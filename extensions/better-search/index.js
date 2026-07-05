// Full-page search to replace Qobuz's weak native one. function(Qobuzify).
// Hooks the real search box and, as you type, throws an opaque takeover over the content region so
// the native /search never shows through. Cover play buttons navigate + click the native Play (no
// play API, the player's sealed). Closing restores wherever you were.
var Q = Qobuzify;
var CSS_ID = "qz-search-css";
var PANEL_ID = "qz-search-panel";

var input = null, panel = null, debTimer = null, hookObs = null;
var state = { q: "", tab: "top", hires: false, lossless: false, heard: false, sort: "relevance", year: 0, data: null, reqId: 0, raw: "" };
var lastNonSearchRoute = null; // restored when the panel closes
try { var _p0 = Q.getState().router.location.pathname || ""; if (_p0.indexOf("/search") !== 0) lastNonSearchRoute = _p0; } catch (e) {}

function norm(s) { return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[‘’']/g, "").trim(); }
function wordScore(n, q) {
  if (n === q) return 1000;
  if (n.indexOf(q) === 0) return 860;
  var w = n.split(/\s+/);
  for (var i = 0; i < w.length; i++) if (w[i].indexOf(q) === 0) return 730;
  if (n.indexOf(q) >= 0) return 560;
  var qi = 0; for (var j = 0; j < n.length && qi < q.length; j++) if (n[j] === q[qi]) qi++;
  if (qi === q.length) return Math.max(120, 320 - (n.length - q.length));
  return 0;
}
// multi-word: every word has to hit, scored by avg per-word quality, bonus if the full phrase is in order
function score(name, q) {
  var n = norm(name); if (!n || !q) return 0;
  var words = q.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return wordScore(n, q);
  var total = 0;
  for (var i = 0; i < words.length; i++) { var s = wordScore(n, words[i]); if (!s) return 0; total += s; }
  var base = total / words.length;
  if (n.indexOf(q) === 0) base += 220; else if (n.indexOf(q) >= 0) base += 110;
  return base;
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

function qsrc(o) { return (o && (o.maximum_bit_depth || o.hires != null)) ? o : (o && o.album) || o; }
function tier(o) {
  o = qsrc(o) || {};
  var bd = o.maximum_bit_depth || (o.hires ? 24 : 16), sr = o.maximum_sampling_rate || 0;
  var sub = bd && sr ? bd + "/" + sr : "";
  if (o.hires || bd >= 24) return { k: "hires", label: "Hi-Res", sub: sub };
  if (bd >= 16) return { k: "lossless", label: "CD", sub: sub };
  return { k: "lossy", label: "MP3", sub: "" };
}
function badge(o) { var t = tier(o); return '<span class="qz-s-badge qz-s-badge--' + t.k + '">' + t.label + (t.sub ? ' <i>' + t.sub + "</i>" : "") + "</span>"; }
function relAt(o) { o = o || {}; return o.released_at || (o.release_date_original ? Date.parse(o.release_date_original) / 1000 : 0) || (o.album ? relAt(o.album) : 0) || 0; }
function cover(o) { if (!o) return ""; var im = o.image || o.picture || o.cover; if (!im && o.album) return cover(o.album); if (typeof im === "string") return im; return (im && (im.small || im.thumbnail || im.medium || im.large)) || ""; }

// placeholder svgs for when there's no image (artists are often image:null)
var PH_ARTIST = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="8.5" r="4"/><path d="M4 20.5c0-4.2 3.6-6.5 8-6.5s8 2.3 8 6.5z"/></svg>';
var PH_MUSIC = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 16.5V6l9-1.8v10.3"/><circle cx="7.5" cy="16.5" r="2.6"/><circle cx="16.5" cy="14.5" r="2.6"/></svg>';
function thumb(url, round, kind) {
  var cls = "qz-s-thumb" + (round ? " qz-s-thumb--round" : "");
  if (url) return '<span class="' + cls + '"><img loading="lazy" src="' + esc(url) + '"></span>';
  return '<span class="' + cls + ' qz-s-thumb--ph">' + (kind === "artist" ? PH_ARTIST : PH_MUSIC) + "</span>";
}
function art(url, kind, round) {
  var cls = "qz-s-art" + (round ? " qz-s-art--round" : "");
  if (url) return '<img class="' + cls + '" loading="lazy" src="' + esc(url) + '">';
  return '<span class="' + cls + ' qz-s-art--ph">' + (kind === "artist" ? PH_ARTIST : PH_MUSIC) + "</span>";
}

var known = null; // {fav:{id:1}, recent:{id:rank}}, higher rank = more recent
function loadKnown() {
  if (known) return Promise.resolve(known);
  known = { fav: {}, recent: {} };
  refreshRecent();
  return Q.api("favorite/getUserFavorites?type=tracks&limit=500").then(function (j) {
    var items = (j.tracks && j.tracks.items) || []; items.forEach(function (t) { known.fav[t.id] = 1; }); return known;
  }).catch(function () { return known; });
}
function refreshRecent() {
  try { var h = (Q.getState().playqueue && Q.getState().playqueue.history) || []; var n = h.length; if (!known) known = { fav: {}, recent: {} }; for (var i = Math.max(0, n - 200); i < n; i++) known.recent[h[i]] = i; } catch (e) {}
}
function knownOf(tr) { if (!known || !tr) return null; var rec = known.recent[tr.id]; var fav = !!known.fav[tr.id]; if (rec == null && !fav) return null; return { recent: rec != null, rank: rec == null ? -1 : rec, fav: fav }; }

function doSearch(q) {
  refreshRecent();
  var id = ++state.reqId; state.q = q;
  Q.api("catalog/search?query=" + encodeURIComponent(q) + "&limit=30").then(function (j) {
    if (id !== state.reqId) return; // stale
    state.data = j; render();
  }).catch(function () { if (id === state.reqId) { state.data = { __err: 1 }; render(); } });
}

// Cover/karaoke/instrumental/tribute markers. These versions get demoted so the real recording wins
// (the #1 reason a billion-stream original ends up buried under knockoffs). Live/acoustic/unplugged
// are deliberately NOT here - they're legit alternate takes, not knockoffs.
var COVER_RE = /karaoke|instrumental|originally performed|in the style of|made famous|tribute|backing track|cover version|bossa nova version|lullaby|piano cover|8 ?bit|ringtone|remake/;
function rankList(group, q, opts) {
  opts = opts || {};
  var items = (group && group.items) || [];
  var nq = norm(q);
  var scored = items.map(function (it, idx) {
    var nm = it.title || it.name || "";
    var sub = (it.artist && it.artist.name) || (it.performer && it.performer.name) || "";
    // Score title, artist, AND the combined "title artist" text. score() needs every query word to hit
    // ONE field, so a query that mixes song + artist ("Blank Space Taylor Swift") zeroes the real track
    // (title has the song, artist has the name) while a cover that stuffs the artist into its own title
    // matches fully. Scoring the combined string lets the split match count.
    var s = Math.max(score(nm, q), score(sub, q) * 0.6, score(nm + " " + sub, q) * 0.9);
    // If the query actually names this artist, they own it: lift their real tracks above covers by
    // others that just put the artist's name in the title (the "Blank Space Taylor Swift"/Aiden Yoo trap).
    var ns = norm(sub), nnm = norm(nm);
    if (ns && ns.length > 2 && nq.indexOf(ns) >= 0) s += 500; // query names this artist
    if (nnm && nnm.length > 2 && nq.indexOf(nnm) >= 0) s += 350; // query contains this item's own name (keeps a named artist from being filtered out)
    if (s && COVER_RE.test(nnm)) s *= 0.4; // demote karaoke/instrumental/cover/tribute versions
    var k = opts.track ? knownOf(it) : null;
    if (k) s += k.recent ? 150 : 90; // songs you've heard surface in relevance ranking
    return { it: it, s: s, idx: idx, k: k };
  });
  if (opts.quality) scored = scored.filter(function (x) { var k = tier(x.it).k; return state.hires ? k === "hires" : state.lossless ? k === "lossless" : true; });
  if (opts.dated && state.year) scored = scored.filter(function (x) { var y = new Date(relAt(x.it) * 1000).getFullYear(); return y >= state.year; });
  if (opts.track && state.heard) scored = scored.filter(function (x) { return x.k; });
  var sort = state.sort;
  scored.sort(function (a, b) {
    if (sort === "popularity") return a.idx - b.idx; // Qobuz returns roughly popularity order
    if (sort === "familiar") { var ra = a.k ? (a.k.recent ? 2 : 1) : 0, rb = b.k ? (b.k.recent ? 2 : 1) : 0; return rb - ra || ((b.k ? b.k.rank : -1) - (a.k ? a.k.rank : -1)) || b.s - a.s || a.idx - b.idx; }
    if (sort === "newest") return relAt(b.it) - relAt(a.it) || a.idx - b.idx;
    if (sort === "oldest") return (relAt(a.it) || 9e9) - (relAt(b.it) || 9e9) || a.idx - b.idx;
    return b.s - a.s || a.idx - b.idx;
  });
  if (sort === "relevance") scored = scored.filter(function (x) { return x.s > 0; });
  return scored.map(function (x) { return x.it; });
}

// no play API (sealed player), so playback = navigate to the thing + click its native Play
function headerPlayBtn() {
  // has to be the dest page's header Play, and visible. there's a pile of other aria-label=Play
  // buttons around (For You cards stay mounted+hidden, the player bar, the prev page mid-transition)
  // and a loose selector kept grabbing one and playing the wrong album.
  var cands = document.querySelectorAll("[class*='PageHeader'] button[aria-label='Play']");
  for (var i = 0; i < cands.length; i++) { var r = cands[i].getBoundingClientRect(); if (cands[i].offsetParent && r.width > 4 && r.height > 4) return cands[i]; }
  return null;
}
function playEntity(path) {
  hide();
  Q.navigate(path);
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    var onPage = (Q.getState().router.location.pathname || "").indexOf(path) >= 0;
    var btn = headerPlayBtn();
    if (onPage && btn) { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); clearInterval(iv); }
    else if (tries > 40) clearInterval(iv); // ~6s
  }, 150);
}
function go(path) { hide(); Q.navigate(path); }
function playBtnHTML() { return '<button class="qz-s-play" title="Play" aria-label="Play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg></button>'; }

// play a specific track, not the album's track 1. no track page either, so: open the album, match the
// .ListItem row by title (exact > prefix > contains, diacritic-insensitive), tie-break on track number,
// click its .ListItem__player. falls back to the header Play if nothing matches so it can't hang.
function normTitle(s) { return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[‘’'`]/g, "").replace(/\s+/g, " ").trim(); }
function tracklistRows() { return [].slice.call(document.querySelectorAll(".ListItem")).filter(function (r) { return r.querySelector(".ListItem__title") && r.querySelector(".ListItem__player"); }); }
function matchTrackRow(rows, title, num) {
  var wt = normTitle(title), best = null, bestS = -1;
  rows.forEach(function (r) {
    var te = r.querySelector(".ListItem__title"); var rt = te ? normTitle(te.textContent) : "";
    var s = 0;
    if (rt && rt === wt) s = 100;
    else if (rt && wt && (rt.indexOf(wt) === 0 || wt.indexOf(rt) === 0)) s = 70;
    else if (rt && wt && (rt.indexOf(wt) >= 0 || wt.indexOf(rt) >= 0)) s = 40;
    if (num) { var ne = r.querySelector(".ListItem__numberText"); if (ne && parseInt(ne.textContent, 10) === num) s += 15; }
    if (s > bestS) { bestS = s; best = r; }
  });
  return bestS >= 40 ? best : null;
}
function fireClick(elm) { ["mousedown", "mouseup", "click"].forEach(function (t) { elm.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); }); }
function playTrack(albumId, title, num) {
  if (!albumId) return;
  hide(); Q.navigate("/album/" + albumId);
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    var onPage = (Q.getState().router.location.pathname || "").indexOf(albumId) >= 0;
    if (onPage) {
      var rows = tracklistRows();
      if (rows.length) {
        var target = matchTrackRow(rows, title, num);
        if (target) { var p = target.querySelector(".ListItem__player") || target.querySelector(".ListItem__number"); if (p) { fireClick(p); clearInterval(iv); return; } }
        if (tries > 12) { var hb = headerPlayBtn(); if (hb) { hb.dispatchEvent(new MouseEvent("click", { bubbles: true })); clearInterval(iv); return; } }
      }
    }
    if (tries > 40) clearInterval(iv);
  }, 150);
}

function trackRow(tr) {
  var alId = tr.album && tr.album.id;
  var k = knownOf(tr);
  var mark = k ? '<span class="qz-s-heard' + (k.recent ? " qz-s-heard--recent" : "") + '">' + (k.recent ? "Recently played" : "In favorites") + "</span>" : "";
  var r = el('<a class="qz-s-row' + (k ? " qz-s-row--heard" : "") + '" href="' + (alId ? "/album/" + alId : "#") + '">' + thumb(cover(tr), false, "track") +
    '<span class="qz-s-meta"><span class="qz-s-name">' + esc(tr.title) + " " + badge(tr) + mark + '</span><span class="qz-s-sub">' + esc((tr.performer && tr.performer.name) || "") + (tr.album ? " &middot; " + esc(tr.album.title || "") : "") + "</span></span></a>");
  if (alId) { var pb = el(playBtnHTML()); r.querySelector(".qz-s-thumb").appendChild(pb); pb.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); playTrack(alId, tr.title, tr.track_number); }); }
  r.addEventListener("click", function (e) { e.preventDefault(); if (alId) go("/album/" + alId); });
  return r;
}
function artistRow(ar) {
  var r = el('<a class="qz-s-row" href="/artist/' + ar.id + '">' + thumb(cover(ar), true, "artist") +
    '<span class="qz-s-meta"><span class="qz-s-name">' + esc(ar.name) + '</span><span class="qz-s-sub">Artist' + (ar.albums_count ? " &middot; " + ar.albums_count + " releases" : "") + "</span></span></a>");
  r.addEventListener("click", function (e) { e.preventDefault(); go("/artist/" + ar.id); });
  return r;
}

function albumCard(al) {
  var c = el('<a class="qz-s-card" href="/album/' + al.id + '">' +
    '<span class="qz-s-cardart">' + art(cover(al), "album", false) + '<span class="qz-s-cardbadge">' + badge(al) + '</span>' + playBtnHTML() + '</span>' +
    '<span class="qz-s-cardname">' + esc(al.title) + '</span>' +
    '<span class="qz-s-cardsub">' + esc((al.artist && al.artist.name) || "") + (relAt(al) ? " &middot; " + new Date(relAt(al) * 1000).getFullYear() : "") + '</span></a>');
  var pb = c.querySelector(".qz-s-play"); if (pb) pb.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); playEntity("/album/" + al.id); });
  c.addEventListener("click", function (e) { e.preventDefault(); go("/album/" + al.id); });
  return c;
}
function artistCard(ar) {
  var c = el('<a class="qz-s-card qz-s-card--artist" href="/artist/' + ar.id + '">' +
    '<span class="qz-s-cardart qz-s-cardart--round">' + art(cover(ar), "artist", true) + '</span>' +
    '<span class="qz-s-cardname">' + esc(ar.name) + '</span>' +
    '<span class="qz-s-cardsub">Artist' + (ar.albums_count ? " &middot; " + ar.albums_count + " releases" : "") + '</span></a>');
  c.addEventListener("click", function (e) { e.preventDefault(); go("/artist/" + ar.id); });
  return c;
}
function playlistCard(pl) {
  var src = pl.images300 ? { image: pl.images300[0] } : pl;
  var c = el('<a class="qz-s-card" href="/playlist/' + pl.id + '">' +
    '<span class="qz-s-cardart">' + art(cover(src), "playlist", false) + playBtnHTML() + '</span>' +
    '<span class="qz-s-cardname">' + esc(pl.name) + '</span>' +
    '<span class="qz-s-cardsub">Playlist' + (pl.tracks_count ? " &middot; " + pl.tracks_count + " tracks" : "") + (pl.owner && pl.owner.name ? " &middot; " + esc(pl.owner.name) : "") + '</span></a>');
  var pb = c.querySelector(".qz-s-play"); if (pb) pb.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); playEntity("/playlist/" + pl.id); });
  c.addEventListener("click", function (e) { e.preventDefault(); go("/playlist/" + pl.id); });
  return c;
}
function heroCard(it, kind) {
  var path = (kind === "artist" ? "/artist/" : "/album/") + it.id;
  var name = it.name || it.title || "";
  var sub = kind === "artist" ? "Artist" : ("Album" + ((it.artist && it.artist.name) ? " &middot; " + esc(it.artist.name) : "") + (relAt(it) ? " &middot; " + new Date(relAt(it) * 1000).getFullYear() : ""));
  var c = el('<div class="qz-s-hero">' +
    '<a class="qz-s-heroart' + (kind === "artist" ? " qz-s-heroart--round" : "") + '" href="' + path + '">' + art(cover(it), kind, kind === "artist") + '</a>' +
    '<div class="qz-s-heroinfo">' +
      '<div class="qz-s-herokind">Top result</div>' +
      '<a class="qz-s-heroname" href="' + path + '">' + esc(name) + '</a>' +
      '<div class="qz-s-herosub">' + sub + '</div>' +
      '<button class="qz-s-herobtn"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>Play</button>' +
    '</div></div>');
  c.querySelectorAll("a").forEach(function (a) { a.addEventListener("click", function (e) { e.preventDefault(); go(path); }); });
  c.querySelector(".qz-s-herobtn").addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); playEntity(path); });
  return c;
}
function el(html) { var t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }

function cardGrid(title, cards) {
  if (!cards.length) return null;
  var s = document.createElement("div"); s.className = "qz-s-sec";
  if (title) s.innerHTML = '<div class="qz-s-sectitle">' + esc(title) + "</div>";
  var g = document.createElement("div"); g.className = "qz-s-grid";
  cards.forEach(function (c) { g.appendChild(c); });
  s.appendChild(g); return s;
}
function listSec(title, rows) {
  if (!rows.length) return null;
  var s = document.createElement("div"); s.className = "qz-s-sec";
  if (title) s.innerHTML = '<div class="qz-s-sectitle">' + esc(title) + "</div>";
  var l = document.createElement("div"); l.className = "qz-s-list";
  rows.forEach(function (r) { l.appendChild(r); });
  s.appendChild(l); return s;
}
function render() {
  if (!panel) return;
  var body = panel.querySelector(".qz-s-body");
  var titleEl = panel.querySelector(".qz-s-query");
  var d = state.data, q = norm(state.q);
  if (titleEl) titleEl.textContent = state.raw ? state.raw.trim() : "";
  panel.querySelectorAll("[data-tab]").forEach(function (b) { b.classList.toggle("qz-on", b.getAttribute("data-tab") === state.tab); });
  panel.querySelector('[data-q="hires"]').classList.toggle("qz-on", state.hires);
  panel.querySelector('[data-q="lossless"]').classList.toggle("qz-on", state.lossless);
  var heardChip = panel.querySelector('[data-q="heard"]'); if (heardChip) heardChip.classList.toggle("qz-on", state.heard);
  var qualOff = state.tab === "artists" || state.tab === "playlists";
  panel.querySelector(".qz-s-qual").style.opacity = qualOff ? ".35" : "1";
  panel.querySelector(".qz-s-qual").style.pointerEvents = qualOff ? "none" : "auto";

  if (!d) { body.innerHTML = '<div class="qz-s-empty"><div class="qz-s-empticon">' + PH_MUSIC + '</div>Search your 100M-track Qobuz catalog.<span>Albums, tracks, artists and playlists - ranked, filterable, instant.</span></div>'; return; }
  if (d.__err) { body.innerHTML = '<div class="qz-s-empty">Search failed - try again.</div>'; return; }

  var albums = rankList(d.albums, q, { quality: true, dated: true });
  var tracks = rankList(d.tracks, q, { quality: true, dated: true, track: true });
  var artists = rankList(d.artists, q, {});
  var playlists = rankList(d.playlists, q, {});
  body.innerHTML = "";
  var inner = document.createElement("div"); inner.className = "qz-s-inner";

  if (state.tab === "top") {
    // strongest of the top artist/album becomes the hero
    var aBest = artists[0] ? { it: artists[0], kind: "artist", s: score(artists[0].name, q) } : null;
    // if the query explicitly names the top artist, they're the top result the user wants - not a
    // keyword-stuffed cover/mashup album that happens to put the artist's name in its own title.
    if (aBest && norm(artists[0].name).length > 2 && norm(q).indexOf(norm(artists[0].name)) >= 0) aBest.s += 1200;
    var alBest = albums[0] ? { it: albums[0], kind: "album", s: score(albums[0].title, q) * (COVER_RE.test(norm(albums[0].title)) ? 0.4 : 1) } : null;
    var hero = null;
    if (aBest && (!alBest || aBest.s >= alBest.s)) hero = aBest; else if (alBest) hero = alBest;
    if (hero && hero.s < 300) hero = null;
    // "song + artist" queries (e.g. "Blank Space Taylor Swift") return no artist result and only cover
    // albums, so there's no clean artist/album hero. Fall back to the top track's real performer when the
    // query names them - the actual artist is a better Top result than a cover album or an empty slot.
    if (!hero && tracks[0]) {
      var perf = tracks[0].performer || tracks[0].artist;
      if (perf && perf.id && norm(perf.name).length > 2 && norm(q).indexOf(norm(perf.name)) >= 0)
        hero = { it: { id: perf.id, name: perf.name, image: cover(tracks[0]) }, kind: "artist" };
    }

    if (hero || tracks.length) {
      var topWrap = document.createElement("div"); topWrap.className = "qz-s-topgrid";
      if (hero) { var hs = document.createElement("div"); hs.className = "qz-s-sec"; hs.innerHTML = '<div class="qz-s-sectitle">Top result</div>'; hs.appendChild(heroCard(hero.it, hero.kind)); topWrap.appendChild(hs); }
      var songs = listSec("Songs", tracks.slice(0, 6).map(trackRow)); if (songs) { songs.classList.add("qz-s-songs"); topWrap.appendChild(songs); }
      inner.appendChild(topWrap);
    }
    var heroIsArtist = hero && hero.kind === "artist";
    var heroIsAlbum = hero && hero.kind === "album";
    var sa = cardGrid("Albums", albums.slice(heroIsAlbum ? 1 : 0, heroIsAlbum ? 8 : 7).map(albumCard)); if (sa) inner.appendChild(sa);
    var sr = cardGrid("Artists", artists.slice(heroIsArtist ? 1 : 0, heroIsArtist ? 8 : 7).map(artistCard)); if (sr) inner.appendChild(sr);
    var sp = cardGrid("Playlists", playlists.slice(0, 7).map(playlistCard)); if (sp) inner.appendChild(sp);
    if (!inner.childNodes.length) { body.innerHTML = '<div class="qz-s-empty">No matches.</div>'; return; }
  } else if (state.tab === "tracks") {
    if (!tracks.length) { body.innerHTML = '<div class="qz-s-empty">No tracks match your filters.</div>'; return; }
    var ls = listSec("", tracks.slice(0, 60).map(trackRow)); if (ls) { ls.querySelector(".qz-s-list").classList.add("qz-s-list--grid"); inner.appendChild(ls); }
  } else {
    var map = { albums: [albums, albumCard], artists: [artists, artistCard], playlists: [playlists, playlistCard] };
    var pair = map[state.tab], list = pair[0], mk = pair[1];
    if (!list.length) { body.innerHTML = '<div class="qz-s-empty">No ' + state.tab + " match your filters.</div>"; return; }
    var g = cardGrid("", list.slice(0, 60).map(mk)); if (g) inner.appendChild(g);
  }
  body.appendChild(inner);
}

function ensureUI() {
  if (panel) return;
  panel = document.createElement("div"); panel.id = PANEL_ID; panel.style.display = "none";
  panel.innerHTML =
    '<div class="qz-s-head">' +
      '<div class="qz-s-headtop">' +
        '<div class="qz-s-querywrap"><span class="qz-s-querylbl">Results for</span><span class="qz-s-query"></span></div>' +
        '<button class="qz-s-close" title="Close (Esc)" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
      '</div>' +
      '<div class="qz-s-filters">' +
        '<div class="qz-s-tabs">' +
          ['top:Top', 'albums:Albums', 'tracks:Tracks', 'artists:Artists', 'playlists:Playlists'].map(function (t) {
            var p = t.split(":"); return '<button class="qz-s-tab" data-tab="' + p[0] + '">' + p[1] + "</button>";
          }).join("") +
        '</div>' +
        '<div class="qz-s-controls">' +
          '<div class="qz-s-qual"><button class="qz-s-chip" data-q="hires" title="24-bit hi-res only">Hi-Res</button><button class="qz-s-chip" data-q="lossless" title="16-bit CD quality only">CD</button><button class="qz-s-chip" data-q="heard" title="Only songs you\'ve played before">Heard</button></div>' +
          '<select class="qz-s-sel qz-s-year"></select>' +
          '<select class="qz-s-sel qz-s-sort">' +
            '<option value="relevance">Relevance</option><option value="popularity">Popularity</option><option value="familiar">Familiar</option><option value="newest">Newest</option><option value="oldest">Oldest</option>' +
          '</select>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="qz-s-body"></div>';
  layoutHost().appendChild(panel);

  var sel = panel.querySelector(".qz-s-year"); var now = new Date().getFullYear();
  var opts = ['<option value="0">Any year</option>'];
  for (var y = now; y >= now - 6; y--) opts.push('<option value="' + y + '">From ' + y + "</option>");
  [2020, 2015, 2010, 2000, 1990, 1980, 1970, 1960].forEach(function (y) { opts.push('<option value="' + y + '">From ' + y + "</option>"); });
  sel.innerHTML = opts.join("");

  panel.querySelectorAll("[data-tab]").forEach(function (b) { b.addEventListener("click", function () { state.tab = b.getAttribute("data-tab"); render(); body().scrollTop = 0; }); });
  panel.querySelector('[data-q="hires"]').addEventListener("click", function () { state.hires = !state.hires; if (state.hires) state.lossless = false; render(); });
  panel.querySelector('[data-q="lossless"]').addEventListener("click", function () { state.lossless = !state.lossless; if (state.lossless) state.hires = false; render(); });
  panel.querySelector('[data-q="heard"]').addEventListener("click", function () { state.heard = !state.heard; if (state.tab === "top") state.tab = "tracks"; render(); });
  panel.querySelector(".qz-s-sort").addEventListener("change", function () { state.sort = this.value; render(); });
  panel.querySelector(".qz-s-year").addEventListener("change", function () { state.year = parseInt(this.value, 10) || 0; render(); });
  panel.querySelector(".qz-s-close").addEventListener("click", closeSearch);
}
function body() { return panel && panel.querySelector(".qz-s-body"); }

// host the panel inside the app layout (z:220, under the nav/player panels at z:250) so Qobuz's own
// dropdowns still open above it. a body-level max z-index used to cover them up.
function layoutHost() { var pt = document.querySelector(".ui-layout--root--panel-top"); return (pt && pt.parentElement) || document.body; }
function contentRect() {
  var sc = document.querySelector(".ui-layout--root--scroll-main") || document.querySelector(".ui-layout--root--main") || document.querySelector(".ui-scroll");
  if (sc) { var r = sc.getBoundingClientRect(); if (r.width > 200 && r.height > 200) return { top: r.top, left: r.left, width: r.width, height: r.height }; }
  return { top: 56, left: 0, width: window.innerWidth, height: Math.max(300, window.innerHeight - 56 - 78) };
}
function layout() {
  if (!panel) return;
  var h = layoutHost(); if (panel.parentElement !== h) h.appendChild(panel); // survive React re-renders
  var r = contentRect();
  panel.style.top = r.top + "px"; panel.style.left = r.left + "px";
  panel.style.width = r.width + "px"; panel.style.height = r.height + "px";
}
function show() { ensureUI(); layout(); panel.style.display = "flex"; requestAnimationFrame(function () { panel.classList.add("qz-s-in"); }); }
function hide() { if (!panel) return; panel.classList.remove("qz-s-in"); panel.style.display = "none"; }
function closeSearch() {
  hide();
  // don't hide while still on /search or the native page shows through. bounce back to the saved
  // route, or /discover if the app opened straight onto search.
  try {
    var p = Q.getState().router.location.pathname || "";
    if (p.indexOf("/search") === 0) Q.navigate((lastNonSearchRoute && lastNonSearchRoute.indexOf("/search") !== 0) ? lastNonSearchRoute : "/discover");
  } catch (e) {}
}
function isOpen() { return panel && panel.style.display !== "none"; }

function onType() {
  var v = input ? input.value : "";
  state.raw = v;
  clearTimeout(debTimer);
  if (norm(v).length < 2) { state.data = null; if (isOpen()) render(); return; }
  show();
  state.data = null; render();
  debTimer = setTimeout(function () { doSearch(v.trim()); }, 190);
}
function hookInput() {
  var inp = document.querySelector(".SearchBar__input");
  if (!inp || inp === input) return;
  input = inp;
  input.addEventListener("input", onType);
  input.addEventListener("focus", function () { if (norm(input.value).length >= 2) { show(); if (state.q !== input.value.trim()) onType(); } });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { closeSearch(); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); clearTimeout(debTimer); if (norm(input.value).length >= 2) { show(); doSearch(input.value.trim()); } }
  });
}

Q.css(CSS_ID, [
  "#" + PANEL_ID + "{position:fixed;z-index:220;display:flex;flex-direction:column;color:#eef2f7;",
  "background:radial-gradient(120% 90% at 82% -8%,rgba(61,168,254,.10),transparent 60%),linear-gradient(180deg,#0a0e17,#060a12 60%);",
  "opacity:0;transition:opacity .16s ease;font-family:inherit;overflow:hidden;}",
  "#" + PANEL_ID + ".qz-s-in{opacity:1;}",
  // header
  ".qz-s-head{flex:0 0 auto;padding:20px 34px 12px;border-bottom:1px solid rgba(255,255,255,.06);background:linear-gradient(180deg,rgba(10,14,23,.9),rgba(10,14,23,.55));backdrop-filter:blur(8px);}",
  ".qz-s-headtop{display:flex;align-items:center;gap:16px;margin-bottom:14px;}",
  ".qz-s-querywrap{min-width:0;display:flex;align-items:baseline;gap:12px;flex:1;}",
  ".qz-s-querylbl{font-size:13px;font-weight:650;color:#7d8798;text-transform:uppercase;letter-spacing:.7px;flex:0 0 auto;}",
  ".qz-s-query{font-size:26px;font-weight:800;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.2px;}",
  ".qz-s-close{flex:0 0 auto;width:38px;height:38px;border:0;border-radius:50%;background:rgba(255,255,255,.06);color:#c7cfdb;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .14s;}",
  ".qz-s-close:hover{background:rgba(255,255,255,.13);color:#fff;}.qz-s-close svg{width:19px;height:19px;}",
  ".qz-s-filters{display:flex;align-items:center;gap:16px;flex-wrap:wrap;}",
  ".qz-s-tabs{display:flex;gap:4px;flex-wrap:wrap;}",
  ".qz-s-tab{appearance:none;border:0;background:transparent;color:#9aa3b2;font:inherit;font-size:13.5px;font-weight:700;padding:7px 15px;border-radius:9px;cursor:pointer;transition:all .14s;}",
  ".qz-s-tab:hover{color:#e7ecf3;background:rgba(255,255,255,.05);}",
  ".qz-s-tab.qz-on{color:#06090a;background:var(--qz-accent,#3DA8FE);}",
  ".qz-s-controls{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-left:auto;}",
  ".qz-s-qual{display:flex;gap:6px;transition:opacity .14s;}",
  ".qz-s-chip{appearance:none;border:1px solid rgba(255,255,255,.16);background:transparent;color:#cbd3df;font:inherit;font-size:12px;font-weight:650;padding:6px 12px;border-radius:20px;cursor:pointer;transition:all .14s;}",
  ".qz-s-chip:hover{border-color:var(--qz-accent,#3DA8FE);color:#fff;}",
  ".qz-s-chip.qz-on{background:var(--qz-accent,#3DA8FE);border-color:var(--qz-accent,#3DA8FE);color:#06090a;}",
  ".qz-s-sel{appearance:none;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.04);color:#e7ecf3;font:inherit;font-size:12px;font-weight:600;padding:7px 11px;border-radius:8px;cursor:pointer;}",
  ".qz-s-sel option{background:#12151d;color:#e7ecf3;}",
  // body
  ".qz-s-body{flex:1 1 auto;overflow:auto;padding:22px 34px 40px;scrollbar-width:thin;}",
  ".qz-s-body::-webkit-scrollbar{width:11px;}.qz-s-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.13);border-radius:9px;}.qz-s-body::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.22);}",
  ".qz-s-inner{max-width:1500px;margin:0 auto;}",
  ".qz-s-empty{padding:80px 18px;text-align:center;color:#8b94a3;font-size:16px;font-weight:600;display:flex;flex-direction:column;align-items:center;gap:8px;}",
  ".qz-s-empty span{font-size:13px;font-weight:500;color:#69707d;}",
  ".qz-s-empticon{width:58px;height:58px;color:rgba(255,255,255,.16);margin-bottom:6px;}.qz-s-empticon svg{width:100%;height:100%;}",
  ".qz-s-sec{margin:0 0 30px;}",
  ".qz-s-sectitle{font-size:19px;font-weight:800;letter-spacing:-.2px;color:#fff;margin:0 0 14px;}",
  // top-tab hero grid: Top result + Songs side by side
  ".qz-s-topgrid{display:grid;grid-template-columns:minmax(320px,1fr) 1.35fr;gap:26px;margin-bottom:30px;align-items:start;}",
  "@media (max-width:980px){.qz-s-topgrid{grid-template-columns:1fr;}}",
  ".qz-s-topgrid .qz-s-sec{margin:0;}",
  // hero card
  ".qz-s-hero{position:relative;display:flex;flex-direction:column;gap:16px;padding:22px;border-radius:16px;background:linear-gradient(160deg,rgba(255,255,255,.07),rgba(255,255,255,.02));border:1px solid rgba(255,255,255,.07);overflow:hidden;}",
  ".qz-s-hero:hover{background:linear-gradient(160deg,rgba(255,255,255,.1),rgba(255,255,255,.03));}",
  ".qz-s-heroart{display:block;width:128px;height:128px;border-radius:12px;overflow:hidden;box-shadow:0 12px 34px rgba(0,0,0,.5);text-decoration:none;}",
  ".qz-s-heroart--round{border-radius:50%;}",
  ".qz-s-heroinfo{display:flex;flex-direction:column;gap:6px;min-width:0;}",
  ".qz-s-herokind{font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.6px;color:#8b94a3;}",
  ".qz-s-heroname{font-size:30px;font-weight:850;color:#fff;text-decoration:none;letter-spacing:-.5px;line-height:1.05;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}",
  ".qz-s-heroname:hover{text-decoration:underline;}",
  ".qz-s-herosub{font-size:13px;color:#9aa3b2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".qz-s-herobtn{margin-top:8px;align-self:flex-start;display:inline-flex;align-items:center;gap:8px;border:0;border-radius:24px;background:var(--qz-accent,#3DA8FE);color:#06090a;font:inherit;font-size:13.5px;font-weight:750;padding:10px 20px;cursor:pointer;transition:transform .12s,filter .12s;box-shadow:0 8px 22px -8px var(--qz-accent,#3DA8FE);}",
  ".qz-s-herobtn:hover{transform:scale(1.04);filter:brightness(1.06);}.qz-s-herobtn svg{width:16px;height:16px;}",
  // grids of cards
  ".qz-s-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:8px;}",
  ".qz-s-card{display:flex;flex-direction:column;gap:4px;padding:12px;border-radius:12px;text-decoration:none;color:inherit;cursor:pointer;transition:background .14s;min-width:0;}",
  ".qz-s-card:hover{background:rgba(255,255,255,.06);}",
  ".qz-s-cardart{position:relative;width:100%;aspect-ratio:1;border-radius:9px;overflow:hidden;background:rgba(255,255,255,.05);margin-bottom:6px;box-shadow:0 8px 22px -12px rgba(0,0,0,.7);}",
  ".qz-s-cardart--round{border-radius:50%;}",
  ".qz-s-card--artist{text-align:center;align-items:center;}",
  ".qz-s-art{width:100%;height:100%;object-fit:cover;display:block;}",
  ".qz-s-art--round{border-radius:50%;}",
  ".qz-s-art--ph{display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.28);}.qz-s-art--ph svg{width:46%;height:46%;}",
  ".qz-s-cardbadge{position:absolute;top:7px;left:7px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.6));}",
  ".qz-s-cardname{font-size:14px;font-weight:700;color:#eef2f7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}",
  ".qz-s-cardsub{font-size:12px;color:#8b94a3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}",
  // play button on cover hover
  ".qz-s-cardart .qz-s-play{position:absolute;right:8px;bottom:8px;inset:auto 8px 8px auto;width:42px;height:42px;}",
  ".qz-s-play{border:0;border-radius:50%;background:var(--qz-accent,#3DA8FE);color:#06090a;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;transform:translateY(6px) scale(.85);transition:opacity .14s,transform .14s;box-shadow:0 6px 18px rgba(0,0,0,.5);}",
  ".qz-s-play svg{width:20px;height:20px;margin-left:2px;}",
  ".qz-s-card:hover .qz-s-play,.qz-s-row:hover .qz-s-play{opacity:1;transform:translateY(0) scale(1);}",
  ".qz-s-play:hover{filter:brightness(1.08);}",
  // list rows (tracks tab + hero Songs)
  ".qz-s-songs .qz-s-list{background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.05);border-radius:14px;padding:6px;}",
  ".qz-s-list{display:flex;flex-direction:column;gap:1px;}",
  ".qz-s-list--grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(430px,1fr));gap:1px 24px;}",
  ".qz-s-row{display:flex;align-items:center;gap:14px;padding:9px 12px;border-radius:10px;text-decoration:none;color:inherit;cursor:pointer;transition:background .12s;}",
  ".qz-s-row:hover{background:rgba(255,255,255,.06);}",
  ".qz-s-thumb{position:relative;width:48px;height:48px;border-radius:8px;overflow:hidden;flex:0 0 auto;background:rgba(255,255,255,.06);}",
  ".qz-s-thumb--round{border-radius:50%;}",
  ".qz-s-thumb img{width:100%;height:100%;object-fit:cover;display:block;}",
  ".qz-s-thumb--ph{display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.30);}.qz-s-thumb--ph svg{width:56%;height:56%;}",
  ".qz-s-thumb .qz-s-play{position:absolute;inset:0;margin:auto;width:30px;height:30px;}",
  ".qz-s-meta{min-width:0;display:flex;flex-direction:column;gap:3px;}",
  ".qz-s-name{font-size:14.5px;font-weight:650;color:#eef2f7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:8px;}",
  ".qz-s-sub{font-size:12.5px;color:#8b94a3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".qz-s-badge{font-size:9.5px;font-weight:800;letter-spacing:.3px;padding:1px 6px;border-radius:5px;line-height:1.6;flex:0 0 auto;}",
  ".qz-s-badge i{font-style:normal;font-weight:600;opacity:.85;}",
  ".qz-s-badge--hires{color:#06090a;background:var(--qz-accent,#3DA8FE);}",
  ".qz-s-badge--lossless{color:var(--qz-accent,#3DA8FE);box-shadow:inset 0 0 0 1px var(--qz-accent,#3DA8FE);}",
  ".qz-s-badge--lossy{display:none;}",
  ".qz-s-heard{font-size:9.5px;font-weight:800;letter-spacing:.2px;padding:1px 7px;border-radius:5px;line-height:1.6;flex:0 0 auto;color:#9aa3b2;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18);}",
  ".qz-s-heard--recent{color:var(--qz-accent,#3DA8FE);box-shadow:inset 0 0 0 1px var(--qz-accent,#3DA8FE);}",
  ".qz-s-row--heard .qz-s-thumb{box-shadow:0 0 0 2px var(--qz-accent,#3DA8FE);}"
].join(""));

loadKnown();

hookInput();
hookObs = Q.observe(function () { hookInput(); if (isOpen()) layout(); }, { debounce: 250 });
window.addEventListener("resize", layout);
// stay open through the native search's own /search navs; only close (and save the route) on a real
// nav the user made - a result, a nav item, etc.
var offRoute = Q.onRoute(function (path) {
  if (path && path.indexOf("/search") === 0) return;
  lastNonSearchRoute = path;
  hide();
});

return function cleanup() {
  clearTimeout(debTimer);
  if (hookObs) hookObs();
  if (offRoute) offRoute();
  window.removeEventListener("resize", layout);
  if (input) { input.removeEventListener("input", onType); input = null; }
  if (panel) { panel.remove(); panel = null; }
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
