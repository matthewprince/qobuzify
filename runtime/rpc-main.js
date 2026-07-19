/* Qobuzify Discord Rich Presence - MAIN PROCESS module.
   Copied into main-win32.js (appended) by lib/apply.js. The renderer is sandboxed (no Node), so
   Discord IPC must live here; the renderer POSTs the current track to the localhost bridge below.

   We speak the Discord IPC protocol directly (Node net, no deps) so we FULLY own reconnect:
     - On any pipe close/error: tear down, keep retrying pipes 0..9 with backoff, re-handshake,
       re-push the last activity when Discord returns.
     - HEARTBEAT: switching Discord accounts RELOADS the client but keeps its IPC process alive, so
       the socket never closes - it goes SILENTLY dead while we still think we're connected. So every
       few seconds we (a) re-assert the presence (Discord clears it on the account-switch reload) and
       (b) if Discord has stopped responding (stale receive), force a full reconnect + re-handshake.
   Everything is wrapped so this can NEVER throw at require-time or crash Qobuz's main process. */
;(function () {
try {
  var net = require("net");
  var http = require("http");
  var fs = require("fs");
  var electron = null; try { electron = require("electron"); } catch (_) {}

  var CLIENT_ID = "1519198716417020004"; // Qobuzify's built-in Discord app
  var BRIDGE_PORT = 7673;
  var OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
  var HEARTBEAT_MS = 8000, STALE_MS = 15000, BACKOFF_MAX = 5000;

  var sock = null, ready = false, seq = 0, lastActivity = null, lastRecvAt = 0;
  var reconnectTimer = null, backoff = 1000, connecting = false;

  // Discord's IPC socket is NOT reliably at $XDG_RUNTIME_DIR/discord-ipc-N on Linux. Sandboxed clients
  // put it somewhere nested: Vesktop and the official Flatpak land at
  // $XDG_RUNTIME_DIR/.flatpak/<app-id>/xdg-run/discord-ipc-0 (older builds: .../app/<app-id>/), and Snap
  // uses $XDG_RUNTIME_DIR/snap.<name>/. Checking only the base directory means a Flatpak Discord is never
  // found, the socket never connects, and presence silently never appears with no error anywhere - which
  // is exactly how this read as "RPC just doesn't work on Linux".
  function ipcDirs() {
    var base = (process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || "/tmp").replace(/\/$/, "");
    var dirs = [base];
    [base + "/app", base + "/.flatpak"].forEach(function (parent) {
      var kids = [];
      try { kids = fs.readdirSync(parent); } catch (_) { return; }   // not a flatpak host: fine
      kids.forEach(function (id) {
        dirs.push(parent + "/" + id);
        dirs.push(parent + "/" + id + "/xdg-run");
      });
    });
    try {
      fs.readdirSync(base).forEach(function (n) { if (n.indexOf("snap.") === 0) dirs.push(base + "/" + n); });
    } catch (_) {}
    if (dirs.indexOf("/tmp") < 0) dirs.push("/tmp");
    return dirs;
  }
  // Every plausible socket, existing ones first so a live client is reached on the first attempt
  // instead of after a pile of ENOENTs.
  function pipeCandidates() {
    var out = [], i;
    if (process.platform === "win32") {
      for (i = 0; i <= 9; i++) out.push("\\\\?\\pipe\\discord-ipc-" + i);
      return out;
    }
    ipcDirs().forEach(function (d) {
      for (var k = 0; k <= 9; k++) out.push(d + "/discord-ipc-" + k);
    });
    var live = out.filter(function (p) { try { return fs.existsSync(p); } catch (_) { return false; } });
    if (!live.length) return out;
    return live.concat(out.filter(function (p) { return live.indexOf(p) < 0; }));
  }
  function encode(op, obj) {
    var data = Buffer.from(JSON.stringify(obj), "utf8");
    var head = Buffer.alloc(8);
    head.writeInt32LE(op, 0);
    head.writeInt32LE(data.length, 4);
    return Buffer.concat([head, data]);
  }
  function teardown() {
    ready = false;
    if (sock) { try { sock.removeAllListeners(); sock.destroy(); } catch (_) {} sock = null; }
  }
  function scheduleReconnect() {
    teardown();
    if (reconnectTimer) return;
    var wait = Math.min(backoff, BACKOFF_MAX);
    backoff = Math.min(Math.round(backoff * 1.6), BACKOFF_MAX);
    reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, wait);
  }
  var _cand = [];
  function openPipe(i, cb) {
    // Rebuilt at the start of every attempt, so a Discord started (or a Flatpak dir created) after we
    // gave up is picked up by the next reconnect rather than needing an app restart.
    if (i === 0) _cand = pipeCandidates();
    if (i >= _cand.length) return cb(null);
    var s = net.connect(_cand[i]);
    var settled = false;
    s.once("connect", function () { if (settled) return; settled = true; cb(s); });
    s.once("error", function () { if (settled) return; settled = true; try { s.destroy(); } catch (_) {} openPipe(i + 1, cb); });
  }
  function connect() {
    if (connecting) return;
    connecting = true;
    teardown();
    openPipe(0, function (s) {
      connecting = false;
      if (!s) { scheduleReconnect(); return; }
      sock = s;
      var buf = Buffer.alloc(0);
      s.on("data", function (chunk) {
        lastRecvAt = Date.now();
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 8) {
          var op = buf.readInt32LE(0), len = buf.readInt32LE(4);
          if (buf.length < 8 + len) break;
          var body = buf.slice(8, 8 + len); buf = buf.slice(8 + len);
          var msg = null; try { msg = JSON.parse(body.toString("utf8")); } catch (_) {}
          if (op === OP.PING) { try { s.write(encode(OP.PONG, msg)); } catch (_) {} continue; }
          if (op === OP.CLOSE) { scheduleReconnect(); return; }
          if (msg && msg.evt === "READY") { ready = true; backoff = 1000; lastRecvAt = Date.now(); if (lastActivity) pushActivity(lastActivity); }
        }
      });
      s.on("error", function () { if (sock === s) scheduleReconnect(); });
      s.on("close", function () { if (sock === s) scheduleReconnect(); });
      try { s.write(encode(OP.HANDSHAKE, { v: 1, client_id: CLIENT_ID })); } catch (_) { scheduleReconnect(); }
    });
  }
  function pushActivity(act) {
    lastActivity = act;
    if (!ready || !sock) return;
    try { sock.write(encode(OP.FRAME, { cmd: "SET_ACTIVITY", args: { pid: process.pid, activity: act }, nonce: String(++seq) })); }
    catch (_) { scheduleReconnect(); }
  }
  function clearActivity() {
    lastActivity = null;
    if (!ready || !sock) return;
    try { sock.write(encode(OP.FRAME, { cmd: "SET_ACTIVITY", args: { pid: process.pid, activity: null }, nonce: String(++seq) })); } catch (_) {}
  }

  // Heartbeat: re-assert + detect a silently-dead pipe (the account-switch case).
  setInterval(function () {
    try {
      var now = Date.now();
      if (ready && sock) {
        if (lastActivity && now - lastRecvAt > STALE_MS) { scheduleReconnect(); return; } // no response -> dead
        if (lastActivity) pushActivity(lastActivity); // re-assert (Discord clears presence on account switch)
      } else if (lastActivity && !reconnectTimer && !connecting) {
        connect(); // we believe we're down but have something to show -> try now
      }
    } catch (_) {}
  }, HEARTBEAT_MS);

  // OS window fullscreen: the renderer is sandboxed (no Node/electron), so it POSTs here and we
  // drive BrowserWindow.setFullScreen from the main process. We hook 'leave-full-screen' ONCE so
  // that leaving fullscreen by ANY route (our toggle, the OS, a shortcut) tells the renderer to
  // drop its in-view fullscreen button state.
  function fsWindow() {
    try { var BW = electron && electron.BrowserWindow; if (!BW) return null; return BW.getFocusedWindow() || (BW.getAllWindows() || [])[0] || null; } catch (_) { return null; }
  }
  var fsLeaveHooked = false;
  function setFullscreen(on) {
    var win = fsWindow(); if (!win) return false;
    try {
      if (!fsLeaveHooked) {
        fsLeaveHooked = true;
        win.on("leave-full-screen", function () {
          try { win.webContents.executeJavaScript("window.__qzOnLeaveFS&&window.__qzOnLeaveFS()", true).catch(function () {}); } catch (_) {}
        });
      }
      win.setFullScreen(!!on);
      return true;
    } catch (_) { return false; }
  }

  // Same intake as the HTTP bridge below, over IPC. The desktop wrapper's renderer is an https page, so
  // its POST to http://127.0.0.1 is cross-origin https->http AND (with a JSON content-type) needs a
  // preflight: it never left the renderer, so the bridge received nothing and Discord presence silently
  // never appeared. Nothing to block over IPC. The bake's renderer is not an https page and keeps using
  // the HTTP bridge, where this listener is simply unused.
  try {
    if (electron && electron.ipcMain) {
      electron.ipcMain.on("qz:rpc", function (_e, d) {
        try {
          if (!d) return;
          if (d.clear) clearActivity();
          else if (d.activity) pushActivity(d.activity);
        } catch (_) {}
      });
    }
  } catch (_) {}

  // localhost bridge: the renderer POSTs { activity: {...} } or { clear: true }
  var server = http.createServer(function (req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ready: ready, hasActivity: !!lastActivity, sinceRecvMs: lastRecvAt ? (Date.now() - lastRecvAt) : null }));
      return;
    }
    if (req.method === "POST" && req.url === "/activity") {
      var b = ""; req.on("data", function (c) { b += c; if (b.length > 1e5) { try { req.destroy(); } catch (_) {} } });
      req.on("end", function () {
        res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}');
        var d = null; try { d = JSON.parse(b); } catch (_) { return; }
        if (!d) return;
        if (d.clear) clearActivity();
        else if (d.activity) pushActivity(d.activity);
      });
      return;
    }
    if (req.method === "POST" && req.url === "/fullscreen") {
      var fb = ""; req.on("data", function (c) { fb += c; if (fb.length > 1e4) { try { req.destroy(); } catch (_) {} } });
      req.on("end", function () {
        var d = null; try { d = JSON.parse(fb); } catch (_) {}
        var ok = setFullscreen(!!(d && d.on));
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: ok }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  // Bind the localhost bridge. A quick restart can leave the OLD Qobuz process holding 7673 for a few
  // seconds (slow exit / TIME_WAIT), so a single listen() would EADDRINUSE and the old code gave up
  // SILENTLY FOREVER = Discord RPC dead until a full restart (the reported "127.0.0.1:7673 connection
  // refused" bug). Retry with backoff so the bridge recovers once the port frees, and log the outcome so
  // a persistent failure (another instance / firewall / AV blocking the local server) is diagnosable.
  var _bindTries = 0;
  function startBridge() { try { server.listen(BRIDGE_PORT, "127.0.0.1"); } catch (_) { scheduleBind(); } }
  function scheduleBind() {
    if (_bindTries++ >= 12) { try { console.error("[Qobuzify RPC] bridge could not bind 127.0.0.1:" + BRIDGE_PORT + " after retries - another instance may hold it, or a firewall/AV is blocking the local server; Discord presence will be off"); } catch (_) {} return; }
    setTimeout(startBridge, Math.min(1000 * _bindTries, 5000));
  }
  server.on("error", function (e) { try { console.error("[Qobuzify RPC] bridge listen error:", (e && e.code) || e); } catch (_) {} scheduleBind(); });
  server.on("listening", function () { _bindTries = 0; try { console.log("[Qobuzify RPC] bridge listening on 127.0.0.1:" + BRIDGE_PORT); } catch (_) {} });
  startBridge();

  // --- Windows taskbar thumbnail toolbar: Previous / Play-Pause / Next on the taskbar-icon hover preview
  // (parity with the native Qobuz app). Windows-only. The renderer is sandboxed, so the buttons live here
  // and drive playback by clicking Qobuz's own transport in the renderer via executeJavaScript. The middle
  // button's icon tracks play/pause via a light 2s poll. Icons are drawn as bitmaps (white glyph + alpha),
  // so no asset files are needed and the RGBA-vs-BGRA channel order is irrelevant. Fully wrapped so it can
  // never break the main process.
  try {
    if (process.platform === "win32" && electron && electron.nativeImage) {
      var _ni = electron.nativeImage;
      var _icons = null, _thumbPlaying = null, _thumbWinId = null;
      var _glyph = function (kind) {
        var W = 32, H = 32, buf = Buffer.alloc(W * H * 4); // transparent (all 0)
        var px = function (x, y) { if (x < 0 || y < 0 || x >= W || y >= H) return; var o = (y * W + x) * 4; buf[o] = 255; buf[o + 1] = 255; buf[o + 2] = 255; buf[o + 3] = 255; };
        var rect = function (x0, y0, x1, y1) { for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) px(x, y); };
        var triR = function (x0, x1, ym, half) { for (var x = x0; x <= x1; x++) { var h = Math.round(half * (1 - (x - x0) / (x1 - x0))); for (var y = ym - h; y <= ym + h; y++) px(x, y); } };
        var triL = function (x0, x1, ym, half) { for (var x = x1; x >= x0; x--) { var h = Math.round(half * (1 - (x1 - x) / (x1 - x0))); for (var y = ym - h; y <= ym + h; y++) px(x, y); } };
        if (kind === "play") triR(10, 25, 16, 9);
        else if (kind === "pause") { rect(9, 7, 15, 25); rect(18, 7, 24, 25); }
        else if (kind === "next") { triR(7, 21, 16, 8); rect(22, 7, 25, 25); }
        else { triL(11, 25, 16, 8); rect(7, 7, 10, 25); } // prev
        return _ni.createFromBitmap(buf, { width: W, height: H });
      };
      var _thumbIcons = function () { if (!_icons) { try { _icons = { prev: _glyph("prev"), play: _glyph("play"), pause: _glyph("pause"), next: _glyph("next") }; } catch (_) {} } return _icons; };
      var _thumbClick = function (which) {
        var win = fsWindow(); if (!win) return;
        var sel = which === "prev" ? ".pct-player-prev, .player__action-previous" : which === "next" ? ".pct-player-next, .player__action-next" : ".player__action-pause, .player__action-play";
        try { win.webContents.executeJavaScript("(function(){try{var b=document.querySelector(" + JSON.stringify(sel) + ");if(b)b.click();}catch(e){}})()", true).catch(function () {}); } catch (_) {}
      };
      var _setThumb = function (win, playing) {
        var ic = _thumbIcons(); if (!ic || !win) return;
        try {
          win.setThumbarButtons([
            { tooltip: "Previous", icon: ic.prev, click: function () { _thumbClick("prev"); } },
            { tooltip: playing ? "Pause" : "Play", icon: playing ? ic.pause : ic.play, click: function () { _thumbClick("play"); } },
            { tooltip: "Next", icon: ic.next, click: function () { _thumbClick("next"); } }
          ]);
          _thumbPlaying = playing;
        } catch (_) {}
      };
      // .player__action-pause is present only while playing (it shows the Pause control); poll it to keep the
      // middle button's icon in sync and to (re)apply on a new window.
      setInterval(function () {
        try {
          var win = fsWindow(); if (!win) return;
          win.webContents.executeJavaScript("(function(){try{return !!document.querySelector('.player__action-pause');}catch(e){return null;}})()", true)
            .then(function (playing) {
              if (playing === null || playing === undefined) return;
              if (win.id !== _thumbWinId || !!playing !== _thumbPlaying) { _thumbWinId = win.id; _setThumb(win, !!playing); }
            }).catch(function () {});
        } catch (_) {}
      }, 2000);
    }
  } catch (_) { /* never break the main process */ }

  connect(); // start trying Discord immediately; retries forever until it (re)appears
} catch (_) { /* never break the main process */ }
})();
