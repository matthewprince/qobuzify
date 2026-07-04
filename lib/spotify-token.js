// Pull a live Spotify USER access token from a running Spotify desktop that was
// launched with --remote-debugging-port. Keeps Qobuzify Lyrics' lyric-API auth fresh
// without a full OAuth login (the primary token source; OAuth is the fallback
// for when Spotify isn't running). Node 18+ has global fetch + WebSocket.

function evalOnPage(wsUrl, expr) {
  return new Promise((resolve) => {
    let done = false;
    const ws = new WebSocket(wsUrl);
    const finish = (v) => { if (done) return; done = true; try { ws.close(); } catch (_) {} resolve(v); };
    const to = setTimeout(() => finish(null), 5000);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } })));
    ws.addEventListener("message", (ev) => { try { const m = JSON.parse(ev.data); if (m.id === 1) { clearTimeout(to); finish(m.result && m.result.result ? m.result.result.value : null); } } catch (_) {} });
    ws.addEventListener("error", () => { clearTimeout(to); finish(null); });
  });
}

// Scan candidate debug ports for a Spotify page exposing Platform.Session, return
// { access_token, expires_at } or null.
async function grabSpotifyToken(ports) {
  ports = (ports && ports.length) ? ports : [9222, 9223, 9224];
  for (const port of ports) {
    let targets;
    try { targets = await (await fetch("http://127.0.0.1:" + port + "/json")).json(); } catch (_) { continue; }
    for (const pg of (targets || []).filter((t) => t.type === "page" && t.webSocketDebuggerUrl)) {
      const v = await evalOnPage(pg.webSocketDebuggerUrl, "(()=>{try{var s=window.Spicetify&&Spicetify.Platform&&Spicetify.Platform.Session;return s&&s.accessToken?JSON.stringify({access_token:s.accessToken,expires_at:s.accessTokenExpirationTimestampMs}):null;}catch(e){return null;}})()");
      if (v) { try { const o = JSON.parse(v); if (o && o.access_token) return o; } catch (_) {} }
    }
  }
  return null;
}

module.exports = { grabSpotifyToken };
