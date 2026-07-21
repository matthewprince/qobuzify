// A personalized recommendations home page, built entirely from your own Qobuz data (favorites +
// listening) and Qobuz's own catalog endpoints. No external API, no key. Runs as
// function(Qobuzify){ ... return cleanup }.
//
// It drops a native-styled "For You" item in as the first tab in the top nav row, before Discover,
// with a custom (non-sparkle) icon, and then acts as the app's home - it auto-opens on launch, and
// the Qobuz logo opens it too. The page itself is a full-page overlay (same trick as better-search):
// a "Top pick for you" hero spotlight up top, then horizontal shelves that fill in as the data
// arrives - In your rotation, New from artists you love, Because you like {Artist}, Artists you
// might like, Fresh for you. Cards have hover play buttons; there's no play API, so those navigate
// to the entity and click its native Play.
//
// All the data comes through Qobuzify.api (the in-app Qobuz token):
//   favorite/getUserFavorites?type=artists|albums|tracks
//   artist/getSimilarArtists?artist_id=..   artist/get?artist_id=..&extra=albums
//   album/getFeatured?type=new-releases-full   track/get?track_id=..   playlist/get?playlist_id=..
var Q = Qobuzify;
var CSS_ID = "qz-foryou-css";
var PAGE_ID = "qz-foryou-page";
var NAV_ID = "foryou";
// custom nav icon (heart) - replaces the AI-looking "magic stars" sparkle
var FY_ICON = '<svg class="ui-base-icon qz-fy-navicon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20.3S3.6 14.9 3.6 8.9C3.6 6.3 5.7 4.3 8.2 4.3C9.9 4.3 11.3 5.2 12 6.6C12.7 5.2 14.1 4.3 15.8 4.3C18.3 4.3 20.4 6.3 20.4 8.9C20.4 14.9 12 20.3 12 20.3Z"/></svg>';
var FY_SHUFFLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>';

var cache = {};           // path -> promise (session cache)
var page = null, active = false, loaded = false, reassertObs = null, booted = false;
var heroPool = [], heroLastId = null; // rotating "Top pick" spotlight (was stuck on the single newest release)

function api(path) {
  if (!cache[path]) cache[path] = Q.api(path).catch(function (e) { delete cache[path]; throw e; });
  return cache[path];
}
// run fn over items with at most n in flight; resolves with results array (nulls on error)
function pool(items, n, fn) {
  return new Promise(function (resolve) {
    var out = new Array(items.length), i = 0, done = 0, running = 0;
    if (!items.length) return resolve(out);
    function next() {
      while (running < n && i < items.length) {
        (function (idx) {
          running++;
          Promise.resolve(fn(items[idx], idx)).then(function (r) { out[idx] = r; }, function () { out[idx] = null; })
            .then(function () { running--; if (++done === items.length) resolve(out); else next(); });
        })(i++);
      }
    }
    next();
  });
}

// --- data helpers ---
function favArtists() { return api("favorite/getUserFavorites?type=artists&limit=50").then(function (j) { return (j.artists && j.artists.items) || []; }); }
function favAlbums() { return api("favorite/getUserFavorites?type=albums&limit=60").then(function (j) { return (j.albums && j.albums.items) || []; }).catch(function () { return []; }); }
function similarArtists(id) { return api("artist/getSimilarArtists?artist_id=" + id + "&limit=12").then(function (j) { return (j.artists && j.artists.items) || []; }); }
function artistAlbums(id) { return api("artist/get?artist_id=" + id + "&extra=albums&limit=6").then(function (j) { return (j.albums && j.albums.items) || []; }); }
function featuredNew() { return api("album/getFeatured?type=new-releases-full&limit=30").then(function (j) { return (j.albums && j.albums.items) || []; }); }

function coverUrl(o) {
  if (!o) return "";
  var im = o.image || o.cover || o.picture;
  if (!im) return o.album ? coverUrl(o.album) : "";
  if (typeof im === "string") return im;
  return im.large || im.medium || im.small || im.thumbnail || im.extralarge || im.mega || "";
}
function albumArtistName(al) { return (al.artist && al.artist.name) || (al.performer && al.performer.name) || ""; }
function streamable(al) { return al && al.streamable !== false; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
function rel(a) { return (a && (a.released_at || a.release_date_original && Date.parse(a.release_date_original) / 1000)) || 0; }
function byNewest(a, b) { return (rel(b) - rel(a)); }
function dedupe(list, keyOf) { var seen = {}, out = []; list.forEach(function (x) { if (!x) return; var k = keyOf(x); if (k == null || seen[k]) return; seen[k] = 1; out.push(x); }); return out; }
// Hi-Res badge only (no badge = not hi-res), matching the quality-badges philosophy
function hires(o) { o = (o && (o.maximum_bit_depth || o.hires != null)) ? o : (o && o.album) || o || {}; return !!(o.hires || (o.maximum_bit_depth || 0) >= 24); }
function badge(o) { return hires(o) ? '<span class="qz-fy-badge">Hi-Res</span>' : ""; }

// --- playback (no play API - navigate and click the native Play button) ---
// only the destination page's header Play button, and only once it's visible. the DOM has plenty of
// aria-label="Play" buttons (our own For You cards - including the just-played track in "In your
// rotation" - the player bar, the previous page mid-transition); a broad selector caught those and
// played the wrong album.
function headerPlayBtn() {
  var cands = document.querySelectorAll("[class*='PageHeader'] button[aria-label='Play']");
  for (var i = 0; i < cands.length; i++) { var r = cands[i].getBoundingClientRect(); if (cands[i].offsetParent && r.width > 4 && r.height > 4) return cands[i]; }
  return null;
}
function playEntity(path) {
  close(); Q.navigate(path);
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    var onPage = (Q.getState().router.location.pathname || "").indexOf(path) >= 0;
    var btn = headerPlayBtn();
    if (onPage && btn) { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); clearInterval(iv); }
    else if (tries > 40) clearInterval(iv);
  }, 150);
}
function go(path) { close(); Q.navigate(path); }
function playBtnHTML() { return '<button class="qz-fy-play" title="Play" aria-label="Play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg></button>'; }

// Play one specific track, not the album's first. No play API and no track page, so open the album
// and click the matching row's own play arrow (.ListItem > .ListItem__number > .ListItem__player).
// Match on title, break ties with the track number, fall back to the album header Play if nothing hits.
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
function playTrack(albumId, title, num) {
  if (!albumId) return;
  close(); Q.navigate("/album/" + albumId);
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    var onPage = (Q.getState().router.location.pathname || "").indexOf(albumId) >= 0;
    if (onPage) {
      var rows = tracklistRows();
      if (rows.length) {
        var target = matchTrackRow(rows, title, num);
        if (target) { var p = target.querySelector(".ListItem__player") || target.querySelector(".ListItem__number"); if (p) { ["mousedown", "mouseup", "click"].forEach(function (t) { p.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); }); clearInterval(iv); return; } }
        if (tries > 12) { var hb = headerPlayBtn(); if (hb) { hb.dispatchEvent(new MouseEvent("click", { bubbles: true })); clearInterval(iv); return; } }
      }
    }
    if (tries > 40) clearInterval(iv);
  }, 150);
}

// --- card + row builders ---
function albumCard(al) {
  var c = document.createElement("a");
  c.className = "qz-fy-card"; c.href = "/album/" + al.id;
  c.innerHTML = '<div class="qz-fy-art"><img loading="lazy" src="' + coverUrl(al) + '" alt="">' + badge(al) + playBtnHTML() + '</div>' +
    '<div class="qz-fy-t">' + esc(al.title || "") + '</div><div class="qz-fy-s">' + esc(albumArtistName(al)) + (rel(al) ? " &middot; " + new Date(rel(al) * 1000).getFullYear() : "") + '</div>';
  var pb = c.querySelector(".qz-fy-play"); if (pb) pb.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); playEntity("/album/" + al.id); });
  c.addEventListener("click", function (e) { e.preventDefault(); go("/album/" + al.id); });
  return c;
}
function artistCard(ar) {
  var c = document.createElement("a");
  c.className = "qz-fy-card qz-fy-card--artist"; c.href = "/artist/" + ar.id;
  c.innerHTML = '<div class="qz-fy-art qz-fy-art--round"><img loading="lazy" src="' + coverUrl(ar) + '" alt=""></div>' +
    '<div class="qz-fy-t">' + esc(ar.name || "") + '</div><div class="qz-fy-s">Artist</div>';
  c.addEventListener("click", function (e) { e.preventDefault(); go("/artist/" + ar.id); });
  return c;
}
function songCard(t) {
  var c = document.createElement("a");
  c.className = "qz-fy-card"; c.href = "/album/" + t.albumId;
  c.innerHTML = '<div class="qz-fy-art"><img loading="lazy" src="' + (t.cover || "") + '" alt="">' + playBtnHTML() + '</div>' +
    '<div class="qz-fy-t">' + esc(t.title || "") + '</div><div class="qz-fy-s">' + esc(t.artist || "") + '</div>';
  var pb = c.querySelector(".qz-fy-play"); if (pb && t.albumId) pb.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); playTrack(t.albumId, t.title, t.trackNumber); });
  c.addEventListener("click", function (e) { e.preventDefault(); if (t.albumId) go("/album/" + t.albumId); });
  return c;
}
function playlistCard(pl) {
  var c = document.createElement("a");
  c.className = "qz-fy-card"; c.href = "/playlist/" + pl.id;
  var img = (pl.images300 && pl.images300[0]) || coverUrl(pl);
  c.innerHTML = '<div class="qz-fy-art"><img loading="lazy" src="' + img + '" alt="">' + playBtnHTML() + '</div>' +
    '<div class="qz-fy-t">' + esc(pl.name || pl.title || "") + '</div><div class="qz-fy-s">Playlist</div>';
  var pb = c.querySelector(".qz-fy-play"); if (pb) pb.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); playEntity("/playlist/" + pl.id); });
  c.addEventListener("click", function (e) { e.preventDefault(); go("/playlist/" + pl.id); });
  return c;
}
function row(title, subtitle) {
  var sec = document.createElement("section");
  sec.className = "qz-fy-row";
  sec.innerHTML =
    '<div class="qz-fy-rowhead"><div class="qz-fy-rowtitle">' + esc(title) + "</div>" +
    (subtitle ? '<div class="qz-fy-rowsub">' + esc(subtitle) + "</div>" : "") + "</div>" +
    '<div class="qz-fy-track"><div class="qz-fy-skel"></div><div class="qz-fy-skel"></div><div class="qz-fy-skel"></div>' +
    '<div class="qz-fy-skel"></div><div class="qz-fy-skel"></div><div class="qz-fy-skel"></div></div>';
  sec.fill = function (cards) {
    var t = sec.querySelector(".qz-fy-track");
    if (!cards || !cards.length) { sec.remove(); return; }
    t.innerHTML = "";
    cards.forEach(function (c) { if (c) t.appendChild(c); });
  };
  return sec;
}
function heroSpot(al, kind) {
  var s = document.createElement("section"); s.className = "qz-fy-spot";
  s.innerHTML =
    '<a class="qz-fy-spotart" href="/album/' + al.id + '"><img loading="lazy" src="' + coverUrl(al) + '" alt="">' + badge(al) + '</a>' +
    '<div class="qz-fy-spotinfo"><div class="qz-fy-spotkind">' + esc(kind || "Top pick for you") + '</div>' +
    '<a class="qz-fy-spotname" href="/album/' + al.id + '">' + esc(al.title || "") + '</a>' +
    '<div class="qz-fy-spotsub">' + esc(albumArtistName(al)) + (rel(al) ? " &middot; " + new Date(rel(al) * 1000).getFullYear() : "") + '</div>' +
    '<button class="qz-fy-spotbtn"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>Play</button>' +
    '<button class="qz-fy-spotshuffle" title="Show me another">' + FY_SHUFFLE + 'Shuffle pick</button></div>';
  s.querySelectorAll("a").forEach(function (a) { a.addEventListener("click", function (e) { e.preventDefault(); go("/album/" + al.id); }); });
  s.querySelector(".qz-fy-spotbtn").addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); playEntity("/album/" + al.id); });
  s.querySelector(".qz-fy-spotshuffle").addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); var sh = page && page.querySelector(".qz-fy-spot-host"); if (sh) rotateHero(sh); });
  return s;
}
// Rotating spotlight: pick a fresh candidate (never the one just shown) from the hero pool (your
// favorite albums + new releases from artists you love). Rotates on every For You open + the Shuffle
// button, and remembers the last pick across sessions so it doesn't get stuck on one album forever.
function rotateHero(spotHost) {
  if (!spotHost || !heroPool.length) return;
  var last = heroLastId != null ? heroLastId : Q.storage.get("hero:last", null);
  var choices = heroPool;
  if (heroPool.length > 1 && last != null) { choices = heroPool.filter(function (x) { return String(x.al.id) !== String(last); }); if (!choices.length) choices = heroPool; }
  var pick = choices[Math.floor(Math.random() * choices.length)];
  heroLastId = pick.al.id; try { Q.storage.set("hero:last", String(pick.al.id)); } catch (e) {}
  spotHost.innerHTML = "";
  spotHost.appendChild(heroSpot(pick.al, pick.kind));
}

// --- "Made for you": auto-curated mixes from what you've been playing ---
Q.css("qz-fy-mix-css", [
  ".qz-fy-mixart{position:relative;background:linear-gradient(135deg,#1a2634,#0d151d);}",
  ".qz-fy-mixart img{filter:saturate(1.12) brightness(.78);}",
  ".qz-fy-mixcollage{position:absolute;inset:0;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;}",
  ".qz-fy-mixcollage img{width:100%;height:100%;object-fit:cover;display:block;}",
  ".qz-fy-mixgrad{position:absolute;inset:0;background:linear-gradient(180deg,transparent 38%,rgba(6,9,13,.88));z-index:1;}",
  ".qz-fy-mixlabel{position:absolute;left:11px;right:11px;bottom:10px;z-index:2;font-size:15px;font-weight:850;color:#fff;text-shadow:0 2px 10px rgba(0,0,0,.7);line-height:1.15;}",
  ".qz-fy-mixspin{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(6,9,13,.55);z-index:3;}",
  ".qz-fy-mixspin::after{content:'';width:34px;height:34px;border-radius:50%;border:3px solid rgba(255,255,255,.22);border-top-color:var(--qz-accent,#3DA8FE);animation:qz-fy-mspin .8s linear infinite;}",
  ".qz-fy-building .qz-fy-mixspin{display:flex;}",
  "@keyframes qz-fy-mspin{to{transform:rotate(360deg)}}"
].join(""));
function artistTopTracks(id) { return api("artist/get?artist_id=" + id + "&extra=tracks&limit=12").then(function (j) { var t = j.tracks; return (t && (t.items || t)) || []; }).catch(function () { return []; }); }
function createPlaylist(name, desc) { return api("playlist/create?name=" + encodeURIComponent(name) + "&is_public=false&description=" + encodeURIComponent(desc || "")).then(function (c) { return String(c.id); }); }
function fillPlaylist(pid, ids) { return api("playlist/addTracks?playlist_id=" + pid + "&track_ids=" + ids.join(",")); }
function deletePlaylist(pid) { return api("playlist/delete?playlist_id=" + pid).catch(function () {}); }
// recent top artists come from the Stats logger (real recency); fall back to favorites if it's not loaded
function statsTopArtists() {
  try { if (window.__QZ_STATS && window.__QZ_STATS.stats) return window.__QZ_STATS.stats("1M").then(function (a) { return (a.topArtists || []).filter(function (x) { return x.artistId; }).slice(0, 8); }).catch(function () { return favFallback(); }); } catch (e) {}
  return favFallback();
}
function favFallback() { return favArtists().then(function (fa) { return fa.slice(0, 8).map(function (a) { return { name: a.name, artistId: a.id, cover: coverUrl(a) }; }); }, function () { return []; }); }
// build a playlist from seed artists (+ their similars' top tracks), excluding what you just heard, then play it.
// "just heard" = our own play log (synchronous); __QZ_STATS has no .recent property - its recents
// live behind an async aggregate, so don't reach for the stats global here.
function buildMix(seedIds, name, themeKey) {
  var exclude = {}; try { readLog("tracks").forEach(function (p) { if (p && p.id) exclude[p.id] = 1; }); } catch (e) {}
  return pool(seedIds.slice(0, 6), 4, function (id) { return Promise.all([artistTopTracks(id), similarArtists(id)]).then(function (r) { return { top: r[0] || [], sims: (r[1] || []).slice(0, 3) }; }); }).then(function (buckets) {
    var simIds = {}; buckets.forEach(function (b) { b.sims.forEach(function (a) { simIds[a.id] = 1; }); });
    return pool(Object.keys(simIds).slice(0, 10), 4, artistTopTracks).then(function (simTracks) {
      var all = []; buckets.forEach(function (b) { all = all.concat(b.top); }); (simTracks || []).forEach(function (t) { all = all.concat(t || []); });
      var seen = {}, ids = []; all.forEach(function (t) { if (t && t.id && !seen[t.id] && !exclude[t.id] && t.streamable !== false) { seen[t.id] = 1; ids.push(t.id); } });
      for (var i = ids.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp; }
      ids = ids.slice(0, 40); if (!ids.length) return null;
      return createPlaylist(name, "Made for you by Qobuzify").then(function (pid) {
        return fillPlaylist(pid, ids).then(function () {
          var oldPid = Q.storage.get("mix:" + themeKey, null); Q.storage.set("mix:" + themeKey, pid);
          if (oldPid && oldPid !== pid) setTimeout(function () { deletePlaylist(oldPid); }, 8000);
          return pid;
        });
      });
    });
  });
}
// Daily Mix gets a 2x2 collage of its top artists' covers so it reads as a "mix" and never looks
// identical to a single-artist mix card sitting right next to it. Single-artist mixes keep one cover.
function mixArtInner(theme) {
  var covers = (theme.covers || []).filter(Boolean);
  if (covers.length >= 2) {
    var four = covers.slice(0, 4);
    for (var i = 0; four.length < 4; i++) four.push(covers[i % covers.length]);
    return '<div class="qz-fy-mixcollage">' + four.map(function (u) { return '<img loading="lazy" src="' + esc(u) + '" alt="">'; }).join("") + "</div>";
  }
  return theme.cover ? '<img loading="lazy" src="' + esc(theme.cover) + '" alt="">' : "";
}
function mixCard(theme) {
  var c = document.createElement("div"); c.className = "qz-fy-card qz-fy-mixcard";
  c.innerHTML = '<div class="qz-fy-art qz-fy-mixart">' + mixArtInner(theme) + '<div class="qz-fy-mixgrad"></div><div class="qz-fy-mixlabel">' + esc(theme.badge || theme.title) + "</div>" + playBtnHTML() + '<div class="qz-fy-mixspin"></div></div>' +
    '<div class="qz-fy-cardtitle">' + esc(theme.title) + '</div><div class="qz-fy-cardsub">' + esc(theme.sub || "") + "</div>";
  function build() {
    if (c.classList.contains("qz-fy-building")) return;
    c.classList.add("qz-fy-building");
    buildMix(theme.seeds, theme.title, theme.key).then(function (pid) { c.classList.remove("qz-fy-building"); if (pid) playEntity("/playlist/" + pid); }, function () { c.classList.remove("qz-fy-building"); });
  }
  var pb = c.querySelector(".qz-fy-play"); if (pb) pb.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); build(); });
  c.addEventListener("click", function (e) { e.preventDefault(); build(); });
  return c;
}
function buildMadeForYou(rowsHost) {
  var sec = row("Made for you", "Fresh mixes built from what you've been playing - tap to play");
  rowsHost.insertBefore(sec, rowsHost.firstChild);
  statsTopArtists().then(function (tops) {
    if (!tops || !tops.length) { sec.remove(); return; }
    var cards = [];
    cards.push(mixCard({ key: "daily", title: "Daily Mix", badge: "Daily Mix", sub: tops.slice(0, 4).map(function (a) { return a.name; }).join(" · "), seeds: tops.slice(0, 6).map(function (a) { return a.artistId; }), covers: tops.slice(0, 4).map(function (a) { return a.cover; }).filter(Boolean), cover: tops[0].cover }));
    tops.slice(0, 3).forEach(function (a) { cards.push(mixCard({ key: "art-" + a.artistId, title: a.name + " Mix", badge: a.name, sub: "Because you've been into them", seeds: [a.artistId], cover: a.cover })); });
    sec.fill(cards);
  }, function () { sec.remove(); });
}

// --- the recommendation build ---
function buildSections(scroll) {
  var spotHost = scroll.querySelector(".qz-fy-spot-host");
  var rowsHost = scroll.querySelector(".qz-fy-rows-host");
  buildMadeForYou(rowsHost);
  var sNew = row("New from artists you love", "Latest releases from your favorites");
  rowsHost.appendChild(sNew);
  var becauseHost = document.createElement("div");
  rowsHost.appendChild(becauseHost);
  var sArtists = row("Artists you might like", "Similar to the artists you love");
  rowsHost.appendChild(sArtists);
  var sFresh = row("Fresh for you", "New on Qobuz");
  rowsHost.appendChild(sFresh);

  favArtists().then(function (fa) {
    var seeds = fa.slice(0, 4);

    // New from artists you love + build the ROTATING hero pool
    pool(fa.slice(0, 16), 5, function (a) { return artistAlbums(a.id); }).then(function (lists) {
      var albums = [];
      lists.forEach(function (al) { if (al && al.length) { al.sort(byNewest); albums.push(al[0]); } });
      albums = dedupe(albums.filter(streamable), function (a) { return a.id; }).sort(byNewest).slice(0, 18);
      sNew.fill(albums.map(albumCard));
      // Hero pool = your favorite albums (rediscovery) + these new releases (discovery), rotated each visit
      favAlbums().then(function (favA) {
        var cands = [];
        (favA || []).forEach(function (a) { if (streamable(a) && coverUrl(a)) cands.push({ al: a, kind: "From your favorites" }); });
        albums.slice(0, 12).forEach(function (a) { cands.push({ al: a, kind: "New for you" }); });
        heroPool = dedupe(cands, function (x) { return x.al.id; });
        if (spotHost) rotateHero(spotHost);
      }, function () { heroPool = albums.slice(0, 12).map(function (a) { return { al: a, kind: "New for you" }; }); if (spotHost) rotateHero(spotHost); });
    });

    // Because you like {seed}
    seeds.slice(0, 3).forEach(function (seed) {
      var sec = row("Because you like " + (seed.name || ""), "Artists in the same orbit");
      becauseHost.appendChild(sec);
      similarArtists(seed.id).then(function (sims) {
        return pool(sims.slice(0, 8), 5, function (sa) { return artistAlbums(sa.id).then(function (al) { al.sort(byNewest); return al[0]; }); });
      }).then(function (albums) {
        albums = dedupe((albums || []).filter(streamable), function (a) { return a.id; }).slice(0, 14);
        sec.fill(albums.map(albumCard));
      }, function () { sec.remove(); });
    });

    // Artists you might like: aggregate similar artists across seeds, score by frequency
    var favIds = {}; fa.forEach(function (a) { favIds[a.id] = 1; });
    pool(seeds, 4, function (s) { return similarArtists(s.id); }).then(function (lists) {
      var score = {}, byId = {};
      (lists || []).forEach(function (l) { (l || []).forEach(function (a) { if (favIds[a.id]) return; score[a.id] = (score[a.id] || 0) + 1; byId[a.id] = a; }); });
      var ranked = Object.keys(score).sort(function (x, y) { return score[y] - score[x]; }).map(function (id) { return byId[id]; }).slice(0, 16);
      sArtists.fill(ranked.map(artistCard));
    });
  }, function () { sNew.remove(); });

  featuredNew().then(function (albums) {
    sFresh.fill(dedupe(albums.filter(streamable), function (a) { return a.id; }).slice(0, 18).map(albumCard));
  }, function () { sFresh.remove(); });
}

// --- recent-activity log ("In your rotation") ---
function readLog(k) { try { return JSON.parse(Q.storage.get("recent:" + k, "[]")) || []; } catch (e) { return []; } }
function writeLog(k, a) { Q.storage.set("recent:" + k, JSON.stringify(a)); }
function nowMs() { try { return Date.now(); } catch (e) { return 0; } }
// The track's real performer id. The player-bar DOM (.player's first /artist/ link) isn't reliably the
// track's main performer - on the web player it can point at a featured or a different artist that
// merely SHARES THE NAME, and that wrong id then seeds the rotation rail, promoting the wrong artist.
// track/get's `performer` is the authoritative identity, so disambiguate by that id, not a name/DOM guess.
function authoritativeArtistId(t) {
  if (!t || !t.id) return Promise.resolve(null);
  return api("track/get?track_id=" + t.id).then(function (j) {
    var p = (j && (j.performer || (j.album && j.album.artist))) || null;
    return (p && p.id != null) ? String(p.id) : null;
  }, function () { return null; });
}
function bump(kind, id) { if (!id) return; var arr = readLog(kind).filter(function (x) { return x.id !== id; }); arr.unshift({ id: id, t: nowMs() }); writeLog(kind, arr.slice(0, 20)); }
function logTrack(t) {
  if (!t || !t.id) return;
  var arr = readLog("tracks").filter(function (x) { return x.id !== t.id; });
  // log the play immediately with no artist id, then patch in the AUTHORITATIVE performer id once the
  // API resolves. Never seed from the player-bar scrape: a wrong same-named id shown even briefly is
  // exactly the "wrong artist" bug. null just means the artist card holds off for a beat, then corrects.
  arr.unshift({ id: t.id, title: t.title, artist: t.artist, artistId: null, albumId: t.albumId, cover: t.cover, trackNumber: t.trackNumber || t.track_number, t: nowMs() });
  writeLog("tracks", arr.slice(0, 40));
  if (active) refreshRotation();
  authoritativeArtistId(t).then(function (aid) {
    if (!aid) return;
    var log = readLog("tracks");
    for (var i = 0; i < log.length; i++) {
      if (log[i].id === t.id) { if (log[i].artistId !== aid) { log[i].artistId = aid; writeLog("tracks", log); if (active) refreshRotation(); } break; }
    }
  });
}
function logRoute(path) {
  var m;
  if ((m = (path || "").match(/\/artist\/(\d+)/))) bump("artists", m[1]);
  else if ((m = (path || "").match(/\/playlist\/([^/?#]+)/))) bump("playlists", m[1]);
}
function seedRecentTracks() {
  if (readLog("tracks").length >= 5) return;
  var hist = []; try { hist = (Q.getState().playqueue && Q.getState().playqueue.history) || []; } catch (e) {}
  var seen = {}, ids = [];
  for (var i = hist.length - 1; i >= 0 && ids.length < 10; i--) { var id = hist[i]; if (id && !seen[id]) { seen[id] = 1; ids.push(id); } }
  if (!ids.length) return;
  pool(ids, 4, function (id) { return api("track/get?track_id=" + id).catch(function () { return null; }); }).then(function (tracks) {
    var log = readLog("tracks"), byId = {}; log.forEach(function (x) { byId[x.id] = 1; });
    tracks.filter(Boolean).forEach(function (t) { if (byId[t.id]) return; log.push({ id: t.id, title: t.title, artist: (t.performer && t.performer.name) || "", artistId: t.performer && t.performer.id, albumId: t.album && t.album.id, cover: t.album && coverUrl(t.album), trackNumber: t.track_number, t: 0 }); });
    writeLog("tracks", log.slice(0, 40));
    if (active) refreshRotation();
  });
}
function resolveArtist(id) { return api("artist/get?artist_id=" + id + "&limit=0").then(function (j) { return { id: id, name: j.name, picture: j.picture, image: j.image }; }).catch(function () { return null; }); }
function resolvePlaylist(id) { return api("playlist/get?playlist_id=" + id + "&limit=0").then(function (j) { return { id: id, name: j.name, images300: j.images300, image: j.image }; }).catch(function () { return null; }); }

function refreshRotation() {
  var host = page && page.querySelector(".qz-fy-rot-host"); if (!host) return;
  var tracks = readLog("tracks");
  // songs: dedupe by album and cap to 2 per artist, so one album or artist can't flood the row with
  // near-identical covers (the old behaviour showed 6 tracks off the same album). remember which
  // artists we've already shown as a song so we don't also show their artist card below.
  var songItems = [], albSeen = {}, artCount = {}, songArtists = {};
  tracks.forEach(function (t) {
    if (!t.albumId || albSeen[t.albumId]) return;
    var aid = t.artistId || ("n:" + (t.artist || ""));
    if ((artCount[aid] || 0) >= 2) return;
    albSeen[t.albumId] = 1; artCount[aid] = (artCount[aid] || 0) + 1;
    if (t.artistId) songArtists[t.artistId] = 1;
    songItems.push({ kind: "song", t: t.t || 0, obj: t });
  });
  songItems = songItems.slice(0, 8);
  var artistIds = [], aseen = {};
  tracks.forEach(function (t) { if (t.artistId && !aseen[t.artistId] && !songArtists[t.artistId]) { aseen[t.artistId] = 1; artistIds.push({ id: t.artistId, t: t.t || 0 }); } });
  readLog("artists").forEach(function (x) { if (!aseen[x.id] && !songArtists[x.id]) { aseen[x.id] = 1; artistIds.push(x); } });
  artistIds.sort(function (a, b) { return (b.t || 0) - (a.t || 0); });
  var plLog = readLog("playlists").slice(0, 6);
  Promise.all([
    pool(artistIds.slice(0, 6), 4, function (x) { return resolveArtist(x.id).then(function (a) { return a ? { kind: "artist", t: x.t, obj: a } : null; }); }),
    pool(plLog, 4, function (x) { return resolvePlaylist(x.id).then(function (p) { return p ? { kind: "playlist", t: x.t, obj: p } : null; }); })
  ]).then(function (res) {
    if (!active) return;
    var items = songItems.slice();
    (res[0] || []).filter(Boolean).forEach(function (x) { items.push(x); });
    (res[1] || []).filter(Boolean).forEach(function (x) { items.push(x); });
    items.sort(function (a, b) { return (b.t || 0) - (a.t || 0); });
    items = items.slice(0, 16);
    host.innerHTML = "";
    if (!items.length) return;
    var sec = document.createElement("section"); sec.className = "qz-fy-row"; sec.id = "qz-fy-rotation";
    sec.innerHTML = '<div class="qz-fy-rowhead"><div class="qz-fy-rowtitle">In your rotation</div><div class="qz-fy-rowsub">Pick up where you left off</div></div><div class="qz-fy-track"></div>';
    var track = sec.querySelector(".qz-fy-track");
    items.forEach(function (it) { track.appendChild(it.kind === "song" ? songCard(it.obj) : it.kind === "artist" ? artistCard(it.obj) : playlistCard(it.obj)); });
    host.appendChild(sec);
  });
}

// --- page shell + geometry ---
function ensurePage() {
  if (page) return page;
  page = document.createElement("div");
  page.id = PAGE_ID;
  page.innerHTML =
    '<div class="qz-fy-inner">' +
      '<div class="qz-fy-hero"><div class="qz-fy-h1">For You</div>' +
      '<div class="qz-fy-h2">Built from your favorites and listening - no algorithms phoning home.</div></div>' +
      '<div class="qz-fy-scroll"><div class="qz-fy-spot-host"></div><div class="qz-fy-rot-host"></div><div class="qz-fy-rows-host"></div></div>' +
    "</div>";
  return page;
}
// Fill the native content scroll region (below the top nav, above the player), same as better-search.
function contentRect() {
  var sc = document.querySelector(".ui-layout--root--scroll-main") || document.querySelector(".ui-layout--root--main") || document.querySelector(".ui-scroll");
  if (sc) { var r = sc.getBoundingClientRect(); if (r.width > 200 && r.height > 200) return { left: r.left, top: r.top, width: r.width, height: r.height }; }
  var nav = document.querySelector(".NavBar"), player = document.querySelector(".player");
  var top = nav ? nav.getBoundingClientRect().bottom : 56;
  var bottom = player ? player.getBoundingClientRect().top : window.innerHeight - 78;
  return { left: 0, top: top, width: window.innerWidth, height: Math.max(220, bottom - top) };
}
function placePage() { if (!page) return; var r = contentRect(); page.style.left = r.left + "px"; page.style.top = r.top + "px"; page.style.width = r.width + "px"; page.style.height = r.height + "px"; }
// host the overlay inside the app layout (as a sibling of the panels) instead of document.body, so
// its z-index (220, under the z:250 nav/player panels) lets Qobuz's native dropdowns - the
// account/pfp menu, track "More actions", context menus - open above it. A body-level max z covered them.
function layoutHost() { var pt = document.querySelector(".ui-layout--root--panel-top"); return (pt && pt.parentElement) || document.body; }
function open() {
  active = true;
  var p = ensurePage();
  var host = layoutHost();
  if (p.parentElement !== host) host.appendChild(p);
  placePage();
  p.style.display = "block";
  var sc = p.querySelector(".qz-fy-scroll"); if (sc) sc.scrollTop = 0;
  if (!loaded) { loaded = true; buildSections(p.querySelector(".qz-fy-scroll")); }
  else { var sh = p.querySelector(".qz-fy-spot-host"); if (sh) rotateHero(sh); } // fresh Top pick each visit
  refreshRotation();
  setActive(true);
  window.addEventListener("resize", placePage);
  if (!reassertObs) reassertObs = Q.observe(function () { injectNav(); hookLogo(); if (active) { var h = layoutHost(); if (page && page.parentElement !== h) h.appendChild(page); placePage(); setActive(true); } }, { debounce: 300 });
}
function close() {
  if (!active) return;
  active = false;
  if (page) page.style.display = "none";
  window.removeEventListener("resize", placePage);
  if (reassertObs) { reassertObs(); reassertObs = null; }
  setActive(false);
}

// --- nav row item (first position, before Discover) ---
function injectNav() {
  var row = document.querySelector(".NavBar__items");
  if (!row) return;
  var existing = row.querySelector('[data-qz-nav="' + NAV_ID + '"]');
  if (existing) { if (row.firstElementChild !== existing) row.insertBefore(existing, row.firstChild); return; }
  var wrap = document.createElement("div");
  wrap.className = "ui-block-nav-item flex w-full relative rounded-md cursor-pointer select-none transition-colors duration-200 outline-1 -outline-offset-1 outline-transparent hover:bg-surface-default-secondary qz-fy-navwrap";
  wrap.setAttribute("data-qz-nav", NAV_ID);
  wrap.innerHTML = '<a class="ui-link flex w-full items-center gap-8 px-12 py-8 rounded-md transition-colors duration-200 qz-fy-navlink" data-type="router-link" href="/foryou">' + FY_ICON + '<span>For You</span></a>';
  wrap.querySelector("a").addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); open(); });
  row.insertBefore(wrap, row.firstChild);
}
function setActive(on) {
  var wrap = document.querySelector('[data-qz-nav="' + NAV_ID + '"]');
  if (wrap) wrap.classList.toggle("qz-fy-navactive", on);
  // while For You is open, suppress the native route-item highlight so there aren't two active tabs
  var natives = document.querySelectorAll(".NavBar__items .ui-block-nav-item:not([data-qz-nav])");
  for (var i = 0; i < natives.length; i++) natives[i].classList.toggle("qz-fy-suppress", on);
}
// make the Qobuz logo (home) open For You instead of Discover
function hookLogo() {
  var b = document.querySelector(".NavBar__brand");
  if (b && !b.__qzForYou) { b.__qzForYou = 1; b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); open(); }, true); }
}
// For You sits over whatever route is underneath (usually /discover on launch), so clicking the
// Discover tab is a same-route nav that fires no onRoute, and the overlay would just stay up. So we
// delegate: clicking any other nav tab or the search bar closes For You and reveals that destination.
// The logo is excluded (it opens For You), and so is our own tab.
function onDocClick(e) {
  if (!active) return;
  var t = e.target; if (!t || !t.closest) return;
  if (t.closest('[data-qz-nav="' + NAV_ID + '"]') || t.closest(".NavBar__brand")) return;
  if (t.closest(".NavBar__items") || t.closest(".SearchBar")) close();
}
// on app launch, land on For You
function bootOpen() {
  if (booted) return;
  if (!document.querySelector(".NavBar__items")) return;
  booted = true;
  injectNav(); hookLogo();
  open();
}

Q.css(CSS_ID, [
  // page
  "#" + PAGE_ID + "{position:fixed;z-index:220;overflow:auto;color:#eef2f7;",
  "background:radial-gradient(120% 80% at 80% -10%,rgba(61,168,254,.10),transparent 60%),linear-gradient(180deg,#0a0e17,#080b12 55%);",
  "scrollbar-width:thin;}",
  "#" + PAGE_ID + "::-webkit-scrollbar{width:11px;}#" + PAGE_ID + "::-webkit-scrollbar-thumb{background:rgba(255,255,255,.13);border-radius:9px;}",
  ".qz-fy-inner{min-height:100%;}",
  ".qz-fy-hero{padding:34px 40px 6px;max-width:1500px;margin:0 auto;}",
  ".qz-fy-h1{font-size:36px;font-weight:850;letter-spacing:-.6px;color:#fff;background:linear-gradient(92deg,#fff,var(--qz-accent,#3DA8FE));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;}",
  ".qz-fy-h2{margin-top:7px;font-size:14px;color:#98a2b3;}",
  ".qz-fy-scroll{padding:6px 40px 60px;max-width:1500px;margin:0 auto;}",
  // hero spotlight (Top pick)
  ".qz-fy-spot{display:flex;align-items:center;gap:26px;margin:20px 0 6px;padding:22px;border-radius:18px;background:linear-gradient(120deg,rgba(255,255,255,.07),rgba(255,255,255,.015));border:1px solid rgba(255,255,255,.07);}",
  ".qz-fy-spotart{position:relative;flex:0 0 auto;width:168px;height:168px;border-radius:14px;overflow:hidden;box-shadow:0 16px 40px -14px rgba(0,0,0,.7);text-decoration:none;}",
  ".qz-fy-spotart img{width:100%;height:100%;object-fit:cover;display:block;}",
  ".qz-fy-spotinfo{min-width:0;display:flex;flex-direction:column;gap:7px;}",
  ".qz-fy-spotkind{font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.7px;color:var(--qz-accent,#3DA8FE);}",
  ".qz-fy-spotname{font-size:34px;font-weight:850;letter-spacing:-.6px;color:#fff;text-decoration:none;line-height:1.03;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}",
  ".qz-fy-spotname:hover{text-decoration:underline;}",
  ".qz-fy-spotsub{font-size:14px;color:#9aa3b2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".qz-fy-spotbtn{margin-top:8px;align-self:flex-start;display:inline-flex;align-items:center;gap:8px;border:0;border-radius:26px;background:var(--qz-accent,#3DA8FE);color:#06090a;font:inherit;font-size:14px;font-weight:800;padding:11px 24px;cursor:pointer;transition:transform .12s,filter .12s;box-shadow:0 10px 26px -10px var(--qz-accent,#3DA8FE);}",
  ".qz-fy-spotbtn:hover{transform:scale(1.04);filter:brightness(1.06);}.qz-fy-spotbtn svg{width:17px;height:17px;}",
  ".qz-fy-spotshuffle{margin-top:10px;align-self:flex-start;display:inline-flex;align-items:center;gap:7px;border:0;background:transparent;color:#8b94a3;font:inherit;font-size:12.5px;font-weight:650;padding:2px 0;cursor:pointer;transition:color .12s;}",
  ".qz-fy-spotshuffle:hover{color:var(--qz-accent,#3DA8FE);}.qz-fy-spotshuffle svg{width:14px;height:14px;}",
  // rows
  ".qz-fy-row{margin:28px 0 6px;}",
  ".qz-fy-rowhead{display:flex;align-items:baseline;gap:12px;margin-bottom:14px;}",
  ".qz-fy-rowtitle{font-size:20px;font-weight:800;letter-spacing:-.2px;color:#eef2f7;}",
  ".qz-fy-rowsub{font-size:12.5px;color:#8b94a3;}",
  // fixed-ish card width: cap the max so a sparse row (few items, e.g. a fresh account's history)
  // can't stretch one card to the full row width. 1fr used to balloon a single card to giant size.
  ".qz-fy-track{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(158px,190px);grid-template-rows:1fr;gap:20px;overflow-x:auto;overflow-y:hidden;padding-bottom:12px;scroll-snap-type:x proximity;scrollbar-width:thin;}",
  ".qz-fy-track::-webkit-scrollbar{height:9px;}.qz-fy-track::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:9px;}",
  ".qz-fy-card{display:block;text-decoration:none;scroll-snap-align:start;cursor:pointer;min-width:0;}",
  ".qz-fy-art{position:relative;width:100%;aspect-ratio:1;border-radius:12px;overflow:hidden;background:rgba(255,255,255,.05);box-shadow:0 10px 28px -14px rgba(0,0,0,.8);transition:transform .16s,box-shadow .16s;}",
  ".qz-fy-card:hover .qz-fy-art{transform:translateY(-4px);box-shadow:0 18px 40px -16px var(--qz-accent,#3DA8FE);}",
  ".qz-fy-art--round{border-radius:50%;}",
  ".qz-fy-art img{width:100%;height:100%;object-fit:cover;display:block;}",
  ".qz-fy-t{margin-top:10px;font-size:13.5px;font-weight:700;color:#e7ecf3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}",
  ".qz-fy-card--artist .qz-fy-t{text-align:center;}",
  ".qz-fy-s{margin-top:2px;font-size:12px;color:#8b94a3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}",
  ".qz-fy-card--artist .qz-fy-s{text-align:center;}",
  // Hi-Res badge
  ".qz-fy-badge{position:absolute;top:8px;left:8px;font-size:9.5px;font-weight:800;letter-spacing:.3px;padding:2px 7px;border-radius:5px;color:#06090a;background:var(--qz-accent,#3DA8FE);filter:drop-shadow(0 2px 4px rgba(0,0,0,.6));}",
  // hover play button (albums/playlists/songs)
  ".qz-fy-play{position:absolute;right:9px;bottom:9px;width:44px;height:44px;border:0;border-radius:50%;background:var(--qz-accent,#3DA8FE);color:#06090a;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;transform:translateY(8px) scale(.85);transition:opacity .15s,transform .15s;box-shadow:0 8px 20px rgba(0,0,0,.5);}",
  ".qz-fy-play svg{width:21px;height:21px;margin-left:2px;}",
  ".qz-fy-card:hover .qz-fy-play{opacity:1;transform:translateY(0) scale(1);}.qz-fy-play:hover{filter:brightness(1.08);}",
  // skeletons
  ".qz-fy-skel{width:100%;aspect-ratio:1;border-radius:12px;background:linear-gradient(100deg,rgba(255,255,255,.05) 30%,rgba(255,255,255,.11) 50%,rgba(255,255,255,.05) 70%);background-size:200% 100%;animation:qz-fy-sh 1.3s linear infinite;}",
  "@keyframes qz-fy-sh{0%{background-position:200% 0}100%{background-position:-200% 0}}",
  // nav item
  ".qz-fy-navicon{flex:0 0 auto;}",
  ".qz-fy-navlink,.qz-fy-navlink span{white-space:nowrap;}",
  ".qz-fy-navwrap.qz-fy-navactive{background:rgba(255,255,255,.09)!important;outline-color:rgba(255,255,255,.14)!important;}",
  ".qz-fy-suppress{background-color:transparent!important;outline-color:transparent!important;}"
].join(""));

// recent-activity logger (always on, feeds "In your rotation")
var offTrack = Q.player.onChange(logTrack);
seedRecentTracks();
var offRoute = Q.onRoute(function (path) { close(); logRoute(path); });
document.addEventListener("click", onDocClick, true);
// inject the nav item + open on launch (retry briefly until the nav row mounts)
injectNav(); hookLogo();
var bootIv = setInterval(function () { injectNav(); hookLogo(); bootOpen(); if (booted) clearInterval(bootIv); }, 250);
var bootObs = Q.observe(function () { injectNav(); hookLogo(); bootOpen(); }, { debounce: 200 });

return function cleanup() {
  clearInterval(bootIv);
  if (bootObs) bootObs();
  document.removeEventListener("click", onDocClick, true);
  if (offRoute) offRoute();
  if (offTrack) offTrack();
  if (reassertObs) { reassertObs(); reassertObs = null; }
  window.removeEventListener("resize", placePage);
  active = false;
  var nav = document.querySelector('[data-qz-nav="' + NAV_ID + '"]'); if (nav) nav.remove();
  if (page) { page.remove(); page = null; }
  loaded = false; booted = false;
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
