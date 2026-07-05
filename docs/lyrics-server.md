# The lyrics cache-proxy

Qobuzify Lyrics can resolve lyrics entirely on the client from open sources. But there's also an optional server, a Cloudflare Worker, that sits in front of the whole thing as a shared cache and proxy. This doc is about why it exists and how it's built, because the caching design is the reusable part.

It lives under `server/` and deploys to `api.qobuzify.app`. The client is proxy-first: it asks the Worker, and only falls back to resolving locally if the proxy misses.

## Why a server at all

Two reasons.

**Speed through sharing.** Lyric resolution is slow: it can mean an ISRC lookup, a search, a fetch, and a parse across several upstreams. Once one person's client has resolved a track, nobody else should have to. A shared cache means a track anyone has already played loads for everyone else in a single warm round-trip with zero client-side parsing.

**One source, from the client's view.** The client only ever talks to `api.qobuzify.app`. Which source actually served a given lyric never shows up in the client's network tab, because the API response reports a codename, not the real source. The client never advertises where a lyric came from.

## Lyric tiers

Every track resolves to one of three tiers, and the response tells you which one you got:

- **Word-by-word** (`lyrics.Type` is `"Syllable"`). Karaoke-grade: every word carries its own start and end time, so the client can sweep a fill across the line as it's sung. This is the top tier and what the resolver reaches for first, keyed by ISRC when the track has one.
- **Line-level** (`lyrics.Type` is `"Line"`). Each line has a single timestamp. The current line highlights as a block when it's reached, but there's no per-word timing. This is the fallback for a track that no reachable source has word-by-word for.
- **None** (`hasLyrics` is `false`). No synced lyrics anywhere reachable. It's cached as a negative result for a TTL so it doesn't re-sweep every play, and can still pick up lyrics added upstream later.

The resolver always prefers word-by-word over line-level, so a track that has both comes back `"Syllable"`. A line-level result is never treated as final: the server serves it now but re-resolves it in the background (no user latency), so the next play can quietly upgrade it to word-by-word if a better source has since become reachable.

One consequence worth knowing: the client is proxy-first with a local fallback, so if the server call misses or fails, the client resolves locally, and the local path may only find line-level for a track the server actually has word-by-word for. Re-opening the lyrics re-asks the server and gets the better tier.

## Storage, in priority order

The Worker answers a lyric request from the first of these that hits:

1. **D1 (the parsed cache).** A SQLite row holding the already-parsed lyric JSON at the current parse version. This is the fast path, served instantly with no work.
2. **R2 (the raw archive).** The original upstream payload, stored permanently. If the parser changed or the D1 row was lost, the Worker re-parses the archived raw locally. It never re-downloads. This is the "download once, own it forever" layer: once a lyric is pulled, it lives in R2 for good.
3. **Upstream.** Only for a track nobody has ever resolved. The Worker resolves from a ranked set of lyric sources, preferring syllable-timed word-by-word (keyed by ISRC when there is one) and falling back to line-level, then archives the raw payload to R2 and caches the parsed result in D1.

A confirmed no-lyrics result is cached negatively in D1 for a TTL, so a track with no lyrics anywhere doesn't re-trigger a full upstream sweep on every play. It can still pick up lyrics added upstream later.

## Parse versioning

The parsed cache is tagged with a `PARSE_VER`. When the parsing logic changes (a better word-break rule, a new background-vocal split), you bump `PARSE_VER`, and every cached track re-parses from its archived R2 raw the next time it's requested. No re-downloading, just re-parsing what's already owned. The client carries a matching `CACHE_VER`; keep the two in sync so client and server agree on what a "current" parse is.

The resolver (`server/src/resolver.js`) is a deliberate, near-verbatim port of the client's resolve-and-parse chain, so a lyric cached server-side is byte-identical to what the client would have produced locally. That's what lets the two share a cache at all.

## Self-healing a wrong-song match

Same-title songs are a real problem. Selena Gomez and Baby Keem both have a track called "Wolves"; an early cache entry matched the wrong one, so Baby Keem's 83-second track served Selena's 193-second lyrics.

The fix is a duration guard on both sides. If a cached lyric's timing runs well past the current track's end (more than 10 seconds over), it belongs to a different, longer song with the same title. The server evicts that D1 row and R2 raw and re-resolves; the client drops its local cache entry and re-asks. A stale wrong-song match now auto-corrects on the next play instead of being stuck forever.

## Cache only what's trustworthy

Not every result is worth caching. The Worker caches only high-confidence lyrics: results from the trusted high-quality sources even at line level, or anything word-by-word. Line-level results from the open sources are served to the client but not cached, so they stay re-resolvable and can upgrade to a better source on a later play. The client mirrors this with a `cacheable` flag in the response, and a cached line-level result gets a background re-resolve (fired with no user latency) so the next play can quietly upgrade it to word-by-word.

## The home-IP relay

One good word-by-word source is often blocked from Cloudflare's egress IPs. So the Worker can call a small relay running on a home IP, and the client keeps that same source as its own local fallback for tracks the Worker can't reach. It's a pragmatic way to keep a useful source alive from an environment that can't reach it directly.

## Also on the Worker: stats sync

The same Worker hosts the opt-in listening-stats cloud sync for the stats extension. Data is scoped to a client-generated random sync id, with no account and no personal information, deduped by (sync id, timestamp), and off by default in the client. It's a separate set of endpoints (`/v1/stats/*`) that happens to share the deployment.

## Endpoints

```
GET  /v1/lyrics?name=&artist=&album=&durationMs=&isrc=&spotifyId=
GET  /v1/stats  |  POST /v1/stats/push  |  GET /v1/stats/pull  |  POST /v1/stats/wipe
GET  /health
```

Plus a few admin endpoints gated behind a secret (flush, upgrade line-to-word-by-word in bulk, purge one track). The lyric response is `{ ok, cached, hasLyrics, source, lyrics, key, cacheable }`, where `cached` is `false`, `"d1"`, or `"r2"`, `source` is the codename, and `lyrics.Type` is `"Syllable"` (word-by-word) or `"Line"` (line-level), the tier you got (see [Lyric tiers](#lyric-tiers)).

## Rate limits and unblocking

The public API is rate-limited per IP so no single client can hammer the shared cache and ruin it for everyone else. The ceiling is 120 requests a minute from one IP, which normal listening never gets near; it's there to slow down scrapers, not people. Trip it and the edge returns a `429` with a small JSON body in place of a lyric:

```
{
  "ok": false,
  "error": "rate_limited",
  "message": "Too many requests. If you are a real person, unblock your IP at https://qobuzify.app/unban",
  "unban": "https://qobuzify.app/unban"
}
```

The client treats a `429` the same as a cache miss and just resolves locally, so a real listener keeps getting lyrics even in the rare case they trip the limit. And if a genuine person is stuck behind a flagged or shared IP, the unblock page at [qobuzify.app/unban](https://qobuzify.app/unban) clears it: pass the human check and the IP you're connecting from goes on an allowlist for 24 hours, then expires on its own through an hourly prune. It only ever allowlists the connecting IP, never one typed into a box, so passing the check can unblock you but not some scraper somewhere else.
