import { useEffect, useState } from "react";

// Pulls the latest release straight from the GitHub API so the buttons track whatever
// version is current without the site ever being redeployed. Falls back to the releases
// page if the API is unreachable (rate limit, offline).
const REPO = "matthewprince/qobuzify";
const RELEASES = `https://github.com/${REPO}/releases/latest`;

type Asset = { name: string; size: number; url: string };
type OSId = "mac" | "linux" | "windows";

function Apple() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  );
}
function Windows() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3 4.3 10.4 3.3v7.4H3zM11.3 3.2 21 2v8.7h-9.7zM3 12.6h7.4V20L3 19zM11.3 12.6H21V22l-9.7-1.3z" />
    </svg>
  );
}
function Penguin() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.2c-2.1 0-3.6 1.7-3.6 3.9 0 .7.1 1.3-.1 1.8-.2.5-.6.9-1.1 1.5C6 10.9 5.2 12.6 5.2 14.8c0 1.6.5 3 1.2 4.1.3.5.5.9.3 1.3-.2.4-.7.7-1.1 1-.3.2-.2.7.2.7.9.1 2-.1 2.7-.6.9.5 2 .7 3.3.7s2.4-.2 3.3-.7c.7.5 1.8.7 2.7.6.4 0 .5-.5.2-.7-.4-.3-.9-.6-1.1-1-.2-.4 0-.8.3-1.3.7-1.1 1.2-2.5 1.2-4.1 0-2.2-.8-3.9-2-5.4-.5-.6-.9-1-1.1-1.5-.2-.5-.1-1.1-.1-1.8 0-2.2-1.5-3.9-3.6-3.9z" />
      <circle cx="10.2" cy="7.3" r=".9" fill="var(--bg)" />
      <circle cx="13.8" cy="7.3" r=".9" fill="var(--bg)" />
      <path d="M12 8.1c.7 0 1.3.5 1.3 1s-.6.6-1.3.6-1.3-.1-1.3-.6.6-1 1.3-1z" fill="var(--accent)" />
    </svg>
  );
}

const OSES: { id: OSId; label: string; Icon: () => JSX.Element; ext: string; is: (n: string) => boolean }[] = [
  { id: "mac", label: "macOS", Icon: Apple, ext: ".dmg", is: (n) => n.endsWith(".dmg") },
  { id: "linux", label: "Linux", Icon: Penguin, ext: ".AppImage", is: (n) => n.endsWith(".AppImage") },
  { id: "windows", label: "Windows", Icon: Windows, ext: ".exe", is: (n) => n.endsWith(".exe") },
];

function detectOS(): OSId {
  const p = (navigator.userAgent + " " + (navigator.platform || "")).toLowerCase();
  if (p.includes("mac") || p.includes("iphone") || p.includes("ipad")) return "mac";
  if (p.includes("win")) return "windows";
  return "linux";
}
function mb(bytes: number) {
  return Math.round(bytes / 1048576) + " MB";
}

export default function Downloads() {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [ver, setVer] = useState("");
  const [failed, setFailed] = useState(false);
  const mine = detectOS();

  useEffect(() => {
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => {
        setVer(d.tag_name || "");
        setAssets(
          (d.assets || []).map((a: { name: string; size: number; browser_download_url: string }) => ({
            name: a.name,
            size: a.size,
            url: a.browser_download_url,
          }))
        );
      })
      .catch(() => setFailed(true));
  }, []);

  const deb = assets?.find((a) => a.name.endsWith(".deb"));

  return (
    <section className="section" id="download">
      <h2>Mac &amp; Linux app</h2>
      <p className="lede">
        There is no official Qobuz app for macOS or Linux, so Qobuzify now ships as its own: the
        Qobuz web player wrapped up with all {10} themes and the full extension suite, in one
        download. {ver ? <>Latest is <strong>{ver}</strong>. </> : null}Synced lyrics stay
        Windows-only for now.
      </p>
      <div className="dl-grid">
        {OSES.map((os) => {
          const a = assets?.find((x) => os.is(x.name));
          const isWin = os.id === "windows";
          const primary = os.id === mine && !isWin;
          return (
            <div
              key={os.id}
              className={
                "card dl-card" +
                (primary ? " dl-mine" : "") +
                (isWin ? " dl-backup" : "") +
                (a || failed ? "" : " dl-off")
              }
            >
              {primary ? <span className="dl-badge">Your system</span> : null}
              {isWin ? <span className="dl-badge dl-badge-muted">Backup method</span> : null}
              <div className="dl-icon">
                <os.Icon />
              </div>
              <h3>{os.label}</h3>
              {a ? (
                <a className="dl-btn" href={a.url} download>
                  Download {os.ext}
                </a>
              ) : (
                <a className="dl-btn" href={RELEASES} target="_blank" rel="noopener">
                  {failed ? "Releases" : "Loading…"}
                </a>
              )}
              <span className="dl-meta">{a ? mb(a.size) : os.ext}</span>
              {os.id === "linux" && deb ? (
                <a className="dl-alt" href={deb.url} download>
                  or .deb ({mb(deb.size)})
                </a>
              ) : null}
              {isWin ? (
                <span className="dl-alt">
                  Almost everyone should use the installer up top. This is only a fallback.
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="install-note">
        Unsigned for now: on macOS, right-click the app and choose Open the first time; on Windows,
        click More info then Run anyway.{" "}
        <a href={RELEASES} target="_blank" rel="noopener" className="dl-alt">
          All files
        </a>
      </p>
    </section>
  );
}
