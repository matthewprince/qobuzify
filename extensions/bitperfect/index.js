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
// Same rule for state the outliving hooks READ AND WRITE: elements muted by a dead instance must stay
// reachable, or the unmute-on-failure paths iterate an empty array and the track stays silent. And the
// captured init segment must survive re-init, or a mid-track re-enable has nothing to prime mpv with.
if (!G.mediaEls) G.mediaEls = [];   // every media element any instance ever saw play()
if (G.lastInit === undefined) G.lastInit = null; // most recent init segment ('ftyp'), replayed when enabling mid-track
function bpEnabled() { try { return enabled || !!G.enabled; } catch (e) { return enabled; } }
function setBpEnabled(v) { enabled = !!v; try { G.enabled = !!v; } catch (e) {} }

// DIRECT STREAM (experimental). Instead of tapping decrypted MSE bytes and feeding them to mpv, the main
// process signs track/getFileUrl and hands mpv a plain FLAC CDN URL (see wrapper/qz-fileurl.js). mpv then
// owns the stream: real Range seeking, no starvation, no ftyp-as-track-boundary guessing. The web element
// still plays muted for its clock / scrobble / queue, and we drive mpv one-directionally off real events.
// Flag lives on G (the tap dispatches globally and must see the same value across a re-init).
// --- direct-mode outcome counter (local only, no network) ------------------------------------------
// Direct stream is opt-in ("experimental") and the question blocking a default flip is simply: how often
// does getFileUrl fail to produce a playable URL, and why. `directfail` already degrades gracefully (that
// track plays through the muted web element, the next one retries), but nothing counted it, so the answer
// was a guess. Keep a denominator (direct loads attempted) beside the reasons; read it with
// JSON.parse(localStorage["qz-bitperfect:directstats"]). Bounded, swallowed, and never on the audio path.
var LS_DSTATS = "qz-bitperfect:directstats";
function dstat(field) {
  try {
    var o = {};
    try { o = JSON.parse(localStorage.getItem(LS_DSTATS) || "{}") || {}; } catch (e) { o = {}; }
    if (typeof o !== "object") o = {};
    o[field] = (o[field] || 0) + 1;
    o.since = o.since || new Date().toISOString().slice(0, 10);
    localStorage.setItem(LS_DSTATS, JSON.stringify(o));
  } catch (e) {}
}
var LS_DIRECT = "qz-bitperfect:direct";
function directOn() { try { return localStorage.getItem(LS_DIRECT) === "1"; } catch (e) { return false; } }
G.direct = directOn();
function setDirect(v) { try { localStorage.setItem(LS_DIRECT, v ? "1" : "0"); } catch (e) {} G.direct = !!v; }
var BP_APPID = "798273057"; // the web player's app id (the wrapper host is always play.qobuz.com)
var _bundleUrl = null;
function bundleUrl() { if (!_bundleUrl) { try { var s = document.querySelector('script[src*="/bundle.js"]'); _bundleUrl = s ? s.src : null; } catch (e) {} } return _bundleUrl; }
function bpToken() { try { return (Q.getState().user && Q.getState().user.token) || ""; } catch (e) { return ""; } }
var lastMpvMs = null, lastMpvAt = 0; // most recent mpv position report, for the direct-mode drift net

// THE position of the audio the user can actually HEAR, in ms, or null when we are not the one making sound.
// In direct mode mpv plays the FLAC while the web <audio> element runs MUTED purely as a clock - and those two
// diverge (the muted element shares bandwidth with mpv's own fetch, so it starves and its clock falls behind).
// Anything that must line up with the SOUND - the lyrics view above all - has to read this, not the element:
// syncTick's drift net deliberately tolerates up to 1.5s of divergence, which is inaudible for the transport
// but is 2-3 words of visible lag in word-by-word karaoke. Returns null (caller falls back to the web clock)
// unless direct mode is genuinely producing audio and mpv reported recently, so a stale value can never be
// mistaken for the truth. Assigned unconditionally so the LIVE instance always owns it after a re-init.
window.__QZBP_AUDIOPOS__ = function () {
  try {
    if (disposed || !enabled || !G.direct || bpStalled || directFailed || !bpLive) return null;
    if (lastMpvMs == null) return null;
    // PAUSED: report mpv's last position WITHOUT extrapolating. Adding wall-clock elapsed while stopped made
    // the lyric clock keep advancing after a pause - the highlight crawled on for ~2s (until the report aged
    // out below) and only then froze, which reads as "it lags for a second, then pauses".
    if (!isPlaying()) return lastMpvMs;
    var age = Date.now() - lastMpvAt;
    if (age < 0 || age > 2000) return null;   // mpv went quiet (stalled/respawning) - not authoritative
    return lastMpvMs + age;                   // extrapolate between mpv's coarse reports
  } catch (e) { return null; }
};
var directFailed = false, directToldOnce = false, _lastDirectId = null;
var mode = "off", curRate = 0, curFmt = "";
var hwRate = 0;      // rate the DAC is actually clocked at, straight from the kernel
var bpTrue = false;  // every condition below holds, i.e. the DAC gets the file's own samples
var bpWhy = null;    // ARRAY of failed conditions: "rate" | "gain" | "gain-unknown" | "convert" | "device-unknown"
var bpGain = 1;      // linear gain the output applies to our samples (1 = untouched)
var bpPro = false;   // sink is on a Pro Audio profile (explains a SOFTWARE volume multiply)
var bpSrcRate = 0;   // decoder-side rate, to show what a player-side conversion converted FROM
var lastTrackId = null, lastPlaying = null, lastWebMs = 0, lastWall = 0;
var reassert = 0;   // tick counter for the periodic transport re-send (see syncTick)
// Shared cooldown for BOTH seek sites in syncTick. MUST init to 0, never undefined: `now - undefined` is NaN,
// every comparison against it is false, and the resync would be silently disabled forever.
var lastSeekAt = 0;
// Age of the Qobuz store's position anchor. Diagnostic only (logged beside a resync), never a gate: during a
// starve the anchor stops being refreshed while playingState stays "play", which is what lets posMs() run away.
function anchorAgeMs() {
  try { var p = Q.getState().player.position; return p && p.timestamp ? (Date.now() - p.timestamp) : -1; } catch (e) { return -1; }
}
// Set on a track change, cleared once the resulting play-transition is handled. In DIRECT mode the
// "directtrack" handler already positions mpv (main.js: loadfile, then seek only when startMs > 250), so the
// seek that normally rides along with a play-transition would re-seek a file mpv has only just started - and
// an absolute seek on a fresh HTTP stream is a Range RE-REQUEST, which audibly drops the audio and restarts
// it ~300ms into every song (and burns a second fetch, starving the muted web element into a buffering
// spinner). Suppress just that one redundant seek; real scrubs are still caught by the jump detector below.
var justLoaded = false;
var sourceBuffers = [];   // live audio SourceBuffers, for forcing a re-feed on mid-track enable
var lastFeedId = null;    // store track id the current mpv feed belongs to; guards spurious mid-track re-inits
var endedLatch = false;   // one early-EOF resync per track, so a healthy auto-advance can never loop on it
var endfeedSent = false;  // tap mode: the feed's clean EOF is announced once per track
var lastLoadAt = 0;       // when mpv was last handed a file; gates the 'ended' handler off fresh loads
var modeWaitT = null;     // tap-mode output-change fallback timer (unmute if the replayed feed never goes live)
var lastSentMute = false; // fixed-output DACs: mirror slider-at-zero onto mpv's stream mute
var lastAheadLog = 0;     // throttle for the drift net's "mpv ahead" diagnostic

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
  // Direct mode drives mpv from a signed URL, not this feed. Still record the init so a switch back to the
  // tap mid-track has the header, but never feed bytes - mpv is already streaming the CDN copy.
  if (en && G.direct) { if (isInit(u8)) G.lastInit = u8.slice(0); return; }
  if (isInit(u8)) {
    G.lastInit = u8.slice(0);
    // Carry the transport state. The main process used to assume a new track meant "playing", but this
    // fires on any init segment - including the one the web player buffers while PAUSED as it restores the
    // last session at launch. That made the sidecar start playing into a paused UI, and the only way out
    // was to skip and come back, which forced a real track change and resynced it.
    if (en) {
      // 'ftyp' is NOT a reliable track boundary: Qobuz re-emits an init segment MID-TRACK on hi-res
      // streams (a segment discontinuity / MSE re-init - seen on Faithfully ~2:11). Every such init used
      // to fire newtrack -> loadfile replace, restarting mpv, and because the boundary recurs the track
      // looped. The store track id (Q.player.getTrack().id) flips instantly and does NOT lag like the DOM,
      // so gate on it: only (re)start the feed for a genuinely new id, or a real restart-from-top of the
      // same song (repeat / seek-to-0). A same-id init deep into the track is spurious - ignore it and let
      // the media segments keep feeding the existing mpv stream uninterrupted.
      var tr = curTrack(), id = tr && tr.id != null ? String(tr.id) : null;
      if (!id || id !== lastFeedId || posMs() < 1500) {
        lastFeedId = id;
        lastLoadAt = Date.now();
        BP.send({ type: "newtrack", playing: isPlaying() });
        BP.feed(u8.slice(0));
      }
    }
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

// Enabling mid-track: hand mpv this track's codec header and let the tap forward whatever segments the
// player appends next. If the track is still playing (segments are still being appended progressively),
// bit-perfect picks up within a segment. If it is already fully buffered (nothing more will append),
// nothing flows and we cleanly wait for the next track's init - the current track just keeps playing
// normally in the browser, untouched.
//
// The old version DROPPED the player's buffered range (sb.remove(0, Infinity)) + seeked, to force a
// re-append. That was the bug behind "couldn't start" and the silent-paused sidecar: dropping the buffer
// stalls the web player into a rebuffer, which reads as paused, which left mpv paused into silence - and
// when the re-append never came, we had already muted, so the track went silent and the watchdog had to
// rescue it with a scary toast. We do NOT touch the player's buffer anymore. Priming is non-destructive.
function forceRefeed() {
  if (!G.lastInit) { bpLog("no init segment captured yet - bit-perfect starts on the next track"); return false; }
  lastLoadAt = Date.now();
  BP.send({ type: "newtrack", playing: isPlaying() });
  BP.feed(G.lastInit.slice(0));
  return true;
}

// --- the muted web element keeps the timeline alive; mute it (re-assert on track change: it may be recreated) ---
// The web player's <audio> is never attached to the document, so querySelector("audio") finds nothing.
// Catch it on the prototype instead: muting inside play() lands before the original runs, so it never
// gets an audible frame out.
function trackEl(el) {
  try {
    if (el && G.mediaEls.indexOf(el) < 0) {
      G.mediaEls.push(el);
      // The elements are detached by design, so nothing else ever releases them: without a cap this
      // registry retains every element the session ever played. The recent few are all the
      // unmute-on-failure paths can meaningfully act on.
      if (G.mediaEls.length > 8) G.mediaEls.splice(0, G.mediaEls.length - 8);
    }
  } catch (e) {}
}
// Same re-init hazard as the MSE tap above: the play() wrapper outlives cleanup, so it must not close
// over instance state. It used to read a dead instance's frozen `bpStalled` and push elements into a
// dead registry, so after any re-init the live instance's muteWeb(false) unmuted nothing. Dispatch
// through a re-pointable global the CURRENT instance owns, exactly like __QZBP_SINK__.
function onPlayEl(el) {
  trackEl(el);
  // Same proof gate as everywhere else: a freshly created element must stay audible until mpv is
  // known to be receiving audio, or this hook alone would re-introduce the silent failure.
  if (bpEnabled() && !bpStalled) { try { el.muted = true; el.volume = 0; } catch (e) {} }
}
function hookMedia() {
  try {
    window.__QZBP_PLAYHOOK__ = onPlayEl; // claim even if the wrapper is already installed
    var proto = HTMLMediaElement.prototype, orig = proto.play;
    if (!orig || orig.__qzbp) return;
    var wrapped = function () {
      try { var h = window.__QZBP_PLAYHOOK__; if (h) h(this); } catch (e) {}
      return orig.apply(this, arguments);
    };
    wrapped.__qzbp = 1;
    proto.play = wrapped;
  } catch (e) {}
}
function muteWeb(m) {
  try {
    var d = document.querySelector("audio"); if (d) trackEl(d); // attached one too, if a build ever ships that
    G.mediaEls.forEach(function (a) {
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
  if (G.direct) {
    var tok = bpToken();
    if (tok) {
      // loadCurrent fires from both syncTick and Q.player.onChange on a track change; dedupe so we sign
      // getFileUrl once per track, not twice. A directfail keeps the id latched, so a dead track is not
      // retried in a storm; a real track change (or a re-enable, which clears it) sends again.
      if (String(tr.id) === _lastDirectId) return;
      _lastDirectId = String(tr.id);
      lastLoadAt = Date.now();
      dstat("attempts"); BP.send({ type: "directtrack", trackId: tr.id, token: tok, appId: BP_APPID, bundleUrl: bundleUrl(), playing: isPlaying(), startMs: posMs() }); return;
    }
    // no token (not logged in yet) - fall through to plain transport; the next track change retries.
  }
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
// The main process's own comment always promised "the renderer can keep the slider greyed and say why" on
// a fixed-output DAC - but nothing ever did it, so the slider rendered fully live while audibly doing
// nothing, which reads as a broken app. Grey it, say why in the tooltip, and say it once out loud.
var fixedVolTold = false;
function syncVolUi() {
  try {
    var box = document.querySelector(".player__settings-volume-slider");
    if (!box) return;
    var fixed = !disposed && enabled && !hwVol.supported && !bpStalled && !directFailed;
    box.classList.toggle("qz-bp-fixedvol", fixed);
    if (fixed) {
      box.title = "Volume is fixed while bit-perfect is on: this DAC has no volume control Qobuzify can drive. Use the DAC or amp's own knob. Dragging to zero still mutes.";
      if (!fixedVolTold) { fixedVolTold = true; toast("Volume is on your DAC while bit-perfect is on"); }
    } else if (box.classList) {
      if (box.title && box.title.indexOf("bit-perfect") >= 0) box.title = "";
    }
  } catch (e) {}
}

function syncTick() {
  if (disposed || !enabled) return;
  pushVol(false);
  var tr = curTrack(); var id = tr && tr.id != null ? String(tr.id) : null;
  if (id && id !== lastTrackId) { bpStalled = false; directFailed = false; lastMpvMs = null; lastSeekAt = 0; justLoaded = true; endedLatch = false; endfeedSent = false; loadCurrent(); lastPlaying = null; lastWebMs = posMs(); lastWall = Date.now(); return; }
  var playing = isPlaying();
  // Edge-triggered alone is not enough. The sidecar's transport can be moved by things this loop never
  // observed (a newtrack arriving from the MSE tap, a respawn after a mode change, a dropped command), and
  // once the two disagree nothing here would ever notice, because `playing` still matches `lastPlaying`.
  // Reassert periodically so any divergence heals on its own instead of needing a skip to clear it.
  reassert = (reassert + 1) % 10;                       // ~3s at the 300ms tick
  if (playing !== lastPlaying || reassert === 0) {
    BP.send(playing ? { type: "play" } : { type: "pause" });
    // Direct mode right after a load: mpv is already at the right spot (see justLoaded) - re-seeking it here
    // is what caused the start-of-song audio drop. Tap mode still seeks, since there a seek means "re-feed
    // from here" rather than an HTTP Range re-request.
    if (playing && playing !== lastPlaying && !(justLoaded && G.direct)) BP.send({ type: "seek", ms: posMs() });
    if (playing) justLoaded = false;
    lastPlaying = playing;
  }
  // seek detection: a position jump not explained by wall-clock elapsed => user scrubbed. The web clock is
  // the truth in both modes, so mpv follows it (tap: re-feed target; direct: mpv Range-seeks the URL).
  //
  // WHY THE GUARDS BELOW EXIST. posMs() is NOT the element's currentTime - it is a wall-clock extrapolation off
  // the Qobuz store's position anchor (base = position.value, plus Date.now()-position.timestamp while
  // playingState is "play"), clamped to the track duration. When the muted element starves, Qobuz stops
  // refreshing that anchor but LEAVES playingState "play", so posMs() free-runs and PINS AT THE DURATION.
  // Measured in a live stuck state: anchor age 1,291,899ms, bufferState "underrun", element.currentTime frozen
  // at 51.8s, yet getPositionMs() == duration and mpv had already hit EOF. The jump detector cannot see this
  // (it re-baselines lastWebMs/lastWall every tick, so a smooth runaway yields ~0 error), but the drift net
  // below had no direction test and no cooldown, so it seeked mpv FORWARD to the duration at ~3 seeks/s -
  // and every one of those is an HTTP Range re-request that starves the element further, sustaining the
  // buffering spinner. Then when the anchor snapped back it dragged mpv BACKWARDS by the whole accumulated
  // gap, which is the passage heard twice. Hence: never seek to a target inside the duration clamp, and
  // rate-limit the resyncs.
  var now = Date.now(), pm = posMs();
  var durMs = (tr && tr.durationMs) || 0;
  // A target within 2s of the end is the runaway clock, not a real position. Fail OPEN when the duration is
  // unknown. A genuine user scrub into the last 2s is ignored and self-heals at the track boundary.
  var sane = !(durMs && pm >= durMs - 2000);
  if (playing) {
    var expected = lastWebMs + (now - lastWall);
    if (Math.abs(pm - expected) > 900) {
      if (sane && now - lastSeekAt > 900) {
        BP.send({ type: "seek", ms: pm }); lastSeekAt = now;
        // A backward jump to ~0 on the SAME id is repeat-one / restart-from-top. mpv sits in keep-open
        // pause at EOF then, and the ~3s periodic reassert was the only thing that unpaused it - a 1-3s
        // silence gap on every loop. An explicit play (idempotent) closes the gap; also re-arm the
        // once-per-track ended latch, since the same file is starting over.
        if (pm < expected - 2000) endedLatch = false;
        BP.send({ type: "play" });
      } else bpLog("seek SUPPRESSED jump pm=" + pm + " dur=" + durMs + " sane=" + sane);
    }
    // Direct-mode drift net: a scrub is caught above, but a network rebuffer can leave mpv trailing the web
    // clock with no web-side jump to notice it. ONE-DIRECTIONAL by design (R5): only correct mpv when it
    // TRAILS the web clock. The other direction - mpv ahead of the web clock - is exactly what a starving
    // muted element looks like (its anchor freezes while mpv plays on), and seeking mpv backward to match
    // a lagging clock replays a passage the user already heard. Also gated on anchor freshness (R6): when
    // the store's position anchor has not been refreshed recently, pm is a wall-clock extrapolation off a
    // stale anchor - a lying target no seek should chase. Fails open when the anchor age is unreadable.
    else if (G.direct && lastMpvMs != null && (now - lastMpvAt) < 2500) {
      var mpvExtrap = lastMpvMs + (now - lastMpvAt);
      var aAge = anchorAgeMs();
      var anchorFresh = aAge < 0 || aAge < 2000;
      if (pm - mpvExtrap > 1500) {
        if (sane && anchorFresh && now - lastSeekAt > 3000) {
          bpLog("drift seek pm=" + pm + " mpv=" + mpvExtrap + " dur=" + durMs + " anchorAge=" + aAge);
          BP.send({ type: "seek", ms: pm }); lastSeekAt = now;
        } else bpLog("drift SUPPRESSED pm=" + pm + " mpv=" + mpvExtrap + " dur=" + durMs + " sane=" + sane + " anchorFresh=" + anchorFresh + " sinceSeek=" + (now - lastSeekAt));
      } else if (mpvExtrap - pm > 1500 && now - lastAheadLog > 5000) {
        lastAheadLog = now;
        bpLog("mpv ahead of web clock by " + (mpvExtrap - pm) + "ms (element lagging/starving) - not seeking, lyrics follow mpv");
      }
    }
    // Tap mode: announce the feed's clean end once the page has appended the whole track, so mpv gets a
    // real EOF instead of blocking forever on the open chunked response. Without this, mpv drains right at
    // the audible end of every track with core-idle=true and stale feed stamps, and a slow next-track init
    // could let the watchdog false-kill bit-perfect at the boundary.
    if (!G.direct && bpLive && !endfeedSent && durMs && pm > durMs - 2500) {
      var covered = false;
      try {
        for (var si = 0; si < sourceBuffers.length; si++) {
          var br = sourceBuffers[si].buffered;
          if (br && br.length && br.end(br.length - 1) * 1000 >= durMs - 700) { covered = true; break; }
        }
      } catch (e) {}
      if (covered) { endfeedSent = true; BP.send({ type: "endfeed" }); }
    }
  } else {
    // PAUSED scrub. The jump detector above only runs while playing, so a scrub made during a pause was
    // invisible: mpv stayed at the old position, __QZBP_AUDIOPOS__ kept reporting it, lyrics ignored the
    // scrub, and a lyric click seeked relative to the WRONG offset. While paused the position must not
    // move on its own, so any real change is a user scrub: seek mpv (it seeks fine while paused), drop
    // the stale position report so the lyric clock follows the element until mpv answers, and clear
    // justLoaded - the load position no longer matches, so the resume-edge seek must not be suppressed.
    if (Math.abs(pm - lastWebMs) > 900 && sane && now - lastSeekAt > 900) {
      justLoaded = false;
      lastMpvMs = null;
      BP.send({ type: "seek", ms: pm }); lastSeekAt = now;
      bpLog("paused scrub -> seek " + pm);
    }
  }
  lastWebMs = pm; lastWall = now;
  // Fixed-output DACs (hwvol unsupported): the slider cannot drive anything, but mute still can - mirror
  // slider-at-zero onto mpv's stream mute so the one control that CAN work does. mpv's mute is a flag,
  // not a sample multiply, so bit-perfect is untouched while unmuted.
  if (enabled && !hwVol.supported) {
    var sp2 = sliderPct();
    if (sp2 != null) {
      var mOn = sp2 === 0;
      if (mOn !== lastSentMute) { lastSentMute = mOn; BP.send({ type: "mute", on: mOn }); }
    }
  }
  if (reassert === 0) syncVolUi(); // slider element can be recreated; keep the fixed-volume styling on it
  // Keep it muted while we are still trying or succeeding; once we have given up (stall / direct failure)
  // we must stop re-muting, or the fallback to normal playback would be silently undone every tick.
  if (!bpStalled && !directFailed) muteWeb(true); // element can be recreated on track change
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
  // bpWhy is a LIST. It used to be one reason with gain checked last, so a rate mismatch hid a volume
  // problem - and "graph pinned to one rate" plus "sink below 100%" is the default state of a stock
  // desktop, so the hidden case was the common one. Lead the badge with the most actionable fault but
  // put every one of them in the tooltip, or the user fixes one and is told nothing about the rest.
  var reasons = bpWhy || [];
  if (reasons.length > 1) {
    var parts = [];
    if (reasons.indexOf("convert") >= 0) parts.push("the player had to convert it before output");
    if (reasons.indexOf("rate") >= 0) parts.push("this track is " + fmtRate(curRate) + " but your converter runs at " + fmtRate(hwRate));
    if (reasons.indexOf("device-unknown") >= 0) parts.push("the current output device could not be identified");
    if (reasons.indexOf("gain") >= 0) parts.push("the output volume is at " + Math.round(bpGain * 100) + "%, so every sample is being scaled");
    if (reasons.indexOf("gain-unknown") >= 0) parts.push("the output volume could not be read");
    badge.textContent = reasons.indexOf("gain") >= 0 && reasons.indexOf("rate") >= 0
      ? fmtRate(curRate) + " → " + fmtRate(hwRate) + " · " + Math.round(bpGain * 100) + "%"
      : (hwRate && hwRate !== curRate ? fmtRate(curRate) + " → " + fmtRate(hwRate) : "Not bit-perfect");
    badge.title = "Not bit-perfect, for " + parts.length + " reasons: " + parts.join("; ") + ".";
    return;
  }
  var bpWhy1 = reasons[0] || null;
  if (bpWhy1 === "device-unknown") {
    badge.textContent = "Output ?";
    badge.title = "Cannot confirm bit-perfect: the audio output in use could not be identified, so there is "
      + "nothing to check the track's rate against. This happens with Bluetooth or virtual/filtered outputs.";
    return;
  }
  if (bpWhy1 === "gain") {
    badge.textContent = "Volume " + Math.round(bpGain * 100) + "%";
    badge.title = "Not bit-perfect: your output volume is at " + Math.round(bpGain * 100) + "%, so every sample is "
      + "being multiplied before it reaches the DAC."
      + (bpPro ? " Under a Pro Audio profile that happens in software, because the profile exposes no hardware volume control for the server to use."
               : "")
      + " Set the system volume for this output to 100% and use your DAC's own volume control instead.";
  } else if (bpWhy1 === "gain-unknown") {
    badge.textContent = "Volume ?";
    badge.title = "Cannot confirm bit-perfect: the output volume could not be read, so it is not possible to say "
      + "whether the samples are being scaled. Claiming bit-perfect here would be a guess.";
  } else if (bpWhy1 === "convert") {
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

var offBP = BP.on(function (m) {
  if (disposed || !m) return;
  if (m.type === "ready") { mode = m.mode || mode; lastSentMute = false; renderBadge(); } // fresh mpv: its mute flag is back to default
  else if (m.type === "params") {
    curRate = m.rate || curRate; curFmt = m.format || curFmt; if (m.mode) mode = m.mode;
    hwRate = m.hwRate || 0; bpTrue = !!m.bitperfect;
    bpWhy = Array.isArray(m.why) ? m.why : (m.why ? [m.why] : []); bpPro = !!m.pro; bpSrcRate = m.srcRate || 0;
    bpGain = (typeof m.gain === "number") ? m.gain : 1;
    renderBadge();
  }
  // A mode change means the main process is respawning mpv on a different output, so the loaded track is
  // gone with the old process. Re-feed it, or playback stops here and never resumes anywhere - which is
  // precisely how degrading turned into permanent silence instead of a downgrade.
  else if (m.type === "mode") {
    mode = m.mode;
    if (mode !== "exclusive") { bpTrue = false; }
    // The respawned mpv lost the loaded stream and has to be handed the current track again.
    // DIRECT: clear the dedupe latch FIRST - with _lastDirectId still equal to the current track,
    // loadCurrent() returned early and this whole recovery path was dead code, leaving the main-side
    // replay to restart the song from 0:00.
    if (G.direct) { lastMpvMs = null; _lastDirectId = null; loadCurrent(); }
    else if (bpLive) {
      bpLive = false;
      // TAP: do NOT start a fresh init-only feed here. The main process replays the retained feed to the
      // respawned mpv on reconnect (and re-emits 'live' when that feed was already live), so re-feeding
      // just the header REPLACED the good feed with one that never goes live on a fully-appended track -
      // which is how a mid-track output change became silence for the rest of the track. Wait for the
      // replayed feed instead, and if no 'live' arrives, hand the track back to the browser and say so.
      if (modeWaitT) clearTimeout(modeWaitT);
      modeWaitT = setTimeout(function () {
        modeWaitT = null;
        if (disposed || !enabled || G.direct || bpLive) return;
        if (!curTrack() || !isPlaying()) return;
        bpLog("no audio after the output change - playing this track normally");
        bpStalled = true; curRate = 0; bpTrue = false; muteWeb(false); renderBadge();
      }, 3500);
    }
    renderBadge();
  }
  // mpv reached EOF. Healthy auto-advance also lands here (mpv EOFs ~130ms after the element flips
  // track), so every guard matters: only act when mpv's loaded track IS still the store's current track,
  // the store position is genuinely far from the end, and the file was not just loaded. That leaves only
  // the real failure: mpv ran out of audio mid-track (starve-accumulated drift, truncated stream) and sat
  // in keep-open pause producing silence while the store said playing - previously unhandled, silent tail.
  else if (m.type === "ended") {
    if (enabled && !endedLatch && !bpStalled && !directFailed) {
      var etr = curTrack(); var esid = etr && etr.id != null ? String(etr.id) : null;
      var mpvId = G.direct ? _lastDirectId : lastFeedId;
      var epm = posMs(); var edur = (etr && etr.durationMs) || 0;
      if (esid && esid === mpvId && edur && (edur - epm) > 3000 && (Date.now() - lastLoadAt) > 5000) {
        endedLatch = true;
        bpLog("mpv ended early (pm=" + epm + " dur=" + edur + ") - resyncing to the web clock");
        BP.send({ type: "seek", ms: epm });
        if (isPlaying()) BP.send({ type: "play" });
      }
    }
  }
  // Direct source: mpv's live position. Feeds the direct-mode drift net in syncTick AND __QZBP_AUDIOPOS__.
  else if (m.type === "position") { lastMpvMs = m.ms; lastMpvAt = Date.now(); if (!bpLive) bpLive = true; }
  // Direct source: getFileUrl could not resolve a playable URL for this track (region/format restriction,
  // or a transient network/auth issue). Fall back to the web element (still playing, just muted) for THIS
  // track; the next track change resets and retries. Not a fatal - bit-perfect stays on.
  else if (m.type === "directfail") {
    // Clear the measured terms like every OTHER give-up path does (:467, :482). Without this the badge kept
    // reporting the last successful track's rate while the audible path is the browser mixer, i.e. it claimed
    // bit-perfect over converted audio.
    dstat("fail_" + (m.reason || "unknown")); directFailed = true; curRate = 0; bpTrue = false; muteWeb(false); renderBadge();
    if (!directToldOnce) { directToldOnce = true; toast(m.reason === "restricted" ? "This track has no direct stream - playing normally" : "Direct stream unavailable right now - playing normally"); }
  }
  // The sidecar is gone for good. Unmuting once is NOT enough: syncTick re-mutes every 300ms while
  // `!bpStalled`, and hookMedia re-mutes any element created later, so the single muteWeb(false) here was
  // undone within one tick and the user was left in permanent silence - with the badge still reading
  // "Bit-perfect" and the settings row still offering to turn it off. Latch the dead state so the re-mute
  // stops, and put every control back to what is actually true.
  else if (m.type === "fatal" || m.type === "disabled") {
    bpLive = false; bpStalled = true; mode = "off";
    if (m.type === "fatal") { setBpEnabled(false); setOn(false); syncSettingsButton(); }
    curRate = 0; bpTrue = false; bpWhy = [];
    muteWeb(false); renderBadge();
    if (m.type === "fatal" && !stallToldOnce) { stallToldOnce = true; toast("Bit-perfect stopped - playing normally"); }
  }
  // Errors the main process was already reporting and this handler simply dropped on the floor, so the
  // three cases where the user goes silent and most needs telling were the three that said nothing.
  else if (m.type === "error") {
    bpLog("sidecar error: " + m.what + (m.msg ? " - " + m.msg : ""));
    if (m.what === "spawn" || m.what === "serve") {
      bpLive = false; bpStalled = true; setBpEnabled(false); setOn(false); syncSettingsButton();
      mode = "off"; curRate = 0; bpTrue = false; muteWeb(false); renderBadge();
      if (!stallToldOnce) { stallToldOnce = true; toast("Bit-perfect unavailable - playing normally"); }
    } else { // "load": this track failed, fall back for it rather than killing the feature
      // Clear the measured state too: the browser is about to play this track through the shared mixer,
      // and a bpTrue/curRate left over from the previous track would keep the badge claiming bit-perfect.
      bpLive = false; bpStalled = true; curRate = 0; bpTrue = false; muteWeb(false); renderBadge();
      if (!stallToldOnce) { stallToldOnce = true; toast("Bit-perfect couldn't play this track - playing normally"); }
    }
  }
  // Real audio reached mpv, so it is safe to hand the DAC over and silence the web element. Fires per
  // track, and muting is idempotent, so a track change re-arms it without a gap.
  else if (m.type === "live") { bpLive = true; bpStalled = false; if (modeWaitT) { clearTimeout(modeWaitT); modeWaitT = null; } muteWeb(true); if (mode === "off") mode = "shared"; renderBadge(); }
  // Enabled, playing, and nothing ever reached the sidecar. Rather than sit silent holding the DAC, fall
  // back to normal playback and SAY so - the failure used to be completely invisible in both directions.
  // A refused device is no longer a dead end that needs its own event: the main process checks whether the
  // PCM is free before it picks a path, and degrades to the sound server if the open is refused anyway, so
  // there is always an output that plays. What used to arrive here as "unavailable" now arrives as a plain
  // mode change above, handled by re-feeding rather than by giving up and unmuting the browser.
  else if (m.type === "stalled") {
    // curRate/bpTrue cleared for the same reason as the load-error branch above: no stale bit-perfect claim.
    bpLive = false; bpStalled = true; curRate = 0; bpTrue = false; muteWeb(false); mode = "shared"; renderBadge();
    bpLog("mpv could not take the device (something else is holding it) - playing normally instead");
    if (!stallToldOnce) { stallToldOnce = true; toast("Bit-perfect couldn't start - playing normally"); }
  }
  else if (m.type === "hwvol") {
    hwVol.supported = !!m.supported; hwVol.elem = m.elem || null;
    // The device keeps its own volume across launches, so on the FIRST report after enable the slider and
    // the hardware can disagree. Only adopt the slider then, and only when doing so LOWERS the level: these
    // are headphones, and syncing a high slider onto a quiet DAC would fire a jump straight into someone's
    // ears. Raising stays a deliberate act, and every later slider move mirrors normally.
    // ONE-SHOT, because every later hwvol is the write-echo of our own "volume" send, and amixer's coarse
    // hardware steps mean it can read back 1% HIGHER than what we wrote. Re-running the compare on the echo
    // re-sent, re-echoed, and spun an infinite IPC + amixer loop in the main process, so after the first
    // report the echo is ignored and lastSentVol stays what WE sent.
    if (hwVol.supported && lastSentVol == null) {
      var p = sliderPct();
      if (p != null && m.pct != null && p < m.pct) pushVol(true);
      else lastSentVol = p;
    }
    syncVolUi();
    renderBadge();
  }
});

// --- enable / disable ---
function enable() {
  if (enabled) return; setBpEnabled(true); setOn(true); syncSettingsButton();
  BP.send({ type: "enable" }); bpLive = false;
  // Do NOT mute the web element here. Muting up-front silenced the current track before we knew we could
  // feed it, and if we could not (already buffered), the track sat silent until the watchdog rescued it
  // with "couldn't start". The 'live' event mutes the browser the instant real audio reaches mpv - so we
  // only ever hand the DAC over once bit-perfect is genuinely producing sound. Until then the browser keeps
  // playing normally.
  bpStalled = false;
  lastTrackId = null; lastPlaying = null;
  lastSentVol = null; // re-arm the one-shot adopt in the hwvol handler
  // Prime mpv with the current track's header (non-destructive). Segments still being appended flow through
  // the tap and bit-perfect engages within a segment; a fully-buffered track quietly waits for the next one.
  directFailed = false; directToldOnce = false; lastMpvMs = null; _lastDirectId = null;
  // Direct mode loads the current track's signed URL immediately (no waiting for the next segment); the tap
  // path primes mpv with the captured header and engages within a segment, or waits for the next track.
  var primed = G.direct ? !!curTrack() : ((curTrack() && isPlaying()) ? forceRefeed() : false);
  loadCurrent();
  renderBadge();
  toast(G.direct ? "Bit-perfect on (direct stream)" : (primed ? "Bit-perfect on" : "Bit-perfect on - starts on the next track"));
}
function disable() {
  if (!enabled) return; setBpEnabled(false); setOn(false); syncSettingsButton(); stallToldOnce = false; bpLive = false; bpStalled = false;
  BP.send({ type: "disable" });
  muteWeb(false);
  mode = "off"; renderBadge(); syncVolUi();
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

// Direct-stream toggle. When on, mpv streams a signed FLAC URL instead of the decrypted MSE tap - real
// seeking, no starvation, no track-boundary guessing. Flipping it mid-session reloads the current track
// through the new source so there is no need to toggle bit-perfect off and on.
function toggleDirect() {
  setDirect(!G.direct);
  syncDirectButton();
  if (enabled) { directFailed = false; directToldOnce = false; lastMpvMs = null; lastTrackId = null; _lastDirectId = null; loadCurrent(); }
  toast(G.direct ? "Direct stream on" : "Direct stream off (tap)");
}
function syncDirectButton() { try { if (directEntry) directEntry.button = G.direct ? "On" : "Off"; } catch (e) {} }
var directEntry = {
  label: "Bit-perfect: direct stream (experimental)",
  sub: "Stream the FLAC file straight to mpv instead of tapping the browser. Fixes seeking, stalls and the odd skip. Uses more data while active (the browser keeps its own stream running for the clock).",
  button: (G.direct ? "On" : "Off"), onClick: toggleDirect
};
var unregDirect = Q.registerSettings ? Q.registerSettings(directEntry) : null;

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
  // Fixed-output DAC: the slider drives nothing, so it must look like it drives nothing.
  ".qz-bp-fixedvol{opacity:.45;}",
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
  if (modeWaitT) { clearTimeout(modeWaitT); modeWaitT = null; }
  try { if (offBP) offBP(); } catch (e) {} // release the preload's single event slot for the next instance
  try { var vb = document.querySelector(".player__settings-volume-slider.qz-bp-fixedvol"); if (vb) vb.classList.remove("qz-bp-fixedvol"); } catch (e) {}
  try { if (enabled) { BP.send({ type: "disable" }); muteWeb(false); } } catch (e) {}
  enabled = false;
  // Only clear the SHARED flag if we still own the sink; a newer live instance must keep running.
  try { if (window.__QZBP_SINK__ === onSegment) G.enabled = false; } catch (e) {}
  // Release the sinks, but ONLY if they are still ours: a newer instance may have claimed them already,
  // and stealing them back is precisely how the tap went permanently dead before.
  try { if (window.__QZBP_SINK__ === onSegment) window.__QZBP_SINK__ = null; } catch (e) {}
  try { if (window.__QZBP_SB__ === onNewSourceBuffer) window.__QZBP_SB__ = null; } catch (e) {}
  try { if (window.__QZBP_PLAYHOOK__ === onPlayEl) window.__QZBP_PLAYHOOK__ = null; } catch (e) {}
  // The taps stay installed: another extension may have wrapped over them since, so unwinding here
  // would clobber whoever wrapped last. Gated off, they cost a branch per append.
  if (slot) slot.remove();
  if (unregSettings) unregSettings();
  if (unregDirect) unregDirect();
  var t = document.getElementById("qz-bp-toast"); if (t) t.remove();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
