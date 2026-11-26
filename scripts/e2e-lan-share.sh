#!/usr/bin/env bash
# End-to-end check of the desktop "Share on my network" server mode against the real packaged server.
# Starts the embedded Node (as the desktop sidecar does) on 0.0.0.0, an ephemeral port, the LAN guard and a
# share password, then probes it with curl through two paths: loopback (127.0.0.1) and this machine's own
# LAN address (the peer is then not loopback). Without a private LAN address those cases are skipped and reported.
# Needs: curl, jq, md5sum, ip, and the packaged server (run `npm run build -w @knowlify/web`, then
# `node apps/desktop/scripts/node-runtime.mjs fetch` and `node apps/desktop/scripts/prepare-server.mjs`).
# Data goes to E2E_DIR (default: ~/.cache/e2e-lan-240). Exit code 0 only if every check passes.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2E_DIR="${E2E_DIR:-$HOME/.cache/e2e-lan-240}"
SERVER="$ROOT/apps/desktop/src-tauri/resources/server"
NODE_BIN="$(ls "$ROOT"/apps/desktop/src-tauri/binaries/knowlify-node-* 2>/dev/null | head -1)"
[ -x "${NODE_BIN:-}" ] && [ -f "$SERVER/dist/index.js" ] && [ -f "$SERVER/web/index.html" ] || { echo "packaged server or sidecar missing; see the header of this script"; exit 2; }
PASSWORD="Share-Pass-7K2M9Q4X"; USERNAME=desktop; FAILS=0; SKIPS=0
PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("0.0.0.0",0));print(s.getsockname()[1])')"
LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"
case "$LAN_IP" in 10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*|169.254.*) ;; *) LAN_IP="";; esac
LO="127.0.0.1:$PORT"; LAN="${LAN_IP:+$LAN_IP:$PORT}"
LOG="$E2E_DIR/server.log"; PIDFILE="$E2E_DIR/pid"
rm -rf "$E2E_DIR"; mkdir -p "$E2E_DIR/data"
J='content-type: application/json'
code() { curl -s -m 5 -o /dev/null -w '%{http_code}' "$@"; }
md5() { printf '%s' "$1" | md5sum | cut -d' ' -f1; }
expect() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected [$2] got [$3]"; FAILS=$((FAILS+1)); fi; }
skip() { echo "skip $1 (no private LAN address)"; SKIPS=$((SKIPS+1)); }
start() {
  (cd "$SERVER" && exec env -u NODE_OPTIONS -u NODE_PATH -u KNOWLIFY_TRUST_PROXY HOST=0.0.0.0 PORT="$PORT" KNOWLIFY_NETWORK_GUARD=lan \
    KNOWLIFY_FORCE_ENV_PASSWORD=1 KNOWLIFY_USER="$USERNAME" KNOWLIFY_PASSWORD="$PASSWORD" KNOWLIFY_DATA="$E2E_DIR/data" \
    KNOWLIFY_WEB_DIR="$SERVER/web" KNOWLIFY_SCAN_INTERVAL=0 KNOWLIFY_MCP=off KNOWLIFY_METADATA_LOOKUP=off KNOWLIFY_LOG_LEVEL=trace \
    "$NODE_BIN" dist/index.js >"$LOG" 2>&1) &
  echo $! >"$PIDFILE"
  for _ in $(seq 1 60); do sleep 1; curl -s -m 1 -H "Host: $LO" "$LO/health" >/dev/null && return 0; done
  echo "server did not start (see $LOG)"; exit 2
}
stop() { [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null; for _ in $(seq 1 20); do kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null || break; sleep 0.5; done; }
trap 'stop' EXIT

echo "peer paths: loopback=$LO lan=${LAN:-none}"
start
for path in lo lan; do
  if [ "$path" = lo ]; then H="$LO"; else [ -z "$LAN" ] && { for n in health host origin xff auth html opds kosync admin; do skip "[lan] $n"; done; continue; }; H="$LAN"; fi
  T="[$path]"
  expect "$T /health under the guard" 200 "$(code "http://$H/health")"
  expect "$T forged Host (public name) refused" 403 "$(code -H 'Host: evil.example' "http://$H/health")"
  expect "$T forged Host (public name) refused on /api" 403 "$(code -u "$USERNAME:$PASSWORD" -H 'Host: evil.example' "http://$H/api/books")"
  expect "$T missing Host refused (HTTP/1.0)" 403 "$(code --http1.0 -H 'Host:' "http://$H/health")"
  expect "$T public Origin refused" 403 "$(code -u "$USERNAME:$PASSWORD" -H 'Origin: https://evil.example' "http://$H/api/books")"
  expect "$T local Origin accepted" 200 "$(code -u "$USERNAME:$PASSWORD" -H "Origin: http://$H" "http://$H/api/books")"
  expect "$T forged X-Forwarded-For has no effect (still 403 with a public Host)" 403 "$(code -H 'X-Forwarded-For: 127.0.0.1' -H 'Host: evil.example' "http://$H/health")"
  expect "$T forged X-Forwarded-For has no effect on the peer verdict (admin PUT: loopback passes the guard, LAN stays 403)" "$([ "$path" = lo ] && echo notforbidden || echo 403)" "$(c=$(code -u "$USERNAME:$PASSWORD" -H 'X-Forwarded-For: 127.0.0.1' -X PUT -H "$J" -d '{}' "http://$H/api/settings/chat"); [ "$path" = lo ] && { [ "$c" != 403 ] && echo notforbidden || echo "$c"; } || echo "$c")"
  expect "$T Basic with the share password" 200 "$(code -u "$USERNAME:$PASSWORD" "http://$H/api/books")"
  expect "$T Basic without credentials" 401 "$(code "http://$H/api/books")"
  expect "$T GET / serves the web HTML" "200 text/html; charset=utf-8" "$(curl -s -m 5 -o /dev/null -w '%{http_code} %{content_type}' "http://$H/")"
  expect "$T GET / body is the Knowlify web app" 1 "$(curl -s -m 5 "http://$H/" | grep -c '<div id="root"')"
  expect "$T /opds with the share password" 200 "$(code -u "$USERNAME:$PASSWORD" "http://$H/opds")"
  expect "$T /opds without credentials" 401 "$(code "http://$H/opds")"
  expect "$T KOSync auth with md5(share password)" 200 "$(code -H "x-auth-user:$USERNAME" -H "x-auth-key:$(md5 "$PASSWORD")" "http://$H/kosync/users/auth")"
  expect "$T KOSync auth with a wrong md5" 401 "$(code -H "x-auth-user:$USERNAME" -H "x-auth-key:$(md5 wrong)" "http://$H/kosync/users/auth")"
done

# Administration routes: loopback may, the LAN peer gets 403 {code: local_only}.
expect "[lo] GET /api/fs (loopback) allowed" 200 "$(code -u "$USERNAME:$PASSWORD" "http://$LO/api/fs")"
expect "[lo] PUT /api/settings/chat (loopback) not blocked by the guard" notforbidden "$(c=$(code -u "$USERNAME:$PASSWORD" -X PUT -H "$J" -d '{"maxConversations":300}' "http://$LO/api/settings/chat"); [ "$c" != 403 ] && echo notforbidden || echo "$c")"
if [ -n "$LAN" ]; then
  for r in "GET /api/fs" "POST /api/sources" "PUT /api/settings/chat" "POST /api/mcp/tokens" "PUT /api/account/password"; do
    m="${r% *}"; p="${r#* }"
    body="$(curl -s -m 5 -u "$USERNAME:$PASSWORD" -X "$m" -H "$J" -d '{}' -w ' [%{http_code}]' "http://$LAN$p")"
    expect "[lan] $r -> 403 local_only" '"local_only" [403]' "$(jq -c .code <<<"${body% \[*}" 2>/dev/null) [${body##* \[}"
  done
  expect "[lan] reads of settings stay allowed" 200 "$(code -u "$USERNAME:$PASSWORD" "http://$LAN/api/settings/chat")"
  expect "[lan] admin route does not leak a 401 before the guard (no credentials)" 403 "$(code -X PUT -H "$J" -d '{}' "http://$LAN/api/settings/chat")"
else skip "[lan] administration routes"; fi

# Wrong password: 401, then 429 after 10 failures from the same peer (the window is fixed at 60 s).
for path in lo lan; do
  [ "$path" = lan ] && [ -z "$LAN" ] && { skip "[lan] rate limit"; continue; }
  H="$LO"; [ "$path" = lan ] && H="$LAN"
  expect "[$path] wrong password -> 401" 401 "$(code -u "$USERNAME:wrong-1" "http://$H/api/books")"
  for _ in $(seq 1 9); do code -u "$USERNAME:wrong-n" "http://$H/api/books" >/dev/null; done
  expect "[$path] 11th failure -> 429" 429 "$(code -u "$USERNAME:wrong-2" "http://$H/api/books")"
  expect "[$path] even the right password is blocked meanwhile" 429 "$(code -u "$USERNAME:$PASSWORD" "http://$H/api/books")"
  expect "[$path] 429 carries Retry-After" 1 "$(curl -s -m 5 -D - -o /dev/null -u "$USERNAME:$PASSWORD" "http://$H/api/books" | grep -ci '^retry-after:')"
  expect "[$path] KOSync is limited too" 429 "$(code -H "x-auth-user:$USERNAME" -H "x-auth-key:$(md5 "$PASSWORD")" "http://$H/kosync/users/auth")"
done
echo "waiting 62 s for the limiter window to expire"; sleep 62
expect "[lo] recovery after the window" 200 "$(code -u "$USERNAME:$PASSWORD" "http://$LO/api/books")"
[ -n "$LAN" ] && expect "[lan] recovery after the window" 200 "$(code -u "$USERNAME:$PASSWORD" "http://$LAN/api/books")"

# Logs: no password, Host, Origin or forged header values.
expect "no share password, forged Host or Origin in the log" 0 "$(grep -c "$PASSWORD\|evil.example\|x-forwarded" "$LOG" 2>/dev/null)"

# SIGTERM without orphans.
PID="$(cat "$PIDFILE")"; kill -TERM "$PID"; for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
expect "SIGTERM stops the server" gone "$(kill -0 "$PID" 2>/dev/null && echo alive || echo gone)"
expect "nothing listens on the port afterwards" 0 "$(ss -ltn | grep -c ":$PORT ")"
expect "no orphan knowlify-node process" 0 "$(pgrep -fc "knowlify-node-.* dist/index.js")"
rm -f "$PIDFILE"
echo; [ "$SKIPS" -gt 0 ] && echo "$SKIPS check(s) skipped"
[ "$FAILS" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "$FAILS CHECK(S) FAILED"; exit "$FAILS"
