#!/usr/bin/env node
// Qobuzify - Spicetify, but for Qobuz. Theme and extend the Qobuz desktop app.
// `install`/`apply` inject an in-app runtime (a Marketplace + a Qobuzify menu
// entry in the account dropdown); theme switching then happens live inside Qobuz.
const fs = require("fs");
const path = require("path");
const { locate } = require("../lib/locate");
const { install, buildCatalog, buildExtensions, RUNTIME_ID } = require("../lib/apply");
const { restore } = require("../lib/restore");
const autopatch = require("../lib/autopatch");

const ROOT = path.join(__dirname, "..");
const THEMES_DIR = path.join(ROOT, "themes");
const EXT_DIR = path.join(ROOT, "extensions");
const RUNTIME = path.join(ROOT, "runtime", "qobuzify-runtime.js");
const DEFAULT_THEME = "glass";

// A small state file kept as a SIBLING of the install dir (so the installer's re-extract, which wipes the
// install dir, leaves it alone). It survives a QOBUZ app-version update too - that update replaces app.html
// with a fresh copy that no longer has our baked block, so currentSeed()/currentTheme() read null on the next
// `qobuzify install`; without a saved seed the reinstall would bake a new one and the runtime's boot logic
// would reset the user's theme + re-enable theming. localStorage itself is a single `file://` bucket and
// survives the update, so per-extension on/off flags are already safe - only the seed/theme need this.
const STATE_FILE = path.join(ROOT, "..", ".qobuzify-state.json");
function readState() { try { const o = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); return (o && typeof o === "object") ? o : {}; } catch (_) { return {}; } }
function saveState(patch) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(Object.assign(readState(), patch))); } catch (_) {} }

function version() {
  try { return require(path.join(ROOT, "package.json")).version || "0.1.0"; } catch (_) { return "0.1.0"; }
}

function listThemes() {
  try { return buildCatalog(THEMES_DIR).map((t) => t.slug); } catch (_) { return []; }
}

// Read the theme/seed currently baked into app.html, so a re-install (the update path, spotify
// refreshes) can preserve them. A new seed forces `def` as the active theme on next launch; reusing
// the existing seed means the user's live in-app theme choice survives an update untouched.
function currentTheme() {
  try { const m = fs.readFileSync(locate().appHtml, "utf8").match(/"def":"([^"]+)"/); return m ? m[1] : null; } catch (_) { return null; }
}
function currentSeed() {
  try { const m = fs.readFileSync(locate().appHtml, "utf8").match(/"seed":(\d+)/); return m ? parseInt(m[1], 10) : null; } catch (_) { return null; }
}

// Inject the runtime + full theme catalog, asserting `def` as the starting theme. A fresh `seed`
// forces `def` on next launch; pass the existing seed to leave the live theme choice alone.
// opts.explicit: the user typed this theme, so a typo is an error. Otherwise (update, reapply) the theme
// came from the baked block or the state file and may name a theme a newer Qobuzify no longer ships: fall
// back to the default rather than refusing to update at all.
// opts.relaunch: false to patch without restarting Qobuz.
function installRuntime(def, seed, opts = {}) {
  const catalog = buildCatalog(THEMES_DIR);
  if (def && !catalog.some((t) => t.slug === def)) {
    if (opts.explicit) throw new Error(`Theme "${def}" not found. Run: qobuzify list`);
    const fallback = catalog.some((t) => t.slug === DEFAULT_THEME) ? DEFAULT_THEME : (catalog[0] && catalog[0].slug);
    if (!fallback) throw new Error("No themes found in " + THEMES_DIR);
    console.error(`Theme "${def}" is no longer included; using "${fallback}" instead.`);
    def = fallback;
  }
  const extensions = buildExtensions(EXT_DIR);
  const runtimeSrc = fs.readFileSync(RUNTIME, "utf8");
  // Spotify creds are NO LONGER injected: the client-side ISRC->Spotify bridge was removed, so no local
  // Spotify request is ever made and no client_secret ships in the payload. The server does all Spotify-id
  // resolution from the ISRC. (The .spotify-* files, if present, are now ignored.)
  const spotify = null;
  const spotifyToken = null;
  let apple = null; // Apple Music TTML (syllable lyrics + duet agents): your own dev + media-user tokens, local only
  try { const a = JSON.parse(fs.readFileSync(path.join(ROOT, ".apple-creds.json"), "utf8")); if (a.developer_token && a.media_user_token) apple = { developer_token: a.developer_token, media_user_token: a.media_user_token, storefront: a.storefront || "us" }; } catch (_) {}
  // A prebuilt sibling bundle (extension/vendor.js) ships as its own file rather than inlined. None ship
  // one today - the lyrics view renders through Lyra, which is prepended into the payload - so this is
  // empty, but the plumbing stays for any future vendor-bearing extension.
  const vendors = extensions.filter((e) => e.hasVendor).map((e) => ({ name: "qobuzify-ext-" + e.id + ".js", src: path.join(EXT_DIR, e.id, "vendor.js") }));
  install(locate(), { catalog, extensions, def: def || DEFAULT_THEME, version: version(), seed: seed || Date.now(), runtimeSrc, spotify, spotifyToken, apple, vendors },
    { relaunch: opts.relaunch !== false });
  return catalog.find((t) => t.slug === (def || DEFAULT_THEME));
}

// Install/refresh the auto-reapply task unless the user turned it off with `qobuzify autopatch off`.
function ensureAutopatch() {
  if (process.platform !== "win32" || readState().autopatch === false) return;
  const r = autopatch.enable(ROOT);
  if (r.ok) console.log("Qobuz updates are re-patched automatically (turn off with: qobuzify autopatch off).");
  else console.error("Could not set up automatic re-patching after Qobuz updates (" + r.reason + "). Run qobuzify update after a Qobuz update.");
}

// Run by the auto-reapply Scheduled Task. Quiet, never relaunches Qobuz, and does nothing unless the
// newest app-* folder is unpatched AND Squirrel has finished writing it (nothing in it changed in the last
// two minutes; a half-unpacked folder would otherwise give us a truncated file to back up).
const SETTLE_MS = 2 * 60 * 1000;
function reapply() {
  let p;
  try { p = locate(); } catch (_) { return 0; } // Qobuz missing or mid-update (files not there yet): next run
  let html;
  try { html = fs.readFileSync(p.appHtml, "utf8"); } catch (_) { return 0; }
  if (html.includes(`<script id="${RUNTIME_ID}">`)) return 0; // already patched: the common case
  const files = [p.appDir, p.appHtml, p.legacyCss, path.join(path.dirname(p.appHtml), "main-win32.js")];
  const newest = Math.max(...files.map((f) => { try { return fs.statSync(f).mtimeMs; } catch (_) { return 0; } }));
  if (Date.now() - newest < SETTLE_MS) return 0;
  const st = readState();
  const def = st.theme || DEFAULT_THEME;
  const seed = st.seed || Date.now();
  try {
    const t = installRuntime(def, seed, { relaunch: false });
    saveState({ seed, theme: t ? t.slug : def, lastReapply: { at: new Date().toISOString(), version: p.version, ok: true } });
    return 0;
  } catch (e) {
    saveState({ lastReapply: { at: new Date().toISOString(), version: p.version, ok: false, error: String(e.message).slice(0, 300) } });
    return 1;
  }
}

function usage() {
  console.log("Qobuzify - Spicetify, but for Qobuz\n");
  console.log("Usage:");
  console.log("  qobuzify detect           show the Qobuz install Qobuzify will patch");
  console.log("  qobuzify list             list available themes");
  console.log("  qobuzify install [theme]  install the in-app Marketplace (default theme optional)");
  console.log("  qobuzify update           re-apply the current files, keeping your theme and settings");
  console.log("  qobuzify apply <theme>    set a theme and relaunch (switch live from the Marketplace after)");
  console.log("  qobuzify restore          revert to the stock Qobuz UI and remove the auto-reapply task");
  console.log("  qobuzify autopatch [on|off]  show, turn on or turn off automatic re-patching");
  console.log("");
  console.log("Qobuz updates itself into a fresh, unpatched folder. On Windows, install/update/apply also");
  console.log("create a per-user Scheduled Task (\"Qobuzify Auto-Reapply\", no admin needed) that runs");
  console.log("`qobuzify reapply` every 15 minutes: when the newest Qobuz is unpatched it re-applies your");
  console.log("theme and settings, without restarting Qobuz. `qobuzify restore` removes the task.");
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "detect": {
        const p = locate();
        console.log("Qobuz found:");
        console.log("  version   " + p.version);
        console.log("  app dir   " + p.appDir);
        console.log("  app.html  " + p.appHtml);
        console.log("  legacy    " + p.legacyCss);
        console.log("  launcher  " + p.launcher);
        break;
      }
      case "list":
        console.log("Themes:\n  " + (listThemes().join("\n  ") || "(none)"));
        break;
      case "install":
      case "update": {
        // An explicit theme forces it (fresh seed). No theme = keep what's already there: reuse the baked
        // theme + seed so re-running the installer to update never resets the user's live choice. If a Qobuz
        // app update wiped the baked block from app.html, fall back to the seed/theme saved in STATE_FILE so
        // the reinstall still preserves them. Only a truly fresh machine (no baked block, no state) gets a
        // new seed + the default theme.
        const existingSeed = currentSeed();
        const st = readState();
        const def = arg || currentTheme() || st.theme || DEFAULT_THEME;
        const seed = arg ? Date.now() : (existingSeed || st.seed || Date.now());
        const t = installRuntime(def, seed, { explicit: !!arg });
        saveState({ seed, theme: t ? t.slug : def });
        const verb = (existingSeed || st.seed) ? "Updated" : "Installed";
        console.log(`${verb} Qobuzify v${version()} (theme "${t ? t.name : DEFAULT_THEME}").`);
        console.log("In Qobuz: click your avatar (top-right) > Marketplace to browse and switch themes live.");
        ensureAutopatch();
        break;
      }
      case "apply": {
        if (!arg) throw new Error("Usage: qobuzify apply <theme>  (or: qobuzify install)");
        const seed = Date.now();
        const t = installRuntime(arg, seed, { explicit: true });
        saveState({ seed, theme: arg });
        console.log(`Applied "${t ? t.name : arg}" and relaunched Qobuz.`);
        console.log("Switch themes live from the avatar menu > Marketplace.");
        ensureAutopatch();
        break;
      }
      case "reapply":
        process.exit(reapply());
        break;
      case "autopatch": {
        if (process.platform !== "win32") throw new Error("Automatic re-patching is Windows-only (it follows the Qobuz desktop app's own updater).");
        if (arg === "off") {
          const r = autopatch.disable(ROOT);
          saveState({ autopatch: false });
          console.log(r.ok ? "Automatic re-patching is off. Run qobuzify update after each Qobuz update." : "Could not remove the scheduled task \"" + autopatch.TASK_NAME + "\"; remove it in Task Scheduler.");
        } else if (arg === "on") {
          saveState({ autopatch: true });
          const r = autopatch.enable(ROOT);
          if (!r.ok) throw new Error("Could not create the scheduled task: " + r.reason);
          console.log("Automatic re-patching is on: Qobuzify is re-applied within 15 minutes of a Qobuz update.");
        } else {
          const st = readState();
          console.log("Automatic re-patching: " + (autopatch.status().installed ? "on" : "off") + " (task \"" + autopatch.TASK_NAME + "\")");
          if (st.lastReapply) console.log("Last re-patch: " + st.lastReapply.at + " Qobuz " + st.lastReapply.version + (st.lastReapply.ok ? " ok" : " FAILED: " + st.lastReapply.error));
        }
        break;
      }
      case "restore": {
        // Remove the auto-reapply task first, so it can't patch Qobuz straight back after the restore.
        const a = autopatch.disable(ROOT);
        if (!a.ok) console.error("Could not remove the scheduled task \"" + autopatch.TASK_NAME + "\"; remove it in Task Scheduler.");
        const n = restore(locate());
        console.log(n ? "Restored Qobuz to stock and relaunched." : "No Qobuzify backups found; nothing to restore.");
        break;
      }
      default:
        usage();
    }
  } catch (e) {
    console.error("Error: " + e.message);
    process.exit(1);
  }
}

main();
