#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  defaultBinariesDir, defaultCacheDir, extractArchive, hostTarget, loadManifest, sha256File, sidecarName, targetInfo,
  validateManifest, SUPPORTED_TARGETS,
} from './node-runtime.mjs';
import {
  betterSqlitePrebuildFile, buildServerManifest, directorySizeBytes, formatBytes, platformPackageAllowed, targetProfile,
} from './prepare-server.mjs';

/**
 * Checks a packaged desktop artifact before it is published: the sidecar and its
 * hash, the compiled server, the Node license, leftover binaries for other
 * platforms and the size ceiling. Accepts an extracted directory, a .deb, .rpm,
 * .dmg, NSIS .exe or AppImage.
 */

const desktopDir = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const MAX_INSTALLER_BYTES = 250 * 1024 * 1024;
const LICENSE_DIR = 'licenses/node/LICENSE';
const LICENSE_SEGMENTS = LICENSE_DIR.split('/');

function fail(message) {
  throw new Error(message);
}

function log(message) {
  console.log(`[verify-bundle] ${message}`);
}

function warn(message) {
  console.warn(`[verify-bundle] warning: ${message}`);
}

function commandExists(command) {
  const result = spawnSync(command, ['--help'], { encoding: 'utf8' });
  // A spawned process (any exit code) exists; only the spawn itself can prove
  // the command is missing. Some Windows tools exit above 1 for --help.
  return !result.error;
}

/** True when `file` ends with the given path segments, with either separator. */
export function pathEndsWithSegments(file, segments) {
  const parts = String(file).split(/[\\/]/);
  if (parts.length < segments.length) return false;
  const offset = parts.length - segments.length;
  return segments.every((segment, index) => parts[offset + index] === segment);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024, ...options,
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} exited with ${result.status}: ${(result.stderr || '').trim()}`);
  }
  return result;
}

function spawnToFile(command, args, file) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    pipeline(child.stdout, createWriteStream(file)).then(() => {
      const check = () => (child.exitCode === 0
        ? resolveRun()
        : reject(new Error(`${command} exited with ${child.exitCode}`)));
      if (child.exitCode !== null) check();
      else child.once('close', check);
    }, reject);
    child.once('error', reject);
  });
}

function spawnWithFileInput(command, args, inputFile, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'inherit', 'inherit'], ...options });
    pipeline(createReadStream(inputFile), child.stdin).catch(reject);
    child.once('error', reject);
    child.once('close', code => (code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`))));
  });
}

async function loadServerEntry(root) {
  const files = await listFiles(root);
  const entry = files.find(file => /(?:^|[\\/])server[\\/]dist[\\/]index\.js$/.test(file));
  if (!entry) fail(`server/dist/index.js not found under ${root}`);
  if ((await stat(entry)).size === 0) fail('server/dist/index.js is empty');
  return entry;
}

async function listFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  await walk(root);
  return files;
}

async function extractBundle(inputPath, workDir) {
  const lower = inputPath.toLowerCase();
  const target = join(workDir, 'bundle');
  await mkdir(target, { recursive: true });
  if (lower.endsWith('.deb')) {
    run('dpkg-deb', ['-x', inputPath, target]);
    return { root: target, cleanup: async () => {} };
  }
  if (lower.endsWith('.exe')) {
    if (!commandExists('7z')) fail('7z is required to inspect an NSIS installer');
    run('7z', ['x', '-y', `-o${target}`, inputPath]);
    return { root: target, cleanup: async () => {} };
  }
  if (lower.endsWith('.dmg')) {
    const mountPoint = join(workDir, 'mnt');
    await mkdir(mountPoint, { recursive: true });
    run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, inputPath]);
    return {
      root: mountPoint,
      cleanup: async () => {
        run('hdiutil', ['detach', mountPoint]);
      },
    };
  }
  if (lower.endsWith('.rpm')) {
    if (commandExists('bsdtar')) {
      run('bsdtar', ['-xf', inputPath, '-C', target]);
      return { root: target, cleanup: async () => {} };
    }
    if (!commandExists('rpm2cpio') || !commandExists('cpio')) {
      fail('verifying an .rpm requires bsdtar or rpm2cpio plus cpio');
    }
    const payload = join(workDir, 'payload.cpio');
    await spawnToFile('rpm2cpio', [inputPath], payload);
    await spawnWithFileInput('cpio', ['-idm', '--quiet'], payload, { cwd: target });
    return { root: target, cleanup: async () => {} };
  }
  if (lower.endsWith('.appimage')) {
    // The squashfs starts after the AppImage ELF header, so unsquashfs cannot
    // open the file directly. The runtime's own extractor handles that layout
    // and does not mount the image, so it works without FUSE.
    await chmod(inputPath, 0o755).catch(() => {});
    run(inputPath, ['--appimage-extract'], { cwd: target });
    const root = join(target, 'squashfs-root');
    if (!existsSync(root)) fail(`${basename(inputPath)} did not create ${root} when extracting`);
    return { root, cleanup: async () => {} };
  }
  fail(`Unsupported bundle type: ${inputPath}. Pass an extracted directory or a .deb, .rpm, .dmg, .exe or .AppImage`);
}

async function findSidecars(root) {
  const files = await listFiles(root);
  return files.filter(file => /^knowlify-node(?:\.exe)?$/.test(basename(file)));
}

async function recordedBinaryHash(binariesDir) {
  try {
    const line = (await readFile(join(binariesDir, '.node-sha256'), 'utf8')).trim().split(/\s+/)[0];
    return /^[0-9a-f]{64}$/.test(line) ? line : null;
  } catch {
    return null;
  }
}

const REWRITTEN_FORMATS = new Set(['AppImage', 'dmg', 'app']);
const FORMAT_PLATFORM = Object.freeze({ AppImage: 'linux', dmg: 'darwin', app: 'darwin' });
const ARTIFACT_PLATFORM = Object.freeze({
  '.appimage': 'linux',
  '.deb': 'linux',
  '.rpm': 'linux',
  '.dmg': 'darwin',
  '.app': 'darwin',
  '.exe': 'win32',
});

export function isMacosTarget(target) {
  return typeof target === 'string' && target.endsWith('-apple-darwin');
}

/** Platform a known artifact suffix belongs to, or null for a generic path. */
export function artifactPlatform(inputPath) {
  const lower = String(inputPath).toLowerCase();
  for (const [suffix, platform] of Object.entries(ARTIFACT_PLATFORM)) {
    if (lower.endsWith(suffix)) return platform;
  }
  return null;
}

/**
 * linuxdeploy and codesign rewrite the sidecar binary, so its packaged hash no
 * longer matches the pinned archive. Those formats are checked through the
 * pre-packaging sidecar instead; deb, rpm and NSIS keep the strict comparison.
 * A known suffix always wins: --target can only describe a generic extracted
 * directory, never turn a .deb/.rpm/.exe into a rewritten bundle.
 */
export function artifactFormat(inputPath, explicitTarget = null, { isDirectory = false } = {}) {
  const lower = String(inputPath).toLowerCase();
  if (lower.endsWith('.appimage')) return 'AppImage';
  if (lower.endsWith('.dmg')) return 'dmg';
  if (lower.endsWith('.app')) return 'app';
  if (lower.endsWith('.deb') || lower.endsWith('.rpm') || lower.endsWith('.exe')) return 'strict';
  if (isDirectory && isMacosTarget(explicitTarget)) return 'app';
  return 'strict';
}

/** Rejects a --target whose platform contradicts a known artifact suffix. */
export function assertArtifactTarget(inputPath, explicitTarget) {
  if (explicitTarget === null) return;
  const expected = artifactPlatform(inputPath);
  if (expected === null) return;
  const actual = targetInfo(explicitTarget).platform;
  if (actual !== expected) {
    fail(`${basename(inputPath)} is a ${expected} artifact and cannot be verified against the ${actual} target ${explicitTarget}`);
  }
}

/**
 * Printed only after the pre-packaging sidecar was compared with the pinned
 * archive and .node-sha256. Never claims that the rewritten sidecar hash was
 * checked.
 */
export function sidecarHashSkippedMessage(format) {
  return `sidecar hash: skipped for ${format} (rewritten by the packager; verified before packaging by node:fetch)`;
}

async function findPrePackagingSidecars(binariesDir, wantedPlatform) {
  let entries;
  try {
    entries = await readdir(binariesDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    fail(`cannot read the pre-packaging binaries directory ${binariesDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const candidates = [];
  for (const target of SUPPORTED_TARGETS) {
    if (targetInfo(target).platform !== wantedPlatform) continue;
    const name = sidecarName(target);
    if (entries.includes(name)) {
      candidates.push({ target, path: join(binariesDir, name) });
    }
  }
  return candidates;
}

/**
 * Resolves which target an AppImage or macOS bundle was built for. The
 * rewritten sidecar hash cannot identify it, so the unsigned
 * `src-tauri/binaries` sidecar (or an explicit --target) is the source of truth.
 */
export async function resolveRewrittenBundleTarget({
  format,
  explicitTarget = null,
  binariesDir = defaultBinariesDir,
  platform = process.platform,
  readHostTarget = hostTarget,
} = {}) {
  const wanted = FORMAT_PLATFORM[format];
  if (!wanted) {
    fail(`"${format}" is not a rewritten bundle format; expected one of ${[...REWRITTEN_FORMATS].join(', ')}`);
  }
  if (explicitTarget !== null) {
    if (targetInfo(explicitTarget).platform !== wanted) {
      fail(`a ${format} bundle must be verified against a ${wanted} Node archive, not ${explicitTarget}`);
    }
    return explicitTarget;
  }
  const candidates = await findPrePackagingSidecars(binariesDir, wanted);
  if (candidates.length === 1) return candidates[0].target;
  if (platform === wanted) {
    let host = null;
    try {
      host = readHostTarget();
    } catch {
      host = null;
    }
    if (host && targetInfo(host).platform === wanted
      && (candidates.length === 0 || candidates.some(candidate => candidate.target === host))) {
      return host;
    }
  }
  if (candidates.length === 0) {
    fail(`cannot tell which target the ${format} bundle was built for: no knowlify-node sidecar for ${wanted} exists in ${binariesDir}; pass --target and run "npm run node:fetch -w @knowlify/desktop" before the build`);
  }
  fail(`${binariesDir} contains pre-packaging sidecars for more than one ${wanted} target; pass --target`);
}

/**
 * Checks the unsigned sidecar left in `src-tauri/binaries` before packaging.
 * This is the anchor for a rewritten bundle: the packaged hash cannot be
 * compared, so the artifact that entered the bundler is checked instead.
 */
async function verifyPrePackagingSidecar({ binariesDir, target, pinnedHashes, logLine }) {
  const sidecarPath = join(binariesDir, sidecarName(target));
  try {
    await stat(sidecarPath);
  } catch {
    fail(`pre-packaging sidecar ${sidecarPath} is missing; run "npm run node:fetch -w @knowlify/desktop" before building the bundle`);
  }
  const pinned = pinnedHashes.get(target);
  if (!pinned) {
    fail(`cannot verify the pre-packaging sidecar for ${target}: its pinned Node archive is not usable from the cache; run "npm run node:fetch -w @knowlify/desktop" before verify-bundle`);
  }
  const actual = await sha256File(sidecarPath);
  if (actual !== pinned) {
    fail(`pre-packaging sidecar ${sidecarPath} sha256 ${actual} does not match the Node archive pinned in node-runtime.json (${target} is ${pinned})`);
  }
  const recorded = await recordedBinaryHash(binariesDir);
  if (recorded === null) {
    fail(`${join(binariesDir, '.node-sha256')} is missing or invalid; run "npm run node:fetch -w @knowlify/desktop" before building the bundle`);
  }
  if (recorded !== actual) {
    fail(`pre-packaging sidecar ${sidecarPath} sha256 ${actual} does not match .node-sha256 ${recorded}; the workspace hash file is stale or was tampered with`);
  }
  logLine(`pre-packaging sidecar ${basename(sidecarPath)} sha256 matches node-runtime.json (${target}) and .node-sha256`);
  return { path: sidecarPath, sha256: actual, target };
}

/**
 * Verifies the signature of the packaged sidecar when the host provides
 * `codesign`. Failure is fatal: a signed bundle must not be reported as valid
 * without a successful signature check on a macOS host.
 */
export function verifyCodesign(sidecarPath, {
  platform = process.platform,
  hasCommand = commandExists,
  runCommand = (command, args) => spawnSync(command, args, {
    encoding: 'utf8', timeout: 60_000,
  }),
  logLine = log,
  warnLine = warn,
} = {}) {
  const label = basename(sidecarPath);
  if (platform !== 'darwin') {
    warnLine(`codesign --verify skipped for ${label}: not running on macOS`);
    return { checked: false, reason: 'not-macos' };
  }
  if (!hasCommand('codesign')) {
    warnLine(`codesign --verify skipped for ${label}: codesign is not available`);
    return { checked: false, reason: 'missing-codesign' };
  }
  const result = runCommand('codesign', ['--verify', '--strict', sidecarPath]);
  if (result.error) fail(`codesign --verify failed to run for ${label}: ${result.error.message}`);
  if (result.status !== 0) {
    const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim();
    fail(`codesign --verify failed for ${label}: ${output || `exit code ${result.status}`}`);
  }
  logLine(`codesign --verify ${label}: ok`);
  return { checked: true, reason: null };
}

/**
 * Derives the expected sidecar hash from the pinned archive: the cache entry is
 * re-hashed against the manifest and the entry binary inside it is hashed. This
 * ties the artifact to `node-runtime.json` without adding fields to the frozen
 * manifest format.
 */
async function hashesFromPinnedArchives(manifest, cacheDir, warnLine) {
  const hashes = new Map();
  for (const target of SUPPORTED_TARGETS) {
    const spec = manifest.targets[target];
    const archive = join(cacheDir, spec.sha256, spec.archive);
    if (!existsSync(archive)) continue;
    if ((await sha256File(archive)) !== spec.sha256) {
      warnLine(`cached ${spec.archive} does not match node-runtime.json; ignoring it`);
      continue;
    }
    const workDir = await mkdtemp(join(tmpdir(), 'knowlify-verify-node-'));
    try {
      const extracted = await extractArchive({
        archivePath: archive, target, version: manifest.version, destinationDir: workDir,
      });
      hashes.set(target, await sha256File(extracted.binary));
    } catch (error) {
      warnLine(`cannot hash the entry for ${target}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  return hashes;
}

function versionMatchesTarget(target) {
  if (!target) return false;
  try {
    return hostTarget() === target;
  } catch {
    return false;
  }
}

function checkSidecarVersion(sidecarPath, target, manifest, { logLine, warnLine }) {
  const label = basename(sidecarPath);
  if (!versionMatchesTarget(target)) {
    warnLine(`sidecar ${label} cannot run on ${process.platform}; version check skipped`);
    return null;
  }
  const reported = run(sidecarPath, ['--version']).stdout.trim();
  if (reported !== `v${manifest.version}`) fail(`sidecar reports ${reported}, expected v${manifest.version}`);
  logLine(`sidecar ${label} --version = ${reported}`);
  return reported;
}

async function requireExecutable(sidecarPath) {
  if (process.platform === 'win32') return;
  try {
    await access(sidecarPath, fsConstants.X_OK);
  } catch {
    fail(`sidecar ${basename(sidecarPath)} is not executable`);
  }
}

/** N-API prebuilds must exist for the artifact target, not only for the host. */
function requireBetterSqlitePrebuild(nodeModules, target) {
  const profile = targetProfile(target, { libc: target === 'x86_64-unknown-linux-gnu' ? null : undefined });
  const required = join('better-sqlite3', 'prebuilds', betterSqlitePrebuildFile(profile));
  if (!existsSync(join(nodeModules, required))) {
    fail(`server/node_modules is missing ${required}`);
  }
}

async function findForeignPayloads(root, target) {
  const profile = targetProfile(target, { libc: target === 'x86_64-unknown-linux-gnu' ? null : undefined });
  const foreign = [];
  for (const file of await listFiles(root)) {
    const parts = file.split(/[\\/]/);
    const napiIndex = parts.indexOf('@napi-rs');
    if (napiIndex >= 0 && parts[napiIndex + 1]?.startsWith('canvas')) {
      const allowed = platformPackageAllowed(`@napi-rs/${parts[napiIndex + 1]}`, profile);
      if (allowed === false && !foreign.includes(parts[napiIndex + 1])) foreign.push(parts[napiIndex + 1]);
    }
    const imgIndex = parts.indexOf('@img');
    if (imgIndex >= 0 && parts[imgIndex + 1]?.startsWith('sharp')) {
      const allowed = platformPackageAllowed(`@img/${parts[imgIndex + 1]}`, profile);
      if (allowed === false && !foreign.includes(parts[imgIndex + 1])) foreign.push(parts[imgIndex + 1]);
    }
    const onnxIndex = parts.indexOf('napi-v6');
    if (onnxIndex >= 0) {
      const osName = parts[onnxIndex + 1];
      const archName = parts[onnxIndex + 2];
      if (osName && osName !== profile.os) foreign.push(`onnxruntime-node/${osName}`);
      else if (osName === profile.os && archName && archName !== profile.arch) {
        foreign.push(`onnxruntime-node/${osName}/${archName}`);
      }
    }
  }
  return [...new Set(foreign)];
}

export async function verifyBundle({
  inputPath,
  explicitTarget = null,
  maxBytes = MAX_INSTALLER_BYTES,
  manifest: injectedManifest = null,
  cacheDir = defaultCacheDir,
  binariesDir = defaultBinariesDir,
  logLine = log,
  warnLine = warn,
  rawLine = line => console.log(line),
} = {}) {
  const absolute = resolve(inputPath);
  const inputStat = await stat(absolute);
  const size = inputStat.isDirectory() ? await directorySizeBytes(absolute) : inputStat.size;
  if (size > maxBytes) {
    fail(`${absolute} is ${formatBytes(size)}, above the ${formatBytes(maxBytes)} limit`);
  }
  logLine(`size ${formatBytes(size)} (limit ${formatBytes(maxBytes)})`);

  const manifest = injectedManifest ? validateManifest(injectedManifest) : await loadManifest();
  assertArtifactTarget(absolute, explicitTarget);
  const format = artifactFormat(absolute, explicitTarget, { isDirectory: inputStat.isDirectory() });
  const workDir = await mkdtemp(join(tmpdir(), 'knowlify-verify-'));
  let extracted;
  try {
    extracted = inputStat.isDirectory()
      ? { root: absolute, cleanup: async () => {} }
      : await extractBundle(absolute, workDir);
    const root = extracted.root;

    const serverEntry = await loadServerEntry(root);
    logLine(`server entry ${relative(root, serverEntry)}`);

    const serverRoot = join(serverEntry, '..', '..');
    const nodeModules = join(serverRoot, 'node_modules');
    for (const required of [
      'fastify/package.json',
      'better-sqlite3/package.json',
      'better-sqlite3/prebuilds',
      '@napi-rs/canvas/package.json',
    ]) {
      if (!existsSync(join(nodeModules, required))) {
        fail(`server/node_modules is missing ${required}`);
      }
    }
    logLine('server node_modules present');

    const packagedServer = JSON.parse(await readFile(join(serverRoot, 'package.json'), 'utf8'));
    const expectedManifest = buildServerManifest(
      JSON.parse(await readFile(join(repoRoot, 'apps/server/package.json'), 'utf8')),
    );
    if (packagedServer.version !== expectedManifest.version) {
      fail(`packaged server version ${packagedServer.version} does not match apps/server (${expectedManifest.version})`);
    }
    if (packagedServer.type !== 'module') fail('packaged server package.json lost "type": "module"');
    logLine(`server version ${packagedServer.version}`);

    // The server serves this copy to browsers on the local network; the app's
    // own webview keeps using the Tauri frontendDist.
    const webIndex = (await listFiles(root))
      .find(file => pathEndsWithSegments(file, ['server', 'web', 'index.html']));
    if (!webIndex) {
      fail('server/web/index.html is missing from the bundle; run prepare-server after building the web app');
    }
    if ((await stat(webIndex)).size === 0) fail('server/web/index.html is empty');
    logLine('server/web/index.html present');

    const license = (await listFiles(root)).find(file => pathEndsWithSegments(file, LICENSE_SEGMENTS));
    if (!license) fail(`${LICENSE_DIR} is missing from the bundle`);
    if ((await stat(license)).size === 0) fail(`${LICENSE_DIR} is empty`);
    logLine(`${LICENSE_DIR} present`);

    const sidecars = await findSidecars(root);
    if (sidecars.length === 0) fail('knowlify-node sidecar is missing from the bundle');

    // The manifest pins only the archive hash. The binary hash is derived from
    // that archive, so a missing cache is a hard failure: binaries/.node-sha256
    // is a workspace file and must never be the only source of truth.
    const pinnedHashes = await hashesFromPinnedArchives(manifest, cacheDir, warnLine);
    if (pinnedHashes.size === 0) {
      fail(`cannot verify the sidecar: no usable Node archive pinned in node-runtime.json is cached under ${cacheDir}; run "npm run node:fetch -w @knowlify/desktop" before verify-bundle`);
    }
    if (explicitTarget && !pinnedHashes.has(explicitTarget)) {
      fail(`cannot verify ${explicitTarget}: its pinned ${manifest.targets[explicitTarget].archive} is not usable from the cache under ${cacheDir}; run "npm run node:fetch -w @knowlify/desktop" before verify-bundle`);
    }

    if (format !== 'strict') {
      if (sidecars.length !== 1) {
        fail(`a ${format} bundle must contain exactly one knowlify-node sidecar, found ${sidecars.length}`);
      }
      const target = await resolveRewrittenBundleTarget({ format, explicitTarget, binariesDir });
      requireBetterSqlitePrebuild(nodeModules, target);
      const packaging = await verifyPrePackagingSidecar({ binariesDir, target, pinnedHashes, logLine });
      const sidecar = sidecars[0];
      await requireExecutable(sidecar);
      logLine(`sidecar ${basename(sidecar)} is executable`);
      const reported = checkSidecarVersion(sidecar, target, manifest, { logLine, warnLine });
      const codesign = format === 'AppImage' ? null : verifyCodesign(sidecar, { logLine, warnLine });

      const foreign = await findForeignPayloads(root, target);
      if (foreign.length > 0) fail(`bundle contains payloads for another platform: ${foreign.join(', ')}`);
      logLine(`no payloads for platforms other than ${target}`);

      // Only reached after the unsigned sidecar was compared with both anchors.
      rawLine(sidecarHashSkippedMessage(format));
      return {
        size,
        target,
        sidecars,
        format,
        hashCheck: 'skipped-rewritten',
        packagingSidecar: packaging.path,
        packagingSha256: packaging.sha256,
        version: reported,
        codesign,
      };
    }

    const recorded = await recordedBinaryHash(binariesDir);
    let inferredTarget = null;
    for (const sidecar of sidecars) {
      const label = relative(root, sidecar);
      const hash = await sha256File(sidecar);
      let matchedTarget = null;
      if (explicitTarget) {
        if (hash === pinnedHashes.get(explicitTarget)) matchedTarget = explicitTarget;
      } else {
        for (const [target, pinned] of pinnedHashes) {
          if (pinned === hash) {
            matchedTarget = target;
            break;
          }
        }
      }
      if (matchedTarget === null) {
        const expected = explicitTarget
          ? `${explicitTarget} is ${pinnedHashes.get(explicitTarget)}`
          : `expected one of ${[...pinnedHashes.values()].join(', ')}`;
        fail(`${label} sha256 ${hash} does not match the Node archive pinned in node-runtime.json (${expected}).`);
      }
      if (inferredTarget !== null && inferredTarget !== matchedTarget) {
        fail(`bundle contains knowlify-node sidecars for more than one target: ${inferredTarget} and ${matchedTarget}`);
      }
      inferredTarget = matchedTarget;
      if (recorded !== null && recorded !== hash) {
        fail(`${label} sha256 ${hash} does not match .node-sha256 ${recorded}; the workspace hash file is stale or was tampered with`);
      }
      await requireExecutable(sidecar);
      checkSidecarVersion(sidecar, inferredTarget, manifest, { logLine, warnLine });
      logLine(`sidecar ${basename(sidecar)} sha256 matches node-runtime.json (${matchedTarget})`);
    }

    const effectiveTarget = inferredTarget;
    requireBetterSqlitePrebuild(nodeModules, effectiveTarget);
    const foreign = await findForeignPayloads(root, effectiveTarget);
    if (foreign.length > 0) fail(`bundle contains payloads for another platform: ${foreign.join(', ')}`);
    logLine(`no payloads for platforms other than ${effectiveTarget}`);
    return {
      size, target: effectiveTarget, sidecars, format: 'strict', hashCheck: 'strict',
    };
  } finally {
    await extracted?.cleanup?.();
    await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
    if (argument === '--target') {
      options.target = valueAfter(index);
      index += 1;
    } else if (argument === '--max-size-mb') {
      options.maxSizeMb = Number(valueAfter(index));
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (options.path === undefined) {
      options.path = argument;
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  if (options.help || options.path === undefined) {
    console.log('Usage: node scripts/verify-bundle.mjs <path> [--target <triple>] [--max-size-mb <n>]');
    if (options.help) process.exit(0);
    process.exitCode = 1;
  } else {
    verifyBundle({
      inputPath: options.path,
      explicitTarget: options.target ?? null,
      ...(Number.isFinite(options.maxSizeMb) ? { maxBytes: options.maxSizeMb * 1024 * 1024 } : {}),
    }).then(() => {
      console.log('[verify-bundle] passed');
    }).catch(error => {
      console.error(`[verify-bundle] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  }
}
