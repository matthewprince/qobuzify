// Strip the Magazine and editorial promo clutter for a lean, library-first Qobuz. Runs as
// function(Qobuzify){ ... return cleanup }.
//
// Two moving parts. The Magazine nav item just gets hidden with CSS while the extension is on. The
// Discover promo carousels get matched by their (fairly stable) heading text and hidden per a set
// you can tune - a "Lean" control injected onto the Discover page lets you check/uncheck each
// section live, and the choice sticks. Out of the box it hides the five pure-editorial rows and
// leaves New Releases and Top albums alone.
var Q = Qobuzify;
var CSS_ID = "qz-simple-css";
var PREF = "simple:hidden";

// Discover sections, keyed and matched by heading text (the headings concatenate
// title + "See all" + blurb, so a loose substring regex is enough and survives
// minor copy tweaks). Order here = order in the Lean control.
var SECTIONS = [
  { key: "newreleases", label: "New Releases", re: /new releases/i },
  { key: "top", label: "Top albums", re: /top albums/i },
  { key: "playlists", label: "Qobuz Playlists", re: /qobuz playlists/i },
  { key: "discography", label: "Essential Discography", re: /essential discography/i },
  { key: "qobuzissime", label: "Qobuzissime", re: /qobuzissime/i },
  { key: "week", label: "Albums of the Week", re: /albums?\s+of\s+the\s+week/i },
  { key: "press", label: "Press Accolades", re: /press\s+(accolades|awards)/i }
];
var DEFAULT_HIDDEN = ["playlists", "discography", "qobuzissime", "week", "press"];
var SECTION_SEL = '[class*="ui-section-cards-slice"],[class*="ui-section-charts-slice"]';

function getHidden() {
  var raw = Q.storage.get(PREF, null);
  if (raw == null) return DEFAULT_HIDDEN.slice();
  try { var a = JSON.parse(raw); return Array.isArray(a) ? a : DEFAULT_HIDDEN.slice(); }
  catch (e) { return DEFAULT_HIDDEN.slice(); }
}
function setHidden(a) { Q.storage.set(PREF, JSON.stringify(a)); }
function isHidden(key) { return getHidden().indexOf(key) >= 0; }
function toggleKey(key, on) {
  var a = getHidden(), i = a.indexOf(key);
  if (on && i < 0) a.push(key);
  if (!on && i >= 0) a.splice(i, 1);
  setHidden(a);
}

Q.css(CSS_ID, [
  // Magazine nav item. The old `a.NavItem[href]` markup is stale now - Qobuz's nav is `.ui-block-nav-item >
  // a.ui-link` inside `.NavBar__items`, and that dead selector was letting Magazine reappear on any nav
  // re-render. Hide the whole nav-item wrapper via :has (clean, no leftover gap), keeping the anchor + the
  // legacy selectors as fallbacks.
  '.NavBar__items .ui-block-nav-item:has(a[href="/magazine"]),.NavBar__items a[href="/magazine"],a.NavItem[href="/magazine"]{display:none !important;}',
  // Lean control
  ".qz-lean-wrap{position:relative;display:inline-flex;margin-left:14px;vertical-align:middle;}",
  ".qz-lean-btn{display:inline-flex;align-items:center;gap:7px;appearance:none;border:1px solid var(--qz-accent,#3DA8FE);",
  "background:transparent;color:var(--qz-accent,#3DA8FE);font:inherit;font-size:12px;font-weight:700;letter-spacing:.3px;",
  "padding:5px 11px;border-radius:20px;cursor:pointer;line-height:1;transition:background .15s,color .15s;}",
  ".qz-lean-btn:hover{background:var(--qz-accent,#3DA8FE);color:#06090a;}",
  ".qz-lean-btn .qz-lean-dot{width:7px;height:7px;border-radius:50%;background:currentColor;}",
  ".qz-lean-pop{position:absolute;top:calc(100% + 9px);left:0;z-index:99999;min-width:248px;padding:10px;",
  "background:linear-gradient(180deg,rgba(22,25,33,.98),rgba(13,15,21,.99));border:1px solid rgba(255,255,255,.12);",
  "border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.6),0 0 40px -22px var(--qz-accent,#3DA8FE);}",
  ".qz-lean-pop h4{margin:4px 6px 9px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#8b94a3;}",
  ".qz-lean-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 8px;border-radius:9px;cursor:pointer;}",
  ".qz-lean-row:hover{background:rgba(255,255,255,.05);}",
  ".qz-lean-row span{font-size:13px;color:#e7ecf3;font-weight:550;}",
  ".qz-lean-row.qz-on span{color:#7e8796;text-decoration:line-through;}",
  ".qz-lean-chk{position:relative;width:38px;height:22px;border-radius:20px;background:rgba(255,255,255,.16);flex:0 0 auto;transition:background .15s;}",
  ".qz-lean-chk i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .16s;}",
  ".qz-lean-row.qz-on .qz-lean-chk{background:var(--qz-accent,#3DA8FE);}",
  ".qz-lean-row.qz-on .qz-lean-chk i{left:19px;}",
  ".qz-lean-foot{display:flex;gap:8px;padding:9px 6px 3px;}",
  ".qz-lean-foot button{flex:1;appearance:none;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);",
  "color:#cbd3df;font:inherit;font-size:12px;font-weight:600;padding:7px;border-radius:8px;cursor:pointer;}",
  ".qz-lean-foot button:hover{background:rgba(255,255,255,.1);color:#fff;}"
].join(""));

function onDiscover() { try { return /^\/discover\b/.test(Q.getState().router.location.pathname || ""); } catch (e) { return false; } }

function sectionMatch(sec) {
  // match against the short section title only (.typo-main-heading-s). the wider
  // module-heading block also carries the descriptive blurb, and its words can
  // collide with another section's pattern (say, a blurb that mentions "new releases").
  var head = sec.querySelector(".typo-main-heading-s");
  var txt = head ? head.textContent : "";
  if (!txt) return null;
  for (var i = 0; i < SECTIONS.length; i++) if (SECTIONS[i].re.test(txt)) return SECTIONS[i];
  return null;
}

// hide/show the editorial carousels per the saved set
function applySections() {
  var secs = document.querySelectorAll(SECTION_SEL);
  for (var i = 0; i < secs.length; i++) {
    var sec = secs[i], m = sectionMatch(sec);
    if (!m) continue;
    sec.setAttribute("data-qz-simple", m.key);
    sec.style.display = isHidden(m.key) ? "none" : "";
  }
}

// --- Lean control (per-section checklist) on the Discover page ---
function closePop() { var p = document.querySelector(".qz-lean-pop"); if (p) p.remove(); document.removeEventListener("mousedown", outside, true); }
function outside(e) { var w = document.querySelector(".qz-lean-wrap"); if (w && !w.contains(e.target)) closePop(); }
function openPop(wrap) {
  if (wrap.querySelector(".qz-lean-pop")) { closePop(); return; }
  var pop = document.createElement("div");
  pop.className = "qz-lean-pop";
  pop.innerHTML = "<h4>Show on Discover</h4>";
  SECTIONS.forEach(function (s) {
    var row = document.createElement("div");
    var hidden = isHidden(s.key);
    row.className = "qz-lean-row" + (hidden ? " qz-on" : "");
    row.innerHTML = "<span>" + s.label + "</span><span class='qz-lean-chk'><i></i></span>";
    row.addEventListener("click", function (e) {
      e.stopPropagation();
      var nowHidden = !row.classList.contains("qz-on");
      row.classList.toggle("qz-on", nowHidden);
      toggleKey(s.key, nowHidden);
      applySections();
    });
    pop.appendChild(row);
  });
  var foot = document.createElement("div");
  foot.className = "qz-lean-foot";
  foot.innerHTML = "<button data-act='all'>Show all</button><button data-act='lean'>Lean default</button>";
  foot.querySelector("[data-act='all']").addEventListener("click", function (e) { e.stopPropagation(); setHidden([]); applySections(); closePop(); openPop(wrap); });
  foot.querySelector("[data-act='lean']").addEventListener("click", function (e) { e.stopPropagation(); setHidden(DEFAULT_HIDDEN.slice()); applySections(); closePop(); openPop(wrap); });
  pop.appendChild(foot);
  wrap.appendChild(pop);
  setTimeout(function () { document.addEventListener("mousedown", outside, true); }, 0);
}

function injectLeanBtn() {
  if (!onDiscover()) return;
  var title = document.querySelector(".ui-section-page-title-001 [class*='ui-block-title'], .ui-section-page-title-001 .typo-main-heading-xl");
  var host = title ? title.parentElement : document.querySelector(".ui-section-page-title-001");
  if (!host || host.querySelector(".qz-lean-wrap")) return;
  var wrap = document.createElement("span");
  wrap.className = "qz-lean-wrap";
  var btn = document.createElement("button");
  btn.className = "qz-lean-btn";
  btn.innerHTML = "<span class='qz-lean-dot'></span>Lean";
  btn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); openPop(wrap); });
  wrap.appendChild(btn);
  host.appendChild(wrap);
}

function scan() { try { applySections(); injectLeanBtn(); } catch (e) {} }

var offObs = Q.observe(scan, { debounce: 180 });
var offRoute = Q.onRoute(function () { closePop(); scan(); });
scan();

return function cleanup() {
  if (offObs) offObs();
  if (offRoute) offRoute();
  closePop();
  var lean = document.querySelectorAll(".qz-lean-wrap"); for (var i = 0; i < lean.length; i++) lean[i].remove();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
  // un-hide any carousels we hid
  var secs = document.querySelectorAll("[data-qz-simple]");
  for (var j = 0; j < secs.length; j++) { secs[j].style.display = ""; secs[j].removeAttribute("data-qz-simple"); }
};
