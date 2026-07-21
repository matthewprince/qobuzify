/* Lyra lyric renderer - built 2026-07-21T05:29:41Z */
// Lyra — TTML / JSON / LRC parsing front-ends.
//
// Everything here produces one internal model (all times in MILLISECONDS):
//   {
//     timing: 'word' | 'line' | 'none',
//     duration: ms | 0,
//     songwriters: [string],
//     lines: [{
//       kind: 'line',                      // engine may insert synthetic 'interlude' items later
//       start, end,                        // ms
//       text,                              // plain text of the lead vocal
//       align: 'start' | 'end',            // duet side (end = opposite-aligned)
//       agent: string|null, songPart: string|null, key: string|null,
//       words: [{ start, end, text, syllables: [{ start, end, text }] }],   // word timing only
//       background: [{ start, end, words: [...] }],                          // x-bg vocals
//     }]
//   }
//
// The TTML parser is namespace-PREFIX-agnostic: real files disagree on prefixes
// (ttm:, itunes:, amll:, no prefix at all), so attributes and elements are matched
// by localName, never by qualified name.
(function (global) {
  "use strict";
  var Lyra = global.Lyra = global.Lyra || {};

  // ---------------------------------------------------------------------------
  // time parsing: "h:mm:ss.fff" | "m:ss.fff" | "ss.fff" | "12.5s" | "500ms" | bare seconds
  function parseClock(str) {
    if (str == null) return null;
    var s = String(str).trim();
    if (!s) return null;
    var m = s.match(/^(\d+(?:\.\d+)?)(h|m|s|ms)$/); // TTML offset-time with metric
    if (m) {
      var v = parseFloat(m[1]);
      return m[2] === "h" ? v * 3600000 : m[2] === "m" ? v * 60000 : m[2] === "s" ? v * 1000 : v;
    }
    var parts = s.split(":");
    if (parts.length > 3) return null;
    var ms = 0;
    for (var i = 0; i < parts.length; i++) {
      var p = parseFloat(parts[i]);
      if (isNaN(p)) return null;
      ms = ms * 60 + p * 1000; // accumulate: each colon shifts previous into the next-larger unit
    }
    return ms;
  }

  // attribute by localName, ignoring namespace prefix ("ttm:agent" vs "agent" vs "amll:agent")
  function attr(el, local) {
    if (!el || !el.attributes) return null;
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (a.localName === local || a.name === local) return a.value;
    }
    return null;
  }
  function localName(el) { return (el.localName || el.nodeName || "").toLowerCase().replace(/^.*:/, ""); }
  function elementsByLocal(rootEl, local) {
    var out = [], all = rootEl.getElementsByTagName("*");
    for (var i = 0; i < all.length; i++) if (localName(all[i]) === local) out.push(all[i]);
    return out;
  }
  function normText(s) { return (s || "").replace(/\s+/g, " ").trim(); }

  // ---------------------------------------------------------------------------
  // syllable collection: walk a <p> (or an x-bg span), producing syllables with a
  // trailing-space flag. Word boundaries come from whitespace-bearing TEXT NODES
  // between timed spans; adjacent timed spans with no whitespace between them are
  // syllables of ONE word. Newline-bearing whitespace nodes are pretty-printer
  // indentation, NOT word boundaries, unless the whole document has no plain
  // space separators at all (nlBoundary: span-per-line formatted files).
  function collectSyllables(container, sink, nlBoundary) {
    var kids = container.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 3) { // text
        if (/\S/.test(n.nodeValue)) {
          // untimed loose text (rare): attach as an untimed syllable, engine will infer times
          if (/^\s/.test(n.nodeValue) && sink.syls.length) sink.syls[sink.syls.length - 1].space = true;
          sink.syls.push({ start: null, end: null, text: normText(n.nodeValue), space: /\s$/.test(n.nodeValue) });
        } else if (/\s/.test(n.nodeValue) && sink.syls.length) {
          if (nlBoundary || !/[\n\r]/.test(n.nodeValue)) sink.syls[sink.syls.length - 1].space = true;
        }
        continue;
      }
      if (n.nodeType !== 1) continue;
      var ln = localName(n);
      if (ln === "br") { if (sink.syls.length) sink.syls[sink.syls.length - 1].space = true; continue; }
      if (ln !== "span") continue;
      var role = attr(n, "role") || "";
      if (/x-bg/.test(role)) { sink.bg.push(n); continue; }                    // background vocal group, handled by caller
      if (/x-translation|x-transliteration|x-roman/.test(role)) continue;      // not rendered (v1)
      var b = parseClock(attr(n, "begin")), e = parseClock(attr(n, "end"));
      if (b == null && elementsByLocal(n, "span").length) { collectSyllables(n, sink, nlBoundary); continue; } // formatting wrapper (prefix-agnostic)
      var txt = n.textContent || "";
      if (!normText(txt) && b == null) continue;
      sink.syls.push({ start: b, end: e, text: txt.replace(/\s+/g, " ").replace(/^ | $/g, ""), space: /\s$/.test(txt) });
      if (/^\s/.test(txt) && sink.syls.length > 1) sink.syls[sink.syls.length - 2].space = true;
    }
  }

  // group syllables (with .space flags) into words; fill missing times from neighbours
  function toWords(syls) {
    // repair untimed syllables: inherit from previous/next timed neighbour
    var last = 0;
    for (var i = 0; i < syls.length; i++) {
      var s = syls[i];
      if (s.start == null) s.start = last;
      if (s.end == null) {
        var nxt = null;
        for (var j = i + 1; j < syls.length; j++) if (syls[j].start != null) { nxt = syls[j].start; break; }
        s.end = nxt != null ? nxt : s.start;
      }
      if (s.end < s.start) s.end = s.start;
      last = s.end;
    }
    var words = [], cur = null;
    for (var k = 0; k < syls.length; k++) {
      var sy = syls[k];
      if (!sy.text) { if (cur && sy.space) { words.push(cur); cur = null; } continue; }
      if (!cur) cur = { start: sy.start, end: sy.end, text: "", syllables: [] };
      cur.syllables.push({ start: sy.start, end: sy.end, text: sy.text });
      cur.text += sy.text;
      cur.end = Math.max(cur.end, sy.end);
      if (sy.space) { words.push(cur); cur = null; }
    }
    if (cur) words.push(cur);
    return words;
  }
  function wordsSpan(words) {
    if (!words.length) return null;
    var s = Infinity, e = 0;
    for (var i = 0; i < words.length; i++) { s = Math.min(s, words[i].start); e = Math.max(e, words[i].end); }
    return { start: s, end: e };
  }
  function wordsText(words) { return words.map(function (w) { return w.text; }).join(" "); }

  // ---------------------------------------------------------------------------
  Lyra.parseTTML = function (source) {
    var xml = String(source || "").replace(/^﻿/, "");
    var doc = new DOMParser().parseFromString(xml, "text/xml");
    if (doc.getElementsByTagName("parsererror").length) {
      // some producers emit stray "&" etc.; one repair pass, then give up cleanly
      doc = new DOMParser().parseFromString(xml.replace(/&(?!#?\w+;)/g, "&amp;"), "text/xml");
      if (doc.getElementsByTagName("parsererror").length) return null;
    }
    var tt = doc.documentElement;
    if (!tt || localName(tt) !== "tt") return null;

    var timingAttr = (attr(tt, "timing") || "").toLowerCase();
    var body = elementsByLocal(tt, "body")[0];
    if (!body) return null;

    // agents (duets): p ttm:agent != first-declared agent renders opposite-aligned
    var agents = [];
    var head = elementsByLocal(tt, "head")[0];
    if (head) {
      var ags = elementsByLocal(head, "agent");
      for (var a = 0; a < ags.length; a++) {
        var id = attr(ags[a], "id");
        if (id) agents.push(id);
      }
    }
    var primaryAgent = agents.length ? agents[0] : null;

    var songwriters = [];
    if (head) {
      var sws = elementsByLocal(head, "songwriter");
      for (var w = 0; w < sws.length; w++) { var t = normText(sws[w].textContent); if (t) songwriters.push(t); }
    }

    var lines = [];
    var ps = elementsByLocal(body, "p");
    // decide the newline rule once for the whole document (see collectSyllables)
    var spaceNodes = 0, nlNodes = 0;
    for (var sc = 0; sc < ps.length; sc++) {
      var tw = ps[sc].childNodes;
      for (var tn = 0; tn < tw.length; tn++) {
        var nd = tw[tn];
        if (nd.nodeType !== 3 || /\S/.test(nd.nodeValue)) continue;
        if (/[\n\r]/.test(nd.nodeValue)) nlNodes++; else spaceNodes++;
      }
      // spaces at the EDGE of span text are also word-separator evidence (some
      // files carry "ther " inside the span); without this, pretty-printing such
      // a file would flip nlBoundary and shatter every multi-syllable word
      var sps = elementsByLocal(ps[sc], "span");
      for (var se = 0; se < sps.length; se++) {
        if (/^\s|\s$/.test(sps[se].textContent || "")) spaceNodes++;
      }
    }
    var nlBoundary = spaceNodes === 0 && nlNodes > 0;
    var sawSyllables = false;
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      var pBegin = parseClock(attr(p, "begin")), pEnd = parseClock(attr(p, "end"));
      var agent = attr(p, "agent");
      var songPart = attr(p, "songPart");
      if (!songPart && p.parentNode && p.parentNode.nodeType === 1) songPart = attr(p.parentNode, "songPart");

      var sink = { syls: [], bg: [] };
      collectSyllables(p, sink, nlBoundary);
      var words = toWords(sink.syls);
      var timed = words.length && words.some(function (wd) { return wd.syllables.some(function (s2) { return s2.end > s2.start; }); });

      var line = {
        kind: "line",
        start: pBegin != null ? pBegin : 0,
        end: pEnd != null ? pEnd : 0,
        text: "",
        align: agent && primaryAgent && agent !== primaryAgent ? "end" : "start",
        agent: agent || null,
        songPart: songPart || null,
        key: attr(p, "key"),
        words: [],
        background: [],
      };

      if (timed && timingAttr !== "line") {
        sawSyllables = true;
        line.words = words;
        line.text = wordsText(words);
        var span = wordsSpan(words);
        if (pBegin == null) line.start = span.start;
        if (pEnd == null || pEnd < span.end) line.end = Math.max(pEnd || 0, span.end);
      } else {
        // NOT p.textContent: that would re-include x-bg / x-translation text that
        // collectSyllables deliberately routed elsewhere
        line.text = wordsText(words);
        if (pEnd == null && pBegin != null) line.end = pBegin; // repaired below from the next line
      }

      // background vocal groups (x-bg spans found while walking)
      for (var g = 0; g < sink.bg.length; g++) {
        var bsink = { syls: [], bg: [] };
        collectSyllables(sink.bg[g], bsink, nlBoundary);
        // the x-bg group may carry the timing itself (plain-text or untimed content):
        // seed the edges from its own begin/end (falling back to the line's) so
        // untimed background vocals don't collapse to 0/0
        var bb = parseClock(attr(sink.bg[g], "begin")), be = parseClock(attr(sink.bg[g], "end"));
        if (bsink.syls.length) {
          var bs0 = bsink.syls[0], bsN = bsink.syls[bsink.syls.length - 1];
          if (bs0.start == null) bs0.start = bb != null ? bb : (pBegin || 0);
          if (bsN.end == null) bsN.end = be != null ? be : pEnd;
        }
        var bwords = toWords(bsink.syls);
        if (!bwords.length) continue;
        var bspan = wordsSpan(bwords);
        line.background.push({ start: bspan.start, end: bspan.end, words: bwords });
        line.end = Math.max(line.end, bspan.end);
      }

      lines.push(line);
    }

    // repair: line-mode missing ends -> next line's start (or +5s for the last)
    for (var r = 0; r < lines.length; r++) {
      if (lines[r].end <= lines[r].start) {
        lines[r].end = r + 1 < lines.length ? Math.max(lines[r].start, lines[r + 1].start) : lines[r].start + 5000;
      }
    }

    var duration = parseClock(attr(body, "dur")) || (lines.length ? lines[lines.length - 1].end : 0);
    var timing = sawSyllables ? "word" : (lines.some(function (l) { return l.start || l.end; }) ? "line" : "none");
    if (timingAttr === "none") timing = "none";
    return { timing: timing, duration: duration, songwriters: songwriters, lines: lines };
  };

  // ---------------------------------------------------------------------------
  // Adapter for the Qobuzify API / v1 internal format (times in SECONDS):
  //   { Type:"Syllable"|"Line", Content:[ {Lead:{StartTime,EndTime,Syllables:[{Text,StartTime,EndTime,IsPartOfWord}]},
  //     Background?:[{Syllables:[...]}], OppositeAligned?:bool} | {Text,StartTime,EndTime} ] }
  // Also accepts the full /v2/track envelope: {ok, lyrics:{data}, songwriters:{names}}.
  Lyra.fromLyricsJSON = function (ly, songwriters) {
    if (ly && ly.lyrics && ly.lyrics.data) {
      return Lyra.fromLyricsJSON(ly.lyrics.data,
        (ly.songwriters && ly.songwriters.names) || songwriters);
    }
    if (ly && ly.data && ly.data.Content) return Lyra.fromLyricsJSON(ly.data, songwriters);
    if (!ly || !ly.Content || !ly.Content.length) return null;
    var syllable = ly.Type === "Syllable";
    function grpSyls(syls, fallbackEnd) { // IsPartOfWord=true joins the NEXT syllable (v1 semantics)
      var out = [];
      for (var i = 0; i < (syls || []).length; i++) {
        var s = syls[i];
        var end = s.EndTime;
        if (end == null) { // some responses omit EndTime: run to the next syllable
          var nxt = syls[i + 1];
          end = nxt && nxt.StartTime != null ? nxt.StartTime : (fallbackEnd != null ? fallbackEnd : s.StartTime);
        }
        out.push({
          start: (s.StartTime || 0) * 1000, end: (end || 0) * 1000,
          text: (s.Text || "").replace(/\s+/g, " ").replace(/^ | $/g, ""),
          space: !s.IsPartOfWord,
        });
      }
      return toWords(out);
    }
    var lines = [];
    for (var i = 0; i < ly.Content.length; i++) {
      var it = ly.Content[i];
      if (!it) continue; // tolerate glitched/partial responses
      var L = it.Lead;
      var line = {
        kind: "line", start: 0, end: 0, text: "",
        align: it.OppositeAligned ? "end" : "start",
        agent: null, songPart: null, key: null, words: [], background: [],
      };
      if (syllable && L && L.Syllables) {
        line.words = grpSyls(L.Syllables, L.EndTime);
        line.text = wordsText(line.words);
        line.start = (L.StartTime || 0) * 1000;
        line.end = (L.EndTime || 0) * 1000;
        var sp = wordsSpan(line.words);
        if (sp) { if (!line.start) line.start = sp.start; line.end = Math.max(line.end, sp.end); }
        for (var b = 0; b < (it.Background || []).length; b++) {
          var bgw = grpSyls(it.Background[b] && it.Background[b].Syllables, it.Background[b] && it.Background[b].EndTime);
          if (!bgw.length) continue;
          var bsp = wordsSpan(bgw);
          line.background.push({ start: bsp.start, end: bsp.end, words: bgw });
          line.end = Math.max(line.end, bsp.end);
        }
      } else {
        line.text = normText(it.Text || (L && L.Text) || "");
        line.start = ((it.StartTime != null ? it.StartTime : L && L.StartTime) || 0) * 1000;
        line.end = ((it.EndTime != null ? it.EndTime : L && L.EndTime) || 0) * 1000;
      }
      lines.push(line);
    }
    // end repair (Line-type docs from LRC upstreams often omit EndTime): a line
    // with no usable end runs to the next line's start, else 0-length "lines"
    // read as long gaps and spawn interlude dots everywhere
    for (var r2 = 0; r2 < lines.length; r2++) {
      if (lines[r2].end <= lines[r2].start) {
        lines[r2].end = r2 + 1 < lines.length ? Math.max(lines[r2].start, lines[r2 + 1].start) : lines[r2].start + 5000;
      }
    }
    return {
      timing: syllable ? "word" : "line",
      duration: lines.length ? lines[lines.length - 1].end : 0,
      songwriters: songwriters || [], lines: lines,
    };
  };

  // ---------------------------------------------------------------------------
  // Minimal LRC (line stamps) + enhanced LRC (<mm:ss.xx> inline word stamps).
  Lyra.fromLRC = function (text) {
    var rows = String(text || "").split(/\r?\n/), lines = [], anyWords = false;
    for (var i = 0; i < rows.length; i++) {
      var m = rows[i].match(/^\s*((?:\[\d+:\d+(?:\.\d+)?\])+)(.*)$/);
      if (!m) continue;
      var stamps = m[1].match(/\[(\d+):(\d+(?:\.\d+)?)\]/g).map(function (st) {
        var p = st.match(/\[(\d+):(\d+(?:\.\d+)?)\]/);
        return (parseInt(p[1], 10) * 60 + parseFloat(p[2])) * 1000;
      });
      var bodyTxt = m[2];
      var words = [];
      var lead = normText(bodyTxt.split(/<\d+:\d+(?:\.\d+)?>/)[0]); // text before the first word stamp
      var wm, wre = /<(\d+):(\d+(?:\.\d+)?)>([^<]*)/g;
      while ((wm = wre.exec(bodyTxt))) {
        var ws = (parseInt(wm[1], 10) * 60 + parseFloat(wm[2])) * 1000;
        var wt = normText(wm[3]);
        if (!wt) continue;
        words.push({ start: ws, end: 0, text: wt, syllables: [{ start: ws, end: 0, text: wt }] });
      }
      for (var s = 0; s < stamps.length; s++) {
        var off = stamps[s] - stamps[0]; // repeated-chorus stamps shift the word times too
        var lw = words.map(function (wd) { return { start: wd.start + off, end: 0, text: wd.text, syllables: [{ start: wd.start + off, end: 0, text: wd.text }] }; });
        if (lead && lw.length) lw.unshift({ start: stamps[s], end: 0, text: lead, syllables: [{ start: stamps[s], end: 0, text: lead }] });
        lines.push({
          kind: "line", start: stamps[s], end: 0, text: normText(bodyTxt.replace(/<\d+:\d+(?:\.\d+)?>/g, " ")),
          align: "start", agent: null, songPart: null, key: null, words: lw, background: [],
        });
        if (lw.length) anyWords = true;
      }
    }
    lines.sort(function (a, b) { return a.start - b.start; });
    for (var r = 0; r < lines.length; r++) {
      var nx = r + 1 < lines.length ? lines[r + 1].start : lines[r].start + 5000;
      lines[r].end = Math.max(lines[r].start, nx);
      var lws = lines[r].words;
      for (var w = 0; w < lws.length; w++) {
        var we = w + 1 < lws.length ? lws[w + 1].start : lines[r].end;
        lws[w].end = lws[w].syllables[0].end = Math.max(lws[w].start, we);
      }
    }
    if (!lines.length) return null;
    return { timing: anyWords ? "word" : "line", duration: lines[lines.length - 1].end, songwriters: [], lines: lines };
  };

  // auto-detect front-end
  Lyra.parse = function (input) {
    if (input == null) return null;
    if (typeof input === "object") return Lyra.fromLyricsJSON(input);
    var s = String(input).replace(/^﻿/, "").trim();
    if (s[0] === "<") return Lyra.parseTTML(s);
    if (s[0] === "{") { try { return Lyra.fromLyricsJSON(JSON.parse(s)); } catch (e) { return null; } }
    return Lyra.fromLRC(s);
  };
})(typeof window !== "undefined" ? window : globalThis);
// Lyra — karaoke lyric renderer engine.
//
// Design rules (every one exists to kill a stutter class):
//  1. STABLE DOM: every line/word/syllable node is built ONCE per track and never
//     destroyed while the track plays. No virtual list, no rebuild-on-scroll.
//  2. ONE rAF loop, ZERO layout reads inside it. Geometry (line offsets, syllable
//     widths, viewport height) is measured in a single batched pass on build /
//     font-ready / resize only.
//  3. Compositor-only animation: `translate`, `scale`, `opacity`. Depth blur is a
//     STEPPED filter (blur-value transitions run on the main thread, so we never
//     transition filter). Per-frame style writes are dirty-checked and quantized.
//  4. The gradient sweep lives on ONE syllable at a time (registered @property,
//     inherits:false), so the per-frame paint area is a single small span. It is
//     per-syllable rather than per-word because Chromium breaks background-clip:
//     text on elements with transformed/positioned descendants (bug 41385122),
//     and our words contain scaling syllables + an absolutely-positioned glow.
//  5. Scroll is a critically-damped spring on the content container, NOT
//     scrollTop. The Apple-style cascade is done by TIME-SHIFTING: lines below
//     the active one replay the container's motion history with a per-line
//     delay, so there is exactly one physics sim no matter how many lines move.
//  6. Seeks and tab-visibility returns take a SNAP path: transitions are
//     disabled for a couple of frames and every animated value jumps straight
//     to its target. No transition catch-up storm after alt-tab.
//
// API:
//   var r = Lyra.create({ mount, getPos, isPlaying, onSeek, onClose, settings });
//   r.load(modelOrSource); r.setCover(url); r.start(); r.stop();
//   r.frame(posMs); r.status(msg); r.remeasure(); r.stats(); r.destroy();
(function (global) {
  "use strict";
  var Lyra = global.Lyra = global.Lyra || {};

  var DEFAULTS = {
    depthBlur: true,        // progressive (stepped) blur by distance from the active line
    glow: true,             // bloom overlay on the currently-sung word
    cascade: true,          // staggered line follow
    cascadeStep: 45,        // ms of lag per line below the active one
    cascadeMax: 340,        // cap on that lag
    centerBias: 0.40,       // active line rests this fraction down the viewport
    followK: 100,           // follow-spring stiffness baseline (adaptive, see tempo tracking)
    followZeta: 0.65,       // follow-spring damping ratio: ~7% overshoot, a real settle
                            // (0.8+ is mathematically <2% = invisible = "flat")
    adaptiveSpring: true,   // weightier spring on slow songs, snappier on fast ones
    entrance: true,         // staggered ripple-in on load and after seeks
    userK: 430,             // user-scroll spring stiffness (critically damped)
    userIdleMs: 3200,       // resume auto-follow after this much scroll idle
    graceMs: 350,           // hold a line active this long past its end
    interludeMinMs: 2600,   // min silent gap that earns interlude dots
    interludeLeadMs: 4000,  // dots before the first line if it starts later than this
    fontFamily: null,
    background: true,       // drive Lyra.Background if present
    closeButton: true,      // rendered when onClose is provided; set false to suppress
    credits: true,          // songwriters line after the lyrics
  };

  // ---------------------------------------------------------------------------
  var CSS = "" +
// registered so per-frame writes cost microseconds, not a style-recalc storm
"@property --fill{syntax:'<percentage>';inherits:false;initial-value:0%;}" +
".lyra-root{position:absolute;inset:0;overflow:hidden;color:#fff;-webkit-font-smoothing:antialiased;contain:layout style;touch-action:none;}" +
".lyra-viewport{position:absolute;inset:0;overflow:hidden;}" +
".lyra-canvas{position:absolute;left:0;right:0;top:0;will-change:translate;}" +
".lyra-content{padding:0 clamp(24px,5.5vw,88px);box-sizing:border-box;max-width:min(1160px,94%);margin:0 auto;}" +
// lines. Base state = dim + slightly small, so a freshly-built line can never
// flash bright: brightness is only ever ADDED by the active class. filter is
// deliberately NOT in the transition list (stepped, see header).
".lyra-line{position:relative;margin:0 0 clamp(.55em,1.6vh,.9em);font-weight:700;" +
"font-size:clamp(26px,3.3vw,52px);line-height:1.16;letter-spacing:-.01em;text-align:start;" +
"overflow-wrap:break-word;cursor:pointer;opacity:.34;transform-origin:left center;scale:.93;" +
// asymmetric: brightening is quick (duration override on .lyra-active below), dimming
// trails slowly; scale rides a gentle spring curve so growth has a settle, not an ease
"transition:opacity .6s cubic-bezier(.33,0,.2,1),scale .6s cubic-bezier(.34,1.3,.4,1);}" +
"@keyframes lyra-in{from{opacity:0;translate:0 16px;}}" + // to-frame omitted: animates to each line's own styles
".lyra-enter{animation:lyra-in .55s cubic-bezier(.2,.55,.25,1) backwards;}" +
".lyra-line.lyra-opp{text-align:end;transform-origin:right center;}" +
".lyra-near,.lyra-lag{will-change:translate;}" +
".lyra-line.lyra-active{opacity:1;scale:1.03;transition-duration:.28s,.5s;}" +
".lyra-line:hover{opacity:.72;filter:none!important;}" +
".lyra-line.lyra-active:hover{opacity:1;}" +
// depth-of-field: further from the active line = dimmer (+ stepped blur when enabled)
".lyra-d1{opacity:.5;}.lyra-d2{opacity:.42;}.lyra-d3{opacity:.36;}.lyra-d4{opacity:.30;}" +
".lyra-blur .lyra-line{filter:blur(3.5px);}.lyra-blur .lyra-line.lyra-active{filter:none;}" +
".lyra-blur .lyra-d1{filter:blur(1px);}.lyra-blur .lyra-d2{filter:blur(1.8px);}" +
".lyra-blur .lyra-d3{filter:blur(2.6px);}.lyra-blur .lyra-d4{filter:blur(3.5px);}" +
// words: plain containers (lift/scale + glow anchor); the paint tricks live on syllables.
// The word lift has NO CSS transitions: it is a continuous per-frame envelope driven
// by the engine (attack over the word's start, sustain, 260ms release after it ends).
// Class-transition pops looked like a pogo stick on dense tracks where consecutive
// words have ZERO gap (Alone Pt. II peaks at ~4 words/s, contiguous) - two competing
// transitions fired on every word handoff. A time-domain envelope is continuous by
// construction, and amplitude still scales with word duration.
".lyra-w{position:relative;display:inline-block;transform-origin:center 80%;}" +
// syllables (base glyphs). In the active line: future = dim, sung = bright,
// current = gradient sweep clipped to its own glyphs. Everywhere else: flat.
// NO per-syllable scale: a held syllable used to swell 1.09 here, which grew
// long words ~10px sideways and glued them to their neighbors; hold emphasis
// now lives in the word-lift envelope, where scale is pixel-capped.
".lyra-s,.lyra-gs{display:inline-block;}" +
".lyra-line .lyra-s{color:rgba(255,255,255,.92);}" +
".lyra-line.lyra-active .lyra-s{color:var(--lyra-unsung,rgba(255,255,255,.34));}" +
".lyra-line.lyra-active .lyra-w-sung .lyra-s,.lyra-line.lyra-active .lyra-s.lyra-s-sung{color:var(--lyra-sung,#fff);}" +
".lyra-line.lyra-active .lyra-s.lyra-s-cur{" +
"background-image:linear-gradient(90deg,var(--lyra-sung,#fff) calc(var(--fill) - 18%),var(--lyra-unsung,rgba(255,255,255,.34)) var(--fill));" +
"-webkit-background-clip:text;background-clip:text;color:transparent;}" +
// line-timed tracks have no sweep: the active line simply reads bright
".lyra-linemode .lyra-line.lyra-active .lyra-s{color:var(--lyra-sung,#fff);}" +
// glow overlay: duplicate glyphs (.lyra-gs twins), clipped to the sung portion,
// bloomed with a STATIC drop-shadow; only the overlay's opacity animates.
".lyra-wg{position:absolute;inset:0;pointer-events:none;opacity:0;" + // opacity driven by the lift envelope
"filter:drop-shadow(0 0 6px rgba(255,255,255,.5)) drop-shadow(0 0 22px rgba(255,255,255,.28));}" +
// held-note tier: a long word being sung earns a hotter, wider bloom (static filter
// swapped by class: repaints once at hold start, intensity still rides the envelope)
".lyra-w-hold .lyra-wg{filter:drop-shadow(0 0 7px rgba(255,255,255,.68)) drop-shadow(0 0 32px rgba(255,255,255,.42));}" +
".lyra-gs{color:transparent;}" +
".lyra-line.lyra-active .lyra-gs.lyra-s-sung{color:#fff;}" +
".lyra-line.lyra-active .lyra-gs.lyra-s-cur{" +
"background-image:linear-gradient(90deg,#fff calc(var(--fill) - 18%),transparent var(--fill));" +
"-webkit-background-clip:text;background-clip:text;}" +
// background vocals: smaller echo line under the lead
".lyra-bgv{display:block;font-size:.58em;font-weight:600;opacity:.8;margin-top:.15em;}" +
// interlude dots
".lyra-int{position:relative;height:1.4em;margin:0 0 clamp(.55em,1.6vh,.9em);display:flex;align-items:center;" +
"opacity:0;scale:.6;transform-origin:left center;transition:opacity .4s ease,scale .5s cubic-bezier(.3,.7,.25,1.15);}" +
".lyra-int.lyra-active{opacity:1;scale:1;}" +
".lyra-int.lyra-int-exit{opacity:0;scale:1.18;}" +
".lyra-int-dots{display:inline-flex;gap:.3em;animation:lyra-breathe 2.2s ease-in-out infinite alternate;animation-play-state:paused;}" +
".lyra-int.lyra-active .lyra-int-dots{animation-play-state:running;}" +
".lyra-dot{width:.32em;height:.32em;border-radius:50%;background:#fff;font-size:clamp(26px,3.3vw,52px);}" +
".lyra-dot:nth-child(1){opacity:clamp(.22,calc(var(--ifill,0)*3 + .22),1);}" +
".lyra-dot:nth-child(2){opacity:clamp(.22,calc(var(--ifill,0)*3 - .78),1);}" +
".lyra-dot:nth-child(3){opacity:clamp(.22,calc(var(--ifill,0)*3 - 1.78),1);}" +
"@keyframes lyra-breathe{from{scale:1;}to{scale:1.09;}}" +
// spacers, credits, status, close
".lyra-sp-top{height:44vh;}.lyra-sp-bot{height:52vh;}" +
".lyra-credits{opacity:.42;font-size:clamp(13px,1vw,16px);font-weight:500;margin-top:2.2em;letter-spacing:.01em;}" +
".lyra-status{position:absolute;top:50%;left:50%;translate:-50% -50%;color:rgba(255,255,255,.72);" +
"font-size:clamp(16px,1.7vw,24px);font-weight:600;text-align:center;letter-spacing:.01em;max-width:80%;z-index:2;}" +
".lyra-close{position:absolute;top:16px;left:50%;translate:-50%;z-index:6;width:38px;height:38px;border:0;border-radius:50%;" +
"background:rgba(255,255,255,.09);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;" +
"backdrop-filter:blur(8px);transition:background .15s,scale .12s;}" +
".lyra-close:hover{background:rgba(255,255,255,.2);scale:1.08;}" +
".lyra-close svg{width:17px;height:17px;stroke:currentColor;stroke-width:2.4;fill:none;stroke-linecap:round;}" +
// snap mode: kills every transition for the resync frame(s)
".lyra-cut .lyra-line,.lyra-cut .lyra-w,.lyra-cut .lyra-wg,.lyra-cut .lyra-s,.lyra-cut .lyra-gs,.lyra-cut .lyra-int{transition:none!important;}" +
"@media (prefers-reduced-motion:reduce){" +
".lyra-line,.lyra-w,.lyra-s,.lyra-gs{transition-duration:.01s!important;}" +
".lyra-int-dots,.lyra-enter{animation:none!important;}}";

  function injectCSS() {
    if (document.getElementById("lyra-css")) return;
    var s = document.createElement("style");
    s.id = "lyra-css";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // ---------------------------------------------------------------------------
  Lyra.create = function (opts) {
    var mount = opts.mount;
    var getPos = opts.getPos || function () { return 0; };
    var isPlaying = opts.isPlaying || function () { return true; };
    var onSeek = opts.onSeek || function () {};
    var onClose = opts.onClose || null;
    var S = {};
    for (var dk in DEFAULTS) S[dk] = DEFAULTS[dk];
    for (var ok in (opts.settings || {})) S[ok] = opts.settings[ok];
    var reduced = false;
    try { reduced = matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
    if (reduced) { S.cascade = false; S.glow = false; S.depthBlur = false; }

    // --- state -----------------------------------------------------------------
    var root = null, viewport = null, canvas = null, content = null, statusEl = null, bg = null;
    var items = [];              // lines + interludes, doc order
    var model = null;
    var destroyed = false, running = false;
    var raf = null;
    var anchor = -1;             // index of the item that owns the spotlight
    var marked = [];             // items currently carrying distance/near classes
    var vh = 0, maxScroll = 0, measured = false, measureQueued = false;
    var ro = null;

    // scroll spring + motion history for the cascade
    var spr = { y: 0, v: 0, target: 0, settled: true };
    var adaptedK = S.followK;   // tempo-adapted stiffness
    var lastAnchorT = 0, cadence = [];   // recent inter-line intervals (ms)
    var hist = [];               // [{t, y}] recent container positions
    var lagged = [];             // items currently replaying delayed history
    var userUntil = 0;           // auto-follow paused until this timestamp
    var lastCanvasY = 1e9;

    // clock smoothing + jump detection
    var est = 0, lastRaw = -1, lastT = 0;
    var pendingCover = null;   // setCover() before the first scaffold

    // stats for perf verification
    var stat = { frames: 0, styleWrites: 0, lastMs: 0, worstMs: 0 };

    var nativeRAF = global.__QZ_SL_nativeRAF ||
      (window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : function (f) { return setTimeout(function () { f(performance.now()); }, 16); });

    // --- scaffold --------------------------------------------------------------
    function scaffold() {
      if (destroyed) return;
      injectCSS();
      root = el("div", "lyra-root");
      if (S.depthBlur) root.classList.add("lyra-blur");
      if (S.fontFamily) root.style.fontFamily = S.fontFamily;
      viewport = el("div", "lyra-viewport");
      canvas = el("div", "lyra-canvas");
      content = el("div", "lyra-content");
      canvas.appendChild(content);
      viewport.appendChild(canvas);
      root.appendChild(viewport);
      if (onClose && S.closeButton) {
        var btn = el("button", "lyra-close");
        btn.type = "button"; btn.title = "Close lyrics";
        btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
        btn.addEventListener("click", function (e) { e.stopPropagation(); try { onClose(); } catch (x) {} });
        root.appendChild(btn);
      }
      mount.appendChild(root);
      if (S.background && Lyra.Background) { try { bg = Lyra.Background.attach(root); } catch (e) { bg = null; } }
      if (bg && pendingCover) { try { bg.setCover(pendingCover[0], pendingCover[1]); } catch (e) {} pendingCover = null; }

      root.addEventListener("wheel", onWheel, { passive: true });
      root.addEventListener("pointerdown", onPointerDown);
      content.addEventListener("click", onLineClick);
      document.addEventListener("visibilitychange", onVisibility);
      if (window.ResizeObserver) { ro = new ResizeObserver(queueMeasure); ro.observe(viewport); }
      else window.addEventListener("resize", queueMeasure);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(queueMeasure);
    }

    function status(msg) {
      if (destroyed) return;
      if (!root) scaffold();
      if (!msg) { if (statusEl) { statusEl.remove(); statusEl = null; } return; }
      if (!statusEl) { statusEl = el("div", "lyra-status"); root.appendChild(statusEl); }
      statusEl.textContent = msg;
    }

    // --- build -----------------------------------------------------------------
    function buildWord(word, withGlow) {
      var w = el("span", "lyra-w");
      // lift amplitude from word duration: <=~180ms -> 0.25 (barely moves), >=600ms -> 1
      var pop = reduced ? 0 : Math.max(0.25, Math.min(1, ((word.end - word.start) - 120) / 480));
      var meta = { el: w, glow: null, start: word.start, end: word.end, pop: pop, syls: [], _ws: -1, _lift: 0 };
      for (var i = 0; i < word.syllables.length; i++) {
        var sy = word.syllables[i];
        var se = el("span", "lyra-s");
        se.textContent = sy.text;
        w.appendChild(se);
        meta.syls.push({ el: se, gel: null, start: sy.start, end: sy.end, _ss: -1, _f: -1 });
      }
      if (withGlow) {
        var g = el("span", "lyra-wg");
        g.setAttribute("aria-hidden", "true");
        for (var j = 0; j < meta.syls.length; j++) {
          var gs = el("span", "lyra-gs");
          gs.textContent = word.syllables[j].text;
          g.appendChild(gs);
          meta.syls[j].gel = gs;
        }
        w.appendChild(g);
        meta.glow = g;
      }
      return meta;
    }

    function buildWordRow(container, words, withGlow) {
      var metas = [];
      for (var i = 0; i < words.length; i++) {
        var m = buildWord(words[i], withGlow);
        container.appendChild(m.el);
        if (i < words.length - 1) container.appendChild(document.createTextNode(" "));
        metas.push(m);
      }
      return metas;
    }

    function buildInterlude(start, end, opp) {
      var e = el("div", "lyra-int");
      if (opp) e.classList.add("lyra-opp");
      var dots = el("span", "lyra-int-dots");
      dots.appendChild(el("span", "lyra-dot"));
      dots.appendChild(el("span", "lyra-dot"));
      dots.appendChild(el("span", "lyra-dot"));
      e.appendChild(dots);
      return { kind: "interlude", el: e, start: start, end: end, words: [], bgGroups: [],
               natY: 0, natH: 0, _state: -1, _dist: null, _if: -1, _exit: false, lagDelay: 0, lagY: null };
    }

    function build() {
      if (!root) scaffold();
      content.textContent = "";
      items = []; marked = []; lagged = []; cooling = [];
      anchor = -1; measured = false;
      content.appendChild(el("div", "lyra-sp-top"));

      var lines = (model && model.lines) || [];
      var wordMode = model && model.timing === "word";
      root.classList.toggle("lyra-linemode", !wordMode);
      var prevEnd = 0;

      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        var isEmpty = !ln.text && !(ln.words && ln.words.length) && !(ln.background && ln.background.length);

        // interlude for a long silent gap (or an explicitly empty marker line)
        var gapStart = prevEnd, gapEnd = ln.start;
        var minGap = items.length === 0 ? S.interludeLeadMs : S.interludeMinMs;
        if (gapEnd - gapStart >= minGap) {
          var it = buildInterlude(gapStart + (items.length ? 200 : 0), gapEnd - 150, false);
          content.appendChild(it.el);
          items.push(it);
        }
        if (isEmpty) { prevEnd = Math.max(prevEnd, ln.end || ln.start); continue; }

        var le = el("div", "lyra-line");
        le.dir = "auto";
        if (ln.align === "end") le.classList.add("lyra-opp");
        var meta = { kind: "line", el: le, start: ln.start, end: ln.end, text: ln.text,
                     words: [], bgGroups: [], natY: 0, natH: 0, _state: -1, _dist: null,
                     lagDelay: 0, lagY: null };
        if (wordMode && ln.words && ln.words.length) {
          meta.words = buildWordRow(le, ln.words, S.glow);
        } else {
          var w = el("span", "lyra-w");
          var ws = el("span", "lyra-s");
          ws.textContent = ln.text;
          w.appendChild(ws);
          le.appendChild(w);
          meta.words = [{ el: w, glow: null, start: ln.start, end: ln.end, pop: 0, _ws: -1, _lift: 0,
                          syls: [{ el: ws, gel: null, start: ln.start, end: ln.end, _ss: -1, _f: -1 }] }];
        }
        for (var b = 0; b < (ln.background || []).length; b++) {
          var bgLine = ln.background[b];
          var bgEl = el("div", "lyra-bgv");
          var bgWords = buildWordRow(bgEl, bgLine.words, S.glow);
          le.appendChild(bgEl);
          meta.bgGroups.push({ words: bgWords });
        }
        le._lyra = meta;
        content.appendChild(le);
        items.push(meta);
        prevEnd = Math.max(prevEnd, meta.end);
      }

      if (S.entrance && !reduced) { // staggered ripple-in when the sheet appears
        for (var e2 = 0; e2 < items.length; e2++) {
          items[e2].el.classList.add("lyra-enter");
          items[e2].el.style.animationDelay = Math.min(e2 * 22, 480) + "ms";
        }
      }

      if (S.credits && model && model.songwriters && model.songwriters.length) {
        var cr = el("div", "lyra-credits");
        cr.textContent = "Songwriters: " + model.songwriters.join(", ");
        content.appendChild(cr);
      }
      content.appendChild(el("div", "lyra-sp-bot"));
      queueMeasure();
    }

    // --- geometry (the ONLY place that reads layout) ---------------------------
    function queueMeasure() {
      if (measureQueued || destroyed) return;
      measureQueued = true;
      nativeRAF(function () {
        measureQueued = false;
        if (!destroyed) measure();
      });
    }
    function measure() {
      if (!root || !items.length) { measured = false; return; }
      vh = viewport.clientHeight;
      var contentH = content.offsetHeight;
      maxScroll = Math.max(0, contentH - vh);
      for (var i = 0; i < items.length; i++) {
        var m = items[i];
        m.natY = m.el.offsetTop;
        m.natH = m.el.offsetHeight;
        // word layout widths, for the absolute cap on scale growth (reads only,
        // same batched layout pass; scale doesn't affect offsetWidth)
        for (var w = 0; w < m.words.length; w++) m.words[w].px = m.words[w].el.offsetWidth;
        for (var g = 0; g < m.bgGroups.length; g++)
          for (var bw = 0; bw < m.bgGroups[g].words.length; bw++)
            m.bgGroups[g].words[bw].px = m.bgGroups[g].words[bw].el.offsetWidth;
      }
      measured = true;
      if (anchor >= 0) {
        if (drag || performance.now() < userUntil) {
          // mid-read resize/font-load: keep the user's place, just re-clamp
          spr.target = clamp(spr.target, 0, maxScroll);
          spr.y = clamp(spr.y, 0, maxScroll);
          writeCanvas(true);
        } else {
          // keep the anchor where it belongs, without animating the correction
          retarget(true); snapScroll();
        }
      }
    }

    // --- scroll ----------------------------------------------------------------
    function targetFor(i) {
      var m = items[i];
      if (!m) return spr.target;
      return clamp(m.natY + m.natH / 2 - vh * S.centerBias, 0, maxScroll);
    }
    function retarget(instant) {
      if (anchor < 0 || !measured) return;
      if (!instant && performance.now() < userUntil) return; // the user is browsing: don't yank the view
      var t = targetFor(anchor);
      if (t === spr.target && !instant) return;
      spr.target = t;
      spr.settled = false;
      if (instant) return;
      // tempo tracking: weighty settle on ballads, snappy on uptempo (Apple-style)
      if (S.adaptiveSpring) {
        var nowT = performance.now();
        if (lastAnchorT) {
          cadence.push(Math.min(8000, nowT - lastAnchorT));
          if (cadence.length > 4) cadence.shift();
          var avg = 0;
          for (var c2 = 0; c2 < cadence.length; c2++) avg += cadence[c2];
          avg /= cadence.length;
          var f = clamp((avg - 1200) / 3800, 0, 1); // 1.2s lines -> fast, 5s lines -> slow
          adaptedK = 150 - f * 76;                  // 150 (snappy) .. 74 (weighty)
        }
        lastAnchorT = nowT;
      }
      // arm the cascade: lines below the anchor replay the container's motion
      // with a per-line delay (bounded to what's on screen)
      for (var j = lagged.length - 1; j >= 0; j--) clearLag(lagged[j]);
      lagged.length = 0;
      if (S.cascade && !document.hidden) {
        for (var i = anchor + 1; i < items.length; i++) {
          var m = items[i];
          if (m.natY > spr.target + vh * 1.3) break;
          m.lagDelay = Math.min((i - anchor) * S.cascadeStep, S.cascadeMax);
          if (m.lagDelay > 0) { lagged.push(m); m.el.classList.add("lyra-lag"); } // promoted for exactly the cascade window
        }
      }
    }
    function snapScroll() {
      spr.y = spr.target; spr.v = 0; spr.settled = true;
      hist.length = 0;
      for (var i = 0; i < lagged.length; i++) clearLag(lagged[i]);
      lagged.length = 0;
      writeCanvas(true);
    }
    function clearLag(m) {
      m.lagDelay = 0;
      m.el.classList.remove("lyra-lag");
      if (m.lagY !== null) { m.lagY = null; m.el.style.translate = ""; stat.styleWrites++; }
    }
    function writeCanvas(force) {
      var y = -spr.y;
      if (!force && Math.abs(y - lastCanvasY) < 0.18) return;
      lastCanvasY = y;
      canvas.style.translate = "0 " + y.toFixed(2) + "px";
      stat.styleWrites++;
    }
    function sampleHist(t) {
      // newest-to-oldest linear scan; the buffer is tiny (~1s of frames)
      if (!hist.length) return spr.y;
      for (var i = hist.length - 1; i >= 0; i--) {
        if (hist[i].t <= t) {
          if (i === hist.length - 1) return hist[i].y;
          var a = hist[i], b2 = hist[i + 1];
          var f = (t - a.t) / Math.max(1, b2.t - a.t);
          return a.y + (b2.y - a.y) * f;
        }
      }
      return hist[0].y;
    }
    function stepScroll(now, dtMs) {
      var userMode = now < userUntil;
      var k = userMode ? S.userK : adaptedK;
      var zeta = userMode ? 1 : S.followZeta;
      if (!spr.settled) {
        var dt = Math.min(dtMs, 90) / 1000;
        var n = dt > 0.021 ? Math.min(6, Math.ceil(dt / 0.016)) : 1;
        var h = dt / n, c = 2 * zeta * Math.sqrt(k);
        for (var s = 0; s < n; s++) {
          spr.v += (-k * (spr.y - spr.target) - c * spr.v) * h;
          spr.y += spr.v * h;
        }
        if (Math.abs(spr.y - spr.target) < 0.12 && Math.abs(spr.v) < 1.5) {
          spr.y = spr.target; spr.v = 0; spr.settled = true;
        }
        writeCanvas(false);
      }
      // motion history for the cascade
      if (!spr.settled || lagged.length) {
        hist.push({ t: now, y: spr.y });
        if (hist.length > 100) hist.splice(0, hist.length - 100);
      }
      // delayed followers
      for (var i2 = lagged.length - 1; i2 >= 0; i2--) {
        var m = lagged[i2];
        var yi = sampleHist(now - m.lagDelay);
        var off = yi - spr.y; // >0 while the line is still behind the container
        if (spr.settled && Math.abs(off) < 0.25) {
          clearLag(m);
          lagged.splice(i2, 1);
          continue;
        }
        // slight amplification with distance makes the ripple legible as a wave
        off *= 1 + Math.min(0.15, m.lagDelay / 2200);
        if (m.lagY === null || Math.abs(off - m.lagY) > 0.22) {
          m.lagY = off;
          m.el.style.translate = "0 " + off.toFixed(2) + "px";
          stat.styleWrites++;
        }
      }
    }

    // --- input -----------------------------------------------------------------
    function onWheel(e) {
      if (!measured) return;
      userUntil = performance.now() + S.userIdleMs;
      spr.target = clamp(spr.target + e.deltaY, 0, maxScroll);
      spr.settled = false;
      // in-flight cascade lines are NOT snapped here (visible pop); they keep
      // replaying the now-user-driven motion and converge via the settle path
    }
    var drag = null;
    function onPointerDown(e) {
      if (e.pointerType === "mouse" || !measured) return;
      drag = { y: e.clientY, t0: spr.target };
      userUntil = performance.now() + S.userIdleMs;
      root.setPointerCapture && root.setPointerCapture(e.pointerId);
      root.addEventListener("pointermove", onPointerMove);
      root.addEventListener("pointerup", onPointerUp);
      root.addEventListener("pointercancel", onPointerUp);
    }
    function onPointerMove(e) {
      if (!drag) return;
      userUntil = performance.now() + S.userIdleMs;
      spr.target = clamp(drag.t0 + (drag.y - e.clientY), 0, maxScroll);
      spr.settled = false;
    }
    function onPointerUp() {
      drag = null;
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerup", onPointerUp);
      root.removeEventListener("pointercancel", onPointerUp);
    }
    function onLineClick(e) {
      var t = e.target;
      while (t && t !== content && !t._lyra) t = t.parentNode;
      if (t && t._lyra) {
        userUntil = 0; // clicking a line hands control back to auto-follow
        try { onSeek(t._lyra.start); } catch (x) {}
      }
    }
    function onVisibility() {
      if (!document.hidden && !destroyed) resync();
    }

    // --- states ----------------------------------------------------------------
    function setDist(m, cls) {
      if (m._dist === cls) return;
      if (m._dist) m.el.classList.remove(m._dist);
      if (cls) m.el.classList.add(cls);
      m._dist = cls;
    }
    function applyDistances() {
      if (anchor < 0) { // pre-song: no distance grading, just clear stale marks
        for (var c0 = 0; c0 < marked.length; c0++) { setDist(marked[c0], null); marked[c0].el.classList.remove("lyra-near"); }
        marked = [];
        return;
      }
      var next = [];
      for (var i = Math.max(0, anchor - 5); i <= Math.min(items.length - 1, anchor + 7); i++) {
        if (i === anchor) { setDist(items[i], null); }
        else {
          var d = Math.min(4, Math.abs(i - anchor));
          setDist(items[i], "lyra-d" + d);
        }
        var near = i >= anchor - 2 && i <= anchor + 4;
        items[i].el.classList.toggle("lyra-near", near);
        next.push(items[i]);
      }
      for (var j = 0; j < marked.length; j++) {
        var m = marked[j];
        if (next.indexOf(m) === -1) { setDist(m, null); m.el.classList.remove("lyra-near"); }
      }
      marked = next;
    }
    function setState(i, st) {
      var m = items[i];
      if (m._state === st) return;
      m._state = st;
      var cl = m.el.classList;
      cl.toggle("lyra-active", st === 1);
      if (m.kind === "interlude") {
        if (st !== 1 && m._exit) { m._exit = false; cl.remove("lyra-int-exit"); }
        if (st !== 1 && m._if !== -1) { m._if = -1; m.el.style.setProperty("--ifill", "0"); }
      } else if (st !== 1) {
        resetWords(m);
      }
    }
    function resetWords(m) {
      for (var w = 0; w < m.words.length; w++) releaseWord(m.words[w]);
      for (var g = 0; g < m.bgGroups.length; g++)
        for (var bw = 0; bw < m.bgGroups[g].words.length; bw++) releaseWord(m.bgGroups[g].words[bw]);
    }
    // normal advance: a still-lifted word (the line's last word, usually) keeps its
    // drop animation while the line recedes; classes/fills clean up when it lands.
    // resync/seek passes (hardPass) zero everything instantly as before.
    function releaseWord(wm) {
      if (!hardPass && wm._lift > 0) coolWord(wm, frameNow, true);
      else resetWord(wm);
    }
    function resetWord(wm) {
      if (wm._ws !== -1) { wm._ws = -1; wm.el.classList.remove("lyra-w-cur", "lyra-w-sung"); }
      wm.el.classList.remove("lyra-w-hold");
      uncool(wm);
      applyLift(wm, 0);
      for (var s = 0; s < wm.syls.length; s++) resetSyl(wm.syls[s]);
    }
    function resetSyl(sy) {
      if (sy._ss !== -1) {
        sy._ss = -1;
        sy.el.classList.remove("lyra-s-cur", "lyra-s-sung");
        if (sy.gel) sy.gel.classList.remove("lyra-s-cur", "lyra-s-sung");
      }
      if (sy._f !== -1) {
        sy._f = -1;
        sy.el.style.removeProperty("--fill");
        if (sy.gel) sy.gel.style.removeProperty("--fill");
        stat.styleWrites++;
      }
    }
    function setSylState(sy, st) {
      if (sy._ss === st) return;
      sy._ss = st;
      sy.el.classList.toggle("lyra-s-cur", st === 1);
      sy.el.classList.toggle("lyra-s-sung", st === 2);
      if (sy.gel) {
        sy.gel.classList.toggle("lyra-s-cur", st === 1);
        sy.gel.classList.toggle("lyra-s-sung", st === 2);
      }
      if (st !== 1 && sy._f !== -1) {
        sy._f = -1;
        sy.el.style.removeProperty("--fill");
        if (sy.gel) sy.gel.style.removeProperty("--fill");
      }
    }
    // --- word-lift envelope ----------------------------------------------------
    // lift(t): smoothstep attack over the word's start -> sustain at the word's
    // amplitude -> 260ms smoothstep release AFTER the word ends (cooling set).
    // All values are functions of song time, so handoffs are continuous no matter
    // how dense the words are, and seeks land on the exact correct pose.
    var cooling = [];
    var hardPass = false;      // resync/seek state passes zero lifts instantly; normal
                               // line advances let the release play out (no slam)
    var frameNow = 0;          // timestamp of the current frame, for state-pass cooling
    var LIFT_EM = 0.022, LIFT_SCALE = 0.032, RELEASE_MS = 380;
    var HOLD_MS = 800;         // a current word at least this long gets the held-note treatment
    var SCALE_CAP_PX = 4; // max ABSOLUTE horizontal growth: % scale on a long word
                          // otherwise eats the inter-word space and words clip together
    function smooth(x) { return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x); }
    function applyLift(wm, v) {
      var q = Math.round(v * 50) / 50; // 0.02 steps
      if (wm._lift === q) return;
      wm._lift = q;
      if (q <= 0) {
        wm.el.style.translate = "";
        wm.el.style.scale = "";
        if (wm.glow) wm.glow.style.opacity = "";
      } else {
        var sc = LIFT_SCALE;
        if (wm.px && LIFT_SCALE * wm.px > SCALE_CAP_PX) sc = SCALE_CAP_PX / wm.px;
        wm.el.style.translate = "0 " + (-(LIFT_EM * q)).toFixed(4) + "em";
        wm.el.style.scale = (1 + sc * q).toFixed(4);
        if (wm.glow) wm.glow.style.opacity = Math.min(1, 0.85 * q).toFixed(3);
      }
      stat.styleWrites++;
    }
    function uncool(wm) {
      for (var i = 0; i < cooling.length; i++) if (cooling[i].wm === wm) { cooling.splice(i, 1); return; }
    }
    function coolWord(wm, now, deferReset) {
      if (wm._lift <= 0) return;
      for (var i = 0; i < cooling.length; i++) {
        if (cooling[i].wm === wm) { // already mid-drop: keep its timing, never restart
          if (deferReset) cooling[i].deferReset = true;
          return;
        }
      }
      cooling.push({ wm: wm, from: wm._lift, t0: now, deferReset: !!deferReset });
    }
    function stepCooling(now) {
      for (var i = cooling.length - 1; i >= 0; i--) {
        var c = cooling[i], k = (now - c.t0) / RELEASE_MS;
        if (k >= 1) {
          applyLift(c.wm, 0);
          var wm = c.wm, defer = c.deferReset;
          cooling.splice(i, 1);
          wm.el.classList.remove("lyra-w-hold"); // held-note bloom ends when the drop lands
          if (defer) resetWord(wm); // class/fill cleanup we postponed so the drop could play
          continue;
        }
        applyLift(c.wm, c.from * smooth(1 - k));
      }
    }

    function setSylFill(sy, pct) {
      var q = Math.round(pct); // whole percent: a syllable is narrow
      if (sy._f === q) return;
      sy._f = q;
      var v = q + "%";
      sy.el.style.setProperty("--fill", v);
      if (sy.gel) sy.gel.style.setProperty("--fill", v);
      stat.styleWrites++;
    }

    // strict single playhead per word group: at most ONE word mid-sweep, and
    // within it at most ONE syllable carries the gradient.
    function sweepGroup(words, pos, now) {
      var playhead = false;
      for (var w = 0; w < words.length; w++) {
        var wm = words[w];
        var st = wm.start, en = Math.max(st + 1, wm.end);
        var wstate;
        if (playhead) wstate = 0;                       // not reached yet
        else if (pos >= en) wstate = 2;                 // sung
        else { wstate = pos < st ? 0 : 1; playhead = true; }
        if (wm._ws !== wstate) {
          var was = wm._ws;
          wm._ws = wstate;
          wm.el.classList.toggle("lyra-w-cur", wstate === 1);
          wm.el.classList.toggle("lyra-w-sung", wstate === 2);
          if (wstate === 1) {
            uncool(wm);
            if (en - st >= HOLD_MS) wm.el.classList.add("lyra-w-hold"); // held-note bloom tier
          } else {
            if (was === 1) coolWord(wm, now); // finished word: soft settle (drops w-hold on landing)
            for (var r = 0; r < wm.syls.length; r++) resetSyl(wm.syls[r]);
          }
        }
        if (wstate !== 1) continue;
        // lift envelope: smoothstep attack sized to the word, sustain at its
        // amplitude; long holds swell substantially ACROSS the hold, with a
        // gentle ~1.1s shimmer (song-time driven). Scale stays pixel-capped in
        // applyLift, so the swell can't clip into neighbors.
        if (wm.pop > 0) {
          var wdur = en - st;
          var e = smooth((pos - st) / Math.max(1, Math.min(120, wdur * 0.35)));
          if (wdur >= HOLD_MS) {
            var hp = smooth((pos - st) / wdur);
            e *= 1 + hp * (0.5 + 0.06 * Math.sin((pos - st) / 175));
          }
          applyLift(wm, wm.pop * e);
        }
        // syllable walk inside the current word
        var sPlay = false;
        for (var s = 0; s < wm.syls.length; s++) {
          var sy = wm.syls[s];
          var ss;
          if (sPlay) ss = 0;
          else if (pos >= sy.end) ss = 2;
          else { ss = pos < sy.start ? 0 : 1; sPlay = true; }
          setSylState(sy, ss);
          if (ss === 1) setSylFill(sy, ((pos - sy.start) / Math.max(1, sy.end - sy.start)) * 100);
        }
      }
    }

    // --- the frame -------------------------------------------------------------
    function findAnchor(pos) {
      var a = anchor < 0 ? -1 : anchor;
      if (a >= items.length) a = items.length - 1;
      while (a + 1 < items.length && items[a + 1].start <= pos) a++;
      while (a >= 0 && items[a].start > pos) a--;
      return a;
    }

    function frame(pos, now, dtMs) {
      now = now == null ? performance.now() : now;
      frameNow = now;
      var t0 = performance.now();
      if (!items.length || !root) return;

      var a = findAnchor(pos);
      if (a !== anchor) {
        var prev = anchor;
        anchor = a;
        for (var i = 0; i < items.length; i++) {
          // the active-hold window matches the sweep/expiry windows (a-3..a); a
          // wider hold would freeze lines mid-sweep with no one updating them
          var st = i === a ? 1
            : i < a ? (i >= a - 3 && pos < items[i].end + S.graceMs ? 1 : 0)   // finishing duet partner stays lit
            : 2;
          setState(i, st);
        }
        applyDistances();
        if (a >= 0 && prev !== a) retarget(false);
      } else if (a >= 0) {
        // keep overlapping earlier lines fresh (duet partner expiring mid-anchor)
        for (var k2 = Math.max(0, a - 3); k2 < a; k2++) {
          if (items[k2]._state === 1 && pos >= items[k2].end + S.graceMs) setState(k2, 0);
        }
      }

      // word sweeps on everything currently lit
      if (a >= 0) {
        for (var j = Math.max(0, a - 3); j <= a; j++) {
          var m = items[j];
          if (m._state !== 1) continue;
          if (m.kind === "interlude") {
            var span = Math.max(1, m.end - m.start);
            var f = clamp((pos - m.start) / span, 0, 1);
            var qf = Math.round(f * 100) / 100;
            if (m._if !== qf) { m._if = qf; m.el.style.setProperty("--ifill", qf); stat.styleWrites++; }
            var exiting = m.end - pos < 450;
            if (m._exit !== exiting) { m._exit = exiting; m.el.classList.toggle("lyra-int-exit", exiting); }
          } else {
            sweepGroup(m.words, pos, now);
            for (var g = 0; g < m.bgGroups.length; g++) sweepGroup(m.bgGroups[g].words, pos, now);
          }
        }
      }
      stepCooling(now); // finished words settling back down

      // manual-scroll window expired: glide back to the active line even if no
      // new anchor change happens for a while
      if (userUntil && now >= userUntil) { userUntil = 0; retarget(false); }

      if (measured) stepScroll(now, dtMs == null ? 16.7 : dtMs);

      stat.frames++;
      stat.lastMs = performance.now() - t0;
      if (stat.lastMs > stat.worstMs) stat.worstMs = stat.lastMs;
    }

    // one-shot cascade replay around the new anchor: Apple plays this after seeks
    // (never on visibility returns - those must be seamless)
    function replayEntrance() {
      if (!S.entrance || reduced || document.hidden || anchor < 0 || !items.length) return;
      var from = Math.max(0, anchor - 2), to = Math.min(items.length - 1, anchor + 9);
      var targets = [];
      for (var i = from; i <= to; i++) {
        items[i].el.classList.remove("lyra-enter");
        targets.push(items[i]);
      }
      nativeRAF(function () {
        for (var j = 0; j < targets.length; j++) {
          targets[j].el.classList.add("lyra-enter");
          targets[j].el.style.animationDelay = (j * 36) + "ms";
        }
      });
    }

    // full resync with transitions disabled: used after seeks and alt-tab returns
    function resync() {
      if (!root) return;
      root.classList.add("lyra-cut");
      try { est = getPos(); } catch (e) { est = lastRaw >= 0 ? lastRaw : 0; }
      if (!isFinite(est)) est = lastRaw >= 0 && isFinite(lastRaw) ? lastRaw : 0;
      lastRaw = est; lastT = performance.now();
      anchor = -2; // force full state pass
      hardPass = true;
      try { frame(est, lastT, 16.7); } finally { hardPass = false; }
      retarget(true);
      snapScroll();
      nativeRAF(function () { nativeRAF(function () { if (root) root.classList.remove("lyra-cut"); }); });
    }

    // --- loop ------------------------------------------------------------------
    function tick(nowIn) {
      if (!running || destroyed) return;
      raf = nativeRAF(tick);
      var now = typeof nowIn === "number" ? nowIn : performance.now();
      var dt = lastT ? now - lastT : 16.7;
      lastT = now;
      if (dt > 250) dt = 250;

      // a throwing/NaN position source must degrade, not storm or poison est
      var raw;
      try { raw = getPos(); } catch (e) { raw = lastRaw; }
      if (!isFinite(raw)) raw = isFinite(lastRaw) ? lastRaw : 0;
      if (!isFinite(est)) est = raw;
      var playing = true;
      try { playing = !!isPlaying(); } catch (e) {}

      // idle short-circuit: paused, position unchanged, nothing in motion
      if (!playing && raw === lastRaw && spr.settled && !lagged.length && !cooling.length) { est = raw; return; }

      // clock smoothing + jump detection (handles coarse position sources)
      if (!playing) {
        if (Math.abs(raw - est) > 2) {
          var big = Math.abs(raw - est) > 900;
          est = raw; resyncSoft(raw);
          if (big) replayEntrance();
        }
      } else {
        est += dt;
        var err = raw - est;
        if (Math.abs(err) > 900) { est = raw; lastRaw = raw; resync(); replayEntrance(); return; }
        est += err * 0.12;
      }
      lastRaw = raw;
      frame(est, now, dt);
    }
    function resyncSoft(pos) {
      anchor = -2;
      hardPass = true;
      try { frame(pos, performance.now(), 16.7); } finally { hardPass = false; }
    }

    function start() {
      if (running || destroyed) return;
      running = true;
      lastT = 0;
      raf = nativeRAF(tick);
    }
    function stop() {
      running = false;
      if (raf) { try { cancelAnimationFrame(raf); } catch (e) {} raf = null; }
    }

    // --- api -------------------------------------------------------------------
    function load(input) {
      if (destroyed) return false;
      var m = input && input.lines ? input : Lyra.parse(input && (input.ttml || input.lrc || input.json) || input);
      model = m;
      if (!root) scaffold();
      status(null);
      if (!m || !m.lines || !m.lines.length) {
        content && (content.textContent = "");
        items = [];
        status("No lyrics for this track");
        return false;
      }
      build();
      resync();
      return true;
    }

    function destroy() {
      destroyed = true;
      stop();
      if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
      else window.removeEventListener("resize", queueMeasure);
      document.removeEventListener("visibilitychange", onVisibility);
      if (bg && bg.destroy) { try { bg.destroy(); } catch (e) {} }
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = viewport = canvas = content = null;
      items = []; lagged = []; marked = []; cooling = [];
    }

    return {
      load: load,
      start: start,
      stop: stop,
      destroy: destroy,
      frame: function (pos) { frame(pos, performance.now(), 16.7); },
      resync: resync,
      status: status,
      remeasure: queueMeasure,
      setCover: function (url, accent) { if (bg && bg.setCover) bg.setCover(url, accent); else pendingCover = [url, accent]; },
      stats: function () { return { frames: stat.frames, styleWrites: stat.styleWrites, lastMs: stat.lastMs, worstMs: stat.worstMs, items: items.length, anchor: anchor }; },
      get settings() { return S; },
      get lineCount() { return items.length; },
    };
  };
})(typeof window !== "undefined" ? window : globalThis);
// Lyra — ambient album-art background.
//
// The cover is downsampled ONCE to a tiny canvas (the downsample IS the blur;
// bilinear upscaling plus a static CSS blur finishes the job), then two big
// layers drift with pure CSS transform animations. Nothing repaints per frame:
// the layers rasterize once and the compositor does the rest. Cover changes
// crossfade between two stacked groups. Always dark; text stays readable via a
// fixed scrim + vignette.
(function (global) {
  "use strict";
  var Lyra = global.Lyra = global.Lyra || {};

  var CSS = "" +
".lyra-bg{position:absolute;inset:0;overflow:hidden;z-index:0;background:#0b0b0f;}" +
".lyra-bg~.lyra-viewport{z-index:1;}" +
".lyra-bg-grp{position:absolute;inset:0;opacity:0;transition:opacity 1.1s ease;}" +
".lyra-bg-grp.lyra-bg-in{opacity:1;}" +
".lyra-bg-layer{position:absolute;left:50%;top:50%;margin:-80vmax 0 0 -80vmax;width:160vmax;height:160vmax;" +
"border-radius:38%;filter:blur(56px) saturate(1.6);will-change:transform;}" +
".lyra-bg-a{animation:lyra-bg-a 80s linear infinite;opacity:.85;}" +
".lyra-bg-b{animation:lyra-bg-b 100s linear infinite;opacity:.6;}" +
"@keyframes lyra-bg-a{from{transform:rotate(0deg) translate(6vmax,0) scale(1);}50%{transform:rotate(180deg) translate(6vmax,0) scale(1.18);}to{transform:rotate(360deg) translate(6vmax,0) scale(1);}}" +
"@keyframes lyra-bg-b{from{transform:rotate(360deg) translate(-8vmax,2vmax) scale(1.25);}50%{transform:rotate(180deg) translate(-8vmax,2vmax) scale(1.05);}to{transform:rotate(0deg) translate(-8vmax,2vmax) scale(1.25);}}" +
".lyra-bg-scrim{position:absolute;inset:0;" +
"background:radial-gradient(ellipse at 50% 40%,rgba(0,0,0,.28) 0%,rgba(0,0,0,.66) 100%),rgba(8,8,12,.38);}" +
"@media (prefers-reduced-motion:reduce){.lyra-bg-layer{animation:none!important;}}";

  function injectCSS() {
    if (document.getElementById("lyra-bg-css")) return;
    var s = document.createElement("style");
    s.id = "lyra-bg-css";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // tiny downsample of the artwork; returns {canvas, avg:[r,g,b]}
  function crush(img, size) {
    var c = document.createElement("canvas");
    c.width = c.height = size;
    var x = c.getContext("2d");
    x.drawImage(img, 0, 0, size, size);
    var avg = [40, 40, 60];
    try {
      var d = x.getImageData(0, 0, size, size).data, r = 0, g = 0, b = 0, n = d.length / 4;
      for (var i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      avg = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    } catch (e) {} // tainted canvas: keep the default, layers still render
    return { canvas: c, avg: avg };
  }

  function fallbackArt(accent) {
    var c = document.createElement("canvas");
    c.width = c.height = 48;
    var x = c.getContext("2d");
    var g = x.createLinearGradient(0, 0, 48, 48);
    g.addColorStop(0, accent || "#2a2440");
    g.addColorStop(0.55, "#16324a");
    g.addColorStop(1, "#101018");
    x.fillStyle = g;
    x.fillRect(0, 0, 48, 48);
    return { canvas: c, avg: [30, 36, 56] };
  }

  function makeLayer(srcCanvas, cls) {
    var c = document.createElement("canvas");
    c.width = c.height = 96;
    c.className = "lyra-bg-layer " + cls;
    var x = c.getContext("2d");
    x.imageSmoothingEnabled = true;
    x.drawImage(srcCanvas, 0, 0, 96, 96);
    return c;
  }

  Lyra.Background = {
    attach: function (rootEl) {
      injectCSS();
      var holder = document.createElement("div");
      holder.className = "lyra-bg";
      rootEl.insertBefore(holder, rootEl.firstChild);
      var scrim = document.createElement("div");
      scrim.className = "lyra-bg-scrim";
      var curGroup = null, token = 0, destroyed = false;

      function show(art) {
        if (destroyed) return;
        var grp = document.createElement("div");
        grp.className = "lyra-bg-grp";
        grp.appendChild(makeLayer(art.canvas, "lyra-bg-a"));
        grp.appendChild(makeLayer(art.canvas, "lyra-bg-b"));
        holder.appendChild(grp);
        holder.appendChild(scrim); // scrim stays on top of whichever groups exist
        var old = curGroup;
        curGroup = grp;
        // double rAF: the class must land AFTER the group's first style recalc,
        // or the opacity transition never runs and the cover hard-cuts
        requestAnimationFrame(function () { requestAnimationFrame(function () { grp.classList.add("lyra-bg-in"); }); });
        if (old) setTimeout(function () { old.remove(); }, 1300);
      }

      return {
        setCover: function (url, accent) {
          var my = ++token;
          if (!url) { show(fallbackArt(accent)); return; }
          var img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = function () { if (my === token) show(crush(img, 24)); };
          img.onerror = function () {
            if (my !== token) return;
            // retry without CORS (drawable but tainted: avg sampling degrades only)
            var img2 = new Image();
            img2.onload = function () { if (my === token) show(crush(img2, 24)); };
            img2.onerror = function () { if (my === token) show(fallbackArt(accent)); };
            img2.src = url;
          };
          img.src = url;
        },
        destroy: function () { destroyed = true; holder.remove(); },
      };
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
