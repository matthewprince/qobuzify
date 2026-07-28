# Getting started

Qobuzify ships two ways. Pick the one that matches your setup:

- **The Windows bake** (the rest of this page): the CLI patches the official Qobuz desktop app in place. You keep the native app and its bit-perfect JUCE audio engine, with the Qobuzify runtime, themes, and extensions injected. Windows only, needs Node.
- **The standalone app** (Linux, macOS, Windows): an Electron wrapper around the Qobuz web player carrying the same runtime, themes, and extensions. One download from [qobuzify.app](https://qobuzify.app) or the [GitHub releases](https://github.com/matthewprince/qobuzify/releases), no Node, no patching: download, run, sign in. On Linux it adds bit-perfect output through a bundled player; macOS and Windows builds play through the web player.

Rule of thumb: on Windows with the Qobuz app installed, take the bake. Anywhere else, or for a zero-setup install, take the standalone app.

## Requirements

- The Qobuz desktop app, installed and run at least once
- Node 16 or newer
- Windows (the standalone app above covers Linux and macOS)

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

## Lyrics

Lyrics are zero-setup. The Qobuzify Lyrics extension pulls synced, word-by-word lyrics for the current track through the qobuzify.app cache proxy: no accounts, no credentials, no tokens to configure, and nothing that identifies your Qobuz account. How the proxy works is covered in [lyrics-server.md](lyrics-server.md).

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

Qobuzify checks for a newer release on launch and shows an in-app prompt when one is out. To update, re-run the one-line installer (it keeps your theme and settings):

```
irm https://qobuzify.app/install.ps1 | iex
```

or, from a cloned checkout, `qobuzify update`. Re-running is non-destructive: your live theme choice and enabled extensions are preserved.

## Reporting a problem or contributing

- **Bug or feature request:** [qobuzify.app/issues](https://qobuzify.app/issues), or the "Report a bug" link in the Qobuzify settings (it attaches your version and enabled extensions).
- **A theme or extension to share:** [qobuzify.app/submit](https://qobuzify.app/submit). Approved ones ship in the bundled catalog. See [writing an extension](writing-extensions.md) and [writing a theme](themes.md).
- **A security issue:** report it privately at [qobuzify.app/security](https://qobuzify.app/security), not the public bug form. See the security policy for scope and disclosure.
