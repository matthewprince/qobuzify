// Smoke test: run the real install + restore against throwaway COPIES of the live
// Qobuz files, so we verify the patch logic without touching the real install or
// relaunching anything.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { locate } = require("../lib/locate");
const { install, buildCatalog, buildExtensions } = require("../lib/apply");
const { restore } = require("../lib/restore");

const real = locate();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qobuzify-test-"));
const appHtml = path.join(tmp, "app.html");
const legacyCss = path.join(tmp, "legacy.css");
fs.copyFileSync(real.appHtml, appHtml);
fs.copyFileSync(real.legacyCss, legacyCss);
const paths = { appHtml, legacyCss, launcher: "noop" };

let failed = 0;
function check(cond, msg) {
  console.log((cond ? "ok   - " : "FAIL - ") + msg);
  if (!cond) failed++;
}

const runtimeSrc = fs.readFileSync(path.join(__dirname, "..", "runtime", "qobuzify-runtime.js"), "utf8");
const catalog = buildCatalog(path.join(__dirname, "..", "themes"));
check(catalog.length >= 5, "buildCatalog finds the bundled themes");
check(catalog[0].slug === "glass", "catalog is ordered with Glass first");
check(catalog.some((t) => t.slug === "glass" && t.css.length > 100), "catalog attaches the Glass CSS layer");
check(catalog.every((t) => t.preview && t.name), "every theme has a name + preview for the Marketplace");

const extensions = buildExtensions(path.join(__dirname, "..", "extensions"));
check(extensions.length >= 1, "buildExtensions finds the bundled extensions");
check(extensions.some((e) => e.id === "quality-badges" && e.source.length > 100), "quality-badges extension is bundled with source");
extensions.forEach((e) => {
  try { new Function("Qobuzify", e.source); check(true, "extension '" + e.id + "' source compiles"); }
  catch (err) { check(false, "extension '" + e.id + "' source compiles (" + err.message + ")"); }
});

const goldHtml = fs.readFileSync(appHtml, "utf8");

install(paths, { catalog, extensions, def: "matrix", version: "9.9.9", seed: 123, runtimeSrc }, { relaunch: false });
check(fs.readFileSync(appHtml, "utf8").includes('"id":"quality-badges"'), "install bundles extensions into the payload");
const iHtml = fs.readFileSync(appHtml, "utf8");
check(iHtml.includes('<script id="qobuzify-runtime">'), "install injects the runtime script");
check(iHtml.includes("window.__QOBUZIFY__"), "install writes the payload data object");
check(iHtml.includes('"def":"matrix"'), "install sets the requested starting theme");
check(iHtml.includes('"seed":123'), "install stamps the seed");
check(!iHtml.includes('<style id="qobuzify">'), "install leaves no stale static style block");
const block = iHtml.match(/<script id="qobuzify-runtime">([\s\S]*?)<\/script>/);
check(block && !/<\/script/i.test(block[1]), "runtime payload contains no premature </script>");
check(iHtml.indexOf('<script id="qobuzify-runtime">') < iHtml.indexOf('<script src="/bundle.js">'), "runtime is injected before bundle.js");

install(paths, { catalog, def: "matrix", version: "9.9.9", seed: 124, runtimeSrc }, { relaunch: false });
const iTwice = fs.readFileSync(appHtml, "utf8");
check((iTwice.match(/<script id="qobuzify-runtime">/g) || []).length === 1, "re-install does not stack runtime scripts");

restore(paths, { relaunch: false });
check(fs.readFileSync(appHtml, "utf8") === goldHtml, "restore returns app.html to the pristine backup");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED.` : "\nAll smoke checks passed.");
process.exit(failed ? 1 : 0);
