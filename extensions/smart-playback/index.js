// A real fix for Qobuz's weak autoplay. Runs as function(Qobuzify).
//
// The queue and autoplay live in a sealed player module that injected JS can't reach, so there's
// no way to quietly swap out its picks. So instead of fighting it: one click builds a genuinely
// related set from whatever's playing - the current artist plus similar artists' top tracks,
// weighted toward your favorites and deduped against what you've heard recently - drops it into a
// fresh "Qobuzify Radio" playlist, and plays that through Qobuz's own UI. The old radio playlist
// gets deleted right after, so the library only ever holds one of them, and minting a fresh id
// each run sidesteps Qobuz's playlist-content cache. Nothing leaves the app, no external services.
var Q = Qobuzify;
var CSS_ID = "qz-radio-css";
var PLAYLIST_NAME = "Qobuzify Radio";
var LS_PID = "smart:pid";
var building = false, favCache = null;

function api(p) { return Q.api(p); } // GET; Qobuz playlist writes are GET too
function cmap(items, n, fn) {
  return new Promise(function (resolve) {
    var out = new Array(items.length), i = 0, done = 0, running = 0;
    if (!items.length) return resolve(out);
    function next() { while (running < n && i < items.length) { (function (idx) { running++; Promise.resolve(fn(items[idx], idx)).then(function (r) { out[idx] = r; }, function () { out[idx] = null; }).then(function () { running--; if (++done === items.length) resolve(out); else next(); }); })(i++); } }
    next();
  });
}

// --- data ---
function similarArtists(id) { return api("artist/getSimilarArtists?artist_id=" + id + "&limit=15").then(function (j) { return (j.artists && j.artists.items) || []; }).catch(function () { return []; }); }
// artist/get&extra=tracks is NOT ranked by plays - it lists the newest release first and repeats it once
// per album variant, so a radio seeded from it kept serving the same handful of brand-new tracks. artist/page
// is the route Qobuz's own clients use for "Most listened to". It speaks the newer track shape, so map the
// two fields the picker below actually reads (id, streamable) back onto the legacy names, and fall back to
// the old call if the route is unavailable.
function artistTopTracks(id) {
  return api("artist/page?artist_id=" + id).then(function (p) {
    var tt = (p && p.top_tracks) || []; if (!tt.length) throw new Error("no top_tracks");
    return tt.slice(0, 12).map(function (t) { return { id: t.id, title: t.title, streamable: !(t.rights && t.rights.streamable === false) }; });
  }).catch(function () {
    return api("artist/get?artist_id=" + id + "&extra=tracks&limit=12").then(function (j) { var t = j.tracks; return (t && (t.items || t)) || []; }).catch(function () { return []; });
  });
}
function favSets() {
  if (favCache) return Promise.resolve(favCache);
  return Promise.all([
    api("favorite/getUserFavorites?type=artists&limit=200").then(function (j) { return (j.artists && j.artists.items) || []; }).catch(function () { return []; }),
    api("favorite/getUserFavorites?type=tracks&limit=200").then(function (j) { return (j.tracks && j.tracks.items) || []; }).catch(function () { return []; })
  ]).then(function (r) { var A = {}, T = {}; r[0].forEach(function (a) { A[a.id] = 1; }); r[1].forEach(function (t) { T[t.id] = 1; }); favCache = { artists: A, tracks: T }; return favCache; });
}

// current track's seed artist. track/get's performer is the authoritative identity - the player
// bar's first /artist/ anchor can be a featured or same-named artist and lags on track change,
// so the DOM link is only a last resort when the store has no id or the API call fails.
function currentSeed() {
  function fromBar() {
    var bar = document.querySelector(".player");
    var a = bar && bar.querySelector('a[href*="/artist/"]');
    if (!a) return null;
    var m = (a.getAttribute("href") || "").match(/\/artist\/(\d+)/);
    return m ? { id: m[1], name: (a.textContent || "").trim() || "this artist" } : null;
  }
  var ct = Q.getState().player.currentTrack;
  if (!ct || !ct.id) return Promise.resolve(fromBar());
  return api("track/get?track_id=" + ct.id).then(function (j) { var p = j.performer || (j.album && j.album.artist); return p && p.id ? { id: p.id, name: p.name || "this artist" } : fromBar(); }).catch(function () { return fromBar(); });
}

// Seed from a SPECIFIC track (right-click -> Start song radio) instead of whatever is playing. track/get's
// performer is the authoritative artist for that recording, so clicking a featured or compilation row seeds
// the artist actually credited on it rather than the album's headline act.
function seedFromTrack(trackId, fallbackName) {
  return api("track/get?track_id=" + trackId).then(function (j) {
    var p = j.performer || (j.album && j.album.artist);
    return p && p.id ? { id: p.id, name: p.name || fallbackName || "this artist" } : null;
  }).catch(function () { return null; });
}

// --- the radio engine ---
// leadTrackId (song radio) pins that track to the front of the result and keeps it from being drawn again.
function buildRadio(seed, leadTrackId) {
  return Promise.all([similarArtists(seed.id), favSets()]).then(function (res) {
    var sims = res[0], fav = res[1];
    sims.sort(function (a, b) { return (fav.artists[b.id] ? 1 : 0) - (fav.artists[a.id] ? 1 : 0) || (Math.random() - 0.5); });
    var pool = [{ id: seed.id, name: seed.name, seed: true }].concat(sims.slice(0, 12).map(function (a) { return { id: a.id, name: a.name }; }));
    return cmap(pool, 5, function (a) { return artistTopTracks(a.id).then(function (tr) { return { seed: a.seed, tracks: tr }; }); });
  }).then(function (lists) {
    var st = Q.getState();
    var curId = st.player.currentTrack && st.player.currentTrack.id;
    var hist = (st.playqueue && st.playqueue.history) || [];
    var exclude = {}; if (curId) exclude[curId] = 1; hist.slice(-60).forEach(function (id) { exclude[id] = 1; });
    // the song-radio seed leads the list, so bar it from the picker (it would otherwise land mid-queue as a
    // duplicate) and un-exclude it from the recent-history filter - you just asked for it on purpose.
    if (leadTrackId) exclude[leadTrackId] = 1;
    var seen = {};
    function take(tracks, n) { var out = []; for (var i = 0; i < tracks.length && out.length < n; i++) { var t = tracks[i]; if (!t || !t.id || t.streamable === false) continue; if (exclude[t.id] || seen[t.id]) continue; seen[t.id] = 1; out.push(t.id); } return out; }
    var buckets = lists.filter(Boolean);
    buckets.sort(function (a, b) { return (b.seed ? 1 : 0) - (a.seed ? 1 : 0); });
    var head = buckets[0] ? take(buckets[0].tracks, 3) : [];           // lead with the current artist
    var perBucket = buckets.map(function (b) { return take(b.tracks, b.seed ? 4 : 3); });
    var rr = [], i = 0, any = true;                                    // round-robin the rest, interleaved
    while (any && head.length + rr.length < 46) { any = false; for (var b = 0; b < perBucket.length; b++) { if (perBucket[b][i] != null) { rr.push(perBucket[b][i]); any = true; } } i++; }
    var ids = [], dd = {};
    if (leadTrackId) { dd[leadTrackId] = 1; ids.push(leadTrackId); }   // the song you picked plays first
    head.concat(rr).forEach(function (id) { if (!dd[id]) { dd[id] = 1; ids.push(id); } });
    return ids.slice(0, 46);
  });
}

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

// --- playlist plumbing (fresh playlist each run) ---
// LS_PID holds the id of the radio in use (its genCapture record sits under "gen:smart:pid"). Older radios go
// through LS_PENDING, a persisted delete queue drained a few seconds after each run and again at boot, so
// quitting inside that delay (or a failed delete) can't orphan one. LS_PID only moves on once the old record
// is safely in that queue.
var LS_PENDING = "smart:pendingDel";
var PENDING_MAX_TRIES = 5;
var pendingT = null, draining = false;
function createPlaylist(desc) { return api("playlist/create?name=" + encodeURIComponent(PLAYLIST_NAME) + "&is_public=false&description=" + encodeURIComponent(desc)).then(function (c) { return String(c.id); }); }
function fillPlaylist(pid, ids) { return api("playlist/addTracks?playlist_id=" + pid + "&track_ids=" + ids.join(",")); }
function readPending() { try { var a = JSON.parse(Q.storage.get(LS_PENDING, "[]")); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function writePending(a) { try { Q.storage.set(LS_PENDING, JSON.stringify(a)); } catch (e) {} }
function queueDelete(raw) {
  var rec = genParse(raw); if (!rec) return;
  var a = readPending();
  if (!a.some(function (x) { return x && String(x.pid) === rec.pid; })) { a.push(rec); writePending(a); }
}
function drainPending() {
  if (draining) return Promise.resolve();
  try { if (!Q.getState().user.token) return Promise.resolve(); } catch (e) { return Promise.resolve(); }
  var list = readPending(); if (!list.length) return Promise.resolve();
  draining = true;
  var curPid = Q.storage.get(LS_PID, null);
  return list.reduce(function (p, item) {
    return p.then(function () {
      var pid = item && item.pid != null ? String(item.pid) : null;
      function drop() { writePending(readPending().filter(function (x) { return !(x && String(x.pid) === pid); })); }
      var rec = genParse(item);
      if (!rec || (curPid != null && String(curPid) === rec.pid)) { drop(); return; }   // malformed, or the radio in use
      return genDelete(rec).then(drop, function () {
        // transient failure: keep it for the next drain, but give up after a few so a dead entry can't live forever
        var a = readPending();
        a.forEach(function (x) { if (x && String(x.pid) === pid) x.tries = (x.tries || 0) + 1; });
        writePending(a.filter(function (x) { return !(x && String(x.pid) === pid && x.tries >= PENDING_MAX_TRIES); }));
      });
    });
  }, Promise.resolve()).then(function () { draining = false; }, function () { draining = false; });
}
// Same visibility-checked header Play as better-search's headerPlayBtn(): a loose first-.ButtonRoundPrimary
// match can be a hidden For You card's button or the previous page's header mid-transition.
function headerPlayBtn() {
  var cands = document.querySelectorAll("[class*='PageHeader'] button[aria-label='Play'], button[aria-label='Play'].ButtonRoundPrimary--large");
  for (var i = 0; i < cands.length; i++) { var r = cands[i].getBoundingClientRect(); if (cands[i].offsetParent && r.width > 4 && r.height > 4) return cands[i]; }
  return null;
}
function playPlaylist(pid) {
  Q.navigate("/playlist/" + pid);
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    var onPage = (Q.getState().router.location.pathname || "").indexOf("/playlist/" + pid) >= 0;
    var btn = onPage ? headerPlayBtn() : null;
    if (btn) { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); clearInterval(iv); }
    else if (tries > 50) clearInterval(iv);
  }, 140);
}

// --- orchestrator ---
// opts (all optional) = { trackId, title, artist }. With a trackId this is a SONG radio: seeded from that
// recording's performer, with the track itself first. Without one it is the player-bar behaviour - seed
// from whatever is playing. Either way exactly one "Qobuzify Radio" playlist is kept.
function smartRadio(opts) {
  if (building) return;
  opts = opts || {};
  var seedTrack = opts.trackId ? String(opts.trackId) : null;
  building = true; setBusy(true);
  (seedTrack ? seedFromTrack(seedTrack, opts.artist) : currentSeed()).then(function (seed) {
    if (!seed) { toast(seedTrack ? "Couldn't read that track" : "Play a track first, then hit Smart Radio"); throw "no-seed"; }
    var what = seedTrack ? (opts.title || "that track") : seed.name;
    toast("Building a radio from " + what + "…");
    return buildRadio(seed, seedTrack).then(function (ids) {
      if (!ids.length) { toast("Couldn't build a radio for this track"); throw "empty"; }
      var desc = (seedTrack ? "Song radio - tracks like " : "Smart Radio - tracks like ") + what;
      return createPlaylist(desc).then(function (pid) {
        return fillPlaylist(pid, ids).then(function () {
          return genCapture(pid, PLAYLIST_NAME, desc, ids.length);
        }, function (err) {
          // the fill failed: don't leave an empty (or half-filled) radio behind. Record what is there now and
          // delete it through the queue, so a failed delete is retried at the next boot.
          return genCapture(pid, PLAYLIST_NAME, desc, 0).then(function (rec) { queueDelete(rec); drainPending(); throw err; });
        }).then(function (rec) { return { rec: rec, pid: pid, count: ids.length, name: what }; });
      });
    });
  }).then(function (r) {
    // hand the previous radio to the persisted delete queue BEFORE smart:pid moves on, so the library keeps
    // exactly one "Qobuzify Radio" even if the app quits inside the delay below
    var old = genLoad(LS_PID);
    if (old && old.pid !== String(r.pid)) queueDelete(old);
    genStore(LS_PID, r.rec);
    toast("▶ " + (seedTrack ? "Song radio" : "Smart Radio") + " - " + r.count + " tracks like " + r.name);
    playPlaylist(r.pid);
    // delete the previous radio once the new one is playing (genDelete skips it if the user changed it)
    clearTimeout(pendingT); pendingT = setTimeout(drainPending, 7000);
  }).catch(function (e) { if (e !== "no-seed" && e !== "empty") toast("Smart Radio failed - try again"); })
    .then(function () { building = false; setBusy(false); });
}

// --- player-bar button ---
function setBusy(on) { var b = document.getElementById("qz-radio-btn"); if (b) b.classList.toggle("qz-radio-busy", !!on); }

// --- toast ---
// one toast at a time: a new message replaces the last one
var curToast = null;
function toast(msg) {
  if (curToast) curToast.close();
  curToast = Q.ui.toast(msg, { timeout: 2600 });
}

Q.css(CSS_ID, [
  ".qz-radio-busy{pointer-events:none;animation:qz-radio-spin 1s linear infinite;opacity:.85;}",
  "@keyframes qz-radio-spin{to{transform:rotate(360deg)}}",
  // the one-item box is appended to <body> and follows Qobuz's appearance (Q.ui.follow)
  ".qz-radio-menu{position:fixed;z-index:2147483600;min-width:186px;padding:6px;box-sizing:border-box;",
  "background:var(--qzu-surface);color:var(--qzu-fg);border:1px solid var(--qzu-line);",
  "border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.35);}",
  ".qz-radio-item{display:block;width:100%;text-align:left;appearance:none;border:0;background:transparent;color:inherit;",
  "font:inherit;font-size:13px;font-weight:550;padding:9px 11px;border-radius:8px;cursor:pointer;transition:background .12s,color .12s;}",
  ".qz-radio-item:hover{background:color-mix(in srgb,var(--qz-accent,#3DA8FE) 18%,transparent);color:var(--qz-accent,#3DA8FE);}",
  // make the song progress bar actually visible without clipping. Qobuz's default is
  // a thin top-edge line; we give it a real track plus an accent-coloured played fill
  // (don't set appearance:none on the <progress> or the fill pseudo stops rendering).
  // the grab zone and thumb hang downward from the bar so nothing pokes above the
  // player's top edge, which gets clipped. the thumb only shows on hover.
  ".player__progressbar{height:6px !important;background:color-mix(in srgb,currentColor 17%,transparent) !important;border-radius:3px;}",
  ".player__progressbar .player__progressbar__buffer{height:100% !important;background:color-mix(in srgb,currentColor 13%,transparent) !important;border-radius:3px;}",
  ".player__progressbar > progress{height:100% !important;border:0 !important;border-radius:3px;background:transparent !important;}",
  ".player__progressbar > progress::-webkit-progress-bar{background:transparent !important;}",
  ".player__progressbar > progress::-webkit-progress-value{background:var(--qz-accent,#3DA8FE) !important;border-radius:3px;}",
  ".player__progressbar input[type=range]{position:absolute !important;left:0;top:0 !important;transform:none !important;width:100%;height:18px !important;margin:0 !important;padding:0;cursor:pointer;-webkit-appearance:none;background:transparent;z-index:6;}",
  ".player__progressbar input[type=range]::-webkit-slider-runnable-track{background:transparent;border:0;height:18px;}",
  ".player__progressbar input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 0 0 1px var(--qz-accent,#3DA8FE),0 1px 5px rgba(0,0,0,.6);opacity:0;transition:opacity .14s ease;}",
  ".player:hover .player__progressbar input[type=range]::-webkit-slider-thumb{opacity:1;}"
].join(""));

var b = document.createElement("button");
b.id = "qz-radio-btn"; b.className = "qz-pbtn";
b.title = "Smart Radio - play tracks like the current one";
b.setAttribute("aria-label", "Smart Radio");
b.innerHTML = '<span class="icon-magic-stars"></span>';
b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); smartRadio(); });
var slot = Q.playerSlot({ id: "smart-radio", zone: "left", order: 20, el: b, label: "Smart Radio" });

// --- right-click a track row -> "Start song radio" -------------------------------------------------
// Resolving a row to a track id is the same two-case problem multi-select solved: a dwp track row's DOM id
// is "<trackId>[_<playlistTrackId>]__actions", while the web player's library rows carry no id at all and
// have to be matched back to the store's track dictionary by title + main artist.
function norm(s) { return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[‘’'`]/g, "").replace(/\s+/g, " ").trim(); }
function titleCore(s) { return norm(s).replace(/\((?:feat|with|ft|prod)\.?[^)]*\)/g, "").replace(/\s*[-–—][^-–—]*$/, "").replace(/\s+/g, " ").trim(); }
function dictArtist(t) {
  try {
    var it = t.interpreters;
    if (typeof it === "string") it = JSON.parse(it);
    if (it && it.length) {
      var main = it.filter(function (x) { return x.roles && x.roles.indexOf("main-artist") >= 0; })[0] || it[0];
      var nm = main && main.name;
      return (nm && (nm.display || nm)) || "";
    }
  } catch (e) {}
  return (t.performer && t.performer.name) || (t.artist && t.artist.name) || "";
}
var dictMap = null, dictAt = 0;
function dictIds() {
  var now = Date.now();
  if (dictMap && now - dictAt < 1500) return dictMap;   // the dictionary grows as rows render; short cache
  var m = {};
  try {
    var d = Q.getState().dictionnary.tracks.data || {};
    for (var id in d) {
      var t = d[id]; if (!t || !t.title) continue;
      var k = titleCore(t.title) + "|" + norm(dictArtist(t));
      if (m[k] == null) m[k] = String(t.id != null ? t.id : id);
    }
  } catch (e) {}
  dictMap = m; dictAt = now; return m;
}
function rowTrackId(row) {
  var id = row && row.id ? String(row.id) : "";
  if (/__actions$/.test(id)) { var m = id.match(/^(\d+)_/); return m ? m[1] : null; }
  var te = row.querySelector(".typo-main-default-m") || row.querySelector('[class*="typo-main-default"]') || row.querySelector(".ListItem__title, .track-name");
  var title = te ? te.textContent.trim() : ""; if (!title) return null;
  var ae = row.querySelector('a[href*="/artist/"]');
  return dictIds()[titleCore(title) + "|" + norm(ae ? ae.textContent.trim() : "")] || null;
}
// What the right-click resolved to, or null. Shared with copy-share (see the hook below).
function songSeedFromEvent(e) {
  var row = e.target.closest && e.target.closest(".ListItem, .track-item, .ui-module-track-row");
  if (!row) return null;
  var tid = rowTrackId(row); if (!tid) return null;
  var te = row.querySelector(".ListItem__title, .track-name, .ListItem__titleWithArtists, .typo-main-default-m");
  var ae = row.querySelector('a[href*="/artist/"]');
  return { trackId: tid, title: te ? te.textContent.trim() : "", artist: ae ? ae.textContent.trim() : "" };
}
function songRadio(seed) { if (seed && seed.trackId) smartRadio(seed); }

// This listener is deliberately BUBBLE phase. On the desktop app copy-share owns the right-click on track rows
// and cancels the event during capture, so this never fires there (no two menus fighting) - it offers the same
// action inside its own menu through the published hook instead. Everywhere else (the web player's rows, or
// copy-share off) the item goes into Qobuz's own track menu, with a one-item box only when no menu opens.
function removeRadioMenu() {
  var m = document.getElementById("qz-radio-menu"); if (m) m.remove();
  document.removeEventListener("mousedown", onRadioDocDown, true);
  document.removeEventListener("keydown", onRadioEsc, true);
  document.removeEventListener("scroll", removeRadioMenu, true);
  window.removeEventListener("blur", removeRadioMenu);
}
function onRadioDocDown(e) { var m = document.getElementById("qz-radio-menu"); if (m && !m.contains(e.target)) removeRadioMenu(); }
function onRadioEsc(e) { if (e.key === "Escape") removeRadioMenu(); }
function showRadioBox(x, y, seed) {
  removeRadioMenu();
  var m = document.createElement("div"); m.id = "qz-radio-menu"; m.className = "qz-radio-menu";
  Q.ui.follow(m);
  var b = document.createElement("button"); b.className = "qz-radio-item"; b.textContent = "Start song radio";
  b.addEventListener("click", function (ev) { ev.stopPropagation(); removeRadioMenu(); songRadio(seed); });
  m.appendChild(b);
  m.style.visibility = "hidden"; document.body.appendChild(m);
  m.style.left = Math.min(x, window.innerWidth - m.offsetWidth - 8) + "px";
  m.style.top = Math.min(y, window.innerHeight - m.offsetHeight - 8) + "px";
  m.style.visibility = "";
  setTimeout(function () {
    document.addEventListener("mousedown", onRadioDocDown, true);
    document.addEventListener("keydown", onRadioEsc, true);
    document.addEventListener("scroll", removeRadioMenu, true);
    window.addEventListener("blur", removeRadioMenu);
  }, 0);
}
// The web player opens its OWN track menu on right-click (a React portal that is already in the DOM by the time
// this bubble-phase listener runs), so the box above used to appear next to it: two menus at once. Put the item
// INSIDE Qobuz's menu instead, cloned from its "Play next" row so it is native in everything but label and icon.
// Found by Qobuz's row keys (ui-base-menu--item-row--<key>), never by English labels, so any UI language works.
function nativeTrackMenu() {
  var box = document.querySelector(".ui-base-menu--item-row--items");
  return box && box.querySelector('[class*="ui-base-menu--item-row--add-to-queue"], [class*="ui-base-menu--item-row--play-next"]') ? box : null;
}
function injectNativeItem(box, seed) {
  if (box.querySelector(".qz-radio-native")) return true;
  var ref = box.querySelector('[class*="ui-base-menu--item-row--play-next"]') || box.querySelector('[class*="ui-base-menu--item-row--add-to-queue"]');
  if (!ref) return false;
  var item = ref.cloneNode(true);
  // drop the row-key classes so nothing keyed on "play-next" can take the clone for that action
  item.className = String(item.className).replace(/\bui-base-menu--item-row--[a-z0-9-]+/g, "").replace(/\s+/g, " ").trim() + " qz-radio-native";
  var lab = item.querySelector(".typo-main-default-m") || item.querySelector('[class*="typo-main"]');
  if (lab) { lab.textContent = "Start song radio"; lab.className = String(lab.className).replace(/\bui-(base-tooltip|float)--[a-z0-9-]+/g, "").replace(/\s+/g, " ").trim(); }
  [].forEach.call(item.querySelectorAll("use"), function (u) {   // Qobuz's own sprite has a radio glyph
    var h = (u.getAttribute("href") || u.getAttribute("xlink:href") || "").replace(/#.*$/, "#qobuz-icon-radio");
    u.setAttribute("href", h); try { u.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", h); } catch (e) {}
  });
  // Stopped on the item itself, so the click never bubbles to React's root: the clone cannot fire "Play next".
  // Escape is Qobuz's own close path for this menu.
  item.addEventListener("click", function (ev) {
    ev.preventDefault(); ev.stopPropagation();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    songRadio(seed);
  }, true);
  ref.parentNode.insertBefore(item, ref.nextSibling);
  return true;
}
function onRadioContext(e) {
  if (e.target.closest && e.target.closest(".qz-slot-left, .qz-slot-right, [data-qz-slot]")) return;
  var seed = songSeedFromEvent(e); if (!seed) return;
  e.preventDefault(); e.stopPropagation();
  removeRadioMenu();
  var box = nativeTrackMenu();
  if (box && injectNativeItem(box, seed)) return;
  // No native menu yet: give a slower page a few frames, and only then fall back to our own one-item box
  // (the desktop app with copy-share switched off opens no menu at all).
  var x = e.clientX, y = e.clientY, t0 = Date.now();
  (function wait() {
    var b = nativeTrackMenu();
    if (b && injectNativeItem(b, seed)) return;
    if (Date.now() - t0 < 250) { requestAnimationFrame(wait); return; }
    showRadioBox(x, y, seed);
  })();
}
document.addEventListener("contextmenu", onRadioContext, false);

// Publish the engine so a host with its own UI can use it. The button above lives on the DESKTOP player
// bar, so on Android (where mobile-app draws its own interface over that bar) this extension was loaded,
// working, and completely unreachable: the phone's Radio button ran mobile-app's plainer builder instead,
// with no favourites weighting, no dedupe and no recent-play exclusion. mobile-app now prefers this when
// the extension is enabled. buildRadio takes {id,name} and resolves track ids; smartRadio() is the whole
// flow including the playlist write and playback.
// songRadio + seedFromEvent are what copy-share reads to put "Start song radio" in the menu it already owns.
window.__qzSmartRadio = { buildRadio: buildRadio, run: smartRadio, seedFromCurrent: currentSeed, songRadio: songRadio, seedFromEvent: songSeedFromEvent };

// retry any radio deletes left over from a previous session (quit inside the delay, or a failed delete)
var bootDrainT = setTimeout(drainPending, 8000);

return function cleanup() {
  // pending deletes stay persisted for the next boot
  clearTimeout(bootDrainT); clearTimeout(pendingT);
  try { if (window.__qzSmartRadio && window.__qzSmartRadio.run === smartRadio) delete window.__qzSmartRadio; } catch (e) {}
  document.removeEventListener("contextmenu", onRadioContext, false);
  removeRadioMenu();
  if (slot) slot.remove();
  if (curToast) curToast.close();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
