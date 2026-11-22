#!/usr/bin/env bash
# End-to-end check of the password change against real server processes.
# Needs: node (with tsx via the workspace), curl, jq, md5sum. Uses a temporary data dir and PORT (default 8814).
# Exit code 0 only if every check passes.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8814}"; B="localhost:$PORT"; J='content-type: application/json'
D="$(mktemp -d)"; LOG="$D/server.log"; FAILS=0
[ -s "$HOME/.nvm/nvm.sh" ] && { . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; nvm use 26 >/dev/null 2>&1 || true; }

start() { (cd "$ROOT/apps/server" && env KNOWLIFY_DATA="$D/data" PORT="$PORT" KNOWLIFY_USER=admin KNOWLIFY_PASSWORD=initial-pass-1 KNOWLIFY_SCAN_INTERVAL=0 "$@" nohup npx tsx src/index.ts >>"$LOG" 2>&1 &)
  for _ in $(seq 1 30); do sleep 1; curl -s -m 1 "$B/health" >/dev/null && return 0; done; echo "server did not start (see $LOG)"; exit 2; }
stop() { local pid; pid=$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1); [ -n "$pid" ] && kill "$pid"; sleep 1; }
trap 'stop; rm -rf "$D"' EXIT
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
md5() { printf '%s' "$1" | md5sum | cut -d' ' -f1; }
put() { curl -s -u "$1" -X PUT -H "$J" -d "$2" -w ' [%{http_code}]' "$B/api/account/password"; }
expect() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected [$2] got [$3]"; FAILS=$((FAILS+1)); fi; }
status_of() { sed -n 's/.*\[\([0-9]*\)\]$/\1/p' <<<"$1"; }

start
expect "account (env password)" '{"user":"admin","canChangePassword":true,"passwordSource":"env"}' "$(curl -s -u admin:initial-pass-1 "$B/api/account")"
expect "account needs auth" 401 "$(code "$B/api/account")"
expect "wrong current -> 403 (never 401)" 403 "$(status_of "$(put admin:initial-pass-1 '{"current":"nope","next":"new-pass-2222"}')")"
expect "too short -> 400" 400 "$(status_of "$(put admin:initial-pass-1 '{"current":"initial-pass-1","next":"short"}')")"
expect "same as current -> 400" 400 "$(status_of "$(put admin:initial-pass-1 '{"current":"initial-pass-1","next":"initial-pass-1"}')")"
expect "control char -> 400" 400 "$(status_of "$(put admin:initial-pass-1 '{"current":"initial-pass-1","next":"abcdefgh\u0007ij"}')")"
expect "missing field -> 400" 400 "$(status_of "$(put admin:initial-pass-1 '{"current":"initial-pass-1"}')")"
expect "no auth -> 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "$J" -d '{"current":"a","next":"bbbbbbbb"}' "$B/api/account/password")"
expect "old password intact after rejections" 200 "$(code -u admin:initial-pass-1 "$B/api/books")"
expect "change succeeds -> 204" 204 "$(status_of "$(put admin:initial-pass-1 '{"current":"initial-pass-1","next":"new-pass-2222"}')")"
expect "old password dead on /api" 401 "$(code -u admin:initial-pass-1 "$B/api/books")"
expect "new password works on /api" 200 "$(code -u admin:new-pass-2222 "$B/api/books")"
expect "old password dead on /opds" 401 "$(code -u admin:initial-pass-1 "$B/opds")"
expect "new password works on /opds" 200 "$(code -u admin:new-pass-2222 "$B/opds")"
expect "kosync old md5 refused" 401 "$(code -H x-auth-user:admin -H "x-auth-key:$(md5 initial-pass-1)" "$B/kosync/users/auth")"
expect "kosync new md5 accepted" 200 "$(code -H x-auth-user:admin -H "x-auth-key:$(md5 new-pass-2222)" "$B/kosync/users/auth")"
expect "passwordSource is now user" '"user"' "$(curl -s -u admin:new-pass-2222 "$B/api/account" | jq -c .passwordSource)"
expect "no plaintext passwords in db or log" "0" "$(cat "$D"/data/* "$LOG" 2>/dev/null | grep -c 'new-pass-2222\|initial-pass-1')"
stop; start
expect "new password persists across restart" 200 "$(code -u admin:new-pass-2222 "$B/api/books")"
stop; start KNOWLIFY_FORCE_ENV_PASSWORD=1
expect "recovery: env password works again" 200 "$(code -u admin:initial-pass-1 "$B/api/books")"
expect "recovery: stored password refused" 401 "$(code -u admin:new-pass-2222 "$B/api/books")"
stop; rm -rf "$D/data"; start KNOWLIFY_ACCOUNT_LOCKED=1
expect "locked: canChangePassword false" 'false' "$(curl -s -u admin:initial-pass-1 "$B/api/account" | jq -c .canChangePassword)"
expect "locked: change refused -> 403" 403 "$(status_of "$(put admin:initial-pass-1 '{"current":"initial-pass-1","next":"another-pass-3"}')")"
stop; rm -rf "$D/data"; start
for i in 1 2 3 4 5; do put admin:initial-pass-1 '{"current":"bad","next":"zzzzzzzz1"}' >/dev/null; done
expect "rate limit: 6th wrong attempt -> 429" 429 "$(status_of "$(put admin:initial-pass-1 '{"current":"bad","next":"zzzzzzzz1"}')")"
expect "rate limit: even the right password is blocked" 429 "$(status_of "$(put admin:initial-pass-1 '{"current":"initial-pass-1","next":"zzzzzzzz1"}')")"
echo; [ "$FAILS" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "$FAILS CHECK(S) FAILED"; exit "$FAILS"
