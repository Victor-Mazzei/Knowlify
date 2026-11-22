import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { SUPPORTED_NODE_MAJOR } from '../scripts/node-runtime.mjs';

/**
 * The bundled runtime manifest is the version source. The major is repeated in
 * .nvmrc, the Dockerfile and the workflows that run the test suite, so this
 * test fails with every mismatch instead of silently drifting apart.
 *
 * The repository is exported to GitHub without .gitea/, docs/ or export/,
 * where the same workflows live under .github/. Each layout declares its own
 * files: a file missing from its own layout is a divergence, never a skip.
 */
const repoFileUrl = relativePath => new URL(`../../../${relativePath}`, import.meta.url);
const readRepoFile = relativePath => readFile(repoFileUrl(relativePath), 'utf8');

const fileExists = async relativePath => {
  try {
    await stat(repoFileUrl(relativePath));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

const LAYOUTS = [
  {
    name: 'Gitea',
    marker: '.gitea/workflows/ci.yaml',
    workflows: [
      { path: '.gitea/workflows/ci.yaml', ci: true },
      { path: 'export/github/workflows/ci.yml', ci: true },
      // Generated from export/github and uses a step output, not a literal major.
      { path: 'export/github/workflows/release-desktop.yml', ci: false },
    ],
  },
  {
    name: 'GitHub export',
    marker: '.github/workflows/ci.yml',
    workflows: [
      { path: '.github/workflows/ci.yml', ci: true },
      { path: '.github/workflows/release-desktop.yml', ci: false },
    ],
  },
];

const detectLayout = async () => {
  const present = [];
  for (const layout of LAYOUTS) {
    if (await fileExists(layout.marker)) present.push(layout);
  }
  assert.equal(
    present.length,
    1,
    `expected exactly one repository layout, found ${present.map(layout => layout.name).join(', ') || 'none'}`,
  );
  return present[0];
};

test('the pinned Node.js major matches .nvmrc, the Dockerfile and every CI workflow', async () => {
  const layout = await detectLayout();
  const manifest = JSON.parse(await readRepoFile('apps/desktop/node-runtime.json'));
  const pinnedMajor = String(manifest.version).split('.')[0];
  const divergences = [];
  const verified = new Set();

  if (Number(pinnedMajor) !== SUPPORTED_NODE_MAJOR) {
    divergences.push(
      `apps/desktop/node-runtime.json pins ${pinnedMajor}; SUPPORTED_NODE_MAJOR is ${SUPPORTED_NODE_MAJOR}`,
    );
  }

  if (await fileExists('.nvmrc')) {
    verified.add('.nvmrc');
    const nvmrc = (await readRepoFile('.nvmrc')).trim();
    if (nvmrc !== pinnedMajor) {
      divergences.push(`.nvmrc has "${nvmrc}", expected "${pinnedMajor}"`);
    }
  } else {
    divergences.push('.nvmrc is missing');
  }

  if (await fileExists('Dockerfile')) {
    verified.add('Dockerfile');
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
  } else {
    divergences.push('Dockerfile is missing');
  }

  for (const workflow of layout.workflows) {
    if (!(await fileExists(workflow.path))) {
      divergences.push(`${workflow.path} is missing from the ${layout.name} layout`);
      continue;
    }
    verified.add(workflow.path);
    const text = await readRepoFile(workflow.path);
    const versions = [...text.matchAll(/^\s*node-version:\s*["']?(\d+)["']?\s*$/gim)];
    if (versions.length === 0) {
      if (workflow.ci) divergences.push(`${workflow.path} declares no node-version`);
      continue;
    }
    for (const [, major] of versions) {
      if (major !== pinnedMajor) {
        divergences.push(`${workflow.path} sets node-version "${major}", expected "${pinnedMajor}"`);
      }
    }
  }

  const requiredFiles = [
    '.nvmrc',
    'Dockerfile',
    layout.workflows.find(workflow => workflow.ci).path,
  ];
  for (const required of requiredFiles) {
    if (!verified.has(required)) divergences.push(`required file not verified: ${required}`);
  }

  if (divergences.length > 0) {
    assert.fail(`Node.js ${pinnedMajor} is not in lockstep:\n- ${divergences.join('\n- ')}`);
  }
});
