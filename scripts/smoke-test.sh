#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
ENV_EXAMPLE="$BACKEND_DIR/.env.example"
PORT="3001"
SERVER_PID=""
SMOKE_DB_DIR=""
LOG_FILE="${TMPDIR:-/tmp}/budget-automation-smoke-test.log"
FAILURES=0

pass() {
  printf 'PASS %s\n' "$1"
}

fail() {
  printf 'FAIL %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi

  if [[ -n "$SMOKE_DB_DIR" && -d "$SMOKE_DB_DIR" ]]; then
    rm -rf "$SMOKE_DB_DIR"
  fi
}
trap cleanup EXIT

if [[ -f "$ENV_EXAMPLE" ]]; then
  PORT_FROM_EXAMPLE="$(
    awk -F= '/^[[:space:]]*PORT=/{print $2; exit}' "$ENV_EXAMPLE" \
      | tr -d '\r' \
      | tr -d '"' \
      | tr -d "'"
  )"
  PORT_FROM_EXAMPLE="${PORT_FROM_EXAMPLE%%#*}"
  PORT_FROM_EXAMPLE="$(printf '%s' "$PORT_FROM_EXAMPLE" | xargs)"

  if [[ -n "$PORT_FROM_EXAMPLE" ]]; then
    PORT="$PORT_FROM_EXAMPLE"
  fi
fi

if [[ -d "$BACKEND_DIR/node_modules" ]]; then
  pass "node_modules exists"
else
  printf 'node_modules missing, running npm install in backend...\n'
  if (cd "$BACKEND_DIR" && npm install); then
    pass "node_modules installed"
  else
    fail "npm install failed"
    exit 1
  fi
fi

if (cd "$BACKEND_DIR" && npx tsc --noEmit); then
  pass "TypeScript compiles"
else
  fail "TypeScript compilation failed"
  exit 1
fi

SMOKE_DB_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t budget-automation-smoke)"
SMOKE_DB_PATH="$SMOKE_DB_DIR/budget_automation.db"

(
  cd "$BACKEND_DIR" &&
    PORT="$PORT" DATABASE_PATH="$SMOKE_DB_PATH" npm run dev >"$LOG_FILE" 2>&1
) &
SERVER_PID=$!

sleep 5

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  fail "server process exited before health check"
  if [[ -f "$LOG_FILE" ]]; then
    tail -n 40 "$LOG_FILE"
  fi
  exit 1
fi

HEALTH_OK=0
for HEALTH_PATH in "/health" "/api/health"; do
  HEALTH_URL="http://localhost:${PORT}${HEALTH_PATH}"
  if curl -fsS "$HEALTH_URL" 2>/dev/null | grep -q '"status":"ok"'; then
    pass "server health check (${HEALTH_PATH})"
    HEALTH_OK=1
    break
  fi
done

if [[ "$HEALTH_OK" -ne 1 ]]; then
  fail "server health check failed on port ${PORT}"
  if [[ -f "$LOG_FILE" ]]; then
    tail -n 40 "$LOG_FILE"
  fi
fi

if [[ "$FAILURES" -eq 0 ]]; then
  exit 0
fi

exit 1
