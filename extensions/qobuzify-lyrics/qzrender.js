// Qobuzify Lyrics renderer - our OWN karaoke engine, built to replace the Qz Lyrics vendor.
//
// WHY: the vendor's react-virtual list DESTROYS + RECREATES its rows on every auto-scroll. For the frames
// that takes, the fresh rows have no state class, so they render in the CSS default (bright + flat) = the
// mid-song "everything flashes white/black then re-renders" bug. It lives inside the licensed 1.3MB bundle,
// so we can't fix it there. This engine renders STABLE nodes: every line + word is built once per track and
// never destroyed; a single rAF tick only mutates styles (active-line emphasis, per-word fill) and lerps the
// scroll. Nothing is torn down on scroll, so there is no recreate and no flash - by construction.
//
// Input = our internal finalized lyrics (times in SECONDS):
//   { Type:"Syllable"|"Line", Content:[ { Lead:{StartTime,EndTime,Syllables:[{Text,StartTime,EndTime,IsPartOfWord}]},
//                                          Background?:[...], OppositeAligned?:bool }  |  {Text,StartTime,EndTime} ] }
// API: var r = QZLyricsRenderer.make({ mount, getPos, isPlaying, onSeek }); r.render(lyrics); r.start(); ... r.destroy();
(function (global) {
  "use strict";
  var LEAD_MS = 0;          // (offset already baked into getPos)
  var FOLLOW = 0.3;         // scroll lerp factor per frame (0..1); higher = snappier follow (keeps active line centered on fast songs)
  var CENTER_BIAS = 0.46;   // active line target: this fraction down the viewport (0.5 = dead center)
  var GRACE_MS = 400;       // keep a line "active" this long past its EndTime before advancing (fills gaps)

  var CSS = [
    ".qzl-root{position:absolute;inset:0;overflow:hidden;font-family:inherit;direction:ltr;text-align:left;}",
    ".qzl-scroller{position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:none;-ms-overflow-style:none;}",
    ".qzl-scroller::-webkit-scrollbar{display:none;}",
    ".qzl-content{padding:0 clamp(20px,4vw,64px);box-sizing:border-box;max-width:min(1180px,92vw);margin:0 auto;text-align:left;}",
    ".qzl-spacer-top{height:42vh;}.qzl-spacer-bottom{height:56vh;}",
    // base line = DIM by default, so a line is NEVER bright before its state is set (no classless flash possible)
    ".qzl-line{margin:0 0 .42em;font-weight:800;font-size:clamp(26px,3.1vw,48px);line-height:1.2;letter-spacing:-.015em;",
    "text-align:left;white-space:normal;overflow-wrap:break-word;word-break:normal;max-width:100%;",
    "opacity:.44;transform-origin:left center;scale:1;cursor:pointer;transition:opacity .28s cubic-bezier(.4,0,.2,1),scale .3s cubic-bezier(.2,.7,.2,1.2);will-change:opacity,scale;}",
    ".qzl-line.qzl-opp{text-align:left;}",   // duet/OppositeAligned right-align deferred to Phase 2 (was clipping)
    ".qzl-line.qzl-sung{opacity:.4;}",        // past lines: flat dim
    ".qzl-line.qzl-next{opacity:.4;}",        // upcoming: flat dim
    ".qzl-line.qzl-active{opacity:1;scale:1.05;}",
    ".qzl-line:hover{opacity:.7;}",
    ".qzl-line.qzl-active:hover{opacity:1;}",
    // word-by-word fill: white sweeps left->right as --fill goes 0->100%, soft leading edge. Unsung stays a
    // VISIBLE grey (dimming is the LINE opacity's job, not the word's - double-dimming made upcoming lines invisible).
    ".qzl-word{background-image:linear-gradient(90deg,var(--qzl-sung,#fff) calc(var(--fill,0%) - 6%),var(--qzl-unsung,rgba(255,255,255,.62)) var(--fill,0%));-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;}",
    ".qzl-line.qzl-active .qzl-word{--qzl-sung:#fff;--qzl-unsung:rgba(255,255,255,.3);}",
    // within the active line: exactly ONE word (the current one) carries the bright white sweep.
    // already-sung words settle to a calm medium so a run of them doesn't read as a block of
    // bright white - that block was the 'N words illuminated at once' complaint.
    ".qzl-line.qzl-active .qzl-word.qzl-w-sung{--qzl-sung:rgba(255,255,255,.58);--qzl-unsung:rgba(255,255,255,.58);}",
    // every NON-active line: flat dim text, no gradient (kills 'progress on 3 lines at once').
    ".qzl-line:not(.qzl-active) .qzl-word{background-image:none;color:rgba(255,255,255,.92);-webkit-text-fill-color:rgba(255,255,255,.92);}",
    ".qzl-bg{font-size:.62em;opacity:.75;margin-top:.1em;font-weight:700;}",
    ".qzl-musical{opacity:.32;}.qzl-musical.qzl-active{opacity:.85;}",
    ".qzl-dots{display:inline-flex;gap:.28em;}",
    ".qzl-dot{width:.34em;height:.34em;border-radius:50%;background:#fff;opacity:.5;transition:opacity .25s,scale .25s;}",
    ".qzl-musical.qzl-active .qzl-dot{opacity:.9;}",
    // close (X) button, centered at the top like the vendor's
    ".qzl-close{position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:5;width:38px;height:38px;border:0;border-radius:50%;",
    "background:rgba(255,255,255,.08);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);transition:background .15s,scale .12s;}",
    ".qzl-close:hover{background:rgba(255,255,255,.18);scale:1.08;}",
    ".qzl-close svg{width:18px;height:18px;stroke:currentColor;stroke-width:2.4;fill:none;stroke-linecap:round;}",
    ".qzl-status{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:rgba(255,255,255,.7);font-size:clamp(16px,1.8vw,24px);font-weight:600;text-align:center;letter-spacing:.01em;}"
  ].join("");
  function injectCSS() { if (document.getElementById("qzl-css")) return; var s = document.createElement("style"); s.id = "qzl-css"; s.textContent = CSS; document.head.appendChild(s); }

  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function isMusical(item) {
    // an instrumental break: a Lead with no real syllable text, or an explicitly empty line
    if (!item) return false;
    var L = item.Lead;
    if (L && L.Syllables && L.Syllables.length) {
      var t = L.Syllables.map(function (s) { return (s.Text || "").trim(); }).join("");
      return t.length === 0;
    }
    return !L && !(item.Text && item.Text.trim());
  }

  function make(opts) {
    var mount = opts.mount, getPos = opts.getPos, isPlaying = opts.isPlaying, onSeek = opts.onSeek || function () {}, onClose = opts.onClose || function () {};
    var root = null, scroller = null, content = null, lines = [], _statusEl = null;
    function status(msg) {
      injectCSS();
      if (!msg) { if (_statusEl) { _statusEl.remove(); _statusEl = null; } return; }
      if (!_statusEl) { _statusEl = el("div", "qzl-status"); mount.appendChild(_statusEl); }
      _statusEl.textContent = msg;
    }
    var raf = null, running = false, curActive = -1, userScrollUntil = 0, destroyed = false;
    var nativeRAF = (global.__QZ_SL_nativeRAF) || (window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : function (f) { return setTimeout(function () { f(performance.now()); }, 16); });

    // ---- build the DOM once ---------------------------------------------------
    function buildWords(lineEl, syls) {
      // group syllables into words: a syllable with IsPartOfWord joins the NEXT one (no space between)
      var words = [], cur = null;
      for (var i = 0; i < syls.length; i++) {
        var s = syls[i];
        if (!cur) { cur = { el: el("span", "qzl-word"), syls: [], start: s.StartTime, end: s.EndTime }; }
        var sy = el("span", "qzl-syl"); sy.textContent = (s.Text || "").replace(/^\s+|\s+$/g, ""); // trim ends; word gaps come from the space node below (source syllables carry trailing spaces -> double space bug)
        cur.el.appendChild(sy);
        cur.syls.push({ el: sy, start: s.StartTime, end: s.EndTime });
        cur.end = s.EndTime;
        // a syllable NOT part of a word ends the word; add a trailing space unless it's the last
        if (!s.IsPartOfWord) {
          words.push(cur); lineEl.appendChild(cur.el);
          if (i < syls.length - 1) lineEl.appendChild(document.createTextNode(" "));
          cur = null;
        }
      }
      if (cur) { words.push(cur); lineEl.appendChild(cur.el); }
      return words;
    }

    function render(lyrics) {
      destroyLines(); injectCSS(); status(null);
      root = el("div", "qzl-root");
      scroller = el("div", "qzl-scroller");
      content = el("div", "qzl-content");
      scroller.appendChild(content); root.appendChild(scroller);
      var closeBtn = el("button", "qzl-close"); closeBtn.type = "button"; closeBtn.title = "Close lyrics";
      closeBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      closeBtn.addEventListener("click", function (e) { e.stopPropagation(); try { onClose(); } catch (x) {} });
      root.appendChild(closeBtn);
      mount.appendChild(root);
      // top/bottom spacers so the first + last lines can center in the viewport
      content.appendChild(el("div", "qzl-spacer qzl-spacer-top"));
      var items = (lyrics && lyrics.Content) || [];
      var syllable = lyrics && lyrics.Type === "Syllable";
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var lineEl = el("div", "qzl-line");
        var meta = { el: lineEl, start: 0, end: 0, words: [], musical: false };
        if (isMusical(item)) {
          lineEl.classList.add("qzl-musical");
          var dg = el("span", "qzl-dots");
          dg.appendChild(el("span", "qzl-dot")); dg.appendChild(el("span", "qzl-dot")); dg.appendChild(el("span", "qzl-dot"));
          lineEl.appendChild(dg);
          var L0 = item.Lead || item;
          meta.start = (L0.StartTime || 0) * 1000; meta.end = (L0.EndTime || meta.start / 1000) * 1000; meta.musical = true;
        } else if (syllable && item.Lead && item.Lead.Syllables) {
          meta.start = (item.Lead.StartTime || 0) * 1000; meta.end = (item.Lead.EndTime || 0) * 1000;
          meta.words = buildWords(lineEl, item.Lead.Syllables);
          if (item.OppositeAligned) lineEl.classList.add("qzl-opp");
          // background vocals -> a smaller sub-line under the lead
          if (item.Background && item.Background.length) {
            for (var b = 0; b < item.Background.length; b++) {
              var bg = item.Background[b]; if (!bg || !bg.Syllables) continue;
              var bgEl = el("div", "qzl-bg");
              var bgWords = buildWords(bgEl, bg.Syllables);
              lineEl.appendChild(bgEl);
              meta.words = meta.words.concat(bgWords);
            }
          }
        } else { // Line-type (no per-word timing)
          var txt = (item.Text || (item.Lead && item.Lead.Text) || "").trim();
          var w = el("span", "qzl-word"); w.textContent = txt; lineEl.appendChild(w);
          meta.start = ((item.StartTime != null ? item.StartTime : (item.Lead && item.Lead.StartTime)) || 0) * 1000;
          meta.end = ((item.EndTime != null ? item.EndTime : (item.Lead && item.Lead.EndTime)) || 0) * 1000;
          meta.words = [{ el: w, syls: [{ el: w, start: meta.start / 1000, end: meta.end / 1000 }], start: meta.start / 1000, end: meta.end / 1000 }];
        }
        (function (idx) { lineEl.addEventListener("click", function () { try { onSeek(meta.start); } catch (e) {} }); })(i);
        content.appendChild(lineEl);
        lines.push(meta);
      }
      content.appendChild(el("div", "qzl-spacer qzl-spacer-bottom"));
      curActive = -1;
      // user-scroll detection: pause auto-follow briefly when the user scrolls/wheels
      scroller.addEventListener("wheel", markUser, { passive: true });
      scroller.addEventListener("pointerdown", markUser, { passive: true });
    }
    function markUser() { userScrollUntil = Date.now() + 1400; }

    // ---- per-frame update -----------------------------------------------------
    function findActive(pos) {
      // last line whose start <= pos; hold it through the gap to the next line (+grace)
      var a = -1;
      for (var i = 0; i < lines.length; i++) { if (lines[i].start <= pos) a = i; else break; }
      return a;
    }
    function setLineState(i, state) {
      var m = lines[i], cl = m.el.classList;
      if (m._state === state) return;
      m._state = state;
      cl.toggle("qzl-active", state === 1);
      cl.toggle("qzl-sung", state === 0);
      cl.toggle("qzl-next", state === 2);
      // words: sung lines full, upcoming lines empty (active handled per-frame)
      if (state === 0) fillAll(m, 1);
      else if (state === 2) fillAll(m, 0);
    }
    function fillAll(m, v) {
      for (var w = 0; w < m.words.length; w++) {
        var word = m.words[w]; setWordFill(word, v);
        if (word._ws !== -1) { word._ws = -1; word.el.classList.remove("qzl-w-cur", "qzl-w-sung"); }
      }
    }
    function setWordFill(word, v) { if (word._f === v) return; word._f = v; word.el.style.setProperty("--fill", (v * 100) + "%"); }

    function tick() {
      if (!running || destroyed) return;
      update(getPos() + LEAD_MS);
      raf = nativeRAF(tick);
    }
    function update(pos) {   // one synchronous frame at a given position (also exposed as .frame for driving/testing)
      var active = findActive(pos);
      // state pass: only touch lines whose state changed
      if (active !== curActive) {
        for (var i = 0; i < lines.length; i++) setLineState(i, i < active ? 0 : i === active ? 1 : 2);
        curActive = active;
      }
      // active line word fill: STRICT single playhead - exactly one word is ever mid-fill.
      // walk the words in order; the first one not yet finished is "current" (partial sweep),
      // everything before it is sung (100%), everything after is unsung (0%). even when the
      // source word times overlap, we never light more than one word's sweep at a time -> no
      // 'N words illuminated at once'.
      if (active >= 0) {
        var m = lines[active], ws = m.words, playhead = false;
        for (var w = 0; w < ws.length; w++) {
          var word = ws[w], st = word.start * 1000, en = Math.max(st + 1, word.end * 1000), f, state;
          if (playhead) { f = 0; state = 0; }
          else if (pos >= en) { f = 1; state = 2; }
          else { f = pos <= st ? 0 : (pos - st) / (en - st); state = 1; playhead = true; }
          setWordFill(word, f);
          if (word._ws !== state) {
            word._ws = state;
            word.el.classList.toggle("qzl-w-cur", state === 1);
            word.el.classList.toggle("qzl-w-sung", state === 2);
          }
        }
        // follow scroll (lerp), unless the user just scrolled
        if (Date.now() > userScrollUntil) {
          var target = m.el.offsetTop - scroller.clientHeight * CENTER_BIAS + m.el.offsetHeight / 2;
          if (target < 0) target = 0;
          var cur = scroller.scrollTop, d = target - cur;
          if (Math.abs(d) > 0.5) scroller.scrollTop = cur + d * FOLLOW;
        }
      }
    }

    function start() { if (running) return; running = true; curActive = -1; raf = nativeRAF(tick); }
    function stop() { running = false; if (raf) { try { cancelAnimationFrame(raf); } catch (e) {} raf = null; } }
    function destroyLines() { lines = []; if (root && root.parentNode) root.parentNode.removeChild(root); root = scroller = content = null; }
    function destroy() { destroyed = true; stop(); destroyLines(); }
    function scrollToTop() { if (scroller) scroller.scrollTop = 0; curActive = -1; }

    return { render: render, start: start, stop: stop, destroy: destroy, scrollToTop: scrollToTop, frame: update, status: status, get lineCount() { return lines.length; } };
  }

  global.QZLyricsRenderer = { make: make };
})(window);
