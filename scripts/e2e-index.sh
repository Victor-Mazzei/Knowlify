#!/usr/bin/env bash
# End-to-end check of the search index against real server processes.
# Needs: node (tsx via the workspace), curl, jq. Uses a temporary data dir and an alternative
# port (default 8815, override with PORT). Never uses Docker or the usual dev ports.
#
# The real ingestion runner (apps/server/src/adapters/indexing/**) must be wired in
# apps/server/src/index.ts (createIngestionRunner). Without it the script stops with a
# clear message: the API runs, but indexing reports enabled:false and nothing is ingested.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8815}"; B="localhost:$PORT"; FAILS=0
USER_NAME=admin; PASS=index-e2e-pass-1; AUTH="$USER_NAME:$PASS"
D="$(mktemp -d)"; LOG="$D/server.log"
[ -s "$HOME/.nvm/nvm.sh" ] && { . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; nvm use 26 >/dev/null 2>&1 || true; }

start() { (cd "$ROOT/apps/server" && env KNOWLIFY_DATA="$D/data" PORT="$PORT" KNOWLIFY_USER="$USER_NAME" \
    KNOWLIFY_PASSWORD="$PASS" KNOWLIFY_SCAN_INTERVAL=0 KNOWLIFY_INDEXING=on KNOWLIFY_INDEX_BACKFILL=auto \
    KNOWLIFY_EMBEDDINGS=none nohup npx tsx src/index.ts >>"$LOG" 2>&1 &)
  for _ in $(seq 1 40); do sleep 1; curl -s -m 1 "$B/health" >/dev/null && return 0; done
  echo "server did not start (see $LOG)"; exit 2; }
stop() { local pid; pid=$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
  for _ in $(seq 1 50); do curl -s -m 0.2 "$B/health" >/dev/null || return 0; sleep 0.1; done
  return 0; }
trap 'stop; rm -rf "$D"' EXIT
code() { curl -s -o /dev/null -w '%{http_code}' -u "$AUTH" "$B$1"; }
get() { curl -s -u "$AUTH" "$B$1"; }
expect() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected [$2] got [$3]"; FAILS=$((FAILS+1)); fi; }
contains() { # name haystack needle
  case "$2" in *"$3"*) echo "ok   $1";; *) echo "FAIL $1: [$2] does not contain [$3]"; FAILS=$((FAILS+1));; esac; }

make_epub() { # path title paragraphs marker
  if ! (cd "$ROOT/apps/server" && node --input-type=module - "$1" "$2" "$3" "$4" <<'NODE'
import AdmZip from "adm-zip";
const [path, title, count, marker] = process.argv.slice(2);
const zip = new AdmZip();
zip.addFile("META-INF/container.xml", Buffer.from(
  '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">'
  + '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'));
zip.addFile("OEBPS/content.opf", Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'
  + `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">knowlify-e2e</dc:identifier>`
  + `<dc:title>${title}</dc:title><dc:language>en</dc:language></metadata>`
  + '<manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest>'
  + '<spine><itemref idref="chapter"/></spine></package>'));
let body = "";
const paragraphs = Math.max(1, Number(count));
for (let i = 0; i < paragraphs; i++) {
  body += `<p>${marker} paragraph ${i} ${"lorem ipsum dolor sit amet ".repeat(8)}</p>\n`;
}
zip.addFile("OEBPS/chapter.xhtml", Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head>'
  + `<body>${body}</body></html>`));
zip.writeZip(path);
NODE
  ); then echo "cannot create $1"; exit 2; fi; }

upload() { # path -> "body\nstatus"
  curl -s -u "$AUTH" -F "file=@$1;type=application/epub+zip" -w '\n%{http_code}' "$B/api/books"; }
wait_state() { # id expected attempts
  local state=""
  for _ in $(seq 1 "$3"); do
    state=$(get "/api/books/$1" | jq -r '.index.state // empty')
    [ "$state" = "$2" ] && { echo "$state"; return; }
    [ "$state" = "error" ] && { echo "$state"; return; }
    sleep 1
  done
  echo "$state"
}

start
STATUS="$(get /api/index/status)"
expect "status is public only behind Basic" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/index/status")"
if [ "$(jq -r .enabled <<<"$STATUS")" != "true" ]; then
  echo "Indexing is disabled or no runner is wired."; echo "Wire the real IngestionRunner in apps/server/src/index.ts (createIngestionRunner)."
  echo "Server log: $LOG"; exit 3
fi
expect "indexing enabled" true "$(jq -r .enabled <<<"$STATUS")"
expect "embedder is lexical in this run" none "$(jq -r .search.embeddings <<<"$STATUS")"

echo; echo "-- upload, queue and search --"
SMALL="$D/small.epub"; make_epub "$SMALL" "Index probe" 1 "knowlifyprobe"
UPLOAD="$(upload "$SMALL")"; BODY="${UPLOAD%$'\n'*}"; STATUS_CODE="${UPLOAD##*$'\n'}"
expect "upload returns immediately with 201" 201 "$STATUS_CODE"
expect "upload response is pending" pending "$(jq -r '.index.state' <<<"$BODY")"
ID="$(jq -r .id <<<"$BODY")"
expect "book becomes searchable" ready "$(wait_state "$ID" ready 120)"
SEARCH="$(get "/api/passages/search?q=knowlifyprobe")"
expect "search mode" lexical "$(jq -r .mode <<<"$SEARCH")"
expect "coverage counts the book" 1 "$(jq -r .coverage.indexed <<<"$SEARCH")"
contains "search finds the indexed text" "$(jq -r '.hits[0].text' <<<"$SEARCH")" "knowlifyprobe"
expect "book DTO reports ready" ready "$(get "/api/books/$ID" | jq -r '.index.state')"
expect "short query is rejected" 400 "$(code '/api/passages/search?q=a')"
expect "unknown book reindex is 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' -u "$AUTH" -X POST "$B/api/books/missing/index")"

echo; echo "-- restart in the middle of a larger job --"
BIG="$D/big.epub"; make_epub "$BIG" "Resume probe" 1200 "resumeprobe"
UPLOAD="$(upload "$BIG")"; BODY="${UPLOAD%$'\n'*}"; STATUS_CODE="${UPLOAD##*$'\n'}"
expect "big upload returns immediately with 201" 201 "$STATUS_CODE"
BIG_ID="$(jq -r .id <<<"$BODY")"
MIDWAY=0
for _ in $(seq 1 50); do
  COUNTS="$(get /api/index/status)"
  BUSY=$(( $(jq -r '.counts.pending' <<<"$COUNTS") + $(jq -r '.counts.indexing' <<<"$COUNTS") ))
  [ "$BUSY" -gt 0 ] && { MIDWAY=1; break; }
  sleep 0.1
done
[ "$MIDWAY" -eq 1 ] && echo "ok   stopped while the queue was busy" || echo "note job finished before the restart; checking persistence only"
stop
start
expect "indexing is enabled after restart" true "$(get /api/index/status | jq -r .enabled)"
expect "interrupted or finished job resumes to ready" ready "$(wait_state "$BIG_ID" ready 180)"
RESUMED="$(get "/api/passages/search?q=resumeprobe")"
contains "resumed index is searchable" "$(jq -r '.hits[0].text' <<<"$RESUMED")" "resumeprobe"
expect "status stays free of secrets" "0" "$(get /api/index/status | grep -ciE 'api[_-]?key|https?://|/data/')"

echo; [ "$FAILS" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "$FAILS CHECK(S) FAILED"; exit "$FAILS"
