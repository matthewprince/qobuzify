// Playlist Finder. Two questions the native library cannot answer: which playlists is this song already
// on, and which songs have I never filed anywhere? Runs as function(Qobuzify){ ... return cleanup }.
//
// Both answers need the same thing: a trackId -> [playlist] index. Qobuz has no endpoint for it, so it is
// built by walking your own playlists once (playlist/get?extra=tracks per playlist, bounded concurrency)
// and cached in Q.storage behind a fingerprint of the playlist list. The fingerprint is id:tracks_count
// per playlist, so adding or removing a track anywhere changes it and the index rebuilds; nothing else
// does, so opening the panel again is free.
//
// The favourites side comes from library-load's cache (Q.library.tracks()), which already holds every
// favourite with title/artist/album. Rendering our own list rather than filtering the native one, for the
// reason hires-filter documents: the library list is WINDOWED (a 512-track library keeps ~20 rows in the
// DOM no matter how far you scroll), so hiding rows there leaves a mostly-empty list.
var Q = Qobuzify;
var CSS_ID = "qz-plf-css";
var CHIP_ID = "qz-plf-chip";
var PANEL_ID = "qz-plf-panel";
var K_IDX = "plf:index";          // { fp, at, map: { trackId: [playlistId] }, names: { playlistId: name } }
var CONC = 4;                     // parallel playlist fetches; polite to the API, still quick on ~50 lists

var on = false, panel = null, chip = null;
var genSkipped = 0;   // Qobuzify-generated playlists left out of the index
var idx = null;                   // { map, names } once built
var building = false, buildErr = null;
var rows = [];                    // what is currently rendered
var orphansOnly = false, query = "";

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
function el(h) { var d = document.createElement("div"); d.innerHTML = h; return d.firstElementChild; }
function fmtDur(sec) { sec = Math.max(0, Math.round(sec || 0)); var m = Math.floor(sec / 60), s = sec % 60; return m + ":" + (s < 10 ? "0" : "") + s; }
function route() { try { return Q.getState().router.location.pathname || ""; } catch (e) { return ""; } }
function isLibraryRoute(p) { return /^\/user-library(\/|$)/.test(p || route()); }
function norm(s) { return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim(); }

function libTracks() {
  try { return (Q.library && typeof Q.library.tracks === "function") ? (Q.library.tracks() || []) : null; }
  catch (e) { return null; }
}

// ---------- the index ----------
function pool(items, n, fn) {
  return new Promise(function (resolve) {
    var out = new Array(items.length), i = 0, done = 0, running = 0;
    if (!items.length) return resolve(out);
    function next() {
      while (running < n && i < items.length) {
        (function (k) {
          running++;
          Promise.resolve(fn(items[k])).then(function (r) { out[k] = r; }, function () { out[k] = null; })
            .then(function () { running--; if (++done === items.length) resolve(out); else next(); });
        })(i++);
      }
    }
    next();
  });
}
// Qobuzify's own generated playlists must not count as "filed". "Shuffle . My Tracks" is the whole
// library by construction, so with it indexed the orphan count collapsed to 2 of 512 and the feature was
// useless - measured on the first live run. Excluded by ID, read from the storage keys the extensions that
// create them already keep (mobile-app mob:shuffle / mob:radio, smart-playback smart:pid, multi-select
// ms:tmp, bulk-actions ba:shuf, recommended mix:<theme>), which is exact and survives renaming. A name pattern is kept only as a
// fallback for a playlist whose creating extension has since been disabled, taking its stored id with it.
var GEN_NAME_RE = /^(Qobuzify Radio|Shuffle\s*[\u00b7.-]\s*My Tracks|Radio\s*[\u00b7.-]\s|Song radio\b)/i;
function generatedIds() {
  var out = {};
  function add(v) { if (v != null && v !== "") out[String(v)] = 1; }
  ["mob:shuffle", "mob:radio", "smart:pid", "ms:tmp", "ba:shuf"].forEach(function (k) {
    try { add(Q.storage.get(k, null)); } catch (e) {}
  });
  // recommended writes one per mix theme: qobuzify:x:mix:<themeKey>
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i) || "";
      if (k.indexOf("qobuzify:x:mix:") === 0) add(localStorage.getItem(k));
    }
  } catch (e) {}
  return out;
}
function myPlaylists() {
  return Q.api("playlist/getUserPlaylists?limit=500", { timeout: 45000 }).then(function (j) { return (j.playlists && j.playlists.items) || []; });
}
// id:count per playlist. Changes whenever a playlist gains or loses a track, which is exactly when the
// index is stale; renaming or reordering does not move it, which is exactly when a rebuild would be waste.
function fingerprint(pls) {
  return pls.map(function (p) { return String(p.id) + ":" + (p.tracks_count != null ? p.tracks_count : (p.duration || 0)); }).sort().join(",");
}
function readCache(fp) {
  try {
    var raw = Q.storage.get(K_IDX, null); if (!raw) return null;
    var j = JSON.parse(raw);
    if (!j || j.fp !== fp || !j.map) return null;
    return { map: j.map, names: j.names || {} };
  } catch (e) { return null; }
}
// Every track id on one playlist. playlist/get caps limit at 500 (a larger limit still returns 500), so
// page by offset until we have tracks.total or a page comes back empty - the same 500 page mobile-app uses.
// Any failed page rejects, so a half-read playlist is treated as unread rather than as complete.
var PL_PAGE = 500, PL_MAX_PAGES = 40;
function playlistTrackIds(pid) {
  var ids = [];
  function page(offset, n) {
    return Q.api("playlist/get?playlist_id=" + encodeURIComponent(pid) + "&extra=tracks&limit=" + PL_PAGE + "&offset=" + offset, { timeout: 45000 })
      .then(function (j) {
        var tr = (j && j.tracks) || {}, items = tr.items || [];
        items.forEach(function (t) { if (t && t.id != null) ids.push(t.id); });
        var total = typeof tr.total === "number" ? tr.total : (j && typeof j.tracks_count === "number" ? j.tracks_count : null);
        var more = items.length > 0 && (total != null ? offset + items.length < total : items.length >= PL_PAGE);
        return more && n + 1 < PL_MAX_PAGES ? page(offset + items.length, n + 1) : ids;
      });
  }
  return page(0, 0);
}
function writeCache(fp, data) {
  try { Q.storage.set(K_IDX, JSON.stringify({ fp: fp, at: Date.now(), map: data.map, names: data.names })); } catch (e) {}
}
function buildIndex(force) {
  if (building) return Promise.resolve(null);
  building = true; buildErr = null; render();
  return myPlaylists().then(function (pls) {
    var fp = fingerprint(pls);
    if (!force) { var c = readCache(fp); if (c) { idx = c; return null; } }
    var skip = generatedIds();
    var keep = pls.filter(function (p) { return !skip[String(p.id)] && !GEN_NAME_RE.test(String(p.name || "")); });
    genSkipped = pls.length - keep.length;
    var names = {};
    keep.forEach(function (p) { names[String(p.id)] = p.name || "Untitled"; });
    return pool(keep, CONC, function (p) {
      return playlistTrackIds(p.id).then(function (ids) { return { id: String(p.id), ids: ids }; })
        .catch(function () { return null; });
    }).then(function (res) {
      var map = {}, failed = 0;
      (res || []).forEach(function (r) {
        if (!r) { failed++; return; }
        r.ids.forEach(function (tid) { var k = String(tid); (map[k] = map[k] || []).push(r.id); });
      });
      idx = { map: map, names: names, failed: failed };
      // An incomplete index must not be cached: its fingerprint would match next time and the songs
      // on the unread playlists would read as orphans until a playlist changed.
      if (!failed) writeCache(fp, idx);
      return null;
    });
  }).catch(function (e) { buildErr = String((e && e.message) || e); })
    .then(function () { building = false; render(); });
}

// ---------- rendering ----------
function playlistsOf(trackId) {
  if (!idx) return [];
  var ids = idx.map[String(trackId)] || [];
  return ids.map(function (pid) { return { id: pid, name: idx.names[pid] || "Untitled" }; });
}
function rowHTML(t, i) {
  var art = (t.album && t.album.image && (t.album.image.small || t.album.image.thumbnail)) || "";
  var pls = playlistsOf(t.id);
  var tags = pls.length
    ? pls.slice(0, 4).map(function (p) { return '<button class="qz-plf-tag" data-pl="' + esc(p.id) + '">' + esc(p.name) + "</button>"; }).join("")
      + (pls.length > 4 ? '<span class="qz-plf-more">+' + (pls.length - 4) + "</span>" : "")
    : '<span class="qz-plf-none">in no playlist</span>';
  return '<div class="qz-plf-row" data-i="' + i + '">' +
    '<span class="qz-plf-art">' + (art ? '<img loading="lazy" src="' + esc(art) + '">' : "") +
      '<button class="qz-plf-play" aria-label="Play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg></button></span>' +
    '<span class="qz-plf-meta"><span class="qz-plf-t">' + esc(t.title) + "</span>" +
      '<span class="qz-plf-s">' + esc((t.performer && t.performer.name) || "") +
      (t.album && t.album.title ? " &middot; " + esc(t.album.title) : "") + "</span>" +
      '<span class="qz-plf-tags">' + tags + "</span></span>" +
    '<span class="qz-plf-dur">' + fmtDur(t.duration) + "</span>" +
    "</div>";
}
function render() {
  if (!panel) return;
  var body = panel.querySelector(".qz-plf-body");
  var count = panel.querySelector(".qz-plf-count");
  var all = libTracks();

  if (all === null) {
    count.textContent = "";
    body.innerHTML = '<p class="qz-plf-empty">This needs the <b>Library cache</b> extension (library-load) switched on -' +
      " it holds your favourites locally. Enable it, open your library once, then try again.</p>";
    return;
  }
  if (Q.library && !Q.library.ready("tracks")) {
    count.textContent = "";
    body.innerHTML = '<p class="qz-plf-empty">Loading your library… this happens once, then it is cached.</p>';
    try { Q.library.load("tracks"); } catch (e) {}
    return;
  }
  if (building) { count.textContent = ""; body.innerHTML = '<p class="qz-plf-empty">Reading your playlists…</p>'; return; }
  if (buildErr) { count.textContent = ""; body.innerHTML = '<p class="qz-plf-empty">Couldn\'t read your playlists: ' + esc(buildErr) + "</p>"; return; }
  if (!idx) { count.textContent = ""; body.innerHTML = '<p class="qz-plf-empty">No index yet.</p>'; return; }

  var q = norm(query);
  var list = all.filter(function (t) {
    if (!t || t.id == null) return false;
    if (orphansOnly && playlistsOf(t.id).length) return false;
    if (!q) return true;
    return norm(t.title).indexOf(q) >= 0 || norm((t.performer && t.performer.name) || "").indexOf(q) >= 0;
  });
  rows = list;
  var orphanTotal = all.filter(function (t) { return t && t.id != null && !playlistsOf(t.id).length; }).length;
  count.textContent = list.length + " shown \u00b7 " + orphanTotal + " of " + all.length + " favourites are in no playlist"
    + (genSkipped ? " \u00b7 " + genSkipped + " auto-generated skipped" : "")
    + (idx.failed ? " \u00b7 " + idx.failed + (idx.failed === 1 ? " playlist" : " playlists") + " couldn't be read" : "");
  if (!list.length) { body.innerHTML = '<p class="qz-plf-empty">Nothing matches.</p>'; return; }
  var html = "";
  for (var i = 0; i < list.length; i++) html += rowHTML(list[i], i);
  body.innerHTML = html;
  body.scrollTop = 0;
}

// ---------- playback: album page, then the row (the one path proven on this sealed player) ----------
function normTitle(s) { return String(s == null ? "" : s).toLowerCase().replace(/\(.*?\)|\[.*?\]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
function fireClick(e) { ["mousedown", "mouseup", "click"].forEach(function (t) { e.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); }); }
function tracklistRows() {
  return [].slice.call(document.querySelectorAll(".ListItem")).filter(function (r) { return r.querySelector(".ListItem__title") && r.querySelector(".ListItem__player"); });
}
function headerPlayBtn() {
  var c = document.querySelectorAll("[class*='PageHeader'] button[aria-label='Play'], button[aria-label='Play'].ButtonRoundPrimary--large");
  for (var i = 0; i < c.length; i++) { var r = c[i].getBoundingClientRect(); if (c[i].offsetParent && r.width > 4 && r.height > 4) return c[i]; }
  return null;
}
function matchRow(list, title, num) {
  var wt = normTitle(title), best = null, bestS = -1;
  list.forEach(function (r) {
    var te = r.querySelector(".ListItem__title"), rt = te ? normTitle(te.textContent) : "", s = 0;
    if (rt && rt === wt) s = 100;
    else if (rt && wt && (rt.indexOf(wt) === 0 || wt.indexOf(rt) === 0)) s = 70;
    else if (rt && wt && (rt.indexOf(wt) >= 0 || wt.indexOf(rt) >= 0)) s = 40;
    if (num) { var ne = r.querySelector(".ListItem__numberText"); if (ne && parseInt(ne.textContent, 10) === num) s += 15; }
    if (s > bestS) { bestS = s; best = r; }
  });
  return bestS >= 40 ? best : null;
}
var playIv = null;
function playTrack(albumId, title, num) {
  if (!albumId) return;
  close(); Q.navigate("/album/" + albumId);
  if (playIv) clearInterval(playIv);
  var tries = 0;
  playIv = setInterval(function () {
    tries++;
    if ((route() || "").indexOf(albumId) >= 0) {
      var list = tracklistRows();
      if (list.length) {
        var target = matchRow(list, title, num);
        if (target) { var p = target.querySelector(".ListItem__player") || target.querySelector(".ListItem__number"); if (p) { fireClick(p); clearInterval(playIv); playIv = null; return; } }
      }
      if (tries > 12) { var hb = headerPlayBtn(); if (hb) { hb.dispatchEvent(new MouseEvent("click", { bubbles: true })); clearInterval(playIv); playIv = null; return; } }
    }
    if (tries > 40) { clearInterval(playIv); playIv = null; }
  }, 150);
}

// ---------- panel ----------
function layoutHost() { var pt = document.querySelector(".ui-layout--root--panel-top"); return (pt && pt.parentElement) || document.body; }
// Below the toolbar, so the chip that opens this stays visible and clickable while it is open.
function contentRect() {
  var sc = document.querySelector(".ui-layout--root--scroll-main") || document.querySelector(".ui-layout--root--main") || document.querySelector(".ui-scroll");
  if (sc) {
    var r = sc.getBoundingClientRect();
    if (r.width > 200 && r.height > 200) {
      var top = r.top, tb = document.querySelector(".ui-section-toolbar");
      if (tb) { var tr = tb.getBoundingClientRect(); if (tr.height > 0 && tr.top <= r.top + 8) top = tr.bottom; }
      return { top: top, left: r.left, width: r.width, height: Math.max(160, (r.top + r.height) - top) };
    }
  }
  return { top: 133, left: 0, width: window.innerWidth, height: Math.max(300, window.innerHeight - 133 - 78) };
}
function layout() {
  if (!panel) return;
  var h = layoutHost();
  if (panel.parentElement !== h) h.appendChild(panel);
  var r = contentRect();
  panel.style.top = r.top + "px"; panel.style.left = r.left + "px";
  panel.style.width = r.width + "px"; panel.style.height = r.height + "px";
}
function ensureUI() {
  if (panel) return;
  panel = el('<div id="' + PANEL_ID + '">' +
    '<div class="qz-plf-head"><span class="qz-plf-title">Playlists</span>' +
    '<span class="qz-plf-count"></span>' +
    '<input class="qz-plf-q" type="text" placeholder="Filter by title or artist" spellcheck="false">' +
    '<button class="qz-plf-orph">In no playlist</button>' +
    '<button class="qz-plf-rebuild" title="Re-read your playlists">Refresh</button>' +
    '<button class="qz-plf-close">Close</button></div>' +
    '<div class="qz-plf-body"></div></div>');
  panel.querySelector(".qz-plf-close").addEventListener("click", function () { setOn(false); });
  panel.querySelector(".qz-plf-rebuild").addEventListener("click", function () { buildIndex(true); });
  panel.querySelector(".qz-plf-orph").addEventListener("click", function (e) {
    orphansOnly = !orphansOnly; e.currentTarget.classList.toggle("qz-on", orphansOnly); render();
  });
  panel.querySelector(".qz-plf-q").addEventListener("input", function (e) { query = e.target.value || ""; render(); });
  // one delegated handler: a per-row listener on hundreds of rows is wasted work
  panel.querySelector(".qz-plf-body").addEventListener("click", function (e) {
    var tag = e.target.closest && e.target.closest(".qz-plf-tag");
    if (tag) { e.preventDefault(); e.stopPropagation(); close(); Q.navigate("/playlist/" + tag.getAttribute("data-pl")); return; }
    var row = e.target.closest && e.target.closest(".qz-plf-row"); if (!row) return;
    var t = rows[+row.getAttribute("data-i")]; if (!t) return;
    var alId = t.album && t.album.id; if (!alId) return;
    if (e.target.closest(".qz-plf-play")) { e.preventDefault(); e.stopPropagation(); playTrack(alId, t.title, t.track_number); return; }
    close(); Q.navigate("/album/" + alId);
  });
  layoutHost().appendChild(panel);
}
function open() {
  ensureUI(); layout(); panel.style.display = "flex";
  requestAnimationFrame(function () { panel.classList.add("qz-plf-in"); });
  if (!idx && !building) buildIndex(false); else render();
}
function close() { if (panel) { panel.classList.remove("qz-plf-in"); panel.style.display = "none"; } }
function setOn(v) { on = !!v; if (chip) chip.classList.toggle("qz-plf-active", on); if (on) open(); else close(); }

// ---------- chip ----------
function toolbarHost() {
  var tb = document.querySelector(".ui-section-toolbar");
  if (!tb) return null;
  var gen = tb.querySelector("[class*='genres-selector--trigger']");
  if (gen) {
    var n = gen.parentElement;
    while (n && n !== tb) {
      if (getComputedStyle(n).display === "flex" && n.getBoundingClientRect().width > 100) return n;
      n = n.parentElement;
    }
  }
  return tb.querySelector(".ui-base-bar") || tb;
}
function ensureChip() {
  var host = toolbarHost();
  if (!host) { if (chip) { chip.remove(); chip = null; } return; }
  if (chip && chip.isConnected && chip.parentElement === host) return;
  if (!chip) {
    chip = el('<button id="' + CHIP_ID + '" type="button" title="Which playlists a song is on, and what is filed nowhere">Playlists</button>');
    chip.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); setOn(!on); });
  }
  host.appendChild(chip);
  chip.classList.toggle("qz-plf-active", on);
}
// Library only. Elsewhere the chip is REMOVED (not hidden) and the panel resets, so it cannot re-cover the
// library the next time you walk into it. Re-asserted on mutations because Qobuz re-renders the layout host
// and takes the chip with it; a route-only sync leaves you on the library with no chip.
function sync() {
  if (isLibraryRoute()) {
    ensureChip();
    if (on) { ensureUI(); layout(); panel.style.display = "flex"; }
  } else {
    if (on) setOn(false);
    if (chip) { chip.remove(); chip = null; }
    if (panel) close();
  }
}
function onResize() { if (isLibraryRoute() && on) layout(); }
function onEsc(e) { if (e.key === "Escape" && on) { e.stopPropagation(); setOn(false); } }

Q.css(CSS_ID, [
  "#" + CHIP_ID + "{flex:0 0 auto;height:45px;display:inline-flex;align-items:center;gap:8px;",
  "padding:0 18px;border-radius:999px;cursor:pointer;",
  // colour comes from the toolbar the chip sits in, so it reads on Qobuz's light appearance too - a fixed light
  // grey was near-invisible on white. Border and fill are mixes of that same colour.
  "color:inherit;border:1px solid color-mix(in srgb,currentColor 18%,transparent);",
  "background:color-mix(in srgb,currentColor 6%,transparent);font:inherit;font-size:13px;font-weight:650;",
  "letter-spacing:.2px;white-space:nowrap;transition:background .13s,color .13s,border-color .13s;}",
  "#" + CHIP_ID + ":hover{border-color:color-mix(in srgb,currentColor 34%,transparent);background:color-mix(in srgb,currentColor 10%,transparent);}",
  "#" + CHIP_ID + ".qz-plf-active{background:var(--qz-accent,#3DA8FE);border-color:transparent;color:#06090a;}",
  "#" + PANEL_ID + "{position:fixed;z-index:220;display:none;flex-direction:column;color:#eef2f7;",
  "background:linear-gradient(180deg,#0a0e17,#060a12 60%);opacity:0;transition:opacity .16s ease;font-family:inherit;overflow:hidden;}",
  "#" + PANEL_ID + ".qz-plf-in{opacity:1;}",
  ".qz-plf-head{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:16px 26px 12px;border-bottom:1px solid rgba(255,255,255,.07);flex-wrap:wrap;}",
  ".qz-plf-title{font-size:19px;font-weight:700;}",
  ".qz-plf-count{font-size:12.5px;font-weight:600;color:#7d8798;flex:1;min-width:170px;}",
  ".qz-plf-q{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:#e7ecf3;font:inherit;",
  "font-size:13px;padding:7px 12px;border-radius:999px;outline:none;min-width:200px;}",
  ".qz-plf-q:focus{border-color:var(--qz-accent,#3DA8FE);}",
  ".qz-plf-orph,.qz-plf-rebuild,.qz-plf-close{appearance:none;border:1px solid rgba(255,255,255,.16);background:transparent;",
  "color:#cdd6e2;font:inherit;font-size:12.5px;font-weight:600;padding:7px 13px;border-radius:999px;cursor:pointer;white-space:nowrap;}",
  ".qz-plf-orph:hover,.qz-plf-rebuild:hover,.qz-plf-close:hover{border-color:rgba(255,255,255,.3);color:#fff;}",
  ".qz-plf-orph.qz-on{background:var(--qz-accent,#3DA8FE);border-color:transparent;color:#06090a;}",
  ".qz-plf-body{flex:1 1 auto;overflow-y:auto;padding:6px 16px 22px;}",
  ".qz-plf-empty{color:#8b95a6;font-size:14px;padding:26px 14px;line-height:1.6;max-width:640px;}",
  ".qz-plf-row{display:flex;align-items:center;gap:14px;padding:8px 14px;border-radius:9px;cursor:pointer;}",
  ".qz-plf-row:hover{background:rgba(255,255,255,.06);}",
  ".qz-plf-art{position:relative;flex:0 0 42px;width:42px;height:42px;border-radius:5px;overflow:hidden;background:#131823;}",
  ".qz-plf-art img{width:100%;height:100%;object-fit:cover;display:block;}",
  ".qz-plf-play{position:absolute;inset:0;display:none;align-items:center;justify-content:center;appearance:none;border:0;background:rgba(0,0,0,.55);color:#fff;cursor:pointer;padding:0;}",
  ".qz-plf-play svg{width:20px;height:20px;}",
  ".qz-plf-row:hover .qz-plf-play{display:flex;}",
  ".qz-plf-meta{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px;}",
  ".qz-plf-t{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".qz-plf-s{font-size:12px;color:#8b95a6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".qz-plf-tags{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:1px;}",
  ".qz-plf-tag{appearance:none;border:1px solid rgba(61,168,254,.35);background:rgba(61,168,254,.12);color:#9fd0ff;",
  "font:inherit;font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;cursor:pointer;max-width:210px;",
  "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".qz-plf-tag:hover{background:rgba(61,168,254,.22);color:#cfe8ff;}",
  ".qz-plf-more{font-size:11px;color:#7d8798;font-weight:600;}",
  ".qz-plf-none{font-size:11px;color:#8a6b3d;font-weight:600;}",
  ".qz-plf-dur{flex:0 0 46px;text-align:right;font-size:12px;color:#7d8798;font-variant-numeric:tabular-nums;}"
].join(""));

var offRoute = Q.onRoute(sync);
var offObs = (typeof Q.observe === "function") ? Q.observe(sync, { debounce: 250 }) : function () {};
window.addEventListener("resize", onResize);
document.addEventListener("keydown", onEsc, true);
var offProgress = (Q.library && typeof Q.library.onProgress === "function")
  ? Q.library.onProgress(function (p) { if (on && p && p.done) render(); })
  : function () {};
sync();

return function cleanup() {
  if (offRoute) offRoute();
  if (offObs) offObs();
  if (offProgress) offProgress();
  window.removeEventListener("resize", onResize);
  document.removeEventListener("keydown", onEsc, true);
  if (playIv) { clearInterval(playIv); playIv = null; }
  if (panel) { panel.remove(); panel = null; }
  if (chip) { chip.remove(); chip = null; }
  var st = document.getElementById(CSS_ID); if (st) st.remove();
  on = false; rows = []; idx = null;
};
