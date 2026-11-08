#!/usr/bin/env bash
# Starts a throwaway local worker (fresh database), runs the integration test, stops the worker.
set -e
cd "$(dirname "$0")/.."
pkill -f "wrangler dev" 2>/dev/null || true
rm -rf .wrangler/state
printf 'INVITE_CODE=testcode\nADMIN_CODE=adminpass\n' > .dev.vars
npx wrangler d1 execute bandbook --local --file=worker/schema.sql >/dev/null
npx wrangler dev --local --port 8787 > /tmp/bandbook-dev.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; pkill -f "wrangler dev" 2>/dev/null || true' EXIT
for i in $(seq 1 40); do curl -sf localhost:8787/api/health >/dev/null && break; sleep 1; done
node tests-integration/server.test.mjs
