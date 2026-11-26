import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { serverSupportsNetworkGuard, smokeEnv } from '../scripts/smoke-server.mjs';

test('smokeEnv binds every interface under the guard with the packaged web app', () => {
  const inherited = {
    PATH: '/bin',
    NODE_OPTIONS: '--require evil',
    NODE_PATH: '/evil',
    KNOWLIFY_NODE: '/evil/node',
    KNOWLIFY_TRUST_PROXY: 'on',
    KNOWLIFY_MCP_ALLOWED_HOSTS: 'evil.example',
    KNOWLIFY_MCP_ALLOWED_ORIGINS: 'https://evil.example',
    KNOWLIFY_FORCE_ENV_PASSWORD: '1',
  };

  const env = smokeEnv({
    port: 43_210,
    dataDir: '/data',
    webDir: '/resources/server/web',
    user: 'smoke',
    password: 'smoke-password',
  }, inherited);

  assert.equal(env.PATH, '/bin', 'the runtime still needs the host environment');
  assert.equal(env.HOST, '0.0.0.0');
  assert.equal(env.PORT, '43210');
  assert.equal(env.KNOWLIFY_NETWORK_GUARD, 'lan');
  assert.equal(env.KNOWLIFY_WEB_DIR, '/resources/server/web');
  assert.equal(env.KNOWLIFY_DATA, '/data');
  assert.equal(env.KNOWLIFY_USER, 'smoke');
  assert.equal(env.KNOWLIFY_PASSWORD, 'smoke-password');
  assert.equal(env.KNOWLIFY_ACCOUNT_LOCKED, '0');
  assert.equal(env.KNOWLIFY_MCP, 'off');
  assert.equal(env.KNOWLIFY_METADATA_LOOKUP, 'off');
  for (const name of Object.keys(inherited).filter(key => key !== 'PATH')) {
    assert.equal(name in env, false, `${name} must not reach the smoke server`);
  }
});

test('detects the network guard from the compiled server', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'knowlify-smoke-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dist = join(directory, 'dist');
  await mkdir(join(dist, 'adapters'), { recursive: true });
  await writeFile(
    join(dist, 'adapters', 'networkGuard.js'),
    'export const mode = process.env.KNOWLIFY_NETWORK_GUARD;\n',
  );
  assert.equal(await serverSupportsNetworkGuard(dist), true);

  const withoutGuard = join(directory, 'old-dist');
  await mkdir(withoutGuard, { recursive: true });
  await writeFile(join(withoutGuard, 'index.js'), 'export const server = true;\n');
  assert.equal(await serverSupportsNetworkGuard(withoutGuard), false);
});
