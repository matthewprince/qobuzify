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
function artistTopTracks(id) { return api("artist/get?artist_id=" + id + "&extra=tracks&limit=12").then(function (j) { var t = j.tracks; return (t && (t.items || t)) || []; }).catch(function () { return []; }); }
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

// --- the radio engine ---
function buildRadio(seed) {
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
    var seen = {};
    function take(tracks, n) { var out = []; for (var i = 0; i < tracks.length && out.length < n; i++) { var t = tracks[i]; if (!t || !t.id || t.streamable === false) continue; if (exclude[t.id] || seen[t.id]) continue; seen[t.id] = 1; out.push(t.id); } return out; }
    var buckets = lists.filter(Boolean);
    buckets.sort(function (a, b) { return (b.seed ? 1 : 0) - (a.seed ? 1 : 0); });
    var head = buckets[0] ? take(buckets[0].tracks, 3) : [];           // lead with the current artist
    var perBucket = buckets.map(function (b) { return take(b.tracks, b.seed ? 4 : 3); });
    var rr = [], i = 0, any = true;                                    // round-robin the rest, interleaved
    while (any && head.length + rr.length < 46) { any = false; for (var b = 0; b < perBucket.length; b++) { if (perBucket[b][i] != null) { rr.push(perBucket[b][i]); any = true; } } i++; }
    var ids = [], dd = {};
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
function smartRadio() {
  if (building) return;
  building = true; setBusy(true);
  currentSeed().then(function (seed) {
    if (!seed) { toast("Play a track first, then hit Smart Radio"); throw "no-seed"; }
    toast("Building a radio from " + seed.name + "…");
    return buildRadio(seed).then(function (ids) {
      if (!ids.length) { toast("Couldn't build a radio for this track"); throw "empty"; }
      return createPlaylist("Smart Radio - tracks like " + seed.name).then(function (pid) {
        return fillPlaylist(pid, ids).then(function () { return { pid: pid, count: ids.length, name: seed.name }; });
      });
    });
  }).then(function (r) {
    var oldPid = Q.storage.get(LS_PID, null);
    Q.storage.set(LS_PID, r.pid);
    toast("▶ Smart Radio - " + r.count + " tracks like " + r.name);
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

return function cleanup() {
  if (slot) slot.remove();
  var t = document.getElementById("qz-radio-toast"); if (t) t.remove();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
