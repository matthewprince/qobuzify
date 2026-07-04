# Qobuzify one-line installer for Windows.
#   irm https://qobuzify.app/install.ps1 | iex
# Downloads Qobuzify, installs it into the Qobuz desktop app, and relaunches Qobuz.
# Zero dependencies beyond Node.js. Fully reversible (qobuzify restore).

$ErrorActionPreference = "Stop"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

Write-Host ""
Write-Host "  Qobuzify " -ForegroundColor Cyan -NoNewline
Write-Host "- Spicetify, but for Qobuz" -ForegroundColor DarkGray
Write-Host ""

# Node.js is the only requirement.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js (v16+) is required and was not found." -ForegroundColor Yellow
  Write-Host "Install it from https://nodejs.org, then run this command again." -ForegroundColor Yellow
  return
}

$dir = Join-Path $env:LOCALAPPDATA "Qobuzify"
$zip = Join-Path $env:TEMP ("qobuzify-" + [guid]::NewGuid().ToString().Substring(0, 8) + ".zip")

Write-Host "Downloading Qobuzify..." -ForegroundColor DarkGray
Invoke-WebRequest -Uri "https://qobuzify.app/qobuzify.zip" -OutFile $zip -UseBasicParsing

Write-Host "Installing to $dir" -ForegroundColor DarkGray
# On an update (dir already there), keep the local-only lyric credentials the extract would wipe.
$keep = @(".spotify-creds.json", ".spotify-user-token.json", ".apple-creds.json")
$stash = $null
if (Test-Path $dir) {
  $stash = Join-Path $env:TEMP ("qobuzify-keep-" + [guid]::NewGuid().ToString().Substring(0, 8))
  New-Item -ItemType Directory -Path $stash -Force | Out-Null
  foreach ($f in $keep) { $s = Join-Path $dir $f; if (Test-Path $s) { Copy-Item $s (Join-Path $stash $f) -Force } }
  Remove-Item $dir -Recurse -Force
}
Expand-Archive -Path $zip -DestinationPath $dir -Force
Remove-Item $zip -Force -ErrorAction SilentlyContinue
if ($stash) {
  foreach ($f in $keep) { $s = Join-Path $stash $f; if (Test-Path $s) { Copy-Item $s (Join-Path $dir $f) -Force } }
  Remove-Item $stash -Recurse -Force -ErrorAction SilentlyContinue
}

# Patch the Qobuz app and relaunch it.
Push-Location $dir
try { & node "bin/qobuzify.js" install } finally { Pop-Location }

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "In Qobuz: click your avatar (top-right) then Marketplace to switch themes and toggle extensions." -ForegroundColor Gray
Write-Host ("To undo it all later:  node `"" + (Join-Path $dir 'bin\qobuzify.js') + "`" restore") -ForegroundColor DarkGray
Write-Host ""
