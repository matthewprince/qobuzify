# Security policy

Qobuzify patches the Qobuz desktop app and runs extensions with full access inside it. Security
reports are taken seriously and handled privately.

## Reporting a vulnerability

Report it privately at **https://qobuzify.app/security**. Please do not open a public issue or a
normal bug report for a security problem.

Include enough to reproduce: what the issue is, where it lives (client runtime, an extension, or the
API), the steps to trigger it, and the impact. A contact (email or handle) is optional but lets the
maintainer follow up and credit you.

## What happens next

The report lands privately with the maintainer. Please allow a reasonable window to investigate and
ship a fix before any public disclosure. Fixes go out through the normal release, and the in-app
update prompt tells users to update.

## Scope

In scope: the injected runtime (`runtime/`), the bundled extensions (`extensions/`), the installer
and patch logic (`bin/`, `lib/`), and the lyrics/feedback API (`server/`).

Out of scope: vulnerabilities in Qobuz itself or in third-party services Qobuzify talks to. Report
those to their respective owners.

## Note on extensions

Because an extension is arbitrary JavaScript running with full privileges inside Qobuz, submitted
themes and extensions are reviewed by hand before they ship in the bundled catalog. If you find a
malicious or unsafe submission that slipped through, treat it as a vulnerability and report it here.
