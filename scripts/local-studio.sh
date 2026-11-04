#!/usr/bin/env bash
# A throwaway Blygger Studio on this machine, for the plugin's end-to-end test (tests/e2e/studio.e2e.test.ts) and for trying the
# client by hand. Written for a Claude Code cloud session; it needs nothing but the tools listed under "Needs".
#
#   scripts/local-studio.sh start [DIR]   download + verify the pinned release, migrate a fresh local database, start it on :8787,
#                                          mint a REST token, print the two environment variables the e2e test needs
#   WITH_REMOTE=1 scripts/local-studio.sh start [DIR]
#                                          also start a second Studio on :8788 (DIR-remote), publish one fragment there and subscribe the
#                                          first Studio to it, so the first holds an imported item (what "Insert quote" lists from a blyg
#                                          you read); takes about a minute longer
#   scripts/local-studio.sh stop           stops both
#
# Needs: node, npx, curl, tar, python3 (JSON). Nothing here is a secret: the password and cookie secret are made up for this run, the
# Studios listen on localhost only, and the token it prints is valid for this local database only.
set -euo pipefail

# Default: the pinned release in tests/e2e/studio-pin.env (the one the plugin speaks: Studio 0.51.0, API contract 5.2.0 since M1/S16). Override both to test another
# release, e.g. a contract-4 Studio (the plugin refuses to write to those; only useful for the version-gate check):
#   STUDIO_VERSION=0.49.1 STUDIO_SHA256=07174bee74ce7b15d7668593cf3d14b1cf807c69d4d90fbddb7804b0b092fc3e scripts/local-studio.sh start
# or only STUDIO_VERSION=<x.y.z>: the checksum is then read from that release's own SHA256SUMS (integrity of the download, not provenance:
# the checksum comes from the same place as the file). The newest-release leg of CI uses this.
PIN_FILE="$(dirname "$0")/../tests/e2e/studio-pin.env"
if [ -f "$PIN_FILE" ]; then PIN_VERSION="$(sed -n 's/^STUDIO_VERSION=//p' "$PIN_FILE")"; PIN_SHA="$(sed -n 's/^STUDIO_SHA256=//p' "$PIN_FILE")"; fi
VERSION="${STUDIO_VERSION:-${PIN_VERSION:-0.51.0}}"
if [ -n "${STUDIO_SHA256:-}" ]; then
  SHA256="$STUDIO_SHA256"
elif [ "$VERSION" = "${PIN_VERSION:-}" ]; then
  SHA256="$PIN_SHA"
else
  SHA256="$(curl -fsSL "https://github.com/blygger/blygger-studio/releases/download/v$VERSION/SHA256SUMS" | awk -v f="blygger-worker-$VERSION.tar.gz" '$2 == f { print $1 }')"
  [ -n "$SHA256" ] || { echo "no checksum for blygger-worker-$VERSION.tar.gz in the release's SHA256SUMS" >&2; exit 1; }
fi
WRANGLER="wrangler@4.151.1"
PORT=8787
REMOTE_PORT=8788
PASSWORD="local-test-password-123"
DIR="${2:-${TMPDIR:-/tmp}/blyg-dev-local-studio}"
REMOTE_DIR="$DIR-remote"
# wrangler watches the Worker folder and rebuilds on any change in it, so the log, the pid and the cookies live beside it, not in it.
STATE="$DIR.state"
REMOTE_STATE="$REMOTE_DIR.state"
export NO_PROXY="localhost,127.0.0.1" no_proxy="localhost,127.0.0.1"   # the sandbox proxy would otherwise swallow localhost

# stop_one STATE: npx starts wrangler, which starts workerd: they were started as one process group, which is stopped as a whole
stop_one() {
  if [ -f "$1/wrangler.pid" ]; then kill -- "-$(cat "$1/wrangler.pid")" 2>/dev/null || true; rm -f "$1/wrangler.pid"; fi
}

# boot_one DIR STATE PORT: unpack (once), migrate a fresh database, start, wait until it answers
boot_one() {
  local dir="$1" state="$2" port="$3"
  mkdir -p "$dir" "$state"
  if [ ! -f "$dir/worker.js" ]; then
    # Unpacked beside, not inside, the worker folder: wrangler would take every file below it for a module of the Worker.
    local tmp
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/worker.tgz" "https://github.com/blygger/blygger-studio/releases/download/v$VERSION/blygger-worker-$VERSION.tar.gz"
    echo "$SHA256  $tmp/worker.tgz" | sha256sum -c - >&2
    tar -xzf "$tmp/worker.tgz" -C "$tmp"
    cp -r "$tmp/blygger-worker-$VERSION/." "$dir/"
    rm -rf "$tmp"
  fi
  (
    cd "$dir"
    printf 'OWNER_PASSWORD=%s\nCOOKIE_SECRET=%s\n' "$PASSWORD" "$(head -c 48 /dev/urandom | base64 | tr -d '\n=+/')" > .dev.vars
    rm -rf .wrangler
    npx --yes "$WRANGLER" d1 migrations apply DB --local >&2
    setsid nohup npx --yes "$WRANGLER" dev --port "$port" --var ALLOW_PRIVATE_FETCH:true > "$state/wrangler.log" 2>&1 &
    echo $! > "$state/wrangler.pid"
  )
  for _ in $(seq 1 60); do curl -fsS --noproxy '*' "http://localhost:$port/blyg.json" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS --noproxy '*' "http://localhost:$port/blyg.json" >/dev/null
}

# login STATE PORT: the owner cookie in STATE/cookies.txt (only the cookie can mint tokens and manage subscriptions)
login() {
  curl -sS --noproxy '*' -c "$1/cookies.txt" -o /dev/null -X POST "http://localhost:$2/studio/login" -H "Origin: http://localhost:$2" --data-urlencode "password=$PASSWORD"
}

# mint STATE PORT: a REST token with the owner scopes the plugin uses (owner:manage for hoppers, S13), printed
mint() {
  login "$1" "$2"
  curl -fsS --noproxy '*' -b "$1/cookies.txt" -X POST "http://localhost:$2/api/authorizations" -H "Origin: http://localhost:$2" -H 'content-type: application/json' \
    -d '{"name":"blyg-dev e2e","resource":"api","scope":["owner:read","owner:draft","owner:publish","owner:manage"]}' | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("accessToken") or d["access_token"])'
}

case "${1:-}" in
  stop)
    stop_one "$STATE"
    stop_one "$REMOTE_STATE"
    echo "stopped"
    ;;
  start)
    boot_one "$DIR" "$STATE" "$PORT"
    TOKEN="$(mint "$STATE" "$PORT")"
    if [ "${WITH_REMOTE:-}" = "1" ]; then
      boot_one "$REMOTE_DIR" "$REMOTE_STATE" "$REMOTE_PORT"
      REMOTE_TOKEN="$(mint "$REMOTE_STATE" "$REMOTE_PORT")"
      REMOTE_BODY='{"mode":"blank","kind":"fragment","contentMd":"A remote fragment from a blyg you read. It has a quotable sentence. And another one."}'
      CREATED="$(curl -fsS --noproxy '*' -X POST "http://localhost:$REMOTE_PORT/api/items" -H "Authorization: Bearer $REMOTE_TOKEN" -H 'content-type: application/json' -d "$REMOTE_BODY")"
      REMOTE_ID="$(echo "$CREATED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
      REMOTE_REV="$(echo "$CREATED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["revision"])')"
      curl -fsS --noproxy '*' -o /dev/null -X POST "http://localhost:$REMOTE_PORT/api/items/$REMOTE_ID/publish" -H "Authorization: Bearer $REMOTE_TOKEN" -H 'content-type: application/json' -d "{\"expectedRevision\":$REMOTE_REV}"
      # The first Studio subscribes to the second (owner cookie: a bearer token cannot manage subscriptions) and polls until it has imported it.
      JSON='content-type: application/json'
      curl -fsS --noproxy '*' -b "$STATE/cookies.txt" -o /dev/null -X POST "http://localhost:$PORT/api/subscriptions" -H "Origin: http://localhost:$PORT" -H "$JSON" \
        -d "{\"url\":\"http://localhost:$REMOTE_PORT/\",\"confirm\":true,\"title\":\"Blog B\"}"
      for _ in $(seq 1 20); do
        total="$(curl -fsS --noproxy '*' "http://localhost:$PORT/api/search?source=imported&limit=1" -H "Authorization: Bearer $TOKEN" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["items"]))')"
        [ "$total" != "0" ] && break
        curl -sS --noproxy '*' -b "$STATE/cookies.txt" -o /dev/null -X POST "http://localhost:$PORT/api/subscriptions/poll" -H "Origin: http://localhost:$PORT" -H "$JSON" -d '{}' || true
        sleep 3
      done
      [ "${total:-0}" != "0" ] || { echo "the first Studio did not import the remote item" >&2; exit 1; }
      rm -f "$REMOTE_STATE/cookies.txt"
    fi
    rm -f "$STATE/cookies.txt"
    echo "export STUDIO_E2E_URL=http://localhost:$PORT"
    echo "export STUDIO_E2E_TOKEN=$TOKEN"
    ;;
  *)
    echo "usage: $0 start [DIR] | stop    (WITH_REMOTE=1 for a second Studio and an imported item)" >&2
    exit 2
    ;;
esac
