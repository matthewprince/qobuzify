import { useEffect, useState } from "react";

// The single install section. Two honest routes, emphasis driven by the visitor's OS:
//   Windows -> the installer script patches the Qobuz app you already have (fullest
//              experience, adds synced lyrics), needs Node.js.
//   Any OS  -> the standalone app is one download, nothing else needed.
// Latest version + asset sizes come live from the GitHub releases API so the buttons
// track whatever is current without redeploying.
const REPO = "matthewprince/qobuzify";
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const INSTALL_CMD = "irm https://qobuzify.app/install.ps1 | iex";

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
      <circle cx="10.2" cy="7.3" r=".9" fill="var(--pm-bg,#000)" />
      <circle cx="13.8" cy="7.3" r=".9" fill="var(--pm-bg,#000)" />
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
  const [copied, setCopied] = useState(false);
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

  const copyCmd = () =>
    navigator.clipboard?.writeText(INSTALL_CMD).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });

  const find = (id: OSId) => assets?.find((x) => OSES.find((o) => o.id === id)!.is(x.name));
  const deb = assets?.find((a) => a.name.endsWith(".deb"));
  const primaryOS = OSES.find((o) => o.id === (mine === "windows" ? "windows" : mine))!;
  const primaryAsset = find(primaryOS.id);
  const others = OSES.filter((o) => o.id !== primaryOS.id);

  const winPrimary = mine === "windows";

  return (
    <section className="section" id="download">
      <div className="eyebrow">Install</div>
      <h2 className="h-sec">Get Qobuzify</h2>
      <p className="lede">
        Two ways in, both fully reversible and both needing a paid Qobuz subscription (Qobuzify adds
        to Qobuz, it is not a way to get it for free). On Windows, the installer patches the Qobuz app
        you already have. On any OS, the standalone app is one download with nothing else to set up.
        {ver ? <> Latest release is <strong>{ver}</strong>.</> : null}
      </p>

      <div className="routes">
        {/* Route A: patch the installed Windows app */}
        <div className={"route" + (winPrimary ? " route-primary" : "")}>
          <div className="route-badge">Windows, fullest</div>
          <h3>Patch your Qobuz app</h3>
          <p className="route-sub">
            Adds everything including Windows-only synced lyrics. Patches the Qobuz desktop app you
            already installed.
          </p>
          <button className="cmd cmd-lg" onClick={copyCmd} title="Copy install command">
            <code>{INSTALL_CMD}</code>
            <span className="copy">{copied ? "copied" : "copy"}</span>
          </button>
          <div className="chips-req">
            <span className="req">Windows 10 / 11</span>
            <a className="req req-link" href="https://nodejs.org" target="_blank" rel="noopener">
              Needs Node.js
            </a>
            <span className="req">Qobuz app installed</span>
          </div>
          <p className="route-note">
            Backs up the originals first. Undo anytime with <code>qobuzify restore</code>.
          </p>
        </div>

        {/* Route B: standalone app, any OS */}
        <div className={"route" + (!winPrimary ? " route-primary" : "")}>
          <div className="route-badge">macOS, Linux, Windows</div>
          <h3>Standalone app</h3>
          <p className="route-sub">
            The Qobuz web player wrapped with all themes and the full extension suite, in one
            download. Nothing else to install.
          </p>
          <div className="dl-main">
            <div className="dl-os">
              <span className="dl-os-ico">
                <primaryOS.Icon />
              </span>
              {primaryOS.label}
              {primaryOS.id === mine ? <span className="dl-you">your system</span> : null}
            </div>
            {primaryAsset ? (
              <a className="dl-btn" href={primaryAsset.url} download>
                Download {primaryOS.ext} <span className="dl-size">{mb(primaryAsset.size)}</span>
              </a>
            ) : (
              <a className="dl-btn" href={RELEASES} target="_blank" rel="noopener">
                {failed ? "Open releases" : "Loading..."}
              </a>
            )}
          </div>
          <div className="dl-others">
            {others.map((o) => {
              const a = find(o.id);
              return (
                <a
                  key={o.id}
                  className="dl-other"
                  href={a ? a.url : RELEASES}
                  {...(a ? { download: true } : { target: "_blank", rel: "noopener" })}
                >
                  <span className="dl-other-ico"><o.Icon /></span>
                  {o.label} {o.ext}
                </a>
              );
            })}
            {deb ? (
              <a className="dl-other" href={deb.url} download>
                <span className="dl-other-ico"><Penguin /></span>Linux .deb
              </a>
            ) : null}
          </div>
          <p className="route-note">
            Unsigned for now: on macOS right-click and choose Open the first time; on Windows click
            More info then Run anyway.{" "}
            <a href={RELEASES} target="_blank" rel="noopener" className="req-link">
              All files
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}
