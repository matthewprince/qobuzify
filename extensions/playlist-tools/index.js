// Stats, Export, remove-duplicates, and Sort for your own Qobuz playlists. Runs as
// function(Qobuzify){ ... return cleanup }. Nothing here needs the play API - it's all the playlist
// write API, GET via Q.api: playlist/get?extra=tracks, playlist/create, playlist/addTracks,
// playlist/deleteTracks. A "Tools" button goes into the playlist page header (.PageHeader__actions),
// but only on playlists you actually own (owner.id === your user id), and it opens a four-tab modal:
//   - Stats is read-only: total time, hi-res %, top artists, a decade breakdown, unique artists/albums.
//   - Export is read-only: copy to clipboard, or download as Text / M3U / CSV / JSON.
//   - Duplicates edits the playlist, so it's cautious - it scans for repeats, makes you confirm inline,
//     then deletes the extras (keeping the first of each) and reloads.
//   - Sort never touches the original - it builds a new sorted playlist and opens that instead.
var Q = Qobuzify;
var CSS_ID = "qz-pt-css";
var BTN_ID = "qz-pt-btn";
var TOOLS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4v5M6 15v5M12 4v3M12 13v7M18 4v9M18 17v3"/><circle cx="6" cy="12" r="2.4"/><circle cx="12" cy="10" r="2.4"/><circle cx="18" cy="15" r="2.4"/></svg>';

// --- helpers ---
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
function pid() { var m = (Q.getState().router.location.pathname || "").match(/\/playlist\/([^/?#]+)/); return m ? m[1] : null; }
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function fmtClock(s) { s = Math.round(s || 0); var m = Math.floor(s / 60), ss = s % 60; return m + ":" + pad2(ss); }
function fmtLong(s) { s = Math.round(s || 0); var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? (h + "h " + m + "m") : (m + " min"); }
function normStr(s) { return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim(); }
function chunk(a, n) { var o = []; for (var i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

var meCache = null;
function me() { if (meCache != null) return Promise.resolve(meCache); return Q.api("user/get").then(function (u) { meCache = (u && (u.id || (u.user && u.user.id))) || 0; return meCache; }).catch(function () { meCache = 0; return 0; }); }
var metaCache = {};
function plMeta(id) { if (metaCache[id]) return Promise.resolve(metaCache[id]); return Q.api("playlist/get?playlist_id=" + id + "&limit=0").then(function (j) { metaCache[id] = { name: j.name, ownerId: j.owner && j.owner.id, count: j.tracks_count }; return metaCache[id]; }).catch(function () { return null; }); }

function yearOf(t) {
  var r = (t.album && (t.album.released_at || t.album.release_date_original)) || t.release_date_original || t.released_at;
  if (typeof r === "string") { var p = Date.parse(r); r = isNaN(p) ? 0 : p / 1000; }
  return r ? new Date(r * 1000).getFullYear() : 0;
}
function normTrack(t) {
  return {
    id: t.id, ptid: t.playlist_track_id,
    title: t.title || "", artist: (t.performer && t.performer.name) || (t.album && t.album.artist && t.album.artist.name) || "",
    album: (t.album && t.album.title) || "", dur: t.duration || 0,
    hires: !!(t.hires || (t.maximum_bit_depth || 0) >= 24), explicit: !!(t.parental_warning),
    year: yearOf(t), added: t.created_at || 0, isrc: t.isrc || ""
  };
}
function loadAll(id) {
  var all = [];
  function page(offset) {
    return Q.api("playlist/get?playlist_id=" + id + "&extra=tracks&limit=500&offset=" + offset).then(function (j) {
      var t = (j.tracks && j.tracks.items) || []; all = all.concat(t);
      var total = (j.tracks && j.tracks.total) || all.length;
      if (all.length < total && t.length) return page(all.length);
      return all;
    });
  }
  return page(0).then(function (raw) { return raw.map(normTrack); });
}
function addTracksBatched(id, ids) { return chunk(ids, 50).reduce(function (p, c) { return p.then(function () { return Q.api("playlist/addTracks?playlist_id=" + id + "&track_ids=" + c.join(",")); }); }, Promise.resolve()); }
function deleteTracksBatched(id, ptids) { return chunk(ptids, 50).reduce(function (p, c) { return p.then(function () { return Q.api("playlist/deleteTracks?playlist_id=" + id + "&playlist_track_ids=" + c.join(",")); }); }, Promise.resolve()); }

function copyText(text) {
  return new Promise(function (res, rej) {
    function fallback() { try { var ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.left = "-9999px"; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); res(); } catch (e) { rej(e); } }
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(res, fallback); return; } } catch (e) {}
    fallback();
  });
}
function download(name, text, mime) { try { var b = new Blob([text], { type: mime || "text/plain;charset=utf-8" }); var u = URL.createObjectURL(b); var a = document.createElement("a"); a.href = u; a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); URL.revokeObjectURL(u); }, 1500); } catch (e) {} }
function safeName(s) { return String(s || "playlist").replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "playlist"; }

// --- modal ---
var modal = null, TR = [], curId = null, curName = "", tab = "stats";
function toast(msg) {
  if (!modal) return;
  var t = modal.querySelector(".qz-pt-toast"); if (!t) return;
  t.textContent = msg; t.classList.add("qz-pt-toast--show");
  clearTimeout(t._iv); t._iv = setTimeout(function () { t.classList.remove("qz-pt-toast--show"); }, 2200);
}
function openModal(id, name) {
  curId = id; curName = name || "Playlist"; tab = "stats";
  build();
  modal.style.display = "flex"; requestAnimationFrame(function () { modal.classList.add("qz-pt-in"); });
  modal.querySelector(".qz-pt-title").textContent = curName;
  setBody('<div class="qz-pt-loading"><div class="qz-pt-spin"></div>Loading ' + esc(curName) + '…</div>');
  loadAll(id).then(function (tracks) { TR = tracks; selectTab("stats"); }, function () { setBody('<div class="qz-pt-empty">Could not load this playlist.</div>'); });
}
function closeModal() { if (!modal) return; modal.classList.remove("qz-pt-in"); setTimeout(function () { if (modal && !modal.classList.contains("qz-pt-in")) modal.style.display = "none"; }, 180); }
function build() {
  if (modal) return;
  modal = document.createElement("div"); modal.className = "qz-pt-overlay"; modal.style.display = "none";
  modal.innerHTML =
    '<div class="qz-pt-modal" role="dialog" aria-modal="true">' +
      '<div class="qz-pt-head">' +
        '<div class="qz-pt-headl">' + TOOLS_ICON + '<div><div class="qz-pt-kicker">Playlist Tools</div><div class="qz-pt-title"></div></div></div>' +
        '<button class="qz-pt-x" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
      '</div>' +
      '<div class="qz-pt-tabs">' +
        ['stats:Stats', 'export:Export', 'dups:Duplicates', 'sort:Sort'].map(function (t) { var p = t.split(":"); return '<button class="qz-pt-tab" data-tab="' + p[0] + '">' + p[1] + '</button>'; }).join("") +
      '</div>' +
      '<div class="qz-pt-body"></div>' +
      '<div class="qz-pt-toast"></div>' +
    '</div>';
  document.body.appendChild(modal);
  modal.addEventListener("mousedown", function (e) { if (e.target === modal) closeModal(); });
  modal.querySelector(".qz-pt-x").addEventListener("click", closeModal);
  modal.querySelectorAll(".qz-pt-tab").forEach(function (b) { b.addEventListener("click", function () { selectTab(b.getAttribute("data-tab")); }); });
}
function setBody(html) { var b = modal && modal.querySelector(".qz-pt-body"); if (b) b.innerHTML = html; return b; }
function selectTab(t) {
  tab = t;
  modal.querySelectorAll(".qz-pt-tab").forEach(function (b) { b.classList.toggle("qz-pt-tab--on", b.getAttribute("data-tab") === t); });
  if (!TR) return;
  if (t === "stats") renderStats();
  else if (t === "export") renderExport();
  else if (t === "dups") renderDups();
  else if (t === "sort") renderSort();
}

// --- Stats ---
function renderStats() {
  var total = 0, hires = 0, explicit = 0, artists = {}, albums = {}, decades = {};
  TR.forEach(function (t) { total += t.dur; if (t.hires) hires++; if (t.explicit) explicit++; if (t.artist) artists[t.artist] = (artists[t.artist] || 0) + 1; if (t.album) albums[t.album] = 1; if (t.year) { var d = Math.floor(t.year / 10) * 10; decades[d] = (decades[d] || 0) + 1; } });
  var top = Object.keys(artists).map(function (a) { return { name: a, n: artists[a] }; }).sort(function (x, y) { return y.n - x.n; }).slice(0, 8);
  var topMax = top.length ? top[0].n : 1;
  var decKeys = Object.keys(decades).map(Number).sort(function (a, b) { return a - b; });
  var decMax = decKeys.reduce(function (m, k) { return Math.max(m, decades[k]); }, 1);
  var pct = TR.length ? Math.round(hires / TR.length * 100) : 0;
  var cards =
    statCard(TR.length, "tracks") + statCard(fmtLong(total), "total time") +
    statCard(pct + "%", "Hi-Res") + statCard(Object.keys(artists).length, "artists") +
    statCard(Object.keys(albums).length, "albums") + statCard(TR.length ? fmtClock(Math.round(total / TR.length)) : "0:00", "avg length");
  var html = '<div class="qz-pt-scroll"><div class="qz-pt-cards">' + cards + "</div>";
  html += '<div class="qz-pt-sec"><div class="qz-pt-h">Top artists</div>';
  if (top.length) top.forEach(function (a) { html += '<div class="qz-pt-bar"><div class="qz-pt-barlabel" title="' + esc(a.name) + '">' + esc(a.name) + '</div><div class="qz-pt-bartrack"><div class="qz-pt-barfill" style="width:' + (a.n / topMax * 100) + '%"></div></div><div class="qz-pt-barn">' + a.n + '</div></div>'; });
  else html += '<div class="qz-pt-dim">No artist data.</div>';
  html += "</div>";
  if (decKeys.length) {
    html += '<div class="qz-pt-sec"><div class="qz-pt-h">By decade</div><div class="qz-pt-decs">';
    decKeys.forEach(function (k) { var h = Math.round(decades[k] / decMax * 74) + 6; html += '<div class="qz-pt-dec"><div class="qz-pt-decbar" style="height:' + h + 'px" title="' + decades[k] + ' tracks"></div><div class="qz-pt-declbl">' + (k ? "'" + pad2(k % 100) : "?") + '</div></div>'; });
    html += '</div></div>';
  }
  if (explicit) html += '<div class="qz-pt-dim" style="margin-top:14px">' + explicit + ' explicit track' + (explicit > 1 ? "s" : "") + '.</div>';
  html += "</div>";
  setBody(html);
}
function statCard(v, l) { return '<div class="qz-pt-card"><div class="qz-pt-cardv">' + esc(String(v)) + '</div><div class="qz-pt-cardl">' + esc(l) + '</div></div>'; }

// --- Export ---
var EXPORT = { fmt: "text" };
function expText() { return TR.map(function (t) { return t.artist + " - " + t.title; }).join("\n"); }
function expM3U() { return "#EXTM3U\n" + TR.map(function (t) { return "#EXTINF:" + Math.round(t.dur) + "," + t.artist + " - " + t.title + "\nhttps://play.qobuz.com/track/" + t.id; }).join("\n"); }
function csvCell(s) { s = String(s == null ? "" : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function expCSV() { return "Title,Artist,Album,Duration,Year,ISRC,TrackID\n" + TR.map(function (t) { return [t.title, t.artist, t.album, fmtClock(t.dur), t.year || "", t.isrc, t.id].map(csvCell).join(","); }).join("\n"); }
function expJSON() { return JSON.stringify(TR.map(function (t) { return { title: t.title, artist: t.artist, album: t.album, durationSec: t.dur, year: t.year || null, isrc: t.isrc, id: t.id }; }), null, 2); }
function expBody() { return EXPORT.fmt === "m3u" ? expM3U() : EXPORT.fmt === "csv" ? expCSV() : EXPORT.fmt === "json" ? expJSON() : expText(); }
function expExtMime() { return EXPORT.fmt === "m3u" ? ["m3u8", "audio/x-mpegurl"] : EXPORT.fmt === "csv" ? ["csv", "text/csv"] : EXPORT.fmt === "json" ? ["json", "application/json"] : ["txt", "text/plain"]; }
function renderExport() {
  var html = '<div class="qz-pt-scroll"><div class="qz-pt-row" style="margin-bottom:12px">' +
    ['text:Text', 'm3u:M3U', 'csv:CSV', 'json:JSON'].map(function (f) { var p = f.split(":"); return '<button class="qz-pt-seg' + (EXPORT.fmt === p[0] ? " qz-pt-seg--on" : "") + '" data-fmt="' + p[0] + '">' + p[1] + '</button>'; }).join("") +
    '</div><textarea class="qz-pt-ta" readonly spellcheck="false"></textarea>' +
    '<div class="qz-pt-row" style="margin-top:12px"><button class="qz-pt-primary" data-act="copy">Copy to clipboard</button><button class="qz-pt-ghost" data-act="dl">Download</button><span class="qz-pt-dim" style="margin-left:auto;align-self:center">' + TR.length + ' tracks</span></div></div>';
  var b = setBody(html);
  var ta = b.querySelector(".qz-pt-ta");
  function refresh() { ta.value = expBody(); }
  refresh();
  b.querySelectorAll("[data-fmt]").forEach(function (s) { s.addEventListener("click", function () { EXPORT.fmt = s.getAttribute("data-fmt"); b.querySelectorAll("[data-fmt]").forEach(function (x) { x.classList.toggle("qz-pt-seg--on", x === s); }); refresh(); }); });
  b.querySelector('[data-act="copy"]').addEventListener("click", function () { copyText(expBody()).then(function () { toast("Copied " + TR.length + " tracks"); }, function () { toast("Copy failed"); }); });
  b.querySelector('[data-act="dl"]').addEventListener("click", function () { var em = expExtMime(); download(safeName(curName) + "." + em[0], expBody(), em[1]); toast("Downloaded " + safeName(curName) + "." + em[0]); });
}

// --- Duplicates ---
var DUP = { byId: true };
function findDups() {
  var seen = {}, dups = [];
  TR.forEach(function (t) { var k = DUP.byId ? ("#" + t.id) : (normStr(t.title) + "|" + normStr(t.artist)); if (!k || k === "|") return; if (seen[k]) dups.push(t); else seen[k] = 1; });
  return dups;
}
function renderDups() {
  var dups = findDups();
  var html = '<div class="qz-pt-scroll"><div class="qz-pt-row" style="margin-bottom:12px">' +
    '<button class="qz-pt-seg' + (DUP.byId ? " qz-pt-seg--on" : "") + '" data-mode="id">Exact track</button>' +
    '<button class="qz-pt-seg' + (!DUP.byId ? " qz-pt-seg--on" : "") + '" data-mode="ta">Same title + artist</button>' +
    '<span class="qz-pt-dim" style="margin-left:auto;align-self:center">' + (DUP.byId ? "same track ID" : "catches different masters") + '</span></div>';
  if (!dups.length) html += '<div class="qz-pt-empty">No duplicates found. 🎉</div>';
  else {
    html += '<div class="qz-pt-note">' + dups.length + ' duplicate ' + (dups.length > 1 ? "entries" : "entry") + ' (keeping the first of each). Removing edits this playlist.</div><div class="qz-pt-list">';
    dups.slice(0, 200).forEach(function (t) { html += '<div class="qz-pt-li"><div class="qz-pt-litxt"><div class="qz-pt-lit">' + esc(t.title) + '</div><div class="qz-pt-lis">' + esc(t.artist) + '</div></div></div>'; });
    html += '</div><div class="qz-pt-row" style="margin-top:14px"><button class="qz-pt-danger" data-act="rm">Remove ' + dups.length + ' duplicate' + (dups.length > 1 ? "s" : "") + '</button><span class="qz-pt-confirm"></span></div>';
  }
  html += "</div>";
  var b = setBody(html);
  b.querySelectorAll("[data-mode]").forEach(function (s) { s.addEventListener("click", function () { DUP.byId = s.getAttribute("data-mode") === "id"; renderDups(); }); });
  var rm = b.querySelector('[data-act="rm"]');
  if (rm) rm.addEventListener("click", function () {
    var host = b.querySelector(".qz-pt-confirm");
    host.innerHTML = 'Sure? <button class="qz-pt-danger qz-pt-sm" data-y>Yes, remove</button><button class="qz-pt-ghost qz-pt-sm" data-n>Cancel</button>';
    host.querySelector("[data-n]").addEventListener("click", function () { host.innerHTML = ""; });
    host.querySelector("[data-y]").addEventListener("click", function () {
      var ptids = dups.map(function (t) { return t.ptid; }).filter(Boolean);
      rm.disabled = true; host.textContent = "Removing…";
      deleteTracksBatched(curId, ptids).then(function () {
        toast("Removed " + ptids.length + " duplicate" + (ptids.length > 1 ? "s" : ""));
        return loadAll(curId).then(function (t) { TR = t; renderDups(); });
      }, function () { rm.disabled = false; host.textContent = "Failed - try again"; });
    });
  });
}

// --- Sort (non-destructive: builds a new playlist) ---
var SORTS = [
  { key: "title", label: "Title (A–Z)", cmp: function (a, b) { return normStr(a.title).localeCompare(normStr(b.title)); } },
  { key: "artist", label: "Artist (A–Z)", cmp: function (a, b) { return normStr(a.artist).localeCompare(normStr(b.artist)) || normStr(a.album).localeCompare(normStr(b.album)); } },
  { key: "album", label: "Album (A–Z)", cmp: function (a, b) { return normStr(a.album).localeCompare(normStr(b.album)); } },
  { key: "dur", label: "Duration (short → long)", cmp: function (a, b) { return a.dur - b.dur; } },
  { key: "durd", label: "Duration (long → short)", cmp: function (a, b) { return b.dur - a.dur; } },
  { key: "year", label: "Release year (new → old)", cmp: function (a, b) { return (b.year || 0) - (a.year || 0); } },
  { key: "yeara", label: "Release year (old → new)", cmp: function (a, b) { return (a.year || 9999) - (b.year || 9999); } },
  { key: "added", label: "Date added (newest first)", cmp: function (a, b) { return (b.added || 0) - (a.added || 0); } },
  { key: "addeda", label: "Date added (oldest first)", cmp: function (a, b) { return (a.added || 0) - (b.added || 0); } },
  { key: "shuffle", label: "Shuffle (random)", cmp: null }
];
function sortedIds(sortKey) {
  var arr = TR.slice(), s = SORTS.filter(function (x) { return x.key === sortKey; })[0];
  if (s && s.cmp) arr.sort(s.cmp);
  else for (var i = arr.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp; }
  return arr.map(function (t) { return t.id; });
}
function renderSort() {
  var html = '<div class="qz-pt-scroll"><div class="qz-pt-note">Builds a <b>new</b> sorted playlist and opens it. Your original stays exactly as it is.</div>' +
    '<div class="qz-pt-sortgrid">' + SORTS.map(function (s) { return '<button class="qz-pt-sortbtn" data-sort="' + s.key + '">' + esc(s.label) + '</button>'; }).join("") + '</div>' +
    '<div class="qz-pt-sortstatus qz-pt-dim"></div></div>';
  var b = setBody(html);
  b.querySelectorAll("[data-sort]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (b._busy) return; b._busy = true;
      b.querySelectorAll("[data-sort]").forEach(function (x) { x.disabled = true; });
      var status = b.querySelector(".qz-pt-sortstatus"); status.textContent = "Building sorted playlist…";
      var label = (SORTS.filter(function (x) { return x.key === btn.getAttribute("data-sort"); })[0] || {}).label || "sorted";
      var ids = sortedIds(btn.getAttribute("data-sort"));
      var newName = curName + " (sorted)";
      Q.api("playlist/create?name=" + encodeURIComponent(newName) + "&is_public=false&description=" + encodeURIComponent("Sorted by " + label + " - by Qobuzify")).then(function (c) {
        var npid = String(c.id);
        return addTracksBatched(npid, ids).then(function () { toast("Created “" + newName + "”"); closeModal(); Q.navigate("/playlist/" + npid); });
      }).catch(function () { status.textContent = "Failed - try again"; b._busy = false; b.querySelectorAll("[data-sort]").forEach(function (x) { x.disabled = false; }); });
    });
  });
}

// --- button injection ---
function injectBtn() {
  var id = pid();
  var ex = document.getElementById(BTN_ID);
  if (!id) { if (ex) ex.remove(); return; }
  if (ex) { if (ex.getAttribute("data-pid") === id && ex.parentNode) return; ex.remove(); }
  var actions = document.querySelector(".PageHeader__actions"); if (!actions) return;
  // gate on ownership (async) - only your own playlists get the button
  me().then(function (uid) {
    if (!uid) return;
    plMeta(id).then(function (m) {
      if (!m || m.ownerId !== uid) return;
      if (document.getElementById(BTN_ID) || pid() !== id) return;
      var host = document.querySelector(".PageHeader__actions"); if (!host) return;
      var b = document.createElement("button");
      b.id = BTN_ID; b.type = "button"; b.className = "qz-pt-btn"; b.title = "Playlist tools"; b.setAttribute("data-pid", id);
      b.innerHTML = TOOLS_ICON + "<span>Tools</span>";
      b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); openModal(id, m.name); });
      host.appendChild(b);
    });
  });
}

// --- styles ---
Q.css(CSS_ID, [
  // header button
  ".qz-pt-btn{display:inline-flex;align-items:center;gap:7px;height:40px;padding:0 16px;border:1px solid var(--qz-accent,#3DA8FE);border-radius:20px;background:transparent;color:var(--qz-accent,#3DA8FE);font:inherit;font-size:13.5px;font-weight:750;cursor:pointer;transition:all .15s;margin-left:4px;}",
  ".qz-pt-btn:hover{background:var(--qz-accent,#3DA8FE);color:#06090a;}",
  ".qz-pt-btn svg{width:18px;height:18px;}",
  // overlay + modal
  ".qz-pt-overlay{position:fixed;inset:0;z-index:2147483200;display:flex;align-items:center;justify-content:center;background:rgba(4,6,10,.62);backdrop-filter:blur(9px);-webkit-backdrop-filter:blur(9px);opacity:0;transition:opacity .18s;font-family:inherit;-webkit-app-region:no-drag;}",
  ".qz-pt-overlay.qz-pt-in{opacity:1;}",
  ".qz-pt-modal{width:min(720px,94vw);max-height:86vh;display:flex;flex-direction:column;color:#eef2f7;background:linear-gradient(180deg,#0e131c,#0a0e15);border:1px solid rgba(255,255,255,.09);border-radius:18px;box-shadow:0 30px 80px -20px rgba(0,0,0,.8);overflow:hidden;transform:translateY(8px) scale(.99);transition:transform .18s;}",
  ".qz-pt-in .qz-pt-modal{transform:none;}",
  ".qz-pt-head{display:flex;align-items:center;gap:12px;padding:18px 20px 14px;border-bottom:1px solid rgba(255,255,255,.06);}",
  ".qz-pt-headl{display:flex;align-items:center;gap:12px;min-width:0;flex:1;}",
  ".qz-pt-headl>svg{width:26px;height:26px;color:var(--qz-accent,#3DA8FE);flex:0 0 auto;}",
  ".qz-pt-kicker{font-size:11px;font-weight:750;letter-spacing:.7px;text-transform:uppercase;color:var(--qz-accent,#3DA8FE);}",
  ".qz-pt-title{font-size:19px;font-weight:800;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:520px;}",
  ".qz-pt-x{flex:0 0 auto;width:36px;height:36px;border:0;border-radius:50%;background:rgba(255,255,255,.06);color:#c7cfdb;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .14s;}",
  ".qz-pt-x:hover{background:rgba(255,255,255,.14);color:#fff;}.qz-pt-x svg{width:18px;height:18px;}",
  ".qz-pt-tabs{display:flex;gap:4px;padding:12px 18px 0;flex:0 0 auto;}",
  ".qz-pt-tab{appearance:none;border:0;background:transparent;color:#9aa3b2;font:inherit;font-size:13.5px;font-weight:700;padding:9px 16px;border-radius:9px 9px 0 0;cursor:pointer;transition:all .14s;border-bottom:2px solid transparent;}",
  ".qz-pt-tab:hover{color:#e7ecf3;}",
  ".qz-pt-tab--on{color:#fff;border-bottom-color:var(--qz-accent,#3DA8FE);}",
  ".qz-pt-body{flex:1 1 auto;overflow:hidden;display:flex;min-height:280px;}",
  ".qz-pt-scroll{flex:1;overflow:auto;padding:20px;}",
  ".qz-pt-loading,.qz-pt-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#8b94a3;font-size:15px;font-weight:600;padding:50px;}",
  ".qz-pt-spin{width:34px;height:34px;border-radius:50%;border:3px solid rgba(255,255,255,.16);border-top-color:var(--qz-accent,#3DA8FE);animation:qz-pt-spin .8s linear infinite;}",
  "@keyframes qz-pt-spin{to{transform:rotate(360deg)}}",
  // stat cards
  ".qz-pt-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;}",
  ".qz-pt-card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:14px 16px;}",
  ".qz-pt-cardv{font-size:24px;font-weight:850;color:#fff;letter-spacing:-.5px;}",
  ".qz-pt-cardl{font-size:12px;color:#8b94a3;margin-top:2px;}",
  ".qz-pt-sec{margin-top:22px;}",
  ".qz-pt-h{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:#aeb7c6;margin-bottom:12px;}",
  ".qz-pt-dim{color:#8b94a3;font-size:13px;}",
  // bars
  ".qz-pt-bar{display:flex;align-items:center;gap:12px;margin-bottom:9px;}",
  ".qz-pt-barlabel{width:150px;flex:0 0 auto;font-size:13px;color:#e7ecf3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".qz-pt-bartrack{flex:1;height:9px;background:rgba(255,255,255,.06);border-radius:6px;overflow:hidden;}",
  ".qz-pt-barfill{height:100%;background:linear-gradient(90deg,var(--qz-accent,#3DA8FE),rgba(61,168,254,.6));border-radius:6px;}",
  ".qz-pt-barn{width:30px;flex:0 0 auto;text-align:right;font-size:12.5px;color:#9aa3b2;font-weight:700;}",
  // decades
  ".qz-pt-decs{display:flex;align-items:flex-end;gap:8px;height:96px;}",
  ".qz-pt-dec{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:6px;}",
  ".qz-pt-decbar{width:100%;max-width:40px;background:linear-gradient(180deg,var(--qz-accent,#3DA8FE),rgba(61,168,254,.45));border-radius:5px 5px 0 0;}",
  ".qz-pt-declbl{font-size:11px;color:#8b94a3;font-weight:700;}",
  // export
  ".qz-pt-ta{width:100%;height:230px;resize:none;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.08);border-radius:12px;color:#cdd5e0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;padding:12px 14px;box-sizing:border-box;}",
  ".qz-pt-row{display:flex;gap:8px;flex-wrap:wrap;}",
  ".qz-pt-seg{appearance:none;border:1px solid rgba(255,255,255,.14);background:transparent;color:#cbd3df;font:inherit;font-size:12.5px;font-weight:700;padding:7px 15px;border-radius:20px;cursor:pointer;transition:all .14s;}",
  ".qz-pt-seg:hover{border-color:var(--qz-accent,#3DA8FE);color:#fff;}",
  ".qz-pt-seg--on{background:var(--qz-accent,#3DA8FE);border-color:var(--qz-accent,#3DA8FE);color:#06090a;}",
  ".qz-pt-primary{appearance:none;border:0;border-radius:22px;background:var(--qz-accent,#3DA8FE);color:#06090a;font:inherit;font-size:13.5px;font-weight:800;padding:10px 22px;cursor:pointer;transition:filter .12s,transform .12s;}",
  ".qz-pt-primary:hover{filter:brightness(1.07);transform:translateY(-1px);}",
  ".qz-pt-ghost{appearance:none;border:1px solid rgba(255,255,255,.16);border-radius:22px;background:transparent;color:#e7ecf3;font:inherit;font-size:13.5px;font-weight:700;padding:10px 20px;cursor:pointer;transition:all .12s;}",
  ".qz-pt-ghost:hover{background:rgba(255,255,255,.07);}",
  ".qz-pt-danger{appearance:none;border:1px solid #ff5c6c;border-radius:22px;background:rgba(255,92,108,.12);color:#ff8b96;font:inherit;font-size:13.5px;font-weight:800;padding:10px 20px;cursor:pointer;transition:all .12s;}",
  ".qz-pt-danger:hover{background:#ff5c6c;color:#0a0e15;}.qz-pt-danger:disabled{opacity:.5;cursor:default;}",
  ".qz-pt-sm{padding:7px 14px;font-size:12.5px;}",
  ".qz-pt-confirm{display:inline-flex;align-items:center;gap:8px;color:#c7cfdb;font-size:13px;font-weight:600;}",
  ".qz-pt-note{background:rgba(61,168,254,.09);border:1px solid rgba(61,168,254,.22);border-radius:11px;padding:11px 14px;font-size:13px;color:#c7d3e2;margin-bottom:14px;}",
  ".qz-pt-note b{color:#fff;}",
  // dup list
  ".qz-pt-list{display:flex;flex-direction:column;gap:2px;max-height:280px;overflow:auto;border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:6px;}",
  ".qz-pt-li{display:flex;align-items:center;gap:12px;padding:8px 10px;border-radius:8px;}",
  ".qz-pt-li:hover{background:rgba(255,255,255,.04);}",
  ".qz-pt-lit{font-size:13.5px;color:#e7ecf3;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".qz-pt-lis{font-size:12px;color:#8b94a3;}",
  ".qz-pt-litxt{min-width:0;}",
  // sort
  ".qz-pt-sortgrid{display:grid;grid-template-columns:1fr 1fr;gap:9px;}",
  ".qz-pt-sortbtn{appearance:none;text-align:left;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);color:#e7ecf3;font:inherit;font-size:13.5px;font-weight:650;padding:13px 16px;border-radius:11px;cursor:pointer;transition:all .14s;}",
  ".qz-pt-sortbtn:hover{border-color:var(--qz-accent,#3DA8FE);background:rgba(61,168,254,.1);}",
  ".qz-pt-sortbtn:disabled{opacity:.5;cursor:default;}",
  ".qz-pt-sortstatus{margin-top:14px;min-height:18px;}",
  // toast
  ".qz-pt-toast{position:absolute;left:50%;bottom:18px;transform:translate(-50%,20px);background:#06090d;border:1px solid var(--qz-accent,#3DA8FE);color:#fff;font-size:13px;font-weight:700;padding:9px 18px;border-radius:22px;opacity:0;pointer-events:none;transition:all .2s;box-shadow:0 10px 30px rgba(0,0,0,.5);}",
  ".qz-pt-toast--show{opacity:1;transform:translate(-50%,0);}"
].join(""));

// --- boot ---
var offRoute = Q.onRoute(function () { setTimeout(injectBtn, 350); });
var obs = Q.observe(function () { injectBtn(); }, { debounce: 300 });
injectBtn();
document.addEventListener("keydown", onKey, true);
function onKey(e) { if (e.key === "Escape" && modal && modal.classList.contains("qz-pt-in")) { e.stopPropagation(); closeModal(); } }

return function cleanup() {
  if (offRoute) offRoute();
  if (obs) obs();
  document.removeEventListener("keydown", onKey, true);
  var b = document.getElementById(BTN_ID); if (b) b.remove();
  if (modal) { modal.remove(); modal = null; }
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
