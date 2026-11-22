import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createDocument, walk } from '../test-support/fake-dom.mjs';

const source = await readFile(
  new URL('../src-tauri/src/bootstrap.js', import.meta.url),
  'utf8',
);

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
function load(invoke, { fetch = async () => ({ ok: true, status: 200 }), reconfigure = false } = {}) {
  const listeners = new Map();
  const storage = new Map();
  if (reconfigure) storage.set('knowlify-desktop-session', JSON.stringify({ reconfigure: true }));
  const location = {
    href: 'tauri://localhost/',
    origin: 'tauri://localhost',
    replace: path => { location.replaced = path; },
  };
  const window = {
    __TAURI__: { core: { invoke } },
    __KNOWLIFY_LAUNCH__: 'test-launch',
    location,
  };
  window.top = window;
  const document = createDocument();
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
  return { listeners, document, location, storage };
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

function nodes(document) {
  const found = [];
  walk(document.body, node => {
    if (node && typeof node === 'object') found.push(node);
  });
  return found;
}

function find(document, predicate) {
  return nodes(document).find(predicate);
}

function field(document, label) {
  const node = find(
    document,
    candidate => candidate.tagName === 'LABEL' && candidate.children[0] === label,
  );
  assert.ok(node, `the ${label} field is rendered`);
  return node.children.find(child => child.tagName === 'INPUT');
}

function screen(document) {
  const form = find(document, node => node.tagName === 'FORM');
  assert.ok(form, 'the connection form is rendered');
  const group = find(
    document,
    node => node.getAttribute('aria-label') === 'Library mode',
  );
  assert.ok(group, 'the mode selector is rendered');
  const [local, remote] = group.children;
  return {
    form,
    group,
    local,
    remote,
    remoteFields: find(
      document,
      node => node.getAttribute('aria-label') === 'Remote server',
    ),
    url: field(document, 'Server URL'),
    user: field(document, 'Username'),
    pass: field(document, 'Password'),
    submit: find(document, node => node.tagName === 'BUTTON' && node.className === 'primary'),
    error: find(document, node => node.tagName === 'P' && node.className === 'error'),
  };
}

function press(element, key) {
  let prevented = false;
  element.dispatchEvent({
    type: 'keydown',
    key,
    preventDefault() { prevented = true; },
  });
  return prevented;
}

// Opens the connection form. `reconfigure` matches the "Connection settings"
// path, which renders the form with the saved summary instead of auto-connecting.
async function openForm({ summary = null, invoke, reconfigure = summary !== null } = {}) {
  const handler = invoke ?? ((command, args) => {
    if (command === 'saved_summary') return Promise.resolve(summary);
    if (command === 'connect_saved') return Promise.reject(new Error('No saved connection'));
    if (command === 'connect') {
      return Promise.resolve({
        apiBaseUrl: 'http://127.0.0.1:8787',
        credentials: { user: 'reader', pass: 's3cret' },
      });
    }
    return Promise.resolve(undefined);
  });
  const harness = load(handler, { reconfigure });
  harness.listeners.get('DOMContentLoaded')();
  await nextTask();
  return harness;
}

test('local mode hides and disables the remote fields', async () => {
  const { document } = await openForm({ summary: { mode: 'local', url: null, user: null } });
  const ui = screen(document);

  assert.equal(ui.group.getAttribute('role'), 'radiogroup');
  assert.equal(ui.local.getAttribute('role'), 'radio');
  assert.equal(ui.remote.getAttribute('role'), 'radio');
  assert.equal(ui.local.getAttribute('aria-checked'), 'true');
  assert.equal(ui.remote.getAttribute('aria-checked'), 'false');
  assert.equal(ui.local.tabIndex, 0);
  assert.equal(ui.remote.tabIndex, -1);

  // `hidden` alone was not enough: the old inline `display:grid` overrode it.
  assert.equal(ui.remoteFields.hidden, true);
  assert.equal(ui.remoteFields.style.display, 'none');
  for (const input of [ui.url, ui.user, ui.pass]) {
    assert.equal(input.disabled, true, `${input.name} is disabled in local mode`);
    assert.equal(input.required, false, `${input.name} is not required in local mode`);
  }
  assert.equal(ui.error.getAttribute('role'), 'alert');
  assert.equal(ui.error.getAttribute('aria-live'), 'assertive');
});

test('restores the saved remote mode with its fields visible and enabled', async () => {
  const { document } = await openForm({
    summary: { mode: 'remote', url: 'https://books.example.com', user: 'reader' },
  });
  const ui = screen(document);

  assert.equal(ui.remote.getAttribute('aria-checked'), 'true');
  assert.equal(ui.local.getAttribute('aria-checked'), 'false');
  assert.equal(ui.remoteFields.hidden, false);
  assert.equal(ui.remoteFields.style.display, 'grid');
  assert.equal(ui.url.value, 'https://books.example.com');
  assert.equal(ui.user.value, 'reader');
  assert.equal(ui.pass.value, '', 'a saved password is never prefilled');
  for (const input of [ui.url, ui.user, ui.pass]) {
    assert.equal(input.disabled, false);
    assert.equal(input.required, true);
  }
});

test('switching modes keeps the typed remote password and focuses sensibly', async () => {
  const { document } = await openForm({
    summary: { mode: 'remote', url: 'https://books.example.com', user: 'reader' },
  });
  const ui = screen(document);
  ui.pass.value = 'typed-once';

  ui.local.onclick();
  assert.equal(ui.remoteFields.hidden, true);
  assert.equal(ui.remoteFields.style.display, 'none');
  assert.equal(ui.pass.disabled, true);
  assert.equal(ui.pass.value, 'typed-once');
  assert.equal(document.activeElement, ui.submit);

  ui.remote.onclick();
  assert.equal(ui.remoteFields.hidden, false);
  assert.equal(ui.pass.disabled, false);
  assert.equal(ui.pass.value, 'typed-once');
  assert.equal(document.activeElement, ui.url);

  for (let round = 0; round < 3; round += 1) {
    ui.local.onclick();
    assert.equal(ui.remoteFields.style.display, 'none');
    ui.remote.onclick();
    assert.equal(ui.remoteFields.style.display, 'grid');
  }
  assert.equal(ui.pass.value, 'typed-once');
});

test('the mode selector is navigable with the keyboard', async () => {
  const { document } = await openForm({ summary: { mode: 'local', url: null, user: null } });
  const ui = screen(document);

  ui.local.focus();
  assert.equal(press(ui.group, 'ArrowRight'), true);
  assert.equal(ui.remote.getAttribute('aria-checked'), 'true');
  assert.equal(ui.remoteFields.hidden, false);
  assert.equal(document.activeElement, ui.remote);

  assert.equal(press(ui.group, 'ArrowLeft'), true);
  assert.equal(ui.local.getAttribute('aria-checked'), 'true');
  assert.equal(ui.remoteFields.hidden, true);
  assert.equal(document.activeElement, ui.local);

  press(ui.group, 'End');
  assert.equal(ui.remote.getAttribute('aria-checked'), 'true');
  // Arrows wrap: right from the last radio returns to the first.
  ui.remote.focus();
  press(ui.group, 'ArrowRight');
  assert.equal(ui.local.getAttribute('aria-checked'), 'true');
  assert.equal(document.activeElement, ui.local);
  press(ui.group, 'Home');
  assert.equal(ui.local.getAttribute('aria-checked'), 'true');
  assert.equal(document.activeElement, ui.local);
});

// With two radios, every arrow either moves to the sibling or wraps back to the
// current one: right/down go forward, left/up go backward. All four keys must
// end up selecting the other radio from both positions.
for (const { key, from, to } of [
  { key: 'ArrowRight', from: 'local', to: 'remote' },
  { key: 'ArrowDown', from: 'local', to: 'remote' },
  { key: 'ArrowLeft', from: 'local', to: 'remote' },
  { key: 'ArrowUp', from: 'local', to: 'remote' },
  { key: 'ArrowLeft', from: 'remote', to: 'local' },
  { key: 'ArrowUp', from: 'remote', to: 'local' },
  { key: 'ArrowRight', from: 'remote', to: 'local' },
  { key: 'ArrowDown', from: 'remote', to: 'local' },
]) {
  test(`${key} from ${from} selects ${to}`, async () => {
    const { document } = await openForm({
      summary: { mode: from, url: 'https://books.example.com', user: 'reader' },
    });
    const ui = screen(document);
    const start = ui[from];
    const target = ui[to];
    start.focus();

    assert.equal(press(ui.group, key), true, `${key} is handled and prevented`);

    assert.equal(target.getAttribute('aria-checked'), 'true');
    assert.equal(start.getAttribute('aria-checked'), 'false');
    assert.equal(document.activeElement, target, 'focus follows the selection');
    assert.equal(target.tabIndex, 0, 'the selected radio is in the tab order');
    assert.equal(start.tabIndex, -1);
    assert.equal(ui.remoteFields.hidden, to === 'local');
    assert.equal(ui.remoteFields.style.display, to === 'remote' ? 'grid' : 'none');
    assert.equal(ui.url.disabled, to === 'local');
    assert.equal(ui.url.required, to === 'remote');
  });
}

test('Home and End select the first and last radio from either end', async () => {
  for (const { from, key, to } of [
    { from: 'remote', key: 'Home', to: 'local' },
    { from: 'local', key: 'Home', to: 'local' },
    { from: 'local', key: 'End', to: 'remote' },
    { from: 'remote', key: 'End', to: 'remote' },
  ]) {
    const { document } = await openForm({
      summary: { mode: from, url: 'https://books.example.com', user: 'reader' },
    });
    const ui = screen(document);
    const start = ui[from];
    const target = ui[to];
    start.focus();

    assert.equal(press(ui.group, key), true, `${key} is handled and prevented`);

    assert.equal(ui.local.getAttribute('aria-checked'), String(to === 'local'), `${key} from ${from}`);
    assert.equal(ui.remote.getAttribute('aria-checked'), String(to === 'remote'));
    assert.equal(document.activeElement, target, 'focus follows the selection');
    assert.equal(ui.local.tabIndex, to === 'local' ? 0 : -1);
    assert.equal(ui.remote.tabIndex, to === 'remote' ? 0 : -1);
  }
});

test('submitting local mode never sends the remote fields', async () => {
  const invoked = [];
  const { document, location } = await openForm({
    invoke: (command, args) => {
      if (command === 'connect_saved') return Promise.reject(new Error('No saved connection'));
      if (command === 'saved_summary') return Promise.resolve(null);
      if (command === 'connect') {
        invoked.push(JSON.parse(JSON.stringify(args)));
        return Promise.resolve({
          apiBaseUrl: 'http://127.0.0.1:8787',
          credentials: { user: 'desktop', pass: 'local-password' },
        });
      }
      return Promise.resolve(undefined);
    },
  });
  const ui = screen(document);
  // Values left from a previous remote attempt stay in the DOM but are disabled.
  ui.url.value = 'https://books.example.com';
  ui.user.value = 'reader';
  ui.pass.value = 'typed-once';

  await ui.form.onsubmit({ preventDefault() {} });
  await nextTask();

  assert.deepEqual(invoked, [{ mode: 'local' }]);
  assert.equal(location.replaced, '/');
});

test('submitting remote mode sends the server credentials', async () => {
  const invoked = [];
  const { document } = await openForm({
    summary: { mode: 'remote', url: 'https://books.example.com', user: 'reader' },
    invoke: (command, args) => {
      if (command === 'saved_summary') {
        return Promise.resolve({ mode: 'remote', url: 'https://books.example.com', user: 'reader' });
      }
      if (command === 'connect') {
        invoked.push(JSON.parse(JSON.stringify(args)));
        return Promise.resolve({
          apiBaseUrl: 'https://books.example.com',
          credentials: { user: 'reader', pass: 'typed-once' },
        });
      }
      return Promise.resolve(undefined);
    },
  });
  const ui = screen(document);
  ui.pass.value = 'typed-once';

  await ui.form.onsubmit({ preventDefault() {} });
  await nextTask();

  assert.deepEqual(invoked, [{
    mode: 'remote',
    url: 'https://books.example.com',
    user: 'reader',
    pass: 'typed-once',
  }]);
});
