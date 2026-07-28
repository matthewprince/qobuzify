# Qobuzify one-line installer for Windows.
#   irm https://qobuzify.app/install.ps1 | iex
# Installs Qobuzify into the official Qobuz desktop app and relaunches Qobuz.
# ZERO dependencies: no system Node.js required - if the machine has none, this script fetches the
# official portable Node runtime from nodejs.org (pinned version, sha256-verified) automatically.
# Fully reversible (qobuzify restore).

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # the IWR progress bar throttles downloads 10-50x; off = much faster
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

# SHA-256 of the qobuzify.zip this script is paired with. Embedded HERE (inside the TLS-delivered
# irm|iex script) rather than fetched as a sibling file, so it is a real tamper anchor: an attacker who
# swaps the zip on the origin cannot also swap this hash without breaking the signed TLS delivery.
# tools/build-zip.py rewrites this line on every build.
$ExpectedZipSha = "15C6F57B328DF0B41AA7C21716425C4850C055A7CC70FABEE3344F668B25B953"

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
    # Squirrel launches the HIGHEST app-<version> dir, not the newest by mtime (AV/indexer touches can
    # reorder mtimes), so sort by parsed version; mtime only breaks exact-version ties.
    $app = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -like "app-*" } |
           Sort-Object -Property @{ Expression = {
               $v = ($_.Name -replace '^app-', '' -split '[^0-9.]')[0]
               if ($v -notmatch '\.') { $v = $v + ".0" }
               try { [version]$v } catch { [version]"0.0" }
             }; Descending = $true },
             @{ Expression = { $_.LastWriteTime }; Descending = $true } |
           Select-Object -First 1
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
  $appxFailed = $false
  try { $store = Get-AppxPackage -Name "*Qobuz*" -ErrorAction SilentlyContinue | Select-Object -First 1 } catch { $appxFailed = $true }
  if ($appxFailed -and ($PSVersionTable.PSEdition -eq "Core")) {
    # pwsh 7: the Appx module often fails to load under .NET Core; retry through Windows PowerShell.
    try {
      $raw = (powershell.exe -NoProfile -Command "(Get-AppxPackage -Name '*Qobuz*' -ErrorAction SilentlyContinue | Select-Object -First 1).PackageFullName") | Out-String
      $raw = $raw.Trim()
      if ($raw) { $store = $raw }
    } catch {
      Write-Host "Store-app detection unavailable (Appx failed in both shells); assuming no Store install." -ForegroundColor DarkGray
    }
  }
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

# --- Install (stage-then-swap; keep local-only lyric creds across an update) -------------------------
# Extract into a staging dir FIRST: a failed Expand-Archive must never leave a wiped install behind.
# Staged under LOCALAPPDATA (not TEMP) so the final Move-Item never crosses volumes.
Write-Host "Installing to $dir" -ForegroundColor DarkGray
$keep = @(".spotify-creds.json", ".spotify-user-token.json", ".apple-creds.json")
$stash = $null
$stage = Join-Path $env:LOCALAPPDATA ("Qobuzify-stage-" + [guid]::NewGuid().ToString().Substring(0, 8))
try {
  if (Test-Path $dir) {
    $stash = Join-Path $env:TEMP ("qobuzify-keep-" + [guid]::NewGuid().ToString().Substring(0, 8))
    New-Item -ItemType Directory -Path $stash -Force | Out-Null
    foreach ($f in $keep) { $s = Join-Path $dir $f; if (Test-Path $s) { Copy-Item $s (Join-Path $stash $f) -Force } }
  }
  Expand-Archive -Path $zip -DestinationPath $stage -Force
  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
  Move-Item $stage $dir
} finally {
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  if ($stash) {
    # Restore the kept creds even if the swap failed mid-way (if the old dir survived, this is a no-op copy).
    if (Test-Path $dir) {
      foreach ($f in $keep) { $s = Join-Path $stash $f; if (Test-Path $s) { Copy-Item $s (Join-Path $dir $f) -Force } }
    }
    Remove-Item $stash -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# --- Put the qobuzify shim on the USER Path so `qobuzify restore` works in NEW terminals -------------
$binDir = Join-Path $dir "bin"
try {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $userPath) { $userPath = "" }
  $parts = $userPath -split ";" | Where-Object { $_ }
  if ($parts -notcontains $binDir) {
    if ($userPath -and (-not $userPath.EndsWith(";"))) { $userPath = $userPath + ";" }
    [Environment]::SetEnvironmentVariable("Path", $userPath + $binDir, "User")
    Write-Host "Added the qobuzify command to your user PATH (takes effect in NEW terminals)." -ForegroundColor DarkGray
  }
} catch {
  Write-Host ("Could not update the user PATH: " + $_.Exception.Message + ". Use the full path shown at the end instead.") -ForegroundColor Yellow
}

# --- Node runtime: portable node.exe in the install dir, a system Node, or a fresh verified download --
# The zip itself ships without node.exe (it would push the download past the host's per-file size cap),
# but the install stays zero-dependency: when the machine has no Node at all, the official portable
# build is downloaded straight from nodejs.org, verified against a sha256 pinned in THIS script (the
# same TLS-delivered tamper anchor that protects the zip), and placed at runtime\node\node.exe.
$NodeVersion = "v20.18.0"
$NodeZipSha  = "F5CEA43414CC33024BBE5867F208D1C9C915D6A38E92ABEEE07ED9E563662297" # sha256 of node-v20.18.0-win-x64.zip from nodejs.org SHASUMS256.txt
function Resolve-Node($installDir) {
  $bundled = Join-Path $installDir "runtime\node\node.exe"
  if (Test-Path $bundled) { return $bundled }
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
  Write-Host ("No Node.js found - downloading the portable runtime (" + $NodeVersion + ", ~30 MB, one time)...") -ForegroundColor Gray
  $nodeZipName = "node-" + $NodeVersion + "-win-x64.zip"
  $nodeZip = Join-Path $env:TEMP ("qobuzify-" + $nodeZipName)
  $nodeStage = Join-Path $env:TEMP ("qobuzify-node-" + [IO.Path]::GetRandomFileName())
  try {
    Invoke-WebRequest -Uri ("https://nodejs.org/dist/" + $NodeVersion + "/" + $nodeZipName) -OutFile $nodeZip -UseBasicParsing
    $got = (Get-FileHash -Algorithm SHA256 -Path $nodeZip).Hash
    if ($got -ne $NodeZipSha) {
      Write-Host ("Node download failed verification (got " + $got + "). Not using it.") -ForegroundColor Red
      Write-Host "Install Node LTS from https://nodejs.org yourself, then re-run this installer." -ForegroundColor Yellow
      return
    }
    Expand-Archive -Path $nodeZip -DestinationPath $nodeStage -Force
    $nodeDir = Join-Path $dir "runtime\node"
    New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
    Copy-Item (Join-Path $nodeStage ("node-" + $NodeVersion + "-win-x64\node.exe")) (Join-Path $nodeDir "node.exe") -Force
    $node = Join-Path $nodeDir "node.exe"
    Write-Host "Portable Node runtime installed (verified)." -ForegroundColor Gray
  } catch {
    Write-Host ("Could not download Node: " + $_.Exception.Message) -ForegroundColor Red
    Write-Host "Install Node LTS from https://nodejs.org, then re-run this installer." -ForegroundColor Yellow
    return
  } finally {
    Remove-Item $nodeZip -ErrorAction SilentlyContinue
    Remove-Item $nodeStage -Recurse -Force -ErrorAction SilentlyContinue
  }
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
Write-Host "To undo it all later, open a NEW terminal and run:  qobuzify restore" -ForegroundColor DarkGray
if ($node -eq "node") {
  Write-Host ("(or directly:  node `"" + (Join-Path $dir 'bin\qobuzify.js') + "`" restore)") -ForegroundColor DarkGray
} else {
  Write-Host ("(or directly:  & `"" + $node + "`" `"" + (Join-Path $dir 'bin\qobuzify.js') + "`" restore)") -ForegroundColor DarkGray
}
Write-Host "Heads up: a Qobuz app update removes Qobuzify. Re-run this installer to restore it (your settings survive)." -ForegroundColor DarkGray
Write-Host ""
