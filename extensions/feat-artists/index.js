// Qobuz only shows the main artist on a track row - anyone featured or collaborating is buried in
// the credits. This digs them back out and shows them inline. Runs as function(Qobuzify).
//
// The performers ride along in the normal album/get (or playlist/get) response as track.performers,
// a string like "Name, Role, Role - Name, Role - ...", so one fetch per page (cached per id) covers
// every row - no special credits endpoint, no per-track lookups. Pull the main + featured names out
// of it and, if there's more than the one already on the row, tack " feat. X, Y" onto the end.
var Q = Qobuzify;
var CSS_ID = "qz-fa-css";
var MARK = "data-qz-fa";

function route() { try { return Q.getState().router.location.pathname || ""; } catch (e) { return ""; } }
function ctx() { var m = route().match(/\/(album|playlist)\/([^/?#]+)/); return m ? { kind: m[1], id: m[2] } : null; }
function norm(s) { return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").replace(/[’'`]/g, "").trim(); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

// grab the main + featured artist names (in order, deduped) out of a performers string
function performerArtists(str) {
  if (!str) return [];
  var out = [], seen = {};
  String(str).split(" - ").forEach(function (seg) {
    var parts = seg.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.length < 2) return;
    var name = parts[0], roles = parts.slice(1).join(" ");
    if (/(Main\s*Artist|Featured\s*Artist)/i.test(roles)) {
      var k = norm(name);
      if (k && !seen[k]) { seen[k] = 1; out.push(name); }
    }
  });
  return out;
}

// --- build a title -> performers map from the loaded track list ---
var cache = {}; // ctxKey -> { normTitle: performers }
function loadMap(c) {
  var key = c.kind + ":" + c.id;
  if (cache[key]) return Promise.resolve(cache[key]);
  var p;
  if (c.kind === "album") p = Q.api("album/get?album_id=" + c.id).then(function (j) { return (j.tracks && j.tracks.items) || []; });
  else {
    var all = [];
    var page = function (off) { return Q.api("playlist/get?playlist_id=" + c.id + "&extra=tracks&limit=500&offset=" + off).then(function (j) { var t = (j.tracks && j.tracks.items) || []; all = all.concat(t); var total = (j.tracks && j.tracks.total) || all.length; if (all.length < total && t.length) return page(all.length); return all; }); };
    p = page(0);
  }
  return p.then(function (tracks) {
    var map = {};
    tracks.forEach(function (t) { if (t && t.title && t.performers) { var nt = norm(t.title); if (!map[nt]) map[nt] = t.performers; } });
    cache[key] = map; return map;
  }).catch(function () { cache[key] = {}; return {}; });
}

// --- stick the feat. onto each row ---
function titleOf(row) { var el = row.querySelector(".ListItem__title"); if (!el) return ""; var clone = el.cloneNode(true); var b = clone.querySelector(".qz-badge, .qz-fa-feat"); if (b) b.remove(); return clone.textContent || ""; }
function augmentRow(row, map) {
  var title = titleOf(row); if (!title) return;
  var nt = norm(title);
  if (row.getAttribute(MARK) === nt) return; // done already (rows get recycled as you scroll)
  var old = row.querySelector(".qz-fa-feat"); if (old) old.remove();
  row.setAttribute(MARK, nt);
  var performers = map[nt]; if (!performers) return;
  var names = performerArtists(performers);
  if (names.length < 2) return; // just the main artist, nothing to add
  var artistWrap = row.querySelector(".ListItem__artists") || row.querySelector(".ListItem__artist") && row.querySelector(".ListItem__artist").parentNode;
  if (!artistWrap) return;
  // first name is the one already on the row; the rest are the feats/collaborators
  var feats = names.slice(1);
  if (!feats.length) return;
  var span = document.createElement("span");
  span.className = "qz-fa-feat";
  span.textContent = " feat. " + feats.join(", ");
  artistWrap.appendChild(span);
}
function scan() {
  var c = ctx(); if (!c) return;
  loadMap(c).then(function (map) {
    if (!ctx() || (ctx().id !== c.id)) return; // bailed to another page mid-load
    var rows = document.querySelectorAll(".ListItem");
    for (var i = 0; i < rows.length; i++) { if (rows[i].querySelector(".ListItem__title") && rows[i].querySelector(".ListItem__artist")) augmentRow(rows[i], map); }
  });
}

Q.css(CSS_ID, [
  ".qz-fa-feat{color:#8b94a3;font-weight:600;}",
  ".ListItem__artist--isClickable + .qz-fa-feat,.ListItem__artist + .qz-fa-feat{margin-left:2px;}"
].join(""));

var offRoute = Q.onRoute(function () { setTimeout(scan, 400); });
var obs = Q.observe(function () { scan(); }, { debounce: 300 });
scan();

return function cleanup() {
  if (offRoute) offRoute();
  if (obs) obs();
  document.querySelectorAll(".qz-fa-feat").forEach(function (e) { e.remove(); });
  document.querySelectorAll("[" + MARK + "]").forEach(function (e) { e.removeAttribute(MARK); });
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
