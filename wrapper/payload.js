// Assemble the exact same injection payload the desktop bake produces, but for the
// wrapper: window.__QOBUZIFY__ = { catalog, extensions, def, seed, version, ... } followed
// by the runtime source. On desktop this goes into an inline <script> before bundle.js;
// here the shell injects it via CDP addScriptToEvaluateOnNewDocument (runs before the
// page's own scripts, same guarantee). Reuses lib/apply's catalog/extension readers so the
// wrapper runs the real Qobuzify (all themes + all extensions), not a stripped copy.
const fs = require("fs");
const path = require("path");
const { buildCatalog, buildExtensions } = require("../lib/apply");

const ROOT = path.join(__dirname, "..");
const THEMES_DIR = path.join(ROOT, "themes");
const EXT_DIR = path.join(ROOT, "extensions");
const RUNTIME = path.join(ROOT, "runtime", "qobuzify-runtime.js");

function version() {
  // The WRAPPER's own version (wrapper/package.json), NOT the root package.json - that one carries the
  // desktop-bake line (a different product on its own version number). Baking the bake version here made
  // the in-app version read low, so the runtime updater (which asks /v1/version?platform=wrapper-<os>)
  // saw the wrapper channel as newer than itself and nagged users to "update" to the version they run.
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version || "0.1"; }
  catch (_) { return "0.1"; }
}

// The source injected before the page boots. No </script> escaping needed (this is raw JS
// handed to the debugger, not embedded in HTML). Lyrics are proxy-first via api.qobuzify.app,
// so the local Spotify/Apple creds stay null in the prototype.
// The wrapper ships the SAME extension set as the desktop bake: Linux is Windows plus bit-perfect, and
// nothing less. Nothing is filtered out here.
const EXCLUDE = new Set([]);

function buildPayloadSource(def) {
  const catalog = buildCatalog(THEMES_DIR);
  const extensions = buildExtensions(EXT_DIR).filter((e) => !EXCLUDE.has(e.id));
  const runtimeSrc = fs.readFileSync(RUNTIME, "utf8");
  const data = {
    catalog,
    extensions,
    def: def || "electric-blue",
    version: version(),
    seed: 1,            // fresh seed asserts `def` as the active theme on first launch
    spotify: null,
    spotifyToken: null,
    apple: null,
  };
  return "window.__QOBUZIFY__ = " + JSON.stringify(data) + ";\n" + runtimeSrc;
}

// id -> local vendor.js path, for any extension that ships a prebuilt bundle (none do
// today; the lyrics view renders through Lyra). The wrapper serves these at the same-origin
// path the extension requests.
function vendorMap() {
  const map = {};
  for (const e of buildExtensions(EXT_DIR)) {
    if (e.hasVendor && !EXCLUDE.has(e.id)) map[e.id] = path.join(EXT_DIR, e.id, "vendor.js");
  }
  return map;
}

module.exports = { buildPayloadSource, vendorMap };
