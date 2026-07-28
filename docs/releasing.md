# Releasing

Not implemented yet. This is the agreed design, written down while it was fresh so that shipping it later is transcription rather than rediscovery. Nothing in here is live: as of 0.3.1 the updater still reads `/releases/latest` and every release still goes to every platform.

## The problem

CI triggers on `v*`, builds a three-OS matrix, and publishes **one** GitHub Release carrying every platform's assets. The updater in `wrapper/main.js` reads `/releases/latest`, which returns exactly one release regardless of who is asking.

So a Linux-only fix nags Windows and macOS users toward a build containing nothing for them, or worse, containing changes that were never run on their platform. That second case is the real problem, because the maintainer develops on Linux and has no Windows or macOS machine. Under the current setup, every release ships unverified Windows code by construction. There is no way to say "this one is Linux only" other than not releasing at all.

## The scheme

```
v<MAJOR>.<MINOR>.<PATCH>[+<platforms>]

v0.3.0          all three platforms
v0.3.1+linux    linux only
v0.3.2+win      windows only
v0.3.3+linux.mac
```

One shared version line across linux, win and mac, strictly monotonic. Never fork per-platform counters, and never invent a `0.3.0.1`.

The suffix is semver **build metadata** (`+`), not a prerelease identifier (`-`). This matters more than it looks:

- `-linux` sorts *below* `0.3.0` in every semver implementation, and reads as "beta" to a human. `+linux` does neither.
- The current version regex, `/(\d+)\.(\d+)\.(\d+)/` at `wrapper/main.js (semver()/RELEASES_API near the top)`, parses it unchanged. But that regex is unanchored, and that is a bug this design leans on fixing: it also "parses" `bake-v1.0.0` and `android-v0.2.0` as wrapper versions, so the tag filter below only works with the anchored replacement in the updater snippet.
- The existing CI trigger, `tags: ["v*"]`, matches it unchanged.

Suffix atoms are exactly `linux`, `win`, `mac`, dot joined, alphabetical. **No suffix means all three**, which is also a claim that you tested all three.

Version gaps per platform are intentional and carry meaning. "Windows has no 0.3.4" reads as "0.3.4 was never built for Windows", not "Windows numbering is unrelated". When Windows does move, it jumps straight to the current number and picks up the accumulated work in one hop, because it is one commit lineage and one version line.

Other products never take a bare `v*` tag, so they can never collide with the desktop matrix:

```
bake-v1.0.0       the legacy Windows bake (site/public/install.ps1 + lib/apply.js)
android-v0.2.0    the Android app
```

## Channels, and the one trick that makes migration safe

Every client already installed in the field polls `/releases/latest` and **cannot be patched**. Whatever we change, those clients keep doing that until they update at least once. That is the highest risk part of this whole design, and it has a clean answer.

`/releases/latest` honours GitHub's `make_latest` flag, and `gh release create` exposes it:

- **Unsuffixed tag → `--latest=true`.** Carries assets for all three platforms.
- **Suffixed tag → `--latest=false`.** Invisible to `/releases/latest`, therefore invisible to every old client.

So an old Windows 0.2.2 install never sees a `+linux` release at all. The cross-platform nagging bug is fixed for stale clients on day one, without those clients updating. New clients get correct behaviour from the updater below.

This is the load-bearing rule of the whole document. **Never cut a release by hand in the GitHub web UI, and never touch the "Set as latest release" checkbox.** Let CI derive it from the tag.

## The updater change

`wrapper/main.js`, replacing the constants at 89 to 90 and the body of `checkForUpdate()` at ~147. `isNewer()`, `tellAboutUpdate()`, `notifiedTag`, the 25s/24h scheduling and `QZ_NO_UPDATE_CHECK` all stay exactly as they are. `semver()` does **not** stay: it must be re-anchored (first block below), or the `bake-v*` / `android-v*` filter never filters anything.

Stop asking "what is the newest release" and start asking "what is the newest release that actually contains something I could install". Filter on **assets, not on the tag**: the tag is intent, the assets are reality. A release whose Windows runner died has no `.exe`, and Windows clients then correctly stay quiet.

```js
// ANCHORED, unlike the shipped /(\d+)\.(\d+)\.(\d+)/, which happily reads "bake-v1.0.0" as 1.0.0
// and would nag wrapper users toward a bake release. The leading-v boundary plus the (\+|$) tail
// accepts "v0.3.1", "v0.3.1+linux" and a bare "0.3.1" (app.getVersion()), and rejects bake-v*,
// android-v* and "0.3.1-dev" builds.
function semver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:\+|$)/.exec(String(v || ""));
  return m ? [+m[1], +m[2], +m[3]] : null;
}

const RELEASES_API  = "https://api.github.com/repos/matthewprince/qobuzify/releases?per_page=100";
const RELEASES_PAGE = "https://github.com/matthewprince/qobuzify/releases";
let updateTimer = null, notifiedTag = null, releasesEtag = null;

// THE TRAP: electron-builder's ${arch} is NOT process.arch. An x64 build ships as x86_64 (AppImage),
// amd64 (deb), x64 (win) and universal (mac). Matching process.arch literally means "x64" never matches
// "x86_64", so the updater matches nothing on Linux and goes PERMANENTLY SILENT instead of failing
// loudly. If an asset carries no arch token we recognise, accept it rather than disqualify ourselves.
const ARCH_ALIASES = {
  x64:   ["x64", "x86_64", "amd64", "universal"],
  arm64: ["arm64", "aarch64", "universal"],
  ia32:  ["ia32", "i386"],
};
function archOk(n) {
  const m = /-(x64|x86_64|amd64|arm64|aarch64|ia32|i386|universal)\./.exec(n);
  if (!m) return true;
  return (ARCH_ALIASES[process.arch] || [process.arch]).indexOf(m[1]) >= 0;
}

function assetMatcher() {
  if (process.platform === "win32")  return (n) => n.includes("-win-")  && archOk(n) && /\.exe$/.test(n);
  if (process.platform === "darwin") return (n) => n.includes("-mac-")  && archOk(n) && /\.(dmg|zip)$/.test(n);
  // An AppImage install can only be replaced by an AppImage; a deb install takes either.
  const ext = process.env.APPIMAGE ? /\.AppImage$/ : /\.(deb|AppImage)$/;
  return (n) => n.includes("-linux-") && archOk(n) && ext.test(n);
}

// Newest release that is both newer than us AND carries a file we can install. Deliberately not
// "the newest release", which is the entire bug being fixed.
function pickUpdate(list, local) {
  if (!Array.isArray(list)) return null;          // API error object or shape change: say nothing
  const match = assetMatcher();
  let best = null;
  for (const r of list) {
    if (!r || r.draft || r.prerelease) continue;  // prerelease stays available for real betas
    const tag = String(r.tag_name || r.name || "");
    if (!semver(tag)) continue;                   // bake-v*, android-v*, junk
    if (!isNewer(tag, local)) continue;           // unparseable => false => no nag
    if (!(r.assets || []).some((a) => match(String(a.name || "")))) continue;
    if (!best || isNewer(tag, best.tag)) best = { tag, url: r.html_url || RELEASES_PAGE };
  }
  return best;
}
```

In `checkForUpdate()`, send `If-None-Match: releasesEtag` when present and store `res.headers.etag` on a 200. A 304 costs nothing against the unauthenticated 60/hour/IP budget. Any non-200 (rate limited, offline, 304) returns silently and tries again tomorrow, which is the existing fail-safe behaviour and should stay.

## CI changes

`.github/workflows/build.yml`:

1. **A new `plan` job** (ubuntu, fast) that parses `GITHUB_REF_NAME` with an anchored regex:

   ```
   ^v([0-9]+\.[0-9]+\.[0-9]+)(\+((linux|mac|win)(\.(linux|mac|win))*))?$
   ```

   It hard-fails on a malformed tag, validates the scope against the literal `{linux,win,mac}` set (a typo like `+linx` must be a red build, not a silently empty matrix), and asserts the numeric part equals `wrapper/package.json`'s version. **That last assert is the thing that kills the drift class described below.** Outputs `matrix`, `plats`, `is_full`.

   Write the shell with `if`/`fi`, not `[[ ]] && VAR+=...` chains: under `set -e` a trailing false test kills the step.

2. **`build`** gains `needs: plan` and `strategy.matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}` with `fail-fast: false`. Every existing step survives. The mpv bundling guard becomes `if: matrix.plat == 'linux'`.

3. **`release`** passes `--latest=true` for an unsuffixed tag and `--latest=false` for a suffixed one, and gains a **verify-assets** step: for every platform in `plats`, assert at least one uploaded artifact matches that platform's client-side matcher. Fail the job otherwise. This is what converts a silent-forever updater failure into a red build.

## Fix these at the same time

Three real bugs were found while designing this. Two are fixed since; one is still live.

- **STILL LIVE: `wrapper/package.json:27` `artifactName` collides nsis and portable.** It is `Qobuzify-${version}-${os}-${arch}.${ext}`, and the `win` target list is `["nsis", "portable"]`, so both render `Qobuzify-0.2.2-win-x64.exe`. Only one survives upload, which is why v0.2.2 shipped exactly one `.exe`. **The portable build is silently discarded today.** Give each win target its own name (`...-win-${arch}-nsis.exe`, `...-win-${arch}-portable.exe`) and note that the updater matcher above then needs the flavour appended.

- **FIXED: the Worker's stale version constant.** `server/src/index.js` said `latest: "0.1.9"` while the app was on 0.2.2; it now tracks the bake line (`latest: "0.2.1"` at `server/src/index.js:38`) with per-platform entries. The lesson stands: this is second-source-of-truth rot, and it is why the `plan` job asserts the tag against `package.json` instead. A hint-less `platform=desktop` must keep resolving to the **bake**, not the Electron line, because those are the un-upgradable installs.

- **FIXED: the bake/wrapper platform collapse.** `runtime/qobuzify-runtime.js` used to set `PLATFORM = IS_ANDROID ? "android" : "desktop"`; it now distinguishes the wrapper (`wrapper-<os>`, `runtime/qobuzify-runtime.js:49`). The remaining double-nag risk (main-process banner plus runtime toast on the wrapper) is handled by the preload-marker suppression described here; verify it whenever the updater lands.

## Migration sequence

1. Cut **the next full, unsuffixed, `--latest=true` release (`v0.4.0` at the time of writing; 0.3.x shipped without any of this)** containing the new updater plus safe shared code only. Do **not** fold platform-specific unverified work into it. This is the bridge that carries the new updater to every platform.
2. From the first scoped tag after it (`v0.4.1+linux` style) onward, scoped releases are `--latest=false` and only ever move the platforms named in the tag.

What each stale pre-bridge client sees: one correct nag toward the bridge release (which does contain an asset for it), and after that it is running per-platform logic. A client that never updates only ever sees full releases, so it is never pulled toward a build that has nothing for it.

Note that `notifiedTag` is process scoped, so a user who dismisses a nag is reminded again next launch. That is existing behaviour and is fine.

## User-facing version string

```
Qobuzify 0.3.1 (linux/appimage, e3f9a1c)
Qobuzify Bake 1.0.0 (Qobuz 8.1.2)
Qobuzify 0.2.0 (android)
```

Same string in Help > About (with a copy button), in the settings panel, and in the update check's `User-Agent`. That last one is worth doing: the lyrics proxy already logs requests, so it becomes a free version-adoption view, and it is the only signal that would reveal a silently dead updater in the field. Local dev builds should read `0.3.1-dev (dirty)` so an unofficial build is never mistaken for a shipped one.

## Accepted tradeoffs

- **Windows will lag, with no forcing function.** Its eventual catch-up release ships an accumulated, individually untested batch in one hop. Accepted because the alternative is the status quo, which ships unverified Windows code on *every* release. Worth a scheduled job that opens an issue when a platform falls more than ~3 releases or ~60 days behind.
- **Stale 0.2.2 clients never see scoped fixes for their own platform**, since `--latest=false` hides those releases from them. Bounded, and shrinks as people update through `v0.3.0`.
- **A shared urgent fix drags the whole version line.** No branch topology fixes this without giving up the single version line. If it ever genuinely matters, cut a maintenance branch and relax the `package.json` assert for that one tag, deliberately.
- **macOS rides Linux's verification** on full releases, since there is no Mac either. Live with it, or default to `+linux` and treat mac as opt-in like Windows.

## Rules of thumb

1. Bump `wrapper/package.json` to match the tag, always. CI hard-fails otherwise; the fix is a deleted tag and a re-push.
2. Tested on Linux only? Tag `v0.X.Y+linux`. **No suffix is a claim that you tested all three.**
3. Suffixed means `--latest=false`. Unsuffixed means `--latest=true`. CI derives it from the tag. Never cut a release by hand.
4. The version always goes up, for everyone. Windows sitting at 0.3.0 while Linux is at 0.3.5 is correct.
5. A platform moves only when you tag it. Windows gets a fix when, and only when, someone verified Windows.
6. Different product means a different prefix: `bake-v*`, `android-v*`. Never a bare `v*`.
7. A red asset-verify step means a platform in your tag produced nothing installable. Fix the build; do not blindly re-run the release.
8. Asked "what version?", ask for the About line, not the number.
