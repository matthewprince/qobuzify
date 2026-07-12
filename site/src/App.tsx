import { useEffect, useMemo, useState } from "react";
import { THEMES } from "./themes";
import ThemeCard from "./ThemeCard";
import ThemeSwitcher from "./ThemeSwitcher";
import Downloads from "./Downloads";

const GITHUB = "https://github.com/matthewprince/qobuzify";
const REPO = "matthewprince/qobuzify";

const FEATURES = [
  { title: "10 live themes", body: "Recolor the whole client. Switch instantly from the in-app Marketplace, no relaunch." },
  { title: "A real search", body: "A full-page, instant, ranked, filterable search that replaces the weak native one." },
  { title: "For You", body: "A personalized home built from your own favorites and listening. No algorithms phoning home." },
  { title: "Synced lyrics", body: "Word-by-word karaoke lyrics over an album-cover backdrop, with auto-scroll and click-to-seek." },
  { title: "Listening stats", body: "A private, on-device dashboard: top artists, minutes, streaks, and your play history." },
  { title: "Smart Radio", body: "A real fix for autoplay: a genuinely related queue built from what you are playing." },
  { title: "Playlist tools", body: "Stats, export, deduplicate, and sort, for the playlists you own." },
  { title: "And a stack more", body: "Seek and A-B loop, a sleep timer, keyboard shortcuts, bulk actions, Discord Rich Presence." },
];

const STEPS = [
  { n: "1", title: "Install", body: "One command patches your local Qobuz. It backs up the originals and is fully reversible." },
  { n: "2", title: "Theme", body: "In Qobuz, click your profile picture (top-right) and open the Marketplace, then pick a theme. Switching is live, no relaunch." },
  { n: "3", title: "Extend", body: "The extensions ship on by default. Toggle any of them in that same Marketplace, or open Qobuzify for settings." },
];

const EXTENSIONS = [
  { name: "Better Search", body: "Instant, ranked, filterable search across albums, tracks, artists and playlists." },
  { name: "For You", body: "A personalized home built from your own favorites and listening. No external services." },
  { name: "Qobuzify Lyrics", body: "Synced, word-by-word karaoke lyrics over an album-cover background." },
  { name: "Smart Radio", body: "One click builds a genuinely related queue from what you are playing." },
  { name: "Listening Stats", body: "A private, on-device dashboard: top artists, minutes, streaks, and play history." },
  { name: "Full App Display", body: "A cinematic fullscreen now-playing view with big art, a seek bar, and transport controls." },
  { name: "Playlist Tools", body: "Stats, export, deduplicate, and sort, for the playlists you own." },
  { name: "Discord Presence", body: "Show what you are playing as Discord Rich Presence, with album art and a live progress bar." },
  { name: "Quality Badges", body: "Show the Hi-Res AUDIO badge on hi-res tracks across the whole app." },
  { name: "Seek Controls", body: "Ten-second skip buttons and an A-B loop on the player bar." },
  { name: "Sleep Timer", body: "Stop the music after a set time, or at the end of the track, with a live countdown." },
  { name: "Keyboard Shortcuts", body: "Control playback, seeking, and search from the keyboard. Press ? for the list." },
  { name: "Bulk Actions", body: "Favourite a whole album or playlist at once, or add all of it to another playlist." },
  { name: "Featured Artists", body: "Show the featured and collaborating artists on each track, not just the main one." },
  { name: "Copy & Share", body: "Right-click any track to copy the artist and title, or a shareable link." },
  { name: "Content Filters", body: "Hide the top-nav items you never use for a cleaner, leaner Qobuz." },
  { name: "Simple Client", body: "Hide the Magazine and the editorial promos for a leaner Discover." },
  { name: "Find Available Version", body: "When a track is greyed out in your country, find and play a version that streams for you." },
  { name: "Quality of Life", body: "The most-requested r/qobuz fixes: double-click to play, remembered views, and more." },
];

const TRUST = [
  { q: "Will it get me banned?", a: "No. Qobuzify runs entirely on your machine and never touches your Qobuz account, password, or subscription. It patches the local app only." },
  { q: "Is it reversible?", a: "Yes. It backs up the originals before patching, and one command restores stock Qobuz." },
  { q: "Does anything phone home?", a: "No. Themes, For You, and Listening Stats are all computed on your device." },
  { q: "Is it open source?", a: "Yes. Every line is on GitHub. Read it, fork it, or build your own theme." },
];

function useStars() {
  const [stars, setStars] = useState<number | null>(null);
  useEffect(() => {
    fetch(`https://api.github.com/repos/${REPO}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => typeof d.stargazers_count === "number" && setStars(d.stargazers_count))
      .catch(() => {});
  }, []);
  return stars;
}

export default function App() {
  const [copied, setCopied] = useState(false);
  const [q, setQ] = useState("");
  const stars = useStars();

  const copyRestore = () =>
    navigator.clipboard?.writeText("qobuzify restore").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return EXTENSIONS;
    return EXTENSIONS.filter((e) => (e.name + " " + e.body).toLowerCase().includes(s));
  }, [q]);

  return (
    <>
      <nav className="nav">
        <div className="nav-inner">
          <a className="nav-brand" href="/">
            <img src="/qobuzify-wordmark.svg" alt="Qobuzify" />
          </a>
          <div className="nav-links">
            <a href="/#themes">Themes</a>
            <a href="/#extensions">Extensions</a>
            <a href="/docs/">Docs</a>
            <a href="https://api.qobuzify.app">API</a>
            <a href={GITHUB} target="_blank" rel="noopener">GitHub</a>
            <a className="nav-cta" href="/#download">Get Qobuzify</a>
          </div>
        </div>
      </nav>

      <div className="page">
        <div className="glow" />

        <header className="hero">
          <div className="kicker">Spicetify, but for Qobuz</div>
          <h1>Make the Qobuz app yours.</h1>
          <p className="tag">
            Live themes, a full-page search, a home built from your own library, word-by-word synced
            lyrics, and a stack of quality-of-life tools. It all runs on your machine, and undoes in
            one click.
          </p>
          <div className="hero-cta">
            <a className="btn btn-primary" href="/#download">Get Qobuzify</a>
            <a className="btn btn-ghost" href="/#themes">Browse themes</a>
          </div>
          <div className="proof">
            <span>Open source</span>
            {stars != null ? <span>{stars.toLocaleString()} stars</span> : null}
            <span>{THEMES.length} themes</span>
            <span>{EXTENSIONS.length} extensions</span>
            <span>MIT</span>
          </div>

          <ThemeSwitcher />
        </header>

        <section className="section" id="safe">
          <div className="eyebrow">Safe by design</div>
          <h2 className="h-sec">Safe, open source, and reversible</h2>
          <div className="trust">
            {TRUST.map((t) => (
              <div className="surface trust-card" key={t.q}>
                <h3>{t.q}</h3>
                <p>{t.a}</p>
              </div>
            ))}
          </div>
          <div className="undo">
            <span>Undo anytime</span>
            <button className="cmd" onClick={copyRestore} title="Copy command">
              <code>qobuzify restore</code>
              <span className="copy">{copied ? "copied" : "copy"}</span>
            </button>
          </div>
        </section>

        <section className="section">
          <div className="eyebrow">What you get</div>
          <h2 className="h-sec">Everything Qobuz left out</h2>
          <div className="features">
            {FEATURES.map((f) => (
              <div className="surface feature" key={f.title}>
                <div className="feature-dot" />
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="section" id="themes">
          <div className="eyebrow">{THEMES.length} themes</div>
          <h2 className="h-sec">Ten looks, switch them live</h2>
          <p className="lede">
            Every theme recolors the whole client through Qobuz's own variables. Switch between them
            instantly from the in-app Marketplace, no relaunch. Preview them right here.
          </p>
          <div className="gallery">
            {THEMES.map((t) => (
              <ThemeCard key={t.slug} theme={t} />
            ))}
          </div>
        </section>

        <Downloads />

        <section className="section" id="extensions">
          <div className="eyebrow">{EXTENSIONS.length} extensions</div>
          <h2 className="h-sec">All built in, on by default</h2>
          <p className="lede">
            Manage them from the in-app Marketplace (your profile picture, top-right). Here is the
            full set.
          </p>
          <input
            className="search"
            type="search"
            placeholder="Search extensions..."
            aria-label="Search extensions"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="ext-list">
            {shown.map((e) => (
              <div className="ext" key={e.name}>
                <span className="ext-dot" />
                <div>
                  <h3>{e.name}</h3>
                  <p>{e.body}</p>
                </div>
              </div>
            ))}
            {shown.length === 0 ? <p className="ext-none">No extensions match "{q}".</p> : null}
          </div>
        </section>

        <section className="section">
          <div className="eyebrow">How it works</div>
          <h2 className="h-sec">One small runtime, nothing forked</h2>
          <p className="lede">
            The Qobuz desktop app is unpacked Electron with an open content policy, so Qobuzify injects
            one small runtime into it: a live theme engine, an in-app Marketplace, and an extension
            loader that adds features by driving the app's own interface. Nothing is forked or rebuilt,
            and one command puts everything back.
          </p>
          <div className="steps">
            {STEPS.map((s) => (
              <div className="surface step" key={s.n}>
                <div className="step-n">{s.n}</div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        <footer className="foot">
          <div className="foot-links">
            <a href={GITHUB} target="_blank" rel="noopener">GitHub</a>
            <span>·</span>
            <a href="/docs/">Docs</a>
            <span>·</span>
            <a href="/issues">Report a bug</a>
            <span>·</span>
            <a href="/submit">Submit a theme or extension</a>
            <span>·</span>
            <a href="/security">Security</a>
            <span>·</span>
            <a href="/unban">Unblock IP</a>
          </div>
          <div className="foot-info">
            {THEMES.length} themes · {EXTENSIONS.length} extensions · runs on your machine · qobuzify.app
          </div>
        </footer>
      </div>
    </>
  );
}
