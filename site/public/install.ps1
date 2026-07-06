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

# Node.js is the only requirement. A just-installed Node usually isn't on the PATH of an
# already-open PowerShell yet, so if the first check misses, reload PATH from the registry
# (and probe the default install dir) before giving up - saves people the confusing
# "not found" right after they installed it.
function Test-Node {
  if (Get-Command node -ErrorAction SilentlyContinue) { return $true }
  try {
    $m = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $u = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = (@($m, $u) | Where-Object { $_ }) -join ";"
  } catch {}
  if (Get-Command node -ErrorAction SilentlyContinue) { return $true }
  foreach ($b in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($b) {
      $d = Join-Path $b "nodejs"
      if (Test-Path (Join-Path $d "node.exe")) { $env:Path = "$d;$env:Path"; return $true }
    }
  }
  return $false
}

if (-not (Test-Node)) {
  Write-Host "Node.js (v16 or newer) is required and was not found." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  1. Install the LTS build from https://nodejs.org" -ForegroundColor Yellow
  Write-Host "  2. Close this window, open a NEW PowerShell, and run the command again." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "If you just installed Node and still see this, a fresh window is the fix:" -ForegroundColor DarkGray
  Write-Host "an already-open terminal doesn't pick up Node until it's reopened." -ForegroundColor DarkGray
  return
}

# Guard against an ancient Node that would only fail later with a cryptic error.
$nv = ""
try { $nv = (& node -v) } catch {}
if ($nv -match "v(\d+)" -and [int]$matches[1] -lt 16) {
  Write-Host "Found Node $nv, but Qobuzify needs v16 or newer. Update it from https://nodejs.org." -ForegroundColor Yellow
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
