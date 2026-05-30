#!/usr/bin/env bash
# Launch a debug Chrome for discover.mjs / blast.mjs to drive over CDP.
#
# Uses a repo-local, gitignored profile dir (.discover-profile) so each machine
# keeps its own TikTok login and no cookies ever get committed. First run on a
# machine: log into TikTok once in the window that opens — the session persists.
#
#   ./launch-browser.sh            # port 9223 (discover.mjs default)
#   ./launch-browser.sh 9222       # custom port (e.g. for blast.mjs)
#
# Leave the window open while the scripts run.

set -euo pipefail
PORT="${1:-9223}"
DIR="$(cd "$(dirname "$0")" && pwd)/.discover-profile"

# Find the Chrome binary for this OS.
case "$(uname -s)" in
  Darwin) CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ;;
  Linux)  CHROME="$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || true)" ;;
  *)      CHROME="" ;;
esac

if [ -z "${CHROME}" ] || { [ "$(uname -s)" = "Darwin" ] && [ ! -x "${CHROME}" ]; }; then
  echo "Could not find Google Chrome automatically."
  echo "On Windows, use the PowerShell launcher instead, then log into TikTok:"
  echo "  powershell -ExecutionPolicy Bypass -File launch-browser.ps1"
  exit 1
fi

echo "Launching debug Chrome on port ${PORT}"
echo "  profile: ${DIR}"
echo "  -> if TikTok isn't logged in, log in once in the window that opens."

"${CHROME}" \
  --remote-debugging-port="${PORT}" \
  --user-data-dir="${DIR}" \
  --no-first-run --no-default-browser-check \
  "https://www.tiktok.com" >/dev/null 2>&1 &

sleep 4
if curl -s "http://localhost:${PORT}/json/version" >/dev/null 2>&1; then
  echo "Debug Chrome is up on port ${PORT}. You can now run: node discover.mjs \"#reviewbuku\""
else
  echo "Chrome launched but CDP isn't responding yet on ${PORT} — give it a few seconds and check the window."
fi
