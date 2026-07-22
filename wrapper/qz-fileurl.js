// Direct-stream source for bit-perfect (Linux/mac wrapper).
//
// The web player only ever hands MSE encrypted segments, which is why the "tap" path exists. But the
// SIGNED track/getFileUrl endpoint every native client uses returns a plain, direct, Range-seekable
// FLAC URL from the Qobuz CDN - proven on this account: format 27 negotiates to the true best master
// (16/44.1 for a CD track, 24/88.2 for a hi-res one), mime audio/flac, and mpv streams it natively.
// Feeding mpv that URL instead of decrypted MSE scraps removes the whole fragile inference layer (feed
// server, ftyp-as-track-boundary, ring buffer, starvation watchdog): mpv owns the stream and seeks it.
//
// The request is signed with the WEB app id (798273057) + an app secret derived from the page bundle
// (the standard seed+timezone method; several candidates are produced and only some validate, so we try
// each against a real call and cache the winner). Secrets rotate with the bundle, so a signature
// rejection triggers one re-derive. The secret lives ONLY here in the main process, never the renderer.
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const API = "https://www.qobuz.com/api.json/0.2/track/getFileUrl";
const UA = "Mozilla/5.0";

var cacheDir = null;                 // set by main via setCacheDir()
var mem = { appId: null, secret: null, candidates: null }; // in-session cache

function setCacheDir(dir) { cacheDir = dir; loadCache(); }
function cacheFile() { return cacheDir ? path.join(cacheDir, "qz-fileurl.json") : null; }
function loadCache() {
  try { var j = JSON.parse(fs.readFileSync(cacheFile(), "utf8")); if (j && j.secret) { mem.appId = j.appId; mem.secret = j.secret; } } catch (_) {}
}
function saveCache() {
  try { if (cacheFile()) fs.writeFileSync(cacheFile(), JSON.stringify({ appId: mem.appId, secret: mem.secret }), "utf8"); } catch (_) {}
}

function md5(s) { return crypto.createHash("md5").update(s).digest("hex"); }

// GET with a small redirect follower (play.qobuz.com bounces) and a byte cap so a stray huge body can't
// blow up memory - the bundle is ~9MB, cap at 24MB.
function get(url, headers, cap) {
  return new Promise(function (resolve) {
    var hops = 0;
    function go(u) {
      var req = https.get(u, { headers: headers || {} }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops++ < 4) {
          res.resume(); return go(new URL(res.headers.location, u).toString());
        }
        var buf = "", n = 0, lim = cap || 24 * 1024 * 1024;
        res.on("data", function (d) { n += d.length; if (n > lim) { req.destroy(); return; } buf += d; });
        res.on("end", function () { resolve({ status: res.statusCode, body: buf }); });
      });
      req.on("error", function (e) { resolve({ status: 0, body: "", err: String(e && e.message || e) }); });
      req.setTimeout(15000, function () { req.destroy(); resolve({ status: 0, body: "", err: "timeout" }); });
    }
    go(url);
  });
}

// Pull app id + every candidate secret out of the bundle. The seeds carry a per-timezone base64 blob;
// the secret is base64decode((seed+info+extras) minus its last 44 chars). Also grab any inline appSecret.
function deriveFromBundle(js) {
  var out = { appId: null, candidates: [] };
  var a = /production:\{api:\{appId:"(\d{9,})"(?:,appSecret:"(\w+)")?/.exec(js);
  if (a) { out.appId = a[1]; if (a[2]) out.candidates.push(a[2]); }
  else { var a2 = /appId:"(\d{9,})"/.exec(js); if (a2) out.appId = a2[1]; }
  var seedRe = /[a-z]\.initialSeed\("([\w=]+)",window\.utimezone\.([a-z]+)\)/g, m;
  while ((m = seedRe.exec(js))) {
    var seed = m[1], tz = m[2];
    var cap = tz.charAt(0).toUpperCase() + tz.slice(1);
    var ie = new RegExp('name:"[^"]*/' + cap + '",info:"([\\w=]+)",extras:"([\\w=]+)"').exec(js);
    if (!ie) continue;
    var s = (seed + ie[1] + ie[2]).slice(0, -44);
    while (s.length % 4) s += "=";
    try { var dec = Buffer.from(s, "base64").toString("utf8"); if (dec.length >= 20) out.candidates.push(dec); } catch (_) {}
  }
  return out;
}

async function loadCandidates(bundleUrl) {
  // the renderer passes the exact bundle it is running; fall back to scraping the app shell.
  var url = bundleUrl;
  if (!url) {
    var page = await get("https://play.qobuz.com/", { "User-Agent": UA }, 2 * 1024 * 1024);
    var b = /resources\/[^"']+?\/bundle\.js/.exec(page.body || "");
    if (b) url = "https://play.qobuz.com/" + b[0];
  }
  if (!url) return { appId: null, candidates: [] };
  var res = await get(url, { "User-Agent": UA });
  if (res.status !== 200 || !res.body) return { appId: null, candidates: [] };
  return deriveFromBundle(res.body);
}

function sign(secret, trackId, formatId) {
  var ts = Math.floor(Date.now() / 1000);
  var sig = md5("trackgetFileUrlformat_id" + formatId + "intentstreamtrack_id" + trackId + ts + secret);
  return { ts: ts, sig: sig };
}

async function callWith(secret, appId, token, trackId, formatId) {
  var s = sign(secret, trackId, formatId);
  var q = "request_ts=" + s.ts + "&request_sig=" + s.sig + "&track_id=" + encodeURIComponent(trackId) +
    "&format_id=" + formatId + "&intent=stream&app_id=" + encodeURIComponent(appId) + "&user_auth_token=" + encodeURIComponent(token);
  var res = await get(API + "?" + q, { "X-App-Id": appId, "X-User-Auth-Token": token, "User-Agent": UA }, 256 * 1024);
  var j = null; try { j = JSON.parse(res.body); } catch (_) {}
  return { status: res.status, j: j, err: res.err };
}

// Resolve a signed, playable FLAC URL for a track. Returns {ok, url, formatId, bitDepth, rate, mime} or
// {ok:false, reason}. reason "restricted" = track/account has no such format (a real answer, not a bug);
// "auth" = token rejected; "network" = could not reach Qobuz; "nosecret" = bundle gave nothing usable.
async function resolve(opts, _retried) {
  var appId = String(opts.appId || mem.appId || "798273057");
  var token = opts.token, trackId = opts.trackId, formatId = opts.formatId || 27;
  if (!token || !trackId) return { ok: false, reason: "args" };

  if (!mem.candidates || !mem.candidates.length || !_retried) {
    if (!mem.candidates) {
      var d = await loadCandidates(opts.bundleUrl);
      if (d.appId) mem.appId = d.appId;
      mem.candidates = d.candidates;
    }
  }
  // try the known-good secret first, then the rest.
  var list = [];
  if (mem.secret) list.push(mem.secret);
  (mem.candidates || []).forEach(function (c) { if (c !== mem.secret) list.push(c); });
  if (!list.length) return { ok: false, reason: "nosecret" };

  var sawSigReject = false;
  for (var i = 0; i < list.length; i++) {
    var r = await callWith(list[i], appId, token, trackId, formatId);
    if (r.status === 200 && r.j && r.j.url) {
      if (mem.secret !== list[i]) { mem.secret = list[i]; saveCache(); }
      return { ok: true, url: r.j.url, formatId: r.j.format_id, bitDepth: r.j.bit_depth, rate: r.j.sampling_rate, mime: r.j.mime_type, duration: r.j.duration };
    }
    if (r.status === 0) return { ok: false, reason: "network", detail: r.err };
    var msg = (r.j && r.j.message) || "";
    if (/request_sig/i.test(msg)) { sawSigReject = true; continue; }        // wrong secret, keep trying
    if (r.status === 401 || /auth|token/i.test(msg)) return { ok: false, reason: "auth", detail: msg };
    // 400/4xx that is not a signature problem = the track has no such format for this account.
    return { ok: false, reason: "restricted", detail: msg, status: r.status };
  }
  // every secret failed the signature: the bundle rotated. Re-derive ONCE and retry.
  if (sawSigReject && !_retried) {
    mem.candidates = null; mem.secret = null;
    return resolve(opts, true);
  }
  return { ok: false, reason: "nosecret" };
}

module.exports = { setCacheDir: setCacheDir, resolve: resolve, _deriveFromBundle: deriveFromBundle };
