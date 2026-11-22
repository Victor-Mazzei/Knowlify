#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import {
  chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

/**
 * Downloads the pinned Node.js runtime, verifies it against this repository's
 * hash manifest and installs it as a Tauri sidecar. Every network call has an
 * explicit host policy, size cap and timeout; no step goes through a shell.
 */

const desktopDir = fileURLToPath(new URL('../', import.meta.url));
export const defaultManifestPath = join(desktopDir, 'node-runtime.json');
export const defaultBinariesDir = join(desktopDir, 'src-tauri', 'binaries');
export const defaultLicensesDir = join(desktopDir, 'src-tauri', 'resources', 'licenses', 'node');
export const defaultCacheDir = join(desktopDir, '.cache', 'node');

const DIST_ORIGIN = 'https://nodejs.org';
const DIST_INDEX_URL = `${DIST_ORIGIN}/dist/index.json`;
export const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
export const MAX_METADATA_BYTES = 1024 * 1024;
export const FETCH_TIMEOUT_MS = 300_000;
export const EXTRACT_TIMEOUT_MS = 120_000;

/** Rust target triples are the sidecar suffixes Tauri requires. */
const TARGETS = {
  'x86_64-pc-windows-msvc': { dist: 'win-x64', platform: 'win32', arch: 'x64', exe: '.exe' },
  'aarch64-apple-darwin': { dist: 'darwin-arm64', platform: 'darwin', arch: 'arm64', exe: '' },
  'x86_64-apple-darwin': { dist: 'darwin-x64', platform: 'darwin', arch: 'x64', exe: '' },
  'x86_64-unknown-linux-gnu': { dist: 'linux-x64', platform: 'linux', arch: 'x64', exe: '' },
};

export const SUPPORTED_TARGETS = Object.freeze(Object.keys(TARGETS));

export function targetInfo(target) {
  const info = TARGETS[target];
  if (!info) fail(`Unsupported target "${target}". Supported: ${SUPPORTED_TARGETS.join(', ')}`);
  return { ...info };
}

const HOST_FALLBACK = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
};
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const sha256Pattern = value => typeof value === 'string' && SHA256_PATTERN.test(value);

function fail(message) {
  throw new Error(message);
}

function logLine(log, message) {
  log(`[node-runtime] ${message}`);
}

export function parseNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function archiveName(version, target) {
  const info = TARGETS[target];
  if (!info) fail(`Unsupported target "${target}". Supported: ${SUPPORTED_TARGETS.join(', ')}`);
  const extension = info.platform === 'win32' ? 'zip' : info.platform === 'darwin' ? 'tar.gz' : 'tar.xz';
  return `node-v${version}-${info.dist}.${extension}`;
}

export function archiveRoot(version, target) {
  return archiveName(version, target).replace(/\.(?:zip|tar\.gz|tar\.xz)$/, '');
}

/**
 * Path of the runtime inside the official archive. The Windows ZIP puts node.exe
 * at the archive root while the Unix tarballs use bin/.
 */
export function archiveEntry(version, target) {
  const root = archiveRoot(version, target);
  return TARGETS[target].platform === 'win32' ? `${root}/node.exe` : `${root}/bin/node`;
}

export function sidecarName(target) {
  const info = TARGETS[target];
  if (!info) fail(`Unsupported target "${target}". Supported: ${SUPPORTED_TARGETS.join(', ')}`);
  return `knowlify-node-${target}${info.exe}`;
}

/** Rejects a malformed manifest before any byte is downloaded. */
export function validateManifest(manifest) {
  if (!isRecord(manifest)) fail('node-runtime.json must be a JSON object');
  const version = parseNodeVersion(manifest.version);
  if (!version) fail(`node-runtime.json has an invalid version: ${JSON.stringify(manifest.version)}`);
  if (version.major !== 22) fail(`node-runtime.json must pin Node.js 22.x, got ${manifest.version}`);
  const expectedBase = `${DIST_ORIGIN}/dist/v${manifest.version}/`;
  if (manifest.baseUrl !== expectedBase) {
    fail(`node-runtime.json baseUrl must be ${expectedBase}, got ${JSON.stringify(manifest.baseUrl)}`);
  }
  if (!isRecord(manifest.targets)) fail('node-runtime.json is missing "targets"');
  const keys = Object.keys(manifest.targets).sort();
  const expectedKeys = [...SUPPORTED_TARGETS].sort();
  if (keys.join(',') !== expectedKeys.join(',')) {
    fail(`node-runtime.json must declare exactly these targets: ${expectedKeys.join(', ')}`);
  }
  for (const target of SUPPORTED_TARGETS) {
    const entry = manifest.targets[target];
    if (!isRecord(entry)) fail(`node-runtime.json target ${target} must be an object`);
    if (entry.archive !== archiveName(manifest.version, target)) {
      fail(`node-runtime.json target ${target} archive must be ${archiveName(manifest.version, target)}`);
    }
    if (!sha256Pattern(entry.sha256)) {
      fail(`node-runtime.json target ${target} sha256 must be 64 lowercase hex characters`);
    }
    const expectedEntry = archiveEntry(manifest.version, target);
    if (entry.entry !== expectedEntry) {
      fail(`node-runtime.json target ${target} entry must be ${expectedEntry}`);
    }
  }
  return manifest;
}

export async function loadManifest(file = defaultManifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    fail(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateManifest(parsed);
}

/** Host triple from rustc, with the platform/arch map as a fallback for machines without Rust. */
export function hostTarget({ rustc = 'rustc' } = {}) {
  const result = spawnSync(rustc, ['-vV'], { encoding: 'utf8' });
  if (!result.error && result.status === 0) {
    const match = /^host:\s*(\S+)$/m.exec(result.stdout);
    if (match) {
      if (TARGETS[match[1]]) return match[1];
      fail(`Unsupported host target ${match[1]}; supported: ${SUPPORTED_TARGETS.join(', ')}`);
    }
  }
  const fallback = HOST_FALLBACK[`${process.platform}-${process.arch}`];
  if (fallback) return fallback;
  fail(`Cannot determine the host target; pass --target. Supported: ${SUPPORTED_TARGETS.join(', ')}`);
}

export function isHostTarget(target) {
  try {
    return hostTarget() === target;
  } catch {
    return false;
  }
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  }));
  return hash.digest('hex');
}

/** Allows tests to point at a local HTTP fixture without weakening the real policy. */
export const OFFICIAL_POLICY = Object.freeze({ protocols: ['https:'], hosts: ['nodejs.org'] });

function checkUrl(url, policy) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(`Invalid download URL: ${url}`);
  }
  if (!policy.protocols.includes(parsed.protocol)) {
    fail(`Refusing ${parsed.protocol} download; allowed: ${policy.protocols.join(', ')}`);
  }
  if (!policy.hosts.includes(parsed.hostname)) {
    fail(`Refusing download from ${parsed.hostname}; allowed: ${policy.hosts.join(', ')}`);
  }
  return parsed;
}

export function archiveUrl(manifest, target) {
  return new URL(archiveName(manifest.version, target), manifest.baseUrl).href;
}

/**
 * Streams a file to `destination`, hashing it on the way. Rejects redirects,
 * oversized bodies, truncated bodies and hash mismatches; the partial file is
 * removed on any failure so a later run cannot reuse it.
 */
export async function downloadVerifiedFile({
  url,
  destination,
  expectedSha256,
  policy = OFFICIAL_POLICY,
  maxBytes = MAX_ARCHIVE_BYTES,
  timeoutMs = FETCH_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  checkUrl(url, policy);
  if (!sha256Pattern(expectedSha256)) fail('expectedSha256 must be 64 lowercase hex characters');
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  await rm(partial, { force: true });

  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'knowlify-node-runtime' },
    });
  } catch (error) {
    fail(`Download failed for ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status >= 300 && response.status < 400) {
    fail(`Refusing redirect (${response.status}) from ${url}; the pinned URL must not redirect`);
  }
  if (!response.ok) fail(`Download failed for ${url}: HTTP ${response.status}`);
  if (!response.body) fail(`Download failed for ${url}: empty response body`);

  const declaredHeader = response.headers.get('content-length');
  const contentEncoding = response.headers.get('content-encoding');
  // fetch decompresses gzip/br bodies; comparing the compressed length would
  // report a false truncation. The archives are served as-is, so the guard only
  // applies when the body is not encoded.
  const declared = !contentEncoding || contentEncoding === 'identity'
    ? Number(declaredHeader ?? Number.NaN)
    : Number.NaN;
  if (Number.isFinite(declared) && declared > maxBytes) {
    fail(`Refusing ${declared} bytes from ${url}; limit is ${maxBytes} bytes`);
  }

  const hash = createHash('sha256');
  let received = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) {
        callback(new Error(`Download exceeded the ${maxBytes}-byte limit`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(partial));
  } catch (error) {
    await rm(partial, { force: true });
    fail(`Download failed for ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (received === 0) {
    await rm(partial, { force: true });
    fail(`Download failed for ${url}: empty file`);
  }
  if (Number.isFinite(declared) && received !== declared) {
    await rm(partial, { force: true });
    fail(`Truncated download for ${url}: received ${received} of ${declared} bytes`);
  }
  const actual = hash.digest('hex');
  if (actual !== expectedSha256) {
    await rm(partial, { force: true });
    fail(`SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${actual}`);
  }
  await rename(partial, destination);
  return { path: destination, sha256: actual, bytes: received };
}

/**
 * Returns a hash-verified archive from the cache, downloading it when absent.
 * A cached file is hashed again: a poisoned or partially written cache entry is
 * discarded instead of trusted.
 */
export async function ensureCachedArchive({
  manifest,
  target,
  cacheDir = defaultCacheDir,
  fetchImpl = fetch,
  policy = OFFICIAL_POLICY,
  url,
  log = () => {},
}) {
  const spec = manifest.targets[target];
  if (!spec) fail(`Manifest has no entry for target ${target}`);
  const destination = join(cacheDir, spec.sha256, spec.archive);
  try {
    const cached = await sha256File(destination);
    if (cached === spec.sha256) {
      logLine(log, `using cached ${spec.archive} (sha256 verified)`);
      return { path: destination, sha256: cached, cached: true };
    }
    logLine(log, `cached ${spec.archive} has a wrong hash; discarding it`);
    await rm(destination, { force: true });
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
  const result = await downloadVerifiedFile({
    url: url ?? archiveUrl(manifest, target),
    destination,
    expectedSha256: spec.sha256,
    policy,
    fetchImpl,
  });
  logLine(log, `downloaded ${spec.archive}: ${result.bytes} bytes, sha256 ${result.sha256}`);
  return { ...result, cached: false };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: EXTRACT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} exited with ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

function commandExists(command) {
  const result = spawnSync(command, ['--help'], { encoding: 'utf8', timeout: 10_000 });
  return !result.error && (result.status === 0 || result.status === 1);
}

function tarReadsZip(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  return !result.error && result.status === 0 && /(?:bsdtar|libarchive)/i.test(result.stdout ?? '');
}

/**
 * Picks an extractor for the Windows ZIP. Windows and macOS ship bsdtar as
 * `tar`; GNU tar (Linux) cannot read ZIP, so fall back to bsdtar or unzip.
 */
export function zipExtractor({
  platform = process.platform,
  hasCommand = commandExists,
  tarHandlesZip = tarReadsZip,
} = {}) {
  if (platform === 'win32') return { command: 'tar', style: 'tar' };
  if (tarHandlesZip('tar')) return { command: 'tar', style: 'tar' };
  if (hasCommand('bsdtar')) return { command: 'bsdtar', style: 'tar' };
  if (hasCommand('unzip')) return { command: 'unzip', style: 'unzip' };
  fail('extracting a Windows Node.js ZIP requires bsdtar or unzip; GNU tar cannot read ZIP archives');
}

/** Extracts only the Node binary and its LICENSE; the archive stays in the cache. */
export async function extractArchive({
  archivePath,
  target,
  version,
  destinationDir,
  tar = null,
  platform = process.platform,
}) {
  const entry = archiveEntry(version, target);
  const license = `${archiveRoot(version, target)}/LICENSE`;
  await mkdir(destinationDir, { recursive: true });
  if (/\.zip$/i.test(archivePath)) {
    const extractor = tar ? { command: tar, style: 'tar' } : zipExtractor({ platform });
    if (extractor.style === 'unzip') {
      run(extractor.command, ['-o', archivePath, entry, license, '-d', destinationDir]);
    } else {
      run(extractor.command, ['-xf', archivePath, '-C', destinationDir, entry, license]);
    }
  } else {
    run(tar ?? 'tar', ['-xf', archivePath, '-C', destinationDir, entry, license]);
  }
  const binary = join(destinationDir, entry);
  const licenseFile = join(destinationDir, license);
  await stat(binary);
  await stat(licenseFile);
  return { binary, license: licenseFile };
}

export function expectedVersionOutput(version) {
  return `v${version}`;
}

async function readCommandVersion(binary) {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (result.error) fail(`Cannot run ${binary}: ${result.error.message}`);
  if (result.status !== 0) fail(`${binary} --version exited with ${result.status}`);
  return result.stdout.trim();
}

/**
 * Downloads, verifies and installs the sidecar and the Node LICENSE. The
 * `--version` probe only runs for the host triple; a cross-target prefetch keeps
 * the hash guarantee and reports that execution was skipped.
 */
export async function fetchRuntime({
  target = hostTarget(),
  manifest = null,
  manifestPath = defaultManifestPath,
  binariesDir = defaultBinariesDir,
  licensesDir = defaultLicensesDir,
  cacheDir = defaultCacheDir,
  fetchImpl = fetch,
  policy = OFFICIAL_POLICY,
  archiveUrl: overrideUrl,
  tar = null,
  runVersionCheck = true,
  log = console.log,
} = {}) {
  const loaded = manifest ?? await loadManifest(manifestPath);
  validateManifest(loaded);
  const spec = loaded.targets[target];
  if (!spec) fail(`Manifest has no entry for target ${target}`);

  const archive = await ensureCachedArchive({
    manifest: loaded, target, cacheDir, fetchImpl, policy, url: overrideUrl, log,
  });
  const workDir = await mkdtemp(join(tmpdir(), 'knowlify-node-'));
  try {
    const extracted = await extractArchive({
      archivePath: archive.path, target, version: loaded.version, destinationDir: workDir, tar,
    });
    await mkdir(binariesDir, { recursive: true });
    const sidecarPath = join(binariesDir, sidecarName(target));
    await copyFile(extracted.binary, sidecarPath);
    if (TARGETS[target].platform !== 'win32') await chmod(sidecarPath, 0o755);
    await mkdir(licensesDir, { recursive: true });
    const licensePath = join(licensesDir, 'LICENSE');
    await copyFile(extracted.license, licensePath);

    const binarySha256 = await sha256File(sidecarPath);
    await writeFile(join(binariesDir, '.node-sha256'), `${binarySha256}  ${basename(sidecarPath)}\n`);
    logLine(log, `installed ${basename(sidecarPath)} (${binarySha256})`);

    if (runVersionCheck) {
      const expected = expectedVersionOutput(loaded.version);
      if (isHostTarget(target)) {
        const actual = await readCommandVersion(sidecarPath);
        if (actual !== expected) fail(`${basename(sidecarPath)} reports ${actual}, expected ${expected}`);
        logLine(log, `verified ${basename(sidecarPath)} --version = ${actual}`);
      } else {
        logLine(log, `skipping --version: ${target} cannot run on this host (hash verified)`);
      }
    }
    return { target, sidecarPath, licensePath, binarySha256, archiveSha256: spec.sha256 };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Proves the installed sidecar still matches the archive that was fetched. */
export async function verifyRuntime({
  target = hostTarget(),
  manifest = null,
  manifestPath = defaultManifestPath,
  binariesDir = defaultBinariesDir,
  log = console.log,
} = {}) {
  const loaded = manifest ?? await loadManifest(manifestPath);
  validateManifest(loaded);
  const sidecarPath = join(binariesDir, sidecarName(target));
  if (!existsSync(sidecarPath)) fail(`Missing ${sidecarPath}; run "npm run node:fetch -w @knowlify/desktop" first`);
  let recorded;
  try {
    recorded = (await readFile(join(binariesDir, '.node-sha256'), 'utf8')).trim().split(/\s+/)[0];
  } catch {
    fail(`Missing ${join(binariesDir, '.node-sha256')}; run "npm run node:fetch -w @knowlify/desktop" first`);
  }
  if (!sha256Pattern(recorded)) fail('binaries/.node-sha256 does not contain a SHA-256 hash');
  const actual = await sha256File(sidecarPath);
  if (actual !== recorded) fail(`${basename(sidecarPath)} does not match .node-sha256`);
  if (isHostTarget(target)) {
    const expected = expectedVersionOutput(loaded.version);
    const reported = await readCommandVersion(sidecarPath);
    if (reported !== expected) fail(`${basename(sidecarPath)} reports ${reported}, expected ${expected}`);
  }
  logLine(log, `${basename(sidecarPath)} matches .node-sha256`);
  return { sidecarPath, sha256: actual };
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function pickLatestLts(entries) {
  if (!Array.isArray(entries)) fail('nodejs.org/dist/index.json did not return an array');
  let best = null;
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.version !== 'string') continue;
    const version = parseNodeVersion(entry.version.replace(/^v/, ''));
    if (!version || version.major !== 22 || entry.lts === false || entry.lts == null) continue;
    if (best === null || compareVersions([version.major, version.minor, version.patch], best) > 0) {
      best = [version.major, version.minor, version.patch];
    }
  }
  if (best === null) fail('No Node.js 22.x LTS release found');
  return best.join('.');
}

async function fetchText(url, { fetchImpl = fetch, policy = OFFICIAL_POLICY, maxBytes = MAX_METADATA_BYTES } = {}) {
  checkUrl(url, policy);
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
      headers: { 'user-agent': 'knowlify-node-runtime' },
    });
  } catch (error) {
    fail(`Cannot fetch ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) fail(`Cannot fetch ${url}: HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) fail(`Response from ${url} exceeds ${maxBytes} bytes`);
  return text;
}

export function parseShasums(text) {
  const hashes = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match) hashes.set(match[2], match[1]);
  }
  return hashes;
}

function gpgAvailable() {
  const result = spawnSync('gpg', ['--version'], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

/** Verifies SHASUMS256.txt.sig when the release key is already in the keyring. */
export function verifySignedShasums({ shasums, signature, directory, log = console.log }) {
  if (!gpgAvailable()) {
    logLine(log, 'gpg is not installed; skipping the SHASUMS256.txt signature check (hash pin is the anchor)');
    return false;
  }
  const result = spawnSync('gpg', ['--verify', signature, shasums], { encoding: 'utf8', cwd: directory });
  if (!result.error && result.status === 0) {
    logLine(log, 'SHASUMS256.txt signature verified');
    return true;
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (/No public key|can't check signature|public key not found/i.test(output)) {
    logLine(log, 'Node.js release key is not in the keyring; skipping the signature check (hash pin is the anchor)');
    return false;
  }
  fail(`SHASUMS256.txt signature verification failed: ${output.trim()}`);
}

export async function fetchShasums({ version, fetchImpl = fetch, policy = OFFICIAL_POLICY, directory, log = console.log }) {
  const base = `${DIST_ORIGIN}/dist/v${version}/`;
  const text = await fetchText(`${base}SHASUMS256.txt`, { fetchImpl, policy });
  const hashes = parseShasums(text);
  let signaturePath;
  try {
    const signature = await fetchImpl(`${base}SHASUMS256.txt.sig`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
      headers: { 'user-agent': 'knowlify-node-runtime' },
    });
    if (signature.ok) {
      const bytes = Buffer.from(await signature.arrayBuffer());
      if (bytes.length > 16 * 1024) fail('SHASUMS256.txt.sig is unexpectedly large');
      signaturePath = join(directory, 'SHASUMS256.txt.sig');
      await writeFile(signaturePath, bytes);
    }
  } catch (error) {
    logLine(log, `could not download SHASUMS256.txt.sig: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (signaturePath) {
    const shasumsPath = join(directory, 'SHASUMS256.txt');
    await writeFile(shasumsPath, text);
    verifySignedShasums({ shasums: shasumsPath, signature: signaturePath, directory, log });
  } else {
    logLine(log, 'SHASUMS256.txt.sig is unavailable; skipping the signature check (hash pin is the anchor)');
  }
  return hashes;
}

/** Manual task: rewrites the manifest from the official index and SHASUMS file. */
export async function updateManifest({
  version = null,
  manifestPath = defaultManifestPath,
  fetchImpl = fetch,
  policy = OFFICIAL_POLICY,
  log = console.log,
} = {}) {
  let selected = version;
  if (selected === null) {
    const text = await fetchText(DIST_INDEX_URL, { fetchImpl, policy });
    selected = pickLatestLts(JSON.parse(text));
    logLine(log, `latest Node.js 22.x LTS is v${selected}`);
  } else {
    selected = selected.replace(/^v/, '');
  }
  const parsed = parseNodeVersion(selected);
  if (!parsed || parsed.major !== 22) fail(`Node.js 22.x required, got ${selected}`);

  const workDir = await mkdtemp(join(tmpdir(), 'knowlify-shasums-'));
  try {
    const hashes = await fetchShasums({ version: selected, fetchImpl, policy, directory: workDir, log });
    const targets = {};
    for (const target of SUPPORTED_TARGETS) {
      const archive = archiveName(selected, target);
      const sha256 = hashes.get(archive);
      if (!sha256) fail(`SHASUMS256.txt has no hash for ${archive}`);
      targets[target] = {
        archive,
        sha256,
        entry: archiveEntry(selected, target),
      };
    }
    const manifest = {
      version: selected,
      baseUrl: `${DIST_ORIGIN}/dist/v${selected}/`,
      targets,
    };
    validateManifest(manifest);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    logLine(log, `wrote ${manifestPath} for Node.js v${selected}`);
    return manifest;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const valueAfter = index => {
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`Missing value for ${rest[index]}`);
    return value;
  };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--target') {
      options.target = valueAfter(index);
      index += 1;
    } else if (argument === '--version') {
      options.version = valueAfter(index);
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  return { command, options };
}

function printUsage() {
  console.log(`Usage:
  node scripts/node-runtime.mjs fetch [--target <triple>]
  node scripts/node-runtime.mjs verify [--target <triple>]
  node scripts/node-runtime.mjs update [--version <X.Y.Z>]

Targets: ${SUPPORTED_TARGETS.join(', ')}`);
}

async function main(argv) {
  const { command, options } = parseArguments(argv);
  if (options.help || command === undefined) {
    printUsage();
    return;
  }
  if (command === 'fetch') {
    await fetchRuntime({ target: options.target ?? hostTarget(), log: console.log });
    return;
  }
  if (command === 'verify') {
    await verifyRuntime({ target: options.target ?? hostTarget(), log: console.log });
    return;
  }
  if (command === 'update') {
    await updateManifest({ version: options.version ?? null, log: console.log });
    return;
  }
  fail(`Unknown command "${command}"`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`[node-runtime] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
