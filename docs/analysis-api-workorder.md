# Work order: audio-analysis endpoint for api.qobuzify.app

Goal: serve beat/bar/section/energy data to Lyra (and any client) so visuals can
be audio-reactive without touching audio. Upstream = the spclient audio-analysis
service already implemented in `audioAnalysis.ts` (spotify-api microservice).
Client rule carries over from lyrics: PROXY-ONLY, no upstream identity visible.

## 1. Endpoint

`GET /v2/analysis`

Params (same resolution chain as /v2/track, reuse the existing resolver):
- `spotifyId` (preferred, direct hit)
- `isrc`
- `name` + `artist` (+ optional `album`, `durationMs`) -> resolve to spotifyId first
- `fields` (optional): comma list of `beats,bars,tatums,sections,energy,segments`.
  Default = `beats,bars,sections,energy`. `segments` (raw, huge) is opt-in only.

Also add to `GET /v2/track`: `"analysis": { "available": true|false }` hint so
clients know whether to bother calling /v2/analysis. No analysis payload there,
the lyrics call stays light.

## 2. Response envelope

Match the /v2/track conventions: HTTP 200 for everything resolvable, misses are
`available:false`, never an upstream error/URL/status in the body.

```jsonc
{
  "ok": true,
  "cached": "d1" | "edge" | "miss",
  "track": { "name": "...", "artist": "...", "spotifyId": "..." },
  "analysis": {
    "available": true,
    "source": "<codename>",          // pick one, same style as lyrics codenames.
                                     // NEVER the real provider name.
    "summary": {
      "tempo": 171.01, "tempoConfidence": 0.93,
      "key": 5, "mode": 1, "timeSignature": 4,
      "loudness": -5.4,
      "durationMs": 200040,
      "endOfFadeInMs": 240, "startOfFadeOutMs": 191560
    },
    // COLUMNAR tuples, ms ints, confidence 2dp. Halves the JSON vs objects.
    "beats":  [[startMs, durMs, conf], ...],     // ~800 rows for a 3.5min track
    "bars":   [[startMs, durMs, conf], ...],     // ~200 rows
    "tatums": [[startMs, durMs, conf], ...],     // only when requested
    "sections": [
      // [startMs, durMs, conf, loudnessDb, tempo, key, mode, timeSignature]
      [0, 14320, 1.0, -9.1, 171.0, 5, 1, 4], ...
    ],
    // The one Lyra actually leans on: server-side downsampled loudness envelope.
    // Fixed 250ms step from 0ms, values normalized 0-100 (int) against the
    // track's own min/max segment loudnessMax. ~800 ints = ~3KB.
    "energy": { "stepMs": 250, "values": [12, 14, 38, ...] }
  }
}
```

Rounding: all times to int ms, confidences to 2dp, loudness to 1dp. Do NOT ship
pitches/timbre unless `fields=segments`.

## 3. Energy curve (server-side derivation)

From raw segments:
1. For each 250ms bucket from 0 to durationMs, take the max `loudness_max` of
   segments overlapping the bucket (use `loudness_max_time` for placement).
2. dB -> linear-ish perceptual: `v = 10^(dB/20)`, then normalize to the track's
   own [min, max] over all buckets, scale 0-100, round to int.
3. Smooth with a 3-bucket moving average so the curve drives opacity/scale
   without flicker.

This kills 95% of the payload while keeping everything a renderer needs.

## 4. Caching

- Analysis is immutable per spotifyId. D1 row keyed `analysis:<spotifyId>`
  storing the SHRUNK columnar JSON (post-derivation, not the raw upstream).
  If a row would exceed comfortable D1 size with `segments`, put raw segments
  in R2 and keep the default payload in D1.
- Edge: `Cache-Control: public, max-age=31536000, immutable` on hits.
- Negative cache misses/404s for 7 days (`analysis:<id>:miss`), 200 with
  `available:false`. New tracks get analysis eventually, so not forever.
- Single-flight per spotifyId on the worker (dedupe concurrent misses) so a new
  release doesn't stampede the microservice.

## 5. Worker <-> microservice plumbing

- Worker calls the spotify-api microservice (private), which owns the token
  dance + 401-retry already in `audioAnalysis.ts`. 8s timeout, one retry.
- Normalize + shrink at the WORKER (columnar, rounding, energy derivation), so
  the cached object is final-form and the microservice stays a dumb fetcher.
- Fix before deploy: `SPOTIFY_TOKEN_URL` fallback is the placeholder `'nono '`;
  make missing env a hard startup error instead.
- Sanity-check upstream: reject/no-cache when `beats` is empty or
  `track.duration` is 0 (truncated upstream responses happen).

## 6. Rate limits / tiers

Same keying as lyrics. Since it's one immutable object per track and edge-cached,
count it at half a lookup or free-with-key, your call. WAF: same `qz=1` skip
convention as the lyrics route.

## 7. Acceptance checks

- [ ] `GET /v2/analysis?name=Blinding%20Lights&artist=The%20Weeknd` returns
      beats/bars/sections/energy, <40KB raw, <12KB gzipped, no "spotify"
      substring anywhere in the body (grep the bytes, not the schema).
- [ ] Same request twice: second is `cached: d1|edge` and <100ms at edge.
- [ ] Unknown garbage title: `ok:true, analysis.available:false`, negative-cached.
- [ ] `fields=beats` returns only beats + summary.
- [ ] `/v2/track` response now carries `analysis.available` without measurable
      latency change on the lyrics path.
- [ ] CORS: same policy as /v2/track (Lyra demo fetches from a browser).

## 8. Client contract (what Lyra will consume, for reference)

```ts
type Marker = [startMs: number, durMs: number, conf: number];
type Analysis = {
  summary: { tempo: number; durationMs: number; /* ... */ };
  beats: Marker[]; bars: Marker[]; sections: number[][];
  energy: { stepMs: number; values: number[] };
};
// Lyra side (already planned): lyra.setAnalysis(json.analysis)
```
