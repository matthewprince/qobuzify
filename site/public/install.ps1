# Qobuzify one-line installer for Windows.
#   irm https://qobuzify.app/install.ps1 | iex
# Installs Qobuzify into the official Qobuz desktop app and relaunches Qobuz.
# ZERO dependencies: a portable Node runtime is bundled inside the download, so a system
# Node.js is NOT required. Fully reversible (qobuzify restore).

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # the IWR progress bar throttles downloads 10-50x; off = much faster
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

# SHA-256 of the qobuzify.zip this script is paired with. Embedded HERE (inside the TLS-delivered
# irm|iex script) rather than fetched as a sibling file, so it is a real tamper anchor: an attacker who
# swaps the zip on the origin cannot also swap this hash without breaking the signed TLS delivery.
# build-zip.ps1 rewrites this line on every build.
$ExpectedZipSha = "F447C3F586F6198D9B4B487895BC9D4A6EC1ED97E48BBCC10621F6FD920EDEA8"

Write-Host ""
Write-Host "  Qobuzify " -ForegroundColor Cyan -NoNewline
Write-Host "- Spicetify, but for Qobuz" -ForegroundColor DarkGray
Write-Host ""

# --- Pre-flight: the official Qobuz DESKTOP app must be present (we patch it in place) ---------------
# Do this BEFORE downloading anything, so a missing prerequisite fails fast with a clear fix instead of
# a cryptic error after the download.
function Find-QobuzDesktop {
  $root = Join-Path $env:LOCALAPPDATA "Qobuz"
  if (Test-Path $root) {
    $app = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -like "app-*" } |
           Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $launcher = Join-Path $root "Qobuz.exe"
    if ($app -and (Test-Path $launcher) -and (Test-Path (Join-Path $app.FullName "resources\app\app.html"))) {
      return @{ Ok = $true; Version = ($app.Name -replace '^app-', ''); Root = $root }
    }
  }
  return @{ Ok = $false }
}

$qz = Find-QobuzDesktop
if (-not $qz.Ok) {
  # Distinguish the un-patchable Microsoft Store / MSIX build from "not installed at all".
  $store = $null
  try { $store = Get-AppxPackage -Name "*Qobuz*" -ErrorAction SilentlyContinue | Select-Object -First 1 } catch {}
  Write-Host "The official Qobuz DESKTOP app wasn't found, and Qobuzify works by patching it." -ForegroundColor Yellow
  Write-Host ""
  if ($store) {
    Write-Host "You have the Microsoft Store version of Qobuz, which is sealed and cannot be patched." -ForegroundColor Yellow
    Write-Host "Uninstall it and install the desktop build from https://www.qobuz.com/download instead." -ForegroundColor Yellow
  } else {
    Write-Host "Install the Qobuz desktop app first:" -ForegroundColor Yellow
    Write-Host "  1. Get it from https://www.qobuz.com/download  (the desktop app, NOT the Store version)" -ForegroundColor Yellow
    Write-Host "  2. Launch Qobuz once so it finishes installing, then re-run this command." -ForegroundColor Yellow
    $ans = Read-Host "Open the Qobuz download page now? (y/N)"
    if ($ans -match '^(y|yes)$') { Start-Process "https://www.qobuz.com/download" }
  }
  Write-Host ""
  return
}
Write-Host ("Found Qobuz desktop " + $qz.Version + ".") -ForegroundColor DarkGray

# --- Notice if Qobuz is running (the patch step closes + relaunches it) ------------------------------
if (Get-Process -Name "Qobuz" -ErrorAction SilentlyContinue) {
  Write-Host "Qobuz is open - it will be closed and relaunched to apply the changes." -ForegroundColor DarkGray
}

# --- Download + integrity-verify ---------------------------------------------------------------------
$dir = Join-Path $env:LOCALAPPDATA "Qobuzify"
$zip = Join-Path $env:TEMP ("qobuzify-" + [guid]::NewGuid().ToString().Substring(0, 8) + ".zip")

Write-Host "Downloading Qobuzify..." -ForegroundColor DarkGray
Invoke-WebRequest -Uri "https://qobuzify.app/qobuzify.zip" -OutFile $zip -UseBasicParsing

if ($ExpectedZipSha -notmatch '^0+$') {
  $got = (Get-FileHash -Path $zip -Algorithm SHA256).Hash
  if ($got -ne $ExpectedZipSha) {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    throw "Download integrity check FAILED (sha256 mismatch). Expected $ExpectedZipSha, got $got. Aborting - do not run a tampered download."
  }
  Write-Host "Integrity verified." -ForegroundColor DarkGray
}

# --- Install (keep local-only lyric creds across an update) ------------------------------------------
Write-Host "Installing to $dir" -ForegroundColor DarkGray
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

# --- Node runtime: prefer the bundled portable node.exe (zero-dependency); fall back to a system Node -
function Resolve-Node($installDir) {
  $bundled = Join-Path $installDir "runtime\node\node.exe"
  if (Test-Path $bundled) { return $bundled }
  # Legacy fallback: a system Node (only reached if the bundle is somehow absent).
  if (Get-Command node -ErrorAction SilentlyContinue) { return "node" }
  try {
    $m = [Environment]::GetEnvironmentVariable("Path", "Machine"); $u = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = (@($m, $u) | Where-Object { $_ }) -join ";"
  } catch {}
  if (Get-Command node -ErrorAction SilentlyContinue) { return "node" }
  return $null
}
$node = Resolve-Node $dir
if (-not $node) {
  Write-Host "The bundled Node runtime is missing and no system Node was found - the download may be incomplete." -ForegroundColor Yellow
  Write-Host "Re-run the installer; if it persists, install Node LTS from https://nodejs.org and try again." -ForegroundColor Yellow
  return
}

# --- Patch the Qobuz app and relaunch it -------------------------------------------------------------
Push-Location $dir
try { & $node "bin/qobuzify.js" install } finally { Pop-Location }

# $ErrorActionPreference = "Stop" does NOT apply to native-command exit codes in Windows PowerShell 5.1,
# so check explicitly - otherwise a failed patch (locked app.html, shifted Squirrel layout) fell straight
# through to a green "Done." and success instructions for an install that never happened.
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "Install FAILED - see the error above. Qobuz was NOT patched." -ForegroundColor Red
  Write-Host "Close Qobuz fully and re-run the installer; if it keeps failing, report it at https://qobuzify.app" -ForegroundColor Yellow
  Write-Host ""
  return
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "In Qobuz: click your avatar (top-right) then Marketplace to switch themes and toggle extensions." -ForegroundColor Gray
Write-Host ("To undo it all later:  & `"" + (Join-Path $dir 'runtime\node\node.exe') + "`" `"" + (Join-Path $dir 'bin\qobuzify.js') + "`" restore") -ForegroundColor DarkGray
Write-Host ""
