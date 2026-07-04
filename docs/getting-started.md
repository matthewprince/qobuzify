# Getting started

## Requirements

- The Qobuz desktop app, installed and run at least once
- Node 16 or newer
- Windows (macOS is planned; there is no Linux Qobuz desktop app)

Qobuzify has zero runtime dependencies. It is a plain Node CLI plus the files it injects.

## Install

```
git clone <repo> && cd qobuzify
npm link                 # puts `qobuzify` on your PATH
# or skip the link and run: node bin/qobuzify.js <command>
```

Then install the runtime into Qobuz:

```
qobuzify install         # installs with the default theme (Glass)
qobuzify install neon    # or pick a starting theme
```

That injects the runtime, relaunches Qobuz, and you're done. Open Qobuz, click your avatar (top right), and pick **Marketplace** to browse themes and extensions. Theme switching from there is live, no relaunch.

## Commands

```
qobuzify detect           show the Qobuz install Qobuzify will patch
qobuzify list             list available themes
qobuzify install [theme]  install the in-app runtime + Marketplace
qobuzify update           re-apply the current files, keeping your theme and settings
qobuzify apply <theme>    set a theme and relaunch
qobuzify restore          revert to the stock Qobuz UI
qobuzify spotify-login    connect Spotify once for synced lyrics (OAuth, auto-renewed)
qobuzify spotify-token    refresh the lyrics Spotify token from a running Spotify
```

`install` and `apply` do the same injection. The difference is intent: `install` sets up the Marketplace and you switch themes live afterward; `apply <theme>` asserts a specific theme as the active one on the next launch. Both relaunch Qobuz, because the renderer only reads its HTML at startup.

Run `detect` first if you want to see exactly what will be patched:

```
$ qobuzify detect
Qobuz found:
  version   8.2.0
  app dir   ...\Programs\Qobuz\app-8.2.0\resources\dist
  app.html  ...\dist\www\app.html
  legacy    ...\dist\www\...\legacy.css
  launcher  ...\Programs\Qobuz\Qobuz.exe
```

## Optional: lyrics sources

The Qobuzify Lyrics extension works out of the box using open sources (NetEase and LRCLIB). Two optional setups improve it:

- **Spotify login** (`qobuzify spotify-login`) unlocks the Qz Lyrics backend for more word-by-word coverage. It is a one-time OAuth flow; the token then auto-renews. You need a Spotify app client ID in `.spotify-creds.json`.
- **Apple Music credentials** (a developer token and media-user token in `.apple-creds.json`) unlock Apple's syllable-timed TTML, the highest-quality source. When present, the installer also patches the main process to set the `Origin` header Apple's API requires.

Neither is required. All of this is local; credentials live in gitignored files next to the CLI and are passed into the runtime payload, never sent anywhere except the source they authenticate.

## Undoing it

```
qobuzify restore
```

Restore copies the original `app.html`, `legacy.css`, and `main-win32.js` back from the `*.qobuzify-bak` backups taken on first install, then relaunches. Qobuzify is fully reversible.

## After a Qobuz update

A Qobuz update installs a fresh `app-<version>` folder, which won't have the runtime. Re-run:

```
qobuzify install
```

It re-detects the current install and patches it.

## Updating Qobuzify

Qobuzify checks for a newer release on launch and shows an in-app prompt when one is out. To update, re-run the one-line installer (it keeps your theme and local credentials):

```
irm https://qobuzify.app/install.ps1 | iex
```

or, from a cloned checkout, `qobuzify update`. Re-running is non-destructive: your live theme choice, enabled extensions, and lyric credentials are preserved.

## Reporting a problem or contributing

- **Bug or feature request:** [qobuzify.app/issues](https://qobuzify.app/issues), or the "Report a bug" link in the Qobuzify settings (it attaches your version and enabled extensions).
- **A theme or extension to share:** [qobuzify.app/submit](https://qobuzify.app/submit). Approved ones ship in the bundled catalog. See [writing an extension](writing-extensions.md) and [writing a theme](themes.md).
- **A security issue:** report it privately at [qobuzify.app/security](https://qobuzify.app/security), not the public bug form. See the security policy for scope and disclosure.
