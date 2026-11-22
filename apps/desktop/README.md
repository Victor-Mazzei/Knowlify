# Knowlify desktop

This Tauri v2 app uses the existing React UI. At startup, choose **Local** or **Remote**.
The app remembers the last working connection and reconnects on its own at the next launch. Use **Connection settings** in the lower right corner to change it.

## Requirements

To build the app:

- Install Rust and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).
- Use Node.js 26 (the manifest pins 26.13.1) and npm for the desktop commands. If you use nvm, run `nvm use 26`; the repository does not install or manage nvm. The packaged app runs its own Node.js. `prepare-server` is fail-closed: it stops when the host Node.js major differs from the bundled runtime (26).
- Build on each target OS and architecture. The native SQLite modules prevent portable cross-platform resource copies.
- Windows: Windows 10 version 1809 or later. The NSIS installer includes the WebView2 bootstrapper.
- macOS: macOS 13.5 or later (the Node.js 26 minimum) and the Xcode command line tools.
- Linux: glibc 2.35 or later and the WebKitGTK 4.1 development packages. The release builds on Ubuntu 22.04 (glibc 2.35), so older distributions are not supported. Do not use the Node.js 26 minimum (glibc 2.28) here: the Tauri binary and the native modules are built on the runner.

Use the manifest Node version (26.13.1) for the build; the CI installs exactly that version. `prepare-server.mjs` rebuilds `better-sqlite3` for the Node that runs it, and that binary must load under the bundled runtime. The `smoke-server` check proves this. If you change the Node version, run `npm install` again. The server and web development loop also requires Node.js 26: `engines` is `>=26` in the root and workspace manifests.

## Bundled Node.js

The installer includes a Node.js 26 runtime as the Tauri sidecar `knowlify-node` (`knowlify-node.exe` on Windows). In local mode, the app starts this binary from its own folder. The runtime is not on `PATH`, the webview cannot start it, and end users do not install Node.js.

`node-runtime.json` pins the version, the official download URL and the SHA-256 of each archive:

| Target | Archive |
| --- | --- |
| `x86_64-pc-windows-msvc` | `node-v26.13.1-win-x64.zip` |
| `aarch64-apple-darwin` | `node-v26.13.1-darwin-arm64.tar.gz` |
| `x86_64-apple-darwin` | `node-v26.13.1-darwin-x64.tar.gz` |
| `x86_64-unknown-linux-gnu` | `node-v26.13.1-linux-x64.tar.xz` |

`npm run node:fetch -w @knowlify/desktop` downloads the archive for the host target, checks the SHA-256, extracts only the binary and the `LICENSE`, writes `src-tauri/binaries/knowlify-node-<triple>[.exe]` (mode 0755) and `src-tauri/resources/licenses/node/LICENSE`, and runs `<sidecar> --version` for the host target. The cache is `apps/desktop/.cache/node/<sha256>/`; every reuse is hashed again.

`KNOWLIFY_NODE` is only an explicit override: an absolute path to an existing Node executable. It wins over the sidecar. In a release build, there is no `PATH` lookup; without the sidecar or the override, the app shows an error and asks you to reinstall. In a development build (`tauri dev`), the app falls back to `node` on `PATH` when the sidecar is absent.

To update Node.js, run `npm run node:update -w @knowlify/desktop`. Without arguments, the script selects the newest 26.x LTS release from `nodejs.org`, reads `SHASUMS256.txt` and rewrites the manifest. If `gpg` has the Node.js release key, the script also verifies the signature; otherwise it prints a warning. Review the manifest diff in the pull request: the pinned hash in the repository is the trust anchor for the release build.

## Development

From the repository root, run:

```sh
npm install
npm run dev -w @knowlify/desktop
```

The preparation script builds `apps/server/dist` and installs production dependencies in `src-tauri/resources/server`.
Select Node 26 before this command (with nvm, `nvm use 26`): the desktop `dev` command also runs `prepare-server`, which fails closed on a different host major.
The Tauri CLI starts Vite at `http://localhost:5174` with a fixed port. Close the desktop app to stop development.
The existing server must pass its TypeScript build before preparation can complete.
`npm run dev` does not download the sidecar; in development, the app uses `node` from `PATH`.

## Build

Build with Node 26. With nvm, run `nvm use 26`; the repository does not install or manage nvm. The build fails if the host major is not 26; the CI uses exactly 26.13.1.

From the repository root, run:

```sh
npm run build -w @knowlify/desktop -- --bundles deb,rpm,appimage
```

Use `--bundles nsis` on Windows and `--bundles dmg` on macOS. Add `-- --locked` after the bundles list to pass `--locked` to Cargo, as the release workflow does.

The `build` script runs three steps:

1. `node-runtime.mjs fetch` downloads and verifies the Node.js runtime.
2. `prepare-server.mjs` builds `apps/server/dist`, installs the production dependencies from the root `package-lock.json`, rebuilds `better-sqlite3`, prunes files for the target and asserts that no binary for another platform remains.
3. `tauri build --config src-tauri/tauri.bundle.conf.json` builds the web UI and the packages.

Artifacts appear under `src-tauri/target/release/bundle`.
The Tauri names (`Knowlify_X.Y.Z_amd64.deb`, `Knowlify-X.Y.Z-1.x86_64.rpm`, `Knowlify_X.Y.Z_amd64.AppImage`, and the `.dmg` and NSIS files) become `Knowlify_X.Y.Z_linux-x64.deb`, `Knowlify_X.Y.Z_linux-x64.rpm`, `Knowlify_X.Y.Z_linux-x64.AppImage`, `Knowlify_X.Y.Z_windows-x64-setup.exe`, `Knowlify_X.Y.Z_macos-arm64.dmg` and `Knowlify_X.Y.Z_macos-x64.dmg` in the release workflow.
The Tauri `frontendDist` path is `../../web/dist`, relative to `src-tauri`; it points to `apps/web/dist`.

The base `tauri.conf.json` does not declare `externalBin`. The Rust checks (`cargo check`, `cargo test`, `cargo clippy`) therefore run without the sidecar, and the "Desktop Rust checks" job in the CI uses this path.
`tauri.bundle.conf.json` is a JSON Merge Patch for release builds. It adds the sidecar, the server and license resources, macOS ad-hoc signing (`signingIdentity: "-"`, `hardenedRuntime: false`, minimum macOS 13.5) and the per-user NSIS install mode.
Always pass this overlay; a plain `tauri build` produces a package without `knowlify-node`. A Node test (`test/bundle-config.test.mjs`) checks both configurations.

## Connections and storage

Local mode reserves a free IPv4 loopback port, releases it, and starts the bundled Node.js bound to `127.0.0.1`.
The app checks the authenticated books endpoint before it opens the library. It retries startup three times if necessary.
The app owns the child process and kills and reaps it on normal exit, startup failure, or a mode change.
An OS force-kill or machine crash cannot run this cleanup.

In local mode the app starts the server with `KNOWLIFY_ACCOUNT_LOCKED=1`: the password is generated by the app on first launch and reused afterwards, so **Settings → Account** does not offer a password change there (the page says it is managed by the app). To change a password, use a server in remote mode.

The server data directory is Tauri's OS app-data directory for `com.knowlify.desktop`.
It contains the database, books, covers, a generated 256-bit password, and `server.log`.
The password file is created with mode `0600` on Unix. On Windows, it inherits the user profile directory permissions.
Keep this directory to preserve your library across upgrades. Each running app instance uses its own local port.

Remote mode accepts an HTTP(S) URL, username, and password. Plain `http://` is accepted only for loopback, private LAN addresses (RFC1918/ULA), `localhost`, single-label hostnames and `.local`/`.lan`/`.home.arpa` names. Any other (public) host must use `https://`, because the app sends your credentials to it; a saved `http://` connection to a public host is refused until you change it in **Connection settings**.
The app checks credentials before opening the library. It loads the bundled UI and makes API requests to the remote server.
The last working connection is saved in `connection.json` in the app-data directory (created with mode 0600 on Unix), so you enter it once. For a remote server the file contains the server URL, username and password in plain text; it is protected only by file permissions. Delete the file, or use **Connection settings**, to change it. If a saved server is unreachable, the app shows the settings form with the error.

The desktop bootstrap injects `window.__KNOWLIFY__` before the React modules load.
The web UI reads its API URL and initial credentials from this object.
Browser use still falls back to `VITE_API_BASE_URL`, the existing `VITE_API_BASE` alias, and then same-origin requests.
No server changes are required. The existing server CORS support permits requests from the desktop webview.

## Navigation and external links

Webview navigations are restricted by the `is_allowed_navigation` filter:
- **Allowed inside the webview**: the connected server's exact origin (scheme, host and port), App origins (`tauri://localhost`, `http://localhost`, `http://127.0.0.1`, `http(s)://tauri.localhost`), `about:` pages (`about:srcdoc`, `about:blank` required by reader iframes), and `blob:` URLs originating from the app.
- **Blocked**: External websites, external `blob:` origins, `file:` URLs, `javascript:`, `data:`, and other schemes.

External links (such as RSS articles and third-party references) open in the user's default system browser:
- `bootstrap.js` intercepts clicks on `a[href^="http"]` pointing outside the app origin and patches `window.open` to invoke the `open_external` Tauri command. When running in a standard web browser (without `window.__TAURI__`), behavior remains unchanged.
- The `open_external` command validates the URL with `validate_external_url`: only `http` and `https` schemes with a valid host are allowed; non-HTTP schemes (`file:`, `javascript:`, `data:`) and URLs with embedded credentials are strictly rejected.
- Validated external URLs are launched via the lightweight `open` crate (`open::that_detached`), which starts the system default browser asynchronously without exposing unnecessary plugin endpoints or capability permissions.

## Content security policy

The webview sets a restrictive CSP (`tauri.conf.json`, `csp`; `devCsp` adds the Vite dev server and HMR websocket): `default-src 'self'`; `script-src 'self'` (no inline scripts in production); `style-src 'self' 'unsafe-inline'`; `img-src` self/data/blob/http(s) (covers, RSS images); `font-src 'self' data:`; `frame-src blob: about: data:` and `worker-src 'self' blob:` (epub.js iframes and the pdf.js worker); `object-src 'none'`; `base-uri 'none'`. `connect-src` allows `http:` and `https:` because the server URL is chosen at runtime, so the CSP does not restrict which server the UI talks to; the navigation guard and the HTTPS rule above cover that. Capabilities are limited to `core:default` and `dialog:allow-open`.

## Checks and tests

```sh
npm test -w @knowlify/desktop
npm run smoke-server -w @knowlify/desktop
npm run verify-bundle -w @knowlify/desktop -- <installer-or-directory>
npm run build -w @knowlify/web
cd apps/desktop/src-tauri
cargo check
cargo test
```

`smoke-server` starts the compiled server with the bundled Node.js on an ephemeral loopback port and a temporary data directory.
It checks `/health`, the authenticated `/api/about`, `better-sqlite3` and `@napi-rs/canvas`, then stops the child.
Pass `--node` and `--server` to test an extracted package.

`verify-bundle` accepts an extracted directory, `.deb`, `.rpm`, `.dmg`, NSIS `.exe` or AppImage.
It checks the sidecar hash and `--version`, the server tree and its native modules, the Node.js license, leftover binaries for other platforms and the 250 MiB size limit.

Unit tests in `apps/desktop/src-tauri/src/main.rs` cover:
1. `is_allowed_navigation`: Verifies that app origins, `about:` iframes, and own `blob:` URLs are allowed while external web links, external blob URLs, and file/script URLs are blocked.
2. `validate_external_url`: Verifies that valid HTTP/HTTPS URLs open, while schemes like `file:`, `javascript:`, `data:`, empty hosts, and embedded credentials are rejected.
3. `validate_remote_url`: Verifies that remote server connection URLs reject embedded credentials, query strings, fragments, and non-HTTP schemes.
4. `node_executable`: Resolves the sidecar next to the app, rejects a relative, missing or directory `KNOWLIFY_NODE`, and uses the `PATH` fallback only in a debug build.

Node tests in `apps/desktop/test/` cover the bootstrap log bridge, the security configuration, the bundle configuration, the Node runtime manifest and the server preparation.

Linux needs development packages that expose `webkit2gtk-4.1`, `javascriptcoregtk-4.1`, `gtk+-3.0`, and `libsoup-3.0` through pkg-config.
These checks do not open a desktop window. Test the packaged app on each target OS before distribution.
