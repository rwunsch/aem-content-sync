#!/usr/bin/env bash
#
# dev-ui.sh — run the Content Sync UI locally and open it in the Experience
# Cloud shell, which injects your Adobe sign-in (IMS) token so the secured
# backend actions work (no 401).
#
# Why this is the right way to operate the UI:
#   * The deployed STAGE workspace runs the SECURED actions + the scheduler
#     24/7 in Adobe's cloud — that's the engine, and it requires a valid token
#     from your org (anonymous callers get 401; the orchestrator has no public
#     URL at all).
#   * The UI is run from YOUR machine. The shell hands a *localhost* dev app
#     your token, so the gated actions accept its calls. Nothing about the UI
#     is exposed publicly this way.
#
# The deployed-static "?devMode=true&localDevUrl=https://...adobeio-static.net"
# URL does NOT get a token (the shell only does the token handshake with a
# localhost dev app), which is why that path shows "401 missing authorization
# header". Use THIS script instead.
#
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-9080}"
LOCAL_URL="https://localhost:${PORT}"
SHELL_URL="https://experience.adobe.com/?devMode=true#/custom-apps/?localDevUrl=${LOCAL_URL}"
LOG="/tmp/aio-app-run.log"
CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"

cd "$APP_DIR"

is_up() { curl -sk --max-time 4 "${LOCAL_URL}/index.html" -o /dev/null; }

if is_up; then
  echo "✓ Dev server already running at ${LOCAL_URL}"
else
  echo "Starting local dev server (aio app run --no-actions)…"
  rm -f "$LOG"
  nohup ./node_modules/.bin/aio app run --no-actions > "$LOG" 2>&1 &
  echo "  pid $! — logging to $LOG"
  printf "  waiting for %s " "$LOCAL_URL"
  for _ in $(seq 1 60); do
    if is_up; then echo " ✓ up"; break; fi
    printf "."; sleep 2
  done
  if ! is_up; then
    echo
    echo "✗ Dev server did not come up in time. Last log lines:"
    tail -20 "$LOG"
    exit 1
  fi
fi

# Open Windows Chrome (WSL2): first the raw localhost URL so you can accept the
# self-signed dev cert ONCE (click Advanced → Proceed to localhost), then the
# Experience Cloud shell pointed at the local server.
if [[ -x "$CHROME" ]]; then
  echo "Opening Chrome…"
  "$CHROME" "$LOCAL_URL"  >/dev/null 2>&1 &
  sleep 2
  "$CHROME" "$SHELL_URL"  >/dev/null 2>&1 &
else
  echo "(Chrome not found at: $CHROME — open the URLs below manually.)"
fi

cat <<EOF

Open these if they didn't open automatically:
  1. ${LOCAL_URL}
       ↳ first time only: accept the self-signed cert (Advanced → Proceed)
  2. ${SHELL_URL}
       ↳ this is the one you use — it injects your sign-in token

Stop the dev server with:  pkill -f 'aio app run'
EOF
