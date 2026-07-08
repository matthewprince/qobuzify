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
const { app, BrowserWindow, session, shell } = require("electron");
const http = require("http");
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
  win.on("closed", () => { if (probeTimer) { clearInterval(probeTimer); probeTimer = null; } win = null; });

  // Recover if the app ever restores a dead route: /foryou is a fake overlay route (the For You
  // nav opens an overlay, it never really navigates there), so a persisted /foryou lands on
  // /error/404 on next launch. Bounce any such route back to /discover once.
  let recovered = false, crashReloads = 0, crashResetT = null;
  win.webContents.on("did-finish-load", () => {
    const u = win.webContents.getURL();
    saveState({ stage: "loaded", url: u.slice(0, 60) });
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
  await createWindow();
});

app.on("window-all-closed", () => app.quit());
