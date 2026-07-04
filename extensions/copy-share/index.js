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
function showMenu(x, y, info) {
  removeMenu();
  var link = qobuzLink(info);
  var opts = [];
  if (info.artist || info.title) opts.push({ label: 'Copy "Artist - Title"', text: [info.artist, info.title].filter(Boolean).join(" - "), t: "track" });
  if (info.title) opts.push({ label: "Copy title", text: info.title, t: "title" });
  if (info.artist) opts.push({ label: "Copy artist", text: info.artist, t: "artist" });
  if (link) opts.push({ label: "Copy Qobuz link", text: link, t: "link" });
  if (!opts.length) return;
  var m = document.createElement("div"); m.id = "qz-copy-menu"; m.className = "qz-copy-menu";
  opts.forEach(function (o) {
    var b = document.createElement("button"); b.className = "qz-copy-item"; b.textContent = o.label;
    b.addEventListener("click", function (e) { e.stopPropagation(); copyText(o.text).then(function () { toastCopy(o.t); }, function () { toast("Copy failed"); }); removeMenu(); });
    m.appendChild(b);
  });
  m.style.visibility = "hidden"; document.body.appendChild(m);
  var mw = m.offsetWidth, mh = m.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
  m.style.left = Math.min(x, vw - mw - 8) + "px"; m.style.top = Math.min(y, vh - mh - 8) + "px"; m.style.visibility = "";
  setTimeout(function () { document.addEventListener("mousedown", onDocDown, true); document.addEventListener("keydown", onEsc, true); window.addEventListener("blur", removeMenu); document.addEventListener("scroll", removeMenu, true); }, 0);
}
function onContext(e) {
  var inPlayer = e.target.closest(".player__track, .player__content, .player__track-infos");
  var row = e.target.closest(".ListItem, .track-item");
  var info = null;
  if (row) info = rowInfo(row);
  else if (inPlayer) info = playerInfo();
  if (!info || (!info.title && !info.artist)) return;
  e.preventDefault(); e.stopPropagation();
  showMenu(e.clientX, e.clientY, info);
}

Q.css(CSS_ID, [
  ".qz-copy-menu{position:fixed;z-index:2147483600;min-width:186px;padding:6px;",
  "background:linear-gradient(180deg,rgba(22,25,33,.98),rgba(13,15,21,.99));border:1px solid rgba(255,255,255,.12);",
  "border-radius:12px;box-shadow:0 24px 70px rgba(0,0,0,.6),0 0 40px -22px var(--qz-accent,#3DA8FE);}",
  ".qz-copy-item{display:block;width:100%;text-align:left;appearance:none;border:0;background:transparent;color:#e7ecf3;",
  "font:inherit;font-size:13px;font-weight:550;padding:9px 11px;border-radius:8px;cursor:pointer;transition:background .12s,color .12s;}",
  ".qz-copy-item:hover{background:color-mix(in srgb,var(--qz-accent,#3DA8FE) 18%,transparent);color:var(--qz-accent,#3DA8FE);}",
  "#qz-copy-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%) translateY(12px);z-index:2147483600;",
  "padding:10px 17px;border-radius:24px;font-size:13px;font-weight:600;color:#06090a;background:var(--qz-accent,#3DA8FE);",
  "box-shadow:0 16px 44px -12px rgba(0,0,0,.6);opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;white-space:nowrap;}",
  "#qz-copy-toast.qz-show{opacity:1;transform:translateX(-50%) translateY(0);}"
].join(""));

var toastT = null;
function toast(msg) {
  var t = document.getElementById("qz-copy-toast");
  if (!t) { t = document.createElement("div"); t.id = "qz-copy-toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("qz-show");
  clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove("qz-show"); }, 1600);
}

document.addEventListener("contextmenu", onContext, true);

return function cleanup() {
  document.removeEventListener("contextmenu", onContext, true);
  removeMenu();
  var t = document.getElementById("qz-copy-toast"); if (t) t.remove();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
