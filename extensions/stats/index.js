// Private, on-device play logging plus a stats.fm-style dashboard. Runs as
// function(Qobuzify){ ... return cleanup }.
//
// Qobuz doesn't expose any play history, so a 1-second tick watches the player and logs each play
// you actually listened to - Last.fm-style threshold, seeks don't count - into a local IndexedDB.
// The dashboard is just queries over that log: top artists and songs, minutes, a streak,
// recently-played, a minutes-per-day chart, ranges from 1D through All. Everything stays on the
// device by default; cloud sync exists but it's opt-in, and off until you turn it on.
var Q = Qobuzify;

// --- IndexedDB ---
var DB_NAME = "qobuzify-stats", DB_VER = 1, STORE = "plays";
var _db = null;
function openDB() {
  return new Promise(function (res, rej) {
    if (_db) return res(_db);
    var r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        var os = db.createObjectStore(STORE, { keyPath: "ts" });
        os.createIndex("artistKey", "artistKey", { unique: false });
        os.createIndex("day", "day", { unique: false });
      }
    };
    r.onsuccess = function (e) { _db = e.target.result; res(_db); };
    r.onerror = function () { rej(r.error); };
  });
}
function putPlay(play) { return openDB().then(function (db) { return new Promise(function (res, rej) { var tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).put(play); tx.oncomplete = function () { res(play); }; tx.onerror = function () { rej(tx.error); }; }); }); }
function putMany(plays) { return openDB().then(function (db) { return new Promise(function (res, rej) { var tx = db.transaction(STORE, "readwrite"); var os = tx.objectStore(STORE); plays.forEach(function (p) { os.put(p); }); tx.oncomplete = function () { res(plays.length); }; tx.onerror = function () { rej(tx.error); }; }); }); }
function rangePlays(fromTs) { return openDB().then(function (db) { return new Promise(function (res) { var out = []; var tx = db.transaction(STORE, "readonly"); var kr = fromTs ? IDBKeyRange.lowerBound(fromTs) : null; var cur = tx.objectStore(STORE).openCursor(kr); cur.onsuccess = function (e) { var c = e.target.result; if (c) { out.push(c.value); c.continue(); } else res(out); }; tx.onerror = function () { res(out); }; }); }); }
function allPlays() { return rangePlays(null); }
function clearAll() { return openDB().then(function (db) { return new Promise(function (res) { var tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).clear(); tx.oncomplete = res; }); }); }

// --- helpers ---
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function dayKey(ts) { var d = new Date(ts); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
function playerArtistId() { var bar = document.querySelector(".player"); var a = bar && bar.querySelector('a[href*="/artist/"]'); var m = a && (a.getAttribute("href") || "").match(/\/artist\/(\d+)/); return m ? m[1] : null; }
function midCover(url) { return url ? String(url).replace(/_\d+\.(jpg|jpeg|png|webp)/i, "_230.$1") : ""; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

// --- logger ---
function threshold(dur) { if (!dur) return 30000; if (dur < 30000) return Math.max(4000, dur * 0.9); return Math.min(dur / 2, 240000); }
var cur = null;
function record(c) {
  var t = Q.player.getTrack(); if (!t || t.id !== c.track.id) t = c.track;
  var ts = Date.now(), name = t.artist || (t.artists || [])[0] || "";
  var play = { ts: ts, id: t.id || null, title: t.title || "", artist: name, artistKey: name.toLowerCase(), artistId: c.artistId || playerArtistId() || null, album: t.album || "", albumId: t.albumId || null, durationMs: t.durationMs || 0, listenedMs: Math.round(c.listenedMs), cover: midCover(t.cover), quality: t.quality || null, day: dayKey(ts) };
  putPlay(play); queuePush(play); // queuePush no-ops unless cloud sync is on
}
function tick() {
  try {
    var t = Q.player.getTrack();
    if (!t || !t.id) { cur = null; return; }
    if (!cur || cur.track.id !== t.id) { cur = { track: t, artistId: playerArtistId(), listenedMs: 0, counted: false, lastPos: Q.player.getPositionMs() }; return; }
    if (Q.player.isPlaying()) {
      var pos = Q.player.getPositionMs(), delta = pos - cur.lastPos; cur.lastPos = pos;
      if (delta > 0 && delta < 4000) cur.listenedMs += delta;
      if (!cur.counted && cur.listenedMs >= threshold(t.durationMs)) { cur.counted = true; cur.artistId = cur.artistId || playerArtistId(); record(cur); }
    } else { cur.lastPos = Q.player.getPositionMs(); }
  } catch (e) {}
}
var iv = setInterval(tick, 1000);

// --- aggregation ---
function computeStreak(daySet) {
  var d = new Date(), streak = 0, first = true;
  for (var i = 0; i < 4000; i++) { var k = dayKey(d.getTime()); if (daySet[k]) streak++; else if (first) { } else break; first = false; d.setDate(d.getDate() - 1); }
  return streak;
}
function aggregate(plays) {
  var totalMs = 0, artists = {}, songs = {}, albums = {}, days = {};
  plays.forEach(function (p) {
    var ms = p.listenedMs || 0; totalMs += ms;
    var ak = p.artistId || p.artistKey || p.artist || "?";
    (artists[ak] || (artists[ak] = { name: p.artist, artistId: p.artistId, count: 0, ms: 0, cover: p.cover }));
    artists[ak].count++; artists[ak].ms += ms; if (!artists[ak].cover) artists[ak].cover = p.cover;
    var sk = p.id || (p.artistKey + "|" + p.title);
    (songs[sk] || (songs[sk] = { title: p.title, artist: p.artist, count: 0, ms: 0, cover: p.cover, albumId: p.albumId, id: p.id }));
    songs[sk].count++; songs[sk].ms += ms; if (!songs[sk].cover) songs[sk].cover = p.cover;
    if (p.albumId) { (albums[p.albumId] || (albums[p.albumId] = { album: p.album, artist: p.artist, count: 0, ms: 0, cover: p.cover, albumId: p.albumId })); albums[p.albumId].count++; albums[p.albumId].ms += ms; }
    days[p.day] = (days[p.day] || 0) + ms;
  });
  var arr = function (o) { return Object.keys(o).map(function (k) { return o[k]; }); };
  return {
    totalPlays: plays.length, totalMs: totalMs, distinctArtists: Object.keys(artists).length,
    topArtists: arr(artists).sort(function (a, b) { return b.ms - a.ms || b.count - a.count; }),
    topSongs: arr(songs).sort(function (a, b) { return b.count - a.count || b.ms - a.ms; }),
    topAlbums: arr(albums).sort(function (a, b) { return b.ms - a.ms; }),
    perDay: days, streak: computeStreak(days), recent: plays.slice().sort(function (a, b) { return b.ts - a.ts; }).slice(0, 50)
  };
}
function fromTsFor(rk) { var now = Date.now(), D = 86400000; return { "1D": now - D, "1W": now - 7 * D, "1M": now - 30 * D, "6M": now - 182 * D, "1Y": now - 365 * D, "ALL": null }[rk] || null; }

// --- dashboard UI ---
var CSS_ID = "qz-stats-css", NAV_ID = "qz-stats-nav", PAGE_ID = "qz-stats-page";
var curRange = "1M", reassertObs = null;
var IC_CHART = '<svg class="ui-base-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4v16h16M8 14l3-4 3 2 4-6"/></svg>';

function fmtNum(n) { return (n || 0).toLocaleString("en-US"); }
function fmtDur(ms) { var m = Math.round((ms || 0) / 60000); if (m < 60) return m + " min"; var h = Math.floor(m / 60); if (h < 48) return h + "h " + (m % 60) + "m"; return (m / 1440).toFixed(1) + " days (" + h + "h)"; }
function relTime(ts) { var s = Math.round((Date.now() - ts) / 1000); if (s < 60) return "just now"; var m = Math.floor(s / 60); if (m < 60) return m + "m ago"; var h = Math.floor(m / 60); if (h < 24) return h + "h ago"; var d = Math.floor(h / 24); return d + "d ago"; }
function up(n) { return n > 0 ? '<span class="qz-st-up">&#8593; ' + fmtNum(n) + "</span>" : ""; }

function lineChart(perDay, fromTs) {
  var DAY = 86400000, now = Date.now(), from = fromTs || (now - 30 * DAY);
  var days = Math.min(120, Math.max(1, Math.ceil((now - from) / DAY)));
  var pts = [];
  for (var i = days - 1; i >= 0; i--) { var t = now - i * DAY; pts.push({ t: t, m: Math.round((perDay[dayKey(t)] || 0) / 60000) }); }
  var W = 720, H = 250, PL = 38, PB = 24, PT = 12, PR = 8;
  var max = Math.max(1, pts.reduce(function (a, p) { return Math.max(a, p.m); }, 0));
  var x = function (i) { return PL + (pts.length <= 1 ? 0 : i / (pts.length - 1) * (W - PL - PR)); };
  var y = function (m) { return PT + (1 - m / max) * (H - PT - PB); };
  var line = pts.map(function (p, i) { return (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p.m).toFixed(1); }).join(" ");
  var area = line + " L" + x(pts.length - 1).toFixed(1) + " " + (H - PB) + " L" + x(0).toFixed(1) + " " + (H - PB) + " Z";
  var grid = [0, 0.5, 1].map(function (f) { var yy = (PT + (1 - f) * (H - PT - PB)).toFixed(1); return '<line x1="' + PL + '" y1="' + yy + '" x2="' + (W - PR) + '" y2="' + yy + '" class="qz-st-grid"/><text x="' + (PL - 6) + '" y="' + (parseFloat(yy) + 4) + '" class="qz-st-ylbl">' + Math.round(max * f) + "</text>"; }).join("");
  var step = Math.max(1, Math.floor(pts.length / 7)), xlbl = "";
  for (var j = 0; j < pts.length; j += step) { var dd = new Date(pts[j].t); xlbl += '<text x="' + x(j).toFixed(1) + '" y="' + (H - 7) + '" class="qz-st-xlbl" text-anchor="middle">' + pad2(dd.getDate()) + "/" + pad2(dd.getMonth() + 1) + "</text>"; }
  return '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" class="qz-st-chart">' + grid + '<path d="' + area + '" class="qz-st-area"/><path d="' + line + '" class="qz-st-line"/>' + xlbl + "</svg>";
}
function coverEl(url, sm) { return '<div class="qz-st-cover' + (sm ? " sm" : "") + '">' + (url ? '<img src="' + esc(url) + '" alt="" loading="lazy">' : "") + "</div>"; }
function artistRow(a, r) { var med = r <= 3 ? " qz-st-medal-" + r : ""; return '<div class="qz-st-arow">' + coverEl(a.cover) + '<div class="qz-st-ainfo"><div class="qz-st-aname"><span class="qz-st-rank' + med + '">#' + r + "</span>" + esc(a.name) + '</div><div class="qz-st-asub">' + fmtNum(a.count) + " plays &middot; " + Math.round(a.ms / 60000) + " min</div></div></div>"; }
function songRow(s, r) { return '<div class="qz-st-srow"><span class="qz-st-srank">#' + r + "</span>" + coverEl(s.cover, 1) + '<div class="qz-st-sinfo"><div class="qz-st-stitle">' + esc(s.title) + '</div><div class="qz-st-ssub">' + esc(s.artist) + " &middot; " + fmtNum(s.count) + " plays</div></div></div>"; }
function recentRow(p) { return '<div class="qz-st-rrow">' + coverEl(p.cover, 1) + '<div class="qz-st-rinfo"><div class="qz-st-rtitle">' + esc(p.title) + '</div><div class="qz-st-rsub">' + esc(p.artist) + '</div></div><div class="qz-st-rtime">' + relTime(p.ts) + "</div></div>"; }
function emptyMsg() { return '<div class="qz-st-empty">Still building - keep listening and this fills in.</div>'; }
function hcard(label, val) { return '<div class="qz-stats-hcard"><div class="qz-stats-hlabel">' + esc(label) + '</div><div class="qz-stats-hval">' + val + "</div></div>"; }
function scard(label, val, d) { return '<div class="qz-stats-scard"><div class="qz-stats-slabel">' + esc(label) + '</div><div class="qz-stats-sval">' + val + (d || "") + "</div></div>"; }

function buildPage() {
  var ex = document.getElementById(PAGE_ID); if (ex) return ex;
  var pg = document.createElement("div"); pg.id = PAGE_ID; pg.className = "qz-stats-page";
  pg.innerHTML = '<div class="qz-stats-inner"><div class="qz-stats-head"><span class="qz-stats-title">' + IC_CHART + ' Listening Stats</span>' +
    '<div class="qz-stats-headbtns"><button class="qz-stats-cloud" title="Cloud sync">' + IC_CLOUD + '</button><button class="qz-stats-close" aria-label="Close">&#215;</button></div></div>' +
    '<div class="qz-stats-hero"></div><div class="qz-stats-rangebar"></div><div class="qz-stats-cards"></div>' +
    '<div class="qz-stats-grid"><div class="qz-stats-col qz-stats-left"></div><div class="qz-stats-col qz-stats-right"></div></div></div>';
  document.body.appendChild(pg);
  pg.querySelector(".qz-stats-close").addEventListener("click", closePage);
  pg.querySelector(".qz-stats-cloud").addEventListener("click", openCloud);
  var rb = pg.querySelector(".qz-stats-rangebar");
  ["1D", "1W", "1M", "6M", "1Y", "ALL"].forEach(function (r) {
    var b = document.createElement("button"); b.className = "qz-stats-range" + (r === curRange ? " on" : ""); b.textContent = r === "ALL" ? "All" : r; b.setAttribute("data-r", r);
    b.addEventListener("click", function () { curRange = r; rb.querySelectorAll(".qz-stats-range").forEach(function (x) { x.classList.toggle("on", x.getAttribute("data-r") === r); }); render(); });
    rb.appendChild(b);
  });
  return pg;
}
function render() {
  var pg = document.getElementById(PAGE_ID); if (!pg) return;
  allPlays().then(function (plays) {
    var now = Date.now(), from = fromTsFor(curRange), span = from ? now - from : null;
    var A = aggregate(from ? plays.filter(function (p) { return p.ts >= from; }) : plays);
    var P = span ? aggregate(plays.filter(function (p) { return p.ts >= now - 2 * span && p.ts < from; })) : { totalPlays: 0, distinctArtists: 0 };
    var label = { "1D": "today", "1W": "past week", "1M": "past month", "6M": "past 6 months", "1Y": "past year", "ALL": "all time" }[curRange];
    var effFrom = from || (plays.length ? plays.reduce(function (m, p) { return Math.min(m, p.ts); }, now) : now - 30 * 86400000);
    var streak = aggregate(plays).streak, np = Q.player.getTrack();

    pg.querySelector(".qz-stats-hero").innerHTML =
      hcard("Now playing", np && np.title ? esc(np.artist + " - " + np.title) : "Nothing playing") +
      hcard("Listening streak", streak + (streak === 1 ? " day" : " days")) +
      hcard("Total plays (all time)", fmtNum(plays.length));
    pg.querySelector(".qz-stats-cards").innerHTML =
      scard("Plays", fmtNum(A.totalPlays), up(A.totalPlays - P.totalPlays)) +
      scard("Time listened", fmtDur(A.totalMs), "") +
      scard("Artists", fmtNum(A.distinctArtists), up(A.distinctArtists - P.distinctArtists));
    pg.querySelector(".qz-stats-left").innerHTML =
      '<div class="qz-stats-panel"><h3>Top Artists <span>' + label + "</span></h3>" + (A.topArtists.length ? A.topArtists.slice(0, 6).map(function (a, i) { return artistRow(a, i + 1); }).join("") : emptyMsg()) + "</div>" +
      '<div class="qz-stats-panel"><h3>Top Songs <span>' + label + "</span></h3>" + (A.topSongs.length ? A.topSongs.slice(0, 6).map(function (s, i) { return songRow(s, i + 1); }).join("") : emptyMsg()) + "</div>";
    pg.querySelector(".qz-stats-right").innerHTML =
      '<div class="qz-stats-panel"><h3>Minutes listened <span>' + label + "</span></h3>" + lineChart(A.perDay, effFrom) + "</div>" +
      '<div class="qz-stats-panel"><h3>Recently Played</h3><div class="qz-st-recent">' + (A.recent.length ? A.recent.slice(0, 12).map(recentRow).join("") : emptyMsg()) + "</div></div>";
  });
}
function onEsc(e) { if (e.key === "Escape") { e.stopPropagation(); closePage(); } }
function openPage() { buildPage(); render(); requestAnimationFrame(function () { var p = document.getElementById(PAGE_ID); if (p) p.classList.add("qz-stats-show"); }); document.addEventListener("keydown", onEsc, true); }
function closePage() { var p = document.getElementById(PAGE_ID); if (!p) return; p.classList.remove("qz-stats-show"); document.removeEventListener("keydown", onEsc, true); setTimeout(function () { if (p && !p.classList.contains("qz-stats-show")) p.remove(); }, 220); }

function injectNav() {
  var row = document.querySelector(".NavBar__items"); if (!row) return;
  if (row.querySelector('[data-qz-nav="' + NAV_ID + '"]')) return;
  var wrap = document.createElement("div");
  wrap.className = "ui-block-nav-item flex w-full relative rounded-md cursor-pointer select-none transition-colors duration-200 outline-1 -outline-offset-1 outline-transparent hover:bg-surface-default-secondary";
  wrap.setAttribute("data-qz-nav", NAV_ID);
  wrap.innerHTML = '<a class="ui-link flex w-full items-center gap-8 px-12 py-8 rounded-md transition-colors duration-200" data-type="router-link" href="/stats">' + IC_CHART + "<span>Stats</span></a>";
  wrap.querySelector("a").addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); openPage(); });
  row.appendChild(wrap);
}

// --- cloud sync (opt-in, off by default) ---
var SYNC_API = "https://api.qobuzify.app/v1/stats";
var LS_CLOUD = "qz-stats-cloud", LS_SYNCID = "qz-stats-syncid", LS_LASTPULL = "qz-stats-lastpull";
var pullTimer = null, pushQueue = [], pushT = null;
function cloudOn() { try { return localStorage.getItem(LS_CLOUD) === "1"; } catch (e) { return false; } }
function getSyncId() {
  var id = null; try { id = localStorage.getItem(LS_SYNCID); } catch (e) {}
  if (!id || !/^[A-Za-z0-9-]{16,64}$/.test(id)) { id = ((window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ("qz" + Date.now() + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2))).replace(/[^A-Za-z0-9-]/g, "").slice(0, 40); try { localStorage.setItem(LS_SYNCID, id); } catch (e) {} }
  return id;
}
function setSyncId(id) { id = (id || "").trim(); if (/^[A-Za-z0-9-]{16,64}$/.test(id)) { try { localStorage.setItem(LS_SYNCID, id); localStorage.setItem(LS_LASTPULL, "0"); } catch (e) {} return true; } return false; }
function pushPlays(plays) {
  if (!plays.length) return Promise.resolve(0);
  return fetch(SYNC_API + "/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ syncId: getSyncId(), plays: plays }) }).then(function (r) { return r.json(); }).then(function (j) { return (j && j.inserted) || 0; }).catch(function () { return 0; });
}
function pushAll() { return allPlays().then(function (p) { var chunks = []; for (var i = 0; i < p.length; i += 500) chunks.push(p.slice(i, i + 500)); return chunks.reduce(function (pr, c) { return pr.then(function (acc) { return pushPlays(c).then(function (n) { return acc + n; }); }); }, Promise.resolve(0)); }); }
function pullMerge() {
  var since = 0; try { since = parseInt(localStorage.getItem(LS_LASTPULL) || "0", 10) || 0; } catch (e) {}
  return fetch(SYNC_API + "/pull?syncId=" + encodeURIComponent(getSyncId()) + "&since=" + since).then(function (r) { return r.json(); }).then(function (j) {
    var plays = (j && j.plays) || []; if (!plays.length) return 0;
    plays.forEach(function (p) { p.artistKey = (p.artist || "").toLowerCase(); });
    return putMany(plays).then(function () { var mx = plays.reduce(function (m, p) { return Math.max(m, p.ts); }, since); try { localStorage.setItem(LS_LASTPULL, String(mx)); } catch (e) {} return plays.length; });
  }).catch(function () { return 0; });
}
function queuePush(play) { if (!cloudOn()) return; pushQueue.push(play); clearTimeout(pushT); pushT = setTimeout(function () { var q = pushQueue.slice(); pushQueue = []; pushPlays(q); }, 5000); }
function startPull() { if (pullTimer) return; pullMerge(); pullTimer = setInterval(pullMerge, 300000); }
function stopPull() { if (pullTimer) { clearInterval(pullTimer); pullTimer = null; } }
function enableCloud() { try { localStorage.setItem(LS_CLOUD, "1"); } catch (e) {} return pushAll().then(function (n) { startPull(); return n; }); }
function disableCloud() { try { localStorage.setItem(LS_CLOUD, "0"); } catch (e) {} stopPull(); }
function wipeCloud() { return fetch(SYNC_API + "/wipe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ syncId: getSyncId() }) }).then(function (r) { return r.json(); }).then(function (j) { return (j && j.deleted) || 0; }).catch(function () { return 0; }); }

var IC_CLOUD = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.5 19a4.5 4.5 0 0 0 .4-8.98A6 6 0 0 0 6.2 9.5 4 4 0 0 0 7 17.9"/><path d="M7 17.9h10.5"/></svg>';
function closeCloud() { var m = document.getElementById("qz-cloud-modal"); if (m) m.remove(); }
function openCloud() {
  closeCloud();
  var on = cloudOn(), sid = getSyncId();
  var m = document.createElement("div"); m.id = "qz-cloud-modal"; m.className = "qz-cloud-modal";
  m.innerHTML = '<div class="qz-cloud-box"><div class="qz-cloud-h">' + IC_CLOUD + " Cloud Sync</div>" +
    '<p class="qz-cloud-p">Off by default - your listening history stays only on this device. Turn this on to back it up and sync it across devices. <b>Stored per play:</b> title, artist, album, duration, minutes listened, timestamp, cover URL, quality. No account, no name, nothing else about you.</p>' +
    '<div class="qz-cloud-row"><span>Enable cloud sync</span><button class="qz-cloud-sw' + (on ? " on" : "") + '" data-act="toggle"><span></span></button></div>' +
    '<div class="qz-cloud-details" style="display:' + (on ? "block" : "none") + '"><div class="qz-cloud-lbl">Your sync code - paste it on another device to sync the same history</div>' +
    '<div class="qz-cloud-idrow"><code class="qz-cloud-id">' + esc(sid) + '</code><button class="qz-cloud-btn" data-act="copy">Copy</button></div>' +
    '<div class="qz-cloud-status" data-status>&nbsp;</div>' +
    '<div class="qz-cloud-actrow"><button class="qz-cloud-btn" data-act="syncnow">Sync now</button><button class="qz-cloud-btn ghost" data-act="usecode">Use a code</button><button class="qz-cloud-btn ghost" data-act="wipe">Wipe cloud</button></div>' +
    '<div class="qz-cloud-import" style="display:none"><input class="qz-cloud-input" placeholder="paste a sync code"><button class="qz-cloud-btn" data-act="loadcode">Load</button></div></div>' +
    '<button class="qz-cloud-done" data-act="done">Done</button></div>';
  document.body.appendChild(m);
  m.addEventListener("mousedown", function (e) { if (e.target === m) closeCloud(); });
  var st = m.querySelector("[data-status]"); function setSt(t) { if (st) st.textContent = t; }
  m.querySelector('[data-act="done"]').addEventListener("click", closeCloud);
  m.querySelector('[data-act="toggle"]').addEventListener("click", function () {
    if (cloudOn()) { disableCloud(); this.classList.remove("on"); m.querySelector(".qz-cloud-details").style.display = "none"; }
    else { this.classList.add("on"); m.querySelector(".qz-cloud-details").style.display = "block"; setSt("Uploading your history…"); enableCloud().then(function (n) { setSt("Backed up. New plays upload automatically."); render(); }); }
  });
  var cp = m.querySelector('[data-act="copy"]'); if (cp) cp.addEventListener("click", function () { try { navigator.clipboard.writeText(sid); } catch (e) {} setSt("Copied sync code."); });
  var sn = m.querySelector('[data-act="syncnow"]'); if (sn) sn.addEventListener("click", function () { setSt("Syncing…"); Promise.all([pushAll(), pullMerge()]).then(function (r) { setSt("Synced · " + r[1] + " pulled from cloud."); render(); }); });
  var uc = m.querySelector('[data-act="usecode"]'); if (uc) uc.addEventListener("click", function () { var im = m.querySelector(".qz-cloud-import"); im.style.display = im.style.display === "none" ? "flex" : "none"; });
  var lc = m.querySelector('[data-act="loadcode"]'); if (lc) lc.addEventListener("click", function () { if (setSyncId(m.querySelector(".qz-cloud-input").value)) { setSt("Pulling that code's history…"); pullMerge().then(function (n) { setSt("Loaded " + n + " plays."); render(); }); } else setSt("That doesn't look like a valid code."); });
  var wp = m.querySelector('[data-act="wipe"]'); if (wp) wp.addEventListener("click", function () { setSt("Wiping cloud data…"); wipeCloud().then(function (n) { setSt("Wiped " + n + " plays from the cloud."); }); });
}

var STATS_CSS = [
  ".qz-stats-page{position:fixed;top:0;left:0;right:0;bottom:74px;z-index:2147482000;overflow-y:auto;opacity:0;transition:opacity .2s ease;-webkit-app-region:no-drag;",
  "background:radial-gradient(120% 100% at 50% 0%,#10131a 0%,#0a0c11 62%,#07090d 100%);color:#e7ecf3;font-family:inherit;}",
  ".qz-stats-page.qz-stats-show{opacity:1;}",
  ".qz-stats-inner{max-width:1180px;margin:0 auto;padding:16px 26px 64px;}",
  ".qz-stats-head{display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;padding:8px 0 16px;z-index:2;background:linear-gradient(180deg,#0a0c11 72%,transparent);}",
  ".qz-stats-title{display:flex;align-items:center;gap:10px;font-size:22px;font-weight:800;}",
  ".qz-stats-title svg{color:var(--qz-accent,#3DA8FE);}",
  ".qz-stats-close{appearance:none;border:0;background:rgba(255,255,255,.06);color:#cbd3df;width:38px;height:38px;border-radius:10px;font-size:22px;line-height:1;cursor:pointer;-webkit-app-region:no-drag;}",
  ".qz-stats-close:hover{background:rgba(255,255,255,.13);color:#fff;}",
  ".qz-stats-hero{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:18px;}",
  ".qz-stats-hcard{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:15px 18px;min-width:0;}",
  ".qz-stats-hlabel{font-size:12.5px;color:#8b94a3;font-weight:600;}",
  ".qz-stats-hval{font-size:19px;font-weight:800;margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".qz-stats-rangebar{display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap;}",
  ".qz-stats-range{appearance:none;border:1px solid rgba(255,255,255,.1);background:transparent;color:#9aa3b2;font:inherit;font-size:13px;font-weight:700;padding:7px 15px;border-radius:9px;cursor:pointer;transition:all .13s;}",
  ".qz-stats-range:hover{color:#e7ecf3;border-color:rgba(255,255,255,.2);}",
  ".qz-stats-range.on{background:var(--qz-accent,#3DA8FE);color:#06090a;border-color:var(--qz-accent,#3DA8FE);}",
  ".qz-stats-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:18px;}",
  ".qz-stats-scard{background:linear-gradient(180deg,rgba(61,168,254,.11),rgba(255,255,255,.025));border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:15px 18px;}",
  ".qz-stats-slabel{font-size:12.5px;color:#9aa3b2;font-weight:600;}",
  ".qz-stats-sval{font-size:25px;font-weight:850;margin-top:4px;}",
  ".qz-st-up{font-size:13px;color:#4ade80;font-weight:700;margin-left:8px;}",
  ".qz-stats-grid{display:grid;grid-template-columns:.82fr 1.18fr;gap:16px;align-items:start;}",
  ".qz-stats-panel{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:16px;padding:15px 18px;margin-bottom:16px;}",
  ".qz-stats-panel h3{margin:0 0 10px;font-size:15px;font-weight:750;display:flex;align-items:baseline;gap:8px;}",
  ".qz-stats-panel h3 span{font-size:12px;color:#8b94a3;font-weight:500;}",
  ".qz-st-arow{display:flex;align-items:center;gap:12px;padding:7px 0;}",
  ".qz-st-cover{width:50px;height:50px;border-radius:10px;overflow:hidden;background:rgba(255,255,255,.06);flex:0 0 auto;}",
  ".qz-st-cover.sm{width:40px;height:40px;border-radius:8px;}",
  ".qz-st-cover img{width:100%;height:100%;object-fit:cover;display:block;}",
  ".qz-st-ainfo,.qz-st-sinfo,.qz-st-rinfo{min-width:0;flex:1;}",
  ".qz-st-aname{font-size:15px;font-weight:700;display:flex;align-items:center;gap:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".qz-st-rank{font-size:13px;font-weight:800;color:#7e8796;}",
  ".qz-st-medal-1{color:#ffd54a;}.qz-st-medal-2{color:#cdd5e0;}.qz-st-medal-3{color:#e0a56b;}",
  ".qz-st-asub{font-size:12.5px;color:#9aa3b2;margin-top:2px;}",
  ".qz-st-srow,.qz-st-rrow{display:flex;align-items:center;gap:11px;padding:6px 0;}",
  ".qz-st-srank{font-size:12px;font-weight:800;color:#7e8796;width:26px;flex:0 0 auto;}",
  ".qz-st-stitle,.qz-st-rtitle{font-size:14px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".qz-st-ssub,.qz-st-rsub{font-size:12px;color:#9aa3b2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".qz-st-rtime{font-size:12px;color:#8b94a3;flex:0 0 auto;white-space:nowrap;}",
  ".qz-st-chart{width:100%;height:250px;display:block;}",
  ".qz-st-line{fill:none;stroke:var(--qz-accent,#3DA8FE);stroke-width:2.4;vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round;}",
  ".qz-st-area{fill:var(--qz-accent,#3DA8FE);opacity:.12;stroke:none;}",
  ".qz-st-grid{stroke:rgba(255,255,255,.07);stroke-width:1;vector-effect:non-scaling-stroke;}",
  ".qz-st-ylbl{fill:#7e8796;font-size:11px;text-anchor:end;}.qz-st-xlbl{fill:#7e8796;font-size:10px;}",
  ".qz-st-empty{color:#8b94a3;font-size:13px;padding:12px 4px;}",
  "@media(max-width:820px){.qz-stats-hero,.qz-stats-cards,.qz-stats-grid{grid-template-columns:1fr;}}",
  ".qz-stats-headbtns{display:flex;align-items:center;gap:8px;-webkit-app-region:no-drag;}",
  ".qz-stats-cloud{appearance:none;border:0;background:rgba(255,255,255,.06);color:#cbd3df;width:38px;height:38px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;-webkit-app-region:no-drag;}",
  ".qz-stats-cloud:hover{background:rgba(255,255,255,.13);color:var(--qz-accent,#3DA8FE);}",
  ".qz-cloud-modal{position:fixed;inset:0;z-index:2147482500;display:flex;align-items:center;justify-content:center;background:rgba(4,6,10,.62);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);-webkit-app-region:no-drag;}",
  ".qz-cloud-box{width:min(470px,92vw);background:linear-gradient(180deg,rgba(22,25,33,.98),rgba(13,15,21,.99));border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:20px 22px;box-shadow:0 30px 80px rgba(0,0,0,.6);}",
  ".qz-cloud-h{display:flex;align-items:center;gap:9px;font-size:17px;font-weight:800;color:#eef2f7;}",
  ".qz-cloud-h svg{color:var(--qz-accent,#3DA8FE);}",
  ".qz-cloud-p{font-size:12.5px;color:#9aa3b2;line-height:1.55;margin:12px 0 12px;}.qz-cloud-p b{color:#cbd3df;}",
  ".qz-cloud-row{display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-top:1px solid rgba(255,255,255,.07);}",
  ".qz-cloud-row span{font-size:14px;font-weight:650;color:#e7ecf3;}",
  ".qz-cloud-sw{position:relative;width:46px;height:26px;border-radius:20px;border:0;cursor:pointer;background:rgba(255,255,255,.16);transition:background .15s;flex:0 0 auto;}",
  ".qz-cloud-sw span{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:left .16s;}",
  ".qz-cloud-sw.on{background:var(--qz-accent,#3DA8FE);}.qz-cloud-sw.on span{left:23px;}",
  ".qz-cloud-lbl{font-size:12px;color:#8b94a3;margin:10px 0 6px;}",
  ".qz-cloud-idrow,.qz-cloud-import{display:flex;gap:8px;align-items:center;}",
  ".qz-cloud-id{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px 10px;color:#cbd3df;}",
  ".qz-cloud-btn{appearance:none;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#e7ecf3;font:inherit;font-size:12.5px;font-weight:650;padding:8px 13px;border-radius:8px;cursor:pointer;white-space:nowrap;}",
  ".qz-cloud-btn:hover{background:rgba(255,255,255,.12);}.qz-cloud-btn.ghost{background:transparent;}",
  ".qz-cloud-status{font-size:12px;color:var(--qz-accent,#3DA8FE);margin:10px 0 4px;min-height:16px;}",
  ".qz-cloud-actrow{display:flex;gap:8px;margin-top:6px;}.qz-cloud-import{margin-top:8px;}",
  ".qz-cloud-input{flex:1;min-width:0;appearance:none;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#e7ecf3;font:inherit;font-size:12.5px;padding:8px 10px;border-radius:8px;}",
  ".qz-cloud-done{width:100%;margin-top:16px;appearance:none;border:0;border-radius:9px;padding:10px;font:inherit;font-size:14px;font-weight:750;cursor:pointer;color:#06090a;background:var(--qz-accent,#3DA8FE);}"
].join("");

// --- dev seeder (realistic: songs reuse stable ids) ---
function seed(nDays, playsPerDay) {
  nDays = nDays || 30; playsPerDay = playsPerDay || 12;
  var ART = [{ n: "Travis Scott", id: "308709" }, { n: "Metro Boomin", id: "1010" }, { n: "Future", id: "12" }, { n: "Playboi Carti", id: "2" }, { n: "Drake", id: "3" }, { n: "Yeat", id: "4" }, { n: "Don Toliver", id: "5" }, { n: "24kGoldn", id: "6" }, { n: "Kanye West", id: "7" }, { n: "Frank Ocean", id: "8" }];
  var TITLES = ["4 Raws", "Too Many Nights", "ZEZE", "FE!N", "Type Shit", "Money Trees", "Nights", "Telekinesis", "One Call", "Breathe", "Nightcrawler", "Cinderella", "Sicko Mode", "Trance", "Rich Flex"];
  var SONGS = [];
  for (var s = 0; s < 40; s++) { var a = ART[s % ART.length]; SONGS.push({ id: 900000 + s, title: TITLES[s % TITLES.length], a: a }); }
  var out = [], now = Date.now(), DAY = 86400000;
  for (var d = 0; d < nDays; d++) {
    var n = Math.max(1, Math.round(playsPerDay * (0.4 + Math.random() * 1.2)));
    for (var i = 0; i < n; i++) {
      var song = SONGS[Math.floor(Math.random() * SONGS.length)];
      var ts = now - d * DAY - Math.floor(Math.random() * DAY), dur = 120000 + Math.floor(Math.random() * 180000);
      out.push({ ts: ts, id: song.id, title: song.title, artist: song.a.n, artistKey: song.a.n.toLowerCase(), artistId: song.a.id, album: song.a.n + " - Album", albumId: "alb" + song.a.id, durationMs: dur, listenedMs: Math.round(dur * (0.5 + Math.random() * 0.5)), cover: "", quality: null, day: dayKey(ts) });
    }
  }
  return putMany(out).then(function () { return out.length; });
}
// a more realistic demo seed, pulled from your actual Qobuz favorites - real titles, artists, cover art
function seedReal(nDays, playsPerDay) {
  nDays = nDays || 30; playsPerDay = playsPerDay || 14;
  return Q.api("favorite/getUserFavorites?type=tracks&limit=100").then(function (j) {
    var items = (j.tracks && j.tracks.items) || [];
    if (!items.length) return 0;
    var pool = items.map(function (t) {
      var art = t.performer || (t.album && t.album.artist) || {};
      var im = t.album && t.album.image ? (t.album.image.large || t.album.image.small || t.album.image.thumbnail || "") : "";
      return { id: t.id, title: t.title, artist: art.name || "", artistId: art.id || null, album: t.album ? t.album.title : "", albumId: t.album ? t.album.id : null, dur: (t.duration || 200) * 1000, cover: im };
    });
    var out = [], now = Date.now(), DAY = 86400000;
    for (var d = 0; d < nDays; d++) {
      var n = Math.max(1, Math.round(playsPerDay * (0.4 + Math.random() * 1.2)));
      for (var i = 0; i < n; i++) {
        var s = pool[Math.floor(Math.random() * pool.length)], ts = now - d * DAY - Math.floor(Math.random() * DAY);
        out.push({ ts: ts, id: s.id, title: s.title, artist: s.artist, artistKey: (s.artist || "").toLowerCase(), artistId: s.artistId, album: s.album, albumId: s.albumId, durationMs: s.dur, listenedMs: Math.round(s.dur * (0.5 + Math.random() * 0.5)), cover: s.cover, quality: null, day: dayKey(ts) });
      }
    }
    return putMany(out).then(function () { return out.length; });
  });
}

// --- boot + API ---
Q.css(CSS_ID, STATS_CSS);
injectNav();
reassertObs = Q.observe(function () { injectNav(); }, { debounce: 400 });
if (cloudOn()) startPull();

window.__QZ_STATS = {
  all: allPlays, range: rangePlays, put: putPlay, clear: clearAll, seed: seed, seedReal: seedReal, aggregate: aggregate, fromTsFor: fromTsFor,
  stats: function (rk) { return rangePlays(fromTsFor(rk || "ALL")).then(aggregate); },
  count: function () { return allPlays().then(function (p) { return p.length; }); },
  open: openPage, close: closePage, setRange: function (r) { curRange = r; },
  cloud: { on: cloudOn, enable: enableCloud, disable: disableCloud, syncId: getSyncId, setSyncId: setSyncId, pushAll: pushAll, pull: pullMerge, openUi: openCloud }
};

return function cleanup() {
  clearInterval(iv);
  stopPull(); closeCloud(); clearTimeout(pushT);
  if (reassertObs) reassertObs();
  closePage(); var pg = document.getElementById(PAGE_ID); if (pg) pg.remove();
  var nav = document.querySelector('[data-qz-nav="' + NAV_ID + '"]'); if (nav) nav.remove();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
  try { delete window.__QZ_STATS; } catch (e) { window.__QZ_STATS = null; }
};
