import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  archiveEntry,
  archiveName,
  downloadVerifiedFile,
  ensureCachedArchive,
  extractArchive,
  fetchRuntime,
  loadManifest,
  MAX_ARCHIVE_BYTES,
  parseShasums,
  pickLatestLts,
  sidecarName,
  SUPPORTED_NODE_MAJOR,
  SUPPORTED_TARGETS,
  updateManifest,
  validateManifest,
  zipExtractor,
} from '../scripts/node-runtime.mjs';
import { storedZip } from '../test-support/fixtures.mjs';

const manifestUrl = new URL('../node-runtime.json', import.meta.url);
const manifestText = await readFile(manifestUrl, 'utf8');
const manifest = JSON.parse(manifestText);
const LOCAL_POLICY = { protocols: ['http:'], hosts: ['127.0.0.1'] };

const sha256 = value => createHash('sha256').update(value).digest('hex');

const WINDOWS_TARGET = 'x86_64-pc-windows-msvc';
const WINDOWS_ROOT = `node-v${manifest.version}-win-x64`;

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

function windowsZipFixture() {
  return storedZip({
    [`${WINDOWS_ROOT}/node.exe`]: 'MZ node runtime fixture',
    [`${WINDOWS_ROOT}/LICENSE`]: 'Node license fixture',
    [`${WINDOWS_ROOT}/README.md`]: 'must not be extracted',
  });
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'knowlify-node-runtime-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function withHttpServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function fixtureManifest(archiveUrl, sha256Value, target = 'x86_64-unknown-linux-gnu') {
  return {
    ...manifest,
    targets: {
      ...manifest.targets,
      [target]: { ...manifest.targets[target], sha256: sha256Value },
    },
  };
}

test('manifest pins a supported Node.js 26 LTS release for the four desktop targets', async () => {
  const loaded = await loadManifest(fileURLToPath(manifestUrl));
  assert.deepEqual(loaded, manifest);
  validateManifest(loaded);

  const [major, minor, patch] = loaded.version.split('.').map(Number);
  assert.equal(major, SUPPORTED_NODE_MAJOR);
  assert.ok(minor > 13 || (minor === 13 && patch >= 1), `expected >= 26.13.1, got ${loaded.version}`);
  assert.equal(loaded.baseUrl, `https://nodejs.org/dist/v${loaded.version}/`);
  assert.deepEqual(Object.keys(loaded.targets).sort(), [...SUPPORTED_TARGETS].sort());
  const expectedEntries = {
    'x86_64-pc-windows-msvc': `${WINDOWS_ROOT}/node.exe`,
    'aarch64-apple-darwin': `node-v${loaded.version}-darwin-arm64/bin/node`,
    'x86_64-apple-darwin': `node-v${loaded.version}-darwin-x64/bin/node`,
    'x86_64-unknown-linux-gnu': `node-v${loaded.version}-linux-x64/bin/node`,
  };
  for (const target of SUPPORTED_TARGETS) {
    const spec = loaded.targets[target];
    assert.match(spec.sha256, /^[0-9a-f]{64}$/);
    assert.equal(spec.archive, archiveName(loaded.version, target));
    assert.equal(spec.entry, archiveEntry(loaded.version, target));
    assert.equal(spec.entry, expectedEntries[target]);
  }
  // Regression: the official Windows ZIP has node.exe at the archive root, not in bin/.
  assert.equal(loaded.targets[WINDOWS_TARGET].entry, `${WINDOWS_ROOT}/node.exe`);
  assert.equal(manifestText.endsWith('\n'), true);
});

test('manifest validation rejects a wrong major, a bad hash and a missing target', () => {
  const wrongMajor = structuredClone(manifest);
  wrongMajor.version = '24.1.0';
  wrongMajor.baseUrl = 'https://nodejs.org/dist/v24.1.0/';
  assert.throws(() => validateManifest(wrongMajor), /must pin Node\.js 26\.x/);

  const badHash = structuredClone(manifest);
  badHash.targets['x86_64-unknown-linux-gnu'].sha256 = 'xyz';
  assert.throws(() => validateManifest(badHash), /sha256 must be 64 lowercase hex/);

  const missing = structuredClone(manifest);
  delete missing.targets['aarch64-apple-darwin'];
  assert.throws(() => validateManifest(missing), /exactly these targets/);

  const linuxRoot = `node-v${manifest.version}-linux-x64`;
  const wrongWindowsEntry = structuredClone(manifest);
  wrongWindowsEntry.targets[WINDOWS_TARGET].entry = `${WINDOWS_ROOT}/bin/node.exe`;
  assert.throws(() => validateManifest(wrongWindowsEntry), {
    message: `node-runtime.json target ${WINDOWS_TARGET} entry must be ${WINDOWS_ROOT}/node.exe`,
  });

  const wrongUnixEntry = structuredClone(manifest);
  wrongUnixEntry.targets['x86_64-unknown-linux-gnu'].entry = `${linuxRoot}/node`;
  assert.throws(() => validateManifest(wrongUnixEntry), {
    message: `node-runtime.json target x86_64-unknown-linux-gnu entry must be ${linuxRoot}/bin/node`,
  });
});

test('archive entries follow the official archive layout per target', () => {
  assert.equal(archiveEntry(manifest.version, WINDOWS_TARGET), `${WINDOWS_ROOT}/node.exe`);
  assert.equal(
    archiveEntry(manifest.version, 'aarch64-apple-darwin'),
    `node-v${manifest.version}-darwin-arm64/bin/node`,
  );
  assert.equal(
    archiveEntry(manifest.version, 'x86_64-unknown-linux-gnu'),
    `node-v${manifest.version}-linux-x64/bin/node`,
  );
});

test('download rejects a SHA-256 mismatch and removes the partial file', async t => {
  const directory = await temporaryDirectory(t);
  const baseUrl = await withHttpServer(t, (_request, response) => {
    response.writeHead(200, { 'content-length': 5 });
    response.end('hello');
  });
  const destination = join(directory, 'node.tar.xz');
  await assert.rejects(
    downloadVerifiedFile({
      url: `${baseUrl}/node.tar.xz`,
      destination,
      expectedSha256: '0'.repeat(64),
      policy: LOCAL_POLICY,
      maxBytes: MAX_ARCHIVE_BYTES,
    }),
    /SHA-256 mismatch/,
  );
  await assert.rejects(readFile(destination));
  await assert.rejects(readFile(`${destination}.part`));
});

test('download rejects a truncated body announced by content-length', async t => {
  const directory = await temporaryDirectory(t);
  const baseUrl = await withHttpServer(t, (_request, response) => {
    response.writeHead(200, { 'content-length': 1_000 });
    response.write('short');
    response.destroy();
  });
  const destination = join(directory, 'node.tar.xz');
  await assert.rejects(
    downloadVerifiedFile({
      url: `${baseUrl}/node.tar.xz`,
      destination,
      expectedSha256: sha256('short'),
      policy: LOCAL_POLICY,
    }),
    /truncated|terminated|Download failed|body/i,
  );
  await assert.rejects(readFile(destination));
});

test('download refuses redirects and hosts outside the policy', async t => {
  const directory = await temporaryDirectory(t);
  const baseUrl = await withHttpServer(t, (_request, response) => {
    response.writeHead(302, { location: 'https://nodejs.org/dist/index.json' });
    response.end();
  });
  await assert.rejects(
    downloadVerifiedFile({
      url: `${baseUrl}/node.tar.xz`,
      destination: join(directory, 'node.tar.xz'),
      expectedSha256: '0'.repeat(64),
      policy: LOCAL_POLICY,
    }),
    /Refusing redirect/,
  );
  await assert.rejects(
    downloadVerifiedFile({
      url: `${baseUrl}/node.tar.xz`,
      destination: join(directory, 'other.tar.xz'),
      expectedSha256: '0'.repeat(64),
    }),
    /Refusing/,
  );
});

test('cached archives are hashed again and a poisoned cache entry is replaced', async t => {
  const directory = await temporaryDirectory(t);
  const body = Buffer.from('official archive bytes');
  const expected = sha256(body);
  const baseUrl = await withHttpServer(t, (_request, response) => {
    response.writeHead(200, { 'content-length': body.length });
    response.end(body);
  });
  const fixture = fixtureManifest(`${baseUrl}/node.tar.xz`, expected);
  const spec = fixture.targets['x86_64-unknown-linux-gnu'];
  const cachedPath = join(directory, spec.sha256, spec.archive);
  await mkdir(join(directory, spec.sha256), { recursive: true });
  await writeFile(cachedPath, 'poisoned');

  const result = await ensureCachedArchive({
    manifest: fixture,
    target: 'x86_64-unknown-linux-gnu',
    cacheDir: directory,
    url: `${baseUrl}/node.tar.xz`,
    policy: LOCAL_POLICY,
  });
  assert.equal(result.cached, false);
  assert.equal(result.sha256, expected);
  assert.equal(sha256(await readFile(cachedPath)), expected);
});

test('SHASUMS parsing keeps the official hashes for the four archives', () => {
  const text = `
${'a'.repeat(64)}  node-v1.0.0-darwin-arm64.tar.gz
${'b'.repeat(64)} *node-v1.0.0-darwin-x64.tar.gz
invalid line
`;
  const hashes = parseShasums(text);
  assert.equal(hashes.get('node-v1.0.0-darwin-arm64.tar.gz'), 'a'.repeat(64));
  assert.equal(hashes.get('node-v1.0.0-darwin-x64.tar.gz'), 'b'.repeat(64));
  assert.equal(hashes.size, 2);
});

test('latest 26.x LTS selection ignores non-LTS, other majors and older releases', () => {
  const entries = [
    { version: 'v26.13.1', lts: 'Lithium' },
    { version: 'v24.22.3', lts: 'Krypton' },
    { version: 'v26.14.0', lts: false },
    { version: 'v26.12.0', lts: 'Lithium' },
    { version: 'v27.1.0', lts: false },
  ];
  assert.equal(pickLatestLts(entries), '26.13.1');
});

test('ZIP extraction uses the absolute Windows bsdtar, not GNU tar from Git Bash', () => {
  assert.deepEqual(
    zipExtractor({ platform: 'win32', systemRoot: 'D:\\Windows', fileExists: () => true }),
    { command: 'D:\\Windows\\System32\\tar.exe', style: 'tar' },
  );
  assert.throws(
    () => zipExtractor({ platform: 'win32', systemRoot: 'D:\\Windows', fileExists: () => false }),
    /Windows bsdtar not found at D:\\Windows\\System32\\tar\.exe/,
  );
});

test('ZIP extraction refuses GNU tar without a fallback', () => {
  assert.deepEqual(
    zipExtractor({ platform: 'linux', tarHandlesZip: () => true, hasCommand: () => false }),
    { command: 'tar', style: 'tar' },
  );
  assert.deepEqual(
    zipExtractor({ platform: 'linux', tarHandlesZip: () => false, hasCommand: name => name === 'bsdtar' }),
    { command: 'bsdtar', style: 'tar' },
  );
  assert.deepEqual(
    zipExtractor({ platform: 'linux', tarHandlesZip: () => false, hasCommand: name => name === 'unzip' }),
    { command: 'unzip', style: 'unzip' },
  );
  assert.throws(
    () => zipExtractor({ platform: 'linux', tarHandlesZip: () => false, hasCommand: () => false }),
    /bsdtar or unzip/,
  );
});

test('extractArchive reads node.exe from the root of the official Windows layout', zipTestOptions, async t => {
  const directory = await temporaryDirectory(t);
  const archivePath = join(directory, archiveName(manifest.version, WINDOWS_TARGET));
  await writeFile(archivePath, windowsZipFixture());
  const destinationDir = join(directory, 'work');

  const extracted = await extractArchive({
    archivePath,
    target: WINDOWS_TARGET,
    version: manifest.version,
    destinationDir,
  });

  assert.equal(extracted.binary, join(destinationDir, WINDOWS_ROOT, 'node.exe'));
  assert.equal(await readFile(extracted.binary, 'utf8'), 'MZ node runtime fixture');
  assert.equal(await readFile(extracted.license, 'utf8'), 'Node license fixture');
  await assert.rejects(readFile(join(destinationDir, WINDOWS_ROOT, 'README.md')));
});

test('fetchRuntime installs the Windows sidecar from the archive root', zipTestOptions, async t => {
  const directory = await temporaryDirectory(t);
  const zip = windowsZipFixture();
  const baseUrl = await withHttpServer(t, (_request, response) => {
    response.writeHead(200, { 'content-length': zip.length });
    response.end(zip);
  });
  const fixture = structuredClone(manifest);
  fixture.targets[WINDOWS_TARGET].sha256 = sha256(zip);

  const result = await fetchRuntime({
    target: WINDOWS_TARGET,
    manifest: fixture,
    binariesDir: join(directory, 'binaries'),
    licensesDir: join(directory, 'licenses'),
    cacheDir: join(directory, 'cache'),
    archiveUrl: `${baseUrl}/${archiveName(manifest.version, WINDOWS_TARGET)}`,
    policy: LOCAL_POLICY,
    runVersionCheck: false,
    log: () => {},
  });

  assert.equal(
    result.sidecarPath,
    join(directory, 'binaries', sidecarName(WINDOWS_TARGET)),
  );
  assert.equal(await readFile(result.sidecarPath, 'utf8'), 'MZ node runtime fixture');
  assert.equal(await readFile(result.licensePath, 'utf8'), 'Node license fixture');
  assert.equal(
    await readFile(join(directory, 'binaries', '.node-sha256'), 'utf8'),
    `${sha256('MZ node runtime fixture')}  ${sidecarName(WINDOWS_TARGET)}\n`,
  );
});

test('updateManifest writes the contracted entry without bin/ on Windows', async t => {
  const directory = await temporaryDirectory(t);
  const manifestPath = join(directory, 'node-runtime.json');
  const shasums = SUPPORTED_TARGETS.map((target, index) => (
    `${String(index + 1).repeat(64).slice(0, 64)}  ${archiveName(manifest.version, target)}`
  )).join('\n');
  const requested = [];
  const fetchImpl = async url => {
    requested.push(String(url));
    if (String(url).endsWith('SHASUMS256.txt')) return new Response(shasums, { status: 200 });
    return new Response('', { status: 404 });
  };

  const updated = await updateManifest({
    version: manifest.version,
    manifestPath,
    fetchImpl,
    log: () => {},
  });

  assert.equal(updated.targets[WINDOWS_TARGET].entry, `${WINDOWS_ROOT}/node.exe`);
  assert.equal(
    updated.targets['x86_64-unknown-linux-gnu'].entry,
    `node-v${manifest.version}-linux-x64/bin/node`,
  );
  assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), updated);
  validateManifest(updated);
  assert.equal(requested.some(url => url.endsWith('SHASUMS256.txt')), true);
});
