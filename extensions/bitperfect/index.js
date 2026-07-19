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
// The extension can be re-initialised while the prototype taps (which must outlive cleanup) keep running.
// Anything the tap reads therefore CANNOT live in per-instance closure state: measured in the field, the
// sink was invoked with init segments while its own `enabled` was pinned false by a long-dead instance,
// so mpv sat idle holding the DAC and not one byte was ever fed. Keep the authoritative flag on window so
// whichever instance enables and whichever tap runs are always looking at the same thing.
var G = (window.__QZBP_G__ = window.__QZBP_G__ || { enabled: false });
function bpEnabled() { try { return enabled || !!G.enabled; } catch (e) { return enabled; } }
function setBpEnabled(v) { enabled = !!v; try { G.enabled = !!v; } catch (e) {} }
var mode = "off", curRate = 0, curFmt = "";
var hwRate = 0;      // rate the DAC is actually clocked at, straight from the kernel
var bpTrue = false;  // every condition below holds, i.e. the DAC gets the file's own samples
var bpWhy = null;    // which condition failed: "rate" | "gain" | "gain-unknown" | "convert"
var bpGain = 1;      // linear gain the output applies to our samples (1 = untouched)
var bpPro = false;   // sink is on a Pro Audio profile (explains a SOFTWARE volume multiply)
var bpSrcRate = 0;   // decoder-side rate, to show what a player-side conversion converted FROM
var lastTrackId = null, lastPlaying = null, lastWebMs = 0, lastWall = 0;
var reassert = 0;   // tick counter for the periodic transport re-send (see syncTick)
var sourceBuffers = [];   // live audio SourceBuffers, for forcing a re-feed on mid-track enable
var lastInit = null;      // most recent init segment ('ftyp'), replayed when enabling mid-track

function on() { try { return localStorage.getItem(LS_ON) === "1"; } catch (e) { return false; } }
function setOn(v) { try { localStorage.setItem(LS_ON, v ? "1" : "0"); } catch (e) { } }

// An init segment opens with an 'ftyp' box; media segments open with 'styp'. That distinction is the only
// reliable track boundary here - a poll on the track id races the first appendBuffer of the next track.
function isInit(u8) { return u8.length > 8 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70; }

// THE TAP MUST NOT CLOSE OVER INSTANCE STATE.
// This bit was silently fatal. The prototype wrappers deliberately outlive cleanup (unwinding them could
// clobber whoever wrapped over us since), and cleanup sets `enabled = false`. But tapMse() bails when the
// prototype is ALREADY wrapped - so after the extension re-initialises, the live wrapper is still the FIRST
// instance's closure, whose `enabled` is pinned false forever. The new instance then sets its own
// `enabled = true`, sends "enable", spawns mpv... and waits for bytes from a tap that can never call it.
// Observed exactly that: 41 appendBuffer calls during a track change, zero BP.send, zero BP.feed, mpv
// idle-active with the DAC held. So the wrapper now dispatches to a GLOBAL that the CURRENT instance owns,
// and re-init simply re-points it.
function onSegment(u8) {
  var en = bpEnabled();
  if (isInit(u8)) {
    lastInit = u8.slice(0);
    // Carry the transport state. The main process used to assume a new track meant "playing", but this
    // fires on any init segment - including the one the web player buffers while PAUSED as it restores the
    // last session at launch. That made the sidecar start playing into a paused UI, and the only way out
    // was to skip and come back, which forced a real track change and resynced it.
    if (en) { BP.send({ type: "newtrack", playing: isPlaying() }); BP.feed(u8.slice(0)); }
  } else if (en) {
    BP.feed(u8.slice(0));
  }
}
function onNewSourceBuffer(sb) { try { if (sourceBuffers.indexOf(sb) < 0) sourceBuffers.push(sb); } catch (e) {} }

function tapMse() {
  try {
    // Always claim the sinks, even if the wrappers are already installed by a previous instance.
    window.__QZBP_SINK__ = onSegment;
    window.__QZBP_SB__ = onNewSourceBuffer;

    var proto = SourceBuffer.prototype, orig = proto.appendBuffer;
    if (!orig) return;
    if (!orig.__qzbp) {
      var wrapped = function (buf) {
        try {
          var src = buf && buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf;
          var sink = window.__QZBP_SINK__;
          if (sink) sink(new Uint8Array(src));
        } catch (e) { }
        return orig.apply(this, arguments);
      };
      wrapped.__qzbp = 1;
      proto.appendBuffer = wrapped;
    }

    var addSb = MediaSource.prototype.addSourceBuffer;
    if (addSb && !addSb.__qzbp) {
      var wrapAdd = function (mime) {
        var sb = addSb.apply(this, arguments);
        try { if (String(mime).indexOf("audio") >= 0 && window.__QZBP_SB__) window.__QZBP_SB__(sb); } catch (e) { }
        return sb;
      };
      wrapAdd.__qzbp = 1;
      MediaSource.prototype.addSourceBuffer = wrapAdd;
    }
  } catch (e) { }
}

// Say what happened. Enabling used to either work or produce silence with no explanation anywhere, which
// is the single most expensive failure mode in this codebase.
function bpLog(m) { try { console.log("[Qobuzify bit-perfect] " + m); } catch (e) {} }

// The player's own seek handle (React fiber props.seek), same one media-session drives. Needed because
// dropping the buffered range alone does not reliably make the player re-request: seeking to where the
// playhead already is does, and it is the only way to make bytes flow through our tap again mid-track.
var _seekInst = null;
function seekInput() { return document.querySelector(".player__progressbar input[type=range]") || document.querySelector(".player__progressbar input"); }
function findSeekInstance() {
  try {
    if (_seekInst && _seekInst.props && typeof _seekInst.props.seek === "function") return _seekInst;
    var input = seekInput(); if (!input) return null;
    var fk = Object.keys(input).find(function (k) { return k.indexOf("__reactInternalInstance$") === 0; });
    if (!fk) return null;
    var f = input[fk], d = 0;
    while (f && d++ < 40) { var sn = f.stateNode; if (sn && sn.props && typeof sn.props.seek === "function") { _seekInst = sn; return sn; } f = f.return; }
  } catch (e) {}
  return null;
}
function nudgeReappend() {
  var inst = findSeekInstance();
  if (!inst) return false;
  try { inst.props.seek({ position: Math.max(0, posMs()) }); return true; } catch (e) { return false; }
}

// Enabling mid-track is the awkward case: the page has usually already appended the whole track, so no
// further bytes are coming and mpv would sit idle holding the DAC. Two nudges, because neither alone was
// enough: drop the buffered range to leave a hole at the playhead, THEN seek to that position so the
// player actually notices the hole and re-requests. Those re-appends are what we capture.
// Returns whether we could plausibly start now; false means "wait for the next track", which the tap
// will pick up on its own via the next init segment.
function forceRefeed() {
  if (!lastInit) { bpLog("no init segment captured yet - will start on the next track"); return false; }
  BP.send({ type: "newtrack", playing: isPlaying() });
  BP.feed(lastInit.slice(0));
  var dropped = 0;
  sourceBuffers.forEach(function (sb) {
    try { if (!sb.updating) { sb.remove(0, Infinity); dropped++; } } catch (e) { }
  });
  var sought = nudgeReappend();
  bpLog("bootstrap: sourceBuffers=" + sourceBuffers.length + " dropped=" + dropped + " seek=" + sought);
  if (!dropped && !sought) bpLog("could not make the player re-append - will start on the next track");
  return dropped > 0 || sought;
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
      // Same proof gate as everywhere else: a freshly created element must stay audible until mpv is
      // known to be receiving audio, or this hook alone would re-introduce the silent failure.
      if (bpEnabled() && !bpStalled) { try { this.muted = true; this.volume = 0; } catch (e) {} }
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

// --- volume -> the DAC's hardware mixer -----------------------------------------------------------
// With bit-perfect on, the web element is muted and mpv runs at unity gain, so Qobuz's volume slider
// controls nothing. Rather than grey it out, mirror it onto the DAC's own hardware volume: the samples
// stay untouched and the attenuation happens in the device, which is the only way to have a working
// slider AND bit-perfect at once. Read the level off the slider's RENDERED FILL, never the store -
// settings.volume goes stale (it sits pinned at 100 while the rendered slider moves).
var stallToldOnce = false;   // one toast per session, not one per track
var bpLive = false;          // mpv has confirmed real audio (badge/state only)
// Muting is NOT an optimisation, it is how the DAC gets freed. The web element playing through PipeWire
// holds the very device mpv must open EXCLUSIVELY, so "do not mute until mpv proves itself" deadlocks:
// the element keeps the device, mpv is refused, it never proves anything, so we never mute. Measured
// exactly that (pipewire holding /dev/snd/pcmC1D1p while mpv sat idle). So: mute provisionally to let mpv
// try, and if it has not delivered audio within the watchdog window, unmute and stay in Shared.
var bpStalled = false;
var hwVol = { supported: false, elem: null };
var lastSentVol = null;
function sliderPct() {
  try {
    var sl = document.querySelector(".player__settings-volume-slider .rangeslider");
    if (!sl) return null;
    var w = sl.getBoundingClientRect().width || 0;
    var fill = sl.querySelector(".rangeslider__fill");
    if (!w || !fill) return null;
    return Math.max(0, Math.min(100, Math.round((fill.getBoundingClientRect().width || 0) / w * 100)));
  } catch (e) { return null; }
}
function pushVol(force) {
  if (disposed || !enabled || !hwVol.supported) return;
  var p = sliderPct();
  if (p == null || (!force && p === lastSentVol)) return;
  lastSentVol = p;
  BP.send({ type: "volume", pct: p });
}

function syncTick() {
  if (disposed || !enabled) return;
  pushVol(false);
  var tr = curTrack(); var id = tr && tr.id != null ? String(tr.id) : null;
  if (id && id !== lastTrackId) { loadCurrent(); lastPlaying = null; lastWebMs = posMs(); lastWall = Date.now(); return; }
  var playing = isPlaying();
  // Edge-triggered alone is not enough. The sidecar's transport can be moved by things this loop never
  // observed (a newtrack arriving from the MSE tap, a respawn after a mode change, a dropped command), and
  // once the two disagree nothing here would ever notice, because `playing` still matches `lastPlaying`.
  // Reassert periodically so any divergence heals on its own instead of needing a skip to clear it.
  reassert = (reassert + 1) % 10;                       // ~3s at the 300ms tick
  if (playing !== lastPlaying || reassert === 0) {
    BP.send(playing ? { type: "play" } : { type: "pause" });
    if (playing && playing !== lastPlaying) BP.send({ type: "seek", ms: posMs() });
    lastPlaying = playing;
  }
  // seek detection: a position jump not explained by wall-clock elapsed => user scrubbed
  var now = Date.now(), pm = posMs();
  if (playing) {
    var expected = lastWebMs + (now - lastWall);
    if (Math.abs(pm - expected) > 900) BP.send({ type: "seek", ms: pm });
  }
  lastWebMs = pm; lastWall = now;
  // Keep it muted while we are still trying or succeeding; once the watchdog has given up we must stop
  // re-muting, or the fallback to normal playback would be silently undone every tick.
  if (!bpStalled) muteWeb(true); // element can be recreated on track change
}

// --- indicator (player slot): honest mode + rate, fed by mpv events ---
// Deliberately says nothing about quality: the Hi-Res logo is quality-badges' job, drawn with Qobuz's own
// hires.png. This must never duplicate or stand in for it. While bit-perfect is off the slot renders
// nothing at all, so the player bar is identical to the Windows app, which has no such extension.
// The old tooltip asserted "Volume is on your DAC/system while active", which is not true on every setup:
// under a Pro Audio profile the app's slider drives the DAC's own ALSA control while the desktop's slider
// moves a SOFTWARE gain in the audio server, so they are two different controls and only one of them keeps
// the samples intact. The badge now describes the state it actually measured, per track, rather than
// promising a behaviour up front.
var TIP_WAIT = "Bit-perfect sends audio straight to your DAC instead of through the browser's mixer. "
  + "The badge reports what was actually measured for the current track.";
var badge = document.createElement("div");
badge.className = "qz-bp-badge"; badge.title = TIP_WAIT;
function fmtRate(r) { return r ? (r % 1000 === 0 ? (r / 1000) + "kHz" : (r / 1000).toFixed(1) + "kHz") : ""; }
// The claim is driven by the measured rates the main process reports, never by which output path we happen
// to be on. Exclusive and passthrough are both bit-perfect when the converter is clocked at the track's
// rate, and neither is when it isn't, so one flag decides the wording and a rate mismatch is shown outright
// rather than hidden behind a mode name the user has no way to check.
function renderBadge() {
  if (!enabled) { badge.className = "qz-bp-badge off"; badge.textContent = ""; badge.style.display = "none"; return; }
  badge.style.display = "";
  if (!curRate) { badge.className = "qz-bp-badge wait"; badge.textContent = "Bit-perfect…"; badge.title = TIP_WAIT; return; }
  if (bpTrue) {
    badge.className = "qz-bp-badge bp"; badge.textContent = "Bit-perfect · " + fmtRate(curRate);
    badge.title = "Bit-perfect: this track decodes at " + fmtRate(curRate) + ", your converter is clocked at "
      + fmtRate(hwRate) + ", and the output volume is at unity, so the samples reaching the DAC are the samples in the file.";
    return;
  }
  badge.className = "qz-bp-badge shared";
  // Say WHICH condition failed. "Shared" told the user nothing they could act on, and a rate-only message
  // was worse than nothing once we learned a below-unity sink volume silently multiplies every sample:
  // the badge read "44.1 → 96kHz" as though rate were the only problem while gain was also breaking it.
  if (bpWhy === "gain") {
    badge.textContent = "Volume " + Math.round(bpGain * 100) + "%";
    badge.title = "Not bit-perfect: your output volume is at " + Math.round(bpGain * 100) + "%, so every sample is "
      + "being multiplied before it reaches the DAC."
      + (bpPro ? " Under a Pro Audio profile that happens in software, because the profile exposes no hardware volume control for the server to use."
               : "")
      + " Set the system volume for this output to 100% and use your DAC's own volume control instead.";
  } else if (bpWhy === "gain-unknown") {
    badge.textContent = "Volume ?";
    badge.title = "Cannot confirm bit-perfect: the output volume could not be read, so it is not possible to say "
      + "whether the samples are being scaled. Claiming bit-perfect here would be a guess.";
  } else if (bpWhy === "convert") {
    badge.textContent = fmtRate(bpSrcRate) + " → " + fmtRate(curRate);
    badge.title = "Not bit-perfect: the player had to convert this track before output (the audio device would not "
      + "accept it as decoded), so these are no longer the original samples.";
  } else if (hwRate && hwRate !== curRate) {
    badge.textContent = fmtRate(curRate) + " → " + fmtRate(hwRate);
    badge.title = "Not bit-perfect: this track is " + fmtRate(curRate) + " but your converter is clocked at "
      + fmtRate(hwRate) + ", so it is being resampled. This happens when the audio graph is pinned to one rate, "
      + "or when your hardware does not support the track's rate at all.";
  } else {
    badge.textContent = "Shared · " + fmtRate(curRate);
    badge.title = TIP_WAIT;
  }
}
var slot = Q.playerSlot ? Q.playerSlot({ id: "qz-bp", zone: "right", order: 12, el: badge }) : null;

BP.on(function (m) {
  if (disposed || !m) return;
  if (m.type === "ready") { mode = m.mode || mode; renderBadge(); }
  else if (m.type === "params") {
    curRate = m.rate || curRate; curFmt = m.format || curFmt; if (m.mode) mode = m.mode;
    hwRate = m.hwRate || 0; bpTrue = !!m.bitperfect;
    bpWhy = m.why || null; bpPro = !!m.pro; bpSrcRate = m.srcRate || 0;
    bpGain = (typeof m.gain === "number") ? m.gain : 1;
    renderBadge();
  }
  // A mode change means the main process is respawning mpv on a different output, so the loaded track is
  // gone with the old process. Re-feed it, or playback stops here and never resumes anywhere - which is
  // precisely how degrading turned into permanent silence instead of a downgrade.
  else if (m.type === "mode") {
    mode = m.mode;
    if (mode !== "exclusive") { bpTrue = false; }
    if (bpLive) { bpLive = false; if (curTrack() && isPlaying()) forceRefeed(); }
    renderBadge();
  }
  else if (m.type === "fatal" || m.type === "disabled") { bpLive = false; mode = "off"; muteWeb(false); renderBadge(); } // sidecar died -> unmute so audio never fully drops
  // Real audio reached mpv, so it is safe to hand the DAC over and silence the web element. Fires per
  // track, and muting is idempotent, so a track change re-arms it without a gap.
  else if (m.type === "live") { bpLive = true; bpStalled = false; muteWeb(true); if (mode === "off") mode = "shared"; renderBadge(); }
  // Enabled, playing, and nothing ever reached the sidecar. Rather than sit silent holding the DAC, fall
  // back to normal playback and SAY so - the failure used to be completely invisible in both directions.
  // A refused device is no longer a dead end that needs its own event: the main process checks whether the
  // PCM is free before it picks a path, and degrades to the sound server if the open is refused anyway, so
  // there is always an output that plays. What used to arrive here as "unavailable" now arrives as a plain
  // mode change above, handled by re-feeding rather than by giving up and unmuting the browser.
  else if (m.type === "stalled") {
    bpLive = false; bpStalled = true; muteWeb(false); mode = "shared"; renderBadge();
    bpLog("mpv could not take the device (something else is holding it) - playing normally instead");
    if (!stallToldOnce) { stallToldOnce = true; toast("Bit-perfect couldn't start - playing normally"); }
  }
  else if (m.type === "hwvol") {
    hwVol.supported = !!m.supported; hwVol.elem = m.elem || null;
    // The device keeps its own volume across launches, so on enable the slider and the hardware can
    // disagree. Only adopt the slider here when doing so LOWERS the level: these are headphones, and
    // syncing a high slider onto a quiet DAC would fire a jump straight into someone's ears. Raising
    // stays a deliberate act, and every later slider move mirrors normally.
    if (hwVol.supported) {
      var p = sliderPct();
      if (p != null && m.pct != null && p < m.pct) pushVol(true);
      else lastSentVol = p;
    }
    renderBadge();
  }
});

// --- enable / disable ---
function enable() {
  if (enabled) return; setBpEnabled(true); setOn(true); syncSettingsButton();
  BP.send({ type: "enable" }); bpLive = false;
  // Mute now: this is what makes PipeWire drop the device so mpv's exclusive open can succeed. The
  // watchdog undoes it if mpv does not deliver audio, so a failed start degrades instead of going silent.
  bpStalled = false;
  muteWeb(true);
  lastTrackId = null; lastPlaying = null;
  // Mid-track: nudge the player into re-appending so bytes start flowing now rather than next track.
  var boot = (curTrack() && isPlaying()) ? forceRefeed() : true;
  loadCurrent();
  renderBadge();
  toast(boot ? "Bit-perfect on" : "Bit-perfect on - starts on the next track");
}
function disable() {
  if (!enabled) return; setBpEnabled(false); setOn(false); syncSettingsButton(); stallToldOnce = false; bpLive = false; bpStalled = false;
  BP.send({ type: "disable" });
  muteWeb(false);
  mode = "off"; renderBadge();
  toast("Bit-perfect off");
}
function toggle() { if (enabled) disable(); else enable(); }
// Keep the settings row's label in step with reality, whichever control changed it. Guarded because
// enable() can run during boot, before the row object below exists.
function syncSettingsButton() {
  try { if (settingsEntry) settingsEntry.button = bpEnabled() ? "Turn off" : "Turn on"; } catch (e) {}
}

hookMedia(); // install before the first play() so no element ever escapes the registry
tapMse();    // and before the first appendBuffer, so we always hold the current track's init segment
var syncTimer = setInterval(syncTick, 300);
var offChange = Q.player.onChange ? Q.player.onChange(function () { if (enabled) { loadCurrent(); } }) : null;

// settings row + a small player-bar click target on the badge
badge.addEventListener("click", toggle);
// The panel renders `button` off THIS object every time it opens, so keeping the object in a variable and
// updating the label is what keeps the two controls agreeing. It used to be an inline literal whose label
// was computed once, at registration: clicking the badge changed the real state but left the row reading
// its boot-time text, so the row then both LIED about the state and, because onClick just toggles whatever
// is actually true, appeared to do the opposite of what its own button said.
var settingsEntry = {
  // Deliberately promises less than it used to. "(exclusive mode)" described a path most Linux setups can
  // never take: where the sound server holds the device open by policy, an exclusive open is refused for as
  // long as that profile is selected, so the app plays through the server instead. Whether the result is
  // byte-exact then depends on the track's rate and the output volume, which is what the badge reports.
  label: "Bit-perfect audio", sub: "Send FLAC straight to your DAC at its native rate, bypassing the browser mixer. The badge shows whether the current track really is byte-exact, and what is in the way when it is not.",
  button: (on() ? "Turn off" : "Turn on"), onClick: toggle
};
var unregSettings = Q.registerSettings ? Q.registerSettings(settingsEntry) : null;

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
  enabled = false;
  // Only clear the SHARED flag if we still own the sink; a newer live instance must keep running.
  try { if (window.__QZBP_SINK__ === onSegment) G.enabled = false; } catch (e) {}
  // Release the sinks, but ONLY if they are still ours: a newer instance may have claimed them already,
  // and stealing them back is precisely how the tap went permanently dead before.
  try { if (window.__QZBP_SINK__ === onSegment) window.__QZBP_SINK__ = null; } catch (e) {}
  try { if (window.__QZBP_SB__ === onNewSourceBuffer) window.__QZBP_SB__ = null; } catch (e) {}
  // The taps stay installed: another extension may have wrapped over them since, so unwinding here
  // would clobber whoever wrapped last. Gated off, they cost a branch per append.
  if (slot) slot.remove();
  if (unregSettings) unregSettings();
  var t = document.getElementById("qz-bp-toast"); if (t) t.remove();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
