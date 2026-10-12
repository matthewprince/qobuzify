// Right-click a track to copy it - either "Artist - Title" or a shareable Qobuz link.
// Runs as function(Qobuzify){ ... return cleanup }.
//
// Works on list rows (.ListItem / .track-item) and on the player bar's current track. The
// title and artist come straight off the row's DOM (or the player API, for the bar), and the
// link is a play.qobuz.com url built from whatever /album/ or /track/ id the row points at.
// Clipboard writes go through the async API with an execCommand fallback, since a file:// origin
// doesn't reliably get clipboard permission. A small toast confirms it landed.
var Q = Qobuzify;
var CSS_ID = "qz-copy-css";

function copyText(text) {
  return new Promise(function (res, rej) {
    function fallback() { try { var ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.left = "-9999px"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); res(); } catch (e) { rej(e); } }
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(res, fallback); return; } } catch (e) {}
    fallback();
  });
}
function idFrom(href, kind) { if (!href) return null; var m = href.match(new RegExp("/" + kind + "/([^/?#]+)")); return m ? m[1] : null; }
function qobuzLink(info) {
  if (info.trackId) return "https://play.qobuz.com/track/" + info.trackId;
  if (info.albumId) return "https://play.qobuz.com/album/" + info.albumId;
  return null;
}
function rowInfo(row) {
  var titleEl = row.querySelector(".ListItem__title, .track-name, .ListItem__titleWithArtists");
  var title = titleEl ? titleEl.textContent.trim() : "";
  var artistEl = row.querySelector('a[href*="/artist/"]');
  var artist = artistEl ? artistEl.textContent.trim() : "";
  var albumA = row.querySelector('a[href*="/album/"]'); var trackA = row.querySelector('a[href*="/track/"]');
  return { title: title, artist: artist, albumId: albumA ? idFrom(albumA.getAttribute("href"), "album") : null, trackId: trackA ? idFrom(trackA.getAttribute("href"), "track") : null };
}
function playerInfo() {
  var t = Q.player.getTrack() || {};
  return { title: t.title || "", artist: t.artist || (t.artists || [])[0] || "", albumId: t.albumId || null, trackId: t.id || null };
}

// --- menu ---
function removeMenu() { var m = document.getElementById("qz-copy-menu"); if (m) m.remove(); document.removeEventListener("mousedown", onDocDown, true); document.removeEventListener("keydown", onEsc, true); window.removeEventListener("blur", removeMenu); document.removeEventListener("scroll", removeMenu, true); }
function onDocDown(e) { var m = document.getElementById("qz-copy-menu"); if (m && !m.contains(e.target)) removeMenu(); }
function onEsc(e) { if (e.key === "Escape") removeMenu(); }
function toastCopy(label) { toast("Copied " + label); }
function showMenu(x, y, info, radioSeed) {
  removeMenu();
  var link = qobuzLink(info);
  var opts = [];
  // Smart Radio owns the engine; this menu already owns the right-click on track rows, so when that
  // extension is enabled its song radio is offered here rather than as a second competing menu.
  if (radioSeed) opts.push({ label: "Start song radio", act: function () { try { window.__qzSmartRadio.songRadio(radioSeed); } catch (e) {} } });
  if (info.artist || info.title) opts.push({ label: 'Copy "Artist - Title"', text: [info.artist, info.title].filter(Boolean).join(" - "), t: "track" });
  if (info.title) opts.push({ label: "Copy title", text: info.title, t: "title" });
  if (info.artist) opts.push({ label: "Copy artist", text: info.artist, t: "artist" });
  if (link) opts.push({ label: "Copy Qobuz link", text: link, t: "link" });
  if (!opts.length) return;
  var m = document.createElement("div"); m.id = "qz-copy-menu"; m.className = "qz-copy-menu";
  Q.ui.follow(m);
  opts.forEach(function (o) {
    var b = document.createElement("button"); b.className = "qz-copy-item"; b.textContent = o.label;
    b.addEventListener("click", function (e) {
      e.stopPropagation(); removeMenu();
      if (o.act) { o.act(); return; }
      copyText(o.text).then(function () { toastCopy(o.t); }, function () { toast("Copy failed"); });
    });
    m.appendChild(b);
  });
  m.style.visibility = "hidden"; document.body.appendChild(m);
  var mw = m.offsetWidth, mh = m.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
  m.style.left = Math.min(x, vw - mw - 8) + "px"; m.style.top = Math.min(y, vh - mh - 8) + "px"; m.style.visibility = "";
  setTimeout(function () { document.addEventListener("mousedown", onDocDown, true); document.addEventListener("keydown", onEsc, true); window.addEventListener("blur", removeMenu); document.addEventListener("scroll", removeMenu, true); }, 0);
}
function onContext(e) {
  // don't hijack right-clicks on Qobuzify's own player-bar controls (e.g. the Playlist Context
  // chip) - let the extension that owns that button handle its own menu
  if (e.target.closest && e.target.closest(".qz-slot-left, .qz-slot-right, [data-qz-slot]")) return;
  var inPlayer = e.target.closest(".player__track, .player__content, .player__track-infos");
  var row = e.target.closest(".ListItem, .track-item");
  var info = null;
  if (row) info = rowInfo(row);
  else if (inPlayer) info = playerInfo();
  if (!info || (!info.title && !info.artist)) return;
  var radioSeed = null;
  try {
    var sr = window.__qzSmartRadio;
    if (sr && sr.songRadio) {
      radioSeed = row && sr.seedFromEvent ? sr.seedFromEvent(e) : null;
      // the player bar has no row to parse; the currently playing track id is right there on the API
      if (!radioSeed && inPlayer && info.trackId) radioSeed = { trackId: info.trackId, title: info.title, artist: info.artist };
    }
  } catch (err) {}
  e.preventDefault(); e.stopPropagation();
  showMenu(e.clientX, e.clientY, info, radioSeed);
}

Q.css(CSS_ID, [
  // the menu is appended to <body> and follows Qobuz's appearance (Q.ui.follow)
  ".qz-copy-menu{position:fixed;z-index:2147483600;min-width:186px;padding:6px;box-sizing:border-box;",
  "background:var(--qzu-surface);color:var(--qzu-fg);border:1px solid var(--qzu-line);",
  "border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.35);}",
  ".qz-copy-item{display:block;width:100%;text-align:left;appearance:none;border:0;background:transparent;color:inherit;",
  "font:inherit;font-size:13px;font-weight:550;padding:9px 11px;border-radius:8px;cursor:pointer;transition:background .12s,color .12s;}",
  ".qz-copy-item:hover{background:color-mix(in srgb,var(--qz-accent,#3DA8FE) 18%,transparent);color:var(--qz-accent,#3DA8FE);}"
].join(""));

// one toast at a time, as before: a new message updates the open one and restarts its timer
var curToast = null, toastT = null;
function toast(msg) {
  clearTimeout(toastT);
  if (curToast) curToast.update(msg);
  else { var t = curToast = Q.ui.toast(msg, { timeout: 0, onClose: function () { if (curToast === t) curToast = null; } }); }
  var mine = curToast;
  toastT = setTimeout(function () { mine.close(); }, 1600);
}
function closeToast() { clearTimeout(toastT); if (curToast) curToast.close(); }

document.addEventListener("contextmenu", onContext, true);

return function cleanup() {
  document.removeEventListener("contextmenu", onContext, true);
  removeMenu();
  closeToast();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
