import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const readJson = async path =>
  JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const readText = path => readFile(new URL(path, import.meta.url), 'utf8');

// Release builds pass this overlay with `tauri build --config`; the base config
// must stay sidecar-free so `cargo check/test/clippy` run without downloading
// the bundled Node runtime.
const base = await readJson('../src-tauri/tauri.conf.json');
const overlay = await readJson('../src-tauri/tauri.bundle.conf.json');
const rootPackage = await readJson('../../../package.json');

const REQUIRED_ICONS = [
  'icons/32x32.png',
  'icons/128x128.png',
  'icons/128x128@2x.png',
  'icons/icon.icns',
  'icons/icon.ico',
  'icons/icon.png',
];

test('base config does not declare the Node sidecar', () => {
  assert.equal(
    base.bundle?.externalBin,
    undefined,
    'the base config must not embed binaries; use the release overlay',
  );
  assert.deepEqual(
    base.bundle?.resources,
    { 'resources/server/': 'server/' },
    'the base config bundles only the server, so Rust checks need no license tree',
  );
});

test('release overlay embeds the bundled Node under the knowlify-node name', () => {
  assert.deepEqual(overlay.bundle?.externalBin, ['binaries/knowlify-node']);

  // Tauri appends the target triple. The bare name is installed next to the app
  // (and in /usr/bin for deb/rpm), so it must never collide with the distro
  // `node` package.
  const name = overlay.bundle.externalBin[0].split('/').pop();
  assert.equal(name, 'knowlify-node');
  assert.notEqual(name, 'node');
});

test('release overlay bundles the server tree and the third-party licenses', () => {
  assert.deepEqual(overlay.bundle?.resources, {
    'resources/server/': 'server/',
    'resources/licenses/': 'licenses/',
  });
});

test('release overlay keeps exactly the per-platform target set', () => {
  // Tauri filters this list by the host platform at bundle time, so one overlay
  // serves the matrix: Linux keeps deb/rpm/AppImage, macOS keeps app/dmg and
  // Windows keeps NSIS. MSI (and pacman) stay out on purpose: the release is
  // NSIS-only on Windows. Release jobs also narrow the list with `--bundles`.
  assert.equal(base.bundle?.targets, 'all');
  assert.deepEqual(overlay.bundle?.targets, [
    'deb',
    'rpm',
    'appimage',
    'dmg',
    'app',
    'nsis',
  ]);
});

test('release overlay signs macOS ad-hoc without the hardened runtime', () => {
  assert.equal(overlay.bundle?.macOS?.minimumSystemVersion, '13.5');
  // Unsigned distribution: only the notarization phase needs the hardened
  // runtime. With it off, the bundler runs `codesign -s -` without
  // `--options runtime`, so the Node sidecar keeps its allow-jit entitlement.
  assert.equal(overlay.bundle?.macOS?.signingIdentity, '-');
  assert.equal(overlay.bundle?.macOS?.hardenedRuntime, false);
  assert.equal(
    overlay.bundle?.windows?.nsis?.installMode,
    'currentUser',
    'Windows installs per user, without Administrator access',
  );
});

test('release overlay only changes bundling and cannot relax the webview', async () => {
  assert.deepEqual(Object.keys(overlay).sort(), ['$schema', 'bundle']);
  assert.equal(overlay.app, undefined, 'the overlay must not touch app security');
  assert.equal(overlay.identifier, undefined);
  assert.equal(overlay.productName, undefined);
  assert.equal(overlay.version, undefined);

  const raw = await readText('../src-tauri/tauri.bundle.conf.json');
  assert.ok(
    !/"(csp|devCsp|security|capabilities|permissions)"/.test(raw),
    'the overlay must not mention CSP or capabilities',
  );
});

test('product name and identifier stay stable so current installs keep their data', () => {
  assert.equal(base.productName, 'Knowlify');
  assert.equal(base.identifier, 'com.knowlify.desktop');
  assert.equal(overlay.productName, undefined);
  assert.equal(overlay.identifier, undefined);
});

test('base config carries the package metadata used by the installers', () => {
  // The deb Maintainer falls back to `publisher` when Cargo.toml has no
  // authors; keep it without an email. A future signing/notarization phase
  // should re-enable `macOS.hardenedRuntime` and add an entitlements.plist with
  // com.apple.security.cs.allow-jit, allow-unsigned-executable-memory and
  // disable-library-validation for the Node sidecar (V8 JIT).
  assert.equal(base.bundle?.publisher, 'Victor Mota Mazzei');
  assert.equal(base.bundle?.copyright, 'Copyright (C) 2026 Knowlify.');
  assert.equal(
    base.bundle?.shortDescription,
    'Personal knowledge hub and ebook reader',
  );
  assert.equal(
    base.bundle?.longDescription,
    'Knowlify is a local-first library for your PDF and EPUB books, with a reader, notes and an optional AI tutor.',
  );
  assert.equal(base.bundle?.category, 'Education');
  const metadata = [
    base.bundle?.publisher,
    base.bundle?.copyright,
    base.bundle?.shortDescription,
    base.bundle?.longDescription,
  ];
  assert.ok(
    metadata.every(value => !value.includes('@')),
    'package metadata must not expose an email address',
  );
});

test('the base version stays in lockstep with the root package version', () => {
  assert.equal(base.version, rootPackage.version);
});

test('every icon referenced by the base config exists on disk', async () => {
  const icons = base.bundle?.icon ?? [];
  for (const icon of REQUIRED_ICONS) {
    assert.ok(icons.includes(icon), `bundle.icon must reference ${icon}`);
  }
  assert.equal(overlay.bundle?.icon, undefined);

  for (const icon of icons) {
    const info = await stat(new URL(`../src-tauri/${icon}`, import.meta.url));
    assert.ok(info.isFile(), `${icon} must be a file`);
    assert.ok(info.size > 0, `${icon} must not be empty`);
  }
});

test('Microsoft Store logos are not referenced by the installer bundle', () => {
  const icons = base.bundle?.icon ?? [];
  assert.ok(
    !icons.some(icon => /(?:Square\d+x\d+Logo|StoreLogo)\.png$/.test(icon)),
    'NSIS does not use the Microsoft Store logo set',
  );
});
