import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SUPPORTED_NODE_MAJOR } from '../scripts/node-runtime.mjs';

/**
 * The bundled runtime manifest is the version source. The major is repeated in
 * .nvmrc, the Dockerfile and the workflows that run the test suite, so this
 * test fails with every mismatch instead of silently drifting apart.
 */
const readRepoFile = relativePath => readFile(new URL(`../../../${relativePath}`, import.meta.url), 'utf8');

test('the pinned Node.js major matches .nvmrc, the Dockerfile and both CI workflows', async () => {
  const manifest = JSON.parse(await readRepoFile('apps/desktop/node-runtime.json'));
  const pinnedMajor = String(manifest.version).split('.')[0];
  const divergences = [];

  if (Number(pinnedMajor) !== SUPPORTED_NODE_MAJOR) {
    divergences.push(
      `apps/desktop/node-runtime.json pins ${pinnedMajor}; SUPPORTED_NODE_MAJOR is ${SUPPORTED_NODE_MAJOR}`,
    );
  }

  const nvmrc = (await readRepoFile('.nvmrc')).trim();
  if (nvmrc !== pinnedMajor) {
    divergences.push(`.nvmrc has "${nvmrc}", expected "${pinnedMajor}"`);
  }

  const dockerfile = await readRepoFile('Dockerfile');
  const dockerStages = [...dockerfile.matchAll(/^FROM\s+node:(\d+)/gim)];
  if (dockerStages.length === 0) {
    divergences.push('Dockerfile has no "FROM node:<major>" stage');
  }
  for (const [, major] of dockerStages) {
    if (major !== pinnedMajor) {
      divergences.push(`Dockerfile uses node:${major}, expected node:${pinnedMajor}`);
    }
  }

  for (const workflow of ['.gitea/workflows/ci.yaml', 'export/github/workflows/ci.yml']) {
    const text = await readRepoFile(workflow);
    const versions = [...text.matchAll(/^\s*node-version:\s*["']?(\d+)["']?\s*$/gim)];
    if (versions.length === 0) {
      divergences.push(`${workflow} declares no node-version`);
    }
    for (const [, major] of versions) {
      if (major !== pinnedMajor) {
        divergences.push(`${workflow} sets node-version "${major}", expected "${pinnedMajor}"`);
      }
    }
  }

  if (divergences.length > 0) {
    assert.fail(`Node.js ${pinnedMajor} is not in lockstep:\n- ${divergences.join('\n- ')}`);
  }
});
