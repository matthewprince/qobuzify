// Stop playback after a set time, or at the end of the current track. Runs as
// function(Qobuzify){ ... return cleanup }.
//
// A moon button in the player bar opens a small menu - 15/30/45/60/90 min, a custom entry, or
// "end of track". Once it's armed the button shows a live countdown and goes accent-coloured.
// When the timer's up it pauses by clicking the play/pause control, the same one you'd click
// yourself. Qobuz's audio engine is sealed so there's no pause API to call, but a transport click
// does the job.
var Q = Qobuzify;
var CSS_ID = "qz-sleep-css";

function clickEl(sel) { var el = document.querySelector(sel); if (!el) return false; el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); return true; }
function pauseNow() { if (Q.player.isPlaying()) clickEl(".player__action-pause, .player__action-play"); }

var endAt = 0, toId = null, tickId = null, mode = null, offTrack = null;
function clearAll() {
  if (toId) { clearTimeout(toId); toId = null; }
  if (tickId) { clearInterval(tickId); tickId = null; }
  if (offTrack) { try { offTrack(); } catch (e) {} offTrack = null; }
  endAt = 0; mode = null;
}
function fire() { clearAll(); pauseNow(); updateBtn(); closePop(); toast("Sleep timer - playback paused"); }
function startMinutes(min) {
  clearAll(); mode = "time"; endAt = Date.now() + min * 60000;
  toId = setTimeout(fire, min * 60000);
  tickId = setInterval(updateBtn, 1000);
  updateBtn(); closePop(); toast("Sleep timer set for " + min + " min");
}
function startEndOfTrack() {
  clearAll(); mode = "track";
  var startId = null; try { startId = (Q.getState().player.currentTrack || {}).id; } catch (e) {}
  var lastPos = -1;
  // poll for the track advancing - Qobuz's onChange is unreliable on autoplay advance, so we watch
  // the current-track id directly and pause the moment it changes (the next track just started).
  // repeat-one restarts the SAME id, so a position wrap back to ~0 counts as the boundary too.
  tickId = setInterval(function () {
    try {
      var id = (Q.getState().player.currentTrack || {}).id;
      if (id != null && id !== startId) { fire(); return; }
      var pos = Q.player.getPositionMs();
      if (lastPos >= 0 && pos < 3000 && pos < lastPos - 5000 && Q.player.isPlaying()) { fire(); return; }
      lastPos = pos;
    } catch (e) {}
  }, 400);
  updateBtn(); closePop(); toast("Will pause when this track ends");
}
function cancel() { var had = !!mode; clearAll(); updateBtn(); closePop(); if (had) toast("Sleep timer cancelled"); }

function remainMs() { return mode === "time" ? Math.max(0, endAt - Date.now()) : 0; }
function fmtRemain(ms) { var s = Math.ceil(ms / 1000); if (s >= 60) return Math.ceil(s / 60) + "m"; return s + "s"; }
function updateBtn() {
  var b = document.getElementById("qz-sleep-btn"); if (!b) return;
  var lab = b.querySelector(".qz-sleep-label");
  b.classList.toggle("qz-sleep-active", !!mode);
  if (mode === "time") { lab.textContent = fmtRemain(remainMs()); lab.style.display = ""; if (remainMs() <= 0) fire(); }
  else if (mode === "track") { lab.textContent = "track"; lab.style.display = ""; }
  else { lab.textContent = ""; lab.style.display = "none"; }
}

// --- menu ---
function closePop() { var p = document.querySelector(".qz-sleep-pop"); if (p) p.remove(); document.removeEventListener("mousedown", outside, true); }
function outside(e) { var w = document.getElementById("qz-sleep-wrap"), p = document.getElementById("qz-sleep-pop"); if ((w && w.contains(e.target)) || (p && p.contains(e.target))) return; closePop(); }
function openPop() {
  if (document.getElementById("qz-sleep-pop")) { closePop(); return; }
  var btn = document.getElementById("qz-sleep-btn"); if (!btn) return;
  var pop = document.createElement("div");
  pop.id = "qz-sleep-pop"; pop.className = "qz-sleep-pop";
  var mins = [15, 30, 45, 60, 90];
  pop.innerHTML = "<h4>Sleep timer</h4>" +
    '<div class="qz-sleep-grid">' + mins.map(function (m) { return '<button class="qz-sleep-opt" data-min="' + m + '">' + m + "m</button>"; }).join("") +
    '<button class="qz-sleep-opt qz-sleep-custom" data-custom="1">Custom</button></div>' +
    '<button class="qz-sleep-row" data-track="1"><span>End of track</span><span class="qz-sleep-ico-eot"></span></button>' +
    (mode ? '<button class="qz-sleep-row qz-sleep-cancel" data-cancel="1"><span>Cancel timer</span><span>' + (mode === "time" ? fmtRemain(remainMs()) + " left" : "at track end") + "</span></button>" : "");
  pop.querySelectorAll("[data-min]").forEach(function (btn) { btn.addEventListener("click", function (e) { e.stopPropagation(); startMinutes(parseInt(btn.getAttribute("data-min"), 10)); }); });
  var cust = pop.querySelector("[data-custom]");
  if (cust) cust.addEventListener("click", function (e) {
    e.stopPropagation();
    var have = pop.querySelector(".qz-sleep-custrow");
    if (have) { have.querySelector(".qz-sleep-cinput").focus(); return; }
    var row = document.createElement("div"); row.className = "qz-sleep-custrow";
    row.innerHTML = '<input type="number" min="1" max="1440" placeholder="minutes" class="qz-sleep-cinput"/><button class="qz-sleep-cgo">Set</button>';
    var inp = row.querySelector(".qz-sleep-cinput");
    var go = function () { var n = parseInt(inp.value, 10); if (n > 0 && n <= 1440) startMinutes(n); };
    row.querySelector(".qz-sleep-cgo").addEventListener("click", function (e2) { e2.stopPropagation(); go(); });
    inp.addEventListener("click", function (e2) { e2.stopPropagation(); });
    inp.addEventListener("keydown", function (e2) { e2.stopPropagation(); if (e2.key === "Enter") { e2.preventDefault(); go(); } });
    pop.insertBefore(row, pop.querySelector("[data-track]"));
    inp.focus();
  });
  var trk = pop.querySelector("[data-track]");
  if (trk) trk.addEventListener("click", function (e) { e.stopPropagation(); startEndOfTrack(); });
  var can = pop.querySelector("[data-cancel]");
  if (can) can.addEventListener("click", function (e) { e.stopPropagation(); cancel(); });
  // append to body (fixed) so the player bar's stacking context can't clip it behind the app
  pop.style.visibility = "hidden";
  document.body.appendChild(pop);
  var br = btn.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  var left = Math.max(8, Math.min(br.left + br.width / 2 - pw / 2, window.innerWidth - pw - 8));
  var top = br.top - ph - 10; if (top < 8) top = br.bottom + 10;
  pop.style.left = left + "px"; pop.style.top = top + "px"; pop.style.visibility = "";
  setTimeout(function () { document.addEventListener("mousedown", outside, true); }, 0);
}

var MOON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="currentColor"/></svg>';

Q.css(CSS_ID, [
  "#qz-sleep-wrap{position:relative;display:inline-flex;align-items:center;flex:0 0 auto;margin-right:4px;}",
  "#qz-sleep-btn{display:inline-flex;align-items:center;gap:5px;height:34px;padding:0 8px;appearance:none;border:0;border-radius:17px;",
  "background:transparent;color:#cbd3df;cursor:pointer;transition:background .15s,color .12s;flex:0 0 auto;}",
  "#qz-sleep-btn:hover{background:color-mix(in srgb,var(--qz-accent,#3DA8FE) 20%,transparent);color:var(--qz-accent,#3DA8FE);}",
  "#qz-sleep-btn.qz-sleep-active{color:var(--qz-accent,#3DA8FE);}",
  "#qz-sleep-btn svg{pointer-events:none;display:block;}",
  ".qz-sleep-label{font:inherit;font-size:11px;font-weight:800;letter-spacing:.3px;}",
  ".qz-sleep-pop{position:fixed;z-index:2147483600;min-width:236px;padding:12px;",
  "background:linear-gradient(180deg,rgba(22,25,33,.98),rgba(13,15,21,.99));border:1px solid rgba(255,255,255,.12);",
  "border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.6),0 0 40px -22px var(--qz-accent,#3DA8FE);}",
  ".qz-sleep-pop h4{margin:2px 4px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#8b94a3;}",
  ".qz-sleep-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:8px;}",
  ".qz-sleep-opt{appearance:none;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:#e7ecf3;font:inherit;",
  "font-size:13px;font-weight:700;padding:9px 0;border-radius:9px;cursor:pointer;transition:all .13s;}",
  ".qz-sleep-opt:hover{border-color:var(--qz-accent,#3DA8FE);color:var(--qz-accent,#3DA8FE);background:color-mix(in srgb,var(--qz-accent,#3DA8FE) 12%,transparent);}",
  ".qz-sleep-custom{grid-column:span 3;font-size:12px;}",
  ".qz-sleep-custrow{display:flex;gap:7px;margin-bottom:8px;}",
  ".qz-sleep-cinput{flex:1;min-width:0;appearance:none;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05);color:#e7ecf3;font:inherit;font-size:13px;padding:8px 10px;border-radius:9px;}",
  ".qz-sleep-cinput:focus{outline:none;border-color:var(--qz-accent,#3DA8FE);}",
  ".qz-sleep-cgo{appearance:none;border:0;background:var(--qz-accent,#3DA8FE);color:#06090a;font:inherit;font-size:13px;font-weight:700;padding:8px 14px;border-radius:9px;cursor:pointer;}",
  ".qz-sleep-row{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;appearance:none;border:1px solid rgba(255,255,255,.10);",
  "background:transparent;color:#e7ecf3;font:inherit;font-size:13px;font-weight:600;padding:10px;border-radius:9px;cursor:pointer;margin-top:2px;transition:all .13s;}",
  ".qz-sleep-row:hover{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.2);}",
  ".qz-sleep-cancel{color:#f0a3a3;border-color:rgba(240,120,120,.25);}",
  ".qz-sleep-cancel span:last-child{font-size:11px;color:#9aa3b2;}",
  ".qz-sleep-ico-eot{width:9px;height:9px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-45deg);opacity:.7;}",
  "#qz-sleep-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%) translateY(12px);z-index:2147483600;max-width:min(440px,80vw);",
  "padding:11px 18px;border-radius:24px;font-size:13.5px;font-weight:600;color:#06090a;background:var(--qz-accent,#3DA8FE);",
  "box-shadow:0 16px 44px -12px rgba(0,0,0,.6);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;white-space:nowrap;}",
  "#qz-sleep-toast.qz-show{opacity:1;transform:translateX(-50%) translateY(0);}"
].join(""));

var toastT = null;
function toast(msg) {
  var t = document.getElementById("qz-sleep-toast");
  if (!t) { t = document.createElement("div"); t.id = "qz-sleep-toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("qz-show");
  clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove("qz-show"); }, 2400);
}

var wrap = document.createElement("span");
wrap.id = "qz-sleep-wrap";
var sb = document.createElement("button");
sb.id = "qz-sleep-btn"; sb.title = "Sleep timer";
sb.innerHTML = MOON + '<span class="qz-sleep-label" style="display:none"></span>';
sb.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); openPop(); });
wrap.appendChild(sb);
var slot = Q.playerSlot({ id: "sleep-timer", zone: "left", order: 10, el: wrap });
updateBtn();

return function cleanup() {
  if (slot) slot.remove();
  clearAll();
  closePop();
  var t = document.getElementById("qz-sleep-toast"); if (t) t.remove();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
