import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(
  new URL('../src-tauri/src/bootstrap.js', import.meta.url),
  'utf8',
);

function createElement(tagName) {
  return {
    tagName,
    children: [],
    style: {},
    hidden: false,
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(name, value) { this[name] = value; },
  };
}

// A browser `btoa` throws for any character above U+00FF; Buffer's 'binary'
// encoding would silently truncate instead of reproducing the bug.
function browserBtoa(value) {
  for (const char of value) {
    if (char.codePointAt(0) > 0xff) throw new Error('InvalidCharacterError');
  }
  return Buffer.from(value, 'latin1').toString('base64');
}

// Loads bootstrap.js in a vm context with just enough browser surface for the
// error/log bridge and the saved-connection check. DOMContentLoaded is only
// fired by the tests that need the login flow.
function load(invoke, { fetch = async () => ({ ok: true, status: 200 }) } = {}) {
  const listeners = new Map();
  const storage = new Map();
  const location = {
    href: 'tauri://localhost/',
    origin: 'tauri://localhost',
    replace: () => {},
  };
  const window = {
    __TAURI__: { core: { invoke } },
    __KNOWLIFY_LAUNCH__: 'test-launch',
    location,
  };
  window.top = window;
  const document = {
    addEventListener: (type, handler) => listeners.set(type, handler),
    createElement,
    getElementById: () => null,
    body: createElement('body'),
  };
  const sandbox = {
    window,
    document,
    location,
    console: { error: () => {}, warn: () => {} },
    sessionStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    localStorage: { removeItem: key => storage.delete(key) },
    addEventListener: (type, handler) => listeners.set(type, handler),
    URL,
    btoa: browserBtoa,
    TextEncoder,
    AbortSignal,
    fetch,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'bootstrap.js' });
  return { listeners };
}

function triggerWebviewError(listeners) {
  listeners.get('error')({ message: 'boom', filename: 'app.js', lineno: 7 });
}

const nextTask = () => new Promise(resolve => setImmediate(resolve));

// Fires DOMContentLoaded with a saved connection so bootstrap runs its real
// connect_saved -> check -> fetch path.
async function connectSaved(credentials, fetch) {
  const { listeners } = load(
    command => Promise.resolve(command === 'connect_saved'
      ? { apiBaseUrl: 'https://books.example.com', credentials }
      : undefined),
    { fetch },
  );
  listeners.get('DOMContentLoaded')();
  await nextTask();
}

test('sends Basic auth as UTF-8 base64 for characters above U+00FF', async () => {
  const requests = [];
  const credentials = { user: 'usuário-漢字', pass: 'pässwörd-😀' };

  await connectSaved(credentials, async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 200 };
  });

  assert.equal(requests.length, 1);
  const authorization = requests[0].init.headers.Authorization;
  assert.match(authorization, /^Basic /);
  assert.equal(
    Buffer.from(authorization.slice('Basic '.length), 'base64').toString('utf8'),
    `${credentials.user}:${credentials.pass}`,
  );
});

test('keeps the Basic auth header for ASCII credentials identical to btoa', async () => {
  const requests = [];
  const credentials = { user: 'reader', pass: 's3cret' };

  await connectSaved(credentials, async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 200 };
  });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].init.headers.Authorization,
    `Basic ${Buffer.from(`${credentials.user}:${credentials.pass}`).toString('base64')}`,
  );
});

test('forwards webview errors to the js_log command', async () => {
  const calls = [];
  const { listeners } = load((command, args) => {
    calls.push({ command, args });
    return Promise.resolve();
  });

  triggerWebviewError(listeners);
  await nextTask();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'js_log');
  assert.deepEqual(
    { level: calls[0].args.level, message: calls[0].args.message },
    { level: 'error', message: 'boom app.js:7' },
  );
});

test('does not leak an unhandled rejection when js_log fails', async () => {
  const rejections = [];
  const onRejection = reason => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const { listeners } = load(() => Promise.reject(new Error('ipc unavailable')));

    triggerWebviewError(listeners);
    await nextTask();

    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('ignores a synchronous js_log failure', () => {
  const { listeners } = load(() => {
    throw new Error('ipc unavailable');
  });

  assert.doesNotThrow(() => triggerWebviewError(listeners));
});
