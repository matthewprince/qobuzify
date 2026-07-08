// The Qobuzify runtime - injected into Qobuz's app.html as an inline <script>. This is the in-app
// layer, Spicetify-style: a live theme engine plus a Qobuzify menu entry and a Marketplace, both
// reachable from the account dropdown.
//
// It reads its payload from window.__QOBUZIFY__ = { catalog, def, version }, which the CLI templates
// in just above this script. Theme switching happens live by swapping a single
// <style id="qobuzify-live"> - no relaunch - and the choice is persisted to localStorage so it
// survives restarts.
(function () {
  if (window.__QOBUZIFY_RUNTIME__) return; // guard against a double inject
  window.__QOBUZIFY_RUNTIME__ = true;

  var DATA = window.__QOBUZIFY__ || { catalog: [], def: null, version: "0.1" };
  var CATALOG = DATA.catalog || [];
  var VERSION = DATA.version || "0.1";
  var LS_THEME = "qobuzify:theme";
  var LS_ENABLED = "qobuzify:enabled";
  var DEFAULT_ACCENT = "#3DA8FE";

  // --- theme engine ---
  function bySlug(slug) { for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i].slug === slug) return CATALOG[i]; return null; }
  function isEnabled() { return localStorage.getItem(LS_ENABLED) !== "0"; }
  function activeSlug() {
    if (!isEnabled()) return null;
    return localStorage.getItem(LS_THEME) || DATA.def || (CATALOG[0] && CATALOG[0].slug) || null;
  }
  function buildCss(t) {
    if (!t) return "";
    var root = "";
    if (t.tokens) {
      var body = "";
      for (var k in t.tokens) if (t.tokens.hasOwnProperty(k)) body += "  " + k + ": " + t.tokens[k] + " !important;\n";
      if (body) root = ":root {\n" + body + "}\n\n";
    }
    return root + (t.css || "");
  }
  function liveStyle() {
    var el = document.getElementById("qobuzify-live");
    if (!el) { el = document.createElement("style"); el.id = "qobuzify-live"; (document.head || document.documentElement).appendChild(el); }
    return el;
  }
  function accentOf(t) { return (t && t.preview && t.preview.accent) || DEFAULT_ACCENT; }
  function setUiAccent(hex) { document.documentElement.style.setProperty("--qz-accent", hex); }

  function applyTheme(slug, persist) {
    var t = bySlug(slug);
    liveStyle().textContent = buildCss(t);
    if (persist !== false && slug) { localStorage.setItem(LS_THEME, slug); localStorage.setItem(LS_ENABLED, "1"); }
    setUiAccent(accentOf(t));
    refreshCards();
    refreshSettings();
    return t;
  }
  function disableTheming() { liveStyle().textContent = ""; localStorage.setItem(LS_ENABLED, "0"); setUiAccent(DEFAULT_ACCENT); refreshCards(); refreshSettings(); }
  function enableTheming() { applyTheme(localStorage.getItem(LS_THEME) || DATA.def || (CATALOG[0] && CATALOG[0].slug)); }

  // --- account-menu items ---
  var MENU_ITEMS = [
    { key: "marketplace", label: "Marketplace", icon: "icon-view-grid-filled", open: openMarketplace },
    { key: "qobuzify", label: "Qobuzify", icon: "icon-magic-stars", open: openSettings }
  ];
  function closeNativeMenu() {
    // nudge the native dropdown shut via an outside-click; avoid dispatching
    // Escape (our own Esc handler would close the overlay we're about to open)
    try { document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); } catch (e) {}
  }
  function makeMenuItem(spec) {
    var item = document.createElement("div");
    item.className = "MenuItem NavBarMenu__item qz-menuitem";
    item.setAttribute("data-qz", spec.key);
    var text = document.createElement("div");
    text.className = "MenuItem__text " + spec.icon;
    text.textContent = spec.label;
    item.appendChild(text);
    item.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      closeNativeMenu();
      spec.open();
    });
    return item;
  }
  function injectMenu() {
    var list = document.querySelector(".NavBarMenu__items");
    if (!list || list.querySelector('[data-qz="qobuzify"]')) return;
    var rows = list.querySelectorAll(".NavBarMenu__item");
    var logout = null;
    for (var i = 0; i < rows.length; i++) if (/log\s?out|sign\s?out/i.test(rows[i].textContent || "")) { logout = rows[i]; break; }
    for (var j = 0; j < MENU_ITEMS.length; j++) {
      var node = makeMenuItem(MENU_ITEMS[j]);
      if (logout) list.insertBefore(node, logout); else list.appendChild(node);
    }
  }

  // --- overlay shell ---
  var overlay = null, currentTab = "themes";
  function buildOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "qz-overlay";
    overlay.style.display = "none";
    overlay.innerHTML =
      '<div class="qz-modal" role="dialog" aria-modal="true">' +
        '<div class="qz-head">' +
          '<div class="qz-brand"><span class="icon-magic-stars qz-brand-ico"></span><span class="qz-brand-name">Qobuzify</span><span class="qz-ver"></span></div>' +
          '<div class="qz-tabs">' +
            '<button class="qz-tab" data-tab="themes">Themes</button>' +
            '<button class="qz-tab" data-tab="extensions">Extensions</button>' +
          '</div>' +
          '<button class="qz-close" aria-label="Close">&#215;</button>' +
        '</div>' +
        '<div class="qz-body">' +
          '<div class="qz-panel" data-panel="themes"><div class="qz-grid"></div></div>' +
          '<div class="qz-panel" data-panel="extensions"></div>' +
          '<div class="qz-panel" data-panel="settings"></div>' +
        '</div>' +
        '<div class="qz-foot"><span class="qz-foot-l"></span><span class="qz-foot-r">made by matthewprince</span></div>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.querySelector(".qz-ver").textContent = "v" + VERSION;
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) hideOverlay(); });
    overlay.querySelector(".qz-close").addEventListener("click", hideOverlay);
    var tabs = overlay.querySelectorAll(".qz-tab");
    for (var i = 0; i < tabs.length; i++) tabs[i].addEventListener("click", function () { selectTab(this.getAttribute("data-tab")); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && overlay && overlay.style.display !== "none") hideOverlay(); });

    renderThemes();
    renderExtensions();
    renderSettings();
    return overlay;
  }
  function showOverlay() { buildOverlay(); overlay.style.display = "flex"; requestAnimationFrame(function () { overlay.classList.add("qz-show"); }); }
  function hideOverlay() { if (!overlay) return; overlay.classList.remove("qz-show"); setTimeout(function () { if (overlay && !overlay.classList.contains("qz-show")) overlay.style.display = "none"; }, 180); }
  function selectTab(tab) {
    currentTab = tab;
    var foot = overlay.querySelector(".qz-foot-l");
    if (foot) foot.textContent = tab === "extensions" ? "Extensions" : (CATALOG.length + " themes");
    var tabs = overlay.querySelectorAll(".qz-tab");
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle("qz-tab--active", tabs[i].getAttribute("data-tab") === tab);
    var panels = overlay.querySelectorAll(".qz-panel");
    for (var j = 0; j < panels.length; j++) panels[j].style.display = panels[j].getAttribute("data-panel") === tab ? "block" : "none";
  }
  function openMarketplace() { showOverlay(); selectTab("themes"); }
  function openSettings() { showOverlay(); renderSettings(); selectTab("settings"); }

  // --- themes panel ---
  function swatch(p) {
    p = p || {}; var bg = p.bg || "#101010", surf = p.surface || "#181818", acc = p.accent || DEFAULT_ACCENT, tx = p.text || "#eee";
    return '<div class="qz-prev" style="background:' + bg + '">' +
      '<div class="qz-prev-bar" style="background:' + surf + '"></div>' +
      '<div class="qz-prev-row"><span class="qz-prev-play" style="background:' + acc + '"></span>' +
        '<span class="qz-prev-lines"><i style="background:' + tx + '"></i><i style="background:' + tx + ';opacity:.45;width:60%"></i></span>' +
        '<span class="qz-prev-heart" style="color:' + acc + '">&#9829;</span></div>' +
      '<div class="qz-prev-chip" style="background:' + surf + ';border:1px solid ' + acc + '55"></div>' +
    '</div>';
  }
  function renderThemes() {
    var grid = overlay.querySelector('[data-panel="themes"] .qz-grid');
    grid.innerHTML = "";
    var act = activeSlug();
    CATALOG.forEach(function (t) {
      var card = document.createElement("div");
      card.className = "qz-card" + (t.slug === act ? " qz-card--active" : "");
      card.setAttribute("data-slug", t.slug);
      card.innerHTML = swatch(t.preview) +
        '<div class="qz-card-body">' +
          '<div class="qz-card-top"><span class="qz-card-name">' + esc(t.name || t.slug) + '</span>' +
            '<span class="qz-dot" style="background:' + accentOf(t) + '"></span></div>' +
          '<div class="qz-card-desc">' + esc(t.description || "") + '</div>' +
          '<button class="qz-apply">' + (t.slug === act ? "Applied" : "Apply") + '</button>' +
        '</div>';
      card.querySelector(".qz-apply").addEventListener("click", function () { applyTheme(t.slug); });
      grid.appendChild(card);
    });
  }
  function refreshCards() {
    if (!overlay) return;
    var act = activeSlug();
    var cards = overlay.querySelectorAll(".qz-card");
    for (var i = 0; i < cards.length; i++) {
      var on = cards[i].getAttribute("data-slug") === act;
      cards[i].classList.toggle("qz-card--active", on);
      var btn = cards[i].querySelector(".qz-apply");
      if (btn) btn.textContent = on ? "Applied" : "Apply";
    }
  }

  // --- extensions panel (real, toggleable) ---
  function renderExtensions() {
    var panel = overlay.querySelector('[data-panel="extensions"]');
    var exts = DATA.extensions || [];
    if (!exts.length) {
      panel.innerHTML = '<div class="qz-soon-head"><span class="icon-magic-stars qz-soon-ico"></span>' +
        '<div><div class="qz-soon-title">No extensions yet</div>' +
        '<div class="qz-soon-sub">Extensions ship with Qobuzify and appear here to toggle on and off.</div></div></div>';
      return;
    }
    panel.innerHTML = '<div class="qz-grid">' + exts.map(function (e) {
      var on = extEnabled(e.id);
      return '<div class="qz-card qz-ext" data-ext="' + e.id + '"><div class="qz-card-body">' +
        '<div class="qz-card-top"><span class="qz-card-name"><span class="' + (e.icon || "icon-magic-stars") + ' qz-ext-ico"></span>' + esc(e.name) + '</span>' +
          '<button class="qz-switch ' + (on ? "qz-switch--on" : "") + '" data-ext-toggle="' + e.id + '"><span></span></button></div>' +
        '<div class="qz-card-desc">' + esc(e.description || "") + '</div>' +
        (e.version ? '<div class="qz-ext-meta">v' + esc(e.version) + (e.author ? " &middot; " + esc(e.author) : "") + '</div>' : "") +
      '</div></div>';
    }).join("") + '</div>';
    panel.querySelectorAll("[data-ext-toggle]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-ext-toggle");
        if (extEnabled(id)) { localStorage.setItem("qobuzify:ext:" + id, "0"); unloadExtension(id); }
        else { localStorage.setItem("qobuzify:ext:" + id, "1"); var ext = (DATA.extensions || []).filter(function (x) { return x.id === id; })[0]; if (ext) loadExtension(ext); }
        btn.classList.toggle("qz-switch--on");
      });
    });
  }

  // --- settings panel (the "Qobuzify" entry) ---
  function renderSettings() {
    if (!overlay) return;
    var panel = overlay.querySelector('[data-panel="settings"]');
    var on = isEnabled();
    var act = bySlug(activeSlug());
    var hasRpc = (DATA.extensions || []).some(function (x) { return x.id === "discord-rpc"; });
    var rpcOn = extEnabled("discord-rpc");
    panel.innerHTML =
      (updateInfo ?
      '<div class="qz-set-row qz-set-update">' +
        '<div><div class="qz-set-label">Update available</div><div class="qz-set-sub">v' + esc(updateInfo.latest) + ' is out. You have v' + esc(VERSION) + '.</div></div>' +
        '<button class="qz-btn qz-btn--accent" data-act="update">Update</button>' +
      '</div>' : "") +
      '<div class="qz-set-row">' +
        '<div><div class="qz-set-label">Theming</div><div class="qz-set-sub">Apply Qobuzify themes to the Qobuz UI.</div></div>' +
        '<button class="qz-switch ' + (on ? "qz-switch--on" : "") + '" data-act="toggle"><span></span></button>' +
      '</div>' +
      (hasRpc ?
      '<div class="qz-set-row">' +
        '<div><div class="qz-set-label">Discord Rich Presence</div><div class="qz-set-sub">Show the track you&#39;re playing on your Discord profile.</div></div>' +
        '<button class="qz-switch ' + (rpcOn ? "qz-switch--on" : "") + '" data-act="rpc"><span></span></button>' +
      '</div>' : "") +
      '<div class="qz-set-row">' +
        '<div><div class="qz-set-label">Active theme</div><div class="qz-set-sub">' + (on && act ? esc(act.name) : "None") + '</div></div>' +
        '<button class="qz-btn" data-act="browse">Browse themes</button>' +
      '</div>' +
      '<div class="qz-set-row">' +
        '<div><div class="qz-set-label">Restore Qobuz</div><div class="qz-set-sub">Turn theming off and use the stock look.</div></div>' +
        '<button class="qz-btn qz-btn--ghost" data-act="off">Restore default</button>' +
      '</div>' +
      '<div class="qz-set-about">Qobuzify v' + VERSION + ' - themes &amp; extensions for the Qobuz desktop app.</div>' +
      '<div class="qz-set-links">' +
        '<a data-act="report">Report a bug</a><span>&middot;</span>' +
        '<a data-act="submit">Submit a theme or extension</a><span>&middot;</span>' +
        '<a data-act="security">Security issue</a>' +
      '</div>';
    var upBtn = panel.querySelector('[data-act="update"]'); if (upBtn) upBtn.addEventListener("click", doUpdate);
    panel.querySelector('[data-act="report"]').addEventListener("click", function () { openExternal(feedbackUrl("issues")); });
    panel.querySelector('[data-act="submit"]').addEventListener("click", function () { openExternal(feedbackUrl("submit")); });
    panel.querySelector('[data-act="security"]').addEventListener("click", function () { openExternal("https://qobuzify.app/security"); });
    panel.querySelector('[data-act="toggle"]').addEventListener("click", function () { if (isEnabled()) disableTheming(); else enableTheming(); });
    panel.querySelector('[data-act="browse"]').addEventListener("click", function () { selectTab("themes"); });
    panel.querySelector('[data-act="off"]').addEventListener("click", function () { disableTheming(); });
    var rpcBtn = panel.querySelector('[data-act="rpc"]');
    if (rpcBtn) rpcBtn.addEventListener("click", function () {
      // Discord RPC on/off = enable/disable the discord-rpc extension (same key as the Marketplace).
      // unloadExtension() runs the extension's cleanup, which clears the presence + stops posting.
      if (extEnabled("discord-rpc")) { localStorage.setItem("qobuzify:ext:discord-rpc", "0"); unloadExtension("discord-rpc"); }
      else { localStorage.setItem("qobuzify:ext:discord-rpc", "1"); var ex = (DATA.extensions || []).filter(function (x) { return x.id === "discord-rpc"; })[0]; if (ex) loadExtension(ex); }
      this.classList.toggle("qz-switch--on");
    });
  }
  function refreshSettings() { if (overlay && currentTab === "settings") renderSettings(); }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // --- update check + feedback ---
  var API_BASE = "https://api.qobuzify.app";
  var INSTALL_CMD = "irm https://qobuzify.app/install.ps1 | iex";
  var updateInfo = null; // the release payload once we've seen a newer version is out

  // numeric-part semver compare: is a strictly newer than b? ("0.2.0" > "0.1.9")
  function verNewer(a, b) {
    var pa = String(a || "0").split("."), pb = String(b || "0").split(".");
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var da = parseInt(pa[i], 10) || 0, db = parseInt(pb[i], 10) || 0;
      if (da !== db) return da > db;
    }
    return false;
  }
  function checkForUpdate() {
    try {
      fetch(API_BASE + "/v1/version", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.latest || !verNewer(j.latest, VERSION)) return;
          updateInfo = j;
          refreshSettings(); // surface it in the Qobuzify settings panel too
          if (localStorage.getItem("qobuzify:update-seen") !== j.latest) showUpdateToast(j);
        })
        .catch(function () {});
    } catch (e) {}
  }

  // open a URL in the user's real browser (window.open works in the Qobuz Electron shell; the <a>
  // click is a fallback if the popup is blocked)
  function openExternal(url) {
    try { if (window.open(url, "_blank", "noopener")) return; } catch (e) {}
    try { var a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove(); } catch (e) {}
  }
  function copyText(s) { try { if (navigator.clipboard) navigator.clipboard.writeText(s); } catch (e) {} }
  function enabledExtIds() { return (DATA.extensions || []).filter(function (e) { return extEnabled(e.id); }).map(function (e) { return e.id; }); }
  // prefill a feedback form's diagnostics via the querystring (no personal data: version, platform,
  // active theme, enabled extensions)
  function feedbackUrl(page) {
    return "https://qobuzify.app/" + page +
      "?v=" + encodeURIComponent(VERSION) +
      "&ua=" + encodeURIComponent(navigator.userAgent) +
      "&theme=" + encodeURIComponent(activeSlug() || "off") +
      "&exts=" + encodeURIComponent(enabledExtIds().join(","));
  }
  // the reliable, universal update: re-run the web installer (now non-destructive - it keeps the
  // user's theme and local creds). copy it to the clipboard and open the site where it's the headline.
  function doUpdate() { copyText(INSTALL_CMD); openExternal("https://qobuzify.app/"); }

  var updateToast = null;
  function showUpdateToast(j) {
    if (updateToast) return;
    injectUiStyle();
    var notes = (j.notes || []).slice(0, 4).map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("");
    updateToast = document.createElement("div");
    updateToast.className = "qz-toast";
    updateToast.innerHTML =
      '<div class="qz-toast-head"><span class="icon-magic-stars qz-toast-ico"></span>' +
        '<div class="qz-toast-title">Update available</div>' +
        '<button class="qz-toast-x" aria-label="Dismiss">&#215;</button></div>' +
      '<div class="qz-toast-sub">Qobuzify <b>v' + esc(j.latest) + '</b> is out. You have v' + esc(VERSION) + '.</div>' +
      (notes ? '<ul class="qz-toast-notes">' + notes + '</ul>' : "") +
      '<div class="qz-toast-actions"><button class="qz-toast-go">Update</button>' +
        '<button class="qz-toast-later">Later</button></div>';
    document.body.appendChild(updateToast);
    requestAnimationFrame(function () { if (updateToast) updateToast.classList.add("qz-toast--in"); });
    function dismiss() {
      localStorage.setItem("qobuzify:update-seen", j.latest);
      if (!updateToast) return;
      var t = updateToast; updateToast = null;
      t.classList.remove("qz-toast--in");
      setTimeout(function () { t.remove(); }, 220);
    }
    updateToast.querySelector(".qz-toast-x").addEventListener("click", dismiss);
    updateToast.querySelector(".qz-toast-later").addEventListener("click", dismiss);
    updateToast.querySelector(".qz-toast-go").addEventListener("click", function () { doUpdate(); dismiss(); });
  }

  // --- overlay styling (accent-tinted by the active theme) ---
  function injectUiStyle() {
    if (document.getElementById("qobuzify-ui")) return;
    var s = document.createElement("style");
    s.id = "qobuzify-ui";
    s.textContent = QZ_CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  // --- extension layer ---
  // X-App-Id must match the client the session token was issued for: the desktop app and the web
  // player (play.qobuz.com, used by the Linux/Mac wrapper) have different public app ids, and a
  // mismatched pair 401s. Pick by host so Q.api works in both.
  var APP_ID = (location.host.indexOf("play.qobuz.com") >= 0) ? "798273057" : "304027809";
  var QZ_STORE = null;             // the app's Redux store (found via React fiber)
  var routeCbs = [], lastPath = null;
  var extCleanups = {};            // ext id -> cleanup fn
  var navItems = [];               // sidebar nav items added by extensions
  var playerSlots = { left: [], right: [] }; // player-bar buttons added by extensions (see Q.playerSlot)

  // Walk the React fiber tree from #root to find the Redux store. Qobuz ships a
  // legacy ReactDOM.render build: the fiber root is _reactRootContainer._internalRoot
  // .current, and the DOM key is __reactContainere$<id> (note the extra "e"), so we
  // try several entry points rather than one exact key.
  function findStore() {
    try {
      var root = document.getElementById("root");
      if (!root) return null;
      var fibers = [];
      if (root._reactRootContainer && root._reactRootContainer._internalRoot) fibers.push(root._reactRootContainer._internalRoot.current);
      Object.keys(root).forEach(function (k) { if (/^__react(Container|Fiber|InternalInstance)/.test(k)) fibers.push(root[k]); });
      for (var r = 0; r < fibers.length; r++) {
        var seen = new Set(), stack = [fibers[r]], n = 0;
        while (stack.length && n < 80000) {
          n++; var f = stack.pop(); if (!f || seen.has(f)) continue; seen.add(f);
          var mp = f.memoizedProps;
          if (mp) { for (var i = 0; i < 2; i++) { var v = i === 0 ? mp.store : mp.value; if (v && typeof v.getState === "function" && typeof v.subscribe === "function") return v; } }
          if (f.child) stack.push(f.child); if (f.sibling) stack.push(f.sibling);
        }
      }
    } catch (e) {}
    return null;
  }

  function makeNavItem(spec) {
    var a = document.createElement("a");
    a.className = "NavItem qz-navitem " + (spec.icon || "icon-magic-stars");
    a.setAttribute("data-qz-nav", spec.id);
    a.textContent = spec.label;
    a.style.cursor = "pointer";
    a.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); if (spec.onClick) spec.onClick(); });
    return a;
  }
  function injectNavItems() {
    if (!navItems.length) return;
    var anchor = document.querySelector(".NavItem:not(.qz-navitem)");
    if (!anchor || !anchor.parentElement) return;
    var container = anchor.parentElement;
    navItems.forEach(function (n) {
      if (container.querySelector('[data-qz-nav="' + n.spec.id + '"]')) return;
      container.appendChild(makeNavItem(n.spec));
    });
  }

  // Shared player-bar button slots. Two zones: "left" is a flex group parked at the right edge of
  // the track column (just left of the transport, in the open space), "right" is a flex group at the
  // start of the settings cluster. Both keep consistent gap spacing so any number of extensions'
  // buttons auto-arrange. Boot's observer keeps them alive across React re-renders, and the buttons
  // are held by reference, so re-appending just re-parents the same node.
  function slotContainer(zone) {
    if (zone === "left") {
      var track = document.querySelector(".player__track"); if (!track) return null;
      var cl = track.querySelector(":scope > .qz-slot-left");
      if (!cl) { cl = document.createElement("div"); cl.className = "qz-slot-left"; }
      // anchor right after the info/heart buttons (a stable node). anchoring to the time display instead
      // would re-insert us every second (React swaps that node), detaching the buttons and flashing :hover.
      var btns = track.querySelector(":scope > .player__track-buttons");
      var anchor = btns ? btns.nextSibling : track.querySelector(":scope > .player__track-time");
      if (cl.parentElement !== track || (btns && cl.previousElementSibling !== btns)) track.insertBefore(cl, anchor);
      return cl;
    }
    var settings = document.querySelector(".player__settings"); if (!settings) return null;
    var cr = settings.querySelector(":scope > .qz-slot-right");
    if (!cr) { cr = document.createElement("div"); cr.className = "qz-slot-right"; settings.insertBefore(cr, settings.firstChild); }
    return cr;
  }
  function injectPlayerSlots() {
    ["left", "right"].forEach(function (zone) {
      if (!playerSlots[zone].length) return;
      var c = slotContainer(zone); if (!c) return;
      playerSlots[zone].sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      var prev = null;
      playerSlots[zone].forEach(function (s) {
        if (s.el.getAttribute("data-qz-slot") !== s.id) s.el.setAttribute("data-qz-slot", s.id);
        // Only (re)insert when actually out of place. Re-appending an in-place, hovered node detaches +
        // reattaches it and resets :hover -> a blue/white flash. This runs on every player re-render.
        if (s.el.parentNode !== c || s.el.previousElementSibling !== prev) c.insertBefore(s.el, prev ? prev.nextSibling : c.firstChild);
        prev = s.el;
      });
    });
    fitPlayerSlots();
  }

  // Player-bar overflow guard. Qobuz centres the transport controls over the bar independently of the
  // left/right flow sections (hiding a slot doesn't move them), so on a narrow or portrait window our
  // injected slot buttons - which sit at the inner edge of those sections - end up on top of the play /
  // next controls and cover them, so they can't be clicked (reported on a portrait monitor). The left
  // zone's width depends on which extensions are on, so a fixed CSS breakpoint can't judge it. Measure
  // instead: show a zone, read whether it reaches the transport, hide it if so. The show and the hide
  // happen in one synchronous pass with no paint in between, so there's no flicker.
  function fitPlayerSlots() {
    var prev = document.querySelector(".pct-player-prev");
    var next = document.querySelector(".pct-player-next");
    if (!prev && !next) return;
    var GAP = 10;
    var pr = prev && prev.getBoundingClientRect();
    var nr = next && next.getBoundingClientRect();
    // The transport is centred over the whole bar, so on a narrow window our side-zone buttons - which sit at
    // the INNER edge of each flow section - grow into it and cover the play/next controls (they render on top,
    // so the transport becomes unclickable). The old guard hid the ENTIRE zone the moment any part overlapped,
    // which wiped every button on any sub-~1740px window (the reported "Lyrics + Full App Display missing"
    // bug). Instead: reveal everything, then hide buttons one at a time from the inner edge until the group no
    // longer reaches the transport - so the outer buttons stay usable and only what genuinely can't fit drops.
    var right = document.querySelector(".player__settings > .qz-slot-right");
    if (right && nr) {
      right.style.display = "";
      var rb = [].slice.call(right.children);
      rb.forEach(function (b) { b.style.display = ""; });
      // zone is row-reverse, so the LAST DOM child is the visually-innermost (leftmost) button; drop from
      // there back toward the outer edge, so the highest-order / least-important buttons go first.
      for (var i = rb.length - 1; i >= 0; i--) {
        var rr = right.getBoundingClientRect();
        if (!rr.width || rr.left >= nr.right + GAP) break;
        rb[i].style.display = "none";
      }
    }
    var left = document.querySelector(".player__track > .qz-slot-left");
    if (left && pr) {
      left.style.display = "";
      var lb = [].slice.call(left.children);
      lb.forEach(function (b) { b.style.display = ""; });
      for (var j = lb.length - 1; j >= 0; j--) { // innermost = rightmost, closest to the transport
        var lr = left.getBoundingClientRect();
        if (!lr.width || lr.right <= pr.left - GAP) break;
        lb[j].style.display = "none";
      }
    }
  }

  function buildApi() {
    var Q = {
      version: VERSION,
      spotify: DATA.spotify || null, // {client_id, client_secret} for the ISRC->Spotify bridge (local only)
      spotifyToken: DATA.spotifyToken || null, // {access_token, expires_at, refresh_token?} for SL's real lyrics sources
      apple: DATA.apple || null, // {developer_token, media_user_token, storefront} for Apple Music TTML (local only)
      store: QZ_STORE,
      getState: function () { return QZ_STORE.getState(); },
      subscribe: function (fn) { return QZ_STORE.subscribe(fn); },
      accent: function () { return (document.documentElement.style.getPropertyValue("--qz-accent") || DEFAULT_ACCENT).trim(); },
      css: function (id, text) { var e = document.getElementById(id); if (!e) { e = document.createElement("style"); e.id = id; (document.head || document.documentElement).appendChild(e); } e.textContent = text; return e; },
      el: function (html) { var t = document.createElement("template"); t.innerHTML = (html || "").trim(); return t.content.firstElementChild; },
      storage: {
        get: function (k, d) { var v = localStorage.getItem("qobuzify:x:" + k); return v == null ? d : v; },
        set: function (k, v) { localStorage.setItem("qobuzify:x:" + k, v); }
      },
      // Qobuz API with the in-app token (read endpoints: album/get, getFeatured, search...)
      api: function (methodPath) {
        var token = QZ_STORE.getState().user.token;
        return fetch("https://www.qobuz.com/api.json/0.2/" + methodPath, { headers: { "X-App-Id": APP_ID, "X-User-Auth-Token": token } })
          .then(function (r) { if (!r.ok) throw new Error("qobuz api " + methodPath + " -> " + r.status); return r.json(); });
      },
      player: {
        isPlaying: function () { try { return QZ_STORE.getState().player.playingState === "play"; } catch (e) { return false; } },
        getPositionMs: function () {
          try {
            var p = QZ_STORE.getState().player, pos = p.position || {}, base = pos.value || 0;
            if (p.playingState === "play" && pos.timestamp) base += Date.now() - pos.timestamp;
            var dur = (p.currentTrack && p.currentTrack.duration) || 0;
            return dur ? Math.max(0, Math.min(base, dur)) : Math.max(0, base);
          } catch (e) { return 0; }
        },
        getTrack: function () {
          try {
            var p = QZ_STORE.getState().player, ct = p.currentTrack || {};
            var bar = document.querySelector(".player");
            var titleEl = bar && bar.querySelector(".player__track-overflow, [class*='track-overflow']");
            // artist + album live on the .player__track-album line. scope to it, or we'd grab the title's
            // own /album/ link (the track name links to the album too) and pick up the " - " separator.
            var meta = (bar && bar.querySelector(".player__track-album")) || bar;
            var artistEls = meta ? meta.querySelectorAll('a[href*="/artist/"]') : [];
            var albumEl = (meta && meta.querySelector('a[href*="/album/"]')) || (bar && bar.querySelector('a[href*="/album/"]'));
            var img = bar && bar.querySelector("img");
            function cleanName(s) { return String(s == null ? "" : s).replace(/^\s*[-–—·]\s+/, "").replace(/\s+[-–—·]\s*$/, "").trim(); }
            var artists = []; for (var i = 0; i < artistEls.length; i++) { var a = cleanName(artistEls[i].textContent); if (a && artists.indexOf(a) < 0) artists.push(a); }
            var albumId = albumEl ? ((albumEl.getAttribute("href") || "").match(/\/album\/([^/?]+)/) || [])[1] : null;
            return {
              id: ct.id || null, title: titleEl ? titleEl.textContent.trim() : "",
              artists: artists, artist: artists[0] || "", album: albumEl ? albumEl.textContent.trim() : "",
              albumId: albumId, durationMs: ct.duration || 0, cover: img ? img.src : "", quality: p.quality || null
            };
          } catch (e) { return null; }
        },
        onChange: function (fn) {
          var lastId = null;
          try { lastId = QZ_STORE.getState().player.currentTrack && QZ_STORE.getState().player.currentTrack.id; } catch (e) {}
          return QZ_STORE.subscribe(function () {
            try { var ct = QZ_STORE.getState().player.currentTrack; var id = ct && ct.id; if (id !== lastId) { lastId = id; fn(Q.player.getTrack()); } } catch (e) {}
          });
        },
        // Remove UPCOMING play-queue items whose trackId matches pred - so a filtered track is skipped
        // BEFORE it becomes current (never plays at all), rather than being skipped after it starts. Mirrors
        // the app's own remove-from-queue: recompute the item list and dispatch playqueue/set (a partial
        // state merge - it only touches the keys we pass). Only ever drops items AFTER currentIndex, so the
        // playing track and the index are never disturbed. Returns how many items were removed.
        dropUpcoming: function (pred) {
          try {
            var pq = QZ_STORE.getState().playqueue; if (!pq || typeof pred !== "function") return 0;
            var ci = pq.currentIndex || 0, removed = 0;
            var keep = function (arr) { return arr.filter(function (it, i) { if (i <= ci) return true; var drop = !!(it && it.trackId != null && pred(String(it.trackId))); if (drop) removed++; return !drop; }); };
            var payload = { index: ci, dirty: true };
            // when shuffled the play order is shuffledItems (currentIndex indexes into it); otherwise it's items
            if (pq.shuffled && Array.isArray(pq.shuffledItems) && pq.shuffledItems.length) payload.shuffledItems = keep(pq.shuffledItems);
            else if (Array.isArray(pq.items)) payload.items = keep(pq.items);
            // autoplay continuation (played once the queue runs out) - all of it is upcoming, so drop every
            // denied entry. Without this, a trashed autoplay track becomes current and the URL-deny hangs it.
            if (pq.autoplay && Array.isArray(pq.autoplay.items) && pq.autoplay.items.length) {
              var ai = pq.autoplay.items.filter(function (it) { var drop = !!(it && it.trackId != null && pred(String(it.trackId))); if (drop) removed++; return !drop; });
              if (ai.length !== pq.autoplay.items.length) payload.autoplayItems = ai;
            }
            if (!removed) return 0;
            QZ_STORE.dispatch({ type: "playqueue/set", payload: payload });
            return removed;
          } catch (e) { return 0; }
        }
      },
      onRoute: function (fn) { routeCbs.push(fn); return function () { var i = routeCbs.indexOf(fn); if (i >= 0) routeCbs.splice(i, 1); }; },
      // debounced DOM observer; returns an unsubscribe fn
      observe: function (fn, opts) {
        var pending, ms = (opts && opts.debounce) || 120;
        function run() { if (pending) return; pending = setTimeout(function () { pending = null; try { fn(); } catch (e) {} }, ms); }
        var mo = new MutationObserver(run); mo.observe(document.body, { childList: true, subtree: true }); run();
        return function () { clearTimeout(pending); mo.disconnect(); };
      },
      addNavItem: function (spec) {
        navItems.push({ spec: spec }); injectNavItems();
        return { remove: function () { navItems = navItems.filter(function (n) { return n.spec.id !== spec.id; }); var ex = document.querySelector('[data-qz-nav="' + spec.id + '"]'); if (ex) ex.remove(); } };
      },
      // Register a button in the player bar. spec = { id, zone:"left"|"right", order:number, el:HTMLElement }.
      // The runtime places it (with spacing + keep-alive); the extension just builds the element (use the
      // .qz-pbtn class for a standard native-sized icon button). Returns { remove }.
      playerSlot: function (spec) {
        var zone = spec.zone === "left" ? "left" : "right";
        playerSlots[zone] = playerSlots[zone].filter(function (s) { return s.id !== spec.id; });
        playerSlots[zone].push({ id: spec.id, order: spec.order || 0, el: spec.el });
        injectPlayerSlots();
        return { remove: function () { playerSlots[zone] = playerSlots[zone].filter(function (s) { return s.id !== spec.id; }); var ex = document.querySelector('[data-qz-slot="' + spec.id + '"]'); if (ex) ex.remove(); } };
      },
      // navigate the Qobuz router (connected-react-router action), with an <a>-click fallback
      navigate: function (path) {
        try { QZ_STORE.dispatch({ type: "@@router/CALL_HISTORY_METHOD", payload: { method: "push", args: [path] } }); }
        catch (e) { var a = document.createElement("a"); a.href = path; document.body.appendChild(a); a.click(); a.remove(); }
      }
    };
    return Q;
  }

  function extEnabled(id) { return localStorage.getItem("qobuzify:ext:" + id) !== "0"; } // default ON
  function loadExtension(ext) {
    if (!window.Qobuzify || extCleanups[ext.id]) return;
    try {
      var fn = new Function("Qobuzify", "vendor", ext.source + "\n//# sourceURL=qobuzify-ext-" + ext.id + ".js");
      var cleanup = fn(window.Qobuzify, ext.vendor || "");
      extCleanups[ext.id] = typeof cleanup === "function" ? cleanup : function () {};
    } catch (e) { try { console.error("[Qobuzify] extension '" + ext.id + "' failed:", e); } catch (_) {} }
  }
  function unloadExtension(id) { var c = extCleanups[id]; if (c) { try { c(); } catch (e) {} delete extCleanups[id]; } }

  function initExtensions() {
    window.Qobuzify = buildApi();
    if (QZ_STORE) QZ_STORE.subscribe(function () {
      try { var loc = QZ_STORE.getState().router && QZ_STORE.getState().router.location; var path = loc && loc.pathname;
        if (path && path !== lastPath) { lastPath = path; routeCbs.forEach(function (f) { try { f(path); } catch (e) {} }); } } catch (e) {}
    });
    (DATA.extensions || []).forEach(function (ext) { if (extEnabled(ext.id)) loadExtension(ext); });
  }
  function initExtensionsWhenReady() {
    if (window.__QZ_EXT_INIT) return;
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (!QZ_STORE) QZ_STORE = findStore();
      if (QZ_STORE) { clearInterval(iv); window.__QZ_EXT_INIT = true; initExtensions(); }
      else if (tries > 60) clearInterval(iv);
    }, 300);
  }

  // --- boot ---
  function boot() {
    // a CLI `apply <theme>` bumps DATA.seed to assert its theme as the active one
    // on next launch; in-app picks afterwards still win until the next CLI apply.
    if (DATA.seed && localStorage.getItem("qobuzify:seed") !== String(DATA.seed)) {
      if (DATA.def) { localStorage.setItem(LS_THEME, DATA.def); localStorage.setItem(LS_ENABLED, "1"); }
      localStorage.setItem("qobuzify:seed", String(DATA.seed));
    }
    setUiAccent(accentOf(bySlug(activeSlug())));
    injectUiStyle();
    var a = activeSlug();
    if (a) applyTheme(a, false); else liveStyle().textContent = "";
    injectMenu(); injectNavItems();
    // re-inject whenever React re-renders the navbar (setTimeout, not rAF, so it
    // still fires when the window is backgrounded), coalesced to one run per burst.
    var pending;
    function schedule() { if (pending) return; pending = setTimeout(function () { pending = null; injectMenu(); injectNavItems(); injectPlayerSlots(); }, 80); }
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    // a pure window resize doesn't mutate the DOM, so the observer above won't fire - re-fit the
    // player-bar slots explicitly so buttons re-appear/hide as the window widens or narrows.
    var rzT; window.addEventListener("resize", function () { clearTimeout(rzT); rzT = setTimeout(fitPlayerSlots, 120); });
    // startup guarantee: poll until the navbar mounts, then stop
    var tries = 0;
    var iv = setInterval(function () { injectMenu(); injectNavItems(); injectPlayerSlots(); if (++tries > 40 || document.querySelector('[data-qz="qobuzify"]')) clearInterval(iv); }, 250);

    // bring up the extension API + load enabled extensions once the store is ready
    initExtensionsWhenReady();

    // check for a newer release (after startup settles) and prompt in-app if there is one
    setTimeout(checkForUpdate, 4000);
  }
  // overlay CSS, kept as one string so the file stays self-contained
  var QZ_CSS = [
    ":root{--qz-accent:#3DA8FE;}",
    // Qobuz's native fullscreen now-playing (.FullPlayer) is position:fixed and expects to fill the
    // viewport. But it lives inside the bottom player panel, and any theme that puts a backdrop-filter
    // (or transform/filter) on that panel turns the panel into the fixed element's containing block -
    // so .FullPlayer renders offset and clipped to the panel's box instead of fullscreen. That's the
    // "full screen only covers part of the window" bug, and it only bit the blur themes (glass/cosmic/
    // dramatic/terracotta), which is why it looked intermittent. While it's open, strip those props off
    // the hosting panels so it escapes back to the viewport. The :has() out-specifies the themes' plain
    // panel rules, so it wins even against their !important, and it self-heals for any user theme too.
    ".grid-layout--panel-outer-bottom:has(.FullPlayer),.ui-layout-001--panel-outer-bottom:has(.FullPlayer),.grid-layout--panel-outer-right:has(.FullPlayer),.ui-layout-001--panel-outer-right:has(.FullPlayer){backdrop-filter:none!important;-webkit-backdrop-filter:none!important;transform:none!important;filter:none!important;}",
    // Qobuzify brand wordmark - replaces the Qobuz logo in the NavBar (kept an <a href=/discover> so click-to-ForYou still works)
    ".NavBar__brand.icon-brand-medium{-webkit-mask:none!important;mask:none!important;background-color:transparent!important;background-image:url(\"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5MzQgMjczIiBmaWxsPSJub25lIj48cGF0aCBkPSJNMTE0LjIwIDI1Ni4zNUwxMTQuMjAgMTgyLjY0UTEwNi43MCAxOTEuNDMgOTYuMTAgMTk2LjEyUTg1LjQ5IDIwMC44MCA3Mi40OCAyMDAuODBRNTcuNzIgMjAwLjgwIDQ0LjU5IDE5Mi44NFEzMS40NyAxODQuODcgMjMuNzMgMTcxLjM5UTE2IDE1Ny45MSAxNiAxNDIuMzNRMTYgMTI2LjM5IDIzLjg1IDExMi45MVEzMS41OSA5OS40NCA0NC42NSA5MS41OVE1Ny43MiA4My43MyA3Mi40OCA4My43M1E4NS40OSA4My43MyA5Ni4xMCA4OC40MlExMDYuNzAgOTMuMTEgMTE0LjIwIDEwMS45MEwxMTQuMjAgODUuODRMMTMzLjg5IDg1Ljg0TDEzMy44OSAyNTYuMzVMMTE0LjIwIDI1Ni4zNU03NS4wNiAxODEuNzBRODUuOTYgMTgxLjcwIDk0Ljg3IDE3Ni40M1ExMDMuODkgMTcxLjE2IDEwOS4wNSAxNjIuMTNRMTE0LjIwIDE1My4xMSAxMTQuMjAgMTQyLjMzUTExNC4yMCAxMzEuNTUgMTA5LjA1IDEyMi41MlExMDMuNzcgMTEzLjM4IDk0LjgxIDEwOC4xN1E4NS44NCAxMDIuOTUgNzUuMDYgMTAyLjk1UTY0LjI4IDEwMi45NSA1NS4yNiAxMDguMjNRNDYuMTIgMTEzLjUwIDQwLjkwIDEyMi41MlEzNS42OSAxMzEuNTUgMzUuNjkgMTQyLjMzUTM1LjY5IDE1My4xMSA0MC45NiAxNjIuMTNRNDYuMjMgMTcxLjI3IDU1LjI2IDE3Ni40OVE2NC4yOCAxODEuNzAgNzUuMDYgMTgxLjcwTTIyMi4wMiAyMDAuODBRMjA1Ljg0IDIwMC44MCAxOTIuMzcgMTkyLjk1UTE3OC43NyAxODUuMTAgMTcwLjg2IDE3MS42M1ExNjIuOTUgMTU4LjE1IDE2Mi45NSAxNDIuMzNRMTYyLjk1IDEyNi41MSAxNzAuOTIgMTEyLjkxUTE3OC44OSA5OS4zMiAxOTIuNDMgOTEuNTNRMjA1Ljk2IDgzLjczIDIyMi4wMiA4My43M1EyMzguMDcgODMuNzMgMjUxLjU1IDkxLjU5UTI2NS4wMiA5OS40NCAyNzIuODggMTEyLjk3UTI4MC43MyAxMjYuNTEgMjgwLjczIDE0Mi4zM1EyODAuNzMgMTU4LjM4IDI3Mi44OCAxNzEuNjNRMjY1LjAyIDE4NS4yMiAyNTEuNDkgMTkzLjAxUTIzNy45NSAyMDAuODAgMjIyLjAyIDIwMC44ME0yMjIuMDIgMTgxLjcwUTIzMi42OCAxODEuNzAgMjQxLjU5IDE3Ni40M1EyNTAuNDkgMTcxLjE2IDI1NS43NyAxNjIuMDJRMjYxLjA0IDE1Mi44OCAyNjEuMDQgMTQyLjMzUTI2MS4wNCAxMzEuNTUgMjU1Ljg4IDEyMi41MlEyNTAuNjEgMTEzLjM4IDI0MS41OSAxMDguMTdRMjMyLjU2IDEwMi45NSAyMjIuMDIgMTAyLjk1UTIxMS4xMiAxMDIuOTUgMjAyLjA5IDEwOC4yM1ExOTIuOTUgMTEzLjUwIDE4Ny44MCAxMjIuNTJRMTgyLjY0IDEzMS41NSAxODIuNjQgMTQyLjMzUTE4Mi42NCAxNTMuMTEgMTg3LjkxIDE2Mi4xM1ExOTMuMTkgMTcxLjI3IDIwMi4yMSAxNzYuNDlRMjExLjIzIDE4MS43MCAyMjIuMDIgMTgxLjcwTTM3MS40MyAyMDAuODBRMzU4LjQyIDIwMC44MCAzNDcuODIgMTk2LjEyUTMzNy4yMSAxOTEuNDMgMzI5LjcxIDE4Mi42NEwzMjkuNzEgMTk4LjcwTDMxMC4wMiAxOTguNzBMMzEwLjAyIDE4LjcwTDMyOS43MSAxOC43MEwzMjkuNzEgMTAxLjkwUTMzNy4yMSA5My4xMSAzNDcuODIgODguNDJRMzU4LjQyIDgzLjczIDM3MS40MyA4My43M1EzODYuNDMgODMuNzMgMzk5LjMyIDkxLjU5UTQxMi40NSA5OS41NSA0MjAuMTIgMTEzLjA5UTQyNy44MCAxMjYuNjMgNDI3LjgwIDE0Mi4zM1E0MjcuODAgMTU4LjAzIDQyMC4wNiAxNzEuNjNRNDEyLjMzIDE4NS4xMCAzOTkuMjYgMTkyLjk1UTM4Ni4yMCAyMDAuODAgMzcxLjQzIDIwMC44ME0zNjguNzMgMTgxLjcwUTM3OS42MyAxODEuNzAgMzg4LjU0IDE3Ni40M1EzOTcuNjggMTcxLjE2IDQwMi44OSAxNjIuMTNRNDA4LjExIDE1My4xMSA0MDguMTEgMTQyLjMzUTQwOC4xMSAxMzEuNDMgNDAyLjg0IDEyMi41MlEzOTcuNTYgMTEzLjM4IDM4OC41NCAxMDguMTdRMzc5LjUyIDEwMi45NSAzNjguNzMgMTAyLjk1UTM1OC4wNyAxMDIuOTUgMzQ5LjA1IDEwOC4yM1EzNDAuMDIgMTEzLjUwIDMzNC44NyAxMjIuNThRMzI5LjcxIDEzMS42NiAzMjkuNzEgMTQyLjMzUTMyOS43MSAxNTMuMTEgMzM0Ljk4IDE2Mi4xM1EzNDAuMTQgMTcxLjI3IDM0OS4xNiAxNzYuNDlRMzU4LjE5IDE4MS43MCAzNjguNzMgMTgxLjcwTTUwMC45MiAyMDAuODBRNDg4LjAzIDIwMC44MCA0NzguMTMgMTk1LjQ3UTQ2OC4yMyAxOTAuMTQgNDYyLjcyIDE4MC41M1E0NTcuMjEgMTcwLjkyIDQ1Ny4yMSAxNTguMjdMNDU3LjIxIDg1Ljg0TDQ3Ni42NiA4NS44NEw0NzYuNjYgMTU2LjYzUTQ3Ni42NiAxNjUuMDYgNDgwLjQ3IDE3MS4xNlE0ODQuMjggMTc3LjI1IDQ4OS42NyAxNzkuOTVRNDk1LjA2IDE4Mi42NCA1MDAuOTIgMTgyLjY0UTUwNi43OCAxODIuNjQgNTEyLjUyIDE3OS45NVE1MTguMjcgMTc3LjI1IDUyMS43OCAxNzEuODZRNTI1LjMwIDE2Ni40NyA1MjUuMzAgMTU2LjYzTDUyNS4zMCA4NS44NEw1NDQuNjMgODUuODRMNTQ0LjYzIDE1OC4yN1E1NDQuNjMgMTcwLjkyIDUzOS4xMyAxODAuNTNRNTMzLjYyIDE5MC4xNCA1MjMuNzEgMTk1LjQ3UTUxMy44MSAyMDAuODAgNTAwLjkyIDIwMC44ME01NjQuNTUgMTk4LjcwTDU2NC40NCAxODUuOTJMNjI2LjMxIDEwMy44OUw1NjcuMTMgMTAzLjg5TDU2Ny4xMyA4NS44NEw2NTMuNzMgODUuODRMNjUzLjczIDk4LjYyTDU5MS44NiAxODAuNjVMNjU1LjE0IDE4MC42NUw2NTUuMTQgMTk4LjcwTDU2NC41NSAxOTguNzBNNjg3LjcyIDE5OC43MEw2ODcuNzIgODUuODRMNzA3LjE3IDg1Ljg0TDcwNy4xNyAxOTguNzBMNjg3LjcyIDE5OC43ME02OTcuNTYgNjQuOThRNjkyLjE3IDY0Ljk4IDY4OC4yNSA2MS4xOFE2ODQuMzIgNTcuMzcgNjg0LjMyIDUyLjA5UTY4NC4zMiA0Ni41OSA2ODguMjUgNDIuODRRNjkyLjE3IDM5LjA5IDY5Ny41NiAzOS4wOVE3MDIuOTUgMzkuMDkgNzA2Ljc2IDQyLjg0UTcxMC41NyA0Ni41OSA3MTAuNTcgNTIuMDlRNzEwLjU3IDU3LjM3IDcwNi43MCA2MS4xOFE3MDIuODQgNjQuOTggNjk3LjU2IDY0Ljk4TTc1Mi45OSAxOTguNzBMNzUyLjk5IDEwMy44OUw3MzQuMDEgMTAzLjg5TDczNC4wMSA4NS44NEw3NTIuOTkgODUuODRMNzUyLjk5IDUxLjA0UTc1Mi45OSA0MC4zOCA3NTcuMTUgMzIuNDZRNzYxLjMxIDI0LjU1IDc2OC45MyAyMC4yOFE3NzYuNTUgMTYgNzg2LjYzIDE2UTc5MS40MyAxNiA3OTUuNTkgMTYuOTRRNzk5Ljc1IDE3Ljg4IDgwMS45OCAxOS40MEw4MDEuOTggMzguODVRNzk5LjQwIDM2Ljg2IDc5NS44OCAzNS42OVE3OTIuMzcgMzQuNTIgNzg4Ljk3IDM0LjUyUTc4MS41OSAzNC41MiA3NzcuMTMgMzkuNzNRNzcyLjY4IDQ0Ljk1IDc3Mi42OCA1My41MEw3NzIuNjggODUuODRMODAyLjQ1IDg1Ljg0TDgwMi40NSAxMDMuODlMNzcyLjY4IDEwMy44OUw3NzIuNjggMTk4LjcwTDc1Mi45OSAxOTguNzBNODIyLjEzIDI1Ni4zNUw4MjIuMTMgMjM3LjEzUTgzMC4yMiAyMzcuMTMgODMzLjUwIDIzNS4wMlE4MzYuMzEgMjMzLjE1IDgzOS4yNCAyMjZMODUwLjYxIDE5OC43MEw4MDQuNzkgODUuODRMODI2LjcwIDg1Ljg0TDg2MS44NiAxNzQuMDlMODk1LjAyIDg1Ljg0TDkxNy4xNyA4NS44NEw4NTYuODIgMjM1LjYxUTg1Mi4xMyAyNDUuMjIgODQ0Ljg3IDI1MC42MVE4MzYuNjYgMjU2LjM1IDgyMi4xMyAyNTYuMzUiIGZpbGw9IiNGRkZGRkYiIHN0cm9rZT0iI0ZGRkZGRiIgc3Ryb2tlLXdpZHRoPSIxMiIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PC9zdmc+\")!important;background-repeat:no-repeat!important;background-position:left center!important;background-size:contain!important;width:82px!important;height:24px!important;font-size:0!important;color:transparent!important;}.NavBar__brand.icon-brand-medium::before{content:none!important;background:none!important;-webkit-mask:none!important;mask:none!important;}",
    // dark scrollbars app-wide (replaces the default light/white native ones so they match the theme).
    // the standard scrollbar-color has to be set here: any element using the standard scrollbar-width
    // property (Qobuz's containers, plus our own .qz-fy-track / #qz-foryou-page / search body, all do)
    // makes Chromium ignore ::-webkit-scrollbar and fall back to the native (white) scrollbar unless
    // scrollbar-color is given too. !important on the color so it always wins.
    "*{scrollbar-color:rgba(255,255,255,.22) transparent !important;scrollbar-width:thin;}",
    "::-webkit-scrollbar{width:12px;height:12px;}",
    "::-webkit-scrollbar-track{background:transparent !important;}",
    "::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16) !important;border-radius:8px;border:3px solid transparent;background-clip:padding-box;}",
    "::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.28) !important;background-clip:padding-box;}",
    "::-webkit-scrollbar-corner{background:transparent !important;}",
    ".qz-menuitem{cursor:pointer;}",
    ".qz-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;",
      "background:rgba(4,6,10,.62);backdrop-filter:blur(9px);-webkit-backdrop-filter:blur(9px);opacity:0;transition:opacity .18s ease;font-family:inherit;}",
    ".qz-overlay.qz-show{opacity:1;}",
    ".qz-modal{width:min(960px,93vw);max-height:84vh;display:flex;flex-direction:column;color:#eef2f7;",
      "background:linear-gradient(180deg,rgba(20,23,31,.96),rgba(12,14,20,.97));border:1px solid rgba(255,255,255,.10);",
      "border-radius:18px;box-shadow:0 30px 90px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.03),0 0 60px -20px var(--qz-accent);",
      "transform:translateY(8px) scale(.99);transition:transform .2s ease;overflow:hidden;}",
    ".qz-show .qz-modal{transform:none;}",
    ".qz-head{display:flex;align-items:center;gap:18px;padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.07);}",
    ".qz-brand{display:flex;align-items:center;gap:9px;}",
    ".qz-brand-ico{color:var(--qz-accent);font-size:20px;line-height:1;}",
    ".qz-brand-name{font-weight:700;font-size:17px;letter-spacing:.2px;}",
    ".qz-ver{font-size:11px;color:#8b94a3;background:rgba(255,255,255,.06);padding:2px 7px;border-radius:20px;}",
    ".qz-tabs{display:flex;gap:4px;margin-left:6px;}",
    ".qz-tab{appearance:none;border:0;background:transparent;color:#9aa3b2;font:inherit;font-size:13px;font-weight:600;",
      "padding:7px 14px;border-radius:9px;cursor:pointer;transition:all .15s;}",
    ".qz-tab:hover{color:#e7ecf3;background:rgba(255,255,255,.05);}",
    ".qz-tab--active{color:#0a0d12;background:var(--qz-accent);}",
    ".qz-close{margin-left:auto;appearance:none;border:0;background:rgba(255,255,255,.06);color:#cbd3df;",
      "width:32px;height:32px;border-radius:9px;font-size:20px;line-height:1;cursor:pointer;transition:all .15s;}",
    ".qz-close:hover{background:rgba(255,255,255,.13);color:#fff;}",
    ".qz-body{padding:18px;overflow:auto;}",
    ".qz-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(212px,1fr));gap:15px;}",
    ".qz-card{background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden;",
      "transition:transform .15s,border-color .15s,box-shadow .15s;}",
    ".qz-card:hover{transform:translateY(-3px);border-color:rgba(255,255,255,.18);}",
    ".qz-card--active{border-color:var(--qz-accent);box-shadow:0 0 0 1px var(--qz-accent),0 10px 30px -12px var(--qz-accent);}",
    ".qz-card--soon{opacity:.7;}",
    ".qz-prev{position:relative;height:104px;padding:10px;display:flex;flex-direction:column;gap:8px;}",
    ".qz-prev-bar{height:14px;border-radius:5px;width:70%;}",
    ".qz-prev-row{display:flex;align-items:center;gap:9px;}",
    ".qz-prev-play{width:26px;height:26px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 14px -2px var(--qz-accent);}",
    ".qz-prev-lines{flex:1;display:flex;flex-direction:column;gap:5px;}",
    ".qz-prev-lines i{height:6px;border-radius:4px;display:block;width:85%;}",
    ".qz-prev-heart{font-size:15px;}",
    ".qz-prev-chip{position:absolute;right:10px;bottom:10px;width:34px;height:18px;border-radius:6px;}",
    ".qz-card-body{padding:12px 13px 13px;}",
    ".qz-card-top{display:flex;align-items:center;justify-content:space-between;gap:8px;}",
    ".qz-card-name{font-weight:650;font-size:14px;}",
    ".qz-dot{width:10px;height:10px;border-radius:50%;flex:0 0 auto;}",
    ".qz-pill{font-size:10px;font-weight:700;color:#0a0d12;background:var(--qz-accent);padding:2px 7px;border-radius:20px;text-transform:uppercase;letter-spacing:.5px;}",
    ".qz-card-desc{font-size:12px;color:#9aa3b2;margin:5px 0 11px;line-height:1.4;min-height:32px;}",
    ".qz-apply{width:100%;appearance:none;border:0;border-radius:9px;padding:9px;font:inherit;font-size:13px;font-weight:700;",
      "cursor:pointer;color:#0a0d12;background:var(--qz-accent);transition:filter .15s,opacity .15s;}",
    ".qz-apply:hover{filter:brightness(1.08);}",
    ".qz-card--active .qz-apply{background:rgba(255,255,255,.10);color:#cdd5e0;cursor:default;}",
    ".qz-apply[disabled]{background:rgba(255,255,255,.07);color:#7b8494;cursor:not-allowed;}",
    ".qz-soon-head{display:flex;gap:14px;align-items:center;padding:6px 2px 20px;}",
    ".qz-soon-ico{color:var(--qz-accent);font-size:30px;}",
    ".qz-soon-title{font-weight:700;font-size:16px;}",
    ".qz-soon-sub{font-size:13px;color:#9aa3b2;margin-top:3px;max-width:560px;line-height:1.45;}",
    ".qz-set-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:16px 4px;border-bottom:1px solid rgba(255,255,255,.06);}",
    ".qz-set-label{font-weight:650;font-size:14px;}",
    ".qz-set-sub{font-size:12.5px;color:#9aa3b2;margin-top:3px;}",
    ".qz-btn{appearance:none;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#e7ecf3;font:inherit;",
      "font-size:13px;font-weight:600;padding:8px 15px;border-radius:9px;cursor:pointer;white-space:nowrap;transition:all .15s;}",
    ".qz-btn:hover{background:rgba(255,255,255,.1);}",
    ".qz-btn--ghost{background:transparent;}",
    ".qz-switch{position:relative;width:46px;height:26px;border-radius:20px;border:0;cursor:pointer;background:rgba(255,255,255,.16);transition:background .15s;}",
    ".qz-switch span{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:left .16s;}",
    ".qz-switch--on{background:var(--qz-accent);}",
    ".qz-switch--on span{left:23px;}",
    ".qz-set-about{font-size:12px;color:#7e8796;padding:18px 4px 2px;}",
    ".qz-set-links{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:4px 4px 2px;font-size:12.5px;}",
    ".qz-set-links a{color:var(--qz-accent);cursor:pointer;text-decoration:none;}",
    ".qz-set-links a:hover{text-decoration:underline;}",
    ".qz-set-links span{color:#5b6474;}",
    ".qz-set-update{border-bottom-color:rgba(255,255,255,.06);}",
    ".qz-btn--accent{background:var(--qz-accent);color:#0a0d12;border-color:transparent;font-weight:700;}",
    ".qz-btn--accent:hover{filter:brightness(1.08);background:var(--qz-accent);}",
    // update toast (bottom-right)
    ".qz-toast{position:fixed;right:20px;bottom:20px;z-index:2147483001;width:320px;max-width:calc(100vw - 40px);",
      "background:linear-gradient(180deg,rgba(20,23,31,.98),rgba(12,14,20,.99));border:1px solid rgba(255,255,255,.12);",
      "border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.55),0 0 40px -18px var(--qz-accent);color:#eef2f7;",
      "padding:14px 15px;font-family:inherit;opacity:0;transform:translateY(12px);transition:opacity .22s ease,transform .22s ease;}",
    ".qz-toast--in{opacity:1;transform:none;}",
    ".qz-toast-head{display:flex;align-items:center;gap:9px;}",
    ".qz-toast-ico{color:var(--qz-accent);font-size:18px;line-height:1;}",
    ".qz-toast-title{font-weight:700;font-size:14px;}",
    ".qz-toast-x{margin-left:auto;appearance:none;border:0;background:transparent;color:#9aa3b2;font-size:18px;line-height:1;cursor:pointer;padding:0 2px;}",
    ".qz-toast-x:hover{color:#fff;}",
    ".qz-toast-sub{font-size:12.5px;color:#9aa3b2;margin-top:6px;}",
    ".qz-toast-sub b{color:var(--qz-accent);}",
    ".qz-toast-notes{margin:9px 0 4px;padding-left:18px;font-size:12px;color:#c2cad6;line-height:1.5;}",
    ".qz-toast-notes li{margin:2px 0;}",
    ".qz-toast-actions{display:flex;gap:8px;margin-top:12px;}",
    ".qz-toast-go{flex:1;appearance:none;border:0;border-radius:9px;padding:8px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;color:#0a0d12;background:var(--qz-accent);transition:filter .15s;}",
    ".qz-toast-go:hover{filter:brightness(1.08);}",
    ".qz-toast-later{appearance:none;border:1px solid rgba(255,255,255,.14);background:transparent;color:#cbd3df;border-radius:9px;padding:8px 12px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;}",
    ".qz-toast-later:hover{background:rgba(255,255,255,.08);}",
    ".qz-ext-ico{color:var(--qz-accent);margin-right:8px;font-size:15px;vertical-align:-2px;}",
    ".qz-ext .qz-card-body{display:flex;flex-direction:column;}",
    ".qz-ext-meta{font-size:11px;color:#7e8796;margin-top:10px;}",
    ".qz-foot{display:flex;justify-content:space-between;align-items:center;padding:11px 18px;border-top:1px solid rgba(255,255,255,.07);font-size:12px;color:#7e8796;}",
    // shared player-bar button slots (Q.playerSlot): auto-spaced zones + a native-sized icon button helper
    ".qz-slot-left{display:inline-flex;align-items:center;gap:4px;padding:0 8px;flex:0 0 auto;}",
    // row-reverse so the lowest-order (most important, e.g. Lyrics) button sits at the OUTER edge, away from
    // the centred transport - so when a narrow window forces buttons to drop, the least-important ones (inner)
    // go first and the flagship buttons survive longest. fitPlayerSlots hides from the inner edge to match.
    ".qz-slot-right{display:inline-flex;flex-direction:row-reverse;align-items:center;gap:8px;margin-right:14px;flex:0 0 auto;}",
    ".qz-pbtn{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;appearance:none;border:0;border-radius:9px;",
      "background:transparent;color:#c2cad6;cursor:pointer;transition:background .15s,color .12s,transform .08s;flex:0 0 auto;padding:0;line-height:1;}",
    ".qz-pbtn:hover{background:color-mix(in srgb,var(--qz-accent,#3DA8FE) 18%,transparent);color:var(--qz-accent,#3DA8FE);}",
    ".qz-pbtn:active{transform:scale(.9);}",
    ".qz-pbtn svg{width:22px;height:22px;display:block;pointer-events:none;}",
    ".qz-pbtn>[class*='icon-']{font-size:22px;line-height:1;pointer-events:none;}"
  ].join("");

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
