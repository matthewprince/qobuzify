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
const vm = require("vm");

const BAK = ".qobuzify-bak";
const STYLE_ID = "qobuzify";           // legacy static block id (stripped on install)
const RUNTIME_ID = "qobuzify-runtime"; // the injected runtime <script>

// Flagship first, then the bold set, then the simple token-swap themes.
const ORDER = ["glass", "electric-blue", "neon", "matrix", "cosmic", "dramatic", "terracotta", "oled-black", "nord", "dracula"];

function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {}
}

// Write `data` to file.tmp, then rename over the target, so a crash or a full disk mid-write can never
// leave a half-written file in place (the target is either the old file or the complete new one).
// Windows refuses the rename while something (AV, an indexer) briefly holds the target open, so retry for
// a moment; as a last resort fall back to copying the finished tmp over it.
function writeTmp(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, data);
  return tmp;
}
function commitTmp(tmp, file) {
  for (let i = 0; i < 6; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      if (!/^(EPERM|EBUSY|EACCES)$/.test(e.code || "") || i === 5) break;
      sleepMs(150);
    }
  }
  fs.copyFileSync(tmp, file);
  try { fs.unlinkSync(tmp); } catch (_) {}
}
function writeAtomic(file, data) { commitTmp(writeTmp(file, data), file); }

// Is `text` a complete, unpatched copy of `file`? Checked on an existing backup and on the live file before
// it becomes one, so a truncated or already-patched copy is never treated as the clean original. The checks
// only fire on strong signs of damage, because a false alarm here would block every install:
//   app.html       must reach </html> and carry none of our blocks
//   legacy.css     must not end inside an open rule (more { than }, comments stripped)
//   main-win32.js  must carry none of our markers, and must not fail to parse with a cut-off signature
//                  (end of input, unterminated literal). Other parse errors are let through: the system
//                  Node may simply not know a syntax the bundle's Electron does.
function looksPristine(file, text) {
  if (typeof text !== "string" || !text.trim().length) return false;
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html") {
    return /<\/html>/i.test(text) && !text.includes(`<script id="${RUNTIME_ID}">`) && !text.includes(`<style id="${STYLE_ID}">`);
  }
  if (ext === ".css") {
    const bare = text.replace(/\/\*[\s\S]*?(\*\/|$)/g, "");
    return (bare.match(/\{/g) || []).length <= (bare.match(/\}/g) || []).length;
  }
  if (ext === ".js") {
    if (text.includes("/*qz-")) return false;
    // Compile only (never run), and unwrapped: a function wrapper would add its own closing brace and turn a
    // cut-off file's "Unexpected end of input" into an ordinary-looking "Unexpected token '}'".
    try { new vm.Script(text, { filename: path.basename(file) }); return true; }
    catch (e) { return !/end of input|Unterminated|Invalid or unexpected token/i.test(String(e && e.message)); }
  }
  return true;
}

// Strip our own blocks out of a patched app.html (the same regexes injectRuntime uses), so an app.html that
// lost its backup can still yield the clean original.
function stripHtml(html) {
  return html
    .replace(new RegExp(`\\s*<script id="${RUNTIME_ID}">[\\s\\S]*?</script>`, "g"), "")
    .replace(new RegExp(`\\s*<style id="${STYLE_ID}">[\\s\\S]*?</style>`, "g"), "");
}

// The clean original of `file`: its *.qobuzify-bak if that is intact, else the live file if THAT is clean.
// Never writes the live file. Returns { text, bakTmp }; bakTmp (if set) is a complete new backup already
// written to *.qobuzify-bak.tmp and waiting for install() to commit it, so a partial backup can never
// appear under the real name.
function readPristine(file) {
  const bak = file + BAK;
  let live = fs.readFileSync(file, "utf8");
  if (path.extname(file).toLowerCase() === ".html" && !looksPristine(file, live)) {
    const s = stripHtml(live);
    if (looksPristine(file, s)) live = s;
  }
  const liveOk = looksPristine(file, live);
  if (fs.existsSync(bak)) {
    const b = fs.readFileSync(bak, "utf8");
    // A backup that is a strict prefix of a clean live file was cut short while being copied.
    const truncated = liveOk && live.length > b.length && live.startsWith(b);
    if (!truncated && looksPristine(file, b)) return { text: b, bakTmp: null };
    if (liveOk) return { text: live, bakTmp: writeTmp(bak, live) };
    throw new Error("The Qobuzify backup " + bak + " is damaged and " + path.basename(file) + " is already patched, " +
      "so there is no clean copy to build from. Reinstall the Qobuz desktop app, then run qobuzify install again.");
  }
  if (!liveOk) {
    throw new Error(path.basename(file) + " at " + file + " looks incomplete or already patched and has no Qobuzify backup. " +
      "Reinstall the Qobuz desktop app, then run qobuzify install again.");
  }
  return { text: live, bakTmp: writeTmp(bak, live) };
}

function qobuzRunning() {
  try {
    const out = cp.execSync('tasklist /FI "IMAGENAME eq Qobuz.exe" /NH', { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    return /qobuz\.exe/i.test(out);
  } catch (_) { return false; }
}

function relaunch(launcher) {
  let killed = false;
  try { cp.execSync("taskkill /IM Qobuz.exe /F", { stdio: "ignore", windowsHide: true }); killed = true; } catch (_) {}
  // taskkill /F returns before the processes are gone. Relaunching straight away can hand the new launch to
  // the dying instance's single-instance lock, and it then exits with it. Wait (bounded) for a clean slate.
  if (killed) {
    const until = Date.now() + 8000;
    while (Date.now() < until && qobuzRunning()) sleepMs(250);
  }
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
// The OTHER half of the alt-tab lag, Windows-specific: even with backgroundThrottling:false (which keeps the
// renderer's rAF alive), Chromium's native window-occlusion detection SUSPENDS THE COMPOSITOR when the Qobuz
// window is fully covered (exactly what alt-tabbing to another app does) and can drop its GPU tiles. On
// alt-tab back it re-rasterizes the whole window - worst for the lyrics view's heavy blurred mesh background -
// which is the visible stall. backgroundThrottling (renderer scheduler) and occlusion (browser->compositor
// visibility) are DIFFERENT subsystems, so the throttle fix alone doesn't cover it. The wrapper already
// disables occlusion (wrapper/main.js); this mirrors it for the baked app via a command-line switch. Unlike
// backgroundThrottling (a per-window webPreferences flag with no switch, read only at window creation), the
// occlusion switch just has to be set before 'ready' - the whole main-win32.js body runs synchronously before
// 'ready', and the occlusion tracker only inits at first window show. APPENDED (not prepended) + a
// getSwitchValue-merge so we win as the last writer before 'ready' and never clobber a disable-features value
// Qobuz itself may set (a later appendSwitch REPLACES an earlier one for the same switch). Reverted by restore.js
// (it rebuilds main-win32.js from the pristine .qobuzify-bak). No-op on non-Windows.
const OCCLUSION_FIX = "/*qz-occlusion*/;(function(){try{var e=require(\"electron\");var cl=e.app&&e.app.commandLine;if(!cl)return;var cur=cl.getSwitchValue(\"disable-features\")||\"\";var want=\"CalculateNativeWinOcclusion\";if(cur.split(\",\").map(function(s){return s.trim();}).indexOf(want)===-1){cl.appendSwitch(\"disable-features\",cur?cur+\",\"+want:want);}}catch(_){}})();";
// Build the patched main-win32.js in memory. Returns { file, src, bakTmp } or null when there is no main
// bundle; install() does the writing, so nothing lands until every output is ready.
function buildMainProcess(appDir, enable) {
  const mainJs = path.join(appDir, "main-win32.js");
  if (!fs.existsSync(mainJs)) return null;
  const p = readPristine(mainJs); // from the .qobuzify-bak, no prior patch
  let src = p.text;
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
  src = src + "\n" + OCCLUSION_FIX + "\n"; // Windows alt-tab: keep compositing while occluded (see note above)
  return { file: mainJs, src, bakTmp: p.bakTmp };
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
    // manifest.prepend: renderer/runtime bundles that must define their globals BEFORE the extension body
    // runs (e.g. Lyra ships lyra.js + lyra-glue.js which set window.Lyra + window.QZLyricsRenderer). They are
    // concatenated ahead of index.js in listed order (so lyra.js defines window.Lyra before lyra-glue.js
    // wraps it), and inlined into the same payload script.
    let prefix = "";
    for (const pf of (Array.isArray(manifest.prepend) ? manifest.prepend : [])) {
      try { prefix += fs.readFileSync(path.join(base, pf), "utf8") + "\n;\n"; }
      catch (_) { /* a missing prepend file just no-ops, like a missing vendor.js */ }
    }
    source = prefix + source;
    // SYNTAX GATE. An extension that does not parse is dead at runtime, and the failure is invisible
    // everywhere except on a device: the payload still bakes, still ships, the runtime still loads, and
    // only THAT extension silently never mounts. 0.3.0 shipped exactly this way - one stray backtick
    // inside mobile-app's CSS (which lives in a JS template literal) terminated the string, mobile-app
    // died, and the Android build came up showing the desktop UI with no mobile interface at all.
    // Extensions run as function(Qobuzify){...}, so that is how we parse-check them.
    try {
      new Function("Qobuzify", source);
    } catch (e) {
      throw new Error("extension '" + (manifest.id || d.name) + "' does not parse, refusing to bake: " +
                      e.message + "\n  (a backtick or ${ inside a template literal is the usual cause)");
    }
    // A big prebuilt bundle (e.g. a vendored renderer) ships as a sibling vendor.js loaded
    // via <script src> at runtime - NOT inlined (it would break the inline payload).
    const hasVendor = fs.existsSync(path.join(base, "vendor.js"));
    return {
      id: manifest.id || d.name, name: manifest.name || d.name, description: manifest.description || "",
      icon: manifest.icon || "", version: manifest.version || "", author: manifest.author || "",
      defaultOn: !!manifest.defaultOn, source, hasVendor
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
  if (html.includes(anchor)) html = html.replace(anchor, tag + "    " + anchor);
  else html = html.replace("</head>", tag + "</head>");
  // Both anchors are plain string replaces that silently no-op on a layout change; without this
  // assert the install prints green with nothing patched.
  if (!html.includes(`<script id="${RUNTIME_ID}">`)) {
    throw new Error("Qobuz layout changed; Qobuzify needs an update (no injection anchor found in app.html).");
  }
  return html;
}

// Install (or refresh) the runtime. `def`/`seed` let the CLI assert a starting
// theme on the next launch; switching afterward is live and in-app.
//
// Nothing is written until all three outputs (app.html, legacy.css, main-win32.js) are built in memory and
// staged as *.tmp, so a failure part-way (a layout change, a locked file, a full disk) leaves Qobuz exactly
// as it was. Then: new backups first, then main-win32.js, then legacy.css, and app.html LAST, so the worst
// an interruption can leave is the main bridge without the page patch (harmless), never the reverse.
function install(paths, cfg, opts = {}) {
  const doRelaunch = opts.relaunch !== false;
  const staged = []; // { tmp, file } in commit order
  try {
    const html = readPristine(paths.appHtml);
    if (html.bakTmp) staged.push({ tmp: html.bakTmp, file: paths.appHtml + BAK });
    const css = readPristine(paths.legacyCss);
    if (css.bakTmp) staged.push({ tmp: css.bakTmp, file: paths.legacyCss + BAK });
    const main = buildMainProcess(path.dirname(paths.appHtml), !!cfg.apple); // Apple Music Origin rewrite (only with creds)
    if (main && main.bakTmp) staged.push({ tmp: main.bakTmp, file: main.file + BAK });
    const htmlOut = injectRuntime(html.text, buildPayload(cfg));
    if (main) staged.push({ tmp: writeTmp(main.file, main.src), file: main.file });
    staged.push({ tmp: writeTmp(paths.legacyCss, css.text), file: paths.legacyCss }); // keep legacy stock
    staged.push({ tmp: writeTmp(paths.appHtml, htmlOut), file: paths.appHtml });
  } catch (e) {
    const mainJs = path.join(path.dirname(paths.appHtml), "main-win32.js");
    const leftovers = staged.map((s) => s.tmp).concat([paths.appHtml, paths.legacyCss, mainJs].map((f) => f + ".tmp"));
    for (const t of leftovers) { try { fs.unlinkSync(t); } catch (_) {} }
    throw e;
  }
  for (const s of staged) commitTmp(s.tmp, s.file);
  // copy big extension bundles into the dist dir so the extension can <script src="/qobuzify-ext-<id>.js">
  if (cfg.vendors && cfg.vendors.length) {
    const distDir = path.dirname(path.dirname(path.dirname(path.dirname(paths.legacyCss)))); // .../dist
    for (const v of cfg.vendors) { try { fs.copyFileSync(v.src, path.join(distDir, v.name)); } catch (_) {} }
  }
  if (doRelaunch) relaunch(paths.launcher);
}

module.exports = { install, buildCatalog, buildExtensions, buildPayload, injectRuntime, relaunch, qobuzRunning, writeAtomic, looksPristine, BAK, RUNTIME_ID };
