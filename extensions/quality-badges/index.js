// Puts Qobuz's own Hi-Res Audio logo on hi-res tracks, reusing the app's bundled hires.png so it
// looks native. Only hi-res gets a badge - CD and lossy tracks show nothing, which is the point:
// hi-res becomes easy to spot at a glance. Runs as function(Qobuzify){ ... return cleanup }.
//
// Every surface here is a .ListItem row. On an album page the tier is matched by track number
// against the route album; on the playlist / favorites / search tables each row links to its own
// /album/ instead. Tier comes from Qobuz's album/get, cached per album id so we fetch each once.
var Q = Qobuzify;
var STYLE_ID = "qz-badges-css";
// Qobuz's own Hi-Res AUDIO badge, relative to app.html (verified it loads from here).
var HIRES_IMG = "node_modules/@qobuz/qobuz-dwp-ui/dist/assets/images/logos/hires.png";
var albums = {}; // albumId -> "loading" | { byNum:{n:tier}, order:[tier], albumTier }

Q.css(STYLE_ID, [
  ".qz-badge{display:inline-flex;align-items:center;vertical-align:middle;margin-left:8px;flex:0 0 auto;}",
  ".qz-badge img{height:26px;width:auto;display:block;}",
  // track table: park the badge at the right edge of the Genre column (between Genre and Duration)
  ".ListItem__genre{position:relative;}",
  ".ListItem__genre:has(.qz-badge){overflow:visible;}", // the cell is ~18px + clips; let the 26px badge show
  ".qz-badge--col{position:absolute;right:12px;top:50%;transform:translateY(-50%);margin:0;}"
].join(""));

function tierOf(o) {
  var bd = o.maximum_bit_depth || (o.hires ? 24 : 16);
  if (o.hires || bd >= 24) return { tier: "hires" };
  if (bd >= 16) return { tier: "lossless" };
  return { tier: "lossy" };
}
function badgeEl() {
  var s = document.createElement("span");
  s.className = "qz-badge"; s.setAttribute("data-qz-badge", "1"); s.title = "Hi-Res Audio";
  var im = document.createElement("img"); im.src = HIRES_IMG; im.alt = "Hi-Res Audio"; im.setAttribute("draggable", "false");
  s.appendChild(im); return s;
}
// Only hi-res tracks get a badge - no badge means it's not hi-res (CD/lossy show nothing).
function addBadge(host, q, col) {
  if (!host || !q || q.tier !== "hires" || host.querySelector("[data-qz-badge]")) return;
  var el = badgeEl(); if (col) el.classList.add("qz-badge--col"); host.appendChild(el);
}

function routeAlbumId() { try { var p = Q.getState().router.location.pathname || ""; var m = p.match(/\/album\/([^/?#]+)/); return m ? m[1] : null; } catch (e) { return null; } }
function rowAlbumId(row) { var a = row.querySelector('a[href*="/album/"]'); if (!a) return null; var m = (a.getAttribute("href") || "").match(/\/album\/([^/?#]+)/); return m ? m[1] : null; }
function titleHost(row) { return row.querySelector(".ListItem__title, .track-name") || row.querySelector(".ListItem__titleWithArtists") || row; }

function ensureAlbum(id) {
  if (!id || albums[id] !== undefined) return;
  albums[id] = "loading";
  Q.api("album/get?album_id=" + encodeURIComponent(id)).then(function (j) {
    var items = (j.tracks && j.tracks.items) || [];
    var byNum = {}, order = [];
    items.forEach(function (t) { var q = tierOf(t); order.push(q); if (t.track_number != null) byNum[t.track_number] = q; });
    albums[id] = { byNum: byNum, order: order, albumTier: tierOf(j) };
    scan();
  }).catch(function () { delete albums[id]; });
}

// .ListItem rows on any surface. If the row has its OWN /album/ link (playlist/favorites/search),
// badge with that album's tier; otherwise it's an album page - use the route album, per track number.
function paintListItems() {
  var routeId = routeAlbumId();
  var rows = document.querySelectorAll(".ListItem");
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]; if (row.querySelector("[data-qz-badge]")) continue;
    var rid = rowAlbumId(row);
    var id = rid || routeId; if (!id) continue;
    var data = albums[id];
    if (data === undefined) { ensureAlbum(id); continue; }
    if (!data || data === "loading") continue;
    var q;
    if (rid) q = data.albumTier; // per-row album (playlist etc.)
    else { var numEl = row.querySelector(".ListItem__numberText"); var n = numEl ? parseInt(numEl.textContent, 10) : NaN; q = (!isNaN(n) && data.byNum[n]) || data.order[i]; }
    // track table: right edge of the Genre column (between Genre and Duration). Album pages have no
    // genre column, so fall back to inline-with-title there.
    var genre = row.querySelector(".ListItem__genre");
    if (genre) addBadge(genre, q, true);
    else addBadge(titleHost(row), q, false);
  }
}
// legacy card list (older favorites/search views) - album-level tier
function paintTrackItems() {
  var rows = document.querySelectorAll(".track-item");
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]; if (row.querySelector("[data-qz-badge]")) continue;
    var id = rowAlbumId(row); if (!id) continue;
    var data = albums[id];
    if (data === undefined) { ensureAlbum(id); continue; }
    if (!data || data === "loading" || !data.albumTier) continue;
    addBadge(row.querySelector(".track-name") || row, data.albumTier);
  }
}
function scan() { try { paintListItems(); } catch (e) {} try { paintTrackItems(); } catch (e) {} }

var offObs = Q.observe(scan, { debounce: 200 });
var offRoute = Q.onRoute(scan);

return function cleanup() {
  if (offObs) offObs();
  if (offRoute) offRoute();
  var st = document.getElementById(STYLE_ID); if (st) st.remove();
  var b = document.querySelectorAll("[data-qz-badge]");
  for (var i = 0; i < b.length; i++) b[i].remove();
};
