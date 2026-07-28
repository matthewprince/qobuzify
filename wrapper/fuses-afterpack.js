// electron-builder afterPack hook: flip Electron's runtime fuses on the packaged binary.
// electron-builder 25 has no declarative `electronFuses` config (that landed in 26), so this runs
// post-pack via @electron/fuses. RunAsNode / NODE_OPTIONS / --inspect are dev backdoors into a
// process that holds exclusive DAC access and the Qobuz session; asar integrity + onlyLoadAppFromAsar
// are effective on win/mac (electron-builder embeds the asar hash there) and harmless on linux.
// Not packaged into the app (the "files" allowlist doesn't include it).
const path = require("path");
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");

module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const productFilename = context.packager.appInfo.productFilename;
  let binary;
  if (platform === "darwin" || platform === "mas") {
    // SKIPPED on mac for now: this hook runs per-arch BEFORE the universal merge, and the flip +
    // ad-hoc re-sign regenerates each arch's _CodeSignature/CodeResources differently, which
    // @electron/universal rejects ("Expected all non-binary files to have identical SHAs") - it
    // failed the v0.3.2 CI mac job exactly that way. Flipping only the merged universal app needs a
    // universal-aware hook (electron-builder 25 does not re-run afterPack on the merged app), so mac
    // ships Electron-default fuses until that lands. The mac build is unsigned anyway; win/linux
    // keep the hardening below.
    return;
  } else if (platform === "win32") {
    binary = path.join(context.appOutDir, productFilename + ".exe");
  } else {
    binary = path.join(context.appOutDir, context.packager.executableName);
  }
  await flipFuses(binary, {
    version: FuseVersion.V1,
    // The mac build is unsigned (identity: null) but Electron ships ad-hoc signed; flipping bytes
    // invalidates that signature, so re-stamp it or the app won't launch on arm64.
    resetAdHocDarwinSignature: platform === "darwin" || platform === "mas",
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
  console.log("afterPack: flipped Electron fuses on " + binary);
};
