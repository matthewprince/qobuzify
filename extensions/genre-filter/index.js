// Finer genre browsing for Discover. Runs as function(Qobuzify){ ... return cleanup }.
//
// Qobuz's own Discover genre customizer is coarse - it lumps whole families together (Pop and Rock
// share a chip). This adds a small "Genres" pill next to those chips on the Discover header. It opens
// a picker built from Qobuz's own genre tree (genre/list, with parent_id for sub-genres), and picking
// a fine genre (or sub-genre) opens a scoped, Discover-style overlay of that genre's albums and
// playlists - New Releases / Most Streamed / Press Awards via album/getFeatured?genre_ids=, and a
// Playlists tab via playlist/getFeatured?genres_id= (the two param spellings Qobuz itself uses). All
// data comes through Qobuzify.api with the in-app token; no external calls. Cards navigate to the
// entity (no play API). Inert off the Discover page; fully self-cleans on toggle-off.
var Q = Qobuzify;
var CSS_ID = "qz-genre-css";
var PAGE_ID = "qz-genre-page";
var WRAP = "qz-gf-wrap";
var LAST = "genrefilter:last";

// album/getFeatured type values + a playlists tab. The three album types are all present in the
// shipped bundle's discover epics; the playlists tab is best-effort (guarded, empty-state on miss).
var TABS = [
  { key: "new-releases", label: "New Releases", kind: "album" },
  { key: "most-streamed", label: "Most Streamed", kind: "album" },
  { key: "press-awards", label: "Press Awards", kind: "album" },
  { key: "playlists", label: "Playlists", kind: "playlist" }
];
var LIMIT = 30;

// --- session api cache (keyed by full path; each genre/type/offset is its own key) ---
var cache = {};
function api(path) {
  if (!cache[path]) cache[path] = Q.api(path).catch(function (e) { delete cache[path]; throw e; });
  return cache[path];
}

// --- genre tree ---
// genre/list shapes vary by wrapper; read items from genres.items or items. Sub-genres come either
// inline on a node or from a parent_id fetch.
function gItems(j) { return (j && ((j.genres && j.genres.items) || j.items)) || []; }
function childrenOf(it) {
  var c = it && (it.subgenres || it.sub_genres || it.genres || it.children);
  if (c && c.items) c = c.items;
  return Array.isArray(c) ? c : null;
}
function topGenres() { return api("genre/list").then(gItems); }
function subGenres(id) { return api("genre/list?parent_id=" + encodeURIComponent(id)).then(gItems); }

// --- featured fetches (genre-scoped) ---
function fetchAlbums(id, type, off) {
  return api("album/getFeatured?type=" + encodeURIComponent(type) + "&genre_ids=" + encodeURIComponent(id) + "&limit=" + LIMIT + "&offset=" + off)
    .then(function (j) { var a = (j && j.albums) || {}; return { items: a.items || [], total: (a.total != null ? a.total : null) }; });
}
function fetchPlaylists(id, off) {
  return api("playlist/getFeatured?genres_id=" + encodeURIComponent(id) + "&type=editor-picks&limit=" + LIMIT + "&offset=" + off)
    .then(function (j) { var p = (j && j.playlists) || {}; return { items: p.items || [], total: (p.total != null ? p.total : null) }; });
}

// --- small helpers (mirrors recommended) ---
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
function coverUrl(o) {
  if (!o) return "";
  var im = o.image || o.cover || o.picture;
  if (!im) return o.album ? coverUrl(o.album) : "";
  if (typeof im === "string") return im;
  return im.large || im.medium || im.small || im.thumbnail || im.extralarge || im.mega || "";
}
function albumArtistName(al) { return (al.artist && al.artist.name) || (al.performer && al.performer.name) || (al.artists && al.artists[0] && al.artists[0].name) || ""; }
function hires(o) { o = (o && (o.maximum_bit_depth || o.hires != null)) ? o : (o && o.album) || o || {}; return !!(o.hires || (o.maximum_bit_depth || 0) >= 24); }
function badge(o) { return hires(o) ? '<span class="qz-gf-badge">Hi-Res</span>' : ""; }
function readLast() { try { return JSON.parse(Q.storage.get(LAST, "null")); } catch (e) { return null; } }
function saveLast() { if (cur.id != null) { try { Q.storage.set(LAST, JSON.stringify({ id: cur.id, name: cur.name, type: cur.type })); } catch (e) {} } }

// --- state ---
var cur = { id: null, name: "", type: "new-releases", off: 0, busy: false, more: true };
var page = null, active = false, reassertObs = null, seq = 0;
(function () { var l = readLast(); if (l && l.type && tabByKey(l.type)) cur.type = l.type; })();

function tabByKey(k) { for (var i = 0; i < TABS.length; i++) if (TABS[i].key === k) return TABS[i]; return null; }

// --- overlay geometry (fill the native content scroll region; host inside the layout so Qobuz's own
// dropdowns still open above it - the z-index rule from writing-extensions) ---
function contentRect() {
  var sc = document.querySelector(".ui-layout--root--scroll-main") || document.querySelector(".ui-layout--root--main") || document.querySelector(".ui-scroll");
  if (sc) { var r = sc.getBoundingClientRect(); if (r.width > 200 && r.height > 200) return { left: r.left, top: r.top, width: r.width, height: r.height }; }
  var nav = document.querySelector(".NavBar"), player = document.querySelector(".player");
  var top = nav ? nav.getBoundingClientRect().bottom : 56;
  var bottom = player ? player.getBoundingClientRect().top : window.innerHeight - 78;
  return { left: 0, top: top, width: window.innerWidth, height: Math.max(220, bottom - top) };
}
function placePage() { if (!page) return; var r = contentRect(); page.style.left = r.left + "px"; page.style.top = r.top + "px"; page.style.width = r.width + "px"; page.style.height = r.height + "px"; }
function layoutHost() { var pt = document.querySelector(".ui-layout--root--panel-top"); return (pt && pt.parentElement) || document.body; }

// --- cards ---
function go(path) { close(); Q.navigate(path); }
function albumCard(al) {
  var c = document.createElement("a");
  c.className = "qz-gf-card"; c.href = "/album/" + al.id;
  var cover = coverUrl(al);
  c.innerHTML = '<div class="qz-gf-art">' + (cover ? '<img loading="lazy" src="' + cover + '" alt="">' : '<div class="qz-gf-ph">&#9835;</div>') + badge(al) + '</div>' +
    '<div class="qz-gf-t">' + esc(al.title || "") + '</div><div class="qz-gf-s">' + esc(albumArtistName(al)) + '</div>';
  c.addEventListener("click", function (e) { e.preventDefault(); go("/album/" + al.id); });
  return c;
}
function playlistCard(pl) {
  var c = document.createElement("a");
  c.className = "qz-gf-card"; c.href = "/playlist/" + pl.id;
  var img = (pl.images300 && pl.images300[0]) || (pl.images150 && pl.images150[0]) || (pl.images && pl.images[0]) || coverUrl(pl);
  var sub = (pl.owner && pl.owner.name) ? "By " + pl.owner.name : (pl.tracks_count ? pl.tracks_count + " tracks" : "Playlist");
  c.innerHTML = '<div class="qz-gf-art">' + (img ? '<img loading="lazy" src="' + img + '" alt="">' : '<div class="qz-gf-ph">&#9835;</div>') + '</div>' +
    '<div class="qz-gf-t">' + esc(pl.name || pl.title || "") + '</div><div class="qz-gf-s">' + esc(sub) + '</div>';
  c.addEventListener("click", function (e) { e.preventDefault(); go("/playlist/" + pl.id); });
  return c;
}
function skels(n) { var h = ""; for (var i = 0; i < n; i++) h += '<div class="qz-gf-skel"></div>'; return h; }

// --- results loader (paged, with a seq guard so a tab/genre switch discards stale responses) ---
function loadPage(reset) {
  if (!page) return;
  var grid = page.querySelector(".qz-gf-grid");
  var moreHost = page.querySelector(".qz-gf-more");
  var tab = tabByKey(cur.type) || TABS[0];
  if (reset) { cur.off = 0; cur.more = true; cur.busy = false; grid.innerHTML = skels(12); moreHost.innerHTML = ""; }
  if (cur.busy || !cur.more) return;
  cur.busy = true;
  var reqId = ++seq;
  var pr = tab.kind === "playlist" ? fetchPlaylists(cur.id, cur.off) : fetchAlbums(cur.id, cur.type, cur.off);
  pr.then(function (res) {
    if (reqId !== seq || !page) return;
    cur.busy = false;
    if (reset) grid.innerHTML = "";
    var items = res.items || [];
    items.forEach(function (it) { grid.appendChild(tab.kind === "playlist" ? playlistCard(it) : albumCard(it)); });
    cur.off += items.length;
    cur.more = items.length >= LIMIT && (res.total == null || cur.off < res.total);
    finishGrid(grid, moreHost, tab);
  }, function () {
    if (reqId !== seq || !page) return;
    cur.busy = false; cur.more = false;
    if (reset) grid.innerHTML = "";
    finishGrid(grid, moreHost, tab);
  });
}
function finishGrid(grid, moreHost, tab) {
  moreHost.innerHTML = "";
  if (grid.childElementCount === 0) {
    grid.innerHTML = '<div class="qz-gf-empty">No ' + (tab.kind === "playlist" ? "playlists" : "albums") + ' here right now. Try another tab or genre.</div>';
    return;
  }
  if (cur.more) {
    var b = document.createElement("button"); b.type = "button"; b.textContent = "Load more";
    b.addEventListener("click", function () { loadPage(false); });
    moreHost.appendChild(b);
  }
}

// --- overlay shell ---
function ensurePage() {
  if (page) return page;
  page = document.createElement("div");
  page.id = PAGE_ID;
  page.innerHTML =
    '<div class="qz-gf-head"><div class="qz-gf-kicker">Browse by genre</div><div class="qz-gf-title"></div>' +
    '<button class="qz-gf-close" type="button" title="Close">&times;</button></div>' +
    '<div class="qz-gf-tabs"></div>' +
    '<div class="qz-gf-grid"></div>' +
    '<div class="qz-gf-more"></div>';
  page.querySelector(".qz-gf-close").addEventListener("click", function (e) { e.preventDefault(); close(); });
  return page;
}
function renderTabs() {
  if (!page) return;
  var host = page.querySelector(".qz-gf-tabs"); host.innerHTML = "";
  TABS.forEach(function (tb) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "qz-gf-tab" + (tb.key === cur.type ? " qz-on" : "");
    b.textContent = tb.label;
    b.addEventListener("click", function () { if (cur.type === tb.key) return; cur.type = tb.key; saveLast(); renderTabs(); loadPage(true); });
    host.appendChild(b);
  });
}
function browse(id, name) {
  closePop();
  cur.id = String(id); cur.name = name || ("Genre " + id);
  saveLast();
  open();
}
function open() {
  active = true;
  var p = ensurePage();
  var host = layoutHost();
  if (p.parentElement !== host) host.appendChild(p);
  placePage();
  p.style.display = "block";
  p.scrollTop = 0;
  p.querySelector(".qz-gf-title").textContent = cur.name;
  renderTabs();
  loadPage(true);
  window.removeEventListener("resize", placePage);
  window.addEventListener("resize", placePage);
  if (!reassertObs) reassertObs = Q.observe(function () {
    if (!active) return;
    var h = layoutHost();
    if (page && page.parentElement !== h) h.appendChild(page);
    placePage();
  }, { debounce: 300 });
}
function close() {
  if (!active) return;
  active = false;
  if (page) page.style.display = "none";
  window.removeEventListener("resize", placePage);
  if (reassertObs) { reassertObs(); reassertObs = null; }
}

// --- genre picker popover (lives next to the coarse genre chips in the Discover header) ---
function closePop() { var p = document.querySelector(".qz-gf-pop"); if (p) p.remove(); document.removeEventListener("mousedown", outside, true); }
function outside(e) { var w = document.querySelector("." + WRAP); if (w && !w.contains(e.target)) closePop(); }
function allRow(g) {
  var all = document.createElement("div"); all.className = "qz-gf-krow qz-gf-all";
  all.textContent = "Browse all " + (g.name || "");
  all.addEventListener("click", function (ev) { ev.stopPropagation(); browse(g.id, g.name); });
  return all;
}
function genreRow(g) {
  var box = document.createElement("div");
  var row = document.createElement("div"); row.className = "qz-gf-grow";
  row.innerHTML = '<span class="qz-gf-gname">' + esc(g.name || "") + '</span><span class="qz-gf-chev">&rsaquo;</span>';
  var kids = document.createElement("div"); kids.className = "qz-gf-kids"; kids.style.display = "none";
  var loaded = false;
  row.addEventListener("click", function (e) {
    e.stopPropagation();
    if (row.classList.contains("qz-open")) { row.classList.remove("qz-open"); kids.style.display = "none"; return; }
    row.classList.add("qz-open"); kids.style.display = "";
    if (loaded) return;
    loaded = true;
    var render = function (subs) {
      kids.innerHTML = "";
      kids.appendChild(allRow(g));
      (subs || []).forEach(function (s) {
        var kr = document.createElement("div"); kr.className = "qz-gf-krow"; kr.textContent = s.name || "";
        kr.addEventListener("click", function (ev) { ev.stopPropagation(); browse(s.id, s.name); });
        kids.appendChild(kr);
      });
    };
    var inline = childrenOf(g);
    if (inline) { render(inline); return; }
    kids.innerHTML = '<div class="qz-gf-note">Loading&hellip;</div>';
    subGenres(g.id).then(function (subs) { if (kids.isConnected) render(subs); },
      function () { if (kids.isConnected) { kids.innerHTML = ""; kids.appendChild(allRow(g)); } });
  });
  box.appendChild(row); box.appendChild(kids);
  return box;
}
function openPop(wrap) {
  if (wrap.querySelector(".qz-gf-pop")) { closePop(); return; }
  var pop = document.createElement("div"); pop.className = "qz-gf-pop";
  pop.innerHTML = "<h4>Browse by genre</h4>";
  var last = readLast();
  if (last && last.id != null) {
    var r = document.createElement("div"); r.className = "qz-gf-resume";
    r.innerHTML = "<span>Resume: " + esc(last.name || ("Genre " + last.id)) + "</span><span>&rsaquo;</span>";
    r.addEventListener("click", function (e) { e.stopPropagation(); if (last.type && tabByKey(last.type)) cur.type = last.type; browse(last.id, last.name); });
    pop.appendChild(r);
  }
  var list = document.createElement("div"); list.className = "qz-gf-list";
  list.innerHTML = '<div class="qz-gf-note">Loading genres&hellip;</div>';
  pop.appendChild(list);
  wrap.appendChild(pop);
  setTimeout(function () { document.addEventListener("mousedown", outside, true); }, 0);
  topGenres().then(function (items) {
    if (!list.isConnected) return;
    if (!items.length) { list.innerHTML = '<div class="qz-gf-note">Couldn\'t load genres.</div>'; return; }
    list.innerHTML = "";
    items.forEach(function (g) { list.appendChild(genreRow(g)); });
  }, function () { if (list.isConnected) list.innerHTML = '<div class="qz-gf-note">Couldn\'t load genres.</div>'; });
}

// --- header control ---
var TAG_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2a2 2 0 0 1-.6-1.4V4a1 1 0 0 1 1-1h7.6a2 2 0 0 1 1.4.6l7.8 7.8a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.4" fill="currentColor" stroke="none"/></svg>';
function onDiscover() { try { return /^\/discover/.test(Q.getState().router.location.pathname || ""); } catch (e) { return false; } }
function titleHost() {
  var t = document.querySelector(".ui-section-page-title-001 [class*='ui-block-title'], .ui-section-page-title-001 .typo-main-heading-xl");
  return (t && t.parentElement) || document.querySelector(".ui-section-page-title-001");
}
function ensureButton() {
  if (!onDiscover()) return;
  var host = titleHost();
  if (!host || host.querySelector("." + WRAP)) return;
  var wrap = document.createElement("span"); wrap.className = WRAP;
  var b = document.createElement("button"); b.type = "button"; b.className = "qz-gf-btn";
  b.innerHTML = TAG_ICON + "<span>Genres</span>";
  b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); openPop(wrap); });
  wrap.appendChild(b);
  host.appendChild(wrap);
}

// clicking a nav tab / search / logo while the overlay is up closes it (a same-route Discover click
// fires no onRoute, so the overlay would otherwise linger)
function onDocClick(e) {
  if (!active) return;
  var t = e.target; if (!t || !t.closest) return;
  if (t.closest("#" + PAGE_ID)) return;
  if (t.closest(".NavBar__items") || t.closest(".SearchBar") || t.closest(".NavBar__brand")) close();
}

Q.css(CSS_ID, [
  // header pill
  "." + WRAP + "{position:relative;display:inline-flex;margin-left:14px;vertical-align:middle;}",
  ".qz-gf-btn{display:inline-flex;align-items:center;gap:7px;appearance:none;border:1px solid var(--qz-accent,#3DA8FE);",
  "background:transparent;color:var(--qz-accent,#3DA8FE);font:inherit;font-size:12px;font-weight:700;letter-spacing:.3px;",
  "padding:5px 11px;border-radius:20px;cursor:pointer;line-height:1;transition:background .15s,color .15s;}",
  ".qz-gf-btn:hover{background:var(--qz-accent,#3DA8FE);color:#06090a;}",
  ".qz-gf-btn svg{display:block;}",
  // picker popover
  ".qz-gf-pop{position:absolute;top:calc(100% + 9px);left:0;z-index:99999;width:300px;max-height:440px;display:flex;flex-direction:column;padding:10px;",
  "background:linear-gradient(180deg,rgba(22,25,33,.98),rgba(13,15,21,.99));border:1px solid rgba(255,255,255,.12);",
  "border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.6),0 0 40px -22px var(--qz-accent,#3DA8FE);}",
  ".qz-gf-pop h4{margin:4px 6px 9px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#8b94a3;}",
  ".qz-gf-resume{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 4px 8px;padding:8px 10px;border-radius:9px;",
  "background:rgba(61,168,254,.12);border:1px solid rgba(61,168,254,.28);color:#dbe9fb;font-size:12.5px;font-weight:600;cursor:pointer;}",
  ".qz-gf-resume:hover{background:rgba(61,168,254,.2);}",
  ".qz-gf-list{overflow:auto;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.2) transparent;}",
  ".qz-gf-list::-webkit-scrollbar{width:9px;}.qz-gf-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:9px;}",
  ".qz-gf-grow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px;border-radius:9px;cursor:pointer;color:#e7ecf3;font-size:13.5px;font-weight:600;}",
  ".qz-gf-grow:hover{background:rgba(255,255,255,.06);}",
  ".qz-gf-grow .qz-gf-chev{color:#7e8796;transition:transform .15s,color .15s;font-size:17px;line-height:1;}",
  ".qz-gf-grow.qz-open .qz-gf-chev{transform:rotate(90deg);color:var(--qz-accent,#3DA8FE);}",
  ".qz-gf-kids{margin:2px 0 6px 8px;border-left:1px solid rgba(255,255,255,.08);padding-left:6px;}",
  ".qz-gf-krow{padding:7px 9px;border-radius:8px;cursor:pointer;color:#cbd3df;font-size:12.5px;font-weight:550;}",
  ".qz-gf-krow:hover{background:rgba(255,255,255,.06);color:#fff;}",
  ".qz-gf-krow.qz-gf-all{color:var(--qz-accent,#3DA8FE);font-weight:700;}",
  ".qz-gf-note{padding:12px 8px;color:#8b94a3;font-size:12.5px;}",
  // overlay page
  "#" + PAGE_ID + "{position:fixed;z-index:220;overflow:auto;color:#eef2f7;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.2) transparent;",
  "background:radial-gradient(120% 80% at 80% -10%,rgba(61,168,254,.10),transparent 60%),linear-gradient(180deg,#0a0e17,#080b12 55%);}",
  "#" + PAGE_ID + "::-webkit-scrollbar{width:11px;}#" + PAGE_ID + "::-webkit-scrollbar-thumb{background:rgba(255,255,255,.13);border-radius:9px;}",
  ".qz-gf-head{position:relative;padding:26px 40px 6px;max-width:1500px;margin:0 auto;}",
  ".qz-gf-kicker{font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.7px;color:var(--qz-accent,#3DA8FE);}",
  ".qz-gf-title{margin-top:5px;font-size:32px;font-weight:850;letter-spacing:-.5px;color:#fff;}",
  ".qz-gf-close{position:absolute;top:22px;right:36px;width:38px;height:38px;border:0;border-radius:10px;background:rgba(255,255,255,.06);",
  "color:#cbd3df;cursor:pointer;font-size:22px;line-height:1;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s;}",
  ".qz-gf-close:hover{background:rgba(255,255,255,.12);color:#fff;}",
  ".qz-gf-tabs{display:flex;gap:8px;flex-wrap:wrap;padding:14px 40px 4px;max-width:1500px;margin:0 auto;}",
  ".qz-gf-tab{appearance:none;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:#cbd3df;",
  "font:inherit;font-size:13px;font-weight:650;padding:7px 15px;border-radius:20px;cursor:pointer;transition:background .14s,color .14s,border-color .14s;}",
  ".qz-gf-tab:hover{background:rgba(255,255,255,.09);color:#fff;}",
  ".qz-gf-tab.qz-on{background:var(--qz-accent,#3DA8FE);border-color:var(--qz-accent,#3DA8FE);color:#06090a;}",
  ".qz-gf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:24px 20px;padding:22px 40px 30px;max-width:1500px;margin:0 auto;}",
  ".qz-gf-card{display:block;text-decoration:none;cursor:pointer;min-width:0;}",
  ".qz-gf-art{position:relative;width:100%;aspect-ratio:1;border-radius:12px;overflow:hidden;background:rgba(255,255,255,.05);",
  "box-shadow:0 10px 28px -14px rgba(0,0,0,.8);transition:transform .16s,box-shadow .16s;}",
  ".qz-gf-card:hover .qz-gf-art{transform:translateY(-4px);box-shadow:0 18px 40px -16px var(--qz-accent,#3DA8FE);}",
  ".qz-gf-art img{width:100%;height:100%;object-fit:cover;display:block;}",
  ".qz-gf-ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1a2634,#0d151d);color:rgba(255,255,255,.25);font-size:30px;}",
  ".qz-gf-badge{position:absolute;top:8px;left:8px;font-size:9.5px;font-weight:800;letter-spacing:.3px;padding:2px 7px;border-radius:5px;color:#06090a;background:var(--qz-accent,#3DA8FE);filter:drop-shadow(0 2px 4px rgba(0,0,0,.6));}",
  ".qz-gf-t{margin-top:10px;font-size:13.5px;font-weight:700;color:#e7ecf3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".qz-gf-s{margin-top:2px;font-size:12px;color:#8b94a3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".qz-gf-skel{width:100%;aspect-ratio:1;border-radius:12px;background:linear-gradient(100deg,rgba(255,255,255,.05) 30%,rgba(255,255,255,.11) 50%,rgba(255,255,255,.05) 70%);background-size:200% 100%;animation:qz-gf-sh 1.3s linear infinite;}",
  "@keyframes qz-gf-sh{0%{background-position:200% 0}100%{background-position:-200% 0}}",
  ".qz-gf-empty{grid-column:1/-1;padding:40px;text-align:center;color:#8b94a3;font-size:14px;}",
  ".qz-gf-more{display:flex;justify-content:center;padding:0 40px 54px;}",
  ".qz-gf-more button{appearance:none;border:1px solid var(--qz-accent,#3DA8FE);background:transparent;color:var(--qz-accent,#3DA8FE);",
  "font:inherit;font-size:13px;font-weight:700;padding:10px 26px;border-radius:24px;cursor:pointer;transition:background .15s,color .15s;}",
  ".qz-gf-more button:hover{background:var(--qz-accent,#3DA8FE);color:#06090a;}"
].join(""));

function scan() { try { ensureButton(); } catch (e) {} }
var offObs = Q.observe(scan, { debounce: 220 });
var offRoute = Q.onRoute(function () { closePop(); close(); scan(); });
document.addEventListener("click", onDocClick, true);
scan();

return function cleanup() {
  if (offObs) offObs();
  if (offRoute) offRoute();
  if (reassertObs) { reassertObs(); reassertObs = null; }
  document.removeEventListener("click", onDocClick, true);
  document.removeEventListener("mousedown", outside, true);
  window.removeEventListener("resize", placePage);
  active = false;
  closePop();
  var w = document.querySelectorAll("." + WRAP); for (var i = 0; i < w.length; i++) w[i].remove();
  if (page) { page.remove(); page = null; }
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
