// A handful of small desktop-app annoyances, fixed. These are the ones that come up over and
// over on r/qobuz. Runs as function(Qobuzify).
//   1. double-click a track row to play it, instead of hunting for the tiny hover play arrow
//   2. the library opens on whatever tab you used last (Tracks by default) instead of resetting
//   3. your grid/list view choice sticks - Qobuz forgets it on every visit
//   4. an optional switch (in Qobuzify settings) to hide the Hi-Res badges
var Q = Qobuzify;
var CSS_ID = "qz-ux-css";
var HIDE_ID = "qz-ux-hidehires";
var LIB_CATS = ["all", "playlists", "tracks", "releases", "artists", "labels"];

// --- double-click a row to play ---
function onDblClick(e) {
  var row = e.target.closest && e.target.closest(".ListItem");
  if (!row) return;
  // ignore double-clicks on interactive bits (favorite/more buttons, artist links, the number/play cell)
  if (e.target.closest("a, button, input, [role='button'], .ButtonFavorite, .ListItem__number, .ListItem__actions, .qz-badge")) return;
  var play = row.querySelector(".ListItem__player");
  if (!play) return;
  e.preventDefault();
  ["mousedown", "mouseup", "click"].forEach(function (t) { play.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); });
}

// --- library remembers your last tab (defaults to Tracks) ---
function libRedirect(path) {
  var m = (path || "").match(/^\/user-library\/([a-z]+)/);
  if (m && LIB_CATS.indexOf(m[1]) >= 0) { Q.storage.set("ux:libcat", m[1]); return; }
  if (/^\/user-library\/?$/.test(path || "")) {
    var cat = Q.storage.get("ux:libcat", "tracks");
    if (LIB_CATS.indexOf(cat) < 0) cat = "tracks";
    Q.navigate("/user-library/" + cat);
  }
}

// --- remember grid/list view ---
function viewRadios() { return { grid: document.getElementById("ui-base-radio--grid"), list: document.getElementById("ui-base-radio--list") }; }
function applyViewMode() {
  var r = viewRadios(); if (!r.grid || !r.list) return; // no toggle on this view
  var pref = Q.storage.get("ux:viewmode", "list"); // default to LIST (the common request)
  var want = pref === "grid";
  if (r.grid.checked !== want) { try { (want ? r.grid : r.list).click(); } catch (e) {} }
}
function scheduleViewApply() { [300, 800, 1600].forEach(function (ms) { setTimeout(applyViewMode, ms); }); }
function onViewChange(e) { var t = e.target; if (t && (t.id === "ui-base-radio--grid" || t.id === "ui-base-radio--list")) Q.storage.set("ux:viewmode", t.value); }

// --- hide Hi-Res badges (opt-in) ---
function hideHiresOn() { return Q.storage.get("ux:hidehires", "0") === "1"; }
function applyHideHires() {
  // .ui-block-tag-quality = Qobuz's native quality pill on cards/rows/headers (NOT the player bar,
  // which is .player__settings-quality). Also drop our own hi-res badges for consistency.
  Q.css(HIDE_ID, hideHiresOn() ? ".ui-block-tag-quality,.qz-badge,.qz-fy-badge{display:none !important;}" : "");
}
function injectSettingsToggle() {
  var panel = document.querySelector('.qz-panel[data-panel="settings"]');
  if (!panel || panel.querySelector("#qz-ux-hidehires-row")) return;
  var on = hideHiresOn();
  var row = document.createElement("div");
  row.className = "qz-set-row"; row.id = "qz-ux-hidehires-row";
  row.innerHTML = '<div><div class="qz-set-label">Hide Hi-Res badges</div><div class="qz-set-sub">Remove the Hi-Res quality tags from albums and track lists (the player bar keeps showing quality).</div></div>' +
    '<button class="qz-switch ' + (on ? "qz-switch--on" : "") + '" data-qz-ux="hidehires"><span></span></button>';
  var about = panel.querySelector(".qz-set-about");
  if (about) panel.insertBefore(row, about); else panel.appendChild(row);
  row.querySelector('[data-qz-ux="hidehires"]').addEventListener("click", function () {
    var nowOn = !hideHiresOn(); Q.storage.set("ux:hidehires", nowOn ? "1" : "0");
    this.classList.toggle("qz-switch--on", nowOn); applyHideHires();
  });
}

// --- boot ---
Q.css(CSS_ID, ""); // reserve the id (hide rule lives in HIDE_ID)
document.addEventListener("dblclick", onDblClick, true);
document.addEventListener("change", onViewChange, true);
applyHideHires();
var offRoute = Q.onRoute(function (path) { libRedirect(path); if (/^\/user-library/.test(path || "")) scheduleViewApply(); });
var obs = Q.observe(function () { injectSettingsToggle(); }, { debounce: 350 });
// apply once on load in case we boot straight into a library view
scheduleViewApply();
// if we boot on the bare library root, redirect immediately
try { libRedirect(Q.getState().router.location.pathname); } catch (e) {}

return function cleanup() {
  document.removeEventListener("dblclick", onDblClick, true);
  document.removeEventListener("change", onViewChange, true);
  if (offRoute) offRoute();
  if (obs) obs();
  var r = document.getElementById("qz-ux-hidehires-row"); if (r) r.remove();
  [CSS_ID, HIDE_ID].forEach(function (id) { var s = document.getElementById(id); if (s) s.remove(); });
};
