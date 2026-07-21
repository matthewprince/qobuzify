// Full Library Load. function(Qobuzify).
//
// Qobuz's native app only trickles your favorites in a page at a time as you scroll, so a big library
// (Reddit's bean_chuffer: 40k+ tracks) is slow to browse and impossible to search as a whole. This
// pages the *entire* favorites library up front and caches it, so the whole thing is available
// instantly to browse, search and mark.
//
// How it loads (all confirmed against the shipped bundle):
//   - favorite/getUserFavoriteIds        -> the COMPLETE id set in ONE request (no paging). Cheap, and
//                                           enough on its own to mark favorites app-wide + to fingerprint
//                                           the library for freshness.
//   - favorite/getUserFavorites?type=tracks&limit=500&offset=N
//                                         -> full track metadata, paged 500 at a time (500 is the app's
//                                            own default page size, so it's the real max), looped to
//                                            exhaustion. Only re-paged when the fingerprint changes.
//
// Caching: the id set is always persisted (small). Track metadata is persisted best-effort in compact
// chunks and rehydrated instantly next launch; on a library too big to fit localStorage it degrades to
// memory-only (re-paged per session, fast, with the progress pill). Everything lives under Q.storage so
// it survives restarts.
//
// Integration: exposes a shared Q.library API (favorite membership + the full track list + load/refresh)
// that any extension can consume - this is the clean, order-independent hook for Better Search's
// library/search surface (see the note by the Q.api wrap below). It ALSO opportunistically upgrades
// Better Search's one capped favorites call to the complete set when it can.
var Q = Qobuzify;

var CSS_ID = "qz-lib-css";
var PROG_ID = "qz-lib-progress";
var PAGE = 500;                 // confirmed: the native favorites pager's default (and max sane) page size
var MAX_PAGES = 400;            // runaway guard: 200k tracks is far past any real library
var META_MAX_PERSIST = 20000;   // above this, keep metadata in memory only (localStorage quota ~5MB)
var CHUNK = 2000;               // compact records per persisted metadata chunk

var K_IDS = "library:ids";                          // {v,t:[..],a:[..],r:[..],at}
function K_MIDX(type) { return "library:midx:" + type; }   // {v,meta,chunks,count}
function K_MCH(type, i) { return "library:mch:" + type + ":" + i; }

// --- in-memory state ---
var mem = {
  ids: null,        // { tracks:{id:1}, albums:{id:1}, artists:{id:1} } - complete favorite membership
  fp: {},           // type -> fingerprint of the current id set
  idsPromise: null,
  meta: {},         // type -> array of (full or rehydrated-compact) track objects
  loaded: {},       // type -> bool (full metadata in memory)
  loading: {}       // type -> in-flight Promise
};
var progCbs = [];   // Q.library.onProgress subscribers

function fmt(n) { try { return Number(n).toLocaleString("en-US"); } catch (e) { return String(n); } }

// order-independent fingerprint of an id set: count + sum + xor. Any add/remove changes it, so the
// cheap getUserFavoriteIds call alone tells us whether the heavy metadata cache is still valid.
function fp(ids) {
  var n = ids.length, s = 0, x = 0;
  for (var i = 0; i < n; i++) { var v = +ids[i] || 0; s = (s + v) % 2147483647; x = (x ^ v) >>> 0; }
  return n + ":" + s + ":" + x;
}

// getUserFavoriteIds nodes come in a few shapes: [id,..] | [{id},..] | {items:[..]}. Be tolerant.
function idList(node) {
  if (!node) return [];
  var arr = node.items || node; if (!arr || !arr.length) return [];
  return [].map.call(arr, function (x) { return String(x && x.id != null ? x.id : x); });
}

// ---------- persistence ----------
function readJSON(key) { try { var v = Q.storage.get(key, ""); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function writeJSON(key, obj) { Q.storage.set(key, JSON.stringify(obj)); } // may throw QuotaExceeded - callers guard

function persistIds() {
  try {
    writeJSON(K_IDS, {
      v: mem.fp,
      t: Object.keys(mem.ids.tracks), a: Object.keys(mem.ids.albums), r: Object.keys(mem.ids.artists),
      at: Date.now()
    });
  } catch (e) {}
}
function seedIdsFromCache() { // offline / API-failure fallback so marking still works
  var c = readJSON(K_IDS); if (!c) return null;
  var toMap = function (a) { var m = {}; (a || []).forEach(function (id) { m[id] = 1; }); return m; };
  var ids = { tracks: toMap(c.t), albums: toMap(c.a), artists: toMap(c.r) };
  return { ids: ids, fp: c.v || { tracks: fp(c.t || []), albums: fp(c.a || []), artists: fp(c.r || []) } };
}

// Compact a raw Qobuz favorite track down to just what a list row / badge / search needs, then
// rehydrate to a shape those consumers already expect (performer.name, album.image.small,
// maximum_bit_depth, released_at, ...). Keeps the persisted cache small enough to actually fit.
function enc(t) {
  var al = t.album || {}, im = al.image || {}, perf = t.performer || al.artist || {};
  return {
    i: t.id, t: t.title || "", p: perf.name || "", pi: perf.id != null ? perf.id : null,
    a: al.title || "", ai: al.id != null ? al.id : null,
    c: im.small || im.thumbnail || "", d: t.duration || 0,
    r: t.released_at || al.released_at || 0,
    b: t.maximum_bit_depth || (t.hires ? 24 : 16), s: t.maximum_sampling_rate || 0,
    n: t.track_number || 0, st: t.streamable === false ? 0 : 1
  };
}
function dec(c) {
  return {
    id: c.i, title: c.t,
    performer: { id: c.pi, name: c.p },
    album: { id: c.ai, title: c.a, image: { small: c.c, thumbnail: c.c } },
    duration: c.d, released_at: c.r,
    maximum_bit_depth: c.b, maximum_sampling_rate: c.s,
    hires: c.b >= 24, streamable: c.st !== 0, track_number: c.n,
    __libcompact: true
  };
}

function clearChunks(type, from, to) { for (var i = from; i < to; i++) { try { Q.storage.set(K_MCH(type, i), ""); } catch (e) {} } }

function persistMeta(type, fpv, list) {
  var oldIdx = readJSON(K_MIDX(type)) || {};
  var oldChunks = oldIdx.chunks || 0;
  if (list.length > META_MAX_PERSIST) { // too big to cache - keep memory-only, wipe any stale chunks
    clearChunks(type, 0, oldChunks);
    try { writeJSON(K_MIDX(type), { v: fpv, meta: false, chunks: 0, count: list.length }); } catch (e) {}
    return;
  }
  var n = Math.ceil(list.length / CHUNK) || 0, i = 0;
  try {
    for (i = 0; i < n; i++) {
      var slice = list.slice(i * CHUNK, (i + 1) * CHUNK).map(enc);
      writeJSON(K_MCH(type, i), slice); // throws on quota
    }
    if (oldChunks > n) clearChunks(type, n, oldChunks); // drop leftovers from a previously larger cache
    writeJSON(K_MIDX(type), { v: fpv, meta: true, chunks: n, count: list.length });
  } catch (e) { // quota (or other) - roll back to a clean "not persisted" state, memory keeps the data
    clearChunks(type, 0, Math.max(n, oldChunks));
    try { writeJSON(K_MIDX(type), { v: fpv, meta: false, chunks: 0, count: list.length }); } catch (e2) {}
  }
}

// Rehydrate metadata from the cache iff the fingerprint still matches (fpv null = accept any as a
// stale fallback). Returns the array, or null if there's nothing usable.
function hydrateMeta(type, fpv) {
  var idx = readJSON(K_MIDX(type));
  if (!idx || !idx.meta || !idx.chunks) return null;
  if (fpv != null && idx.v !== fpv) return null;
  var out = [], titled = false;
  for (var i = 0; i < idx.chunks; i++) {
    var ch = readJSON(K_MCH(type, i)); if (!ch || !ch.length) return null; // torn cache -> give up, re-page
    for (var j = 0; j < ch.length; j++) { if (ch[j].t) titled = true; out.push(dec(ch[j])); }
  }
  if (out.length && !titled) return null; // poisoned cache of id-only stubs (pre-fix wrap bug) -> re-page
  return out;
}

// ---------- loading ----------
function ensureIds(force) {
  if (mem.ids && !force) return Promise.resolve(mem.ids);
  if (mem.idsPromise && !force) return mem.idsPromise;
  mem.idsPromise = Q.api("favorite/getUserFavoriteIds").then(function (j) {
    j = j || {};
    var ids = { tracks: {}, albums: {}, artists: {} };
    idList(j.tracks).forEach(function (id) { ids.tracks[id] = 1; });
    idList(j.albums).forEach(function (id) { ids.albums[id] = 1; });
    idList(j.artists).forEach(function (id) { ids.artists[id] = 1; });
    mem.ids = ids;
    mem.fp = { tracks: fp(Object.keys(ids.tracks)), albums: fp(Object.keys(ids.albums)), artists: fp(Object.keys(ids.artists)) };
    persistIds();
    updateSettingsSub();
    return ids;
  }).catch(function () {
    mem.idsPromise = null;
    var seed = seedIdsFromCache(); // API failed - fall back to the last persisted id set
    if (seed) { mem.ids = seed.ids; mem.fp = seed.fp; updateSettingsSub(); }
    return mem.ids || { tracks: {}, albums: {}, artists: {} };
  });
  return mem.idsPromise;
}

function pageAll(type, fpv) {
  var all = [], offset = 0, total = null, pages = 0;
  progStart();
  function step() {
    // realApi, never Q.api: our own wrap (below) serves cached id-only stubs for favorites calls, and
    // paging through it would persist a metadata cache of empty records under a valid fingerprint.
    return realApi.call(Q, "favorite/getUserFavorites?type=" + type + "&limit=" + PAGE + "&offset=" + offset).then(function (j) {
      var node = j && j[type], items = (node && node.items) || [];
      if (total == null) total = (node && node.total) || (mem.ids && Object.keys(mem.ids[type] || {}).length) || items.length;
      all = all.concat(items);
      progUpdate(all.length, total);
      offset += PAGE; pages++;
      if (items.length === PAGE && all.length < total && pages < MAX_PAGES) return step();
      return all;
    });
  }
  return step().then(function (list) {
    persistMeta(type, fpv, list);
    progDone(list.length, false);
    return list;
  }, function (e) { progDone(all.length, true); throw e; });
}

function loadType(type, force) {
  if (mem.loaded[type] && !force) return Promise.resolve(mem.meta[type]);
  if (mem.loading[type]) return mem.loading[type];
  mem.loading[type] = ensureIds(force).then(function () {
    var fpNow = mem.fp[type];
    if (!force) {
      var cached = hydrateMeta(type, fpNow); // fingerprint still valid -> instant, no network paging
      if (cached) { notify({ type: type, loaded: cached.length, total: cached.length, done: true, cached: true }); return cached; }
    }
    return pageAll(type, fpNow);
  }).then(function (list) {
    mem.meta[type] = list; mem.loaded[type] = true; delete mem.loading[type]; updateSettingsSub();
    return list;
  }).catch(function () {
    delete mem.loading[type];
    var stale = hydrateMeta(type, null); // last-ditch: serve whatever's cached even if fingerprint moved
    if (stale) { mem.meta[type] = stale; mem.loaded[type] = true; return stale; }
    return mem.meta[type] || [];
  });
  return mem.loading[type];
}

// ---------- progress pill (subtle, bottom-right) ----------
var progTimer = null, hideTimer = null;
function progEl() {
  var el = document.getElementById(PROG_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = PROG_ID;
    el.innerHTML =
      '<span class="qz-lib-spin"></span>' +
      '<span class="qz-lib-txt"><span class="qz-lib-title">Syncing your library</span>' +
      '<span class="qz-lib-count"></span></span>' +
      '<span class="qz-lib-bar"><i></i></span>';
    document.body.appendChild(el);
  } else if (el.parentElement !== document.body) { document.body.appendChild(el); }
  return el;
}
function progShow() {
  var el = progEl();
  clearTimeout(hideTimer);
  el.classList.remove("qz-lib-done");
  requestAnimationFrame(function () { el.classList.add("qz-lib-in"); });
}
function progStart() {
  clearTimeout(progTimer);
  // only surface the pill if paging actually takes a beat - a fast/cached load never flashes it
  progTimer = setTimeout(progShow, 350);
}
function progUpdate(loaded, total) {
  notify({ type: "tracks", loaded: loaded, total: total, done: false });
  var el = document.getElementById(PROG_ID); if (!el || !el.classList.contains("qz-lib-in")) return;
  var pct = total ? Math.max(3, Math.min(100, Math.round(loaded / total * 100))) : 0;
  var c = el.querySelector(".qz-lib-count"); if (c) c.textContent = fmt(loaded) + (total ? " / " + fmt(total) : "");
  var b = el.querySelector(".qz-lib-bar > i"); if (b) b.style.width = pct + "%";
}
function progDone(loaded, failed) {
  clearTimeout(progTimer);
  notify({ type: "tracks", loaded: loaded, total: loaded, done: true, failed: !!failed });
  var el = document.getElementById(PROG_ID);
  if (!el || !el.classList.contains("qz-lib-in")) { if (el) el.classList.remove("qz-lib-in"); return; }
  el.classList.add("qz-lib-done");
  var t = el.querySelector(".qz-lib-title"); if (t) t.textContent = failed ? "Library sync incomplete" : "Library ready";
  var c = el.querySelector(".qz-lib-count"); if (c) c.textContent = fmt(loaded) + " tracks";
  var b = el.querySelector(".qz-lib-bar > i"); if (b) b.style.width = "100%";
  hideTimer = setTimeout(function () { var e = document.getElementById(PROG_ID); if (e) e.classList.remove("qz-lib-in"); }, 1500);
}
function notify(ev) { for (var i = 0; i < progCbs.length; i++) { try { progCbs[i](ev); } catch (e) {} } }

// ---------- shared API (the clean integration hook) ----------
// NOTE for Better Search (extensions/better-search): its loadKnown() marks favorites from a single
// capped "favorite/getUserFavorites?type=tracks&limit=500", so on a 40k library only 500 tracks get the
// "In favorites" tag. The order-independent fix is one line there:
//     known.fav[id] = 1  for id of Q.library.ids("tracks")   (guarded by Q.library && Q.library.idsReady())
// Better Search is left unedited per task; this exposes the complete set for it (and anyone) to adopt.
var libApi = {
  idsReady: function () { return !!mem.ids; },
  ready: function (type) { return !!mem.loaded[type || "tracks"]; },
  has: function (type, id) { try { return !!(mem.ids && mem.ids[type] && mem.ids[type][String(id)]); } catch (e) { return false; } },
  hasTrack: function (id) { return this.has("tracks", id); },
  ids: function (type) { try { return mem.ids ? Object.keys(mem.ids[type || "tracks"] || {}) : []; } catch (e) { return []; } },
  count: function (type) { try { return mem.ids ? Object.keys(mem.ids[type || "tracks"] || {}).length : 0; } catch (e) { return 0; } },
  get: function (type) { var m = mem.meta[type || "tracks"]; return m ? m.slice() : []; },
  tracks: function () { return this.get("tracks"); },
  load: function (type, opts) { return loadType(type || "tracks", !!(opts && opts.force)); },
  refresh: function () { mem.loaded = {}; mem.loading = {}; return ensureIds(true).then(function () { return loadType("tracks", true); }); },
  onProgress: function (fn) { if (typeof fn === "function") progCbs.push(fn); return function () { var i = progCbs.indexOf(fn); if (i >= 0) progCbs.splice(i, 1); }; },
  version: function (type) { return mem.fp[type || "tracks"] || null; }
};

// ---------- Q.api wrap: opportunistically serve Better Search's capped favorites call from the full set.
// Reversible (restored on cleanup) and scoped to EXACTLY better-search's signature (type=tracks,
// limit>=500, no non-zero offset) so it never touches stats(limit=100)/smart-playback(limit=200) or any
// real paged call. Because extensions load alphabetically, better-search runs before us on a cold boot
// and hits the original api - so this mainly upgrades it when better-search is toggled off/on after we've
// cached. The durable hook is Q.library above.
var realApi = Q.api;
function isBetterSearchFavCall(mp) {
  if (typeof mp !== "string" || mp.indexOf("favorite/getUserFavorites") !== 0) return false;
  if (!/(?:^|[?&])type=tracks(?:&|$)/.test(mp)) return false;
  var lm = mp.match(/[?&]limit=(\d+)/); if (!lm || +lm[1] < 500) return false;
  // any explicit offset means a real pager - better-search's one capped call carries none. Serving a
  // pager page 0 the ENTIRE set would end its loop with stubs (and offset=0 pages exist beyond ours).
  if (/[?&]offset=/.test(mp)) return false;
  return true;
}
function wrappedApi(methodPath) {
  try {
    if (isBetterSearchFavCall(methodPath) && mem.ids && mem.ids.tracks) {
      var ids = Object.keys(mem.ids.tracks);
      var items = ids.map(function (id) { var n = +id; return { id: isNaN(n) ? id : n }; });
      return Promise.resolve({ tracks: { items: items, total: items.length, limit: items.length, offset: 0 } });
    }
  } catch (e) {}
  return realApi.apply(Q, arguments);
}

// ---------- settings row (manual refresh + status) ----------
var settingsEntry = { label: "Library cache", sub: "Loading favorites...", button: "Reload", onClick: function () { libApi.refresh(); } };
function updateSettingsSub() {
  var favN = libApi.count("tracks");
  var cached = mem.loaded.tracks;
  settingsEntry.sub = favN ? (fmt(favN) + " favorite tracks" + (cached ? " - cached & searchable" : " - open your library to load")) : "No favorites found yet.";
}
var unregSettings = (typeof Q.registerSettings === "function") ? Q.registerSettings(settingsEntry) : function () {};

// ---------- route warming ----------
// Load full track metadata when the user actually opens their library (that's the slow native surface
// this fixes), or instantly if the fingerprint-matched cache is already warm. Marking (Q.library.hasTrack)
// works app-wide the moment the cheap id set lands, without paging.
function isLibraryRoute(p) { return typeof p === "string" && (/^\/user-library(\/|$)/.test(p) || /^\/user\/library\/favorites/.test(p)); }
var offRoute = Q.onRoute(function (path) { if (isLibraryRoute(path)) loadType("tracks", false); });

Q.css(CSS_ID, [
  "#" + PROG_ID + "{position:fixed;right:20px;bottom:20px;z-index:2147482000;display:flex;align-items:center;gap:11px;",
  "min-width:210px;max-width:calc(100vw - 40px);padding:11px 15px;border-radius:13px;font-family:inherit;",
  "background:linear-gradient(180deg,rgba(20,23,31,.98),rgba(12,14,20,.99));border:1px solid rgba(255,255,255,.12);",
  "box-shadow:0 18px 50px rgba(0,0,0,.5),0 0 34px -20px var(--qz-accent,#3DA8FE);color:#eef2f7;",
  "opacity:0;transform:translateY(12px);transition:opacity .2s ease,transform .2s ease;pointer-events:none;}",
  "#" + PROG_ID + ".qz-lib-in{opacity:1;transform:none;}",
  ".qz-lib-spin{flex:0 0 auto;width:17px;height:17px;border-radius:50%;border:2px solid rgba(255,255,255,.18);",
  "border-top-color:var(--qz-accent,#3DA8FE);animation:qz-lib-rot .7s linear infinite;}",
  "#" + PROG_ID + ".qz-lib-done .qz-lib-spin{border-color:var(--qz-accent,#3DA8FE);border-top-color:var(--qz-accent,#3DA8FE);animation:none;}",
  "@keyframes qz-lib-rot{to{transform:rotate(360deg);}}",
  ".qz-lib-txt{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;}",
  ".qz-lib-title{font-size:12.5px;font-weight:700;color:#eef2f7;white-space:nowrap;}",
  ".qz-lib-count{font-size:11.5px;font-weight:600;color:#9aa3b2;white-space:nowrap;font-variant-numeric:tabular-nums;}",
  ".qz-lib-bar{position:absolute;left:14px;right:14px;bottom:7px;height:2px;border-radius:2px;background:rgba(255,255,255,.1);overflow:hidden;}",
  ".qz-lib-bar>i{display:block;height:100%;width:0;border-radius:2px;background:var(--qz-accent,#3DA8FE);transition:width .25s ease;}"
].join(""));

// publish the shared API + wrap, then kick off the cheap id load
Q.library = libApi;
Q.api = wrappedApi;
ensureIds(false).then(function () {
  // warm track metadata silently if the fingerprint-matched cache is still valid (no network paging)
  var cached = hydrateMeta("tracks", mem.fp.tracks);
  if (cached) {
    mem.meta.tracks = cached; mem.loaded.tracks = true; updateSettingsSub();
    notify({ type: "tracks", loaded: cached.length, total: cached.length, done: true, cached: true });
  }
});

return function cleanup() {
  if (offRoute) offRoute();
  if (unregSettings) unregSettings();
  clearTimeout(progTimer); clearTimeout(hideTimer);
  if (Q.api === wrappedApi) Q.api = realApi;      // restore the shared primitive exactly
  if (Q.library === libApi) { try { delete Q.library; } catch (e) { Q.library = undefined; } }
  progCbs.length = 0;
  var el = document.getElementById(PROG_ID); if (el) el.remove();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
  // persistent cache (Q.storage) is intentionally left in place so a re-enable warms instantly.
};
