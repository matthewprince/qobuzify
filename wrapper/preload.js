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
// (position/params/ended/error/mode) come back the other way.
// Only exposed when an mpv actually exists (bundled, QZ_MPV, or on PATH): the mac/win wrappers ship no
// mpv, and exposing the bridge there put a "Turn on" toggle in front of users whose every click could
// only end in a spawn-error toast. No bridge -> the extension is inert -> no toggle, honestly.
// `on` uses the same single-listener replaceable-slot pattern as __QZFS__/__QZMPRIS__ below (the comment
// there explains why); a bare ipcRenderer.on per call stacked one permanent listener per Marketplace
// toggle cycle.
try {
  if (ipcRenderer.sendSync("qzbp:avail")) {
    let bpCb = null;
    try { ipcRenderer.on("qzbp:evt", (_e, m) => { try { if (bpCb) bpCb(m); } catch (_) {} }); } catch (_) {}
    contextBridge.exposeInMainWorld("__QZBP__", {
      send: (msg) => { try { ipcRenderer.send("qzbp:cmd", msg); } catch (_) {} },
      // Audio bytes get their own channel: segments run to megabytes and shouldn't ride the command path.
      feed: (bytes) => { try { ipcRenderer.send("qzbp:feed", bytes); } catch (_) {} },
      on: (cb) => {
        bpCb = typeof cb === "function" ? cb : null;
        return () => { if (bpCb === cb) bpCb = null; };
      },
    });
  }
} catch (_) {}

// Bridge for OS window fullscreen. The lyrics view's fullscreen button used to POST to the loopback
// bridge (127.0.0.1:7673), but this page is https and a request to http loopback dies here - the same
// cross-origin https->http problem that forced the vendor bundle to be inlined below. The fetch was
// fire-and-forget, so the failure was swallowed and only the button's icon flipped while the window
// stayed windowed: fullscreen worked everywhere EXCEPT the lyrics view, which is the one place that
// went over the network. This goes over IPC to the same win.setFullScreen() call F11 makes, so there
// is no request to block. onChange keeps the button's icon honest when fullscreen is toggled by F11
// or the window manager instead of by the button.
// Subscribes hold ONE persistent ipcRenderer listener dispatching to a replaceable slot: extensions
// are unloaded and re-run in the same page by the Marketplace toggle, and a bare ipcRenderer.on per
// call stacks a listener per cycle (media keys double-fire, a disabled extension keeps control).
// Re-registering replaces the previous callback; the returned unsubscribe clears it (callers that
// ignore the return value still get replace-on-register).
try {
  let fsCb = null;
  try { ipcRenderer.on("qz:fullscreen-changed", (_e, v) => { try { if (fsCb) fsCb(!!v); } catch (_) {} }); } catch (_) {}
  contextBridge.exposeInMainWorld("__QZFS__", {
    set: (on) => { try { ipcRenderer.send("qz:fullscreen", !!on); } catch (_) {} },
    onChange: (cb) => {
      fsCb = typeof cb === "function" ? cb : null;
      return () => { if (fsCb === cb) fsCb = null; };
    },
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
// onCmd has the same single-listener slot semantics as __QZFS__.onChange above.
try {
  let mprisCb = null;
  try { ipcRenderer.on("qz:mpris-cmd", (_e, m) => { try { if (mprisCb) mprisCb(m); } catch (_) {} }); } catch (_) {}
  contextBridge.exposeInMainWorld("__QZMPRIS__", {
    send: (state) => { try { ipcRenderer.send("qz:mpris", state); } catch (_) {} },
    seeked: (ms) => { try { ipcRenderer.send("qz:mpris-seeked", ms); } catch (_) {} },
    onCmd: (cb) => {
      mprisCb = typeof cb === "function" ? cb : null;
      return () => { if (mprisCb === cb) mprisCb = null; };
    },
  });
} catch (_) {}

// Bridge for back/forward navigation. The stock Qobuz DESKTOP app draws history arrows next to its
// logo; play.qobuz.com has no such control at all (verified live: NavBar__leftContainer goes straight
// from .NavBar__brand to .NavBar__items), so wrapper users lost them. The renderer must not guess at
// history depth - only the main process knows whether a back/forward entry exists - so it asks, and
// main pushes the state on every navigation. onState uses the same single-slot pattern as __QZFS__.
try {
  let navCb = null;
  try { ipcRenderer.on("qz:nav-state", (_e, s) => { try { if (navCb) navCb(s); } catch (_) {} }); } catch (_) {}
  contextBridge.exposeInMainWorld("__QZNAV__", {
    go: (dir) => { try { ipcRenderer.send("qz:nav", dir); } catch (_) {} },
    ask: () => { try { ipcRenderer.send("qz:nav-ask"); } catch (_) {} },
    onState: (cb) => {
      navCb = typeof cb === "function" ? cb : null;
      return () => { if (navCb === cb) navCb = null; };
    },
  });
} catch (_) {}

// Identify this shell to the runtime. Without it the runtime reports platform=desktop, which is the
// BAKE's channel, so wrapper users get the bake's release info (a different product with its own version
// line). Map to the OS channel names the update endpoint serves.
try {
  const OS = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
  // updatesHandled: the wrapper's main process already runs its own release check (notification + in-page
  // banner), so the runtime must NOT stack its /v1/version toast on top - one release used to produce
  // three simultaneous prompts. The runtime checks this marker and keeps only its settings-panel entry.
  contextBridge.exposeInMainWorld("__QZWRAP__", { os: OS, updatesHandled: true });
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

// The payload runs in the page's MAIN world; this preload is in an ISOLATED world and cannot see
// window.Qobuzify to know whether it actually booted. The DOM is shared though, so the injected script
// stamps documentElement when it reaches the end - that attribute is the only honest "it ran" signal here.
const READY_ATTR = "data-qz-ready";
const EPILOGUE = "\n;try{document.documentElement.setAttribute('" + READY_ATTR + "','1');}catch(e){}";
function ranToCompletion() {
  try { return document.documentElement && document.documentElement.getAttribute(READY_ATTR) === "1"; }
  catch (_) { return false; }
}

function inject(force) {
  try {
    if (!document.documentElement) return false;
    // Presence of the TAG used to be treated as success, which was wrong: the script can start, set the
    // first statement (window.__QOBUZIFY__) and then stop with NO uncaught exception, leaving the tag in
    // place with nothing defined. The retry loop then saw the tag, declared victory and never tried again,
    // so the app sat there with no theme, no lyrics and no extensions until a manual reload. Observed live
    // 2026-07-25. Now the tag only counts when the epilogue also ran.
    const existing = document.getElementById("qobuzify-runtime");
    if (existing && !force) return ranToCompletion();
    if (existing && force) { try { existing.remove(); } catch (_) {} }
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
    s.textContent = payload + EPILOGUE;
    document.documentElement.appendChild(s);
    return ranToCompletion();   // synchronous execution: by now it either finished or it didn't
  } catch (_) { return false; }
}

// documentElement usually exists by preload time; if not, poll briefly until it does (still
// well before bundle.js finishes parsing).
if (!inject()) {
  const iv = setInterval(() => { if (inject()) clearInterval(iv); }, 2);
  setTimeout(() => clearInterval(iv), 5000);
}
// Backstop for the partial-execution case: if the script is in the DOM but never reached its epilogue, the
// poll above can never succeed (inject() returns ranToCompletion() and nothing re-runs it). Force a clean
// re-inject a couple of times, spaced past the page's own heavy parse. Cheap - it no-ops once ready, and
// the runtime's own re-init guards make a second boot safe.
let forced = 0;
const fiv = setInterval(() => {
  if (ranToCompletion()) { clearInterval(fiv); return; }
  if (!document.documentElement) return;
  if (++forced > 3) { clearInterval(fiv); return; }
  inject(true);
}, 1500);
setTimeout(() => clearInterval(fiv), 12000);
