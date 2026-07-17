// Inject the Qobuzify payload (window.__QOBUZIFY__ + runtime) into the page's MAIN world
// before the page's own scripts run. This is the wrapper's stand-in for the desktop bake
// placing an inline <script> before bundle.js in app.html. A <script> element created here
// executes in the page world (not the isolated preload world), which is what the runtime
// needs to hook the app's store and fetch.
const { contextBridge, ipcRenderer } = require("electron");
const fs = require("fs");
const path = require("path");

// Bridge for the bit-perfect audio sidecar. contextIsolation is on, so the injected runtime (main world)
// can't reach ipcRenderer directly - expose a tiny, explicit channel. The renderer sends transport commands
// (load/play/pause/seek/volume) to the main process, which relays them to the bundled mpv; mpv's events
// (position/params/ended/error/mode) come back the other way. Guarded so a non-bitperfect build is unaffected.
try {
  contextBridge.exposeInMainWorld("__QZBP__", {
    send: (msg) => { try { ipcRenderer.send("qzbp:cmd", msg); } catch (_) {} },
    // Audio bytes get their own channel: segments run to megabytes and shouldn't ride the command path.
    feed: (bytes) => { try { ipcRenderer.send("qzbp:feed", bytes); } catch (_) {} },
    on: (cb) => { try { ipcRenderer.on("qzbp:evt", (_e, m) => { try { cb(m); } catch (_) {} }); } catch (_) {} },
  });
} catch (_) {}

let payload = "";
try { payload = fs.readFileSync(path.join(__dirname, "qz-payload.js"), "utf8"); } // baked by prebuild.js
catch (e) { payload = "console.error('[Qobuzify] payload missing: " + (e && e.message) + "');"; }

// Extensions that ship a big prebuilt renderer (Qobuzify Lyrics) load it as a sibling bundle. On the
// desktop bake that is a <script src> off the app's own file:// dist dir. Here the page is https and the
// bundle only exists locally, and redirecting that request to the loopback server dies with ERR_ABORTED
// (cross-origin https -> http for a script subresource). Inline scripts are fine, so hand the bundle to
// the page as one instead: no network, no origin to cross.
let vendorSrc = "";
try {
  const map = JSON.parse(fs.readFileSync(path.join(__dirname, "qz-vendors.json"), "utf8"));
  const out = {};
  for (const id of Object.keys(map)) {
    try { out[id] = fs.readFileSync(path.join(__dirname, "vendor", map[id]), "utf8"); } catch (_) {}
  }
  if (Object.keys(out).length) vendorSrc = "window.__QZ_VENDOR__ = " + JSON.stringify(out) + ";";
} catch (_) {}

function inject() {
  try {
    if (!document.documentElement) return false;
    if (document.getElementById("qobuzify-runtime")) return true;
    // Vendors first: the payload boots the runtime, which inits extensions immediately, and Lyrics
    // reaches for its renderer during init.
    if (vendorSrc && !document.getElementById("qobuzify-vendors")) {
      const v = document.createElement("script");
      v.id = "qobuzify-vendors";
      v.textContent = vendorSrc;
      document.documentElement.appendChild(v);
    }
    const s = document.createElement("script");
    s.id = "qobuzify-runtime";
    s.textContent = payload;
    document.documentElement.appendChild(s);
    return true;
  } catch (_) { return false; }
}

// documentElement usually exists by preload time; if not, poll briefly until it does (still
// well before bundle.js finishes parsing).
if (!inject()) {
  const iv = setInterval(() => { if (inject()) clearInterval(iv); }, 2);
  setTimeout(() => clearInterval(iv), 5000);
}
