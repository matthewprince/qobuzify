// Discord Rich Presence, renderer side. The renderer is sandboxed - no Node, no pipe - so the
// real Discord IPC has to live in the main process (runtime/rpc-main.js, appended to
// main-win32.js). All this half does is read the current track off the Qobuzify player bridge and
// POST an activity payload to that main-process bridge over localhost. It's deduped so ordinary
// playback doesn't spam Discord: only a track change, play/pause, seek, or the quality string
// arriving triggers a re-post. Discord animates the progress bar itself from the start/end stamps.
//
// The presence mirrors the original qobuz-rpc. When playing, details is the title, state is "by
// <artist>", the cover goes in large_image, and large_text is "<album> · <quality>" - the quality
// gets folded into the cover-hover text because there's no Discord art asset to hang it on -
// plus start/end timestamps so the bar runs. When paused, same track, but state="Paused", a little
// pause-icon overlay (small_image/text), large_text drops to just the album, and no timestamps, so
// Discord freezes the bar instead of running it. The quality string is the real bit-depth /
// sample-rate from track/get, like "Hi-Res 24-Bit / 96 kHz" or "CD 16-Bit / 44.1 kHz" - same
// format as qobuz_core.quality_str.
//
// It returns a cleanup fn, which matters here: toggling the extension off has to both stop posting
// and clear the presence, otherwise the always-on main-process half sits frozen on the last track.
try {
  var Q = window.Qobuzify;
  if (!Q || !Q.player) return function () {};
  var BRIDGE = "http://127.0.0.1:7673/activity";
  // Twemoji pause button (U+23F8); Discord proxies external image URLs, so no art upload is needed.
  var PAUSE_ICON = "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/23f8.png";
  var _fetch = window.fetch.bind(window); // capture the real fetch (before any bridge patch)
  var lastSig = null, pend = null, iv = null, t0 = null, offChange = null, offSub = null;
  var qualCache = {}, qualInflight = {}; // trackId -> "Hi-Res 24-Bit / 96 kHz" ("" once fetched w/ none)
  var _bridgeFails = 0, _bridgeWarned = false; // surface a dead bridge instead of failing silently

  function post(body) {
    try {
      _fetch(BRIDGE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(function () { _bridgeFails = 0; })
        .catch(function () {
          // The bridge lives in the main process (rpc-main.js). If it's unreachable the POST just
          // throws ERR_CONNECTION_REFUSED forever with no user-facing sign - log ONE actionable line
          // so it's diagnosable (this was exactly how the "Discord not registering" report was found).
          if (++_bridgeFails === 3 && !_bridgeWarned) {
            _bridgeWarned = true;
            try { console.warn("[Qobuzify] Discord RPC: the local bridge at 127.0.0.1:7673 is unreachable, so Discord presence is off. Usually the main-process patch is missing (re-run `qobuzify update`) or a firewall/antivirus is blocking the local bridge."); } catch (_) {}
          }
        });
    } catch (e) {}
  }
  // Port of qobuz_core.quality_str: sr may be Hz (44100) or already kHz (44.1).
  function qualityStr(bd, sr) {
    bd = bd || 0; sr = sr || 0;
    if (sr > 1000) sr = sr / 1000;
    if (!(bd && sr)) return "";
    return (bd >= 24 ? "Hi-Res" : "CD") + " " + Math.round(bd) + "-Bit / " + (Math.round(sr * 10) / 10) + " kHz";
  }
  function curId() { try { return (Q.getState().player.currentTrack || {}).id || null; } catch (e) { return null; } }
  // The player state only carries {id,duration,fileUrl}, so pull real quality from track/get once per id.
  function ensureQuality(id) {
    if (id == null || qualCache[id] !== undefined || qualInflight[id]) return;
    qualInflight[id] = true;
    try {
      Q.api("track/get?track_id=" + id).then(function (tr) {
        qualCache[id] = qualityStr(tr && tr.maximum_bit_depth, tr && tr.maximum_sampling_rate);
        delete qualInflight[id]; schedule(); // re-post now that quality is known
      }).catch(function () { qualCache[id] = ""; delete qualInflight[id]; });
    } catch (e) { qualCache[id] = ""; delete qualInflight[id]; }
  }

  function build() {
    var t; try { t = Q.player.getTrack(); } catch (e) { return null; }
    if (!t || !t.title) return null;
    var playing = false, pos = 0;
    try { playing = Q.player.isPlaying(); } catch (e) {}
    try { pos = Q.player.getPositionMs() || 0; } catch (e) {}
    var dur = t.durationMs || 0;
    var id = curId(); ensureQuality(id);
    var quality = (id != null && qualCache[id]) || "";
    var album = String(t.album || "");
    var act = { type: 2, status_display_type: 2, details: String(t.title).slice(0, 128) }; // type 2 = Listening; status_display_type 2 = show details (title) in the compact status
    if (playing) {
      if (t.artist) act.state = ("by " + String(t.artist)).slice(0, 128);
      var hover = [album, quality].filter(Boolean).join(" · ") || t.title || ""; // "album · quality"
      act.assets = t.cover ? { large_image: t.cover, large_text: hover.slice(0, 128) } : { large_text: hover.slice(0, 128) };
      if (dur > 0) { var now = Date.now(); act.timestamps = { start: now - pos, end: now - pos + dur }; }
    } else {
      // PAUSED: frozen track + pause badge, no timer (matches the original _push_paused).
      act.state = "Paused";
      act.assets = t.cover ? { large_image: t.cover } : {};
      if (album) act.assets.large_text = album.slice(0, 128);
      act.assets.small_image = PAUSE_ICON;
      act.assets.small_text = "Paused";
    }
    return { playing: playing, pos: pos, dur: dur, act: act, title: t.title, artist: t.artist || "", quality: quality };
  }
  function tick() {
    var b = build();
    if (!b) { if (lastSig !== "CLR") { lastSig = "CLR"; post({ clear: true }); } return; }
    var bucket = (b.playing && b.dur > 0) ? Math.round((Date.now() - b.pos) / 4000) : -1;
    var sig = b.title + "|" + b.artist + "|" + b.playing + "|" + b.quality + "|" + bucket;
    if (sig === lastSig) return;
    lastSig = sig;
    post({ activity: b.act });
  }
  function schedule() { if (pend) return; pend = setTimeout(function () { pend = null; tick(); }, 300); }

  try { offChange = Q.player.onChange(function () { schedule(); }); } catch (e) {} // track change
  try { offSub = Q.subscribe(function () { schedule(); }); } catch (e) {}           // play/pause/seek
  iv = setInterval(tick, 4000); // keep-alive + catch anything missed (deduped, so cheap)
  t0 = setTimeout(tick, 2000);  // initial push after boot

  return function cleanup() {
    try { clearInterval(iv); } catch (e) {}
    try { clearTimeout(t0); } catch (e) {}
    try { if (pend) clearTimeout(pend); } catch (e) {}
    try { if (typeof offChange === "function") offChange(); } catch (e) {}
    try { if (typeof offSub === "function") offSub(); } catch (e) {}
    try { post({ clear: true }); } catch (e) {} // remove the Discord presence
  };
} catch (e) { return function () {}; }
