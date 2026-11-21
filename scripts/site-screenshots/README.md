# Site screenshots

The public site (`site/`) uses real captures from a running Knowlify instance.
This directory contains the reproducible pipeline: download public-domain books,
seed a disposable library, start a fake OpenAI-compatible provider and capture
the screenshots with Playwright.

Nothing here runs in production. Use a temporary data directory and delete it
when you are done.

## Prerequisites

- Node.js 24 (or 22.12+) and `npm ci` in the repository root.
- A Chromium binary. The capture script can reuse the browser installed by
  Playwright, or any local Chromium. Set `CHROMIUM_PATH` when the default search
  does not find one.
- `playwright-core`, installed outside this repository so it is never committed:

```bash
mkdir -p /tmp/knowlify/ge-site-tools
cd /tmp/knowlify/ge-site-tools
npm init -y
npm install playwright-core@1.61.1
# If you do not already have a browser:
npx --yes playwright@1.61.1 install chromium
```

`sharp` comes from the repository dependencies (`npm ci`) and is used to write
the WebP files and the Open Graph image.

## 1. Download the fixture books

```bash
DEMO=/tmp/knowlify/ge-site-demo
rm -rf "$DEMO"
mkdir -p "$DEMO/data"
node scripts/site-screenshots/fetch-books.mjs "$DEMO/books/library"
```

The script refuses a non-empty target directory and validates every EPUB ZIP.
Every request and redirect must stay on HTTPS `standardebooks.org`, and response
bodies are streamed with a 40 MB limit instead of being buffered first.
Project Gutenberg was unavailable when these captures were made (HTTP 503,
`Retry-After: 21600`), so the fixture uses Standard Ebooks. Both are free
editions of public-domain books. The list is in `fetch-books.mjs`.

## 2. Start the fake LLM and the app

Use free ports. The example uses 18987 for the app; the LLM gets an ephemeral
port from the operating system.

```bash
DEMO=/tmp/knowlify/ge-site-demo
node scripts/site-screenshots/fake-llm.mjs "$DEMO/llm.port" &
LLM_PORT=$(cat "$DEMO/llm.port")

PORT=18987 HOST=127.0.0.1 \
KNOWLIFY_DATA="$DEMO/data" \
KNOWLIFY_WEB_DIR="$PWD/apps/web/dist" \
KNOWLIFY_USER=admin KNOWLIFY_PASSWORD=demo-library-pass \
KNOWLIFY_LIBRARY_PATHS="$DEMO/books/library" \
KNOWLIFY_BROWSE_ROOTS="$DEMO/books/library" \
KNOWLIFY_SCAN_INTERVAL=0 KNOWLIFY_INDEXING=on KNOWLIFY_EMBEDDINGS=none \
KNOWLIFY_LLM_URL="http://localhost:$LLM_PORT/v1" \
KNOWLIFY_LLM_API_KEY=demo-key KNOWLIFY_LLM_MODEL=tutor-demo \
KNOWLIFY_LLM_ALLOW_PRIVATE=on \
KNOWLIFY_METADATA_LOOKUP=off KNOWLIFY_MCP=on \
KNOWLIFY_SECRET=ge-site-demo-secret-0123456789abcdef \
node_modules/.bin/tsx apps/server/src/index.ts &
```

Build the web app first, if `apps/web/dist` is missing or stale:

```bash
npm run build -w @knowlify/web
```

The server serves the built web app and the API on the same port.

## 3. Seed the library

```bash
KNOWLIFY_BASE_URL=http://127.0.0.1:18987 \
KNOWLIFY_PASSWORD=demo-library-pass \
node scripts/site-screenshots/fixtures.mjs
```

The script waits for the 18 books and the lexical index, then creates tags,
favorites, reading progress and 12 notes. It is safe to re-run only against a
fresh data directory; it does not delete existing fixtures.

## 4. Capture

```bash
NODE_PATH=/tmp/knowlify/ge-site-tools/node_modules \
KNOWLIFY_BASE_URL=http://127.0.0.1:18987 \
KNOWLIFY_PASSWORD=demo-library-pass \
CHROMIUM_PATH="$HOME/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome" \
node scripts/site-screenshots/capture.mjs
```

The script writes to `site/assets/img/`:

- `library-light.webp`, `library-dark.webp` (hero, 1440 x 900)
- `library-filters.webp` (favorites view, 1440 x 900)
- `book-details.webp` (1440 x 900)
- `reader-tutor.webp` (tutor answer, 1440 x 900)
- `notes.webp` (1440 x 900)
- `settings-mcp.webp` (no tokens, 1440 x 900)
- `library-mobile.webp` (390 x 844)
- `library-light-720/1080.webp`, `library-dark-720/1080.webp`,
  `reader-tutor-720/1080.webp` and `*-720.webp` for the feature plates:
  responsive variants used by `srcset`
- `og.png` (1200 x 630)

Open every image and check it for local paths, internal hostnames, tokens,
personal names and email addresses before committing. The Settings screenshot
must show the MCP card with no tokens.

## 5. Clean up

```bash
kill %1 %2
rm -rf /tmp/knowlify/ge-site-demo
```

The fixture never writes to the downloaded books. The server only writes to
`$DEMO/data`.
