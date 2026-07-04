// Patch the Qobuz client with the Qobuzify in-app runtime: a Marketplace and a
// Qobuzify entry in the account menu, plus a live theme engine. Theming is done
// at runtime via CSS-variable overrides + a bundled theme catalog, so one install
// supports switching every theme live - no per-theme file rewrites, no relaunch.
//
// Only app.html is touched: an inline <script id="qobuzify-runtime"> is injected
// before bundle.js. legacy.css is reset to stock (the runtime overrides tokens
// instead of hard-swapping hex). Originals are backed up once as *.qobuzify-bak and
// every install rebuilds from that pristine backup, so re-running stays clean.
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const BAK = ".qobuzify-bak";
const STYLE_ID = "qobuzify";           // legacy static block id (stripped on install)
const RUNTIME_ID = "qobuzify-runtime"; // the injected runtime <script>

// Flagship first, then the bold set, then the simple token-swap themes.
const ORDER = ["glass", "electric-blue", "neon", "matrix", "cosmic", "dramatic", "terracotta", "oled-black", "nord", "dracula"];

function backupOnce(file) {
  const bak = file + BAK;
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
}

function pristine(file) {
  const bak = file + BAK;
  return fs.readFileSync(fs.existsSync(bak) ? bak : file, "utf8");
}

function relaunch(launcher) {
  try { cp.execSync("taskkill /IM Qobuz.exe /F", { stdio: "ignore" }); } catch (_) {}
  cp.spawn(launcher, [], { detached: true, stdio: "ignore" }).unref();
}

// Apple Music's amp-api validates the Origin header (the web dev-token is bound to
// apple.com), and a renderer fetch can't set Origin - so the lyrics request 401s. The
// fix is a tiny main-process header rewrite: stamp Origin/Referer = music.apple.com on
// *.music.apple.com requests. main-win32.js is the (minified) main bundle; we append
// the snippet after it (require('electron') is then available). Rebuilt from the
// pristine *.qobuzify-bak each install, and removed when Apple creds aren't present.
// Apple's amp-api validates the Origin header (the web dev-token is bound to apple.com)
// and a renderer fetch can't set Origin, so the request 401s. Qobuz also registers its
// own onBeforeSendHeaders and "last listener wins", so we install an all-URLs listener
// (pass everything through untouched, stamp Origin/Referer only on amp-api) and re-add
// it on a short timer to win the race against Qobuz's. main-win32.js is the minified
// main bundle; this is appended after it. Rebuilt from the pristine *.qobuzify-bak each
// install; removed when no Apple creds are present.
const APPLE_HDR = "/*qz-apple-hdr*/;(function(){try{var e=require(\"electron\");var handler=function(d,cb){try{if(/amp-api\\.music\\.apple\\.com/.test(d.url||\"\")){var h=d.requestHeaders||{};h.Origin=\"https://music.apple.com\";h.Referer=\"https://music.apple.com/\";cb({requestHeaders:h});return;}}catch(_){}cb({requestHeaders:d.requestHeaders});};var apply=function(s){try{if(s)s.webRequest.onBeforeSendHeaders({urls:[\"*://*/*\"]},handler);}catch(_){}};var go=function(){try{apply(e.session.defaultSession);}catch(_){}try{(e.BrowserWindow.getAllWindows()||[]).forEach(function(w){try{apply(w.webContents.session);}catch(_){}});}catch(_){}};try{e.app.on(\"web-contents-created\",function(x,c){try{apply(c.session);}catch(_){}});}catch(_){}try{if(e.app.isReady&&e.app.isReady())go();else e.app.whenReady().then(go);}catch(_){}[2000,5000,9000].forEach(function(ms){try{setTimeout(go,ms);}catch(_){}});}catch(_){}})();";
// The alt-tab lyrics freeze: Chromium throttles a backgrounded renderer (rAF pauses), so on
// return the lyrics loop has to resume + catch up. Spotify (same Electron base) doesn't freeze,
// and CDP showed why: its renderer runs rAF full-rate while backgrounded+idle (132/s, no media
// playing, NO anti-throttle launch flags) - because it creates its BrowserWindow with
// webPreferences.backgroundThrottling=false. That flag is read ONLY at window creation (runtime
// setBackgroundThrottling does nothing; command-line switches via appendSwitch load too late since
// Chromium reads them at process startup, before main-win32.js runs). So we wrap the BrowserWindow
// constructor and force backgroundThrottling:false on every window. PREPENDED to main-win32.js so
// the wrap is in place before Qobuz captures the class; W keeps O's prototype + statics, and falls
// back to a plain construct if anything throws (so a bad wrap can't stop Qobuz from launching).
// Rebuilt from the pristine *.qobuzify-bak each install; reverted by restore.js.
const BG_THROTTLE_FIX = "/*qz-bg-throttle*/;(function(){try{var e=require(\"electron\");var O=e&&e.BrowserWindow;if(typeof O===\"function\"&&!O.__qzbg){var W=function(o){o=o||{};try{o.webPreferences=Object.assign({},o.webPreferences,{backgroundThrottling:false});}catch(_){}try{return Reflect.construct(O,[o],new.target||W);}catch(_){return new O(o);}};try{Object.setPrototypeOf(W,O);}catch(_){}W.prototype=O.prototype;W.__qzbg=true;try{e.BrowserWindow=W;}catch(_){try{Object.defineProperty(e,\"BrowserWindow\",{value:W,configurable:true});}catch(__){}}}}catch(_){}})();";
function patchMainProcess(appDir, enable) {
  const mainJs = path.join(appDir, "main-win32.js");
  if (!fs.existsSync(mainJs)) return;
  backupOnce(mainJs);
  let src = pristine(mainJs); // pristine = from the .qobuzify-bak, no prior patch
  // Primary fix: inject backgroundThrottling:false straight into the MAIN window's webPreferences
  // literal (the one carrying zoomFactor:1.5). Default is true => the renderer + lyrics rAF freeze
  // when backgrounded (Spotify sets it false, which is why it never freezes). Targeted text patch
  // on the minified bundle; if a Qobuz update changes that literal it simply won't match (no-op,
  // harmless) and we re-find the anchor.
  src = src.replace("webPreferences:{zoomFactor:1.5,", "webPreferences:{backgroundThrottling:!1,zoomFactor:1.5,");
  src = BG_THROTTLE_FIX + "\n" + src; // fallback for future builds: also wrap the BrowserWindow constructor
  if (enable) src = src + "\n" + APPLE_HDR + "\n"; // append: Apple Music Origin-header rewrite
  // Discord Rich Presence (always on): append the main-process RPC module (Discord IPC pipe +
  // localhost bridge the renderer posts to). Read from runtime/rpc-main.js so it stays readable
  // + editable rather than a giant escaped string; it runs after the bundle where require() exists.
  try { const rpcSrc = fs.readFileSync(path.join(__dirname, "..", "runtime", "rpc-main.js"), "utf8"); src = src + "\n" + rpcSrc + "\n"; } catch (_) {}
  fs.writeFileSync(mainJs, src, "utf8");
}

// Read every themes/*.json, attach its CSS layer, and shape it for the runtime.
function buildCatalog(themesDir) {
  const entries = fs.readdirSync(themesDir).filter((f) => f.endsWith(".json")).map((f) => {
    const slug = f.replace(/\.json$/, "");
    const t = JSON.parse(fs.readFileSync(path.join(themesDir, f), "utf8"));
    let css = "";
    if (t.cssFile) { try { css = fs.readFileSync(path.join(themesDir, t.cssFile), "utf8"); } catch (_) {} }
    return { slug, name: t.name || slug, description: t.description || "", preview: t.preview || {}, tokens: t.tokens || {}, css };
  });
  entries.sort((a, b) => {
    const ia = ORDER.indexOf(a.slug), ib = ORDER.indexOf(b.slug);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.slug.localeCompare(b.slug);
  });
  return entries;
}

// Read every extensions/<id>/ (manifest.json + index.js) for the install payload.
function buildExtensions(extDir) {
  let dirs;
  try { dirs = fs.readdirSync(extDir, { withFileTypes: true }).filter((e) => e.isDirectory()); }
  catch (_) { return []; }
  return dirs.map((d) => {
    const base = path.join(extDir, d.name);
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(base, "manifest.json"), "utf8")); } catch (_) {}
    let source;
    try { source = fs.readFileSync(path.join(base, "index.js"), "utf8"); } catch (_) { return null; }
    // A big prebuilt bundle (e.g. Qz Lyrics) ships as a sibling vendor.js loaded
    // via <script src> at runtime - NOT inlined (it would break the inline payload).
    const hasVendor = fs.existsSync(path.join(base, "vendor.js"));
    return {
      id: manifest.id || d.name, name: manifest.name || d.name, description: manifest.description || "",
      icon: manifest.icon || "", version: manifest.version || "", author: manifest.author || "",
      defaultOff: !!manifest.defaultOff, source, hasVendor
    };
  }).filter(Boolean);
}

// Build the inline-script body: the data object + the runtime source, escaped so
// nothing inside (theme CSS, extension JS, etc.) can break out of the <script>.
function buildPayload({ catalog, extensions, def, version, seed, runtimeSrc, spotify, spotifyToken, apple }) {
  const data = JSON.stringify({ catalog, extensions: extensions || [], def: def || null, version: version || "0.1", seed: seed || 0, spotify: spotify || null, spotifyToken: spotifyToken || null, apple: apple || null });
  const body = "window.__QOBUZIFY__ = " + data + ";\n" + runtimeSrc;
  return body.replace(/<\/(script)/gi, "<\\/$1");
}

function injectRuntime(html, payload) {
  // drop any prior Qobuzify blocks (our runtime script + the old static style)
  html = html.replace(new RegExp(`\\s*<script id="${RUNTIME_ID}">[\\s\\S]*?</script>`, "g"), "");
  html = html.replace(new RegExp(`\\s*<style id="${STYLE_ID}">[\\s\\S]*?</style>`, "g"), "");
  const tag = `<script id="${RUNTIME_ID}">\n${payload}\n</script>\n`;
  const anchor = '<script src="/bundle.js"></script>';
  if (html.includes(anchor)) return html.replace(anchor, tag + "    " + anchor);
  return html.replace("</head>", tag + "</head>");
}

// Install (or refresh) the runtime. `def`/`seed` let the CLI assert a starting
// theme on the next launch; switching afterward is live and in-app.
function install(paths, cfg, opts = {}) {
  const doRelaunch = opts.relaunch !== false;
  backupOnce(paths.appHtml);
  backupOnce(paths.legacyCss);
  fs.writeFileSync(paths.appHtml, injectRuntime(pristine(paths.appHtml), buildPayload(cfg)), "utf8");
  fs.writeFileSync(paths.legacyCss, pristine(paths.legacyCss), "utf8"); // keep legacy stock
  patchMainProcess(path.dirname(paths.appHtml), !!cfg.apple); // Apple Music Origin rewrite (only with creds)
  // copy big extension bundles into the dist dir so the extension can <script src="/qobuzify-ext-<id>.js">
  if (cfg.vendors && cfg.vendors.length) {
    const distDir = path.dirname(path.dirname(path.dirname(path.dirname(paths.legacyCss)))); // .../dist
    for (const v of cfg.vendors) { try { fs.copyFileSync(v.src, path.join(distDir, v.name)); } catch (_) {} }
  }
  if (doRelaunch) relaunch(paths.launcher);
}

module.exports = { install, buildCatalog, buildExtensions, buildPayload, injectRuntime, relaunch };
