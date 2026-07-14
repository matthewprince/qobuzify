// Desktop multi-select on track lists (r/qobuz ZariantheMighty32). Shift-click a range, Ctrl/Cmd-click
// to toggle one, on any .ListItem track row (album / playlist / favorites / search tables). Selected rows
// get an accent tint; a floating action bar appears while >=1 is selected with Play, Queue, Playlist and
// Favourite. Selection clears on route change and Esc. Runs as function(Qobuzify){ ... return cleanup }.
//
// How the pieces map to the sealed app:
//  - Per-row track id: every .ListItem gets id="<trackId>[_<playlistTrackId>]__actions" (the app builds it
//    from the row's identity via trackIdentityToString, which joins identity values with "_"). We parse the
//    leading digits off row.id - no fragile title matching.
//  - Favourite / Add-to-playlist: the write-GET API, same as the bulk-actions extension
//    (favorite/create?type=tracks&track_ids= batched, playlist/create, playlist/addTracks, getUserPlaylists).
//  - Play: the player is sealed and there is no "play these N tracks" call, so we do what Shuffle-and-play
//    and Smart Radio do - build a throwaway playlist through the write API, navigate to it, and click its
//    header Play button (see docs/player-control.md). One temp playlist is kept and rotated.
//  - Queue: appending to the play queue mirrors the app's own remove-from-queue - a partial "playqueue/set"
//    merge over state.playqueue.items (+ shuffledItems). The runtime's dropUpcoming proves the engine honours
//    this slice for upcoming tracks. New entries clone the current item's contextUuid and get fresh unique
//    queueItemIds ("q<n>", matching QueueItemIdGenerator). Best-effort: if nothing is playing (no active
//    queue) there is nothing to append to, so we fall back to Play.
var Q = Qobuzify;
var CSS_ID = "qz-ms-css";
var BAR_ID = "qz-ms-bar";
var TOAST_ID = "qz-ms-toast";
var TMP_KEY = "ms:tmp"; // storage key: the rotating throwaway "Play" playlist id

var PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
var QUEUE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h11M4 12h11M4 18h7M18 15v6M15 18h6"/></svg>';
var PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
var HEART = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.3S3.6 14.9 3.6 8.9C3.6 6.3 5.7 4.3 8.2 4.3C9.9 4.3 11.3 5.2 12 6.6C12.7 5.2 14.1 4.3 15.8 4.3C18.3 4.3 20.4 6.3 20.4 8.9C20.4 14.9 12 20.3 12 20.3Z"/></svg>';

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
function chunk(a, n) { var o = []; for (var i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
function route() { try { return Q.getState().router.location.pathname || ""; } catch (e) { return ""; } }
function coerceId(id) { return /^\d+$/.test(id) ? Number(id) : id; }

// ---- selection state (map of trackId -> true; anchor = last non-range clicked row) ----
var sel = {};
var anchor = null;
function selIds() { return Object.keys(sel); }
function count() { return selIds().length; }

// A track row's id is "<trackId>[_<playlistTrackId>]__actions". Parse the leading digits.
function rowTrackId(row) {
  var id = row && row.id ? String(row.id) : "";
  if (!/__actions$/.test(id)) return null;
  var m = id.match(/^(\d+)_/);
  return m ? m[1] : null;
}
// selectable rows in document order, each { el, id }
function selectableRows() {
  var out = [], rows = document.querySelectorAll(".ListItem");
  for (var i = 0; i < rows.length; i++) { var id = rowTrackId(rows[i]); if (id) out.push({ el: rows[i], id: id }); }
  return out;
}

// ---- Qobuz write API (same shape as the bulk-actions extension) ----
var meId = null;
function me() { if (meId != null) return Promise.resolve(meId); return Q.api("user/get").then(function (u) { meId = (u && (u.id || (u.user && u.user.id))) || 0; return meId; }).catch(function () { meId = 0; return 0; }); }
function favAll(ids) { return chunk(ids, 50).reduce(function (p, c) { return p.then(function () { return Q.api("favorite/create?type=tracks&track_ids=" + c.join(",")); }); }, Promise.resolve()); }
function addTracks(pid, ids) { return chunk(ids, 50).reduce(function (p, c) { return p.then(function () { return Q.api("playlist/addTracks?playlist_id=" + pid + "&track_ids=" + c.join(",")); }); }, Promise.resolve()); }
function userPlaylists() { return Q.api("playlist/getUserPlaylists?limit=200").then(function (j) { return (j.playlists && j.playlists.items) || []; }).catch(function () { return []; }); }
function createPlaylist(name) { return Q.api("playlist/create?name=" + encodeURIComponent(name) + "&is_public=false").then(function (c) { return String(c.id); }); }

// ---- toast ----
var toastT = null;
function toast(msg, bad) {
  var t = document.getElementById(TOAST_ID);
  if (!t) { t = document.createElement("div"); t.id = TOAST_ID; document.body.appendChild(t); }
  t.textContent = msg; t.className = bad ? "qz-bad" : ""; t.classList.add("qz-show");
  clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove("qz-show"); }, 2400);
}

// ---- play a specific entity: navigate, then click the VISIBLE header Play (docs/player-control.md) ----
function headerPlayBtn() {
  var cands = document.querySelectorAll("[class*='PageHeader'] button[aria-label='Play'], .PageHeader .ButtonRoundPrimary");
  for (var i = 0; i < cands.length; i++) { var r = cands[i].getBoundingClientRect(); if (cands[i].offsetParent && r.width > 4 && r.height > 4) return cands[i]; }
  return null;
}
function playEntity(path) {
  Q.navigate(path);
  var tries = 0;
  var iv = setInterval(function () {
    var onPage = route().indexOf(path.replace(/^\//, "")) >= 0;
    var btn = headerPlayBtn();
    if (onPage && btn) { btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); clearInterval(iv); }
    else if (++tries > 45) clearInterval(iv);
  }, 150);
}

// ---- actions ----
function doPlay() {
  var ids = selIds(); if (!ids.length) return;
  toast("Starting playback…");
  var name = "Selection · " + ids.length + " track" + (ids.length > 1 ? "s" : ""); // plain prefix - an emoji makes Qobuz save an empty name
  createPlaylist(name).then(function (pid) {
    return addTracks(pid, ids).then(function () {
      var old = Q.storage.get(TMP_KEY, null); Q.storage.set(TMP_KEY, pid);
      // keep exactly one throwaway playlist: delete the previous one shortly after (never the one now playing)
      if (old && old !== pid) setTimeout(function () { Q.api("playlist/delete?playlist_id=" + old).catch(function () {}); }, 8000);
      clearSel();
      playEntity("/playlist/" + pid);
    });
  }).catch(function () { toast("Couldn't start playback - try again", true); });
}

// Best-effort append to the sealed play queue via the same partial "playqueue/set" merge the app's own
// remove-from-queue uses. Only ever appends AFTER the current index; never touches the playing track.
function addToQueueStore(ids) {
  try {
    if (!Q.store || typeof Q.store.dispatch !== "function") return false;
    var pq = Q.getState().playqueue;
    if (!pq || !Array.isArray(pq.items) || !pq.items.length) return false; // nothing playing -> nothing to queue onto
    var ci = pq.currentIndex || 0;
    var tmpl = pq.items[ci] || pq.items[0] || {};
    var ctxUuid = tmpl.contextUuid;
    var maxN = 0;
    function scanMax(arr) { (arr || []).forEach(function (it) { if (it && typeof it.queueItemId === "string") { var n = Number(it.queueItemId.slice(1)); if (!isNaN(n) && n > maxN) maxN = n; } }); }
    scanMax(pq.items); scanMax(pq.shuffledItems);
    var newItems = ids.map(function (id) { maxN += 1; return { trackId: coerceId(id), queueItemId: "q" + maxN, cloudItemId: null, contextUuid: ctxUuid }; });
    var payload = { index: ci, dirty: true };
    payload.items = pq.items.concat(newItems);
    // in shuffle mode the play order is shuffledItems (currentIndex indexes into it) - the same entries must be
    // present there too, or they'd never be reached. Append them to the tail of the shuffled order.
    if (pq.shuffled && Array.isArray(pq.shuffledItems) && pq.shuffledItems.length) payload.shuffledItems = pq.shuffledItems.concat(newItems);
    Q.store.dispatch({ type: "playqueue/set", payload: payload });
    return true;
  } catch (e) { return false; }
}
function doQueue() {
  var ids = selIds(); if (!ids.length) return;
  if (addToQueueStore(ids)) toast("Added " + ids.length + " to the queue");
  else { toast("Nothing playing - starting these instead"); doPlay(); }
}

function doFav(btn) {
  var ids = selIds(); if (!ids.length) return;
  if (btn) { if (btn.classList.contains("qz-ms-busy")) return; btn.classList.add("qz-ms-busy"); }
  favAll(ids).then(function () { toast("Favourited " + ids.length + " track" + (ids.length > 1 ? "s" : "")); })
    .catch(function () { toast("Failed - try again", true); })
    .then(function () { if (btn) btn.classList.remove("qz-ms-busy"); });
}

// ---- add-to-playlist picker (adapted from bulk-actions; operates on the selected ids) ----
function closePicker() { var p = document.getElementById("qz-ms-pop"); if (p) p.remove(); document.removeEventListener("mousedown", pickerOutside, true); }
function pickerOutside(e) { var p = document.getElementById("qz-ms-pop"); if (p && !p.contains(e.target) && !(e.target.closest && e.target.closest("#qz-ms-add"))) closePicker(); }
function openPicker(anchorEl) {
  if (document.getElementById("qz-ms-pop")) { closePicker(); return; }
  if (!count()) return;
  var pop = document.createElement("div"); pop.id = "qz-ms-pop"; pop.className = "qz-ms-pop";
  pop.innerHTML = '<div class="qz-ms-poptitle">Add selected to…</div><div class="qz-ms-new"><input class="qz-ms-newinput" placeholder="New playlist name…" maxlength="80"><button class="qz-ms-newbtn">Create</button></div><div class="qz-ms-list"><div class="qz-ms-loading">Loading playlists…</div></div>';
  document.body.appendChild(pop);
  var r = anchorEl.getBoundingClientRect();
  pop.style.left = Math.round(Math.min(r.left, window.innerWidth - 320)) + "px";
  pop.style.bottom = Math.round(window.innerHeight - r.top + 8) + "px"; // open upward from the bar
  setTimeout(function () { document.addEventListener("mousedown", pickerOutside, true); }, 0);
  var input = pop.querySelector(".qz-ms-newinput");
  function doCreate() { var nm = (input.value || "").trim(); if (!nm) { input.focus(); return; } run(null, nm); }
  pop.querySelector(".qz-ms-newbtn").addEventListener("click", doCreate);
  input.addEventListener("keydown", function (e) { if (e.key === "Enter") doCreate(); else if (e.key === "Escape") { e.stopPropagation(); closePicker(); } });
  function run(targetPid, newName) {
    var ids = selIds();
    closePicker();
    if (!ids.length) return;
    toast("Adding tracks…");
    var mk = newName ? createPlaylist(newName) : Promise.resolve(targetPid);
    mk.then(function (pid) { return addTracks(pid, ids).then(function () { toast("Added " + ids.length + " track" + (ids.length > 1 ? "s" : "") + (newName ? " to “" + newName + "”" : "")); }); })
      .catch(function () { toast("Failed - try again", true); });
  }
  userPlaylists().then(function (pls) {
    return me().then(function (uid) {
      var mine = pls.filter(function (p) { return !uid || (p.owner && p.owner.id === uid); });
      var list = pop.querySelector(".qz-ms-list");
      if (!list) return;
      if (!mine.length) { list.innerHTML = '<div class="qz-ms-loading">No playlists yet - create one above.</div>'; return; }
      list.innerHTML = "";
      mine.forEach(function (p) {
        var row = document.createElement("div"); row.className = "qz-ms-item";
        row.innerHTML = '<span class="qz-ms-itemname">' + esc(p.name) + '</span><span class="qz-ms-itemn">' + (p.tracks_count || 0) + '</span>';
        row.addEventListener("click", function () { run(String(p.id), null); });
        list.appendChild(row);
      });
    });
  }).catch(function () {});
}

// ---- floating action bar ----
function removeBar() { var b = document.getElementById(BAR_ID); if (b) b.remove(); }
function renderBar() {
  var n = count();
  if (!n) { removeBar(); closePicker(); return; }
  var bar = document.getElementById(BAR_ID);
  if (!bar) {
    bar = document.createElement("div"); bar.id = BAR_ID;
    bar.innerHTML =
      '<span class="qz-ms-count"></span>' +
      '<span class="qz-ms-sep"></span>' +
      '<button class="qz-ms-btn qz-ms-btn--accent" id="qz-ms-play" title="Play the selected tracks">' + PLAY + '<span>Play</span></button>' +
      '<button class="qz-ms-btn" id="qz-ms-queue" title="Add the selected tracks to the queue">' + QUEUE + '<span>Queue</span></button>' +
      '<button class="qz-ms-btn" id="qz-ms-add" title="Add the selected tracks to a playlist">' + PLUS + '<span>Playlist</span></button>' +
      '<button class="qz-ms-btn qz-ms-fav" id="qz-ms-fav" title="Favourite the selected tracks">' + HEART + '<span>Favourite</span></button>' +
      '<button class="qz-ms-clear" id="qz-ms-clear" title="Clear selection (Esc)">&#215;</button>';
    document.body.appendChild(bar);
    bar.querySelector("#qz-ms-play").addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); doPlay(); });
    bar.querySelector("#qz-ms-queue").addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); doQueue(); });
    bar.querySelector("#qz-ms-add").addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); openPicker(this); });
    bar.querySelector("#qz-ms-fav").addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); doFav(this); });
    bar.querySelector("#qz-ms-clear").addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); clearSel(); });
  }
  bar.querySelector(".qz-ms-count").textContent = n + " selected";
}

// ---- paint selected rows (idempotent; re-applied as virtualised rows recycle) ----
function paint() {
  var rows = document.querySelectorAll(".ListItem");
  for (var i = 0; i < rows.length; i++) {
    var id = rowTrackId(rows[i]);
    var on = !!(id && sel[id]);
    if (rows[i].classList.contains("qz-ms-sel") !== on) rows[i].classList.toggle("qz-ms-sel", on);
  }
}
function afterSelChange() { paint(); renderBar(); }
function clearSel() { sel = {}; anchor = null; closePicker(); removeBar(); [].slice.call(document.querySelectorAll(".qz-ms-sel")).forEach(function (n) { n.classList.remove("qz-ms-sel"); }); }

// ---- interaction: modifier-clicks on rows drive selection (capture phase, so we beat the app's row handler) ----
function onDocClick(e) {
  if (!(e.shiftKey || e.ctrlKey || e.metaKey)) return; // plain clicks pass through untouched (normal play/navigate)
  var el = e.target; if (el && el.nodeType === 3) el = el.parentElement;
  var row = el && el.closest ? el.closest(".ListItem") : null; if (!row) return;
  var id = rowTrackId(row); if (!id) return;
  // this is a selection gesture - stop the app from playing/navigating on the same click
  e.preventDefault(); e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  if (e.shiftKey && anchor) {
    var rows = selectableRows(), ai = -1, ti = -1;
    for (var i = 0; i < rows.length; i++) { if (rows[i].id === anchor) ai = i; if (rows[i].id === id) ti = i; }
    if (ai >= 0 && ti >= 0) { var lo = Math.min(ai, ti), hi = Math.max(ai, ti); for (var j = lo; j <= hi; j++) sel[rows[j].id] = true; }
    else { sel[id] = true; anchor = id; } // anchor scrolled out of the virtualised list - just add the target
  } else if (e.ctrlKey || e.metaKey) {
    if (sel[id]) delete sel[id]; else sel[id] = true;
    anchor = id;
  } else { // shift with no anchor yet
    sel[id] = true; anchor = id;
  }
  afterSelChange();
}
function onKey(e) { if (e.key === "Escape" && count()) { e.stopPropagation(); clearSel(); } }

// ---- styles ----
Q.css(CSS_ID, [
  // selected row: accent tint + an inset accent bar down the left edge (dark, never white)
  ".ListItem.qz-ms-sel{background:color-mix(in srgb,var(--qz-accent,#3DA8FE) 15%,transparent)!important;box-shadow:inset 3px 0 0 var(--qz-accent,#3DA8FE);}",
  // floating action bar (above content + player, below the picker/toast; parked above the transport)
  "#qz-ms-bar{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2147483200;display:flex;align-items:center;gap:9px;padding:9px 12px;border-radius:16px;background:linear-gradient(180deg,#121722,#0b0f16);border:1px solid rgba(255,255,255,.12);box-shadow:0 20px 60px -12px rgba(0,0,0,.75);color:#e7ecf3;font-family:inherit;-webkit-app-region:no-drag;}",
  "#qz-ms-bar .qz-ms-count{font-size:12.5px;font-weight:800;color:#aeb7c4;padding:0 2px 0 6px;white-space:nowrap;}",
  "#qz-ms-bar .qz-ms-sep{width:1px;height:22px;background:rgba(255,255,255,.12);flex:0 0 auto;}",
  "#qz-ms-bar .qz-ms-btn{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 13px;border:1px solid rgba(255,255,255,.16);border-radius:18px;background:transparent;color:#e7ecf3;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;transition:all .14s;}",
  "#qz-ms-bar .qz-ms-btn:hover{border-color:var(--qz-accent,#3DA8FE);color:#fff;background:rgba(61,168,254,.12);}",
  "#qz-ms-bar .qz-ms-btn svg{width:16px;height:16px;flex:0 0 auto;}",
  "#qz-ms-bar .qz-ms-btn--accent{border-color:var(--qz-accent,#3DA8FE);color:var(--qz-accent,#3DA8FE);}",
  "#qz-ms-bar .qz-ms-btn--accent:hover{background:var(--qz-accent,#3DA8FE);color:#06090a;}",
  "#qz-ms-bar .qz-ms-fav:hover svg{color:#ff5c6c;}",
  "#qz-ms-bar .qz-ms-btn.qz-ms-busy{opacity:.55;cursor:default;}",
  "#qz-ms-bar .qz-ms-clear{appearance:none;border:0;background:transparent;color:#8b94a3;font-size:20px;line-height:1;cursor:pointer;padding:0 4px 0 2px;}",
  "#qz-ms-bar .qz-ms-clear:hover{color:#fff;}",
  // add-to-playlist picker popover (opens upward from the bar)
  ".qz-ms-pop{position:fixed;z-index:2147483400;width:300px;max-height:56vh;display:flex;flex-direction:column;background:linear-gradient(180deg,#0e131c,#0a0e15);border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 24px 60px -16px rgba(0,0,0,.8);overflow:hidden;color:#eef2f7;font-family:inherit;-webkit-app-region:no-drag;}",
  ".qz-ms-poptitle{font-size:12px;font-weight:750;letter-spacing:.4px;text-transform:uppercase;color:#8b94a3;padding:13px 15px 9px;}",
  ".qz-ms-new{display:flex;gap:7px;padding:0 12px 11px;border-bottom:1px solid rgba(255,255,255,.07);}",
  ".qz-ms-newinput{flex:1;min-width:0;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.12);border-radius:9px;color:#e7ecf3;font:inherit;font-size:13px;padding:8px 10px;}",
  ".qz-ms-newinput:focus{outline:none;border-color:var(--qz-accent,#3DA8FE);}",
  ".qz-ms-newbtn{flex:0 0 auto;border:0;border-radius:9px;background:var(--qz-accent,#3DA8FE);color:#06090a;font:inherit;font-size:12.5px;font-weight:800;padding:0 14px;cursor:pointer;}",
  ".qz-ms-newbtn:hover{filter:brightness(1.08);}",
  ".qz-ms-list{overflow:auto;padding:6px;}",
  ".qz-ms-loading{padding:16px 12px;color:#8b94a3;font-size:13px;text-align:center;}",
  ".qz-ms-item{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:9px;cursor:pointer;transition:background .12s;}",
  ".qz-ms-item:hover{background:rgba(255,255,255,.06);}",
  ".qz-ms-itemname{flex:1;min-width:0;font-size:13.5px;font-weight:600;color:#e7ecf3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".qz-ms-itemn{flex:0 0 auto;font-size:11.5px;color:#8b94a3;}",
  // toast
  "#qz-ms-toast{position:fixed;left:50%;bottom:150px;transform:translate(-50%,14px);z-index:2147483500;background:#06090d;border:1px solid var(--qz-accent,#3DA8FE);color:#fff;font-size:13px;font-weight:700;padding:10px 20px;border-radius:22px;opacity:0;pointer-events:none;transition:all .22s;box-shadow:0 12px 34px rgba(0,0,0,.55);}",
  "#qz-ms-toast.qz-show{opacity:1;transform:translate(-50%,0);}",
  "#qz-ms-toast.qz-bad{border-color:#ff5c6c;}"
].join(""));

// ---- boot ----
document.addEventListener("click", onDocClick, true);
document.addEventListener("keydown", onKey, true);
var obs = Q.observe(paint, { debounce: 150 });
var offRoute = Q.onRoute(function () { clearSel(); });

return function cleanup() {
  document.removeEventListener("click", onDocClick, true);
  document.removeEventListener("keydown", onKey, true);
  if (obs) obs();
  if (offRoute) offRoute();
  closePicker();
  removeBar();
  [].slice.call(document.querySelectorAll(".qz-ms-sel")).forEach(function (n) { n.classList.remove("qz-ms-sel"); });
  var t = document.getElementById(TOAST_ID); if (t) t.remove();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
