// Media Session - lockscreen / notification / Bluetooth-headset transport controls.
// Runs as function(Qobuzify, vendor){ ... return cleanup }.
//
// Qobuz's web player never touches the W3C Media Session API (verified: navigator.mediaSession,
// MediaMetadata, setActionHandler, setPositionState and playbackState appear NOWHERE in the
// qobuz-dwp-ui bundle), so the OS has nothing to show on a phone lockscreen / notification, in the
// Windows SMTC or macOS Now Playing card, or on a car display - and hardware media keys / headset
// buttons fall back to the browser default (which, with no <audio> element it can see, does nothing
// useful). This wires it up: on every track change we publish MediaMetadata (title/artist/album +
// cover art); a light 1s interval publishes positionState (for the OS scrubber) and playbackState;
// and setActionHandler routes play / pause / next / prev / seek back to Qobuz by driving the same
// native player-bar controls the rest of Qobuzify uses. Fully inert where the API is absent, and it
// self-cleans on cleanup (handlers cleared, interval stopped, metadata dropped).
//
// The audio engine is a sealed JUCE controller with no reachable API, so - exactly like seek-controls
// and the mobile-app - transport is "click the native control" and seek is the player's own progress
// bar (React-fiber props.seek primary, synthetic mousemove+mouseup fallback). Works on desktop and
// mobile alike; on desktop the native player bar is visible, on mobile it stays mounted but hidden.
//
// ANDROID (Qobuzify WebView app): the W3C Media Session API in a System WebView does NOT reach the OS
// lockscreen / OxygenOS Live Actions (no media element it tracks - audio is Web Audio / MSE). So the
// WebView host injects window.QZAndroidMedia, a bridge to a NATIVE android.media.session.MediaSession +
// MediaStyle foreground service. This same extension detects that bridge and pushes the identical
// metadata + play/pause/position it already computes, and exposes window.__qzMediaCmd(cmd,arg) so the
// native session's callbacks (lockscreen / notification / hardware keys) drive the SAME player-bar
// transport used above. Everything bridge-side is a strict no-op when window.QZAndroidMedia is absent
// (desktop / web), so there is no second copy of the transport logic - both surfaces share this one.

var Q = Qobuzify;

// ---- feature detection: drive whichever "now playing" surface exists ----
// hasWebMS = the W3C Media Session API (desktop + most mobile browsers).
// AB       = the Qobuzify Android native bridge (present only inside the WebView app).
// Bail fully inert only when NEITHER exists.
var hasWebMS = (typeof navigator !== "undefined" && navigator && ("mediaSession" in navigator) && typeof window.MediaMetadata === "function");
// Linux system media controls live on D-Bus in the main process; the preload exposes the bridge.
var MPRIS = (typeof window !== "undefined" && window.__QZMPRIS__) || null;
var AB = (typeof window !== "undefined" && window.QZAndroidMedia) ? window.QZAndroidMedia : null;
if (!hasWebMS && !AB) return function cleanup() {};
// When the Android bridge exists it's authoritative (it reaches the lockscreen / OxygenOS Live Actions
// and holds real audio focus); also driving the W3C API there is redundant and can surface a duplicate
// media card, so prefer the native session EXCLUSIVELY on Android. ms stays null then; guard every ms.* use.
var ms = (!AB && hasWebMS) ? navigator.mediaSession : null;

// ---- transport: drive the native player bar (same selectors mobile-app / boot use) ----
function clickEl(sel) {
  var el = document.querySelector(sel);
  if (!el) return false;
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  return true;
}
function isPlaying() { try { return Q.player.isPlaying(); } catch (e) { return false; } }
function togglePlay() { clickEl(".player__action-pause, .player__action-play"); }
function playNext() { clickEl(".pct-player-next, .player__action-next"); }
function playPrev() { clickEl(".pct-player-prev, .player__action-previous"); }
function curPosMs() { try { return Q.player.getPositionMs(); } catch (e) { return 0; } }
function curDurMs() { try { return (Q.getState().player.currentTrack || {}).duration || 0; } catch (e) { return 0; } } // duration is ms

// ---- seek: React-fiber props.seek({position}) is primary (geometry-independent, works while the bar is
// hidden); the synthetic drag on .player__progressbar is the fallback (seek-controls' inverted formula). ----
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
function seekToMs(msPos) {
  var dur = curDurMs();
  if (dur) msPos = Math.max(0, Math.min(msPos, dur));
  msPos = Math.round(msPos);
  var inst = findSeekInstance();
  if (inst) { try { inst.props.seek({ position: msPos }); return true; } catch (e) {} }
  var bar = document.querySelector(".player__progressbar"), input = seekInput();   // fallback: synthetic drag
  if (!bar || !input) return false;
  var d = parseInt(input.max, 10) || dur || 0; if (!d) return false;
  var rect = bar.getBoundingClientRect(); if (!rect.width) return false;
  var clientX = Math.max(rect.left + 1, Math.min(rect.left + rect.width - 1, rect.left + 7.5 + msPos * (rect.width - 15) / d));
  var clientY = input.getBoundingClientRect().top + 6;
  var o = { bubbles: true, cancelable: true, view: window, clientX: clientX, clientY: clientY, button: 0 };
  bar.dispatchEvent(new MouseEvent("mousemove", o));
  input.dispatchEvent(new MouseEvent("mouseup", o));
  return true;
}

// ---- metadata: publish on track change (and when the cover url first resolves) ----
// upgrade a Qobuz cover thumbnail (..._50.jpg / _230.jpg) to a crisp 600px for the lockscreen; keep the
// original as a fallback entry. If the pattern doesn't match we just use the url as-is.
function bigArt(url) {
  if (!url) return url;
  try { return url.replace(/_\d+(\.[a-z]+)(\?.*)?$/i, "_600$1$2"); } catch (e) { return url; }
}
var lastMetaKey = null;
function applyMetadata(force) {
  var tk = null; try { tk = Q.player.getTrack(); } catch (e) {}
  if (!tk || !tk.id) {
    if (lastMetaKey !== null) {
      if (ms) { try { ms.metadata = null; } catch (e) {} }
      lastMetaKey = null;
    }
    return;
  }
  var key = String(tk.id) + "|" + (tk.cover || "");
  if (!force && key === lastMetaKey) return;   // unchanged: nothing to do (also how we skip re-setting every tick)
  lastMetaKey = key;
  var title = tk.title || "";
  var artist = tk.artist || (tk.artists && tk.artists.join(", ")) || "";
  var album = tk.album || "";
  var big = tk.cover ? bigArt(tk.cover) : "";
  var durMs = tk.durationMs || 0;
  if (!durMs) { try { durMs = (Q.getState().player.currentTrack || {}).duration || 0; } catch (e) {} }
  if (ms) {
    var art = [];
    if (tk.cover) {
      if (big && big !== tk.cover) art.push({ src: big, sizes: "600x600" });
      art.push({ src: tk.cover });   // sizes omitted => treated as matching any size (fallback)
    }
    try {
      ms.metadata = new MediaMetadata({ title: title, artist: artist, album: album, artwork: art });
    } catch (e) { lastMetaKey = null; }   // let the next tick retry
  }
  // Android native bridge: hand the crisp cover url over; the native side fetches + downscales it.
  // Gated by the lockscreen toggle (when off we publish no live metadata to the native session).
  if (AB && lockscreenOn()) { try { AB.updateMeta(title, artist, album, big || tk.cover || "", durMs); } catch (e) {} }
}

// ---- Android lockscreen toggle (mobile-app Settings > Appearance "Lockscreen and Live Actions") ----
// mobile-lockscreen in Q.storage: string "1"/"0", default "1" = on. When off we tear the native session
// down once and stop pushing to the bridge; the W3C path (ms.*) is never affected. No-op when AB is absent.
function lockscreenOn() { try { return Q.storage.get("mobile-lockscreen", "1") !== "0"; } catch (e) { return true; } }
var lastLockFlag = null;   // null = unknown; tracks on<->off transitions so we tear down / re-publish exactly once

// ---- position + playback state (the OS scrubber and play/pause glyph) ----
function publishState() {
  var id = null, dur = 0;
  try { var ct = Q.getState().player.currentTrack; id = ct && ct.id; dur = (ct && ct.duration) || 0; } catch (e) {}
  applyMetadata(false);   // cheap: early-returns unless the id or cover changed since last publish
  var playing = isPlaying();
  var posMs = curPosMs();
  if (ms) {
    try { ms.playbackState = id ? (playing ? "playing" : "paused") : "none"; } catch (e) {}
    if (typeof ms.setPositionState === "function") {
      if (id && dur > 0) {
        var durS = dur / 1000;
        var posS = Math.max(0, Math.min(posMs / 1000, durS));
        try { ms.setPositionState({ duration: durS, playbackRate: 1, position: posS }); } catch (e) {}
      } else {
        try { ms.setPositionState(); } catch (e) {}   // no track / unknown duration -> clear the scrubber
      }
    }
  }
  // Linux system media controls: the desktop wants the same fields the web MediaSession gets, but it
  // lives on D-Bus in the main process. mpris-main only rewrites (and signals) metadata when the track
  // id actually changes, so pushing every tick is cheap.
  if (MPRIS) {
    var tkm = null; try { tkm = Q.player.getTrack(); } catch (e) {}
    var cov = (tkm && tkm.cover) || "";
    try {
      MPRIS.send({
        trackId: id == null ? null : String(id),
        title: (tkm && tkm.title) || "",
        artist: (tkm && (tkm.artist || (tkm.artists && tkm.artists.join(", ")))) || "",
        album: (tkm && tkm.album) || "",
        artUrl: cov ? (bigArt(cov) || cov) : "",
        durationMs: dur || (tkm && tkm.durationMs) || 0,
        positionMs: posMs,
        playing: !!(id && playing),
      });
    } catch (e) {}
  }
  // Android native bridge: play/pause + position for the native MediaSession (~1s tick while playing).
  // Lockscreen toggle: when off, tear the native session down ONCE (updateState(false,0)) then stop pushing;
  // when re-enabled, re-publish metadata and resume. The W3C path above is untouched.
  if (AB) {
    if (!lockscreenOn()) {
      if (lastLockFlag !== false) { try { AB.updateState(false, 0); } catch (e) {} lastLockFlag = false; }
    } else {
      if (lastLockFlag === false) { lastMetaKey = null; applyMetadata(true); }   // re-enabled -> push fresh metadata
      lastLockFlag = true;
      try { AB.updateState(id ? playing : false, id ? posMs : 0); } catch (e) {}
    }
  }
}

// ---- action handlers -> native controls. play/pause are guarded (we only have a toggle, so check state
// first) so the OS "play" always plays and "pause" always pauses instead of blindly flipping. ----
var ACTIONS = [
  ["play", function () { if (!isPlaying()) togglePlay(); }],
  ["pause", function () { if (isPlaying()) togglePlay(); }],
  ["stop", function () { if (isPlaying()) togglePlay(); }],
  ["previoustrack", function () { playPrev(); }],
  ["nexttrack", function () { playNext(); }],
  ["seekbackward", function (d) { var off = (d && d.seekOffset) || 10; seekToMs(curPosMs() - off * 1000); }],
  ["seekforward", function (d) { var off = (d && d.seekOffset) || 10; seekToMs(curPosMs() + off * 1000); }],
  ["seekto", function (d) {
    if (!d || typeof d.seekTime !== "number") return;
    if (d.fastSeek === true && typeof ms.setPositionState === "function") { /* let a fast-seek land as a normal seek */ }
    seekToMs(d.seekTime * 1000);
  }]
];
var registered = [];
if (ms) {
  ACTIONS.forEach(function (a) {
    try { ms.setActionHandler(a[0], a[1]); registered.push(a[0]); } catch (e) { /* action not supported here */ }
  });
}

// ---- native (Android) transport dispatcher ----
// The WebView host calls window.__qzMediaCmd from the native MediaSession.Callback (lockscreen scrubber,
// notification buttons, hardware/Bluetooth media keys). It maps straight onto the same guarded transport
// helpers the W3C action handlers use, so both surfaces behave identically. Installed only when the bridge
// is present; restored on cleanup.
var dispatcher = null, prevCmd = null, hadPrevCmd = false;
// One command path for every surface. The Android bridge, MPRIS (Linux media keys) and the W3C action
// handlers all funnel through this, so a play from the lockscreen, the keyboard and the OS widget can
// never drift apart. Defined unconditionally - MPRIS needs it even where the Android bridge is absent.
function runCmd(cmd, arg) {
  try {
    switch (cmd) {
      case "play": if (!isPlaying()) togglePlay(); break;
      case "pause": if (isPlaying()) togglePlay(); break;
      case "playpause": case "toggle": togglePlay(); break;
      case "stop": if (isPlaying()) togglePlay(); break;
      case "next": case "nexttrack": playNext(); break;
      case "prev": case "previous": case "previoustrack": playPrev(); break;
      case "seek": case "seekto": seekToMs(typeof arg === "number" ? arg : (parseInt(arg, 10) || 0)); break;
    }
  } catch (e) {}
  return true;
}
if (AB) {
  hadPrevCmd = ("__qzMediaCmd" in window); prevCmd = window.__qzMediaCmd;
  dispatcher = runCmd;
  window.__qzMediaCmd = dispatcher;
}
// Linux media keys arrive here from the main process (wrapper/mpris-main.js). Per the MPRIS spec Seek
// carries a RELATIVE offset while SetPosition is absolute, so translate both to an absolute seek and
// echo the result back, otherwise the desktop's scrubber drifts away from where we actually landed.
if (MPRIS && MPRIS.onCmd) {
  MPRIS.onCmd(function (m) {
    if (!m || !m.action) return;
    if (m.action === "seek" || m.action === "setpos") {
      var t = m.action === "seek" ? curPosMs() + (Number(m.ms) || 0) : (Number(m.ms) || 0);
      t = Math.max(0, t);
      seekToMs(t);
      try { MPRIS.seeked(t); } catch (e) {}
      return;
    }
    runCmd(m.action);
  });
}

// ---- wire up: initial publish, react to track changes, and a light 1s heartbeat ----
applyMetadata(true);
publishState();
var offChange = null;
try { offChange = Q.player.onChange(function () { applyMetadata(true); publishState(); }); } catch (e) {}
var iv = setInterval(publishState, 1000);

return function cleanup() {
  if (iv) { clearInterval(iv); iv = null; }
  if (offChange) { try { offChange(); } catch (e) {} offChange = null; }
  if (ms) {
    registered.forEach(function (name) { try { ms.setActionHandler(name, null); } catch (e) {} });
    try { ms.metadata = null; } catch (e) {}
    try { ms.playbackState = "none"; } catch (e) {}
    try { if (typeof ms.setPositionState === "function") ms.setPositionState(); } catch (e) {}
  }
  registered = [];
  if (AB) {
    try { AB.updateState(false, 0); } catch (e) {}   // tell the native session we've stopped
    if (window.__qzMediaCmd === dispatcher) {
      if (hadPrevCmd) window.__qzMediaCmd = prevCmd;
      else { try { delete window.__qzMediaCmd; } catch (e) { window.__qzMediaCmd = undefined; } }
    }
  }
  lastMetaKey = null;
};
