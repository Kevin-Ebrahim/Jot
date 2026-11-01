#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
port="${JOT_TEST_PORT:-3129}"
data_dir="$(mktemp -d "${TMPDIR:-/tmp}/jot-offline-qa.XXXXXX")"
log="$data_dir/server.log"
server=''
cleanup() {
  if [[ -n "$server" ]]; then kill "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true; fi
  rm -rf "$data_dir"
}
trap cleanup EXIT
npm run build
JOT_DATA_DIR="$data_dir" node_modules/.bin/next start --hostname 127.0.0.1 --port "$port" >"$log" 2>&1 &
server=$!
ready=''
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$port/" >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$server" 2>/dev/null; then cat "$log"; exit 1; fi
  sleep .5
done
if [[ -z "$ready" ]]; then cat "$log"; echo 'Local production server did not start.' >&2; exit 1; fi
JOT_TEST_URL="http://127.0.0.1:$port" node tests/offline-production.mjs
