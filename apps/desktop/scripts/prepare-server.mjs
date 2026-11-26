#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostTarget, loadManifest, targetInfo } from './node-runtime.mjs';

/**
 * Builds the server bundle for one desktop target: compiled dist plus a
 * production-only node_modules tree installed from the root lockfile, pruned of
 * other platforms and of files the server never loads at runtime.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url));
const desktopDir = fileURLToPath(new URL('../', import.meta.url));
const defaultResourcesDir = join(desktopDir, 'src-tauri', 'resources');
const defaultWebDistDir = join(root, 'apps', 'web', 'dist');

const PRUNED_DIRECTORIES = new Set(['test', 'tests', '__tests__', 'docs', '.github']);
const LICENSE_FILE = /^(?:license|notice|copying|readme)/i;
const GENERATED_FILE = /\.map$/i;
const MARKDOWN_FILE = /\.md$/i;

// The server reads this manifest at runtime to answer GET /api/about, so the
// version must travel with the packaged package.json (lockstep with apps/server).
export function buildServerManifest(server) {
  return {
    name: 'knowlify-desktop-server',
    version: server.version,
    private: true,
    type: 'module',
    dependencies: server.dependencies,
    // Optional native runtime for local embeddings; a failure must not break the app.
    optionalDependencies: server.optionalDependencies ?? {},
  };
}

function fail(message) {
  throw new Error(message);
}

/**
 * The bundled runtime pins the native-module ABI. Running the install with a
 * different major silently produces modules the embedded Node cannot load.
 */
export function assertBundledNodeMajor(nodeVersion, manifestVersion) {
  const hostMajor = String(nodeVersion).split('.')[0];
  const pinnedMajor = String(manifestVersion).split('.')[0];
  if (hostMajor !== pinnedMajor) {
    fail(`prepare-server must run with Node ${pinnedMajor} (found ${nodeVersion}): the native modules must match the bundled Node ABI. Run: nvm use ${pinnedMajor}`);
  }
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function detectLibc() {
  const report = process.report?.getReport?.();
  return report?.header?.glibcVersionRuntime ? 'gnu' : 'musl';
}

/** Everything the prune needs to know about a target triple. */
export function targetProfile(target, { libc } = {}) {
  const info = targetInfo(target);
  return {
    triple: target,
    os: info.platform,
    arch: info.arch,
    // `null` skips the libc assertion, which lets verify-bundle inspect a Linux
    // artifact from a non-glibc host.
    libc: info.platform === 'linux' ? (libc === undefined ? detectLibc() : libc) : null,
    exe: info.exe,
  };
}

/**
 * N-API prebuild shipped inside better-sqlite3 13+ for the target. The loader
 * picks `prebuilds/<platform>-<arch>.node`; only the gnu Linux target is
 * supported by the desktop app, so the libc-specific musl names never apply.
 */
export function betterSqlitePrebuildFile(profile) {
  return `${profile.os}-${profile.arch}.node`;
}

/**
 * `@napi-rs/canvas-*`, `@img/sharp-*` and the onnxruntime OS/arch directories
 * encode a platform. Returns true (target), false (other platform) or null
 * (not a platform package).
 */
export function platformPackageAllowed(packageName, profile) {
  if (packageName === 'onnxruntime-web') return true;
  if (packageName.startsWith('@napi-rs/canvas')) {
    const suffix = packageName.slice('@napi-rs/canvas'.length).replace(/^-/, '');
    if (suffix === '') return true;
    const [os, arch, abi] = suffix.split('-');
    if (os !== profile.os || arch !== profile.arch) return false;
    if (profile.os === 'linux' && profile.libc !== null) return abi === profile.libc;
    return true;
  }
  if (packageName.startsWith('@img/sharp')) {
    const suffix = packageName.replace(/^@img\/(?:sharp-libvips|sharp)-?/, '');
    if (suffix === '' || packageName === '@img/colour') return true;
    const [rawOs, arch] = suffix.split('-');
    if (!arch) return false;
    const os = rawOs === 'linuxmusl' ? 'linux' : rawOs;
    const libc = rawOs === 'linuxmusl' ? 'musl' : 'gnu';
    if (os !== profile.os || arch !== profile.arch) return false;
    return profile.os !== 'linux' || profile.libc === null || libc === profile.libc;
  }
  return null;
}

async function readDirOrEmpty(directory) {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

async function readTree(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function assertDirectory(directory, label) {
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) fail(`${label} is not a directory: ${directory}`);
  } catch {
    fail(`${label} was not created: ${directory}`);
  }
}

export function webBuildMissingMessage(webDistDir) {
  return `web build not found at ${webDistDir}/index.html; run "npm run build -w @knowlify/web" before prepare-server`;
}

/**
 * Copies the web build that the local server serves when sharing is enabled.
 * The desktop app keeps using its own `frontendDist`; only external browsers
 * need this copy.
 */
export async function copyWebBuild(sourceDir, destinationDir) {
  if (!existsSync(join(sourceDir, 'index.html'))) fail(webBuildMissingMessage(sourceDir));
  await rm(destinationDir, { recursive: true, force: true });
  await cp(sourceDir, destinationDir, { recursive: true });
  return destinationDir;
}

/** Removes the multi-platform payloads that `npm ci` cannot filter on its own. */
async function pruneNativePayloads(nodeModules, profile) {
  const onnxBin = join(nodeModules, 'onnxruntime-node', 'bin', 'napi-v6');
  for (const osEntry of await readTree(onnxBin)) {
    const osPath = join(onnxBin, osEntry.name);
    if (osEntry.isDirectory() && osEntry.name !== profile.os) {
      await rm(osPath, { recursive: true, force: true });
      continue;
    }
    if (!osEntry.isDirectory()) continue;
    for (const archEntry of await readTree(osPath)) {
      const archPath = join(osPath, archEntry.name);
      if (!archEntry.isDirectory()) continue;
      if (archEntry.name !== profile.arch) {
        await rm(archPath, { recursive: true, force: true });
        continue;
      }
      // CPU inference only: on Linux the CUDA/TensorRT providers add hundreds of
      // megabytes and are never loaded by this app.
      if (profile.os === 'linux') {
        for (const file of await readDirOrEmpty(archPath)) {
          if (/^libonnxruntime_providers_(?:cuda|tensorrt|shared)/.test(file)) {
            await rm(join(archPath, file), { force: true });
          }
        }
      }
    }
  }

  const betterSqlite = join(nodeModules, 'better-sqlite3');
  for (const entry of ['deps', 'src', 'build']) {
    await rm(join(betterSqlite, entry), { recursive: true, force: true });
  }
  const prebuildsDir = join(betterSqlite, 'prebuilds');
  const targetPrebuild = betterSqlitePrebuildFile(profile);
  for (const entry of await readDirOrEmpty(prebuildsDir)) {
    if (entry !== targetPrebuild) {
      await rm(join(prebuildsDir, entry), { recursive: true, force: true });
    }
  }
}

async function walkPackages(nodeModules, visit) {
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === '.bin' || entry.name === '.cache') continue;
    const packages = [];
    if (entry.name.startsWith('@')) {
      for (const child of await readdir(join(nodeModules, entry.name), { withFileTypes: true })) {
        if (child.isDirectory()) packages.push(join(nodeModules, entry.name, child.name));
      }
    } else {
      packages.push(join(nodeModules, entry.name));
    }
    for (const packageDir of packages) {
      await visit(packageDir);
      const nested = join(packageDir, 'node_modules');
      if (existsSync(nested)) await walkPackages(nested, visit);
    }
  }
}

async function removeForeignPlatformPackages(nodeModules, profile) {
  for (const scope of ['@napi-rs', '@img']) {
    const scopeDir = join(nodeModules, scope);
    for (const name of await readDirOrEmpty(scopeDir)) {
      const fullName = `${scope}/${name}`;
      if (platformPackageAllowed(fullName, profile) === false) {
        await rm(join(scopeDir, name), { recursive: true, force: true });
      }
    }
  }
}

async function removeSourceMaps(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') await removeSourceMaps(full);
    } else if (entry.isFile() && GENERATED_FILE.test(entry.name)) {
      await rm(full, { force: true });
    }
  }
}

async function prunePackageJunk(packageDir) {
  for (const entry of await readdir(packageDir, { withFileTypes: true })) {
    const full = join(packageDir, entry.name);
    if (entry.isDirectory() && PRUNED_DIRECTORIES.has(entry.name)) {
      await rm(full, { recursive: true, force: true });
    } else if (entry.isFile()) {
      if (MARKDOWN_FILE.test(entry.name) && !LICENSE_FILE.test(entry.name)) {
        await rm(full, { force: true });
      }
    }
  }
  await removeSourceMaps(packageDir);
}

export async function directorySizeBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(full);
    } else if (entry.isFile()) {
      total += (await stat(full)).size;
    }
  }
  return total;
}

/**
 * Testable core of the prune. `nodeModules` is a plain directory tree; no npm
 * or network access happens here.
 */
export async function pruneServerTree(nodeModules, target, { log = () => {}, libc } = {}) {
  const profile = targetProfile(target, { libc });
  await assertDirectory(nodeModules, 'node_modules');
  await removeForeignPlatformPackages(nodeModules, profile);
  await pruneNativePayloads(nodeModules, profile);
  let visited = 0;
  await walkPackages(nodeModules, async packageDir => {
    visited += 1;
    await prunePackageJunk(packageDir);
  });
  log(`[prepare-server] pruned ${visited} packages for ${target}`);
  return { packages: visited };
}

/** Fails when a package or native binary for another platform survived the prune. */
export async function assertSinglePlatform(nodeModules, target, { libc } = {}) {
  const profile = targetProfile(target, { libc });
  const foreign = [];
  for (const scope of ['@napi-rs', '@img']) {
    for (const name of await readDirOrEmpty(join(nodeModules, scope))) {
      if (platformPackageAllowed(`${scope}/${name}`, profile) === false) {
        foreign.push(`${scope}/${name}`);
      }
    }
  }
  const onnxBin = join(nodeModules, 'onnxruntime-node', 'bin', 'napi-v6');
  for (const osEntry of await readDirOrEmpty(onnxBin)) {
    if (osEntry !== profile.os) {
      foreign.push(`onnxruntime-node/${osEntry}`);
      continue;
    }
    for (const archEntry of await readDirOrEmpty(join(onnxBin, osEntry))) {
      if (archEntry !== profile.arch) foreign.push(`onnxruntime-node/${osEntry}/${archEntry}`);
    }
  }
  if (foreign.length > 0) {
    fail(`server bundle contains packages for another platform: ${foreign.join(', ')}`);
  }
  const binding = join(nodeModules, 'better-sqlite3', 'prebuilds', betterSqlitePrebuildFile(profile));
  if (!existsSync(binding)) fail(`better-sqlite3 has no prebuild for this target: ${binding} is missing`);
}

function run(command, args, { cwd, env = process.env, log = console.log, label } = {}) {
  log(`[prepare-server] ${label ?? `${command} ${args.join(' ')}`}`);
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32' && command === 'npm.cmd',
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${result.status}`);
}

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/** Copies only the runtime tree; workspace links and npm metadata stay behind. */
async function copyRuntimeModules(source, destination) {
  await mkdir(destination, { recursive: true });
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: (from) => {
      const relativePath = relative(source, from);
      if (relativePath === '') return true;
      const top = relativePath.split(sep)[0];
      if (top === '@knowlify' || top === '.bin' || top === '.package-lock.json') return false;
      return true;
    },
  });
}

/**
 * npm nests a dependency under `apps/server/node_modules` when another
 * workspace pins a different version, so the hoisted tree alone can miss a
 * runtime package. Replace the affected packages with the workspace copy.
 */
export async function overlayNodeModules(source, destination) {
  if (!existsSync(source)) return;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin' || entry.name === '@knowlify') continue;
    const packages = entry.name.startsWith('@')
      ? (await readdir(join(source, entry.name), { withFileTypes: true }))
        .filter((child) => child.isDirectory())
        .map((child) => join(entry.name, child.name))
      : [entry.name];
    for (const name of packages) {
      const target = join(destination, name);
      await rm(target, { recursive: true, force: true });
      await cp(join(source, name), target, { recursive: true, dereference: false });
    }
  }
}

/** Creates the minimal workspace fixture `npm ci` needs to resolve the root lockfile. */
async function createInstallWorkspace(directory) {
  await mkdir(join(directory, 'apps'), { recursive: true });
  for (const workspace of ['server', 'web', 'desktop']) {
    await mkdir(join(directory, 'apps', workspace), { recursive: true });
    await cp(
      join(root, 'apps', workspace, 'package.json'),
      join(directory, 'apps', workspace, 'package.json'),
    );
  }
  await cp(join(root, 'package.json'), join(directory, 'package.json'));
  await cp(join(root, 'package-lock.json'), join(directory, 'package-lock.json'));
}

export async function prepareServer({
  target = hostTarget(),
  resourcesDir = defaultResourcesDir,
  webDistDir = defaultWebDistDir,
  log = console.log,
  env = process.env,
  skipBuild = false,
  nodeVersion = process.versions.node,
} = {}) {
  const manifest = await loadManifest();
  assertBundledNodeMajor(nodeVersion, manifest.version);
  const serverDir = join(resourcesDir, 'server');
  // Fail before destroying resourcesDir: a clean checkout must build the web app
  // first, because the packaged server serves that copy to the LAN.
  if (!existsSync(join(webDistDir, 'index.html'))) fail(webBuildMissingMessage(webDistDir));
  if (!skipBuild) {
    run(npmBin(), ['run', 'build', '-w', '@knowlify/server'], { cwd: root, env, log, label: 'build server' });
  }
  await rm(serverDir, { recursive: true, force: true });
  await mkdir(serverDir, { recursive: true });
  await cp(join(root, 'apps/server/dist'), join(serverDir, 'dist'), { recursive: true });
  await copyWebBuild(webDistDir, join(serverDir, 'web'));
  const server = JSON.parse(await readFile(join(root, 'apps/server/package.json'), 'utf8'));
  await writeFile(join(serverDir, 'package.json'), `${JSON.stringify(buildServerManifest(server), null, 2)}\n`);

  const installDir = await mkdtemp(join(tmpdir(), 'knowlify-server-'));
  try {
    await createInstallWorkspace(installDir);
    const npmEnv = { ...env, npm_config_audit: 'false', npm_config_fund: 'false' };
    run(npmBin(), [
      'ci', '--omit=dev', '--include=optional', '--workspace', '@knowlify/server', '--ignore-scripts',
    ], { cwd: installDir, env: npmEnv, log, label: 'install server dependencies from the root lockfile' });
    // better-sqlite3 13+ ships N-API prebuilds inside the package, so the
    // --ignore-scripts install already carries the native runtime and does not
    // depend on the Node ABI. smoke-server.mjs proves it against the sidecar.
    await copyRuntimeModules(join(installDir, 'node_modules'), join(serverDir, 'node_modules'));
    await overlayNodeModules(
      join(installDir, 'apps', 'server', 'node_modules'),
      join(serverDir, 'node_modules'),
    );
  } finally {
    await rm(installDir, { recursive: true, force: true });
  }

  await pruneServerTree(join(serverDir, 'node_modules'), target, { log });
  await assertSinglePlatform(join(serverDir, 'node_modules'), target);
  const sizeBytes = await directorySizeBytes(serverDir);
  log(`[prepare-server] resources/server for ${target}: ${formatBytes(sizeBytes)}`);
  return { serverDir, target, sizeBytes };
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
    if (argument === '--target') {
      options.target = valueAfter(index);
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
    console.log('Usage: node scripts/prepare-server.mjs [--target <triple>]');
  } else {
    prepareServer({ target: options.target ?? hostTarget() }).catch(error => {
      console.error(`[prepare-server] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  }
}
