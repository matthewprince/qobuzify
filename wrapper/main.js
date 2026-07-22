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
const { app, BrowserWindow, Menu, session, shell, nativeImage, ipcMain, Notification } = require("electron");
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
// System media controls (MPRIS on Linux, SMTC on Windows). The media-session extension already fills in
// navigator.mediaSession metadata + action handlers, but that only reaches the OS if Chromium's media
// session service is running - without it nothing registers on D-Bus, so the desktop has no MPRIS player
// to talk to and the keyboard's play/pause/next/prev keys land on nothing. Same single-switch rule as
// disable-features above: gather and set once, or the last call silently wins.
const enableFeatures = ["MediaSessionService", "HardwareMediaKeyHandling"];
app.commandLine.appendSwitch("disable-features", disableFeatures.join(","));
app.commandLine.appendSwitch("enable-features", enableFeatures.join(","));

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
// Direct-stream source: signs track/getFileUrl to hand mpv a plain FLAC CDN URL (see qz-fileurl.js).
const qzfu = require("./qz-fileurl.js");
try { qzfu.setCacheDir(app.getPath("userData")); } catch (_) {}
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
  if (!port) { bpTrace("feedStart FAILED: loopback feed server would not listen"); qzbpEvt({ type: "error", what: "serve" }); return; }
  const prev = qzbp.feed;
  if (prev && prev.res) { try { prev.res.end(); } catch (_) {} }
  qzbp.token += 1;
  qzbp.feed = { token: qzbp.token, chunks: [], res: null, done: false, bytes: 0 };
  qzbp.feedStartedAt = Date.now();   // each track gets its own grace window before the watchdog judges it
  qzbp.curUrl = "http://127.0.0.1:" + port + "/s/" + qzbp.token;
  bpTrace("feedStart: loadfile issued", { url: qzbp.curUrl });
  mpvSend(["loadfile", qzbp.curUrl, "replace"]);
  mpvSend(["set_property", "pause", !qzbp.wantPlaying]);
}
function qzbpFeedChunk(buf) {
  const f = qzbp.feed;
  if (!f || f.done || !buf || !buf.length) return;
  const b = Buffer.from(buf);
  f.chunks.push(b); f.bytes += b.length;
  // Count MEDIA bytes separately. Every track's first chunk is the init segment: a few hundred bytes of
  // ftyp/moov container header carrying zero audio frames. Treating that as "real audio reached the
  // sidecar" meant the header alone declared the feed healthy and permanently disarmed the watchdog below,
  // which is the one thing that catches "page muted, mpv silent". An init segment proves the tap works, not
  // that audio is flowing.
  const isInit = b.length > 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70; // 'ftyp'
  if (!isInit) f.mediaBytes = (f.mediaBytes || 0) + b.length;
  qzbp.lastFeedAt = Date.now();
  if (!f.live && (f.mediaBytes || 0) > 0) { f.live = true; qzbp.stalled = false; bpTrace("LIVE: media bytes reached mpv", { mediaBytes: f.mediaBytes }); qzbpEvt({ type: "live" }); }
  // A whole hi-res track is tens of MB; hold one track's worth so mpv can restart mid-track, no more.
  // Never evict chunks[0]: it is the ftyp/moov init segment, and a replay that starts headerless is
  // undemuxable, so every crash-respawn/reconnect on a long hi-res track would kill the stream.
  if (f.bytes > 320 * 1024 * 1024 && f.chunks.length > 1) { const d = f.chunks.splice(1, 1)[0]; if (d) f.bytes -= d.length; }
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
// --- async probe batch for the 1s watchdog --------------------------------------------------------
// The per-second badge re-verify needs pw-dump/pactl/wpctl output every tick, but execFileSync on the
// Electron main thread stalls IPC, feed chunks and every window event for as long as the daemon takes
// to answer (up to the 4s timeout when it is wedged) - a per-second freeze while bit-perfect is on.
// So the watchdog samples asynchronously, one in-flight batch at a time, and the sync helpers below
// serve from the sampled raw outputs while they are fresh. Parsing and every decision stay exactly as
// they were; only the acquisition moves off the hot path. Cold calls (enable click, a track-boundary
// params event before the first sample) still exec synchronously, which is rare and user-initiated.
const qzbpProbe = { at: 0, out: null, busy: false };
function qzbpExecAsync(cmd, args) {
  return new Promise((resolve) => {
    try {
      require("child_process").execFile(cmd, args, { timeout: 4000, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
        (err, stdout) => resolve(err ? null : stdout));
    } catch (_) { resolve(null); }
  });
}
function qzbpSample(cb) {
  if (process.platform !== "linux") { cb(); return; }
  if (qzbpProbe.busy) return; // batch in flight; the next tick retries
  qzbpProbe.busy = true;
  Promise.all([
    qzbpExecAsync("pw-dump", []),
    qzbpExecAsync("pactl", ["get-default-sink"]),
    qzbpExecAsync("pactl", ["-f", "json", "list", "sinks"]),
    qzbpExecAsync("wpctl", ["inspect", "@DEFAULT_AUDIO_SINK@"]),
    qzbpExecAsync("wpctl", ["get-volume", "@DEFAULT_AUDIO_SINK@"]),
  ]).then(([pwdump, pactlDef, pactlSinks, wpInspect, wpVol]) => {
    qzbpProbe.at = Date.now();
    qzbpProbe.out = { pwdump, pactlDef, pactlSinks, wpInspect, wpVol };
    qzbpProbe.busy = false;
    cb();
  });
}
// Fresh means sampled within 2s: newer than the watchdog period so the hot path never falls through
// to a blocking exec, stale soon enough that a dead watchdog cannot serve old answers for long.
function qzbpProbeFresh() { return qzbpProbe.out && Date.now() - qzbpProbe.at < 2000 ? qzbpProbe.out : null; }

function pactl(args) {
  // Serve the async sample even when its value is null: that command just failed asynchronously, and
  // re-running it synchronously would block on the exact daemon the sampling exists to avoid.
  const p = qzbpProbeFresh(), key = args.join(" ");
  if (p) {
    if (key === "get-default-sink") return p.pactlDef;
    if (key === "-f json list sinks") return p.pactlSinks;
  }
  try { return require("child_process").execFileSync("pactl", args, { timeout: 4000, encoding: "utf8" }); }
  catch (_) { return null; }
}
function pactlJson(args) { try { return JSON.parse(pactl(["-f", "json"].concat(args)) || "null"); } catch (_) { return null; } }

function wpctl(args) {
  const p = qzbpProbeFresh(), key = args.join(" ");
  if (p) {
    if (key === "inspect @DEFAULT_AUDIO_SINK@") return p.wpInspect;
    if (key === "get-volume @DEFAULT_AUDIO_SINK@") return p.wpVol;
  }
  try { return require("child_process").execFileSync("wpctl", args, { timeout: 4000, encoding: "utf8" }); }
  catch (_) { return null; }
}
function alsaDeviceForDefaultSink() {
  if (process.platform !== "linux") return null;
  if (process.env.QZ_BP_DEVICE) return process.env.QZ_BP_DEVICE; // explicit override wins (diagnostics)
  // 1. PulseAudio / pipewire-pulse.
  const def = (pactl(["get-default-sink"]) || "").trim();
  const sinks = pactlJson(["list", "sinks"]);
  if (sinks && sinks.length) {
    // ONLY the sink that is actually default. There used to be an `|| sinks.find(any with alsa.card)`
    // fallback here, which silently returned whichever ALSA sink pactl happened to list first whenever the
    // default sink was virtual (an EasyEffects chain, a null sink, a combine sink, Bluetooth). That is the
    // exact guess the wpctl branch below refuses to make, and because this branch runs first it defeated
    // that policy on any machine with pulseaudio-utils installed. The harm is not theoretical: on a laptop
    // with one card plus a filter chain the guessed card IS the device downstream of the chain, so it is
    // open and clocked at the graph rate, every term of the bit-perfect test passes, and the badge claims
    // bit-perfect over the user's DSP. No sink we can name means no claim.
    const pick = sinks.find((s) => s.name === def && (s.properties || {})["alsa.card"] != null);
    if (pick) {
      const p = pick.properties || {};
      return "alsa/hw:" + p["alsa.card"] + "," + (p["alsa.device"] == null ? 0 : p["alsa.device"]);
    }
  }
  // 2. Bare PipeWire. pactl comes from pulseaudio-utils, which plenty of PipeWire desktops don't install
  //    (Zorin/Ubuntu ship wpctl instead), and without this we would fall through to guessing a card.
  const insp = wpctl(["inspect", "@DEFAULT_AUDIO_SINK@"]);
  if (insp) {
    const c = /alsa\.card = "(\d+)"/.exec(insp), d = /alsa\.device = "(\d+)"/.exec(insp);
    if (c) return "alsa/hw:" + c[1] + "," + (d ? d[1] : 0);
    // The default sink exists but is virtual - a DSP chain (EasyEffects and friends insert a
    // support.null-audio-sink) or some other software node, so it has no card behind it. Do NOT go
    // hunting for a card here: the user deliberately routed their audio through that chain, and the
    // "first card we find" is as likely to be an HDMI monitor as their actual headphones. Bit-perfect
    // through a DSP is a contradiction anyway, so return nothing and let the caller degrade to shared
    // and say so, rather than quietly bypassing their routing or playing out the wrong device.
    return null;
  }
  // 3. Bare ALSA, with no sound server to ask about a default. Only guess here, where there is no
  //    routing to contradict. /proc/asound/pcm lists the card-device pairs that actually exist
  //    ("01-00: USB Audio : playback 1"); the card list alone doesn't, and assuming device 0 is wrong on
  //    plenty of hardware (an NVidia HDMI card's devices start at 3, so hw:0,0 opens nothing at all).
  //    GUARDED by !soundServerPresent(): if a server IS running (bare PipeWire with neither pactl nor
  //    wpctl, or PulseAudio whose default is a virtual/DSP/combine sink), guessing the first hardware card
  //    would name a device the audio is NOT routed to - and the badge would then claim bit-perfect over the
  //    user's filter chain. When a server owns audio and we can't name its sink, the honest answer is null
  //    (-> device-unknown), never a guess. This branch is only correct on genuinely serverless ALSA.
  if (!soundServerPresent()) {
    try {
      const pcm = fs.readFileSync("/proc/asound/pcm", "utf8").split("\n");
      for (const line of pcm) {
        const m = /^(\d+)-(\d+):\s*(.*)$/.exec(line.trim());
        if (!m || !/playback/i.test(m[3]) || /loopback|dummy/i.test(m[3])) continue;
        return "alsa/hw:" + parseInt(m[1], 10) + "," + parseInt(m[2], 10);
      }
    } catch (_) {}
  }
  return null;
}

// ---- can we actually have the device? -----------------------------------------------------------
// An exclusive open is either available or it isn't, and the kernel will tell us for free. Asking first
// matters because mpv does NOT fail loudly when refused: it runs --idle --keep-open, so a refused device
// leaves it alive, idle and silent, and the only symptom is that nothing plays. Every "bit-perfect is on
// but there's no sound" report traces back to spawning into a device someone else already holds.
//
// /proc/asound/cardC/pcmDp/sub0/status is "closed" when the PCM is free and dumps the owner's state when
// it isn't. A sound server configured to keep its PCM open (PipeWire's pro-audio profile sets
// node.pause-on-idle=false, which parks the device open for as long as that profile is selected) will
// therefore read as busy forever, and no amount of retrying changes that.
function pcmPath(device, leaf) {
  const c = alsaCardOf(device), d = alsaDevOf(device);
  if (c == null) return null;
  return "/proc/asound/card" + c + "/pcm" + (d == null ? 0 : d) + "p/sub0/" + leaf;
}
function pcmBusy(device) {
  const p = pcmPath(device, "status");
  if (!p) return false;
  try { return !/^closed\s*$/i.test(fs.readFileSync(p, "utf8").trim()); }
  catch (_) { return false; } // no such node: let the open attempt be the judge
}
// The rate the DAC is actually clocked at right now. This is the ground truth the badge needs: bit-perfect
// is not a mode you select, it is the property "the samples we decoded are the samples the converter is
// clocked for". If the track is 44.1k and the hardware is running 96k, something resampled, and saying
// otherwise is a lie no matter which code path produced it.
function hwRateOf(device) {
  const p = pcmPath(device, "hw_params");
  if (!p) return 0;
  try { const m = /^rate:\s*(\d+)/m.exec(fs.readFileSync(p, "utf8")); return m ? parseInt(m[1], 10) : 0; }
  catch (_) { return 0; }
}
// What the sound server is doing to our samples, read straight from the graph.
//
// Bit-perfect is not only a rate question. A sink whose volume is below unity multiplies every sample,
// and the badge used to ignore that entirely - it reported "Bit-perfect" while the graph scaled by ~0.59.
// The trap that produced that bug is worth writing down, because the properties actively mislead:
// `softVolumes` reading [1.0, 1.0] looks like "the software volume stage is identity", and it is NOT.
// It is a never-written default. A Pro Audio profile synthesizes its mappings from PCM enumeration and
// never builds a mixer path, so there is no hardware element to delegate volume to; `have_soft_volume`
// is therefore never latched, and `set_volume()` falls back to applying `channelVolumes` in software via
// channelmix. Under a normal profile with no hardware volume the server writes softVolumes explicitly and
// the two agree. So: trust `channelVolumes`, which is the gain that reaches the samples either way, and
// never infer unity from softVolumes.
function pwDumpJson() {
  // Prefer the async sample, but only when it actually carries a usable dump. A round where the async
  // pw-dump came back empty/null used to make this return null outright (the `if (p) return` swallowed the
  // sync fallback), so the gain read as "unknown" and the badge sat on "Volume ?" even though pw-dump was
  // perfectly readable. Treat a missing/unparseable sample as "no sample" and fall through to the sync read.
  const p = qzbpProbeFresh();
  if (p && p.pwdump) { try { const j = JSON.parse(p.pwdump); if (Array.isArray(j) && j.length) return j; } catch (_) {} }
  try {
    const out = require("child_process").execFileSync("pw-dump", [], { timeout: 5000, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(out);
  } catch (_) { return null; }
}
// { gain, pro } for the current default sink. gain is the linear multiplier applied to our samples;
// null means "could not determine", which callers must treat as "cannot claim bit-perfect" rather than
// as unity. Cached briefly because params events fire per track and pw-dump is not cheap.
function sinkState() {
  const now = Date.now();
  if (qzbp.sinkCache && now - qzbp.sinkCache.at < 1000) return qzbp.sinkCache.val;
  let val = { gain: null, pro: false };
  const d = pwDumpJson();
  if (d && d.length) {
    // Metadata objects carry their props at the TOP level, not under .info like nodes do. Reading only
    // .info.props finds nothing, which silently drops us to "whichever sink is listed first" - and that
    // read the gain of a completely different device than the one being played to.
    let defName = null;
    for (const n of d) {
      const p = n.props || (n.info || {}).props || {};
      if (p["metadata.name"] !== "default") continue;
      for (const it of n.metadata || []) {
        if (it.key === "default.audio.sink" && it.value) defName = it.value.name || it.value;
      }
    }
    let node = null;
    if (defName) {
      for (const n of d) {
        const p = (n.info || {}).props || {};
        if (p["media.class"] === "Audio/Sink" && p["node.name"] === defName) { node = n; break; }
      }
    }
    // No guessing. If the default sink cannot be identified, the gain stays null and the caller withholds
    // the bit-perfect claim. Picking an arbitrary sink here would produce a confident number about the
    // wrong device, which is worse than admitting we do not know.
    if (node) {
      const p = (node.info || {}).props || {};
      val.pro = String(p["device.profile.pro"]) === "true";
      for (const pr of ((node.info || {}).params || {}).Props || []) {
        if (Array.isArray(pr.channelVolumes) && pr.channelVolumes.length) {
          // Every channel has its own multiplier. Taking the MAX reported the least attenuated channel, so
          // a balance setting of [1.0, 0.72] read as unity and claimed bit-perfect over an audibly lopsided
          // mix. Unity means all of them are 1; anything else is reported as its worst channel, and note
          // that includes values ABOVE 1, which are not "louder but intact" but amplification that clips.
          val.gain = pr.channelVolumes.every((v) => v === 1) ? 1 : Math.min.apply(null, pr.channelVolumes);
        }
        if (pr.mute === true) val.gain = 0;
      }
    }
  }
  // PulseAudio (no PipeWire, so no pw-dump and no wpctl). pactl reports the raw volume, where
  // PA_VOLUME_NORM = 65536 is exactly unity, so this is an EXACT test rather than a rounded one.
  // Without this branch a real-PulseAudio machine could never claim bit-perfect at any volume.
  if (val.gain == null) {
    const j = pactlJson(["list", "sinks"]);
    const def = (pactl(["get-default-sink"]) || "").trim();
    const s = j && j.length && (j.find((x) => x.name === def) || null);
    if (s) {
      if (s.mute === true) val.gain = 0;
      else {
        const vals = Object.keys(s.volume || {}).map((k) => (s.volume[k] || {}).value);
        if (vals.length && vals.every((v) => typeof v === "number")) {
          val.gain = vals.every((v) => v === 65536) ? 1 : Math.min.apply(null, vals) / 65536;
        }
      }
    }
  }
  // Last resort. NOTE wpctl prints the CUBE ROOT of the linear volume, so it has to be cubed back: a
  // reading of 0.35 is a linear gain of ~0.0429, not 0.35. It also prints only two decimals, so anything
  // in [0.995, 1.005) prints "1.00" and cubes to exactly 1 - a band roughly +/-1.5% wide that would be
  // asserted as unity while actually scaling (or amplifying past full scale). Precision we do not have is
  // not a reason to make the claim, so a value that is merely CLOSE to unity reports as unknown and the
  // badge says so. Below that band the number is good enough to show the user what is wrong.
  if (val.gain == null) {
    const t = wpctl(["get-volume", "@DEFAULT_AUDIO_SINK@"]);
    const m = t && /Volume:\s*([0-9.]+)/.exec(t);
    if (m) {
      const g = Math.pow(parseFloat(m[1]), 3);
      val.gain = g > 0.97 ? null : g;   // near unity but unprovable -> unknown; clearly attenuated -> show it
    }
    if (t && /\[MUTED\]/.test(t)) val.gain = 0;
  }
  qzbp.sinkCache = { at: now, val };
  return val;
}
// Bits actually carried by an mpv format name ("s16", "s32", "s24", "float", "double").
function fmtBits(f) {
  const s = String(f || "");
  if (/^floatp?$/.test(s)) return 24;   // f32 carries a 24-bit significand exactly
  if (/^doublep?$/.test(s)) return 53;
  const m = /(\d+)/.exec(s);
  return m ? parseInt(m[1], 10) : 0;
}

function soundServerPresent() {
  if (process.platform !== "linux") return false;
  // Derive the runtime dir from the real uid, not a hardcoded /run/user/1000: a session with uid != 1000 and
  // XDG_RUNTIME_DIR unset would otherwise miss its own server sockets and churn passthrough -> shared.
  const run = process.env.XDG_RUNTIME_DIR || ("/run/user/" + (typeof process.getuid === "function" ? process.getuid() : 1000));
  try { if (fs.existsSync(path.join(run, "pipewire-0"))) return true; } catch (_) {}
  try { if (fs.existsSync(path.join(run, "pulse", "native"))) return true; } catch (_) {}
  return false;
}

// ---- hardware volume ---------------------------------------------------------------------------
// Bit-perfect means mpv holds the DAC exclusively at unity gain, so the desktop's slider is out of the
// path entirely. That is not a gap to paper over with software volume: multiplying the samples is
// exactly what destroys bit-perfection, so a player that "supports" the OS slider in this mode is
// either lying or resampling. The honest control is the one Roon calls Device Volume - leave the bits
// untouched and drive the DAC's OWN mixer, where attenuation happens in hardware downstream of us.
// Plenty of devices are fixed-output with no such element; there we report unsupported rather than
// silently doing nothing, so the renderer can keep the slider greyed and say why.
function amixer(args) {
  try { return require("child_process").execFileSync("amixer", args, { timeout: 4000, encoding: "utf8" }); }
  catch (_) { return null; } // alsa-utils absent, or no such card/element
}
function alsaCardOf(device) { const m = /hw:(\d+)/.exec(String(device || "")); return m ? m[1] : null; }
function alsaDevOf(device) { const m = /hw:\d+,(\d+)/.exec(String(device || "")); return m ? parseInt(m[1], 10) : 0; }
// Which element to move. Order matters: a USB headset leads with PCM while onboard codecs lead with
// Master, and driving the wrong one moves a control the DAC does not actually listen to.
const MIXER_PREF = ["PCM", "Master", "Speaker", "Headphone", "Digital", "Analogue", "Wave", "Front"];
// Returns an amixer-addressable "NAME,INDEX". The index is not decoration: a device with several
// playback PCMs exposes one element per PCM (the Maxwell has 'PCM',0 and 'PCM',1), and a bare "PCM"
// always resolves to index 0. If mpv opened hw:C,1 that would move a control nothing is playing
// through, and the slider would appear dead for no visible reason. So match the element index to the
// ALSA device index when such an element exists, and fall back to the lowest one when it does not.
function alsaMixerElem(card, devIdx) {
  const out = amixer(["-c", card, "scontents"]);
  if (!out) return null;
  const found = [];
  let cur = null;
  for (const line of out.split("\n")) {
    const s = /^Simple mixer control '([^']+)',(\d+)/.exec(line.trim());
    if (s) { cur = { name: s[1], idx: parseInt(s[2], 10), pvolume: false }; found.push(cur); continue; }
    if (cur && /Capabilities:.*\bpvolume\b/.test(line)) cur.pvolume = true; // playback volume, not just a switch
  }
  const usable = found.filter((f) => f.pvolume);
  if (!usable.length) return null;
  let name = null;
  for (const p of MIXER_PREF) if (usable.some((u) => u.name === p)) { name = p; break; }
  if (!name) name = usable[0].name;
  const sameName = usable.filter((u) => u.name === name);
  const hit = sameName.find((u) => u.idx === devIdx) || sameName[0];
  return name + "," + hit.idx;
}
// -M asks ALSA for its MAPPED (perceptual) scale instead of the raw index. It matters here: these raw
// steps are ~1dB each, so a raw-linear slider crams everything usable into the top few percent and
// leaves the bottom half inaudible, which is the unusable curve this is meant to fix.
function hwVolRead(card, elem) {
  const out = amixer(["-M", "-c", card, "sget", elem]);
  const m = out && /\[(\d+)%\]/.exec(out);
  return m ? parseInt(m[1], 10) : null;
}
function hwVolWrite(card, elem, pct) {
  const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  return amixer(["-M", "-c", card, "sset", elem, v + "%"]) != null;
}
// Resolve the mixer for whatever device mpv is about to open, and tell the renderer whether it has a
// usable knob. Called on enable, so a device change is picked up on the next toggle.
function qzbpDetectMixer() {
  qzbp.mixer = null;
  if (process.platform !== "linux") return;
  const card = alsaCardOf(qzbp.device);
  if (!card) return;
  const elem = alsaMixerElem(card, alsaDevOf(qzbp.device));
  if (elem) qzbp.mixer = { card, elem };
}

// Bit-perfect leaves no trace when it fails, and the failure is invisible from the outside: an idle mpv
// and a muted page look exactly like a healthy quiet app. Keep a tiny always-on breadcrumb file so a
// failure can be diagnosed after the fact without the user opening DevTools. QZ_DEBUG ONLY: a shipped
// build writes nothing at all. To collect it, launch once with QZ_DEBUG=1.
const BP_DIAG = path.join(app.getPath("userData"), "qz-bp-diag.json");
const bpDiag = [];
function bpTrace(stage, extra) {
  if (!DEBUG) return;   // never in a shipped build - same gate as the qz-state.json probe above
  try {
    bpDiag.push(Object.assign({ t: new Date().toISOString(), stage }, extra || {}));
    while (bpDiag.length > 40) bpDiag.shift();
    fs.writeFileSync(BP_DIAG, JSON.stringify(bpDiag, null, 1));
  } catch (_) {}
}

// Watchdog. Enabling bit-perfect mid-track could leave the app in a state that is impossible in a healthy
// system and invisible in a broken one: the web element muted, mpv holding the DAC exclusively, and no
// bytes ever reaching it, so the user hears nothing and NOTHING reports an error. That happens because the
// feed only starts on an 'ftyp' init segment, and a track that is already buffered never appends one.
// If we are enabled and the player says it is playing but no audio has reached mpv, say so and stand down.
const STALL_MS = 2500;   // long enough for a real exclusive open, short enough not to be a noticeable gap
function qzbpStallCheck() {
  // Re-verify the WHOLE badge on this timer, BEFORE the guards below - not just the gain. mpv only emits
  // audio-params at a track boundary, but the three things the verdict rests on can all move mid-track with
  // no mpv event: the default sink can switch (wired -> Bluetooth, DAC-A -> DAC-B), the graph can re-pin the
  // same card to a new rate (96k -> 48k, which keeps the hw:C,D string identical so the device alone would
  // miss it), and the sink volume can change. Signature over device + hardware rate + gain catches all three;
  // re-emitting only on a change keeps this to one probe batch per second and no IPC spam. A sink we can no
  // longer name resolves to device-unknown - an honest degrade, never a stale claim. The probes run through
  // the async qzbpSample batch, so this tick never blocks the main thread on a subprocess; the logic below
  // reads the sampled outputs through the same helpers and is otherwise unchanged. NOT while stalled: after
  // a downgrade the audio path is the unmuted web element through the shared mixer, and re-emitting the dead
  // stream's params on a signature change could hand the badge a bit-perfect claim that is false.
  if (qzbp.enabled && qzbp.mode === "passthrough" && !qzbp.stalled && (qzbp.srcParams || qzbp.outParams)) {
    qzbpSample(() => {
      // state can move while the sample is in flight; re-check before emitting anything from it
      if (!(qzbp.enabled && qzbp.mode === "passthrough" && !qzbp.stalled && (qzbp.srcParams || qzbp.outParams))) return;
      const g = sinkState().gain;
      const dev = alsaDeviceForDefaultSink();
      const hw = dev ? hwRateOf(dev) : 0;
      const sig = dev + "|" + hw + "|" + g;
      if (sig !== qzbp.lastParamSig) { qzbp.lastParamSig = sig; qzbp.lastGain = g; qzbpReportParams(); }
    });
  }
  if (!qzbp.enabled || !qzbp.wantPlaying || qzbp.stalled) return;
  // "No media bytes reached mpv" is NO LONGER a failure to alarm on. The renderer now mutes the web element
  // only on the `live` event (real audio in mpv), so "no bytes" simply means bit-perfect has not engaged yet
  // - the browser is still playing the track normally, nothing is silent, nothing needs rescuing. It engages
  // on its own when a feedable track (mid-playback, or the next track's init) starts flowing. So the old
  // "no bytes -> STALLED -> couldn't start" path is gone; it only ever fired on the harmless waiting state
  // and scared the user off a feature that was about to work on the next track.
  //
  // The one genuine failure left is: audio DID reach mpv (we went live, so we muted) but mpv then sat idle
  // producing nothing. That would be real silence. Catch only that: live-but-idle past the grace.
  const f = qzbp.feed;
  if (!f || !f.live) return;                         // never went live -> not committed -> nothing to rescue
  if (!qzbp.coreIdle) return;                        // mpv is playing -> fine
  // Grace runs from the LAST FEED ACTIVITY too, not just feedStart/enable. Measured failure (Faithfully,
  // 2026-07-20 trace): the page stalled its appends for 10.8s, bytes resumed, and this check fired 41ms
  // after the resume - before mpv could flip core-idle - killing a stream that was actively recovering.
  // A feed that is receiving bytes is by definition not the "went live then sat idle" corpse this hunts.
  const since = Math.max(qzbp.enabledAt || 0, qzbp.feedStartedAt || 0, qzbp.lastFeedAt || 0);
  if (Date.now() - since < STALL_MS) return;
  qzbp.stalled = true;
  bpTrace("STALLED: mpv went live then sat idle", { device: qzbp.device, mode: qzbp.mode });
  try { mpvSend(["stop"]); } catch (_) {}
  // The stopped stream's params must not survive it: nothing is measured any more, and stale numbers
  // are exactly what the re-verify's stall gate exists to keep away from the badge.
  qzbp.srcParams = null; qzbp.outParams = null;
  qzbpEvt({ type: "stalled", why: "audio reached the bit-perfect sidecar but it stopped producing sound" });
}

// DELIBERATELY REMOVED: the null-sink isolation layer (pwIsolate / pwSweep / pwRestore).
//
// It used to `pactl load-module module-null-sink`, then re-parent this app's streams onto that phantom
// sink and keep sweeping every 2s to catch new ones, undoing it all on exit. Two reasons it is gone and
// must not come back:
//
//  1. IT IS NOT NEEDED. Measured directly (see the arch-repro notes): PipeWire hands the hw: device to an
//     exclusive mpv client while STILL clocking the other stream - the muted <audio> keeps ticking, so
//     progress, scrobble, MediaSession and auto-advance all survive with no null sink anywhere.
//  2. IT MUTATES SOMEONE ELSE'S AUDIO GRAPH. Loading modules and moving sink-inputs is not ours to do on
//     a machine doing real audio work, and an unclean exit strands the user's streams on a sink that no
//     longer exists.
//
// Bit-perfect now takes the DAC the only way it should: mpv opens hw: exclusively and everything else is
// left exactly as the user configured it. No modules, no moves, no sweeps, no profile changes, nothing
// touched in PipeWire at all.

function mpvArgs(sockPath, mode) {
  const a = ["--idle=yes", "--no-video", "--no-terminal", "--no-config", "--keep-open=yes",
    "--input-ipc-server=" + sockPath, "--gapless-audio=weak", "--replaygain=no",
    "--af=", "--volume=100", "--volume-max=100", "--audio-samplerate=0", "--audio-channels=stereo",
    // The feed is a chunked HTTP body with no Content-Length, so the stream itself can't Range-seek.
    // A demuxer cache big enough for a whole hi-res track is what makes scrubbing work at all.
    // Plain byte counts, not "768MiB": the suffixed form is a FATAL parse error on mpv < 0.33 (Debian 11,
    // Ubuntu 20.04, Mint 20, Pop 20.04 all ship 0.32), and the error text does not match the open-failure
    // regex, so a system-mpv fallback there would crash-loop into `fatal`. 805306368 = 768*1024*1024 exactly;
    // parses on both sides of the 0.33 boundary and is a no-op on the bundled 0.41.
    "--cache=yes", "--demuxer-max-bytes=805306368", "--demuxer-max-back-bytes=805306368",
    "--user-agent=Mozilla/5.0"];
  if (mode === "shared") { // last resort: no device we can name and no server to hand it to
    if (process.platform === "linux") a.push("--ao=pipewire,pulse,alsa");
    else if (process.platform === "darwin") a.push("--ao=coreaudio");
    else a.push("--ao=wasapi");
    return a;
  }
  // Passthrough: hand the decoded stream to the sound server at its NATIVE rate and unity gain, aimed at
  // whatever the user's default sink currently is. This is the mode that matters on a normal Linux desktop.
  //
  // It is not a consolation prize for failing to get exclusive access. When the server's graph is running
  // at the track's rate, it has nothing to do to our samples: no resample, no gain, only the format widening
  // the DAC asked for - which is bit-exact. When the graph is at a different rate it resamples, and the
  // badge says so rather than claiming a bit-perfect path that isn't. Either way the user's routing, sample
  // rate policy, profile and graph are entirely theirs; we follow them and never reconfigure anything.
  //
  // Deliberately NOT naming a device here: leaving it default means switching sinks mid-track follows,
  // which is the whole point of "follow whatever I do with the server".
  // Three outputs, in order, because the first one is not as reliable as it looks: the bundled mpv links a
  // much newer libpipewire than most desktops are running, and a client newer than the daemon fails to
  // initialize outright ("Failed to initialize audio driver 'pipewire'"), so in practice almost everyone
  // lands on the second entry. That is fine - pipewire-pulse hands the stream to the same graph at the same
  // rate, verified end to end - but it means the list is load-bearing rather than decorative, and a system
  // running bare PipeWire with no pulse compat needs the third entry or it gets no audio at all.
  // Note the fallback text does NOT match the open-failure patterns watched below, so walking down this
  // list never looks like a refused device and never triggers a mode change.
  if (mode === "passthrough") {
    a.push("--ao=pipewire,pulse,alsa", "--audio-exclusive=no");
    return a;
  }
  // Exclusive: name the hw: device explicitly. Left to itself mpv opens ALSA "default", which on any
  // PipeWire/Pulse desktop is their plug: it accepts every rate and resamples, so we would claim
  // bit-perfect and not be. Only ever chosen when we have already confirmed the PCM is free.
  if (process.platform === "linux" && qzbp.device) a.push("--audio-device=" + qzbp.device);
  if (process.platform === "linux") a.push("--ao=alsa", "--audio-exclusive=yes");
  else if (process.platform === "darwin") a.push("--ao=coreaudio", "--audio-exclusive=yes");
  else a.push("--ao=wasapi", "--audio-exclusive=yes");
  return a;
}
// Which output path can actually work right now, decided from the system's own state rather than tried
// and hoped for. Order is best-audio-first, but every step has to be true, not merely plausible.
function pickMode() {
  if (process.platform !== "linux") return "exclusive"; // CoreAudio/WASAPI negotiate exclusivity themselves
  // If a sound server owns the card, go THROUGH it - always. The old code grabbed the raw device whenever
  // pcmBusy() read "free", but on a PipeWire desktop "free" is a lie in motion: muting the web element (which
  // enabling bit-perfect does) makes the server suspend the sink for a beat, so the PCM flickers to "closed"
  // exactly at enable time. pickMode then chose exclusive, the server immediately re-took the device, and mpv's
  // exclusive open lost the race - silence, or "couldn't play, playing normally". Passthrough at the graph's
  // rate is byte-perfect when the rates match and, crucially, ALWAYS opens. The device-grab is only correct
  // where there is genuinely no server to contend with (bare ALSA).
  if (soundServerPresent()) return "passthrough";
  if (qzbp.device && !pcmBusy(qzbp.device)) return "exclusive";
  return qzbp.device ? "exclusive" : "shared";
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
// Decide, and report, whether the samples reaching the converter are the samples in the file. Every term
// here exists because its absence produced a wrong badge: the predicate used to be `decodedRate == hwRate`
// alone, which claims bit-perfect while the graph applies a gain, while mpv silently converts internally,
// or while pointing at a card the audio no longer goes to.
function qzbpReportParams() {
  const src = qzbp.srcParams, out = qzbp.outParams || qzbp.srcParams;
  if (!out) return;

  // Re-resolve the device every time in passthrough. mpv is given NO --audio-device there so it follows
  // the default sink, but this used to verify against whatever sink was default at enable time. Move the
  // default (or unplug the DAC) and it reads hw_params from a card the audio is not going to any more.
  // Assign UNCONDITIONALLY. Guarding this with `if (dev)` made the fix cover only the success case: when
  // re-resolution returns null - a Bluetooth sink, a virtual default, neither pactl nor wpctl present - the
  // old device silently persisted. That is worse than useless on a pro-audio profile, because such a PCM is
  // held open forever, so /proc keeps reporting RUNNING at its old rate even when nothing is routed there,
  // and the rate check passes against a card the audio has left. Move to Bluetooth mid-session and the badge
  // would read "Bit-perfect" over an SBC link. A null device makes hwRateOf() return 0, which withholds the
  // claim, which is the correct answer to "we cannot tell".
  if (qzbp.mode === "passthrough") {
    const prevDevice = qzbp.device;
    qzbp.device = alsaDeviceForDefaultSink();
    // Retarget the hardware volume mixer when the DAC changes. qzbpDetectMixer() otherwise runs only at
    // enable, so after a mid-session sink switch the slider kept driving the PREVIOUS card's ALSA mixer.
    // Re-detect on change and tell the renderer, so the slider tracks the DAC that is actually playing (or
    // greys out if the new one has no hardware volume element).
    if (qzbp.device !== prevDevice) {
      qzbpDetectMixer();
      qzbpEvt(qzbp.mixer
        ? { type: "hwvol", supported: true, pct: hwVolRead(qzbp.mixer.card, qzbp.mixer.elem), elem: qzbp.mixer.elem }
        : { type: "hwvol", supported: false });
    }
  }
  const rate = out.samplerate || 0;
  const hw = qzbp.mode === "shared" ? 0 : hwRateOf(qzbp.device);

  // In exclusive mode mpv holds the PCM itself, so no server gain sits in the path. In passthrough the
  // server's sink gain multiplies our samples, and an unknown gain must NOT be optimistically treated as
  // unity: unverified is a reason to withhold the claim, not to make it.
  const st = qzbp.mode === "passthrough" ? sinkState() : { gain: 1, pro: false };
  const gain = st.gain;

  // mpv converting between the decoder and the output is invisible in audio-params. If the rates differ,
  // mpv resampled; if the output carries fewer bits than the decode, mpv narrowed.
  const converted = !!(src && out && (src.samplerate !== out.samplerate || fmtBits(out.format) < fmtBits(src.format)));

  const rateOk = !!(rate && hw && rate === hw);
  const gainOk = gain === 1;
  const bitperfect = rateOk && gainOk && !converted;

  // ALL the reasons, not the first one. A single scalar with gain checked last meant a rate mismatch
  // masked a volume problem entirely - and a graph pinned to one rate while the sink sits below 100% is
  // the default state of a stock desktop, so the masked case was the common one. The user would repin
  // their graph, restart the track, and only then discover volume was also breaking it.
  const why = [];
  if (!bitperfect) {
    if (converted) why.push("convert");
    if (!rateOk) why.push(hw ? "rate" : "device-unknown");
    if (gain == null) why.push("gain-unknown"); else if (gain !== 1) why.push("gain");
  }
  qzbpEvt({
    type: "params", rate, format: out.format, channels: out["channel-count"],
    mode: qzbp.mode, hwRate: hw, bitperfect, why, gain, pro: st.pro,
    srcRate: src ? src.samplerate : rate,
  });
}
// Wire an ALREADY-CONNECTED IPC socket into the relay. The caller (the connect poller in qzbpSpawn)
// owns establishing the connection, because on win32 the only reliable probe for the named pipe IS a
// connect attempt; by the time this runs the transport is up on every platform.
function qzbpConnect(s) {
  qzbp.sock = s;
  // observe the properties that drive the UI badge + gapless/scrobble reconciliation
  mpvSend(["observe_property", 1, "time-pos"]);
  mpvSend(["observe_property", 2, "audio-params"]);
  mpvSend(["observe_property", 3, "eof-reached"]);
  mpvSend(["observe_property", 4, "core-idle"]);
  // audio-params is the DECODER side. audio-out-params is what the audio output actually negotiated.
  // Comparing the decoder against the hardware (which is what this did) can report bit-perfect straight
  // across a conversion mpv did itself: if the output refuses a rate or format, mpv silently converts and
  // audio-params never mentions it. Watch both and require them to agree.
  mpvSend(["observe_property", 5, "audio-out-params"]);
  qzbpEvt({ type: "ready", mode: qzbp.mode });
  s.on("data", (d) => {
    qzbp.buf += d.toString("utf8");
    let i;
    while ((i = qzbp.buf.indexOf("\n")) >= 0) {
      const line = qzbp.buf.slice(0, i); qzbp.buf = qzbp.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch (_) { continue; }
      if (m.event === "property-change") {
        if (m.name === "time-pos" && m.data != null) qzbpEvt({ type: "position", ms: Math.round(m.data * 1000) });
        else if (m.name === "audio-params" || m.name === "audio-out-params") {
          if (m.data) {
            if (m.name === "audio-params") qzbp.srcParams = m.data; else qzbp.outParams = m.data;
            qzbpReportParams();
          } else {
            // mpv unloaded the stream (stop command, watchdog kill): a cleared property clears our
            // copy, or the re-verify timer keeps treating the dead stream's rates as measurements.
            if (m.name === "audio-params") qzbp.srcParams = null; else qzbp.outParams = null;
          }
        }
        else if (m.name === "core-idle") qzbp.coreIdle = m.data === true; // true = mpv not producing audio (paused/buffering/idle)
        else if (m.name === "eof-reached" && m.data === true) qzbpEvt({ type: "ended" });
      } else if (m.event === "end-file" && m.reason === "error") {
        qzbpEvt({ type: "error", what: "load" });
      }
    }
  });
  s.on("error", () => {});
  // Only clear the live handle when it is still THIS socket: a respawn may already own qzbp.sock.
  s.on("close", () => { if (qzbp.sock === s) qzbp.sock = null; });
}
// Where to go when a mode turns out not to work. Never a dead end: the last stop always produces audio.
function nextMode(mode) {
  if (mode === "exclusive") return soundServerPresent() ? "passthrough" : "shared";
  if (mode === "passthrough") return "shared";
  return null;
}
function qzbpSpawn(mode) {
  const bin = mpvBinary();
  qzbp.mode = mode;
  qzbp.socketPath = qzbpSocketPath();
  try { if (process.platform !== "win32" && fs.existsSync(qzbp.socketPath)) fs.unlinkSync(qzbp.socketPath); } catch (_) {}
  let proc;
  try { proc = spawn(bin, mpvArgs(qzbp.socketPath, mode), { stdio: ["ignore", "ignore", "pipe"] }); }
  catch (e) { qzbpEvt({ type: "error", what: "spawn", msg: String(e && e.message) }); return; }
  qzbp.proc = proc;
  // spawn() does NOT throw synchronously when the binary is missing: it returns a ChildProcess and emits
  // 'error' asynchronously, so the try/catch above never sees ENOENT. With no listener that becomes an
  // unhandled EventEmitter 'error' and takes down the whole main process. Reachable in the deb/rpm builds,
  // which declare mpv as a dependency and resolve a bare `mpv` from PATH rather than shipping one. ENOENT
  // also emits 'close' rather than 'exit', so the respawn ladder below never runs either.
  proc.on("error", (e) => {
    if (qzbp.proc !== proc) return;
    qzbp.proc = null; qzbp.sock = null; qzbp.enabled = false;
    bpTrace("sidecar spawn failed", { bin, msg: e && e.message });
    qzbpEvt({ type: "error", what: "spawn", msg: String((e && e.message) || e) });
  });
  // Watch stderr for an output-open failure. pcmBusy() already rules out the common case before we spawn,
  // but it cannot rule out every one (a race against another client, a DAC that rejects the rate, a device
  // that disappears), so the runtime check stays as the backstop.
  let sawOpenFail = false;
  if (proc.stderr) proc.stderr.on("data", (d) => {
    const t = d.toString();
    if (sawOpenFail || !nextMode(mode)) return;
    if (!/Failed to open|cannot open|Device or resource busy|EBUSY|could not open|Could not open/i.test(t)) return;
    sawOpenFail = true;
    // mpv runs --idle=yes --keep-open=yes, so it does NOT exit when the audio device is refused: it sits
    // there alive, idle, holding nothing and playing nothing. Waiting for the 'exit' handler to degrade
    // therefore never fired, which is exactly the "enabled, playing, mpv idle-active, silence" state.
    // Killing it here is what turns a permanent silence into a mode change.
    bpTrace("output open REFUSED", { mode, device: qzbp.device, busy: /Device or resource busy|EBUSY/i.test(t) });
    try { proc.kill(); } catch (_) {}
  });
  proc.on("exit", (code) => {
    qzbp.sock = null; qzbp.proc = null;
    if (!qzbp.enabled) return; // intentional stop
    if (sawOpenFail) {
      // Degrade one step and tell the renderer, which re-feeds the current track into the new process.
      // The old code degraded to "shared" and left the renderer unmuted-and-stalled, so the track that
      // was playing when the device was refused never resumed anywhere: that is the silence.
      const next = nextMode(mode);
      qzbp.restarts = 0;
      qzbpEvt({ type: "mode", mode: next });
      qzbpSpawn(next);
      return;
    }
    // crash: respawn a few times, then give up and tell the renderer to unmute so audio never fully drops
    const now = Date.now();
    if (now - qzbp.restartAt > 20000) qzbp.restarts = 0;
    if (qzbp.restarts++ < 4) { qzbp.restartAt = now; qzbpSpawn(mode); }
    else { qzbp.enabled = false; qzbpEvt({ type: "fatal" }); }
  });
  // Connect once the IPC endpoint exists. On unix the socket file's existence is a cheap gate; on
  // win32 there is no reliable probe for a named pipe (opening one consumes a server instance), so
  // the probe IS the connect attempt: try each tick and retry on failure until mpv creates the pipe.
  // Either way an exhausted budget must SAY so: giving up silently left mpv running with no
  // observe/loadfile relay and the renderer waiting on "Bit-perfect..." forever.
  let tries = 0, connecting = false;
  const iv = setInterval(() => {
    if (qzbp.proc !== proc) { clearInterval(iv); return; } // this spawn is gone; stop probing its socket
    if (connecting) return;
    tries += 1;
    if (process.platform !== "win32") {
      let there = false;
      try { there = fs.existsSync(qzbp.socketPath); } catch (_) {}
      if (!there) {
        if (tries > 50) { clearInterval(iv); qzbpEvt({ type: "error", what: "ipc" }); }
        return;
      }
    }
    connecting = true;
    let s;
    try { s = net.connect(qzbp.socketPath); } catch (_) { connecting = false; return; }
    const onErr = () => {
      connecting = false;
      try { s.destroy(); } catch (_) {}
      if (qzbp.proc !== proc) { clearInterval(iv); return; }
      if (tries > 50) { clearInterval(iv); qzbpEvt({ type: "error", what: "ipc" }); }
    };
    s.once("error", onErr);
    s.once("connect", () => {
      s.removeListener("error", onErr);
      clearInterval(iv);
      qzbpConnect(s);
      if (qzbp.curUrl) { mpvSend(["loadfile", qzbp.curUrl, "replace"]); mpvSend(["set_property", "pause", !qzbp.wantPlaying]); }
    });
  }, 100);
}
function qzbpStop() {
  qzbp.enabled = false;
  if (qzbp.stallTimer) { clearInterval(qzbp.stallTimer); qzbp.stallTimer = null; }
  qzbp.stalled = false;
  try { if (qzbp.sock) qzbp.sock.end(); } catch (_) {}
  try { if (qzbp.proc) qzbp.proc.kill(); } catch (_) {}
  qzbp.sock = null; qzbp.proc = null; qzbp.mode = "off"; qzbp.curUrl = null;
  // Stale negotiated params outlive the sidecar that reported them, and a badge computed from the last
  // session's numbers is exactly the kind of quiet wrongness this whole change is removing.
  qzbp.srcParams = null; qzbp.outParams = null; qzbp.sinkCache = null; qzbp.lastGain = undefined; qzbp.lastParamSig = undefined;
  if (qzbp.feed && qzbp.feed.res) { try { qzbp.feed.res.end(); } catch (_) {} }
  qzbp.feed = null;
  try { if (qzbp.srv) qzbp.srv.close(); } catch (_) {}
  qzbp.srv = null; qzbp.port = 0;
}
// The page went away without an orderly "disable": Ctrl+R reload, the crash auto-reload, any real
// navigation. The renderer half of the protocol is gone, but the feed server and its chunks live
// main-side, so mpv would keep playing the buffered track over whatever the fresh page shows, and
// the reloaded extension's "enable" used to be swallowed by the already-enabled guard (no mode
// event, no hwvol, hardware slider dead for the session). Reset fully; the fresh page's enable then
// walks the normal path and everything resynchronizes.
function qzbpPageGone() {
  if (!qzbp.enabled) return;
  qzbpStop();
}
function qzbpCommand(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "enable":
      if (!qzbp.enabled) {
        qzbp.enabled = true; qzbp.restarts = 0;
        // Read-only: this only ASKS which sink is default so we can name its hw: device. Nothing about
        // the user's routing, profile or PipeWire graph is changed here or anywhere else.
        qzbp.device = alsaDeviceForDefaultSink();
        // Pick the output path from the system's current state instead of always reaching for exclusive
        // and discovering the hard way. Grabbing the PCM is only the best option when the PCM is free;
        // where a sound server holds it open by policy - which is the normal case on a PipeWire desktop,
        // and permanent under a pro-audio profile - the exclusive attempt cannot ever succeed, and the
        // old code spent a spawn, a refusal, a kill and a respawn per enable to find that out, leaving a
        // window of silence each time. Going straight through the server is both instant and, at a
        // matching graph rate, byte-identical at the converter.
        const mode = pickMode();
        qzbpEvt({ type: "mode", mode });
        // Tell the renderer whether this DAC has a hardware knob, so the slider can go live instead of
        // staying greyed. Report the CURRENT hardware level too: the device keeps its own state across
        // launches, so the slider must adopt the hardware's position rather than assume its own.
        qzbpDetectMixer();
        qzbpEvt(qzbp.mixer
          ? { type: "hwvol", supported: true, pct: hwVolRead(qzbp.mixer.card, qzbp.mixer.elem), elem: qzbp.mixer.elem }
          : { type: "hwvol", supported: false });
        qzbp.enabledAt = Date.now(); qzbp.stalled = false; qzbp.lastFeedAt = 0;
        bpTrace("enable", { mode, device: qzbp.device || "none", busy: qzbp.device ? pcmBusy(qzbp.device) : null, mixer: qzbp.mixer ? qzbp.mixer.elem : null });
        if (!qzbp.stallTimer) qzbp.stallTimer = setInterval(qzbpStallCheck, 1000);
        qzbpSpawn(mode);
      } else {
        // A repeated enable means a renderer that lost sync with us (a reload path the navigation
        // hooks did not catch). Swallowing it silently left that renderer with no mode, a dead
        // hardware-volume slider and a badge stuck waiting; re-emit the snapshot it needs instead.
        qzbpEvt({ type: "mode", mode: qzbp.mode });
        qzbpEvt(qzbp.mixer
          ? { type: "hwvol", supported: true, pct: hwVolRead(qzbp.mixer.card, qzbp.mixer.elem), elem: qzbp.mixer.elem }
          : { type: "hwvol", supported: false });
      }
      break;
    case "disable": qzbpStop(); qzbpEvt({ type: "disabled" }); break;
    // A new track is NOT the same thing as "the user pressed play". This assumed it was, and the init
    // segment the web player buffers while restoring a paused session at launch was enough to start the
    // sidecar playing into a paused UI. Take the renderer's actual transport state; only default to
    // playing when an older renderer did not send one.
    case "newtrack":
      qzbp.wantPlaying = (typeof msg.playing === "boolean") ? msg.playing : true;
      bpTrace("newtrack received from renderer", { playing: qzbp.wantPlaying });
      qzbpFeedStart();
      break;
    case "feed": qzbpFeedChunk(msg.data); break;
    case "endfeed": if (qzbp.feed) { qzbp.feed.done = true; if (qzbp.feed.res) { try { qzbp.feed.res.end(); } catch (_) {} } } break;
    // DIRECT SOURCE: mpv streams a signed FLAC CDN URL instead of the tap feed. No feed server, no ftyp
    // guessing, no starvation - mpv owns the stream and Range-seeks it. The renderer sends this on a real
    // track change (store id is authoritative); a stale request is dropped by the token counter so a
    // rapid skip can't play the wrong URL.
    case "directtrack": {
      qzbp.wantPlaying = (typeof msg.playing === "boolean") ? msg.playing : true;
      qzbp.feed = null; // this stream is URL-driven; make sure no old feed lingers
      const dseq = (qzbp.dseq = (qzbp.dseq || 0) + 1);
      const startMs = Number(msg.startMs) || 0;
      bpTrace("directtrack: resolving", { trackId: msg.trackId, playing: qzbp.wantPlaying });
      qzfu.resolve({ token: msg.token, trackId: msg.trackId, appId: msg.appId, bundleUrl: msg.bundleUrl, formatId: 27 })
        .then((r) => {
          if (dseq !== qzbp.dseq) return;                 // a newer track superseded this resolve
          if (!r.ok) { bpTrace("directtrack: resolve failed", { reason: r.reason }); qzbpEvt({ type: "directfail", reason: r.reason }); return; }
          qzbp.curUrl = r.url;
          mpvSend(["loadfile", r.url, "replace"]);
          if (startMs > 250) mpvSend(["seek", startMs / 1000, "absolute"]);
          mpvSend(["set_property", "pause", !qzbp.wantPlaying]);
          bpTrace("directtrack: loaded", { fmt: r.formatId, bit: r.bitDepth, rate: r.rate });
        })
        .catch((e) => { if (dseq === qzbp.dseq) qzbpEvt({ type: "directfail", reason: "network", detail: String(e && e.message || e) }); });
      break;
    }
    case "play": qzbp.wantPlaying = true; mpvSend(["set_property", "pause", false]); break;
    case "pause": qzbp.wantPlaying = false; mpvSend(["set_property", "pause", true]); break;
    case "seek": mpvSend(["seek", (Number(msg.ms) || 0) / 1000, "absolute"]); break;
    // Stale params must not outlive the stream they measured (the mpv-side property clear also
    // handles this, but only while the socket is up).
    case "stop": mpvSend(["stop"]); qzbp.curUrl = null; qzbp.feed = null; qzbp.srcParams = null; qzbp.outParams = null; break;
    // Volume is still NEVER mapped to mpv's software volume - that multiplies the samples and is exactly
    // what breaks bit-perfect. It goes to the DAC's own hardware mixer instead, so the bits we send stay
    // untouched and the attenuation happens downstream in the device.
    case "volume":
      if (qzbp.mixer && hwVolWrite(qzbp.mixer.card, qzbp.mixer.elem, msg.pct)) {
        qzbpEvt({ type: "hwvol", supported: true, pct: hwVolRead(qzbp.mixer.card, qzbp.mixer.elem), elem: qzbp.mixer.elem });
      }
      break;
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
    // Electron's default application menu ("File Edit View Window Help") lives in the client area, not the
    // window decoration, so fullscreen strips the title bar but leaves that menu bar sitting there - which
    // reads as "fullscreen isn't really fullscreen" on Linux. Hiding it makes F11 fill the whole screen.
    // The menu still exists (Alt reveals it), so its accelerators - F11 fullscreen, Ctrl+Shift+I devtools,
    // reload, zoom - keep working; only the persistent bar goes away. No-op on macOS (menu is in the global
    // bar) and harmless on Windows, so it is set unconditionally to keep one window across platforms.
    autoHideMenuBar: true,
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

  // Reliable fullscreen. setFullScreen itself works on Linux (proven), but the trigger was the problem:
  // Electron's default menu binds F11 through the accelerator path, which some Linux WMs swallow (the
  // "F11 does nothing / it's never really fullscreen" report), and the only other entry point was the
  // lyrics view's fullscreen button - so the now-playing screen and plain pages had no way in at all.
  // Bind F11 ourselves at the raw-input level so it fires from ANY view and toggles the OS window directly,
  // and replace the default menu with a minimal one that deliberately does NOT bind F11 (so the input path
  // and an accelerator can't double-toggle and cancel out). autoHideMenuBar keeps this menu off-screen
  // until Alt; it still carries devtools/reload/zoom so nothing useful is lost.
  const toggleFullScreen = () => { try { if (win) win.setFullScreen(!win.isFullScreen()); } catch (_) {} };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "fileMenu" },
    { role: "editMenu" },
    { label: "View", submenu: [
      { label: "Toggle Full Screen (F11)", click: toggleFullScreen },
      { type: "separator" },
      { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
    ] },
    { role: "windowMenu" },
  ]));
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "F11" && !input.isAutoRepeat) {
      toggleFullScreen();
      event.preventDefault();
    }
  });

  // Tell the page when the window's fullscreen state actually changes, whatever caused it (the lyrics
  // button, F11, or the window manager). The lyrics view draws an expand/collapse icon and only knew
  // about its own clicks, so any other route left the icon lying about the real state.
  const sendFsState = (v) => { try { if (win && !win.isDestroyed()) win.webContents.send("qz:fullscreen-changed", v); } catch (_) {} };
  win.on("enter-full-screen", () => sendFsState(true));
  win.on("leave-full-screen", () => sendFsState(false));

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

  // The sidecar's renderer half dies with the page on any real navigation (Ctrl+R reload, crash
  // auto-reload); without this, mpv keeps playing the buffered feed over the fresh page and the
  // reloaded extension's enable hits the already-enabled guard. Main-frame, not same-document:
  // Qobuz's own routing is same-document and must not touch playback.
  win.webContents.on("did-start-navigation", (d) => {
    if (d && d.isMainFrame && !d.isSameDocument) qzbpPageGone();
  });

  // Crash/hang recovery + diagnostics. Qobuz's big library page has crashed the renderer a few
  // minutes in; log why and reload so the window comes back instead of staying blank/dead.
  win.webContents.on("render-process-gone", (_e, details) => {
    qzbpPageGone(); // the page died mid-protocol; never leave mpv playing into the void
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

// One instance only. A second launch (one click on the desktop launcher while the app runs) would
// fight this one over the persist:qobuz partition (LevelDB locks read back as logged-out/settings
// lost), the 127.0.0.1:7673 RPC bridge, the MPRIS bus name, and - with the sidecar - the DAC itself.
// Hand focus to the first instance instead.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) app.quit();
else app.on("second-instance", () => { try { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } } catch (_) {} });

app.whenReady().then(async () => {
  if (!gotInstanceLock) return; // quitting; don't spin up servers for a doomed instance
  await startVendorServer();
  saveState({ stage: "vendor-up", vendorPort });
  ipcMain.on("qzbp:cmd", (_e, msg) => { try { qzbpCommand(msg); } catch (_) {} }); // bit-perfect sidecar control
  ipcMain.on("qzbp:feed", (_e, bytes) => { try { qzbpFeedChunk(bytes); } catch (_) {} }); // decrypted FLAC from MSE
  // Lyrics-view fullscreen button. Same call F11 makes; it used to go over the loopback bridge, which the
  // https page can't reach, so it silently did nothing (see preload's __QZFS__ note).
  ipcMain.on("qz:fullscreen", (_e, on) => { try { if (win && !win.isDestroyed()) win.setFullScreen(!!on); } catch (_) {} });
  // The 127.0.0.1:7673 bridge for Discord presence and the lyrics true-fullscreen button. The Windows bake
  // appends this to the native main process; the wrapper requires the same module (copied in by prebuild).
  // It is a fully-wrapped self-starting IIFE, so a require is all it takes - but require() itself throws
  // when the copy is missing or broken, and swallowing that is how presence "silently never worked" once
  // before. Say so, like the MPRIS wiring below does.
  global.__QZ_WRAPPER__ = true; // tells rpc-main.js this is the wrapper: skip its bake-only thumbbar (main.js runs setupThumbar instead)
  try { require("./rpc-main.js"); }
  catch (e) { try { console.error("[Qobuzify RPC] rpc-main load failed: " + (e && e.message)); } catch (_) {} }
  await createWindow();

  // Linux system media controls. Electron publishes nothing to D-Bus on its own, so the desktop sees
  // no player and the keyboard's media keys land on nothing; mpris-main registers a real service and
  // routes what the desktop sends to the renderer, which already drives the sealed player.
  try {
    // Prefer the bundled build. electron-builder's production-dependency pruner drops
    // call-bind-apply-helpers (it is deduped to the top level and also appears under the dev tree), so
    // a node_modules-based require dies with "Cannot find module" inside the packaged app while working
    // perfectly in dev. Bundling mpris-service into one file removes the dependency tree it can mis-prune.
    let mpris;
    try { mpris = require("./mpris-bundle.js"); }
    catch (_) { mpris = require("./mpris-main.js"); }   // dev / unbundled checkout
    if (mpris.start((action, ms) => {
      if (action === "raise") { try { if (win && !win.isDestroyed()) { win.show(); win.focus(); } } catch (_) {} return; }
      try { if (win && !win.isDestroyed()) win.webContents.send("qz:mpris-cmd", { action, ms }); } catch (_) {}
    })) {
      ipcMain.on("qz:mpris", (_e, s) => { try { mpris.update(s); } catch (_) {} });
      ipcMain.on("qz:mpris-seeked", (_e, ms) => { try { mpris.seeked(ms); } catch (_) {} });
      app.on("before-quit", () => { try { mpris.stop(); } catch (_) {} });
    }
  } catch (e) { try { console.error("[Qobuzify MPRIS] main wiring failed: " + (e && e.message)); } catch (_) {} }
});

app.on("before-quit", () => { try { qzbpStop(); } catch (_) {} }); // never leave an orphan mpv
app.on("window-all-closed", () => { try { qzbpStop(); } catch (_) {} app.quit(); });
// before-quit only runs for an orderly exit. A kill or a crash skips it, and the sidecar is a separate
// process that happily keeps running - so it survives as an orphan still holding whatever it opened. In
// exclusive mode that is the DAC itself, which means the NEXT launch finds the device busy and plays
// nothing: an app that got force-quit once stays silent afterwards, for a reason nothing on screen
// explains. Catch the signals we can, and sweep whatever earlier runs leaked on the way up.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  try { process.on(sig, () => { try { qzbpStop(); } catch (_) {} app.quit(); }); } catch (_) {}
}
// Only ever touches sockets this app named, and only when the run that named them is gone. The pid is in
// the socket's own filename, so a live session's sidecar is never a candidate.
function qzbpSweepStale() {
  if (process.platform === "win32") return;
  const dir = process.env.XDG_RUNTIME_DIR || require("os").tmpdir();
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  for (const n of names) {
    const m = /^qobuzify-mpv-(\d+)\.sock$/.exec(n);
    if (!m) continue;
    const owner = parseInt(m[1], 10);
    if (owner === process.pid) continue;
    try { process.kill(owner, 0); continue; } catch (_) {} // owner alive: leave its sidecar alone
    const sock = path.join(dir, n);
    // Ask the stale sidecar to quit through its own IPC socket rather than hunting pids by name: only the
    // process actually listening on this socket can answer, so nothing else can be hit by mistake.
    try {
      const c = net.connect(sock);
      c.on("connect", () => { try { c.write(JSON.stringify({ command: ["quit"] }) + "\n"); } catch (_) {} setTimeout(() => { try { c.destroy(); } catch (_) {} }, 200); });
      c.on("error", () => { try { c.destroy(); } catch (_) {} });
    } catch (_) {}
    setTimeout(() => { try { fs.unlinkSync(sock); } catch (_) {} }, 800);
  }
}
try { qzbpSweepStale(); } catch (_) {}
