// Last.fm scrobbling + history import. Runs as function(Qobuzify, vendor){ ... return cleanup }.
//
// What it does:
//  1. Watches the player. When a track starts it POSTs track.updateNowPlaying; once the track has
//     played >= 50% of its length OR >= 4 minutes (whichever comes first, the Last.fm rule) it POSTs
//     track.scrobble. Seeks don't count toward the played time (delta is clamped), and tracks under
//     30s are never scrobbled (Last.fm ignores them anyway).
//  2. Auth + signing are done by the Qobuzify worker (api.qobuzify.app/v1/lastfm). This extension NEVER
//     holds the Last.fm API key or shared secret and never computes an api_sig. Connect is a web-callback
//     flow: mint a random nonce, ask the worker for the (non-secret) api_key, open the browser to
//     last.fm/api/auth?api_key&cb=<worker callback carrying the nonce>. The worker's callback signs
//     auth.getSession and stashes the resulting session key against the nonce; we then poll the worker
//     for the session key by nonce and store just the sk locally. Every write (scrobble/nowplaying)
//     posts {sk, ...} to the worker, which signs and forwards it to Last.fm.
//  3. A row in the Qobuzify settings panel (via Q.registerSettings, same as block-trash) opens a
//     small modal to Connect / Disconnect and see status.
//  4. Bonus: "Import your Qobuzify history to Last.fm" reads the plays the Listening Stats extension
//     records (its IndexedDB "qobuzify-stats", or its in-memory global, or the cloud copy via the
//     stored syncId) and batch-scrobbles them <=50 at a time. Last.fm silently rejects scrobbles
//     older than ~2 weeks, so most historical plays bounce; we attempt them anyway and report how
//     many Last.fm accepted.
//
// SETUP (maintainer): the key + secret are Worker secrets, not shipped here. Set them once on the worker:
//   wrangler secret put LASTFM_API_KEY   /   wrangler secret put LASTFM_API_SECRET   then deploy.
// Nothing is sent anywhere before the user connects, and the client stays inert until it holds an sk.

try {
  var Q = window.Qobuzify || Qobuzify;
  if (!Q || !Q.player) return function () {};

  // Worker signing proxy. Override via Q.storage "lastfm:api" for local testing; trailing slashes trimmed.
  var LFM_API = (Q.storage.get("lastfm:api", "") || "https://api.qobuzify.app/v1/lastfm").replace(/\/+$/, "");
  var AUTH_URL = "https://www.last.fm/api/auth/";
  var _fetch = window.fetch.bind(window); // capture the real fetch before any other extension wraps it

  // persisted state
  var sessionKey = Q.storage.get("lastfm:sk", "") || "";
  var username = Q.storage.get("lastfm:user", "") || "";
  function connected() { return !!sessionKey; }
  function enabled() { return Q.storage.get("lastfm:enabled", "1") === "1"; }

  // ---------------------------------------------------------------------------
  // Transport to the worker. No key, no secret, no api_sig here - the worker does all of that.
  // ---------------------------------------------------------------------------
  function getJSON(path) {
    return _fetch(LFM_API + path).then(function (r) { return r.json(); });
  }
  // A rejection that never reached the worker (offline, DNS) is tagged e.net, so the retry queue can tell
  // "try again later" apart from an answer that keeps failing.
  function postJSON(path, obj) {
    return _fetch(LFM_API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(obj)
    }).catch(function (e) { e = e || new Error("network"); try { e.net = true; } catch (_) {} throw e; })
      .then(function (r) { return r.json(); });
  }
  function randNonce() {
    var a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    var s = ""; for (var i = 0; i < a.length; i++) s += ("0" + a[i].toString(16)).slice(-2);
    return s;
  }

  // ---------------------------------------------------------------------------
  // Auth flow (web callback, worker-signed). We never see a Last.fm token or the api_sig; we hand the
  // browser off to Last.fm with the worker's callback URL, then poll the worker for the session key.
  // ---------------------------------------------------------------------------
  var authPoll = null, authTries = 0, pendingAuth = null; // pendingAuth = { nonce, apiKey, url }
  function openExternal(url) { try { window.open(url, "_blank", "noopener,noreferrer"); } catch (e) {} }
  // When live scrobbling began for an account. History import only sends plays from BEFORE this, since
  // everything after it was already scrobbled live (Last.fm doesn't dedupe: the timestamps differ). Kept per
  // username and never moved later, so a disconnect + reconnect doesn't reopen the window it already covered.
  var DAY_MS = 86400000;
  function connectedAtKey(u) { return "lastfm:connectedAt:" + (u || ""); }
  function connectedAt(u) { var v = Number(Q.storage.get(connectedAtKey(u), "")); return isFinite(v) && v > 0 ? v : 0; }
  function stampConnectedAt(u, ms) { var cur = connectedAt(u); if (!cur || ms < cur) Q.storage.set(connectedAtKey(u), String(ms)); }
  // Import high-water mark (seconds): the newest play timestamp an import already delivered for this account.
  function importHWKey(u) { return "lastfm:importHW:" + (u || ""); }
  function importHW(u) { var v = Number(Q.storage.get(importHWKey(u), "")); return isFinite(v) && v > 0 ? v : 0; }
  function setImportHW(u, ts) { if (ts > importHW(u)) Q.storage.set(importHWKey(u), String(ts)); }
  function pickupSession(j) {
    if (j && j.ok && j.sk) {
      sessionKey = j.sk; username = j.user || "";
      Q.storage.set("lastfm:sk", sessionKey); Q.storage.set("lastfm:user", username);
      stampConnectedAt(username, Date.now());
      return true;
    }
    return false; // { ok:false, pending:true } -> keep polling
  }
  // A session from before connectedAt existed: we can't know when live scrobbling started, so assume ~2 weeks
  // ago. Last.fm rejects scrobbles older than that anyway, so this can only skip plays, never send one twice.
  if (sessionKey && !connectedAt(username)) stampConnectedAt(username, Date.now() - 14 * DAY_MS);
  function pollSession(nonce) {
    return getJSON("/session?n=" + encodeURIComponent(nonce)).catch(function () { return null; });
  }
  function stopAuthPoll() { if (authPoll) { clearInterval(authPoll); authPoll = null; } }
  function startSessionPoll(nonce) {
    stopAuthPoll(); authTries = 0;
    authPoll = setInterval(function () {
      if (++authTries > 40) { stopAuthPoll(); setStatus("Authorization timed out. Click Connect to try again."); return; } // ~2 min
      pollSession(nonce).then(function (j) {
        if (pickupSession(j)) { stopAuthPoll(); pendingAuth = null; renderModal(); flushQueue(); toast("Connected to Last.fm as " + username); }
      });
    }, 3000);
  }
  function connect() {
    setStatus("Contacting Last.fm...");
    var nonce = randNonce();
    getJSON("/connect/start").then(function (j) {
      var apiKey = j && j.ok && j.apiKey;
      if (!apiKey) { setStatus("Couldn't reach the Qobuzify server. Check your connection and try again."); return; }
      var cb = encodeURIComponent(LFM_API + "/callback?n=" + nonce);
      var url = AUTH_URL + "?api_key=" + encodeURIComponent(apiKey) + "&cb=" + cb;
      pendingAuth = { nonce: nonce, apiKey: apiKey, url: url };
      openExternal(url);
      renderModal(); // reveals the "waiting for authorization" state + the auth URL
      startSessionPoll(nonce);
    }).catch(function () { setStatus("Couldn't reach the Qobuzify server. Check your connection and try again."); });
  }
  function disconnect() {
    stopAuthPoll(); pendingAuth = null;
    sessionKey = ""; username = "";
    Q.storage.set("lastfm:sk", ""); Q.storage.set("lastfm:user", "");
    renderModal();
  }

  // ---------------------------------------------------------------------------
  // Now Playing + scrobbling
  // ---------------------------------------------------------------------------
  function safeTrack() { try { return Q.player.getTrack(); } catch (e) { return null; } }
  function safePos() { try { return Q.player.getPositionMs() || 0; } catch (e) { return 0; } }
  function safePlaying() { try { return !!Q.player.isPlaying(); } catch (e) { return false; } }
  // Last.fm rule: scrobble at half the track, or 4 minutes, whichever is sooner.
  function threshold(durMs) { if (!durMs) return 240000; return Math.min(durMs / 2, 240000); }
  function acceptedCount(resp) { try { return parseInt(resp.scrobbles["@attr"].accepted, 10) || 0; } catch (e) { return 0; } }

  // Authoritative artist/track/album per id from track/get (the player-bar scrape can hand back a
  // torn snapshot mid-change, and its first /artist/ link isn't always the main performer). Only a real
  // track/get answer is cached. On failure the caller's fallback is returned uncached, and that fallback is
  // only ever built from the SETTLED track Q.player.onChange delivers (fbFrom), never from a getTrack()
  // taken mid-change, which paired the new id with the previous track's title.
  var metaCache = {};
  function fbFrom(t) { return t && t.id != null ? { artist: t.artist || (t.artists || [])[0] || "", track: t.title || "", album: t.album || "", durationMs: t.durationMs || 0 } : null; }
  function resolveMeta(id, fallback) {
    if (id == null) return Promise.resolve(fallback);
    if (metaCache[id]) return Promise.resolve(metaCache[id]);
    if (!Q.api) return Promise.resolve(fallback);
    return Q.api("track/get?track_id=" + id).then(function (j) {
      var perf = (j && (j.performer || (j.album && j.album.artist))) || null;
      fallback = fallback || {};
      var m = {
        artist: (perf && perf.name) || fallback.artist || "",
        track: (j && j.title) || fallback.track || "",
        album: (j && j.album && j.album.title) || fallback.album || "",
        durationMs: fallback.durationMs || (j && j.duration ? j.duration * 1000 : 0)
      };
      if (m.artist && m.track) metaCache[id] = m;
      return m;
    }).catch(function () { return fallback; });
  }

  function sendNowPlaying(m) {
    if (!connected() || !enabled() || !m || !m.artist || !m.track) return;
    var body = { sk: sessionKey, artist: m.artist, track: m.track };
    if (m.album) body.album = m.album;
    if (m.durationMs) body.duration = Math.round(m.durationMs / 1000);
    postJSON("/nowplaying", body).catch(function () {}); // best-effort, nothing to retry
  }
  // POST the batch to the worker (which signs + forwards to Last.fm). Worker returns Last.fm's JSON
  // verbatim, so callers still key off resp.error (9 = invalid session) and resp.scrobbles["@attr"].
  function scrobbleBatch(items) {
    var scrobbles = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var s = { artist: it.artist, track: it.track, timestamp: it.timestamp };
      if (it.album) s.album = it.album;
      if (it.duration) s.duration = it.duration;
      scrobbles.push(s);
    }
    return postJSON("/scrobble", { sk: sessionKey, scrobbles: scrobbles });
  }

  // Retry queue for scrobbles that didn't land. Each item is tagged with the Last.fm username it was played
  // under (item.user) and only ever flushes into that account: items for another account are held until it
  // reconnects. Untagged items from before tagging are adopted by whoever is connected. An answer that isn't
  // a success counts against the item (item.tries) and it is dropped after QUEUE_MAX_TRIES, so one permanent
  // error can't wedge the head of the queue forever; going offline (e.net) doesn't count. Items past Last.fm's
  // ~2 week window are dropped too, since it would ignore them.
  var QKEY = "lastfm:queue";
  var QUEUE_MAX_TRIES = 6;
  function loadQueue() { try { var q = JSON.parse(Q.storage.get(QKEY, "[]")); return Array.isArray(q) ? q : []; } catch (e) { return []; } }
  function saveQueue(q) { try { Q.storage.set(QKEY, JSON.stringify(q.slice(-500))); } catch (e) {} }
  function enqueue(item) { item.user = username; var q = loadQueue(); q.push(item); saveQueue(q); }
  function qKey(it) { return (it && (it.user || "")) + "|" + (it && it.timestamp) + "|" + (it && it.artist) + "|" + (it && it.track); }
  var flushing = false;
  function flushQueue() {
    if (flushing || !connected() || !enabled()) return;
    var minTs = Math.floor((Date.now() - 14 * DAY_MS) / 1000);
    var q = loadQueue(), changed = false;
    q = q.filter(function (it) {
      if (!it || !it.artist || !it.track || !it.timestamp || it.timestamp < minTs) { changed = true; return false; }
      if (it.user == null) { it.user = username; changed = true; }
      return true;
    });
    if (changed) saveQueue(q);
    var batch = q.filter(function (it) { return it.user === username; }).slice(0, 50);
    if (!batch.length) return;
    flushing = true;
    var keys = batch.map(qKey);
    // remove (or charge a try to) exactly this batch's items in the CURRENT stored queue, which may have grown
    function settle(charge) {
      var want = {}; keys.forEach(function (k) { want[k] = (want[k] || 0) + 1; });
      saveQueue(loadQueue().filter(function (it) {
        var k = qKey(it); if (!want[k]) return true;
        want[k]--;
        if (!charge) return false;
        it.tries = (it.tries || 0) + 1;
        return it.tries < QUEUE_MAX_TRIES;
      }));
    }
    scrobbleBatch(batch).then(function (resp) {
      if (resp && resp.error === 9) { flushing = false; disconnect(); return; } // invalid session key; items stay held for that account
      settle(!(resp && resp.scrobbles)); // processed (accepted or too-old-ignored) -> drop; any other answer -> charge a try
      flushing = false;
    }).catch(function (e) { if (!(e && e.net)) settle(true); flushing = false; }); // offline keeps the queue untouched
  }

  // live logger: one snapshot object per track, accumulating real listened time
  var scr = null;
  function tick() {
    try {
      var t = safeTrack();
      if (!t || t.id == null) { scr = null; return; }
      if (!scr || scr.id !== t.id) {
        // only the id (store-side, never torn) and duration are taken here; names come from onSettled()
        scr = { id: t.id, startTs: Date.now(), listenedMs: 0, lastPos: safePos(), durationMs: t.durationMs || 0, scrobbled: false, fb: null };
        if (settledFb && settledFb.id === t.id) attachSettled(settledFb.fb);
        return;
      }
      if (safePlaying()) {
        var pos = safePos(), delta = pos - scr.lastPos; scr.lastPos = pos;
        if (delta > 0 && delta < 4000) scr.listenedMs += delta; // ignore seeks / big jumps
        else if (delta < -5000 && pos < 3000) {
          // same id, position wrapped back to ~0: repeat-one (or a manual replay) restarted the
          // track. Re-arm so the new play scrobbles under the normal 50%/4min rule.
          scr.startTs = Date.now(); scr.listenedMs = 0; scr.scrobbled = false;
          var mc = metaCache[scr.id] || scr.fb; if (mc) sendNowPlaying(mc); // cached/settled only - best-effort, like every nowplaying
        }
        if (!scr.scrobbled && scr.durationMs >= 30000 && scr.listenedMs >= threshold(scr.durationMs)) {
          scr.scrobbled = true;
          doScrobble(scr);
        }
      } else { scr.lastPos = safePos(); }
    } catch (e) {}
  }
  // The settled track for the newest change, from Q.player.onChange (title stable across reads, so it's
  // the new track's own). This is the ONLY source for a fallback when track/get fails.
  var settledFb = null; // { id, fb }
  function attachSettled(fb) {
    if (!scr || !fb) return;
    scr.fb = fb;
    var id = scr.id;
    resolveMeta(id, fb).then(function (m) { if (scr && scr.id === id) sendNowPlaying(m); });
  }
  function onSettled(t) {
    var fb = fbFrom(t);
    settledFb = fb ? { id: t.id, fb: fb } : null;
    tick(); // makes scr for this id if the 1s tick hasn't yet (and attaches the settled names)
    if (fb && scr && scr.id === t.id && scr.fb !== fb) attachSettled(fb);
  }
  function doScrobble(s) {
    if (!connected() || !enabled()) return;
    var id = s.id, startTs = s.startTs, durationMs = s.durationMs, fb = s.fb;
    // retry track/get at scrobble time if it failed at the change; fall back to the settled names only
    resolveMeta(id, fb).then(function (m) {
      if (!m || !m.artist || !m.track || !connected() || !enabled()) return;
      var item = { artist: m.artist, track: m.track, album: m.album || "" };
      item.timestamp = Math.floor(startTs / 1000);
      if (durationMs) item.duration = Math.round(durationMs / 1000);
      scrobbleBatch([item]).then(function (resp) {
        if (resp && resp.error === 9) { disconnect(); return; }
        if (!resp || !resp.scrobbles) enqueue(item); // unexpected/transient body -> retry later
      }).catch(function () { enqueue(item); }); // network failure -> retry later
    });
  }

  // ---------------------------------------------------------------------------
  // History import (from the Listening Stats extension's recorded plays)
  // ---------------------------------------------------------------------------
  function statsGlobal() {
    try {
      if (window.__QZ_STATS && typeof window.__QZ_STATS.all === "function")
        return Promise.resolve(window.__QZ_STATS.all()).then(function (p) { return p || []; }).catch(function () { return []; });
    } catch (e) {}
    return Promise.resolve([]);
  }
  function statsDB() {
    return new Promise(function (res) {
      try {
        var r = indexedDB.open("qobuzify-stats");
        // If the DB doesn't exist, don't create a phantom one (stats would then find its store missing
        // and break). Aborting the upgrade cancels the open cleanly and we treat it as "no history".
        r.onupgradeneeded = function (e) { try { e.target.transaction.abort(); } catch (_) {} };
        r.onerror = function () { res([]); };
        r.onsuccess = function (e) {
          var db = e.target.result, out = [];
          try {
            if (!db.objectStoreNames.contains("plays")) { db.close(); return res([]); }
            var cur = db.transaction("plays", "readonly").objectStore("plays").openCursor();
            cur.onsuccess = function (ev) { var c = ev.target.result; if (c) { out.push(c.value); c.continue(); } else { db.close(); res(out); } };
            cur.onerror = function () { try { db.close(); } catch (_) {} res(out); };
          } catch (err) { try { db.close(); } catch (_) {} res([]); }
        };
      } catch (e) { res([]); }
    });
  }
  function cloudPlays() {
    var sid = null; try { sid = localStorage.getItem("qz-stats-syncid"); } catch (e) {}
    if (!sid || !/^[A-Za-z0-9-]{16,64}$/.test(sid)) return Promise.resolve([]);
    return _fetch("https://api.qobuzify.app/v1/stats/pull?qz=1&syncId=" + encodeURIComponent(sid) + "&since=0")
      .then(function (r) { return r.json(); }).then(function (j) { return (j && j.plays) || []; }).catch(function () { return []; });
  }
  function readHistory() {
    return statsGlobal()
      .then(function (p) { return p.length ? p : statsDB(); })
      .then(function (p) { return p.length ? p : cloudPlays(); });
  }
  // Only plays from before live scrobbling began for this account (connectedAt) and newer than what an
  // import already delivered (the high-water mark) are sent, so repeated clicks never send a play twice.
  // The running flag lives on window, not in this closure: a disabled-then-re-enabled extension is a new
  // closure and would otherwise start a second import beside the first. A disabled instance stops at its
  // next batch boundary (disposed) and only then releases the flag.
  var disposed = false;
  function importBusy() { return !!window.__qzLfmImport; }
  function runImport() {
    if (importBusy()) { setStatus("An import is already running."); return; }
    if (!connected()) { setStatus("Connect Last.fm first."); return; }
    var user = username, cutoff = connectedAt(user), hw = importHW(user);
    if (!cutoff) { setStatus("Couldn't tell when scrobbling started for this account. Reconnect Last.fm and try again."); return; }
    var token = {}; window.__qzLfmImport = token; // claim before the async read so a second click can't slip in
    function release() { if (window.__qzLfmImport === token) window.__qzLfmImport = null; }
    setStatus("Reading your recorded play history...");
    readHistory().then(function (plays) {
      if (disposed || username !== user) { release(); return; }
      var seen = {}, items = [], cutoffTs = Math.floor(cutoff / 1000);
      (plays || []).forEach(function (p) {
        var artist = p.artist || "", track = p.title || "", ts = Math.floor((p.ts || 0) / 1000);
        if (!artist || !track || !ts) return;
        if (ts >= cutoffTs || ts <= hw) return; // scrobbled live already, or sent by an earlier import
        var key = artist + "|" + track + "|" + ts;
        if (seen[key]) return; seen[key] = 1;
        var it = { artist: artist, track: track, timestamp: ts };
        if (p.album) it.album = p.album;
        if (p.durationMs) it.duration = Math.round(p.durationMs / 1000);
        items.push(it);
      });
      items.sort(function (a, b) { return a.timestamp - b.timestamp; });
      if (!items.length) { release(); setStatus(hw ? "Nothing new to import. Plays since you connected were scrobbled live, and earlier ones were already imported." : "No recorded plays from before you connected. The Listening Stats extension logs plays as you listen; everything since you connected was scrobbled live."); return; }
      batchImport(items, user, token, release);
    }).catch(function () { release(); setStatus("Couldn't read your play history."); });
  }
  function batchImport(items, user, token, release) {
    var total = items.length, sent = 0, accepted = 0, idx = 0;
    setStatus("Importing 0 / " + total + " ...");
    function next() {
      if (disposed || window.__qzLfmImport !== token) { release(); return; }
      if (username !== user || !connected()) { release(); setStatus("Account changed; import stopped at " + sent + " / " + total + "."); return; }
      if (idx >= items.length) {
        release();
        setStatus("Done. Sent " + sent + " of " + total + " plays; Last.fm accepted " + accepted + ". (It rejects scrobbles older than ~2 weeks, so older plays bounce.)");
        return;
      }
      var batch = items.slice(idx, idx + 50); idx += batch.length;
      scrobbleBatch(batch).then(function (resp) {
        if (resp && resp.error === 9) { release(); disconnect(); setStatus("Session expired. Reconnect Last.fm and try again."); return; }
        if (!resp || !resp.scrobbles) { release(); setStatus("Last.fm didn't take the batch at " + sent + " / " + total + ". Try the import again later."); return; }
        // delivered (accepted or ignored as too old): never send these again
        setImportHW(user, batch[batch.length - 1].timestamp);
        sent += batch.length; accepted += acceptedCount(resp);
        setStatus("Importing " + Math.min(idx, total) + " / " + total + " (" + accepted + " accepted) ...");
        setTimeout(next, 500); // stay polite to the API between batches
      }).catch(function () { release(); setStatus("Network error at " + sent + " / " + total + ". Reopen and retry to continue."); });
    }
    next();
  }

  // ---------------------------------------------------------------------------
  // Settings modal (opened from the Qobuzify settings panel row)
  // ---------------------------------------------------------------------------
  var CSS_ID = "qz-lfm-css", MODAL_ID = "qz-lfm-modal";
  var IC = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="2.2"/><path d="M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 7.5a6.4 6.4 0 0 1 0 9M4.7 4.7a10.3 10.3 0 0 0 0 14.6M19.3 4.7a10.3 10.3 0 0 1 0 14.6"/></svg>';
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function setStatus(t) { var s = document.querySelector("#" + MODAL_ID + " [data-status]"); if (s) s.textContent = t || " "; }

  function modalInner() {
    var head = '<div class="qz-lfm-box"><div class="qz-lfm-h">' + IC + ' Last.fm<button class="qz-lfm-close" data-act="close" aria-label="Close">&#215;</button></div>';
    if (connected()) {
      var on = enabled();
      return head +
        '<div class="qz-lfm-conn"><span class="qz-lfm-dot"></span>Connected as <b>' + esc(username || "your account") + '</b></div>' +
        '<div class="qz-lfm-row"><span>Scrobble what I play</span><button class="qz-lfm-sw' + (on ? " on" : "") + '" data-act="toggle"><span></span></button></div>' +
        '<div class="qz-lfm-sec"><div class="qz-lfm-lbl">Import history</div>' +
          '<p class="qz-lfm-p">Send the plays the Listening Stats extension has recorded to Last.fm, oldest first, in batches of 50. Last.fm rejects anything older than ~2 weeks, so most historical plays will bounce.</p>' +
          '<button class="qz-lfm-btn" data-act="import">Import your Qobuzify history to Last.fm</button></div>' +
        '<div class="qz-lfm-status" data-status>&nbsp;</div>' +
        '<div class="qz-lfm-foot"><button class="qz-lfm-btn ghost" data-act="disconnect">Disconnect</button><button class="qz-lfm-btn" data-act="close">Done</button></div></div>';
    }
    if (pendingAuth) {
      var authLink = pendingAuth.url;
      return head +
        '<p class="qz-lfm-p">A Last.fm authorization page should have opened in your browser. Approve access there, then come back &mdash; this finishes automatically. If nothing opened, use the link below.</p>' +
        '<div class="qz-lfm-idrow"><code class="qz-lfm-id">' + esc(authLink) + '</code><button class="qz-lfm-btn" data-act="copy">Copy</button></div>' +
        '<div class="qz-lfm-status" data-status>Waiting for authorization...</div>' +
        '<div class="qz-lfm-foot"><button class="qz-lfm-btn ghost" data-act="cancel">Cancel</button><button class="qz-lfm-btn" data-act="finish">I&#39;ve authorized</button></div></div>';
    }
    return head +
      '<p class="qz-lfm-p">Connect your Last.fm account to scrobble the tracks you play in Qobuz. A browser window opens for you to approve access; nothing is sent until you connect.</p>' +
      '<div class="qz-lfm-status" data-status>&nbsp;</div>' +
      '<div class="qz-lfm-foot"><button class="qz-lfm-btn ghost" data-act="close">Close</button><button class="qz-lfm-btn accent" data-act="connect">Connect Last.fm</button></div></div>';
  }
  function renderModal() { var m = document.getElementById(MODAL_ID); if (m) m.innerHTML = modalInner(); }
  function closeModal() { var m = document.getElementById(MODAL_ID); if (m) m.remove(); }
  function openModal() {
    closeModal();
    var m = document.createElement("div"); m.id = MODAL_ID; m.className = "qz-lfm-modal";
    m.innerHTML = modalInner();
    document.body.appendChild(m);
    m.addEventListener("mousedown", function (e) { if (e.target === m) closeModal(); });
    m.addEventListener("click", function (e) {
      var act = e.target.closest ? e.target.closest("[data-act]") : null; if (!act) return;
      switch (act.getAttribute("data-act")) {
        case "close": closeModal(); break;
        case "connect": connect(); break;
        case "cancel": stopAuthPoll(); pendingAuth = null; renderModal(); break;
        case "finish": if (pendingAuth) pollSession(pendingAuth.nonce).then(function (j) { if (pickupSession(j)) { stopAuthPoll(); pendingAuth = null; renderModal(); flushQueue(); } else setStatus("Not authorized yet. Approve access in the browser, then try again."); }); break;
        case "disconnect": disconnect(); toast("Disconnected from Last.fm"); break;
        case "import": runImport(); break;
        case "toggle": { var now = !enabled(); Q.storage.set("lastfm:enabled", now ? "1" : "0"); act.classList.toggle("on", now); if (now) flushQueue(); break; }
        case "copy": try { navigator.clipboard.writeText((pendingAuth && pendingAuth.url) || ""); setStatus("Link copied."); } catch (e2) {} break;
      }
    });
  }

  // small transient toast for connect/disconnect/errors (not per-scrobble)
  var toastEl = null, toastT = null;
  function toast(msg) {
    if (!toastEl) { toastEl = document.createElement("div"); toastEl.className = "qz-lfm-toast"; document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(function () { if (toastEl) toastEl.classList.remove("show"); }, 2000);
  }

  Q.css(CSS_ID, [
    ".qz-lfm-modal{position:fixed;inset:0;z-index:2147483601;display:flex;align-items:center;justify-content:center;background:rgba(4,6,10,.62);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);-webkit-app-region:no-drag;}",
    ".qz-lfm-box{width:min(470px,93vw);max-height:88vh;overflow:auto;background:linear-gradient(180deg,rgba(22,25,33,.98),rgba(13,15,21,.99));border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:18px 20px;box-shadow:0 30px 80px rgba(0,0,0,.6);color:#e7ebf2;}",
    ".qz-lfm-h{display:flex;align-items:center;gap:9px;font-size:16px;font-weight:800;color:#eef2f7;}",
    ".qz-lfm-h svg{color:var(--qz-accent,#3DA8FE);}",
    ".qz-lfm-close{margin-left:auto;appearance:none;border:0;background:transparent;color:#98a2b3;font-size:22px;line-height:1;cursor:pointer;padding:0 2px;}.qz-lfm-close:hover{color:#fff;}",
    ".qz-lfm-p{font-size:12.5px;color:#9aa3b2;line-height:1.55;margin:12px 0;}.qz-lfm-p b{color:#cbd3df;}",
    ".qz-lfm-conn{display:flex;align-items:center;gap:9px;font-size:13.5px;color:#dbe1ea;margin:14px 0 6px;}.qz-lfm-conn b{color:#fff;}",
    ".qz-lfm-dot{width:9px;height:9px;border-radius:50%;background:#4ade80;box-shadow:0 0 0 3px rgba(74,222,128,.18);flex:0 0 auto;}",
    ".qz-lfm-row{display:flex;align-items:center;justify-content:space-between;padding:11px 0;font-size:13.5px;border-top:1px solid rgba(255,255,255,.07);}",
    ".qz-lfm-sw{position:relative;width:44px;height:25px;border-radius:20px;border:0;background:rgba(255,255,255,.16);cursor:pointer;transition:background .16s;flex:0 0 auto;}",
    ".qz-lfm-sw span{position:absolute;top:3px;left:3px;width:19px;height:19px;border-radius:50%;background:#fff;transition:left .16s;}",
    ".qz-lfm-sw.on{background:var(--qz-accent,#3DA8FE);}.qz-lfm-sw.on span{left:22px;}",
    ".qz-lfm-sec{margin-top:8px;border-top:1px solid rgba(255,255,255,.07);padding-top:12px;}",
    ".qz-lfm-lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#8b93a2;margin-bottom:4px;}",
    ".qz-lfm-idrow{display:flex;gap:8px;align-items:center;margin:8px 0;}",
    ".qz-lfm-id{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.09);border-radius:8px;padding:7px 9px;font:600 11.5px/1.3 ui-monospace,monospace;color:#cdd5e0;}",
    ".qz-lfm-status{font-size:12px;color:var(--qz-accent,#3DA8FE);min-height:16px;margin:10px 0 2px;line-height:1.5;}",
    ".qz-lfm-foot{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap;}",
    ".qz-lfm-btn{appearance:none;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#e7ebf2;font:inherit;font-size:12.5px;font-weight:650;padding:9px 14px;border-radius:9px;cursor:pointer;white-space:nowrap;-webkit-app-region:no-drag;}",
    ".qz-lfm-btn:hover{background:rgba(255,255,255,.13);}.qz-lfm-btn.ghost{background:transparent;}",
    ".qz-lfm-btn.accent{background:var(--qz-accent,#3DA8FE);border-color:var(--qz-accent,#3DA8FE);color:#06090a;}",
    ".qz-lfm-toast{position:fixed;left:50%;bottom:98px;transform:translateX(-50%) translateY(8px);background:rgba(20,22,28,.97);color:#fff;padding:9px 16px;border-radius:11px;font:600 13px/1 system-ui,sans-serif;z-index:2147483650;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;box-shadow:0 10px 34px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.1);}",
    ".qz-lfm-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}"
  ].join(""));

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  var unregSettings = Q.registerSettings ? Q.registerSettings({
    label: "Last.fm",
    sub: "Scrobble your plays and import your listening history.",
    button: "Open",
    onClick: openModal
  }) : null;

  var iv = setInterval(tick, 1000);
  var flushIv = setInterval(flushQueue, 90000);
  var offChange = null;
  try { offChange = Q.player.onChange(onSettled); } catch (e) {} // settled names + prompt Now Playing on every change
  // Enabled mid-track: onChange won't fire for the track already playing, and there is no settled snapshot to
  // fall back on, so Now Playing (and later the scrobble) rely on track/get alone for this one track.
  tick();
  if (scr && !scr.fb) { var bootId = scr.id; resolveMeta(bootId, null).then(function (m) { if (scr && scr.id === bootId) sendNowPlaying(m); }); }
  if (connected()) setTimeout(flushQueue, 4000); // retry anything the last session couldn't send

  return function cleanup() {
    disposed = true; // a running import stops at its next batch and releases window.__qzLfmImport
    try { clearInterval(iv); } catch (e) {}
    try { clearInterval(flushIv); } catch (e) {}
    stopAuthPoll();
    try { if (typeof offChange === "function") offChange(); } catch (e) {}
    if (unregSettings) unregSettings();
    closeModal();
    if (toastEl) { toastEl.remove(); toastEl = null; }
    var st = document.getElementById(CSS_ID); if (st) st.remove();
  };
} catch (e) { return function () {}; }
