const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require('playwright');

async function checkPackagedStartup(executable, outputDir) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-packaged-startup-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({ executablePath: path.resolve(executable), args: [`--user-data-dir=${profile}`], env, timeout: 25000 });
    const page = await app.firstWindow({ timeout: 15000 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('#loginButton').waitFor({ state: 'visible', timeout: 15000 });
    const runtime = await app.evaluate(({ app }) => {
      const path = process.getBuiltinModule('node:path');
      const root = app.getAppPath();
      const requireApp = process.getBuiltinModule('node:module').createRequire(path.join(root, 'package.json'));
      return {
        packaged: app.isPackaged, version: app.getVersion(), executable: process.execPath, appPath: root,
        modelRetryLoaded: typeof requireApp('./desktop/model-retry.js').retryModelJson === 'function',
        buyerProvidersLoaded: typeof requireApp('./desktop/buyer-providers.js').createBuyerProviders === 'function',
        buyerMappingLoaded: typeof requireApp('./desktop/buyer-mapping.js').rankSuppliers === 'function',
        buyerDraftViewLoaded: typeof requireApp('./desktop/buyer-draft-view.js').normalizeDraftDetail === 'function'
      };
    });
    assert.equal(runtime.packaged, true);
    assert.equal(runtime.version, require('../desktop/updates').updateVersion(require('../manifest.json').version_name));
    assert.equal(runtime.modelRetryLoaded, true);
    assert.equal(runtime.buyerProvidersLoaded, true);
    assert.equal(runtime.buyerMappingLoaded, true);
    assert.equal(runtime.buyerDraftViewLoaded, true);
    const buyerDraftUiLoaded = await page.evaluate(() => typeof window.BuyerDraftUI?.render === 'function' && typeof window.loadBuyerDrafts === 'function' && !!document.getElementById('navDrafts'));
    assert.equal(buyerDraftUiLoaded, true);
    assert.deepEqual(errors, []);
    await fs.mkdir(outputDir, { recursive: true });
    await page.screenshot({ path: path.join(outputDir, 'packaged-startup.png') });
    const result = { ...runtime, buyerDraftUiLoaded, loginVisible: true, rendererErrors: errors, isolatedProfile: true };
    await fs.writeFile(path.join(outputDir, 'packaged-startup.json'), JSON.stringify(result, null, 2));
    return result;
  } finally {
    if (app) await app.close();
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

module.exports = { checkPackagedStartup };
if (require.main === module) {
  checkPackagedStartup(process.argv[2], process.argv[3]).then(result => console.log(JSON.stringify(result, null, 2)), error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
