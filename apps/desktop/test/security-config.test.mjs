import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readJson = async path =>
  JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

const config = await readJson('../src-tauri/tauri.conf.json');

test('production webview sets a restrictive content security policy', () => {
  const csp = config.app?.security?.csp;
  assert.equal(typeof csp, 'string', 'csp must be a string');
  for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'none'",
    "worker-src 'self' blob:",
  ]) {
    assert.ok(csp.includes(directive), `CSP must include ${directive}`);
  }
  assert.ok(!csp.includes("'unsafe-eval'"), 'CSP must not allow eval');
  assert.ok(
    csp.includes("'wasm-unsafe-eval'"),
    'PDF.js 6 compiles its image codecs with WebAssembly',
  );
  assert.ok(!csp.includes('ws:'), 'production CSP must not allow websockets');
});

test('dev CSP keeps Vite HMR working without relaxing production', () => {
  const devCsp = config.app?.security?.devCsp;
  assert.equal(typeof devCsp, 'string', 'devCsp must be a string');
  assert.ok(
    devCsp.includes('ws://localhost:5174'),
    'dev CSP must allow the Vite websocket',
  );
  assert.ok(
    devCsp.includes("script-src 'self' 'unsafe-inline'"),
    'Vite React refresh needs inline scripts in dev',
  );
});

test('capabilities keep filesystem and shell access out of the webview', async () => {
  const capability = await readJson('../src-tauri/capabilities/main.json');
  assert.deepEqual(capability.permissions, ['core:default', 'dialog:allow-open']);
});

// Rust is compiled on the user's machine, not here; keep a static guard for the
// desktop-only LLM policy so it cannot silently disappear from the spawn call.
test('local server inherits the private-LLM policy', async () => {
  const source = await readFile(
    new URL('../src-tauri/src/main.rs', import.meta.url),
    'utf8',
  );
  assert.ok(
    source.includes('.env("KNOWLIFY_LLM_ALLOW_PRIVATE", "on")'),
    'the local Node server must receive KNOWLIFY_LLM_ALLOW_PRIVATE=on',
  );
});

// Release builds run the bundled `knowlify-node` sidecar: the runtime is resolved
// from the app location, never from PATH, and the app must not hand the spawn to a
// shell or let the user's environment inject code into the bundled runtime.
test('local server starts the bundled runtime without a shell or env injection', async () => {
  const source = await readFile(
    new URL('../src-tauri/src/main.rs', import.meta.url),
    'utf8',
  );
  assert.ok(
    /current_exe\(\)/.test(source),
    'the Node runtime must be resolved from the app executable',
  );
  assert.ok(
    source.includes('"knowlify-node"') && source.includes('"knowlify-node.exe"'),
    'the sidecar name must be knowlify-node[.exe] on every platform',
  );
  assert.ok(
    !/Command::new\(\s*"(?:sh|bash|zsh|cmd|powershell)"/.test(source),
    'the local server must be spawned directly, without a shell',
  );
  assert.ok(
    !source.includes('Command::new("node")'),
    'release builds must not spawn `node` from PATH directly',
  );
  for (const variable of ['NODE_OPTIONS', 'NODE_PATH', 'KNOWLIFY_NODE']) {
    assert.ok(
      source.includes(`.env_remove("${variable}")`),
      `the local server must not inherit ${variable}`,
    );
  }
});
