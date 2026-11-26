import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { zipExtractor } from '../scripts/node-runtime.mjs';
import {
  artifactFormat, artifactPlatform, assertArtifactTarget, pathEndsWithSegments, sidecarHashSkippedMessage,
  verifyBundle, verifyCodesign,
} from '../scripts/verify-bundle.mjs';
import { storedTarGz, storedZip } from '../test-support/fixtures.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const WINDOWS_TARGET = 'x86_64-pc-windows-msvc';
const MACOS_TARGET = 'aarch64-apple-darwin';
const LINUX_TARGET = 'x86_64-unknown-linux-gnu';
const SIDECAR = 'knowlify-node.exe';
const UNIX_SIDECAR = 'knowlify-node';
const BINARY = Buffer.from('MZ node runtime for the bundle fixture');
const SIGNED_BINARY = Buffer.from('signed Mach-O node runtime for the bundle fixture');
const LICENSE = Buffer.from('Node license fixture\n');
const versionScript = version => Buffer.from(`#!/bin/sh\nprintf '%s\\n' v${version}\n`);
const NOT_RUNNABLE_BINARY = Buffer.from('#!/nonexistent/knowlify-node-interpreter\n');
const server = JSON.parse(
  await readFile(new URL('../../server/package.json', import.meta.url), 'utf8'),
);
const manifest = JSON.parse(
  await readFile(new URL('../node-runtime.json', import.meta.url), 'utf8'),
);
const VERSION_SCRIPT = versionScript(manifest.version);
const WRONG_VERSION_SCRIPT = versionScript('0.0.0');
const WINDOWS_ROOT = `node-v${manifest.version}-win-x64`;
const MACOS_ROOT = `node-v${manifest.version}-darwin-arm64`;
const LINUX_ROOT = `node-v${manifest.version}-linux-x64`;

const archive = storedZip({
  [`${WINDOWS_ROOT}/node.exe`]: BINARY,
  [`${WINDOWS_ROOT}/LICENSE`]: LICENSE,
  [`${WINDOWS_ROOT}/README.md`]: 'not part of the sidecar',
});
const fixtureManifest = structuredClone(manifest);
fixtureManifest.targets[WINDOWS_TARGET].sha256 = sha256(archive);

const macArchive = storedTarGz({
  [`${MACOS_ROOT}/bin/node`]: BINARY,
  [`${MACOS_ROOT}/LICENSE`]: LICENSE,
});
const macManifest = structuredClone(manifest);
macManifest.targets[MACOS_TARGET].sha256 = sha256(macArchive);

const linuxArchive = storedTarGz({
  [`${LINUX_ROOT}/bin/node`]: BINARY,
  [`${LINUX_ROOT}/LICENSE`]: LICENSE,
});
const linuxManifest = structuredClone(manifest);
linuxManifest.targets[LINUX_TARGET].sha256 = sha256(linuxArchive);

function hasZipExtractor() {
  try {
    zipExtractor();
    return true;
  } catch {
    return false;
  }
}

const zipTestOptions = hasZipExtractor()
  ? {}
  : { skip: 'a ZIP-capable extractor (bsdtar or unzip) is not available' };

async function writeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const file = join(root, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

async function createBundle(t, { sidecar = BINARY, sidecarName = SIDECAR, bundleName = 'bundle' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'knowlify-verify-bundle-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = join(directory, bundleName);
  await writeTree(bundle, {
    'licenses/node/LICENSE': LICENSE,
    [sidecarName]: sidecar,
    'server/dist/index.js': 'export {};\n',
    'server/package.json': JSON.stringify({
      name: 'knowlify-desktop-server',
      private: true,
      type: 'module',
      version: server.version,
    }),
    'server/web/index.html': '<!doctype html><div id="root"></div>\n',
    'server/web/assets/app.js': 'console.log("web build");\n',
    'server/node_modules/fastify/package.json': '{}',
    'server/node_modules/better-sqlite3/package.json': '{}',
    'server/node_modules/better-sqlite3/prebuilds/win32-x64.node': 'native',
    'server/node_modules/better-sqlite3/prebuilds/linux-x64.node': 'native',
    'server/node_modules/better-sqlite3/prebuilds/darwin-arm64.node': 'native',
    'server/node_modules/better-sqlite3/prebuilds/darwin-x64.node': 'native',
    'server/node_modules/@napi-rs/canvas/package.json': '{}',
  });
  await chmod(join(bundle, sidecarName), 0o755);
  return { directory, bundle };
}

async function createMacBundle(t, { sidecar = SIGNED_BINARY, bundleName = 'Knowlify.app' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'knowlify-verify-bundle-mac-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = join(directory, bundleName);
  await writeTree(bundle, {
    'Contents/MacOS/knowlify-node': sidecar,
    'Contents/Resources/licenses/node/LICENSE': LICENSE,
    'Contents/Resources/server/dist/index.js': 'export {};\n',
    'Contents/Resources/server/package.json': JSON.stringify({
      name: 'knowlify-desktop-server',
      private: true,
      type: 'module',
      version: server.version,
    }),
    'Contents/Resources/server/web/index.html': '<!doctype html><div id="root"></div>\n',
    'Contents/Resources/server/node_modules/fastify/package.json': '{}',
    'Contents/Resources/server/node_modules/better-sqlite3/package.json': '{}',
    'Contents/Resources/server/node_modules/better-sqlite3/prebuilds/win32-x64.node': 'native',
    'Contents/Resources/server/node_modules/better-sqlite3/prebuilds/linux-x64.node': 'native',
    'Contents/Resources/server/node_modules/better-sqlite3/prebuilds/darwin-arm64.node': 'native',
    'Contents/Resources/server/node_modules/better-sqlite3/prebuilds/darwin-x64.node': 'native',
    'Contents/Resources/server/node_modules/@napi-rs/canvas/package.json': '{}',
  });
  await chmod(join(bundle, 'Contents/MacOS/knowlify-node'), 0o755);
  return { directory, bundle, sidecarPath: join(bundle, 'Contents/MacOS/knowlify-node') };
}

async function createCache(directory) {
  const cache = join(directory, 'cache');
  await mkdir(join(cache, sha256(archive)), { recursive: true });
  await writeFile(join(cache, sha256(archive), `${WINDOWS_ROOT}.zip`), archive);
  return cache;
}

async function createArchiveCache(directory, manifestFixture, target, archiveBytes) {
  const cache = join(directory, 'cache');
  await mkdir(join(cache, sha256(archiveBytes)), { recursive: true });
  await writeFile(join(cache, sha256(archiveBytes), manifestFixture.targets[target].archive), archiveBytes);
  return cache;
}

async function createPrePackagingSidecar(
  directory,
  target,
  { content = BINARY, writeRecorded = true, recordedHash = null } = {},
) {
  const binariesDir = join(directory, 'src-tauri', 'binaries');
  await mkdir(binariesDir, { recursive: true });
  const name = `knowlify-node-${target}`;
  const sidecarPath = join(binariesDir, name);
  await writeFile(sidecarPath, content);
  await chmod(sidecarPath, 0o755);
  if (writeRecorded) {
    await writeFile(join(binariesDir, '.node-sha256'), `${recordedHash ?? sha256(content)}  ${name}\n`);
  } else {
    await unlink(join(binariesDir, '.node-sha256')).catch(() => {});
  }
  return { binariesDir, sidecarPath };
}

function verifyOptions(bundle, directory, overrides = {}) {
  return {
    inputPath: bundle,
    explicitTarget: WINDOWS_TARGET,
    manifest: fixtureManifest,
    cacheDir: join(directory, 'missing-cache'),
    binariesDir: join(directory, 'binaries'),
    maxBytes: 250 * 1024 * 1024,
    logLine: () => {},
    warnLine: () => {},
    rawLine: () => {},
    ...overrides,
  };
}

function macVerifyOptions(bundle, directory, overrides = {}) {
  return {
    inputPath: bundle,
    explicitTarget: MACOS_TARGET,
    manifest: macManifest,
    cacheDir: join(directory, 'missing-cache'),
    binariesDir: join(directory, 'missing-binaries'),
    maxBytes: 250 * 1024 * 1024,
    logLine: () => {},
    warnLine: () => {},
    rawLine: () => {},
    ...overrides,
  };
}

test('accepts a sidecar whose hash derives from the pinned archive', zipTestOptions, async t => {
  const { directory, bundle } = await createBundle(t);
  const cacheDir = await createCache(directory);
  const binariesDir = join(directory, 'binaries');
  await mkdir(binariesDir, { recursive: true });
  await writeFile(join(binariesDir, '.node-sha256'), `${sha256(BINARY)}  ${SIDECAR}\n`);

  const result = await verifyBundle(verifyOptions(bundle, directory, { cacheDir, binariesDir }));

  assert.equal(result.target, WINDOWS_TARGET);
});

test('rejects a bundle without the web build served to the LAN', zipTestOptions, async t => {
  const { directory, bundle } = await createBundle(t);
  await unlink(join(bundle, 'server', 'web', 'index.html'));

  await assert.rejects(
    verifyBundle(verifyOptions(bundle, directory)),
    /server\/web\/index\.html is missing from the bundle.*prepare-server/s,
  );
});

test('rejects an empty web entry', zipTestOptions, async t => {
  const { directory, bundle } = await createBundle(t);
  await writeFile(join(bundle, 'server', 'web', 'index.html'), '');

  await assert.rejects(
    verifyBundle(verifyOptions(bundle, directory)),
    /server\/web\/index\.html is empty/,
  );
});

test('fails closed when only .node-sha256 is available', zipTestOptions, async t => {
  const { directory, bundle } = await createBundle(t);
  const binariesDir = join(directory, 'binaries');
  await mkdir(binariesDir, { recursive: true });
  // An attacker or a stale workspace can write any hash here; it must not
  // replace the archive pinned in node-runtime.json.
  await writeFile(join(binariesDir, '.node-sha256'), `${sha256(BINARY)}  ${SIDECAR}\n`);

  await assert.rejects(
    verifyBundle(verifyOptions(bundle, directory, { binariesDir })),
    /cannot verify the sidecar: no usable Node archive pinned in node-runtime\.json is cached.*node:fetch/s,
  );
});

test('does not trust .node-sha256 when the sidecar differs from the pinned archive', zipTestOptions, async t => {
  const tampered = Buffer.from('MZ replaced node runtime');
  const { directory, bundle } = await createBundle(t, { sidecar: tampered });
  const cacheDir = await createCache(directory);
  const binariesDir = join(directory, 'binaries');
  await mkdir(binariesDir, { recursive: true });
  await writeFile(join(binariesDir, '.node-sha256'), `${sha256(tampered)}  ${SIDECAR}\n`);

  await assert.rejects(
    verifyBundle(verifyOptions(bundle, directory, { cacheDir, binariesDir })),
    /does not match the Node archive pinned in node-runtime\.json/,
  );
});

test('rejects a stale .node-sha256 even when the sidecar matches the archive', zipTestOptions, async t => {
  const { directory, bundle } = await createBundle(t);
  const cacheDir = await createCache(directory);
  const binariesDir = join(directory, 'binaries');
  await mkdir(binariesDir, { recursive: true });
  await writeFile(join(binariesDir, '.node-sha256'), `${'0'.repeat(64)}  ${SIDECAR}\n`);

  await assert.rejects(
    verifyBundle(verifyOptions(bundle, directory, { cacheDir, binariesDir })),
    /stale or was tampered with/,
  );
});

test('rejects an explicit target whose pinned archive is not cached', zipTestOptions, async t => {
  const { directory, bundle } = await createBundle(t);
  const cacheDir = await createCache(directory);

  const version = manifest.version.replaceAll('.', '\\.');
  await assert.rejects(
    verifyBundle(verifyOptions(bundle, directory, {
      cacheDir,
      explicitTarget: 'x86_64-unknown-linux-gnu',
    })),
    new RegExp(`cannot verify x86_64-unknown-linux-gnu: its pinned node-v${version}-linux-x64\\.tar\\.xz is not usable from the cache.*node:fetch`, 's'),
  );
});

test('matches bundle paths with Windows or POSIX separators', () => {
  const segments = ['licenses', 'node', 'LICENSE'];
  assert.equal(pathEndsWithSegments('C:\\bundle\\licenses\\node\\LICENSE', segments), true);
  assert.equal(pathEndsWithSegments('/bundle/licenses/node/LICENSE', segments), true);
  assert.equal(pathEndsWithSegments('/bundle/licenses/node/LICENSE.md', segments), false);
  assert.equal(pathEndsWithSegments('/bundle/node/LICENSE', segments), false);
  assert.equal(pathEndsWithSegments('licenses\\node\\LICENSE', segments), true);
});

test('pins the exact messages used for rewritten bundle formats', () => {
  assert.deepEqual(
    ['AppImage', 'dmg', 'app'].map(sidecarHashSkippedMessage),
    [
      'sidecar hash: skipped for AppImage (rewritten by the packager; verified before packaging by node:fetch)',
      'sidecar hash: skipped for dmg (rewritten by the packager; verified before packaging by node:fetch)',
      'sidecar hash: skipped for app (rewritten by the packager; verified before packaging by node:fetch)',
    ],
  );
});

test('classifies rewritten and strict artifact formats', () => {
  assert.equal(artifactFormat('/dist/Knowlify_1.7.3_linux-x64.AppImage'), 'AppImage');
  assert.equal(artifactFormat('/dist/Knowlify_1.7.3_macos-arm64.dmg'), 'dmg');
  assert.equal(artifactFormat('/dist/Knowlify.app'), 'app');
  assert.equal(artifactFormat('/dist/Knowlify_1.7.3_linux-x64.deb'), 'strict');
  assert.equal(artifactFormat('/dist/Knowlify_1.7.3_linux-x64.rpm'), 'strict');
  assert.equal(artifactFormat('/dist/Knowlify_1.7.3_windows-x64-setup.exe'), 'strict');
  // A known suffix always wins over --target; only a generic directory may
  // borrow the macOS format from an explicit darwin target.
  for (const name of ['bundle.deb', 'bundle.rpm', 'bundle-setup.exe']) {
    assert.equal(artifactFormat(name, MACOS_TARGET), 'strict');
    assert.equal(artifactFormat(name, MACOS_TARGET, { isDirectory: true }), 'strict');
  }
  assert.equal(artifactFormat('/dist/extracted', MACOS_TARGET), 'strict');
  assert.equal(artifactFormat('/dist/extracted', MACOS_TARGET, { isDirectory: true }), 'app');
  assert.equal(artifactPlatform('/dist/Knowlify.AppImage'), 'linux');
  assert.equal(artifactPlatform('/dist/Knowlify.deb'), 'linux');
  assert.equal(artifactPlatform('/dist/Knowlify.rpm'), 'linux');
  assert.equal(artifactPlatform('/dist/Knowlify.dmg'), 'darwin');
  assert.equal(artifactPlatform('/dist/Knowlify.app'), 'darwin');
  assert.equal(artifactPlatform('/dist/Knowlify-setup.exe'), 'win32');
  assert.equal(artifactPlatform('/dist/extracted'), null);
});

test('rejects a target that contradicts a known artifact suffix', () => {
  assert.throws(
    () => assertArtifactTarget('/dist/bundle.deb', MACOS_TARGET),
    { message: `bundle.deb is a linux artifact and cannot be verified against the darwin target ${MACOS_TARGET}` },
  );
  assert.throws(
    () => assertArtifactTarget('/dist/bundle.rpm', MACOS_TARGET),
    { message: `bundle.rpm is a linux artifact and cannot be verified against the darwin target ${MACOS_TARGET}` },
  );
  assert.throws(
    () => assertArtifactTarget('/dist/setup.exe', LINUX_TARGET),
    { message: `setup.exe is a win32 artifact and cannot be verified against the linux target ${LINUX_TARGET}` },
  );
  assert.doesNotThrow(() => assertArtifactTarget('/dist/bundle.deb', LINUX_TARGET));
  assert.doesNotThrow(() => assertArtifactTarget('/dist/extracted', MACOS_TARGET));
});

test('accepts a rewritten macOS app sidecar whose hash changed and reports the skip', async t => {
  const { directory, bundle } = await createMacBundle(t);
  const cacheDir = await createArchiveCache(directory, macManifest, MACOS_TARGET, macArchive);
  const { binariesDir } = await createPrePackagingSidecar(directory, MACOS_TARGET);
  const raw = [];
  const logs = [];

  // No --target: the workflow calls verify-bundle with just the .dmg path, so
  // the target must come from the pre-packaging sidecar.
  const result = await verifyBundle(macVerifyOptions(bundle, directory, {
    explicitTarget: null,
    cacheDir,
    binariesDir,
    rawLine: line => raw.push(line),
    logLine: line => logs.push(line),
  }));

  assert.notEqual(sha256(SIGNED_BINARY), sha256(BINARY));
  assert.equal(result.target, MACOS_TARGET);
  assert.equal(result.format, 'app');
  assert.equal(result.hashCheck, 'skipped-rewritten');
  assert.deepEqual(raw, [sidecarHashSkippedMessage('app')]);
  assert.ok(logs.some(line => line.includes('pre-packaging sidecar')));
  assert.ok(!logs.some(line => /^sidecar .* sha256 matches node-runtime\.json/.test(line)));
});

test('accepts a rewritten dmg sidecar whose hash changed and reports the skip', async t => {
  const { directory, bundle } = await createMacBundle(t, { bundleName: 'Knowlify.dmg' });
  const cacheDir = await createArchiveCache(directory, macManifest, MACOS_TARGET, macArchive);
  const { binariesDir } = await createPrePackagingSidecar(directory, MACOS_TARGET);
  const raw = [];

  const result = await verifyBundle(macVerifyOptions(bundle, directory, {
    explicitTarget: null,
    cacheDir,
    binariesDir,
    rawLine: line => raw.push(line),
  }));

  assert.equal(result.format, 'dmg');
  assert.deepEqual(raw, [sidecarHashSkippedMessage('dmg')]);
});

test('rejects a macOS bundle when the pre-packaging sidecar is missing', async t => {
  const { directory, bundle } = await createMacBundle(t);
  const cacheDir = await createArchiveCache(directory, macManifest, MACOS_TARGET, macArchive);
  const raw = [];

  await assert.rejects(
    verifyBundle(macVerifyOptions(bundle, directory, {
      cacheDir,
      binariesDir: join(directory, 'src-tauri', 'binaries'),
      rawLine: line => raw.push(line),
    })),
    /pre-packaging sidecar .*knowlify-node-aarch64-apple-darwin is missing.*node:fetch/s,
  );
  assert.deepEqual(raw, []);
});

test('rejects a macOS bundle when the pre-packaging sidecar was replaced', async t => {
  const { directory, bundle } = await createMacBundle(t);
  const cacheDir = await createArchiveCache(directory, macManifest, MACOS_TARGET, macArchive);
  const replaced = Buffer.from('replaced before packaging');
  // The workspace hash file is rewritten too: only the pinned archive can tell.
  const { binariesDir } = await createPrePackagingSidecar(directory, MACOS_TARGET, {
    content: replaced,
    recordedHash: sha256(replaced),
  });
  const raw = [];

  await assert.rejects(
    verifyBundle(macVerifyOptions(bundle, directory, {
      cacheDir,
      binariesDir,
      rawLine: line => raw.push(line),
    })),
    /pre-packaging sidecar .* does not match the Node archive pinned in node-runtime\.json/,
  );
  assert.deepEqual(raw, []);
});

test('rejects a macOS bundle when .node-sha256 is missing', async t => {
  const { directory, bundle } = await createMacBundle(t);
  const cacheDir = await createArchiveCache(directory, macManifest, MACOS_TARGET, macArchive);
  const { binariesDir } = await createPrePackagingSidecar(directory, MACOS_TARGET, {
    writeRecorded: false,
  });

  await assert.rejects(
    verifyBundle(macVerifyOptions(bundle, directory, { cacheDir, binariesDir })),
    /\.node-sha256 is missing or invalid.*node:fetch/s,
  );
});

test('rejects a macOS bundle whose packaged sidecar is not executable', async t => {
  const { directory, bundle, sidecarPath } = await createMacBundle(t);
  const cacheDir = await createArchiveCache(directory, macManifest, MACOS_TARGET, macArchive);
  const { binariesDir } = await createPrePackagingSidecar(directory, MACOS_TARGET);
  await chmod(sidecarPath, 0o644);

  await assert.rejects(
    verifyBundle(macVerifyOptions(bundle, directory, { cacheDir, binariesDir })),
    /sidecar knowlify-node is not executable/,
  );
});

test('rejects a Linux sidecar whose hash differs from the pinned archive', async t => {
  const { directory, bundle } = await createBundle(t, {
    sidecar: Buffer.from('replaced Linux node runtime'),
    sidecarName: UNIX_SIDECAR,
  });
  const cacheDir = await createArchiveCache(directory, linuxManifest, LINUX_TARGET, linuxArchive);

  await assert.rejects(
    verifyBundle(verifyOptions(bundle, directory, {
      explicitTarget: LINUX_TARGET,
      manifest: linuxManifest,
      cacheDir,
    })),
    /knowlify-node sha256 .* does not match the Node archive pinned in node-runtime\.json/,
  );
});

test('accepts a rewritten AppImage sidecar whose hash changed and reports the skip', async t => {
  const { directory, bundle } = await createBundle(t, {
    bundleName: 'Knowlify.AppImage',
    sidecar: VERSION_SCRIPT,
    sidecarName: UNIX_SIDECAR,
  });
  const cacheDir = await createArchiveCache(directory, linuxManifest, LINUX_TARGET, linuxArchive);
  const { binariesDir } = await createPrePackagingSidecar(directory, LINUX_TARGET);
  const raw = [];
  const logs = [];

  // No --target: the workflow passes only the artifact path.
  const result = await verifyBundle(verifyOptions(bundle, directory, {
    explicitTarget: null,
    manifest: linuxManifest,
    cacheDir,
    binariesDir,
    rawLine: line => raw.push(line),
    logLine: line => logs.push(line),
  }));

  assert.notEqual(sha256(VERSION_SCRIPT), sha256(BINARY));
  assert.equal(result.format, 'AppImage');
  assert.equal(result.target, LINUX_TARGET);
  assert.equal(result.hashCheck, 'skipped-rewritten');
  assert.deepEqual(raw, [sidecarHashSkippedMessage('AppImage')]);
  assert.ok(logs.some(line => line.includes('pre-packaging sidecar')));
  assert.ok(!logs.some(line => /^sidecar .* sha256 matches node-runtime\.json/.test(line)));
  if (process.platform === 'linux') {
    assert.equal(result.version, `v${manifest.version}`);
  }
});

const appImageExtractionOnly = process.platform === 'win32'
  ? { skip: 'the AppImage runtime fixture is a POSIX shell script' }
  : {};

test('extracts an AppImage with its runtime before inspecting the bundle', appImageExtractionOnly, async t => {
  const { directory, bundle } = await createBundle(t, {
    bundleName: 'source-bundle',
    sidecar: VERSION_SCRIPT,
    sidecarName: UNIX_SIDECAR,
  });
  const imagePath = join(directory, 'Knowlify.AppImage');
  // The runtime extracts squashfs-root from the ELF payload; this fixture proves
  // verify-bundle uses that path and never hands the file to unsquashfs.
  await writeFile(imagePath, [
    '#!/bin/sh',
    'set -eu',
    'rm -rf squashfs-root',
    'mkdir squashfs-root',
    `cp -R ${JSON.stringify(bundle)}/. squashfs-root/`,
    '',
  ].join('\n'));
  const cacheDir = await createArchiveCache(directory, linuxManifest, LINUX_TARGET, linuxArchive);
  const { binariesDir } = await createPrePackagingSidecar(directory, LINUX_TARGET);
  const raw = [];

  const result = await verifyBundle(verifyOptions(imagePath, directory, {
    explicitTarget: null,
    manifest: linuxManifest,
    cacheDir,
    binariesDir,
    rawLine: line => raw.push(line),
  }));

  assert.equal(result.format, 'AppImage');
  assert.equal(result.target, LINUX_TARGET);
  assert.equal(result.hashCheck, 'skipped-rewritten');
  assert.deepEqual(raw, [sidecarHashSkippedMessage('AppImage')]);
});

const linuxExecutionOnly = process.platform === 'linux'
  ? {}
  : { skip: 'executing the AppImage sidecar requires a Linux host' };

test('rejects an AppImage sidecar that reports the wrong version', linuxExecutionOnly, async t => {
  const { directory, bundle } = await createBundle(t, {
    bundleName: 'Knowlify.AppImage',
    sidecar: WRONG_VERSION_SCRIPT,
    sidecarName: UNIX_SIDECAR,
  });
  const cacheDir = await createArchiveCache(directory, linuxManifest, LINUX_TARGET, linuxArchive);
  const { binariesDir } = await createPrePackagingSidecar(directory, LINUX_TARGET);

  await assert.rejects(
    verifyBundle(verifyOptions(bundle, directory, {
      explicitTarget: null,
      manifest: linuxManifest,
      cacheDir,
      binariesDir,
    })),
    error => error.message === `sidecar reports v0.0.0, expected v${manifest.version}`,
  );
});

test('rejects an AppImage sidecar that cannot run', linuxExecutionOnly, async t => {
  const { directory, bundle } = await createBundle(t, {
    bundleName: 'Knowlify.AppImage',
    sidecar: NOT_RUNNABLE_BINARY,
    sidecarName: UNIX_SIDECAR,
  });
  const cacheDir = await createArchiveCache(directory, linuxManifest, LINUX_TARGET, linuxArchive);
  const { binariesDir } = await createPrePackagingSidecar(directory, LINUX_TARGET);

  await assert.rejects(
    verifyBundle(verifyOptions(bundle, directory, {
      explicitTarget: null,
      manifest: linuxManifest,
      cacheDir,
      binariesDir,
    })),
    /failed:/,
  );
});

for (const [label, bundleName, sidecarName] of [
  ['deb', 'Knowlify.deb', UNIX_SIDECAR],
  ['rpm', 'Knowlify.rpm', UNIX_SIDECAR],
  ['NSIS', 'Knowlify-setup.exe', SIDECAR],
]) {
  test(`rejects a ${label} sidecar whose hash differs from the pinned archive`, async t => {
    const { directory, bundle } = await createBundle(t, {
      bundleName,
      sidecar: Buffer.from(`replaced ${label} node runtime`),
      sidecarName,
    });
    const cacheDir = await createArchiveCache(directory, linuxManifest, LINUX_TARGET, linuxArchive);
    const raw = [];

    await assert.rejects(
      verifyBundle(verifyOptions(bundle, directory, {
        explicitTarget: null,
        manifest: linuxManifest,
        cacheDir,
        rawLine: line => raw.push(line),
      })),
      /sha256 .* does not match the Node archive pinned in node-runtime\.json/,
    );
    assert.deepEqual(raw, []);
  });
}

for (const [label, bundleName, sidecarName, platform] of [
  ['deb', 'bundle.deb', UNIX_SIDECAR, 'linux'],
  ['rpm', 'bundle.rpm', UNIX_SIDECAR, 'linux'],
  ['NSIS', 'Knowlify-setup.exe', SIDECAR, 'win32'],
]) {
  test(`rejects an altered ${label} bundle even with a darwin --target`, async t => {
    const { directory, bundle } = await createBundle(t, {
      bundleName,
      sidecar: Buffer.from(`altered ${label} sidecar`),
      sidecarName,
    });
    // A complete, valid darwin pre-packaging proof would let the old app
    // classification skip this artifact's hash and pass; the conflict check
    // must reject it before any pre-packaging evidence is considered.
    const cacheDir = await createArchiveCache(directory, macManifest, MACOS_TARGET, macArchive);
    const { binariesDir } = await createPrePackagingSidecar(directory, MACOS_TARGET);
    const raw = [];
    const logs = [];

    await assert.rejects(
      verifyBundle(verifyOptions(bundle, directory, {
        explicitTarget: MACOS_TARGET,
        manifest: macManifest,
        cacheDir,
        binariesDir,
        rawLine: line => raw.push(line),
        logLine: line => logs.push(line),
      })),
      { message: `${bundleName} is a ${platform} artifact and cannot be verified against the darwin target ${MACOS_TARGET}` },
    );
    assert.deepEqual(raw, []);
    assert.ok(!logs.some(line => line.includes('pre-packaging sidecar')));
  });
}

test('still accepts a generic extracted directory with a darwin target', async t => {
  const { directory, bundle } = await createMacBundle(t, { bundleName: 'extracted-bundle' });
  const cacheDir = await createArchiveCache(directory, macManifest, MACOS_TARGET, macArchive);
  const { binariesDir } = await createPrePackagingSidecar(directory, MACOS_TARGET);
  const raw = [];

  const result = await verifyBundle(macVerifyOptions(bundle, directory, {
    cacheDir,
    binariesDir,
    rawLine: line => raw.push(line),
  }));

  assert.equal(result.format, 'app');
  assert.deepEqual(raw, [sidecarHashSkippedMessage('app')]);
});

test('verifyCodesign records a successful codesign check on macOS', () => {
  const logs = [];
  const calls = [];
  const sidecarPath = '/bundle/Knowlify.app/Contents/MacOS/knowlify-node';
  const result = verifyCodesign(sidecarPath, {
    platform: 'darwin',
    hasCommand: () => true,
    runCommand: (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    },
    logLine: line => logs.push(line),
    warnLine: () => {},
  });

  assert.deepEqual(result, { checked: true, reason: null });
  assert.deepEqual(calls, [['codesign', '--verify', '--strict', sidecarPath]]);
  assert.deepEqual(logs, ['codesign --verify knowlify-node: ok']);
});

test('verifyCodesign fails closed when codesign rejects the sidecar', () => {
  assert.throws(
    () => verifyCodesign('/bundle/Contents/MacOS/knowlify-node', {
      platform: 'darwin',
      hasCommand: () => true,
      runCommand: () => ({ status: 1, stdout: '', stderr: 'code object is not signed at all' }),
      logLine: () => {},
      warnLine: () => {},
    }),
    /codesign --verify failed for knowlify-node: code object is not signed at all/,
  );
});

test('verifyCodesign skips with a warning when codesign is unavailable', () => {
  const warnings = [];
  const result = verifyCodesign('/bundle/Contents/MacOS/knowlify-node', {
    platform: 'darwin',
    hasCommand: () => false,
    runCommand: () => {
      throw new Error('must not run');
    },
    logLine: () => {},
    warnLine: line => warnings.push(line),
  });

  assert.deepEqual(result, { checked: false, reason: 'missing-codesign' });
  assert.match(warnings[0], /codesign --verify skipped.*codesign is not available/);
});

test('verifyCodesign skips with a warning off macOS', () => {
  const warnings = [];
  const result = verifyCodesign('/bundle/Contents/MacOS/knowlify-node', {
    platform: 'linux',
    hasCommand: () => true,
    runCommand: () => {
      throw new Error('must not run');
    },
    logLine: () => {},
    warnLine: line => warnings.push(line),
  });

  assert.deepEqual(result, { checked: false, reason: 'not-macos' });
  assert.match(warnings[0], /codesign --verify skipped.*not running on macOS/);
});
