const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const { profileId } = require('../desktop/accounts');
const root = path.resolve(__dirname, '..');

test('实际 Electron：任务批次时间、删除确认与失败恢复、清空保留在途、账号隔离、运行版本动态显示', { timeout: 45000 }, async t => {
  const executablePath = path.join(root, 'desktop/node_modules/electron/dist/electron.exe');
  try { await fs.access(executablePath); } catch { return t.skip('需要 Electron 开发依赖'); }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'product-history-ui-'));
  const dataDir = path.join(temp, 'profile');
  const jobsDir = path.join(dataDir, 'profiles', profileId({ id: 'history-A' }), 'jobs');
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  await fs.mkdir(path.join(jobsDir, 'queries'), { recursive: true });
  const jobs = ids.map((id, index) => ({ id, goodsId: index === 2 ? '排队中的任务' : '',
    createdAt: index === 0 ? '2026-10-28T06:17:00.000Z' : index === 1 ? '2026-10-28T06:19:00.000Z' : null,
    updatedAt: '2026-10-28T06:20:00.000Z', status: ['complete', 'partial', 'queued'][index],
    total: [13, 29, 1][index], items: [{ id: String(index), title: '商品样本', imageUrl: 'https://pics.17qcc.com/fixture.png' }] }));
  for (const id of ids) {
    await fs.writeFile(path.join(jobsDir, 'queries', id + '.txt'), 'data:image/png;base64,YQ==');
    await fs.mkdir(path.join(jobsDir, 'images', id), { recursive: true });
    await fs.writeFile(path.join(jobsDir, 'images', id, 'test.jpg'), 'test image');
  }
  await fs.writeFile(path.join(jobsDir, 'jobs.json'), JSON.stringify(jobs));
  const bootstrap = path.join(temp, 'main.cjs');
  const code = [
    "const {app}=require('electron');app.setPath('userData'," + JSON.stringify(dataDir) + ');',
    "globalThis.fetch=async (url, options={})=>{if(!String(url).startsWith('https://wsfile.cn/myladmin/api/auth/'))throw new Error('禁止外网请求');if(String(url).endsWith('/login')){const input=JSON.parse(options.body);globalThis.testUser={id:input.username,username:input.username,displayName:'任务记录测试'};return Response.json({user:testUser,token:'fixture-session',expiresAt:new Date(Date.now()+3600000).toISOString()});}return Response.json({user:globalThis.testUser,ok:true});};",
    // Keep the persisted queued fixture queued while exercising history operations.
    // No model work belongs in this test, and login normally resumes the queue.
    'const bridgeModule=require(' + JSON.stringify(path.join(root, 'desktop/bridge-server.js')) + ');const createBridge=bridgeModule.createDesktopBridge;bridgeModule.createDesktopBridge=options=>createBridge({...options,canProcess:()=>false});',
    'require(' + JSON.stringify(path.join(root, 'desktop/main.js')) + ');'
  ].join('\n');
  await fs.writeFile(bootstrap, code);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({ executablePath, args: [bootstrap], env });
    const page = await app.firstWindow(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await app.context().route('https://**/*', route => route.abort());
    const login = async username => {
      await page.locator('#username').fill(username); await page.locator('#password').fill('fixture-password'); await page.locator('#loginButton').click();
      await page.waitForSelector('#appShell', { state: 'visible' });
      await page.locator('#navWork').click();
    };
    await login('history-A');
    assert.equal(await page.locator('#appVersion').textContent(), '本地桌面端 · ' + require('../manifest.json').version_name);
    const first = page.locator('article[data-job="' + ids[0] + '"]');
    assert.match(await first.locator('.job-times').textContent(), /2026\/10\/28 14:17:00/);
    assert.match(await first.locator('.job-times').textContent(), /14:20:00/);
    const active = page.locator('article[data-job="' + ids[2] + '"]');
    assert.match(await active.locator('.job-times').textContent(), /时间未记录/);
    assert.equal(await active.locator('.delete-job').isDisabled(), true);
    await assert.rejects(page.evaluate(ids => window.desktop.deleteJobs(ids), [ids[2]]), /识别中的任务不能删除/);
    await fs.mkdir(path.join(root, 'output/playwright'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'output/playwright/task-history-desktop.png'), fullPage: true });
    await first.locator('.delete-job').click();
    assert.match(await page.locator('#deleteJobsList').textContent(), /14:17:00.*13 张候选/);
    await page.locator('#cancelDeleteJobs').click();
    assert.equal((await page.evaluate(() => window.desktop.snapshot())).jobs.length, 3);
    await fs.access(path.join(jobsDir, 'queries', ids[0] + '.txt'));
    await first.locator('.delete-job').click();
    const blockedWrite = path.join(jobsDir, 'jobs.json.tmp');
    await fs.mkdir(blockedWrite);
    await page.locator('#confirmDeleteJobs').click();
    await page.waitForFunction(() => document.getElementById('deleteJobsError').textContent.includes('本地保存失败'));
    assert.equal((await page.evaluate(() => window.desktop.snapshot())).jobs.length, 3);
    assert.equal(await page.locator('#deleteJobsDialog').isVisible(), true);
    await fs.rmdir(blockedWrite);
    await page.locator('#confirmDeleteJobs').click();
    await page.waitForSelector('#deleteJobsDialog', { state: 'hidden' });
    await page.waitForFunction(() => document.getElementById('taskCount').textContent === '2');
    await assert.rejects(fs.access(path.join(jobsDir, 'queries', ids[0] + '.txt')));
    await assert.rejects(fs.access(path.join(jobsDir, 'images', ids[0])));
    await page.reload(); await page.waitForSelector('#appShell', { state: 'visible' });
    await page.locator('#navWork').click();
    assert.equal(await first.count(), 0);
    await page.locator('#clearJobs').click();
    assert.match(await page.locator('#deleteJobsList').textContent(), /14:19:00.*29 张候选/);
    assert.doesNotMatch(await page.locator('#deleteJobsList').textContent(), /排队中的任务/);
    await page.screenshot({ path: path.join(root, 'output/playwright/task-history-delete-confirm.png') });
    await page.locator('#confirmDeleteJobs').click();
    await page.waitForFunction(() => document.getElementById('taskCount').textContent === '1');
    assert.equal(await page.locator('#clearJobs').isDisabled(), true);
    await fs.access(path.join(jobsDir, 'queries', ids[2] + '.txt'));
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(800, 620));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(root, 'output/playwright/task-history-800.png') });
    // Simulate metadata from an installed package without generating a package:
    // the UI must display the running package version, not the source manifest.
    await app.evaluate(({app}) => {
      Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
      app.getVersion = () => '26.10.27-v42';
    });
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.getElementById('appVersion').textContent.includes('26.10.27-v42'));
    await page.locator('#logout').click(); await page.waitForSelector('#loginScreen', { state: 'visible' });
    await assert.rejects(page.evaluate(ids => window.desktop.deleteJobs(ids), [ids[2]]), /请先登录/);
    await login('history-B');
    assert.equal((await page.evaluate(() => window.desktop.snapshot())).jobs.length, 0);
    await assert.rejects(page.evaluate(ids => window.desktop.deleteJobs(ids), [ids[2]]), /已变化/);
    await page.locator('#logout').click(); await page.waitForSelector('#loginScreen', { state: 'visible' });
    await login('history-A');
    assert.deepEqual((await page.evaluate(() => window.desktop.snapshot())).jobs.map(job => job.id), [ids[2]]);
    assert.deepEqual(errors, []);
  } finally { await app?.close(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
