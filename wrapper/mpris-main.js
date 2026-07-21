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
let lastMetaKey = null;   // every published field, so DOM fields that settle late still republish
let lastPubId = null;     // id + title of the last publish, for the torn-snapshot guard below
let lastPubTitle = null;
let holds = 0;            // consecutive held publishes, so identical consecutive titles can't wedge

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
  // mpris-service re-emits async bus/socket failures (dead session bus, requestName rejection) as
  // 'error' on the Player object; an EventEmitter with no 'error' listener turns that into an
  // uncaught exception in the main process and kills the whole app. Degrade to "no media keys".
  try {
    player.on("error", (e) => {
      log("bus error: " + (e && e.message) + " - media keys off");
      player = null; lastMetaKey = null; lastPubId = null; lastPubTitle = null; holds = 0;
    });
  } catch (e) { log("error-handler wiring failed: " + (e && e.message)); }
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
// deliberately cheap and only rewrites metadata when a published field actually changes: assigning
// `metadata` emits a PropertiesChanged signal, and doing that every tick would spam the bus.
function update(s) {
  if (!player || !s) return;
  try {
    positionUs = Math.max(0, Math.round(Number(s.positionMs || 0) * 1000));
    const id = s.trackId == null ? null : String(s.trackId);
    const metaKey = id == null ? null :
      [id, s.title || "", s.artist || "", s.album || "", s.artUrl || "", s.durationMs || 0].join("|");
    if (metaKey !== lastMetaKey) {
      // The first snapshot after a track change can be torn: the store id flips before the player
      // bar repaints, so a new id arrives paired with the PREVIOUS track's DOM-scraped title.
      // Publishing that would latch the old track on the desktop widget, so hold it back and let
      // the renderer's next tick deliver the settled fields. Capped: two consecutive tracks that
      // genuinely share a title must still publish.
      const torn = id != null && lastPubId != null && id !== lastPubId &&
        s.title && s.title === lastPubTitle;
      if (torn && holds < 3) { holds++; }
      else {
        holds = 0;
        lastMetaKey = metaKey; lastPubId = id; lastPubTitle = s.title || "";
        player.metadata = id == null ? {} : {
          "mpris:trackid": player.objectPath("track/" + id.replace(/[^A-Za-z0-9]/g, "")),
          "mpris:length": Math.max(0, Math.round(Number(s.durationMs || 0) * 1000)),
          "mpris:artUrl": s.artUrl || "",
          "xesam:title": s.title || "",
          "xesam:album": s.album || "",
          "xesam:artist": s.artist ? [s.artist] : [],
        };
      }
    }
    const want = id == null ? "Stopped" : (s.playing ? "Playing" : "Paused");
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
  player = null; lastMetaKey = null; lastPubId = null; lastPubTitle = null; holds = 0; positionUs = 0;
}

module.exports = { start, update, seeked, stop };
