// One-time Spotify user login via OAuth 2.0 with PKCE (public-client flow - no
// client secret). Spins up a loopback server to catch the redirect, exchanges the
// code for an access + refresh token, and returns them. The refresh token lets the
// Qobuzify Lyrics extension renew the access token forever with no further user action.
const https = require("https");
const crypto = require("crypto");
const cp = require("child_process");
const LOOPBACK = require("./loopback-cert");

function b64url(buf) { return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

function openBrowser(url) {
  // rundll32 FileProtocolHandler opens the default browser and tolerates "&" in the
  // query string (cmd's `start` does not).
  try { cp.exec('rundll32 url.dll,FileProtocolHandler "' + url + '"'); } catch (_) {}
}

// scopes: enough to mint a real user token the lyrics API accepts; harmless/read-only.
const SCOPES = "user-read-private user-read-email user-read-playback-state user-read-currently-playing streaming";

function spotifyLogin(clientId, opts) {
  opts = opts || {};
  const port = opts.port || 8888;
  const redirectUri = "https://127.0.0.1:" + port + "/callback";
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const authUrl = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
    client_id: clientId, response_type: "code", redirect_uri: redirectUri,
    code_challenge_method: "S256", code_challenge: challenge, state, scope: SCOPES
  }).toString();

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; try { server.close(); } catch (_) {} fn(v); };
    const server = https.createServer({ cert: LOOPBACK.cert, key: LOOPBACK.key }, async (req, res) => {
      const u = new URL(req.url, redirectUri);
      if (!u.pathname.startsWith("/callback")) { res.writeHead(404); res.end(); return; }
      const code = u.searchParams.get("code"), st = u.searchParams.get("state"), err = u.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body style='font-family:system-ui;background:#0f0f12;color:#fff;text-align:center;padding-top:90px'><h2 style='color:#3DA8FE'>Qobuzify — Spotify connected</h2><p>You can close this tab and return to your terminal.</p></body></html>");
      if (err) return done(reject, new Error("authorization was denied (" + err + ")"));
      if (st !== state) return done(reject, new Error("state mismatch (possible CSRF) — try again"));
      if (!code) return done(reject, new Error("no authorization code returned"));
      try {
        const r = await fetch("https://accounts.spotify.com/api/token", {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }).toString()
        });
        const tok = await r.json();
        if (!tok.access_token) return done(reject, new Error("token exchange failed: " + JSON.stringify(tok)));
        done(resolve, { access_token: tok.access_token, refresh_token: tok.refresh_token || null, expires_at: Date.now() + ((tok.expires_in || 3600) * 1000) });
      } catch (e) { done(reject, e); }
    });
    server.on("error", (e) => done(reject, e.code === "EADDRINUSE" ? new Error("port " + port + " is in use; close whatever's using it and retry") : e));
    server.listen(port, "127.0.0.1", () => {
      console.log("\nA browser window will open for Spotify login. If it doesn't, open this URL:\n  " + authUrl + "\n");
      console.log("Waiting for you to authorize… (Ctrl+C to cancel)");
      openBrowser(authUrl);
    });
    setTimeout(() => done(reject, new Error("timed out waiting for authorization (5 min)")), 300000);
  });
}

module.exports = { spotifyLogin, SCOPES };
