# Knowlify

![Knowlify](assets/brand/banner.png)

Knowlify is a self-hosted, local-first library for ebooks. It reads PDF and EPUB files in a web or desktop app and keeps your notes, tags and reading progress.

## What it does

- **Library.** Upload PDF and EPUB files, or index source folders in place. Knowlify reads covers and metadata in the background. View the library as a grid or a table.
- **Source folders.** Knowlify indexes these folders as read-only. It never writes to them and never deletes files in them.
- **Book details and metadata.** Edit title, author, description, ISBN, year, publisher, language, series and cover. Your edits do not change the book files. You can reset them. You can also search Open Library, with Google Books as a fallback, when you ask for it.
- **Favorites and tags.** Star books, add colored tags, and filter the library by favorite, tag, format, author, source folder, notes and reading state.
- **Reader.** Read EPUB and PDF files in the browser or in the desktop app. The reader saves your position.
- **Notes.** Save notes and quotes for each book. Search notes across all books.
- **Search.** Knowlify indexes the book text. Search finds passages by keyword. With embeddings enabled, search also finds passages by meaning.
- **Tutor (optional).** Connect an LLM to ask questions about one book or the whole library. Answers cite passages from your books. Open the tutor with Alt+T.
- **MCP server.** Connect Claude Code, Cursor or Claude Desktop to your library.
- **OPDS and KOSync.** Browse the library and sync reading progress from KOReader.
- **News (RSS).** Follow topics and feeds that you choose, and save articles to read later.
- **One library on every device.** Use the same library from the browser, the desktop app and KOReader. The desktop app runs a local server with its own bundled Node.js, or it connects to a remote server. See [One library on every device](#one-library-on-every-device).
- **Accounts.** Knowlify has one user. Change the password in Settings.

## Quick start with Docker

Docker Compose builds the image from this repository.

1. Copy the example environment file: `cp .env.example .env`
2. Open `.env`. Set `KNOWLIFY_PASSWORD` to a password that only you know.
3. Set `KNOWLIFY_LIBRARY_DIR` to the host folder that holds your ebooks.
4. Build and start the container: `docker compose up -d --build`
5. Open `http://localhost:8787`. Sign in with `KNOWLIFY_USER` and `KNOWLIFY_PASSWORD`.
6. Open **Settings**, then **Folders**. Add `/library` as a source folder.

The container stores the database, uploaded books and covers in `./data`.

The container mounts `KNOWLIFY_LIBRARY_DIR` at `/library` as read-only. You can use a network share. Mount the share on the host first, then set `KNOWLIFY_LIBRARY_DIR` to the mount point.

To run a published image instead of a local build, use this service definition. Replace the placeholder with the registry and owner of your image.

```yaml
services:
  knowlify:
    image: <registry>/<owner>/knowlify:latest
    ports:
      - "8787:8787"
    environment:
      KNOWLIFY_PASSWORD: ${KNOWLIFY_PASSWORD:?set KNOWLIFY_PASSWORD}
      KNOWLIFY_LIBRARY_PATHS: /library
    volumes:
      - ./data:/data
      - /path/to/ebooks:/library:ro
    restart: unless-stopped
```

The image stores its data in `/data`. Mount a volume there to keep your data.

To see the running version and commit, open `/api/about` after you sign in.

## One library on every device

Knowlify is one server with several clients. Use the same library from the browser, the desktop app and KOReader.

| Client | How it connects |
| --- | --- |
| Browser | Open the server address. The server serves the web app. |
| Desktop app | Use local mode or remote mode. |
| KOReader | Add the OPDS catalog and the KOSync server. See [Connect other clients](#connect-other-clients). |

### Local mode and remote mode

The desktop app has two modes:

- **Local.** The app starts its own Knowlify server with the bundled Node.js. The database, uploaded books, covers, notes and reading progress stay in the app data folder on that computer. Source folders are indexed in place. You do not install Node.js.
- **Remote.** The app connects to a Knowlify server that you already run, for example the Docker container. The library, book files, covers, notes, reading progress, search index and settings stay on that server. The browser and the remote desktop app use the same data. The desktop app keeps the server URL, user name and password on the computer in `connection.json`.

### Connect the desktop app to your server

1. Start the server. See [Quick start with Docker](#quick-start-with-docker).
2. Open the desktop app.
3. Select **Remote**.
4. Enter the server URL and your user name and password.

Use an `https://` address when the server is outside your home network. The desktop app accepts a plain `http://` address only for local destinations. This includes loopback, private networks and the Tailscale range `100.64.0.0/10`.

The app remembers the last working connection and opens it at the next start. To change the mode or the server, open **Connection settings** in the lower right corner.

KOReader uses the same server for the OPDS catalog and KOSync. KOSync keeps the KOReader reading position. The browser and the desktop app use the server reading progress.

## Download the desktop app

Get the installer for your system from the [GitHub Releases page](https://github.com/Victor-Mazzei/Knowlify/releases). Download the file for your system and the `SHA256SUMS` file.

| System | File |
| --- | --- |
| Windows 10 or 11, 64-bit | `Knowlify_X.Y.Z_windows-x64-setup.exe` |
| macOS, Apple Silicon (M1 and later) | `Knowlify_X.Y.Z_macos-arm64.dmg` |
| macOS, Intel | `Knowlify_X.Y.Z_macos-x64.dmg` |
| Linux, 64-bit | `Knowlify_X.Y.Z_linux-x64.AppImage`, `.deb` or `.rpm` |

Replace `X.Y.Z` with the version of the release. The app needs Windows 10 version 1809 or later, macOS 13.5 or later, or Linux with glibc 2.35 or later. The Linux installers are built on Ubuntu 22.04, so older distributions are not supported.

The desktop app includes its own Node.js. You do not need to install Node.

The app can run its own server or connect to the server you run. See [One library on every device](#one-library-on-every-device) for the two modes and the connection steps.

### Check the download

The `SHA256SUMS` file lists the SHA-256 hash of each installer. Compare the hash of your file with its line in that file.

Linux:

```bash
sha256sum -c SHA256SUMS
```

macOS:

```bash
shasum -a 256 -c SHA256SUMS
```

Windows (PowerShell):

```powershell
Get-FileHash .\Knowlify_X.Y.Z_windows-x64-setup.exe -Algorithm SHA256
```

On Linux and macOS, `sha256sum -c` and `shasum -a 256 -c` print `OK` for each file that matches. Files that you did not download are reported as `FAILED open or read`; ignore those lines, and note that the command exits nonzero because of them. The `OK` lines for the files you downloaded are the result that matters.

On Windows, `Get-FileHash` prints only the hash; it does not compare it. Open `SHA256SUMS`, find the line for your file, and compare the expected hash (the first field) with the printed `Hash` value manually. The comparison is not case-sensitive. If they match, the file is intact.

### Install

The installers are not signed yet. Your system shows a warning the first time you open the app. The warning is expected. Install the app only if you downloaded it from this repository.

**Windows.** SmartScreen shows "Windows protected your PC". Select **More info**, then **Run anyway**. The installer does not need administrator rights.

**macOS.** Open the `.dmg` and move Knowlify to **Applications**. If macOS says that the app cannot be opened or is damaged:

1. Try to open the app once.
2. Open **System Settings > Privacy & Security**. Select **Open Anyway** next to the Knowlify message.

On older macOS versions, you can also Control-click the app and select **Open**. Or run this command in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/Knowlify.app
```

**Linux.** For the AppImage, make the file executable and run it:

```bash
chmod +x Knowlify_X.Y.Z_linux-x64.AppImage
./Knowlify_X.Y.Z_linux-x64.AppImage
```

For the `.deb`, run `sudo apt install ./Knowlify_X.Y.Z_linux-x64.deb`. For the `.rpm`, run `sudo dnf install ./Knowlify_X.Y.Z_linux-x64.rpm`.

### Your data

The app stores its data in these folders:

- Windows: `%APPDATA%\com.knowlify.desktop`
- macOS: `~/Library/Application Support/com.knowlify.desktop`
- Linux: `~/.local/share/com.knowlify.desktop`

Updates keep your data. To remove all data, uninstall the app and delete that folder.

Uninstall:

- Windows: open **Settings > Apps**, select Knowlify and uninstall it. The uninstaller can also delete the app data; this option is off by default.
- macOS: move Knowlify from **Applications** to the Trash.
- Linux: run `sudo apt remove knowlify` or `sudo dnf remove knowlify`.

## Configuration

Set variables in `.env`. The file `.env.example` lists every variable with comments.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `KNOWLIFY_PASSWORD` | Yes (Docker Compose) | none | Initial password. Compose stops if it is empty. |
| `KNOWLIFY_USER` | No | `admin` | User name. |
| `KNOWLIFY_LIBRARY_DIR` | No | `./library` | Host folder that Compose mounts read-only at `/library`. |
| `KNOWLIFY_PORT` | No | `8787` | Host port that Compose publishes. |
| `KNOWLIFY_SCAN_INTERVAL` | No | `600` | Seconds between source folder scans. `0` turns scans off. |
| `KNOWLIFY_BROWSE_ROOTS` | No | `KNOWLIFY_LIBRARY_PATHS` | Folders that the folder picker can open and that you can add as sources. `any` allows all folders. |
| `KNOWLIFY_INDEXING` | No | `on` | `off` turns the passage index off. |
| `KNOWLIFY_EMBEDDINGS` | No | `local` | `none`, `local` or `http`. `local` downloads a model of about 120 MB on first use. |
| `KNOWLIFY_LLM_URL`, `KNOWLIFY_LLM_API_KEY`, `KNOWLIFY_LLM_MODEL` | No | none | Enable the tutor. You can also set the LLM in Settings. |
| `KNOWLIFY_SECRET` | No | generated | Secret of at least 32 characters. It encrypts the LLM key and signs list cursors. |
| `KNOWLIFY_METADATA_LOOKUP` | No | `on` | `off` turns off online metadata search and cover download by URL. A value saved in Settings overrides it. |
| `KNOWLIFY_GOOGLE_BOOKS_API_KEY` | No | none | Optional Google Books API key. A key saved in Settings overrides it. |
| `KNOWLIFY_METADATA_LOCKED` | No | `0` | `1` locks the toggle and the key to the environment. `PUT /api/settings/metadata` returns `403`. |
| `KNOWLIFY_MCP` | No | `on` | `off` removes the `/mcp` route. |
| `KNOWLIFY_TRUST_PROXY` | No | `off` | `on`, a hop count, or a list of proxy IPs/CIDRs. Use it only behind a reverse proxy that you control. See [Behind a reverse proxy](#behind-a-reverse-proxy). |
| `KNOWLIFY_LOG_LEVEL` | No | `info` | `error`, `warn`, `info`, `debug`, `trace` or `silent`. `debug` never logs secrets or the content of your library. |
| `KNOWLIFY_FORCE_ENV_PASSWORD` | No | none | Set to `1` to sign in with `KNOWLIFY_PASSWORD` after you forget a changed password. |

Never commit the `.env` file. It contains secrets.

## Connect other clients

### KOReader

Knowlify serves an OPDS catalog and a KOSync server. In KOReader, add the catalog URL `http://<server>:8787/opds` and the progress sync server `http://<server>:8787/kosync`. Use the same user name and password as the web app. The Settings page shows both addresses with a copy button.

### AI applications (MCP)

The server exposes your library at `POST /mcp` with MCP Streamable HTTP. The endpoint is stateless.

1. Open **Settings**, then **MCP access**.
2. Create an access token with the scope `read` or `write_notes`.
3. Copy the token. Knowlify shows it only once.
4. Add the token to your client. Replace `http://127.0.0.1:8787` with the address of your server.

Claude Code:

```bash
claude mcp add --transport http knowlify http://127.0.0.1:8787/mcp --header "Authorization: Bearer <TOKEN>"
```

Cursor (`~/.cursor/mcp.json`):

```json
{ "mcpServers": { "knowlify": { "url": "http://127.0.0.1:8787/mcp", "headers": { "Authorization": "Bearer <TOKEN>" } } } }
```

Claude Desktop (`claude_desktop_config.json`, through `mcp-remote`):

```json
{ "mcpServers": { "knowlify": { "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:8787/mcp", "--header", "Authorization: Bearer <TOKEN>"] } } }
```

The scope `read` gives these tools: `search_passages`, `list_books`, `get_book`, `list_notes`, `list_tags` and `get_index_status`. The scope `write_notes` adds `create_note`, `add_tags_to_books`, `remove_tags_from_books` and `set_book_favorite`. No tool deletes data.

Revoke a token in **Settings** at any time. The revocation takes effect at once. Each token has a limit of 120 messages and 20 writes per minute. The variables `KNOWLIFY_MCP_RATE_PER_MIN`, `KNOWLIFY_MCP_WRITE_RATE_PER_MIN`, `KNOWLIFY_MCP_ALLOWED_ORIGINS` and `KNOWLIFY_MCP_ALLOWED_HOSTS` change the limits and access rules.

Do not put Basic authentication in front of `/mcp` in a reverse proxy. It conflicts with the `Authorization: Bearer` header.

Your AI application receives the passages, notes and titles that it requests. The provider of that application also receives them.

## Use a different embedding model (fork)

Knowlify uses the multilingual model `Xenova/multilingual-e5-small` (MIT license) for semantic search. The application does not have a setting to select another model in the interface.

You can change the model with these environment variables:

- `KNOWLIFY_EMBEDDINGS`: `none`, `local` or `http`.
- `KNOWLIFY_EMBEDDINGS_MODEL`: Hugging Face model ID (for example `org/model-name`).
- `KNOWLIFY_MODELS_DIR`: folder for downloaded models.
- `KNOWLIFY_EMBEDDINGS_OFFLINE`: set to `1` to block network access. Copy the model to `KNOWLIFY_MODELS_DIR` first.
- `KNOWLIFY_EMBEDDINGS_THREADS`: number of CPU threads.

Limitation: the code adds the E5 prefixes `query: ` and `passage: ` to the text, and it always uses mean pooling and 8-bit quantized weights. Models from other families can need different prefixes. To use them, change `apps/server/src/adapters/indexing/embed/LocalEmbedder.ts` in your fork. When you change the model, Knowlify rebuilds the search index for all books.

The base model `intfloat/multilingual-e5-small` uses the MIT license. If you put the model in an image or an installer, include the MIT license text and the copyright notice of the E5 authors.

## Local development

See [CONTRIBUTING.md](CONTRIBUTING.md) for requirements, setup, checks and tests. For the desktop app, see [apps/desktop/README.md](apps/desktop/README.md).

## Architecture

Knowlify is an npm workspaces monorepo with three apps:

- `apps/server`: Node.js, TypeScript, Fastify and SQLite (`better-sqlite3`).
- `apps/web`: React, TypeScript and Vite. The desktop app uses the same UI.
- `apps/desktop`: Tauri v2 (Rust) with a bundled Node.js runtime for local mode.

The server follows Clean Architecture with lean Domain-Driven Design. The web app and the server share no code; they communicate through the HTTP API. See [CONTRIBUTING.md](CONTRIBUTING.md#architecture-rules) for the layer rules.

The server has six contexts: Library, Reading, Catalog, Knowledge, Assistant and News.

## Security

- Every `/api` and `/opds` route needs Basic authentication. `/kosync` uses the KOSync headers that the protocol requires. `/mcp` needs a Bearer access token. `/health` is public.
- The server stores the password as a scrypt hash. It stores only the SHA-256 hash of each MCP access token.
- Knowlify never writes to source folders.
- Every request that fetches a URL from a user (RSS, metadata lookup, LLM settings) blocks SSRF. The server accepts only public destinations, pins the resolved IP address, and limits response size and time.
- The server encrypts the LLM key with AES-256-GCM. It never returns the key in a response and never writes it to a log.
- If you use a remote LLM, the tutor sends your question and passages from your books to that provider.
- The server rate-limits chat, MCP and metadata requests.
- At start, the server writes a warning to the log if the password is a default value (`admin` or `change-this-password`) and the server listens on a non-loopback address. Change the password.
- The desktop app accepts a plain `http://` server address only for local destinations. This includes private networks and the Tailscale range `100.64.0.0/10`. For other addresses, use HTTPS.

### HTTP on your local network

You can open Knowlify at `http://<server IP>:8787` with no HTTPS. It works, but Basic authentication sends the password with each request, and KOSync sends its key, both in clear text on the network. Use this only on a network that you trust. Do not open port 8787 to the Internet.

### Turn on HTTPS

For remote access, put Knowlify behind a reverse proxy that adds HTTPS (Caddy, Traefik or nginx), or use a private network such as Tailscale (`tailscale serve`). In Caddy, one line is enough:

```
knowlify.example.com { reverse_proxy 127.0.0.1:8787 }
```

Use a dedicated host name or port for Knowlify. A sub-path such as `/knowlify/` does not work. Turn off response buffering for `/api/chat*`, because the tutor streams its answers.

### Behind a reverse proxy

- When you run behind a proxy, client IPs in the logs need `KNOWLIFY_TRUST_PROXY`.
- `KNOWLIFY_TRUST_PROXY` is `off` by default, and the server then uses the socket address as the client address. Behind a proxy, every client has the proxy address, so the per-IP limits (MCP authentication failures and password changes) affect all users together. Set the variable to the proxy address or CIDR (for example `172.18.0.0/16`), to `on`, or to a number of proxy hops. Turn it on only when the proxy is under your control and clients cannot reach the port directly. If they can, they can forge `X-Forwarded-For` and bypass the limits.
- MCP: do not add proxy authentication to `/mcp`. If the server listens on `127.0.0.1` (`HOST=127.0.0.1`), set `KNOWLIFY_MCP_ALLOWED_HOSTS` to your host name (without a port). A browser-based MCP client needs its address in `KNOWLIFY_MCP_ALLOWED_ORIGINS`. The server answers `403` without the reason when the check fails.

## Contact

For a vulnerability, follow the private reporting steps in [SECURITY.md](SECURITY.md). Do not open a public issue.

For other private questions about the project, send an email to [contact@vmmazz.com](mailto:contact@vmmazz.com).

The source code, releases and issue tracker are at [github.com/Victor-Mazzei/Knowlify](https://github.com/Victor-Mazzei/Knowlify).

## Versioning

Knowlify uses [Semantic Versioning](https://semver.org/). The [CHANGELOG](CHANGELOG.md) lists the changes in each release.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, code style and architecture rules. Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Knowlify is released under the GNU AGPL-3.0-only. See [LICENSE](LICENSE).

Copyright (C) 2026 Knowlify.
