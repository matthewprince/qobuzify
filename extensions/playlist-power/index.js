// Playlist Power - two playlist features asked for on r/qobuz. Runs as function(Qobuzify){ ... return cleanup }.
//
// (1) SORT (r/qobuz treeitsme): a "Sort" button on any playlist page opens a modal that re-queries the
//     whole playlist and lists it in a chosen order - Recently added, Title A-Z, Duration, or Default.
//     Qobuz renders long track lists with react-virtualized (windowed above OPTIMIZED_LIST_THRESHOLD=15),
//     so reordering the on-page DOM rows can't work for a real playlist; we re-query and render our own
//     list instead. Clicking a row plays that track through Qobuz's own controls (scroll the native list
//     to the row, click its native play button) - the audio engine is sealed, so play is always native.
//
// (2) CONTEXT (r/qobuz thegooddoktorjones): shuffle "forgets" the playlist you started from. The play
//     queue is a sealed module and, crucially, stores NO reference to the source playlist (each queue item
//     only carries playlist_track_id + track_list_index, not the playlist id). So we work it out from the
//     side: every playlist/album you open gets its track ids cached, and the current track's source is
//     whichever cached set it belongs to (survives shuffle - the shuffled ids are still in the set). A
//     "N / M in <name>" pill in the player shows where you are; its menu jumps back to the playlist or
//     removes the current track from it (playlist/deleteTracks keys off playlist_track_id, not track id).
var Q = Qobuzify;
var CSS_ID = "qz-pp-css";
var BTN_ID = "qz-pp-sortbtn";
var LS_SOURCES = "pp:sources";
var MAX_SOURCES = 6; // how many recent playlists/albums to remember for the context pill
// Feature 2 (the "playing from N/M" pill + jump/remove) duplicates the dedicated playlist-context extension,
// so ship this extension as SORT-ONLY to avoid two pills. Flip to true only if playlist-context is retired.
var CONTEXT_PILL = false;

var SORT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M7 4l-3 3M7 4l3 3"/><path d="M14 7h7M14 12h5M14 17h3"/></svg>';
var LIST_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>';

// ---------- shared helpers ----------
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
function route() { try { return Q.getState().router.location.pathname || ""; } catch (e) { return ""; } }
function playlistIdFromPath(path) { var m = String(path == null ? route() : path).match(/\/playlist\/([^/?#]+)/); return m ? m[1] : null; }
function pageCtx(path) { var m = String(path == null ? route() : path).match(/\/(album|playlist)\/([^/?#]+)/); return m ? { kind: m[1], id: m[2] } : null; }
function curTrackId() { try { var ct = Q.getState().player.currentTrack; return ct && ct.id != null ? String(ct.id) : null; } catch (e) { return null; } }
function normStr(s) { return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim(); }
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function fmtDur(sec) { sec = Math.round(sec || 0); var m = Math.floor(sec / 60), s = sec % 60; return m + ":" + pad2(s); }

// Note on playlist_track_id from the store: the current play-queue item lives at
// Q.getState().playqueue[shuffled?'shuffledItems':'items'][currentIndex] and is shaped
// { track_id, playlist_track_id, track_list_index, track_data } - so playlist_track_id IS readable
// there (0 when the track wasn't queued from a playlist). Removal below deliberately re-derives it from
// the *named* source instead, because the queue item reflects wherever the track was actually queued
// from, which can differ from the source the pill is showing for a track that sits in several playlists.

function scrollParent(el) {
  for (var n = el && el.parentElement; n && n !== document.body; n = n.parentElement) {
    var oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 4) return n;
  }
  return null;
}

// ---------- track loading ----------
function trackYear(t) {
  var r = (t.album && (t.album.released_at || t.album.release_date_original)) || t.release_date_original || t.released_at;
  if (typeof r === "string") { var p = Date.parse(r); r = isNaN(p) ? 0 : p / 1000; }
  return r ? new Date(r * 1000).getFullYear() : 0;
}
function normTrack(t, i) {
  return {
    id: String(t.id), index: i,
    title: t.title || "", version: t.version || "",
    artist: (t.performer && t.performer.name) || (t.album && t.album.artist && t.album.artist.name) || "",
    album: (t.album && t.album.title) || "",
    dur: t.duration || 0, added: t.created_at || 0, year: trackYear(t),
    hires: !!(t.hires || (t.maximum_bit_depth || 0) >= 24),
    cover: (t.album && t.album.image && (t.album.image.small || t.album.image.thumbnail)) || ""
  };
}
// full tracks for the Sort modal (paginated)
function loadTracks(id) {
  var all = [];
  function page(off) {
    return Q.api("playlist/get?playlist_id=" + id + "&extra=tracks&limit=500&offset=" + off, { timeout: 45000 }).then(function (j) {
      var t = (j.tracks && j.tracks.items) || []; all = all.concat(t);
      var total = (j.tracks && j.tracks.total) || all.length;
      if (all.length < total && t.length && all.length < 5000) return page(all.length);
      return all;
    });
  }
  return page(0).then(function (raw) { return raw.map(normTrack); });
}
// just the ids for the context cache
function loadIds(kind, id) {
  if (kind === "album") return Q.api("album/get?album_id=" + id).then(function (j) { return ((j.tracks && j.tracks.items) || []).map(function (t) { return String(t.id); }); }).catch(function () { return []; });
  var all = [];
  function page(off) {
    return Q.api("playlist/get?playlist_id=" + id + "&extra=tracks&limit=500&offset=" + off, { timeout: 45000 }).then(function (j) {
      var t = (j.tracks && j.tracks.items) || [];
      all = all.concat(t.map(function (x) { return String(x.id); }));
      var total = (j.tracks && j.tracks.total) || all.length;
      if (all.length < total && t.length && all.length < 5000) return page(all.length);
      return all;
    }).catch(function () { return all; });
  }
  return page(0);
}
function resolveName(kind, id) {
  var p = kind === "album" ? "album/get?album_id=" + id + "&limit=0" : "playlist/get?playlist_id=" + id + "&limit=0";
  return Q.api(p).then(function (j) { return kind === "album" ? (j.title || "Album") : (j.name || "Playlist"); }).catch(function () { return kind === "album" ? "Album" : "Playlist"; });
}

// =====================================================================================
// FEATURE 1 - Sort modal
// =====================================================================================
var SORTS = [
  { key: "default", label: "Default", cmp: function (a, b) { return a.index - b.index; } },
  { key: "recent", label: "Recently added", cmp: function (a, b) { return (b.added || 0) - (a.added || 0) || a.index - b.index; } },
  { key: "recenta", label: "Oldest added", cmp: function (a, b) { return (a.added || 0) - (b.added || 0) || a.index - b.index; } },
  { key: "title", label: "Title A-Z", cmp: function (a, b) { return normStr(a.title).localeCompare(normStr(b.title)) || a.index - b.index; } },
  { key: "dur", label: "Duration", cmp: function (a, b) { return a.dur - b.dur || a.index - b.index; } }
];
function sortCmp(key) { var s = SORTS.filter(function (x) { return x.key === key; })[0]; return (s || SORTS[0]).cmp; }

// MTRACKS is null while a playlist is loading (renderList's !MTRACKS guard blocks stale renders)
var modal = null, MTRACKS = null, mCurId = null, mCurName = "", mSort = "default";

function buildModal() {
  if (modal) return;
  modal = document.createElement("div"); modal.className = "qz-pp-overlay"; modal.style.display = "none";
  Q.ui.follow(modal);
  modal.innerHTML =
    '<div class="qz-pp-modal" role="dialog" aria-modal="true">' +
      '<div class="qz-pp-head">' +
        '<div class="qz-pp-headl">' + SORT_ICON + '<div><div class="qz-pp-kicker">Sort playlist</div><div class="qz-pp-title"></div></div></div>' +
        '<button type="button" class="qz-pp-x" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
      '</div>' +
      '<div class="qz-pp-segrow"></div>' +
      '<div class="qz-pp-body"></div>' +
    '</div>';
  document.body.appendChild(modal);
  modal.addEventListener("mousedown", function (e) { if (e.target === modal) closeModal(); });
  modal.querySelector(".qz-pp-x").addEventListener("click", closeModal);
}
function openModal(id, name) {
  buildModal();
  mCurId = id; mCurName = name || "Playlist"; mSort = "default"; MTRACKS = null;
  modal.style.display = "flex"; requestAnimationFrame(function () { modal.classList.add("qz-pp-in"); });
  modal.querySelector(".qz-pp-title").textContent = mCurName;
  renderSegs();
  setBody('<div class="qz-pp-loading"><div class="qz-pp-spin"></div>Loading ' + esc(mCurName) + '…</div>');
  // confirm the real name via API (the header selector is a best-effort guess)
  resolveName("playlist", id).then(function (nm) { if (mCurId === id && nm) { mCurName = nm; var te = modal.querySelector(".qz-pp-title"); if (te) te.textContent = nm; } });
  loadTracks(id).then(function (tracks) {
    if (mCurId !== id) return; // navigated away / reopened
    MTRACKS = tracks; renderList();
  }, function () { setBody('<div class="qz-pp-empty">Could not load this playlist.</div>'); });
}
function closeModal() { if (!modal) return; modal.classList.remove("qz-pp-in"); setTimeout(function () { if (modal && !modal.classList.contains("qz-pp-in")) modal.style.display = "none"; }, 170); }
function setBody(html) { var b = modal && modal.querySelector(".qz-pp-body"); if (b) b.innerHTML = html; return b; }
function renderSegs() {
  var row = modal.querySelector(".qz-pp-segrow");
  row.innerHTML = SORTS.map(function (s) { return '<button class="qz-pp-seg' + (mSort === s.key ? " qz-pp-seg--on" : "") + '" data-sort="' + s.key + '">' + esc(s.label) + '</button>'; }).join("");
  row.querySelectorAll("[data-sort]").forEach(function (b) {
    b.addEventListener("click", function () { mSort = b.getAttribute("data-sort"); renderSegs(); renderList(); });
  });
}
function renderList() {
  if (!MTRACKS) return;
  if (!MTRACKS.length) { setBody('<div class="qz-pp-empty">This playlist is empty.</div>'); return; }
  var arr = MTRACKS.slice().sort(sortCmp(mSort));
  var curId = curTrackId();
  var html = '<div class="qz-pp-scroll"><div class="qz-pp-hint">' + arr.length + ' tracks · click a track to play it in this order</div><div class="qz-pp-list">';
  for (var i = 0; i < arr.length; i++) {
    var t = arr[i], playing = curId && t.id === curId;
    var sub = [t.artist, t.album].filter(Boolean).join(" · ");
    html += '<button class="qz-pp-row' + (playing ? " qz-pp-row--playing" : "") + '" data-i="' + i + '" title="Play — ' + esc(t.title) + '">' +
      '<span class="qz-pp-idx">' + (playing ? LIST_ICON : (i + 1)) + '</span>' +
      '<span class="qz-pp-rtxt"><span class="qz-pp-rt">' + esc(t.title) + (t.version ? ' <span class="qz-pp-ver">' + esc(t.version) + '</span>' : '') + '</span>' +
      '<span class="qz-pp-ra">' + esc(sub) + '</span></span>' +
      (t.hires ? '<span class="qz-pp-hr">Hi-Res</span>' : '') +
      '<span class="qz-pp-dur">' + fmtDur(t.dur) + '</span>' +
      '<span class="qz-pp-play"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg></span>' +
      '</button>';
  }
  html += '</div></div>';
  var b = setBody(html);
  var rows = b.querySelectorAll("[data-i]");
  rows.forEach(function (el) {
    el.addEventListener("click", function () { var t = arr[parseInt(el.getAttribute("data-i"), 10)]; if (t) playFromPlaylist(t); });
  });
}

// Play a specific track through Qobuz's own controls. We're already on the playlist page (the modal is
// an overlay on top of it); the native list is still mounted behind us. It's react-virtualized, so a row
// that's scrolled off can't be clicked until it renders - nudge the native scroll toward the track's
// original index until the row appears, match it by title (+artist), then click its native play button.
function playFromPlaylist(t) {
  if (playlistIdFromPath() !== mCurId) { mtoast("Open this playlist to play from here", true); return; }
  var want = normStr(t.title), wantA = normStr(t.artist), tries = 0;
  mtoast("Starting “" + t.title + "”…");
  var iv = setInterval(function () {
    tries++;
    var rows = document.querySelectorAll(".playlist-tracks-list .ListItem, .track-list .ListItem, .ListItem");
    var best = null, exact = null;
    for (var i = 0; i < rows.length; i++) {
      var te = rows[i].querySelector(".ListItem__title"); if (!te) continue;
      if (normStr(te.textContent) !== want) continue;
      if (!best) best = rows[i];
      var ae = rows[i].querySelector('a[href*="/artist/"]'); var ra = ae ? normStr(ae.textContent) : "";
      if (!wantA || !ra || ra === wantA || ra.indexOf(wantA) >= 0 || wantA.indexOf(ra) >= 0) { exact = rows[i]; break; }
    }
    var row = exact || best;
    if (row) { var p = row.querySelector(".ListItem__player"); if (p) { p.dispatchEvent(new MouseEvent("click", { bubbles: true })); clearInterval(iv); closeModal(); return; } }
    // not rendered yet: push the native virtualized list toward this track's original index
    var sample = document.querySelector(".track-list .ListItem, .ListItem");
    var sc = sample ? scrollParent(sample) : null;
    if (sc && sample && t.index >= 0) { var rowH = sample.getBoundingClientRect().height || 56; sc.scrollTop = Math.max(0, t.index * rowH - sc.clientHeight / 2 + rowH / 2); }
    if (tries > 55) { clearInterval(iv); mtoast("Couldn't start that track from here", true); }
  }, 110);
}

// the sort modal's messages and the pill's page messages both go through the one shared toast, which
// stacks above the modal
function mtoast(msg, bad) { if (!modal) return; toast(msg, bad, 2400); }

// Inject the Sort button into the playlist page header (any playlist - it's read-only + native play).
function injectSortBtn() {
  var id = playlistIdFromPath();
  var ex = document.getElementById(BTN_ID);
  if (!id) { if (ex) ex.remove(); return; }
  if (ex) { if (ex.getAttribute("data-pid") === id && ex.parentNode) return; ex.remove(); }
  var host = document.querySelector(".PageHeader__actions"); if (!host) return;
  var b = document.createElement("button");
  b.id = BTN_ID; b.type = "button"; b.className = "qz-pp-btn"; b.title = "Sort this playlist"; b.setAttribute("data-pid", id);
  b.innerHTML = SORT_ICON + "<span>Sort</span>";
  b.addEventListener("click", function (e) {
    e.preventDefault(); e.stopPropagation();
    var nm = document.querySelector(".PageHeader__title, .PageHeader h1");
    openModal(id, (nm && nm.textContent.trim()) || "Playlist");
  });
  host.appendChild(b);
}

// =====================================================================================
// FEATURE 2 - context pill (source cache + player pill + jump/remove)
// =====================================================================================
var sources = [];
try { sources = JSON.parse(Q.storage.get(LS_SOURCES, "[]")) || []; } catch (e) { sources = []; }
if (!Array.isArray(sources)) sources = [];
function persistSources() { try { Q.storage.set(LS_SOURCES, JSON.stringify(sources.slice(0, MAX_SOURCES))); } catch (e) {} }
function findSource(kind, id) { for (var i = 0; i < sources.length; i++) if (sources[i].kind === kind && sources[i].id === id) return sources[i]; return null; }
function promote(entry) { sources = [entry].concat(sources.filter(function (s) { return s !== entry; })).slice(0, MAX_SOURCES); }

// note a playlist/album the user opened: cache/refresh its ids + name, move it to the front
function touchSource(kind, id) {
  var e = findSource(kind, id);
  if (e) { promote(e); persistSources(); refreshPill(); }
  else { e = { kind: kind, id: id, name: kind === "album" ? "Album" : "Playlist", ids: null }; sources = [e].concat(sources).slice(0, MAX_SOURCES); persistSources(); resolveName(kind, id).then(function (nm) { e.name = nm; persistSources(); refreshPill(); }); }
  loadIds(kind, id).then(function (ids) { if (ids && ids.length) { e.ids = ids; persistSources(); refreshPill(); } });
}
// the source the current track belongs to (most-recently opened wins if it's in several)
function currentSource() { var id = curTrackId(); if (!id) return null; for (var i = 0; i < sources.length; i++) { var s = sources[i]; if (s.ids && s.ids.indexOf(id) >= 0) return s; } return null; }

var ctx = null, pillSlot = null, pillEl = null;
function positionText() {
  var id = curTrackId(); if (!id || !ctx || !ctx.ids) return "";
  var i = ctx.ids.indexOf(id);
  return i >= 0 ? (i + 1) + " / " + ctx.ids.length : "";
}
function refreshPill() { ctx = currentSource(); renderPill(); }
function renderPill() {
  if (!ctx) { if (pillSlot) { pillSlot.remove(); pillSlot = null; pillEl = null; } return; }
  if (!pillEl) {
    pillEl = document.createElement("button");
    pillEl.className = "qz-pp-pill";
    pillEl.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); openPillMenu(e); });
    pillEl.addEventListener("contextmenu", function (e) { e.preventDefault(); e.stopPropagation(); openPillMenu(e); });
  }
  var pos = positionText();
  pillEl.title = (pos ? pos + " — " : "") + "in " + ctx.name + " (click for options)";
  pillEl.innerHTML = LIST_ICON + '<span class="qz-pp-pilltxt">' + (pos ? '<span class="qz-pp-pos">' + pos + '</span> ' : '') + '<span class="qz-pp-in">in ' + esc(ctx.name) + '</span></span>';
  if (!pillSlot) pillSlot = Q.playerSlot({ id: "playlist-power-ctx", zone: "right", order: 12, el: pillEl });
}

// ---- pill menu (jump / remove) ----
function closePillMenu() { var m = document.getElementById("qz-pp-menu"); if (m) m.remove(); document.removeEventListener("mousedown", pillMenuOutside, true); }
function pillMenuOutside(ev) { var m = document.getElementById("qz-pp-menu"); if (m && !m.contains(ev.target)) closePillMenu(); }
function openPillMenu(e) {
  if (!ctx) return;
  closePillMenu();
  var canRemove = ctx.kind === "playlist";
  var m = document.createElement("div"); m.className = "qz-pp-menu"; m.id = "qz-pp-menu";
  Q.ui.follow(m);
  m.innerHTML = '<div class="qz-pp-mi" data-act="go">Go to ' + esc(ctx.name) + '</div>' +
    (canRemove ? '<div class="qz-pp-mi qz-pp-mi--danger" data-act="remove">Remove this track from the playlist</div>' : '');
  document.body.appendChild(m);
  var mw = 260, mh = canRemove ? 92 : 48;
  m.style.left = Math.min(Math.max(8, e.clientX), window.innerWidth - mw) + "px";
  m.style.top = Math.max(8, e.clientY - mh) + "px";
  m.querySelector('[data-act="go"]').addEventListener("click", function () { closePillMenu(); jumpToSource(); });
  var rm = m.querySelector('[data-act="remove"]'); if (rm) rm.addEventListener("click", function () { closePillMenu(); removeCurrentFromPlaylist(); });
  setTimeout(function () { document.addEventListener("mousedown", pillMenuOutside, true); }, 0);
}

function playingRow() {
  var r = document.querySelector(".ListItem.isPlaying"); if (r) return r;
  var title = (Q.player.getTrack() || {}).title; if (!title) return null;
  var rows = document.querySelectorAll(".ListItem");
  for (var i = 0; i < rows.length; i++) { var a = rows[i].querySelector(".ListItem__title"); if (a && normStr(a.textContent) === normStr(title)) return rows[i]; }
  return null;
}
function jumpToSource() {
  if (!ctx) return;
  var idx = (ctx.ids || []).indexOf(curTrackId());
  Q.navigate("/" + ctx.kind + "/" + ctx.id);
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    if (route().indexOf(ctx.id) < 0) { if (tries > 60) clearInterval(iv); return; }
    var row = playingRow();
    if (row) { flashRow(row); try { row.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {} clearInterval(iv); return; }
    var sample = document.querySelector(".ListItem"), sc = sample ? scrollParent(sample) : null;
    if (sc && sample && idx >= 0) { var rowH = sample.getBoundingClientRect().height || 56; sc.scrollTop = Math.max(0, idx * rowH - sc.clientHeight / 2 + rowH / 2); }
    if (tries > 60) clearInterval(iv);
  }, 120);
}
function flashRow(el) { el.classList.add("qz-pp-flash"); setTimeout(function () { el.classList.remove("qz-pp-flash"); }, 2200); }

// Remove the current track from its source playlist. deleteTracks wants playlist_track_id (not the track
// id): re-query the *named* source and match by track id to get the right entry - correct even when the
// track sits in several playlists. (The store's current queue item also carries playlist_track_id, but it
// reflects wherever the track was queued from, which may differ from the source the pill is showing.)
function removeCurrentFromPlaylist() {
  if (!ctx || ctx.kind !== "playlist") return;
  var id = curTrackId(); if (!id) { pageToast("Nothing is playing", true); return; }
  var pid = ctx.id, name = ctx.name;
  // page the whole playlist until the track turns up - one limit=500 fetch made removal dead for any
  // track past position 500 (same fix as playlist-context)
  function findEntry(off) {
    return Q.api("playlist/get?playlist_id=" + pid + "&extra=tracks&limit=500&offset=" + off, { timeout: 45000 }).then(function (j) {
      var items = (j.tracks && j.tracks.items) || [];
      for (var i = 0; i < items.length; i++) { if (String(items[i].id) === id) return items[i]; }
      var total = (j.tracks && j.tracks.total) || 0;
      if (items.length && off + items.length < total) return findEntry(off + items.length);
      return null;
    });
  }
  findEntry(0).then(function (match) {
    var ptid = match && (match.playlist_track_id || match.playlistTrackId);
    if (!ptid) { pageToast("Couldn't find that track in the playlist", true); return; }
    return Q.api("playlist/deleteTracks?playlist_id=" + pid + "&playlist_track_ids=" + ptid).then(function () {
      var e = findSource("playlist", pid); if (e && e.ids) e.ids = e.ids.filter(function (t) { return t !== id; });
      persistSources(); pageToast("Removed from " + name); refreshPill();
    });
  }).catch(function () { pageToast("Remove failed - try again", true); });
}

// ---- page-level toast (for the pill actions, outside the modal) ----
function pageToast(msg, bad) { toast(msg, bad, 2600); }
// one toast at a time, as before: a new message updates the open one and restarts its timer
var curToast = null, curBad = false, toastT = null;
function toast(msg, bad, ms) {
  clearTimeout(toastT);
  if (curToast && curBad !== !!bad) curToast.close();
  if (curToast) curToast.update(msg);
  else { var t = curToast = Q.ui.toast(msg, { timeout: 0, tone: bad ? "error" : undefined, onClose: function () { if (curToast === t) curToast = null; } }); curBad = !!bad; }
  var mine = curToast;
  toastT = setTimeout(function () { mine.close(); }, ms || 2600);
}
function closeToast() { clearTimeout(toastT); if (curToast) curToast.close(); }

// =====================================================================================
// styles
// =====================================================================================
Q.css(CSS_ID, [
  // --- Sort header button ---
  ".qz-pp-btn{display:inline-flex;align-items:center;gap:7px;height:40px;padding:0 16px;border:1px solid var(--qz-accent,#3DA8FE);border-radius:20px;background:transparent;color:var(--qz-accent,#3DA8FE);font:inherit;font-size:13.5px;font-weight:750;cursor:pointer;transition:all .15s;margin-left:4px;}",
  ".qz-pp-btn:hover{background:var(--qz-accent,#3DA8FE);color:#06090a;}",
  ".qz-pp-btn svg{width:17px;height:17px;}",
  // --- modal --- (the overlay and the pill menu are appended to <body> and follow Qobuz's appearance via
  // Q.ui.follow, so the kit's tokens apply)
  ".qz-pp-overlay{position:fixed;inset:0;z-index:2147483200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);opacity:0;transition:opacity .18s;font-family:inherit;-webkit-app-region:no-drag;}",
  ".qz-pp-overlay.qz-pp-in{opacity:1;}",
  ".qz-pp-modal{width:min(680px,94vw);max-height:86vh;display:flex;flex-direction:column;color:var(--qzu-fg);background:var(--qzu-surface);border:1px solid var(--qzu-line);border-radius:18px;box-shadow:0 24px 64px rgba(0,0,0,.45);overflow:hidden;transform:translateY(8px) scale(.99);transition:transform .18s;}",
  ".qz-pp-in .qz-pp-modal{transform:none;}",
  ".qz-pp-head{display:flex;align-items:center;gap:12px;padding:18px 20px 14px;border-bottom:1px solid var(--qzu-line);}",
  ".qz-pp-headl{display:flex;align-items:center;gap:12px;min-width:0;flex:1;}",
  ".qz-pp-headl>svg{width:24px;height:24px;color:var(--qz-accent,#3DA8FE);flex:0 0 auto;}",
  ".qz-pp-kicker{font-size:12.5px;font-weight:600;color:var(--qzu-fg2);}",
  ".qz-pp-title{font-size:19px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:500px;}",
  ".qz-pp-x{flex:0 0 auto;width:36px;height:36px;border:0;border-radius:50%;background:var(--qzu-fill);color:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .14s;}",
  ".qz-pp-x:hover{background:var(--qzu-fill-hover);}.qz-pp-x svg{width:18px;height:18px;}",
  ".qz-pp-segrow{display:flex;gap:8px;flex-wrap:wrap;padding:14px 20px 4px;flex:0 0 auto;}",
  ".qz-pp-seg{appearance:none;border:1px solid var(--qzu-line);background:transparent;color:inherit;font:inherit;font-size:12.5px;font-weight:700;padding:7px 15px;border-radius:20px;cursor:pointer;transition:all .14s;}",
  ".qz-pp-seg:hover{border-color:var(--qz-accent,#3DA8FE);}",
  ".qz-pp-seg--on{background:var(--qz-accent,#3DA8FE);border-color:var(--qz-accent,#3DA8FE);color:#06090a;}",
  ".qz-pp-body{flex:1 1 auto;overflow:hidden;display:flex;min-height:280px;}",
  ".qz-pp-scroll{flex:1;overflow:auto;padding:10px 14px 16px;scrollbar-color:color-mix(in srgb,currentColor 22%,transparent) transparent;}",
  ".qz-pp-scroll::-webkit-scrollbar{width:10px;}.qz-pp-scroll::-webkit-scrollbar-thumb{background:color-mix(in srgb,currentColor 18%,transparent);border-radius:6px;}",
  ".qz-pp-hint{font-size:12px;color:var(--qzu-fg2);padding:6px 8px 10px;}",
  ".qz-pp-loading,.qz-pp-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:var(--qzu-fg2);font-size:15px;font-weight:600;padding:50px;}",
  ".qz-pp-spin{width:34px;height:34px;border-radius:50%;border:3px solid color-mix(in srgb,currentColor 16%,transparent);border-top-color:var(--qz-accent,#3DA8FE);animation:qz-pp-spin .8s linear infinite;}",
  "@keyframes qz-pp-spin{to{transform:rotate(360deg)}}",
  // --- track rows ---
  ".qz-pp-list{display:flex;flex-direction:column;gap:1px;}",
  ".qz-pp-row{display:flex;align-items:center;gap:12px;width:100%;text-align:left;appearance:none;border:0;background:transparent;color:inherit;font:inherit;padding:9px 10px;border-radius:9px;cursor:pointer;transition:background .12s;}",
  ".qz-pp-row:hover{background:color-mix(in srgb,var(--qz-accent,#3DA8FE) 13%,transparent);}",
  ".qz-pp-row--playing{background:color-mix(in srgb,var(--qz-accent,#3DA8FE) 9%,transparent);}",
  ".qz-pp-idx{flex:0 0 auto;width:22px;text-align:center;font-size:12.5px;color:var(--qzu-fg2);font-weight:700;display:flex;align-items:center;justify-content:center;}",
  ".qz-pp-idx svg{width:15px;height:15px;color:var(--qz-accent,#3DA8FE);}",
  ".qz-pp-row--playing .qz-pp-idx{color:var(--qz-accent,#3DA8FE);}",
  ".qz-pp-rtxt{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;line-height:1.25;}",
  ".qz-pp-rt{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".qz-pp-ver{color:var(--qzu-fg2);font-weight:500;font-size:12px;}",
  ".qz-pp-ra{font-size:12px;color:var(--qzu-fg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".qz-pp-hr{flex:0 0 auto;font-size:10px;font-weight:700;color:var(--qz-accent,#3DA8FE);border:1px solid color-mix(in srgb,var(--qz-accent,#3DA8FE) 45%,transparent);border-radius:5px;padding:2px 5px;}",
  ".qz-pp-dur{flex:0 0 auto;width:42px;text-align:right;font-size:12px;color:var(--qzu-fg2);font-variant-numeric:tabular-nums;}",
  ".qz-pp-play{flex:0 0 auto;color:var(--qz-accent,#3DA8FE);opacity:0;transition:opacity .12s;display:flex;}",
  ".qz-pp-row:hover .qz-pp-play{opacity:1;}",
  // --- context pill (in the player bar: drawn from its text colour) ---
  ".qz-pp-pill{display:inline-flex;align-items:center;gap:7px;max-width:220px;height:32px;padding:0 12px;border-radius:18px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);background:color-mix(in srgb,currentColor 4%,transparent);color:inherit;font:inherit;font-size:12px;cursor:pointer;transition:all .14s;flex:0 0 auto;}",
  ".qz-pp-pill:hover{border-color:var(--qz-accent,#3DA8FE);background:color-mix(in srgb,var(--qz-accent,#3DA8FE) 12%,transparent);}",
  ".qz-pp-pill svg{width:15px;height:15px;flex:0 0 auto;color:var(--qz-accent,#3DA8FE);}",
  ".qz-pp-pilltxt{display:inline-flex;align-items:baseline;gap:5px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".qz-pp-pos{font-weight:700;font-variant-numeric:tabular-nums;}",
  ".qz-pp-in{overflow:hidden;text-overflow:ellipsis;max-width:150px;opacity:.7;}",
  // --- pill menu ---
  ".qz-pp-menu{position:fixed;z-index:2147483600;min-width:230px;padding:6px;box-sizing:border-box;background:var(--qzu-surface);border:1px solid var(--qzu-line);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.35);color:var(--qzu-fg);font-size:13px;}",
  ".qz-pp-mi{padding:9px 11px;border-radius:8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".qz-pp-mi:hover{background:var(--qzu-fill-hover);}",
  ".qz-pp-mi--danger{color:var(--qzu-error);}",
  ".qz-pp-mi--danger:hover{background:color-mix(in srgb,var(--qzu-error) 12%,transparent);}",
  // --- jump flash ---
  ".qz-pp-flash{animation:qz-pp-flash 2.2s ease;}",
  "@keyframes qz-pp-flash{0%,100%{background:transparent;}18%{background:color-mix(in srgb,var(--qz-accent,#3DA8FE) 30%,transparent);}}"
].join(""));

// =====================================================================================
// boot
// =====================================================================================
// warm the context cache for anything already remembered, and for the page we land on
if (CONTEXT_PILL) {
  sources.forEach(function (s) { if (!s.ids || !s.ids.length) loadIds(s.kind, s.id).then(function (ids) { if (ids && ids.length) { s.ids = ids; persistSources(); refreshPill(); } }); });
  var pc0 = pageCtx(); if (pc0) touchSource(pc0.kind, pc0.id);
  refreshPill();
}
injectSortBtn();

var offChange = CONTEXT_PILL ? Q.player.onChange(refreshPill) : null;
var offRoute = Q.onRoute(function (path) {
  closePillMenu();
  if (modal && modal.classList.contains("qz-pp-in")) closeModal();
  if (CONTEXT_PILL) { var m = pageCtx(path); if (m) touchSource(m.kind, m.id); }
  setTimeout(injectSortBtn, 350);
});
var obs = Q.observe(function () { injectSortBtn(); }, { debounce: 300 });
document.addEventListener("keydown", onKey, true);
function onKey(e) { if (e.key === "Escape" && modal && modal.classList.contains("qz-pp-in")) { e.stopPropagation(); closeModal(); } }

return function cleanup() {
  if (offChange) offChange();
  if (offRoute) offRoute();
  if (obs) obs();
  document.removeEventListener("keydown", onKey, true);
  closePillMenu();
  if (pillSlot) pillSlot.remove();
  var sb = document.getElementById(BTN_ID); if (sb) sb.remove();
  if (modal) { modal.remove(); modal = null; }
  closeToast();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
