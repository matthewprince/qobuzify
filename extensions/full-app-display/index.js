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

var IC = {
  play: '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor"/></svg>',
  prev: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M7 6h2v12H7zM20 6v12L9 12z" fill="currentColor"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M15 6h2v12h-2zM4 6l11 6L4 18z" fill="currentColor"/></svg>',
  expand: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
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
    '<div class="qz-fad-stage">' +
      '<div class="qz-fad-art"><img alt="" draggable="false"></div>' +
      '<div class="qz-fad-meta"><div class="qz-fad-title"></div><div class="qz-fad-artist"></div><div class="qz-fad-album"></div></div>' +
      '<div class="qz-fad-seek"><span class="qz-fad-cur">0:00</span><div class="qz-fad-bar"><div class="qz-fad-fill"></div></div><span class="qz-fad-dur">0:00</span></div>' +
      '<div class="qz-fad-controls">' +
        '<button class="qz-fad-ctl qz-fad-prev" aria-label="Previous">' + IC.prev + "</button>" +
        '<button class="qz-fad-ctl qz-fad-pp" aria-label="Play/pause"></button>' +
        '<button class="qz-fad-ctl qz-fad-next" aria-label="Next">' + IC.next + "</button>" +
      "</div>" +
    "</div>";
  document.body.appendChild(root);
  root.querySelector(".qz-fad-close").addEventListener("click", close);
  root.querySelector(".qz-fad-prev").addEventListener("click", function () { clickEl(".pct-player-prev"); });
  root.querySelector(".qz-fad-next").addEventListener("click", function () { clickEl(".pct-player-next"); });
  root.querySelector(".qz-fad-pp").addEventListener("click", function () { clickEl(".player__action-pause, .player__action-play"); setTimeout(paintProgress, 120); });
  root.querySelector(".qz-fad-bar").addEventListener("click", function (e) {
    var r = this.getBoundingClientRect(); var frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    var input = playerInput(); var dur = input ? (parseInt(input.max, 10) || 0) : ((Q.player.getTrack() || {}).durationMs || 0);
    if (dur) seekToMs(frac * dur); setTimeout(paintProgress, 120);
  });
  paintTrack(); paintProgress();
  requestAnimationFrame(function () { root.classList.add("qz-fad-show"); });
  pollIv = setInterval(paintProgress, 250);
  offTrack = Q.player.onChange(function () { paintTrack(); paintProgress(); });
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
  ".qz-fad-pp:hover{color:#06090a;filter:brightness(1.07);}"
].join(""));

var b = document.createElement("button");
b.id = "qz-fad-btn"; b.className = "qz-pbtn"; b.title = "Full screen now playing (F)";
b.innerHTML = IC.expand;
b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); toggle(); });
var slot = Q.playerSlot({ id: "full-app-display", zone: "right", order: 40, el: b });

function onToggleEvt() { toggle(); }
window.addEventListener("qz-fad-toggle", onToggleEvt);

return function cleanup() {
  if (slot) slot.remove();
  window.removeEventListener("qz-fad-toggle", onToggleEvt);
  close();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
