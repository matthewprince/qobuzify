// "Favourite all" and "Add all to a playlist" from any album or playlist header, plus a
// shuffle-and-play button. These are r/qobuz gripes #5 ("can't favourite multiple songs at once")
// and #8 ("no easy way to copy songs between playlists"). Runs as function(Qobuzify).
//
// It's all done through the playlist/favorite write API, which is GET, via Q.api:
// favorite/create?type=tracks&track_ids= (and it does accept a batch), playlist/addTracks,
// playlist/create, playlist/getUserPlaylists. The buttons inject into .PageHeader__actions on the
// /album/ and /playlist/ pages.
//
// Shuffle is a FULL shuffle (issue #12): the native enqueue only takes the lazily-loaded head of a
// playlist (~100 tracks), so for big sources we start playback natively from a small temp-playlist
// head, then swap the entire shuffled remainder into the play queue store-side (see setUpcoming).
// A Shuffle-only variant also appears on /user-library (whole-favorites shuffle).
var Q = Qobuzify;
var CSS_ID = "qz-ba-css";
var WRAP_ID = "qz-ba-wrap";
var HEART = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.3S3.6 14.9 3.6 8.9C3.6 6.3 5.7 4.3 8.2 4.3C9.9 4.3 11.3 5.2 12 6.6C12.7 5.2 14.1 4.3 15.8 4.3C18.3 4.3 20.4 6.3 20.4 8.9C20.4 14.9 12 20.3 12 20.3Z"/></svg>';
var PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
var SHUF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>';

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
function chunk(a, n) { var o = []; for (var i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
function route() { try { return Q.getState().router.location.pathname || ""; } catch (e) { return ""; } }
function coerceId(id) { return /^\d+$/.test(id) ? Number(id) : id; }
function ctx() {
  var p = route();
  var m = p.match(/\/(album|playlist)\/([^/?#]+)/); if (m) return { kind: m[1], id: m[2] };
  if (/^\/user-library(\/(tracks|all))?$/.test(p)) return { kind: "library", id: "tracks" };
  return null;
}

var meId = null;
function me() { if (meId != null) return Promise.resolve(meId); return Q.api("user/get").then(function (u) { meId = (u && (u.id || (u.user && u.user.id))) || 0; return meId; }).catch(function () { meId = 0; return 0; }); }

function loadTrackIds(c) {
  if (c.kind === "album") return Q.api("album/get?album_id=" + c.id).then(function (j) { return ((j.tracks && j.tracks.items) || []).map(function (t) { return t.id; }).filter(Boolean); });
  if (c.kind === "library") {
    // whole favorites library. Prefer library-load's warm set (bound lazily at click time: extensions
    // load alphabetically, so Q.library doesn't exist yet when we boot), else the one-request id call.
    if (Q.library && Q.library.idsReady && Q.library.idsReady()) return Promise.resolve(Q.library.ids("tracks"));
    return Q.api("favorite/getUserFavoriteIds").then(function (j) {
      // node shapes vary: [id,..] | [{id},..] | {items:[..]} - same tolerant parse as library-load
      var node = (j && j.tracks) || null;
      var arr = (node && (node.items || node)) || [];
      return [].map.call(arr, function (x) { return x && x.id != null ? x.id : x; }).filter(function (x) { return x != null; });
    });
  }
  var all = [];
  function page(off) {
    return Q.api("playlist/get?playlist_id=" + c.id + "&extra=tracks&limit=500&offset=" + off).then(function (j) {
      var t = (j.tracks && j.tracks.items) || []; all = all.concat(t.map(function (x) { return x.id; }).filter(Boolean));
      var total = (j.tracks && j.tracks.total) || all.length;
      if (all.length < total && t.length) return page(all.length);
      return all;
    });
  }
  return page(0);
}
function favAll(ids) { return chunk(ids, 50).reduce(function (p, c) { return p.then(function () { return Q.api("favorite/create?type=tracks&track_ids=" + c.join(",")); }); }, Promise.resolve()); }
function addTracks(pid, ids) { return chunk(ids, 50).reduce(function (p, c) { return p.then(function () { return Q.api("playlist/addTracks?playlist_id=" + pid + "&track_ids=" + c.join(",")); }); }, Promise.resolve()); }
function userPlaylists() { return Q.api("playlist/getUserPlaylists?limit=200").then(function (j) { return (j.playlists && j.playlists.items) || []; }).catch(function () { return []; }); }
function createPlaylist(name) { return Q.api("playlist/create?name=" + encodeURIComponent(name) + "&is_public=false").then(function (c) { return String(c.id); }); }

// --- toast ---
function toast(msg, bad) {
  var t = document.createElement("div"); t.className = "qz-ba-toast" + (bad ? " qz-ba-toast--bad" : ""); t.textContent = msg;
  document.body.appendChild(t); requestAnimationFrame(function () { t.classList.add("qz-ba-toast--in"); });
  setTimeout(function () { t.classList.remove("qz-ba-toast--in"); setTimeout(function () { t.remove(); }, 250); }, 2400);
}

// --- add-to-playlist picker ---
function closePicker() { var p = document.getElementById("qz-ba-pop"); if (p) p.remove(); document.removeEventListener("mousedown", pickerOutside, true); }
function pickerOutside(e) { var p = document.getElementById("qz-ba-pop"); if (p && !p.contains(e.target) && !e.target.closest("#qz-ba-add")) closePicker(); }
function openPicker(anchor, c) {
  if (document.getElementById("qz-ba-pop")) { closePicker(); return; }
  var pop = document.createElement("div"); pop.id = "qz-ba-pop"; pop.className = "qz-ba-pop";
  pop.innerHTML = '<div class="qz-ba-poptitle">Add all tracks to…</div><div class="qz-ba-new"><input class="qz-ba-newinput" placeholder="New playlist name…" maxlength="80"><button class="qz-ba-newbtn">Create</button></div><div class="qz-ba-list"><div class="qz-ba-loading">Loading playlists…</div></div>';
  document.body.appendChild(pop);
  var r = anchor.getBoundingClientRect();
  pop.style.top = Math.round(r.bottom + 8) + "px";
  pop.style.left = Math.round(Math.min(r.left, window.innerWidth - 320)) + "px";
  setTimeout(function () { document.addEventListener("mousedown", pickerOutside, true); }, 0);
  var input = pop.querySelector(".qz-ba-newinput");
  function doCreate() { var nm = (input.value || "").trim(); if (!nm) { input.focus(); return; } run(null, nm); }
  pop.querySelector(".qz-ba-newbtn").addEventListener("click", doCreate);
  input.addEventListener("keydown", function (e) { if (e.key === "Enter") doCreate(); });
  function run(targetPid, newName) {
    closePicker();
    toast("Adding tracks…");
    loadTrackIds(c).then(function (ids) {
      if (!ids.length) { toast("Nothing to add", true); return; }
      var mk = newName ? createPlaylist(newName) : Promise.resolve(targetPid);
      return mk.then(function (pid) { return addTracks(pid, ids).then(function () { toast("Added " + ids.length + " track" + (ids.length > 1 ? "s" : "") + (newName ? " to “" + newName + "”" : "")); }); });
    }).catch(function () { toast("Failed - try again", true); });
  }
  userPlaylists().then(function (pls) {
    return me().then(function (uid) {
      var mine = pls.filter(function (p) { return !uid || (p.owner && p.owner.id === uid); });
      var list = pop.querySelector(".qz-ba-list");
      if (!mine.length) { list.innerHTML = '<div class="qz-ba-loading">No playlists yet - create one above.</div>'; return; }
      list.innerHTML = "";
      mine.forEach(function (p) {
        // don't offer to add a playlist into itself
        if (c.kind === "playlist" && String(p.id) === String(c.id)) return;
        var row = document.createElement("div"); row.className = "qz-ba-item";
        row.innerHTML = '<span class="qz-ba-itemname">' + esc(p.name) + "</span><span class=\"qz-ba-itemn\">" + (p.tracks_count || 0) + "</span>";
        row.addEventListener("click", function () { run(String(p.id), null); });
        list.appendChild(row);
      });
    });
  });
}

// --- favourite all ---
function favouriteAll(btn, c) {
  if (btn.disabled) return;
  btn.disabled = true; btn.classList.add("qz-ba-busy");
  loadTrackIds(c).then(function (ids) {
    if (!ids.length) { toast("Nothing to favourite", true); return; }
    return favAll(ids).then(function () { toast("Favourited " + ids.length + " track" + (ids.length > 1 ? "s" : "")); });
  }).catch(function () { toast("Failed - try again", true); }).then(function () { btn.disabled = false; btn.classList.remove("qz-ba-busy"); });
}

// --- shuffle & play (build a shuffled copy, play only these tracks) ---
function ctxName(c) {
  if (c.kind === "library") return Promise.resolve("My Tracks");
  if (c.kind === "album") return Q.api("album/get?album_id=" + c.id + "&limit=0").then(function (j) { return j.title || "Album"; }).catch(function () { return "Album"; });
  return Q.api("playlist/get?playlist_id=" + c.id + "&limit=0").then(function (j) { return j.name || "Playlist"; }).catch(function () { return "Playlist"; });
}
function playPlaylist(pid) {
  Q.navigate("/playlist/" + pid);
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    var onPage = route().indexOf(pid) >= 0;
    var btn = document.querySelector(".PageHeader .ButtonRoundPrimary, [class*='PageHeader'] button[aria-label='Play']");
    if (onPage && btn && btn.offsetParent) { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); clearInterval(iv); }
    else if (tries > 45) clearInterval(iv);
  }, 150);
}
// --- full-shuffle queue write (issue #12: the native enqueue only takes the lazily-loaded head ~100) ---
// Replace everything AFTER the playing item with the shuffled remainder, via the same partial
// "playqueue/set" merge the app's own remove-from-queue uses (the runtime's dropUpcoming proves the
// engine honours a wholesale upcoming rewrite; multi-select's queue append proves NEW trackIds are
// accepted). New entries clone the live current item's keys - the item shape differs between hosts,
// so never hardcode it - with trackId overridden and fresh unique "q<n>" queueItemIds.
var QUEUE_CAP = 5000;   // mirrors playlist-power's paging guard; shuffle-then-truncate stays a fair sample
var HEAD = 100;         // temp-playlist head: starts playback fast even on a 10k-track source
function setUpcoming(ids) {
  try {
    if (!Q.store || typeof Q.store.dispatch !== "function") return 0;
    var pq = Q.getState().playqueue;
    // when shuffled the play order is shuffledItems (currentIndex indexes into it); otherwise items
    var govShuffled = !!(pq && pq.shuffled && Array.isArray(pq.shuffledItems) && pq.shuffledItems.length);
    var gov = govShuffled ? pq.shuffledItems : (pq && pq.items);
    if (!gov || !gov.length) return 0;
    var ci = pq.currentIndex || 0;
    var tmpl = gov[ci] || gov[0]; if (!tmpl) return 0;
    var maxN = 0;
    function scanMax(arr) { (arr || []).forEach(function (it) { if (it && typeof it.queueItemId === "string") { var n = Number(it.queueItemId.slice(1)); if (!isNaN(n) && n > maxN) maxN = n; } }); }
    scanMax(pq.items); scanMax(pq.shuffledItems);
    var newItems = ids.map(function (id) {
      maxN += 1;
      var o = {};
      for (var k in tmpl) { if (Object.prototype.hasOwnProperty.call(tmpl, k)) o[k] = tmpl[k]; }
      o.trackId = coerceId(id); o.queueItemId = "q" + maxN;
      if ("cloudItemId" in o) o.cloudItemId = null;
      return o;
    });
    var payload = { index: ci, dirty: true };
    if (govShuffled) payload.shuffledItems = gov.slice(0, ci + 1).concat(newItems);
    else payload.items = gov.slice(0, ci + 1).concat(newItems);
    Q.store.dispatch({ type: "playqueue/set", payload: payload });
    return newItems.length;
  } catch (e) { console.warn("[qobuzify] bulk-actions: queue write failed", e); return 0; }
}
// the order is pre-shuffled - native shuffle on top of it would double-shuffle, so turn it off first
// (documented transport click, docs/player-control.md). If it sticks, setUpcoming's shuffledItems
// branch still writes the governing array.
function shuffleOff() {
  try {
    var pq = Q.getState().playqueue;
    if (pq && pq.shuffled) { var el = document.querySelector(".pct-shuffle"); if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); }
  } catch (e) {}
}
function queueSig(pq) { var it = (pq && pq.items) || []; return it.length + "|" + (it[0] && it[0].trackId) + "|" + (it[it.length - 1] && it[it.length - 1].trackId); }
var extendIv = null, reassertT = null;
// Wait for the native queue to actually swap to the temp head (poll the STORE, never the DOM), then
// replace the upcoming items with the full shuffled remainder in one dispatch. Re-assert once ~2s
// later in case Qobuz lazily appends more playlist pages after our write.
function armQueueExtend(ids, headLen) {
  clearInterval(extendIv); clearTimeout(reassertT);
  var preSig = "";
  try { preSig = queueSig(Q.getState().playqueue); } catch (e) {}
  var tries = 0;
  extendIv = setInterval(function () {
    tries++;
    var pq = null;
    try { pq = Q.getState().playqueue; } catch (e) {}
    var items = (pq && pq.items) || [];
    var swapped = items.length && String(items[0] && items[0].trackId) === String(ids[0]) && queueSig(pq) !== preSig;
    if (swapped) {
      clearInterval(extendIv); extendIv = null;
      shuffleOff();
      var n = setUpcoming(ids.slice(1));
      if (!n) { toast("Couldn't queue the full shuffle - playing the first " + headLen, true); return; }
      toast("All " + ids.length + " tracks queued");
      var postSig = "";
      try { postSig = queueSig(Q.getState().playqueue); } catch (e) {}
      reassertT = setTimeout(function () {
        try {
          if (queueSig(Q.getState().playqueue) !== postSig) {
            console.info("[qobuzify] bulk-actions: queue diverged after full-shuffle write, re-asserting");
            setUpcoming(ids.slice(1));
          }
        } catch (e) {}
      }, 2000);
    } else if (tries > 45) {
      clearInterval(extendIv); extendIv = null;
      toast("Couldn't queue the full shuffle - playing the first " + headLen, true);
    }
  }, 150);
}
function shufflePlay(btn, c) {
  if (btn.disabled) return;
  btn.disabled = true; btn.classList.add("qz-ba-busy");
  Promise.all([loadTrackIds(c), ctxName(c)]).then(function (r) {
    var ids = (r[0] || []).slice(), name = r[1];
    if (ids.length < 2) { toast("Nothing to shuffle", true); return; }
    for (var i = ids.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = ids[i]; ids[i] = ids[j]; ids[j] = t; }
    if (ids.length > QUEUE_CAP) ids = ids.slice(0, QUEUE_CAP);
    toast("Shuffling " + ids.length + " tracks…");
    // small source: the temp playlist holds everything and the native enqueue is already complete.
    // Bigger: fill only the head so playback starts fast, then swap in the full remainder store-side.
    var whole = ids.length <= 90;
    var head = whole ? ids : ids.slice(0, HEAD);
    // an emoji in the name makes Qobuz's playlist API save an empty name, so keep it to a plain prefix
    return createPlaylist("Shuffle · " + name).then(function (pid) {
      return addTracks(pid, head).then(function () {
        var oldPid = Q.storage.get("ba:shuf", null); Q.storage.set("ba:shuf", pid);
        // keep exactly one shuffle playlist: delete the previous one shortly after (never the one now playing)
        if (oldPid && oldPid !== pid) setTimeout(function () { Q.api("playlist/delete?playlist_id=" + oldPid).catch(function () {}); }, 8000);
        playPlaylist(pid);
        if (!whole) armQueueExtend(ids, head.length);
      });
    });
  }).catch(function () { toast("Failed - try again", true); }).then(function () { btn.disabled = false; btn.classList.remove("qz-ba-busy"); });
}

// --- inject ---
// The library page has no .PageHeader__actions - park the wrap beside the grid/list view toggle
// (inputs #ui-base-radio--grid / --list, per ux-tweaks), inserted before their common ancestor so the
// radio group itself is never touched.
function libraryHost() {
  var g = document.getElementById("ui-base-radio--grid"), l = document.getElementById("ui-base-radio--list");
  if (!g || !l) return null;
  var host = g.parentElement, hops = 0;
  while (host && !host.contains(l) && ++hops < 6) host = host.parentElement;
  return (host && host.contains(l) && host.parentElement) ? { parent: host.parentElement, before: host } : null;
}
function inject() {
  var c = ctx();
  var ex = document.getElementById(WRAP_ID);
  if (!c) { if (ex) ex.remove(); closePicker(); return; }
  if (ex) { if (ex.getAttribute("data-ctx") === c.kind + ":" + c.id && ex.parentNode) return; ex.remove(); }
  var lib = c.kind === "library";
  var actions = document.querySelector(".PageHeader__actions");
  var libHost = (!actions && lib) ? libraryHost() : null;
  if (!actions && !libHost) return;
  var wrap = document.createElement("span"); wrap.id = WRAP_ID; wrap.className = "qz-ba-wrap"; wrap.setAttribute("data-ctx", c.kind + ":" + c.id);
  // library surface is shuffle-only: favouriting your favourites is a no-op, and "add all" is untested there
  wrap.innerHTML = '<button class="qz-ba-btn qz-ba-btn--accent" id="qz-ba-shuf" title="Shuffle these tracks and play">' + SHUF + '<span>Shuffle</span></button>' +
    (lib ? '' :
    '<button class="qz-ba-btn" id="qz-ba-fav" title="Favourite all tracks">' + HEART + '<span>All</span></button>' +
    '<button class="qz-ba-btn" id="qz-ba-add" title="Add all tracks to a playlist">' + PLUS + '<span>Add all</span></button>');
  wrap.querySelector("#qz-ba-shuf").addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); shufflePlay(this, c); });
  var fv = wrap.querySelector("#qz-ba-fav"); if (fv) fv.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); favouriteAll(this, c); });
  var ad = wrap.querySelector("#qz-ba-add"); if (ad) ad.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); openPicker(this, c); });
  if (actions) actions.appendChild(wrap);
  else libHost.parent.insertBefore(wrap, libHost.before);
}

// --- styles ---
Q.css(CSS_ID, [
  ".qz-ba-wrap{display:inline-flex;align-items:center;gap:6px;margin-left:6px;}",
  ".qz-ba-btn{display:inline-flex;align-items:center;gap:6px;height:40px;padding:0 14px;border:1px solid rgba(255,255,255,.18);border-radius:20px;background:transparent;color:#e7ecf3;font:inherit;font-size:13px;font-weight:700;cursor:pointer;transition:all .14s;}",
  ".qz-ba-btn:hover{border-color:var(--qz-accent,#3DA8FE);color:#fff;background:rgba(61,168,254,.1);}",
  ".qz-ba-btn--accent{border-color:var(--qz-accent,#3DA8FE);color:var(--qz-accent,#3DA8FE);}",
  ".qz-ba-btn--accent:hover{background:var(--qz-accent,#3DA8FE);color:#06090a;}",
  ".qz-ba-btn svg{width:17px;height:17px;}",
  ".qz-ba-btn.qz-ba-busy{opacity:.55;cursor:default;}",
  "#qz-ba-fav:hover svg{color:#ff5c6c;}",
  // picker popover (ephemeral, dismissed on outside click - fine at high z)
  ".qz-ba-pop{position:fixed;z-index:2147483400;width:300px;max-height:60vh;display:flex;flex-direction:column;background:linear-gradient(180deg,#0e131c,#0a0e15);border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 24px 60px -16px rgba(0,0,0,.8);overflow:hidden;color:#eef2f7;font-family:inherit;-webkit-app-region:no-drag;}",
  ".qz-ba-poptitle{font-size:12px;font-weight:750;letter-spacing:.4px;text-transform:uppercase;color:#8b94a3;padding:13px 15px 9px;}",
  ".qz-ba-new{display:flex;gap:7px;padding:0 12px 11px;border-bottom:1px solid rgba(255,255,255,.07);}",
  ".qz-ba-newinput{flex:1;min-width:0;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.12);border-radius:9px;color:#e7ecf3;font:inherit;font-size:13px;padding:8px 10px;}",
  ".qz-ba-newinput:focus{outline:none;border-color:var(--qz-accent,#3DA8FE);}",
  ".qz-ba-newbtn{flex:0 0 auto;border:0;border-radius:9px;background:var(--qz-accent,#3DA8FE);color:#06090a;font:inherit;font-size:12.5px;font-weight:800;padding:0 14px;cursor:pointer;}",
  ".qz-ba-newbtn:hover{filter:brightness(1.08);}",
  ".qz-ba-list{overflow:auto;padding:6px;}",
  ".qz-ba-loading{padding:16px 12px;color:#8b94a3;font-size:13px;text-align:center;}",
  ".qz-ba-item{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:9px;cursor:pointer;transition:background .12s;}",
  ".qz-ba-item:hover{background:rgba(255,255,255,.06);}",
  ".qz-ba-itemname{flex:1;min-width:0;font-size:13.5px;font-weight:600;color:#e7ecf3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".qz-ba-itemn{flex:0 0 auto;font-size:11.5px;color:#8b94a3;}",
  // toast
  ".qz-ba-toast{position:fixed;left:50%;bottom:96px;transform:translate(-50%,16px);z-index:2147483500;background:#06090d;border:1px solid var(--qz-accent,#3DA8FE);color:#fff;font-size:13px;font-weight:700;padding:10px 20px;border-radius:22px;opacity:0;pointer-events:none;transition:all .22s;box-shadow:0 12px 34px rgba(0,0,0,.55);}",
  ".qz-ba-toast--in{opacity:1;transform:translate(-50%,0);}",
  ".qz-ba-toast--bad{border-color:#ff5c6c;}"
].join(""));

// --- boot ---
var offRoute = Q.onRoute(function () { closePicker(); setTimeout(inject, 300); });
var obs = Q.observe(function () { inject(); }, { debounce: 300 });
inject();

return function cleanup() {
  if (offRoute) offRoute();
  if (obs) obs();
  clearInterval(extendIv); clearTimeout(reassertT);
  closePicker();
  var w = document.getElementById(WRAP_ID); if (w) w.remove();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
