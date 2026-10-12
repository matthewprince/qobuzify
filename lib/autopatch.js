// Keep Qobuzify applied across Qobuz's own auto-updates.
//
// Qobuz updates itself through Squirrel: it unpacks a fresh, unpatched app-<version> folder next to the old
// one and launches that on the next start, so every Qobuz update silently removed Qobuzify. This installs a
// per-user Scheduled Task that runs `qobuzify reapply` every 15 minutes. reapply is cheap when there is
// nothing to do (read one file, exit) and, when the newest app-* folder is unpatched and Squirrel has
// finished writing it, patches it WITHOUT relaunching Qobuz (it never interrupts playback; the patched
// version is what the next Qobuz start launches).
//
// Why this shape:
//   - A Scheduled Task under the current user, with a time trigger and an interactive token, needs no admin
//     rights. (A logon trigger via schtasks does, so there is none; StartWhenAvailable covers missed runs.)
//   - The task XML turns off the battery conditions that schtasks' defaults would apply, so laptops on
//     battery still get re-patched.
//   - node.exe is a console program, so the task runs it through a tiny generated .vbs under wscript, which
//     starts it with no window. The .vbs lives NEXT TO the install dir (like .qobuzify-state.json), so the
//     installer's wipe-and-re-extract of the install dir doesn't remove it, and if Qobuzify is deleted
//     without `restore` the .vbs removes its own task and itself on the next run.
//   - Nothing stays resident, so no file in the install dir is held open between runs.
//
// Windows only. On macOS the Qobuz app is not patched by this CLI at all (locate() is Windows-only), so
// there is nothing to keep applied there.
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const TASK_NAME = "Qobuzify Auto-Reapply";
const INTERVAL = "PT15M";

function xmlEsc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function vbsStr(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

function schtasks(args) {
  return cp.spawnSync("schtasks.exe", args, { encoding: "utf8", windowsHide: true, timeout: 20000 });
}

// The node to run: the bundled portable runtime if the install has one, else the node running us now.
function nodeExe(root) {
  const bundled = path.join(root, "runtime", "node", "node.exe");
  return fs.existsSync(bundled) ? bundled : process.execPath;
}

function launcherPath(root) { return path.join(root, "..", ".qobuzify-autopatch.vbs"); }

function launcherSource(node, script) {
  return [
    "' Qobuzify auto-reapply launcher. Created by `qobuzify install`, removed by `qobuzify restore`.",
    "' Runs `qobuzify reapply` with no console window. If Qobuzify was deleted without `restore`,",
    "' it removes its Scheduled Task and itself instead of failing every 15 minutes.",
    "Option Explicit",
    "Dim fso, sh, node, script",
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set sh = CreateObject("WScript.Shell")',
    "node = " + vbsStr(node),
    "script = " + vbsStr(script),
    "If fso.FileExists(script) Then",
    '  If Not fso.FileExists(node) Then node = "node"',
    '  sh.Run """" & node & """ """ & script & """ reapply", 0, True',
    "Else",
    "  sh.Run " + vbsStr('schtasks.exe /Delete /TN "' + TASK_NAME + '" /F') + ", 0, True",
    "  On Error Resume Next",
    "  fso.DeleteFile WScript.ScriptFullName, True",
    "End If",
    "",
  ].join("\r\n");
}

function taskXml(vbs) {
  const user = (process.env.USERDOMAIN ? process.env.USERDOMAIN + "\\" : "") + (process.env.USERNAME || "");
  const wscript = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
  const start = new Date(Date.now() + 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const startLocal = start.getFullYear() + "-" + pad(start.getMonth() + 1) + "-" + pad(start.getDate()) +
    "T" + pad(start.getHours()) + ":" + pad(start.getMinutes()) + ":00";
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Re-applies Qobuzify after the Qobuz desktop app updates itself. Remove with: qobuzify restore</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>${INTERVAL}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>${startLocal}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      ${user ? "<UserId>" + xmlEsc(user) + "</UserId>" : ""}
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEsc(wscript)}</Command>
      <Arguments>${xmlEsc('//B //Nologo "' + vbs + '"')}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

// Create or refresh the task. Idempotent: /F replaces an existing task of the same name, and the .vbs is
// rewritten each time (so a moved node or install dir is picked up by simply re-running install).
function enable(root) {
  if (process.platform !== "win32") return { ok: false, reason: "not Windows" };
  const vbs = launcherPath(root);
  const xmlFile = path.join(require("os").tmpdir(), "qobuzify-task-" + process.pid + ".xml");
  try {
    // UTF-16LE with a BOM: what Task Scheduler itself exports, and what schtasks /XML parses reliably. The
    // .vbs gets the same so a non-ASCII user name in the paths survives (wscript reads UTF-16 scripts).
    fs.writeFileSync(vbs, Buffer.from("\ufeff" + launcherSource(nodeExe(root), path.join(root, "bin", "qobuzify.js")), "utf16le"));
    fs.writeFileSync(xmlFile, Buffer.from("\ufeff" + taskXml(vbs), "utf16le"));
    const r = schtasks(["/Create", "/TN", TASK_NAME, "/XML", xmlFile, "/F"]);
    if (r.status !== 0) return { ok: false, reason: ((r.stderr || r.stdout || "").trim() || "schtasks failed").split(/\r?\n/)[0] };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    try { fs.unlinkSync(xmlFile); } catch (_) {}
  }
}

// Remove the task and its launcher. Safe to call when neither exists.
function disable(root) {
  if (process.platform !== "win32") return { ok: true, removed: false };
  let removed = false;
  if (status().installed) {
    const r = schtasks(["/Delete", "/TN", TASK_NAME, "/F"]);
    removed = r.status === 0;
  }
  try { fs.unlinkSync(launcherPath(root)); removed = true; } catch (_) {}
  return { ok: !status().installed, removed };
}

function status() {
  if (process.platform !== "win32") return { installed: false };
  const r = schtasks(["/Query", "/TN", TASK_NAME]);
  return { installed: r.status === 0 };
}

module.exports = { enable, disable, status, TASK_NAME };
