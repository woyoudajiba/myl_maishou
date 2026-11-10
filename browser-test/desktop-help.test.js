const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const { launchPersistentContext } = require('./browser');
const root = path.resolve(__dirname, '..');

test('实际桌面：使用说明分区、离线准备插件、复制地址、打开目录、页面导航和小窗口布局', { timeout: 35000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'product-help-ui-'));
  let app, browser;
  try {
    const bootstrap = path.join(temp, 'main.cjs');
    await fs.writeFile(bootstrap, `require(${JSON.stringify(path.join(root, 'desktop/main.js'))});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.PC_QA_EXECUTABLE || path.join(root, 'desktop/node_modules/electron/dist/electron.exe');
    const profile = path.join(temp, 'profile');
    app = await _electron.launch({ executablePath, args: [...(process.env.PC_QA_EXECUTABLE ? [] : [bootstrap]), '--user-data-dir=' + profile], env });
    const page = await app.firstWindow(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('#loginScreen', { state: 'visible' });
    await app.evaluate(({ shell }) => {
      globalThis.openedPluginPaths = [];
      shell.openPath = async value => { openedPluginPaths.push(value); return ''; };
      globalThis.fetch = async url => {
        if (!String(url).startsWith('https://wsfile.cn/myladmin/api/auth/')) throw new Error('测试禁止外网请求');
        const user = { id: 'help-qa', username: 'help-qa', displayName: '使用说明测试' };
        return Response.json(String(url).endsWith('/login') ? { user, token: 'fixture-token', expiresAt: new Date(Date.now() + 3600000).toISOString() } : { user, ok: true });
      };
    });
    await assert.rejects(page.evaluate(() => window.desktop.prepareExtension()), /请先登录/);
    await page.locator('#username').fill('help-qa'); await page.locator('#password').fill('fixture-password'); await page.locator('#loginButton').click();
    await page.waitForSelector('#appShell', { state: 'visible' });
    await page.locator('#navHelp').click();
    assert.equal(await page.locator('#helpPage').isVisible(), true);
    assert.equal(await page.locator('#workPage').isVisible(), false);
    assert.match(await page.locator('#pageCrumb').textContent(), /使用说明/);
    assert.equal(await page.locator('.help-guide details').count(), 6);
    await page.locator('.help-guide details').nth(3).locator('summary').click();
    assert.match(await page.locator('.help-guide details').nth(3).textContent(), /重试沿用原任务/);
    await page.locator('#preparePlugin').click();
    await page.waitForFunction(() => !document.getElementById('pluginPathArea').hidden);
    const folder = await page.locator('#pluginPath').inputValue();
    assert.equal(folder, path.join(profile, 'browser-extension'));
    const manifest = JSON.parse(await fs.readFile(path.join(folder, 'manifest.json')));
    assert.equal(manifest.version_name, require('../manifest.json').version_name);
    await fs.access(path.join(folder, 'vendor/transformers.js'));
    await assert.rejects(fs.access(path.join(folder, '.env')));
    await assert.rejects(fs.access(path.join(folder, 'desktop')));
    const launchPlugin = async () => {
      browser = await launchPersistentContext(path.join(temp, 'browser-profile'), { headless: true, ignoreDefaultArgs: ['--disable-extensions'],
        args: ['--disable-extensions-except=' + folder, '--load-extension=' + folder] });
      await browser.route('https://**/*', route => route.abort());
      const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
      return worker;
    };
    let worker = await launchPlugin();
    const paired=await page.evaluate(()=>window.desktop.snapshot());
    await worker.evaluate(async pair=>{
      await chrome.storage.local.set({productComparisonDesktop:{endpoint:`http://127.0.0.1:${pair.port}`,token:pair.token},productComparisonDesktopEnabled:true});
      await pollDesktopCommands();
    },{port:paired.port,token:paired.token});
    await page.waitForFunction(async()=>(await window.desktop.snapshot()).browserClient?.state==='ready');
    assert.equal((await page.evaluate(()=>window.desktop.snapshot())).browserClient.version,manifest.version);
    const extensionId = await worker.evaluate(() => chrome.runtime.id);
    await worker.evaluate(() => chrome.storage.local.set({ deliveryFixture: 'keep-pairing-storage' }));
    const workbench = await browser.newPage();
    await workbench.goto(worker.url().replace('background.js', 'workbench.html'));
    await workbench.waitForFunction(() => !document.getElementById('pickMany').disabled);
    assert.equal(await workbench.locator('#version').textContent(), 'v' + manifest.version_name);
    await browser.close(); browser = null;
    await page.locator('#preparePlugin').click();
    await page.waitForFunction(() => !document.getElementById('preparePlugin').disabled);
    worker = await launchPlugin();
    assert.equal(await worker.evaluate(() => chrome.runtime.id), extensionId);
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('deliveryFixture')).deliveryFixture), 'keep-pairing-storage');
    await browser.close(); browser = null;
    await page.evaluate(() => { window.copiedValues = []; Object.defineProperty(navigator.clipboard, 'writeText', { value: async value => { copiedValues.push(value); } }); });
    await page.locator('#copyPluginPath').click(); await page.locator('#copyChromeAddress').click(); await page.locator('#copyEdgeAddress').click();
    assert.deepEqual(await page.evaluate(() => copiedValues), [folder, 'chrome://extensions/', 'edge://extensions/']);
    await page.locator('#openPluginFolder').click();
    assert.deepEqual(await app.evaluate(() => openedPluginPaths), [folder]);
    await page.locator('[data-help-page="settings"]').first().click();
    assert.equal(await page.locator('#settingsPage').isVisible(), true);
    await page.locator('#navHelp').click();
    await fs.mkdir(path.join(root, 'output/playwright'), { recursive: true });
    const suffix = process.env.PC_QA_EXECUTABLE ? '-packaged' : '';
    await page.screenshot({ path: path.join(root, 'output/playwright/help-plugin' + suffix + '.png'), fullPage: true });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 620));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(root, 'output/playwright/help-800' + suffix + '.png') });
    await page.reload(); await page.waitForSelector('#appShell', { state: 'visible' }); await page.locator('#navHelp').click();
    assert.equal(await page.locator('#pluginPath').inputValue(), folder);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await app?.close(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
