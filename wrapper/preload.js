// Inject the Qobuzify payload (window.__QOBUZIFY__ + runtime) into the page's MAIN world
// before the page's own scripts run. This is the wrapper's stand-in for the desktop bake
// placing an inline <script> before bundle.js in app.html. A <script> element created here
// executes in the page world (not the isolated preload world), which is what the runtime
// needs to hook the app's store and fetch.
const fs = require("fs");
const path = require("path");

let payload = "";
try { payload = fs.readFileSync(path.join(__dirname, "qz-payload.js"), "utf8"); } // baked by prebuild.js
catch (e) { payload = "console.error('[Qobuzify] payload missing: " + (e && e.message) + "');"; }

function inject() {
  try {
    if (!document.documentElement) return false;
    if (document.getElementById("qobuzify-runtime")) return true;
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
