// Synced, word-by-word lyrics for Qobuz - a karaoke-style fill, an album-cover background, and
// auto-scroll. It renders through Lyra (our own renderer, prepended at build) behind a
// Qobuzify-API shim, and a Qobuz->Spotify ISRC bridge feeds Player.data.item.uri the mapped
// spotify:track:<id>. The lyric data is resolved server-side and delivered pre-aligned through the
// Qobuzify lyrics API. Opens from a player-bar button.
var Q = Qobuzify;
var SP = Q.spotify || {}; // { client_id, client_secret } - local only (ISRC->Spotify bridge)
var ST = Q.spotifyToken || null; // { access_token, expires_at } - Spotify user token for SL's real lyric sources
function userToken() { return (ST && ST.access_token) || ""; }
// only treat the token as usable for SL's gated Spotify source when it's a real, non-expired user
// token (client-creds are ~140 chars and only give you static; user tokens are ~500+). otherwise we
// fall back to the open lyric source, which needs no token at all and now syncs (the clock
// is fixed). a usable user token either has a refresh_token (OAuth login, ~270+ chars) or is a long
// desktop-grabbed token (~500). client-credentials tokens (~140, no refresh) get rejected, so we
// fall back to the open lyric source instead of getting static.
function hasFreshUserToken() { return !!(ST && ST.access_token && (ST.refresh_token || ST.access_token.length > 300) && (!ST.expires_at || ST.expires_at > Date.now() + 60000)); }
// renew the access token from the refresh token (OAuth PKCE, no secret) so the user logs in once
// and synced lyrics keep working. updates ST in place.
function refreshSpotifyToken() {
  if (!ST || !ST.refresh_token || !SP.client_id) return Promise.resolve(false);
  return fetch("https://accounts.spotify.com/api/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(ST.refresh_token) + "&client_id=" + encodeURIComponent(SP.client_id)
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (j && j.access_token) { ST.access_token = j.access_token; ST.expires_at = Date.now() + ((j.expires_in || 3600) * 1000); if (j.refresh_token) ST.refresh_token = j.refresh_token; return true; }
    return false;
  }).catch(function () { return false; });
}
// Refresh now if the token is missing or within 5 min of expiry.
function ensureFreshToken() {
  if (!ST || !ST.refresh_token) return Promise.resolve(false);
  if (ST.access_token && ST.access_token.length > 300 && ST.expires_at && ST.expires_at > Date.now() + 300000) return Promise.resolve(true);
  return refreshSpotifyToken();
}

// --- track state for the Player shim ---
var cur = null; // mapped current track (Spotify-shaped item)
var curMeta = null; // clean Qobuz metadata {name, artist, album, durationMs} for lyric lookup
var curLyrics = null; // the resolved lyrics object (Syllable/Line/Static) for the animator
// Lyra (prepended lyra.js + lyra-glue.js, exposed as window.QZLyricsRenderer) is the renderer. This is
// a constant, not a localStorage read, so a stray flag can never swap it out at runtime.
var OWN_RENDERER = true;
var listeners = { songchange: [], onprogress: [], onplaypause: [] };
function emit(type, e) {
  if (type === "songchange") { try { setCoverBg(cur && cur.images && cur.images[0] && cur.images[0].url); } catch (_) {} try { qzSuppressFade(1800); } catch (_) {} } // on a song change the bundle fades the whole .LyricsContent block to opacity 0 for ~1s while the next lyrics load ("lyrics vanish + come back"); hold it visible across the swap
  (listeners[type] || []).forEach(function (cb) { try { cb(e); } catch (_) {} });
}
function playerData() {
  return { item: cur, track: cur ? { uri: cur.uri } : null, isPaused: !Q.player.isPlaying(),
    duration: cur ? { milliseconds: cur.duration.milliseconds } : null };
}

// --- Spotify token + ISRC->id (the bridge) ---
var _tok = null, _tokExp = 0, _tokP = null, _isrc = {};
function spotifyToken() {
  if (!SP.client_id) return Promise.reject(new Error("no spotify creds"));
  if (_tok && Date.now() < _tokExp - 5000) return Promise.resolve(_tok);
  if (_tokP) return _tokP;
  _tokP = fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + btoa(SP.client_id + ":" + SP.client_secret) },
    body: "grant_type=client_credentials"
  }).then(function (r) { return r.json(); }).then(function (j) {
    _tok = j.access_token; _tokExp = Date.now() + (j.expires_in || 3600) * 1000; _tokP = null; return _tok;
  }).catch(function (e) { _tokP = null; throw e; });
  return _tokP;
}
function isrcToSpotifyId(isrc, name) {
  if (!isrc) return Promise.resolve(null);
  if (_isrc[isrc] !== undefined) return Promise.resolve(_isrc[isrc]);
  return spotifyToken().then(function (tok) {
    return fetch("https://api.spotify.com/v1/search?type=track&limit=1&q=" + encodeURIComponent("isrc:" + isrc), { headers: { Authorization: "Bearer " + tok } });
  }).then(function (r) { return r.json(); }).then(function (j) {
    var t = j.tracks && j.tracks.items && j.tracks.items[0];
    // a wrong or reused ISRC (common on nightcore/bootleg uploads) points at an unrelated recording;
    // only trust the hit if its title matches, or we key the renderer off the wrong song
    var id = (t && (!name || titleMatch(name, t.name))) ? t.id : null;
    _isrc[isrc] = id; return id;
  }).catch(function () { return null; });
}

/* map the current Qobuz track -> a Spotify-shaped player item */
function mapTrack(qt) {
  if (!qt || !qt.id) { cur = null; curMeta = null; curLyrics = null; emit("songchange", { data: playerData() }); return; }
  curMeta = { name: qt.title, artist: qt.artist || "", album: qt.album || "", durationMs: qt.durationMs || 0, feats: featsOf(qt.artists, qt.artist) };
  curLyrics = null; _tagSong = null; _tagScanned = false; // reset the credit-tag dedupe so the new song re-scans once
  var cover = (qt.cover || "").replace(/_\d+\.jpg/, "_600.jpg");
  var images = ["standard", "small", "large", "xlarge"].map(function (lbl) { return { label: lbl, url: cover }; });
  var base = {
    name: qt.title, artists: (qt.artists || []).map(function (n) { return { type: "artist", name: n, uri: "" }; }),
    images: images, duration: { milliseconds: qt.durationMs || 0 }, metadata: { album_title: qt.album || "" },
    type: "track", mediaType: "audio", provider: "qobuz", isLocal: false
  };
  // emit right away with the cover (a qobuz: uri) so the album-cover background jumps to the current
  // song immediately. cur used to only get set after the Spotify ISRC bridge resolved, so a slow
  // bridge would leave the background a song behind (a stale gradient).
  cur = Object.assign({ uri: "qobuz:track:" + qt.id }, base);
  emit("songchange", { data: playerData() });
  // resolve the Spotify id in the background (it's the spotify-lyrics DB key). update the uri, but
  // only re-emit (to retry lyrics with that key) if we still have none and we're still on this
  // track - guards against a stale async overwrite landing after a song change.
  Q.api("track/get?track_id=" + qt.id).then(function (tr) {
    if (tr && tr.isrc && curMeta && curMeta.name === qt.title) curMeta.isrc = tr.isrc; // the resolver keys some lyrics by ISRC
    return isrcToSpotifyId(tr && tr.isrc, qt.title);
  }).then(function (spid) {
    if (spid && cur && curMeta && curMeta.name === qt.title) {
      cur.uri = "spotify:track:" + spid;
      if (!curLyrics) emit("songchange", { data: playerData() });
    }
  }).catch(function () {});
}

// Click-to-seek. The renderer's lyric-word click resolves the line's StartTime and
// calls Spicetify.Player.origin.seekTo(ms) (vendor: Seek:e=>...origin.seekTo(e)),
// which the shim below routes here. Qobuz's progress bar is the lone native
// <input type=range> inside .player__progressbar; its component (legacy React 16,
// reached via __reactInternalInstance$) owns the real engine seek as
// this.props.seek({position}). We walk the fiber up to that instance and call it -
// cleaner than synthesizing the drag the bar wants (the bar's onMouseMove sets
// potentialSeekPosition from cursor X, onMouseUp commits props.seek; onChange alone
// is only a visual preview). Verified on Qobuz 8.2.0.
var _seekInst = null;
function findSeekInstance() {
  try {
    if (_seekInst && _seekInst.props && typeof _seekInst.props.seek === "function") return _seekInst;
    var input = document.querySelector(".player__progressbar input[type=range]") || document.querySelector('input[type="range"]');
    if (!input) return null;
    var fk = Object.keys(input).find(function (k) { return k.indexOf("__reactInternalInstance$") === 0; });
    if (!fk) return null;
    var fiber = input[fk], depth = 0;
    while (fiber && depth++ < 40) {
      var sn = fiber.stateNode;
      if (sn && sn.props && typeof sn.props.seek === "function") { _seekInst = sn; return sn; }
      fiber = fiber.return;
    }
  } catch (e) {}
  return null;
}
function qobuzSeek(ms) {
  try {
    if (ms == null || isNaN(ms)) return;
    var inst = findSeekInstance();
    if (!inst) return;
    var dur = 0;
    try { dur = inst._getDuration ? inst._getDuration() : 0; } catch (e) {}
    if (!dur) { try { dur = (Q.getState().player.currentTrack || {}).duration || (cur && cur.duration ? cur.duration.milliseconds : 0); } catch (e) {} }
    var target = Math.round(ms) - autoOffsetMs(); // lyric/getPosMs timeline -> real playback
    if (target < 0) target = 0;
    // Qobuz seeks at one-second granularity - the engine and the position clock both round to the
    // nearest whole second (verified live). Lyric lines rarely start exactly on a whole second, so a
    // plain round lands before the line about half the time, and the previous line highlights (and
    // sticks, when paused). So bias toward the clicked line: round up to the next whole second, unless
    // the line starts within the first 150ms of a second (then floor - it's effectively on that
    // second, and rounding up would skip ~0.9s into the line). Net: the clicked line is active, not the prior.
    var whole = Math.floor(target / 1000), frac = target - whole * 1000;
    target = (frac < 150 ? whole : whole + 1) * 1000;
    if (dur && target > dur - 1000) target = Math.floor((dur - 1000) / 1000) * 1000; // clamp to a whole second below the end
    var _curReal = getPosMs() - autoOffsetMs(); // current real playback position, same timeline as target
    inst.props.seek({ position: target });
    _clkSeek = true; // force getPosMs to snap exactly to the new position (no forward-extrapolation carryover)
    // Only mask the bundle's scroll-to-top flash for a forward/near seek. A real BACKWARD seek legitimately
    // scrolls UP toward an earlier line, which looks identical to the flash - masking it yanks the view back
    // down and the seek appears not to take. So skip the bounce window when seeking clearly backward.
    _seekScrollUntil = (target < _curReal - 1200) ? 0 : Date.now() + 600;
  } catch (e) {}
}

// --- lyrics source: our own resolver feeding SL's renderer ---
// Kept because the resolver client issues its lyric-proxy requests through the original fetch.
var _origFetch = window.fetch.bind(window);

function cleanTitle(s) {
  return (s || "")
    .replace(/\s*[\(\[][^)\]]*(remaster|remastered|radio edit|edit|version|mono|stereo|live|remix|feat\.?|ft\.?|with )[^)\]]*[\)\]]/gi, "")
    .replace(/\s*-\s*(\d{4}\s*)?(remaster(ed)?|radio edit|single version|mono|stereo|live).*$/gi, "")
    .replace(/\s*[\(\[][^)\]]*[\)\]]\s*$/g, "")
    .trim() || (s || "").trim();
}
function cleanArtist(s) { return (s || "").replace(/\s*(feat\.?|ft\.?|with)\s+.*$/i, "").trim(); }
// Featured artists for the lyric key + proxy: everyone after the main artist anchor, or (single
// anchor) a trailing "feat./ft./featuring/with X" credit parsed off the artist string. Separates
// same-title versions (the "Without Me" solo vs feat. collision) locally and server-side.
function featsOf(artists, artist) {
  var f = (artists || []).slice(1).map(function (n) { return String(n == null ? "" : n).trim(); }).filter(Boolean);
  if (!f.length) {
    var m = /\b(?:feat\.?|ft\.?|featuring|with)\s+(.+)$/i.exec(artist || "");
    if (m) f = m[1].split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  }
  return f;
}
// Same, out of the API's track.performers credits string ("Name, Role, Role - Name, Role - ...",
// the format feat-artists already parses) - the prefetch path has no DOM artist anchors to slice.
function featsFromPerformers(str, mainArtist) {
  var out = [];
  if (!str) return out;
  String(str).split(" - ").forEach(function (seg) {
    var parts = seg.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.length < 2) return;
    if (/Featured\s*Artist/i.test(parts.slice(1).join(" ")) && parts[0] && parts[0] !== mainArtist && out.indexOf(parts[0]) < 0) out.push(parts[0]);
  });
  return out;
}
// Normalize for fuzzy compare: lowercase, strip diacritics + punctuation.
function norm(s) { return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
// Two titles "match" if, after cleaning + normalizing, one contains the other.
function titleMatch(a, b) { a = norm(cleanTitle(a)); b = norm(cleanTitle(b)); if (!a || !b) return false; return a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0; }
// An artist string "matches" if any 3+ char word of the wanted artist appears in the candidate's.
function artistMatch(want, have) { want = norm(cleanArtist(want)); have = norm(have); if (!want || !have) return false; if (have.indexOf(want) >= 0 || want.indexOf(have) >= 0) return true; return want.split(" ").some(function (w) { return w.length > 2 && have.indexOf(w) >= 0; }); }
function currentSpotifyId() { try { var m = /^spotify:track:([A-Za-z0-9]+)/.exec((cur && cur.uri) || ""); return m ? m[1] : null; } catch (e) { return null; } }
// Persistent, versioned lyric cache (localStorage): a resolved song loads INSTANTLY on repeat and
// survives reloads/relaunches - no re-fetch every play. Bump CACHE_VER whenever parsing changes
// (spacing/parens/credits/timing) so stale pre-fix lyrics are dropped instead of served forever.
var CACHE_VER = 12; // bumped 2026-07-21: lyrKey carries feat credits now (same-title solo vs feat. versions split); pre-split entries may hold the wrong version. 11 (2026-07-07): match server PARSE_VER, drop the leaked source tag / credits footer. 10 (2026-07-05): reject wrong/reused-ISRC Spotify matches
var LS_KEY = "qz-lyr-cache";
var lsCache = {};
try { var _raw = JSON.parse(localStorage.getItem(LS_KEY) || "{}"); if (_raw && _raw.ver === CACHE_VER) lsCache = _raw.songs || {}; } catch (e) {}
function lyrKey(track) {
  var k = ((track && track.name) || "") + "|" + ((track && track.artist) || "");
  var f = (track && track.feats) || [];
  if (f.length) k += "|" + f.join(",").toLowerCase(); // feat-credit versions of the same title cache separately
  return k;
}
function saveCache() {
  try {
    var ks = Object.keys(lsCache);
    if (ks.length > 120) { ks.sort(function (a, b) { return (lsCache[a].t || 0) - (lsCache[b].t || 0); }); for (var i = 0; i < ks.length - 120; i++) delete lsCache[ks[i]]; }
    localStorage.setItem(LS_KEY, JSON.stringify({ ver: CACHE_VER, songs: lsCache }));
  } catch (e) { // quota blown - halve and retry once
    try { var k2 = Object.keys(lsCache).sort(function (a, b) { return (lsCache[a].t || 0) - (lsCache[b].t || 0); }); for (var j = 0; j < Math.ceil(k2.length / 2); j++) delete lsCache[k2[j]]; localStorage.setItem(LS_KEY, JSON.stringify({ ver: CACHE_VER, songs: lsCache })); } catch (_) {}
  }
}
// --- Cloudflare proxy (api.qobuzify.app): shared server-side cache + resolution. The client sends
// track metadata and gets back pre-parsed, time-aligned lyrics plus a codename in a single
// round-trip - no client-side parsing, and no upstream is ever contacted from the client.
var PROXY_BASE = "https://api.qobuzify.app/v1/lyrics";
var USE_PROXY = true; // __QZ_SL_DEBUG.setProxy(false) to force local-only for testing
function proxyLyrics(track) {
  if (!USE_PROXY || !track || !track.name || !track.artist) return Promise.resolve(null);
  try {
    // qz=1 marks this as a real client request so a WAF rule can whitelist it and skip the bot
    // challenge. a browser fetch can't set a custom User-Agent (forbidden header), and a custom
    // header would force a CORS preflight the challenge could block, so a query param is the clean way.
    var u = PROXY_BASE + "?qz=1&name=" + encodeURIComponent(track.name) + "&artist=" + encodeURIComponent(track.artist);
    var fts = track.feats || [];
    if (fts.length) u += "&feats=" + encodeURIComponent(fts.join(",")); // comma-separated display names (wire contract with the server)
    if (track.album) u += "&album=" + encodeURIComponent(track.album);
    if (track.durationMs) u += "&durationMs=" + track.durationMs;
    var isrc = (curMeta && curMeta.isrc) || track.isrc; if (isrc) u += "&isrc=" + encodeURIComponent(isrc);
    var spid = currentSpotifyId(); if (spid) u += "&spotifyId=" + encodeURIComponent(spid);
    return withTimeout(_origFetch(u).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }), 8000);
  } catch (e) { return Promise.resolve(null); }
}
// Proxy-only resolve: the client asks the proxy and renders whatever it returns; a miss / no-lyrics
// / error just yields null. The proxy (api.qobuzify.app) is the only lyric source the client
// touches - it hands back just a codename, so no upstream is ever visible in the network tab.
function lyrSpanSec(ly) { if (!ly || !ly.Content || !ly.Content.length) return 0; var l = ly.Content[ly.Content.length - 1]; return (l.Lead ? l.Lead.EndTime : l.EndTime) || 0; }
function resolveLyrics(track) {
  var key = lyrKey(track), hit = lsCache[key];
  // self-heal a stale wrong-song cache entry: if the cached lyrics run well past this track's end
  // (>10s over), they belong to a different (longer) same-title song - drop them and re-resolve from
  // the proxy (mirrors the server's durationOk). this is what fixed Selena's "Wolves" (193s) cached
  // under Baby Keem's "Wolves" (83s) from before the client started sending duration.
  if (hit && hit.ly && track.durationMs && lyrSpanSec(hit.ly) * 1000 > track.durationMs + 10000) { delete lsCache[key]; saveCache(); hit = null; }
  if (hit && hit.ly) { hit.t = Date.now(); if (hit.src) curLyricSource = hit.src; return Promise.resolve(hit.ly); }
  return proxyLyrics(track).then(function (pr) {
    if (pr && pr.ok && pr.hasLyrics && pr.lyrics) {
      curLyricSource = pr.source || curLyricSource; // codename from the proxy (never the raw source)
      // persist only high-confidence lyrics (the proxy sets pr.cacheable for word-by-word / syllable).
      // line-level results get shown but not cached, so they stay re-resolvable (and can upgrade to
      // word-by-word on a later play) instead of getting locked into the local cache.
      if (pr.cacheable) { lsCache[key] = { ly: pr.lyrics, src: curLyricSource, t: Date.now() }; saveCache(); }
      return pr.lyrics;
    }
    return null;
  }).catch(function () { return null; });
}

// ---- Prefetch: warm the NEXT queued track's lyrics in the background so they're already cached
// (instant) when it starts. Read the next play-queue item's trackId -> Qobuz track API for its
// metadata (incl. ISRC for an exact match) -> warm the proxy (populates D1 + our local cache).
// Proxy-only + heavily guarded: fires 2.5s after a track change (never competes with the current
// resolve), never touches playback, skips shuffle (next is unpredictable), and dedupes.
var _prefetchTimer = null, _prefetchedKey = null;
function schedulePrefetch() { if (_prefetchTimer) clearTimeout(_prefetchTimer); _prefetchTimer = setTimeout(prefetchNext, 2500); }
function prefetchNext() {
  try {
    if (!USE_PROXY) return;
    var pq = Q.getState().playqueue || {};
    if (pq.shuffled) return;
    var items = pq.items || [], nxt = items[(pq.currentIndex | 0) + 1];
    if (!nxt || !nxt.trackId) return;
    Q.api("track/get?track_id=" + nxt.trackId).then(function (tr) {
      if (!tr || !tr.title) return;
      var artist = (tr.performer && tr.performer.name) || (tr.album && tr.album.artist && tr.album.artist.name) || "";
      if (!artist) return;
      var meta = { name: tr.title, artist: artist, album: (tr.album && tr.album.title) || "", durationMs: (tr.duration || 0) * 1000, isrc: tr.isrc || null, feats: featsFromPerformers(tr.performers, artist) };
      var key = lyrKey(meta);
      if (key === _prefetchedKey || (lsCache[key] && lsCache[key].ly)) return; // already prefetched / cached
      _prefetchedKey = key;
      var u = PROXY_BASE + "?qz=1&name=" + encodeURIComponent(meta.name) + "&artist=" + encodeURIComponent(meta.artist); // qz=1: same WAF whitelist marker as proxyLyrics, or the challenge silently kills every prefetch
      if (meta.feats.length) u += "&feats=" + encodeURIComponent(meta.feats.join(","));
      if (meta.album) u += "&album=" + encodeURIComponent(meta.album);
      if (meta.durationMs) u += "&durationMs=" + meta.durationMs;
      if (meta.isrc) u += "&isrc=" + encodeURIComponent(meta.isrc);
      _origFetch(u).then(function (r) { return r.ok ? r.json() : null; }).then(function (pr) {
        if (pr && pr.ok && pr.hasLyrics && pr.lyrics && pr.cacheable) { lsCache[key] = { ly: pr.lyrics, src: pr.source || null, t: Date.now() }; saveCache(); }
      }).catch(function () {});
    }).catch(function () {});
  } catch (e) {}
}
// Race a promise against a timeout so one slow request can't stall the whole resolve
// (an upstream can occasionally hang for tens of seconds).
function withTimeout(p, ms) { return Promise.race([Promise.resolve(p), new Promise(function (r) { setTimeout(function () { r(null); }, ms); })]); }

// --- minimal PopupModal ---
function makePopupModal() {
  var el = null;
  function hide() { if (el) { el.remove(); el = null; } }
  return {
    display: function (o) {
      hide();
      el = document.createElement("div");
      el.style.cssText = "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);";
      var box = document.createElement("div");
      box.style.cssText = "background:#181818;color:#fff;border-radius:12px;padding:22px;max-width:" + (o && o.isLarge ? "720px" : "460px") + ";max-height:82vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.5);";
      if (o && o.title) { var h = document.createElement("h2"); h.textContent = o.title; h.style.marginTop = "0"; box.appendChild(h); }
      if (o && o.content) { if (typeof o.content === "string") { var d = document.createElement("div"); d.innerHTML = o.content; box.appendChild(d); } else box.appendChild(o.content); }
      el.appendChild(box);
      el.addEventListener("mousedown", function (e) { if (e.target === el) { hide(); if (o && o.onClose) o.onClose(); } });
      document.body.appendChild(el);
    },
    hide: hide
  };
}

// --- history shim (drives SL's page open/close) ---
function makeHistory() {
  var def = { pathname: "/", search: "", hash: "", state: {} };
  var hist = {
    location: Object.assign({}, def),
    _l: [],
    push: function (d) {
      var p = typeof d === "string" ? { pathname: d } : (d || {});
      hist.location = Object.assign({}, def, p);
      hist._l.forEach(function (cb) { try { cb(hist.location, "PUSH"); } catch (_) {} });
      onRouteChange(hist.location);
    },
    replace: function (d) { hist.push(d); },
    goBack: function () { hist.push({ pathname: "/" }); },
    goForward: function () {},
    listen: function (cb) { hist._l.push(cb); return function () { var i = hist._l.indexOf(cb); if (i >= 0) hist._l.splice(i, 1); }; },
    block: function () { return function () {}; },
    entries: [], index: 0, length: 1, action: "POP"
  };
  return hist;
}

var container = null;
// --- our own album-cover background ---
// The bundle's WebGL background is dead in this env (frozen canvas, no songchange update), so we
// paint our own: two blurred layers that crossfade to the current cover, with a slow drift so it
// feels alive. setCoverBg() drives it on every songchange, so it always tracks the playing song. It
// sits at the back of the lyrics view (#qz-sl-root), behind the transparent #QzLyricsPage, and
// the bundle's own bg elements are hidden via CSS.
var _cbgFront = 0, _cbgWant = null;
// Background = two crossfading layers of drifting radial-gradient colour blobs (see paintMesh), melted
// with blur + mix-blend-mode:screen. No SVG/feTurbulence filter (the old "kawarp" displacement idea was
// never shipped; .qz-cbg-layer carries no filter).
function ensureCoverBg() {
  var c = document.getElementById("qz-sl-root"); if (!c || document.getElementById("qz-cbg")) return;
  var bg = document.createElement("div"); bg.id = "qz-cbg";
  bg.appendChild(document.createElement("div")).className = "qz-cbg-layer";
  bg.appendChild(document.createElement("div")).className = "qz-cbg-layer";
  bg.appendChild(document.createElement("div")).className = "qz-bloomlayer"; // beat-bloom swell (pulsed on line change)
  c.insertBefore(bg, c.firstChild); // first child -> painted behind the lyrics
}
// Pull a small palette of dominant, colourful tones from the cover so the background can be a flowing
// mesh of the album's COLOURS (Apple-Music style) instead of a recognisable, moving photo. The Qobuz
// cover CDN sends Access-Control-Allow-Origin:*, so a 32x32 canvas read is CORS-clean; if a cover ever
// taints, coverPalette returns null and setCoverBg falls back to the old blurred cover image.
function coverPalette(img) {
  try {
    var n = 32, cv = document.createElement("canvas"); cv.width = n; cv.height = n;
    var ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, n, n);
    var px = ctx.getImageData(0, 0, n, n).data, buckets = {};
    for (var i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      var r = px[i], g = px[i + 1], b = px[i + 2], key = (r >> 4) + "_" + (g >> 4) + "_" + (b >> 4);
      var bk = buckets[key] || (buckets[key] = { n: 0, r: 0, g: 0, b: 0 });
      bk.n++; bk.r += r; bk.g += g; bk.b += b;
    }
    // rank tones by frequency, but boost colourful ones and demote near-black/near-white so the mesh
    // reads as the album's palette, not a grey wash.
    var cols = Object.keys(buckets).map(function (k) {
      var c = buckets[k], r = c.r / c.n, g = c.g / c.n, b = c.b / c.n;
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b), lum = (mx + mn) / 2, sat = mx - mn;
      return { r: r, g: g, b: b, lum: lum, score: c.n * (1 + sat / 55) * (lum > 16 && lum < 242 ? 1 : 0.18) };
    }).sort(function (a, b) { return b.score - a.score; });
    var pick = [];
    for (var j = 0; j < cols.length && pick.length < 5; j++) {
      var c = cols[j], dup = false;
      for (var k = 0; k < pick.length; k++) { var p = pick[k]; if (Math.abs(p.r - c.r) + Math.abs(p.g - c.g) + Math.abs(p.b - c.b) < 54) { dup = true; break; } }
      if (!dup) pick.push(c);
    }
    return pick.length >= 2 ? pick : null;
  } catch (e) { return null; }
}
function palRgb(c, boost) { // nudge saturation up so the mesh reads vivid, not muddy
  var avg = (c.r + c.g + c.b) / 3, k = boost == null ? 1.2 : boost;
  function ch(v) { return Math.round(Math.max(0, Math.min(255, avg + (v - avg) * k))); }
  return "rgb(" + ch(c.r) + "," + ch(c.g) + "," + ch(c.b) + ")";
}
// Paint the palette as INDEPENDENT drifting blobs (one per colour) into a layer. Each blob is a full-size
// div whose colour sits at a fixed spot via its radial-gradient; a per-blob CSS keyframe then drifts and
// scales it on its OWN timing, so the colours flow relative to each other (a real mesh), not a rigid pan.
// blur + screen-blend melt them into one smooth gradient; only transforms animate, so it's GPU-cheap.
// TL, BR, TR, BL, C - so a 2-colour palette spans a diagonal and a 3-colour one a triangle, instead
// of both first colours landing in the top half and leaving a dead near-black band at the bottom.
var BLOB_AT = [[26, 26], [74, 74], [74, 26], [26, 74], [50, 50]];
function paintMesh(layer, pal) {
  layer.classList.remove("qz-photo");
  layer.style.backgroundImage = "";
  var dark = pal.slice().sort(function (a, b) { return a.lum - b.lum; })[0];
  layer.style.backgroundColor = palRgb(dark, 0.5); // deep base so gaps read as colour, not black
  var html = "";
  for (var i = 0; i < pal.length && i < 5; i++) {
    var a = BLOB_AT[i] || [50, 50];
    html += '<div class="qz-blob b' + i + '" style="background:radial-gradient(50% 50% at ' + a[0] + '% ' + a[1] + '%,' + palRgb(pal[i], 1.35) + ' 0%,transparent 56%)"></div>';
  }
  layer.innerHTML = html;
}
function setCoverBg(url) {
  // Feed Lyra's ambient background the same cover this drives on the extension's own #qz-cbg, so the
  // renderer's album-art backdrop always tracks the playing song. No-op when the own renderer is off.
  try { if (OWN_RENDERER && _own && _own.setCover && url) _own.setCover(url); } catch (e) {}
  if (!url || _cbgWant === url) return; // dedupe repeated/echoed songchange emits
  if (OWN_RENDERER) { _cbgWant = url; return; } // Lyra's opaque .lyra-bg covers the view - skip the hidden legacy mesh (image decode + palette + five blurred infinite animations painting zero visible pixels); _cbgWant still tracks the cover for ownEnsure's priming
  ensureCoverBg();
  var bg = document.getElementById("qz-cbg"); if (!bg) return;
  var layers = bg.getElementsByClassName("qz-cbg-layer"); if (layers.length < 2) return;
  _cbgWant = url;
  var img = new Image();
  img.crossOrigin = "anonymous"; // CORS-clean load so we can sample the cover's colours (CDN sends ACAO:*)
  img.onload = img.onerror = function () {
    if (_cbgWant !== url) return; // a newer song superseded this load (rapid skip)
    var front = layers[_cbgFront], back = layers[_cbgFront ^ 1];
    if (front.getAttribute("data-url") === url) return;
    var pal = coverPalette(img); // null on a broken/tainted load -> fall back to the blurred cover photo
    if (pal) {
      paintMesh(back, pal);
    } else {
      back.innerHTML = ""; back.classList.add("qz-photo");
      back.style.backgroundColor = "";
      back.style.backgroundImage = 'url("' + url + '")';
    }
    back.setAttribute("data-url", url);
    back.classList.add("qz-on"); front.classList.remove("qz-on");
    _cbgFront ^= 1;
  };
  img.src = url;
}

function ensureContainer() {
  container = document.getElementById("qz-sl-root");
  if (!container) {
    // SL's GetPageRoot() looks for ".Root__main-view .main-view-container
    // div[data-overlayscrollbars-viewport]" and appends #QzLyricsPage there,
    // so replicate that exact nesting (Qobuz has no such structure of its own).
    container = document.createElement("div");
    container.className = "Root__main-view";
    container.id = "qz-sl-root";
    container.style.cssText = "position:fixed;inset:0;z-index:2147483500;display:none;background:#000;";
    var mvc = document.createElement("div");
    mvc.className = "main-view-container";
    mvc.style.cssText = "position:absolute;inset:0;";
    var vp = document.createElement("div");
    vp.setAttribute("data-overlayscrollbars-viewport", "");
    vp.className = "main-view-container__scroll-node-child";
    vp.style.cssText = "position:absolute;inset:0;overflow:auto;";
    mvc.appendChild(vp);
    container.appendChild(mvc);
    document.body.appendChild(container);
  }
  // the data-overlayscrollbars-viewport attr triggers OverlayScrollbars CSS that
  // hides the div until the OS lib inits (never happens here) - force it visible
  // and size the page to fill, or the whole lyrics view renders at 0x0.
  Q.css("qz-sl-size",
    "#qz-sl-root [data-overlayscrollbars-viewport]{display:block!important;position:absolute!important;inset:0!important;width:100%!important;height:100%!important;overflow:auto!important;}" +
    "#QzLyricsPage{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;}");
  // our blurred album-cover background (replaces the bundle's dead WebGL one)
  Q.css("qz-cbg-style",
    // only the lyrics view goes neutral-accented: override the inherited global brand --qz-accent inside #qz-sl-root.
    // the rest of Qobuzify (badges, search, etc.) keeps the :root #3DA8FE brand blue untouched.
    "#qz-sl-root{--qz-accent:#e8eaed;}" +
    "#qz-cbg{position:absolute;inset:0;overflow:hidden;background:#0a0a0c;}" +
    // Album-colour MESH: each palette colour is an independent blurred blob (see paintMesh) that drifts on
    // its own keyframe, screen-blended into one smooth gradient. Only transforms animate (GPU) so it holds
    // refresh with no per-frame filter (unlike the old per-frame-blur/turbulence attempts that dropped to
    // ~1fps or re-rastered on alt-tab). The ::after scrim guarantees lyric contrast; a tainted cover falls
    // back to .qz-photo (blurred cover image).
    "#qz-cbg .qz-cbg-layer{position:absolute;inset:0;opacity:0;transition:opacity 1.1s ease;isolation:isolate;}" +
    "#qz-cbg .qz-cbg-layer.qz-on{opacity:1;}" +
    "#qz-cbg .qz-blob{position:absolute;inset:0;mix-blend-mode:screen;filter:blur(16px);will-change:transform;}" +
    "#qz-cbg .qz-cbg-layer.qz-photo{background-size:cover;background-position:center;filter:blur(26px) saturate(1.3) brightness(.8);}" +
    "#qz-cbg::after{content:'';position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,rgba(6,6,9,.34),rgba(6,6,9,.26) 42%,rgba(6,6,9,.62));}" +
    // each blob rides a CONTINUOUS closed orbit (not a 2-point ping-pong) in its own direction - b0/b4
    // clockwise, b1 counter-clockwise, b2/b3 opposing triangles - with big travel (~±24%) so the colours
    // clearly sweep across each other. linear = constant orbit speed; the heavy blur hides the corners.
    "@keyframes qzb0{0%{transform:translate(-22%,-14%) scale(1.05)}25%{transform:translate(18%,-20%) scale(1.35)}50%{transform:translate(24%,16%) scale(1.1)}75%{transform:translate(-16%,22%) scale(1.3)}100%{transform:translate(-22%,-14%) scale(1.05)}}" +
    "@keyframes qzb1{0%{transform:translate(22%,-16%) scale(1.3)}25%{transform:translate(-20%,-22%) scale(1.05)}50%{transform:translate(-24%,18%) scale(1.4)}75%{transform:translate(18%,22%) scale(1.1)}100%{transform:translate(22%,-16%) scale(1.3)}}" +
    "@keyframes qzb2{0%{transform:translate(-26%,12%) scale(1.15)}33%{transform:translate(4%,-24%) scale(1.45)}66%{transform:translate(26%,16%) scale(1.05)}100%{transform:translate(-26%,12%) scale(1.15)}}" +
    "@keyframes qzb3{0%{transform:translate(24%,20%) scale(1.35)}33%{transform:translate(-22%,6%) scale(1.05)}66%{transform:translate(2%,-26%) scale(1.4)}100%{transform:translate(24%,20%) scale(1.35)}}" +
    "@keyframes qzb4{0%{transform:translate(-24%,-6%) scale(1.1)}25%{transform:translate(-4%,-24%) scale(1.4)}50%{transform:translate(26%,10%) scale(1.15)}75%{transform:translate(6%,24%) scale(1.35)}100%{transform:translate(-24%,-6%) scale(1.1)}}" +
    "#qz-cbg .qz-blob.b0{animation:qzb0 15s linear -2s infinite;}" +
    "#qz-cbg .qz-blob.b1{animation:qzb1 18s linear -7s infinite;}" +
    "#qz-cbg .qz-blob.b2{animation:qzb2 21s linear -4s infinite;}" +
    "#qz-cbg .qz-blob.b3{animation:qzb3 17s linear -10s infinite;}" +
    "#qz-cbg .qz-blob.b4{animation:qzb4 23s linear -5s infinite;}" +
    "#qz-sl-root.qz-paused #qz-cbg .qz-blob{animation-play-state:paused;}" +
    "#qz-sl-root .qz-dynamic-bg,#qz-sl-root .ColorBackground{display:none!important;}" +
    "#qz-lyric-server{font:600 11px/1.4 system-ui,sans-serif;opacity:.5;text-align:center;letter-spacing:.04em;margin-top:3px;}" +
    "#qz-lyric-server b{color:var(--qz-accent,#e8eaed);font-weight:700;}" +
    "#qz-sl-root .line.bg-line{font-size:.58em!important;opacity:.5!important;font-weight:600!important;margin:-4px 0 2px!important;letter-spacing:.01em;}");
  // isolate the lyrics subtree's layout from Qobuz's document. on focus (alt-tab back) Chromium marks
  // the whole document's layout dirty; the animator's getBoundingClientRect() in ScrollToActiveLine
  // then forces a synchronous whole-document reflow that blocks the frame (the freeze) and can glitch
  // the scroll to the top. `contain:layout` keeps the expensive lyrics-internal layout (hundreds of
  // lines) cached across that invalidation instead of recomputing it inline. mirrors upstream's PR
  // #271, which isolated layout so the ScrollToActiveLine measure can't cascade across the whole
  // document. the boundary is the page + scroll viewport only (single full-size elements), not per
  // line, since contain:layout forces a BFC per line and can shift margin-collapse / line spacing
  // (which we'd just finished tuning).
  Q.css("qz-sl-contain",
    "#QzLyricsPage{contain:layout;}" +
    "#qz-sl-root [data-overlayscrollbars-viewport]{contain:layout;}");
  // on window refocus the bundle re-renders the lyric list and re-runs its opacity fade-in (lines ease
  // 0 -> target), flashing the lyrics blank for ~half a second. rather than permanently killing all
  // line animation/transition (which also flattened the active-line pop, the instrumental dots, and
  // the scroll ease - the regression this fixes), we suppress transitions only during a brief window
  // after refocus, via a .qz-refocus class (toggled in the JS below): the rebuild snaps in place, but
  // normal playback keeps every ease. (the karaoke word-fill is JS-driven via --gradient-position, so
  // it renders right either way.)
  Q.css("qz-sl-refocus", "#QzLyricsPage.qz-refocus .LyricsContent{opacity:1!important;transition:none!important;animation:none!important;}#QzLyricsPage.qz-refocus .LyricsContainer .LyricsContent .line{transition:none!important;animation:none!important;}");
  // MID-SONG WHITE FLASH FIX. The bundle's virtualizer periodically tears down + recreates its rows on scroll
  // (verified via CDP). A freshly recreated row has NO state class yet (Active/Sung/NotSung), and a classless
  // .line defaults to opacity:1 + scale:1 = BRIGHT + FLAT - so for the frame before the bundle re-applies the
  // class, EVERY visible line flashes highlighted and the active line un-enlarges (Ethan's "all white / flat"
  // flash, worst in dense sections that scroll fast). Dim/small only comes from the class. Fix: a classless
  // line inherits the dim inactive look (NotSung opacity + default scale), so a recreated row is invisible
  // instead of a white flash; the instant the bundle assigns a state class this selector stops matching and
  // its own inline styles take over. Only matches truly-classless (transient) lines, so steady state is untouched.
  Q.css("qz-sl-line-default", "#QzLyricsPage .LyricsContent .line:not(.musical-line):not(.Active):not(.Sung):not(.NotSung):not(.FeelSung){opacity:var(--Vocal-NotSung-opacity,.45)!important;scale:var(--DefaultLineScale,1)!important;}");
  // Active-line "pop" + smooth scroll feel (neutral, no blue; all transform/opacity/text-shadow so it
  // rides the compositor - the earlier lag came from bg blend-mode layers, never from text effects):
  //  - SL sets .Active{scale:1.05} but its base .line only transitions opacity, so the grow snapped in.
  //    Add a springy scale ease + bump the grow a touch so the active line visibly pops as it lands.
  //  - a soft white glow halos the active glyphs so they lift off the background (restores the
  //    separation the removed blue used to give, while staying colour-neutral).
  //  - the instrumental-break dots read brighter/whiter (de-blue had dulled them to low-contrast grey).
  Q.css("qz-sl-pop",
    "#QzLyricsPage.QzRenderer .LyricsContainer .LyricsContent .line:not(.musical-line){transition:opacity .2s cubic-bezier(.61,1,.88,1),scale .26s cubic-bezier(.2,.72,.2,1.28)!important;}" +
    "body:not(.QzSidebarLyrics__Active) #QzLyricsPage.QzRenderer:not(.Fullscreen.MinimalLyricsMode) .LyricsContainer .LyricsContent .line.Active:not(.musical-line){scale:1.08!important;}" +
    // Active-line glow: keep it subtle and cheap. A big blurred text-shadow (was 0 0 14px) on the active
    // words repaints every frame as the karaoke gradient sweeps them - a per-frame paint cost that only
    // exists while playing with lyrics open (exactly the reported "lags only when lyrics are open"). A small
    // radius keeps the separation for a fraction of the paint. Same for the instrumental dots.
    "#QzLyricsPage.QzRenderer .LyricsContainer .LyricsContent .line.Active:not(.musical-line) .word{text-shadow:0 0 4px rgba(255,255,255,.28);}" +
    "#QzLyricsPage.QzRenderer .LyricsContainer .LyricsContent .line.musical-line .dotGroup .dot{--opacity-size:.5;filter:drop-shadow(0 0 3px rgba(255,255,255,.4));}" +
    "#QzLyricsPage.QzRenderer .LyricsContainer .LyricsContent .line.musical-line.Active .dotGroup .dot{--opacity-size:.72;}");
  // COMBO animation (v1). Intentionally NOT gated on prefers-reduced-motion - this immersive lyrics view
  // is opt-in and the user explicitly wants the motion (their OS has reduce-motion on).
  //  - word glow-pop: a gentle size+lift+glow that sweeps across the active line's words (driven in JS by
  //    _comboTick). Uses the INDEPENDENT scale/translate props (NOT `transform` - that is dead on SL's
  //    words: will-change reserves it and the vendor's whole layout uses scale/translate; CDP-verified),
  //    plus text-shadow. We never touch `animation`, so the vendor's colour fill is untouched.
  //  - beat bloom: a soft radial swell on the background that fires on every line change.
  // (the word glow-pop is applied via INLINE style in _sweepPops - a stylesheet rule loses the cascade
  //  war with the vendor, but inline scale/translate/text-shadow are CDP-verified to apply.)
  Q.css("qz-sl-combo",
    "#qz-cbg .qz-bloomlayer{position:absolute;left:50%;top:42%;width:78%;height:58%;transform:translate(-50%,-50%) scale(.7);border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.14),transparent 62%);mix-blend-mode:screen;opacity:0;filter:blur(28px);pointer-events:none;}" +
    "#qz-cbg.qz-bloom .qz-bloomlayer{animation:qz-bloom 1.1s ease-out;}" +
    "@keyframes qz-bloom{0%{opacity:0;transform:translate(-50%,-50%) scale(.7)}24%{opacity:.65;transform:translate(-50%,-50%) scale(1.02)}100%{opacity:0;transform:translate(-50%,-50%) scale(1.26)}}");
  // (2026-07-03) a focus-blur radius reduction was tried here and reverted: a forced-clock ramp
  // seemed to show the blur text-shadow causing a ~257ms worst frame, but a controlled cold-start
  // A/B proved that spike was just the first-ramp-after-reload warmup (JIT + first GPU layer/raster),
  // not the blur - blur-off cold was actually worse (360ms), and warm jank is ~8-16ms at any blur
  // level (off / 0.4x / 3x alike). so the blur has no measurable perf cost warm; don't touch it.
  // Settings + the Spotify-coupled view-mode buttons were removed (by design). The view modes
  // (Cinema/NowBar/Sidebar/Compact) manipulate Spotify's ".Root__main-view" NPV DOM that doesn't
  // exist in the Qobuz port -> they're inert (state flips, nothing renders), and the port's lyrics
  // view is already a full immersive overlay so they're redundant. Settings collapses (missing
  // w-40/slm util classes) + nothing worth changing. LyricsManager (Local Lyrics DB) renders fine but
  // it is intentionally not surfaced. Control bar left with just the auto Romanization toggle (non-Latin) + Close.
  Q.css("qz-remove-controls",
    "#SettingsToggle,#CinemaView,#NowBarToggle,#NowBarSideToggle,#SidebarModeToggle,#CompactModeToggle,#LyricsManager{display:none!important;}" +
    ".MenuItem__text.icon-settings,.icon-settings{display:none!important;}" +
    ".sl-modal-overlay:has(.slmodal-settingsPanel){display:none!important;}");
  if (!OWN_RENDERER) ensureCoverBg(); // Lyra brings its own opaque background; don't build the legacy mesh behind it
  ensureFsButton();
  // The clock is live and lyrics arrive synced, so SL's native per-word gradient
  // glow renders correctly - no readable-fallback override needed. (Unsynced
  // "static" tracks are styled bright by SL's own CSS, so they stay readable.)
}
// suppress the line fade only during the brief rebuild window after the window regains focus /
// becomes visible / the lyrics route opens (see qz-sl-refocus above). outside this window every ease
// runs, so playback keeps its active-line pop + smooth scroll while the alt-tab blank-flash stays gone.
var _refocusT = null;
function qzSuppressFade(ms) {
  var p = document.getElementById("QzLyricsPage"); if (!p) return;
  p.classList.add("qz-refocus");
  if (_refocusT) clearTimeout(_refocusT);
  _refocusT = setTimeout(function () { var q = document.getElementById("QzLyricsPage"); if (q) q.classList.remove("qz-refocus"); _refocusT = null; }, ms || 800);
}
function _onWinFocus() { qzSuppressFade(800); }
function _onVis() { if (!document.hidden) qzSuppressFade(800); }
try {
  window.addEventListener("focus", _onWinFocus, true);
  document.addEventListener("visibilitychange", _onVis, true);
} catch (e) {}
// --- OUR renderer (QZLyricsRenderer, prepended at build): stable-DOM karaoke, no vendor ---
var _own = null, _ownKey = null, _ownReq = 0;
function ownViewOpen() { return !!(container && container.style.display !== "none"); } // onRouteChange sets this on /QzLyrics
function ownEnsure() {
  if (_own) return _own;
  if (!window.QZLyricsRenderer) return null;
  ensureContainer(); var mount = document.getElementById("qz-sl-root"); if (!mount) return null;
  _own = window.QZLyricsRenderer.make({ mount: mount, getPos: getPosMs, isPlaying: function () { return Q.player.isPlaying(); }, onSeek: qobuzSeek, onClose: function () { try { var h = window.Spicetify.Platform.History; if (h && h.goBack) h.goBack(); else if (h) h.push({ pathname: "/" }); } catch (e) {} } }); // onClose returns to the previous page, not a blank "/"
  // Prime the just-created renderer with the CURRENT cover. setCoverBg only pushes setCover on a
  // songchange, but _own didn't exist when this song's songchange fired, so without this the album
  // background stays empty until the next track. The renderer queues it (pendingCover) if it's still
  // pre-scaffold. Prefer the last URL setCoverBg saw; fall back to the live track's cover.
  try {
    var _u0 = _cbgWant || (cur && cur.images && cur.images[0] && cur.images[0].url);
    if (_u0 && _own.setCover) _own.setCover(_u0);
  } catch (e) {}
  return _own;
}
function ownRenderCurrent() {
  var r = ownEnsure();
  ownDiag({ step: "enter", hasRenderer: !!r, curMeta: curMeta ? (curMeta.name + " / " + curMeta.artist) : null, viewOpen: ownViewOpen(), req: _ownReq });
  if (!r) return;
  // Lyra's status() only overlays a message - it never clears content, so without an explicit
  // empty load() the PREVIOUS track's lyric wall keeps rendering (and karaoke-filling against the
  // new clock) under every status below. load({lines:[]}) clears content + resets lineCount to 0
  // (which also un-arms the key===_ownKey early return for the no-lyrics case).
  if (!curMeta) { if (r.lineCount) { try { r.render({ lines: [] }); } catch (e) {} } r.status("Waiting for track…"); return; }
  var key = lyrKey(curMeta); // feat-aware, so same-name/artist versions re-render instead of replaying
  if (key === _ownKey && r.lineCount) { r.start(); return; } // already rendered this track
  // Supersede-safe: each call takes a monotonic token; a resolve that finishes after a NEWER call is
  // dropped. Replaces the old _ownBusy gate, which dropped the incoming track's render while a previous
  // resolve was still in flight - so a fast switch (or the stale-name remap firing a second resolve)
  // rendered the older song and never retried the new one. Snapshot curMeta so a mid-resolve change
  // can't mislabel the result.
  var myReq = ++_ownReq, snap = curMeta;
  r.status("Loading lyrics…");
  resolveLyrics(snap).then(function (ly) {
    if (myReq !== _ownReq) return; // a newer track superseded this resolve
    if (!ownViewOpen()) return;    // route closed while resolving
    var n = ly && ly.Content ? ly.Content.length : 0;
    ownDiag({ step: "resolved", curMeta: snap.name + " / " + snap.artist, type: ly && ly.Type, lines: n, viewOpen: ownViewOpen() });
    _ownKey = key; curLyrics = ly;
    if (n) { r.render(ly); r.start(); } else { try { r.render({ lines: [] }); } catch (x) {} r.status("No word-by-word lyrics for this track"); }
    try { setLyricServerTag(); } catch (e) {}
  }).catch(function (e) { if (myReq !== _ownReq) return; ownDiag({ step: "error", err: String((e && e.message) || e) }); try { r.render({ lines: [] }); r.status("Lyrics failed to load"); } catch (x) {} });
}
var _ownDiagOn = false; try { _ownDiagOn = !!localStorage.getItem("qz-own-diag-on"); } catch (e) {} // dev-only breadcrumb, off unless armed
function ownDiag(o) { if (!_ownDiagOn) return; try { localStorage.setItem("qz-own-diag", JSON.stringify(Object.assign({ t: Date.now() }, o))); } catch (e) {} }
function ownOpen() { var r = ownEnsure(); if (r) ownRenderCurrent(); }
function ownClose() { if (_own) _own.stop(); }
function ownOnTrackChange() { if (OWN_RENDERER && ownViewOpen()) { _ownKey = null; if (_own) _own.scrollToTop(); ownRenderCurrent(); } }

function onRouteChange(loc) {
  var open = loc && loc.pathname === "/QzLyrics";
  if (OWN_RENDERER) {
    if (container) container.style.display = open ? "block" : "none";
    if (open) ownOpen(); else ownClose();
    var btnO = document.getElementById("qz-sl-btn"); if (btnO) btnO.classList.toggle("qz-sl-btn--active", !!open);
    return;
  }
  if (open) qzSuppressFade(850);
  if (container) container.style.display = open ? "block" : "none";
  var btn = document.getElementById("qz-sl-btn");
  if (btn) btn.classList.toggle("qz-sl-btn--active", !!open);
}

// --- the Spicetify shim ---
function buildSpicetify(React, ReactDOM, ReactJSX, ReactDOMServer) {
  var noopTip = function () { return { setContent: function () {}, setProps: function () {}, destroy: function () {}, show: function () {}, hide: function () {}, popper: document.createElement("div") }; };
  return {
    React: React, ReactDOM: ReactDOM, ReactJSX: ReactJSX, ReactDOMServer: ReactDOMServer || {},
    Player: {
      get data() { return playerData(); },
      getProgress: function () { return getPosMs(); },
      getProgressPercentage: function () { var d = cur && cur.duration.milliseconds; return d ? getPosMs() / d : 0; },
      getDuration: function () { try { return (Q.getState().player.currentTrack || {}).duration || (cur && cur.duration ? cur.duration.milliseconds : 0); } catch (e) { return cur && cur.duration ? cur.duration.milliseconds : 0; } },
      getMute: function () { return false; }, getVolume: function () { return 1; },
      addEventListener: function (t, cb) { (listeners[t] = listeners[t] || []).push(cb); },
      removeEventListener: function (t, cb) { var a = listeners[t] || []; var i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); },
      pause: function () {}, play: function () {}, togglePlay: function () {}, next: function () {}, back: function () {},
      seek: function (ms) { qobuzSeek(ms); }, setVolume: function () {},
      getHeart: function () { return false; }, getRepeat: function () { return 0; }, getShuffle: function () { return false; },
      isPlaying: function () { if (window.__QZ_SL_DEBUG && window.__QZ_SL_DEBUG._forcePlaying != null) return window.__QZ_SL_DEBUG._forcePlaying; return Q.player.isPlaying(); },
      _state: { get isPaused() { return !Q.player.isPlaying(); }, restrictions: {}, get positionAsOfTimestamp() { return getPosMs(); }, get timestamp() { return Date.now(); } },
      // origin._state feeds SL's _DEPRECATED_ progress fallback (used when its synced
      // clock is unavailable). Without live position fields here it returns null ->
      // Animate(null) -> ProcessedPosition 0 -> every line stuck "NotSung".
      origin: { seekTo: function (ms) { qobuzSeek(ms); }, _state: { get isPaused() { return !Q.player.isPlaying(); }, shuffle: false, smartShuffle: false, get positionAsOfTimestamp() { return getPosMs(); }, get timestamp() { return Date.now(); } } }
    },
    Platform: {
      version: "1.2.45",
      History: makeHistory(),
      // _isLocal + a _contextPlayer.getPositionState returning our real position route
      // SL's GetProgress() down the clean "local" path (otherwise it reads undefined
      // Spotify state fields and the lyric clock goes NaN -> every word's --gradient-position
      // is NaN -> the gradient calc() is invalid -> text paints transparent = invisible).
      // Spotify reports _isLocal:false → SL reads position from _state.positionAsOfTimestamp
      // + (now - _state.timestamp), not the local getPositionState() path. so match that
      // exactly: positionAsOfTimestamp = our live position, timestamp = now (so the
      // extrapolation term is ~0 and the clock just follows getPosMs()).
      PlaybackAPI: { _isLocal: false, _events: { addListener: function () {}, removeListener: function () {} }, getState: function () { return playerData(); }, getProgress: function () { return getPosMs(); } },
      PlayerAPI: {
        _state: { get isPaused() { return !Q.player.isPlaying(); }, isBuffering: false, hasContext: true, restrictions: {}, get duration() { try { return (Q.getState().player.currentTrack || {}).duration || (cur && cur.duration ? cur.duration.milliseconds : 0); } catch (e) { return cur && cur.duration ? cur.duration.milliseconds : 0; } }, get positionAsOfTimestamp() { var v = getPosMs(); try { if (window.__QZ_SL_DEBUG) { window.__QZ_SL_DEBUG._patCalls = (window.__QZ_SL_DEBUG._patCalls || 0) + 1; window.__QZ_SL_DEBUG._patLast = v; } } catch (e) {} return v; }, get timestamp() { return Date.now(); } },
        getState: function () { return playerData(); }, _events: { addListener: function () {}, removeListener: function () {} },
        _contextPlayer: { getPositionState: function () { try { if (window.__QZ_SL_DEBUG) { window.__QZ_SL_DEBUG._gpsCalls = (window.__QZ_SL_DEBUG._gpsCalls || 0) + 1; window.__QZ_SL_DEBUG._gpsLast = getPosMs(); } } catch (e) {} return Promise.resolve({ position: getPosMs() }); }, resume: function () { return Promise.resolve(); }, pause: function () { return Promise.resolve(); } }
      },
      // Always report a FUTURE expiry: SL's GetSpotifyAccessToken infinite-loops on a
      // past expiresAtTime (it keeps "refreshing" and getting the same token), which
      // hangs fetchLyrics. We can't refresh the token anyway, so just never look expired.
      Session: { get accessToken() { return userToken(); }, get accessTokenExpirationTimestampMs() { return Date.now() + 21600000; } },
      LibraryAPI: { add: function () { return Promise.resolve(); }, remove: function () { return Promise.resolve(); }, contains: function () { return Promise.resolve([false]); }, getEvents: function () { return { addListener: function () {} }; } },
      UserAPI: { getUser: function () { return Promise.resolve({ username: "qobuz" }); } },
      Translations: {}, RootlistAPI: {}, ConnectAPI: {}
    },
    CosmosAsync: {
      // SL's GetSpotifyAccessToken first tries CosmosAsync.get("sp://oauth/v2/token");
      // answer it with the user token so the real lyric sources auth correctly.
      get: function (url) { if (/oauth\/v2\/token/.test(url || "") && userToken()) return Promise.resolve({ accessToken: userToken(), expiresAtTime: Date.now() + 21600000, tokenType: "Bearer" }); return Promise.reject(new Error("Resolver not found")); },
      post: function () { return Promise.reject(new Error("Resolver not found")); },
      put: function () { return Promise.reject(new Error("Resolver not found")); },
      del: function () { return Promise.reject(new Error("Resolver not found")); }
    },
    LocalStorage: { get: function (k) { return localStorage.getItem("qz:" + k); }, set: function (k, v) { localStorage.setItem("qz:" + k, v); }, remove: function (k) { localStorage.removeItem("qz:" + k); } },
    PopupModal: makePopupModal(),
    Tippy: noopTip, TippyProps: {},
    Keyboard: {
      KEYS: { ESCAPE: "Escape", BACKSPACE: "Backspace", TAB: "Tab", ENTER: "Enter", SPACE: " ", ARROW_UP: "ArrowUp", ARROW_DOWN: "ArrowDown", ARROW_LEFT: "ArrowLeft", ARROW_RIGHT: "ArrowRight" },
      registerShortcut: function () {}, _deregisterShortcut: function () {}, registerImportantShortcut: function () {}, ListOfModifiers: {}
    },
    SVGIcons: {},
    Topbar: { Button: function () { this.element = document.createElement("button"); this.element.style.display = "none"; } },
    ContextMenu: { Item: function (name, onClick, shouldAdd, icon) { this.name = name; this.onClick = onClick; this.icon = icon; this.register = function () {}; this.deregister = function () {}; }, SubMenu: function () { this.register = function () {}; this.deregister = function () {}; } },
    Menu: { Item: function () { this.register = function () {}; this.deregister = function () {}; this.setState = function () {}; this.setName = function () {}; }, SubMenu: function () { this.register = function () {}; this.deregister = function () {}; } },
    URI: { fromString: function (s) { return { toString: function () { return s; }, type: "track" }; }, from: function (s) { return { toString: function () { return s; }, type: "track" }; }, isTrack: function () { return true; }, Type: { TRACK: "track", ALBUM: "album", ARTIST: "artist", PLAYLIST: "playlist", EPISODE: "episode", SHOW: "show" } },
    Mousetrap: function () { return { bind: function () {}, unbind: function () {}, reset: function () {} }; },
    Locale: { get: function (k) { return k; }, getDictionary: function () { return {}; }, getLocale: function () { return "en"; }, _dictionary: {} },
    showNotification: function (msg, isErr) { try { console[isErr ? "error" : "info"]("[QobuzifyLyrics] " + msg); } catch (_) {} },
    Events: { platformLoaded: { on: function (cb) { cb && cb(); } }, webpackLoaded: { on: function (cb) { cb && cb(); } } },
    colorExtractor: function () { return Promise.resolve({ DESATURATED: "#9aa0a6", VIBRANT: "#e8eaed", PROMINENT: "#e8eaed", LIGHT_VIBRANT: "#ffffff", DARK_VIBRANT: "#5f6368" }); }, // neutral palette (no forced brand tint - background carries the identity now)
    Snackbar: { enqueueSnackbar: function () {} },
    Platform_: null, _qobuzify: true
  };
}

// --- player-bar button ---
function ensureButton() {
  var btn = document.createElement("button");
  btn.id = "qz-sl-btn";
  btn.className = "qz-pbtn qz-sl-btn";
  btn.title = "Lyrics";
  btn.setAttribute("aria-label", "Lyrics");
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:block"><line x1="4" y1="7" x2="13" y2="7"/><line x1="4" y1="11" x2="11" y2="11"/><line x1="4" y1="15" x2="9" y2="15"/><circle cx="16.5" cy="16" r="2.2"/><path d="M18.7 16.2V7.6l3 1.5"/></svg>'; // custom lyrics mark (text lines + music note)
  btn.addEventListener("click", function (e) {
    e.preventDefault(); e.stopPropagation();
    var h = window.Spicetify && window.Spicetify.Platform.History;
    if (!h) return;
    if (h.location.pathname === "/QzLyrics") h.push({ pathname: "/" }); else h.push({ pathname: "/QzLyrics" });
  });
  Q.css("qz-sl-btn-css", ".qz-sl-btn--active{color:var(--qz-accent,#3DA8FE) !important;}");
  // register in the shared right-zone slot (runtime places + spaces + keeps alive)
  if (Q.playerSlot) { var slot = Q.playerSlot({ id: "qz-lyrics", zone: "right", order: 10, el: btn }); return function () { slot.remove(); }; }
  // fallback for an older runtime without the slot API
  var off = Q.observe(function () { if (!document.getElementById("qz-sl-btn")) { var a = document.querySelector(".player__settings"); if (a) a.insertBefore(btn, a.firstChild); } }, { debounce: 300 });
  return function () { if (off) off(); btn.remove(); };
}

// The karaoke word-fill is rendered by SL's native LyricsAnimator, driven by the getPosMs() clock shim
// (PlayerAPI._state.positionAsOfTimestamp / _contextPlayer.getPositionState). We do not run our own fill loop.
// The server delivers lyrics already time-aligned, so there is no per-source shift here.
// __QZ_SL_DEBUG.setOffset pins a fixed value for dev testing only - never surfaced to users.
var _offOverride = null;
try { var _o0 = parseInt(localStorage.getItem("qz-lyr-fixed"), 10); if (!isNaN(_o0)) _offOverride = _o0; } catch (e) {}
// The codename the server returns for the track (already obfuscated upstream-side); shown verbatim
// in the footer as "Lyric server: <codename>". Null until the first resolve lands.
var curLyricSource = null, _tagSong = null, _tagScanned = false; // _tagSong = source the credit tag was last written for (skip the DOM walk once placed); _tagScanned = walked once this song with no anchor (Lyra path) - re-walk only on songchange
function autoOffsetMs() { return _offOverride != null ? _offOverride : 0; }
function setLyricServerTag() {
  try {
    var root = document.getElementById("qz-sl-root"); if (!root || root.style.display === "none") return; // skip the full-subtree scan while the lyrics view is closed
    if (_tagSong === curLyricSource && document.getElementById("qz-lyric-server")) return; // already tagged this source - nothing to re-scan
    if (_tagScanned) return; // Lyra never renders the vendor credit lines, so a no-anchor walk is definitive for the whole song; without this latch the 250ms tick re-walked the full syllable subtree (3-6k nodes) 4x/sec forever
    // The bundled renderer draws its own credit lines from the lyrics metadata: "Written by ...",
    // "Uploaded by ...", and "Provided by <name>" where the name is mapped from the source id. Those
    // point straight at the upstream, which the whole codename wall exists to prevent, so hide them.
    // Keep only our own "Lyric server: <codename>" line (a fixed, obfuscated map) in the same spot.
    var prov = null, all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i]; if (el.children.length) continue;
      var txt = el.textContent || "";
      if (/^\s*(Written by|Uploaded by|Made by)\b/i.test(txt)) { el.style.display = "none"; continue; }
      if (/^\s*Provided by\b/i.test(txt)) { if (!prov) prov = el; el.style.display = "none"; }
    }
    if (!prov) { if (OWN_RENDERER) _tagScanned = true; return; } // no credits footer yet - nothing to anchor to (vendor renders credits late, so only the Lyra path latches)
    var want = "Lyric server: <b>" + (curLyricSource || "Unknown") + "</b>";
    var tag = document.getElementById("qz-lyric-server");
    if (!tag) { tag = document.createElement("div"); tag.id = "qz-lyric-server"; tag.className = "qz-lyric-server"; prov.parentNode.insertBefore(tag, prov.nextSibling); }
    if (tag.innerHTML !== want) tag.innerHTML = want;
    _tagSong = curLyricSource; // remember, so the 4x/sec tick stops re-scanning until the source changes
  } catch (e) {}
}
// --- rAF frame-rate cap for the karaoke (fast-song fix) ---
// On a high-refresh display (e.g. 144Hz) the vendor renders the word-fill at the FULL refresh rate. On fast
// songs (fast rap) that saturates the frame budget and starves the vendor's OWN synced-position loop (a
// setTimeout that re-anchors its clock): when it can't fire on time its clock extrapolates forward ~0.5s -
// every word reads "sung" (fills white) and the active line drops out - until it re-anchors. Capping the
// vendor's rAF to ~72Hz WHILE THE LYRICS VIEW IS OPEN leaves idle main-thread time each frame for that loop
// to fire on schedule; a 72fps text fill is visually identical to 144. Only engages above ~90Hz (a 60/75Hz
// display passes through untouched). The vendor calls BARE requestAnimationFrame (looked up globally per
// call, never cached as a function - verified), so overriding window.requestAnimationFrame caps every one of
// its loops. Our scroll guard uses the captured NATIVE rAF so it always stays full-rate.
var _origRAF = window.requestAnimationFrame;
var _nativeRAF = _origRAF ? _origRAF.bind(window) : function (f) { return setTimeout(function () { f(performance.now()); }, 16); };
var _origCAF = window.cancelAnimationFrame;
var _nativeCAF = _origCAF ? _origCAF.bind(window) : function (h) { clearTimeout(h); };
try { window.__QZ_SL_nativeRAF = _nativeRAF; } catch (e) {} // our renderer ticks off the true native rAF (bypasses the vendor-only frame cap)
(function installRafCap() {
  if (OWN_RENDERER) return; // the cap exists to protect the SL vendor's synced-position loop; Lyra ticks on __QZ_SL_nativeRAF, so installing it would only half-rate the HOST app's rAF while lyrics are open, for nothing
  if (window.__QZ_SL_RAFCO__) return; window.__QZ_SL_RAFCO__ = true;
  var refreshHz = 0, measuring = false, frame = 0, ticking = false;
  function startMeasure() { // measure the display refresh once, lazily, the first time the view is open (rAF is live even if boot happened minimized)
    if (refreshHz || measuring) return; measuring = true; var n = 0, s = 0;
    function m(ts) { if (!s) s = ts; n++; if (ts - s < 450) _nativeRAF(m); else { refreshHz = (n / ((ts - s) / 1000)) || 60; measuring = false; } }
    _nativeRAF(m);
  }
  function viewOpen() { var r = document.getElementById("qz-sl-root"); return !!(r && r.style.display !== "none"); }
  function cap() { if (!viewOpen()) return false; if (!refreshHz) { startMeasure(); return false; } return refreshHz > 90; }
  function tick() { frame++; if (viewOpen() && refreshHz > 90) _nativeRAF(tick); else ticking = false; } // one increment per real frame while capping
  var idMap = {}; // returned id -> CURRENT native id across re-queue hops, so cancelAnimationFrame(id) still cancels a deferred callback (the old wrapper returned the first hop's id and a cancel after re-queue was a no-op - host code's unmount cancels leaked ghost frames)
  window.requestAnimationFrame = function (cb) {
    if (!cap()) return _nativeRAF(cb); // full rate everywhere except the open lyrics view on a high-refresh display
    if (!ticking) { ticking = true; _nativeRAF(tick); }
    var q = frame;
    // run cb only after the frame counter has advanced by >=2 native frames -> ~half the refresh rate.
    // Each callback tracks its own queue frame, so multiple vendor loops coalesce to ~72Hz without starving each other.
    var id = _nativeRAF(function run(ts) { if (frame >= q + 2 || !viewOpen() || refreshHz <= 90) { delete idMap[id]; cb(ts); } else idMap[id] = _nativeRAF(run); });
    idMap[id] = id;
    return id;
  };
  window.cancelAnimationFrame = function (h) {
    var live = idMap[h];
    if (live != null) { delete idMap[h]; return _nativeCAF(live); }
    return _nativeCAF(h);
  };
})();
// Alt-tab scroll-jump fix. The lyrics live in a SimpleBar/virtualized scroller; when the
// window regains focus the bundle snaps scrollTop to 0 for a frame (flashing the top lines /
// source credits) before re-scrolling to the active line. We track the live scroll position
// and, for a short window after focus, snap any spurious jump toward 0 straight back - so the
// 0 never paints. Capture-phase listener catches the scroll before the bundle's own handlers.
var _seekScrollUntil = 0; // set by qobuzSeek; opens a brief guard window after a click-to-seek
var _scrollGuardRAF = null, _onSeekScroll = null, _onUserScroll = null; // scroll-guard rAF handle + named listeners (for cleanup / re-enable)
// Scroll guard, two jobs sharing one tracked position (lastGood):
//  (1) click-to-seek flash: a scroll to the top right after a seek is the bundle's flash - bounce it.
//  (2) alt-tab rebuild rescue: on refocus the virtualizer rebuilds the lyric list (VirtualLyricsContainer
//      gets fresh DIVs) and spawns a NEW simplebar scroll wrapper at scrollTop 0. It is a rebuild, not a
//      scroll assignment, so no scroll event fires and there is nothing to intercept via events - the only
//      way to catch it is to poll. Each frame: if the live scroller has landed near the top (<200px) while
//      we were scrolled down (>500px), restore our position once the rebuilt list is tall enough to hold
//      it, then hand control straight back to the engine. The near-0 gate means it never fights normal
//      auto-scroll or a deliberate scroll to the top; scoping to the lyrics root means it never touches
//      Qobuz's own scrollers. (Diagnosed via CDP: the reset is always a rebuild landing at exactly 0, while
//      normal virtualizer churn preserves position - so gating on the landing position cleanly separates them.)
if (!window.__QZ_SL_SCROLLGUARD__) { window.__QZ_SL_SCROLLGUARD__ = true; (function installScrollGuard() { // install once (a Marketplace disable->enable re-runs this source)
  var descTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  function rawTop(el) { return descTop.get.call(el); }
  function setTop(el, v) { descTop.set.call(el, v); }
  function lyricsRoot() { return document.getElementById("qz-sl-root") || document.getElementById("QzLyricsPage"); }
  var _cachedScroller = null;
  function scroller() {
    var c = _cachedScroller;
    // Reuse while still in the DOM. The OLD gate also required the list to be scrollable
    // (scrollHeight-clientHeight>2), but during the intro / first-line the list isn't tall
    // enough to scroll yet, so that gate MISSED every tick and re-ran querySelectorAll + a
    // full-list scrollHeight measure ~18x/s (forced layout) exactly while the virtualizer was
    // thrashing its own measurements - amplifying the first-line churn (profiled: `scroller`
    // 115ms). The element is stable within a track (nulled on track change below), so caching
    // by connection alone is safe and kills the storm.
    if (c && c.isConnected) return c;
    var root = lyricsRoot(); if (!root) return null;
    var l = root.querySelectorAll(".simplebar-content-wrapper"), b = null, bs = -1;
    for (var i = 0; i < l.length; i++) { var e = l[i], r = e.scrollHeight - e.clientHeight;
      if (r > 2) { var s = (e.scrollTop || 0) + r * 0.001; if (s > bs) { bs = s; b = e; } } }
    _cachedScroller = b || l[0] || null;
    return _cachedScroller;
  }
  var lastGood = 0, pending = null, lastTrackId = null, _lastPos = 0;
  var _userScrollUntil = 0, lastGoodLine = null; // user-intent window + the active-line element captured when lastGood was recorded
  // The active lyric line. A spurious virtualizer rebuild/flash lands near the top with the SAME active line;
  // a real scroll-up or a backward-seek to an early line lands near the top with a DIFFERENT (earlier) active
  // line. Comparing line identity is the discriminator the magnitude-only gate was missing.
  function activeLine() { try { return document.querySelector("#QzLyricsPage .LyricsContent .line.Active:not(.musical-line)"); } catch (e) { return null; } }
  // Any genuine user scroll gesture over the lyrics opens a short window in which the guard yields. A real
  // rebuild fires NO input event, so the alt-tab rescue is unaffected.
  _onUserScroll = function (e) { var r = lyricsRoot(), t = e && e.target; if (r && t && (t === r || (r.contains && r.contains(t)))) _userScrollUntil = Date.now() + 1200; };
  document.addEventListener("wheel", _onUserScroll, true);
  document.addEventListener("pointerdown", _onUserScroll, true);
  document.addEventListener("touchstart", _onUserScroll, true);
  var _forceTopUntil = 0; // after a track change, actively pin the lyrics to the top for a moment (auto top-on-new-song)
  var _lastWork = 0; // poll ~18Hz (throttled below); the old full-rate refocus burst was removed as pure cost
  // Full-rate the poll for a moment after the window regains focus, so it catches the alt-tab rebuild the
  // instant it lands at 0 (before it paints). Outside these windows an ~18Hz poll is plenty and avoids the
  // per-frame querySelectorAll + scrollHeight reads (forced layout) that showed up as playback jank while
  // just listening. it's not gated on route (that broke auto-scroll before) - always on, just at lower
  // frequency. and no full-rate rescue on refocus. the old code ran rescue() (scroller() + scrollTop/
  // scrollHeight forced-layout reads) at ~144Hz for up to 1.6s after every alt-tab, while the document
  // layout is dirty from the focus - a per-frame forced reflow that was a big slice of the alt-tab lag.
  // it was there to catch a "rebuild lands at scrollTop 0" the instant it paints, but on Windows alt-tab
  // the lyrics never rebuild to 0 (content stays mounted - the lag was repaint, not a scroll reset), so
  // the burst was pure cost.
  // The throttled ~18Hz rescue still runs for the track-change top-pin + seek-flash; focus does nothing now.
  // (1) click-to-seek flash bounce (event-based; the seek path DOES fire a scroll event)
  _onSeekScroll = function (e) {
    var w = e.target;
    if (!w || !w.classList || !w.classList.contains("simplebar-content-wrapper")) return;
    if (Date.now() < _seekScrollUntil && w.scrollTop < 140 && lastGood > 400) w.scrollTop = lastGood;
  };
  document.addEventListener("scroll", _onSeekScroll, true);
  // (2) alt-tab rebuild rescue (poll-based)
  function rescue() {
    var _root = document.getElementById("qz-sl-root");
    if (!_root || _root.style.display === "none") { _scrollGuardRAF = _nativeRAF(rescue); return; } // view closed: skip the querySelectorAll + forced-layout work, keep polling cheaply
    var now = Date.now();
    var hi = false; // always throttle to ~18Hz (_rescueHiUntil was never set; _forceTopUntil pin still runs, just at 18Hz)
    if (!hi && now - _lastWork < 55) { _scrollGuardRAF = _nativeRAF(rescue); return; }
    _lastWork = now;
    // On a song change, forget the remembered position (+ drop the cached scroller so we re-find the rebuilt
    // one) so the rescue can't drag the NEW song back to the old scroll spot - the engine's own scroll-to-top
    // for the new track then wins (auto top-on-new-song).
    try {
      var tid = (Q.getState().player.currentTrack || {}).id;
      if (tid !== lastTrackId) { lastTrackId = tid; lastGood = 0; lastGoodLine = null; pending = null; _forceTopUntil = now + 1000; _cachedScroller = null; _lastPos = 0; }
      else { // same track: a big backward jump to the very start = restart / repeat -> re-pin to the top (a small seek-back does NOT, so scrubbing is unaffected)
        var pos = Q.player.getPositionMs() || 0;
        if (pos < 1500 && _lastPos > 4000) { _forceTopUntil = now + 1600; lastGood = 0; lastGoodLine = null; pending = null; }
        _lastPos = pos;
      }
    } catch (e) {}
    var s = scroller();
    if (s) {
      var st = rawTop(s), sh = s.scrollHeight;
      if (now < _forceTopUntil) {
        // NEW SONG: actively pin to the top until the engine takes over, so every track starts at line 1.
        if (st > 0) setTop(s, 0); lastGood = 0; lastGoodLine = null; pending = null;
      } else if (sh - s.clientHeight > 2) { // only rescue/track when the list is actually scrollable (skips work during the non-scrollable intro/first-line)
        var al = activeLine(); // one query per heavy tick (~18Hz); cheaper than the scrollHeight read above
        // Arm the snap-back ONLY for a true spurious rebuild/flash: landed near the top, we were scrolled
        // down, the user isn't interacting, AND the active line hasn't moved. A deliberate scroll-up (user
        // input) or a backward-seek to an early line (active line changed) is legitimate - don't fight it.
        if (st < 200 && lastGood > 500 && now >= _userScrollUntil && al === lastGoodLine) { if (!pending || now > pending.until) pending = { target: lastGood, until: now + 900 }; }
        else if (st < 200 && pending && (now < _userScrollUntil || al !== lastGoodLine)) pending = null; // user grabbed control / seeked mid-bounce -> release
        if (pending && now <= pending.until) {
          if (sh - s.clientHeight >= pending.target - 5) { if (Math.abs(rawTop(s) - pending.target) > 8) setTop(s, pending.target); else pending = null; }
        } else if (pending) { pending = null; lastGood = st; lastGoodLine = al; } // pending expired: accept where we ended (avoids re-trigger loop)
        else if (st > 50) { lastGood = st; lastGoodLine = al; } // track position + its active line while stable
      }
    }
    _scrollGuardRAF = _nativeRAF(rescue);
  }
  _scrollGuardRAF = _nativeRAF(rescue);
})(); }
// Smooth playback clock. Qobuz reports position in coarse ~250ms steps, so reading it raw
// makes the karaoke jump and the active line flip late. We anchor to Qobuz's position and
// extrapolate with wall-clock between its updates, re-syncing on each fresh value (never
// snapping backward on a late tick), then add the format-based offset.
var _clkPos = 0, _clkAt = 0, _clkRaw = -1, _clkSeek = false; // _clkSeek = a click-to-seek just fired -> snap the clock exactly on the next read
function getPosMs() {
  if (window.__QZ_SL_DEBUG && window.__QZ_SL_DEBUG._pos != null) return window.__QZ_SL_DEBUG._pos;
  var raw = Q.player.getPositionMs() || 0, now = Date.now();
  if (!Q.player.isPlaying()) { _clkPos = raw; _clkAt = now; _clkRaw = raw; return raw + autoOffsetMs(); }
  if (_clkSeek) { _clkSeek = false; _clkRaw = raw; _clkPos = raw; _clkAt = now; return raw + autoOffsetMs(); } // exact snap after a click-to-seek (kills the ~400ms overshoot on a backward re-click)
  if (raw !== _clkRaw) {
    _clkRaw = raw;
    var ext = _clkPos + (now - _clkAt); // renamed from `cur` (which shadowed the module-level track var)
    _clkPos = (raw < ext && ext - raw < 500) ? ext : raw; // don't snap backward on a late coarse tick
    _clkAt = now;
  }
  // Quantize to ~60Hz. On a high-refresh (144Hz) display the bundle re-reads this every frame and repaints
  // the karaoke word-fill 144x/s; holding the value in ~16ms buckets means the fill (and the styles it
  // writes) only CHANGE ~60x/s, so the browser skips the redundant repaints - roughly halves the paint the
  // lyrics view does. 60fps is smooth for text; line-active detection (seconds apart) is unaffected.
  return Math.round((_clkPos + (now - _clkAt) + autoOffsetMs()) / 16) * 16;
}

// --- combo animation driver ---
// Polls for the active line changing; on each change it pulses the background bloom. The per-word glow/pop
// sweep was removed earlier per request, so the driver is now JUST line-change detection + the bloom - no
// per-line querySelectorAll/text-match and no per-tick word loop. That matters on fast songs (fast rap):
// line changes fire many times a second, and the vendor's own synced-position loop (a setTimeout) can get
// starved by heavy per-frame work, spiking its clock forward for ~0.5s (every word reads "sung"/white, the
// active line drops out, then it re-anchors). Keeping our per-tick cost near zero leaves the main thread free
// for that loop to fire on time. (SL words reject `transform`; a stylesheet rule loses the cascade to the
// vendor - both CDP-verified - so any future word effect must be inline scale/translate/text-shadow.)
var _comboIv = null, _comboLast = null;
function _comboTick() {
  var view = document.getElementById("qz-sl-root"); if (!view || view.style.display === "none") return;
  var line = document.querySelector("#QzLyricsPage .LyricsContent .line.Active:not(.musical-line)");
  if (line && line !== _comboLast) {
    _comboLast = line;
    var cbg = document.getElementById("qz-cbg"); if (cbg) { cbg.classList.remove("qz-bloom"); void cbg.offsetWidth; cbg.classList.add("qz-bloom"); } // beat bloom on each new active line
  }
}

// --- boot ---
var offBridge = null, tickIv = null, offPP = null, offBtn = null, tokenIv = null;
(async function boot() {
  try {
    await Promise.resolve(); // let the rest of the module finish evaluating (FS icon vars live below) before any DOM work; boot used to inherit this ordering from the React-import await, which the own path no longer performs
    // The lyrics view builds on a small Spicetify-compatible host object (Platform.History, Player) that
    // Qobuzify's extensions target. Lyra reads only that scaffolding and is React-free, so the host is
    // built directly with no network imports (an offline launch never blocks the button or the lyrics).
    if (!window.Spicetify || !window.Spicetify._qobuzify) {
      window.Spicetify = buildSpicetify(null, {}, {}, {});
    }
    ensureContainer();
    await ensureFreshToken(); // renew the Spotify token (if logged in) before resolving lyrics
    if (ST && ST.refresh_token) tokenIv = setInterval(ensureFreshToken, 1500000); // keep it alive (~25 min)

    // bridge: react to Qobuz track changes + progress + play/pause
    // Qobuz's onChange doesn't fire for every track change (notably in-album auto-advance),
    // which used to leave the cover background a full song behind, and black on a cold
    // relaunch. so we poll getTrack() (a cheap local read) and update on any change, deduped
    // by track id + cover. onChange stays on too, as an extra nudge.
    var _lastTrackId = null, _lastCover = null, _emptyTicks = 0, _nameFixPending = null, _nameFixTicks = 0;
    var handleTrack = function (qt) {
      var id = qt && qt.id ? String(qt.id) : "";
      // Cold restore (and the first read right after launch) hands back the track id BEFORE its title/
      // artist hydrate. Committing that blank read latched curMeta={name:"",artist:""} and then, deduped
      // by id, never re-mapped when the metadata arrived - so a paused restored track resolved lyrics for
      // "" and showed "No lyrics" until you actually changed songs. So don't commit an id-without-title
      // read at all: skip it and let the 250ms poll pick up the hydrated metadata (curMeta stays null ->
      // a brief "Waiting for track…", then flips to the real song). An empty-id read (nothing loaded)
      // still falls through to the occlusion debounce below.
      if (id && !(qt && qt.title)) return;
      // Q.player.getTrack() intermittently returns an EMPTY read during alt-tab focus/occlusion churn.
      // Treating that blank tick as a track change makes mapTrack() wipe cur/curMeta and emit an empty
      // songchange -> the vendor flashes "no song" / "no lyrics", then reloads. So debounce: only believe
      // "nothing is playing" after a blank read PERSISTS ~1s (4 polls). A real track change carries a
      // non-empty id and is handled instantly (and resets the counter).
      if (!id) { if (_lastTrackId && ++_emptyTicks < 4) return; } else { _emptyTicks = 0; }
      // The id comes from the store and flips INSTANTLY on a switch, but title/artist are scraped from
      // the player-bar DOM, which re-renders a frame later - so the first read after a switch pairs the
      // NEW id with the OUTGOING track's name. mapTrack commits that, then the id-dedup below locks it in,
      // leaving lyrics+cover+header stuck on the previous song (seen switching TIMEZONE -> Wolves). So also
      // re-map when the id is unchanged but the scraped name has since corrected to a different title.
      var nameFixed = id && id === _lastTrackId && curMeta && qt && qt.title && qt.title !== curMeta.name;
      // Debounce the correction: the title is SCRAPED from the player bar, and a transient DOM state (an
      // overflow-marquee re-render mid-read, a half-updated node) can make it flicker between values. An
      // undebounced remap on every mismatched read re-nulled the renderer key and re-resolved lyrics per
      // 250ms tick - the "stuck on Loading lyrics… for ages" freeze (long titles = the marquee tracks).
      // Only remap once the corrected title has read IDENTICALLY for 3 consecutive polls (~750ms); a real
      // late-hydrated title is stable, a flicker never survives the window.
      if (nameFixed) {
        if (qt.title === _nameFixPending) { _nameFixTicks++; } else { _nameFixPending = qt.title; _nameFixTicks = 1; }
        if (_nameFixTicks < 3) return;
      } else { _nameFixPending = null; _nameFixTicks = 0; }
      if (id !== _lastTrackId || nameFixed) {
        _nameFixPending = null; _nameFixTicks = 0;
        // real track change (or a corrected late-hydrated name) -> full remap, which emits songchange so the vendor loads THIS song's lyrics.
        _lastTrackId = id; _lastCover = (qt && qt.cover) || "";
        mapTrack(qt);
        schedulePrefetch(); // warm the next queued track's lyrics so it's instant when it starts
        ownOnTrackChange(); // our renderer: re-resolve + re-render for the new track (no-op unless OWN_RENDERER + view open)
      } else {
        // SAME track, only the cover URL changed - Qobuz swaps the player-bar art between resolutions
        // (_50.jpg -> _230.jpg) mid-song and re-renders it. Refresh JUST the background; do NOT re-emit
        // songchange, which tears down + rebuilds the entire lyric list (a visible flash). The old key mixed
        // in the RAW cover, so every resolution swap read as a new song and reloaded the lyrics.
        var cover = (qt && qt.cover) || "";
        if (cover && cover !== _lastCover) { _lastCover = cover; try { setCoverBg(cover.replace(/_\d+\.jpg/, "_600.jpg")); } catch (e) {} }
      }
    };
    offBridge = Q.player.onChange(handleTrack);
    handleTrack(Q.player.getTrack());
    tickIv = setInterval(function () { handleTrack(Q.player.getTrack()); emit("onprogress", { data: Q.player.getPositionMs() }); setLyricServerTag(); }, 250);
    var lastPlaying = Q.player.isPlaying();
    offPP = Q.subscribe(function () { var p = Q.player.isPlaying(); if (p !== lastPlaying) { lastPlaying = p; emit("onplaypause", { data: { isPaused: !p } }); var _r = document.getElementById("qz-sl-root"); if (_r) _r.classList.toggle("qz-paused", !p); } }); // freeze the mesh orbits while paused (window never goes document.hidden)

    offBtn = ensureButton();
    _comboIv = setInterval(_comboTick, 75); // drive the combo animation (bloom + clock-synced word glow-pop)

    // debug hook: render lyrics without live playback (audio output may be absent
    // in a headless/CDP session). Harmless in normal use; only does anything when called.
    window.__QZ_SL_DEBUG = {
      _pos: null,
      _forcePlaying: null,
      setPos: function (ms) { this._pos = ms; emit("onprogress", { data: ms }); },
      getOffset: function () { return { applied: autoOffsetMs(), source: curLyricSource, auto: _offOverride == null, fixed: _offOverride }; },
      setOffset: function (ms) { _offOverride = (ms == null ? null : +ms); try { ms == null ? localStorage.removeItem("qz-lyr-fixed") : localStorage.setItem("qz-lyr-fixed", String(_offOverride)); } catch (e) {} return _offOverride; }, // dev only: pin a fixed offset; setOffset(null) restores auto
      clearPos: function () { this._pos = null; },
      setPlaying: function (b) { this._forcePlaying = b; emit("onplaypause", { data: { isPaused: !b } }); },
      inject: function (meta) {
        curMeta = { name: meta.name, artist: meta.artist || "", album: meta.album || "", durationMs: meta.durationMs || 200000, isrc: meta.isrc || null };
        curLyrics = null;
        cur = { uri: meta.spotifyId ? "spotify:track:" + meta.spotifyId : "qobuz:track:" + (meta.id || "test"), name: meta.name, artists: [{ type: "artist", name: meta.artist || "", uri: "" }], images: ["standard", "small", "large", "xlarge"].map(function (l) { return { label: l, url: meta.cover || "" }; }), duration: { milliseconds: curMeta.durationMs }, metadata: { album_title: meta.album || "" }, type: "track", mediaType: "audio", provider: "qobuz", isLocal: false };
        emit("songchange", { data: playerData() });
        return curMeta;
      },
      resolve: function (meta) { return resolveLyrics(meta || curMeta); },
      open: function () { try { window.Spicetify.Platform.History.push({ pathname: "/QzLyrics" }); } catch (e) {} },
      getLyrics: function () { return curLyrics; },
      getMeta: function () { return curMeta; }
    };
  } catch (e) { try { console.error("[QobuzifyLyrics] boot failed:", e); } catch (_) {} }
})();

// ---- TRUE FULLSCREEN (OS borderless, via the main-process RPC bridge) -----------------------
// The lyrics view (#qz-sl-root) is ALREADY a body-level, position:fixed, max-z, opaque overlay
// (see ensureContainer), so it covers the whole app window on its own - no chrome to hide, and no
// containing-block trap (it is a direct <body> child). "True fullscreen" just pops the OS WINDOW
// itself to borderless full-monitor: POST to the localhost bridge (:7673, the Discord-RPC one) and
// the main process calls BrowserWindow.setFullScreen. An expand/collapse button lives in the view;
// Esc exits; if the view closes while full-monitor we drop back out so you are never stranded.
var _fsOn = false, _fsBtn = null, _fsObs = null;
var FS_ICON_EXPAND = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>';
var FS_ICON_COLLAPSE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/></svg>';
// IPC first: contextBridge -> ipcMain -> win.setFullScreen, the exact call F11 makes. Nothing goes over
// the network, so there is nothing left to block. The loopback POST below is why this button was the ONLY
// broken fullscreen path: this page is https and the request to http://127.0.0.1 never left the renderer,
// while the .catch swallowed the failure and fsEnter had already flipped the icon to "collapse" - so the
// view claimed it was fullscreen and the window never moved. Keep the POST as a fallback for the Windows
// bake, where rpc-main.js is appended to the native main process and __QZFS__ does not exist.
function fsBridge(on) {
  try { if (window.__QZFS__ && window.__QZFS__.set) { window.__QZFS__.set(!!on); return; } } catch (e) {}
  try { fetch("http://127.0.0.1:7673/fullscreen", { method: "POST", body: JSON.stringify({ on: !!on }) }).catch(function () {}); } catch (e) {}
}
function fsSyncBtn() { if (!_fsBtn) return; _fsBtn.innerHTML = _fsOn ? FS_ICON_COLLAPSE : FS_ICON_EXPAND; _fsBtn.title = _fsOn ? "Exit full screen (Esc)" : "Full screen"; _fsBtn.classList.toggle("qz-lyrics-fs-on", _fsOn); }
function _fsEsc(e) { if (e.key === "Escape" && _fsOn) { e.stopPropagation(); e.preventDefault(); fsExit(); } }
function fsEnter() {
  if (_fsOn) return;
  _fsOn = true; fsBridge(true); fsSyncBtn();
  document.addEventListener("keydown", _fsEsc, true);
  // if the lyrics view closes (route change / close button) while full-monitor, drop back out so
  // the user is not stranded in a borderless window with no visible exit control.
  try {
    var root = document.getElementById("qz-sl-root");
    if (root && window.MutationObserver) {
      _fsObs = new MutationObserver(function () { if (root.style.display === "none") fsExit(); });
      _fsObs.observe(root, { attributes: true, attributeFilter: ["style"] });
    }
  } catch (e) {}
}
function fsExit() {
  if (!_fsOn) return;
  _fsOn = false; fsBridge(false); fsSyncBtn();
  document.removeEventListener("keydown", _fsEsc, true);
  if (_fsObs) { try { _fsObs.disconnect(); } catch (e) {} _fsObs = null; }
}
function fsToggle() { if (_fsOn) fsExit(); else fsEnter(); }
// the main process calls this (via executeJavaScript) when the window leaves fullscreen by ANY
// means - sync our state WITHOUT re-POSTing (the window is already out of fullscreen).
window.__qzOnLeaveFS = function () {
  if (!_fsOn) return;
  _fsOn = false; fsSyncBtn();
  document.removeEventListener("keydown", _fsEsc, true);
  if (_fsObs) { try { _fsObs.disconnect(); } catch (e) {} _fsObs = null; }
};
// Reverse sync over IPC: the window can enter OR leave fullscreen with no click on our button (F11, the
// window manager), and the icon would keep claiming whatever the button last did. Mirror the real state.
// Never call fsBridge from in here - the window has already changed, so re-sending would toggle it back.
try {
  if (window.__QZFS__ && window.__QZFS__.onChange) {
    window.__QZFS__.onChange(function (fs) {
      if (!!fs === _fsOn) return;
      _fsOn = !!fs; fsSyncBtn();
      if (_fsOn) { document.addEventListener("keydown", _fsEsc, true); return; }
      document.removeEventListener("keydown", _fsEsc, true);
      if (_fsObs) { try { _fsObs.disconnect(); } catch (e) {} _fsObs = null; }
    });
  }
} catch (e) {}
function ensureFsButton() {
  var root = document.getElementById("qz-sl-root"); if (!root) return;
  var existing = document.getElementById("qz-lyrics-fs-btn");
  if (existing) { _fsBtn = existing; fsSyncBtn(); return; }
  var b = document.createElement("button");
  b.id = "qz-lyrics-fs-btn"; b.type = "button"; b.className = "qz-lyrics-fs-btn"; b.setAttribute("aria-label", "Toggle full screen");
  b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); fsToggle(); });
  root.appendChild(b);
  _fsBtn = b; fsSyncBtn();
}
Q.css("qz-lyrics-fs-css", [
  ".qz-lyrics-fs-btn{position:absolute;top:16px;left:16px;z-index:40;width:40px;height:40px;border:0;border-radius:50%;",
  "background:rgba(255,255,255,.08);color:#e7ecf3;cursor:pointer;display:flex;align-items:center;justify-content:center;",
  "backdrop-filter:blur(6px);transition:background .15s ease,transform .12s ease,opacity .2s ease;opacity:.5;}",
  ".qz-lyrics-fs-btn:hover{background:rgba(255,255,255,.18);opacity:1;transform:scale(1.06);}",
  ".qz-lyrics-fs-btn.qz-lyrics-fs-on{color:var(--qz-accent,#e8eaed);}"
].join(""));

return function cleanup() {
  // Lyra's teardown contract: destroy() (not just stop) releases its rAF loop, the document-level
  // visibilitychange listener, the ResizeObserver, the background layers and the DOM. A re-init without this
  // would leak an orphan renderer still ticking against a dead instance.
  if (_own) { try { _own.destroy(); } catch (e) {} _own = null; }
  if (offBridge) offBridge();
  if (tickIv) clearInterval(tickIv);
  if (tokenIv) clearInterval(tokenIv);
  if (offPP) offPP();
  if (offBtn) offBtn();
  if (container) container.style.display = "none";
  if (_scrollGuardRAF) cancelAnimationFrame(_scrollGuardRAF);
  if (_onSeekScroll) document.removeEventListener("scroll", _onSeekScroll, true);
  if (_onUserScroll) { document.removeEventListener("wheel", _onUserScroll, true); document.removeEventListener("pointerdown", _onUserScroll, true); document.removeEventListener("touchstart", _onUserScroll, true); }
  window.__QZ_SL_SCROLLGUARD__ = false;
  try { window.removeEventListener("focus", _onWinFocus, true); document.removeEventListener("visibilitychange", _onVis, true); } catch (e) {}
  if (_prefetchTimer) clearTimeout(_prefetchTimer);
  if (_refocusT) clearTimeout(_refocusT);
  if (_comboIv) clearInterval(_comboIv);
  if (window.__QZ_SL_RAFCO__ && _origRAF) { window.requestAnimationFrame = _origRAF; if (_origCAF) window.cancelAnimationFrame = _origCAF; window.__QZ_SL_RAFCO__ = false; } // un-cap rAF + restore the paired cancel
  if (_fsOn) { fsBridge(false); _fsOn = false; }
  document.removeEventListener("keydown", _fsEsc, true);
  if (_fsObs) { try { _fsObs.disconnect(); } catch (e) {} _fsObs = null; }
  try { window.__qzOnLeaveFS = null; } catch (e) {}
  var _fsb = document.getElementById("qz-lyrics-fs-btn"); if (_fsb) _fsb.remove();
  var _fscss = document.getElementById("qz-lyrics-fs-css"); if (_fscss) _fscss.remove();
};
