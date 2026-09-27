// Hi-Res only, for your library. A chip on the library page swaps the native track list for a list of
// just your 24-bit favourites. Runs as function(Qobuzify){ ... return cleanup }.
//
// Why a rendered list rather than filtering the real one - both cheaper options were measured and ruled
// out, so this is not gold-plating:
//   * Hiding non-hi-res rows in the DOM does not work. The library list is WINDOWED: scrolling a
//     512-track library to the bottom moves the rendered row count 21 -> 18, it never grows. It is a
//     custom `ui-scroll` list, not ReactVirtualized, so the usual virtualisation check misses it and the
//     idea looks viable right up until you try it. Hiding rows yields a mostly-empty list.
//   * Filtering Qobuz's own fetch by wrapping Q.api does not work either. Q.api is Qobuzify's helper;
//     Qobuz's list does not use it. Spying on it across a full navigate-away-and-back to the library
//     captured ZERO calls. Reaching the real request means patching window.fetch, which puts us in the
//     path of every request the app makes - far too much blast radius for a filter.
// So: render our own list from the data library-load has already cached (it stores maximum_bit_depth per
// track), and drive playback through the album page, which is the one path proven to work on the sealed
// player. Nothing here touches Qobuz's data layer.
var Q = Qobuzify;
var CSS_ID = "qz-hrf-css";
var CHIP_ID = "qz-hrf-chip";
var PANEL_ID = "qz-hrf-panel";

var on = false;          // filter engaged
var panel = null, chip = null;
var lastCount = 0;

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
function el(html) { var d = document.createElement("div"); d.innerHTML = html; return d.firstElementChild; }
function fmtDur(sec) { sec = Math.max(0, Math.round(sec || 0)); var m = Math.floor(sec / 60), s = sec % 60; return m + ":" + (s < 10 ? "0" : "") + s; }
function route() { try { return Q.getState().router.location.pathname || ""; } catch (e) { return ""; } }
function isLibraryRoute(p) { return /^\/user-library(\/|$)/.test(p || route()); }

// 24-bit is the line Qobuz's own Hi-Res Audio badge draws, so use the same one: the chip and the badge
// must never disagree about what "hi-res" means.
function isHires(t) { return !!t && ((t.maximum_bit_depth || 0) >= 24 || t.hires === true); }

// Qobuz's own Hi-Res AUDIO logo, straight from the app's bundle so it looks native and is never tinted.
// Same dual path quality-badges uses: on the DESKTOP app it resolves relative to app.html out of the
// unpacked bundle, but on the WEB player (play.qobuz.com - what the Linux/Mac wrapper loads) that
// node_modules path returns the SPA's HTML fallback with a 200, which renders as a broken image.
var HIRES_IMG = (location.host.indexOf("play.qobuz.com") >= 0)
  ? "/assets/images/logos/hires.png"
  : "node_modules/@qobuz/qobuz-dwp-ui/dist/assets/images/logos/hires.png";

// Sample rate only. The bit depth is the one thing every row here shares - the filter guarantees 24-bit -
// so printing it is dead weight, but the rate is what actually varies (44.1 / 48 / 88.2 / 96 / 176.4 /
// 192) and is the reason to look at this column at all.
function rateOf(t) {
  var sr = t.maximum_sampling_rate || 0;
  if (!sr) return "";
  return (sr % 1 === 0 ? sr : sr.toFixed(1)) + " kHz";
}

function libTracks() {
  try { return (Q.library && typeof Q.library.tracks === "function") ? (Q.library.tracks() || []) : null; }
  catch (e) { return null; }
}
function hiresTracks() {
  var all = libTracks();
  if (!all) return null;
  var out = [];
  for (var i = 0; i < all.length; i++) if (isHires(all[i])) out.push(all[i]);
  return out;
}

// ---------- playback: album page, then the row. Same route better-search proved on this player. ----------
function normTitle(s) { return String(s == null ? "" : s).toLowerCase().replace(/\(.*?\)|\[.*?\]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
function fireClick(elm) { ["mousedown", "mouseup", "click"].forEach(function (t) { elm.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); }); }
function tracklistRows() {
  return [].slice.call(document.querySelectorAll(".ListItem")).filter(function (r) {
    return r.querySelector(".ListItem__title") && r.querySelector(".ListItem__player");
  });
}
// The dest page's header Play, and visible. A loose aria-label=Play selector grabs the player bar, a
// hidden For You card or the previous page mid-transition and starts the WRONG album - better-search
// paid for that lesson, so keep its paired selector and the visibility test.
function headerPlayBtn() {
  var cands = document.querySelectorAll("[class*='PageHeader'] button[aria-label='Play'], button[aria-label='Play'].ButtonRoundPrimary--large");
  for (var i = 0; i < cands.length; i++) {
    var r = cands[i].getBoundingClientRect();
    if (cands[i].offsetParent && r.width > 4 && r.height > 4) return cands[i];
  }
  return null;
}
function matchTrackRow(rows, title, num) {
  var wt = normTitle(title), best = null, bestS = -1;
  rows.forEach(function (r) {
    var te = r.querySelector(".ListItem__title"), rt = te ? normTitle(te.textContent) : "", s = 0;
    if (rt && rt === wt) s = 100;
    else if (rt && wt && (rt.indexOf(wt) === 0 || wt.indexOf(rt) === 0)) s = 70;
    else if (rt && wt && (rt.indexOf(wt) >= 0 || wt.indexOf(rt) >= 0)) s = 40;
    if (num) { var ne = r.querySelector(".ListItem__numberText"); if (ne && parseInt(ne.textContent, 10) === num) s += 15; }
    if (s > bestS) { bestS = s; best = r; }
  });
  return bestS >= 40 ? best : null;
}
var playIv = null;
function playTrack(albumId, title, num) {
  if (!albumId) return;
  close();                                   // the album page is the destination; don't cover it
  Q.navigate("/album/" + albumId);
  if (playIv) clearInterval(playIv);
  var tries = 0;
  playIv = setInterval(function () {
    tries++;
    if ((route() || "").indexOf(albumId) >= 0) {
      var rows = tracklistRows();
      if (rows.length) {
        var target = matchTrackRow(rows, title, num);
        if (target) {
          var p = target.querySelector(".ListItem__player") || target.querySelector(".ListItem__number");
          if (p) { fireClick(p); clearInterval(playIv); playIv = null; return; }
        }
      }
      // Fallback OUTSIDE the rows-exist gate: it must fire both when the row match fails AND when no
      // .ListItem rows ever render (the wrapper's album page uses .ui-module-track-row with no per-row
      // play control), or the poll just expires in silence.
      if (tries > 12) {
        var hb = headerPlayBtn();
        if (hb) { hb.dispatchEvent(new MouseEvent("click", { bubbles: true })); clearInterval(playIv); playIv = null; return; }
      }
    }
    if (tries > 40) { clearInterval(playIv); playIv = null; }
  }, 150);
}

// ---------- panel ----------
// Hosted inside the app layout at z:220 (under Qobuz's nav/player panels at z:250) so the app's own
// dropdowns still open above it, and sized to the content region so the sidebar and player bar stay
// usable - a body-level max-z overlay covers them and feels like a modal, which this is not.
function layoutHost() { var pt = document.querySelector(".ui-layout--root--panel-top"); return (pt && pt.parentElement) || document.body; }
// Starts BELOW the library toolbar, not at the top of the scroll region. The toolbar is the chip's home,
// so covering it left the chip hidden and unclickable while the filter was on (measured: elementFromPoint
// at the chip's centre returned the panel) - the only way back out was the panel's own button. Leaving the
// toolbar exposed also keeps Qobuz's search, sort and genre filter usable alongside this one.
function contentRect() {
  var sc = document.querySelector(".ui-layout--root--scroll-main") || document.querySelector(".ui-layout--root--main") || document.querySelector(".ui-scroll");
  if (sc) {
    var r = sc.getBoundingClientRect();
    if (r.width > 200 && r.height > 200) {
      var top = r.top;
      var tb = document.querySelector(".ui-section-toolbar");
      if (tb) {
        var tr = tb.getBoundingClientRect();
        if (tr.height > 0 && tr.top <= r.top + 8) top = tr.bottom;   // only when it really is the header
      }
      return { top: top, left: r.left, width: r.width, height: Math.max(160, (r.top + r.height) - top) };
    }
  }
  return { top: 133, left: 0, width: window.innerWidth, height: Math.max(300, window.innerHeight - 133 - 78) };
}
function layout() {
  if (!panel) return;
  var h = layoutHost();
  if (panel.parentElement !== h) h.appendChild(panel);   // survive React re-renders
  var r = contentRect();
  panel.style.top = r.top + "px"; panel.style.left = r.left + "px";
  panel.style.width = r.width + "px"; panel.style.height = r.height + "px";
}

function rowHTML(t, i) {
  var art = (t.album && t.album.image && (t.album.image.small || t.album.image.thumbnail)) || "";
  // No row number: this is a filtered view of a library, not an ordered tracklist, so the index counts
  // nothing meaningful - and Qobuz's own library rows are unnumbered too.
  return '<div class="qz-hrf-row" data-i="' + i + '">' +
    '<span class="qz-hrf-art">' + (art ? '<img loading="lazy" src="' + esc(art) + '">' : "") +
      '<button class="qz-hrf-play" aria-label="Play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg></button></span>' +
    '<span class="qz-hrf-meta"><span class="qz-hrf-t">' + esc(t.title) + "</span>" +
      '<span class="qz-hrf-s">' + esc((t.performer && t.performer.name) || "") +
      (t.album && t.album.title ? " &middot; " + esc(t.album.title) : "") + "</span></span>" +
    // Qobuz's own logo, untinted, with just the sample rate beside it.
    '<span class="qz-hrf-spec"><img src="' + esc(HIRES_IMG) + '" alt="Hi-Res Audio" draggable="false">' +
      '<span class="qz-hrf-rate">' + esc(rateOf(t)) + "</span></span>" +
    '<span class="qz-hrf-dur">' + fmtDur(t.duration) + "</span>" +
    "</div>";
}

var rendered = [];
function render() {
  if (!panel) return;
  var body = panel.querySelector(".qz-hrf-body");
  var head = panel.querySelector(".qz-hrf-count");
  var list = hiresTracks();

  if (list === null) {
    head.textContent = "";
    body.innerHTML = '<p class="qz-hrf-empty">This needs the <b>Library cache</b> extension (library-load) switched on -' +
      " it is what holds your favourites' bit depth locally. Enable it, open your library once, then try again.</p>";
    return;
  }
  if (!Q.library.ready("tracks")) {
    head.textContent = "";
    body.innerHTML = '<p class="qz-hrf-empty">Loading your library… this happens once, then it is cached.</p>';
    try { Q.library.load("tracks"); } catch (e) {}
    return;
  }
  rendered = list;
  lastCount = list.length;
  var total = (libTracks() || []).length;
  head.textContent = list.length + " hi-res of " + total + " favourites";
  if (!list.length) {
    body.innerHTML = '<p class="qz-hrf-empty">No 24-bit tracks in your favourites yet.</p>';
    return;
  }
  var html = "";
  for (var i = 0; i < list.length; i++) html += rowHTML(list[i], i);
  body.innerHTML = html;
  body.scrollTop = 0;
}

function ensureUI() {
  if (panel) return;
  panel = el('<div id="' + PANEL_ID + '">' +
    '<div class="qz-hrf-head"><span class="qz-hrf-title">Hi-Res only</span>' +
    '<span class="qz-hrf-count"></span>' +
    '<button class="qz-hrf-close" aria-label="Show all tracks">Show all</button></div>' +
    '<div class="qz-hrf-body"></div></div>');
  panel.querySelector(".qz-hrf-close").addEventListener("click", function () { setOn(false); });
  // one delegated handler for the whole list: a per-row listener on a few hundred rows is wasted work
  panel.querySelector(".qz-hrf-body").addEventListener("click", function (e) {
    var row = e.target.closest && e.target.closest(".qz-hrf-row");
    if (!row) return;
    var t = rendered[+row.getAttribute("data-i")];
    if (!t) return;
    var alId = t.album && t.album.id;
    if (!alId) return;
    if (e.target.closest(".qz-hrf-play")) { e.preventDefault(); e.stopPropagation(); playTrack(alId, t.title, t.track_number); return; }
    close(); Q.navigate("/album/" + alId);
  });
  layoutHost().appendChild(panel);
}

function open() { ensureUI(); render(); layout(); panel.style.display = "flex"; requestAnimationFrame(function () { panel.classList.add("qz-hrf-in"); }); }
function close() { if (panel) { panel.classList.remove("qz-hrf-in"); panel.style.display = "none"; } }

function setOn(v) {
  on = !!v;
  if (chip) chip.classList.toggle("qz-hrf-active", on);
  if (on) open(); else close();
}

// ---------- chip ----------
// The chip sits INSIDE the library toolbar's right-hand control group, as a real flex child next to the
// sort and genre-filter buttons, so it flows with their gap and can never overlap them.
//
// It used to be position:fixed at "content rect, top-right minus 132px". That is precisely where Qobuz
// puts its own "Filter by genre" button (measured: x 2348-2526), so the chip rendered ON TOP of it. The
// DOM check that was supposed to catch this asked elementFromPoint what was at the chip's centre, got the
// chip back, and read that as "nothing is covering it" - true, and exactly backwards. Being on top WAS
// the bug. Anchoring to a real container removes the whole class of problem.
function toolbarHost() {
  var tb = document.querySelector(".ui-section-toolbar");
  if (!tb) return null;
  var gen = tb.querySelector("[class*='genres-selector--trigger']");
  if (gen) {
    // walk out to the first ancestor that is a laid-out flex row (React fragments in between render as
    // display:contents with a zero rect, so skip anything without real geometry)
    var n = gen.parentElement;
    while (n && n !== tb) {
      if (getComputedStyle(n).display === "flex" && n.getBoundingClientRect().width > 100) return n;
      n = n.parentElement;
    }
  }
  return tb.querySelector(".ui-base-bar") || tb;
}
function ensureChip() {
  var host = toolbarHost();
  if (!host) { if (chip) { chip.remove(); chip = null; } return; }   // toolbar not up yet; try next tick
  if (chip && chip.isConnected && chip.parentElement === host) return;
  if (!chip) {
    chip = el('<button id="' + CHIP_ID + '" type="button" title="Show only 24-bit tracks">' +
      '<span class="qz-hrf-dot"></span>Hi-Res</button>');
    chip.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); setOn(!on); });
  }
  host.appendChild(chip);                        // re-home after a React re-render
  chip.classList.toggle("qz-hrf-active", on);
}
function placeChip() { /* in-flow now: the toolbar lays it out. Kept so callers read the same. */ }

// Only exists on the library. Anywhere else the chip is REMOVED (not just hidden) and the filter resets -
// leaving it engaged would silently re-cover the library next time you walked back into it.
//
// Re-asserted on DOM mutations, not just on route change: Qobuz re-renders the layout host and takes our
// chip out with it, and a route-change-only sync leaves you on the library page with no chip until you
// navigate somewhere and come back. Caught exactly that in testing - getElementById returned null on a
// page where the chip was supposed to be live. ensureChip/layout both no-op when nothing has moved, so
// this stays cheap.
function sync() {
  if (isLibraryRoute()) {
    ensureChip(); placeChip();
    // Re-assert placement only. Calling open() here would re-render all 199 rows on every mutation
    // batch, which is a repaint storm on a page that mutates constantly.
    if (on) { ensureUI(); layout(); panel.style.display = "flex"; }
  } else {
    if (on) setOn(false);
    if (chip) { chip.remove(); chip = null; }
    if (panel) close();
  }
}

function onResize() { if (isLibraryRoute()) { placeChip(); if (on) layout(); } }
function onEsc(e) { if (e.key === "Escape" && on) { e.stopPropagation(); setOn(false); } }

Q.css(CSS_ID, [
  // sized to sit level with Qobuz's own 45px-tall toolbar controls rather than floating over them
  "#" + CHIP_ID + "{flex:0 0 auto;height:45px;display:inline-flex;align-items:center;gap:8px;",
  "padding:0 18px;border-radius:999px;cursor:pointer;",
  // colour comes from the toolbar the chip sits in, so it reads on Qobuz's light appearance too - a fixed light
  // grey was near-invisible on white. Border and fill are mixes of that same colour.
  "color:inherit;border:1px solid color-mix(in srgb,currentColor 18%,transparent);",
  "background:color-mix(in srgb,currentColor 6%,transparent);font:inherit;font-size:13px;font-weight:650;",
  "letter-spacing:.2px;white-space:nowrap;transition:background .13s,color .13s,border-color .13s;}",
  "#" + CHIP_ID + ":hover{border-color:color-mix(in srgb,currentColor 34%,transparent);background:color-mix(in srgb,currentColor 10%,transparent);}",
  "#" + CHIP_ID + ".qz-hrf-active{background:var(--qz-accent,#3DA8FE);border-color:transparent;color:#06090a;}",
  ".qz-hrf-dot{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.65;}",

  "#" + PANEL_ID + "{position:fixed;z-index:220;display:none;flex-direction:column;color:#eef2f7;",
  "background:linear-gradient(180deg,#0a0e17,#060a12 60%);opacity:0;transition:opacity .16s ease;",
  "font-family:inherit;overflow:hidden;}",
  "#" + PANEL_ID + ".qz-hrf-in{opacity:1;}",
  ".qz-hrf-head{flex:0 0 auto;display:flex;align-items:center;gap:14px;padding:18px 30px 12px;",
  "border-bottom:1px solid rgba(255,255,255,.07);}",
  ".qz-hrf-title{font-size:19px;font-weight:700;}",
  ".qz-hrf-count{font-size:12.5px;font-weight:600;color:#7d8798;flex:1;}",
  ".qz-hrf-close{appearance:none;border:1px solid rgba(255,255,255,.16);background:transparent;color:#cdd6e2;",
  "font:inherit;font-size:12.5px;font-weight:600;padding:6px 13px;border-radius:999px;cursor:pointer;}",
  ".qz-hrf-close:hover{border-color:rgba(255,255,255,.3);color:#fff;}",
  ".qz-hrf-body{flex:1 1 auto;overflow-y:auto;padding:6px 16px 22px;}",
  ".qz-hrf-empty{color:#8b95a6;font-size:14px;padding:26px 14px;line-height:1.6;max-width:640px;}",
  ".qz-hrf-row{display:flex;align-items:center;gap:14px;padding:7px 14px;border-radius:9px;cursor:pointer;}",
  ".qz-hrf-row:hover{background:rgba(255,255,255,.06);}",
  ".qz-hrf-art{position:relative;flex:0 0 42px;width:42px;height:42px;border-radius:5px;overflow:hidden;background:#131823;}",
  ".qz-hrf-art img{width:100%;height:100%;object-fit:cover;display:block;}",
  ".qz-hrf-play{position:absolute;inset:0;display:none;align-items:center;justify-content:center;",
  "appearance:none;border:0;background:rgba(0,0,0,.55);color:#fff;cursor:pointer;padding:0;}",
  ".qz-hrf-play svg{width:20px;height:20px;}",
  ".qz-hrf-row:hover .qz-hrf-play{display:flex;}",
  ".qz-hrf-meta{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;}",
  ".qz-hrf-t{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  ".qz-hrf-s{font-size:12px;color:#8b95a6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
  // no tint, no filter: it is Qobuz's own gold logo and it should look exactly like it does everywhere else
  ".qz-hrf-spec{flex:0 0 auto;display:inline-flex;align-items:center;gap:9px;}",
  ".qz-hrf-spec img{height:26px;width:auto;display:block;}",
  // fixed width + tabular figures so the rates form a straight column instead of jittering per row
  ".qz-hrf-rate{min-width:62px;font-size:12px;font-weight:600;color:#8b95a6;font-variant-numeric:tabular-nums;}",
  ".qz-hrf-dur{flex:0 0 46px;text-align:right;font-size:12px;color:#7d8798;font-variant-numeric:tabular-nums;}"
].join(""));

var offRoute = Q.onRoute(sync);
var offObs = (typeof Q.observe === "function") ? Q.observe(sync, { debounce: 250 }) : function () {};
window.addEventListener("resize", onResize);
document.addEventListener("keydown", onEsc, true);
// The library cache finishes loading after the panel may already be open; repaint when it lands so an
// open filter fills in instead of sitting on "Loading your library...".
var offProgress = (Q.library && typeof Q.library.onProgress === "function")
  ? Q.library.onProgress(function (p) { if (on && p && p.done) render(); })
  : function () {};
sync();

return function cleanup() {
  if (offRoute) offRoute();
  if (offObs) offObs();
  if (offProgress) offProgress();
  window.removeEventListener("resize", onResize);
  document.removeEventListener("keydown", onEsc, true);
  if (playIv) { clearInterval(playIv); playIv = null; }
  if (panel) { panel.remove(); panel = null; }
  if (chip) { chip.remove(); chip = null; }
  var st = document.getElementById(CSS_ID); if (st) st.remove();
  on = false; rendered = [];
};
