// Qobuzify wrapper prototype.
//
// A plain Electron shell around play.qobuz.com (the same qobuz-dwp-ui frontend the desktop
// app packages) with the Qobuzify runtime injected before the page boots. This is the path
// to a Linux/macOS build: Qobuz ships no desktop app there, but the web player does, and it
// streams via MSE + signed URLs (no Widevine), so a bare Electron shell can play it.
//
// What the shell does that the on-disk desktop bake does via file patching:
//   1. Injects window.__QOBUZIFY__ + the runtime via a preload script, before the page's
//      own scripts (the wrapper equivalent of the inline <script> before bundle.js).
//   2. Serves each extension's vendor.js at the same-origin path the extension requests
//      (the desktop copies it into the app's dist dir; here we intercept and serve it).
//   3. Sets backgroundThrottling:false + disables native-window-occlusion so the lyrics
//      render loop never freezes when the window is hidden (a free fix vs the desktop hack).
const { app, BrowserWindow, session, shell, nativeImage, ipcMain, Notification } = require("electron");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// Occlusion pausing froze the desktop lyrics when the window was covered; disabling it keeps
// the render loop running while hidden. Hardware acceleration stays ON: Qobuz is image-heavy
// (album art everywhere), and software rendering a big list like the whole library eats memory
// until the renderer chokes. (The early segfault was the Bash tool's detached context, not the
// GPU; launched from a real session the GPU is fine.)
// disable-features is a single Chromium switch, so gather the values and set it once at the end - a
// second appendSwitch("disable-features", ...) REPLACES the first, which would silently drop the
// occlusion fix.
const disableFeatures = ["CalculateNativeWinOcclusion"];
app.commandLine.appendSwitch("no-sandbox");
// Two Linux-only crashes reported on Arch, both handled here:
//  (1) the GPU sandbox crashes the GPU process on launch on some setups - dropping just the GPU sandbox
//      keeps hardware acceleration and is a no-op elsewhere;
//  (2) "crashes immediately when trying to log in": on a bleeding-edge kernel a freshly-spawned renderer
//      can FATAL allocating its compositor shared memory ("Creating shared memory in /dev/shm failed").
//      Qobuz's sign-in page runs an invisible Google reCAPTCHA in a cross-site iframe, so site isolation
//      hands it its own renderer, which hits exactly that crash - and since the captcha gates sign-in,
//      login dies. Keeping cross-site frames in the main renderer (which allocated its shmem fine at
//      startup) sidesteps it. Only Qobuz and its own embeds ever load in this shell, so turning off site
//      isolation costs us nothing meaningful.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  app.commandLine.appendSwitch("disable-site-isolation-trials");
  disableFeatures.push("IsolateOrigins", "site-per-process");
}
app.commandLine.appendSwitch("disable-features", disableFeatures.join(","));

// The qz-state.json probe loop below is a dev-only verification channel. A shipped build must NOT run
// a setInterval that calls executeJavaScript on the renderer: if it fires while the window is tearing
// down (clicking X to quit) Electron can segfault mid-teardown on Linux, which is the reported
// "crashed when clicking X" bug. Gate the whole diagnostics path behind QZ_DEBUG so it never runs for
// end users.
const DEBUG = !!process.env.QZ_DEBUG;

const PARTITION = "persist:qobuz"; // keep the Qobuz login across runs
// Baked at build time by prebuild.js so the packaged app carries no ../ Qobuzify source. The preload
// reads qz-payload.js directly; VENDORS maps extension id -> filename under ./vendor (empty while
// lyrics is excluded).
const VENDOR_DIR = path.join(__dirname, "vendor");
let VENDORS = {};
try { VENDORS = JSON.parse(fs.readFileSync(path.join(__dirname, "qz-vendors.json"), "utf8")); } catch (_) {}

// Verification channel: stdout is block-buffered to a redirected pipe, so write state to a
// file synchronously instead (always flushed, readable while the app runs).
const STATE_FILE = path.join(__dirname, "qz-state.json");
const state = { stage: "init", vendorPort: 0, probes: [] };
function saveState(patch) {
  Object.assign(state, patch);
  if (!DEBUG) return; // no state-file writes (or the probe loop that feeds them) in a shipped build
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (_) {}
}

let vendorPort = 0;
let win = null;        // module-scoped so the lifecycle handlers can null it out on close
let probeTimer = null; // dev-only diagnostics interval; cleared on window close so it can't outlive it

// --- update check ---------------------------------------------------------------------------------
// Builds ship through GitHub Releases and nothing here ever looked for a newer one, so a user's only route
// to an update was noticing by hand. Ask the releases API directly: one request, no updater dependency, and
// it behaves the same for AppImage, deb, rpm, nsis and mac. We only ever TELL: deb/rpm installs belong to the
// package manager, and silently swapping an AppImage under someone is not ours to do.
const RELEASES_API = "https://api.github.com/repos/matthewprince/qobuzify/releases/latest";
const RELEASES_PAGE = "https://github.com/matthewprince/qobuzify/releases/latest";
const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
let updateTimer = null, notifiedTag = null;

function semver(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ""));
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function isNewer(remote, local) {
  const r = semver(remote), l = semver(local);
  if (!r || !l) return false; // an unparseable tag is not an excuse to nag
  for (let i = 0; i < 3; i++) { if (r[i] !== l[i]) return r[i] > l[i]; }
  return false;
}
function tellAboutUpdate(tag, url) {
  const cur = app.getVersion();
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: "Qobuzify " + tag + " is available",
        body: "You have " + cur + ". Click to open the download page.",
      });
      n.on("click", () => { try { shell.openExternal(url); } catch (_) {} });
      n.show();
    }
  } catch (_) {}
  // A desktop notification needs a daemon, which plenty of Linux setups do not run, so also say it in the
  // window where the user is definitely looking. The runtime has no toast API, so inject a small
  // self-contained banner (a link + a dismiss). Guarded: an executeJavaScript into a dying renderer can
  // take the process down on Linux.
  try {
    if (!win || win.isDestroyed()) return;
    const label = "Qobuzify " + tag + " is available. You have " + cur + ".";
    win.webContents.executeJavaScript(
      "(function(){try{" +
      "if(document.getElementById('qz-update-banner'))return;" +
      "var openUrl=" + JSON.stringify(url) + ";" +
      "var b=document.createElement('div');b.id='qz-update-banner';" +
      "b.style.cssText='position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2147483647;" +
      "display:flex;gap:12px;align-items:center;padding:10px 14px;border-radius:10px;" +
      "background:#141c2e;color:#f0f6fc;font:600 13px system-ui,sans-serif;" +
      "box-shadow:0 6px 24px rgba(0,0,0,.5),0 0 0 1px rgba(61,168,254,.35);';" +
      "var t=document.createElement('span');t.textContent=" + JSON.stringify(label) + ";" +
      "var a=document.createElement('a');a.textContent='Download';a.href='#';" +
      "a.style.cssText='color:#3da8fe;cursor:pointer;text-decoration:none;font-weight:700;';" +
      // window.open routes through setWindowOpenHandler -> shell.openExternal, so the release page opens in
      // the real browser instead of navigating the Qobuz app away from itself.
      "a.onclick=function(e){e.preventDefault();window.open(openUrl,'_blank');b.remove();};" +
      "var x=document.createElement('span');x.textContent='\\u2715';x.title='Dismiss';" +
      "x.style.cssText='cursor:pointer;opacity:.6;padding:0 2px;';" +
      "x.onclick=function(){b.remove();};" +
      "b.appendChild(t);b.appendChild(a);b.appendChild(x);" +
      "(document.body||document.documentElement).appendChild(b);" +
      "}catch(e){}})()"
    ).catch(() => {});
  } catch (_) {}
}
function checkForUpdate() {
  if (process.env.QZ_NO_UPDATE_CHECK) return; // dev/offline escape hatch
  let req;
  try {
    req = https.get(RELEASES_API, {
      headers: { "User-Agent": "Qobuzify/" + app.getVersion(), "Accept": "application/vnd.github+json" },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return; } // rate limited or offline: try again tomorrow
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { body += d; if (body.length > 1024 * 1024) { try { req.destroy(); } catch (_) {} } });
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          if (j.draft || j.prerelease) return;
          const tag = j.tag_name || j.name;
          if (!isNewer(tag, app.getVersion()) || notifiedTag === tag) return;
          notifiedTag = tag; // one mention per version per run, not once a day forever
          tellAboutUpdate(tag, j.html_url || RELEASES_PAGE);
        } catch (_) {}
      });
    });
  } catch (_) { return; }
  req.on("error", () => {});
  req.on("timeout", () => { try { req.destroy(); } catch (_) {} });
}

// A tiny loopback server for the extension vendor bundles. http://127.0.0.1 is treated as a
// trustworthy origin, so an https page can load these without a mixed-content block.
function startVendorServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const m = /qobuzify-ext-(.+?)\.js/.exec(req.url || "");
      if (m && VENDORS[m[1]]) {
        try {
          const body = fs.readFileSync(path.join(VENDOR_DIR, VENDORS[m[1]]));
          res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
          res.end(body);
          return;
        } catch (_) {}
      }
      res.writeHead(404); res.end("not found");
    });
    srv.listen(0, "127.0.0.1", () => { vendorPort = srv.address().port; resolve(); });
  });
}

// State probe, evaluated in the page and written to the state file.
const PROBE = `(function(){
  try {
    var Q = window.Qobuzify, D = window.__QOBUZIFY__ || {};
    var a = document.querySelector('audio');
    var tr = null; try { tr = Q && Q.player && Q.player.getTrack ? Q.player.getTrack() : null; } catch(e){}
    var playing = null; try { playing = Q.player.isPlaying(); } catch(e){}
    return {
      url: location.href.slice(0,46),
      qobuzify: !!Q,
      themes: (D.catalog||[]).length,
      exts: (D.extensions||[]).length,
      accent: (Q && Q.accent) ? Q.accent() : '',
      playing: playing,
      track: tr ? ((tr.name||tr.title||'?') + ' - ' + ((tr.artists&&tr.artists[0]&&tr.artists[0].name)||tr.artist||'?')) : null,
      audio: a ? { paused:a.paused, t:+(a.currentTime||0).toFixed(1), dur:Math.round(a.duration||0), rs:a.readyState, src:(a.currentSrc||a.src||'').slice(0,18) } : null,
      lyricsUI: !!document.getElementById('qz-sl-root'),
      qzMenu: !!document.querySelector('[data-qz]')
    };
  } catch(e){ return { err: String(e) }; }
})()`;

// --- Windows taskbar thumbnail toolbar: Previous / Play-Pause / Next on the taskbar-icon hover preview
// (parity with the native Qobuz desktop app). Windows-only. Drives the renderer's transport by clicking
// Qobuz's own player buttons. Icons are drawn as bitmaps (white glyph + alpha, so RGBA/BGRA order doesn't
// matter) - no asset files. A 2s poll keeps the middle button's icon in sync with play/pause. All guarded.
const _thumb = { icons: null, playing: null, winId: null, timer: null };
function thumbGlyph(kind) {
  const W = 32, H = 32, buf = Buffer.alloc(W * H * 4);
  const px = (x, y) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const o = (y * W + x) * 4; buf[o] = 255; buf[o + 1] = 255; buf[o + 2] = 255; buf[o + 3] = 255; };
  const rect = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px(x, y); };
  const triR = (x0, x1, ym, half) => { for (let x = x0; x <= x1; x++) { const h = Math.round(half * (1 - (x - x0) / (x1 - x0))); for (let y = ym - h; y <= ym + h; y++) px(x, y); } };
  const triL = (x0, x1, ym, half) => { for (let x = x1; x >= x0; x--) { const h = Math.round(half * (1 - (x1 - x) / (x1 - x0))); for (let y = ym - h; y <= ym + h; y++) px(x, y); } };
  if (kind === "play") triR(10, 25, 16, 9);
  else if (kind === "pause") { rect(9, 7, 15, 25); rect(18, 7, 24, 25); }
  else if (kind === "next") { triR(7, 21, 16, 8); rect(22, 7, 25, 25); }
  else { triL(11, 25, 16, 8); rect(7, 7, 10, 25); } // prev
  return nativeImage.createFromBitmap(buf, { width: W, height: H });
}
function thumbClick(which) {
  if (!win || win.isDestroyed()) return;
  const sel = which === "prev" ? ".pct-player-prev, .player__action-previous" : which === "next" ? ".pct-player-next, .player__action-next" : ".player__action-pause, .player__action-play";
  try { win.webContents.executeJavaScript(`(function(){try{var b=document.querySelector(${JSON.stringify(sel)});if(b)b.click();}catch(e){}})()`, true).catch(() => {}); } catch (_) {}
}
function applyThumbar(playing) {
  if (!win || win.isDestroyed()) return;
  if (!_thumb.icons) { try { _thumb.icons = { prev: thumbGlyph("prev"), play: thumbGlyph("play"), pause: thumbGlyph("pause"), next: thumbGlyph("next") }; } catch (_) { return; } }
  const ic = _thumb.icons;
  try {
    win.setThumbarButtons([
      { tooltip: "Previous", icon: ic.prev, click: () => thumbClick("prev") },
      { tooltip: playing ? "Pause" : "Play", icon: playing ? ic.pause : ic.play, click: () => thumbClick("play") },
      { tooltip: "Next", icon: ic.next, click: () => thumbClick("next") },
    ]);
    _thumb.playing = playing;
  } catch (_) {}
}
function setupThumbar() {
  if (process.platform !== "win32" || _thumb.timer) return;
  _thumb.timer = setInterval(() => {
    try {
      if (!win || win.isDestroyed()) return;
      win.webContents.executeJavaScript("(function(){try{return !!document.querySelector('.player__action-pause');}catch(e){return null;}})()", true)
        .then((playing) => {
          if (playing === null || playing === undefined) return;
          if (win.id !== _thumb.winId || !!playing !== _thumb.playing) { _thumb.winId = win.id; applyThumbar(!!playing); }
        }).catch(() => {});
    } catch (_) {}
  }, 2000);
}

// ===================================================================================================
// Bit-perfect audio sidecar. The web player's <audio>/MSE path goes through Chromium's resampler +
// the shared OS mixer, so it can't be bit-perfect. Instead we spawn a bundled mpv, hand it the signed
// FLAC URL the renderer captures, and it plays it byte-exact through ALSA hw: exclusive (Linux) /
// CoreAudio hog mode (mac) / WASAPI exclusive (win) - native rate per track, no resample/mix/volume.
// The renderer mutes its <audio> element so only mpv reaches the DAC. This process spawns/supervises mpv
// and relays: renderer command (qzbp:cmd) -> mpv JSON IPC, and mpv property events -> renderer (qzbp:evt).
// PROVEN in isolation (byte-exact decode + the full load/pause/seek/observe IPC loop); the on-a-real-
// -desktop integration (exclusive acquisition, muted-element sync) is the remaining verification.
const net = require("net");
const { spawn } = require("child_process");
const qzbp = { proc: null, sock: null, buf: "", reqId: 0, mode: "off", enabled: false, socketPath: null, restarts: 0, restartAt: 0, wantPlaying: false, curUrl: null,
  srv: null, port: 0, feed: null, token: 0, device: null };

// The web player never hands out a plain stream URL: /file/url returns a segment template whose media
// segments are encrypted, and the page decrypts them in JS before pushing them into MSE. So the only
// plaintext FLAC in the process is what reaches SourceBuffer.appendBuffer. The renderer forwards those
// bytes here and we re-serve them to mpv over loopback HTTP: no Content-Length, so mpv keeps reading
// until we end the response instead of stopping at whatever had arrived when it opened the stream.
function qzbpFeedServer() {
  if (qzbp.srv) return Promise.resolve(qzbp.port);
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const m = /^\/s\/(\d+)/.exec(req.url || "");
      const f = qzbp.feed;
      if (!m || !f || String(f.token) !== m[1]) { res.writeHead(404); res.end(); return; }
      if (f.res) { try { f.res.end(); } catch (_) {} } // mpv reconnected; drop the stale one
      res.writeHead(200, { "Content-Type": "audio/mp4", "Cache-Control": "no-store", "Connection": "close" });
      f.chunks.forEach((c) => { try { res.write(c); } catch (_) {} });
      f.res = res;
      if (f.done) { try { res.end(); } catch (_) {} }
      req.on("close", () => { if (f.res === res) f.res = null; });
    });
    srv.on("error", () => resolve(0));
    srv.listen(0, "127.0.0.1", () => { qzbp.srv = srv; qzbp.port = srv.address().port; resolve(qzbp.port); });
  });
}
// A new stream starts at the init segment ('ftyp'); everything after it is that track's media until the
// next one. Keeping the bytes lets a late-connecting mpv replay the track from the beginning.
async function qzbpFeedStart() {
  const port = await qzbpFeedServer();
  if (!port) { qzbpEvt({ type: "error", what: "serve" }); return; }
  const prev = qzbp.feed;
  if (prev && prev.res) { try { prev.res.end(); } catch (_) {} }
  qzbp.token += 1;
  qzbp.feed = { token: qzbp.token, chunks: [], res: null, done: false, bytes: 0 };
  qzbp.curUrl = "http://127.0.0.1:" + port + "/s/" + qzbp.token;
  mpvSend(["loadfile", qzbp.curUrl, "replace"]);
  mpvSend(["set_property", "pause", !qzbp.wantPlaying]);
}
function qzbpFeedChunk(buf) {
  const f = qzbp.feed;
  if (!f || f.done || !buf || !buf.length) return;
  const b = Buffer.from(buf);
  f.chunks.push(b); f.bytes += b.length;
  // A whole hi-res track is tens of MB; hold one track's worth so mpv can restart mid-track, no more.
  if (f.bytes > 320 * 1024 * 1024) { const d = f.chunks.shift(); if (d) f.bytes -= d.length; }
  if (f.res) { try { f.res.write(b); } catch (_) {} }
}

function mpvBinary() {
  // dev override, else the bundled binary under resources (electron-builder extraResources)
  if (process.env.QZ_MPV) return process.env.QZ_MPV;
  const p = process.platform;
  const base = process.resourcesPath || path.join(__dirname, "resources");
  const bundled = p === "win32" ? path.join(base, "mpv", "mpv.exe")
    : p === "darwin" ? path.join(base, "mpv", "mpv")
    : path.join(base, "mpv", "AppRun"); // linux: the self-contained mpv AppImage's entry point
  try { if (fs.existsSync(bundled)) return bundled; } catch (_) {}
  // Nothing bundled (the deb/rpm declare mpv as a dependency instead of shipping a second copy of it,
  // and a dev checkout has no resources dir at all). A system mpv plays the same bytes the same way.
  return p === "win32" ? "mpv.exe" : "mpv";
}
// Byte-exact output flags per platform. exclusivity: linux from selecting hw:, mac/win from --audio-exclusive.
// --- Linux: find the real DAC, and get everything else off it ---------------------------------------
// Two things stand between us and a byte-exact path, and both are invisible if you don't look:
//  1. With PipeWire/Pulse installed, ALSA's "default" is their plug. mpv plays into it happily and the
//     server resamples to whatever the graph runs at, so the audio is NOT bit-perfect while the badge
//     insists it is. We have to name the hw: device ourselves.
//  2. The muted web <audio> still keeps the server parked on that card, so an exclusive open returns
//     "Device or resource busy". Park OUR streams on a throwaway null sink instead: the real sink goes
//     idle, the server suspends it, and the device frees up. The web clock keeps running on the null sink,
//     which is all the timeline needs.
const pw = { module: null, moved: [], timer: null };
function pactl(args) {
  try { return require("child_process").execFileSync("pactl", args, { timeout: 4000, encoding: "utf8" }); }
  catch (_) { return null; }
}
function pactlJson(args) { try { return JSON.parse(pactl(["-f", "json"].concat(args)) || "null"); } catch (_) { return null; } }

function alsaDeviceForDefaultSink() {
  if (process.platform !== "linux") return null;
  if (process.env.QZ_BP_DEVICE) return process.env.QZ_BP_DEVICE; // explicit override wins (diagnostics)
  const def = (pactl(["get-default-sink"]) || "").trim();
  const sinks = pactlJson(["list", "sinks"]);
  if (sinks && sinks.length) {
    const pick = sinks.find((s) => s.name === def && (s.properties || {})["alsa.card"] != null)
      || sinks.find((s) => (s.properties || {})["alsa.card"] != null);
    if (pick) {
      const p = pick.properties || {};
      return "alsa/hw:" + p["alsa.card"] + "," + (p["alsa.device"] == null ? 0 : p["alsa.device"]);
    }
  }
  // No pactl (bare ALSA): take the first real card. Loopback/Dummy are virtual and never the DAC.
  try {
    const cards = fs.readFileSync("/proc/asound/cards", "utf8").split("\n");
    for (const line of cards) {
      const m = /^\s*(\d+)\s+\[(\S+)/.exec(line);
      if (m && !/loopback|dummy/i.test(m[2])) return "alsa/hw:" + m[1] + ",0";
    }
  } catch (_) {}
  return null;
}

// Move this app's own streams to a null sink so the DAC goes idle and mpv can take it exclusively.
function pwIsolate() {
  if (process.platform !== "linux" || pw.module) return;
  const id = (pactl(["load-module", "module-null-sink", "sink_name=qobuzify_silent",
    "sink_properties=device.description=Qobuzify_Bitperfect_Silent"]) || "").trim();
  if (!/^\d+$/.test(id)) return; // no pactl, or the server refused: mpv falls back to shared and says so
  pw.module = id;
  const mine = new RegExp(path.basename(process.execPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "|qobuzify", "i");
  const inputs = pactlJson(["list", "sink-inputs"]) || [];
  for (const si of inputs) {
    const p = si.properties || {};
    const who = String(p["application.name"] || "") + " " + String(p["application.process.binary"] || "");
    if (!mine.test(who)) continue; // never touch other apps' audio
    const from = si.sink != null ? String(si.sink) : null;
    if (pactl(["move-sink-input", String(si.index), "qobuzify_silent"]) !== null) pw.moved.push({ index: si.index, from });
  }
}
// Enable happens at boot, before the web player has ever made a sound, so there is usually nothing to move
// yet: Chromium creates its stream when playback starts and it lands on the real sink, which mpv is holding
// exclusively. Keep sweeping while enabled so that stream gets parked as soon as it appears. Async on
// purpose, this runs on a timer and must never block the main process.
function pwSweep() {
  if (process.platform !== "linux" || !pw.module || !qzbp.enabled) return;
  const mine = new RegExp(path.basename(process.execPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "|qobuzify", "i");
  require("child_process").execFile("pactl", ["-f", "json", "list", "sink-inputs"], { timeout: 4000 }, (err, out) => {
    if (err || !qzbp.enabled || !pw.module) return;
    let inputs; try { inputs = JSON.parse(out); } catch (_) { return; }
    for (const si of inputs || []) {
      const p = si.properties || {};
      const who = String(p["application.name"] || "") + " " + String(p["application.process.binary"] || "");
      if (!mine.test(who)) continue;                       // never touch other apps' audio
      if (String(p["node.target"] || "") === "qobuzify_silent") continue;
      if (pw.moved.some((m) => m.index === si.index)) continue;
      const from = si.sink != null ? String(si.sink) : null;
      require("child_process").execFile("pactl", ["move-sink-input", String(si.index), "qobuzify_silent"],
        { timeout: 4000 }, (e2) => { if (!e2) pw.moved.push({ index: si.index, from }); });
    }
  });
}
function pwRestore() {
  if (process.platform !== "linux") return;
  if (pw.timer) { clearInterval(pw.timer); pw.timer = null; }
  for (const m of pw.moved) { if (m.from) pactl(["move-sink-input", String(m.index), m.from]); }
  pw.moved = [];
  if (pw.module) { pactl(["unload-module", pw.module]); pw.module = null; }
}

function mpvArgs(sockPath, shared) {
  const a = ["--idle=yes", "--no-video", "--no-terminal", "--no-config", "--keep-open=yes",
    "--input-ipc-server=" + sockPath, "--gapless-audio=weak", "--replaygain=no",
    "--af=", "--volume=100", "--volume-max=100", "--audio-samplerate=0", "--audio-channels=stereo",
    // The feed is a chunked HTTP body with no Content-Length, so the stream itself can't Range-seek.
    // A demuxer cache big enough for a whole hi-res track is what makes scrubbing work at all.
    "--cache=yes", "--demuxer-max-bytes=768MiB", "--demuxer-max-back-bytes=768MiB",
    "--user-agent=Mozilla/5.0"];
  if (shared) { // fallback: NOT bit-perfect (shared graph resamples), used only when exclusive fails
    if (process.platform === "linux") a.push("--ao=pipewire,pulse,alsa");
    else if (process.platform === "darwin") a.push("--ao=coreaudio");
    else a.push("--ao=wasapi");
    return a;
  }
  // Name the hw: device explicitly. Left to itself mpv opens ALSA "default", which on any PipeWire/Pulse
  // desktop is their plug: it accepts every rate and resamples, so we would claim bit-perfect and not be.
  if (process.platform === "linux" && qzbp.device) a.push("--audio-device=" + qzbp.device);
  if (process.platform === "linux") a.push("--ao=alsa", "--audio-exclusive=yes");
  else if (process.platform === "darwin") a.push("--ao=coreaudio", "--audio-exclusive=yes");
  else a.push("--ao=wasapi", "--audio-exclusive=yes");
  return a;
}
function qzbpEvt(m) { try { if (win && !win.isDestroyed()) win.webContents.send("qzbp:evt", m); } catch (_) {} }
function qzbpSocketPath() {
  if (process.platform === "win32") return "\\\\.\\pipe\\qobuzify-mpv-" + process.pid;
  return path.join(process.env.XDG_RUNTIME_DIR || require("os").tmpdir(), "qobuzify-mpv-" + process.pid + ".sock");
}
function mpvSend(cmd) {
  if (!qzbp.sock) return;
  qzbp.reqId += 1;
  try { qzbp.sock.write(JSON.stringify({ command: cmd, request_id: qzbp.reqId }) + "\n"); } catch (_) {}
}
function qzbpConnect() {
  const s = net.connect(qzbp.socketPath);
  qzbp.sock = s;
  s.on("connect", () => {
    // observe the properties that drive the UI badge + gapless/scrobble reconciliation
    mpvSend(["observe_property", 1, "time-pos"]);
    mpvSend(["observe_property", 2, "audio-params"]);
    mpvSend(["observe_property", 3, "eof-reached"]);
    mpvSend(["observe_property", 4, "core-idle"]);
    qzbpEvt({ type: "ready", mode: qzbp.mode });
  });
  s.on("data", (d) => {
    qzbp.buf += d.toString("utf8");
    let i;
    while ((i = qzbp.buf.indexOf("\n")) >= 0) {
      const line = qzbp.buf.slice(0, i); qzbp.buf = qzbp.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch (_) { continue; }
      if (m.event === "property-change") {
        if (m.name === "time-pos" && m.data != null) qzbpEvt({ type: "position", ms: Math.round(m.data * 1000) });
        else if (m.name === "audio-params" && m.data) qzbpEvt({ type: "params", rate: m.data.samplerate, format: m.data.format, channels: m.data["channel-count"], mode: qzbp.mode });
        else if (m.name === "eof-reached" && m.data === true) qzbpEvt({ type: "ended" });
      } else if (m.event === "end-file" && m.reason === "error") {
        qzbpEvt({ type: "error", what: "load" });
      }
    }
  });
  s.on("error", () => {});
  s.on("close", () => { qzbp.sock = null; });
}
function qzbpSpawn(shared) {
  const bin = mpvBinary();
  qzbp.mode = shared ? "shared" : "exclusive";
  qzbp.socketPath = qzbpSocketPath();
  try { if (process.platform !== "win32" && fs.existsSync(qzbp.socketPath)) fs.unlinkSync(qzbp.socketPath); } catch (_) {}
  let proc;
  try { proc = spawn(bin, mpvArgs(qzbp.socketPath, shared), { stdio: ["ignore", "ignore", "pipe"] }); }
  catch (e) { qzbpEvt({ type: "error", what: "spawn", msg: String(e && e.message) }); return; }
  qzbp.proc = proc;
  // Watch stderr for an ALSA/exclusive open failure; if the exclusive attempt can't grab the device
  // (another client holds it, or the DAC rejects the rate), fall back to the shared graph and badge it.
  let sawOpenFail = false;
  if (proc.stderr) proc.stderr.on("data", (d) => {
    const t = d.toString();
    if (!shared && /Failed to open|cannot open|Device or resource busy|EBUSY|could not open|Could not open/i.test(t)) sawOpenFail = true;
  });
  proc.on("exit", (code) => {
    qzbp.sock = null; qzbp.proc = null;
    if (!qzbp.enabled) return; // intentional stop
    if (!shared && sawOpenFail) { qzbpEvt({ type: "mode", mode: "shared" }); qzbpSpawn(true); return; } // graceful degrade
    // crash: respawn a few times, then give up and tell the renderer to unmute so audio never fully drops
    const now = Date.now();
    if (now - qzbp.restartAt > 20000) qzbp.restarts = 0;
    if (qzbp.restarts++ < 4) { qzbp.restartAt = now; qzbpSpawn(shared); }
    else { qzbp.enabled = false; qzbpEvt({ type: "fatal" }); }
  });
  // connect once the socket exists
  let tries = 0;
  const iv = setInterval(() => {
    tries += 1;
    const ready = process.platform === "win32" ? true : (() => { try { return fs.existsSync(qzbp.socketPath); } catch (_) { return false; } })();
    if (ready) { clearInterval(iv); qzbpConnect(); if (qzbp.curUrl) { mpvSend(["loadfile", qzbp.curUrl, "replace"]); mpvSend(["set_property", "pause", !qzbp.wantPlaying]); } }
    else if (tries > 50) clearInterval(iv);
  }, 100);
}
function qzbpStop() {
  qzbp.enabled = false;
  try { if (qzbp.sock) qzbp.sock.end(); } catch (_) {}
  try { if (qzbp.proc) qzbp.proc.kill(); } catch (_) {}
  qzbp.sock = null; qzbp.proc = null; qzbp.mode = "off"; qzbp.curUrl = null;
  pwRestore(); // put our streams back on the real sink; never leave a user's audio parked on our null sink
  if (qzbp.feed && qzbp.feed.res) { try { qzbp.feed.res.end(); } catch (_) {} }
  qzbp.feed = null;
  try { if (qzbp.srv) qzbp.srv.close(); } catch (_) {}
  qzbp.srv = null; qzbp.port = 0;
}
function qzbpCommand(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "enable":
      if (!qzbp.enabled) {
        qzbp.enabled = true; qzbp.restarts = 0;
        // Resolve the DAC BEFORE isolating: once the null sink exists it may become the default, and we
        // would then "auto-pick" the very sink we created.
        qzbp.device = alsaDeviceForDefaultSink();
        pwIsolate();
        if (process.platform === "linux" && !pw.timer) pw.timer = setInterval(pwSweep, 2000);
        qzbpSpawn(false);
      }
      break;
    case "disable": qzbpStop(); qzbpEvt({ type: "disabled" }); break;
    case "newtrack": qzbp.wantPlaying = true; qzbpFeedStart(); break;
    case "feed": qzbpFeedChunk(msg.data); break;
    case "endfeed": if (qzbp.feed) { qzbp.feed.done = true; if (qzbp.feed.res) { try { qzbp.feed.res.end(); } catch (_) {} } } break;
    case "play": qzbp.wantPlaying = true; mpvSend(["set_property", "pause", false]); break;
    case "pause": qzbp.wantPlaying = false; mpvSend(["set_property", "pause", true]); break;
    case "seek": mpvSend(["seek", (Number(msg.ms) || 0) / 1000, "absolute"]); break;
    case "stop": mpvSend(["stop"]); qzbp.curUrl = null; qzbp.feed = null; break;
    // volume intentionally NOT mapped to mpv software volume (would break bit-perfect); the renderer greys
    // the slider and volume lives on the DAC/amp. Hardware-mixer mapping is a later refinement.
    default: break;
  }
}

async function createWindow() {
  const ses = session.fromPartition(PARTITION);

  // Serve extension vendor bundles: the extension asks the page origin for
  // /node_modules/@qobuz/qobuz-dwp-ui/dist/qobuzify-ext-<id>.js (404 on Qobuz's server), so
  // redirect that to the loopback server. Redirect to localhost is allowed from https.
  ses.webRequest.onBeforeRequest({ urls: ["*://*/*qobuzify-ext-*.js"] }, (details, cb) => {
    const m = /qobuzify-ext-(.+?)\.js/.exec(details.url || "");
    if (m && VENDORS[m[1]]) return cb({ redirectURL: `http://127.0.0.1:${vendorPort}/qobuzify-ext-${m[1]}.js` });
    cb({});
  });

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: "#0d0d10",
    title: "Qobuzify",
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, "preload.js"),
      sandbox: false,              // preload needs Node to read the payload file
      backgroundThrottling: false, // keep rAF (lyrics render) running when hidden
      contextIsolation: true,
      nodeIntegration: false,
      // Qobuzify's Q.api does a cross-origin fetch to www.qobuz.com from the play.qobuz.com page;
      // with webSecurity on the browser CORS-blocks it (search/For You/etc. fail "Failed to fetch").
      // The desktop app runs the same way (web security off). Safe here: the shell only loads Qobuz.
      webSecurity: false,
    },
  });
  saveState({ stage: "window-created" });

  // Open external links (Qobuz "open in browser" links, any auth popup, help pages) in the user's real
  // browser instead of spawning an in-app child window. Besides being the right behaviour, an unhandled
  // popup window is one more thing that can crash the shell on Linux, so deny it outright.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) { try { shell.openExternal(url); } catch (_) {} }
    return { action: "deny" };
  });

  // Clean lifecycle: clear the (dev-only) probe interval and drop the window reference when it closes,
  // so nothing runs against a destroyed webContents during teardown.
  win.on("closed", () => {
    if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
    if (updateTimer) { clearInterval(updateTimer); updateTimer = null; } // never outlive the window
    win = null;
  });

  setupThumbar(); // Windows taskbar prev/play-pause/next buttons (no-op off win32)

  // Recover if the app ever restores a dead route: /foryou is a fake overlay route (the For You
  // nav opens an overlay, it never really navigates there), so a persisted /foryou lands on
  // /error/404 on next launch. Bounce any such route back to /discover once.
  let recovered = false, crashReloads = 0, crashResetT = null;
  win.webContents.on("did-finish-load", () => {
    const u = win.webContents.getURL();
    saveState({ stage: "loaded", url: u.slice(0, 60) });
    // Look for a newer build once the app has settled, then once a day. Late enough not to compete with
    // the page load, and it only ever runs while a window is alive.
    if (!updateTimer) {
      setTimeout(checkForUpdate, 25000);
      updateTimer = setInterval(checkForUpdate, UPDATE_EVERY_MS);
    }
    if (!recovered && /\/error\/404|\/foryou(\/|$)/.test(u)) {
      recovered = true;
      win.webContents.executeJavaScript(
        "(window.Qobuzify&&Qobuzify.navigate)?Qobuzify.navigate('/discover'):location.replace('https://play.qobuz.com/discover')"
      ).catch(() => {});
    }
  });

  // Crash/hang recovery + diagnostics. Qobuz's big library page has crashed the renderer a few
  // minutes in; log why and reload so the window comes back instead of staying blank/dead.
  win.webContents.on("render-process-gone", (_e, details) => {
    saveState({ stage: "render-gone", reason: details && details.reason, exitCode: details && details.exitCode });
    // Reload to recover, but cap it: if the renderer keeps dying faster than it can stay up (a login
    // that crashes on every attempt), stop reloading instead of looping - that loop is what reads as
    // "crashed twice". The counter resets once the renderer survives 15s, so occasional crashes over a
    // long session still self-heal.
    if (win && crashReloads++ < 5) {
      try { win.webContents.reload(); } catch (_) {}
      clearTimeout(crashResetT);
      crashResetT = setTimeout(() => { crashReloads = 0; }, 15000);
    }
  });
  win.webContents.on("unresponsive", () => {
    saveState({ stage: "unresponsive" });
    try { if (win) win.webContents.reload(); } catch (_) {}
  });
  win.webContents.on("responsive", () => saveState({ stage: "responsive-again" }));

  win.loadURL("https://play.qobuz.com/discover");

  // Dev-only: report state to the file every few seconds so a headless/CDP run is verifiable. This
  // never runs in a shipped build (see the DEBUG note at the top) - an executeJavaScript firing while
  // the window is being destroyed is what segfaults the app on Linux when you click X.
  if (DEBUG) {
    let probing = false;
    probeTimer = setInterval(async () => {
      if (probing || !win) return;
      probing = true;
      try {
        const v = await win.webContents.executeJavaScript(PROBE, true);
        const probes = state.probes.concat([v]).slice(-3);
        saveState({ stage: "running", probes });
      } catch (e) {
        saveState({ stage: "probe-error", error: e && e.message });
      } finally {
        probing = false;
      }
    }, 5000);
  }
}

app.whenReady().then(async () => {
  await startVendorServer();
  saveState({ stage: "vendor-up", vendorPort });
  ipcMain.on("qzbp:cmd", (_e, msg) => { try { qzbpCommand(msg); } catch (_) {} }); // bit-perfect sidecar control
  ipcMain.on("qzbp:feed", (_e, bytes) => { try { qzbpFeedChunk(bytes); } catch (_) {} }); // decrypted FLAC from MSE
  await createWindow();
});

app.on("before-quit", () => { try { qzbpStop(); } catch (_) {} }); // never leave an orphan mpv
app.on("window-all-closed", () => { try { qzbpStop(); } catch (_) {} app.quit(); });
