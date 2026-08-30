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

// --- playlist plumbing (fresh playlist each run) ---
function createPlaylist(desc) { return api("playlist/create?name=" + encodeURIComponent(PLAYLIST_NAME) + "&is_public=false&description=" + encodeURIComponent(desc || "Qobuzify Smart Radio")).then(function (c) { return String(c.id); }); }
function fillPlaylist(pid, ids) { return api("playlist/addTracks?playlist_id=" + pid + "&track_ids=" + ids.join(",")); }
function deletePlaylist(pid) { return api("playlist/delete?playlist_id=" + pid).catch(function () {}); }
function playPlaylist(pid) {
  Q.navigate("/playlist/" + pid);
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    var onPage = (Q.getState().router.location.pathname || "").indexOf("/playlist/" + pid) >= 0;
    var btn = document.querySelector(".PageHeader .ButtonRoundPrimary, .ButtonRoundPrimary");
    if (onPage && btn) { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); clearInterval(iv); }
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
      return createPlaylist((seedTrack ? "Song radio - tracks like " : "Smart Radio - tracks like ") + what).then(function (pid) {
        return fillPlaylist(pid, ids).then(function () { return { pid: pid, count: ids.length, name: what }; });
      });
    });
  }).then(function (r) {
    var oldPid = Q.storage.get(LS_PID, null);
    Q.storage.set(LS_PID, r.pid);
    toast("▶ " + (seedTrack ? "Song radio" : "Smart Radio") + " - " + r.count + " tracks like " + r.name);
    playPlaylist(r.pid);
    // delete the previous radio playlist once the new one is playing, so the
    // library keeps exactly one "Qobuzify Radio"
    if (oldPid && oldPid !== r.pid) setTimeout(function () { deletePlaylist(oldPid); }, 7000);
  }).catch(function (e) { if (e !== "no-seed" && e !== "empty") toast("Smart Radio failed - try again"); })
    .then(function () { building = false; setBusy(false); });
}

// --- player-bar button ---
function setBusy(on) { var b = document.getElementById("qz-radio-btn"); if (b) b.classList.toggle("qz-radio-busy", !!on); }

// --- toast ---
var toastT = null;
function toast(msg) {
  var t = document.getElementById("qz-radio-toast");
  if (!t) { t = document.createElement("div"); t.id = "qz-radio-toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("qz-show");
  clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove("qz-show"); }, 2600);
}

Q.css(CSS_ID, [
  ".qz-radio-busy{pointer-events:none;animation:qz-radio-spin 1s linear infinite;opacity:.85;}",
  "@keyframes qz-radio-spin{to{transform:rotate(360deg)}}",
  "#qz-radio-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%) translateY(12px);z-index:2147483600;",
  "max-width:min(440px,80vw);padding:11px 18px;border-radius:24px;font-size:13.5px;font-weight:600;color:#06090a;",
  "background:var(--qz-accent,#3DA8FE);box-shadow:0 16px 44px -12px rgba(0,0,0,.6),0 0 30px -10px var(--qz-accent,#3DA8FE);",
  "opacity:0;pointer-events:none;transition:opacity .2s ease,transform .2s ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  "#qz-radio-toast.qz-show{opacity:1;transform:translateX(-50%) translateY(0);}",
  ".qz-radio-menu{position:fixed;z-index:2147483600;min-width:186px;padding:6px;",
  "background:linear-gradient(180deg,rgba(22,25,33,.98),rgba(13,15,21,.99));border:1px solid rgba(255,255,255,.12);",
  "border-radius:12px;box-shadow:0 24px 70px rgba(0,0,0,.6),0 0 40px -22px var(--qz-accent,#3DA8FE);}",
  ".qz-radio-item{display:block;width:100%;text-align:left;appearance:none;border:0;background:transparent;color:#e7ecf3;",
  "font:inherit;font-size:13px;font-weight:550;padding:9px 11px;border-radius:8px;cursor:pointer;transition:background .12s,color .12s;}",
  ".qz-radio-item:hover{background:color-mix(in srgb,var(--qz-accent,#3DA8FE) 18%,transparent);color:var(--qz-accent,#3DA8FE);}",
  // make the song progress bar actually visible without clipping. Qobuz's default is
  // a thin top-edge line; we give it a real track plus an accent-coloured played fill
  // (don't set appearance:none on the <progress> or the fill pseudo stops rendering).
  // the grab zone and thumb hang downward from the bar so nothing pokes above the
  // player's top edge, which gets clipped. the thumb only shows on hover.
  ".player__progressbar{height:6px !important;background:rgba(255,255,255,.17) !important;border-radius:3px;}",
  ".player__progressbar .player__progressbar__buffer{height:100% !important;background:rgba(255,255,255,.13) !important;border-radius:3px;}",
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
b.innerHTML = '<span class="icon-magic-stars"></span>';
b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); smartRadio(); });
var slot = Q.playerSlot({ id: "smart-radio", zone: "left", order: 20, el: b });

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

// This listener is deliberately BUBBLE phase. copy-share owns the right-click on track rows and cancels the
// event during capture, so when it is enabled this never fires (no two menus fighting) - it offers the same
// action inside its own menu through the published hook instead. With copy-share off nothing stops the
// event and this one-item menu is the whole feature.
function removeRadioMenu() {
  var m = document.getElementById("qz-radio-menu"); if (m) m.remove();
  document.removeEventListener("mousedown", onRadioDocDown, true);
  document.removeEventListener("keydown", onRadioEsc, true);
  document.removeEventListener("scroll", removeRadioMenu, true);
  window.removeEventListener("blur", removeRadioMenu);
}
function onRadioDocDown(e) { var m = document.getElementById("qz-radio-menu"); if (m && !m.contains(e.target)) removeRadioMenu(); }
function onRadioEsc(e) { if (e.key === "Escape") removeRadioMenu(); }
function onRadioContext(e) {
  if (e.target.closest && e.target.closest(".qz-slot-left, .qz-slot-right, [data-qz-slot]")) return;
  var seed = songSeedFromEvent(e); if (!seed) return;
  e.preventDefault(); e.stopPropagation();
  removeRadioMenu();
  var m = document.createElement("div"); m.id = "qz-radio-menu"; m.className = "qz-radio-menu";
  var b = document.createElement("button"); b.className = "qz-radio-item"; b.textContent = "Start song radio";
  b.addEventListener("click", function (ev) { ev.stopPropagation(); removeRadioMenu(); songRadio(seed); });
  m.appendChild(b);
  m.style.visibility = "hidden"; document.body.appendChild(m);
  m.style.left = Math.min(e.clientX, window.innerWidth - m.offsetWidth - 8) + "px";
  m.style.top = Math.min(e.clientY, window.innerHeight - m.offsetHeight - 8) + "px";
  m.style.visibility = "";
  setTimeout(function () {
    document.addEventListener("mousedown", onRadioDocDown, true);
    document.addEventListener("keydown", onRadioEsc, true);
    document.addEventListener("scroll", removeRadioMenu, true);
    window.addEventListener("blur", removeRadioMenu);
  }, 0);
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

return function cleanup() {
  try { if (window.__qzSmartRadio && window.__qzSmartRadio.run === smartRadio) delete window.__qzSmartRadio; } catch (e) {}
  document.removeEventListener("contextmenu", onRadioContext, false);
  removeRadioMenu();
  if (slot) slot.remove();
  var t = document.getElementById("qz-radio-toast"); if (t) t.remove();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
