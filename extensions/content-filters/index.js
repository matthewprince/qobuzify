// Hide the top-nav items you never use, for a leaner Qobuz. Runs as function(Qobuzify){ ... }.
//
// A funnel button in the nav bar opens a little checklist of the nav entries (For You, Discover,
// Magazine, Library, Imports). Whatever you turn off gets hidden with a scoped CSS rule. The
// selectors stay pinned to .NavBar__items / .NavItem on purpose - the brand logo also links to
// /discover, and you don't want hiding "Discover" to blank out the logo along with it. Choices
// stick. Pairs with Simple Client, which handles the editorial rows on the Discover page itself.
var Q = Qobuzify;
var CSS_ID = "qz-cf-css";        // static (button + popover) styles
var HIDE_ID = "qz-cf-hide";      // dynamic hide rules
var PREF = "cfilters:hidden";

var ITEMS = [
  // For You is recommended's injected tab: hide its whole .ui-block-nav-item wrapper (data-qz-nav), not just the
  // <a>, or an empty padded box is left in the nav row. The bare <a> rule stays for any native /foryou link.
  { key: "/foryou", label: "For You", sel: '.NavBar__items [data-qz-nav="foryou"], .NavBar__items a[href="/foryou"]' },
  { key: "/discover", label: "Discover", sel: '.NavBar__items a[href="/discover"]' },
  { key: "/magazine", label: "Magazine", sel: '.NavBar__items a[href="/magazine"]' },
  { key: "/user-library", label: "Library", sel: '.NavBar__items a[href="/user-library"]' },
  { key: "/local/imports", label: "Imports", sel: '.NavItem[href="/local/imports"], .NavBar__rightContainer a[href="/local/imports"]' }
];

function getHidden() {
  var raw = Q.storage.get(PREF, null);
  if (raw == null) return [];
  try { var a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
function setHidden(a) { Q.storage.set(PREF, JSON.stringify(a)); }
function isHidden(k) { return getHidden().indexOf(k) >= 0; }
function toggleKey(k, hide) {
  var a = getHidden(), i = a.indexOf(k);
  if (hide && i < 0) a.push(k);
  if (!hide && i >= 0) a.splice(i, 1);
  setHidden(a); applyHide();
}
function applyHide() {
  var hidden = getHidden();
  var sels = ITEMS.filter(function (it) { return hidden.indexOf(it.key) >= 0; }).map(function (it) { return it.sel; });
  Q.css(HIDE_ID, sels.length ? sels.join(",") + "{display:none !important;}" : "");
}

// --- popover ---
function closePop() { var p = document.querySelector(".qz-cf-pop"); if (p) p.remove(); document.removeEventListener("mousedown", outside, true); }
function outside(e) { var w = document.getElementById("qz-cf-wrap"); if (w && !w.contains(e.target)) closePop(); }
function openPop(wrap) {
  if (wrap.querySelector(".qz-cf-pop")) { closePop(); return; }
  var pop = document.createElement("div");
  pop.className = "qz-cf-pop";
  Q.ui.follow(pop);
  pop.innerHTML = "<h4>Show in nav</h4>";
  ITEMS.forEach(function (it) {
    var row = document.createElement("div");
    var hidden = isHidden(it.key);
    row.className = "qz-cf-row" + (hidden ? "" : " qz-on"); // qz-on = shown (switch ON)
    row.innerHTML = "<span>" + it.label + "</span>";
    var sw = Q.ui.switch({ checked: !hidden, label: "Show " + it.label, onChange: function (nowShown) {
      row.classList.toggle("qz-on", nowShown);
      toggleKey(it.key, !nowShown); // shown => not hidden
    } });
    row.appendChild(sw);
    // the whole row toggles, as before; a click on the switch itself is handled by the switch
    row.addEventListener("click", function (e) {
      e.stopPropagation();
      if (e.target.closest && e.target.closest(".qzu-switch")) return;
      sw.click();
    });
    pop.appendChild(row);
  });
  var foot = document.createElement("div");
  foot.className = "qz-cf-foot";
  foot.innerHTML = "<button type='button' class='qzu-btn' data-act='all'>Show all</button>";
  foot.querySelector("[data-act='all']").addEventListener("click", function (e) { e.stopPropagation(); setHidden([]); applyHide(); closePop(); openPop(wrap); });
  pop.appendChild(foot);
  wrap.appendChild(pop);
  setTimeout(function () { document.addEventListener("mousedown", outside, true); }, 0);
}

var FUNNEL = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 3H2l8 9.46V19l4 2v-8.54z"/></svg>';

Q.css(CSS_ID, [
  "#qz-cf-wrap{position:relative;display:inline-flex;align-items:center;flex:0 0 auto;}",
  "#qz-cf-btn{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;appearance:none;border:0;border-radius:9px;",
  "background:transparent;color:color-mix(in srgb,currentColor 75%,transparent);cursor:pointer;transition:background .15s,color .12s;}",
  "#qz-cf-btn:hover{background:color-mix(in srgb,currentColor 8%,transparent);color:var(--qz-accent,#3DA8FE);}",
  "#qz-cf-btn svg{pointer-events:none;display:block;}",
  // the popover follows Qobuz's appearance (Q.ui.follow), so the kit's tokens apply
  ".qz-cf-pop{position:absolute;top:calc(100% + 10px);right:0;z-index:2147483600;min-width:230px;padding:10px;box-sizing:border-box;",
  "background:var(--qzu-surface);color:var(--qzu-fg);border:1px solid var(--qzu-line);",
  "border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.35);}",
  ".qz-cf-pop h4{margin:4px 6px 9px;font-size:13px;font-weight:600;color:var(--qzu-fg2);}",
  ".qz-cf-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px;border-radius:9px;cursor:pointer;}",
  ".qz-cf-row:hover{background:var(--qzu-fill);}",
  ".qz-cf-row>span{font-size:13px;font-weight:550;}",
  ".qz-cf-row:not(.qz-on)>span{color:var(--qzu-fg2);}",
  ".qz-cf-foot{display:flex;padding:8px 6px 3px;}",
  ".qz-cf-foot .qzu-btn{flex:1;}"
].join(""));

function ensureButton() {
  var host = document.querySelector(".NavBar__rightContainer");
  if (!host || document.getElementById("qz-cf-wrap")) return;
  var wrap = document.createElement("span");
  wrap.id = "qz-cf-wrap";
  var b = document.createElement("button");
  b.id = "qz-cf-btn"; b.title = "Hide nav items"; b.setAttribute("aria-label", "Hide nav items");
  b.innerHTML = FUNNEL;
  b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); openPop(wrap); });
  wrap.appendChild(b);
  host.insertBefore(wrap, host.firstChild);
}

applyHide();
function scan() { try { ensureButton(); applyHide(); } catch (e) {} }
var offObs = Q.observe(scan, { debounce: 250 });
var offRoute = Q.onRoute(function () { closePop(); });
scan();

return function cleanup() {
  if (offObs) offObs();
  if (offRoute) offRoute();
  closePop();
  var w = document.getElementById("qz-cf-wrap"); if (w) w.remove();
  var h = document.getElementById(HIDE_ID); if (h) h.remove();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
