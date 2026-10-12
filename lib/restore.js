// Restore the stock Qobuz UI by copying the *.qobuzify-bak backups back over
// the patched files. Backups are kept so a later `apply` still works.
const fs = require("fs");
const path = require("path");
const { relaunch, writeAtomic, looksPristine, BAK } = require("./apply");

function restore(paths, opts = {}) {
  const doRelaunch = opts.relaunch !== false;
  let restored = 0;
  // main-win32.js carries the Qobuzify Lyrics header rewrite; revert it too.
  const mainJs = path.join(path.dirname(paths.appHtml), "main-win32.js");
  for (const file of [paths.appHtml, paths.legacyCss, mainJs]) {
    const bak = file + BAK;
    if (!fs.existsSync(bak)) continue;
    const text = fs.readFileSync(bak, "utf8");
    // Never copy a damaged backup over a working (if patched) file: that would break Qobuz outright.
    if (!looksPristine(file, text)) {
      console.error("Skipped " + path.basename(file) + ": its Qobuzify backup looks damaged. Reinstall the Qobuz desktop app to get a clean copy.");
      continue;
    }
    writeAtomic(file, text); // tmp + rename, so an interrupted restore never leaves a half-written file
    restored++;
  }
  if (doRelaunch && restored) relaunch(paths.launcher);
  return restored;
}

module.exports = { restore };
