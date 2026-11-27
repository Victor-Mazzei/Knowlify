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

## [2.5.1] - 2026-11-27

### Fixed

- The tutor page no longer changes width when you switch between Ask and Session. On systems with classic scrollbars (for example macOS with "Show scroll bars: Always"), the columns, the message area and the text lines moved by about 15 px because the browser did not reserve room for the scrollbar. The tutor columns now always show their scrollbars on those systems, and the page is sized by its layout instead of its content.
- On a short desktop window, the one-time mode hint is hidden first, so the page does not start to scroll only because Ask has more controls. The message area keeps a minimum height of 120 px.
- Known limits: in windows with an effective height of about 400 px or less (for example a 390 px high phone screen, or 1280x600 at 150% zoom), the message field can sit below the fold and you scroll the tutor page to reach it. In the desktop app at high zoom and a small window, the "Connection settings" button can cover the message field.

## [2.5.0] - 2026-11-25

### Added

- Knowlify can tell you when a newer release is available. This check is on by default. At most once a day, and only while someone uses the interface, the server asks GitHub for the latest published, final release of the source repository. GitHub sees the IP address of the server and nothing else: Knowlify sends no version, no library data and no ID, and it sends nothing at start-up. You can turn it off in Settings > About or with `KNOWLIFY_UPDATE_CHECK=off`, which makes no requests at all. Set `KNOWLIFY_UPDATE_LOCKED=1` as well so the Settings switch cannot change it.
- The web app shows a small notice when the release is newer than your version, with a link to the release page. You can dismiss it, and it comes back only for a newer version. It is only a notice: Knowlify does not download or install anything. The notice is about the server. A desktop app in remote mode reports the remote server, not the app itself, and a version older than 2.5.0 cannot tell you about 2.5.0.
- Settings > About has an Updates card with the state, the last check time, a "Check now" button and the on/off switch. "Check now" waits at least 60 seconds between real requests. During that time it keeps the current state and says "Checked a moment ago."; it says "Could not check just now." only when the request really fails.
- New routes, all behind the usual sign-in: `GET /api/update` and `POST /api/update/check` (the same answer: `enabled`, `locked`, `canManage`, `current`, `latest`, `available`, `checkedAt`), and `GET` and `PUT /api/settings/update`. New optional settings: `KNOWLIFY_UPDATE_CHECK=on|off` (default `on`) and `KNOWLIFY_UPDATE_LOCKED=1`. A server without these routes shows nothing in the web app.
- With the local network guard on, a phone or tablet on the network does not see the notice and cannot change the switch. `POST /api/update/check` works only from the computer that runs Knowlify (`403` with `code: "local_only"`), and `GET /api/update` from another device returns the saved result without starting a check.

### Security

- The update check uses the same safe outbound policy as the other external requests: HTTPS to a fixed public address, no redirects, a 1 MB limit and an 8 second timeout. The server reads only the release tag, checks that it looks like `vX.Y.Z`, and builds the link itself. Failures are silent and retried later with a growing delay.

## [2.4.0] - 2026-11-25

### Added

- Desktop: Settings → Network ("Share on my network") opens your library to phones and tablets on the same local network. Sharing is optional and off by default. It uses its own 16-character share password and a fixed port (47870 by default) so the address can be bookmarked. A confirmation explains that the local server restarts. The card shows the local address, a QR code that signs the phone in once, the share password behind Show and Copy, a Regenerate password action, the port under Advanced, and firewall tips for Windows, macOS and Linux.
- Sharing limits you should know: traffic on the network is plain HTTP and is not encrypted, so use it only on networks you trust and never on public Wi-Fi (for an encrypted path, use Tailscale on both devices). Only IPv4 addresses are shown. It works only while Knowlify is open and the computer is awake. There is no installable web app (PWA) over the local network, because browsers require HTTPS for that.
- A phone or tablet can read and use the library and notes. Administration actions work only on the computer that runs Knowlify: library folders, settings, the account password and MCP tokens.
- Optional network guard `KNOWLIFY_NETWORK_GUARD=lan` for the server. It accepts only peers from the local network and only local `Host` and `Origin` values. Off by default; Docker and reverse-proxy deployments are unchanged.
- With the guard on, administration routes (folders, sources, settings writes, MCP tokens, account) answer `403` with `code: "local_only"` to everything except the same computer. The guard also limits failed Basic and KOSync sign-in attempts per address (10 per minute, then `429` with `Retry-After`).
- Desktop: the packaged app now includes the web app and serves it to the local network, while its own window keeps using the private loopback connection. Turning sharing on, off, changing the port or regenerating the password restarts the local server, which interrupts an upload or indexing in progress.

### Fixed

- On a phone or tablet, settings that only work on the computer now say so ("This action is only available on the computer that runs Knowlify") instead of showing a generic forbidden error, and you stay signed in.
- The copy buttons in Share on my network work on plain HTTP pages and only say "Copied" when the copy worked; otherwise they show "Copy failed. Select the text and copy it."
- A QR sign-in link is saved only after the browser removes the password from the address bar. If the browser cannot remove it, the link is ignored.

### Security

- No log level writes request credentials to the log. With `KNOWLIFY_LOG_LEVEL=trace`, the multipart parser logged the raw upload headers, including the `Authorization` password and `Host`. The logger now censors authorization, cookie, auth, token, secret, key and password headers, plus `Host`, `Origin` and `Referer`, at every level, including dynamic and capitalized names. Objects are copied through their property descriptors, so a `toJSON` function or getter cannot add credential fields after the censoring, and a reply logged under `res` is always censored. Known limits: logging a whole request or reply object under an unusual key, or a bare string that holds a secret, is not covered; the server does not log such objects.

## [2.3.2] - 2026-11-24

### Fixed

- The tutor workspace keeps the same chat column, composer and message width when switching between Ask and Session, including when the message list, the saved-session list or the page starts scrolling. The dock reserves the same space. Cost: with classic (always visible) scrollbars the message area, the session list and the page reserve about 15 px for the scrollbar even when nothing scrolls; overlay scrollbars are unaffected.

## [2.3.1] - 2026-11-24

### Changed

- Ask controls are simpler: "Search my books" explains what is sent, book suggestions moved behind the composer settings ("Suggest books from my library"), and "Suggest books" asks for book cards on the next message only. On windows up to 520 px high the "Suggest books" button is hidden to save space.

### Fixed

- The tutor page keeps its header and composer in place and scrolls only the message area. The tutor follows new answers while you are at the bottom, leaves you where you are when you scroll up, and offers "Jump to latest" to return.
- The message area keeps a minimum height on short windows, including wide desktops: the surrounding chrome yields and the column scrolls when needed, so the composer and Send stay reachable. On short or landscape windows the Ask page keeps the app menu and the saved-session list reachable through compact keyboard controls.
- In the desktop app, the tutor button and composer reserve space for the "Connection settings" button, following its font size and zoom. Known limit: in very small windows (effective width below 320 px, or effective height around 300 px at high zoom) the message field can still overlap the connection button.

## [2.3.0] - 2026-11-24

### Added

- Tutor Ask can recommend books from your own library for "what should I read" questions, with links to open them. It runs only in Ask over the whole library with "Use my library" on: the server picks at most five candidates from one wider passage search plus title, author, series and tag matches, sends only those to the model, validates the `[book:n]` markers it returns, and shows the cards only for markers that survive. With the library off it explains that suggestions need "Use my library" instead of naming books.
- Recommendation cards link to each book, and a control that appears only in Ask with the whole library and "Use my library" on can turn automatic suggestions off; the choice is remembered on this device.
- Tutor answers render as formatted Markdown in Ask and Session, in both book and library scopes: headings, bold and italic, nested lists, blockquotes, horizontal rules, tables with horizontal scroll, inline code, fenced code with a language header and an accessible Copy action, links, and line breaks. Citation chips stay inside formatted text, including lists, bold text and table cells.
- Code blocks are highlighted on demand after the block closes; while a block is still streaming it stays in plain monospace. The highlighter is a separate lazy chunk, and a failed load leaves readable unhighlighted code.

### Fixed

- "Save as session" removes book suggestion markers from assistant text and never edits your messages.
- A session limit reached after a tutor answer already started streaming now ends with a clear `conversation_limit` error instead of a generic language-model error, and the web keeps the partial answer, marks it incomplete and points to Settings → AI instead of dropping the turn.
- The boot warning about `KNOWLIFY_LLM_HEADERS` describes the current compatibility seed instead of promising a removal that already happened.
- The "Save as session" dialog now states the 20-message limit in the present tense before anything is attempted, and offers "Save last 20 messages" without saying that nothing was saved.

### Security

- Tutor Markdown never renders raw HTML or loads images: HTML is shown as text and image alt text and URLs are shown without a request. Links allow only http, https and mailto; other schemes stay text. Web links open with `noopener noreferrer nofollow`, show the destination host when the label does not, and the desktop shell shows mailto and public http as text because its bridge cannot open them safely.
- Chat logs never record questions, answers, book titles or recommendation text at any level; regression tests with sentinel values now cover the book recommendation and the Save as session paths.

## [2.2.0] - 2026-11-23

### Added

- The tutor has an Ask mode for quick questions that are not saved and a Session mode that keeps the history so it can be resumed later, with a visible description of each mode and a permanent "not saved" or "saved" state line.
- Ask can search your library or answer without it; the choice is visible, remembered on this device and sent per question. Attached reader text is always sent to the model and the interface says so.
- Saved tutor sessions are listed per book and for the whole library, with resume, inline rename and delete. Starting a new session never deletes the previous one, and opening the tutor in the reader resumes the latest session of that book.
- An Ask chat with questions asks before it is discarded and can be saved as a session.
- Settings → AI has a Session limit card (20 to 5000, with the current count). Reaching the limit blocks new sessions with a link to the setting instead of deleting the oldest session.
- `KNOWLIFY_CHAT_MAX_CONVERSATIONS` sets the initial session limit (default 200, range 20 to 5000); a limit saved in Settings → AI takes precedence.

### Changed

- Reaching the session limit now blocks new sessions instead of deleting the oldest one. Existing sessions keep working, Ask is unaffected, and lowering the limit never deletes anything.
- The tutor no longer ends every answer with a check question: questions are optional, at most one every three assistant turns and never in two consecutive turns; an explicit request to be tested is honored, and "no questions" is respected. New messages use prompt `feynman-5`; stored messages keep their original version.

### Fixed

- "Save as session" now refuses an Ask chat longer than the 20-message import limit with an explicit warning and saves nothing, instead of silently keeping only the newest turns. The dialog also offers an explicit "Save last 20 messages" action that says how many oldest messages it leaves out. Partial answers are imported exactly as shown and disclosed, unanswered last questions are disclosed, and Cancel and Discard keep working.

## [2.1.0] - 2026-11-23

### Added

- Passage retrieval keeps a small in-process LRU of stage results (passage ids and scores only, never hydrated text) with single-flight, a ten-minute TTL and cost-based admission; the cache is sized from the effective memory limit (cgroup v1/v2 or physical RAM), capped at 32/128/512 entries by memory tier, and is off with `KNOWLIFY_SEARCH_CACHE=off`. Every passage-index write increments an `IndexEpoch`, so a cached result is never served after an append, clear, deletion, merge, restore or reindex.
- The search index is warmed in the background by a transient worker thread with its own read-only connection: it reads the FTS5 shadow tables page by page (`dbstat`, 1 MiB slices, 16/48/128 MB/s by memory band, at most a quarter of the wall time), pauses within one slice before every query, chat stream, ingestion job and folder scan, waits five minutes after a query-worker timeout, stops on memory pressure and is cancelled on shutdown. `auto` (default) starts two seconds after the first completed query and never at boot; `on` also starts sixty seconds after the server listens; `off` never warms. It stays off on small indexes, below 128 MB of usable memory and when the working set does not fit the budget (metadata-only pass above 1 GB of budget), so 512 MB and 1 GB machines never issue warm-up reads on a large index. `KNOWLIFY_SEARCH_WARMUP=auto|on|off` and `KNOWLIFY_SEARCH_WARMUP_MAX_MB` (0 disables warming) control it.
- `GET /api/index/status` gains an additive `retrieval` block with the effective memory limit and budget, the warm-up mode, state, reason, scope, progress and last completion time, and the query-cache counters (entries, bytes, hits, misses). It is served from in-memory counters only: status polling never reads the disk or the query worker, and the block carries no path, key or query text.
- Settings > Search index shows the search warm-up state (off, idle, waiting, warming with progress, warm or paused), the reason when it is off or paused, and the retrieval cache size when the server reports them.

### Changed

- An FTS5 query whose full ranking is estimated not to fit the eight-second read ceiling now runs a cheap layered plan first: the three lowest-document-frequency terms (protected short terms and numbers pinned), common terms as exact tokens instead of prefixes, and the rare-term union preserved. If that pass returns fewer results than requested and the full pass still fits, the full ranking runs and the cheap hits follow it; otherwise the cheap hits are returned instead of discarding the worker and losing every match. Queries that already fit keep the previous results exactly. The stage-1 record documents the measured performance/recall trade-off at 3.3M chunks.
- The retrieval path keeps the unfiltered FTS query free of the passage-text join; a `bookId` filter still uses the bounded join, measured as the cheaper plan in the stage-1 lab.

### Fixed

- A timed-out search worker and a failed index read now log one short warning with the operation and duration, without a stack, SQL, query text or passage.
- The tutor answers a reply to its own check question as Feynman feedback instead of treating it as a new question: "I don't know", partial and wrong answers get a plain explanation, a gentle correction and one new short question, with prompt `feynman-4`.
- Tutor answers no longer open with library-search internals or partial-result narration; the neutral "try again in a moment" closing line is offered only when the search really timed out and the passages are insufficient, before the closing check question. A clean no-match never suggests a retry and mentions the missing library result only when a claim about the user's books needs that fallback; a conversational reply or Feynman feedback does not mention the library. A turn where the library was not used never suggests a retry or implies that a search ran.
- The tutor's working indicator is now three small dots that pulse in sequence while it thinks, and fade slowly on opacity alone when the system asks for reduced motion instead of freezing as static dots.

## [2.0.4] - 2026-11-22

### Fixed

- Tutor and library search no longer freeze the server on large indexes: FTS5 ranking and the exact vector scan run in a read-only worker thread with per-read time limits, and the query embedding falls back to lexical search after two seconds. Low-signal single-character terms no longer trigger whole-corpus scans, while languages, grades and symbols such as `C++`, `R` and `7` still match as exact tokens. Above the vector scan ceiling, a question with no lexical match gets a bounded, evenly spread semantic sample instead of no sources, and an abandoned embedding is cancelled instead of piling up in the ingestion worker.
- The unfiltered library search reads the FTS rowid directly instead of joining the passage text, which returns the same ranking and was 3–6× faster on a cold page cache in a 200k-chunk lab. The retrieval worker keeps its bounded memory settings (no multi-gigabyte mmap); its cache and busy-timeout values were measured and left unchanged.
- Library and tutor search now drop English, Portuguese and Spanish stopwords and question scaffolding, start prefix matching at three characters, keep at most ten informative terms, and try a two-term `AND` before falling back to the full `OR`. On a 200k-chunk lab this cut warm p95 from 743 ms to 157 ms (extrapolated to ~2.6 s at 3.3M chunks, below the 3 s target); short terms and numbers stay exact, so `C`, `R`, `Go`, `C++`, grades and years remain searchable. Results for long questions are more focused and are not identical to the previous ranking. The search worker also caches the `chunk_vectors` count per SQLite `data_version`.
- When a library-search read times out or its worker is discarded, the tutor is told the search timed out instead of being told that no passage matched: it briefly mentions the delay and answers from the conversation history and general knowledge, marked as such, without claiming the library has no information. Book-only turns say the library was not used for the question. This state stays inside the prompt; no API or SSE field was added.

## [2.0.3] - 2026-11-22

### Fixed

- Assistant chats with reasoning models (for example DeepSeek reasoner) no longer time out while the provider streams only `reasoning_content`. The reasoning text is never forwarded, logged or persisted, and an answer that ends without content reports a clear `llm_empty` error instead of a blank turn.
- Cancelling an assistant answer releases the turn while library retrieval is still running, so a queued turn is not held by a slow embedding query.
- Chat SSE responses send a one-second heartbeat and an explicit identity encoding, and CORS preflights are cached for ten minutes. This keeps reverse proxies from compressing or buffering the stream and works around WebKit 26.x withholding streamed chunks in the remote desktop app.
- The tutor keeps the conversation context: a short reply to its own question searches with that question and is always answered by the model, even when no library passage matches. Prompt `feynman-3` also sends a contiguous, token-budgeted history without stale citation markers or legacy canned turns.
- The tutor keeps a completed answer when the next question is sent, keeps a partial answer with "Answer incomplete." and Retry when a stream fails or closes early, replaces only that partial on Retry, and cancels the previous stream when the user stops it. Deltas now update the screen about every 100 ms.
- WebKit 26.x streams tutor answers over XHR instead of `fetch`, whose `ReadableStream` withholds chunks in that engine version; other browsers keep `fetch`. The tutor also shows a small accessible spinner instead of the fixed "Thinking…/Writing…" labels, and cover loading uses fewer connections so chat always has a free HTTP/1.1 slot.
- PDF pages render on older macOS/Windows/Linux web views that lack `Map.prototype.getOrInsertComputed`.
- The desktop connection screen shows only the fields for the selected mode: Local hides and disables the server URL, user name and password, Remote shows them, and switching modes neither clears the typed password nor stores remote credentials in local mode.
- Favoriting a book right after its details page loads keeps the toggle, and the delete dialog restores focus to Cancel after a partial deletion.

## [2.0.2] - 2026-11-22

### Fixed

- Library selection stops at 100 explicit books: clicks, shift ranges and "select loaded books" no longer grow an id selection past the bulk-delete ceiling, and the selection bar shows "100 of 100 selected" with an accessible warning that points to the uncapped "select every result of the current filter" path.

## [2.0.1] - 2026-11-22

### Fixed

- The desktop Node.js lockstep test detects the source and export layouts, so `npm test` passes in both without reading files that belong to the other layout.
- Web assistant tests wait for the answer stream to finish before asserting citation links and for the Retry control after stream errors, removing a flaky `ChatPanel` failure under load.

## [2.0.0] - 2026-11-22

### Added

- A desktop test keeps the pinned Node.js major in lockstep across `node-runtime.json`, `.nvmrc`, the Dockerfile and both CI workflows, and reports every mismatch.

### Changed

- BREAKING: minimum Node.js is now 26 (LTS). Source builds and the container image need Node.js 26 or later (`engines` is `>=26`); the desktop installers bundle their own Node.js and are not affected.
- The container image, the CI workflows, the desktop sidecar and the development setup now use Node.js 26 LTS (Lithium). The desktop bundles Node.js 26.13.1 with its SHA-256 hashes, and `node:fetch` verifies them.
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

[Unreleased]: https://github.com/Victor-Mazzei/Knowlify/compare/v2.5.1...HEAD
[2.5.1]: https://github.com/Victor-Mazzei/Knowlify/compare/v2.5.0...v2.5.1
[2.5.0]: https://github.com/Victor-Mazzei/Knowlify/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/Victor-Mazzei/Knowlify/compare/v2.3.2...v2.4.0
[2.3.2]: https://github.com/Victor-Mazzei/Knowlify/compare/v2.3.1...v2.3.2
[2.3.1]: https://github.com/Victor-Mazzei/Knowlify/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/Victor-Mazzei/Knowlify/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/Victor-Mazzei/Knowlify/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/Victor-Mazzei/Knowlify/compare/v2.0.4...v2.1.0
[2.0.4]: https://github.com/Victor-Mazzei/Knowlify/compare/v2.0.3...v2.0.4
[2.0.3]: https://github.com/Victor-Mazzei/Knowlify/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/Victor-Mazzei/Knowlify/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/Victor-Mazzei/Knowlify/compare/v2.0.0...v2.0.1
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
