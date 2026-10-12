// The Qobuzify runtime - injected into Qobuz's app.html as an inline <script>. This is the in-app
// layer, Spicetify-style: a live theme engine, one "Qobuzify" entry in the account dropdown that opens
// a Themes / Extensions / Settings modal, the extension API (window.Qobuzify) and its Q.ui kit.
//
// It reads its payload from window.__QOBUZIFY__ = { catalog, def, version }, which the CLI templates
// in just above this script. Theme switching happens live by swapping a single
// <style id="qobuzify-live"> - no relaunch - and the choice is persisted to localStorage so it
// survives restarts.
(function () {
  if (window.__QOBUZIFY_RUNTIME__) return; // guard against a double inject
  window.__QOBUZIFY_RUNTIME__ = true;

  // Some documents the preload injects into deny storage outright (a transient about:blank during
  // navigation, a sandboxed frame). Touching localStorage there throws SecurityError, and because the
  // guard above is ALREADY set, the runtime dies half-initialised and is never retried - the whole mod
  // silently does not exist in that tab. Probe once and bail out of documents that are not the app,
  // releasing the guard so the real document can still inject.
  try { window.localStorage.getItem("qobuzify:probe"); }
  catch (e) { try { window.__QOBUZIFY_RUNTIME__ = false; } catch (_) {} return; }

  // --- interface language override -----------------------------------------------------------
  // Qobuz derives its UI language from the BROWSER, not from any account setting: at boot it runs
  // setLanguage(navigator.language), and again after login setLanguage(navigator.languages[0]). So a
  // user in a German region gets German (with gendered terms like "Kuenstler:in") and there is no
  // opt-out anywhere in Qobuz's own settings. Nothing can undo it from inside the app once booted -
  // but this script is injected BEFORE bundle.js, which makes it the only place an override can stick.
  // Reported as issue #11. Off unless the user picks something: with no stored preference, untouched.
  var LS_LANG = "qobuzify:lang";
  try {
    var _pref = localStorage.getItem(LS_LANG);
    if (_pref) {
      var _base = _pref.slice(0, 2);
      var _list = _base === _pref ? [_pref] : [_pref, _base];
      Object.defineProperty(navigator, "language", { configurable: true, get: function () { return _pref; } });
      Object.defineProperty(navigator, "languages", { configurable: true, get: function () { return _list; } });
    }
  } catch (e) {}

  var DATA = window.__QOBUZIFY__ || { catalog: [], def: null, version: "0.1" };
  var CATALOG = DATA.catalog || [];
  // Android runs the same baked payload as desktop, so DATA.version is the DESKTOP package version. The
  // native shell (MainActivity) exposes the real app versionName as window.__QZ_ANDROID_VERSION__, and
  // window.QZAndroidMedia is the reliable Android signal (the UA is spoofed desktop on both platforms).
  var IS_ANDROID = !!window.QZAndroidMedia;
  // The Electron wrapper and the patched desktop app are DIFFERENT PRODUCTS on separate version lines,
  // and each wrapper OS ships independently. Reporting plain "desktop" from the wrapper made it ask for
  // the bake's channel. Bake clients still send exactly "desktop", so their behaviour is unchanged.
  var WRAP = (typeof window !== "undefined" && window.__QZWRAP__) || null;
  var PLATFORM = IS_ANDROID ? "android" : (WRAP ? ("wrapper-" + (WRAP.os || "linux")) : "desktop");
  var VERSION = (IS_ANDROID && window.__QZ_ANDROID_VERSION__) || DATA.version || "0.1";
  var LS_THEME = "qobuzify:theme";
  var LS_ENABLED = "qobuzify:enabled";
  var DEFAULT_ACCENT = "#3DA8FE";
  var PLAT = IS_ANDROID ? "android" : "desktop";

  // --- storage -------------------------------------------------------------------------------
  // Every runtime write goes through lsSet. A full quota (library-load caches a lot) or a storage-denied
  // document throws from setItem, and an unguarded throw in a click handler left the UI half-updated.
  // The write is simply dropped and reported once; callers that care read the boolean.
  var lsWarned = false;
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) {
    try { localStorage.setItem(k, String(v)); return true; }
    catch (e) {
      if (!lsWarned) { lsWarned = true; try { console.warn("[Qobuzify] could not save setting '" + k + "':", e && e.name); } catch (_) {} }
      return false;
    }
  }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  // --- theme engine ---
  function bySlug(slug) { for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i].slug === slug) return CATALOG[i]; return null; }
  // The baked default, or the first theme if the default itself is gone from the catalog.
  function defaultSlug() { if (DATA.def && bySlug(DATA.def)) return DATA.def; return (CATALOG[0] && CATALOG[0].slug) || null; }
  function isEnabled() { return lsGet(LS_ENABLED) !== "0"; }
  // A stored slug that no longer exists in the catalog (a theme was removed or renamed) falls back to the
  // default instead of applying empty CSS.
  function storedSlug() { var s = lsGet(LS_THEME); return (s && bySlug(s)) ? s : null; }
  function activeSlug() { if (!isEnabled()) return null; return storedSlug() || defaultSlug(); }
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
  function markFollow(on) { try { document.documentElement.classList.toggle("qz-follow", !!on); } catch (e) {} }

  function applyTheme(slug, persist) {
    var t = bySlug(slug) || bySlug(defaultSlug());
    liveStyle().textContent = buildCss(t);
    if (persist !== false && t) { lsSet(LS_THEME, t.slug); lsSet(LS_ENABLED, "1"); }
    markFollow(!t);
    setUiAccent(accentOf(t));
    refreshThemeUi();
    return t;
  }
  // "Follow Qobuz": no Qobuzify theme at all, so Qobuz's own light or dark appearance shows through.
  function followQobuz() { liveStyle().textContent = ""; lsSet(LS_ENABLED, "0"); markFollow(true); setUiAccent(DEFAULT_ACCENT); refreshThemeUi(); }
  function lastTheme() { return storedSlug() || defaultSlug(); }
  function refreshThemeUi() { refreshCards(); refreshSettings(); refreshWelcome(); }

  // --- Qobuz appearance --------------------------------------------------------------------------
  // Qobuz resolves its light/dark appearance onto a data-theme attribute on .ui-responsive (and on each of
  // its own portals), and its design tokens (--token-text-primary, --token-color-surface-*) are defined per
  // [data-theme]. Our UI is appended to <body>, outside that subtree, so it would always get the dark
  // :root defaults. Mirroring the attribute onto our roots makes Qobuz's own token rules apply to them, the
  // same way its portals work. Roots carry data-qz-follow and are re-synced from the boot observer.
  function qobuzAppearance() {
    try {
      var el = document.querySelector(".ui-responsive[data-theme]") || document.querySelector("[data-theme=light],[data-theme=dark]");
      var v = el && el.getAttribute("data-theme");
      if (v === "light" || v === "dark") return v;
    } catch (e) {}
    return "dark";
  }
  function follow(el) {
    if (!el || !el.setAttribute) return el;
    el.setAttribute("data-qz-follow", "");
    el.setAttribute("data-theme", qobuzAppearance());
    el.classList.add("qzu");
    return el;
  }
  function syncAppearance() {
    var a = qobuzAppearance();
    var roots = document.querySelectorAll("[data-qz-follow]");
    for (var i = 0; i < roots.length; i++) if (roots[i].getAttribute("data-theme") !== a) roots[i].setAttribute("data-theme", a);
  }

  // --- Q.ui: the shared UI kit ---------------------------------------------------------------------
  // Small, stable building blocks so extensions stop shipping their own toasts, switches and menus. All of
  // it is drawn from Qobuz's tokens plus currentColor, so it reads right in Qobuz's light and dark
  // appearance and under any Qobuzify theme. Class names use the qzu- prefix (qz- is shared with
  // extensions and has collided before).
  //
  //   Q.ui.toast(message, opts?) -> { el, body, update(message), close() }
  //       message: string or Node. opts: { title, actions: [{ label, primary, onClick(toast) }],
  //       tone: "error", timeout: ms (default 4000, or sticky when actions are given; 0 = until
  //       dismissed), onClose }. Toasts stack bottom-right above the player bar.
  //   Q.ui.switch({ checked, label, onChange(checked, el) }) -> <button role="switch">
  //       el.checked reads/sets the state (and aria-checked). Return false from onChange to revert.
  //   Q.ui.chip({ label, selected, onClick(event, el) }) -> <button aria-pressed>
  //       el.selected reads/sets the state. The chip does not toggle itself: the caller decides.
  //   Q.ui.button(label, { primary, onClick }) -> <button>
  //   Q.ui.menu(anchor, items, opts?) -> { el, close() }
  //       anchor: an element, or { x, y } for a context menu. items: [{ label, icon, onClick, danger,
  //       disabled }] or "-" for a separator. opts: { align: "left"|"right", onClose }. Closes on pick,
  //       outside click, Escape and resize. Arrow keys move between items.
  //   Q.ui.sheet({ title, content, actions: [{ label, primary, danger, onClick(sheet), keepOpen }], onClose })
  //       -> { el, body, close() }. A centred dialog (a bottom sheet on narrow windows). content: string or Node.
  //   Q.ui.empty({ icon, title, text, action: { label, onClick } }) -> element
  //   Q.ui.error({ title, text, onRetry }) -> element (role="alert"; onRetry adds a Try again button)
  //   Q.ui.follow(el) -> el   keep a root you append to <body> on Qobuz's light/dark appearance
  //   Q.ui.appearance() -> "light" | "dark"
  var X_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  var DOTS_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg>';
  var uidN = 0;
  var UI = (function () {
    function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    function put(parent, content) { if (content == null) return; if (typeof content === "string") parent.textContent = content; else parent.appendChild(content); }
    function button(label, opts) {
      opts = opts || {};
      var b = h("button", "qzu-btn" + (opts.primary ? " qzu-btn--primary" : "") + (opts.danger ? " qzu-btn--danger" : ""), label);
      b.type = "button";
      if (opts.onClick) b.addEventListener("click", function (e) { opts.onClick(e, b); });
      return b;
    }
    function iconButton(svg, label) { var b = h("button", "qzu-iconbtn"); b.type = "button"; b.setAttribute("aria-label", label); b.title = label; b.innerHTML = svg; return b; }

    var toastHost = null;
    function host() {
      injectUiStyle();
      if (!toastHost || !toastHost.isConnected) {
        toastHost = follow(h("div", "qzu-toasts"));
        toastHost.setAttribute("aria-live", "polite");
        document.body.appendChild(toastHost);
      }
      return toastHost;
    }
    function toast(message, opts) {
      opts = opts || {};
      var el = h("div", "qzu-toast" + (opts.tone === "error" ? " qzu-toast--error" : ""));
      el.setAttribute("role", opts.tone === "error" ? "alert" : "status");
      var main = h("div", "qzu-toast-main");
      if (opts.title) main.appendChild(h("div", "qzu-toast-title", opts.title));
      var body = h("div", "qzu-toast-body"); put(body, message); main.appendChild(body);
      el.appendChild(main);
      var x = iconButton(X_SVG, "Dismiss"); x.classList.add("qzu-toast-x"); el.appendChild(x);
      var timer = null, closed = false;
      var api = { el: el, body: body, close: close, update: function (m) { body.textContent = ""; put(body, m); } };
      if (opts.actions && opts.actions.length) {
        var acts = h("div", "qzu-toast-actions");
        opts.actions.forEach(function (a) { acts.appendChild(button(a.label, { primary: a.primary, onClick: function () { try { if (a.onClick) a.onClick(api); } catch (e) {} } })); });
        main.appendChild(acts);
      }
      function close() {
        if (closed) return; closed = true; clearTimeout(timer);
        el.classList.remove("qzu-in");
        setTimeout(function () { el.remove(); }, 200);
        try { if (opts.onClose) opts.onClose(); } catch (e) {}
      }
      x.addEventListener("click", close);
      host().appendChild(el);
      requestAnimationFrame(function () { el.classList.add("qzu-in"); });
      var ms = opts.timeout == null ? (opts.actions && opts.actions.length ? 0 : 4000) : +opts.timeout;
      if (ms > 0) {
        timer = setTimeout(close, ms);
        el.addEventListener("mouseenter", function () { clearTimeout(timer); });
        el.addEventListener("mouseleave", function () { if (!closed) { clearTimeout(timer); timer = setTimeout(close, 1500); } });
      }
      return api;
    }
    function sw(opts) {
      opts = opts || {};
      var b = h("button", "qzu-switch"); b.type = "button"; b.setAttribute("role", "switch");
      if (opts.label) b.setAttribute("aria-label", opts.label);
      b.appendChild(h("span", "qzu-switch-knob"));
      var on = !!opts.checked;
      function paint() { b.setAttribute("aria-checked", on ? "true" : "false"); b.classList.toggle("qzu-switch--on", on); }
      Object.defineProperty(b, "checked", { configurable: true, get: function () { return on; }, set: function (v) { on = !!v; paint(); } });
      paint();
      b.addEventListener("click", function () {
        if (b.disabled) return;
        on = !on; paint();
        if (opts.onChange) { var r; try { r = opts.onChange(on, b); } catch (e) { r = false; } if (r === false) { on = !on; paint(); } }
      });
      return b;
    }
    function chip(opts) {
      opts = opts || {};
      var b = h("button", "qzu-chip", opts.label || ""); b.type = "button";
      var sel = !!opts.selected;
      function paint() { b.setAttribute("aria-pressed", sel ? "true" : "false"); b.classList.toggle("qzu-chip--on", sel); }
      Object.defineProperty(b, "selected", { configurable: true, get: function () { return sel; }, set: function (v) { sel = !!v; paint(); } });
      paint();
      if (opts.onClick) b.addEventListener("click", function (e) { opts.onClick(e, b); });
      return b;
    }
    var openMenu = null;
    function menu(anchor, items, opts) {
      opts = opts || {};
      if (openMenu) openMenu.close();
      injectUiStyle();
      var m = follow(h("div", "qzu-menu")); m.setAttribute("role", "menu");
      var btns = [], closed = false;
      var api = { el: m, close: close };
      (items || []).forEach(function (it) {
        if (it === "-") { var s = h("div", "qzu-menu-sep"); s.setAttribute("role", "separator"); m.appendChild(s); return; }
        if (!it) return;
        var b = h("button", "qzu-menu-item" + (it.danger ? " qzu-menu-item--danger" : "")); b.type = "button"; b.setAttribute("role", "menuitem");
        if (it.icon) { var ic = h("span", "qzu-menu-ico " + it.icon); ic.setAttribute("aria-hidden", "true"); b.appendChild(ic); }
        b.appendChild(h("span", "qzu-menu-label", it.label || ""));
        if (it.disabled) b.disabled = true;
        b.addEventListener("click", function () { close(); try { if (it.onClick) it.onClick(); } catch (e) {} });
        m.appendChild(b); btns.push(b);
      });
      document.body.appendChild(m);
      var r = (anchor && anchor.getBoundingClientRect) ? anchor.getBoundingClientRect()
        : { left: (anchor && anchor.x) || 0, right: (anchor && anchor.x) || 0, top: (anchor && anchor.y) || 0, bottom: (anchor && anchor.y) || 0 };
      var mw = m.offsetWidth, mh = m.offsetHeight;
      var left = opts.align === "right" ? r.right - mw : r.left;
      left = Math.max(8, Math.min(left, innerWidth - mw - 8));
      var top = r.bottom + 6;
      if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
      m.style.left = left + "px"; m.style.top = top + "px";
      function isAnchor(t) { return anchor && anchor.contains && anchor.contains(t); }
      function onDown(e) { if (!m.contains(e.target) && !isAnchor(e.target)) close(); }
      function onKey(e) {
        if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); if (anchor && anchor.focus) anchor.focus(); return; }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          var live = btns.filter(function (b) { return !b.disabled; }); if (!live.length) return;
          var i = live.indexOf(document.activeElement);
          i = e.key === "ArrowDown" ? (i + 1) % live.length : (i <= 0 ? live.length - 1 : i - 1);
          live[i].focus();
        }
      }
      function close() {
        if (closed) return; closed = true;
        document.removeEventListener("mousedown", onDown, true);
        document.removeEventListener("keydown", onKey, true);
        window.removeEventListener("resize", close);
        m.remove();
        if (openMenu === api) openMenu = null;
        try { if (opts.onClose) opts.onClose(); } catch (e) {}
      }
      // added after this tick so the click that opened the menu doesn't immediately close it
      setTimeout(function () { if (!closed) document.addEventListener("mousedown", onDown, true); }, 0);
      document.addEventListener("keydown", onKey, true);
      window.addEventListener("resize", close);
      openMenu = api;
      var first = btns.filter(function (b) { return !b.disabled; })[0];
      if (first) first.focus();
      return api;
    }
    function sheet(opts) {
      opts = opts || {};
      injectUiStyle();
      var back = follow(h("div", "qzu-sheet-back"));
      var d = h("div", "qzu-sheet"); d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true");
      var head = h("div", "qzu-sheet-head");
      if (opts.title) { var t = h("div", "qzu-sheet-title", opts.title); t.id = "qzu-sheet-t" + (++uidN); d.setAttribute("aria-labelledby", t.id); head.appendChild(t); }
      var x = iconButton(X_SVG, "Close"); head.appendChild(x);
      d.appendChild(head);
      var body = h("div", "qzu-sheet-body"); put(body, opts.content); d.appendChild(body);
      var closed = false, prevFocus = document.activeElement;
      var api = { el: d, body: body, close: close };
      if (opts.actions && opts.actions.length) {
        var acts = h("div", "qzu-sheet-actions");
        opts.actions.forEach(function (a) {
          acts.appendChild(button(a.label, { primary: a.primary, danger: a.danger, onClick: function () {
            try { if (a.onClick) a.onClick(api); } catch (e) {}
            if (!a.keepOpen) close();
          } }));
        });
        d.appendChild(acts);
      }
      function onKey(e) { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); } }
      function close() {
        if (closed) return; closed = true;
        document.removeEventListener("keydown", onKey, true);
        back.classList.remove("qzu-in");
        setTimeout(function () { back.remove(); }, 180);
        try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) {}
        try { if (opts.onClose) opts.onClose(); } catch (e) {}
      }
      x.addEventListener("click", close);
      back.addEventListener("mousedown", function (e) { if (e.target === back) close(); });
      document.addEventListener("keydown", onKey, true);
      back.appendChild(d);
      document.body.appendChild(back);
      requestAnimationFrame(function () { back.classList.add("qzu-in"); });
      var f = body.querySelector("button, [href], input, select, textarea") || d.querySelector(".qzu-sheet-actions button") || x;
      try { f.focus(); } catch (e) {}
      return api;
    }
    function stateBox(kind, o) {
      o = o || {};
      var w = h("div", "qzu-state" + (kind === "error" ? " qzu-state--error" : ""));
      if (kind === "error") w.setAttribute("role", "alert");
      if (o.icon) { var ic = h("span", "qzu-state-ico " + o.icon); ic.setAttribute("aria-hidden", "true"); w.appendChild(ic); }
      w.appendChild(h("div", "qzu-state-title", o.title || (kind === "error" ? "Couldn't load this" : "Nothing here yet")));
      if (o.text) w.appendChild(h("div", "qzu-state-text", o.text));
      var act = o.action || (kind === "error" && typeof o.onRetry === "function" ? { label: "Try again", onClick: o.onRetry } : null);
      if (act) w.appendChild(button(act.label, { onClick: act.onClick }));
      return w;
    }
    return {
      toast: toast, "switch": sw, chip: chip, button: button, menu: menu, sheet: sheet,
      empty: function (o) { return stateBox("empty", o); },
      error: function (o) { return stateBox("error", o); },
      follow: follow, appearance: qobuzAppearance,
      _iconButton: iconButton, _h: h
    };
  })();

  // --- account-menu entry ---
  // One entry, "Qobuzify", opening one modal with Themes / Extensions / Settings tabs.
  var MENU_ITEM = { key: "qobuzify", label: "Qobuzify", icon: "icon-magic-stars" };
  // Extensions can add their own row to the Settings tab via Q.registerSettings({label,sub,button,onClick}).
  var extSettings = [];
  function closeNativeMenu() {
    // nudge the native dropdown shut via an outside-click; avoid dispatching
    // Escape (our own Esc handler would close the overlay we're about to open)
    try { document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); } catch (e) {}
  }
  function makeMenuItem(spec) {
    var item = document.createElement("div");
    item.className = "MenuItem NavBarMenu__item qz-menuitem";
    item.setAttribute("data-qz", spec.key);
    item.setAttribute("role", "menuitem");
    item.tabIndex = 0;
    var text = document.createElement("div");
    text.className = "MenuItem__text " + spec.icon;
    text.textContent = spec.label;
    item.appendChild(text);
    function go(e) { e.preventDefault(); e.stopPropagation(); closeNativeMenu(); openQobuzify(); }
    item.addEventListener("click", go);
    item.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") go(e); });
    return item;
  }
  // The log-out row, found by Qobuz's own logout icon rather than its (translated) label. Falls back to
  // the last row, which is where Qobuz puts it.
  function findLogoutRow(list) {
    var ico = list.querySelector(".icon-logout");
    var row = ico && ico.closest ? ico.closest(".NavBarMenu__item") : null;
    if (row && row.parentElement === list) return row;
    var rows = list.querySelectorAll(":scope > .NavBarMenu__item:not(.qz-menuitem)");
    return rows.length ? rows[rows.length - 1] : null;
  }
  function injectMenu() {
    var list = document.querySelector(".NavBarMenu__items");
    if (!list || list.querySelector('[data-qz="qobuzify"]')) return;
    var node = makeMenuItem(MENU_ITEM);
    var logout = findLogoutRow(list);
    if (logout) list.insertBefore(node, logout); else list.appendChild(node);
  }

  // --- overlay shell ---
  var TABS = [["themes", "Themes"], ["extensions", "Extensions"], ["settings", "Settings"]];
  var overlay = null, currentTab = "themes", overlayPrevFocus = null;
  function buildOverlay() {
    if (overlay) return overlay;
    injectUiStyle();
    overlay = follow(document.createElement("div"));
    overlay.classList.add("qz-overlay");
    overlay.style.display = "none";
    overlay.innerHTML =
      '<div class="qz-modal" role="dialog" aria-modal="true" aria-labelledby="qz-modal-title">' +
        '<div class="qz-head">' +
          '<div class="qz-title" id="qz-modal-title">Qobuzify</div>' +
          '<div class="qz-tabs" role="tablist" aria-label="Qobuzify">' +
            TABS.map(function (t) {
              return '<button type="button" class="qz-tab" role="tab" id="qz-tab-' + t[0] + '" aria-controls="qz-panel-' + t[0] + '" data-tab="' + t[0] + '">' + t[1] + '</button>';
            }).join("") +
          '</div>' +
        '</div>' +
        '<div class="qz-body">' +
          TABS.map(function (t) {
            return '<div class="qz-panel" role="tabpanel" id="qz-panel-' + t[0] + '" aria-labelledby="qz-tab-' + t[0] + '" data-panel="' + t[0] + '"></div>';
          }).join("") +
        '</div>' +
      '</div>';
    var close = UI._iconButton(X_SVG, "Close");
    close.classList.add("qz-close");
    overlay.querySelector(".qz-head").appendChild(close);
    document.body.appendChild(overlay);

    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) hideOverlay(); });
    close.addEventListener("click", hideOverlay);
    var tabs = overlay.querySelectorAll(".qz-tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function () { selectTab(this.getAttribute("data-tab")); });
      tabs[i].addEventListener("keydown", function (e) {
        var ids = TABS.map(function (t) { return t[0]; }), at = ids.indexOf(this.getAttribute("data-tab"));
        var to = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : null;
        if (to == null) return;
        e.preventDefault();
        to = (to + ids.length) % ids.length;
        selectTab(ids[to]);
        overlay.querySelector('.qz-tab[data-tab="' + ids[to] + '"]').focus();
      });
    }
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && overlay && overlay.style.display !== "none") hideOverlay(); });
    return overlay;
  }
  function overlayOpen() { return !!(overlay && overlay.style.display !== "none"); }
  function showOverlay() {
    buildOverlay();
    syncAppearance();
    if (!overlayOpen()) overlayPrevFocus = document.activeElement;
    overlay.style.display = "flex";
    requestAnimationFrame(function () { overlay.classList.add("qz-show"); });
  }
  function hideOverlay() {
    if (!overlay) return;
    overlay.classList.remove("qz-show");
    setTimeout(function () { if (overlay && !overlay.classList.contains("qz-show")) overlay.style.display = "none"; }, 160);
    try { if (overlayPrevFocus && overlayPrevFocus.focus && overlayPrevFocus.isConnected) overlayPrevFocus.focus(); } catch (e) {}
    overlayPrevFocus = null;
  }
  // Every tab re-renders from live state when selected, so a switch never shows a stale state after
  // something else (the first-run card, mobile-app, an extension) changed it.
  function selectTab(tab) {
    buildOverlay();
    currentTab = tab;
    var tabs = overlay.querySelectorAll(".qz-tab");
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute("data-tab") === tab;
      tabs[i].classList.toggle("qz-tab--active", on);
      tabs[i].setAttribute("aria-selected", on ? "true" : "false");
      tabs[i].tabIndex = on ? 0 : -1;
    }
    var panels = overlay.querySelectorAll(".qz-panel");
    for (var j = 0; j < panels.length; j++) panels[j].style.display = panels[j].getAttribute("data-panel") === tab ? "block" : "none";
    if (tab === "themes") renderThemes();
    else if (tab === "extensions") renderExtensions();
    else renderSettings();
  }
  function openQobuzify(tab) {
    showOverlay();
    selectTab(tab || currentTab || "themes");
    var t = overlay.querySelector(".qz-tab--active"); if (t) try { t.focus(); } catch (e) {}
  }

  // --- themes panel ---
  function swatch(p) {
    p = p || {}; var bg = p.bg || "#101010", surf = p.surface || "#181818", acc = p.accent || DEFAULT_ACCENT, tx = p.text || "#eee";
    return '<div class="qz-prev" style="background:' + bg + '">' +
      '<div class="qz-prev-bar" style="background:' + surf + '"></div>' +
      '<div class="qz-prev-row"><span class="qz-prev-play" style="background:' + acc + '"></span>' +
        '<span class="qz-prev-lines"><i style="background:' + tx + '"></i><i style="background:' + tx + ';opacity:.45;width:60%"></i></span></div>' +
      '<div class="qz-prev-chip" style="background:' + surf + ';border:1px solid ' + acc + '55"></div>' +
    '</div>';
  }
  // Qobuz's own dark and light grounds side by side, with its gold accent.
  function followSwatch() {
    return '<div class="qz-prev qz-prev--follow">' +
      '<div class="qz-prev-half" style="background:#121212"><div class="qz-prev-bar" style="background:#242424"></div>' +
        '<div class="qz-prev-row"><span class="qz-prev-play" style="background:#ffcb74"></span><span class="qz-prev-lines"><i style="background:#f3f3f3"></i><i style="background:#f3f3f3;opacity:.45;width:60%"></i></span></div></div>' +
      '<div class="qz-prev-half" style="background:#ededed"><div class="qz-prev-bar" style="background:#d7d7d7"></div>' +
        '<div class="qz-prev-row"><span class="qz-prev-play" style="background:#9e6301"></span><span class="qz-prev-lines"><i style="background:#242424"></i><i style="background:#242424;opacity:.45;width:60%"></i></span></div></div>' +
    '</div>';
  }
  function renderThemes() {
    if (!overlay) return;
    var panel = overlay.querySelector('[data-panel="themes"]');
    var act = activeSlug();
    var cards = [{ slug: "", name: "Follow Qobuz", description: "Qobuz's own look, in its light or dark appearance.", follow: true }].concat(CATALOG);
    panel.innerHTML = '<div class="qz-grid">' + cards.map(function (t) {
      var on = t.follow ? !act : t.slug === act;
      return '<div class="qz-card' + (on ? " qz-card--active" : "") + '" data-slug="' + esc(t.slug) + '">' +
        (t.follow ? followSwatch() : swatch(t.preview)) +
        '<div class="qz-card-body">' +
          '<div class="qz-card-name">' + esc(t.name || t.slug) + '</div>' +
          '<div class="qz-card-desc">' + esc(t.description || "") + '</div>' +
          '<button type="button" class="qzu-btn qz-apply"' + (on ? ' aria-pressed="true"' : "") + '>' + (on ? "Applied" : "Apply") + '</button>' +
        '</div></div>';
    }).join("") + '</div>';
    [].slice.call(panel.querySelectorAll(".qz-card")).forEach(function (card) {
      var slug = card.getAttribute("data-slug");
      card.querySelector(".qz-apply").addEventListener("click", function () { if (slug) applyTheme(slug); else followQobuz(); });
    });
  }
  function refreshCards() {
    if (!overlay) return;
    var act = activeSlug() || "";
    var cards = overlay.querySelectorAll(".qz-card[data-slug]");
    for (var i = 0; i < cards.length; i++) {
      var on = cards[i].getAttribute("data-slug") === act;
      cards[i].classList.toggle("qz-card--active", on);
      var btn = cards[i].querySelector(".qz-apply");
      if (btn) { btn.textContent = on ? "Applied" : "Apply"; if (on) btn.setAttribute("aria-pressed", "true"); else btn.removeAttribute("aria-pressed"); }
    }
  }

  // --- extensions panel ---
  // Phone-only extensions until the payload carries manifest.platforms (lib/apply.js buildExtensions).
  var PHONE_ONLY = { "mobile-app": 1, "media-session": 1 };
  var CATEGORY_ORDER = ["Playback", "Library", "Discovery", "Interface", "Integrations"];
  function extPlatforms(e) { return (e && Array.isArray(e.platforms) && e.platforms.length) ? e.platforms : (PHONE_ONLY[e.id] ? ["android"] : ["desktop", "android"]); }
  function extOnPlatform(e) { return extPlatforms(e).indexOf(PLAT) >= 0; }
  function extById(id) { return (DATA.extensions || []).filter(function (x) { return x.id === id; })[0] || null; }
  function extHasSettings(id) { return extSettings.some(function (s) { return s.__ext === id; }); }
  // An extension for another platform is listed only while it is switched on, so an install that had it
  // on (the pre-0.3.5 all-on grandfathering) can still switch it off.
  function extListed(e) { return extOnPlatform(e) || extEnabled(e.id); }
  var extFailed = {};              // ext id -> true when its last start threw
  var extView = { q: "", filter: "all" };
  var extExpanded = {};
  // Switch an extension on or off. Returns false when it failed to start, so the caller reverts its switch.
  function setExtension(id, on) {
    var ext = extById(id);
    if (!on) { lsSet("qobuzify:ext:" + id, "0"); unloadExtension(id); delete extFailed[id]; return true; }
    lsSet("qobuzify:ext:" + id, "1");
    if (!ext) return true;
    if (loadExtension(ext)) { delete extFailed[id]; return true; }
    extFailed[id] = true;
    lsSet("qobuzify:ext:" + id, "0");
    return false;
  }
  function renderExtensions() {
    if (!overlay) return;
    var panel = overlay.querySelector('[data-panel="extensions"]');
    var exts = (DATA.extensions || []).filter(extListed);
    panel.innerHTML = "";
    if (!exts.length) {
      panel.appendChild(UI.empty({ icon: "icon-magic-stars", title: "No extensions yet", text: "Extensions ship with Qobuzify and appear here to switch on and off." }));
      return;
    }
    var bar = document.createElement("div"); bar.className = "qz-ext-bar";
    var search = document.createElement("input");
    search.type = "search"; search.className = "qz-search"; search.placeholder = "Search extensions";
    search.setAttribute("aria-label", "Search extensions"); search.value = extView.q;
    search.addEventListener("input", function () { extView.q = search.value; renderExtList(); });
    bar.appendChild(search);
    var chips = document.createElement("div"); chips.className = "qz-chips"; chips.setAttribute("role", "group"); chips.setAttribute("aria-label", "Filter");
    var cats = CATEGORY_ORDER.filter(function (c) { return exts.some(function (e) { return e.category === c; }); });
    exts.forEach(function (e) { if (e.category && cats.indexOf(e.category) < 0) cats.push(e.category); });
    [["all", "All"], ["enabled", "Enabled"]].concat(cats.map(function (c) { return ["cat:" + c, c]; })).forEach(function (f) {
      chips.appendChild(UI.chip({ label: f[1], selected: extView.filter === f[0], onClick: function (ev, el) {
        extView.filter = f[0];
        [].slice.call(chips.children).forEach(function (c) { c.selected = c === el; });
        renderExtList();
      } }));
    });
    bar.appendChild(chips);
    var count = document.createElement("div"); count.className = "qz-ext-count"; bar.appendChild(count);
    panel.appendChild(bar);
    var list = document.createElement("div"); list.className = "qz-ext-list"; panel.appendChild(list);
    renderExtList();
  }
  function renderExtList() {
    if (!overlay) return;
    var panel = overlay.querySelector('[data-panel="extensions"]');
    var list = panel.querySelector(".qz-ext-list"); if (!list) return;
    var all = (DATA.extensions || []).filter(extListed);
    var q = extView.q.trim().toLowerCase(), f = extView.filter;
    var shown = all.filter(function (e) {
      if (f === "enabled" && !extEnabled(e.id)) return false;
      if (f.indexOf("cat:") === 0 && e.category !== f.slice(4)) return false;
      if (q && ((e.name || "") + " " + (e.description || "") + " " + (e.category || "")).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var count = panel.querySelector(".qz-ext-count");
    if (count) count.textContent = all.filter(function (e) { return extEnabled(e.id); }).length + " of " + all.length + " on";
    list.innerHTML = "";
    if (!shown.length) {
      list.appendChild(UI.empty({ title: "No extensions match", text: "Try another search or filter." }));
      return;
    }
    var grid = document.createElement("div"); grid.className = "qz-grid qz-grid--ext";
    shown.forEach(function (e) { grid.appendChild(extCard(e)); });
    list.appendChild(grid);
    // Offer "More" only where the two-line clamp actually cut something off (needs layout, so after paint).
    requestAnimationFrame(function () {
      [].slice.call(grid.querySelectorAll(".qz-ext-desc")).forEach(function (d) {
        var more = d.parentNode.querySelector(".qz-ext-more");
        if (more && !d.classList.contains("qz-ext-desc--open")) more.hidden = !(d.scrollHeight > d.clientHeight + 1);
      });
    });
  }
  function extCard(e) {
    var card = document.createElement("div");
    card.className = "qz-card qz-ext"; card.setAttribute("data-ext", e.id);
    var body = document.createElement("div"); body.className = "qz-card-body";
    var top = document.createElement("div"); top.className = "qz-card-top";
    var name = document.createElement("div"); name.className = "qz-card-name";
    var ico = document.createElement("span"); ico.className = (e.icon || "icon-magic-stars") + " qz-ext-ico"; ico.setAttribute("aria-hidden", "true");
    name.appendChild(ico); name.appendChild(document.createTextNode(e.name || e.id));
    top.appendChild(name);
    var err = document.createElement("div"); err.className = "qz-ext-err"; err.setAttribute("role", "alert");
    function paintErr() { err.textContent = extFailed[e.id] ? "Couldn't start " + (e.name || e.id) : ""; err.hidden = !extFailed[e.id]; }
    var sw = UI["switch"]({ checked: extEnabled(e.id), label: e.name || e.id, onChange: function (on) {
      var ok = setExtension(e.id, on);
      paintErr();
      updateExtCount();
      return ok;
    } });
    top.appendChild(sw);
    body.appendChild(top);
    var desc = document.createElement("div");
    desc.className = "qz-ext-desc" + (extExpanded[e.id] ? " qz-ext-desc--open" : "");
    desc.id = "qz-ext-desc-" + e.id;
    desc.textContent = e.description || "";
    body.appendChild(desc);
    var more = document.createElement("button");
    more.type = "button"; more.className = "qz-ext-more"; more.hidden = !extExpanded[e.id];
    more.setAttribute("aria-controls", desc.id);
    more.setAttribute("aria-expanded", extExpanded[e.id] ? "true" : "false");
    more.textContent = extExpanded[e.id] ? "Less" : "More";
    more.addEventListener("click", function () {
      var open = !desc.classList.contains("qz-ext-desc--open");
      desc.classList.toggle("qz-ext-desc--open", open); extExpanded[e.id] = open;
      more.textContent = open ? "Less" : "More"; more.setAttribute("aria-expanded", open ? "true" : "false");
    });
    body.appendChild(more);
    var meta = document.createElement("div"); meta.className = "qz-ext-meta";
    var bits = [];
    if (e.version) bits.push("v" + e.version);
    if (e.category) bits.push(e.category);
    if (!extOnPlatform(e)) bits.push(extPlatforms(e).indexOf("android") >= 0 ? "Phone only" : "Desktop only");
    var metaText = document.createElement("span"); metaText.textContent = bits.join(" · ");
    meta.appendChild(metaText);
    if (extHasSettings(e.id)) {
      var link = document.createElement("button");
      link.type = "button"; link.className = "qz-ext-settings"; link.textContent = "Settings";
      link.setAttribute("aria-label", (e.name || e.id) + " settings");
      link.addEventListener("click", function () { openExtSettings(e.id); });
      meta.appendChild(link);
    }
    body.appendChild(meta);
    paintErr();
    body.appendChild(err);
    card.appendChild(body);
    return card;
  }
  function updateExtCount() {
    if (!overlay) return;
    var count = overlay.querySelector(".qz-ext-count");
    var all = (DATA.extensions || []).filter(extListed);
    if (count) count.textContent = all.filter(function (e) { return extEnabled(e.id); }).length + " of " + all.length + " on";
  }
  function refreshExtensions() { if (overlayOpen() && currentTab === "extensions") renderExtList(); }
  function openExtSettings(id) {
    selectTab("settings");
    var row = overlay.querySelector('.qz-set-row[data-ext-owner="' + id + '"]');
    if (row) {
      try { row.scrollIntoView({ block: "center" }); } catch (e) {}
      row.classList.add("qz-set-row--hl");
      setTimeout(function () { row.classList.remove("qz-set-row--hl"); }, 1600);
      var b = row.querySelector("button"); if (b) try { b.focus(); } catch (e) {}
    }
  }

  // --- settings panel ---
  var langPending = false;
  function setRow(label, sub, control, cls) {
    var row = document.createElement("div"); row.className = "qz-set-row" + (cls ? " " + cls : "");
    var text = document.createElement("div"); text.className = "qz-set-text";
    var l = document.createElement("div"); l.className = "qz-set-label"; l.textContent = label; text.appendChild(l);
    if (sub != null) { var s = document.createElement("div"); s.className = "qz-set-sub"; if (typeof sub === "string") s.textContent = sub; else s.appendChild(sub); text.appendChild(s); }
    row.appendChild(text);
    if (control) row.appendChild(control);
    return row;
  }
  function setHeading(text) { var hd = document.createElement("div"); hd.className = "qz-set-head"; hd.setAttribute("role", "heading"); hd.setAttribute("aria-level", "3"); hd.textContent = text; return hd; }
  function renderSettings() {
    if (!overlay) return;
    var panel = overlay.querySelector('[data-panel="settings"]');
    panel.innerHTML = "";
    if (updateInfo) {
      var upSub = document.createElement("div");
      upSub.appendChild(document.createTextNode("v" + updateInfo.latest + " is out. You have v" + VERSION + "."));
      var upHelp = document.createElement("div"); upHelp.className = "qz-update-help";
      upSub.appendChild(upHelp);
      panel.appendChild(setRow("Update available", upSub, UI.button("Update", { primary: true, onClick: function () { doUpdate(upHelp); } }), "qz-set-update"));
    }
    panel.appendChild(setHeading("General"));
    var act = bySlug(activeSlug());
    panel.appendChild(setRow("Theme", act ? act.name || act.slug : "Following Qobuz", UI.button("Change", { onClick: function () { selectTab("themes"); } })));
    var sel = document.createElement("select");
    sel.className = "qz-select"; sel.setAttribute("aria-label", "Interface language");
    sel.innerHTML = langOptions();
    sel.addEventListener("change", function () { setLanguage(this.value); });
    panel.appendChild(setRow("Interface language", "Qobuz follows your system and region. Override it here.", sel));
    if (langPending) {
      panel.appendChild(setRow("Relaunch to apply", "Qobuz reads its language once, when it starts. Playback stops while it relaunches.",
        UI.button("Relaunch", { primary: true, onClick: relaunchForLanguage }), "qz-set-notice"));
    }
    if (extSettings.length) {
      panel.appendChild(setHeading("Extensions"));
      extSettings.forEach(function (e) {
        var b = UI.button(e.button || "Open", { onClick: function () { if (typeof e.onClick === "function") { hideOverlay(); e.onClick(); } } });
        var row = setRow(e.label || "", e.sub || "", b);
        if (e.__ext) row.setAttribute("data-ext-owner", e.__ext);
        panel.appendChild(row);
      });
    }
    // .qz-set-about stays the last block: extensions (ux-tweaks) insert their own rows just before it.
    var about = document.createElement("div"); about.className = "qz-set-about";
    about.appendChild(setHeading("About"));
    var line = document.createElement("div"); line.className = "qz-set-about-line";
    line.textContent = "Qobuzify v" + VERSION + " by matthewprince. Themes and extensions for Qobuz.";
    about.appendChild(line);
    var links = document.createElement("div"); links.className = "qz-set-links";
    [["Report a bug", function () { openExternal(feedbackUrl("issues")); }],
     ["Submit a theme or extension", function () { openExternal(feedbackUrl("submit")); }],
     ["Security issue", function () { openExternal("https://qobuzify.app/security"); }]].forEach(function (l, i) {
      if (i) { var dot = document.createElement("span"); dot.setAttribute("aria-hidden", "true"); dot.textContent = "·"; links.appendChild(dot); }
      var a = document.createElement("button"); a.type = "button"; a.className = "qz-link"; a.textContent = l[0];
      a.addEventListener("click", l[1]);
      links.appendChild(a);
    });
    about.appendChild(links);
    panel.appendChild(about);
  }
  // Only locales the Qobuz bundle actually ships (its LanguageInterfaceEnum), one entry per
  // language so the list stays usable. Values must stay enum-legal: they are also dispatched into
  // Qobuz's settings store, and pt-BR (which the bundle silently normalizes to pt-PT) is not.
  var LANGS = [["", "System default"], ["en-US", "English (US)"], ["en-GB", "English (UK)"],
    ["de-DE", "Deutsch"], ["fr-FR", "Francais"], ["fr-CA", "Francais (CA)"], ["es-ES", "Espanol"],
    ["it-IT", "Italiano"], ["pt-PT", "Portugues"], ["ja-JP", "Nihongo"]];
  var LS_LANG_RESET = "qobuzify:lang-reset";
  function langOptions() {
    var cur = lsGet(LS_LANG) || "";
    return LANGS.map(function (l) {
      return '<option value="' + l[0] + '"' + (l[0] === cur ? " selected" : "") + ">" + esc(l[1]) + "</option>";
    }).join("");
  }
  // The language is read once, at boot, by code we cannot reach afterwards, so the pick is stored now and
  // applied on the next start. No reload here: reloading stops playback, so the user chooses when.
  function setLanguage(v) {
    if (v) { lsSet(LS_LANG, v); lsDel(LS_LANG_RESET); }
    else { lsDel(LS_LANG); lsSet(LS_LANG_RESET, "1"); }
    langPending = true;
    renderSettings();
  }
  function relaunchForLanguage() {
    // Persist through Qobuz's own settings store too (the reducer flags it for storage), so its
    // post-login hydration carries the pick. Clearing back to System default must also dispatch, or the
    // store keeps serving the last override; drop the navigator spoof first (own props, configurable) so
    // the REAL system locale is stored.
    try {
      if (QZ_STORE) {
        var lv = lsGet(LS_LANG);
        if (!lv) { try { delete navigator.language; delete navigator.languages; } catch (e2) {} lv = navigator.language; }
        if (lv) QZ_STORE.dispatch({ type: "SETTINGS_SET_LANGUAGE", language: lv });
      }
      lsDel(LS_LANG_RESET);
    } catch (e) {}
    location.reload();
  }
  function refreshSettings() { if (overlayOpen() && currentTab === "settings") renderSettings(); }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // --- update check + feedback ---
  var API_BASE = "https://api.qobuzify.app";
  var INSTALL_CMD = "irm https://qobuzify.app/install.ps1 | iex";
  var updateInfo = null; // the release payload once we've seen a newer version is out
  var LS_SEEN_VERSION = "qobuzify:seen-version";

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
      fetch(API_BASE + "/v1/version?platform=" + encodeURIComponent(PLATFORM), { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.latest) return;
          if (!verNewer(j.latest, VERSION)) { maybeWhatsNew(j); return; }
          updateInfo = j;
          refreshSettings(); // surface it in the Qobuzify settings panel too
          // In the wrapper the MAIN PROCESS already owns update prompting (desktop notification + in-page
          // banner off the GitHub releases API); stacking this toast on top gave one release three
          // simultaneous prompts. The settings-panel entry above stays as the quiet second surface.
          if (WRAP && WRAP.updatesHandled) return;
          if (lsGet("qobuzify:update-seen") !== j.latest) showUpdateToast(j);
        })
        .catch(function () {});
    } catch (e) {}
  }

  // open a URL in the user's real browser (window.open works in the Qobuz Electron shell). Its
  // return value CANNOT signal success: with "noopener" in the features it is null per spec, and
  // under the wrapper's setWindowOpenHandler (deny after shell.openExternal) it is null too - so
  // testing it made the anchor fallback ALSO fire and every link opened twice. Open once; the
  // anchor path only covers a host where window.open itself throws.
  function openExternal(url) {
    try { window.open(url, "_blank", "noopener"); return; } catch (e) {}
    try { var a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove(); } catch (e) {}
  }
  function copyText(s) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(s).then(function () { return true; }, function () { return false; }); } catch (e) {}
    return Promise.resolve(false);
  }
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
  // The universal desktop update is re-running the web installer (non-destructive: it keeps the user's
  // theme and local creds). It used to be copied to the clipboard silently, which read as "nothing
  // happened". Now the command is shown where the button was, with a Copied confirmation.
  // helpEl: where to show the command (the toast body or the settings row).
  function doUpdate(helpEl) {
    // Android has no PowerShell installer - send it to the Android download page instead of copying a
    // Windows command. Desktop keeps the copy-the-installer flow.
    if (IS_ANDROID) { openExternal((updateInfo && updateInfo.url) || "https://qobuzify.app/android"); return; }
    // The wrapper is its own product line with its own releases; a Windows PowerShell one-liner is
    // useless there. Send it to the release download (the server payload carries the platform url).
    if (WRAP) { openExternal((updateInfo && updateInfo.url) || "https://github.com/matthewprince/qobuzify/releases/latest"); return; }
    if (!helpEl) return;
    helpEl.innerHTML = "";
    var lead = document.createElement("div"); lead.className = "qz-update-lead"; lead.textContent = "Paste this into PowerShell and press Enter:";
    var row = document.createElement("div"); row.className = "qz-update-cmdrow";
    var code = document.createElement("code"); code.className = "qz-update-cmd"; code.textContent = INSTALL_CMD;
    var status = document.createElement("span"); status.className = "qz-update-status"; status.setAttribute("role", "status");
    var again = UI.button("Copy", { onClick: function () { copyCmd(); } });
    row.appendChild(code); row.appendChild(again); row.appendChild(status);
    helpEl.appendChild(lead); helpEl.appendChild(row);
    function copyCmd() {
      copyText(INSTALL_CMD).then(function (ok) {
        status.textContent = ok ? "Copied" : "Select it and press Ctrl+C";
        if (!ok) { try { var r = document.createRange(); r.selectNodeContents(code); var s = getSelection(); s.removeAllRanges(); s.addRange(r); } catch (e) {} }
      });
    }
    copyCmd();
  }

  // Stays until the user dismisses it: Update reveals the command and keeps the toast open, and only
  // Later or the close button mark this version as seen.
  var updateToast = null;
  function showUpdateToast(j) {
    if (updateToast) return;
    var body = document.createElement("div");
    body.appendChild(document.createTextNode("Qobuzify v" + j.latest + " is out. You have v" + VERSION + "."));
    var notes = (j.notes || []).slice(0, 4);
    if (notes.length) {
      var ul = document.createElement("ul"); ul.className = "qz-notes";
      notes.forEach(function (n) { var li = document.createElement("li"); li.textContent = n; ul.appendChild(li); });
      body.appendChild(ul);
    }
    var help = document.createElement("div"); help.className = "qz-update-help"; body.appendChild(help);
    updateToast = UI.toast(body, {
      title: "Update available", timeout: 0,
      actions: [{ label: "Update", primary: true, onClick: function () { doUpdate(help); } },
                { label: "Later", onClick: function (t) { t.close(); } }],
      onClose: function () { lsSet("qobuzify:update-seen", j.latest); updateToast = null; }
    });
  }

  // --- first-run card ---------------------------------------------------------------------------
  // Shown once on a fresh install, next to the avatar (where Qobuzify lives): what is on right now, each
  // with its own switch, and how to find the rest. The same card carries a short "what's new" after an
  // update, from the release notes the version endpoint already serves.
  var welcomeEl = null, welcomeMode = null, firstRun = false;
  function welcomeAnchor() { return document.querySelector(".NavBar__avatar"); }
  function placeWelcome() {
    if (!welcomeEl) return;
    var a = welcomeAnchor(), r = a && a.getBoundingClientRect();
    if (r && r.width) { welcomeEl.style.top = Math.round(r.bottom + 10) + "px"; welcomeEl.style.right = Math.max(12, Math.round(innerWidth - r.right)) + "px"; }
    else { welcomeEl.style.top = "70px"; welcomeEl.style.right = "20px"; }
  }
  function closeWelcome() {
    if (!welcomeEl) return;
    lsSet("qobuzify:welcome", "1");
    lsSet(LS_SEEN_VERSION, VERSION);
    var el = welcomeEl; welcomeEl = null;
    el.classList.remove("qzu-in");
    setTimeout(function () { el.remove(); }, 180);
    window.removeEventListener("resize", placeWelcome);
  }
  function showWelcome(mode, notes) {
    if (welcomeEl || IS_ANDROID) return;
    injectUiStyle();
    welcomeMode = mode;
    var el = follow(document.createElement("div"));
    el.classList.add("qz-welcome");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-labelledby", "qz-welcome-title");
    var head = document.createElement("div"); head.className = "qz-welcome-head";
    var title = document.createElement("div"); title.className = "qz-welcome-title"; title.id = "qz-welcome-title";
    title.textContent = mode === "new" ? "What's new in Qobuzify v" + VERSION : "Qobuzify is on";
    head.appendChild(title);
    var x = UI._iconButton(X_SVG, "Dismiss"); x.addEventListener("click", closeWelcome); head.appendChild(x);
    el.appendChild(head);
    var body = document.createElement("div"); body.className = "qz-welcome-body";
    el.appendChild(body);
    if (mode === "new") {
      var ul = document.createElement("ul"); ul.className = "qz-notes";
      (notes || []).slice(0, 5).forEach(function (n) { var li = document.createElement("li"); li.textContent = n; ul.appendChild(li); });
      body.appendChild(ul);
    }
    var where = document.createElement("div"); where.className = "qz-welcome-where";
    where.textContent = "Themes, extensions and settings live under your avatar, in Qobuzify.";
    el.appendChild(where);
    var acts = document.createElement("div"); acts.className = "qz-welcome-actions";
    acts.appendChild(UI.button("Open Qobuzify", { onClick: function () { closeWelcome(); openQobuzify(); } }));
    acts.appendChild(UI.button("Got it", { primary: true, onClick: closeWelcome }));
    el.appendChild(acts);
    document.body.appendChild(el);
    welcomeEl = el;
    renderWelcomeRows();
    placeWelcome();
    window.addEventListener("resize", placeWelcome);
    requestAnimationFrame(function () { el.classList.add("qzu-in"); });
  }
  function renderWelcomeRows() {
    if (!welcomeEl || welcomeMode !== "first") return;
    var body = welcomeEl.querySelector(".qz-welcome-body");
    body.innerHTML = "";
    var sub = document.createElement("div"); sub.className = "qz-welcome-sub"; sub.textContent = "This is what is switched on. Change anything here or later.";
    body.appendChild(sub);
    var list = document.createElement("div"); list.className = "qz-welcome-list";
    function row(label, sub2, sw) {
      var r = document.createElement("div"); r.className = "qz-welcome-row";
      var t = document.createElement("div"); t.className = "qz-welcome-rowtext";
      var l = document.createElement("div"); l.className = "qz-welcome-rowlabel"; l.textContent = label; t.appendChild(l);
      if (sub2) { var s = document.createElement("div"); s.className = "qz-welcome-rowsub"; s.textContent = sub2; t.appendChild(s); }
      r.appendChild(t); r.appendChild(sw); list.appendChild(r);
    }
    var t = bySlug(lastTheme());
    row("Theme", t ? t.name || t.slug : "", UI["switch"]({ checked: !!activeSlug(), label: "Theme " + (t ? t.name : ""), onChange: function (on) {
      if (on) applyTheme(lastTheme()); else followQobuz();
    } }));
    (DATA.extensions || []).filter(function (e) { return e.defaultOn && extOnPlatform(e); }).forEach(function (e) {
      row(e.name || e.id, null, UI["switch"]({ checked: extEnabled(e.id), label: e.name || e.id, onChange: function (on) {
        var ok = setExtension(e.id, on);
        if (!ok) UI.toast("Couldn't start " + (e.name || e.id), { tone: "error" });
        refreshExtensions();
        return ok;
      } }));
    });
    body.appendChild(list);
  }
  function refreshWelcome() { if (welcomeEl && welcomeMode === "first") renderWelcomeRows(); }
  function maybeWelcome() {
    if (!firstRun || IS_ANDROID || lsGet("qobuzify:welcome")) return;
    var tries = 0;
    var iv = setInterval(function () {
      if (welcomeAnchor() || ++tries > 40) { clearInterval(iv); setTimeout(function () { showWelcome("first"); }, 1200); }
    }, 250);
  }
  // After an update (this build differs from the last one the user saw), show the release notes once.
  function maybeWhatsNew(j) {
    if (IS_ANDROID || firstRun || welcomeEl) return;
    var seen = lsGet(LS_SEEN_VERSION);
    if (seen === VERSION) return;
    if (j && j.latest === VERSION && j.notes && j.notes.length) showWelcome("new", j.notes);
    else lsSet(LS_SEEN_VERSION, VERSION);
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
  var loadingExtId = null;         // the extension whose body is running right now (registerSettings owner)
  var navItems = [];               // sidebar nav items added by extensions
  var playerSlots = { left: [], right: [] }; // player-bar buttons added by extensions (see Q.playerSlot)
  // Slots pinned to their zone's outer edge, so a narrow window hides them last. Lyrics is the button
  // people reach for most and it used to have the lowest order, which made it the first to vanish.
  // The value ranks them: higher sits further out. Full screen is outermost, lyrics just inside it.
  var OUTER_SLOTS = { "full-app-display": 2, "qz-lyrics": 1 };
  var API_TIMEOUT_MS = 15000;      // Q.api default; long callers pass { timeout }

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
  // --- back / forward arrows (wrapper only) -------------------------------------------------------
  // The stock Qobuz DESKTOP app draws history arrows immediately right of its logo. play.qobuz.com has
  // no equivalent control anywhere, so in the wrapper those arrows simply were not there and users who
  // came from the desktop app read it as missing functionality. The bake needs nothing: it IS the
  // desktop app and already has them. Gated on the preload bridge, so this is inert everywhere else.
  var NAV_SVG = {
    back: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 4 7 12l8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    forward: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 4l8 8-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  var navHistOff = null;
  function injectNavHistory() {
    var NAV = (typeof window !== "undefined" && window.__QZNAV__) || null;
    if (!NAV) return;                                   // bake, or a build without the bridge
    var brand = document.querySelector(".NavBar__brand");
    if (!brand || !brand.parentElement) return;
    var host = brand.parentElement;
    if (host.querySelector(".qz-navhist")) return;      // already placed (React re-render kept it)
    var wrap = document.createElement("div");
    wrap.className = "qz-navhist";
    ["back", "forward"].forEach(function (dir) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "qz-navhist-btn";
      b.setAttribute("data-qz-nav-dir", dir);
      b.setAttribute("aria-label", dir === "back" ? "Back" : "Forward");
      b.title = dir === "back" ? "Back" : "Forward";
      b.innerHTML = NAV_SVG[dir];
      b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); NAV.go(dir); });
      wrap.appendChild(b);
    });
    // Right of the logo, before the nav links - where the desktop app puts them.
    if (brand.nextSibling) host.insertBefore(wrap, brand.nextSibling); else host.appendChild(wrap);
    // Reflect real history state rather than guessing: main is the only side that knows.
    if (!navHistOff) {
      navHistOff = NAV.onState(function (s) {
        try {
          var w = document.querySelector(".qz-navhist");
          if (!w || !s) return;
          var bb = w.querySelector('[data-qz-nav-dir="back"]');
          var fb = w.querySelector('[data-qz-nav-dir="forward"]');
          if (bb) bb.disabled = !s.canBack;
          if (fb) fb.disabled = !s.canFwd;
        } catch (e) {}
      });
    }
    try { NAV.ask(); } catch (e) {}
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
      // the "..." overflow button (when present) leads the right zone, so slots line up after it
      var prev = (zone === "right" && slotMore && slotMore.parentNode === c) ? slotMore : null;
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
  // Hide an overflowing button WITHOUT reflowing its neighbours. This is the fix for the song-trashing
  // bug: the old guard used display:none, so hiding the innermost lyrics button on a tight bar let its
  // neighbour - the destructive Trash button - slide into the exact pixel lyrics had occupied, and a
  // muscle-memory tap binned the playing song. visibility:hidden keeps the slot's width, so every
  // button's position is permanent; pointer-events:none means a hidden button neither covers the
  // transport nor can be clicked. Empty gaps on a very narrow bar are the deliberate trade (positions
  // that never move beat a bar that packs tighter).
  function markSlotHidden(el, hidden) {
    el.style.visibility = hidden ? "hidden" : "";
    el.style.pointerEvents = hidden ? "none" : "";
  }
  function measureSlots() {
    // paired selectors: bake .pct-* form, web-player (wrapper) .player__action-* form - keyed on the
    // bake form alone this guard never ran on play.qobuz.com.
    var prev = document.querySelector(".pct-player-prev, .player__action-previous");
    var next = document.querySelector(".pct-player-next, .player__action-next");
    if (!prev && !next) return null;
    var GAP = 10, any = false;
    // Per-button overlap test. visibility:hidden elements still report their real layout rect, so a
    // widened window self-corrects: a button that no longer reaches the transport is shown again. The
    // set of hidden buttons is exactly those that individually cross the transport edge - no iteration,
    // no dependence on hide order, and (crucially) no neighbour ever shifts.
    // A button also counts as hidden when it spills out of its zone's own box: on a narrow window Qobuz
    // caps the settings cluster's first child with a max-width, and our overflow then sat underneath the
    // volume control, covered and unclickable.
    var right = document.querySelector(".player__settings > .qz-slot-right");
    if (right && next) {
      var nr = next.getBoundingClientRect(), zr = right.getBoundingClientRect();
      [].slice.call(right.children).forEach(function (b) {
        if (b === slotMore) return;
        var r = b.getBoundingClientRect();
        var hide = !!(r.width && (r.left < nr.right + GAP || r.right > zr.right + 1)); // inner (left) edge grows toward transport
        markSlotHidden(b, hide); if (hide) any = true;
      });
    }
    var left = document.querySelector(".player__track > .qz-slot-left");
    if (left && prev) {
      var pr = prev.getBoundingClientRect(), zl = left.getBoundingClientRect();
      [].slice.call(left.children).forEach(function (b) {
        var r = b.getBoundingClientRect();
        var hide = !!(r.width && (r.right > pr.left - GAP || r.right > zl.right + 1)); // inner (right) edge grows toward transport
        markSlotHidden(b, hide); if (hide) any = true;
      });
    }
    return any;
  }
  // Whatever the guard hides stays reachable from a "..." button at the start of the right zone (the one
  // spot that is never covered: the zone's far end is what Qobuz's own controls overlap on a narrow
  // window). It is only present while something is hidden. Adding it can hide more buttons and removing
  // it only frees space, so the layout settles in one extra pass and never oscillates.
  var slotMore = null;
  function moreButton() {
    if (slotMore) return slotMore;
    var b = document.createElement("button");
    b.type = "button"; b.className = "qz-pbtn qz-slot-more";
    b.setAttribute("aria-label", "More player controls"); b.title = "More player controls";
    b.setAttribute("aria-haspopup", "menu");
    b.innerHTML = DOTS_SVG;
    b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); openSlotOverflow(b); });
    slotMore = b;
    return b;
  }
  // A slot's name in the overflow menu. spec.label wins; otherwise its aria-label / title / text, cut to
  // the first clause when an extension put a whole status sentence in its tooltip.
  function slotName(s, el) {
    var n = (el === s.el && s.label) || el.getAttribute("aria-label") || el.title || (el.textContent || "").replace(/\s+/g, " ").trim() || s.label || s.id;
    if (n.length > 48) { var cut = n.split(/[:.;]/)[0].trim(); n = cut.length >= 6 && cut.length <= 48 ? cut : n.slice(0, 45).trim() + "..."; }
    return n;
  }
  function openSlotOverflow(anchor) {
    var items = [];
    playerSlots.left.concat(playerSlots.right).forEach(function (s) {
      if (!s.el || !s.el.isConnected || s.el.style.visibility !== "hidden") return;
      // A slot can be one button or a group (seek -10/+10): offer each real button in it.
      var targets = (s.el.matches && s.el.matches("button,[role=button]")) ? [s.el] : [].slice.call(s.el.querySelectorAll("button,[role=button]"));
      if (!targets.length) targets = [s.el];
      targets.forEach(function (t) { items.push({ label: slotName(s, t), onClick: function () { try { t.click(); } catch (e) {} } }); });
    });
    if (items.length) UI.menu(anchor, items, { align: "right" });
  }
  function fitPlayerSlots() {
    var any = measureSlots();
    if (any == null) return;
    var more = slotMore && slotMore.parentNode ? slotMore : null;
    if (any && !more) {
      var cr = slotContainer("right"); if (!cr) return;
      cr.insertBefore(moreButton(), cr.firstChild);
      measureSlots();
    } else if (!any && more) {
      more.remove();
    } else if (more && more.previousElementSibling) {
      more.parentNode.insertBefore(more, more.parentNode.firstChild); // keep it leading the zone
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
      // Theme API (CATALOG/accentOf/activeSlug/applyTheme are in-closure). Additive; benefits desktop + mobile.
      themes: function () { try { return (CATALOG || []).map(function (t) { return { slug: t.slug, name: t.name || t.slug, accent: accentOf(t) }; }); } catch (e) { return []; } },
      activeTheme: function () { try { return activeSlug(); } catch (e) { return null; } },
      applyTheme: function (slug) { try { if (!bySlug(slug)) return false; applyTheme(slug); return true; } catch (e) { return false; } },
      css: function (id, text) { var e = document.getElementById(id); if (!e) { e = document.createElement("style"); e.id = id; (document.head || document.documentElement).appendChild(e); } e.textContent = text; return e; },
      el: function (html) { var t = document.createElement("template"); t.innerHTML = (html || "").trim(); return t.content.firstElementChild; },
      storage: {
        get: function (k, d) { var v = lsGet("qobuzify:x:" + k); return v == null ? d : v; },
        // false when the write was refused (quota full, storage denied)
        set: function (k, v) { return lsSet("qobuzify:x:" + k, v); }
      },
      ui: UI,
      // Qobuz API with the in-app token (read endpoints: album/get, getFeatured, search...).
      // opts = { timeout: ms, signal: AbortSignal }. Every call is aborted after API_TIMEOUT_MS unless the
      // caller passes its own timeout (0 = none): with no limit, one hung request held whatever waited on
      // it forever (block-trash held track start on a track/get). A timeout rejects with an Error whose
      // name is "TimeoutError" and .timeout is true.
      api: function (methodPath, opts) {
        opts = opts || {};
        var token;
        try { token = QZ_STORE.getState().user.token; } catch (e) { return Promise.reject(e); }
        var ms = opts.timeout == null ? API_TIMEOUT_MS : (+opts.timeout || 0);
        var ctl = typeof AbortController === "function" ? new AbortController() : null;
        var timer = null, timedOut = false;
        if (ctl && ms > 0) timer = setTimeout(function () { timedOut = true; try { ctl.abort(); } catch (e) {} }, ms);
        if (ctl && opts.signal) {
          if (opts.signal.aborted) ctl.abort();
          else opts.signal.addEventListener("abort", function () { try { ctl.abort(); } catch (e) {} }, { once: true });
        }
        var init = { headers: { "X-App-Id": APP_ID, "X-User-Auth-Token": token } };
        if (ctl) init.signal = ctl.signal;
        return fetch("https://www.qobuz.com/api.json/0.2/" + methodPath, init)
          .then(function (r) { if (!r.ok) throw new Error("qobuz api " + methodPath + " -> " + r.status); return r.json(); })
          .then(function (j) { clearTimeout(timer); return j; }, function (e) {
            clearTimeout(timer);
            if (timedOut) { var te = new Error("qobuz api " + methodPath + " timed out after " + ms + "ms"); te.name = "TimeoutError"; te.timeout = true; throw te; }
            throw e;
          });
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
            // Featured artists Qobuz prints as PLAIN TEXT after the linked performer ("Halsey feat. Juice WRLD")
            // aren't /artist/ anchors, so artists[] misses them - and the lyric lookup then can't tell a solo
            // from its feat. version (they share title + Spotify id). Read them off the credit line: chop the
            // album text, then parse a trailing feat./ft./with credit. Rides the SAME scrape as artist/title
            // (already stability-gated in onChange), so it adds no new store-vs-DOM skew.
            var feats = [];
            try {
              var credit = meta ? meta.textContent : "";
              var albTxt = albumEl ? albumEl.textContent : "";
              if (albTxt) { var ax = credit.lastIndexOf(albTxt); if (ax >= 0) credit = credit.slice(0, ax); }
              var fm = /\b(?:feat\.?|ft\.?|featuring|with)\s+(.+?)\s*[-–—·]?\s*$/i.exec(credit.replace(/\s+/g, " ").trim());
              if (fm) feats = fm[1].split(/\s*(?:,|&|;|\band\b)\s*/i).map(cleanName).filter(Boolean);
            } catch (e) {}
            return {
              id: ct.id || null, title: titleEl ? titleEl.textContent.trim() : "",
              artists: artists, artist: artists[0] || "", album: albumEl ? albumEl.textContent.trim() : "",
              feats: feats, albumId: albumId, durationMs: ct.duration || 0, cover: img ? img.src : "", quality: p.quality || null
            };
          } catch (e) { return null; }
        },
        // Returns an unsubscribe. Unsubscribing also cancels a pending settle, so a consumer never hears
        // from a subscription it already ended (discord-rpc re-posted a presence after being disabled).
        onChange: function (fn) {
          var lastId = null, settleT = null, alive = true;
          try { lastId = QZ_STORE.getState().player.currentTrack && QZ_STORE.getState().player.currentTrack.id; } catch (e) {}
          // The store id flips BEFORE React repaints the player bar, so a synchronous getTrack()
          // here would pair the new id with the PREVIOUS track's DOM-scraped title/artist/cover (a
          // torn snapshot every consumer then had to debounce around). Defer the callback until the
          // scrape settles: poll until the title is non-empty and stable across two reads, capped
          // at ~1.5s, then deliver one coherent object. A cleared track (id null) has nothing to
          // scrape, so it fires right away.
          function settle(id, prevTitle, polls) {
            settleT = null;
            if (!alive) return;
            var t = Q.player.getTrack();
            var curId = null;
            try { var c = QZ_STORE.getState().player.currentTrack; curId = c && c.id; } catch (e) {}
            if (curId !== id) return; // superseded by another change; that change's own settle runs
            if (polls >= 10 || (t && (!t.id || (t.title && t.title === prevTitle)))) {
              try { fn(t); } catch (e) { try { console.error("[Qobuzify] onChange consumer failed:", e); } catch (_) {} }
              return;
            }
            settleT = setTimeout(function () { settle(id, (t && t.title) || "", polls + 1); }, 150);
          }
          var unsub = QZ_STORE.subscribe(function () {
            if (!alive) return;
            try {
              var ct = QZ_STORE.getState().player.currentTrack; var id = ct && ct.id;
              if (id !== lastId) {
                lastId = id;
                if (settleT) { clearTimeout(settleT); settleT = null; }
                settle(id, "", 0);
              }
            } catch (e) {}
          });
          return function () {
            alive = false;
            if (settleT) { clearTimeout(settleT); settleT = null; }
            try { unsub(); } catch (e) {}
          };
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
      // Add a row to the Qobuzify settings panel (avatar menu > Qobuzify). entry = {label, sub, button, onClick}.
      // Returns an unregister fn. Live-refreshes the panel if it's already open.
      // The row is tied to the extension that registered it (registration happens while it loads, or
      // pass entry.ext), so its card in the Extensions tab gets a Settings link to it.
      registerSettings: function (entry) {
        if (!entry || typeof entry.onClick !== "function") return function () {};
        try { entry.__ext = entry.ext || loadingExtId || null; } catch (e) {}
        extSettings.push(entry);
        refreshSettings(); refreshExtensions();
        return function () { var i = extSettings.indexOf(entry); if (i >= 0) { extSettings.splice(i, 1); refreshSettings(); refreshExtensions(); } };
      },
      // Read the registered rows back. The desktop panel is not the only settings surface any more: on
      // Android, mobile-app draws its own screen OVER the desktop DOM, so a row registered above was
      // rendered into a panel that is physically unreachable. That is how Last.fm shipped with a working
      // toggle and no way to sign in. Any host-drawn settings UI must render these too.
      settingsPanels: function () { return extSettings.slice(); },
      // Is this extension loaded? Host-drawn settings UI must ask rather than reimplement the rule: the
      // default now depends on the platform, and a settings screen that guesses differently from the
      // loader shows switches that disagree with reality.
      extEnabled: function (id) { try { return extEnabled(id); } catch (e) { return false; } },
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
      // Register a button in the player bar. spec = { id, zone:"left"|"right", order:number, el:HTMLElement,
      // outer:boolean, label:string }. The runtime places it (with spacing + keep-alive); the extension just
      // builds the element (use the .qz-pbtn class for a standard native-sized icon button). outer:true
      // pins it to the zone's outer edge, the last place a narrow window hides. label names it in the
      // overflow menu (falls back to aria-label / title). Returns { remove }.
      playerSlot: function (spec) {
        var zone = spec.zone === "left" ? "left" : "right";
        var order = spec.order || 0;
        // outermost = highest order on the right (buttons flow toward the window edge), lowest on the left
        if (spec.outer || OUTER_SLOTS[spec.id]) { var rank = OUTER_SLOTS[spec.id] || 0; order = zone === "right" ? 1e6 + rank : -1e6 - rank; }
        playerSlots[zone] = playerSlots[zone].filter(function (s) { return s.id !== spec.id; });
        playerSlots[zone].push({ id: spec.id, order: order, el: spec.el, label: spec.label || "" });
        injectPlayerSlots();
        return { remove: function () { playerSlots[zone] = playerSlots[zone].filter(function (s) { return s.id !== spec.id; }); var ex = document.querySelector('[data-qz-slot="' + spec.id + '"]'); if (ex) ex.remove(); fitPlayerSlots(); } };
      },
      // navigate the Qobuz router (connected-react-router action), with an <a>-click fallback
      navigate: function (path) {
        try { QZ_STORE.dispatch({ type: "@@router/CALL_HISTORY_METHOD", payload: { method: "push", args: [path] } }); }
        catch (e) { var a = document.createElement("a"); a.href = path; document.body.appendChild(a); a.click(); a.remove(); }
      }
    };
    return Q;
  }

  // On ANDROID nothing loads unless the user asks for it, except the two that are not really optional:
  // mobile-app IS the interface, and media-session is the lockscreen/Bluetooth bridge (its own switch
  // lives in Features). Everything else on a phone is either inert (it decorates the desktop layout the
  // mobile UI covers) or a deliberate opt-in, and running ~20 inert extensions on every boot costs
  // startup time and risk for nothing. Desktop is untouched: still default ON.
  var ANDROID_DEFAULT_ON = { "mobile-app": 1, "media-session": 1 };
  function extDefaultOn(id) {
    if (IS_ANDROID) return !!ANDROID_DEFAULT_ON[id];
    // Extensions ship OFF by default; one opts into a fresh-install default with manifest.defaultOn. The
    // curated on-by-default set is Quality of Life, Simple Client, For You, Lyrics and Better Search;
    // everything else the user turns on from the Marketplace. Adapted from @ruizlenato's PR #4 (the
    // opt-in flip), with our own default set. Existing installs are unaffected: a user who left an
    // extension on has its localStorage flag set, which wins over this default.
    var e = (DATA.extensions || []).filter(function (x) { return x.id === id; })[0];
    return !!(e && e.defaultOn);
  }
  function extEnabled(id) {
    var v = lsGet("qobuzify:ext:" + id);
    if (v === "0") return false;
    if (v === "1") return true;
    return extDefaultOn(id);   // never chosen: platform default
  }
  // Has this install run Qobuzify before? (any of our keys present). Read before boot writes anything.
  function installUsedBefore() {
    try {
      if (lsGet("qobuzify:seed") != null || lsGet("qobuzify:update-seen") != null || lsGet(LS_THEME) != null
          || lsGet(LS_ENABLED) != null || lsGet(LS_LANG) != null) return true;
      for (var i = 0; i < localStorage.length; i++) {
        if ((localStorage.key(i) || "").indexOf("qobuzify:ext:") === 0) return true;
      }
    } catch (e) {}
    return false;
  }
  // One-time grandfather for the opt-in flip. Until 0.3.5 every extension defaulted ON, so a user's
  // live set was "everything except what they explicitly switched off". 0.3.5 makes the default opt-in
  // (only the curated defaultOn set), which - with no stored choice for the rest - would silently strip
  // every passively-on extension from an existing install on update. So the first time this build runs
  // on an install that has been used before, pin the current set by writing an explicit "1" for every
  // extension that has no stored choice. Fresh installs have no prior state and keep the new defaults.
  // Desktop only: Android's default set is unchanged by 0.3.5, so seeding there would wrongly switch on
  // desktop-only extensions. Must run before boot() writes qobuzify:seed, or a fresh install reads as used.
  function migrateExtDefaults(usedBefore) {
    try {
      if (IS_ANDROID) return;
      if (lsGet("qobuzify:ext-defaults-v1")) return;
      if (usedBefore) {
        (DATA.extensions || []).forEach(function (ext) {
          var k = "qobuzify:ext:" + ext.id;
          if (lsGet(k) == null) lsSet(k, "1");
        });
      }
      lsSet("qobuzify:ext-defaults-v1", "1");
    } catch (e) {}
  }
  // Returns true when the extension is running (or will start once the app store is ready), false when
  // its body threw, so the caller can revert the switch and say so.
  function loadExtension(ext) {
    if (extCleanups[ext.id]) return true;
    if (!window.Qobuzify) return true; // not initialised yet: initExtensions loads every enabled one
    loadingExtId = ext.id;
    try {
      var fn = new Function("Qobuzify", "vendor", ext.source + "\n//# sourceURL=qobuzify-ext-" + ext.id + ".js");
      var cleanup = fn(window.Qobuzify, ext.vendor || "");
      extCleanups[ext.id] = typeof cleanup === "function" ? cleanup : function () {};
      delete extFailed[ext.id];
      return true;
    } catch (e) {
      try { console.error("[Qobuzify] extension '" + ext.id + "' failed:", e); } catch (_) {}
      extFailed[ext.id] = true;
      // drop anything it registered before throwing, so a dead extension leaves no live settings row
      extSettings = extSettings.filter(function (s) { return s.__ext !== ext.id; });
      return false;
    } finally { loadingExtId = null; }
  }
  function unloadExtension(id) { var c = extCleanups[id]; if (c) { try { c(); } catch (e) {} delete extCleanups[id]; } }

  function initExtensions() {
    window.Qobuzify = buildApi();
    // Locale override, store half (issue #11): the navigator spoof at the top wins the boot path,
    // but Qobuz's post-login hydration prefers persisted settings.language and the account zone
    // over navigator. Align the persisted value with the override once the store exists - the
    // SETTINGS_SET_LANGUAGE reducer flags it for storage, so Qobuz's own hydration then carries
    // the user's choice on every later boot. A renamed action type in a future bundle makes this a
    // no-op and behavior degrades to the navigator-only override, never a crash.
    try {
      var lp = lsGet(LS_LANG);
      var lst = QZ_STORE && QZ_STORE.getState().settings;
      if (lp && lst && lst.language !== lp) QZ_STORE.dispatch({ type: "SETTINGS_SET_LANGUAGE", language: lp });
      // Cleared back to System default and relaunched some other way: store the real system locale
      // (no spoof is installed this boot, so navigator.language is the system's).
      else if (!lp && lsGet(LS_LANG_RESET) && lst) {
        if (navigator.language && lst.language !== navigator.language) QZ_STORE.dispatch({ type: "SETTINGS_SET_LANGUAGE", language: navigator.language });
        lsDel(LS_LANG_RESET);
      }
    } catch (e) {}
    if (QZ_STORE) QZ_STORE.subscribe(function () {
      try { var loc = QZ_STORE.getState().router && QZ_STORE.getState().router.location; var path = loc && loc.pathname;
        if (path && path !== lastPath) { lastPath = path; routeCbs.forEach(function (f) { try { f(path); } catch (e) {} }); } } catch (e) {}
    });
    (DATA.extensions || []).forEach(function (ext) { if (extEnabled(ext.id)) loadExtension(ext); });
    refreshExtensions();
  }
  function initExtensionsWhenReady() {
    if (window.__QZ_EXT_INIT) return;
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (!QZ_STORE) QZ_STORE = findStore();
      if (QZ_STORE) { clearInterval(iv); window.__QZ_EXT_INIT = true; initExtensions(); }
      else if (tries > 60) {
        // On a slow cold start React can take well past 18s to mount; a hard stop here left every
        // extension silently dead for the whole session. Drop to a slow poll instead - it costs
        // nothing once the store appears and makes a late mount recoverable.
        clearInterval(iv);
        try { console.warn("[Qobuzify] app store not found after 18s - extensions delayed, retrying every 2.5s"); } catch (e) {}
        iv = setInterval(function () {
          if (!QZ_STORE) QZ_STORE = findStore();
          if (QZ_STORE) { clearInterval(iv); window.__QZ_EXT_INIT = true; initExtensions(); }
        }, 2500);
      }
    }, 300);
  }

  // --- boot ---
  function boot() {
    var usedBefore = installUsedBefore();
    firstRun = !usedBefore;
    // Grandfather existing installs onto the pre-0.3.5 all-on set before anything writes qobuzify:seed
    // (the seed write below would otherwise make a fresh install read as "used before").
    migrateExtDefaults(usedBefore);
    // a CLI `apply <theme>` bumps DATA.seed to assert its theme as the active one
    // on next launch; in-app picks afterwards still win until the next CLI apply.
    if (DATA.seed && lsGet("qobuzify:seed") !== String(DATA.seed)) {
      if (DATA.def && bySlug(DATA.def)) { lsSet(LS_THEME, DATA.def); lsSet(LS_ENABLED, "1"); }
      lsSet("qobuzify:seed", String(DATA.seed));
    }
    if (firstRun) lsSet(LS_SEEN_VERSION, VERSION); // a fresh install has nothing "new" to show
    setUiAccent(accentOf(bySlug(activeSlug())));
    injectUiStyle();
    var a = activeSlug();
    if (a) applyTheme(a, false); else { liveStyle().textContent = ""; markFollow(true); }
    injectMenu(); injectNavItems(); injectNavHistory();
    // re-inject whenever React re-renders the navbar (setTimeout, not rAF, so it
    // still fires when the window is backgrounded), coalesced to one run per burst.
    var pending;
    function schedule() { if (pending) return; pending = setTimeout(function () { pending = null; injectMenu(); injectNavItems(); injectNavHistory(); injectPlayerSlots(); syncAppearance(); }, 80); }
    // data-theme: Qobuz flipping light/dark re-syncs our UI roots (filtered, so it costs nothing else)
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-theme"] });
    // a pure window resize doesn't mutate the DOM, so the observer above won't fire - re-fit the
    // player-bar slots explicitly so buttons re-appear/hide as the window widens or narrows.
    var rzT; window.addEventListener("resize", function () { clearTimeout(rzT); rzT = setTimeout(fitPlayerSlots, 120); });
    // startup guarantee: poll until the navbar mounts, then stop
    var tries = 0;
    var iv = setInterval(function () { injectMenu(); injectNavItems(); injectNavHistory(); injectPlayerSlots(); if (++tries > 40 || document.querySelector('[data-qz="qobuzify"]')) clearInterval(iv); }, 250);

    // bring up the extension API + load enabled extensions once the store is ready
    initExtensionsWhenReady();

    // first launch: one card by the avatar saying what is on and where Qobuzify lives
    maybeWelcome();

    // check for a newer release (after startup settles) and prompt in-app if there is one
    setTimeout(checkForUpdate, 4000);
  }
  // Qobuzify wordmark (replaces the Qobuz logo in the NavBar); used as a mask, so only its alpha matters.
  var LOGO_URI = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5MzQgMjczIiBmaWxsPSJub25lIj48cGF0aCBkPSJNMTE0LjIwIDI1Ni4zNUwxMTQuMjAgMTgyLjY0UTEwNi43MCAxOTEuNDMgOTYuMTAgMTk2LjEyUTg1LjQ5IDIwMC44MCA3Mi40OCAyMDAuODBRNTcuNzIgMjAwLjgwIDQ0LjU5IDE5Mi44NFEzMS40NyAxODQuODcgMjMuNzMgMTcxLjM5UTE2IDE1Ny45MSAxNiAxNDIuMzNRMTYgMTI2LjM5IDIzLjg1IDExMi45MVEzMS41OSA5OS40NCA0NC42NSA5MS41OVE1Ny43MiA4My43MyA3Mi40OCA4My43M1E4NS40OSA4My43MyA5Ni4xMCA4OC40MlExMDYuNzAgOTMuMTEgMTE0LjIwIDEwMS45MEwxMTQuMjAgODUuODRMMTMzLjg5IDg1Ljg0TDEzMy44OSAyNTYuMzVMMTE0LjIwIDI1Ni4zNU03NS4wNiAxODEuNzBRODUuOTYgMTgxLjcwIDk0Ljg3IDE3Ni40M1ExMDMuODkgMTcxLjE2IDEwOS4wNSAxNjIuMTNRMTE0LjIwIDE1My4xMSAxMTQuMjAgMTQyLjMzUTExNC4yMCAxMzEuNTUgMTA5LjA1IDEyMi41MlExMDMuNzcgMTEzLjM4IDk0LjgxIDEwOC4xN1E4NS44NCAxMDIuOTUgNzUuMDYgMTAyLjk1UTY0LjI4IDEwMi45NSA1NS4yNiAxMDguMjNRNDYuMTIgMTEzLjUwIDQwLjkwIDEyMi41MlEzNS42OSAxMzEuNTUgMzUuNjkgMTQyLjMzUTM1LjY5IDE1My4xMSA0MC45NiAxNjIuMTNRNDYuMjMgMTcxLjI3IDU1LjI2IDE3Ni40OVE2NC4yOCAxODEuNzAgNzUuMDYgMTgxLjcwTTIyMi4wMiAyMDAuODBRMjA1Ljg0IDIwMC44MCAxOTIuMzcgMTkyLjk1UTE3OC43NyAxODUuMTAgMTcwLjg2IDE3MS42M1ExNjIuOTUgMTU4LjE1IDE2Mi45NSAxNDIuMzNRMTYyLjk1IDEyNi41MSAxNzAuOTIgMTEyLjkxUTE3OC44OSA5OS4zMiAxOTIuNDMgOTEuNTNRMjA1Ljk2IDgzLjczIDIyMi4wMiA4My43M1EyMzguMDcgODMuNzMgMjUxLjU1IDkxLjU5UTI2NS4wMiA5OS40NCAyNzIuODggMTEyLjk3UTI4MC43MyAxMjYuNTEgMjgwLjczIDE0Mi4zM1EyODAuNzMgMTU4LjM4IDI3Mi44OCAxNzEuNjNRMjY1LjAyIDE4NS4yMiAyNTEuNDkgMTkzLjAxUTIzNy45NSAyMDAuODAgMjIyLjAyIDIwMC44ME0yMjIuMDIgMTgxLjcwUTIzMi42OCAxODEuNzAgMjQxLjU5IDE3Ni40M1EyNTAuNDkgMTcxLjE2IDI1NS43NyAxNjIuMDJRMjYxLjA0IDE1Mi44OCAyNjEuMDQgMTQyLjMzUTI2MS4wNCAxMzEuNTUgMjU1Ljg4IDEyMi41MlEyNTAuNjEgMTEzLjM4IDI0MS41OSAxMDguMTdRMjMyLjU2IDEwMi45NSAyMjIuMDIgMTAyLjk1UTIxMS4xMiAxMDIuOTUgMjAyLjA5IDEwOC4yM1ExOTIuOTUgMTEzLjUwIDE4Ny44MCAxMjIuNTJRMTgyLjY0IDEzMS41NSAxODIuNjQgMTQyLjMzUTE4Mi42NCAxNTMuMTEgMTg3LjkxIDE2Mi4xM1ExOTMuMTkgMTcxLjI3IDIwMi4yMSAxNzYuNDlRMjExLjIzIDE4MS43MCAyMjIuMDIgMTgxLjcwTTM3MS40MyAyMDAuODBRMzU4LjQyIDIwMC44MCAzNDcuODIgMTk2LjEyUTMzNy4yMSAxOTEuNDMgMzI5LjcxIDE4Mi42NEwzMjkuNzEgMTk4LjcwTDMxMC4wMiAxOTguNzBMMzEwLjAyIDE4LjcwTDMyOS43MSAxOC43MEwzMjkuNzEgMTAxLjkwUTMzNy4yMSA5My4xMSAzNDcuODIgODguNDJRMzU4LjQyIDgzLjczIDM3MS40MyA4My43M1EzODYuNDMgODMuNzMgMzk5LjMyIDkxLjU5UTQxMi40NSA5OS41NSA0MjAuMTIgMTEzLjA5UTQyNy44MCAxMjYuNjMgNDI3LjgwIDE0Mi4zM1E0MjcuODAgMTU4LjAzIDQyMC4wNiAxNzEuNjNRNDEyLjMzIDE4NS4xMCAzOTkuMjYgMTkyLjk1UTM4Ni4yMCAyMDAuODAgMzcxLjQzIDIwMC44ME0zNjguNzMgMTgxLjcwUTM3OS42MyAxODEuNzAgMzg4LjU0IDE3Ni40M1EzOTcuNjggMTcxLjE2IDQwMi44OSAxNjIuMTNRNDA4LjExIDE1My4xMSA0MDguMTEgMTQyLjMzUTQwOC4xMSAxMzEuNDMgNDAyLjg0IDEyMi41MlEzOTcuNTYgMTEzLjM4IDM4OC41NCAxMDguMTdRMzc5LjUyIDEwMi45NSAzNjguNzMgMTAyLjk1UTM1OC4wNyAxMDIuOTUgMzQ5LjA1IDEwOC4yM1EzNDAuMDIgMTEzLjUwIDMzNC44NyAxMjIuNThRMzI5LjcxIDEzMS42NiAzMjkuNzEgMTQyLjMzUTMyOS43MSAxNTMuMTEgMzM0Ljk4IDE2Mi4xM1EzNDAuMTQgMTcxLjI3IDM0OS4xNiAxNzYuNDlRMzU4LjE5IDE4MS43MCAzNjguNzMgMTgxLjcwTTUwMC45MiAyMDAuODBRNDg4LjAzIDIwMC44MCA0NzguMTMgMTk1LjQ3UTQ2OC4yMyAxOTAuMTQgNDYyLjcyIDE4MC41M1E0NTcuMjEgMTcwLjkyIDQ1Ny4yMSAxNTguMjdMNDU3LjIxIDg1Ljg0TDQ3Ni42NiA4NS44NEw0NzYuNjYgMTU2LjYzUTQ3Ni42NiAxNjUuMDYgNDgwLjQ3IDE3MS4xNlE0ODQuMjggMTc3LjI1IDQ4OS42NyAxNzkuOTVRNDk1LjA2IDE4Mi42NCA1MDAuOTIgMTgyLjY0UTUwNi43OCAxODIuNjQgNTEyLjUyIDE3OS45NVE1MTguMjcgMTc3LjI1IDUyMS43OCAxNzEuODZRNTI1LjMwIDE2Ni40NyA1MjUuMzAgMTU2LjYzTDUyNS4zMCA4NS44NEw1NDQuNjMgODUuODRMNTQ0LjYzIDE1OC4yN1E1NDQuNjMgMTcwLjkyIDUzOS4xMyAxODAuNTNRNTMzLjYyIDE5MC4xNCA1MjMuNzEgMTk1LjQ3UTUxMy44MSAyMDAuODAgNTAwLjkyIDIwMC44ME01NjQuNTUgMTk4LjcwTDU2NC40NCAxODUuOTJMNjI2LjMxIDEwMy44OUw1NjcuMTMgMTAzLjg5TDU2Ny4xMyA4NS44NEw2NTMuNzMgODUuODRMNjUzLjczIDk4LjYyTDU5MS44NiAxODAuNjVMNjU1LjE0IDE4MC42NUw2NTUuMTQgMTk4LjcwTDU2NC41NSAxOTguNzBNNjg3LjcyIDE5OC43MEw2ODcuNzIgODUuODRMNzA3LjE3IDg1Ljg0TDcwNy4xNyAxOTguNzBMNjg3LjcyIDE5OC43ME02OTcuNTYgNjQuOThRNjkyLjE3IDY0Ljk4IDY4OC4yNSA2MS4xOFE2ODQuMzIgNTcuMzcgNjg0LjMyIDUyLjA5UTY4NC4zMiA0Ni41OSA2ODguMjUgNDIuODRRNjkyLjE3IDM5LjA5IDY5Ny41NiAzOS4wOVE3MDIuOTUgMzkuMDkgNzA2Ljc2IDQyLjg0UTcxMC41NyA0Ni41OSA3MTAuNTcgNTIuMDlRNzEwLjU3IDU3LjM3IDcwNi43MCA2MS4xOFE3MDIuODQgNjQuOTggNjk3LjU2IDY0Ljk4TTc1Mi45OSAxOTguNzBMNzUyLjk5IDEwMy44OUw3MzQuMDEgMTAzLjg5TDczNC4wMSA4NS44NEw3NTIuOTkgODUuODRMNzUyLjk5IDUxLjA0UTc1Mi45OSA0MC4zOCA3NTcuMTUgMzIuNDZRNzYxLjMxIDI0LjU1IDc2OC45MyAyMC4yOFE3NzYuNTUgMTYgNzg2LjYzIDE2UTc5MS40MyAxNiA3OTUuNTkgMTYuOTRRNzk5Ljc1IDE3Ljg4IDgwMS45OCAxOS40MEw4MDEuOTggMzguODVRNzk5LjQwIDM2Ljg2IDc5NS44OCAzNS42OVE3OTIuMzcgMzQuNTIgNzg4Ljk3IDM0LjUyUTc4MS41OSAzNC41MiA3NzcuMTMgMzkuNzNRNzcyLjY4IDQ0Ljk1IDc3Mi42OCA1My41MEw3NzIuNjggODUuODRMODAyLjQ1IDg1Ljg0TDgwMi40NSAxMDMuODlMNzcyLjY4IDEwMy44OUw3NzIuNjggMTk4LjcwTDc1Mi45OSAxOTguNzBNODIyLjEzIDI1Ni4zNUw4MjIuMTMgMjM3LjEzUTgzMC4yMiAyMzcuMTMgODMzLjUwIDIzNS4wMlE4MzYuMzEgMjMzLjE1IDgzOS4yNCAyMjZMODUwLjYxIDE5OC43MEw4MDQuNzkgODUuODRMODI2LjcwIDg1Ljg0TDg2MS44NiAxNzQuMDlMODk1LjAyIDg1Ljg0TDkxNy4xNyA4NS44NEw4NTYuODIgMjM1LjYxUTg1Mi4xMyAyNDUuMjIgODQ0Ljg3IDI1MC42MVE4MzYuNjYgMjU2LjM1IDgyMi4xMyAyNTYuMzUiIGZpbGw9IiNGRkZGRkYiIHN0cm9rZT0iI0ZGRkZGRiIgc3Ryb2tlLXdpZHRoPSIxMiIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PC9zdmc+";
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
    // Drawn as a mask filled with currentColor (not a white-filled image), so the wordmark takes the nav
    // bar's own text colour and stays visible in Qobuz's light appearance.
    ".NavBar__brand.icon-brand-medium{-webkit-mask:url(\"" + LOGO_URI + "\") left center/contain no-repeat!important;mask:url(\"" + LOGO_URI + "\") left center/contain no-repeat!important;background:currentColor!important;width:82px!important;height:24px!important;font-size:0!important;}.NavBar__brand.icon-brand-medium::before{content:none!important;background:none!important;-webkit-mask:none!important;mask:none!important;}",
    // Scrollbars app-wide, mixed from each scroller's own text colour so they read in Qobuz's light and
    // dark appearance alike (they were hardcoded white). The standard scrollbar-color has to be set: any
    // element using the standard scrollbar-width property (Qobuz's containers, plus our own
    // .qz-fy-track / #qz-foryou-page / search body, all do) makes Chromium ignore ::-webkit-scrollbar and
    // fall back to the native scrollbar unless scrollbar-color is given too. !important so it always wins.
    "*{scrollbar-color:color-mix(in srgb,currentColor 26%,transparent) transparent !important;scrollbar-width:thin;}",
    "::-webkit-scrollbar{width:12px;height:12px;}",
    "::-webkit-scrollbar-track{background:transparent !important;}",
    "::-webkit-scrollbar-thumb{background:color-mix(in srgb,currentColor 20%,transparent) !important;border-radius:8px;border:3px solid transparent;background-clip:padding-box;}",
    "::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,currentColor 32%,transparent) !important;background-clip:padding-box;}",
    "::-webkit-scrollbar-corner{background:transparent !important;}",
    ".qz-menuitem{cursor:pointer;}",
    ".qz-menuitem:focus-visible{outline:2px solid color-mix(in srgb,currentColor 70%,transparent);outline-offset:-2px;}",
    // --- Q.ui base. Every value comes from Qobuz's tokens (resolved under the data-theme our roots mirror)
    // or from currentColor, so nothing here is tied to dark mode. Kit pieces carry the variables too, so
    // they also work when an extension drops one into Qobuz's own page instead of one of our roots.
    ".qzu,.qzu-btn,.qzu-switch,.qzu-chip,.qzu-state{--qzu-fg:var(--token-text-primary,#fff);--qzu-fg2:var(--token-text-secondary,#bdbdbd);",
      "--qzu-surface:var(--token-color-surface-layer-primary,#242424);--qzu-line:color-mix(in srgb,currentColor 13%,transparent);",
      "--qzu-fill:color-mix(in srgb,currentColor 5%,transparent);--qzu-fill-hover:color-mix(in srgb,currentColor 10%,transparent);",
      "--qzu-accent:var(--qz-accent,#3DA8FE);--qzu-invert-bg:var(--token-color-surface-default-invert,#fff);",
      "--qzu-invert-fg:var(--token-text-invert,#242424);--qzu-error:var(--token-text-error,#ff6b6b);}",
    ".qzu{color:var(--qzu-fg);font-family:inherit;font-size:14px;line-height:1.4;text-align:left;}",
    // Qobuz's light surfaces are pure white; ours sit one step down its own grey ramp instead.
    ".qzu[data-theme=light]{--qzu-surface:var(--color-grey-20,#ededed);}",
    // With no Qobuzify theme (Follow Qobuz), the accent is Qobuz's own.
    "html.qz-follow .qzu,html.qz-follow .qzu-switch,html.qz-follow .qzu-chip{--qzu-accent:var(--token-text-accent,#ffcb74);}",
    ".qzu :focus-visible,.qzu-btn:focus-visible,.qzu-switch:focus-visible,.qzu-chip:focus-visible{outline:2px solid color-mix(in srgb,var(--qzu-fg,currentColor) 75%,transparent);outline-offset:2px;}",
    ".qzu :focus:not(:focus-visible){outline:none;}",
    ".qzu-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 14px;box-sizing:border-box;",
      "border-radius:999px;border:1px solid var(--qzu-line);background:transparent;color:inherit;font:inherit;font-size:13px;font-weight:600;",
      "white-space:nowrap;cursor:pointer;transition:background .15s,border-color .15s;}",
    ".qzu-btn:hover{background:var(--qzu-fill-hover);border-color:color-mix(in srgb,currentColor 24%,transparent);}",
    ".qzu-btn--primary,.qzu-btn--primary:hover{background:var(--qzu-invert-bg);color:var(--qzu-invert-fg);border-color:transparent;}",
    ".qzu-btn--primary:hover{background:color-mix(in srgb,var(--qzu-invert-bg) 85%,var(--qzu-invert-fg));}",
    ".qzu-btn--danger{color:var(--qzu-error);}",
    ".qzu-btn:disabled{opacity:.45;cursor:default;}",
    ".qzu-iconbtn{appearance:none;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:32px;height:32px;padding:0;border:0;",
      "border-radius:999px;background:transparent;color:inherit;opacity:.8;cursor:pointer;transition:background .15s,opacity .15s;}",
    ".qzu-iconbtn:hover{background:var(--qzu-fill-hover,rgba(127,127,127,.15));opacity:1;}",
    // switch (also styles the legacy .qz-switch rows extensions still inject into the Settings tab)
    ".qzu-switch,.qz-modal .qz-switch{position:relative;flex:0 0 auto;width:40px;height:24px;padding:0;border:0;border-radius:999px;cursor:pointer;",
      "color:inherit;background:color-mix(in srgb,var(--qzu-fg,currentColor) 28%,transparent);transition:background-color .15s;}",
    ".qzu-switch-knob,.qz-modal .qz-switch span{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;",
      "box-shadow:0 1px 2px rgba(0,0,0,.3);transition:left .16s;}",
    ".qzu-switch--on,.qz-modal .qz-switch--on{background:var(--qzu-accent,var(--qz-accent,#3DA8FE));}",
    ".qzu-switch--on .qzu-switch-knob,.qz-modal .qz-switch--on span{left:19px;}",
    ".qzu-switch:disabled{opacity:.45;cursor:default;}",
    ".qzu-chip{appearance:none;height:30px;padding:0 13px;box-sizing:border-box;border-radius:999px;border:1px solid var(--qzu-line);background:transparent;",
      "color:inherit;font:inherit;font-size:13px;font-weight:600;white-space:nowrap;cursor:pointer;transition:background .15s,border-color .15s;}",
    ".qzu-chip:hover{background:var(--qzu-fill-hover);}",
    ".qzu-chip--on,.qzu-chip--on:hover{background:var(--qzu-invert-bg);color:var(--qzu-invert-fg);border-color:transparent;}",
    // toasts: one stack, bottom-right, above the player bar, and above extension overlays (up to 2147483601)
    // so a toast fired from inside an extension's dialog is not hidden behind its backdrop
    ".qzu-toasts{position:fixed;right:20px;bottom:104px;z-index:2147483640;display:flex;flex-direction:column;align-items:flex-end;gap:10px;pointer-events:none;}",
    ".qzu-toast{pointer-events:auto;display:flex;align-items:flex-start;gap:6px;width:360px;max-width:calc(100vw - 40px);box-sizing:border-box;",
      "padding:10px 8px 14px 16px;border-radius:12px;background:var(--qzu-surface);color:var(--qzu-fg);border:1px solid var(--qzu-line);",
      "box-shadow:0 12px 32px rgba(0,0,0,.35);opacity:0;transform:translateY(8px);transition:opacity .2s ease,transform .2s ease;}",
    ".qzu-toast.qzu-in{opacity:1;transform:none;}",
    ".qzu-toast-main{flex:1;min-width:0;padding-top:6px;}",
    ".qzu-toast-title{font-weight:600;font-size:14px;margin-bottom:3px;}",
    ".qzu-toast-body{font-size:13px;color:var(--qzu-fg2);}",
    ".qzu-toast-body:first-child{color:var(--qzu-fg);}",
    ".qzu-toast--error{border-color:color-mix(in srgb,var(--qzu-error) 55%,transparent);}",
    ".qzu-toast-actions{display:flex;gap:8px;margin-top:12px;}",
    // menu
    ".qzu-menu{position:fixed;z-index:2147483004;min-width:200px;max-width:320px;padding:6px;box-sizing:border-box;border-radius:10px;",
      "background:var(--qzu-surface);border:1px solid var(--qzu-line);box-shadow:0 12px 32px rgba(0,0,0,.35);}",
    ".qzu-menu-item{appearance:none;display:flex;align-items:center;gap:10px;width:100%;min-height:36px;padding:0 12px;border:0;border-radius:6px;",
      "background:transparent;color:inherit;font:inherit;font-size:14px;text-align:left;cursor:pointer;}",
    ".qzu-menu-item:hover,.qzu-menu .qzu-menu-item:focus-visible{background:var(--qzu-fill-hover);outline:none;}",
    ".qzu-menu-item:disabled{opacity:.45;cursor:default;background:transparent;}",
    ".qzu-menu-item--danger{color:var(--qzu-error);}",
    ".qzu-menu-ico{font-size:18px;line-height:1;opacity:.85;}",
    ".qzu-menu-sep{height:1px;margin:6px 4px;background:var(--qzu-line);}",
    // sheet
    ".qzu-sheet-back{position:fixed;inset:0;z-index:2147483002;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);",
      "opacity:0;transition:opacity .16s ease;}",
    ".qzu-sheet-back.qzu-in{opacity:1;}",
    ".qzu-sheet{width:min(480px,92vw);max-height:84vh;display:flex;flex-direction:column;box-sizing:border-box;border-radius:14px;background:var(--qzu-surface);",
      "border:1px solid var(--qzu-line);box-shadow:0 24px 64px rgba(0,0,0,.45);overflow:hidden;}",
    ".qzu-sheet-head{display:flex;align-items:center;gap:12px;padding:12px 12px 4px 20px;}",
    ".qzu-sheet-head .qzu-iconbtn{margin-left:auto;}",
    ".qzu-sheet-title{flex:1;font-size:17px;font-weight:600;}",
    ".qzu-sheet-body{padding:6px 20px 16px;overflow:auto;font-size:14px;color:var(--qzu-fg2);}",
    ".qzu-sheet-actions{display:flex;justify-content:flex-end;gap:8px;padding:8px 20px 18px;}",
    "@media (max-width:600px){.qzu-sheet-back{align-items:flex-end;}.qzu-sheet{width:100%;border-radius:14px 14px 0 0;}}",
    // empty / error states
    ".qzu-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:40px 20px;text-align:center;}",
    ".qzu-state-ico{font-size:30px;line-height:1;opacity:.6;}",
    ".qzu-state-title{font-size:15px;font-weight:600;}",
    ".qzu-state-text{font-size:13px;color:var(--qzu-fg2);max-width:420px;}",
    ".qzu-state .qzu-btn{margin-top:6px;}",
    ".qzu-state--error .qzu-state-title{color:var(--qzu-error);}",
    // --- the Qobuzify modal. Scoped under .qz-modal: the qz- namespace is shared with extensions, and the
    // old unscoped .qz-card/.qz-grid rules leaked into mobile-app's cards.
    ".qz-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);",
      "opacity:0;transition:opacity .16s ease;}",
    ".qz-overlay.qz-show{opacity:1;}",
    ".qz-modal{width:min(1040px,94vw);height:min(800px,88vh);display:flex;flex-direction:column;box-sizing:border-box;background:var(--qzu-surface);",
      "color:var(--qzu-fg);border:1px solid var(--qzu-line);border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.45);overflow:hidden;",
      "transform:translateY(6px);transition:transform .18s ease;}",
    ".qz-show .qz-modal{transform:none;}",
    ".qz-modal .qz-head{display:flex;align-items:center;gap:32px;padding:0 14px 0 24px;height:60px;flex:0 0 auto;border-bottom:1px solid var(--qzu-line);}",
    ".qz-modal .qz-title{font-size:18px;font-weight:700;}",
    ".qz-modal .qz-tabs{display:flex;align-self:stretch;gap:24px;}",
    ".qz-modal .qz-tab{appearance:none;position:relative;border:0;background:transparent;color:var(--qzu-fg2);font:inherit;font-size:14px;font-weight:600;",
      "padding:0 2px;cursor:pointer;transition:color .15s;}",
    ".qz-modal .qz-tab:hover,.qz-modal .qz-tab--active{color:var(--qzu-fg);}",
    ".qz-modal .qz-tab--active::after{content:'';position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px;background:var(--qzu-accent);}",
    ".qz-modal .qz-tab:focus-visible{outline-offset:-4px;}",
    ".qz-modal .qz-close{margin-left:auto;}",
    ".qz-modal .qz-body{flex:1;min-height:0;padding:20px 24px 24px;overflow:auto;}",
    ".qz-modal .qz-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;}",
    ".qz-modal .qz-grid--ext{grid-template-columns:repeat(auto-fill,minmax(290px,1fr));}",
    ".qz-modal .qz-card{display:flex;flex-direction:column;background:var(--qzu-fill);border:1px solid var(--qzu-line);border-radius:12px;overflow:hidden;transition:border-color .15s;}",
    ".qz-modal .qz-card:hover{border-color:color-mix(in srgb,currentColor 22%,transparent);}",
    ".qz-modal .qz-card--active,.qz-modal .qz-card--active:hover{border-color:var(--qzu-accent);box-shadow:inset 0 0 0 1px var(--qzu-accent);}",
    ".qz-modal .qz-prev{position:relative;height:96px;padding:10px;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;flex:0 0 auto;}",
    ".qz-modal .qz-prev--follow{flex-direction:row;padding:0;gap:0;}",
    ".qz-modal .qz-prev-half{flex:1;padding:10px;display:flex;flex-direction:column;gap:8px;}",
    ".qz-modal .qz-prev-bar{height:12px;border-radius:4px;width:70%;}",
    ".qz-modal .qz-prev-row{display:flex;align-items:center;gap:9px;}",
    ".qz-modal .qz-prev-play{width:24px;height:24px;border-radius:50%;flex:0 0 auto;}",
    ".qz-modal .qz-prev-lines{flex:1;display:flex;flex-direction:column;gap:5px;}",
    ".qz-modal .qz-prev-lines i{height:6px;border-radius:4px;display:block;width:85%;}",
    ".qz-modal .qz-prev-chip{position:absolute;right:10px;bottom:10px;width:34px;height:16px;border-radius:5px;box-sizing:border-box;}",
    ".qz-modal .qz-card-body{flex:1;padding:12px 14px 14px;display:flex;flex-direction:column;}",
    ".qz-modal .qz-card-top{display:flex;align-items:center;justify-content:space-between;gap:10px;}",
    ".qz-modal .qz-card-name{font-weight:600;font-size:14px;display:flex;align-items:center;min-width:0;}",
    ".qz-modal .qz-card-desc{font-size:12.5px;color:var(--qzu-fg2);margin:4px 0 12px;line-height:1.45;flex:1;}",
    ".qz-modal .qz-card--active .qz-apply{background:var(--qzu-invert-bg);color:var(--qzu-invert-fg);border-color:transparent;cursor:default;}",
    ".qz-modal .qz-ext-bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin-bottom:16px;}",
    ".qz-modal .qz-search{appearance:none;flex:0 1 260px;min-width:180px;height:32px;box-sizing:border-box;padding:0 14px;border-radius:999px;",
      "border:1px solid var(--qzu-line);background:var(--qzu-fill);color:inherit;font:inherit;font-size:13px;}",
    ".qz-modal .qz-search::placeholder{color:var(--qzu-fg2);opacity:1;}",
    ".qz-modal .qz-chips{display:flex;flex-wrap:wrap;gap:6px;}",
    ".qz-modal .qz-ext-count{margin-left:auto;font-size:12.5px;color:var(--qzu-fg2);white-space:nowrap;}",
    ".qz-modal .qz-ext-ico{font-size:18px;line-height:1;margin-right:10px;flex:0 0 auto;opacity:.85;}",
    ".qz-modal .qz-ext-desc{font-size:12.5px;color:var(--qzu-fg2);margin-top:6px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;",
      "-webkit-box-orient:vertical;overflow:hidden;}",
    ".qz-modal .qz-ext-desc--open{display:block;overflow:visible;}",
    ".qz-modal .qz-ext-more,.qz-modal .qz-ext-settings,.qz-modal .qz-link{appearance:none;border:0;background:none;padding:0;font:inherit;font-size:12.5px;",
      "font-weight:600;color:var(--qzu-fg);cursor:pointer;text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 35%,transparent);",
      "text-underline-offset:3px;}",
    ".qz-modal .qz-ext-more{align-self:flex-start;margin-top:4px;}",
    ".qz-modal .qz-ext-more[hidden],.qz-modal .qz-ext-err[hidden]{display:none;}",
    ".qz-modal .qz-ext-meta{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:auto;padding-top:12px;font-size:12px;color:var(--qzu-fg2);}",
    ".qz-modal .qz-ext-err{margin-top:8px;font-size:12.5px;font-weight:600;color:var(--qzu-error);}",
    ".qz-modal .qz-set-head{font-size:13px;font-weight:600;color:var(--qzu-fg2);margin:26px 4px 2px;}",
    ".qz-modal .qz-panel>.qz-set-head:first-child,.qz-modal .qz-set-update+.qz-set-head{margin-top:2px;}",
    ".qz-modal .qz-set-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:14px 4px;border-bottom:1px solid var(--qzu-line);",
      "transition:background .3s;}",
    ".qz-modal .qz-set-row--hl{background:var(--qzu-fill-hover);}",
    ".qz-modal .qz-set-text{min-width:0;}",
    ".qz-modal .qz-set-label{font-weight:600;font-size:14px;}",
    ".qz-modal .qz-set-sub{font-size:12.5px;color:var(--qzu-fg2);margin-top:3px;}",
    ".qz-modal .qz-set-update,.qz-modal .qz-set-notice{border:1px solid var(--qzu-line);border-radius:12px;padding:14px 16px;background:var(--qzu-fill);margin:6px 0;}",
    ".qz-modal .qz-select{height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--qzu-line);background:var(--qzu-fill);color:inherit;font:inherit;font-size:13px;cursor:pointer;}",
    ".qz-modal .qz-select option{background:var(--qzu-surface);color:var(--qzu-fg);}",
    ".qz-modal .qz-set-about{margin-top:8px;}",
    ".qz-modal .qz-set-about-line{font-size:12.5px;color:var(--qzu-fg2);padding:8px 4px 6px;}",
    ".qz-modal .qz-set-links{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:2px 4px;color:var(--qzu-fg2);font-size:12.5px;}",
    // release notes + the inline update command (toast, settings row, what's-new card)
    ".qzu .qz-notes{list-style:disc;margin:8px 0 2px;padding-left:18px;font-size:12.5px;line-height:1.5;color:var(--qzu-fg2);}",
    ".qzu .qz-update-help{margin-top:10px;}",
    ".qzu .qz-update-help:empty{display:none;}",
    ".qzu .qz-update-lead{font-size:12.5px;color:var(--qzu-fg2);margin-bottom:6px;}",
    ".qzu .qz-update-cmdrow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}",
    ".qzu .qz-update-cmd{flex:1 1 220px;min-width:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;padding:7px 10px;border-radius:8px;",
      "background:var(--qzu-fill-hover);color:var(--qzu-fg);user-select:all;word-break:break-all;}",
    ".qzu .qz-update-status{font-size:12.5px;font-weight:600;color:var(--qzu-fg);}",
    // first-run / what's-new card, anchored under the avatar
    ".qz-welcome{position:fixed;z-index:2147482999;width:340px;max-width:calc(100vw - 24px);box-sizing:border-box;padding:4px 16px 16px;border-radius:14px;",
      "background:var(--qzu-surface);border:1px solid var(--qzu-line);box-shadow:0 18px 48px rgba(0,0,0,.4);opacity:0;transform:translateY(-6px);",
      "transition:opacity .18s ease,transform .18s ease;}",
    ".qz-welcome.qzu-in{opacity:1;transform:none;}",
    ".qz-welcome-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-right:-8px;min-height:44px;}",
    ".qz-welcome-title{font-size:16px;font-weight:700;}",
    ".qz-welcome-sub{font-size:12.5px;color:var(--qzu-fg2);}",
    ".qz-welcome-list{margin-top:6px;}",
    ".qz-welcome-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--qzu-line);}",
    ".qz-welcome-row:last-child{border-bottom:0;}",
    ".qz-welcome-rowlabel{font-size:14px;font-weight:600;}",
    ".qz-welcome-rowsub{font-size:12px;color:var(--qzu-fg2);}",
    ".qz-welcome-where{font-size:12.5px;color:var(--qzu-fg2);margin-top:10px;}",
    ".qz-welcome-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;}",
    // shared player-bar button slots (Q.playerSlot): auto-spaced zones + a native-sized icon button helper
    // Back/forward arrows (wrapper only). Sized and spaced to sit between the logo and the nav links
    // without shifting them; -webkit-app-region:no-drag because the top bar is a window drag handle and
    // a draggable region swallows clicks.
    ".qz-navhist{display:inline-flex;align-items:center;gap:2px;margin:0 6px 0 10px;-webkit-app-region:no-drag;}",
    ".qz-navhist-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;",
    "border:0;border-radius:999px;background:transparent;color:currentColor;cursor:pointer;opacity:.75;",
    "transition:background .15s,opacity .15s;}",
    ".qz-navhist-btn:hover:not(:disabled){background:color-mix(in srgb,currentColor 12%,transparent);opacity:1;}",
    ".qz-navhist-btn:disabled{opacity:.28;cursor:default;}",
    // Shrinkable on purpose. `.player__track` is a FIXED-width column (native: calc(50vw - 156px)) whose
    // other children refuse to give: the cover is flex:none, .player__track-infos stops at min-width:200px,
    // and .player__track-time can't go below its min-content. So every pixel this slot takes pushes the
    // native duration readout PAST the column's right edge, where it gets cut off ("00:01 - 05:05" showing
    // as "00:01 - 05" - reported with a long album/playlist name widening the playlist-context chip).
    // Measured at a 1600px window: a short album name overflowed 0px, a long one 103px. Letting the slot
    // shrink hands the pressure to the chip (the only child that can give - the icon buttons stay
    // flex:0 0 auto and keep their size) so the chip ellipsizes instead of the timer being shoved out.
    ".qz-slot-left{display:inline-flex;align-items:center;gap:4px;padding:0 8px;flex:0 1 auto;min-width:0;}",
    // Buttons flow in ascending `order` left-to-right, so the highest-order button sits at the OUTER (right)
    // edge and the lowest nearest the centred transport. Full App Display is pinned outermost and lyrics
    // just inside it (OUTER_SLOTS). fitPlayerSlots drops from the inner edge on narrow windows, so the outer buttons
    // survive longest, and whatever it drops is listed under the "..." button.
    ".qz-slot-right{display:inline-flex;align-items:center;gap:8px;margin-right:14px;flex:0 0 auto;}",
    ".qz-pbtn{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;appearance:none;border:0;border-radius:9px;",
      "background:transparent;color:color-mix(in srgb,currentColor 82%,transparent);cursor:pointer;transition:background .15s,color .12s,transform .08s;flex:0 0 auto;padding:0;line-height:1;}",
    ".qz-pbtn:focus-visible,.qz-navhist-btn:focus-visible{outline:2px solid color-mix(in srgb,currentColor 75%,transparent);outline-offset:1px;}",
    ".qz-pbtn:hover{background:color-mix(in srgb,var(--qz-accent,#3DA8FE) 18%,transparent);color:var(--qz-accent,#3DA8FE);}",
    ".qz-pbtn:active{transform:scale(.9);}",
    ".qz-pbtn svg{width:22px;height:22px;display:block;pointer-events:none;}",
    ".qz-pbtn>[class*='icon-']{font-size:22px;line-height:1;pointer-events:none;}"
  ].join("");

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
