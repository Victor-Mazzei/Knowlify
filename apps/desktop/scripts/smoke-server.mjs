#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostTarget, loadManifest, sidecarName, SUPPORTED_TARGETS, targetInfo } from './node-runtime.mjs';

/**
 * End-to-end check of the packaged server: starts it with the bundled Node.js on
 * an ephemeral loopback port and a throwaway data directory, probes /health and
 * the authenticated /api/about, loads the native modules under the same runtime
 * and stops the child before returning.
 */

const desktopDir = fileURLToPath(new URL('../', import.meta.url));
const defaultBinariesDir = join(desktopDir, 'src-tauri', 'binaries');
const defaultServerDir = join(desktopDir, 'src-tauri', 'resources', 'server');
const HEALTH_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 5_000;

const sleep = milliseconds => new Promise(resolveSleep => { setTimeout(resolveSleep, milliseconds); });

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
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      KNOWLIFY_DATA: workDir,
      KNOWLIFY_USER: user,
      KNOWLIFY_PASSWORD: password,
      KNOWLIFY_ACCOUNT_LOCKED: '0',
      KNOWLIFY_LIBRARY_PATHS: '',
      KNOWLIFY_SCAN_INTERVAL: '0',
      KNOWLIFY_INDEX_BACKFILL: 'off',
      KNOWLIFY_INDEX_WORKERS: '1',
      KNOWLIFY_MCP: 'off',
      KNOWLIFY_METADATA_LOOKUP: 'off',
      NODE_OPTIONS: '',
      NODE_PATH: '',
    },
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
    log(`[smoke-server] native modules ok under ${resolvedNode}`);
    return { port, version: about.version, node: about.node };
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
