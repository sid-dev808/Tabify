#!/usr/bin/env bash
#
# Tabify — start both servers with one command.
#
#   ./start_script.sh              start backend + frontend
#   ./start_script.sh --backend    backend only
#   ./start_script.sh --frontend   frontend only
#   ./start_script.sh --install    (re)install dependencies first
#
# Ctrl-C stops everything it started.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"

BACKEND_PORT="${PORT:-2000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

# ─── pretty output ───
if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; X=$'\033[0m'
else
  B=""; DIM=""; R=""; G=""; Y=""; C=""; X=""
fi
say()  { printf "%s\n" "$*"; }
ok()   { printf "  ${G}✓${X} %s\n" "$*"; }
warn() { printf "  ${Y}!${X} %s\n" "$*"; }
die()  { printf "\n  ${R}✗ %s${X}\n\n" "$*" >&2; exit 1; }

WANT_BACKEND=1
WANT_FRONTEND=1
DO_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --backend)  WANT_FRONTEND=0 ;;
    --frontend) WANT_BACKEND=0 ;;
    --install)  DO_INSTALL=1 ;;
    -h|--help)  sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $arg (try --help)" ;;
  esac
done

# ─── shut everything down together ───
PIDS=()
cleanup() {
  printf "\n${DIM}Shutting down…${X}\n"
  for pid in "${PIDS[@]:-}"; do
    [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null
  done
  for pid in "${PIDS[@]:-}"; do
    [ -n "${pid:-}" ] && wait "$pid" 2>/dev/null
  done
  printf "${DIM}Stopped.${X}\n"
}
trap cleanup EXIT INT TERM

port_busy() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1
  fi
}

say ""
say "${B}Tabify${X}"
say "${DIM}────────────────────────────────────────${X}"

# ─── backend ───
if [ "$WANT_BACKEND" = 1 ]; then
  [ -d backend ] || die "No backend/ directory here. Run this from the Tabify repo root."

  # Find an existing virtualenv, or make one. A venv copied between machines
  # (or between macOS and Linux) keeps its directory but its python symlink
  # dangles, so check that the interpreter actually runs rather than that the
  # folder exists.
  VENV=""
  UNUSABLE=""
  for candidate in backend/.godhelpme backend/.venv backend/venv; do
    if [ -x "$candidate/bin/python" ]; then
      VENV="$candidate"
      break
    elif [ -d "$candidate" ]; then
      UNUSABLE="$UNUSABLE $candidate"
    fi
  done

  if [ -z "$VENV" ]; then
    if [ -n "$UNUSABLE" ]; then
      warn "Found a virtualenv at$UNUSABLE, but its python won't run on this machine."
      warn "That usually means it was built elsewhere (another OS, or a moved folder)."
      warn "Delete it and re-run with --install to rebuild."
    fi
    warn "Creating backend/.venv (first run takes a few minutes)"
    if ! python3 -m venv backend/.venv; then
      rm -rf backend/.venv 2>/dev/null
      die "Couldn't create a virtualenv. Install python3 with venv support (macOS: brew install python@3.11), then run ./start_script.sh --install"
    fi
    VENV="backend/.venv"
    DO_INSTALL=1
  fi
  PY="$ROOT/$VENV/bin/python"

  if [ "$DO_INSTALL" = 1 ]; then
    say "  Installing backend dependencies…"
    "$PY" -m pip install --quiet --upgrade pip
    "$PY" -m pip install --quiet -r backend/requirements.txt || die "Backend dependency install failed."
    ok "backend dependencies installed"
  elif ! "$PY" -c "import flask" 2>/dev/null; then
    die "Backend dependencies are missing. Run: ./start_script.sh --install"
  fi

  if port_busy "$BACKEND_PORT"; then
    die "Port $BACKEND_PORT is already in use. Stop the other server, or run PORT=2001 ./start_script.sh"
  fi

  ok "using $VENV"
  say "  ${DIM}starting backend on :$BACKEND_PORT …${X}"
  ( cd backend && PORT="$BACKEND_PORT" exec "$PY" app.py ) &
  PIDS+=($!)

  # Wait for /api/health rather than guessing — the audio stack is slow to import.
  say "  ${DIM}waiting for the transcription model to load (can take ~30s)…${X}"
  READY=0
  for _ in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:$BACKEND_PORT/api/health" >/dev/null 2>&1; then READY=1; break; fi
    if ! kill -0 "${PIDS[-1]}" 2>/dev/null; then die "Backend exited during startup — scroll up for the error."; fi
    sleep 1
  done
  if [ "$READY" = 1 ]; then
    AUTH=$(curl -fsS "http://127.0.0.1:$BACKEND_PORT/api/health" 2>/dev/null | grep -o '"auth_required":[a-z]*' | cut -d: -f2)
    ok "backend ready at ${C}http://127.0.0.1:$BACKEND_PORT${X}"
    [ "$AUTH" = "true" ] && say "    ${DIM}token verification ON${X}" || say "    ${DIM}token verification off (no service account set — fine for local dev)${X}"
  else
    warn "backend didn't answer in 90s — starting the frontend anyway"
  fi
fi

# ─── frontend ───
if [ "$WANT_FRONTEND" = 1 ]; then
  [ -d frontend ] || die "No frontend/ directory here. Run this from the Tabify repo root."

  if [ ! -f frontend/.env.local ]; then
    warn "frontend/.env.local is missing — the app will show its setup screen"
    warn "copy frontend/.env.example to frontend/.env.local and add your Firebase keys (see SETUP.md)"
  elif ! grep -qE '^VITE_FIREBASE_API_KEY=.+' frontend/.env.local; then
    warn "VITE_FIREBASE_API_KEY looks empty in frontend/.env.local (see SETUP.md)"
  fi

  if [ "$DO_INSTALL" = 1 ] || [ ! -d frontend/node_modules ]; then
    say "  Installing frontend dependencies…"
    ( cd frontend && npm install --no-audit --no-fund ) || die "npm install failed."
    ok "frontend dependencies installed"
  fi

  if port_busy "$FRONTEND_PORT"; then
    die "Port $FRONTEND_PORT is already in use. Stop the other dev server, or run FRONTEND_PORT=5174 ./start_script.sh"
  fi

  say "  ${DIM}starting frontend on :$FRONTEND_PORT …${X}"
  ( cd frontend && exec npx vite --port "$FRONTEND_PORT" --strictPort ) &
  PIDS+=($!)
  sleep 2
  ok "frontend at ${C}http://localhost:$FRONTEND_PORT${X}"
fi

say "${DIM}────────────────────────────────────────${X}"
say "  ${B}Open ${C}http://localhost:$FRONTEND_PORT${X}"
say "  ${DIM}Ctrl-C to stop everything.${X}"
say ""

wait
