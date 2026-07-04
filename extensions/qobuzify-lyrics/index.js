// Synced, word-by-word lyrics for Qobuz - a karaoke-style fill, an album-cover background, and
// auto-scroll. It renders through a licensed UI bundle (passed in as `vendor`) sitting behind a
// Qobuzify-API shim, and a Qobuz->Spotify ISRC bridge feeds Player.data.item.uri the mapped
// spotify:track:<id>. The lyric data itself comes from open sources (NetEase Cloud Music yrc plus
// LRCLIB). Opens from a player-bar button.
var Q = Qobuzify;
var SP = Q.spotify || {}; // { client_id, client_secret } - local only (ISRC->Spotify bridge)
var ST = Q.spotifyToken || null; // { access_token, expires_at } - Spotify user token for SL's real lyric sources
var AP = Q.apple || null; // { developer_token, media_user_token, storefront } - Apple Music TTML (syllable + duet agents)
function userToken() { return (ST && ST.access_token) || ""; }
// only treat the token as usable for SL's gated Spotify source when it's a real, non-expired user
// token (client-creds are ~140 chars and only give you static; user tokens are ~500+). otherwise we
// fall back to the open NetEase/LRCLIB source, which needs no token at all and now syncs (the clock
// is fixed). a usable user token either has a refresh_token (OAuth login, ~270+ chars) or is a long
// desktop-grabbed token (~500). client-credentials tokens (~140, no refresh) get rejected, so we
// fall back to the open NetEase source instead of getting static.
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
var curLyrics = null; // the resolved SL lyrics object (Syllable/Line/Static) for our own animator
var listeners = { songchange: [], onprogress: [], onplaypause: [] };
function emit(type, e) {
  if (type === "songchange") { try { setCoverBg(cur && cur.images && cur.images[0] && cur.images[0].url); } catch (_) {} }
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
function isrcToSpotifyId(isrc) {
  if (!isrc) return Promise.resolve(null);
  if (_isrc[isrc] !== undefined) return Promise.resolve(_isrc[isrc]);
  return spotifyToken().then(function (tok) {
    return fetch("https://api.spotify.com/v1/search?type=track&limit=1&q=" + encodeURIComponent("isrc:" + isrc), { headers: { Authorization: "Bearer " + tok } });
  }).then(function (r) { return r.json(); }).then(function (j) {
    var t = j.tracks && j.tracks.items && j.tracks.items[0]; var id = t ? t.id : null; _isrc[isrc] = id; return id;
  }).catch(function () { return null; });
}

/* map the current Qobuz track -> a Spotify-shaped player item */
function mapTrack(qt) {
  if (!qt || !qt.id) { cur = null; curMeta = null; curLyrics = null; emit("songchange", { data: playerData() }); return; }
  curMeta = { name: qt.title, artist: qt.artist || "", album: qt.album || "", durationMs: qt.durationMs || 0 };
  curLyrics = null;
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
    if (tr && tr.isrc && curMeta && curMeta.name === qt.title) curMeta.isrc = tr.isrc; // Apple Music keys lyrics by ISRC
    return isrcToSpotifyId(tr && tr.isrc);
  }).then(function (spid) {
    if (spid && cur && curMeta && curMeta.name === qt.title) {
      cur.uri = "spotify:track:" + spid;
      if (!curLyrics) emit("songchange", { data: playerData() });
    }
  }).catch(function () {});
}

// Click-to-seek. Qz Lyrics' lyric-word click resolves the line's StartTime and
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
    inst.props.seek({ position: target });
    _seekScrollUntil = Date.now() + 600; // suppress the bundle's scroll-to-top flash on the jump
  } catch (e) {}
}

// --- lyrics source: LRCLIB (open, no auth) feeding SL's renderer ---
// SL fetches from api.qzlyrics.org/query, which is auth-gated and ToS-restricted to their
// official client. so we intercept that fetch and instead hand back LRCLIB lyrics packed into the
// exact shape SL's lyricsPacker.unpack() and renderer expect.
var _origFetch = window.fetch.bind(window);

// faithful port of SL's SLObjPack.pack() so SL's strict unpack() accepts our payload
function slPack(obj) {
  var seen = new WeakSet();
  function snap(n, d) {
    if (d > 512) throw new Error("depth");
    if (n === null) return null;
    var t = typeof n;
    if (t === "string" || t === "boolean") return n;
    if (t === "number") { if (!isFinite(n)) throw new Error("nonfinite"); return n; }
    if (t !== "object") throw new Error("type");
    if (seen.has(n)) throw new Error("cycle");
    seen.add(n);
    try {
      if (Array.isArray(n)) { var a = new Array(n.length); for (var i = 0; i < n.length; i++) a[i] = snap(n[i], d + 1); return a; }
      var p = Object.getPrototypeOf(n); if (p !== Object.prototype && p !== null) throw new Error("nonplain");
      var ks = Object.keys(n), o = {}; for (var j = 0; j < ks.length; j++) { var k = ks[j]; if (k === "__proto__" || k === "constructor" || k === "prototype") throw new Error("forbidden"); o[k] = snap(n[k], d + 1); } return o;
    } finally { seen.delete(n); }
  }
  var safe = snap(obj, 0), freq = new Map();
  (function count(n) { if (n === null || typeof n !== "object") { freq.set(n, (freq.get(n) || 0) + 1); return; } if (Array.isArray(n)) n.forEach(count); else Object.keys(n).forEach(function (k) { freq.set(k, (freq.get(k) || 0) + 1); count(n[k]); }); })(safe);
  var values = Array.from(freq.entries()).sort(function (a, b) { return b[1] - a[1]; }).map(function (e) { return e[0]; });
  var idx = new Map(); values.forEach(function (v, i) { idx.set(v, i); });
  function ptr(n) { var x = idx.get(n); if (x === undefined) throw new Error("unindexed"); return x; }
  function schema(arr) { if (!arr.length) return false; var f = arr[0]; if (typeof f !== "object" || f === null || Array.isArray(f)) return false; var k0 = Object.keys(f); if (!k0.length) return false; for (var i = 1; i < arr.length; i++) { var it = arr[i]; if (typeof it !== "object" || it === null || Array.isArray(it)) return false; var ki = Object.keys(it); if (ki.length !== k0.length) return false; for (var k = 0; k < k0.length; k++) if (ki[k] !== k0[k]) return false; } return k0; }
  var stream = [];
  (function emit(n) {
    if (n === null || typeof n !== "object") { stream.push(ptr(n)); return; }
    if (Array.isArray(n)) {
      if (n.length === 0) { stream.push(-4); return; }
      if (n.length === 1) { stream.push(-5); emit(n[0]); return; }
      var sk = schema(n);
      if (sk) { stream.push(-3); stream.push(n.length); stream.push(sk.length); sk.forEach(function (k) { stream.push(ptr(k)); }); n.forEach(function (it) { sk.forEach(function (k) { emit(it[k]); }); }); return; }
      stream.push(-2); stream.push(n.length); n.forEach(emit); return;
    }
    var ks = Object.keys(n); if (!ks.length) { stream.push(-6); return; }
    stream.push(-1); stream.push(ks.length); ks.forEach(function (k) { stream.push(ptr(k)); }); ks.forEach(function (k) { emit(n[k]); });
  })(safe);
  return [values, stream];
}

// parse LRC ([mm:ss.xx] text) into SL line objects (StartTime/EndTime in ms)
function parseLRC(lrc, durationMs) {
  var rx = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g, lines = [];
  (lrc || "").split(/\r?\n/).forEach(function (raw) {
    var ms = [], m; rx.lastIndex = 0;
    while ((m = rx.exec(raw))) { var cs = m[3] ? parseInt((m[3] + "000").slice(0, 3), 10) : 0; ms.push((parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 1000 + cs); }
    var text = raw.replace(rx, "").trim();
    ms.forEach(function (t) { lines.push({ Text: text, StartTime: t, EndTime: 0 }); });
  });
  lines.sort(function (a, b) { return a.StartTime - b.StartTime; });
  for (var i = 0; i < lines.length; i++) lines[i].EndTime = i + 1 < lines.length ? lines[i + 1].StartTime : (durationMs || lines[i].StartTime + 5000);
  return lines;
}

// LRCLIB matching: titles like "Levels (Radio Edit)" / "Take It Easy (2013 Remaster)"
// miss an exact /api/get, so strip suffixes, relax album+duration, then search.
function cleanTitle(s) {
  return (s || "")
    .replace(/\s*[\(\[][^)\]]*(remaster|remastered|radio edit|edit|version|mono|stereo|live|remix|feat\.?|ft\.?|with )[^)\]]*[\)\]]/gi, "")
    .replace(/\s*-\s*(\d{4}\s*)?(remaster(ed)?|radio edit|single version|mono|stereo|live).*$/gi, "")
    .replace(/\s*[\(\[][^)\]]*[\)\]]\s*$/g, "")
    .trim() || (s || "").trim();
}
function cleanArtist(s) { return (s || "").replace(/\s*(feat\.?|ft\.?|with)\s+.*$/i, "").trim(); }
// Normalize for fuzzy compare: lowercase, strip diacritics + punctuation.
function norm(s) { return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
// Two titles "match" if, after cleaning + normalizing, one contains the other.
function titleMatch(a, b) { a = norm(cleanTitle(a)); b = norm(cleanTitle(b)); if (!a || !b) return false; return a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0; }
// An artist string "matches" if any 3+ char word of the wanted artist appears in the candidate's.
function artistMatch(want, have) { want = norm(cleanArtist(want)); have = norm(have); if (!want || !have) return false; if (have.indexOf(want) >= 0 || want.indexOf(have) >= 0) return true; return want.split(" ").some(function (w) { return w.length > 2 && have.indexOf(w) >= 0; }); }
function lrGet(track, artist, album, dur) {
  var u = "https://lrclib.net/api/get?track_name=" + encodeURIComponent(track) + "&artist_name=" + encodeURIComponent(artist);
  if (album) u += "&album_name=" + encodeURIComponent(album);
  if (dur) u += "&duration=" + dur;
  return _origFetch(u).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
}
function lrSearch(track, artist) {
  return _origFetch("https://lrclib.net/api/search?track_name=" + encodeURIComponent(track) + "&artist_name=" + encodeURIComponent(artist))
    .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
}
function lrclibFetch(track) {
  var dur = Math.round((track.durationMs || 0) / 1000);
  var ct = cleanTitle(track.name), ca = cleanArtist(track.artist);
  var ok = function (h) { return h && h.syncedLyrics; };
  return lrGet(track.name, track.artist, track.album, dur).then(function (h) {
    if (ok(h)) return h;
    return lrGet(ct, ca, track.album, dur).then(function (h2) {
      if (ok(h2)) return h2;
      // Search, but VALIDATE the pick by duration + title - never a blind res[0]
      // (that loose fallback is what tied lyrics to the wrong song).
      return lrSearch(ct, ca).then(function (res) {
        if (!res || !res.length) return null;
        var v = res.filter(function (x) { return x.syncedLyrics && (!dur || Math.abs((x.duration || 0) - dur) <= 4) && titleMatch(track.name, x.trackName); });
        return v[0] || null;
      });
    });
  }).catch(function () { return null; });
}

function buildSLLyrics(ll, durationMs) {
  if (!ll) return null;
  if (ll.syncedLyrics) { var content = parseLRC(ll.syncedLyrics, durationMs); if (content.length) return { Type: "Line", StartTime: content[0].StartTime, Content: content, classes: "", styles: {}, source: "spl" }; }
  if (ll.plainLyrics) return { Type: "Static", StartTime: 0, Lines: ll.plainLyrics.split(/\r?\n/).map(function (t) { return { Text: t }; }) };
  return null;
}

// --- NetEase Cloud Music public API: word-by-word (yrc) -> SL Syllable mode ---
var NE_HDR = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Referer: "https://music.163.com" };
// Return ALL plausible NCM ids for a track, ranked best-first: title+artist+duration
// matches before title+duration-only. Returning several (not one) matters because
// different NetEase releases of the same song differ - one pressing may carry
// word-by-word yrc while the top result only has line-level lrc, so the resolver
// scans candidates and prefers whichever has word-by-word.
function neteaseSearchIds(track) {
  var q = (track.name || "") + " " + (track.artist || "");
  return _origFetch("https://music.163.com/api/search/get?type=1&limit=10&s=" + encodeURIComponent(q), { headers: NE_HDR })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      var songs = j && j.result && j.result.songs; if (!songs || !songs.length) return [];
      var durS = Math.round((track.durationMs || 0) / 1000);
      var strong = [], weak = []; // strong = title+artist+duration; weak = title+duration only
      for (var i = 0; i < songs.length; i++) {
        var s = songs[i];
        if (durS && Math.abs(Math.round((s.duration || 0) / 1000) - durS) > 3) continue;
        if (!titleMatch(track.name, s.name)) continue;
        var sArtists = (s.artists || []).map(function (a) { return a.name; }).join(" ");
        (artistMatch(track.artist, sArtists) ? strong : weak).push(s.id);
      }
      return strong.concat(weak);
    }).catch(function () { return []; });
}
// first candidate only (used by the neMatch debug hook)
function neteaseSearch(track) { return neteaseSearchIds(track).then(function (ids) { return ids[0] || null; }); }
// the live Spotify id our ISRC bridge mapped onto the current track (for spotify-lyrics)
function currentSpotifyId() { try { var m = /^spotify:track:([A-Za-z0-9]+)/.exec((cur && cur.uri) || ""); return m ? m[1] : null; } catch (e) { return null; } }
function neteaseLyric(id) {
  return _origFetch("https://music.163.com/api/song/lyric/v1?id=" + id + "&lv=-1&kv=-1&tv=-1&yv=-1&cp=false", { headers: NE_HDR })
    .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
}

// --- AMLL TTML DB: CC0 public-domain, hand-authored lyrics (the same database the renderer's
// "community" lyrics came from) ---
// The DB cross-indexes each song under "ncm-lyrics/<NCM id>" and "spotify-lyrics/<22-char Spotify
// id>", so we can key it by either - and the Spotify id (from our ISRC bridge) sidesteps the
// ASCII-only NetEase title search. we fetch the canonical .ttml (word-by-word + duet agents + bg
// vocals; AMLL is dropping the .yrc/.lrc derivatives) and parse it, with .yrc as a fallback while it
// lasts. jsDelivr first (fast, cached, no token), raw GitHub as a fallback.
function dbFetchText(urls, i) {
  if (i >= urls.length) return Promise.resolve(null);
  return _origFetch(urls[i]).then(function (r) { return r.ok ? r.text() : null; })
    .then(function (t) { return t || dbFetchText(urls, i + 1); })
    .catch(function () { return dbFetchText(urls, i + 1); });
}
function amllDbLyrics(folder, id) {
  if (!id) return Promise.resolve(null);
  var base = "https://cdn.jsdelivr.net/gh/amll-dev/amll-ttml-db@main/" + folder + "/" + id;
  var raw = "https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/" + folder + "/" + id;
  return dbFetchText([base + ".ttml", raw + ".ttml"], 0).then(function (ttml) {
    var ly = ttml && parseTTML(ttml);
    if (ly) return ly;
    return dbFetchText([base + ".yrc", raw + ".yrc"], 0).then(function (yrc) {
      return (yrc && /^\[\d+,\d+\]/m.test(yrc)) ? buildSyllable(yrc) : null;
    });
  });
}

// --- Apple Music: the best source - hand-timed syllable TTML with real duet agents, the format
// AMLL emulates ---
// Keyed by ISRC (exact). It needs the user's own developer + media-user tokens (AP), and a
// main-process header rewrite supplies the Origin amp-api wants (the renderer can't set it).
// ISRC -> catalog search -> song id -> syllable-lyrics TTML -> parseTTML.
function appleHeaders() { return { Authorization: "Bearer " + AP.developer_token, "Music-User-Token": AP.media_user_token }; }
function appleTTMLById(sf, H, id) {
  return _origFetch("https://amp-api.music.apple.com/v1/catalog/" + sf + "/songs/" + id + "/syllable-lyrics", { headers: H })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j2) { var t = j2 && j2.data && j2.data[0] && j2.data[0].attributes && j2.data[0].attributes.ttml; return t ? parseTTML(t) : null; });
}
function appleLyrics(isrc) {
  if (!AP || !AP.developer_token || !AP.media_user_token || !isrc) return Promise.resolve(null);
  var sf = AP.storefront || "us", H = appleHeaders();
  return _origFetch("https://amp-api.music.apple.com/v1/catalog/" + sf + "/songs?filter[isrc]=" + encodeURIComponent(isrc), { headers: H })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { var id = j && j.data && j.data[0] && j.data[0].id; return id ? appleTTMLById(sf, H, id) : null; })
    .catch(function () { return null; });
}
// Apple by NAME+ARTIST: fallback when the track's ISRC isn't in Apple's catalog (common for
// remasters/re-releases whose ISRC differs from Apple's copy - e.g. Pink Floyd "Money"). Lyrics
// are identical recording-to-recording, so any same-song+artist Apple match yields clean syllable
// TTML (fixes NetEase's rough word spacing). Require BOTH title and artist to match (so a same-
// titled different song can't win); prefer the closest duration.
function appleSearchLyrics(track) {
  if (!AP || !AP.developer_token || !AP.media_user_token || !track || !track.name) return Promise.resolve(null);
  var sf = AP.storefront || "us", H = appleHeaders();
  var term = encodeURIComponent(((track.name || "") + " " + (track.artist || "")).trim());
  return _origFetch("https://amp-api.music.apple.com/v1/catalog/" + sf + "/search?types=songs&limit=12&term=" + term, { headers: H })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      var songs = (j && j.results && j.results.songs && j.results.songs.data) || [];
      var cand = songs.map(function (s) {
        var a = s.attributes || {};
        var dd = (track.durationMs && a.durationInMillis) ? Math.abs(a.durationInMillis - track.durationMs) : 1e9;
        return { id: s.id, ok: titleMatch(track.name, a.name || "") && artistMatch(track.artist || "", a.artistName || ""), dd: dd };
      }).filter(function (c) { return c.ok; }).sort(function (x, y) { return x.dd - y.dd; });
      return cand.length ? appleTTMLById(sf, H, cand[0].id) : null;
    }).catch(function () { return null; });
}
// yrc line: [startMs,durMs](wMs,wDurMs,0)word (wMs,wDurMs,0)word ...
// The token text keeps its trailing space (the regex captures up to the next "(").
// Forward word-break marker (matches the bundle + Apple's collectTTMLSyl): IsPartOfWord=true means
// "this syllable joins the next one" (no space after it). We work out newWord per token (does this
// token start a new word) and then set the previous token's IsPartOfWord = !newWord. It was written
// backward (space-before) before - fine for all-separate words, but it broke joins: NetEase splits
// "We're" into "We" + "'" + "re", which backward-rendered as "We 'renot". Same with melisma bits ("h"+"ead").
function parseYRC(yrc) {
  var lines = [];
  (yrc || "").split(/\r?\n/).forEach(function (raw) {
    var m = raw.match(/^\[(\d+),(\d+)\]/); if (!m) return;
    var lineStart = parseInt(m[1], 10), lineDur = parseInt(m[2], 10);
    var syl = [], re = /\((\d+),(\d+),\d+\)([^(\n]*)/g, w, prevEndedSpace = true;
    while ((w = re.exec(raw))) {
      var rawText = w[3], text = rawText.replace(/^\s+|\s+$/g, "");
      if (text === "") { prevEndedSpace = true; continue; } // a space-only token = word boundary
      var st = parseInt(w[1], 10), en = st + parseInt(w[2], 10);
      // Sentence/closing punctuation (, . : ; ! ? ...) is emitted as its OWN timed
      // token; the renderer then groups it as a separate "word", leaving a stray space
      // ("mind :", "me ,"). Merge it onto the previous syllable so it hugs the word,
      // and treat what follows as a fresh word (such punctuation is followed by space).
      if (syl.length && /^[.,;:!?…)\]。、，；：！？]+$/.test(text)) {
        var p = syl[syl.length - 1];
        p.Text += text; p.EndTime = en;
        prevEndedSpace = true;
        continue;
      }
      // A token that LEADS with closing punctuation (",in") hugs the punctuation onto the
      // previous word, then the remainder is a fresh word ("ead," + " in" -> "head, in").
      if (syl.length) { var lp = text.match(/^([.,;:!?…)\]，。、；：！？]+)([\s\S]+)$/); if (lp) { syl[syl.length - 1].Text += lp[1]; text = lp[2].replace(/^\s+/, ""); prevEndedSpace = true; } }
      // NetEase yrc spacing is unreliable: some words jam (no trailing space -> "don'tknow",
      // "thatass") while OTHER words are split into syllables for melisma timing ("h"+"ead",
      // "mistak"+"es"). We can't dictionary-check, but the tell is length: two adjacent
      // no-space tokens are separate words only if BOTH are >=3 chars - melisma fragments are
      // short ("h","es","ed"), real words ("know","that","baby") aren't. yrc-spaced tokens and
      // closing punctuation are already word-ends via prevEndedSpace.
      var prevWord = syl.length ? syl[syl.length - 1].Text : "";
      var bothWords = prevWord.length >= 3 && text.length >= 3 && /[A-Za-z]$/.test(prevWord) && /^[A-Za-z]/.test(text);
      // Contractions: NetEase splits "We're" into "We" + "'" + "re" (apostrophe is its OWN token), or
      // "Don't" into "Don " + "'t". A LONE apostrophe must join both sides ("We'"+"re"); an ENCLITIC
      // ('t 's 're 've 'll 'd 'm as one token) hugs the previous word and lets what follows be fresh.
      // ('em / 'cause / 'til stay standalone: not matched.)
      var isLoneApos = /^['’]$/.test(text);
      var isEnclitic = syl.length > 0 && /^['’](t|s|re|ve|ll|d|m)$/i.test(text);
      // Two more NetEase jamming tells: a lowercase->Capital seam means two words got jammed
      // ("AndI"->"And I", "n*ggaMax"->"n*gga Max"). (A token ending in an apostrophe is handled below
      // as a word-end: g-drop "runnin'", possessive "dogs'".)
      var camelSeam = /[a-z]$/.test(prevWord) && /^[A-Z]/.test(text);
      // Censored words: NetEase emits each "*" as its own space-terminated token ("* * * * ed") plus a
      // short suffix after the run. Cluster consecutive asterisks + a <=3-char lowercase suffix into ONE
      // word so "****ed" renders together, not "* * * * ed" (a real word after the run keeps its space).
      var isStar = /^\*+$/.test(text), prevIsStar = /^\*+$/.test(prevWord);
      var starCluster = (isStar && prevIsStar) || (prevIsStar && /^[a-z]{1,3}$/.test(text));
      var newWord = (isLoneApos || isEnclitic || starCluster) ? false : (prevEndedSpace || /^\s/.test(rawText) || bothWords || camelSeam);
      syl.push({ Text: text, StartTime: st, EndTime: en, IsPartOfWord: false });
      if (syl.length >= 2) syl[syl.length - 2].IsPartOfWord = !newWord; // FORWARD: prev joins this token iff this isn't a new word
      prevEndedSpace = isLoneApos ? false : (isEnclitic ? true : /[\s,.;:!?…)\]，。、；：！？'’]$/.test(rawText));
    }
    if (syl.length) lines.push({ Type: "Vocal", OppositeAligned: false, Lead: { StartTime: lineStart, EndTime: lineStart + lineDur, Syllables: syl } });
  });
  return lines;
}
// Reconstruct a line's display text from its syllables (respecting word breaks).
function lineText(line) {
  var syl = (line.Lead && line.Lead.Syllables) || [];
  return syl.map(function (s) { return s.Text + (s.IsPartOfWord ? "" : " "); }).join("");
}
// Duet/section alignment: many lyrics mark who sings with a standalone label line
// ("Machine Gun Kelly:", "Blackbear:"). Assign each singer an alternating side (1st
// left, 2nd right, ...) so a two-part song reads like a back-and-forth. The bundle
// right-aligns lines flagged OppositeAligned (and adds .HasDuetLines). Only engages
// when there are >=2 distinct singers, so a lone stray "X:" line can't skew a solo.
var DUET_LABEL = /^[A-Za-z][A-Za-z0-9 .'&!-]{0,28}:$/;
function applyDuetAlignment(lines) {
  var singers = {}, order = 0, curAlign = false;
  for (var i = 0; i < lines.length; i++) {
    var t = lineText(lines[i]).replace(/\s+/g, " ").trim();
    if (t && DUET_LABEL.test(t) && t.split(" ").length <= 5) {
      var name = t.slice(0, -1).trim().toLowerCase();
      if (singers[name] === undefined) { singers[name] = (order % 2 === 1); order++; }
      curAlign = singers[name];
    }
    lines[i].OppositeAligned = curAlign;
  }
  if (Object.keys(singers).length < 2) lines.forEach(function (l) { l.OppositeAligned = false; });
  return lines;
}
function buildSyllable(yrc) {
  var content = parseYRC(yrc); if (!content.length) return null;
  content.forEach(splitBackgroundVocals);
  applyDuetAlignment(content);
  return { Type: "Syllable", StartTime: content[0].Lead.StartTime, Content: content, classes: "", styles: {}, source: "spl" };
}
// NetEase yrc puts backing-vocal echoes inline in parentheses ("...obsessed (Obsessed)").
// Move any parenthesized run into line.Background so the bundle renders it as the smaller
// offset sub-text (same shape parseTTML builds for Apple x-bg vocals). Parens are stripped.
function splitBackgroundVocals(line) {
  var syl = line.Lead && line.Lead.Syllables; if (!syl || syl.length < 2) return;
  var lead = [], bg = [], depth = 0;
  for (var i = 0; i < syl.length; i++) {
    var s = syl[i], opens = (s.Text.match(/[(（]/g) || []).length, closes = (s.Text.match(/[)）]/g) || []).length; // include NetEase fullwidth parens （ ）
    if (depth > 0 || opens > 0) { bg.push(s); depth = Math.max(0, depth + opens - closes); }
    else lead.push(s);
  }
  if (!bg.length || !lead.length) return; // need both a real main line AND a parenthesized echo
  bg = stripBgParens(bg); if (!bg.length) return;
  lead[lead.length - 1].IsPartOfWord = false;
  bg[bg.length - 1].IsPartOfWord = false;
  line.Lead.Syllables = lead;
  line.Lead.EndTime = lead[lead.length - 1].EndTime;
  line.Background = [{ StartTime: bg[0].StartTime, EndTime: bg[bg.length - 1].EndTime, Syllables: bg }];
}
// Strip the wrapping parens Apple/NetEase put around backing-vocal echoes so the sub-line reads
// "Fine, fine, fine" not "(Fine, fine, fine)": trim a leading "(" off the first syllable and a
// trailing ")" off the last, then drop any syllable left empty (the survivors keep the run timing).
function stripBgParens(bg) {
  if (!bg || !bg.length) return bg;
  // strip ALL parens (ASCII + fullwidth) from every syllable, so a multi-echo line like
  // "(Kiss), (Dub)" reads "Kiss, Dub" not "Kiss ）, （ Dub" (only outer-stripping left the middle ones)
  for (var i = 0; i < bg.length; i++) bg[i].Text = bg[i].Text.replace(/[\(（\)）]/g, "");
  bg[0].Text = bg[0].Text.replace(/^\s+/, "");
  bg[bg.length - 1].Text = bg[bg.length - 1].Text.replace(/\s+$/, "");
  var out = bg.filter(function (s) { return s.Text.replace(/^\s+|\s+$/g, "") !== ""; });
  return out.length ? out : bg;
}
// A line that is ENTIRELY a parenthesized echo ("( And I need you )") has no lead OUTSIDE the parens,
// so splitBackgroundVocals can't split it into lead+bg - just strip the wrapping parens so it doesn't
// render "( ... )". (Kept in the main line; it's already a standalone echo line.)
function stripWrapParens(line) {
  var syl = line.Lead && line.Lead.Syllables; if (!syl || !syl.length) return;
  var joined = syl.map(function (s) { return s.Text; }).join("").trim();
  if (/^[\(（][\s\S]*[\)）]$/.test(joined)) line.Lead.Syllables = stripBgParens(syl);
}

// --- TTML (Apple Music / AMLL canonical) -> SL Syllable ---
// Word-by-word from <span begin end>, duet sides from ttm:agent (v1/v2), background vocals from
// ttm:role="x-bg". AMLL is dropping the .yrc/.lrc derivatives, so .ttml is the source of truth - and
// it's the same format Apple Music serves, so this one parser covers both. Parsed with the
// renderer's DOMParser.
function ttmlTime(s) {
  if (s == null) return 0; s = ("" + s).trim(); if (!s) return 0;
  if (/s$/i.test(s)) return Math.round(parseFloat(s) * 1000); // "12.3s"
  var p = s.split(":"), sec = 0;
  for (var i = 0; i < p.length; i++) sec = sec * 60 + (parseFloat(p[i]) || 0);
  return Math.round(sec * 1000);
}
function ttmlAttr(el, name) { return el.getAttribute(name) || el.getAttribute("ttm:" + name) || el.getAttributeNS("http://www.w3.org/ns/ttml#metadata", name) || ""; }
// Collect word syllables of a <p> (or an x-bg group) into `out`; nested x-bg -> `bgOut`.
// IsPartOfWord is a FORWARD marker for the bundle: true = "this syllable joins the
// NEXT (same word)". A syllable is part-of-word UNLESS a space follows it (a whitespace
// text node, a leading space on the next span, or its own trailing space); the last
// syllable of a line ends its word (set in parseTTML). A BACKWARD marker shifts every
// word break by one on true syllable-split lyrics like Apple's ("grooving" -> "groo
// vingup").
function collectTTMLSyl(container, out, bgOut) {
  var nodes = container.childNodes;
  var endPrev = function () { if (out.length) out[out.length - 1].IsPartOfWord = false; };
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (n.nodeType === 3) { if (/\s/.test(n.nodeValue || "")) endPrev(); continue; }
    if (n.nodeType !== 1) continue;
    var role = ttmlAttr(n, "role");
    if (role === "x-bg") { if (bgOut) collectTTMLSyl(n, bgOut, null); endPrev(); continue; }
    if (role === "x-translation" || role === "x-roman") continue;
    if (n.getElementsByTagName("span").length) { collectTTMLSyl(n, out, bgOut); continue; } // nested syllables
    var st = ttmlTime(n.getAttribute("begin")), en = ttmlTime(n.getAttribute("end"));
    var raw = n.textContent || "";
    if (/^\s/.test(raw)) endPrev(); // a space before this span ends the previous word
    var text = raw.replace(/^\s+/, "").replace(/\s+$/, "");
    if (!text) { endPrev(); continue; }
    if (out.length && /^[.,;:!?…)\]。、，；：！？]+$/.test(text)) { out[out.length - 1].Text += text; out[out.length - 1].EndTime = en; out[out.length - 1].IsPartOfWord = false; continue; }
    out.push({ Text: text, StartTime: st, EndTime: en, IsPartOfWord: !/\s$/.test(raw) });
  }
}
function parseTTML(xml) {
  if (!xml || xml.indexOf("<tt") === -1) return null;
  var doc; try { doc = new DOMParser().parseFromString(xml, "application/xml"); } catch (e) { return null; }
  if (!doc || doc.getElementsByTagName("parsererror").length) return null;
  var ps = doc.getElementsByTagName("p"); if (!ps.length) return null;
  var agentIdx = {}, agentN = 0, lines = [];
  for (var i = 0; i < ps.length; i++) {
    var p = ps[i], agent = ttmlAttr(p, "agent");
    if (agent && agentIdx[agent] === undefined) agentIdx[agent] = agentN++;
    var lead = [], bg = [];
    collectTTMLSyl(p, lead, bg);
    if (!lead.length) continue;
    lead[lead.length - 1].IsPartOfWord = false; // last syllable always ends its word
    if (bg.length) bg = stripBgParens(bg); // Apple x-bg echoes come wrapped in parens - strip them
    if (bg.length) bg[bg.length - 1].IsPartOfWord = false;
    var ls = ttmlTime(p.getAttribute("begin")) || lead[0].StartTime, le = ttmlTime(p.getAttribute("end")) || lead[lead.length - 1].EndTime;
    var line = { Type: "Vocal", OppositeAligned: (agentIdx[agent] || 0) % 2 === 1, Lead: { StartTime: ls, EndTime: le, Syllables: lead } };
    if (bg.length) line.Background = [{ StartTime: bg[0].StartTime, EndTime: bg[bg.length - 1].EndTime, Syllables: bg }];
    lines.push(line);
  }
  if (!lines.length) return null;
  if (agentN < 2) lines.forEach(function (l) { l.OppositeAligned = false; }); // not a duet
  return { Type: "Syllable", StartTime: lines[0].Lead.StartTime, Content: lines, classes: "", styles: {}, source: "spl" };
}

// Our parsers produce times in MS, but SL's applyer runs ConvertTime (x1000) on
// them, i.e. it expects SECONDS. Convert every StartTime/EndTime ms -> s so the
// animator's ms position matches; without this, lines time out hours in the future
// and the active line/glow never advance (render works, sync doesn't).
function toSeconds(ly) {
  function div(o) {
    if (!o || typeof o !== "object") return;
    if (typeof o.StartTime === "number") o.StartTime = o.StartTime / 1000;
    if (typeof o.EndTime === "number") o.EndTime = o.EndTime / 1000;
    if (o.Lead) div(o.Lead);
    ["Content", "Syllables", "Background"].forEach(function (k) { if (Array.isArray(o[k])) o[k].forEach(div); });
  }
  div(ly);
  return ly;
}

// Cache a track's resolved lyrics so repeated fetches (SL re-queries on re-render /
// track re-selection) return the SAME result instead of flickering between lyrics
// and "no lyrics" when a source answers inconsistently. Only successes are cached,
// so a track with no hit can still be retried later.
// Persistent, versioned lyric cache (localStorage): a resolved song loads INSTANTLY on repeat and
// survives reloads/relaunches - no re-fetch every play. Bump CACHE_VER whenever parsing changes
// (spacing/parens/credits/timing) so stale pre-fix lyrics are dropped instead of served forever.
var CACHE_VER = 6; // bumped 2026-07-03: fullwidth-paren bg-vocal split + asterisk-censor clustering + strip-all-parens on multi-echo bg (mirrors server PARSE_VER 5)
var LS_KEY = "qz-lyr-cache";
var lsCache = {};
try { var _raw = JSON.parse(localStorage.getItem(LS_KEY) || "{}"); if (_raw && _raw.ver === CACHE_VER) lsCache = _raw.songs || {}; } catch (e) {}
function lyrKey(track) { return ((track && track.name) || "") + "|" + ((track && track.artist) || ""); }
function saveCache() {
  try {
    var ks = Object.keys(lsCache);
    if (ks.length > 120) { ks.sort(function (a, b) { return (lsCache[a].t || 0) - (lsCache[b].t || 0); }); for (var i = 0; i < ks.length - 120; i++) delete lsCache[ks[i]]; }
    localStorage.setItem(LS_KEY, JSON.stringify({ ver: CACHE_VER, songs: lsCache }));
  } catch (e) { // quota blown - halve and retry once
    try { var k2 = Object.keys(lsCache).sort(function (a, b) { return (lsCache[a].t || 0) - (lsCache[b].t || 0); }); for (var j = 0; j < Math.ceil(k2.length / 2); j++) delete lsCache[k2[j]]; localStorage.setItem(LS_KEY, JSON.stringify({ ver: CACHE_VER, songs: lsCache })); } catch (_) {}
  }
}
// --- Cloudflare proxy (api.qobuzify.app): shared D1 cache + server-side Apple/AMLL/LRCLIB
// resolution. it's tried before the local resolver, so a warm (edge-cached) track loads in one fast
// round-trip with no client-side parsing at all. on a proxy miss / no-lyrics / failure we fall back
// to the full local resolver, which still has NetEase from the home IP (the proxy can't reach it
// from CF egress). server output is byte-identical (same parse chain), already toSeconds'd + credited.
var PROXY_BASE = "https://api.qobuzify.app/v1/lyrics";
var USE_PROXY = true; // __QZ_SL_DEBUG.setProxy(false) to force local-only for testing
function proxyLyrics(track) {
  if (!USE_PROXY || !track || !track.name || !track.artist) return Promise.resolve(null);
  try {
    var u = PROXY_BASE + "?name=" + encodeURIComponent(track.name) + "&artist=" + encodeURIComponent(track.artist);
    if (track.album) u += "&album=" + encodeURIComponent(track.album);
    if (track.durationMs) u += "&durationMs=" + track.durationMs;
    var isrc = (curMeta && curMeta.isrc) || track.isrc; if (isrc) u += "&isrc=" + encodeURIComponent(isrc);
    var spid = currentSpotifyId(); if (spid) u += "&spotifyId=" + encodeURIComponent(spid);
    return withTimeout(_origFetch(u).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }), 8000);
  } catch (e) { return Promise.resolve(null); }
}
// Proxy + hedged local resolve. the proxy fires first; if it comes back with lyrics fast (warm edge
// / Apple) we're done with no local work. if the proxy is slow (>HEDGE_MS), or returns no-lyrics /
// errors, we run the full local resolver in parallel and take whichever returns lyrics first. only a
// non-null result wins early - a null waits for the other side - so a slow proxy never blocks and we
// never serialise proxy-timeout then local (the old 10s worst case). local still has NetEase on the
// home IP for tracks CF can't reach.
// the proxy (api.qobuzify.app) is the only lyric source the client touches, so which upstream
// actually served the lyrics (Apple/AMLL/NetEase/LRCLIB) never shows up in the network tab - the
// proxy hands back only the codename. LOCAL_FALLBACK would let the client resolve directly on a proxy
// miss, but that makes the direct upstream requests visible, so it's off by default.
var LOCAL_FALLBACK = false;
function lyrSpanSec(ly) { if (!ly || !ly.Content || !ly.Content.length) return 0; var l = ly.Content[ly.Content.length - 1]; return (l.Lead ? l.Lead.EndTime : l.EndTime) || 0; }
function resolveLyrics(track) {
  var key = lyrKey(track), hit = lsCache[key];
  // self-heal a stale wrong-song cache entry: if the cached lyrics run well past this track's end
  // (>10s over), they belong to a different (longer) same-title song - drop them and re-resolve from
  // the proxy (mirrors the server's durationOk). this is what fixed Selena's "Wolves" (193s) cached
  // under Baby Keem's "Wolves" (83s) from before the client started sending duration.
  if (hit && hit.ly && track.durationMs && lyrSpanSec(hit.ly) * 1000 > track.durationMs + 10000) { delete lsCache[key]; saveCache(); hit = null; }
  if (hit && hit.ly) { hit.t = Date.now(); if (hit.src) curLyricSource = hit.src; return Promise.resolve(hit.ly); }
  function local() { return resolveLyricsRaw(track).then(function (ly) { if (ly) { lsCache[key] = { ly: ly, src: curLyricSource, t: Date.now() }; saveCache(); } return ly; }); }
  return proxyLyrics(track).then(function (pr) {
    if (pr && pr.ok && pr.hasLyrics && pr.lyrics) {
      curLyricSource = pr.source || curLyricSource; // codename from the proxy (never the raw source)
      // persist only high-confidence lyrics (the proxy sets pr.cacheable for Apple/Qz or word-by-word).
      // line-level LRCLIB/NetEase results get shown but not cached, so they stay re-resolvable (and can
      // upgrade to Qz/Apple on a later play) instead of getting locked into the local cache.
      if (pr.cacheable) { lsCache[key] = { ly: pr.lyrics, src: curLyricSource, t: Date.now() }; saveCache(); }
      return pr.lyrics;
    }
    return LOCAL_FALLBACK ? local() : null;
  }).catch(function () { return LOCAL_FALLBACK ? local() : null; });
}

// ---- Prefetch: warm the NEXT queued track's lyrics in the background so they're already cached
// (instant) when it starts. Read the next play-queue item's trackId -> Qobuz track API for its
// metadata (incl. ISRC -> exact Apple match) -> warm the proxy (populates D1 + our local cache).
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
      var meta = { name: tr.title, artist: artist, album: (tr.album && tr.album.title) || "", durationMs: (tr.duration || 0) * 1000, isrc: tr.isrc || null };
      var key = lyrKey(meta);
      if (key === _prefetchedKey || (lsCache[key] && lsCache[key].ly)) return; // already prefetched / cached
      _prefetchedKey = key;
      var u = PROXY_BASE + "?name=" + encodeURIComponent(meta.name) + "&artist=" + encodeURIComponent(meta.artist);
      if (meta.album) u += "&album=" + encodeURIComponent(meta.album);
      if (meta.durationMs) u += "&durationMs=" + meta.durationMs;
      if (meta.isrc) u += "&isrc=" + encodeURIComponent(meta.isrc);
      _origFetch(u).then(function (r) { return r.ok ? r.json() : null; }).then(function (pr) {
        if (pr && pr.ok && pr.hasLyrics && pr.lyrics && pr.cacheable) { lsCache[key] = { ly: pr.lyrics, src: pr.source || "apple", t: Date.now() }; saveCache(); }
      }).catch(function () {});
    }).catch(function () {});
  } catch (e) {}
}
// Race a promise against a timeout so one slow source can't stall the whole resolve
// (NetEase's API in particular can hang for tens of seconds).
function withTimeout(p, ms) { return Promise.race([Promise.resolve(p), new Promise(function (r) { setTimeout(function () { r(null); }, ms); })]); }

// resolve, word-by-word preferred, sources fired in PARALLEL so a song loads fast:
//   1) AMLL TTML DB (CC0) - Spotify id + every NCM candidate at once; best key wins
//   2) else NetEase lyrics for all candidates at once - prefer yrc, then lrc
//   3) else LRCLIB (line/plain)
// (Was sequential before: 5 DB tries + 4 NetEase fetches back-to-back = 10-40s/song.)
function resolveOpen(track) { // open sources (AMLL DB + NetEase + LRCLIB); Apple is tried before this
  var spid = currentSpotifyId();
  return withTimeout(neteaseSearchIds(track), 7000).then(function (allIds) {
    var ids = (allIds || []).slice(0, 3);
    var dbJobs = [];
    if (spid) dbJobs.push(withTimeout(amllDbLyrics("spotify-lyrics", spid), 6000).then(function (ly) { return { pri: 0, ly: ly }; }));
    ids.forEach(function (id, i) { dbJobs.push(withTimeout(amllDbLyrics("ncm-lyrics", id), 6000).then(function (ly) { return { pri: 1 + i, ly: ly }; })); });
    return Promise.all(dbJobs).then(function (rs) {
      var hit = rs.filter(function (r) { return r.ly; }).sort(function (a, b) { return a.pri - b.pri; })[0];
      if (hit) { curLyricSource = "amll"; return hit.ly; }
      if (!ids.length) return null;
      return Promise.all(ids.map(function (id) { return withTimeout(neteaseLyric(id), 6000); })).then(function (js) {
        for (var i = 0; i < js.length; i++) { var j = js[i]; if (j && j.yrc && j.yrc.lyric) { var s = buildSyllable(j.yrc.lyric); if (s) { curLyricSource = "netease"; return s; } } }
        for (var k = 0; k < js.length; k++) { var j2 = js[k]; if (j2 && j2.lrc && j2.lrc.lyric) { var c = parseLRC(j2.lrc.lyric, track.durationMs); if (c.length) { curLyricSource = "netease"; return { Type: "Line", StartTime: c[0].StartTime, Content: c, classes: "", styles: {}, source: "spl" }; } } }
        return null;
      });
    });
  }).then(function (ly) {
    if (ly) return ly;
    return lrclibFetch(track).then(function (ll) { var r = buildSLLyrics(ll, track.durationMs); if (r) curLyricSource = "lrclib"; return r; });
  }).catch(function () { return lrclibFetch(track).then(function (ll) { var r = buildSLLyrics(ll, track.durationMs); if (r) curLyricSource = "lrclib"; return r; }).catch(function () { return null; }); });
}
// Apple Music TTML first (best quality + real duet agents), keyed by ISRC, otherwise the open
// sources. toSeconds runs once, on the winner (the parsers emit ms; SL wants seconds). the ISRC is
// fetched async in mapTrack, so if a lyric request beats it the isrc is null and we skip Apple (clean
// spacing/timing) for the rougher NetEase. we wait briefly so Apple wins for the tracks it has - it
// matters most on remasters and dialogue, where NetEase data is poor.
function waitForIsrc(ms) {
  return new Promise(function (res) {
    var t0 = Date.now();
    (function poll() {
      if (curMeta && curMeta.isrc) return res(curMeta.isrc);
      if (Date.now() - t0 > ms) return res(null);
      setTimeout(poll, 150);
    })();
  });
}
// NetEase returns a stub for instrumentals / missing lyrics ("纯音乐, 请欣赏", "暂无歌词",
// "no lyrics") - treat as no-lyrics so we don't render a Chinese placeholder.
function isLyricPlaceholder(ly) {
  if (!ly || !ly.Content || ly.Content.length > 4) return false;
  var txt = ly.Content.map(function (l) { return l.Text || ((l.Lead && l.Lead.Syllables) || []).map(function (s) { return s.Text; }).join(""); }).join(" ");
  return /纯音乐|純音樂|暂无歌词|暫無歌詞|no\s*lyric|instrumental/i.test(txt);
}
// NetEase yrc/lrc often prepend Chinese production-credit lines ("作词 : X", "作曲：Y",
// "混音/母带：Z", "词：A 曲：B") that aren't lyrics. Drop any line that is such a credit:
// a colon near the start whose label contains a known credit keyword - so a real lyric that
// merely has a colon ("他说：你好") is KEPT. Western/Apple/AMLL lines never match.
var CREDIT_KW = /(作词|作曲|编曲|改编|制作|出品|监制|混音|母带|和声|配唱|录音|演唱|制作人|文案|策划|统筹|发行|后期|吉他|贝斯|键盘|弦乐|鼓|词|曲)/;
var CREDIT_EN = /^(written|compos|arrang|produc|mix|master|record|lyric|music|vocal|piano|keyboard|synth|guitar|bass|drum|program|engineer|perform|publish|copyright)/i;
function isCreditLine(t) {
  t = (t || "").replace(/^\s+/, "");
  if (!t) return false;
  // NetEase metadata (the "Artist、Artist - Title" line and credit name-lists) uses the ideographic
  // comma "、" (U+3001) as a separator; 2+ of them marks a list/title, never a real lyric line.
  if ((t.match(/、/g) || []).length >= 2) return true;
  // "<label>:" credit line - a Chinese label carrying a credit keyword, OR an English credit label
  // ("Written by:", "Composed by:", "Piano:", "Programmer:", ...).
  var m = t.match(/^([^\n:：]{0,22})[:：]/);
  if (m) { var label = m[1]; if ((/[一-鿿]/.test(label) && CREDIT_KW.test(label)) || CREDIT_EN.test(label)) return true; }
  return false;
}
function lineDisplayText(l) { return l.Text != null ? l.Text : ((l.Lead && l.Lead.Syllables) || []).map(function (s) { return s.Text; }).join(""); }
function stripCredits(ly) {
  if (!ly || !ly.Content || ly.Content.length < 2) return ly;
  var kept = ly.Content.filter(function (l) { return !isCreditLine(lineDisplayText(l).replace(/^\s+/, "")); });
  if (kept.length && kept.length < ly.Content.length) {
    ly.Content = kept;
    var first = kept[0];
    ly.StartTime = (first.StartTime != null ? first.StartTime : (first.Lead && first.Lead.StartTime)) || ly.StartTime;
  }
  return ly;
}
function resolveLyricsRaw(track) {
  return waitForIsrc(1800).then(function (isrc) {
    return (isrc ? withTimeout(appleLyrics(isrc), 3500) : Promise.resolve(null))
      .then(function (apl) {
        if (apl) { curLyricSource = "apple"; return apl; }
        // ISRC missed Apple (e.g. a remaster) -> try Apple by name+artist before the rougher
        // open sources, since Apple's word boundaries are clean. Same song = same lyrics.
        return withTimeout(appleSearchLyrics(track), 3500).then(function (aps) {
          if (aps) { curLyricSource = "apple"; return aps; }
          return resolveOpen(track);
        }).catch(function () { return resolveOpen(track); });
      })
      .catch(function () { return resolveOpen(track); })
      .then(function (ly) {
        if (!ly || isLyricPlaceholder(ly)) return null;
        ly = stripCredits(ly);
        // parenthesized echoes -> Background sub-text for every source (Apple inline asides too, not
        // just NetEase's buildSyllable pass); a fully-parenthesized line just has its parens stripped.
        if (ly.Content) ly.Content.forEach(function (l) { if (!l.Background) splitBackgroundVocals(l); if (!l.Background) stripWrapParens(l); });
        return toSeconds(ly);
      });
  });
}
function markLyricsMode(type) {
  setTimeout(function () { var p = document.getElementById("QzLyricsPage"); if (p) p.classList.toggle("qz-line-mode", type !== "Syllable"); }, 250);
}

// SL's HideLoaderContainer() doesn't reliably strip the loader's .active class in
// our shimmed environment, so once we've supplied lyrics, clear it ourselves (the
// .active loader sits at z-index:9 over the fully-rendered .LyricsContent).
function clearLoaderSoon() {
  [400, 1000, 2000, 3400].forEach(function (ms) {
    setTimeout(function () { var l = document.querySelectorAll("#QzLyricsPage .loaderContainer"); for (var i = 0; i < l.length; i++) l[i].classList.remove("active", "queued"); }, ms);
  });
}
function installLyricsBridge() {
  // Always feed the UI from the open lyric sources (NetEase yrc / LRCLIB). We use the
  // licensed renderer only - never the gated third-party lyrics-data API.
  if (window.__QZ_SL_FETCH_PATCHED__) return;
  window.__QZ_SL_FETCH_PATCHED__ = true;
  window.fetch = function (input, init) {
    try {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      if (/api\.qzlyrics\.org\/query/.test(url)) {
        var op = null; try { var b = JSON.parse(init && init.body); op = b.queries && b.queries[0] && b.queries[0].operation; } catch (e) {}
        if (op === "lyrics") {
          // Read the LIVE track at fetch time (not the possibly-stale curMeta) so a
          // track-change race can't tie one song's lyrics to another.
          var qt = null; try { qt = Q.player.getTrack && Q.player.getTrack(); } catch (e) {}
          var track = (qt && qt.title) ? { name: qt.title, artist: qt.artist || "", album: qt.album || "", durationMs: qt.durationMs || 0 } : (curMeta || { name: cur && cur.name, artist: (cur && cur.artists && cur.artists[0] && cur.artists[0].name) || "", album: (cur && cur.metadata && cur.metadata.album_title) || "", durationMs: cur && cur.duration && cur.duration.milliseconds });
          return resolveLyrics(track).then(function (ly) {
            curLyrics = ly; // keep for our own glow animator
            var result = ly ? { data: slPack(ly), httpStatus: 200, format: "json" } : { data: null, httpStatus: 404, format: "json" };
            if (ly) { clearLoaderSoon(); markLyricsMode(ly.Type); startGlow(); }
            return new Response(JSON.stringify({ queries: [{ operation: "lyrics", operationId: "0", result: result }] }), { status: 200, headers: { "content-type": "application/json" } });
          });
        }
      }
    } catch (e) {}
    return _origFetch(input, init);
  };
}

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
function ensureCoverBg() {
  var c = document.getElementById("qz-sl-root"); if (!c || document.getElementById("qz-cbg")) return;
  var bg = document.createElement("div"); bg.id = "qz-cbg";
  bg.appendChild(document.createElement("div")).className = "qz-cbg-layer";
  bg.appendChild(document.createElement("div")).className = "qz-cbg-layer";
  c.insertBefore(bg, c.firstChild); // first child -> painted behind the lyrics
}
function setCoverBg(url) {
  if (!url || _cbgWant === url) return; // dedupe repeated/echoed songchange emits
  ensureCoverBg();
  var bg = document.getElementById("qz-cbg"); if (!bg) return;
  var layers = bg.getElementsByClassName("qz-cbg-layer"); if (layers.length < 2) return;
  _cbgWant = url;
  var img = new Image(); // preload so the crossfade reveals a loaded image
  img.onload = img.onerror = function () {
    if (_cbgWant !== url) return; // a newer song superseded this load (rapid skip)
    var front = layers[_cbgFront], back = layers[_cbgFront ^ 1];
    if (front.getAttribute("data-url") === url) return;
    back.style.backgroundImage = 'url("' + url + '")';
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
    // Heavier blur + far lower saturation than before: a 600px cover upscaled to fill a large window was
    // under-blurred (blocky, distinct smears) and saturate(1.7) made it garish ("cooked"). A ~38px-equivalent
    // blur turns any cover into a smooth ambient wash; saturate(1.15) keeps colour without frying it; a dark
    // gradient overlay (::after) tames bright blobs and guarantees text contrast.
    // downscaled blur (2026-07-03): the old full-viewport blur(38px) took ~316ms to re-raster on every alt-tab
    // (Chromium discards the occluded layer's backing store and re-blurs on restore = the profiled alt-tab lag).
    // so we render the blur on a 34%-size layer at blur(10px) and scale it ~3.9x to fill: 10px*3.9 ~= 38px visual
    // (identical wash - upscaling an already-blurred small raster is indistinguishable), but ~8x fewer pixels
    // to paint. the drift keyframes carry the fill-scale; translate stays -3%/-2% because scale*size cancels out.
    "#qz-cbg .qz-cbg-layer{position:absolute;inset:0;margin:auto;width:34%;height:34%;background-size:cover;background-position:center;filter:blur(10px) saturate(1.15) brightness(.72);opacity:0;transition:opacity 1.1s ease;will-change:opacity,transform;animation:qz-cbg-drift 42s ease-in-out infinite alternate;}" +
    "#qz-cbg .qz-cbg-layer.qz-on{opacity:1;}" +
    "#qz-cbg::after{content:'';position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,rgba(6,6,9,.34),rgba(6,6,9,.26) 42%,rgba(6,6,9,.62));}" +
    "@keyframes qz-cbg-drift{from{transform:scale(3.8) translate(0,0)}to{transform:scale(4.15) translate(-3%,-2%)}}" +
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
  Q.css("qz-sl-refocus", "#QzLyricsPage.qz-refocus .LyricsContainer .LyricsContent .line{transition:none!important;animation:none!important;}");
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
  ensureCoverBg();
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
try {
  window.addEventListener("focus", function () { qzSuppressFade(800); }, true);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) qzSuppressFade(800); }, true);
} catch (e) {}
function onRouteChange(loc) {
  var open = loc && loc.pathname === "/QzLyrics";
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

// --- our own karaoke glow animator (drives SL's --SLM_GradientPosition) ---
// SL's LyricsAnimator doesn't advance the per-word gradient fill in our shim, so we run it
// ourselves: map the rendered .word elements (document order) to the resolved yrc syllables (same
// order) and, each frame, set --SLM_GradientPosition per word from the live position against that
// word's StartTime/EndTime. SL's own gradient CSS does the rest, producing the real karaoke glow.
// Implemented against the actual DOM below.
var glowRAF = null, glowMap = null;
// The lyric-vs-audio offset depends on the SOURCE, not a Qobuz buffer (Qobuz plays audio
// natively with no clock to read - earlier "format/bitrate" theory was wrong). Apple Music
// and the AMLL TTML DB are professionally/tightly timed and match the audio at 0; community
// sources (NetEase / LRCLIB) can run late. resolveLyricsRaw tags curLyricSource and we shift
// per source. Apple is preferred + ISRC-exact, so the vast majority of tracks resolve to it
// and land at 0 - verified perfect live on a real Apple-sourced track. If ONE source ever
// drifts, tune that single entry below - never per-song, never a global. (__QZ_SL_DEBUG.
// setOffset pins a fixed value for dev testing only - never surfaced to users.)
var _offOverride = null;
try { var _o0 = parseInt(localStorage.getItem("qz-lyr-fixed"), 10); if (!isNaN(_o0)) _offOverride = _o0; } catch (e) {}
var curLyricSource = "apple";
var SOURCE_OFFSET = { apple: 0, amll: 0, netease: 0, lrclib: 0 }; // ms; positive = lyrics earlier
function autoOffsetMs() {
  if (_offOverride != null) return _offOverride;
  var v = SOURCE_OFFSET[curLyricSource];
  return v != null ? v : 0;
}
// Lyric-server codename shown in the footer next to "Provided by Qobuzify Lyrics" - a
// tier list of clever names for which source actually served the lyrics (Apple = top,
// down to the open line-level fallback). Qobuz listeners appreciate the bit.
var SOURCE_CODENAME = { apple: "Magnum Opus", amll: "Cum Laude", netease: "Vox Populi", lrclib: "Marginalia" };
function setLyricServerTag() {
  try {
    var want = "Lyric server: " + (SOURCE_CODENAME[curLyricSource] || curLyricSource || "Unknown");
    var tag = document.getElementById("qz-lyric-server");
    if (tag && tag.textContent === want) return; // already current
    var root = document.getElementById("qz-sl-root"); if (!root) return;
    var prov = null, all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) { if (!all[i].children.length && /Provided by/i.test(all[i].textContent || "")) { prov = all[i]; break; } }
    if (!prov) return;
    if (!tag) { tag = document.createElement("div"); tag.id = "qz-lyric-server"; tag.className = "qz-lyric-server"; prov.parentNode.insertBefore(tag, prov.nextSibling); }
    tag.innerHTML = "Lyric server: <b>" + (SOURCE_CODENAME[curLyricSource] || curLyricSource || "Unknown") + "</b>"; // codenames are a fixed map, safe
  } catch (e) {}
}
// Alt-tab scroll-jump fix. The lyrics live in a SimpleBar/virtualized scroller; when the
// window regains focus the bundle snaps scrollTop to 0 for a frame (flashing the top lines /
// source credits) before re-scrolling to the active line. We track the live scroll position
// and, for a short window after focus, snap any spurious jump toward 0 straight back - so the
// 0 never paints. Capture-phase listener catches the scroll before the bundle's own handlers.
var _seekScrollUntil = 0; // set by qobuzSeek; opens a brief guard window after a click-to-seek
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
(function installScrollGuard() {
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
  var _forceTopUntil = 0; // after a track change, actively pin the lyrics to the top for a moment (auto top-on-new-song)
  var _lastWork = 0, _rescueHiUntil = 0; // poll ~18Hz normally; full-rate briefly after refocus / new song
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
  document.addEventListener("scroll", function (e) {
    var w = e.target;
    if (!w || !w.classList || !w.classList.contains("simplebar-content-wrapper")) return;
    if (Date.now() < _seekScrollUntil && w.scrollTop < 140 && lastGood > 400) w.scrollTop = lastGood;
  }, true);
  // (2) alt-tab rebuild rescue (poll-based)
  function rescue() {
    var now = Date.now();
    var hi = now < _rescueHiUntil || now < _forceTopUntil; // full-rate during rebuild-catch / new-song-pin windows
    if (!hi && now - _lastWork < 55) { requestAnimationFrame(rescue); return; }
    _lastWork = now;
    // On a song change, forget the remembered position (+ drop the cached scroller so we re-find the rebuilt
    // one) so the rescue can't drag the NEW song back to the old scroll spot - the engine's own scroll-to-top
    // for the new track then wins (auto top-on-new-song).
    try {
      var tid = (Q.getState().player.currentTrack || {}).id;
      if (tid !== lastTrackId) { lastTrackId = tid; lastGood = 0; pending = null; _forceTopUntil = now + 2000; _cachedScroller = null; _lastPos = 0; }
      else { // same track: a big backward jump to the very start = restart / repeat -> re-pin to the top (a small seek-back does NOT, so scrubbing is unaffected)
        var pos = Q.player.getPositionMs() || 0;
        if (pos < 1500 && _lastPos > 4000) { _forceTopUntil = now + 1600; lastGood = 0; pending = null; }
        _lastPos = pos;
      }
    } catch (e) {}
    var s = scroller();
    if (s) {
      var st = rawTop(s), sh = s.scrollHeight;
      if (now < _forceTopUntil) {
        // NEW SONG: actively pin to the top until the engine takes over, so every track starts at line 1.
        if (st > 0) setTop(s, 0); lastGood = 0; pending = null;
      } else if (sh - s.clientHeight > 2) { // only rescue/track when the list is actually scrollable (skips work during the non-scrollable intro/first-line)
        if (st < 200 && lastGood > 500) { if (!pending || now > pending.until) pending = { target: lastGood, until: now + 900 }; }
        if (pending && now <= pending.until) {
          if (sh - s.clientHeight >= pending.target - 5) { if (Math.abs(rawTop(s) - pending.target) > 8) setTop(s, pending.target); else pending = null; }
        } else if (pending) { pending = null; lastGood = st; } // pending expired: accept where we ended (avoids re-trigger loop)
        else if (st > 50 && sh > 2000) lastGood = st; // track position while stable
      }
    }
    requestAnimationFrame(rescue);
  }
  requestAnimationFrame(rescue);
})();
// Smooth playback clock. Qobuz reports position in coarse ~250ms steps, so reading it raw
// makes the karaoke jump and the active line flip late. We anchor to Qobuz's position and
// extrapolate with wall-clock between its updates, re-syncing on each fresh value (never
// snapping backward on a late tick), then add the format-based offset.
var _clkPos = 0, _clkAt = 0, _clkRaw = -1;
function getPosMs() {
  if (window.__QZ_SL_DEBUG && window.__QZ_SL_DEBUG._pos != null) return window.__QZ_SL_DEBUG._pos;
  var raw = Q.player.getPositionMs() || 0, now = Date.now();
  if (!Q.player.isPlaying()) { _clkPos = raw; _clkAt = now; _clkRaw = raw; return raw + autoOffsetMs(); }
  if (raw !== _clkRaw) {
    _clkRaw = raw;
    var cur = _clkPos + (now - _clkAt);
    _clkPos = (raw < cur && cur - raw < 500) ? cur : raw; // don't snap backward on a late coarse tick
    _clkAt = now;
  }
  // Quantize to ~60Hz. On a high-refresh (144Hz) display the bundle re-reads this every frame and repaints
  // the karaoke word-fill 144x/s; holding the value in ~16ms buckets means the fill (and the styles it
  // writes) only CHANGE ~60x/s, so the browser skips the redundant repaints - roughly halves the paint the
  // lyrics view does. 60fps is smooth for text; line-active detection (seconds apart) is unaffected.
  return Math.round((_clkPos + (now - _clkAt) + autoOffsetMs()) / 16) * 16;
}
function stopGlow() { if (glowRAF) { try { cancelAnimationFrame(glowRAF); } catch (e) {} glowRAF = null; } glowMap = null; }
function startGlow() { /* wired to the real DOM after inspection */ }

// --- boot ---
var REACT_VER = "19.2.6";
var offBridge = null, tickIv = null, offPP = null, offBtn = null, tokenIv = null;
(async function boot() {
  try {
    if (!window.Spicetify || !window.Spicetify._qobuzify) {
      var React = await import("https://esm.sh/react@" + REACT_VER);
      var rdomClient = await import("https://esm.sh/react-dom@" + REACT_VER + "/client?deps=react@" + REACT_VER);
      var rdomMain = await import("https://esm.sh/react-dom@" + REACT_VER + "?deps=react@" + REACT_VER);
      var ReactJSX = await import("https://esm.sh/react@" + REACT_VER + "/jsx-runtime");
      var ReactDOMServer = await import("https://esm.sh/react-dom@" + REACT_VER + "/server.browser?deps=react@" + REACT_VER).catch(function () { return {}; });
      React = React.default || React;
      var rdom = Object.assign({}, rdomMain.default || rdomMain, rdomClient.default || rdomClient);
      ReactJSX = ReactJSX.default ? Object.assign({}, ReactJSX.default, ReactJSX) : ReactJSX;
      window.Spicetify = buildSpicetify(React, rdom, ReactJSX, ReactDOMServer.default || ReactDOMServer);
    }
    ensureContainer();
    await ensureFreshToken(); // renew the Spotify token (if logged in) before the bridge picks its path
    if (ST && ST.refresh_token) tokenIv = setInterval(ensureFreshToken, 1500000); // keep it alive (~25 min)
    installLyricsBridge(); // fresh user token -> SL's synced source natively; else open NetEase/LRCLIB

    // bridge: react to Qobuz track changes + progress + play/pause
    // Qobuz's onChange doesn't fire for every track change (notably in-album auto-advance),
    // which used to leave the cover background a full song behind, and black on a cold
    // relaunch. so we poll getTrack() (a cheap local read) and update on any change, deduped
    // by track id + cover. onChange stays on too, as an extra nudge.
    var _lastTrackKey = null;
    var handleTrack = function (qt) {
      var key = qt && qt.id ? qt.id + "|" + (qt.cover || "") : "";
      if (key === _lastTrackKey) return;
      _lastTrackKey = key;
      mapTrack(qt);
      schedulePrefetch(); // warm the next queued track's lyrics so it's instant when it starts
    };
    offBridge = Q.player.onChange(handleTrack);
    handleTrack(Q.player.getTrack());
    tickIv = setInterval(function () { handleTrack(Q.player.getTrack()); emit("onprogress", { data: Q.player.getPositionMs() }); setLyricServerTag(); }, 250);
    var lastPlaying = Q.player.isPlaying();
    offPP = Q.subscribe(function () { var p = Q.player.isPlaying(); if (p !== lastPlaying) { lastPlaying = p; emit("onplaypause", { data: { isPaused: !p } }); } });

    // run the licensed lyrics UI bundle once, loaded as a sibling <script> (the
    // 1.3MB bundle is too big to inline; it self-runs and reads window.Spicetify)
    if (!window.__QZ_SL_BUNDLE_RAN__) {
      window.__QZ_SL_BUNDLE_RAN__ = true;
      // the bundle's WebGL fluid background stalls in this shimmed env: the render loop freezes
      // (canvas stuck at 300x150), so the cover sticks on a previous song and the animation
      // stutters. any non-"off" mode stops it creating that WebGL canvas, so we force "color" (the
      // cheapest) and then paint our own blurred album-cover layer over it (ensureCoverBg /
      // setCoverBg), which reliably follows the song. we preset it before the bundle loads, since it
      // reads settings at module init.
      try {
        var SK = "qz:SL:settings";
        var cfg = JSON.parse(localStorage.getItem(SK) || "{}");
        cfg.staticBackgroundMode = "color";
        localStorage.setItem(SK, JSON.stringify(cfg));
      } catch (e) {}
      // the runtime served at "/" only exposes Qobuz's own assets, so load the
      // copied bundle by its absolute file:// path (derived from the app.html URL)
      var base = location.href.replace(/\/app\.html.*$/, "");
      var s = document.createElement("script");
      s.src = base + "/node_modules/@qobuz/qobuz-dwp-ui/dist/qobuzify-ext-qobuzify-lyrics.js";
      s.onerror = function () { try { console.error("[QobuzifyLyrics] failed to load bundle: " + s.src); } catch (_) {} };
      (document.head || document.documentElement).appendChild(s);
    }

    offBtn = ensureButton();

    // debug hook: render lyrics without live playback (audio output may be absent
    // in a headless/CDP session). Harmless in normal use; only does anything when called.
    window.__QZ_SL_DEBUG = {
      _pos: null,
      _forcePlaying: null,
      setPos: function (ms) { this._pos = ms; emit("onprogress", { data: ms }); },
      getOffset: function () { return { applied: autoOffsetMs(), source: curLyricSource, auto: _offOverride == null, fixed: _offOverride, sourceMap: SOURCE_OFFSET }; },
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
      neMatch: function (meta) { var tr = meta || curMeta; if (!tr) return Promise.resolve({ matched: false }); return neteaseSearch(tr).then(function (id) { if (!id) return { matched: false }; return _origFetch("https://music.163.com/api/song/detail?ids=%5B" + id + "%5D", { headers: NE_HDR }).then(function (r) { return r.json(); }).then(function (j) { var s = j && j.songs && j.songs[0]; return { matched: true, id: id, srcTitle: s ? s.name : "?", srcArtist: s ? (s.artists || []).map(function (a) { return a.name; }).join(", ") : "?", srcDurS: s ? Math.round(s.duration / 1000) : 0 }; }).catch(function () { return { matched: true, id: id }; }); }); },
      dbMatch: function (meta) {
        var tr = meta || curMeta; if (!tr) return Promise.resolve({ matched: false });
        var spid = currentSpotifyId();
        return neteaseSearchIds(tr).then(function (allIds) {
          var ids = allIds.slice(0, 3), jobs = [];
          var info = function (key, ly) { var n = 0, duet = false; if (ly && ly.Content) { ly.Content.forEach(function (l) { n += (l.Lead && l.Lead.Syllables && l.Lead.Syllables.length) || 0; if (l.OppositeAligned) duet = true; }); } return { key: key, inDb: !!ly, syllables: n, duet: duet }; };
          if (spid) jobs.push(amllDbLyrics("spotify-lyrics", spid).then(function (ly) { return info("spotify:" + spid, ly); }));
          ids.forEach(function (id) { jobs.push(amllDbLyrics("ncm-lyrics", id).then(function (ly) { return info("ncm:" + id, ly); })); });
          return Promise.all(jobs).then(function (rs) { return { candidates: ids, spotifyId: spid || null, db: rs, anyInDb: rs.some(function (r) { return r.inDb; }) }; });
        });
      },
      ttmlTest: function (folder, id) { return amllDbLyrics(folder || "ncm-lyrics", id).then(function (ly) {
        if (!ly || !ly.Content) return { ok: false };
        var syl = 0, bg = 0, sides = {}; ly.Content.forEach(function (l) { syl += (l.Lead && l.Lead.Syllables && l.Lead.Syllables.length) || 0; if (l.Background) bg++; sides[l.OppositeAligned ? "right" : "left"] = (sides[l.OppositeAligned ? "right" : "left"] || 0) + 1; });
        return { ok: true, type: ly.Type, lines: ly.Content.length, syllables: syl, bgLines: bg, duet: !!sides.right, sides: sides, firstStart: ly.StartTime };
      }); },
      appleTest: function (isrc) { return appleLyrics(isrc).then(function (ly) {
        if (!ly || !ly.Content) return { ok: false, hasCreds: !!(AP && AP.developer_token) };
        var syl = 0, sides = {};
        var wordsOf = function (l) { var s = (l.Lead && l.Lead.Syllables) || [], w = [], cur = ""; s.forEach(function (x) { cur += x.Text; if (!x.IsPartOfWord) { w.push(cur); cur = ""; } }); if (cur) w.push(cur); return w.map(function (t) { return t.replace(/[A-Za-z0-9]/g, "x"); }).join(" "); };
        ly.Content.forEach(function (l) { syl += (l.Lead && l.Lead.Syllables && l.Lead.Syllables.length) || 0; sides[l.OppositeAligned ? "right" : "left"] = (sides[l.OppositeAligned ? "right" : "left"] || 0) + 1; });
        var longest = ly.Content.slice().sort(function (a, b) { return ((b.Lead && b.Lead.Syllables || []).length) - ((a.Lead && a.Lead.Syllables || []).length); }).slice(0, 5);
        return { ok: true, lines: ly.Content.length, syllables: syl, duet: !!sides.right, sides: sides, firstStart: ly.StartTime, words: longest.map(wordsOf) };
      }); },
      appleSearchTest: function (name, artist, durationMs) { return appleSearchLyrics({ name: name, artist: artist, durationMs: durationMs || 0 }).then(function (ly) {
        if (!ly || !ly.Content) return { ok: false, hasCreds: !!(AP && AP.developer_token) };
        var syl = 0;
        var wordsOf = function (l) { var s = (l.Lead && l.Lead.Syllables) || [], w = [], cur = ""; s.forEach(function (x) { cur += x.Text; if (!x.IsPartOfWord) { w.push(cur); cur = ""; } }); if (cur) w.push(cur); return w.map(function (t) { return t.replace(/[A-Za-z0-9]/g, "x"); }).join(" "); };
        ly.Content.forEach(function (l) { syl += (l.Lead && l.Lead.Syllables && l.Lead.Syllables.length) || 0; });
        var longest = ly.Content.slice().sort(function (a, b) { return ((b.Lead && b.Lead.Syllables || []).length) - ((a.Lead && a.Lead.Syllables || []).length); }).slice(0, 6);
        return { ok: true, lines: ly.Content.length, syllables: syl, firstStart: ly.StartTime, words: longest.map(wordsOf) };
      }); },
      open: function () { try { window.Spicetify.Platform.History.push({ pathname: "/QzLyrics" }); } catch (e) {} },
      getLyrics: function () { return curLyrics; },
      getMeta: function () { return curMeta; },
      startGlow: startGlow
    };
  } catch (e) { try { console.error("[QobuzifyLyrics] boot failed:", e); } catch (_) {} }
})();

return function cleanup() {
  if (offBridge) offBridge();
  if (tickIv) clearInterval(tickIv);
  if (tokenIv) clearInterval(tokenIv);
  if (offPP) offPP();
  if (offBtn) offBtn();
  if (container) container.style.display = "none";
};
