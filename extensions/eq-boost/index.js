// Web Audio EQ for the web-player build (the Electron wrapper that loads play.qobuz.com). That
// player plays audio straight through the Web Audio graph - it fetches the signed fileUrl, decodes
// it, and connects a source node to ctx.destination, with NO <audio> element. So rather than tap a
// media element, we patch AudioNode.connect: any connection to the AudioDestinationNode is rerouted
// through our EQ chain (whatever-you-connected -> preamp -> bands -> destination). Installed at load,
// before the player wires up its per-play graph, so it lands as the master output stage.
//
// The Windows DESKTOP bake plays through a native JUCE engine and uses no Web Audio at all, so this
// patch simply never fires there. PROTOTYPE: a modest bass boost to prove the hook, and it stays
// OFF until explicitly armed - a gain stage with no UI knob must never ship default-on.
// Runs as function(Qobuzify){ ... return cleanup }.
var Q = Qobuzify;
if (location.host.indexOf("play.qobuz.com") < 0) return function () {};
if (!window.AudioNode || !window.AudioDestinationNode) return function () {};
if (Q.storage.get("eq:on", "0") !== "1") return function () {}; // opt-in only; no patch installed otherwise

var BANDS = [
  { type: "lowshelf", freq: 140, gain: 6, q: 0.7 },
  { type: "peaking", freq: 45, gain: 4, q: 1.1 },
  { type: "peaking", freq: 80, gain: 3, q: 1.0 }
];

var origConnect = AudioNode.prototype.connect;
var chains = new WeakMap(); // AudioContext -> { head, tail }
var reroutes = 0, lastAn = null;

// build (once per context) preamp -> bands -> analyser -> real destination, all via the ORIGINAL
// connect so our own wiring isn't re-intercepted.
function chainFor(ctx) {
  var c = chains.get(ctx);
  if (c) return c;
  var pre = ctx.createGain(); pre.gain.value = 1;
  var prev = pre;
  for (var i = 0; i < BANDS.length; i++) {
    var b = BANDS[i], f = ctx.createBiquadFilter();
    // clamp so no future band edit can push summed boosts into guaranteed clipping again
    f.type = b.type; f.frequency.value = b.freq; f.gain.value = Math.max(-12, Math.min(12, b.gain)); f.Q.value = b.q;
    origConnect.call(prev, f); prev = f;
  }
  var an = ctx.createAnalyser(); an.fftSize = 256; origConnect.call(prev, an);
  origConnect.call(an, ctx.destination);
  lastAn = an;
  c = { head: pre, tail: an };
  chains.set(ctx, c);
  return c;
}

AudioNode.prototype.connect = function (dest) {
  try {
    if (dest instanceof AudioDestinationNode) {
      var ch = chainFor(dest.context);
      if (this !== ch.head && this !== ch.tail) {
        reroutes++;
        try { console.log("[qz-eq] rerouted a node through the EQ chain"); } catch (e) {}
        return origConnect.call(this, ch.head);
      }
    }
  } catch (e) {}
  return origConnect.apply(this, arguments);
};

// debug probe: how many source connections we've rerouted, and the signal level after the filters
try {
  window.__QZ_EQ = function () {
    var avg = null;
    if (lastAn) { var buf = new Uint8Array(lastAn.frequencyBinCount); lastAn.getByteFrequencyData(buf); var s = 0; for (var i = 0; i < buf.length; i++) s += buf[i]; avg = Math.round(s / buf.length); }
    return { reroutes: reroutes, bands: BANDS.length, signalAvg: avg };
  };
} catch (e) {}

return function cleanup() {
  try { AudioNode.prototype.connect = origConnect; } catch (e) {}
  try { window.__QZ_EQ = undefined; } catch (e) {}
};
