# Changelog

All notable changes to Knowlify are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

<!--
Integrator: add each user- or operator-visible change under Added, Changed,
Deprecated, Removed, Fixed or Security, one line per change. This file is written in English. At
release time, keep `## [Unreleased]` at the top (empty) and insert a new
`## [X.Y.Z] - YYYY-MM-DD` section right below it with the entries; add the
comparison links at the bottom, then run `npm run version:set -- X.Y.Z`.
-->

## [2.0.0] - 2026-11-22

### Added

- A desktop test keeps the pinned Node.js major in lockstep across `node-runtime.json`, `.nvmrc`, the Dockerfile and both CI workflows, and reports every mismatch.

### Changed

- BREAKING: minimum Node.js is now 26 (LTS). Source builds and the container image need Node.js 26 or later (`engines` is `>=26`); the desktop installers bundle their own Node.js and are not affected.
- The container image, the Gitea and GitHub CI workflows, the desktop sidecar and the development setup now use Node.js 26 LTS (Lithium). The desktop bundles Node.js 26.13.1 with its SHA-256 hashes, and `node:fetch` verifies them.
- The minimum Node.js version for source builds is now 26: `engines` is `>=26` in the root and workspace manifests, and `.nvmrc` selects 26. The desktop build fails closed when the host major is not 26.
- The web reader renders PDFs with PDF.js 6.5.438 and loads its module worker from the Vite build. The reader releases the document through the loading task, because PDF.js 6 removed `PDFDocumentProxy.destroy()`, and passes the canvas explicitly to `page.render`.
- The web client builds with Vite 8 and its tests run on Vitest 5.1, jsdom 31 and Testing Library jest-dom 8; the server test suite also moved to Vitest 5.1. Facet filter checkboxes now separate the label from the count for assistive technology ("PDF 4" instead of "PDF4").
- The server uses N-API native modules: better-sqlite3 13 (SQLite 3.54.1) and @napi-rs/canvas 1.2, with one canvas version shared by pdf.js and the web test DOM. Server and root dependencies were refreshed within their compatible ranges.
- The web client uses React 19 and react-dom 19 with their matching type packages, and react-router-dom 7.18.6. Dialog focus handling, the assistant chat and the reader were updated for React 19's nullable ref types; no HTTP contract or user-visible behavior changed.
- The server extracts PDF text and renders covers with pdf.js 6.5.438, using its packaged WebAssembly image codecs and Base-14 font data; covers for PDFs that rely only on standard fonts are no longer blank.
- The desktop server bundle also copies dependencies that npm nests under `apps/server/node_modules` when another workspace pins a different version, so `pdfjs-dist` is present in the packaged sidecar.
- The server and web workspaces compile with TypeScript 7.0.2, the native compiler; the library card now annotates its anchor click event explicitly. Tauri CLI 2.12.6 was already the latest 2.x, so it stays pinned.
- The desktop Rust dependencies were refreshed within their compatible ranges (`cargo update`); Tauri 2.12.7, tauri-build 2.7.6 and the app version are unchanged.
- The root `overrides` entry for `@napi-rs/canvas` was removed: the server's direct dependency keeps pdf.js and jsdom on canvas 1.2.0.

### Fixed

- The web PDF reader loads PDF.js 6's WebAssembly image codecs from the Vite build, so JPEG 2000, JBIG2 and ICC images render instead of leaving blank areas; the desktop CSP allows WebAssembly for the same codecs.
- The desktop release workflow verifies and removes the per-target `SHA256SUMS-<target>` files, so the draft release contains exactly the six installers and `SHA256SUMS`.

### Security

- The desktop CSP now allows `'wasm-unsafe-eval'` in `script-src` only, for the same-origin PDF.js 6 WebAssembly codecs; `'unsafe-eval'` stays forbidden.
- The container image and the desktop server bundle install packages from the N-API prebuilds shipped with better-sqlite3 and canvas and skip npm lifecycle scripts, so the runtime image no longer needs a compiler.


## [1.8.1] - 2026-11-22

### Fixed

- The web settings module no longer ships files whose names differ only by case, which made `tsc -b` resolve the LLM form component to its form logic on macOS and Windows.
- Opening a library URL with a tag filter (`?tag=<id>`) no longer drops the filter while the tag list is still loading; unknown tag ids are still removed once the list arrives.
- The desktop release workflow extracts the Node.js Windows ZIP with the system `tar.exe`, so Git Bash's GNU tar no longer treats the drive letter as a remote host.
- `verify-bundle` extracts AppImages with their own `--appimage-extract` runtime because `unsquashfs` cannot read the squashfs after the ELF header. It also recognizes the bundled license path on Windows.

## [1.8.0] - 2026-11-21

### Added

- Desktop installers for Windows x64 (NSIS), macOS (Apple Silicon and Intel, `.dmg`) and Linux x64 (AppImage, `.deb` and `.rpm`), built by the release workflow. The installers are unsigned.
- `KNOWLIFY_LOG_LEVEL` (`error`, `warn`, `info`, `debug`, `trace` or `silent`; default `info`) with diagnostic debug events that never include secrets or user content.
- Metadata search errors carry an optional `reason`, and the dialog explains why a provider failed (Google Books permission, key, rate limit or network).

### Changed

- The desktop app bundles Node.js 22, so local mode no longer needs a system Node.js. `KNOWLIFY_NODE` is now only an explicit override of the bundled runtime.
- The documented minimum Node version is now 22.23.5, the oldest 22.x release the test suite passes on; the container image and the CI keep using the current Node 22 LTS release.

### Fixed

- Metadata lookup failures are now logged instead of silent.

## [1.7.3] - 2026-11-21

### Changed

- Simplified the project site captions and the license line in the README.
- Dependency updates (patch and minor): vite 7.3.8, Fastify plugins (cors, multipart, static), fast-xml-parser 5.12.1, Tauri 2.12.7 and tauri-build 2.7.6.

## [1.7.2] - 2026-11-21

### Removed

- Generated third-party notices file (THIRD_PARTY_NOTICES.md), its generator and the pipeline check; dependency licenses stay inside each installed package.

## [1.7.1] - 2026-11-21

Version 1.7.0 was tagged but never published because its release pipeline failed. 1.7.1 is the first published release and includes all 1.7.0 changes.

### Added

- `npm test` at the repository root runs the server and web test suites.

### Changed

- Removed the repository-tooling test suites; those checks are run as commands.

### Fixed

- Release pipeline: third-party notices are now generated only from `package-lock.json` plus a committed license table, so the output is identical on every platform and the pipeline check no longer depends on the installed packages.

## [1.7.0] - 2026-11-20

### Added

- `AGPL-3.0-only` license, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and generated `THIRD_PARTY_NOTICES.md`; the license and notices are also copied into the Docker image.
- Open-source README and a reproducible, history-free export script for the public GitHub repository, with a leak scan (internal hosts, paths, e-mails, keys) and GitHub Actions, Dependabot and issue templates.
- Static project site in `site/`, published by a GitHub Pages workflow.
- LLM API style in Settings: `openai` (default) or `anthropic` (Messages API), with a matching model list and connection test.
- Custom provider headers for the LLM (up to 8, encrypted at rest, `{{conversationId}}` variable). `KNOWLIFY_LLM_HEADERS` sets the initial value.
- Source code link in Settings → About, from `KNOWLIFY_SOURCE_URL` (`sourceUrl` in `GET /api/about`).
- Settings with side navigation and section routes (`/settings/:section`). Old anchors and `/folders` redirect to the matching section.
- Metadata lookup card in Settings → Metadata.
- Metadata lookup settings: toggle and encrypted Google Books API key stored from the Settings panel (`KNOWLIFY_METADATA_LOCKED`).
- Embedding model fork guide in the README.
- `KNOWLIFY_TRUST_PROXY` (`off`, `on`, hop count or proxy IPs/CIDRs) so per-IP limits see the real client address behind a reverse proxy.
- Boot warning when the password is a default value (`admin` or `change-this-password`) and the server listens on a non-loopback address.
- README sections for plain-HTTP use on a local network, turning on HTTPS, running behind a reverse proxy and MCP behind a proxy.
- `docker-compose.yml` passes `KNOWLIFY_TRUST_PROXY`, `KNOWLIFY_METADATA_LOOKUP`, `KNOWLIFY_GOOGLE_BOOKS_API_KEY`, `KNOWLIFY_METADATA_LOCKED` and `KNOWLIFY_FORCE_ENV_PASSWORD` to the container.

### Changed

- The LLM session header that was fixed in the client is now a migrated custom header on existing configurations.
- Public project identity: contact `contact@vmmazz.com`, GitHub repository `Victor-Mazzei/Knowlify`, the lowercase GHCR image name and the GitHub Pages site under `/Knowlify/`. `scripts/export-github.sh` defaults to that repository, creates the initial commit with the public author identity and prints the remote and push commands without creating a remote or pushing.
- Provider-neutral wording for the OpenAI-compatible LLM settings, `.env.example` and client comments.
- Configuration comments in `.env.example`, `docker-compose.yml` and related files are now in English.

### Fixed

- No native browser login popup when you use Knowlify over plain HTTP on a LAN IP: the 401 challenge is now sent only for `/opds*` or `Accept: text/html`, not by `Sec-Fetch-Dest`.
- The desktop app accepts `http://` servers on Tailscale addresses (`100.64.0.0/10`).

### Security

- The export check blocks internal hostnames, local paths, personal e-mails and secret-like patterns, and runs gitleaks when available.

## [1.6.0] - 2026-11-20

### Added

- Book details page (`/book/:id`) with cover, metadata, reading progress, favorite star, tags, recent notes and Read/Continue.
- Favorites: star on cards, rows and the details page; Favorites filter and facet; bulk favorite/unfavorite by ids or filter; MCP `set_book_favorite` (`write_notes`) and a `favorite` filter in `list_books`.
- Editable metadata with reset: title, author, description, ISBN, year, publisher, language, series and a custom cover are stored as an override, survive rescans and never touch the book files.
- Online metadata search on demand (Open Library by default, Google Books as fallback), with field-by-field apply and cover download; `KNOWLIFY_METADATA_LOOKUP` and optional `KNOWLIFY_GOOGLE_BOOKS_API_KEY`.
- Database migration v11 (additive: `books.favorite`, `file_*` columns, `cover_rev`, `book_metadata_overrides`).

### Changed

- Clicking a book in the Library now opens its details instead of the reader.

### Security

- Metadata lookup SSRF protections: fixed provider hosts, public IPs only with pinning, cover URL allowlist, revalidated redirects, size and time limits, sanitized third-party text.
- Covers (upload or URL) are decoded and re-encoded to JPEG in an isolated child process.

## [1.5.0] - 2026-11-20

### Added

- Notes are grouped by book with covers, newest note first, with per-book collapse, "Show all N notes" and paged groups.
- Global floating tutor with "This book" and "Whole library" modes (Alt+T), available on every screen and in the reader.
- MCP server at `/mcp` (Streamable HTTP, stateless) with access tokens (`read` | `write_notes`) managed in Settings → MCP access; tools: `search_passages`, `list_books`, `get_book`, `list_notes`, `list_tags`, `get_index_status`, `create_note`, `add_tags_to_books`, `remove_tags_from_books`. Passages and notes returned to the connected AI app leave your machine (privacy note in Settings and README).
- `GET /api/notes/groups`, `q` on `GET /api/books/:id/notes`, and `GET/POST/DELETE /api/mcp/tokens`.
- Optional environment variables `KNOWLIFY_MCP`, `KNOWLIFY_MCP_RATE_PER_MIN`, `KNOWLIFY_MCP_WRITE_RATE_PER_MIN`, `KNOWLIFY_MCP_ALLOWED_ORIGINS`, `KNOWLIFY_MCP_ALLOWED_HOSTS`.
- Database migration v10 (additive: `notes_book_updated` index and `mcp_tokens` table).

### Changed

- `/ask` is now the tutor history workspace.
- `BookChatPanel` is replaced by the global tutor.

### Security

- MCP token model: `knw_mcp_` tokens with 256 bits, only the SHA-256 hash is stored, shown once, immediate revocation, scoped tools, no destructive tool, and a token never works on `/api/*` (Basic never works on `/mcp`).
- `Origin` allowlist on `/mcp` (CORS off), per-token and per-IP failure rate limits, and request and response size caps.

## [1.4.0] - 2026-11-07

### Added

- Desktop local server readiness is checked through the public `/health` endpoint, so credentials are never sent during startup.

### Changed

- **Migration note:** a saved or new desktop remote connection that uses plain `http://` to a public host is now refused; use `https://`. Loopback, private LAN addresses, `localhost`, single-label and `.local`/`.lan`/`.home.arpa` hosts keep working over HTTP.
- The desktop local server runs with `KNOWLIFY_LLM_ALLOW_PRIVATE=on`, so it can reach an LLM on loopback or LAN.
- The desktop navigation guard allows only the exact origin (scheme, host, port) of the connected server.

### Fixed

- Desktop `server.log` is rotated at 5 MiB instead of growing without bound.
- Desktop Rust sources pass `cargo clippy -- -D warnings` and `cargo fmt --check`.

### Security

- Desktop webview now enforces a content security policy; its capabilities are limited to core defaults and the folder-open dialog.
- Desktop connection, password and secret files are created with 0600 permissions on Unix.

## [1.3.0] - 2026-11-07

### Added

- App logo and icons: favicon, PWA manifest and desktop icons; the brand mark also appears on the empty Library.
- Book tags: create, rename, recolor and delete tags in Settings; tag books individually or in bulk (selected ids or every result of a filter) from the Library selection bar; filter by tag and see tag counts in the facets.
- Multi-select in the Library (click, Shift range, Ctrl/Cmd toggle, select all results) with a selection action bar.
- Delete books from the Library with an impact preview, note confirmation and type-to-confirm for large batches. Deleted books are kept in an ignored-books list so folder scans do not bring them back; files in library folders are never touched. Restore them from Settings → Ignored books (or upload the same file again).
- `sort=reading` ("Reading" order) on the paginated book list, plus tag routes and fields (`/api/tags`, `PATCH /api/books/tags`, `tag` filter, `tagIds`).
- Schema migration v9 (additive): tags and ignored books.

### Changed

- The default Library order is **Reading**: books in progress first, by most recently read, then the rest by date added.
- `DELETE /api/books/:id` now also accepts books from library folders (the file is never touched) and requires `confirmNotes` when the book has notes.

## [1.2.1] - 2026-11-07

### Fixed

- Remaining layout shift when returning to the Library and from the Reader: the Library grid is now measured before the first paint, the workspace status (chat, scan, index) is shared by a provider above the routes so the Reader no longer remounts the shell or grows its toolbar, and status requests are tied to the current session so a late answer or 401 from a previous login can no longer affect a new one.

## [1.2.0] - 2026-11-07

### Changed

- Library folders moved from the menu into Settings: the **Folders** menu item is gone and Settings now opens with a Folders card (list, add through the folder picker or a typed path, remove, rescan). `/folders` redirects to `/settings#folders`, and the empty Library offers an "Add a library folder" link to it.
- CI also publishes the moving `latest` Docker tag on pushes to `main`, alongside `sha-<sha>` and `main`, so deployments can always pull the newest main build; `X.Y.Z` release tags remain immutable. The deployment docs now show an image-only production compose (defaulting to `latest`, `pull_policy: always`) and how to pin or roll back by tag.

### Fixed

- Layout flicker when navigating through the menu: the app shell (header and navigation) now stays mounted across pages, so the Ask link no longer disappears and reappears, and the header and menu no longer shift while pages load; the Library toolbar reserves room for the Filters button.

## [1.1.0] - 2026-11-07

### Added

- Content-based deduplication: a book is identified by file size plus SHA-256, so identical copies in other folders or renamed files no longer create extra books. During a scan, identical copies become aliases of the existing book (no metadata extraction, cover or indexing) and the scan status reports `skippedDuplicates` and `movedFiles`.
- Moved or renamed files keep their book id, so notes, reading progress and the search index survive; an unmounted, empty or unreadable source never removes books or their canonical path.
- Duplicates card in Settings and `GET /api/duplicates`, `POST /api/duplicates/scan` and `POST /api/duplicates/merge` to find books that were already duplicated and merge them after a dry-run review: notes, conversations and the latest reading progress move to the kept book and the duplicate's index is discarded. Files in library folders are never changed or deleted.
- "N duplicates skipped" link in the header after a scan, and an "Already in your library" notice with an Open link when an uploaded file already exists.
- Schema migration v8 (additive): `books.content_hash`, `book_duplicates` and `book_merge_log`.

### Changed

- Uploading a file that is already in the library now answers `200` with the existing book and `duplicateOf` instead of `201`; nothing is stored or indexed again, and two simultaneous identical uploads create a single book.
- `GET /api/scan` and `POST /api/scan` responses gain `skippedDuplicates`, `movedFiles` and `duplicates` (additive).

### Fixed

- Books whose copies cannot be verified (unreadable or offline sources) are kept instead of being treated as removed or moved.

## [1.0.1] - 2026-11-07

### Fixed

- Library table columns no longer resize while scrolling: the table uses a fixed column grid shared by the header and the rows.
- Table row height now matches the virtualization step (44 px), so the list no longer drifts while scrolling.
- The table header stays sticky while the page scrolls.
- Truncated title and author cells expose the full text through `title`.

## [1.0.0] - 2026-11-07

First versioned release. It records the state of Knowlify when semantic versioning was introduced.

### Added

- Personal library of PDF and EPUB books with import by upload or by scanning external, read-only folders; metadata and cover extraction.
- Web reader for EPUB and PDF with saved reading progress, and a desktop app (Tauri) that wraps the same interface.
- Notes and quotes per book, with a Notes tab and deletion of notes from that tab.
- OPDS catalog and KOSync endpoint so KOReader can browse the library and sync reading progress.
- News tab with RSS feeds chosen by the user, topic search and bookmarks; feed fetching blocks SSRF.
- Account card in Settings to change the password (scrypt), with recovery and lock switches for operators (`KNOWLIFY_FORCE_ENV_PASSWORD`, `KNOWLIFY_ACCOUNT_LOCKED`) and attempt rate limiting.
- Asynchronous book indexing (full-text and optional embeddings) in background workers, with per-book index state, a search-index card, pause/resume, ETA and re-index actions.
- Tutor chat (Feynman method) over the whole library or the open book, with streaming answers and `[n]` citations to retrieved passages, conversation history and conversation deletion.
- LLM settings in the interface: server URL, encrypted API key, model list fetched from the provider, generation parameters and an editable system prompt with reset to default.
- Folder picker for sources in the web and desktop apps (`/api/fs`, restricted by `KNOWLIFY_BROWSE_ROOTS`).
- Percentage left to finish each book, in the reader and in the library grid and table.
- Library filters (format, reading status, index state, source, author, notes) with facet counts and URL-shareable state.
- About card in Settings and authenticated `GET /api/about` with the application version, build commit, build date and Node version.
- Single semantic version across all packages, `npm run version:check` and `npm run version:set`, a release-consistency CI job, and Docker images whose version tags are immutable and published only from `vX.Y.Z` tags.
- Operator environment variables for scale, the LLM and secrets: `KNOWLIFY_SCAN_CONCURRENCY`, `KNOWLIFY_METADATA_WORKERS`, `KNOWLIFY_INDEX_WORKERS`, `KNOWLIFY_INDEX_VECTORS_MAX_BOOKS`, `KNOWLIFY_VECTOR_SCAN_MAX`, `KNOWLIFY_LLM_*`, `KNOWLIFY_SECRET`.

### Changed

- The library supports 11,000+ books: paginated, virtualized list with signed cursors, server-side search and sort, lazy covers and `GET /api/books/facets`; the unpaginated `GET /api/books` is deprecated.
- Faster import, scan and metadata extraction (bounded concurrency, batches, worker threads) and a prioritized indexing queue that keeps the API responsive.
- Cleaner library layout and design tokens; the AI assistant settings inputs follow the same style.
- Dependencies upgraded so that `npm audit` reports no vulnerabilities.

### Fixed

- Library grid rows no longer overlap their cards after filtering or searching.
- EPUB position is preserved in narrow windows.
- Nested dialogs close one at a time with Escape, and long News queries are handled.
- Provider rejections from the LLM (HTTP 400) are diagnosed and no longer break the chat.
- The "Server URL" input in the AI assistant card has the correct layout again, and the model select arrow has room on the right.
- onnxruntime thread-affinity errors no longer appear in the logs.
- The desktop app opens external links in the system browser and allows the `blob:` and `about:` pages the EPUB reader needs.

### Security

- SSRF-safe handling of user-supplied URLs: RSS feeds accept only public HTTP(S) destinations, while the LLM URL configured in the interface accepts public HTTPS destinations on port 443 by default; both use resolved IP pinning, no redirects and size/time limits, and LLM requests are rate-limited. Operators can allow loopback/private LLM destinations with `KNOWLIFY_LLM_ALLOW_PRIVATE`; LLM and embedding URLs supplied through the environment follow the documented operator exception.
- LLM API key stored encrypted (AES-256-GCM) and never returned by the API or written to logs.
- `/api/fs` and source creation are limited to configured browse roots.
- Retrieved passages and reader excerpts are treated as untrusted data in the prompt.

[Unreleased]: https://github.com/Victor-Mazzei/Knowlify/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/Victor-Mazzei/Knowlify/compare/v1.8.1...v2.0.0
[1.8.1]: https://github.com/Victor-Mazzei/Knowlify/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/Victor-Mazzei/Knowlify/compare/v1.7.3...v1.8.0
[1.7.3]: https://github.com/Victor-Mazzei/Knowlify/compare/v1.7.2...v1.7.3
[1.7.2]: https://github.com/Victor-Mazzei/Knowlify/compare/v1.7.1...v1.7.2
[1.7.1]: https://github.com/Victor-Mazzei/Knowlify/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/Victor-Mazzei/Knowlify/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/Victor-Mazzei/Knowlify/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/Victor-Mazzei/Knowlify/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/Victor-Mazzei/Knowlify/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Victor-Mazzei/Knowlify/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/Victor-Mazzei/Knowlify/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Victor-Mazzei/Knowlify/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Victor-Mazzei/Knowlify/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/Victor-Mazzei/Knowlify/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Victor-Mazzei/Knowlify/releases/tag/v1.0.0
