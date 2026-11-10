const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');

test('实际桌面：登录提示可延后，每次登录检查，确认才下载，进度/失败重试和更新页面均可用', { timeout: 40000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'product-updates-ui-'));
  let app;
  try {
    const bootstrap = path.join(temp, 'main.cjs');
    const script = function () {
      const { app } = require('electron');
      app.setPath('userData', PROFILE);
      const { EventEmitter } = require('node:events');
      const updates = require(UPDATES);
      const info = { version: '26.11.8-5', releaseNotes: '测试新版：优化任务重试与软件更新。', releaseDate: '2026-11-09T00:00:00.000Z',
        files: [{ url: 'ProductComparison-26.11.8-5-x64.exe', sha512: Buffer.alloc(64).toString('base64'), size: 100 }] };
      globalThis.updateCalls = { checks: 0, downloads: 0, installs: 0 };
      const updater = new EventEmitter();
      updater.setFeedURL = () => {};
      updater.checkForUpdates = async () => { updateCalls.checks++; updater.emit('update-available', info); };
      updater.downloadUpdate = async () => {
        updateCalls.downloads++; updater.emit('download-progress', { percent: 42, transferred: 42, total: 100 });
        await new Promise((resolve, reject) => { globalThis.finishDownload = () => { updater.emit('update-downloaded', info); resolve(); }; globalThis.failDownload = () => reject(new Error('network unavailable')); });
      };
      updater.quitAndInstall = () => { updateCalls.installs++; };
      updates.createUpdates = options => new updates.Updates({ ...options, updater, enabled: true });
      globalThis.fetch = async url => {
        if (!String(url).startsWith('https://wsfile.cn/myladmin/api/auth/')) throw new Error('测试禁止外网请求');
        const user = { id: 'update-qa', username: 'update-qa', displayName: '更新测试用户' };
        return Response.json(String(url).endsWith('/login') ? { user, token: 'fixture-token', expiresAt: new Date(Date.now() + 3600000).toISOString() } : { user, ok: true });
      };
      require(MAIN);
    };
    await fs.writeFile(bootstrap, '(' + script.toString().replace('PROFILE', JSON.stringify(path.join(temp, 'profile')))
      .replace('UPDATES', JSON.stringify(path.join(root, 'desktop/updates.js'))).replace('MAIN', JSON.stringify(path.join(root, 'desktop/main.js'))) + ')();');
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: path.join(root, 'desktop/node_modules/electron/dist/electron.exe'), args: [bootstrap], env });
    const page = await app.firstWindow(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const login = async () => {
      await page.locator('#username').fill('update-qa'); await page.locator('#password').fill('fixture-password'); await page.locator('#loginButton').click();
      await page.waitForSelector('#updateDialog', { state: 'visible' });
    };
    await login();
    assert.match(await page.locator('#updateDialogVersion').textContent(), /26\.11\.08-v4.*26\.11\.08-v5/);
    assert.deepEqual(await app.evaluate(() => updateCalls), { checks: 1, downloads: 0, installs: 0 });
    await fs.mkdir(path.join(root, 'output/playwright'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'output/playwright/update-login-prompt.png') });
    await page.locator('#updateLater').click(); await page.locator('#navWork').click(); await page.locator('#refresh').click();
    assert.equal(await page.locator('#updateDialog').isVisible(), false);
    await page.locator('#navUpdates').click();
    assert.equal(await page.locator('#updatesPage').isVisible(), true);
    assert.equal(await page.locator('#settingsPage').isVisible(), false);
    assert.match(await page.locator('#pageCrumb').textContent(), /软件更新/);
    await page.locator('#checkUpdate').click();
    await page.waitForFunction(async () => (await window.desktop.snapshot()).updates.checkedAt);
    await page.locator('#logout').click(); await page.waitForSelector('#loginScreen', { state: 'visible' });
    await login();
    assert.equal(await app.evaluate(() => updateCalls.checks), 3);
    await page.locator('#updateNow').click();
    await page.waitForFunction(() => document.getElementById('updateProgress').value === 42);
    assert.equal(await page.locator('#updatesPage').isVisible(), true);
    assert.equal(await page.locator('#downloadUpdate').isDisabled(), true);
    assert.equal(await app.evaluate(() => updateCalls.downloads), 1);
    await app.evaluate(() => failDownload());
    await page.waitForFunction(() => document.getElementById('updateError').textContent.includes('网络'));
    await page.locator('#downloadUpdate').click();
    await page.waitForFunction(() => document.getElementById('updateProgress').value === 42 && !document.getElementById('updateProgressArea').hidden);
    await app.evaluate(() => finishDownload());
    await page.waitForSelector('#installUpdate', { state: 'visible' });
    assert.equal(await app.evaluate(() => updateCalls.installs), 0);
    assert.match(await page.locator('#updateProgressText').textContent(), /校验/);
    await page.screenshot({ path: path.join(root, 'output/playwright/update-ready.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 620));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(root, 'output/playwright/update-800.png') });
    assert.deepEqual(errors, []);
    await page.locator('#installUpdate').click();
    await page.waitForFunction(async () => (await window.desktop.snapshot()).updates.status === 'installing');
    assert.equal(await app.evaluate(() => updateCalls.installs), 1);
  } finally { await app?.close(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
