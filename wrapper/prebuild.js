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

const sz = fs.statSync(path.join(OUT, "qz-payload.js")).size;
console.log("baked qz-payload.js (" + Math.round(sz / 1024) + " KB) + " + Object.keys(manifest).length + " vendor(s)");
