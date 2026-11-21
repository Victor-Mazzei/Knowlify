import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildServerManifest } from '../scripts/prepare-server.mjs';

const server = JSON.parse(
  await readFile(new URL('../../server/package.json', import.meta.url), 'utf8'),
);

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
