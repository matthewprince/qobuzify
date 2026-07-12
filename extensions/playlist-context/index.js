// Playlist Context - remembers where the current playback came from, so shuffling or playing a
// playlist no longer "forgets" it (an r/qobuz ask). A "Playing from <name>" chip in the player bar
// shows the source and the track's position; click it to jump to the playlist/album and highlight
// the current track, right-click it to remove that track from the playlist without disturbing what
// is playing. Runs as function(Qobuzify).
//
// The play queue lives in a sealed module we can't read the source of, so we work it out from the
// side: every playlist/album you open gets its track ids cached, and the chip shows whichever cached
// source the current track belongs to. That's how it survives shuffle (the shuffled tracks are still
// in the set) and how it still knows the source of a track that was already playing at launch. The
// cache is persisted, so a recently-used source is recognised again after a relaunch.
var Q = Qobuzify;
var CSS_ID = "qz-ctx-css";
var LS = "ctx:sources";
var MAX = 6; // how many recent sources to remember
var LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>';

function route() { try { return Q.getState().router.location.pathname || ""; } catch (e) { return ""; } }
function pageCtx(path) { var m = String(path == null ? route() : path).match(/\/(album|playlist)\/([^/?#]+)/); return m ? { kind: m[1], id: m[2] } : null; }
function curTrackId() { try { var ct = Q.getState().player.currentTrack; return ct && ct.id != null ? String(ct.id) : null; } catch (e) { return null; } }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

// --- source cache (LRU, front = most recently opened), persisted with its track ids ---
var sources = [];
try { sources = JSON.parse(Q.storage.get(LS, "[]")) || []; } catch (e) { sources = []; }
if (!Array.isArray(sources)) sources = [];
function persist() { try { Q.storage.set(LS, JSON.stringify(sources.slice(0, MAX))); } catch (e) {} }

function loadTrackIds(c) {
  if (c.kind === "album") return Q.api("album/get?album_id=" + c.id).then(function (j) { return ((j.tracks && j.tracks.items) || []).map(function (t) { return String(t.id); }); }).catch(function () { return []; });
  var all = [];
  function page(off) {
    return Q.api("playlist/get?playlist_id=" + c.id + "&extra=tracks&limit=500&offset=" + off).then(function (j) {
      var t = (j.tracks && j.tracks.items) || [];
      all = all.concat(t.map(function (x) { return String(x.id); }));
      var total = (j.tracks && j.tracks.total) || all.length;
      if (all.length < total && t.length && all.length < 3000) return page(all.length);
      return all;
    }).catch(function () { return all; });
  }
  return page(0);
}
function resolveName(c) {
  var p = c.kind === "album" ? "album/get?album_id=" + c.id + "&limit=0" : "playlist/get?playlist_id=" + c.id + "&limit=0";
  return Q.api(p).then(function (j) { return c.kind === "album" ? (j.title || "Album") : (j.name || "Playlist"); }).catch(function () { return c.kind === "album" ? "Album" : "Playlist"; });
}
function find(kind, id) { for (var i = 0; i < sources.length; i++) if (sources[i].kind === kind && sources[i].id === id) return sources[i]; return null; }
function promote(entry) { sources = [entry].concat(sources.filter(function (s) { return s !== entry; })).slice(0, MAX); }

// note a playlist/album the user opened: cache/refresh its ids + name, move it to the front
function touch(kind, id) {
  var e = find(kind, id);
  if (e) { promote(e); persist(); refresh(); }
  else { e = { kind: kind, id: id, name: kind === "album" ? "Album" : "Playlist", ids: null }; sources = [e].concat(sources).slice(0, MAX); persist(); resolveName(e).then(function (nm) { e.name = nm; persist(); refresh(); }); }
  loadTrackIds({ kind: kind, id: id }).then(function (ids) { if (ids && ids.length) { e.ids = ids; persist(); refresh(); } });
}
// the source the current track belongs to (most-recent wins if in several)
function currentSource() { var id = curTrackId(); if (!id) return null; for (var i = 0; i < sources.length; i++) { var s = sources[i]; if (s.ids && s.ids.indexOf(id) >= 0) return s; } return null; }

var context = null; // derived: the current track's source
function refresh() { context = currentSource(); renderChip(); }

// --- player-bar chip ---
var slot = null, chipEl = null;
function positionText() { var id = curTrackId(); if (!id || !context || !context.ids) return ""; var i = context.ids.indexOf(id); return i >= 0 ? (i + 1) + " of " + context.ids.length : ""; }
function renderChip() {
  if (!context) { if (slot) { slot.remove(); slot = null; chipEl = null; } return; }
  if (!chipEl) {
    chipEl = document.createElement("button");
    chipEl.className = "qz-ctx-chip";
    chipEl.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); jumpToSource(); });
    chipEl.addEventListener("contextmenu", function (e) { e.preventDefault(); e.stopPropagation(); openMenu(e); });
  }
  var pos = positionText();
  chipEl.title = "Playing from " + context.name + (pos ? " · track " + pos : "") + " (click to jump, right-click for options)";
  chipEl.innerHTML = LIST + '<span class="qz-ctx-txt"><span class="qz-ctx-name">' + esc(context.name) + '</span>' + (pos ? '<span class="qz-ctx-pos">' + pos + '</span>' : '') + '</span>';
  if (!slot) slot = Q.playerSlot({ id: "playlist-context", zone: "left", order: 4, el: chipEl });
}

// --- jump to the source + find/scroll to the current track, then flash it ---
// The playing row carries an .isPlaying class - that's the target. Playlist track lists are
// ReactVirtualized, so a row scrolled off-screen isn't in the DOM until we scroll near it; hence the
// poll that nudges the scroll container toward the track's index until the row renders.
function playingRow() {
  var r = document.querySelector(".ListItem.isPlaying");
  if (r) return r;
  var title = (Q.player.getTrack() || {}).title; if (!title) return null; // fallback: match the title anchor
  var rows = document.querySelectorAll(".ListItem");
  for (var i = 0; i < rows.length; i++) { var a = rows[i].querySelector(".ListItem__title"); if (a && a.textContent.trim() === title) return rows[i]; }
  return null;
}
function scrollParent(el) {
  for (var n = el && el.parentElement; n && n !== document.body; n = n.parentElement) {
    var oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 4) return n;
  }
  return null;
}
function jumpToSource() {
  if (!context) return;
  var idx = (context.ids || []).indexOf(curTrackId());
  Q.navigate("/" + context.kind + "/" + context.id);
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    if (route().indexOf(context.id) < 0) { if (tries > 60) clearInterval(iv); return; }
    var row = playingRow();
    if (row) { flash(row); try { row.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {} clearInterval(iv); return; }
    // not rendered yet (virtualized + off-screen): scroll toward the track's index so it renders
    var sample = document.querySelector(".ListItem"), sc = sample ? scrollParent(sample) : null;
    if (sc && sample && idx >= 0) { var rowH = sample.getBoundingClientRect().height || 56; sc.scrollTop = Math.max(0, idx * rowH - sc.clientHeight / 2 + rowH / 2); }
    if (tries > 60) clearInterval(iv);
  }, 120);
}
function flash(el) { el.classList.add("qz-ctx-flash"); setTimeout(function () { el.classList.remove("qz-ctx-flash"); }, 2200); }

// --- right-click menu ---
function closeMenu() { var m = document.getElementById("qz-ctx-menu"); if (m) m.remove(); document.removeEventListener("mousedown", menuOutside, true); }
function menuOutside(ev) { var m = document.getElementById("qz-ctx-menu"); if (m && !m.contains(ev.target)) closeMenu(); }
function openMenu(e) {
  closeMenu();
  var m = document.createElement("div"); m.className = "qz-ctx-menu"; m.id = "qz-ctx-menu";
  var canRemove = context.kind === "playlist";
  m.innerHTML = '<div class="qz-ctx-mi" data-act="go">Go to ' + esc(context.name) + '</div>' + (canRemove ? '<div class="qz-ctx-mi qz-ctx-mi--danger" data-act="remove">Remove this track from the playlist</div>' : '');
  document.body.appendChild(m);
  m.style.left = Math.min(e.clientX, window.innerWidth - 260) + "px";
  m.style.top = Math.min(e.clientY, window.innerHeight - 96) + "px";
  m.querySelector('[data-act="go"]').addEventListener("click", function () { closeMenu(); jumpToSource(); });
  var rm = m.querySelector('[data-act="remove"]'); if (rm) rm.addEventListener("click", function () { closeMenu(); removeCurrentFromPlaylist(); });
  setTimeout(function () { document.addEventListener("mousedown", menuOutside, true); }, 0);
}
function removeCurrentFromPlaylist() {
  if (!context || context.kind !== "playlist") return;
  var id = curTrackId(); if (!id) { toast("Nothing is playing", true); return; }
  var pid = context.id;
  Q.api("playlist/get?playlist_id=" + pid + "&extra=tracks&limit=500").then(function (j) {
    var items = (j.tracks && j.tracks.items) || [], match = null;
    for (var i = 0; i < items.length; i++) { if (String(items[i].id) === id) { match = items[i]; break; } }
    var ptid = match && (match.playlist_track_id || match.playlistTrackId);
    if (!ptid) { toast("Couldn't find that track in the playlist", true); return; }
    return Q.api("playlist/deleteTracks?playlist_id=" + pid + "&playlist_track_ids=" + ptid).then(function () {
      var e = find("playlist", pid); if (e && e.ids) e.ids = e.ids.filter(function (t) { return t !== id; });
      persist(); toast("Removed from " + context.name); refresh();
    });
  }).catch(function () { toast("Remove failed - try again", true); });
}

// --- toast ---
var toastT = null;
function toast(msg, bad) {
  var t = document.getElementById("qz-ctx-toast");
  if (!t) { t = document.createElement("div"); t.id = "qz-ctx-toast"; document.body.appendChild(t); }
  t.textContent = msg; t.className = bad ? "qz-bad" : ""; t.classList.add("qz-show");
  clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove("qz-show"); }, 2600);
}

Q.css(CSS_ID, [
  ".qz-ctx-chip{display:inline-flex;align-items:center;gap:7px;max-width:200px;height:32px;padding:0 11px;border-radius:18px;",
    "border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:#c2cad6;font:inherit;font-size:12px;cursor:pointer;transition:all .14s;flex:0 0 auto;}",
  ".qz-ctx-chip:hover{border-color:var(--qz-accent,#3DA8FE);color:#fff;background:color-mix(in srgb,var(--qz-accent,#3DA8FE) 12%,transparent);}",
  ".qz-ctx-chip svg{width:15px;height:15px;flex:0 0 auto;color:var(--qz-accent,#3DA8FE);}",
  ".qz-ctx-txt{display:flex;flex-direction:column;min-width:0;line-height:1.15;text-align:left;}",
  ".qz-ctx-name{font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;}",
  ".qz-ctx-pos{font-size:10px;color:#8b94a3;}",
  ".qz-ctx-menu{position:fixed;z-index:2147483600;min-width:220px;padding:6px;background:linear-gradient(180deg,#0e131c,#0a0e15);",
    "border:1px solid rgba(255,255,255,.12);border-radius:12px;box-shadow:0 24px 60px -16px rgba(0,0,0,.8);color:#eef2f7;font-size:13px;}",
  ".qz-ctx-mi{padding:9px 11px;border-radius:8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".qz-ctx-mi:hover{background:rgba(255,255,255,.06);}",
  ".qz-ctx-mi--danger{color:#ff6b78;}",
  ".qz-ctx-mi--danger:hover{background:rgba(255,90,100,.12);}",
  ".qz-ctx-flash{animation:qz-ctx-flash 2.2s ease;}",
  "@keyframes qz-ctx-flash{0%,100%{background:transparent;}18%{background:color-mix(in srgb,var(--qz-accent,#3DA8FE) 30%,transparent);}}",
  "#qz-ctx-toast{position:fixed;left:50%;bottom:96px;transform:translate(-50%,14px);z-index:2147483500;background:#06090d;",
    "border:1px solid var(--qz-accent,#3DA8FE);color:#fff;font-size:13px;font-weight:650;padding:10px 18px;border-radius:22px;opacity:0;pointer-events:none;transition:all .22s;box-shadow:0 12px 34px rgba(0,0,0,.55);}",
  "#qz-ctx-toast.qz-show{opacity:1;transform:translate(-50%,0);}",
  "#qz-ctx-toast.qz-bad{border-color:#ff5c6c;}"
].join(""));

// --- boot ---
sources.forEach(function (s) { if (!s.ids || !s.ids.length) loadTrackIds({ kind: s.kind, id: s.id }).then(function (ids) { if (ids && ids.length) { s.ids = ids; persist(); refresh(); } }); });
var pc = pageCtx(); if (pc) touch(pc.kind, pc.id);
refresh();
var offChange = Q.player.onChange(refresh);
var offRoute = Q.onRoute(function (path) { closeMenu(); var m = pageCtx(path); if (m) touch(m.kind, m.id); });

return function cleanup() {
  if (offChange) offChange();
  if (offRoute) offRoute();
  closeMenu();
  if (slot) slot.remove();
  var t = document.getElementById("qz-ctx-toast"); if (t) t.remove();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
