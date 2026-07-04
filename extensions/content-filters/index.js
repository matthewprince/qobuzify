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
  { key: "/foryou", label: "For You", sel: '.NavBar__items a[href="/foryou"]' },
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
  pop.innerHTML = "<h4>Show in nav</h4>";
  ITEMS.forEach(function (it) {
    var row = document.createElement("div");
    var hidden = isHidden(it.key);
    row.className = "qz-cf-row" + (hidden ? "" : " qz-on"); // qz-on = shown (toggle ON)
    row.innerHTML = "<span>" + it.label + "</span><span class='qz-cf-chk'><i></i></span>";
    row.addEventListener("click", function (e) {
      e.stopPropagation();
      var nowShown = !row.classList.contains("qz-on");
      row.classList.toggle("qz-on", nowShown);
      toggleKey(it.key, !nowShown); // shown => not hidden
    });
    pop.appendChild(row);
  });
  var foot = document.createElement("div");
  foot.className = "qz-cf-foot";
  foot.innerHTML = "<button data-act='all'>Show all</button>";
  foot.querySelector("[data-act='all']").addEventListener("click", function (e) { e.stopPropagation(); setHidden([]); applyHide(); closePop(); openPop(wrap); });
  pop.appendChild(foot);
  wrap.appendChild(pop);
  setTimeout(function () { document.addEventListener("mousedown", outside, true); }, 0);
}

var FUNNEL = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 3H2l8 9.46V19l4 2v-8.54z"/></svg>';

Q.css(CSS_ID, [
  "#qz-cf-wrap{position:relative;display:inline-flex;align-items:center;flex:0 0 auto;}",
  "#qz-cf-btn{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;appearance:none;border:0;border-radius:9px;",
  "background:transparent;color:#aeb6c2;cursor:pointer;transition:background .15s,color .12s;}",
  "#qz-cf-btn:hover{background:rgba(255,255,255,.08);color:var(--qz-accent,#3DA8FE);}",
  "#qz-cf-btn svg{pointer-events:none;display:block;}",
  ".qz-cf-pop{position:absolute;top:calc(100% + 10px);right:0;z-index:2147483600;min-width:230px;padding:10px;",
  "background:linear-gradient(180deg,rgba(22,25,33,.98),rgba(13,15,21,.99));border:1px solid rgba(255,255,255,.12);",
  "border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.6),0 0 40px -22px var(--qz-accent,#3DA8FE);}",
  ".qz-cf-pop h4{margin:4px 6px 9px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#8b94a3;}",
  ".qz-cf-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px;border-radius:9px;cursor:pointer;}",
  ".qz-cf-row:hover{background:rgba(255,255,255,.05);}",
  ".qz-cf-row span:first-child{font-size:13px;color:#e7ecf3;font-weight:550;}",
  ".qz-cf-row:not(.qz-on) span:first-child{color:#7e8796;}",
  ".qz-cf-chk{position:relative;width:38px;height:22px;border-radius:20px;background:rgba(255,255,255,.16);flex:0 0 auto;transition:background .15s;}",
  ".qz-cf-chk i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .16s;}",
  ".qz-cf-row.qz-on .qz-cf-chk{background:var(--qz-accent,#3DA8FE);}",
  ".qz-cf-row.qz-on .qz-cf-chk i{left:19px;}",
  ".qz-cf-foot{display:flex;padding:8px 6px 3px;}",
  ".qz-cf-foot button{flex:1;appearance:none;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#cbd3df;",
  "font:inherit;font-size:12px;font-weight:600;padding:7px;border-radius:8px;cursor:pointer;}",
  ".qz-cf-foot button:hover{background:rgba(255,255,255,.1);color:#fff;}"
].join(""));

function ensureButton() {
  var host = document.querySelector(".NavBar__rightContainer");
  if (!host || document.getElementById("qz-cf-wrap")) return;
  var wrap = document.createElement("span");
  wrap.id = "qz-cf-wrap";
  var b = document.createElement("button");
  b.id = "qz-cf-btn"; b.title = "Hide nav items";
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
