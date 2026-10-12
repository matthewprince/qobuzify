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

// id -> { t: title, a: [artist names] } for every track loadTrackIds has seen, so the shuffle can check
// block-trash's rules without another round-trip (see blockedFilter).
var trackMeta = {};
function noteMeta(t) {
  if (!t || t.id == null || !t.title) return;
  var names = [];
  if (t.performer && t.performer.name) names.push(t.performer.name);
  if (t.album && t.album.artist && t.album.artist.name) names.push(t.album.artist.name);
  if (t.artist && t.artist.name) names.push(t.artist.name);
  try {
    var it = t.interpreters; if (typeof it === "string") it = JSON.parse(it);
    (it || []).forEach(function (x) { var nm = x && x.name; nm = nm && (nm.display || nm); if (typeof nm === "string") names.push(nm); });
  } catch (e) {}
  trackMeta[String(t.id)] = { t: t.title, a: names };
}
function loadTrackIds(c) {
  if (c.kind === "album") return Q.api("album/get?album_id=" + c.id).then(function (j) { var items = (j.tracks && j.tracks.items) || []; items.forEach(noteMeta); return items.map(function (t) { return t.id; }).filter(Boolean); });
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
    return Q.api("playlist/get?playlist_id=" + c.id + "&extra=tracks&limit=500&offset=" + off, { timeout: 45000 }).then(function (j) {
      var t = (j.tracks && j.tracks.items) || []; t.forEach(noteMeta); all = all.concat(t.map(function (x) { return x.id; }).filter(Boolean));
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

// --- generated-playlist guard (identical copy in smart-playback, recommended, bulk-actions, multi-select) ---
// A playlist we generated is only ever deleted while it is still exactly what we made. genCapture() runs right
// after the create + fill and records Qobuz's own view of it (name, description, track count), falling back to
// what we sent if that read fails. genDelete() re-reads the playlist and deletes it only on a full match. A
// rename, an edited description, added or removed tracks, or a record without that fingerprint (an older
// version stored only the id) all mean the user may have kept it: the id is forgotten and the playlist stays.
// genDelete resolves "deleted" | "kept" | "gone" and rejects only on a transient failure (network, 5xx), so a
// caller with a retry list knows to try again later.
// genStore/genLoad keep the id key itself a bare playlist id (playlist-finder reads those keys to exclude our
// playlists) and put the fingerprint beside it under "gen:<key>". genLoad returns null unless both agree.
function genStore(key, rec) { Q.storage.set("gen:" + key, JSON.stringify(rec)); Q.storage.set(key, String(rec.pid)); }
function genLoad(key) {
  var pid = Q.storage.get(key, null), rec = genParse(Q.storage.get("gen:" + key, null));
  return pid != null && rec && rec.pid === String(pid) ? rec : null;
}
function genCapture(pid, name, desc, count) {
  var fb = { pid: String(pid), name: String(name || ""), desc: String(desc || ""), count: count };
  return Q.api("playlist/get?playlist_id=" + encodeURIComponent(pid) + "&limit=0").then(function (p) {
    if (!p || String(p.id) !== String(pid)) return fb;
    var n = Number(p.tracks_count);
    return { pid: String(pid), name: String(p.name || ""), desc: String(p.description || ""), count: isFinite(n) ? n : count };
  }, function () { return fb; });
}
function genParse(raw) {
  try {
    var r = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (r && r.pid != null && typeof r.name === "string" && typeof r.desc === "string" && typeof r.count === "number") return { pid: String(r.pid), name: r.name, desc: r.desc, count: r.count };
  } catch (e) {}
  return null;
}
function genDelete(raw) {
  var rec = genParse(raw);
  if (!rec) return Promise.resolve("kept");
  return Q.api("playlist/get?playlist_id=" + encodeURIComponent(rec.pid) + "&limit=0").then(function (p) {
    if (!p || String(p.id) !== rec.pid) return "gone";
    if (String(p.name || "") !== rec.name || String(p.description || "") !== rec.desc || Number(p.tracks_count) !== rec.count) return "kept";
    return Q.api("playlist/delete?playlist_id=" + encodeURIComponent(rec.pid)).then(function () { return "deleted"; });
  }, function (e) {
    if (/-> (400|403|404)$/.test(String(e && e.message))) return "gone";
    throw e;
  });
}

// --- block-trash's deny list ---
// block-trash keeps its rules in localStorage ("qz-block:artists" = { normArtist }, "qz-block:songs" =
// { "normTitle|normArtist" }) and its per-id verdicts in a private map. Mirror its matching (same norm(), every
// artist credit) on the metadata we already hold, so a full shuffle never queues or re-queues a track it
// blocks. Only while block-trash is running (its #qz-bt-css style exists): a disabled one leaves its lists
// behind but blocks nothing. Ids with no metadata pass through; block-trash's own resolve-and-prune still
// catches those once they are near the front.
function btNorm(s) { return String(s == null ? "" : s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[\u2018\u2019'`]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
function btLoad(k) { try { var o = JSON.parse(localStorage.getItem(k) || "{}"); return (o && typeof o === "object") ? o : {}; } catch (e) { return {}; } }
function metaOf(id) {
  id = String(id);
  if (trackMeta[id]) return trackMeta[id];
  try { var d = Q.getState().dictionnary.tracks.data || {}; if (d[id]) { noteMeta(d[id]); if (trackMeta[id]) return trackMeta[id]; } } catch (e) {}
  return null;
}
var libMetaNoted = false;
function blockedFilter(ids) {
  if (!document.getElementById("qz-bt-css")) return ids;
  var arts = btLoad("qz-block:artists"), songs = btLoad("qz-block:songs");
  if (!Object.keys(arts).length && !Object.keys(songs).length) return ids;
  if (!libMetaNoted && Q.library && Q.library.get) { try { Q.library.get("tracks").forEach(noteMeta); libMetaNoted = true; } catch (e) {} }
  return ids.filter(function (id) {
    var m = metaOf(id); if (!m) return true;
    var nt = btNorm(m.t);
    for (var i = 0; i < m.a.length; i++) { var na = btNorm(m.a[i]); if (arts[na] || songs[nt + "|" + na]) return false; }
    return true;
  });
}

// --- toast ---
// one toast at a time, as before: a new message updates the open one and restarts its timer
var curToast = null, curBad = false, toastT = null;
function toast(msg, bad) {
  clearTimeout(toastT);
  if (curToast && curBad !== !!bad) curToast.close();
  if (curToast) curToast.update(msg);
  else { var t = curToast = Q.ui.toast(msg, { timeout: 0, tone: bad ? "error" : undefined, onClose: function () { if (curToast === t) curToast = null; } }); curBad = !!bad; }
  var mine = curToast;
  toastT = setTimeout(function () { mine.close(); }, 2400);
}
function closeToast() { clearTimeout(toastT); if (curToast) curToast.close(); }

// --- add-to-playlist picker ---
function closePicker() { var p = document.getElementById("qz-ba-pop"); if (p) p.remove(); document.removeEventListener("mousedown", pickerOutside, true); }
function pickerOutside(e) { var p = document.getElementById("qz-ba-pop"); if (p && !p.contains(e.target) && !e.target.closest("#qz-ba-add")) closePicker(); }
function openPicker(anchor, c) {
  if (document.getElementById("qz-ba-pop")) { closePicker(); return; }
  var pop = document.createElement("div"); pop.id = "qz-ba-pop"; pop.className = "qz-ba-pop";
  Q.ui.follow(pop);
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
// What still has to come after the playing item: the shuffled order minus everything already played or
// playing in the governing array. In the normal flow that is exactly ids after the current track's position,
// so a skip during the re-assert window can't queue the new current track (or the one skipped) twice.
// null when the queue is no longer the one we built (the user started something else).
function remainingAfterCurrent(ids) {
  var pq = Q.getState().playqueue;
  var items = (pq && pq.items) || [];
  if (!items.length || String(items[0] && items[0].trackId) !== String(ids[0])) return null;
  var gov = (pq.shuffled && Array.isArray(pq.shuffledItems) && pq.shuffledItems.length) ? pq.shuffledItems : items;
  var ci = pq.currentIndex || 0, played = {};
  for (var i = 0; i <= ci && i < gov.length; i++) if (gov[i]) played[String(gov[i].trackId)] = 1;
  return blockedFilter(ids.filter(function (id) { return !played[String(id)]; }));
}
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
      var rest = null; try { rest = remainingAfterCurrent(ids); } catch (e) {}
      var n = rest ? setUpcoming(rest) : 0;
      if (!n) { toast("Couldn't queue the full shuffle - playing the first " + headLen, true); return; }
      toast("All " + ids.length + " tracks queued");
      var postSig = "";
      try { postSig = queueSig(Q.getState().playqueue); } catch (e) {}
      reassertT = setTimeout(function () {
        try {
          if (queueSig(Q.getState().playqueue) !== postSig) {
            var again = remainingAfterCurrent(ids);
            if (!again) return;   // not our queue any more: leave whatever the user started alone
            console.info("[qobuzify] bulk-actions: queue diverged after full-shuffle write, re-asserting");
            setUpcoming(again);
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
    var ids = blockedFilter((r[0] || []).slice()), name = r[1];
    if (ids.length < 2) { toast("Nothing to shuffle", true); return; }
    for (var i = ids.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = ids[i]; ids[i] = ids[j]; ids[j] = t; }
    if (ids.length > QUEUE_CAP) ids = ids.slice(0, QUEUE_CAP);
    toast("Shuffling " + ids.length + " tracks…");
    // small source: the temp playlist holds everything and the native enqueue is already complete.
    // Bigger: fill only the head so playback starts fast, then swap in the full remainder store-side.
    var whole = ids.length <= 90;
    var head = whole ? ids : ids.slice(0, HEAD);
    // an emoji in the name makes Qobuz's playlist API save an empty name, so keep it to a plain prefix
    var plName = "Shuffle · " + name;
    return createPlaylist(plName).then(function (pid) {
      return addTracks(pid, head).then(function () { return genCapture(pid, plName, "", head.length); }).then(function (rec) {
        var old = genLoad("ba:shuf"); genStore("ba:shuf", rec);
        // keep exactly one shuffle playlist: delete the previous one shortly after (never the one now playing),
        // and only if it is still untouched
        if (old && old.pid !== String(pid)) setTimeout(function () { genDelete(old).catch(function () {}); }, 8000);
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
// Qobuz keeps the album/playlist header dark in BOTH appearances, but the actions row itself inherits the
// page's text colour, so a plain `inherit` went dark-on-dark on the light appearance. Take the colour from
// one of Qobuz's own icon buttons in the same row instead (a transparent one: the big round Play is filled).
function syncHeaderColor(wrap, actions) {
  if (!actions) return;
  var bs = actions.querySelectorAll("button"), col = "";
  for (var i = 0; i < bs.length && !col; i++) {
    if (wrap.contains(bs[i])) continue;
    var cs = getComputedStyle(bs[i]);
    if (cs.backgroundColor === "rgba(0, 0, 0, 0)" || cs.backgroundColor === "transparent") col = cs.color;
  }
  if (col && wrap.style.color !== col) wrap.style.color = col;
}
function inject() {
  var c = ctx();
  var ex = document.getElementById(WRAP_ID);
  if (!c) { if (ex) ex.remove(); closePicker(); return; }
  if (ex) { if (ex.getAttribute("data-ctx") === c.kind + ":" + c.id && ex.parentNode) { syncHeaderColor(ex, ex.parentNode.closest && ex.parentNode.closest(".PageHeader__actions")); return; } ex.remove(); }
  var lib = c.kind === "library";
  var actions = document.querySelector(".PageHeader__actions");
  var libHost = (!actions && lib) ? libraryHost() : null;
  if (!actions && !libHost) return;
  var wrap = document.createElement("span"); wrap.id = WRAP_ID; wrap.className = "qz-ba-wrap"; wrap.setAttribute("data-ctx", c.kind + ":" + c.id);
  // library surface is shuffle-only: favouriting your favourites is a no-op, and "add all" is untested there
  wrap.innerHTML = '<button class="qz-ba-btn qz-ba-btn--accent" id="qz-ba-shuf" title="Shuffle these tracks and play">' + SHUF + '<span>Shuffle</span></button>' +
    (lib ? '' :
    '<button class="qz-ba-btn" id="qz-ba-fav" title="Favourite all tracks" aria-label="Favourite all tracks">' + HEART + '<span>All</span></button>' +
    '<button class="qz-ba-btn" id="qz-ba-add" title="Add all tracks to a playlist">' + PLUS + '<span>Add all</span></button>');
  wrap.querySelector("#qz-ba-shuf").addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); shufflePlay(this, c); });
  var fv = wrap.querySelector("#qz-ba-fav"); if (fv) fv.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); favouriteAll(this, c); });
  var ad = wrap.querySelector("#qz-ba-add"); if (ad) ad.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); openPicker(this, c); });
  if (actions) { actions.appendChild(wrap); syncHeaderColor(wrap, actions); }
  else libHost.parent.insertBefore(wrap, libHost.before);
}

// --- styles ---
Q.css(CSS_ID, [
  ".qz-ba-wrap{display:inline-flex;align-items:center;gap:6px;margin-left:6px;}",
  ".qz-ba-btn{display:inline-flex;align-items:center;gap:6px;height:40px;padding:0 14px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:20px;background:transparent;color:inherit;font:inherit;font-size:13px;font-weight:700;cursor:pointer;transition:all .14s;}",
  ".qz-ba-btn:hover{border-color:var(--qz-accent,#3DA8FE);background:color-mix(in srgb,var(--qz-accent,#3DA8FE) 10%,transparent);}",
  ".qz-ba-btn--accent{border-color:var(--qz-accent,#3DA8FE);color:var(--qz-accent,#3DA8FE);}",
  ".qz-ba-btn--accent:hover{background:var(--qz-accent,#3DA8FE);color:#06090a;}",
  ".qz-ba-btn svg{width:17px;height:17px;}",
  ".qz-ba-btn.qz-ba-busy{opacity:.55;cursor:default;}",
  "#qz-ba-fav:hover svg{color:#ff5c6c;}",
  // picker popover (ephemeral, dismissed on outside click - fine at high z). Appended to <body> and following
  // Qobuz's appearance (Q.ui.follow), so the kit's tokens apply.
  ".qz-ba-pop{position:fixed;z-index:2147483400;width:300px;max-height:60vh;display:flex;flex-direction:column;box-sizing:border-box;background:var(--qzu-surface);border:1px solid var(--qzu-line);border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.35);overflow:hidden;color:var(--qzu-fg);font-family:inherit;-webkit-app-region:no-drag;}",
  ".qz-ba-poptitle{font-size:13px;font-weight:600;color:var(--qzu-fg2);padding:13px 15px 9px;}",
  ".qz-ba-new{display:flex;gap:7px;padding:0 12px 11px;border-bottom:1px solid var(--qzu-line);}",
  ".qz-ba-newinput{flex:1;min-width:0;background:var(--qzu-fill);border:1px solid var(--qzu-line);border-radius:9px;color:inherit;font:inherit;font-size:13px;padding:8px 10px;}",
  ".qz-ba-newinput:focus{outline:none;border-color:var(--qz-accent,#3DA8FE);}",
  ".qz-ba-newbtn{flex:0 0 auto;border:0;border-radius:9px;background:var(--qz-accent,#3DA8FE);color:#06090a;font:inherit;font-size:12.5px;font-weight:700;padding:0 14px;cursor:pointer;}",
  ".qz-ba-newbtn:hover{filter:brightness(1.08);}",
  ".qz-ba-list{overflow:auto;padding:6px;}",
  ".qz-ba-loading{padding:16px 12px;color:var(--qzu-fg2);font-size:13px;text-align:center;}",
  ".qz-ba-item{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:9px;cursor:pointer;transition:background .12s;}",
  ".qz-ba-item:hover{background:var(--qzu-fill-hover);}",
  ".qz-ba-itemname{flex:1;min-width:0;font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".qz-ba-itemn{flex:0 0 auto;font-size:11.5px;color:var(--qzu-fg2);}"
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
  closeToast();
  var w = document.getElementById(WRAP_ID); if (w) w.remove();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
