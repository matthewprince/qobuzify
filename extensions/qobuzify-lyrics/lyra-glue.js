// Lyra adapter for qobuzify-lyrics.
//
// The extension already has an "own renderer" seam (QZLyricsRenderer, the dead qzrender scaffold) whose
// API the lyrics view drives: make({mount,getPos,isPlaying,onSeek,onClose}) -> { render(ly), start, stop,
// status(msg), scrollToTop, lineCount, destroy }, fed the bare Qobuzify {Type, Content} lyric object.
// Lyra speaks all of that natively (Lyra.parse eats the {Type, Content} object; r.load/start/stop/status/
// setCover/resync/lineCount/destroy). So this is a thin shim: point QZLyricsRenderer at Lyra. Nothing in
// Lyra is edited - lyra.js is shipped verbatim and only WRAPPED here.
//
// Prepended (with lyra.js) ahead of index.js at bake time, so window.Lyra + window.QZLyricsRenderer both
// exist before the extension body runs. With OWN_RENDERER = true, the extension uses this and never loads
// the 1.3MB QzLyrics vendor bundle (which stays on disk untouched as a fallback).
(function () {
  if (typeof window === "undefined" || !window.Lyra || !window.Lyra.create) return;

  window.QZLyricsRenderer = {
    make: function (o) {
      var r = window.Lyra.create({
        mount: o.mount,
        getPos: o.getPos,
        isPlaying: o.isPlaying,
        onSeek: o.onSeek,
        onClose: o.onClose,
        // Lyra drives its own ambient album-art background; the extension forwards the cover via setCover
        // (see setCoverBg in index.js), so its own #qz-cbg is redundant while Lyra is active.
        settings: { background: true, glow: true, cascade: true, depthBlur: true },
      });
      return {
        render: function (ly) { return r.load(ly); },
        start: function () { r.start(); },
        stop: function () { r.stop(); },
        destroy: function () { r.destroy(); },
        status: function (m) { r.status(m); },
        setCover: function (url, accent) { r.setCover(url, accent); },
        // The extension calls scrollToTop() on a track change to reset scroll; Lyra rebuilds and snaps to the
        // new track's anchor inside load(), and resync() re-anchors without a transition catch-up, so this is
        // the right equivalent.
        scrollToTop: function () { r.resync(); },
        remeasure: function () { r.remeasure(); },
        get lineCount() { return r.lineCount; },
      };
    },
  };
})();
