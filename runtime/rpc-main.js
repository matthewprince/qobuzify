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

  var CLIENT_ID = "1519198716417020004"; // Qobuzify's built-in Discord app
  var BRIDGE_PORT = 7673;
  var OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
  var HEARTBEAT_MS = 8000, STALE_MS = 15000, BACKOFF_MAX = 5000;

  var sock = null, ready = false, seq = 0, lastActivity = null, lastRecvAt = 0;
  var reconnectTimer = null, backoff = 1000, connecting = false;

  function pipePath(i) {
    if (process.platform === "win32") return "\\\\?\\pipe\\discord-ipc-" + i;
    var base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || "/tmp";
    return base.replace(/\/$/, "") + "/discord-ipc-" + i;
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
  function openPipe(i, cb) {
    if (i > 9) return cb(null);
    var s = net.connect(pipePath(i));
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
    res.writeHead(404); res.end();
  });
  server.on("error", function () {}); // port in use / already running - stay quiet
  try { server.listen(BRIDGE_PORT, "127.0.0.1"); } catch (_) {}

  connect(); // start trying Discord immediately; retries forever until it (re)appears
} catch (_) { /* never break the main process */ }
})();
