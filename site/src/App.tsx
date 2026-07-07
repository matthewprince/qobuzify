import { useState } from "react";
import { THEMES } from "./themes";
import ThemeCard from "./ThemeCard";
import Downloads from "./Downloads";

const INSTALL_CMD = "irm https://qobuzify.app/install.ps1 | iex";
const GITHUB = "https://github.com/matthewprince/qobuzify";

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
  { n: "2", title: "Theme", body: "In Qobuz, click your profile picture in the top-right and open the Marketplace, then pick from 10 themes. Switching is live, no relaunch." },
  { n: "3", title: "Extend", body: "19 extensions ship on by default. Toggle any of them in that same Marketplace, or open Qobuzify in the menu for settings." },
];

const EXTENSIONS = [
  { name: "Better Search", body: "Instant, ranked, filterable search across albums, tracks, artists and playlists, replacing the weak native one." },
  { name: "For You", body: "A personalized home built from your own favorites and listening. No external services." },
  { name: "Qobuzify Lyrics", body: "Synced, word-by-word karaoke lyrics over an album-cover background." },
  { name: "Smart Radio", body: "One click builds a genuinely related queue from what you're playing. A real fix for autoplay." },
  { name: "Listening Stats", body: "A private, on-device dashboard: top artists, minutes, streaks, and play history." },
  { name: "Full App Display", body: "A cinematic fullscreen now-playing view with big art, a seek bar, and transport controls." },
  { name: "Playlist Tools", body: "Stats, export, deduplicate, and sort, for the playlists you own." },
  { name: "Discord Presence", body: "Show what you're playing as Discord Rich Presence, with album art and a live progress bar." },
  { name: "Quality Badges", body: "Show the Hi-Res AUDIO badge on hi-res tracks across the whole app." },
  { name: "Seek Controls", body: "Ten-second skip buttons and an A-B loop on the player bar." },
  { name: "Sleep Timer", body: "Stop the music after a set time, or at the end of the track, with a live countdown." },
  { name: "Keyboard Shortcuts", body: "Control playback, seeking, and search from the keyboard. Press ? for the list." },
  { name: "Bulk Actions", body: "Favourite a whole album or playlist at once, or add all of it to another playlist." },
  { name: "Featured Artists", body: "Show the featured and collaborating artists on each track, not just the main one." },
  { name: "Copy & Share", body: "Right-click any track to copy the artist and title, or a shareable link." },
  { name: "Content Filters", body: "Hide the top-nav items you never use for a cleaner, leaner Qobuz." },
  { name: "Simple Client", body: "Hide the Magazine and the editorial promos for a leaner Discover." },
  { name: "Find Available Version", body: "When a track is greyed out in your country, find and play a version of the same song that streams for you." },
  { name: "Quality of Life", body: "The most-requested r/qobuz fixes: double-click to play, remembered views, and more." },
];

export default function App() {
  const [copied, setCopied] = useState(false);
  const copyInstall = () => {
    navigator.clipboard?.writeText(INSTALL_CMD).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };
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
            <a href="/api">API</a>
            <a href={GITHUB} target="_blank" rel="noopener">GitHub</a>
            <a href="/unban">Unblock IP</a>
            <button className="nav-cta" onClick={copyInstall}>
              {copied ? "copied" : "Install"}
            </button>
          </div>
        </div>
      </nav>

      <div className="page">
        <div className="glow" />

        <header className="hero">
          <img className="hero-logo" src="/qobuzify-wordmark.svg" alt="Qobuzify" />
          <h1>Spicetify, but for Qobuz.</h1>
        <p className="tag">
          A mod for the Qobuz desktop app. Live themes, a full-page search, a home page built
          from your own library, synced lyrics, and a stack of quality-of-life tools. It all
          lives inside the app, and it is fully reversible.
        </p>
        <div className="install-reco">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 13l4 4L19 7" />
          </svg>
          Recommended install
        </div>
        <button className="install" onClick={copyInstall} title="Copy install command">
          <code>{INSTALL_CMD}</code>
          <span>{copied ? "copied" : "PowerShell · click to copy"}</span>
        </button>
        <p className="install-note">Windows, needs Node.js. Then in Qobuz, open the Marketplace from your profile picture (top-right) to theme and extend. Fully reversible.</p>
      </header>

      <Downloads />

      <section className="section">
        <h2>What you get</h2>
        <div className="features">
          {FEATURES.map((f) => (
            <div className="card feature" key={f.title}>
              <div className="feature-dot" />
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <h2>How it works</h2>
        <p className="lede">
          The Qobuz desktop app is unpacked Electron with an open content policy, so Qobuzify
          injects one small runtime into it: a live theme engine, an in-app Marketplace, and an
          extension loader that adds features by driving the app's own interface. Themes recolor
          through the app's own CSS variables; extensions are small scripts. Nothing is forked or
          rebuilt, and one command puts everything back.
        </p>
        <div className="steps">
          {STEPS.map((s) => (
            <div className="card step" key={s.n}>
              <div className="step-n">{s.n}</div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section" id="themes">
        <h2>Themes</h2>
        <div className="gallery">
          {THEMES.map((t) => (
            <ThemeCard key={t.slug} theme={t} />
          ))}
        </div>
      </section>


      <section className="section" id="extensions">
        <h2>Extensions</h2>
        <p className="lede">
          Nineteen extensions ship on by default. To manage them, click your profile picture in the
          top-right of Qobuz and open the Marketplace. Here is the full set.
        </p>
        <div className="features">
          {EXTENSIONS.map((e) => (
            <div className="card feature" key={e.name}>
              <div className="feature-dot" />
              <h3>{e.name}</h3>
              <p>{e.body}</p>
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
          <div className="foot-info">{THEMES.length} themes · 19 extensions · qobuzify.app</div>
        </footer>
      </div>
    </>
  );
}
