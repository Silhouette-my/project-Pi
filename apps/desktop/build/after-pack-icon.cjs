// electron-builder compiles build/icon.icon into Assets.car (macOS 26 light /
// dark icons) and a fallback icon.icns that only reaches 256px. Put the full
// resolution light icns back so Finder and Quick Look stay sharp on older
// macOS releases.
const { copyFileSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  copyFileSync(join(__dirname, "icon.icns"), join(app, "Contents", "Resources", "icon.icns"));
};
