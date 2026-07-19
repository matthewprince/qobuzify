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
  // Proof that real audio reached the sidecar. The renderer keeps the web element AUDIBLE until it sees
  // this, so a bit-perfect path that never starts can no longer leave the user in silence.
  qzbp.lastFeedAt = Date.now();
  if (!f.live) { f.live = true; qzbp.stalled = false; bpTrace("LIVE: first bytes reached mpv", { bytes: f.bytes }); qzbpEvt({ type: "live" }); }
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
function pactl(args) {
  try { return require("child_process").execFileSync("pactl", args, { timeout: 4000, encoding: "utf8" }); }
  catch (_) { return null; }
}
function pactlJson(args) { try { return JSON.parse(pactl(["-f", "json"].concat(args)) || "null"); } catch (_) { return null; } }

function wpctl(args) {
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
    const pick = sinks.find((s) => s.name === def && (s.properties || {})["alsa.card"] != null)
      || sinks.find((s) => (s.properties || {})["alsa.card"] != null);
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
  try {
    const pcm = fs.readFileSync("/proc/asound/pcm", "utf8").split("\n");
    for (const line of pcm) {
      const m = /^(\d+)-(\d+):\s*(.*)$/.exec(line.trim());
      if (!m || !/playback/i.test(m[3]) || /loopback|dummy/i.test(m[3])) continue;
      return "alsa/hw:" + parseInt(m[1], 10) + "," + parseInt(m[2], 10);
    }
  } catch (_) {}
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
function soundServerPresent() {
  if (process.platform !== "linux") return false;
  try { if (fs.existsSync(path.join(process.env.XDG_RUNTIME_DIR || "/run/user/1000", "pipewire-0"))) return true; } catch (_) {}
  try { if (fs.existsSync(path.join(process.env.XDG_RUNTIME_DIR || "/run/user/1000", "pulse", "native"))) return true; } catch (_) {}
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
  if (!qzbp.enabled || !qzbp.wantPlaying || qzbp.stalled) return;
  const fed = qzbp.feed && qzbp.feed.bytes > 0;
  if (fed) return;
  // Grace runs from whichever came last: arming bit-perfect, or the newest track's feed opening. Using
  // only the enable time would fire on every track change, in the gap before the first bytes land.
  const since = Math.max(qzbp.enabledAt || 0, qzbp.feedStartedAt || 0);
  if (Date.now() - since < STALL_MS) return;
  qzbp.stalled = true;
  bpTrace("STALLED: no bytes ever reached mpv", { device: qzbp.device, mode: qzbp.mode });
  // Do NOT keep the DAC hostage while producing no sound: hand it back, and tell the renderer to unmute
  // and stop claiming bit-perfect. Degrading loudly beats a silent lie.
  try { mpvSend(["stop"]); } catch (_) {}
  qzbpEvt({ type: "stalled", why: "no audio reached the bit-perfect sidecar" });
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
    "--cache=yes", "--demuxer-max-bytes=768MiB", "--demuxer-max-back-bytes=768MiB",
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
  if (qzbp.device && !pcmBusy(qzbp.device)) return "exclusive"; // PCM is free: take it at the track's rate
  if (soundServerPresent()) return "passthrough";               // server owns the card: go through it
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
        else if (m.name === "audio-params" && m.data) {
          // Report what the hardware is doing, not what mode we asked for. Bit-perfect is the property
          // "the decoded rate is the rate the converter is clocked at" - checkable against the kernel, and
          // the only claim worth putting on a badge. In exclusive mode mpv set that rate itself; in
          // passthrough the server decides, and it agrees with us exactly when its graph already runs at
          // the track's rate. Anything else resampled, and the badge has to say so.
          const src = m.data.samplerate || 0;
          const hw = qzbp.mode === "shared" ? 0 : hwRateOf(qzbp.device);
          qzbpEvt({ type: "params", rate: src, format: m.data.format, channels: m.data["channel-count"],
            mode: qzbp.mode, hwRate: hw, bitperfect: !!(src && hw && src === hw) });
        }
        else if (m.name === "eof-reached" && m.data === true) qzbpEvt({ type: "ended" });
      } else if (m.event === "end-file" && m.reason === "error") {
        qzbpEvt({ type: "error", what: "load" });
      }
    }
  });
  s.on("error", () => {});
  s.on("close", () => { qzbp.sock = null; });
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
  if (qzbp.stallTimer) { clearInterval(qzbp.stallTimer); qzbp.stallTimer = null; }
  qzbp.stalled = false;
  try { if (qzbp.sock) qzbp.sock.end(); } catch (_) {}
  try { if (qzbp.proc) qzbp.proc.kill(); } catch (_) {}
  qzbp.sock = null; qzbp.proc = null; qzbp.mode = "off"; qzbp.curUrl = null;
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
      }
      break;
    case "disable": qzbpStop(); qzbpEvt({ type: "disabled" }); break;
    case "newtrack": bpTrace("newtrack received from renderer"); qzbp.wantPlaying = true; qzbpFeedStart(); break;
    case "feed": qzbpFeedChunk(msg.data); break;
    case "endfeed": if (qzbp.feed) { qzbp.feed.done = true; if (qzbp.feed.res) { try { qzbp.feed.res.end(); } catch (_) {} } } break;
    case "play": qzbp.wantPlaying = true; mpvSend(["set_property", "pause", false]); break;
    case "pause": qzbp.wantPlaying = false; mpvSend(["set_property", "pause", true]); break;
    case "seek": mpvSend(["seek", (Number(msg.ms) || 0) / 1000, "absolute"]); break;
    case "stop": mpvSend(["stop"]); qzbp.curUrl = null; qzbp.feed = null; break;
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
  // Lyrics-view fullscreen button. Same call F11 makes; it used to go over the loopback bridge, which the
  // https page can't reach, so it silently did nothing (see preload's __QZFS__ note).
  ipcMain.on("qz:fullscreen", (_e, on) => { try { if (win && !win.isDestroyed()) win.setFullScreen(!!on); } catch (_) {} });
  // The 127.0.0.1:7673 bridge for Discord presence and the lyrics true-fullscreen button. The Windows bake
  // appends this to the native main process; the wrapper requires the same module (copied in by prebuild).
  // It is a fully-wrapped self-starting IIFE, so a require is all it takes, and it can never throw here.
  try { require("./rpc-main.js"); } catch (_) {}
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
