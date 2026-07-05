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
const { app, BrowserWindow, session } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");

// Occlusion pausing froze the desktop lyrics when the window was covered; disabling it keeps
// the render loop running while hidden. Hardware acceleration stays ON: Qobuz is image-heavy
// (album art everywhere), and software rendering a big list like the whole library eats memory
// until the renderer chokes. (The early segfault was the Bash tool's detached context, not the
// GPU; launched from a real session the GPU is fine.)
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("no-sandbox");

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
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (_) {}
}

let vendorPort = 0;

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

  const win = new BrowserWindow({
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

  // Recover if the app ever restores a dead route: /foryou is a fake overlay route (the For You
  // nav opens an overlay, it never really navigates there), so a persisted /foryou lands on
  // /error/404 on next launch. Bounce any such route back to /discover once.
  let recovered = false;
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
    try { win.webContents.reload(); } catch (_) {}
  });
  win.webContents.on("unresponsive", () => {
    saveState({ stage: "unresponsive" });
    try { win.webContents.reload(); } catch (_) {}
  });
  win.webContents.on("responsive", () => saveState({ stage: "responsive-again" }));

  win.loadURL("https://play.qobuz.com/discover");

  // Report state periodically to the state file so the run is verifiable while it runs. Guarded so a
  // slow/hung renderer doesn't pile up overlapping executeJavaScript calls (which itself adds pressure).
  let probing = false;
  setInterval(async () => {
    if (probing) return;
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

app.whenReady().then(async () => {
  await startVendorServer();
  saveState({ stage: "vendor-up", vendorPort });
  await createWindow();
});

app.on("window-all-closed", () => app.quit());
