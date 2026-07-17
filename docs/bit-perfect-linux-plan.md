# Qobuzify Linux/macOS Bit-Perfect + Windows Installer — Build Plan

Files confirmed on disk: `wrapper/main.js`, `wrapper/preload.js`, `wrapper/payload.js` (+ minified `qz-payload.js`), 30 extensions incl. `block-trash`, `bin/qobuzify.js`, `lib/apply.js|locate.js|restore.js`, `tools/build-zip.ps1`, `site/public/install.ps1`. The plan grafts onto these seams.

---

## 1. Chosen architecture: **bundled libmpv sidecar, ALSA-hw exclusive primary path**

**Pick: libmpv (not hand-rolled Rust, not raw PipeWire-passthrough).**

Why libmpv wins for a bundled zero-config Electron app:
- It already implements the *entire* hard stack the two native dimensions independently converge on: ALSA `hw:` exclusive open, `org.freedesktop.ReserveDevice1` D-Bus device reservation (so PipeWire releases the card instead of returning `-EBUSY`), per-track `snd_pcm_hw_params` format/rate negotiation, drain+reopen on rate change, S32_LE left-justify padding, unity-gain passthrough. A from-scratch symphonia/alsa-rs player re-derives all of this and owns the maintenance forever. The ALSA-native dimension's own conclusion: "direct ALSA-hw and defer-to-libmpv are the SAME architecture; libmpv is the lower-risk way to get it."
- It demuxes Qobuz's FLAC-in-MP4 (audio/mp4 codecs=flac) *and* raw FLAC *and* MP3 via the linked libavformat. A raw-FLAC-only decoder (claxon/libFLAC) would need a separate ISO-BMFF demuxer.
- One binary + one option string also covers macOS (Core Audio Hog Mode) — see §3.

**Licensing decision that makes this shippable:** build **libmpv in LGPL mode** (`meson -Dgpl=false -Dlibmpv=true`) against **LGPL FFmpeg** (configure WITHOUT `--enable-gpl`/`--enable-nonfree`; FLAC/ALAC/MP4/HTTP/TLS are all LGPL-clean), and **dynamic-link**. Do NOT bundle the GPL `mpv` CLI binary — that would impose GPLv2 on the AppImage. Dynamic-linked LGPL libmpv + shipped license texts + a replaceable `.so` satisfies LGPL, and Qobuzify is going OSS (issue #11) so this is clean either way. Load libmpv via an N-API addon OR spawn a tiny bundled headless host process; given the "lower-risk, zero-native-build" preference, **spawn a minimal `libmpv` host over JSON IPC** (`--input-ipc-server`) rather than compiling an N-API addon. Footprint audio-only (no video/GUI/lua/vulkan/X): ~15-40 MB inside the 109 MB AppImage.

**Exact byte-exact invocation (Linux):**
```
mpv --no-video --no-terminal --idle=yes \
    --input-ipc-server=$XDG_RUNTIME_DIR/qobuzify-mpv.sock \
    --ao=alsa \
    --audio-device=alsa/hw:CARD=<detected>,DEV=0 \
    --audio-exclusive=yes \
    --audio-samplerate=0 \        # follow each track's native rate, switch on track change
    --audio-channels=stereo \     # no channelmix
    --replaygain=no \
    --af= \                       # NO filters
    --volume=100 --volume-max=100 \  # unity gain = filter is a no-op, PCM verbatim
    --gapless-audio=weak \
    --cache=yes \
    --user-agent='Mozilla/5.0'
```
For S/PDIF/coax use `alsa/iec958:CARD=...` instead of `hw`. `hw` PCM applies zero rate/format/channel conversion; exclusive mode locks the DAC; at `--volume=100` the volume filter is skipped so there is no float roundtrip. libavcodec decodes 24-bit FLAC to S24/S32 and mpv passes it verbatim when the DAC accepts that format/rate. **This is genuinely byte-exact-to-DAC, not "lossless-ish."** Proven pattern: Feishin and QBZ both ship exactly this.

**Zero-config device pick + honest fallback ladder:**
1. Query `audio-device-list`, prefer the default output card's `hw:`/`iec958` node, attempt exclusive open.
2. On `-EBUSY`/`-EBADFD` (reservation lost, or DAC rejects the rate): fall back to `--ao=pipewire` **non-exclusive**.
3. **Badge must be honest:** the PipeWire-shared fallback resamples to the graph rate (default 48 kHz) and is NOT bit-perfect. Badge states are **"Bit-perfect"** vs **"Shared (resampled)"**, fed live from the `audio-params` property — never call the fallback "lossless."

**Two honest bounds to bake into UX copy (not bugs, physics):**
- Gapless only holds *within same-rate tracks*. A 44.1→96→192 change forces a device close/reopen = a brief relock gap. Same as WASAPI-exclusive on Windows.
- Exclusive hold silences all other system audio while playing. Acceptable for a music app; it is the same trade as the Windows WASAPI path.

**Rejected alternatives:** raw-ALSA hand-roll (leaner binary, but re-implements reservation/rate-switch/demux and owns forever); PipeWire-passthrough as *primary* (only bit-perfect under sole-stream+matched-rate+unity, silently breaks when any second stream opens, nonexistent on Pulse-only/bare-ALSA boxes — correct as a *fallback*, wrong as the default).

---

## 2. Stream-capture + sync design

Authority model in one line: **the muted web `<audio>` element is the timeline/queue/scrobble authority; libmpv is a lock-step slave** commanded load/play/pause/seek/volume off Redux-store events and resynced to the web clock on every seek/track-change/rebuffer.

### The one contradiction that must be solved first (make-or-break for §2)
The verify pass flagged it correctly: you cannot simultaneously keep the Chromium `<audio>` element decoding (to drive `currentTime`/`ended`/scrobble/auto-advance) AND have libmpv hold the ALSA `hw:` device exclusively, because a live `<audio>` element's `currentTime` is driven by its audio-render clock. If mpv seizes the card, Chromium's sink can freeze and never fire `ended`, collapsing the "web element is timeline authority" model.

**Resolution:** route Chromium's audio to a **null/dummy sink** so its render clock keeps ticking against a virtual device while producing no sound, and let mpv own the real DAC. Two ways, prefer (A):
- **(A) Per-process routing (zero global config):** launch the Electron app with `PULSE_SINK`/PipeWire target pointed at a null sink that Qobuzify creates on startup (`pactl load-module module-null-sink` equivalent via libpipewire, torn down on exit), OR set Chromium's output device via `setSinkId()` from the renderer to a virtual monitor. Chromium keeps decoding against a live-but-silent sink; its `currentTime`/`ended`/scrobble all keep working; mpv holds `hw:` exclusively with no contention.
- **(B) Wall-clock shim:** if a null sink is unavailable, drive the progress/auto-advance off mpv's `time-pos`/`eof-reached` events and stop trusting the frozen `<audio>` clock. More invasive (fights the sealed player state machine), so (A) is primary.

This is the actual hard problem. It must be prototyped on the Arch VM before anything else (§7 Phase 0).

### Renderer (new extension `extensions/bitperfect/index.js`, mirrors `block-trash`)
- **Capture:** compose onto `block-trash`'s existing `window.fetch` wrap. On any `/file/url?track_id=…` **response**, do `r.clone().json()` and store `descriptors[trackId] = {url, formatId, sampleRate, bitDepth, expiresAt}`. `r.clone()` leaves the web player's stream untouched. The response is ONE signed progressive FLAC URL (token in query string, no Widevine, no reassembly). Reuse `block-trash`'s trackId-keyed pending-promise pattern so an `onChange` firing before capture can await the descriptor.
- **Prefetch → gapless:** Qobuz prefetches `file/url` a few tracks ahead (already exploited by `block-trash`'s resolveAhead). When an upcoming queue item's descriptor lands, `send('enqueue', {trackId, url})` so mpv has lookahead.
- **Silence, don't block:** on enable, `a.muted=true; a.volume=0` on the `<audio>` element and re-assert on every track change (element may be recreated). Muted element still decodes, advances `currentTime`, fires `ended`, drives scrobble + MediaSession + auto-advance. (Blocking MSE/appendBuffer instead freezes `currentTime` and kills auto-advance — do NOT do that.) Cost: one wasted decode + ~2x bandwidth at 192k. Accepted.
- **Transport OUT (single `QZ_STORE` subscription):** `currentTrack.id` change → await descriptor → `send('load',{url}); send('play')`. `playingState` flip → `send('play'|'pause')`. Position discontinuity not explained by elapsed → `send('seek', ms)`. `waiting`/`stalled` → `send('pause')`; `playing` → `send('play'); send('seek', getPositionMs())` to re-lock. Reuse existing `Q.player.onChange`, `Q.player.getPositionMs`, transport-click seams (`.pct-player-*`, `.player__progressbar`).
- **UI clock:** keep the progress bar on the web element's clock (it decodes the same bytes in real time). Use mpv `time-pos` only for gapless reconciliation + MediaSession, never to override the store (avoids fighting the app's own render).
- **Volume → hardware:** intercept store volume changes → `send('setVolumeHw', pct)`. mpv sets the DAC's ALSA mixer element (snd_mixer PCM/Digital) — hardware attenuation stays bit-perfect (Roon's Device-Volume model). If the DAC exposes no hardware volume element, pin unity and grey the slider (zero-config: hide the knob). Never map the slider to mpv software volume.
- **Toggle:** `Q.registerSettings({label:'Bit-perfect mode'})` + localStorage flag. ON spawns/enables native + mutes + null-sink route. OFF unmutes, restores sink + volume, kills native, reverts to plain Chromium.

### Preload (`wrapper/preload.js`) — currently injection-only, no bridge
Add:
```js
contextBridge.exposeInMainWorld('__QZBP__', {
  send: (ch,msg)=>ipcRenderer.send('qzbp:cmd',{ch,msg}),
  on:   (cb)=>ipcRenderer.on('qzbp:evt',(_,m)=>cb(m))
});
```
`contextIsolation:true`/`nodeIntegration:false` (main.js:190-194) means this explicit bridge is the only path.

### Main (`wrapper/main.js`) — currently spawns no child
On enable, spawn the bundled libmpv host (electron-builder `extraResources`), relay `qzbp:cmd` → mpv IPC socket JSON, and mpv property events → `qzbp:evt`. Supervise like the existing renderer-crash cap (main.js:236): respawn ≤N times, kill on window `closed`/quit, and **on any native fatal → tell renderer to UNMUTE** so audio never fully drops.

### Native IPC protocol
Commands: `load(url)`, `enqueue(trackId,url)`, `play`, `pause`, `seek(ms)`, `setVolumeHw(pct)`, `stop`. Events: `ready`, `audioParams(rate,fmt,ch)`, `position(ms)`, `trackstarted(trackId)`, `ended`, `stalled`, `error`. Web store is ordering authority: if mpv `trackstarted` disagrees with `currentTrack` (user skipped), renderer force-resyncs with `load`.

---

## 3. macOS: **yes, same backend, same one flag**

libmpv's `coreaudio` AO + `--audio-exclusive=yes` takes **Hog Mode** (writes PID to `kAudioDevicePropertyHogMode`) and switches the device physical format per track. With `--audio-samplerate` unset, no resampler is inserted → byte-exact on any external USB/Thunderbolt DAC. `--audio-device=coreaudio/<uid>`. Use the regular `coreaudio` AO, NOT `coreaudio_exclusive` (that one is for S/PDIF/DSD and has DAC-specific bugs). Float32 coreaudio path is bit-transparent to 24-bit (Qobuz max), so integer mode is unneeded.

Two macOS-specific realities:
- **Hog Mode is refused on built-in speakers/headphone jack** (OS keeps system alerts alive; cf. Feishin #2048 crash). Bit-perfect on Mac = external DAC only. Degrade to shared gracefully, never crash. Auto-pick must exclude built-in AND be careful not to grab HDMI-to-TV/Bluetooth/capture outputs.
- **Bundling a native sidecar forces signing/notarization.** Every bundled dylib (libmpv + libav*) must be codesigned, `hardenedRuntime:true`, sidecar gets `build/entitlements.mac.inherit.plist`, then notarize. Applying hardened runtime to bundled ffmpeg breaks it ("can't detect audio codec") without the inherit entitlements. **Blocker check:** requires a paid Apple Developer ID. If none exists, macOS bit-perfect ships later; Linux ships first. The correction also notes `--audio-exclusive` is a no-op on the ALSA AO specifically (Linux exclusivity comes from selecting the `hw:` device, which the §1 invocation does) — so the "one flag, all three OSes" framing is true for the *config surface* but the mechanism differs per AO. Fine, outcome holds.

---

## 4. Verification plan (prove it, don't assert it)

**Headless on the Arch VM (192.168.30.220, no real DAC needed):**
1. **snd-aloop null test (gold standard):** `modprobe snd-aloop` (does zero rate/format/channel conversion). Point mpv at `hw:Loopback,0`, simultaneously `arecord -D hw:Loopback,1,0 -f S32_LE -r 192000 -c2` at the track's exact rate. `cmp`/`md5` the captured PCM against the independently `ffmpeg -f s32le`-decoded FLAC. **Byte-identical == the software path is provably bit-perfect.** Runs in CI on every build (pins mpv's locked-down config so a regression trips the null test).
2. **hw_params introspection:** during playback `cat /proc/asound/card<X>/pcm<Y>p/sub0/hw_params` — confirm format = S24/S32_LE and rate matches the track and is NOT forced to 48000. Through `default` you'd see dmix/resample; through `hw:` you see native. Proves "no resample" negatively.
3. **Decode-parity:** md5 the PCM mpv produces from the captured `file/url` URL against `ffmpeg -i <same URL>` and against a known-good download of the same track — belt-and-suspenders on the §5 master-quality claim.
4. **Double-audio / sync:** confirm the null-sink route keeps Chromium's `currentTime` advancing and `ended` firing while mpv holds the loopback device exclusively. This validates the §2 contradiction fix.

**Needs Ethan's real USB/SPDIF DAC (VM can't do it):**
- DAC front-panel LED matches per-track rate for a 44.1, a 96, and a 192k track (proves the physical endpoint, not just software).
- Exclusive-mode hog actually succeeds while PipeWire is running on a real desktop.
- Relock gap duration on 2-3 DACs (decides whether same-rate queue grouping is worth it).
- On macOS: Audio MIDI Setup shows the device rate flipping per song on an external DAC.

Split acceptance: **null-test + hw_params = pipeline proven in CI; one-time hardware pass = endpoint proven.**

---

## 5. THE make-or-break unknown: is the web `getFileUrl` FLAC the master?

**Answer from prior art: the stream itself is NOT transcoded/capped by Qobuz — the loss is 100% client-side in Chromium's WebAudio path.** Proof by existence: QBZ (github.com/vicrodh/qbz), hifi.rs, qobuz-dl, and streamrip all hit the *same* `getFileUrl` API and pull bit-perfect FLAC up to format_id 27 (24/192). QBZ's own docs: browsers cap at 48 kHz via WebAudio; a native pipeline delivers the original resolution. So capturing that URL and decoding outside Chromium yields the master.

**The real risk is not transcoding, it's which format_id the web player requested.** Intercepting the web fetch only gives you whatever resolution *the browser asked for*, gated by (a) account tier and (b) the web player's quality toggle. The web player historically defaulted CD-only (16/44). QBZ gets 24/192 because it *explicitly requests format_id 27* — not the same as "the intercepted URL is hi-res."

**How to settle it (do this in Phase 0, one live capture):**
- Log one real `file/url` response in the wrapper on a hi-res track with a Studio/Sublime account. Read the echoed `format_id`/`sampling_rate`/`bit_depth`.
- If it already returns 27 → capture-and-replay is sufficient. Done.
- **If capped** (returns 5/6/16-44): do NOT reimplement signing blindly. Two moves, prefer (A): **(A)** steer the app's own quality preference to hi-res (store dispatch / quality selector) so it *natively* fetches format 27, then capture whatever it fetches — no signing needed. **(B)** if the app won't request 27, issue our *own* `getFileUrl` at format_id 27 using Qobuzify's in-app token (`app_id` + MD5 `request_sig` from the bundled app secret; `Q.api()` already proves the token path works for reads). Fragile — breaks on Qobuz bundle changes — so it's the fallback to the fallback.

Bottom line: **bit-perfect is achievable; the only thing that can cap it is the requested format_id, and that is steerable in-app.** Verify with the one live capture before building the pipeline.

---

## 6. Windows installer redesign

Frame: Windows already gets bit-perfect (patches the official app's JUCE/WASAPI-exclusive engine). The ask here is *installer parity* (zero-dependency, robust), NOT audio.

- **Kill the Node dependency: bundle portable `node.exe`, do NOT port to PowerShell.** The install command drives ~400+ lines across `lib/apply.js`/`locate.js`/`bin/qobuzify.js` doing JSON payload escaping, `</script>` escaping, and regex patches on the *minified* `main-win32.js`. Re-implementing that in PS is a fragile rewrite that immediately diverges from the shared Node codebase that also powers Linux/mac/Android. Ship the single official x64 `node.exe` at `runtime/node/node.exe`. It's Authenticode-signed by OpenJS (helps SmartScreen), needs no npm, repo has zero deps. Cost: zip grows 653 KB → ~35 MB (node.exe ~76-90 MB uncompressed, ~35 MB Deflate) — still under a third of the AppImage. `install.ps1` calls bundled node first, falls back to PATH-probe system node.
- **Handle missing Qobuz app (pre-flight, before any download):** test `%LOCALAPPDATA%\Qobuz` for `app-*` + `Qobuz.exe`. If absent, `Get-AppxPackage *Qobuz*` — the **Store/MSIX build cannot be patched** (sealed, no unpacked `resources/app`), so print "install the desktop build from qobuz.com, not the Store version." If nothing found, with consent `Start-Process` the official download page. Never silent-install. (Verify the exact Appx identity string on a real box.)
- **No elevation.** Qobuz is per-user Squirrel in `%LOCALAPPDATA%`, target is `%LOCALAPPDATA%\Qobuzify`, `taskkill /IM Qobuz.exe` on own process needs no admin. Keep it scoop/bun-style user-scope.
- **Running-Qobuz notice:** `apply.js` already `taskkill /F` + relaunches. Add a `Get-Process Qobuz` check that prints "Qobuz is open; it will close and relaunch to apply changes" so the kill isn't a surprise.
- **Integrity — honest version:** publish `qobuzify.zip.sha256`, `Get-FileHash -Algorithm SHA256`, hard-`throw` on mismatch. **But embed the expected hash *inside* `install.ps1`** (which is TLS-delivered via `irm|iex`) rather than fetching a sibling `.sha256` from the same origin — a same-origin sibling hash only guards against transport corruption, not tampering (an attacker who swaps the zip swaps the sibling too). Embedded-in-the-TLS-script hash is the real tamper anchor. Also pin+verify node.exe's known hash.
- **Perf:** wrap downloads in `$ProgressPreference='SilentlyContinue'` (IWR progress bar throttles up to ~10-50x).
- **Idempotence (already decent, keep):** stash `.spotify-creds.json`/`.apple-creds.json` across re-extract; `.qobuzify-state.json` lives as a sibling of the install dir so re-extract doesn't wipe seed/theme; `restore` rebuilds from `.qobuzify-bak` (call bundled node so uninstall needs no system Node).
- **Build (`tools/build-zip.ps1`):** add `runtime/node/node.exe` (fetch once from nodejs.org dist, extract just node.exe), emit the hash, deploy zip + updated `install.ps1` with embedded hash to `site/public`.

---

## 7. Ordered implementation plan + feasibility call

**Phase 0 — de-risk on the Arch VM (do FIRST, before writing product code):**
1. One live `file/url` capture on a hi-res account → settle §5 (is it format_id 27?).
2. Prototype the §2 null-sink route: prove Chromium `<audio>` `currentTime`/`ended` keep advancing against a null sink while a standalone mpv holds `hw:Loopback` exclusive. **This is the make-or-break for the whole architecture — if it can't be solved cleanly, fall back to §2(B) mpv-clock authority.**
3. Run the snd-aloop null test with mpv + the §1 invocation against a downloaded 24/192 FLAC → prove byte-exact before touching the wrapper.

**Phase 1 — native backend + build:** compile LGPL libmpv + LGPL FFmpeg, audio-only, dynamic-link; wrap a minimal IPC host; add to electron-builder `extraResources` for AppImage/.deb; wire the fallback ladder + device auto-pick.

**Phase 2 — wrapper plumbing:** `wrapper/preload.js` contextBridge; `wrapper/main.js` sidecar spawn/supervise/relay + unmute-on-fatal.

**Phase 3 — renderer extension:** `extensions/bitperfect/index.js` (capture on `block-trash` fetch chain, mute+null-sink route, store-subscription transport, prefetch enqueue, volume→hw, settings toggle).

**Phase 4 — verify:** null-test + hw_params in CI; then the one-time real-DAC pass on Ethan's hardware (44.1/96/192 front-panel + exclusive-while-PipeWire).

**Phase 5 — macOS:** same backend + `coreaudio`; only if a paid Apple Developer ID exists (else defer, ship Linux).

**Phase 6 (parallel, independent) — Windows installer:** bundle node.exe, pre-flight Qobuz check, embedded-hash integrity, `$ProgressPreference` fix, running-Qobuz notice.

**Blunt feasibility call:** True bit-perfect on Linux is **definitely achievable and proven** (QBZ/Feishin/hifi.rs do exactly this; the null test will prove it byte-for-byte). It is **not "zero-config, just works" in the way the AppImage today is** — that framing is the one place the research over-sells. The audio *engine* is a solved, bundled, battle-tested component. **The single biggest risk is the two-brain sync: keeping the sealed Qobuz web player's timeline/queue/scrobble state machine correct while a muted-but-live Chromium element and an exclusively-holding libmpv both need to coexist without contending for the DAC (§2 null-sink resolution).** That is net-new integration work with no prior art to copy (QBZ replaced the UI entirely; we're keeping Qobuz's). Settle it in Phase 0 step 2 before committing to the full build. Format_id capping (§5) is the second risk but is steerable in-app. Everything else is engineering, not uncertainty.