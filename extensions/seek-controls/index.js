// -10s / +10s skip buttons and an A-B loop, dropped into the player bar. Runs as
// function(Qobuzify){ ... return cleanup }.
//
// Qobuz's audio is a sealed JUCE engine - no <audio> element, no seek API you can reach. The one
// clean way in is the player's own progress bar. It works out the target from the mouse position
// on mousemove (showTime -> potentialSeekPosition) and commits it on mouseup (onSeekMouseUp fires
// the real seek and clears the preview). So we fake exactly that: synthesize a mousemove at the
// x-coordinate for the time we want, then a mouseup. Writing input.value directly is a trap - it
// only sets the "seeked" preview, and with no mouseup to clear it the bar just freezes, so we
// never touch the value. The x for a given time comes from inverting the bundle's own formula:
// potentialSeekPosition = dur * (clientX - left - 7.5) / (width - 15).
var Q = Qobuzify;
var CSS_ID = "qz-seek-css";
var STEP = 10000; // ms per skip

function seekBar() { return document.querySelector(".player__progressbar"); }
function seekInput() { return document.querySelector(".player__progressbar input[type=range]") || document.querySelector(".player__progressbar input"); }
function curMs() { var i = seekInput(); return i ? (parseInt(i.value, 10) || 0) : Q.player.getPositionMs(); }
function durMs() { var i = seekInput(); var d = i ? parseInt(i.max, 10) : 0; return d || ((Q.player.getTrack() || {}).durationMs || 0); }

// Seek by driving the app's own progress-bar handlers (mousemove sets target, mouseup commits).
function seekToMs(targetMs) {
  var bar = seekBar(), input = seekInput();
  if (!bar || !input) return false;
  var dur = parseInt(input.max, 10) || 0; if (!dur) return false;
  targetMs = Math.max(0, Math.min(targetMs, dur));
  var rect = bar.getBoundingClientRect();
  var clientX = rect.left + 7.5 + targetMs * (rect.width - 15) / dur;   // invert showTime/updateTime
  clientX = Math.max(rect.left + 1, Math.min(rect.left + rect.width - 1, clientX));
  var clientY = input.getBoundingClientRect().top + 6;                  // must be >= input top or showTime bails
  var o = { bubbles: true, cancelable: true, view: window, clientX: clientX, clientY: clientY, button: 0 };
  bar.dispatchEvent(new MouseEvent("mousemove", o));                    // showTime -> potentialSeekPosition = targetMs
  input.dispatchEvent(new MouseEvent("mouseup", o));                    // onSeekMouseUp -> commit real seek, clear preview
  return true;
}
function nudge(delta) {
  if (!seekToMs(curMs() + delta)) return;
  var b = document.querySelector('.qz-seek-btn[data-qz-seek="' + (delta > 0 ? "fwd" : "back") + '"]');
  if (b) { b.classList.add("qz-seek-flash"); setTimeout(function () { b.classList.remove("qz-seek-flash"); }, 180); }
}

// --- A-B loop ---
var loopA = null, loopB = null, loopIv = null;
function stopLoop() { if (loopIv) { clearInterval(loopIv); loopIv = null; } loopA = null; loopB = null; syncAB(); }
function startLoop() {
  if (loopIv) clearInterval(loopIv);
  loopIv = setInterval(function () {
    if (loopA == null || loopB == null) return;
    var c = curMs();
    if (c >= loopB - 150 || c < loopA - 4000) seekToMs(loopA);
  }, 250);
}
function cycleAB() {
  if (loopA == null && loopB == null) {                   // idle -> arm A
    loopA = curMs(); toast("Loop point A - " + fmt(loopA));
  } else if (loopB == null) {                             // armed -> set B, or swap, or cancel
    var b = curMs();
    if (b >= loopA + 1200) { loopB = b; startLoop(); toast("Looping " + fmt(loopA) + " to " + fmt(loopB)); }
    else if (b <= loopA - 1200) { loopB = loopA; loopA = b; startLoop(); toast("Looping " + fmt(loopA) + " to " + fmt(loopB)); }
    else { loopA = null; toast("A-B loop cancelled"); }    // too close to A -> cancel (always escapable)
  } else { stopLoop(); toast("A-B loop off"); return; }    // looping -> clear
  syncAB();
}
function fmt(ms) { ms = Math.max(0, Math.round(ms / 1000)); var m = Math.floor(ms / 60), s = ms % 60; return m + ":" + (s < 10 ? "0" : "") + s; }
function syncAB() {
  var b = document.querySelector(".qz-ab-btn"); if (!b) return;
  b.classList.remove("qz-ab-armed", "qz-ab-loop");
  if (loopA != null && loopB != null) { b.classList.add("qz-ab-loop"); b.textContent = "A-B"; b.title = "Looping " + fmt(loopA) + " - " + fmt(loopB) + " (click to clear)"; }
  else if (loopA != null) { b.classList.add("qz-ab-armed"); b.textContent = "A ·"; b.title = "A set at " + fmt(loopA) + " (click to set B and loop)"; }
  else { b.textContent = "A-B"; b.title = "A-B loop: click to set A, again for B, again to clear"; }
}

var SVG_BACK = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" fill="currentColor"/><text x="12" y="16" font-size="7.5" font-weight="800" text-anchor="middle" fill="currentColor">10</text></svg>';
var SVG_FWD = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><g transform="translate(24,0) scale(-1,1)"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" fill="currentColor"/></g><text x="12" y="16" font-size="7.5" font-weight="800" text-anchor="middle" fill="currentColor">10</text></svg>';

Q.css(CSS_ID, [
  ".qz-seek-group{display:inline-flex;align-items:center;gap:1px;margin-right:6px;flex:0 0 auto;}",
  ".qz-seek-btn{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;appearance:none;border:0;",
  "border-radius:50%;background:transparent;color:#cbd3df;cursor:pointer;transition:background .15s,color .12s,transform .08s;flex:0 0 auto;}",
  ".qz-seek-btn:hover{background:color-mix(in srgb,var(--qz-accent,#3DA8FE) 20%,transparent);color:var(--qz-accent,#3DA8FE);}",
  ".qz-seek-btn:active{transform:scale(.88);}",
  ".qz-seek-btn.qz-seek-flash{color:var(--qz-accent,#3DA8FE);}",
  ".qz-seek-btn svg{pointer-events:none;display:block;}",
  ".qz-ab-btn{width:auto;min-width:36px;height:24px;margin-left:2px;padding:0 9px;border-radius:16px;font:inherit;font-size:11px;",
  "font-weight:800;letter-spacing:.4px;color:#cbd3df;background:transparent;border:1px solid rgba(255,255,255,.20);cursor:pointer;",
  "transition:all .15s;white-space:nowrap;}",
  ".qz-ab-btn:hover{color:var(--qz-accent,#3DA8FE);border-color:var(--qz-accent,#3DA8FE);}",
  ".qz-ab-btn.qz-ab-armed{color:#06090a;background:var(--qz-accent,#3DA8FE);border-color:var(--qz-accent,#3DA8FE);}",
  ".qz-ab-btn.qz-ab-loop{color:#06090a;background:var(--qz-accent,#3DA8FE);border-color:var(--qz-accent,#3DA8FE);box-shadow:0 0 12px -2px var(--qz-accent,#3DA8FE);}",
  "#qz-seek-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%) translateY(12px);z-index:2147483600;",
  "padding:10px 17px;border-radius:24px;font-size:13px;font-weight:600;color:#06090a;background:var(--qz-accent,#3DA8FE);",
  "box-shadow:0 16px 44px -12px rgba(0,0,0,.6);opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;white-space:nowrap;}",
  "#qz-seek-toast.qz-show{opacity:1;transform:translateX(-50%) translateY(0);}"
].join(""));

var toastT = null;
function toast(msg) {
  var t = document.getElementById("qz-seek-toast");
  if (!t) { t = document.createElement("div"); t.id = "qz-seek-toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("qz-show");
  clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove("qz-show"); }, 1800);
}

// rewind / forward -> RIGHT zone (the settings cluster, with lyrics + fullscreen)
var seekG = document.createElement("span");
seekG.className = "qz-seek-group";
seekG.innerHTML =
  '<button class="qz-seek-btn" data-qz-seek="back" title="Back 10 seconds">' + SVG_BACK + "</button>" +
  '<button class="qz-seek-btn" data-qz-seek="fwd" title="Forward 10 seconds">' + SVG_FWD + "</button>";
seekG.querySelector('[data-qz-seek="back"]').addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); nudge(-STEP); });
seekG.querySelector('[data-qz-seek="fwd"]').addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); nudge(STEP); });
var slotSeek = Q.playerSlot({ id: "seek-fwdback", zone: "right", order: 20, el: seekG });

// A-B loop -> LEFT zone (by the info/heart cluster, with sleep + similar songs)
var abBtn = document.createElement("button");
abBtn.className = "qz-seek-btn qz-ab-btn"; abBtn.setAttribute("data-qz-seek", "ab");
abBtn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); cycleAB(); });
var slotAB = Q.playerSlot({ id: "ab-loop", zone: "left", order: 30, el: abBtn });
syncAB();

// stop the loop when the track changes (A/B belong to the old track)
var offTrack = Q.player.onChange(function () { if (loopIv || loopA != null) stopLoop(); });

return function cleanup() {
  if (slotSeek) slotSeek.remove();
  if (slotAB) slotAB.remove();
  if (offTrack) offTrack();
  if (loopIv) clearInterval(loopIv);
  loopA = null; loopB = null; loopIv = null;
  var t = document.getElementById("qz-seek-toast"); if (t) t.remove();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
