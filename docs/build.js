// Render the docs/ markdown into one self-contained docs/site.html.
// Zero dependencies (matches the rest of the project): a small markdown
// converter plus a template. Run: node docs/build.js
const fs = require("fs");
const path = require("path");

const DIR = __dirname;

// the real Qobuzify wordmark, inlined so the docs stay self-contained (work as a local file too)
var BRAND_SVG = "";
try { BRAND_SVG = fs.readFileSync(path.join(DIR, "..", "brand", "qobuzify-wordmark-medium.svg"), "utf8").trim(); } catch (e) {}

// sidebar order + grouping + display titles. README renders as "Overview".
const GROUPS = [
  { title: "Start here", docs: [["README", "Overview"], ["getting-started", "Getting started"], ["architecture", "Architecture"]] },
  { title: "Reference", docs: [["api", "The Qobuzify API"], ["extensions", "Bundled extensions"], ["player-control", "Controlling the player"], ["gotchas", "Gotchas"]] },
  { title: "Building", docs: [["writing-extensions", "Writing an extension"], ["themes", "Writing a theme"]] },
  { title: "Subsystems", docs: [["lyrics-server", "Lyrics cache-proxy"], ["dev-workflow", "Dev workflow"]] }
];

function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function slug(s) { return s.toLowerCase().replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, ""); }

// map a markdown link href to something that works in the single page:
// foo.md -> #foo, external stays, everything else (templates/, anchors) is left alone.
function href(u) {
  if (/^https?:/.test(u) || u[0] === "#") return u;
  var m = u.match(/^([\w-]+)\.md$/);
  return m ? "#" + m[1] : u;
}

function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, function (_, c) { return "<code>" + c + "</code>"; });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, t, u) {
    var mapped = href(u);
    if (mapped[0] === "#" && /\.md$/.test(t)) t = t.replace(/\.md$/, ""); // tidy ".md" out of link text in the single-page render
    return '<a href="' + mapped + '">' + t + "</a>";
  });
  return s;
}

// convert one markdown doc to HTML. docSlug scopes sub-heading ids so they can't collide.
function mdToHtml(md, docSlug) {
  var lines = md.replace(/\r\n/g, "\n").split("\n");
  var out = [], i = 0;
  function flushList(tag, items) { out.push("<" + tag + ">" + items.map(function (x) { return "<li>" + inline(x) + "</li>"; }).join("") + "</" + tag + ">"); }

  while (i < lines.length) {
    var line = lines[i];

    // fenced code block
    if (/^```/.test(line)) {
      var lang = line.slice(3).trim(), buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // closing fence
      out.push('<pre><code' + (lang ? ' class="lang-' + lang + '"' : "") + ">" + esc(buf.join("\n")) + "</code></pre>");
      continue;
    }

    // table (a header row followed by a |---| separator)
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      var cells = function (r) { return r.replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); }); };
      var head = cells(line);
      i += 2;
      var rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      var th = "<tr>" + head.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("") + "</tr>";
      var tb = rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>"; }).join("");
      out.push("<table><thead>" + th + "</thead><tbody>" + tb + "</tbody></table>");
      continue;
    }

    // heading
    var h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      var level = h[1].length, text = h[2];
      if (level === 1) { out.push('<h1 id="' + docSlug + '">' + inline(text) + "</h1>"); }
      else { out.push("<h" + level + ' id="' + docSlug + "--" + slug(text) + '">' + inline(text) + "</h" + level + ">"); }
      i++; continue;
    }

    // unordered list
    if (/^[-*]\s+/.test(line)) {
      var ul = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) { ul.push(lines[i].replace(/^[-*]\s+/, "")); i++; }
      flushList("ul", ul); continue;
    }

    // ordered list
    if (/^\d+\.\s+/.test(line)) {
      var ol = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) { ol.push(lines[i].replace(/^\d+\.\s+/, "")); i++; }
      flushList("ol", ol); continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      var bq = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { bq.push(lines[i].replace(/^>\s?/, "")); i++; }
      out.push("<blockquote>" + inline(bq.join(" ")) + "</blockquote>"); continue;
    }

    // blank
    if (!line.trim()) { i++; continue; }

    // paragraph (join consecutive plain lines)
    var para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|[-*]\s|\d+\.\s|>\s?|\|)/.test(lines[i])) { para.push(lines[i]); i++; }
    out.push("<p>" + inline(para.join(" ")) + "</p>");
  }
  return out.join("\n");
}

// build the sidebar + sections
var nav = [], sections = [];
GROUPS.forEach(function (g) {
  nav.push('<div class="nav-group">' + esc(g.title) + "</div>");
  g.docs.forEach(function (d) {
    var docSlug = d[0], title = d[1];
    nav.push('<a href="#' + docSlug + '">' + esc(title) + "</a>");
    var md = fs.readFileSync(path.join(DIR, docSlug + ".md"), "utf8");
    // for README, drop its own H1 ("Qobuzify docs") and give the section the display title
    if (docSlug === "README") md = md.replace(/^#\s+.*$/m, "# Overview");
    sections.push('<section>' + mdToHtml(md, docSlug) + "</section>");
  });
});

var CSS = [
  ":root{--acc:#3DA8FE;--bg:#0a0e17;--bg2:#0d1220;--panel:#111726;--line:rgba(255,255,255,.08);--tx:#e7ecf3;--dim:#9aa3b2;}",
  "*{box-sizing:border-box;}",
  "html{scroll-behavior:smooth;scroll-padding-top:20px;}",
  "body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;}",
  ".wrap{display:flex;max-width:1180px;margin:0 auto;}",
  "aside{position:sticky;top:0;align-self:flex-start;height:100vh;overflow-y:auto;width:236px;flex:0 0 236px;padding:26px 16px 40px;border-right:1px solid var(--line);}",
  ".brand{display:block;margin:0 8px 22px;}",
  ".brand:hover{background:none;}",
  ".brand svg{height:22px;width:auto;display:block;}",
  ".nav-group{font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.7px;color:var(--dim);margin:18px 8px 7px;}",
  "aside a{display:block;padding:6px 9px;border-radius:8px;color:#c6cdd9;text-decoration:none;font-size:13.5px;font-weight:550;}",
  "aside a:hover{background:rgba(255,255,255,.05);color:#fff;}",
  "main{flex:1;min-width:0;padding:34px 44px 120px;}",
  "section{border-bottom:1px solid var(--line);padding-bottom:34px;margin-bottom:34px;}",
  "section:last-child{border-bottom:0;}",
  "h1{font-size:30px;font-weight:850;letter-spacing:-.5px;margin:14px 0 14px;padding-top:6px;}",
  "h2{font-size:21px;font-weight:800;letter-spacing:-.2px;margin:30px 0 10px;}",
  "h3{font-size:16.5px;font-weight:750;margin:22px 0 8px;}",
  "h4{font-size:14.5px;font-weight:700;color:var(--dim);margin:18px 0 6px;}",
  "p{margin:11px 0;}",
  "a{color:var(--acc);text-decoration:none;}a:hover{text-decoration:underline;}",
  "strong{color:#fff;font-weight:700;}",
  "code{font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:.88em;background:rgba(124,160,255,.12);color:#cdd9ff;padding:1.5px 6px;border-radius:5px;}",
  "pre{background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:15px 17px;overflow-x:auto;margin:14px 0;}",
  "pre code{background:none;color:#d5deea;padding:0;font-size:12.8px;line-height:1.6;}",
  "ul,ol{margin:11px 0;padding-left:22px;}li{margin:5px 0;}",
  "blockquote{margin:14px 0;padding:2px 16px;border-left:3px solid var(--acc);color:var(--dim);background:rgba(255,255,255,.02);border-radius:0 8px 8px 0;}",
  "table{border-collapse:collapse;margin:16px 0;width:100%;font-size:13.5px;}",
  "th,td{border:1px solid var(--line);padding:8px 12px;text-align:left;}",
  "th{background:var(--panel);font-weight:700;}",
  "td code{font-size:.86em;}",
  "@media(max-width:820px){.wrap{flex-direction:column;}aside{position:static;height:auto;width:auto;flex:none;border-right:0;border-bottom:1px solid var(--line);}main{padding:24px 20px 80px;}}"
].join("\n");

var html = [
  "<!doctype html><html lang=en><head><meta charset=utf-8>",
  '<meta name=viewport content="width=device-width,initial-scale=1">',
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml"><meta name="theme-color" content="#3DA8FE">',
  "<title>Qobuzify docs</title><style>" + CSS + "</style></head><body>",
  '<div class="wrap">',
  '<aside><a class="brand" href="/" aria-label="Qobuzify">' + BRAND_SVG + "</a>" + nav.join("\n") + "</aside>",
  "<main>" + sections.join("\n") + "</main>",
  "</div></body></html>"
].join("\n");

fs.writeFileSync(path.join(DIR, "site.html"), html, "utf8");
console.log("wrote docs/site.html (" + (html.length / 1024).toFixed(0) + " KB, " + sections.length + " sections)");

// also drop a deployable copy into the landing site so qobuzify.app/docs serves it,
// and ship the template starters next to it so their links resolve when hosted.
// one `node docs/build.js` keeps the standalone file and the hosted page in sync.
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  fs.readdirSync(src, { withFileTypes: true }).forEach(function (e) {
    var s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  });
}
var siteDocs = path.join(DIR, "..", "site", "public", "docs");
fs.mkdirSync(siteDocs, { recursive: true });
fs.writeFileSync(path.join(siteDocs, "index.html"), html, "utf8");
copyDir(path.join(DIR, "templates"), path.join(siteDocs, "templates"));
console.log("wrote site/public/docs/index.html + templates (deployable copy)");
