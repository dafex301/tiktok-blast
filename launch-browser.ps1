# launch-browser.ps1 — launch a debug Chrome for discover.mjs / blast.mjs (Windows).
#
# Uses a repo-local, gitignored profile dir (.discover-profile) so each machine
# keeps its own TikTok login and no cookies ever get committed. First run on a
# machine: log into TikTok once in the window that opens — the session persists.
#
#   powershell -ExecutionPolicy Bypass -File launch-browser.ps1          # port 9223
#   powershell -ExecutionPolicy Bypass -File launch-browser.ps1 -Port 9222
#
# Leave the window open while the scripts run.

param([int]$Port = 9223)

$Dir = Join-Path $PSScriptRoot ".discover-profile"
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) {
  Write-Error "Could not find chrome.exe. Install Google Chrome, or edit this script with its path."
  exit 1
}

Write-Host "Launching debug Chrome on port $Port"
Write-Host "  profile: $Dir"
Write-Host "  -> if TikTok isn't logged in, log in once in the window that opens."

& $chrome --remote-debugging-port=$Port --user-data-dir="$Dir" `
  --no-first-run --no-default-browser-check "https://www.tiktok.com"
