(() => {
  if (typeof window === 'undefined' || !window.__TAURI__) return;
  if (window.top !== window) return;
  const key = 'knowlify-desktop-session';
  const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
  // Forward webview errors to the dev terminal (the command is a no-op in release builds).
  const report = (level, ...parts) => {
    const message = parts.map(p => (p instanceof Error ? `${p.message}\n${p.stack}` : typeof p === 'string' ? p : JSON.stringify(p))).join(' ').slice(0, 1500);
    try { Promise.resolve(invoke('js_log', { level, message })).catch(() => {}); } catch { /* ignore */ }
  };
  addEventListener('error', e => report('error', e.message, `${e.filename}:${e.lineno}`));
  addEventListener('unhandledrejection', e => report('rejection', e.reason instanceof Error ? e.reason : String(e.reason)));
  for (const level of ['error', 'warn']) {
    const original = console[level].bind(console);
    console[level] = (...args) => { original(...args); report(level, ...args); };
  }

  // Open external links and window.open in the system default browser.
  const openExternal = url => {
    invoke('open_external', { url }).catch(err => {
      report('warn', 'Failed to open external URL:', err);
    });
  };

  const isExternalHttpUrl = rawUrl => {
    try {
      const parsed = new URL(rawUrl, window.location.href);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        && parsed.origin !== window.location.origin;
    } catch {
      return false;
    }
  };

  const originalWindowOpen = window.open ? window.open.bind(window) : null;
  window.open = (url, target, features) => {
    if (url && isExternalHttpUrl(url)) {
      const parsed = new URL(url, window.location.href);
      openExternal(parsed.href);
      return null;
    }
    return originalWindowOpen ? originalWindowOpen(url, target, features) : null;
  };

  for (const eventType of ['click', 'auxclick']) {
    document.addEventListener(eventType, event => {
      const anchor = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('a[href^="http"]')
        : null;
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      if (isExternalHttpUrl(anchor.href || href)) {
        event.preventDefault();
        event.stopPropagation();
        const parsed = new URL(anchor.href || href, window.location.href);
        openExternal(parsed.href);
      }
    }, true);
  }

  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { /* start fresh */ }
  if (saved?.launch !== window.__KNOWLIFY_LAUNCH__) saved = null;
  window.__KNOWLIFY__ = saved?.connection || { credentials: null };

  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };
  // Basic auth is base64 over UTF-8 bytes: the server decodes the header as UTF-8,
  // while `btoa` alone throws for any character above U+00FF.
  const base64Utf8 = value => {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  const check = async connection => {
    const response = await fetch(`${connection.apiBaseUrl}/api/books`, {
      headers: { Authorization: `Basic ${base64Utf8(`${connection.credentials.user}:${connection.credentials.pass}`)}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(response.status === 401 ? 'Incorrect username or password.' : `Server returned ${response.status}.`);
  };
  const open = connection => {
    sessionStorage.setItem(key, JSON.stringify({ launch: window.__KNOWLIFY_LAUNCH__, connection }));
    localStorage.removeItem('knowlify-credentials');
    location.replace('/');
  };

  addEventListener('DOMContentLoaded', () => {
    if (saved) {
      const button = el('button', { className: 'ghost', textContent: 'Connection settings', type: 'button' });
      button.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:60;background:var(--panel);border:1px solid var(--hairline-strong);box-shadow:var(--shadow-pop)';
      button.onclick = () => {
        sessionStorage.setItem(key, JSON.stringify({ reconfigure: true }));
        location.replace('/');
      };
      document.body.append(button);
      return;
    }

    let reconfigure = false;
    try { reconfigure = JSON.parse(sessionStorage.getItem(key) || 'null')?.reconfigure === true; } catch { /* ignore */ }

    // Cover the web app's own login screen: the desktop connection comes first.
    const root = document.getElementById('root');
    if (root) root.hidden = true;
    const shell = el('main', { className: 'login-shell' });
    const card = el('section', { className: 'login-card' });
    shell.append(card);
    document.body.append(shell);

    const header = (title, copy) => {
      card.replaceChildren(
        el('div', { className: 'brand', textContent: 'Knowlify' }),
        el('h1', {}, title),
        el('p', { className: 'login-copy', textContent: copy }),
      );
    };

    const showForm = async (message = '') => {
      const summary = await invoke('saved_summary').catch(() => null);
      header('Connect to your library', 'Run it on this computer, or connect to a server.');
      let mode = summary?.mode || 'local';

      const form = el('form');
      const localBtn = el('button', { type: 'button', textContent: 'Local' });
      const remoteBtn = el('button', { type: 'button', textContent: 'Remote' });
      const seg = el('div', { className: 'seg' }, localBtn, remoteBtn);
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Library mode');
      seg.style.width = 'fit-content';
      const field = (label, name, props = {}) => {
        const input = el('input', { name, ...props });
        return { input, node: el('label', {}, label, input) };
      };
      const url = field('Server URL', 'url', { type: 'url', placeholder: 'https://books.example.com', value: summary?.url || '' });
      const user = field('Username', 'user', { autocomplete: 'username', value: summary?.user || '' });
      const pass = field('Password', 'pass', { type: 'password', autocomplete: 'current-password' });
      const remote = el('div', {}, url.node, user.node, pass.node);
      remote.style.cssText = 'display:grid;gap:16px';
      const error = el('p', { className: 'error', hidden: !message, textContent: message });
      error.setAttribute('role', 'alert');
      error.style.margin = '0';
      const submit = el('button', { className: 'primary', textContent: 'Connect' });
      const actions = [submit];
      if (summary) {
        const cancel = el('button', { className: 'ghost', type: 'button', textContent: 'Cancel' });
        cancel.onclick = () => { sessionStorage.removeItem(key); autoConnect(); };
        actions.push(cancel);
      }
      form.append(seg, remote, error, ...actions);
      card.append(form);

      const sync = () => {
        localBtn.setAttribute('aria-pressed', String(mode === 'local'));
        remoteBtn.setAttribute('aria-pressed', String(mode === 'remote'));
        remote.hidden = mode !== 'remote';
        url.input.required = user.input.required = pass.input.required = mode === 'remote';
      };
      localBtn.onclick = () => { mode = 'local'; sync(); };
      remoteBtn.onclick = () => { mode = 'remote'; sync(); };
      sync();

      form.onsubmit = async event => {
        event.preventDefault();
        submit.disabled = true; submit.textContent = 'Connecting…'; error.hidden = true;
        try {
          const data = { mode, url: url.input.value, user: user.input.value, pass: pass.input.value };
          const connection = await invoke('connect', data);
          await check(connection);
          open(connection);
        } catch (reason) {
          error.textContent = String(reason?.message || reason); error.hidden = false;
          submit.disabled = false; submit.textContent = 'Connect';
        }
      };
    };

    const autoConnect = async () => {
      header('Opening your library', 'Connecting…');
      try {
        const connection = await invoke('connect_saved');
        await check(connection);
        open(connection);
      } catch (reason) {
        // Nothing saved yet is the normal first run; anything else is worth showing.
        const text = String(reason?.message || reason);
        showForm(text === 'No saved connection' ? '' : `Could not reconnect: ${text}`);
      }
    };

    reconfigure ? showForm() : autoConnect();
  });
})();
