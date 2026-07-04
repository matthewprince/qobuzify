// Restore the stock Qobuz UI by copying the *.qobuzify-bak backups back over
// the patched files. Backups are kept so a later `apply` still works.
const fs = require("fs");
const path = require("path");
const { relaunch } = require("./apply");

const BAK = ".qobuzify-bak";

function restore(paths, opts = {}) {
  const doRelaunch = opts.relaunch !== false;
  let restored = 0;
  // main-win32.js carries the Qobuzify Lyrics header rewrite; revert it too.
  const mainJs = path.join(path.dirname(paths.appHtml), "main-win32.js");
  for (const file of [paths.appHtml, paths.legacyCss, mainJs]) {
    const bak = file + BAK;
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, file);
      restored++;
    }
  }
  if (doRelaunch && restored) relaunch(paths.launcher);
  return restored;
}

module.exports = { restore };
