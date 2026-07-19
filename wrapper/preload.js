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

// Bridge for OS window fullscreen. The lyrics view's fullscreen button used to POST to the loopback
// bridge (127.0.0.1:7673), but this page is https and a request to http loopback dies here - the same
// cross-origin https->http problem that forced the vendor bundle to be inlined below. The fetch was
// fire-and-forget, so the failure was swallowed and only the button's icon flipped while the window
// stayed windowed: fullscreen worked everywhere EXCEPT the lyrics view, which is the one place that
// went over the network. This goes over IPC to the same win.setFullScreen() call F11 makes, so there
// is no request to block. onChange keeps the button's icon honest when fullscreen is toggled by F11
// or the window manager instead of by the button.
try {
  contextBridge.exposeInMainWorld("__QZFS__", {
    set: (on) => { try { ipcRenderer.send("qz:fullscreen", !!on); } catch (_) {} },
    onChange: (cb) => { try { ipcRenderer.on("qz:fullscreen-changed", (_e, v) => { try { cb(!!v); } catch (_) {} }); } catch (_) {} },
  });
} catch (_) {}

// Bridge for Discord Rich Presence, for the same reason as __QZFS__ above. The discord-rpc extension
// POSTs the current track to the loopback bridge at 127.0.0.1:7673, which this https page cannot reach
// (cross-origin https->http, and its JSON content-type needs a preflight on top), so presence silently
// never worked in this wrapper. rpc-main.js takes the identical payload over this channel instead.
try {
  contextBridge.exposeInMainWorld("__QZRPC__", {
    send: (payload) => { try { ipcRenderer.send("qz:rpc", payload); } catch (_) {} },
  });
} catch (_) {}

// Bridge for Linux system media controls (MPRIS). The media-session extension already computes the
// exact metadata and transport state the desktop wants, and already knows how to drive the sealed
// player - it just had no way to reach D-Bus, which lives in the main process. `send` publishes state,
// `seeked` corrects the desktop's scrubber after a jump, and `onCmd` receives the keyboard's keys.
try {
  contextBridge.exposeInMainWorld("__QZMPRIS__", {
    send: (state) => { try { ipcRenderer.send("qz:mpris", state); } catch (_) {} },
    seeked: (ms) => { try { ipcRenderer.send("qz:mpris-seeked", ms); } catch (_) {} },
    onCmd: (cb) => { try { ipcRenderer.on("qz:mpris-cmd", (_e, m) => { try { cb(m); } catch (_) {} }); } catch (_) {} },
  });
} catch (_) {}

// Identify this shell to the runtime. Without it the runtime reports platform=desktop, which is the
// BAKE's channel, so wrapper users get the bake's release info (a different product with its own version
// line). Map to the OS channel names the update endpoint serves.
try {
  const OS = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
  contextBridge.exposeInMainWorld("__QZWRAP__", { os: OS });
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
