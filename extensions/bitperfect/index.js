// Bit-perfect audio (Linux/macOS wrapper only).
// The web player streams lossless FLAC, but Chromium resamples every <audio>/MSE stream to a fixed rate and
// mixes it in-process, so it is lossless but NOT bit-perfect. This extension re-plays the same audio through
// a bundled mpv running ALSA hw: exclusive (Linux) / CoreAudio hog (mac), byte-exact to the DAC at the
// track's native rate. The web <audio> element is muted (it keeps decoding, so its clock, scrobble,
// MediaSession and auto-advance all keep working) while mpv is the only thing that reaches the DAC.
// The web player stays the source of truth for track/queue/position; mpv is driven from its state.
//
// WHERE THE AUDIO COMES FROM: /file/url hands back no playable URL, only a segment template whose media
// segments are encrypted; the page decrypts them in JS on the way into MSE. So the one place plaintext FLAC
// exists is SourceBuffer.appendBuffer, and that is what we tap. The bytes go to the main process, which
// re-serves them to mpv over loopback. Nothing is re-downloaded and no key is touched.
//
// Only active in the Qobuzify WRAPPER, where window.__QZBP__ (the preload IPC bridge to the mpv sidecar)
// exists. On the patched Windows desktop app - which already has native bit-perfect via JUCE/WASAPI-exclusive
// - the bridge is absent and this whole extension is inert.
var Q = Qobuzify;
var BP = window.__QZBP__;
if (!BP || !BP.feed) return function () {}; // not the wrapper (or no sidecar): no-op

var CSS_ID = "qz-bp-css";
var LS_ON = "qz-bitperfect:on";
var enabled = false, disposed = false;
var mode = "off", curRate = 0, curFmt = "";
var lastTrackId = null, lastPlaying = null, lastWebMs = 0, lastWall = 0;
var sourceBuffers = [];   // live audio SourceBuffers, for forcing a re-feed on mid-track enable
var lastInit = null;      // most recent init segment ('ftyp'), replayed when enabling mid-track

function on() { try { return localStorage.getItem(LS_ON) === "1"; } catch (e) { return false; } }
function setOn(v) { try { localStorage.setItem(LS_ON, v ? "1" : "0"); } catch (e) { } }

// An init segment opens with an 'ftyp' box; media segments open with 'styp'. That distinction is the only
// reliable track boundary here - a poll on the track id races the first appendBuffer of the next track.
function isInit(u8) { return u8.length > 8 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70; }

function tapMse() {
  try {
    var proto = SourceBuffer.prototype, orig = proto.appendBuffer;
    if (!orig || orig.__qzbp) return;
    var wrapped = function (buf) {
      try {
        var src = buf && buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf;
        var u8 = new Uint8Array(src);
        if (isInit(u8)) {
          lastInit = u8.slice(0);
          if (enabled) { BP.send({ type: "newtrack" }); BP.feed(u8.slice(0)); }
        } else if (enabled) {
          BP.feed(u8.slice(0));
        }
      } catch (e) { }
      return orig.apply(this, arguments);
    };
    wrapped.__qzbp = 1;
    proto.appendBuffer = wrapped;

    var addSb = MediaSource.prototype.addSourceBuffer;
    if (addSb && !addSb.__qzbp) {
      var wrapAdd = function (mime) {
        var sb = addSb.apply(this, arguments);
        try { if (String(mime).indexOf("audio") >= 0) sourceBuffers.push(sb); } catch (e) { }
        return sb;
      };
      wrapAdd.__qzbp = 1;
      MediaSource.prototype.addSourceBuffer = wrapAdd;
    }
  } catch (e) { }
}

// Enabling mid-track is the awkward case: the page has usually already appended the whole track, so no
// further bytes are coming and mpv would sit silent until the next one. Dropping the buffered range leaves
// a hole at the playhead, which makes the player re-fetch and re-append - and those appends we do capture.
function forceRefeed() {
  if (!lastInit) return false;
  BP.send({ type: "newtrack" });
  BP.feed(lastInit.slice(0));
  var did = false;
  sourceBuffers.forEach(function (sb) {
    try { if (!sb.updating) { sb.remove(0, Infinity); did = true; } } catch (e) { }
  });
  return did;
}

// --- the muted web element keeps the timeline alive; mute it (re-assert on track change: it may be recreated) ---
// The web player's <audio> is never attached to the document, so querySelector("audio") finds nothing.
// Catch it on the prototype instead: muting inside play() lands before the original runs, so it never
// gets an audible frame out.
var mediaEls = [];
function trackEl(el) { try { if (el && mediaEls.indexOf(el) < 0) mediaEls.push(el); } catch (e) {} }
function hookMedia() {
  try {
    var proto = HTMLMediaElement.prototype, orig = proto.play;
    if (!orig || orig.__qzbp) return;
    var wrapped = function () {
      trackEl(this);
      if (enabled) { try { this.muted = true; this.volume = 0; } catch (e) {} }
      return orig.apply(this, arguments);
    };
    wrapped.__qzbp = 1;
    proto.play = wrapped;
  } catch (e) {}
}
function muteWeb(m) {
  try {
    var d = document.querySelector("audio"); if (d) trackEl(d); // attached one too, if a build ever ships that
    mediaEls.forEach(function (a) {
      try {
        if (m) { if (a.__qzVol == null) a.__qzVol = a.volume; a.muted = true; a.volume = 0; }
        else { a.muted = false; if (a.__qzVol != null) { a.volume = a.__qzVol; a.__qzVol = null; } }
      } catch (e) {}
    });
  } catch (e) {}
}

// --- read web-player state (source of truth) ---
function curTrack() { try { return Q.player.getTrack(); } catch (e) { return null; } }
function isPlaying() { try { return !!(Q.player.isPlaying && Q.player.isPlaying()); } catch (e) { return false; } }
function posMs() { try { return Q.player.getPositionMs ? Q.player.getPositionMs() : 0; } catch (e) { return 0; } }

// --- drive mpv from the web state (one-directional; the web UI renders its own progress off its live clock) ---
// The bytes arrive on their own via the MSE tap, which also opens each track on its init segment, so there
// is no URL to hand over here; this only has to keep transport state in step.
function loadCurrent() {
  var tr = curTrack(); if (!tr || tr.id == null) return;
  lastTrackId = String(tr.id);
  if (!enabled) return;
  BP.send(isPlaying() ? { type: "play" } : { type: "pause" });
}

function syncTick() {
  if (disposed || !enabled) return;
  var tr = curTrack(); var id = tr && tr.id != null ? String(tr.id) : null;
  if (id && id !== lastTrackId) { loadCurrent(); lastPlaying = null; lastWebMs = posMs(); lastWall = Date.now(); return; }
  var playing = isPlaying();
  if (playing !== lastPlaying) { BP.send(playing ? { type: "play" } : { type: "pause" }); lastPlaying = playing; if (playing) { BP.send({ type: "seek", ms: posMs() }); } }
  // seek detection: a position jump not explained by wall-clock elapsed => user scrubbed
  var now = Date.now(), pm = posMs();
  if (playing) {
    var expected = lastWebMs + (now - lastWall);
    if (Math.abs(pm - expected) > 900) BP.send({ type: "seek", ms: pm });
  }
  lastWebMs = pm; lastWall = now;
  muteWeb(true); // keep it muted (element can be recreated on track change)
}

// --- indicator (player slot): honest mode + rate, fed by mpv events ---
// Deliberately says nothing about quality: the Hi-Res logo is quality-badges' job, drawn with Qobuz's own
// hires.png. This must never duplicate or stand in for it. While bit-perfect is off the slot renders
// nothing at all, so the player bar is identical to the Windows app, which has no such extension.
var badge = document.createElement("div");
badge.className = "qz-bp-badge"; badge.title = "Bit-perfect: audio bypasses the browser mixer to your DAC at native rate. Volume is on your DAC/system while active.";
function fmtRate(r) { return r ? (r % 1000 === 0 ? (r / 1000) + "kHz" : (r / 1000).toFixed(1) + "kHz") : ""; }
function renderBadge() {
  if (!enabled) { badge.className = "qz-bp-badge off"; badge.textContent = ""; badge.style.display = "none"; return; }
  badge.style.display = "";
  if (mode === "exclusive") { badge.className = "qz-bp-badge bp"; badge.textContent = "Bit-perfect" + (curRate ? " · " + fmtRate(curRate) : ""); }
  else if (mode === "shared") { badge.className = "qz-bp-badge shared"; badge.textContent = "Shared" + (curRate ? " · " + fmtRate(curRate) : ""); }
  else { badge.className = "qz-bp-badge wait"; badge.textContent = "Bit-perfect…"; }
}
var slot = Q.playerSlot ? Q.playerSlot({ id: "qz-bp", zone: "right", order: 12, el: badge }) : null;

BP.on(function (m) {
  if (disposed || !m) return;
  if (m.type === "ready") { mode = m.mode || mode; renderBadge(); }
  else if (m.type === "params") { curRate = m.rate || curRate; curFmt = m.format || curFmt; if (m.mode) mode = m.mode; renderBadge(); }
  else if (m.type === "mode") { mode = m.mode; renderBadge(); }
  else if (m.type === "fatal" || m.type === "disabled") { mode = "off"; muteWeb(false); renderBadge(); } // sidecar died -> unmute so audio never fully drops
});

// --- enable / disable ---
function enable() {
  if (enabled) return; enabled = true; setOn(true);
  BP.send({ type: "enable" });
  muteWeb(true);
  lastTrackId = null; lastPlaying = null;
  // Mid-track: nudge the player into re-appending so bytes start flowing now rather than next track.
  if (curTrack() && isPlaying()) forceRefeed();
  loadCurrent();
  renderBadge();
  toast("Bit-perfect on");
}
function disable() {
  if (!enabled) return; enabled = false; setOn(false);
  BP.send({ type: "disable" });
  muteWeb(false);
  mode = "off"; renderBadge();
  toast("Bit-perfect off");
}
function toggle() { if (enabled) disable(); else enable(); }

hookMedia(); // install before the first play() so no element ever escapes the registry
tapMse();    // and before the first appendBuffer, so we always hold the current track's init segment
var syncTimer = setInterval(syncTick, 300);
var offChange = Q.player.onChange ? Q.player.onChange(function () { if (enabled) { loadCurrent(); } }) : null;

// settings row + a small player-bar click target on the badge
badge.addEventListener("click", toggle);
var unregSettings = Q.registerSettings ? Q.registerSettings({
  label: "Bit-perfect audio", sub: "Play FLAC byte-exact to your DAC (exclusive mode), bypassing the browser mixer. Native rate per track. Volume moves to your DAC/system while on.",
  button: (on() ? "Turn off" : "Turn on"), onClick: toggle
}) : null;

function toast(msg) {
  var t = document.getElementById("qz-bp-toast");
  if (!t) { t = document.createElement("div"); t.id = "qz-bp-toast"; t.className = "qz-bp-toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove("show"); }, 1600);
}

Q.css(CSS_ID, [
  ".qz-bp-badge{font:700 10.5px/1 system-ui,sans-serif;letter-spacing:.02em;padding:4px 9px;border-radius:999px;cursor:pointer;user-select:none;",
  "display:inline-flex;align-items:center;white-space:nowrap;transition:background .15s,color .15s;}",
  // Hidden via the class, not inline style: playerSlot re-creates the node and carries className over,
  // but drops inline styles. `.qz-bp-badge.off` also outranks the base rule's display.
  ".qz-bp-badge.off{display:none !important;}",
  ".qz-bp-badge.wait{background:rgba(255,255,255,.08);color:#aeb4be;}",
  ".qz-bp-badge.bp{background:linear-gradient(90deg,var(--qz-accent,#3DA8FE),#7bc8ff);color:#04121f;box-shadow:0 0 0 1px rgba(61,168,254,.35);}",
  ".qz-bp-badge.shared{background:rgba(245,158,11,.16);color:#f0b34a;box-shadow:0 0 0 1px rgba(245,158,11,.3);}",
  ".qz-bp-badge:hover{filter:brightness(1.08);}",
  ".qz-bp-toast{position:fixed;left:50%;bottom:98px;transform:translateX(-50%) translateY(8px);background:rgba(20,22,28,.97);color:#fff;",
  "padding:8px 16px;border-radius:11px;font:600 13px/1 system-ui,sans-serif;z-index:2147483600;opacity:0;pointer-events:none;",
  "transition:opacity .2s,transform .2s;box-shadow:0 10px 34px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.1);}",
  ".qz-bp-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}"
].join(""));

// restore last state
if (on()) enable(); else renderBadge();

return function cleanup() {
  disposed = true;
  if (syncTimer) clearInterval(syncTimer);
  if (offChange) offChange();
  try { if (enabled) { BP.send({ type: "disable" }); muteWeb(false); } } catch (e) {}
  enabled = false; // the prototype taps gate on this, and they outlive cleanup
  // The taps stay installed: another extension may have wrapped over them since, so unwinding here
  // would clobber whoever wrapped last. Gated off, they cost a branch per append.
  if (slot) slot.remove();
  if (unregSettings) unregSettings();
  var t = document.getElementById("qz-bp-toast"); if (t) t.remove();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
