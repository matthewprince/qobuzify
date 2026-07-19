/* MPRIS - Linux system media controls: the keyboard's play/pause/next/prev keys, and the desktop's
   media widget.

   Electron never publishes Chromium's MPRIS layer, so nothing registers on D-Bus and the media keys
   land on nothing at all. No --enable-features combination fixes that (MediaSessionService and
   HardwareMediaKeyHandling were both tried and neither registers a service), so we register a real
   MPRIS service here and bridge it to the renderer. The renderer already knows how to drive Qobuz's
   sealed player: the media-session extension has the same play/pause/next/prev handlers it gives the
   web MediaSession API, and this reuses them rather than inventing a second control path.

   Everything is wrapped. No D-Bus session (a plain tty, a container, a locked-down sandbox) must
   never take the app down, and a missing module must degrade to "no media keys", not a crash. */
// Never fail silently. Every bug chased in this area was invisible because the failure path swallowed
// its own error, and MPRIS not registering is otherwise indistinguishable from "this desktop has no
// media keys at all". Say why we gave up.
function log(m) { try { console.error("[Qobuzify MPRIS] " + m); } catch (_) {} }
let player = null;
let positionUs = 0;   // MPRIS talks microseconds; the renderer sends milliseconds
let lastTrackKey = null;

// Start the service. `onCmd(action, valueMs)` is called for every control the desktop sends.
function start(onCmd) {
  if (process.platform !== "linux" || player) return player;
  let Player;
  try { Player = require("mpris-service"); }
  catch (e) { log("require('mpris-service') failed: " + (e && e.message)); return null; }
  try {
    player = Player({
      name: "qobuzify",            // bus name becomes org.mpris.MediaPlayer2.qobuzify
      identity: "Qobuzify",
      supportedInterfaces: ["player"],
    });
  } catch (e) { log("service registration failed (no session bus?): " + (e && e.message)); player = null; return null; }
  try {
    player.canRaise = true;
    player.canQuit = false;        // the desktop should not be able to kill the player
    player.canControl = true;
    player.canPlay = true;
    player.canPause = true;
    player.canGoNext = true;
    player.canGoPrevious = true;
    player.canSeek = true;
    player.rate = 1; player.minimumRate = 1; player.maximumRate = 1;
    player.getPosition = () => positionUs;

    const fire = (a, v) => { try { if (onCmd) onCmd(a, v); } catch (_) {} };
    ["play", "pause", "playpause", "stop", "next", "previous", "raise"].forEach((e) => {
      try { player.on(e, () => fire(e)); } catch (_) {}
    });
    // Seek carries a RELATIVE offset in microseconds; SetPosition carries an absolute one. Both are
    // handed on in milliseconds, which is what the renderer's seek helper takes.
    try { player.on("seek", (off) => fire("seek", Math.round(Number(off || 0) / 1000))); } catch (_) {}
    try { player.on("position", (ev) => fire("setpos", Math.round(Number((ev && ev.position) || 0) / 1000))); } catch (_) {}
  } catch (e) { log("wiring failed: " + (e && e.message)); }
  log("registered as org.mpris.MediaPlayer2.qobuzify");
  return player;
}

// Push the current track + transport state. Called on a light interval from the renderer, so this is
// deliberately cheap and only rewrites metadata when the track actually changes: assigning `metadata`
// emits a PropertiesChanged signal, and doing that every tick would spam the bus.
function update(s) {
  if (!player || !s) return;
  try {
    positionUs = Math.max(0, Math.round(Number(s.positionMs || 0) * 1000));
    const key = s.trackId == null ? null : String(s.trackId);
    if (key !== lastTrackKey) {
      lastTrackKey = key;
      player.metadata = key == null ? {} : {
        "mpris:trackid": player.objectPath("track/" + key.replace(/[^A-Za-z0-9]/g, "")),
        "mpris:length": Math.max(0, Math.round(Number(s.durationMs || 0) * 1000)),
        "mpris:artUrl": s.artUrl || "",
        "xesam:title": s.title || "",
        "xesam:album": s.album || "",
        "xesam:artist": s.artist ? [s.artist] : [],
      };
    }
    const want = key == null ? "Stopped" : (s.playing ? "Playing" : "Paused");
    if (player.playbackStatus !== want) player.playbackStatus = want;
  } catch (_) {}
}

// Tell the desktop the position jumped, so its scrubber does not drift after a seek.
function seeked(ms) {
  if (!player) return;
  try { positionUs = Math.max(0, Math.round(Number(ms || 0) * 1000)); player.seeked(positionUs); } catch (_) {}
}

function stop() {
  if (!player) return;
  try { player.playbackStatus = "Stopped"; } catch (_) {}
  player = null; lastTrackKey = null; positionUs = 0;
}

module.exports = { start, update, seeked, stop };
