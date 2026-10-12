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
  "background:transparent;color:var(--qz-accent,#3DA8FE);font:inherit;font-size:12px;font-weight:700;",
  "padding:5px 11px;border-radius:20px;cursor:pointer;line-height:1;transition:background .15s,color .15s;}",
  ".qz-lean-btn:hover{background:var(--qz-accent,#3DA8FE);color:#06090a;}",
  ".qz-lean-btn .qz-lean-dot{width:7px;height:7px;border-radius:50%;background:currentColor;}",
  // the popover follows Qobuz's appearance (Q.ui.follow), so the kit's tokens apply
  ".qz-lean-pop{position:absolute;top:calc(100% + 9px);left:0;z-index:99999;min-width:248px;padding:10px;box-sizing:border-box;",
  "background:var(--qzu-surface);color:var(--qzu-fg);border:1px solid var(--qzu-line);",
  "border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.35);}",
  ".qz-lean-pop h4{margin:4px 6px 9px;font-size:13px;font-weight:600;color:var(--qzu-fg2);}",
  ".qz-lean-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 8px;border-radius:9px;cursor:pointer;}",
  ".qz-lean-row:hover{background:var(--qzu-fill);}",
  ".qz-lean-row>span{font-size:13px;font-weight:550;}",
  ".qz-lean-row.qz-on>span{color:var(--qzu-fg2);text-decoration:line-through;}",
  ".qz-lean-foot{display:flex;gap:8px;padding:9px 6px 3px;}",
  ".qz-lean-foot .qzu-btn{flex:1;}"
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
  Q.ui.follow(pop);
  // a switch that is on hides its section (struck through), so the heading says Hide
  pop.innerHTML = "<h4>Hide on Discover</h4>";
  SECTIONS.forEach(function (s) {
    var row = document.createElement("div");
    var hidden = isHidden(s.key);
    row.className = "qz-lean-row" + (hidden ? " qz-on" : "");
    row.innerHTML = "<span>" + s.label + "</span>";
    var sw = Q.ui.switch({ checked: hidden, label: "Hide " + s.label, onChange: function (nowHidden) {
      row.classList.toggle("qz-on", nowHidden);
      toggleKey(s.key, nowHidden);
      applySections();
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
  foot.className = "qz-lean-foot";
  foot.innerHTML = "<button type='button' class='qzu-btn' data-act='all'>Show all</button><button type='button' class='qzu-btn' data-act='lean'>Lean default</button>";
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
