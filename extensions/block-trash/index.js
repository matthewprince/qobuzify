// Block Artists and Trash Songs.
//  - Block: a ban (circle-with-a-line) button on an artist's PROFILE header, next to play/shuffle/follow.
//    Blocks that artist -> every one of their tracks greys out and never plays.
//  - Trash: a trash-can button on the PLAYER BAR (bins the song playing right now) AND on every track row
//    (slotted just before the row's heart so it never sits on top of it). Trashed songs grey + never play.
// "Never plays" is three layers: (1) we pull upcoming blocked/trashed tracks out of the play queue entirely so
// they never reach the front and never buffer, (2) we deny the streaming URL at the network layer so no audio
// ever resolves, and (3) if a blocked track still becomes current we skip it (synthetic click on the native
// next button, since the audio engine is sealed). All state lives in localStorage. Runs as function(Qobuzify){}.
var Q = Qobuzify;
var CSS_ID = "qz-bt-css";
var A_KEY = "qz-block:artists", S_KEY = "qz-block:songs";

function loadMap(k) { try { var o = JSON.parse(localStorage.getItem(k) || "{}"); return (o && typeof o === "object") ? o : {}; } catch (e) { return {}; } }
function saveMap(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
var blocked = loadMap(A_KEY);   // { normArtist: "Display Name" }
var trashed = loadMap(S_KEY);   // { "normTitle|normArtist": "Title — Artist" }

// normalize for matching so row text vs player text vs API name all collapse to one key.
function norm(s) { return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[‘’'`]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
function songKey(t, a) { return norm(t) + "|" + norm(a); }

function artistBlocked(name) { return !!blocked[norm(name)]; }
function anyBlocked(list) { for (var i = 0; i < (list || []).length; i++) if (artistBlocked(list[i])) return true; return false; }
function songTrashed(t, a) { return !!trashed[songKey(t, a)]; }
function stop(e) { e.preventDefault(); e.stopPropagation(); }

// read a row's title + main artist (re-read at click time; virtualised rows recycle the element).
function rowInfo(row) {
  var te = row.querySelector(".ListItem__title") || row.querySelector(".cell-group-title span.ui-link");
  var title = te ? te.textContent.trim() : "";
  var ae = row.querySelector('a[href*="/artist/"]'); var artist = ae ? ae.textContent.trim() : "";
  return { title: title, artist: artist };
}

var TRASH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>';
var BAN = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>';

// --- hard block: deny the streaming URL so a blocked artist / trashed song makes no sound ---
// Every track resolves through a renderer fetch to `.../file/url?track_id=`, and the app aborts those
// constantly anyway (prefetch, skips), so rejecting one is indistinguishable from its own abort - no error,
// no UI blip. It prefetches file/url a few tracks ahead, so we can't skip on sighting (that would kill the
// current good track); we only DENY the id here and let enforce() skip whatever's actually at the front.
var metaCache = {};    // trackId -> { t: title, a: [artist names] }
var deny = {};         // trackId -> true (resolved and blocked)
var metaPromise = {};  // trackId -> Promise (track/get in flight; also lets the fetch gate await a verdict)
var disposed = false;

function metaBlocked(m) { return m ? (songTrashed(m.t, m.a[0]) || anyBlocked(m.a)) : false; }
function classify(id, m) {
  metaCache[id] = m;
  if (metaBlocked(m)) { deny[id] = true; var t = safeTrack(); if (t && String(t.id) === String(id)) enforce(t); pruneQueue(); } // resolved as blocked -> skip if it's current, and pull it from the upcoming queue so it never plays
  else delete deny[id];
}
// NB: never derive an id->title mapping from Q.player.getTrack(). During a track change it hands back a
// torn snapshot (the new id with the previous title, or vice versa), which poisons the map and ends up
// blocking the wrong track. The streaming API is the only trustworthy id->meta source, so the current
// track gets resolved the exact same way as any upcoming one (resolveId, below).
// upcoming queue items only carry a trackId, so resolve title+artist once via the API and remember it.
function resolveId(id) {
  id = String(id); if (!id) return Promise.resolve();
  if (metaCache[id]) return Promise.resolve();
  if (metaPromise[id]) return metaPromise[id];
  var pr = Q.api("track/get?track_id=" + id).then(function (j) {
    if (disposed) return;
    var t = (j && (j.title || (j.work && j.work.title))) || "";
    var names = [];
    var perf = j && j.performer && j.performer.name; if (perf) names.push(perf);
    var alb = j && j.album && j.album.artist && j.album.artist.name; if (alb) names.push(alb);
    // Some track/get payloads carry a full artists[] with per-name roles. Fold in the performer-type credits
    // (skip pure writer/producer/engineer roles) so a block ALSO catches tracks where the artist is only a
    // featured/guest performer, not the album's main artist. Absent on leaner payloads -> falls back to perf.
    if (j && j.artists && j.artists.length) {
      for (var ai = 0; ai < j.artists.length; ai++) {
        var art = j.artists[ai]; if (!art || !art.name) continue;
        var roles = [].concat(art.roles || art.role || []).join(" ");
        if (roles && /composer|writer|lyric|produc|mix|master|engineer|arrang/i.test(roles)) continue;
        names.push(art.name);
      }
    }
    var a = names.filter(function (n, i) { return n && names.indexOf(n) === i; }); // main performer stays a[0]
    classify(id, { t: t, a: a.length ? a : [""] });
  }).catch(function () {}).then(function () { delete metaPromise[id]; });
  metaPromise[id] = pr;
  return pr;
}
// resolve the current index + the prefetch window (and a little autoplay) so a block lands before the audio.
function resolveAhead() {
  try {
    var pq = Q.getState().playqueue; if (!pq) return;
    var it = pq.items || [], ci = pq.currentIndex || 0, i;
    for (i = ci; i < Math.min(it.length, ci + 6); i++) if (it[i]) resolveId(it[i].trackId);
    var ap = (pq.autoplay && pq.autoplay.items) || [];
    for (i = 0; i < Math.min(ap.length, 3); i++) if (ap[i]) resolveId(ap[i].trackId);
  } catch (e) {}
}
// after a block/trash toggle, re-derive the deny set over everything we've already resolved.
function recomputeDeny() { deny = {}; for (var id in metaCache) if (metaCache.hasOwnProperty(id) && metaBlocked(metaCache[id])) deny[id] = true; }
// Pull any upcoming trashed/blocked tracks OUT of the play queue entirely, so they never become the current
// track and never make a sound (vs the pause-and-skip path, which can't retract audio already in the output
// pipeline once a track starts). dropUpcoming only touches items ahead of the current one and no-ops (no
// dispatch) when there's nothing to remove, so it's cheap to call liberally.
function doPrune() { try { if (Q.player && Q.player.dropUpcoming) Q.player.dropUpcoming(function (tid) { return !!deny[tid]; }); } catch (e) {} }
// While a full-queue sweep is running the sweep owns pruning (batched passes) instead of one dispatch per
// resolved track - a long queue with many blocked tracks would otherwise thrash the up-next list.
function pruneQueue() { if (sweepRunning) return; doPrune(); }

// Full-queue sweep. resolveAhead only classifies the prefetch window, which is plenty for a trashed song you
// can see a few rows down - but a blocked ARTIST's tracks can sit anywhere in a long queue. So when you block
// an artist (or a new queue loads) we resolve every not-yet-known id across items + shuffle + autoplay,
// throttled and capped so a 500-track playlist doesn't fire 500 track/get calls at once, and prune
// progressively as the verdicts land. Already-resolved ids are skipped, so repeat sweeps are near-free.
var sweepQueued = [], sweepRunning = false, sweepDone = 0, SWEEP_CAP = 600, SWEEP_CONC = 5, SWEEP_FLUSH = 20;
function sweepPump() {
  if (sweepRunning || !sweepQueued.length) return;
  sweepRunning = true; sweepDone = 0; var inflight = 0;
  (function step() {
    if (disposed) { sweepRunning = false; return; }
    while (inflight < SWEEP_CONC && sweepQueued.length) {
      var id = sweepQueued.shift(); if (!id || metaCache[id]) continue;
      inflight++;
      resolveId(id).then(function () { inflight--; if (++sweepDone % SWEEP_FLUSH === 0) doPrune(); step(); });
    }
    if (!sweepQueued.length && inflight === 0) { sweepRunning = false; doPrune(); } // final batched prune
  })();
}
function sweepQueue() {
  try {
    var pq = Q.getState().playqueue; if (!pq) return;
    var pools = [pq.items, pq.shuffledItems, pq.autoplay && pq.autoplay.items], seen = {}, added = 0;
    for (var p = 0; p < pools.length && added < SWEEP_CAP; p++) {
      var arr = pools[p]; if (!arr || !arr.length) continue;
      for (var i = 0; i < arr.length && added < SWEEP_CAP; i++) {
        var id = arr[i] && arr[i].trackId != null && String(arr[i].trackId);
        if (id && !seen[id] && !metaCache[id]) { seen[id] = 1; sweepQueued.push(id); added++; }
      }
    }
    if (added) sweepPump();
  } catch (e) {}
}
// Sweep once whenever the queue itself changes (new album/playlist, tracks added) - detected by a cheap
// signature that ignores currentIndex, so plain skipping around a loaded queue doesn't re-trigger it.
function queueSig(pq) { var it = (pq && pq.items) || []; return it.length + "|" + (it[0] && it[0].trackId) + "|" + (it[it.length - 1] && it[it.length - 1].trackId); }
var lastQueueSig = "";
function checkQueueSwap() { try { var pq = Q.getState().playqueue; if (!pq) return; var s = queueSig(pq); if (s !== lastQueueSig) { lastQueueSig = s; sweepQueue(); } } catch (e) {} }

// the gate itself. Guarded by `disposed` so it goes inert on unload even if it can't be unwrapped.
var origFetch = window.fetch;
function denyResp() { return Promise.reject(new DOMException("qz-block", "AbortError")); }
function hookedFetch(input, init) {
  var url = (typeof input === "string") ? input : (input && input.url);
  if (!disposed && url && url.indexOf("/file/url") >= 0) {
    try {
      var id = new URL(url, location.href).searchParams.get("track_id");
      if (id) {
        if (deny[id]) return denyResp();
        if (!metaCache[id]) {
          // Unclassified: gate the stream URL behind one track/get so a blocked track can NEVER buffer
          // ahead of its verdict. Buffering-before-deny is what leaks the first word at a gapless
          // transition. Costs ~1 API call the first time an id is seen; ids pre-resolved by resolveAhead
          // skip this and take the fast path above.
          var self = this, args = arguments;
          return resolveId(id).then(function () { return deny[id] ? denyResp() : origFetch.apply(self, args); });
        }
      }
    } catch (e) {}
  }
  return origFetch.apply(this, arguments);
}
window.fetch = hookedFetch;
var aheadTimer = setInterval(function () { resolveAhead(); checkQueueSwap(); pruneQueue(); }, 4000);

// --- toggles ---
function toggleArtist(name) {
  var k = norm(name); if (!k) return;
  if (blocked[k]) { delete blocked[k]; touchMeta("a", k, 1); toast("Unblocked " + name); }
  else { blocked[k] = name; touchMeta("a", k, 0); toast("Blocked " + name); }
  saveMap(A_KEY, blocked); afterChange();
}
function toggleSong(title, artist) {
  var k = songKey(title, artist); if (!k) return;
  if (trashed[k]) { delete trashed[k]; touchMeta("s", k, 1); toast("Restored"); }
  else { trashed[k] = title + " — " + artist; touchMeta("s", k, 0); toast("Trashed"); }
  saveMap(S_KEY, trashed); afterChange();
}
// remove straight from a normalized key (the manager's unblock/restore buttons work off keys, not display text)
function unblockKey(k) { if (blocked[k] == null) return; var nm = blocked[k]; delete blocked[k]; touchMeta("a", k, 1); saveMap(A_KEY, blocked); afterChange(); toast("Unblocked " + nm); }
function restoreKey(k) { if (trashed[k] == null) return; delete trashed[k]; touchMeta("s", k, 1); saveMap(S_KEY, trashed); afterChange(); toast("Restored"); }
function afterChange() { recomputeDeny(); doPrune(); sweepQueue(); resolveAhead(); decorate(); ensureArtistBtn(); syncSlot(); renderManager(); enforce(safeTrack()); }

// --- cloud sync (opt-in, off by default) ---
// Mirrors the Stats sync model: an anonymous client-generated syncId (no account, no PII), stored per
// entry with a last-modified ts + a `deleted` tombstone so block/unblock across devices merge last-writer-
// wins rather than one device clobbering the other. Server: api.qobuzify.app/v1/blocklist/{push,pull,wipe}.
var SYNC_API = "https://api.qobuzify.app/v1/blocklist";
var LS_CLOUD = "qz-block:cloud", LS_SYNCID = "qz-block:syncid", LS_META = "qz-block:meta";
function cloudOn() { try { return localStorage.getItem(LS_CLOUD) === "1"; } catch (e) { return false; } }
function validId(s) { return typeof s === "string" && /^[A-Za-z0-9-]{16,64}$/.test(s); }
function getSyncId() {
  var id = null; try { id = localStorage.getItem(LS_SYNCID); } catch (e) {}
  if (!validId(id)) {
    id = ((window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ("qz" + Date.now() + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2))).replace(/[^A-Za-z0-9-]/g, "").slice(0, 40);
    try { localStorage.setItem(LS_SYNCID, id); } catch (e) {}
  }
  return id;
}
function setSyncId(id) { id = (id || "").trim(); if (validId(id)) { try { localStorage.setItem(LS_SYNCID, id); } catch (e) {} return true; } return false; }

// per-entry sync journal: { a: { normArtist: {ts,del} }, s: { songKey: {ts,del} } } - the active blocked/
// trashed maps hold the display text; this holds just the timestamps the merge needs.
var meta = (function () { try { var o = JSON.parse(localStorage.getItem(LS_META) || "{}"); if (!o || typeof o !== "object") o = {}; o.a = o.a || {}; o.s = o.s || {}; return o; } catch (e) { return { a: {}, s: {} }; } })();
function saveMeta() { try { localStorage.setItem(LS_META, JSON.stringify(meta)); } catch (e) {} }
function touchMeta(kind, key, del) { (meta[kind] || (meta[kind] = {}))[key] = { ts: Date.now(), del: del ? 1 : 0 }; saveMeta(); queueSync(); }
// give every pre-sync block/trash a low baseline ts (1) so any explicit remote change (a real Date.now ts)
// wins on first merge, while still uploading the local list to a fresh, empty sync code.
function backfillMeta() {
  var ch = false, k;
  for (k in blocked) if (blocked.hasOwnProperty(k) && !meta.a[k]) { meta.a[k] = { ts: 1, del: 0 }; ch = true; }
  for (k in trashed) if (trashed.hasOwnProperty(k) && !meta.s[k]) { meta.s[k] = { ts: 1, del: 0 }; ch = true; }
  if (ch) saveMeta();
}
function buildEntries() {
  var out = [], k;
  for (k in meta.a) if (meta.a.hasOwnProperty(k)) out.push({ kind: "a", key: k, val: blocked[k] || "", deleted: meta.a[k].del, ts: meta.a[k].ts });
  for (k in meta.s) if (meta.s.hasOwnProperty(k)) out.push({ kind: "s", key: k, val: trashed[k] || "", deleted: meta.s[k].del, ts: meta.s[k].ts });
  return out;
}
function pushAll() {
  if (!cloudOn()) return Promise.resolve(0);
  var entries = buildEntries(); if (!entries.length) return Promise.resolve(0);
  return fetch(SYNC_API + "/push?qz=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ syncId: getSyncId(), entries: entries }) })
    .then(function (r) { return r.json(); }).then(function (j) { return (j && j.upserted) || 0; }).catch(function () { return 0; });
}
// pull the FULL server state (a blocklist is small) and merge per-key last-writer-wins: a remote entry only
// wins where its ts is newer than ours. Applies both blocks and tombstones, then recomputes + re-renders.
function pullMerge() {
  return fetch(SYNC_API + "/pull?qz=1&syncId=" + encodeURIComponent(getSyncId()) + "&since=0")
    .then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !Array.isArray(j.entries)) return 0;
      var changed = false;
      j.entries.forEach(function (e) {
        if (e.kind !== "a" && e.kind !== "s") return;
        var m = meta[e.kind], active = (e.kind === "a") ? blocked : trashed, loc = m[e.key];
        if (loc && loc.ts >= e.ts) return; // local is same-or-newer -> keep it
        m[e.key] = { ts: e.ts, del: e.deleted ? 1 : 0 };
        if (e.deleted) { if (active[e.key] != null) { delete active[e.key]; changed = true; } }
        else { var v = e.val || e.key; if (active[e.key] !== v) { active[e.key] = v; changed = true; } }
      });
      saveMeta(); saveMap(A_KEY, blocked); saveMap(S_KEY, trashed);
      if (changed) afterChange(); else renderManager();
      return j.entries.length;
    }).catch(function () { return 0; });
}
var syncT = null;
function queueSync() { if (!cloudOn()) return; clearTimeout(syncT); syncT = setTimeout(pushAll, 4000); }
var pullTimer = null;
function startPull() { stopPull(); pullMerge(); pullTimer = setInterval(function () { if (cloudOn()) pullMerge(); }, 60000); }
function stopPull() { if (pullTimer) { clearInterval(pullTimer); pullTimer = null; } }
function enableCloud() { try { localStorage.setItem(LS_CLOUD, "1"); } catch (e) {} return pushAll().then(function (n) { startPull(); return n; }); }
function disableCloud() { try { localStorage.setItem(LS_CLOUD, "0"); } catch (e) {} stopPull(); }
function wipeCloud() { return fetch(SYNC_API + "/wipe?qz=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ syncId: getSyncId() }) }).then(function (r) { return r.json(); }).then(function (j) { return (j && j.deleted) || 0; }).catch(function () { return 0; }); }

// --- manager modal: see/manage the blocked + trashed lists, and the cloud-sync opt-in ---
var IC_MGR = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="20" y2="12"/><line x1="8" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1.4"/><circle cx="4" cy="12" r="1.4"/><circle cx="4" cy="18" r="1.4"/></svg>';
var IC_CLOUD = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 0 0 .4-8.98A6 6 0 0 0 6.2 9.5 4 4 0 0 0 7 17.9"/><path d="M7 17.9h10.5"/></svg>';
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
function mgrList(kind) {
  var map = (kind === "a") ? blocked : trashed;
  var ks = Object.keys(map).sort(function (a, b) { var x = (map[a] || "").toLowerCase(), y = (map[b] || "").toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; });
  if (!ks.length) return '<div class="qz-btm-empty">' + (kind === "a" ? "No blocked artists yet." : "No trashed songs yet.") + "</div>";
  return ks.map(function (k) { return '<div class="qz-btm-item"><span class="qz-btm-itxt" title="' + esc(map[k]) + '">' + esc(map[k]) + '</span><button class="qz-btm-x" data-kind="' + kind + '" data-key="' + esc(k) + '" title="' + (kind === "a" ? "Unblock" : "Restore") + '">&#215;</button></div>'; }).join("");
}
function renderManager() {
  var m = document.getElementById("qz-btm-modal"); if (!m) return;
  var la = m.querySelector('[data-list="a"]'); if (la) la.innerHTML = mgrList("a");
  var ls = m.querySelector('[data-list="s"]'); if (ls) ls.innerHTML = mgrList("s");
  var ca = m.querySelector('[data-count="a"]'); if (ca) ca.textContent = Object.keys(blocked).length;
  var cs = m.querySelector('[data-count="s"]'); if (cs) cs.textContent = Object.keys(trashed).length;
}
function closeManager() { var m = document.getElementById("qz-btm-modal"); if (m) m.remove(); }
function openManager() {
  closeManager();
  var on = cloudOn(), sid = getSyncId();
  var m = document.createElement("div"); m.id = "qz-btm-modal"; m.className = "qz-btm-modal";
  m.innerHTML = '<div class="qz-btm-box"><div class="qz-btm-h">' + IC_MGR + ' Blocked &amp; Trashed<button class="qz-btm-close" data-act="close" aria-label="Close">&#215;</button></div>' +
    '<div class="qz-btm-cols">' +
      '<div class="qz-btm-col"><div class="qz-btm-lbl">Blocked artists <span class="qz-btm-n" data-count="a">0</span></div><div class="qz-btm-list" data-list="a"></div></div>' +
      '<div class="qz-btm-col"><div class="qz-btm-lbl">Trashed songs <span class="qz-btm-n" data-count="s">0</span></div><div class="qz-btm-list" data-list="s"></div></div>' +
    '</div>' +
    '<div class="qz-btm-sync"><div class="qz-btm-synh">' + IC_CLOUD + ' Cloud sync</div>' +
      '<p class="qz-btm-p">Off by default - your lists stay only on this device. Turn it on to back them up and sync across devices. <b>Stored:</b> the artist names you block and the song titles you trash, plus a random sync code. No account, no name, nothing else about you.</p>' +
      '<div class="qz-btm-row"><span>Enable cloud sync</span><button class="qz-btm-sw' + (on ? " on" : "") + '" data-act="toggle"><span></span></button></div>' +
      '<div class="qz-btm-details" style="display:' + (on ? "block" : "none") + '"><div class="qz-btm-dlbl">Your sync code - paste it on another device to sync the same lists</div>' +
        '<div class="qz-btm-idrow"><code class="qz-btm-id">' + esc(sid) + '</code><button class="qz-btm-btn" data-act="copy">Copy</button></div>' +
        '<div class="qz-btm-status" data-status>&nbsp;</div>' +
        '<div class="qz-btm-actrow"><button class="qz-btm-btn" data-act="syncnow">Sync now</button><button class="qz-btm-btn ghost" data-act="usecode">Use a code</button><button class="qz-btm-btn ghost" data-act="wipe">Wipe cloud</button></div>' +
        '<div class="qz-btm-import" style="display:none"><input class="qz-btm-input" placeholder="paste a sync code"><button class="qz-btm-btn" data-act="loadcode">Load</button></div></div>' +
    '</div></div>';
  document.body.appendChild(m);
  renderManager();
  var setSt = function (t) { var s = m.querySelector("[data-status]"); if (s) s.textContent = t || " "; };
  m.addEventListener("mousedown", function (e) { if (e.target === m) closeManager(); });
  m.addEventListener("click", function (e) {
    var t = e.target, x = t.closest ? t.closest(".qz-btm-x") : null;
    if (x) { if (x.getAttribute("data-kind") === "a") unblockKey(x.getAttribute("data-key")); else restoreKey(x.getAttribute("data-key")); return; }
    var act = t.closest ? t.closest("[data-act]") : null; if (!act) return;
    switch (act.getAttribute("data-act")) {
      case "close": closeManager(); break;
      case "toggle":
        if (cloudOn()) { disableCloud(); act.classList.remove("on"); m.querySelector(".qz-btm-details").style.display = "none"; }
        else { act.classList.add("on"); m.querySelector(".qz-btm-details").style.display = "block"; setSt("Uploading your lists…"); enableCloud().then(function () { setSt("Backed up. Changes sync automatically."); }); }
        break;
      case "copy": try { navigator.clipboard.writeText(sid); } catch (e2) {} setSt("Copied sync code."); break;
      case "syncnow": setSt("Syncing…"); Promise.all([pushAll(), pullMerge()]).then(function (r) { setSt("Synced. " + r[1] + " entries from cloud."); }); break;
      case "usecode": { var im = m.querySelector(".qz-btm-import"); im.style.display = im.style.display === "none" ? "flex" : "none"; break; }
      case "loadcode":
        if (setSyncId(m.querySelector(".qz-btm-input").value)) { setSt("Pulling that code’s lists…"); pullMerge().then(function (n) { setSt("Loaded " + n + " entries."); var idc = m.querySelector(".qz-btm-id"); if (idc) idc.textContent = getSyncId(); }); }
        else setSt("That doesn’t look like a valid code.");
        break;
      case "wipe": setSt("Wiping cloud data…"); wipeCloud().then(function (n) { setSt("Wiped " + n + " entries from the cloud."); }); break;
    }
  });
}

// --- per-row trash button (slotted before the heart, both row types) ---
function handleRow(row) {
  var info = rowInfo(row); if (!info.title || !info.artist) return;
  var isB = artistBlocked(info.artist), isT = songTrashed(info.title, info.artist);
  row.classList.toggle("qz-bt-blocked", isB);
  row.classList.toggle("qz-bt-trashed", isT);
  row.classList.toggle("qz-bt-hit", isB || isT);
  var btn = row.querySelector(".qz-bt-rowtrash");
  if (!btn) {
    btn = document.createElement("button"); btn.type = "button"; btn.className = "qz-bt-b qz-bt-rowtrash"; btn.innerHTML = TRASH;
    btn.addEventListener("click", function (e) { stop(e); var ri = rowInfo(row); if (ri.title && ri.artist) toggleSong(ri.title, ri.artist); });
    // put it immediately before the row's heart / first trailing icon so it can't overlap the heart.
    var anchor = row.querySelector(".ButtonFavorite, [class*='avorite']") || row.querySelector(".ui-block-button-icon");
    if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(btn, anchor);
    else { row.classList.add("qz-bt-row"); btn.classList.add("qz-bt-abs"); row.appendChild(btn); } // fallback: absolute
  }
  btn.classList.toggle("on", isT); btn.title = isT ? "Restore this song" : "Trash this song";
}
function decorate() {
  var li = document.querySelectorAll(".ListItem");
  for (var i = 0; i < li.length; i++) if (li[i].querySelector(".ListItem__player")) handleRow(li[i]);
  var mt = document.querySelectorAll(".ui-module-track-row");
  for (var j = 0; j < mt.length; j++) handleRow(mt[j]);
}

// --- artist-profile block button (header action bar) ---
var artistName = {}; // id -> display name
function curArtistId() { try { var m = /^\/artist\/(\d+)/.exec(Q.getState().router.location.pathname || ""); return m ? m[1] : null; } catch (e) { return null; } }
function findArtistBar() {
  var rounds = document.querySelectorAll(".ui-block-button-round"); // the big header play button
  for (var i = 0; i < rounds.length; i++) { var r = rounds[i].getBoundingClientRect(); if (r.top > 60 && r.top < 460 && r.width > 30) return rounds[i].parentElement; }
  return null;
}
function resolveArtistName(id, cb) {
  if (artistName[id]) { cb(); return; }
  // a track row's artist link carries the real name; a bare a[href*="/artist/id"] can grab a "See all"
  // discography link instead, so scope to track rows and skip generic labels.
  var links = document.querySelectorAll('.ui-module-track-row a[href*="/artist/' + id + '"], .ListItem a[href*="/artist/' + id + '"]');
  for (var i = 0; i < links.length; i++) { var t = (links[i].textContent || "").trim(); if (t && !/^(see all|voir tout|alle|todo)$/i.test(t)) { artistName[id] = t; cb(); return; } }
  Q.api("artist/get?artist_id=" + id + "&limit=0").then(function (j) {
    var nm = j && (typeof j.name === "string" ? j.name : (j.name && j.name.display));
    if (nm) { artistName[id] = nm; cb(); }
  }).catch(function () {});
}
function syncArtistBtn(btn, id) {
  var name = artistName[id], on = name ? artistBlocked(name) : false;
  btn.classList.toggle("on", on);
  btn.title = name ? (on ? ("Unblock " + name) : ("Block " + name)) : "Block this artist";
}
function ensureArtistBtn() {
  var id = curArtistId();
  var existing = document.querySelector(".qz-bt-artistblock");
  if (!id) { if (existing) existing.remove(); return; }         // not an artist page -> no button
  var bar = findArtistBar(); if (!bar) return;
  var btn = bar.querySelector(".qz-bt-artistblock");
  if (!btn) {
    btn = document.createElement("button"); btn.type = "button"; btn.className = "qz-bt-artistblock"; btn.innerHTML = BAN;
    btn.addEventListener("click", function () { var nm = artistName[id]; if (nm) toggleArtist(nm); });
    bar.appendChild(btn);
  }
  resolveArtistName(id, function () { syncArtistBtn(btn, id); });
  syncArtistBtn(btn, id);
}

// --- player-bar trash (bins the currently-playing song) ---
var slotBtn = document.createElement("button");
slotBtn.className = "qz-pbtn qz-bt-slot"; slotBtn.type = "button"; slotBtn.title = "Trash the current song"; slotBtn.innerHTML = TRASH;
slotBtn.addEventListener("click", function () { var tr = safeTrack(); if (tr && tr.title && tr.artist) toggleSong(tr.title, tr.artist); });
var slot = Q.playerSlot({ id: "qz-bt", zone: "right", order: 11, el: slotBtn }); // right of the lyrics button (order 10)
function syncSlot() { var tr = safeTrack(); var on = tr && tr.title && songTrashed(tr.title, tr.artist); slotBtn.classList.toggle("on", !!on); slotBtn.title = on ? "Restore the current song" : "Trash the current song"; }

// player-bar manager button: opens the Blocked & Trashed list + cloud-sync opt-in
var mgrBtn = document.createElement("button");
mgrBtn.className = "qz-pbtn qz-bt-mgr"; mgrBtn.type = "button"; mgrBtn.title = "Blocked & trashed"; mgrBtn.innerHTML = IC_MGR;
mgrBtn.addEventListener("click", openManager);
var mgrSlot = Q.playerSlot({ id: "qz-bt-mgr", zone: "right", order: 12, el: mgrBtn });

// --- auto-skip: sealed engine, so click the native next button. Guard against a runaway if a whole queue
// is blocked (no more than a handful of skips in a short window). ---
function clickEl(sel) { var el = document.querySelector(sel); if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
function safeTrack() { try { return Q.player.getTrack(); } catch (e) { return null; } }
var skipLog = [], lastNextId = null, lastNextAt = 0, weForcedPause = false;
function safePlaying() { try { return !!(Q.player.isPlaying && Q.player.isPlaying()); } catch (e) { return false; } }
// Kill the sound. On a steady track PAUSE is instant (the common "trash the song I'm hearing" case, where
// `next` alone leaks a fraction of a second); at a track boundary the player ignores it for ~1s, so we keep
// trying until it takes. safePlaying() guard means we never toggle an already-paused player back to playing.
function killAudio() { if (safePlaying()) { clickEl(".pct-player-pause"); weForcedPause = true; } }
function enforce(tr) {
  if (!tr || tr.id == null) return;
  var id = String(tr.id);
  // decide on the id-level deny set (populated from the streaming API, so it's tear-proof) plus a live
  // artist check that also catches featured/guest artists the API's main-performer field misses.
  var list = (tr.artists && tr.artists.length) ? tr.artists : [tr.artist];
  if (!deny[id] && !anyBlocked(list)) {
    // landed on a good track. If our own pause left it paused (next-while-paused usually auto-resumes, but
    // guarantee it), resume - so we never leave playback stuck paused. Only un-pauses a pause WE caused.
    if (weForcedPause) { if (!safePlaying()) clickEl(".pct-player-play"); weForcedPause = false; }
    lastNextId = null;
    return;
  }
  var now = Date.now();
  // Retry by STATE, not by time. The player QUEUES next-clicks, so if we fire a second `next` while the
  // first is still being processed, both apply and we overshoot the good track after. So: fire next once
  // per track, then just keep killing the audio and WAIT for the id to actually change. Only re-fire if
  // it's been stuck unusually long (a genuinely dropped click). A distinct next trashed track has a new id,
  // so a blocked run still advances one-per-track with no wait.
  if (lastNextId === id && now - lastNextAt < 2000) { killAudio(); return; }
  skipLog = skipLog.filter(function (t) { return now - t < 10000; });
  if (skipLog.length >= 20) return; // ultimate backstop: a 100%-blocked queue stops here instead of spinning forever (audio is denied/paused, so it's silent either way)
  lastNextId = id; lastNextAt = now; skipLog.push(now);
  killAudio();
  clickEl(".pct-player-next");
}
// catch-all: a denied track can become (or stay) current without an onChange - clicked while already
// playing, restored on launch, stalled by the URL deny, or a skip whose `next` got absorbed. Poll and
// re-attempt (the per-id window above keeps this from stacking); the audio is already paused so retries
// are silent.
var watchdog = setInterval(function () {
  var tr = safeTrack(); if (!tr || tr.id == null) return;
  if (!metaCache[String(tr.id)]) resolveId(String(tr.id)); // make sure the current track is classified
  enforce(tr);
}, 350);

// --- toast ---
var toastEl = null, toastT = null;
function toast(msg) {
  if (!toastEl) { toastEl = document.createElement("div"); toastEl.className = "qz-bt-toast"; document.body.appendChild(toastEl); }
  toastEl.textContent = msg; toastEl.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(function () { if (toastEl) toastEl.classList.remove("show"); }, 1700);
}

Q.css(CSS_ID, [
  // row trash: revealed on row hover (and pinned on trashed rows), sized to match the native row icons.
  "#qz-sl-root .qz-bt-rowtrash{display:none;}",
  ".qz-bt-b{border:0;appearance:none;cursor:pointer;background:transparent;color:#aeb4be;display:inline-flex;align-items:center;justify-content:center;transition:color .12s,transform .1s,opacity .12s;}",
  ".qz-bt-rowtrash{width:26px;height:26px;border-radius:50%;opacity:0;flex:0 0 auto;margin-right:2px;}",
  ".ListItem:hover .qz-bt-rowtrash,.ui-module-track-row:hover .qz-bt-rowtrash,.qz-bt-rowtrash.on{opacity:1;}",
  ".qz-bt-rowtrash:hover{color:#fff;transform:scale(1.1);}",
  ".qz-bt-rowtrash.on{color:#e8892b;}",
  ".qz-bt-rowtrash.qz-bt-abs{position:absolute;right:88px;top:50%;transform:translateY(-50%);z-index:3;opacity:0;}",
  ".qz-bt-row{position:relative;} .ListItem.qz-bt-row:hover .qz-bt-abs{opacity:1;}",
  // artist-profile block button: matches the header icon buttons.
  // match the native header icon buttons (shuffle/follow/menu): borderless, icon-only, light grey.
  ".qz-bt-artistblock{border:0;appearance:none;background:transparent;color:#eef0f3;cursor:pointer;padding:0;display:inline-flex;align-items:center;justify-content:center;transition:color .12s,transform .1s;}",
  ".qz-bt-artistblock svg{width:24px;height:24px;}",
  ".qz-bt-artistblock:hover{color:#fff;transform:scale(1.1);}",
  ".qz-bt-artistblock.on{color:#e5484d;} .qz-bt-artistblock.on:hover{color:#f2575c;}",
  // player-bar trash active tint
  ".qz-bt-slot.on{color:#e8892b!important;}",
  // greyed state - dim/strike the title + fade the cover, buttons stay clickable
  ".qz-bt-hit .ListItem__title,.qz-bt-hit .cell-group-title span.ui-link{text-decoration:line-through;color:#868b95!important;}",
  ".qz-bt-hit img{opacity:.4;filter:grayscale(.4);}",
  ".qz-bt-hit .ListItem__player{opacity:.5;}",
  // toast
  ".qz-bt-toast{position:fixed;left:50%;bottom:98px;transform:translateX(-50%) translateY(8px);background:rgba(20,22,28,.97);color:#fff;",
  "padding:8px 16px;border-radius:11px;font:600 13px/1 system-ui,sans-serif;z-index:2147483600;opacity:0;pointer-events:none;",
  "transition:opacity .2s,transform .2s;box-shadow:0 10px 34px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.1);}",
  ".qz-bt-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}",
  // manager + cloud-sync modal (the qz-bt-mgr player-bar button inherits .qz-pbtn from the runtime)
  ".qz-btm-modal{position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(4,6,10,.62);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);-webkit-app-region:no-drag;}",
  ".qz-btm-box{width:min(560px,94vw);max-height:86vh;overflow:auto;background:linear-gradient(180deg,rgba(22,25,33,.98),rgba(13,15,21,.99));border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:18px 20px;box-shadow:0 30px 80px rgba(0,0,0,.6);color:#e7ebf2;}",
  ".qz-btm-h{display:flex;align-items:center;gap:9px;font-size:16px;font-weight:800;color:#eef2f7;}",
  ".qz-btm-h svg{color:var(--qz-accent,#3DA8FE);}",
  ".qz-btm-close{margin-left:auto;appearance:none;border:0;background:transparent;color:#98a2b3;font-size:22px;line-height:1;cursor:pointer;padding:0 2px;}.qz-btm-close:hover{color:#fff;}",
  ".qz-btm-cols{display:flex;gap:14px;margin:14px 0 4px;}",
  ".qz-btm-col{flex:1 1 0;min-width:0;}",
  ".qz-btm-lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#8b93a2;margin-bottom:7px;display:flex;align-items:center;gap:6px;}",
  ".qz-btm-n{background:rgba(255,255,255,.08);color:#c9d2df;border-radius:20px;padding:1px 7px;font-size:11px;font-weight:700;}",
  ".qz-btm-list{max-height:230px;overflow:auto;border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:5px;}",
  ".qz-btm-item{display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:7px;font-size:12.5px;}",
  ".qz-btm-item:hover{background:rgba(255,255,255,.05);}",
  ".qz-btm-itxt{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#dbe1ea;}",
  ".qz-btm-x{flex:0 0 auto;appearance:none;border:0;background:transparent;color:#7f8794;font-size:16px;line-height:1;cursor:pointer;width:22px;height:22px;border-radius:50%;}",
  ".qz-btm-x:hover{color:#fff;background:rgba(255,255,255,.1);}",
  ".qz-btm-empty{color:#6d7583;font-size:12px;padding:14px 8px;text-align:center;}",
  ".qz-btm-sync{margin-top:16px;border-top:1px solid rgba(255,255,255,.08);padding-top:14px;}",
  ".qz-btm-synh{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:800;color:#eef2f7;}.qz-btm-synh svg{color:var(--qz-accent,#3DA8FE);}",
  ".qz-btm-p{font-size:12px;color:#9aa3b2;line-height:1.55;margin:9px 0 11px;}.qz-btm-p b{color:#cbd3df;}",
  ".qz-btm-row{display:flex;align-items:center;justify-content:space-between;padding:8px 0;font-size:13px;}",
  ".qz-btm-sw{position:relative;width:42px;height:24px;border-radius:20px;border:0;background:rgba(255,255,255,.14);cursor:pointer;transition:background .16s;flex:0 0 auto;}",
  ".qz-btm-sw span{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .16s;}",
  ".qz-btm-sw.on{background:var(--qz-accent,#3DA8FE);}.qz-btm-sw.on span{left:21px;}",
  ".qz-btm-dlbl{font-size:11px;color:#8b93a2;margin:6px 0 5px;}",
  ".qz-btm-idrow{display:flex;gap:8px;align-items:center;}",
  ".qz-btm-id{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.09);border-radius:8px;padding:7px 9px;font:600 12px/1.2 ui-monospace,monospace;color:#cdd5e0;}",
  ".qz-btm-btn{appearance:none;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#dbe1ea;border-radius:8px;padding:7px 12px;font-size:12px;font-weight:600;cursor:pointer;-webkit-app-region:no-drag;}.qz-btm-btn:hover{background:rgba(255,255,255,.13);}.qz-btm-btn.ghost{background:transparent;}",
  ".qz-btm-status{font-size:11.5px;color:var(--qz-accent,#3DA8FE);min-height:16px;margin:8px 0 2px;}",
  ".qz-btm-actrow{display:flex;gap:8px;flex-wrap:wrap;}",
  ".qz-btm-import{margin-top:9px;gap:8px;}",
  ".qz-btm-input{flex:1 1 auto;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:7px 9px;color:#e7ebf2;font-size:12px;}"
].join(""));

var stopObs = Q.observe(function () { decorate(); ensureArtistBtn(); }, { debounce: 180 });
var offChange = Q.player.onChange(function (tr) { if (tr && tr.id != null) resolveId(String(tr.id)); resolveAhead(); checkQueueSwap(); enforce(tr); syncSlot(); });
ensureArtistBtn(); syncSlot(); (function () { var t = safeTrack(); if (t && t.id != null) resolveId(String(t.id)); })(); resolveAhead(); checkQueueSwap(); enforce(safeTrack());
backfillMeta(); if (cloudOn()) startPull(); // seed sync journal for pre-sync entries; resume pulling if opted in

return function cleanup() {
  disposed = true;
  if (aheadTimer) clearInterval(aheadTimer);
  if (watchdog) clearInterval(watchdog);
  stopPull(); clearTimeout(syncT); closeManager();
  if (window.fetch === hookedFetch) window.fetch = origFetch; // if a later wrapper owns it, `disposed` keeps us inert
  if (stopObs) stopObs(); if (offChange) offChange(); if (slot) slot.remove(); if (mgrSlot) mgrSlot.remove();
  [].slice.call(document.querySelectorAll(".qz-bt-rowtrash,.qz-bt-artistblock")).forEach(function (n) { n.remove(); });
  [].slice.call(document.querySelectorAll(".qz-bt-hit,.qz-bt-row")).forEach(function (n) { n.classList.remove("qz-bt-hit", "qz-bt-row", "qz-bt-blocked", "qz-bt-trashed"); });
  if (toastEl) { toastEl.remove(); toastEl = null; }
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
