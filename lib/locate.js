// Find the Qobuz desktop install and the two files Qobuzify patches.
// Qobuz ships as an UNPACKED Electron app (no asar) installed by Squirrel, so
// the renderer's HTML/CSS sit as plain files on disk.
const fs = require("fs");
const path = require("path");
const os = require("os");

function qobuzRoot() {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "Qobuz");
  }
  return null; // macOS layout differs; v0.1 is Windows-only (see locate)
}

// Squirrel keeps each version in its own app-<version> dir and launches the
// newest. Pick the most recently modified one.
function currentAppDir(root) {
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^app-/.test(e.name))
    .map((e) => {
      const full = path.join(root, e.name);
      return { name: e.name, full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return dirs[0] || null;
}

function locate() {
  if (process.platform !== "win32") {
    throw new Error("Qobuzify v0.1 is Windows-only for now (macOS planned; Qobuz has no Linux desktop app).");
  }
  const root = qobuzRoot();
  if (!root || !fs.existsSync(root)) {
    throw new Error("Qobuz install not found at " + root + ". Is the Qobuz desktop app installed?");
  }
  const app = currentAppDir(root);
  if (!app) throw new Error("No app-<version> folder under " + root);

  const appResources = path.join(app.full, "resources", "app");
  const appHtml = path.join(appResources, "app.html");
  const legacyCss = path.join(
    appResources, "node_modules", "@qobuz", "qobuz-dwp-ui",
    "dist", "legacy", "assets", "css", "legacy.css"
  );
  const launcher = path.join(root, "Qobuz.exe"); // version-stub launcher

  for (const [label, p] of [["app.html", appHtml], ["legacy.css", legacyCss], ["launcher", launcher]]) {
    if (!fs.existsSync(p)) throw new Error("Expected " + label + " at " + p + " but it is missing.");
  }

  return {
    root,
    version: app.name.replace(/^app-/, ""),
    appDir: app.full,
    appHtml,
    legacyCss,
    launcher,
  };
}

module.exports = { locate };
