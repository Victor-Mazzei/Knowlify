#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostTarget, loadManifest, sidecarName, SUPPORTED_TARGETS, targetInfo } from './node-runtime.mjs';

/**
 * End-to-end check of the packaged server: starts it with the bundled Node.js on
 * an ephemeral port, bound to every IPv4 interface with the local-network guard,
 * a throwaway data directory and the packaged web build. Probes /health, the
 * authenticated /api/about and `GET /` with a local and a public `Host`, loads
 * the native modules under the same runtime and stops the child before returning.
 */

const desktopDir = fileURLToPath(new URL('../', import.meta.url));
const defaultBinariesDir = join(desktopDir, 'src-tauri', 'binaries');
const defaultServerDir = join(desktopDir, 'src-tauri', 'resources', 'server');
const HEALTH_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 5_000;

const sleep = milliseconds => new Promise(resolveSleep => { setTimeout(resolveSleep, milliseconds); });

/** Variables from the developer shell that must not reach the server process. */
const INHERITED_STATE = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'KNOWLIFY_NODE',
  'KNOWLIFY_TRUST_PROXY',
  'KNOWLIFY_MCP_ALLOWED_HOSTS',
  'KNOWLIFY_MCP_ALLOWED_ORIGINS',
  'KNOWLIFY_FORCE_ENV_PASSWORD',
];

/**
 * Environment of the smoke run. Mirrors the desktop sharing mode: all
 * interfaces, fixed guard, packaged web directory, and no inherited override.
 */
export function smokeEnv({ port, dataDir, webDir, user, password }, baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const name of INHERITED_STATE) delete env[name];
  return {
    ...env,
    PORT: String(port),
    HOST: '0.0.0.0',
    KNOWLIFY_NETWORK_GUARD: 'lan',
    KNOWLIFY_WEB_DIR: webDir,
    KNOWLIFY_DATA: dataDir,
    KNOWLIFY_USER: user,
    KNOWLIFY_PASSWORD: password,
    KNOWLIFY_ACCOUNT_LOCKED: '0',
    KNOWLIFY_LIBRARY_PATHS: '',
    KNOWLIFY_SCAN_INTERVAL: '0',
    KNOWLIFY_INDEX_BACKFILL: 'off',
    KNOWLIFY_INDEX_WORKERS: '1',
    KNOWLIFY_MCP: 'off',
    KNOWLIFY_METADATA_LOOKUP: 'off',
  };
}

async function javascriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

/**
 * The server guard reads KNOWLIFY_NETWORK_GUARD from the environment, so the
 * compiled config carries the literal. While the guard is being implemented in
 * a separate change, the smoke run reports the Host check as skipped instead of
 * failing; once the name is in the build, a public Host must be rejected.
 */
export async function serverSupportsNetworkGuard(distDir) {
  for (const file of await javascriptFiles(distDir)) {
    if ((await readFile(file, 'utf8')).includes('KNOWLIFY_NETWORK_GUARD')) return true;
  }
  return false;
}

function httpGet({ port, path = '/', hostHeader, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolveRequest, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: hostHeader ? { Host: hostHeader } : {},
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolveRequest({
        status: response.statusCode,
        headers: response.headers,
        body,
      }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('request timed out')));
    request.on('error', reject);
    request.end();
  });
}

export function pickFreePort(host = '127.0.0.1') {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : null;
      server.close(error => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function waitForHealth(baseUrl, child, logs, timeoutMs, getSpawnError = () => null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) fail(`cannot start the server process: ${spawnError.message}`);
    if (child.exitCode !== null) {
      fail(`server exited with ${child.exitCode} before /health\n${tail(logs)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) return;
    } catch {
      // The listener is not ready yet; keep polling until the deadline.
    }
    await sleep(250);
  }
  fail(`server did not answer /health within ${timeoutMs} ms\n${tail(logs)}`);
}

function fail(message) {
  throw new Error(message);
}

function tail(logs) {
  const limit = 8_192;
  return [logs.stdout, logs.stderr]
    .filter(Boolean)
    .map(text => text.slice(-limit))
    .join('\n');
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise(resolveExit => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, 10_000)) return;
  child.kill('SIGKILL');
  if (!(await waitForExit(child, 5_000))) fail('server child did not exit after SIGKILL');
}

function checkNativeModules(nodePath, serverDir) {
  const script = [
    "const Database = require('better-sqlite3');",
    "const { createCanvas } = require('@napi-rs/canvas');",
    "const db = new Database(':memory:');",
    "db.exec('create table t (id integer primary key, value text)');",
    "db.prepare('insert into t (value) values (?)').run('ok');",
    "if (db.prepare('select value from t').get().value !== 'ok') throw new Error('sqlite roundtrip failed');",
    'db.close();',
    'const canvas = createCanvas(8, 8);',
    "canvas.getContext('2d').fillRect(0, 0, 8, 8);",
    "console.log('native modules ok');",
  ].join(' ');
  const result = spawnSync(nodePath, ['-e', script], {
    cwd: serverDir,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error) fail(`native module probe failed: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`native modules do not load under ${nodePath}:\n${(result.stderr || result.stdout).trim()}`);
  }
}

export async function smokeServer({
  nodePath,
  serverDir = defaultServerDir,
  dataDir = null,
  log = console.log,
  timeoutMs = HEALTH_TIMEOUT_MS,
} = {}) {
  const resolvedNode = nodePath ?? join(defaultBinariesDir, sidecarName(hostTarget()));
  if (!existsSync(resolvedNode)) {
    fail(`Node runtime not found: ${resolvedNode}. Run "npm run node:fetch -w @knowlify/desktop" first`);
  }
  const entry = join(serverDir, 'dist', 'index.js');
  if (!existsSync(entry)) fail(`Compiled server not found: ${entry}. Run prepare-server first`);
  const webDir = join(serverDir, 'web');
  if (!existsSync(join(webDir, 'index.html'))) {
    fail(`Web build not found: ${join(webDir, 'index.html')}. Run prepare-server after building the web app`);
  }

  const manifest = await loadManifest();
  const packaged = JSON.parse(await readFile(join(serverDir, 'package.json'), 'utf8'));
  if (typeof packaged.version !== 'string') fail(`${serverDir}/package.json has no version`);

  checkNativeModules(resolvedNode, serverDir);

  const workDir = dataDir ?? await mkdtemp(join(tmpdir(), 'knowlify-smoke-'));
  const port = await pickFreePort();
  const user = 'smoke';
  const password = `smoke-${Math.random().toString(36).slice(2)}`;
  const logs = { stdout: '', stderr: '' };
  let spawnError = null;
  const child = spawn(resolvedNode, [entry], {
    cwd: serverDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: smokeEnv({ port, dataDir: workDir, webDir, user, password }),
  });
  child.stdout.on('data', chunk => { logs.stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { logs.stderr += chunk.toString(); });
  child.once('error', error => { spawnError = error; });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    if (spawnError) fail(`cannot start ${resolvedNode}: ${spawnError.message}`);
    await waitForHealth(baseUrl, child, logs, timeoutMs, () => spawnError);
    log(`[smoke-server] /health ok on ${baseUrl}`);

    const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    const aboutResponse = await fetch(`${baseUrl}/api/about`, {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (aboutResponse.status !== 200) {
      fail(`/api/about answered ${aboutResponse.status} instead of 200`);
    }
    const about = await aboutResponse.json();
    if (about.version !== packaged.version) {
      fail(`/api/about reports ${JSON.stringify(about.version)}, package.json says ${packaged.version}`);
    }
    if (about.node !== manifest.version) {
      fail(`/api/about reports Node.js ${JSON.stringify(about.node)}, manifest pins ${manifest.version}`);
    }
    log(`[smoke-server] /api/about version=${about.version} node=${about.node}`);

    const index = await httpGet({
      port,
      path: '/',
      hostHeader: `127.0.0.1:${port}`,
    });
    if (index.status !== 200) {
      fail(`GET / with Host: 127.0.0.1:${port} answered ${index.status} instead of 200`);
    }
    const contentType = String(index.headers['content-type'] ?? '');
    if (!contentType.toLowerCase().includes('text/html')) {
      fail(`GET / answered content-type ${JSON.stringify(contentType)} instead of text/html`);
    }
    if (!/<div id="root"/i.test(index.body)) {
      fail('GET / did not serve the web app index.html from KNOWLIFY_WEB_DIR');
    }
    log('[smoke-server] GET / served the packaged web app');

    const supportsGuard = await serverSupportsNetworkGuard(join(serverDir, 'dist'));
    if (supportsGuard) {
      const blocked = await httpGet({ port, path: '/', hostHeader: 'evil.example' });
      if (blocked.status !== 403) {
        fail(`GET / with Host: evil.example answered ${blocked.status} instead of 403`);
      }
      log('[smoke-server] network guard rejected a public Host');
    } else {
      log('[smoke-server] network guard not present in this server build; Host check skipped (run again after the server guard is merged)');
    }

    log(`[smoke-server] native modules ok under ${resolvedNode}`);
    return {
      port,
      version: about.version,
      node: about.node,
      networkGuard: supportsGuard ? 'checked' : 'skipped',
    };
  } finally {
    await stopChild(child);
    if (dataDir === null) {
      await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}

function parseArguments(argv) {
  const options = {};
  const valueAfter = index => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`Missing value for ${argv[index]}`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--node') {
      options.node = valueAfter(index);
      index += 1;
    } else if (argument === '--server') {
      options.server = valueAfter(index);
      index += 1;
    } else if (argument === '--data') {
      options.data = valueAfter(index);
      index += 1;
    } else if (argument === '--timeout') {
      options.timeout = Number(valueAfter(index));
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node scripts/smoke-server.mjs [--node <path>] [--server <dir>] [--data <dir>]
Targets: ${SUPPORTED_TARGETS.join(', ')} (runtime target: ${targetInfo(hostTarget()).triple})`);
  } else {
    smokeServer({
      nodePath: options.node ? resolve(options.node) : undefined,
      serverDir: options.server ? resolve(options.server) : defaultServerDir,
      dataDir: options.data ? resolve(options.data) : null,
      ...(Number.isFinite(options.timeout) ? { timeoutMs: options.timeout } : {}),
    }).then(() => {
      console.log('[smoke-server] passed');
    }).catch(error => {
      console.error(`[smoke-server] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  }
}
