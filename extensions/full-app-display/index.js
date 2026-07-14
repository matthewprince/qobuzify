// A fullscreen now-playing overlay. Runs as function(Qobuzify){ ... return cleanup }.
//
// Big cover art with the title/artist/album over a blurred backdrop, a live seekable progress bar,
// and prev/play-pause/next. It all reads from Qobuzify's player API and drives the real player
// controls underneath - transport is the .player__action clicks, seek is the progress-bar
// mousemove->mouseup commit - so the sealed audio engine never gets touched directly. Toggle it
// from the player-bar button or the F key (keyboard-shortcuts fires a qz-fad-toggle event).
var Q = Qobuzify;
var CSS_ID = "qz-fad-css";
var pollIv = null, offTrack = null;
var durCache = {};        // trackId -> duration in SECONDS (queue-remaining readout)
var durInflight = {};     // trackId -> 1 while a track/get is in flight
var lastQSig = "";        // signature of the upcoming queue, so we only re-resolve when it changes
var optimisticFav = null; // { id, val } - bridges the gap before the native heart reflects a toggle

var IC = {
  play: '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor"/></svg>',
  prev: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M7 6h2v12H7zM20 6v12L9 12z" fill="currentColor"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M15 6h2v12h-2zM4 6l11 6L4 18z" fill="currentColor"/></svg>',
  expand: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  heart: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg>',
  heartFilled: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>'
};

function bigCover(url) { return url ? String(url).replace(/_\d+\.(jpg|jpeg|png|webp)/i, "_600.$1") : ""; }
function fmt(ms) { ms = Math.max(0, Math.round(ms / 1000)); var m = Math.floor(ms / 60), s = ms % 60; return m + ":" + (s < 10 ? "0" : "") + s; }
function clickEl(sel) { var el = document.querySelector(sel); if (!el) return false; el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); return true; }

function playerInput() { return document.querySelector(".player__progressbar input[type=range]") || document.querySelector(".player__progressbar input"); }
function seekToMs(targetMs) {
  var bar = document.querySelector(".player__progressbar"), input = playerInput();
  if (!bar || !input) return;
  var dur = parseInt(input.max, 10) || 0; if (!dur) return;
  targetMs = Math.max(0, Math.min(targetMs, dur));
  var rect = bar.getBoundingClientRect();
  var clientX = Math.max(rect.left + 1, Math.min(rect.left + rect.width - 1, rect.left + 7.5 + targetMs * (rect.width - 15) / dur));
  var clientY = input.getBoundingClientRect().top + 6;
  var o = { bubbles: true, cancelable: true, view: window, clientX: clientX, clientY: clientY, button: 0 };
  bar.dispatchEvent(new MouseEvent("mousemove", o));
  input.dispatchEvent(new MouseEvent("mouseup", o));
}

// --- favourite / like ---------------------------------------------------------------------------
// The player bar's own heart (.player .ButtonFavorite, class ButtonFavorite--isActive when favourited)
// is Qobuz's live source of truth. Our FAD button mirrors it: clicking ours drives the native heart so
// Qobuz owns the write (its click performs favorite/create|delete) and the two never desync. If the native
// heart is somehow absent we fall back to calling favorite/create|delete?type=tracks&track_ids= directly.
function curId() { try { var t = Q.player.getTrack(); return t && t.id != null ? t.id : null; } catch (e) { return null; } }
function nativeHeart() { return document.querySelector(".player .ButtonFavorite"); }
function isFavNow() {
  var id = curId();
  if (optimisticFav && optimisticFav.id === id) return optimisticFav.val;
  var h = nativeHeart();
  if (h) return h.classList.contains("ButtonFavorite--isActive");
  return false;
}
function renderLike() {
  var root = document.getElementById("qz-fad-root"); if (!root) return;
  var btn = root.querySelector(".qz-fad-like"); if (!btn) return;
  var id = curId();
  if (optimisticFav && optimisticFav.id !== id) optimisticFav = null;                 // track changed -> drop stale optimism
  var h = nativeHeart();
  if (optimisticFav && h && h.classList.contains("ButtonFavorite--isActive") === optimisticFav.val) optimisticFav = null; // native caught up
  var fav = isFavNow();
  btn.classList.toggle("qz-fad-liked", fav);
  btn.setAttribute("aria-pressed", fav ? "true" : "false");
  btn.title = fav ? "Remove from favourites" : "Add to favourites";
  var ic = btn.querySelector(".qz-fad-like-ic"); if (ic) ic.innerHTML = fav ? IC.heartFilled : IC.heart;
  btn.disabled = id == null;
}
function toggleLike() {
  var id = curId(); if (id == null) return;
  var want = !isFavNow();
  optimisticFav = { id: id, val: want };
  renderLike();
  var h = nativeHeart();
  if (h) h.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  else Q.api("favorite/" + (want ? "create" : "delete") + "?type=tracks&track_ids=" + id).catch(function () {});
}

// --- queue remaining time -----------------------------------------------------------------------
// Sum the durations of the play-queue items after currentIndex (+ the current track's remaining time) and
// show "1h 23m left". Durations come from the store's dictionnary.tracks.data[id] when present (free), else
// a cached track/get. Qobuz's track/get duration is in SECONDS; the dictionnary field can be either, so a
// per-value heuristic (> 10h => milliseconds) normalises both.
function normSec(d) { d = Number(d) || 0; if (d > 36000) d = d / 1000; return d; }
function dictDur(id) {
  try {
    var data = Q.getState().dictionnary && Q.getState().dictionnary.tracks && Q.getState().dictionnary.tracks.data;
    if (!data) return null;
    var t = data[id]; if (t == null) t = data[String(id)];
    if (t && t.duration != null) return normSec(t.duration);
  } catch (e) {}
  return null;
}
function durOf(id) { // seconds, or null if not known yet
  if (id == null) return null;
  if (durCache[id] != null) return durCache[id];
  var d = dictDur(id); if (d != null) { durCache[id] = d; return d; }
  return null;
}
function upcomingIds() {
  try {
    var pq = Q.getState().playqueue; if (!pq) return [];
    var order = (pq.shuffled && pq.shuffledItems && pq.shuffledItems.length) ? pq.shuffledItems : (pq.items || []);
    var ci = (typeof pq.currentIndex === "number" && pq.currentIndex >= 0) ? pq.currentIndex : 0;
    var out = [], i;
    for (i = ci + 1; i < order.length; i++) { var it = order[i]; if (it && it.trackId != null) out.push(it.trackId); }
    return out;
  } catch (e) { return []; }
}
function fmtLeft(sec) {
  sec = Math.max(0, Math.round(sec));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h > 0) return h + "h " + (m < 10 ? "0" : "") + m + "m left";
  if (m > 0) return m + "m left";
  return sec + "s left";
}
function resolveDurations(ids) {
  var CAP = 120, CONC = 4, list = [], i;
  for (i = 0; i < ids.length && list.length < CAP; i++) {
    var id = ids[i];
    if (id == null || durCache[id] != null || durInflight[id] || dictDur(id) != null) continue;
    list.push(id);
  }
  if (!list.length) return;
  var idx = 0, active = 0;
  function step() {
    while (active < CONC && idx < list.length) {
      var id = list[idx++]; durInflight[id] = 1; active++;
      (function (id) {
        Q.api("track/get?track_id=" + id).then(function (tr) { if (tr && tr.duration != null) durCache[id] = normSec(tr.duration); })
          .catch(function () {}).then(function () { delete durInflight[id]; active--; paintQueue(); step(); });
      })(id);
    }
  }
  step();
}
function paintQueue() {
  var root = document.getElementById("qz-fad-root"); if (!root) return;
  var pill = root.querySelector(".qz-fad-queue"); if (!pill) return;
  var ids = upcomingIds(), sum = 0, unresolved = 0, i;
  for (i = 0; i < ids.length; i++) { var d = durOf(ids[i]); if (d == null) unresolved++; else sum += d; }
  var curRem = 0;
  try { var t = Q.player.getTrack() || {}; curRem = Math.max(0, (t.durationMs || 0) - Q.player.getPositionMs()) / 1000; } catch (e) {}
  var total = sum + curRem;
  if (!ids.length && curRem < 1) { pill.hidden = true; return; }
  pill.hidden = false;
  pill.querySelector(".qz-fad-q-txt").textContent = (unresolved > 0 ? "~" : "") + fmtLeft(total);
  pill.title = ids.length + " track" + (ids.length === 1 ? "" : "s") + " left in queue";
}
function syncQueue() { // re-resolve durations only when the upcoming set actually changed, then paint
  var ids = upcomingIds();
  var sig = ids.length + "|" + ids[0] + "|" + ids[ids.length - 1];
  if (sig !== lastQSig) { lastQSig = sig; resolveDurations(ids); }
  paintQueue();
}

function isOpen() { return !!document.getElementById("qz-fad-root"); }
function paintTrack() {
  var root = document.getElementById("qz-fad-root"); if (!root) return;
  var t = Q.player.getTrack() || {};
  var img = root.querySelector(".qz-fad-art img"), bg = root.querySelector(".qz-fad-bg");
  var big = bigCover(t.cover);
  if (img && img.getAttribute("data-src") !== big) { img.setAttribute("data-src", big); img.src = big || t.cover || ""; }
  if (bg) bg.style.backgroundImage = big ? 'url("' + big + '")' : "none";
  root.querySelector(".qz-fad-title").textContent = t.title || "";
  root.querySelector(".qz-fad-artist").textContent = t.artist || (t.artists || []).join(", ") || "";
  root.querySelector(".qz-fad-album").textContent = t.album || "";
}
function paintProgress() {
  var root = document.getElementById("qz-fad-root"); if (!root) return;
  var input = playerInput();
  var dur = input ? (parseInt(input.max, 10) || 0) : ((Q.player.getTrack() || {}).durationMs || 0);
  var pos = input ? (parseInt(input.value, 10) || 0) : Q.player.getPositionMs();
  pos = Math.max(0, Math.min(pos, dur || pos));
  root.querySelector(".qz-fad-fill").style.width = dur ? (pos / dur * 100) + "%" : "0%";
  root.querySelector(".qz-fad-cur").textContent = fmt(pos);
  root.querySelector(".qz-fad-dur").textContent = fmt(dur);
  var pp = root.querySelector(".qz-fad-pp");
  var playing = Q.player.isPlaying();
  if (pp && pp.getAttribute("data-playing") !== String(playing)) { pp.setAttribute("data-playing", String(playing)); pp.innerHTML = playing ? IC.pause : IC.play; }
}

function open() {
  if (isOpen()) return;
  var root = document.createElement("div");
  root.id = "qz-fad-root"; root.className = "qz-fad";
  root.innerHTML =
    '<div class="qz-fad-bg"></div><div class="qz-fad-scrim"></div>' +
    '<button class="qz-fad-close" aria-label="Close">' + IC.close + "</button>" +
    '<div class="qz-fad-queue" hidden>' + IC.clock + '<span class="qz-fad-q-txt"></span></div>' +
    '<div class="qz-fad-stage">' +
      '<div class="qz-fad-art"><img alt="" draggable="false"></div>' +
      '<div class="qz-fad-meta"><div class="qz-fad-title"></div><div class="qz-fad-artist"></div><div class="qz-fad-album"></div></div>' +
      '<div class="qz-fad-seek"><span class="qz-fad-cur">0:00</span><div class="qz-fad-bar"><div class="qz-fad-fill"></div></div><span class="qz-fad-dur">0:00</span></div>' +
      '<div class="qz-fad-controls">' +
        '<button class="qz-fad-ctl qz-fad-like" aria-label="Favourite" aria-pressed="false"><span class="qz-fad-like-ic">' + IC.heart + "</span></button>" +
        '<button class="qz-fad-ctl qz-fad-prev" aria-label="Previous">' + IC.prev + "</button>" +
        '<button class="qz-fad-ctl qz-fad-pp" aria-label="Play/pause"></button>' +
        '<button class="qz-fad-ctl qz-fad-next" aria-label="Next">' + IC.next + "</button>" +
        '<span class="qz-fad-spacer" aria-hidden="true"></span>' +
      "</div>" +
    "</div>";
  document.body.appendChild(root);
  root.querySelector(".qz-fad-close").addEventListener("click", close);
  root.querySelector(".qz-fad-like").addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); toggleLike(); });
  root.querySelector(".qz-fad-prev").addEventListener("click", function () { clickEl(".pct-player-prev"); });
  root.querySelector(".qz-fad-next").addEventListener("click", function () { clickEl(".pct-player-next"); });
  root.querySelector(".qz-fad-pp").addEventListener("click", function () { clickEl(".player__action-pause, .player__action-play"); setTimeout(paintProgress, 120); });
  root.querySelector(".qz-fad-bar").addEventListener("click", function (e) {
    var r = this.getBoundingClientRect(); var frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    var input = playerInput(); var dur = input ? (parseInt(input.max, 10) || 0) : ((Q.player.getTrack() || {}).durationMs || 0);
    if (dur) seekToMs(frac * dur); setTimeout(paintProgress, 120);
  });
  lastQSig = "";
  paintTrack(); paintProgress(); renderLike(); syncQueue();
  requestAnimationFrame(function () { root.classList.add("qz-fad-show"); });
  pollIv = setInterval(function () { paintProgress(); renderLike(); syncQueue(); }, 250);
  offTrack = Q.player.onChange(function () { optimisticFav = null; paintTrack(); paintProgress(); renderLike(); syncQueue(); });
  document.addEventListener("keydown", onEsc, true);
}
function close() {
  var root = document.getElementById("qz-fad-root"); if (!root) return;
  if (pollIv) { clearInterval(pollIv); pollIv = null; }
  if (offTrack) { try { offTrack(); } catch (e) {} offTrack = null; }
  document.removeEventListener("keydown", onEsc, true);
  root.classList.remove("qz-fad-show");
  setTimeout(function () { if (root && !root.classList.contains("qz-fad-show")) root.remove(); }, 220);
}
function toggle() { if (isOpen()) close(); else open(); }
function onEsc(e) { if (e.key === "Escape") { e.stopPropagation(); close(); } }

Q.css(CSS_ID, [
  ".qz-fad{position:fixed;inset:0;z-index:2147483100;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .25s ease;overflow:hidden;}",
  ".qz-fad.qz-fad-show{opacity:1;}",
  ".qz-fad-bg{position:absolute;inset:-8%;background-size:cover;background-position:center;filter:blur(60px) saturate(1.3) brightness(.55);transform:scale(1.12);}",
  ".qz-fad-scrim{position:absolute;inset:0;background:radial-gradient(120% 90% at 50% 40%,rgba(6,8,12,.35),rgba(4,6,10,.82) 100%);}",
  ".qz-fad-close{position:absolute;top:20px;left:24px;z-index:2;appearance:none;border:0;background:rgba(255,255,255,.08);color:#e7ecf3;",
  "width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background .15s,transform .12s;}",
  ".qz-fad-close:hover{background:rgba(255,255,255,.16);transform:scale(1.06);}",
  ".qz-fad-stage{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:22px;width:min(560px,86vw);text-align:center;padding:20px;}",
  ".qz-fad-art{width:min(400px,60vh);aspect-ratio:1/1;border-radius:18px;overflow:hidden;box-shadow:0 40px 120px -24px rgba(0,0,0,.8),0 0 0 1px rgba(255,255,255,.06);}",
  ".qz-fad-art img{width:100%;height:100%;object-fit:cover;display:block;}",
  ".qz-fad-meta{display:flex;flex-direction:column;gap:6px;max-width:100%;}",
  ".qz-fad-title{font-size:30px;font-weight:800;letter-spacing:-.3px;color:#fff;line-height:1.15;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:min(560px,86vw);}",
  ".qz-fad-artist{font-size:18px;font-weight:600;color:var(--qz-accent,#3DA8FE);}",
  ".qz-fad-album{font-size:14px;color:#aeb6c2;}",
  ".qz-fad-seek{display:flex;align-items:center;gap:12px;width:100%;margin-top:4px;}",
  ".qz-fad-cur,.qz-fad-dur{font-size:12px;font-weight:600;color:#c2cad6;font-variant-numeric:tabular-nums;flex:0 0 auto;min-width:38px;}",
  ".qz-fad-dur{text-align:left;}",
  ".qz-fad-bar{position:relative;flex:1;height:6px;border-radius:4px;background:rgba(255,255,255,.18);cursor:pointer;}",
  ".qz-fad-bar:hover{height:8px;}",
  ".qz-fad-fill{position:absolute;left:0;top:0;height:100%;border-radius:4px;background:var(--qz-accent,#3DA8FE);box-shadow:0 0 12px -2px var(--qz-accent,#3DA8FE);transition:width .2s linear;}",
  ".qz-fad-controls{display:flex;align-items:center;gap:26px;margin-top:6px;}",
  ".qz-fad-ctl{appearance:none;border:0;background:transparent;color:#e7ecf3;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .12s,color .12s;}",
  ".qz-fad-ctl:hover{color:#fff;transform:scale(1.1);}",
  ".qz-fad-pp{width:70px;height:70px;border-radius:50%;background:var(--qz-accent,#3DA8FE);color:#06090a;box-shadow:0 10px 34px -8px var(--qz-accent,#3DA8FE);}",
  ".qz-fad-pp:hover{color:#06090a;filter:brightness(1.07);}",
  ".qz-fad-like-ic{display:flex;align-items:center;justify-content:center;}",
  ".qz-fad-like.qz-fad-liked{color:var(--qz-accent,#3DA8FE);}",
  ".qz-fad-like[disabled]{opacity:.35;pointer-events:none;}",
  ".qz-fad-spacer{width:26px;height:26px;flex:0 0 auto;pointer-events:none;}",
  ".qz-fad-queue{position:absolute;top:22px;right:24px;z-index:2;display:inline-flex;align-items:center;gap:7px;padding:8px 14px;border-radius:20px;",
  "background:rgba(255,255,255,.08);color:#c8d0dc;font-size:13px;font-weight:600;letter-spacing:.2px;white-space:nowrap;}",
  ".qz-fad-queue[hidden]{display:none;}",
  ".qz-fad-queue svg{display:block;flex:0 0 auto;opacity:.85;}",
  // --- shared player-bar controls row: horizontal-scroll instead of dropping buttons at narrow widths ---
  // The runtime hides slot buttons (inline display:none) once a zone reaches the centred transport; that is
  // the reported "Lyrics / Full App Display vanish" bug. We make each zone a hidden-scrollbar horizontal
  // scroller so buttons overflow-scroll rather than disappear; fitScroll() (JS below) caps each zone's width
  // to stop just short of the transport, which also keeps the runtime's guard from ever needing to hide one.
  ".player__settings>.qz-slot-right,.player__track>.qz-slot-left{overflow-x:auto;overflow-y:hidden;flex-wrap:nowrap;scrollbar-width:none;overscroll-behavior-x:contain;}",
  ".player__settings>.qz-slot-right::-webkit-scrollbar,.player__track>.qz-slot-left::-webkit-scrollbar{width:0;height:0;display:none;}"
].join(""));

var b = document.createElement("button");
b.id = "qz-fad-btn"; b.className = "qz-pbtn"; b.title = "Full screen now playing (F)";
b.innerHTML = IC.expand;
b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); toggle(); });
var slot = Q.playerSlot({ id: "full-app-display", zone: "right", order: 40, el: b });

function onToggleEvt() { toggle(); }
window.addEventListener("qz-fad-toggle", onToggleEvt);

// --- shared controls-row overflow fix (see the CSS block above) ---------------------------------
// Cap each slot zone's width so its inner edge stops GAP px short of the centred transport, then the
// CSS makes the overflow scroll instead of the runtime dropping buttons. We measure the SAME transport
// nodes the runtime's guard reads (.pct-player-prev/.pct-player-next); shrinking a right-anchored zone
// by its overlap moves its inner edge exactly clear, so the runtime's guard then finds nothing to hide.
// These are style-only writes, which don't trip the runtime's childList observers, so there's no loop.
var GAP = 12, fitT = null, offFit = null;
function revealAll(group) { var c = group.children, i; for (i = 0; i < c.length; i++) if (c[i].style.display === "none") c[i].style.display = ""; }
function fitScroll() {
  try {
    var next = document.querySelector(".pct-player-next"), prev = document.querySelector(".pct-player-prev");
    var right = document.querySelector(".player__settings > .qz-slot-right");
    var left = document.querySelector(".player__track > .qz-slot-left");
    if (right && next) {
      right.style.maxWidth = ""; revealAll(right);
      var g = right.getBoundingClientRect(), n = next.getBoundingClientRect();
      var over = (n.right + GAP) - g.left;                              // >0: zone's left edge intrudes on transport
      if (over > 0 && g.width) right.style.maxWidth = Math.max(0, Math.floor(g.width - over)) + "px";
    }
    if (left && prev) {
      left.style.maxWidth = ""; revealAll(left);
      var lg = left.getBoundingClientRect(), p = prev.getBoundingClientRect();
      var lover = lg.right - (p.left - GAP);                            // >0: zone's right edge intrudes on transport
      if (lover > 0 && lg.width) left.style.maxWidth = Math.max(0, Math.floor(lg.width - lover)) + "px";
    }
  } catch (e) {}
}
function scheduleFit() { if (fitT) return; fitT = setTimeout(function () { fitT = null; fitScroll(); }, 100); }
window.addEventListener("resize", scheduleFit);
offFit = Q.observe ? Q.observe(function () { fitScroll(); }, { debounce: 250 }) : null;
scheduleFit();

return function cleanup() {
  if (slot) slot.remove();
  window.removeEventListener("qz-fad-toggle", onToggleEvt);
  window.removeEventListener("resize", scheduleFit);
  if (fitT) { clearTimeout(fitT); fitT = null; }
  if (offFit) offFit();
  var r = document.querySelector(".player__settings > .qz-slot-right"); if (r) { r.style.maxWidth = ""; revealAll(r); }
  var l = document.querySelector(".player__track > .qz-slot-left"); if (l) { l.style.maxWidth = ""; revealAll(l); }
  close();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
