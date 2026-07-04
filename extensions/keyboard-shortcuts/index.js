// Control Qobuz from anywhere with the keyboard. Runs as function(Qobuzify){ ... return cleanup }.
//
// The audio engine is sealed, so every action drives the player's own DOM controls instead -
// transport is the .player__action .pct spans, seek is the progress-bar mousemove->mouseup commit,
// mute is .pct-volume - or it reads/writes the store. Keys are ignored while you're typing in an
// input, textarea, or contenteditable, and anything with Ctrl/Cmd/Alt held is left for the app.
var Q = Qobuzify;
var CSS_ID = "qz-kbd-css";
var helpOpen = false;

function clickEl(sel) { var el = document.querySelector(sel); if (!el) return false; el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); return true; }
function transport(a) {
  var map = { playpause: ".player__action-pause, .player__action-play", next: ".pct-player-next", prev: ".pct-player-prev", shuffle: ".pct-shuffle", repeat: ".pct-repeat", mute: ".pct-volume", like: ".player .ButtonFavorite" };
  clickEl(map[a]);
}
// seek by driving the app's own progress-bar handlers (see seek-controls for the why)
function seekBy(delta) {
  var bar = document.querySelector(".player__progressbar");
  var input = document.querySelector(".player__progressbar input[type=range]") || document.querySelector(".player__progressbar input");
  if (!bar || !input) return;
  var dur = parseInt(input.max, 10) || 0; if (!dur) return;
  var cur = parseInt(input.value, 10) || 0;
  var target = Math.max(0, Math.min(cur + delta, dur));
  var rect = bar.getBoundingClientRect();
  var clientX = Math.max(rect.left + 1, Math.min(rect.left + rect.width - 1, rect.left + 7.5 + target * (rect.width - 15) / dur));
  var clientY = input.getBoundingClientRect().top + 6;
  var o = { bubbles: true, cancelable: true, view: window, clientX: clientX, clientY: clientY, button: 0 };
  bar.dispatchEvent(new MouseEvent("mousemove", o));
  input.dispatchEvent(new MouseEvent("mouseup", o));
}
function volSlider() { return document.querySelector(".player__settings-volume-slider .rangeslider") || document.querySelector(".player__settings-volume-slider"); }
// read the true current volume off the slider's rendered fill (px), not the store.
// settings.volume goes stale - it stayed pinned at 100 while the fill moved, so every
// step got computed off 100 and could only ever crawl to ~94. fill width / slider width = volume.
function currentVolPct() {
  var sl = volSlider(); if (!sl) return null;
  var sw = sl.getBoundingClientRect().width || 1;
  var fill = sl.querySelector(".rangeslider__fill");
  if (fill) { var fw = fill.getBoundingClientRect().width; return Math.max(0, Math.min(100, fw / sw * 100)); }
  var h = sl.querySelector(".rangeslider__handle");
  if (h) { var hl = parseFloat(h.style.left); if (!isNaN(hl)) return Math.max(0, Math.min(100, hl / sw * 100)); }
  try { var v = Q.getState().settings.volume; if (v != null) return v; } catch (e) {}
  return 50;
}
function adjustVolume(delta) {
  var sl = volSlider(); if (!sl) return;
  var cur = currentVolPct(); if (cur == null) cur = 50;
  var nv = Math.max(0, Math.min(100, Math.round((cur + delta) / 5) * 5)); // snap to clean 5% steps
  var rect = sl.getBoundingClientRect();
  var o = { bubbles: true, cancelable: true, view: window, clientX: rect.left + (nv / 100) * rect.width, clientY: rect.top + rect.height / 2, button: 0 };
  sl.dispatchEvent(new MouseEvent("mousedown", o));
  sl.dispatchEvent(new MouseEvent("mouseup", o));
  sl.dispatchEvent(new MouseEvent("click", o));
  toast("Volume " + nv + "%");
}
function focusSearch() { var s = document.querySelector('.SearchBar input, input[type=search], .NavBar input'); if (s) { s.focus(); try { s.select(); } catch (e) {} } }
function toggleFullscreen() {
  // hand off to Full App Display if enabled; else fall back to Qobuz's native fullscreen
  window.dispatchEvent(new CustomEvent("qz-fad-toggle"));
  setTimeout(function () { if (!document.getElementById("qz-fad-root")) clickEl(".player__track-cover .pct-fullscreen_open, .pct-fullscreen_open"); }, 40);
}

var MAP = [
  { keys: [" ", "k"], label: "Space / K", desc: "Play / pause", run: function () { transport("playpause"); } },
  { keys: ["l"], label: "L", desc: "Forward 10s", run: function () { seekBy(10000); } },
  { keys: ["j"], label: "J", desc: "Back 10s", run: function () { seekBy(-10000); } },
  { keys: ["ArrowRight"], label: "→", desc: "Forward 5s", run: function () { seekBy(5000); } },
  { keys: ["ArrowLeft"], label: "←", desc: "Back 5s", run: function () { seekBy(-5000); } },
  { keys: ["ArrowUp"], label: "↑", desc: "Volume up", run: function () { adjustVolume(5); } },
  { keys: ["ArrowDown"], label: "↓", desc: "Volume down", run: function () { adjustVolume(-5); } },
  { keys: ["n"], label: "N", desc: "Next track", run: function () { transport("next"); } },
  { keys: ["p"], label: "P", desc: "Previous track", run: function () { transport("prev"); } },
  { keys: ["m"], label: "M", desc: "Mute", run: function () { transport("mute"); } },
  { keys: ["b"], label: "B", desc: "Like / favorite", run: function () { transport("like"); } },
  { keys: ["s"], label: "S", desc: "Shuffle", run: function () { transport("shuffle"); } },
  { keys: ["r"], label: "R", desc: "Repeat", run: function () { transport("repeat"); } },
  { keys: ["f"], label: "F", desc: "Fullscreen now playing", run: function () { toggleFullscreen(); } },
  { keys: ["/"], label: "/", desc: "Search", run: function (e) { e.preventDefault(); focusSearch(); } },
  { keys: ["?", "h"], label: "? / H", desc: "Show this help", run: function () { toggleHelp(); } }
];
var PREVENT = { " ": 1, "/": 1, "?": 1, ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1 };

function typing(el) { if (!el) return false; var t = el.tagName; return t === "INPUT" || t === "TEXTAREA" || t === "SELECT" || el.isContentEditable; }
function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (helpOpen && e.key === "Escape") { toggleHelp(false); return; }
  if (typing(e.target)) return;
  var key = e.key, lk = key.length === 1 ? key.toLowerCase() : key;
  for (var i = 0; i < MAP.length; i++) {
    if (MAP[i].keys.indexOf(key) >= 0 || MAP[i].keys.indexOf(lk) >= 0) {
      if (PREVENT[key]) e.preventDefault();
      try { MAP[i].run(e); } catch (err) {}
      return;
    }
  }
}

// --- help overlay ---
function toggleHelp(force) {
  var want = force === undefined ? !helpOpen : force;
  var ex = document.getElementById("qz-kbd-help");
  if (!want) { if (ex) ex.remove(); helpOpen = false; return; }
  if (ex) return;
  helpOpen = true;
  var ov = document.createElement("div");
  ov.id = "qz-kbd-help"; ov.className = "qz-kbd-overlay";
  ov.innerHTML = '<div class="qz-kbd-modal"><div class="qz-kbd-head"><span class="icon-keyboard qz-kbd-headico"></span>' +
    '<span class="qz-kbd-title">Keyboard Shortcuts</span><button class="qz-kbd-close" aria-label="Close">&#215;</button></div>' +
    '<div class="qz-kbd-list">' + MAP.filter(function (m) { return m.keys[0] !== "?"; }).map(function (m) {
      return '<div class="qz-kbd-item"><kbd>' + m.label + "</kbd><span>" + m.desc + "</span></div>";
    }).join("") + "</div></div>";
  ov.addEventListener("mousedown", function (e) { if (e.target === ov) toggleHelp(false); });
  ov.querySelector(".qz-kbd-close").addEventListener("click", function () { toggleHelp(false); });
  document.body.appendChild(ov);
}

Q.css(CSS_ID, [
  ".qz-kbd-overlay{position:fixed;inset:0;z-index:2147483200;display:flex;align-items:center;justify-content:center;",
  "background:rgba(4,6,10,.62);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);}",
  ".qz-kbd-modal{width:min(520px,92vw);max-height:82vh;overflow:auto;color:#eef2f7;",
  "background:linear-gradient(180deg,rgba(20,23,31,.98),rgba(12,14,20,.99));border:1px solid rgba(255,255,255,.1);",
  "border-radius:16px;box-shadow:0 30px 90px rgba(0,0,0,.6),0 0 60px -20px var(--qz-accent,#3DA8FE);}",
  ".qz-kbd-head{display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.07);}",
  ".qz-kbd-headico{color:var(--qz-accent,#3DA8FE);font-size:20px;}",
  ".qz-kbd-title{font-weight:700;font-size:16px;flex:1;}",
  ".qz-kbd-close{appearance:none;border:0;background:rgba(255,255,255,.06);color:#cbd3df;width:30px;height:30px;border-radius:8px;font-size:19px;cursor:pointer;}",
  ".qz-kbd-close:hover{background:rgba(255,255,255,.13);color:#fff;}",
  ".qz-kbd-list{padding:12px 18px 18px;display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;}",
  ".qz-kbd-item{display:flex;align-items:center;gap:12px;padding:6px 0;}",
  ".qz-kbd-item kbd{flex:0 0 auto;min-width:58px;text-align:center;font:inherit;font-size:12px;font-weight:700;color:#e7ecf3;",
  "background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);border-bottom-width:2px;border-radius:7px;padding:5px 8px;}",
  ".qz-kbd-item span{font-size:13px;color:#c2cad6;}",
  "#qz-kbd-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%) translateY(12px);z-index:2147483600;",
  "padding:10px 17px;border-radius:24px;font-size:13px;font-weight:600;color:#06090a;background:var(--qz-accent,#3DA8FE);",
  "box-shadow:0 16px 44px -12px rgba(0,0,0,.6);opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;white-space:nowrap;}",
  "#qz-kbd-toast.qz-show{opacity:1;transform:translateX(-50%) translateY(0);}"
].join(""));

var toastT = null;
function toast(msg) {
  var t = document.getElementById("qz-kbd-toast");
  if (!t) { t = document.createElement("div"); t.id = "qz-kbd-toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("qz-show");
  clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove("qz-show"); }, 1500);
}

document.addEventListener("keydown", onKey, false);

return function cleanup() {
  document.removeEventListener("keydown", onKey, false);
  toggleHelp(false);
  var t = document.getElementById("qz-kbd-toast"); if (t) t.remove();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
