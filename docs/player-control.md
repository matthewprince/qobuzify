# Controlling a sealed player

Qobuz plays audio through a native JUCE addon, not an HTML `<audio>` element. There is no `play()`, `pause()`, `seek()`, `setVolume()`, or queue API reachable from the renderer. Everything that touches playback has to drive the app's own UI controls or, in one case, reach a React component's props through the fiber.

This is the single most important thing to understand about extending Qobuz, and it's why the playback extensions are shaped the way they are. Here are the working techniques.

## Transport (play, pause, next, prev, shuffle, repeat, like)

These are the easy ones. The player-bar buttons are real, so click them:

```js
function click(sel) {
  var el = document.querySelector(sel);
  if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
}
```

| action     | selector |
|------------|----------|
| play/pause | `.player__action-pause, .player__action-play` |
| next       | `.pct-player-next` |
| previous   | `.pct-player-prev` |
| shuffle    | `.pct-shuffle` |
| repeat     | `.pct-repeat` |
| mute       | `.pct-volume` |
| like       | `.player .ButtonFavorite` |

Play/pause has two possible classes because the same button relabels itself, so the combined selector catches whichever is current. This is how sleep-timer pauses and how keyboard-shortcuts does transport.

## Seek

Seeking is the subtle one. The only clean path is the player's own progress bar, and you have to fake the exact gesture it listens for.

The bar derives the target time from the mouse x-position on `mousemove` (it stores a `potentialSeekPosition`) and commits it on `mouseup`. So you synthesize a `mousemove` at the x-coordinate for your target time, then a `mouseup`:

```js
function seekToMs(targetMs) {
  var bar = document.querySelector(".player__progressbar");
  var input = document.querySelector(".player__progressbar input[type=range]");
  if (!bar || !input) return;
  var dur = parseInt(input.max, 10) || 0; if (!dur) return;
  targetMs = Math.max(0, Math.min(targetMs, dur));
  var rect = bar.getBoundingClientRect();
  // invert the bundle's own formula: potentialSeekPosition = dur * (clientX - left - 7.5) / (width - 15)
  var clientX = rect.left + 7.5 + targetMs * (rect.width - 15) / dur;
  clientX = Math.max(rect.left + 1, Math.min(rect.left + rect.width - 1, clientX));
  var clientY = input.getBoundingClientRect().top + 6; // must be >= the input's top or it bails
  var o = { bubbles: true, cancelable: true, view: window, clientX: clientX, clientY: clientY, button: 0 };
  bar.dispatchEvent(new MouseEvent("mousemove", o));
  input.dispatchEvent(new MouseEvent("mouseup", o));
}
```

The trap: **do not write `input.value` directly.** That only sets the "seeked" visual preview, and with no `mouseup` to commit it the bar freezes at that value. Never touch the value; drive the gesture. This is the mechanism behind seek-controls, keyboard-shortcuts, and full-app-display's scrubber.

### The alternative: reach the seek through the fiber

Qobuzify Lyrics needs to seek when you click a lyric line, and it uses a different route: the progress bar's React component (a legacy React 16 build, reached via `__reactInternalInstance$`) owns the real engine seek as `this.props.seek({ position })`. Walking the fiber up to that instance and calling it is cleaner than synthesizing the drag, when you already have a component reference:

```js
var input = document.querySelector(".player__progressbar input[type=range]");
var fk = Object.keys(input).find(function (k) { return k.indexOf("__reactInternalInstance$") === 0; });
var fiber = input[fk];
while (fiber) {
  var sn = fiber.stateNode;
  if (sn && sn.props && typeof sn.props.seek === "function") { sn.props.seek({ position: ms }); break; }
  fiber = fiber.return;
}
```

One caveat that bit us: Qobuz seeks at whole-second granularity (the engine and the position clock both round to the nearest second). Lyric lines rarely start on a whole second, so a plain round lands before the line about half the time and the previous line highlights. Bias toward the clicked line by rounding up, unless the line starts in the first 150 ms of a second.

## Volume

Volume is a slider you drive with a click, but read it carefully. The store's `settings.volume` goes stale (it stayed pinned at 100 while the rendered slider moved), so compute the current level from the slider's rendered fill, not the store:

```js
function currentVolPct() {
  var sl = document.querySelector(".player__settings-volume-slider .rangeslider");
  if (!sl) return null;
  var sw = sl.getBoundingClientRect().width || 1;
  var fill = sl.querySelector(".rangeslider__fill");
  if (fill) return Math.max(0, Math.min(100, fill.getBoundingClientRect().width / sw * 100));
  return null;
}
```

Then set a new level by dispatching `mousedown`, `mouseup`, and `click` at the x-position for that percentage across the slider. keyboard-shortcuts snaps to clean 5% steps.

## Playing a specific entity

There's no "play this album" function either, so navigate to it and click its header Play button. The subtlety is *which* Play button, because the DOM is full of `aria-label="Play"` buttons: the For You page's cards (which stay mounted but hidden), your own extension's buttons, the player bar, and the previous page mid-transition. A broad selector clicks the wrong one and plays the wrong album.

Scope to a **visible** button inside the page header:

```js
function headerPlayBtn() {
  var cands = document.querySelectorAll("[class*='PageHeader'] button[aria-label='Play']");
  for (var i = 0; i < cands.length; i++) {
    var r = cands[i].getBoundingClientRect();
    if (cands[i].offsetParent && r.width > 4 && r.height > 4) return cands[i];
  }
  return null;
}

function playEntity(path) {
  Q.navigate(path);
  var tries = 0;
  var iv = setInterval(function () {
    var onPage = (Q.getState().router.location.pathname || "").indexOf(path) >= 0;
    var btn = headerPlayBtn();
    if (onPage && btn) { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); clearInterval(iv); }
    else if (++tries > 40) clearInterval(iv);
  }, 150);
}
```

You navigate, then poll until you're on the page and its Play button has rendered, then click.

## Playing a specific track

Hardest of all, because there is no track page to navigate to. Open the track's album, wait for the tracklist, find the matching row, and click that row's own play arrow. Album track rows are `.ListItem` with `.ListItem__player[aria-label=Play]`, `.ListItem__title`, and `.ListItem__numberText`. Match by normalized title (exact, then prefix, then contains, diacritic-insensitive), break ties on the track number, and fall back to the album header Play if nothing matches so it can never hang:

```js
function playTrack(albumId, title, num) {
  Q.navigate("/album/" + albumId);
  var tries = 0;
  var iv = setInterval(function () {
    if ((Q.getState().router.location.pathname || "").indexOf(albumId) >= 0) {
      var rows = [].slice.call(document.querySelectorAll(".ListItem"))
        .filter(function (r) { return r.querySelector(".ListItem__title") && r.querySelector(".ListItem__player"); });
      if (rows.length) {
        var target = matchTrackRow(rows, title, num);            // your title/number matcher
        if (target) { fireClick(target.querySelector(".ListItem__player")); clearInterval(iv); return; }
        if (tries > 12) { var hb = headerPlayBtn(); if (hb) { hb.click(); clearInterval(iv); return; } }
      }
    }
    if (++tries > 40) clearInterval(iv);
  }, 150);
}

function fireClick(el) {
  ["mousedown", "mouseup", "click"].forEach(function (t) {
    el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  });
}
```

both better-search and For You use this to make their result-card play buttons play the actual thing you clicked. Library track rows are different markup (`.ui-module-track-row.ui-block-item-row`, with the play button appearing on hover) if you need to handle those too.

## When you can't do it live: build a playlist

Some things genuinely aren't reachable by clicking, notably the queue. Smart Radio and the shuffle button don't try. They build a playlist through the write API, then play that playlist with `playEntity`. Creating a fresh playlist each time (and deleting the old one after) also sidesteps Qobuz's playlist-content cache, which would otherwise serve stale tracks for a reused playlist id.
