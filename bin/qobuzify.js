#!/usr/bin/env node
// Qobuzify - Spicetify, but for Qobuz. Theme and extend the Qobuz desktop app.
// `install`/`apply` inject an in-app runtime (a Marketplace + a Qobuzify menu
// entry in the account dropdown); theme switching then happens live inside Qobuz.
const fs = require("fs");
const path = require("path");
const { locate } = require("../lib/locate");
const { install, buildCatalog, buildExtensions } = require("../lib/apply");
const { restore } = require("../lib/restore");

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
function installRuntime(def, seed) {
  const catalog = buildCatalog(THEMES_DIR);
  if (def && !catalog.some((t) => t.slug === def)) {
    throw new Error(`Theme "${def}" not found. Run: qobuzify list`);
  }
  const extensions = buildExtensions(EXT_DIR);
  const runtimeSrc = fs.readFileSync(RUNTIME, "utf8");
  let spotify = null; // local-only creds for the Qobuzify Lyrics ISRC->Spotify bridge
  try { const c = JSON.parse(fs.readFileSync(path.join(ROOT, ".spotify-creds.json"), "utf8")); if (c.client_id && !/YOUR_/.test(c.client_id)) spotify = { client_id: c.client_id, client_secret: c.client_secret }; } catch (_) {}
  let spotifyToken = null; // (vestigial) optional Spotify user token; the lyrics view uses open sources by default
  try { const tk = JSON.parse(fs.readFileSync(path.join(ROOT, ".spotify-user-token.json"), "utf8")); if (tk.access_token) spotifyToken = { access_token: tk.access_token, expires_at: tk.expires_at || 0, refresh_token: tk.refresh_token || null }; } catch (_) {}
  let apple = null; // Apple Music TTML (syllable lyrics + duet agents): your own dev + media-user tokens, local only
  try { const a = JSON.parse(fs.readFileSync(path.join(ROOT, ".apple-creds.json"), "utf8")); if (a.developer_token && a.media_user_token) apple = { developer_token: a.developer_token, media_user_token: a.media_user_token, storefront: a.storefront || "us" }; } catch (_) {}
  // A prebuilt sibling bundle (extension/vendor.js) ships as its own file rather than inlined. None ship
  // one today - the lyrics view renders through Lyra, which is prepended into the payload - so this is
  // empty, but the plumbing stays for any future vendor-bearing extension.
  const vendors = extensions.filter((e) => e.hasVendor).map((e) => ({ name: "qobuzify-ext-" + e.id + ".js", src: path.join(EXT_DIR, e.id, "vendor.js") }));
  install(locate(), { catalog, extensions, def: def || DEFAULT_THEME, version: version(), seed: seed || Date.now(), runtimeSrc, spotify, spotifyToken, apple, vendors });
  return catalog.find((t) => t.slug === (def || DEFAULT_THEME));
}

function usage() {
  console.log("Qobuzify - Spicetify, but for Qobuz\n");
  console.log("Usage:");
  console.log("  qobuzify detect           show the Qobuz install Qobuzify will patch");
  console.log("  qobuzify list             list available themes");
  console.log("  qobuzify install [theme]  install the in-app Marketplace (default theme optional)");
  console.log("  qobuzify update           re-apply the current files, keeping your theme and settings");
  console.log("  qobuzify apply <theme>    set a theme and relaunch (switch live from the Marketplace after)");
  console.log("  qobuzify restore          revert to the stock Qobuz UI");
  console.log("  qobuzify spotify-login    connect Spotify once (OAuth) so Qobuzify Lyrics gets synced lyrics, auto-renewed");
  console.log("  qobuzify spotify-token    refresh Qobuzify Lyrics' Spotify token from a running Spotify (debug port)");
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
        const t = installRuntime(def, seed);
        saveState({ seed, theme: def });
        const verb = (existingSeed || st.seed) ? "Updated" : "Installed";
        console.log(`${verb} Qobuzify v${version()} (theme "${t ? t.name : DEFAULT_THEME}").`);
        console.log("In Qobuz: click your avatar (top-right) > Marketplace to browse and switch themes live.");
        break;
      }
      case "apply": {
        if (!arg) throw new Error("Usage: qobuzify apply <theme>  (or: qobuzify install)");
        const seed = Date.now();
        const t = installRuntime(arg, seed);
        saveState({ seed, theme: arg });
        console.log(`Applied "${t ? t.name : arg}" and relaunched Qobuz.`);
        console.log("Switch themes live from the avatar menu > Marketplace.");
        break;
      }
      case "restore": {
        const n = restore(locate());
        console.log(n ? "Restored Qobuz to stock and relaunched." : "No Qobuzify backups found; nothing to restore.");
        break;
      }
      case "spotify-login": {
        const { spotifyLogin } = require("../lib/spotify-login");
        let clientId;
        try { clientId = JSON.parse(fs.readFileSync(path.join(ROOT, ".spotify-creds.json"), "utf8")).client_id; } catch (_) {}
        if (!clientId || /YOUR_/.test(clientId)) throw new Error("No Spotify client_id in .spotify-creds.json");
        const port = arg ? parseInt(arg, 10) : 8888;
        console.log("One-time setup: in your Spotify app (developer.spotify.com/dashboard) add this Redirect URI:");
        console.log("  https://127.0.0.1:" + port + "/callback");
        console.log("(Your browser will show a one-time 'not private' warning for the local cert - click through it.)");
        const tok = await spotifyLogin(clientId, { port });
        fs.writeFileSync(path.join(ROOT, ".spotify-user-token.json"), JSON.stringify(tok, null, 2));
        // preserve the user's current theme AND seed so a token refresh doesn't reset the live choice
        installRuntime(currentTheme() || DEFAULT_THEME, currentSeed() || Date.now());
        console.log("\nSpotify connected. Qobuzify Lyrics now uses synced lyrics, and the token auto-renews — no further action needed.");
        break;
      }
      case "spotify-token": {
        const { grabSpotifyToken } = require("../lib/spotify-token");
        const tok = await grabSpotifyToken(arg ? [parseInt(arg, 10)] : null);
        if (!tok) throw new Error("No running Spotify with a debug port found.\n  Launch Spotify with --remote-debugging-port=9222 (keep it open), then re-run: qobuzify spotify-token");
        fs.writeFileSync(path.join(ROOT, ".spotify-user-token.json"), JSON.stringify({ access_token: tok.access_token, expires_at: tok.expires_at }, null, 2));
        // preserve the user's current theme so a token refresh doesn't reset it
        // preserve the user's current theme AND seed so a token refresh doesn't reset the live choice
        installRuntime(currentTheme() || DEFAULT_THEME, currentSeed() || Date.now());
        console.log("Synced Spotify token (valid until " + new Date(tok.expires_at).toLocaleTimeString() + ") and relaunched Qobuz.");
        console.log("Qobuzify Lyrics lyrics work until then; re-run this when they stop.");
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
