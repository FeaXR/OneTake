// electron-builder hook: gives the macOS app an ad-hoc signature. Without a paid Apple
// certificate the app is not signed, but Apple Silicon Macs refuse to run code with no
// signature at all, and packaging changes Electron's own one.
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
