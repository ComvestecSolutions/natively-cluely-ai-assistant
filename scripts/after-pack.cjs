/**
 * Composite electron-builder afterPack hook.
 *
 * The Apple Speech helper must exist before packaged assets are verified, and
 * verification must succeed before signing. The existing ad-hoc-sign hook
 * remains the final mutation of a development app; production signing is left
 * to electron-builder.
 */
const { buildForAfterPack } = require('./build-apple-speech.js');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const adHocSignModule = require('./ad-hoc-sign.js');

const adHocSign = adHocSignModule.default || adHocSignModule;

function packagedAppPath(context) {
  const platform = context.electronPlatformName || context.packager?.platform?.nodeName;
  if (platform === 'win32') return context.appOutDir;
  if (platform === 'darwin') {
    const name = context.packager?.appInfo?.productFilename;
    if (!name) throw new Error('[afterPack] Missing macOS product filename');
    return path.join(context.appOutDir, `${name}.app`);
  }
  // This verifier covers macOS and Windows; keep other targets' existing hook behavior.
  return null;
}

function verifyPackagedAssets(appPath) {
  execFileSync(process.execPath, [path.join(__dirname, 'verify-packaged-local-assets.mjs'), '--app', appPath], {
    stdio: 'inherit',
  });
}

async function runAfterPack(
  context,
  { buildHelper = buildForAfterPack, verifyAssets = verifyPackagedAssets, signApp = adHocSign } = {}
) {
  await buildHelper(context);
  const appPath = packagedAppPath(context);
  if (appPath) await verifyAssets(appPath);
  return signApp(context);
}

module.exports = runAfterPack;
module.exports.runAfterPack = runAfterPack;
