// Qobuz greys out any track that isn't streamable in your country: the row goes dim and its play
// button stops working, with no way forward. This drops a small accent-coloured button onto those
// dead rows. Click it and it searches the catalog for the same song, keeps only the versions that
// actually stream for you (a different release, a remaster, a non-region-locked upload), and plays
// the best match. A greyed-out track in a playlist stops being a dead end.
//
// The audio engine is sealed, so "play" is the usual Qobuzify move: open the match's album, find its
// row by title, and click the native play button. Runs as function(Qobuzify){ ... return cleanup }.
var Q = Qobuzify;
var CSS_ID = "qz-fav-css";
var BTN = "qz-fav-btn";
var reqId = 0;

// knockoff / wrong-recording versions to push down so the real song wins (same list better-search
// uses). Live/acoustic/unplugged are left off on purpose - those are legit alternate takes.
var COVER_RE = /karaoke|instrumental|originally performed|in the style of|made famous|tribute|backing track|cover version|8 ?bit|ringtone|lullaby|piano cover|remake/i;

function norm(s) { return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[‘’'`]/g, "").replace(/\s+/g, " ").trim(); }
// strip "(feat. X)" and a trailing " - Remastered / Live / 2011 Mix" so two pressings of the same
// song compare equal. Keep the core title only.
function titleCore(s) { return norm(s).replace(/\((?:feat|with|ft|prod)\.?[^)]*\)/g, "").replace(/\s*[-–—][^-–—]*$/, "").replace(/\s+/g, " ").trim(); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

function rowInfo(row) {
  // .ListItem__title is the clean song title on dwp-ui rows; the classic .track-list used in the
  // Library, search and artist pages puts the title in .track-name (a span whose textContent is just
  // the title - the artist sits in a separate .track-artist cell, so it isn't glued on). Don't fall
  // back to .ListItem__titleWithArtists as a sibling in one querySelector - that element is the title's
  // PARENT and its textContent glues the artist onto the end ("SongThe Beatles"), poisoning the query.
  var te = row.querySelector(".ListItem__title") || row.querySelector(".track-name");
  var title = te ? te.textContent.trim() : "";
  if (!title) { var alt = row.querySelector(".ListItem__titleWithArtists"); title = alt ? alt.textContent.trim() : ""; }
  var ae = row.querySelector('a[href*="/artist/"]');
  var artist = ae ? ae.textContent.trim() : "";
  return { title: title, artist: artist };
}

// score a search hit against the dead track's title+artist. Returns <=0 to drop it entirely.
function scoreCand(it, tCore, aNorm) {
  var nm = norm(it.title || "");
  var core = titleCore(it.title || "");
  var artist = norm((it.performer && it.performer.name) || "");
  var s = 0;
  if (core === tCore) s += 100;
  else if (tCore && core && (core.indexOf(tCore) >= 0 || tCore.indexOf(core) >= 0)) s += 55;
  else return -1; // title has to be in the ballpark or it's a different song
  if (aNorm) {
    if (artist === aNorm) s += 60;
    else if (artist.indexOf(aNorm) >= 0 || aNorm.indexOf(artist) >= 0) s += 35;
    else s -= 30; // named a different artist - probably a cover
  }
  if (COVER_RE.test(nm)) s -= 70;
  if (it.hires) s += 4; // tie-break toward the better master
  return s;
}

function findVersions(info) {
  var q = [info.artist, info.title].filter(Boolean).join(" ");
  var tCore = titleCore(info.title), aNorm = norm(info.artist);
  return Q.api("catalog/search?query=" + encodeURIComponent(q) + "&limit=30").then(function (j) {
    var items = (j.tracks && j.tracks.items) || [];
    var scored = items
      .filter(function (it) { return it && it.streamable === true; })
      .map(function (it) { return { it: it, s: scoreCand(it, tCore, aNorm) }; })
      .filter(function (x) { return x.s > 0; })
      .sort(function (a, b) { return b.s - a.s; });
    // one entry per recording: dedupe on album + core title so the same master doesn't list twice
    var seen = {}, res = [];
    scored.forEach(function (x) {
      var k = ((x.it.album && x.it.album.id) || "") + "|" + titleCore(x.it.title);
      if (seen[k]) return; seen[k] = 1; res.push(x.it);
    });
    return res.slice(0, 6);
  });
}

// ---- play a specific hit: open its album, match the row by title, click the native play button ----
function playTrack(it) {
  var albumId = it.album && it.album.id; if (!albumId) return;
  var want = titleCore(it.title), path = "/album/" + albumId;
  Q.navigate(path);
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    var onPage = ((Q.getState().router.location.pathname) || "").indexOf(path) >= 0;
    if (onPage) {
      var rows = [].slice.call(document.querySelectorAll(".ListItem")).filter(function (r) { return r.querySelector(".ListItem__title") && r.querySelector(".ListItem__player"); });
      var best = null, bestS = -1;
      rows.forEach(function (r) {
        var te = r.querySelector(".ListItem__title"); var rt = te ? titleCore(te.textContent) : "";
        var s = rt === want ? 100 : (rt && want && (rt.indexOf(want) >= 0 || want.indexOf(rt) >= 0) ? 55 : 0);
        if (s > bestS) { bestS = s; best = r; }
      });
      if (best && bestS > 0) { var p = best.querySelector(".ListItem__player"); if (p) { p.dispatchEvent(new MouseEvent("click", { bubbles: true })); clearInterval(iv); return; } }
    }
    if (tries > 40) clearInterval(iv); // ~6s, then give up rather than spin forever
  }, 150);
}

// ---- results panel ----
function closePanel() { var p = document.getElementById("qz-fav-panel"); if (p) p.remove(); document.removeEventListener("mousedown", onDown, true); document.removeEventListener("keydown", onEsc, true); document.removeEventListener("scroll", closePanel, true); }
function onDown(e) { var p = document.getElementById("qz-fav-panel"); if (p && !p.contains(e.target) && !(e.target.closest && e.target.closest("." + BTN))) closePanel(); }
function onEsc(e) { if (e.key === "Escape") closePanel(); }

function qualityTag(it) { if (it.hires || it.hires_streamable) return "Hi-Res"; if ((it.maximum_bit_depth || 0) >= 16) return "Lossless"; return ""; }
function coverUrl(it) { var im = it.album && it.album.image; return (im && (im.small || im.thumbnail || im.large)) || ""; }

function openPanel(anchor, info) {
  closePanel();
  var p = document.createElement("div"); p.id = "qz-fav-panel"; p.className = "qz-fav-panel";
  p.innerHTML =
    '<div class="qz-fav-head"><span class="qz-fav-h-title">Available versions</span><span class="qz-fav-h-sub"></span></div>' +
    '<div class="qz-fav-body"><div class="qz-fav-msg">Searching the catalog…</div></div>';
  document.body.appendChild(p);
  p.querySelector(".qz-fav-h-sub").textContent = [info.artist, info.title].filter(Boolean).join(" - ");
  // anchor near the button, then nudge on-screen
  var r = anchor.getBoundingClientRect(), pw = 344, ph = 320;
  var left = Math.min(Math.max(8, r.right - pw), window.innerWidth - pw - 8);
  var top = r.bottom + 6; if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
  p.style.left = left + "px"; p.style.top = top + "px";
  setTimeout(function () { document.addEventListener("mousedown", onDown, true); document.addEventListener("keydown", onEsc, true); document.addEventListener("scroll", closePanel, true); }, 0);

  var myReq = ++reqId;
  findVersions(info).then(function (list) {
    if (myReq !== reqId || !document.getElementById("qz-fav-panel")) return;
    var body = p.querySelector(".qz-fav-body");
    if (!list.length) { body.innerHTML = '<div class="qz-fav-msg">No streamable version found for your region.</div>'; return; }
    body.innerHTML = "";
    list.forEach(function (it) {
      var b = document.createElement("button"); b.className = "qz-fav-res"; b.type = "button";
      var cov = coverUrl(it), qual = qualityTag(it);
      var artist = (it.performer && it.performer.name) || "";
      var album = (it.album && it.album.title) || "";
      var ver = it.version ? it.version : "";
      b.innerHTML =
        (cov ? '<img class="qz-fav-cov" src="' + esc(cov) + '" alt="">' : '<span class="qz-fav-cov"></span>') +
        '<span class="qz-fav-txt"><span class="qz-fav-t">' + esc(it.title) + (ver ? '<span class="qz-fav-ver"> · ' + esc(ver) + "</span>" : "") + "</span>" +
        '<span class="qz-fav-a">' + esc([artist, album].filter(Boolean).join(" · ")) + "</span></span>" +
        (qual ? '<span class="qz-fav-q">' + qual + "</span>" : "") +
        '<span class="qz-fav-go"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg></span>';
      b.addEventListener("click", function () { playTrack(it); closePanel(); });
      body.appendChild(b);
    });
  }).catch(function () {
    if (myReq !== reqId) return; var body = p.querySelector(".qz-fav-body");
    if (body) body.innerHTML = '<div class="qz-fav-msg">Search failed. Try again in a moment.</div>';
  });
}

// ---- drop the button onto greyed-out (unavailable) rows ----
// Two row systems ship in the desktop app. The dwp-ui .ListItem rows (playlists, albums, queue) mark
// an unavailable track with .isDisabled (.isPast is just already-played queue history, so skip it).
// The classic .track-list rows used in the Library (.user-library, i.e. liked songs / favorites),
// search and artist pages instead put .disable on the .track-item. Query both, or the button never
// shows on the library's greyed-out rows.
var ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.2-4.2"></path></svg>';
function decorate() {
  var rows = document.querySelectorAll(".ListItem.isDisabled:not(.isPast), .track-item.disable");
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (row.getAttribute("data-qz-fav")) continue;
    if (!rowInfo(row).title) continue; // nothing to search on
    row.setAttribute("data-qz-fav", "1");
    var b = document.createElement("button");
    b.className = BTN; b.type = "button"; b.title = "Find a playable version of this track";
    b.innerHTML = ICON;
    (function (rowEl, btn) {
      btn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); openPanel(btn, rowInfo(rowEl)); });
    })(row, b);
    row.appendChild(b);
  }
}

Q.css(CSS_ID, [
  // the row needs a positioning context for the absolutely-placed button; only touches rows we decorate
  ".ListItem.isDisabled[data-qz-fav]{position:relative;}",
  ".qz-fav-btn{position:absolute;right:58px;top:50%;transform:translateY(-50%);z-index:3;display:flex;align-items:center;justify-content:center;",
  "width:26px;height:26px;border-radius:50%;appearance:none;border:0;cursor:pointer;pointer-events:auto;",
  "background:color-mix(in srgb,var(--qz-accent,#3DA8FE) 22%,transparent);color:var(--qz-accent,#3DA8FE);",
  "opacity:.9;transition:background .14s,transform .12s,opacity .14s;}",
  ".qz-fav-btn:hover{background:var(--qz-accent,#3DA8FE);color:#06090a;opacity:1;transform:translateY(-50%) scale(1.08);}",
  // classic .track-item rows (Library / search) are shorter and lay their cells out differently, so
  // anchor the button over the left play zone - inert on an unavailable row - instead of the .ListItem
  // right-side actions cluster. .track-list li is already position:relative; mark the item too to be safe.
  ".track-item.disable[data-qz-fav]{position:relative;}",
  ".track-item.disable[data-qz-fav] .qz-fav-btn{right:auto;left:10px;width:22px;height:22px;}",

  ".qz-fav-panel{position:fixed;z-index:2147483600;width:344px;max-height:340px;overflow:hidden;display:flex;flex-direction:column;",
  "background:linear-gradient(180deg,rgba(22,25,33,.98),rgba(13,15,21,.99));border:1px solid rgba(255,255,255,.12);",
  "border-radius:14px;box-shadow:0 26px 74px rgba(0,0,0,.62),0 0 46px -22px var(--qz-accent,#3DA8FE);}",
  ".qz-fav-head{padding:12px 14px 9px;border-bottom:1px solid rgba(255,255,255,.08);}",
  ".qz-fav-h-title{display:block;font-size:13px;font-weight:750;color:#fff;letter-spacing:-.2px;}",
  ".qz-fav-h-sub{display:block;font-size:11.5px;color:#9aa3b2;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".qz-fav-body{overflow-y:auto;padding:6px;}",
  ".qz-fav-msg{padding:20px 12px;text-align:center;font-size:12.5px;color:#9aa3b2;}",
  ".qz-fav-res{display:flex;align-items:center;gap:10px;width:100%;text-align:left;appearance:none;border:0;background:transparent;",
  "color:#e7ecf3;font:inherit;padding:7px 8px;border-radius:9px;cursor:pointer;transition:background .12s;}",
  ".qz-fav-res:hover{background:color-mix(in srgb,var(--qz-accent,#3DA8FE) 14%,transparent);}",
  ".qz-fav-cov{width:38px;height:38px;border-radius:6px;object-fit:cover;flex:0 0 auto;background:rgba(255,255,255,.06);}",
  ".qz-fav-txt{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;}",
  ".qz-fav-t{font-size:13px;font-weight:600;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".qz-fav-ver{color:#9aa3b2;font-weight:500;}",
  ".qz-fav-a{font-size:11.5px;color:#9aa3b2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".qz-fav-q{flex:0 0 auto;font-size:9.5px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:var(--qz-accent,#3DA8FE);",
  "border:1px solid color-mix(in srgb,var(--qz-accent,#3DA8FE) 45%,transparent);border-radius:5px;padding:2px 5px;}",
  ".qz-fav-go{flex:0 0 auto;color:var(--qz-accent,#3DA8FE);opacity:0;transition:opacity .12s;}",
  ".qz-fav-res:hover .qz-fav-go{opacity:1;}"
].join(""));

var stopObs = Q.observe(decorate, { debounce: 200 });

return function cleanup() {
  if (stopObs) stopObs();
  closePanel();
  var btns = document.querySelectorAll("." + BTN); for (var i = 0; i < btns.length; i++) btns[i].remove();
  var marked = document.querySelectorAll("[data-qz-fav]"); for (var j = 0; j < marked.length; j++) marked[j].removeAttribute("data-qz-fav");
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
