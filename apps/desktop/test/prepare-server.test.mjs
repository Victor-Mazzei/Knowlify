import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  assertBundledNodeMajor,
  assertSinglePlatform,
  buildServerManifest,
  overlayNodeModules,
  platformPackageAllowed,
  prepareServer,
  pruneServerTree,
  targetProfile,
} from '../scripts/prepare-server.mjs';

const server = JSON.parse(
  await readFile(new URL('../../server/package.json', import.meta.url), 'utf8'),
);

const exists = async path => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

async function writeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const file = join(root, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

async function createServerTree(t) {
  const directory = await mkdtemp(join(tmpdir(), 'knowlify-prepare-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nodeModules = join(directory, 'node_modules');
  await writeTree(nodeModules, {
    '@napi-rs/canvas/package.json': '{}',
    '@napi-rs/canvas/index.js': 'canvas',
    '@napi-rs/canvas-linux-x64-gnu/package.json': '{}',
    '@napi-rs/canvas-linux-x64-gnu/lib.node': 'linux',
    '@napi-rs/canvas-win32-x64-msvc/package.json': '{}',
    '@napi-rs/canvas-win32-x64-msvc/lib.node': 'windows',
    '@img/colour/package.json': '{}',
    '@img/colour/index.js.map': '{}',
    '@img/colour/test/colour.js': 'test',
    '@img/sharp-linux-x64/package.json': '{}',
    '@img/sharp-linux-x64/LICENSE': 'MIT',
    '@img/sharp-linux-x64/NOTICE.md': 'notice',
    '@img/sharp-win32-x64/package.json': '{}',
    '@img/sharp-wasm32/package.json': '{}',
    'better-sqlite3/package.json': '{}',
    'better-sqlite3/lib/index.js': 'code',
    'better-sqlite3/src/binding.cc': 'source',
    'better-sqlite3/deps/sqlite3.c': 'sqlite source',
    'better-sqlite3/build/Makefile': 'make',
    'better-sqlite3/prebuilds/linux-x64.node': 'linux binary',
    'better-sqlite3/prebuilds/linuxmusl-x64.node': 'musl binary',
    'better-sqlite3/prebuilds/win32-x64.node': 'windows binary',
    'better-sqlite3/prebuilds/darwin-arm64.node': 'macos binary',
    'better-sqlite3/LICENSE': 'MIT',
    'better-sqlite3/README.md': 'readme',
    'better-sqlite3/test/index.js': 'test',
    'onnxruntime-node/package.json': '{}',
    'onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1': 'cpu library',
    'onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_cuda.so': 'cuda',
    'onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_shared.so': 'shared',
    'onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node': 'binding',
    'onnxruntime-node/bin/napi-v6/linux/arm64/libonnxruntime.so.1': 'arm64',
    'onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.dylib': 'macos',
    'onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll': 'windows',
    'onnxruntime-web/package.json': '{}',
    'onnxruntime-web/dist/ort.wasm': 'wasm',
    'onnxruntime-web/docs/readme.md': 'doc',
    'onnxruntime-web/README.md': 'readme',
    'pdfjs-dist/package.json': '{}',
    'pdfjs-dist/build/index.js': 'code',
    'pdfjs-dist/build/index.js.map': '{}',
  });
  return { directory, nodeModules };
}

test('packaged server manifest carries the server version', () => {
  const manifest = buildServerManifest(server);

  assert.equal(typeof server.version, 'string');
  assert.equal(manifest.version, server.version);
});

test('packaged server manifest keeps the runtime fields used by the server', () => {
  const manifest = buildServerManifest(server);

  assert.deepEqual(
    { name: manifest.name, private: manifest.private, type: manifest.type },
    { name: 'knowlify-desktop-server', private: true, type: 'module' },
  );
  assert.deepEqual(manifest.dependencies, server.dependencies);
  assert.deepEqual(manifest.optionalDependencies, server.optionalDependencies ?? {});
});

test('packaged server manifest defaults optional dependencies to an empty object', () => {
  const manifest = buildServerManifest({ version: server.version, dependencies: {} });

  assert.deepEqual(manifest.optionalDependencies, {});
});

test('prune keeps only the target native payloads and preserves licenses', async t => {
  const { nodeModules } = await createServerTree(t);
  const target = 'x86_64-unknown-linux-gnu';

  await pruneServerTree(nodeModules, target, { log: () => {}, libc: 'gnu' });

  assert.equal(await exists(join(nodeModules, '@napi-rs/canvas-linux-x64-gnu')), true);
  assert.equal(await exists(join(nodeModules, '@napi-rs/canvas-win32-x64-msvc')), false);
  assert.equal(await exists(join(nodeModules, '@img/sharp-linux-x64')), true);
  assert.equal(await exists(join(nodeModules, '@img/sharp-win32-x64')), false);
  assert.equal(await exists(join(nodeModules, '@img/sharp-wasm32')), false);
  assert.equal(await exists(join(nodeModules, '@img/sharp-linux-x64/LICENSE')), true);
  assert.equal(await exists(join(nodeModules, '@img/sharp-linux-x64/NOTICE.md')), true);

  const onnx = join(nodeModules, 'onnxruntime-node', 'bin', 'napi-v6');
  assert.equal(await exists(join(onnx, 'linux', 'x64', 'libonnxruntime.so.1')), true);
  assert.equal(await exists(join(onnx, 'linux', 'x64', 'libonnxruntime_providers_cuda.so')), false);
  assert.equal(await exists(join(onnx, 'linux', 'x64', 'libonnxruntime_providers_shared.so')), false);
  assert.equal(await exists(join(onnx, 'linux', 'arm64')), false);
  assert.equal(await exists(join(onnx, 'darwin')), false);
  assert.equal(await exists(join(onnx, 'win32')), false);

  const sqlite = join(nodeModules, 'better-sqlite3');
  assert.equal(await exists(join(sqlite, 'deps')), false);
  assert.equal(await exists(join(sqlite, 'src')), false);
  assert.equal(await exists(join(sqlite, 'build')), false);
  assert.equal(await exists(join(sqlite, 'prebuilds', 'linux-x64.node')), true);
  assert.equal(await exists(join(sqlite, 'prebuilds', 'linuxmusl-x64.node')), false);
  assert.equal(await exists(join(sqlite, 'prebuilds', 'win32-x64.node')), false);
  assert.equal(await exists(join(sqlite, 'prebuilds', 'darwin-arm64.node')), false);
  assert.equal(await exists(join(sqlite, 'test')), false);
  assert.equal(await exists(join(sqlite, 'LICENSE')), true);
  assert.equal(await exists(join(sqlite, 'README.md')), true);

  assert.equal(await exists(join(nodeModules, 'pdfjs-dist', 'build', 'index.js.map')), false);
  assert.equal(await exists(join(nodeModules, 'pdfjs-dist', 'build', 'index.js')), true);
  assert.equal(await exists(join(nodeModules, 'onnxruntime-web', 'dist', 'ort.wasm')), true);
  assert.equal(await exists(join(nodeModules, 'onnxruntime-web', 'docs')), false);
  assert.equal(await exists(join(nodeModules, 'onnxruntime-web', 'README.md')), true);
  assert.equal(await exists(join(nodeModules, '@img/colour', 'index.js.map')), false);
  assert.equal(await exists(join(nodeModules, '@img/colour', 'test')), false);

  await assert.doesNotReject(() => assertSinglePlatform(nodeModules, target, { libc: 'gnu' }));
});

test('single-platform assertion rejects a package for another operating system', async t => {
  const { nodeModules } = await createServerTree(t);
  const target = 'x86_64-unknown-linux-gnu';
  await pruneServerTree(nodeModules, target, { log: () => {}, libc: 'gnu' });
  await writeTree(nodeModules, { '@napi-rs/canvas-win32-x64-msvc/package.json': '{}' });

  await assert.rejects(
    () => assertSinglePlatform(nodeModules, target, { libc: 'gnu' }),
    /packages for another platform: @napi-rs\/canvas-win32-x64-msvc/,
  );
});

test('platform matcher follows the target triple instead of the host', () => {
  const windows = targetProfile('x86_64-pc-windows-msvc');
  assert.equal(platformPackageAllowed('@napi-rs/canvas-win32-x64-msvc', windows), true);
  assert.equal(platformPackageAllowed('@napi-rs/canvas-linux-x64-gnu', windows), false);
  assert.equal(platformPackageAllowed('@img/sharp-win32-x64', windows), true);
  assert.equal(platformPackageAllowed('@img/sharp-linux-x64', windows), false);
  assert.equal(platformPackageAllowed('@img/sharp-wasm32', windows), false);
  assert.equal(platformPackageAllowed('onnxruntime-web', windows), true);
  assert.equal(platformPackageAllowed('fastify', windows), null);

  const macArm = targetProfile('aarch64-apple-darwin');
  assert.equal(platformPackageAllowed('@napi-rs/canvas-darwin-arm64', macArm), true);
  assert.equal(platformPackageAllowed('@napi-rs/canvas-darwin-x64', macArm), false);

  const linux = targetProfile('x86_64-unknown-linux-gnu', { libc: 'gnu' });
  assert.equal(platformPackageAllowed('@napi-rs/canvas-linux-x64-gnu', linux), true);
  assert.equal(platformPackageAllowed('@napi-rs/canvas-linux-x64-musl', linux), false);
  assert.equal(platformPackageAllowed('@img/sharp-linux-x64', linux), true);
  assert.equal(platformPackageAllowed('@img/sharp-linuxmusl-x64', linux), false);

  const anyLinux = targetProfile('x86_64-unknown-linux-gnu', { libc: null });
  assert.equal(platformPackageAllowed('@napi-rs/canvas-linux-x64-gnu', anyLinux), true);
  assert.equal(platformPackageAllowed('@napi-rs/canvas-linux-x64-musl', anyLinux), true);
  assert.equal(platformPackageAllowed('@img/sharp-linuxmusl-x64', anyLinux), true);
});

const abiMessage = (pinnedMajor, found) => `prepare-server must run with Node ${pinnedMajor} (found ${found}): the native modules must match the bundled Node ABI. Run: nvm use ${pinnedMajor}`;

test('accepts the bundled Node major regardless of minor and patch', () => {
  assert.doesNotThrow(() => assertBundledNodeMajor('26.0.0', '26.13.1'));
  assert.doesNotThrow(() => assertBundledNodeMajor('26.13.1', '26.13.1'));
});

test('rejects another Node major with the ABI message', () => {
  assert.throws(
    () => assertBundledNodeMajor('23.1.2', '26.13.1'),
    { message: abiMessage(26, '23.1.2') },
  );
  assert.throws(
    () => assertBundledNodeMajor('22.23.5', '26.13.1'),
    { message: abiMessage(26, '22.23.5') },
  );
  // The major in the message comes from the manifest, not from the host.
  assert.throws(
    () => assertBundledNodeMajor('23.1.2', '28.5.0'),
    { message: abiMessage(28, '23.1.2') },
  );
});

test('overlays a workspace-nested dependency over the hoisted copy', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'knowlify-prepare-overlay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hoisted = join(directory, 'hoisted');
  const workspace = join(directory, 'workspace');
  await writeTree(hoisted, {
    'pdfjs-dist/package.json': '{"version":"4.10.38"}',
    'pdfjs-dist/build/pdf.mjs': 'old build',
    'fastify/package.json': '{"version":"5.12.8"}',
    '.bin/fastify': 'bin',
  });
  await writeTree(workspace, {
    'pdfjs-dist/package.json': '{"version":"6.5.438"}',
    'pdfjs-dist/legacy/build/pdf.mjs': 'new build',
    '@scope/tool/package.json': '{"version":"1.0.0"}',
    '.bin/tsx': 'bin',
  });

  await overlayNodeModules(workspace, hoisted);

  assert.deepEqual(
    JSON.parse(await readFile(join(hoisted, 'pdfjs-dist/package.json'), 'utf8')),
    { version: '6.5.438' },
  );
  assert.equal(await exists(join(hoisted, 'pdfjs-dist/build/pdf.mjs')), false);
  assert.equal(await exists(join(hoisted, 'pdfjs-dist/legacy/build/pdf.mjs')), true);
  assert.equal(await exists(join(hoisted, '@scope/tool/package.json')), true);
  assert.equal(await exists(join(hoisted, 'fastify/package.json')), true);
  assert.equal(await exists(join(hoisted, '.bin/tsx')), false);
});

test('aborts before touching resources or installing on a major mismatch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'knowlify-prepare-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const resourcesDir = join(directory, 'resources');
  await mkdir(join(resourcesDir, 'server'), { recursive: true });
  await writeFile(join(resourcesDir, 'server', 'sentinel.txt'), 'kept');

  await assert.rejects(
    prepareServer({
      resourcesDir,
      nodeVersion: '23.1.2',
      skipBuild: true,
      log: () => {},
    }),
    { message: abiMessage(26, '23.1.2') },
  );

  assert.equal(await readFile(join(resourcesDir, 'server', 'sentinel.txt'), 'utf8'), 'kept');
  assert.equal(await exists(join(resourcesDir, 'server', 'dist')), false);
  assert.equal(await exists(join(resourcesDir, 'server', 'package.json')), false);
  assert.equal(await exists(join(resourcesDir, 'server', 'node_modules')), false);
});
