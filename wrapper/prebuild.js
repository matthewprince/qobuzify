// Bake the Qobuzify payload (+ any extension vendor bundles) into the wrapper so the packaged app
// is fully self-contained: no ../lib, ../runtime, ../themes, ../extensions needed at runtime. Run
// this before `electron .` (dev) and before electron-builder packages the app. main.js/preload.js
// read the baked qz-payload.js + qz-vendors.json; they never require ./payload.js (which pulls ../).
const fs = require("fs");
const path = require("path");
const { buildPayloadSource, vendorMap } = require("./payload");

const OUT = __dirname;
const theme = process.env.QZ_THEME || "electric-blue";

fs.writeFileSync(path.join(OUT, "qz-payload.js"), buildPayloadSource(theme));

// Copy vendor bundles into ./vendor and write an id -> filename manifest. Lyrics is excluded so this
// is empty today, but keeps the shell working if a vendor-bearing extension is added later.
const vendors = vendorMap();
const vdir = path.join(OUT, "vendor");
if (!fs.existsSync(vdir)) fs.mkdirSync(vdir);
for (const f of fs.readdirSync(vdir)) { try { fs.unlinkSync(path.join(vdir, f)); } catch (_) {} }
const manifest = {};
for (const id of Object.keys(vendors)) {
  const fn = "qobuzify-ext-" + id + ".js";
  fs.copyFileSync(vendors[id], path.join(vdir, fn));
  manifest[id] = fn;
}
fs.writeFileSync(path.join(OUT, "qz-vendors.json"), JSON.stringify(manifest));

// The localhost bridge (127.0.0.1:7673) that Discord presence and the lyrics "true fullscreen" button
// POST to. On the Windows bake lib/apply.js appends runtime/rpc-main.js to the native main process; the
// wrapper has its own main process, so copy the module in and require it from main.js instead. Without
// this the toggle appears on but every POST is refused and the feature silently does nothing on Linux/mac.
let rpc = "not found";
try {
  fs.copyFileSync(path.join(__dirname, "..", "runtime", "rpc-main.js"), path.join(OUT, "rpc-main.js"));
  rpc = "ok";
} catch (e) { rpc = "FAILED: " + (e && e.message); }

// Bundle the MPRIS module (Linux system media controls) into one self-contained file. Required, not
// cosmetic: electron-builder's production-dependency pruner drops call-bind-apply-helpers, so a
// node_modules-based require works in dev and dies with "Cannot find module" in the packaged app.
// abstract-socket and x11 stay external - both are optional natives dbus-next only touches on bus
// address forms this never uses.
try {
  require("esbuild").buildSync({
    entryPoints: [path.join(__dirname, "mpris-main.js")],
    outfile: path.join(OUT, "mpris-bundle.js"),
    bundle: true, platform: "node", target: "node20",
    external: ["electron", "abstract-socket", "x11"],
    logLevel: "warning",
  });
  console.log("bundled mpris-bundle.js");
} catch (e) {
  console.warn("mpris bundle SKIPPED (" + (e && e.message) + ") - media keys will be off on Linux");
}

const sz = fs.statSync(path.join(OUT, "qz-payload.js")).size;
console.log("baked qz-payload.js (" + Math.round(sz / 1024) + " KB) + " + Object.keys(manifest).length + " vendor(s) + rpc-main " + rpc);
