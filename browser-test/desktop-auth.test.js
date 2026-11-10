const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const executablePath = path.join(root, 'desktop/node_modules/electron/dist/electron.exe');
test('实际 Electron 重启验证加密登录、退出中止在途请求、撤销会话不能读取本机资料', { timeout: 60000 }, async t => {
  try { await fs.access(executablePath); } catch { return t.skip('需要 Electron 开发依赖'); }
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'product-auth-'));
  const dataDir = path.join(folder, 'profile'); await fs.mkdir(dataDir);
  const bootstrap = path.join(folder, 'main.cjs');
  const fixture = function () {
    const sharp = require(SHARP_PATH);
    process.getBuiltinModule('node:dns/promises').lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    globalThis.testModelCalls = 0;
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).startsWith('https://wsfile.cn/myladmin/api/auth/')) {
        if (globalThis.revokeSession) return new Response('{}', { status: 401 });
        const user = { id: 'persistent-qa', username: 'persistent-qa', displayName: '持久化测试' };
        return Response.json(String(url).endsWith('/login') ? { token: 'test-persisted-token', expiresAt: new Date(Date.now() + 3600000).toISOString(), user } : { user, ok: true });
      }
      if (String(url).startsWith('https://imgcdn.wsy.com/')) return new Response(await sharp({ create: { width: 800, height: 1000, channels: 3, background: '#0f766e' } }).png().toBuffer());
      if (String(url) === 'https://other-vision.example/v1/chat/completions') {
        globalThis.testModelCalls++;
        return new Promise((resolve, reject) => {
          const stop = () => reject(new DOMException('aborted', 'AbortError'));
          if (options.signal.aborted) stop(); else options.signal.addEventListener('abort', stop, { once: true });
        });
      }
      throw new Error('测试禁止外网请求');
    };
  };
  const fixtureSource = fixture.toString().replace('SHARP_PATH', JSON.stringify(path.join(root, 'desktop/node_modules/sharp')));
  async function writeBootstrap(revoked = false) {
    await fs.writeFile(bootstrap, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(dataDir)});(${fixtureSource})();globalThis.revokeSession=${revoked};require(${JSON.stringify(path.join(root, 'desktop/main.js'))});`);
  }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    await writeBootstrap(); app = await _electron.launch({ executablePath, args: [bootstrap], env });
    let page = await app.firstWindow();
    await page.locator('#username').fill('persistent-qa'); await page.locator('#password').fill('fixture-password'); await page.locator('#loginButton').click();
    await page.waitForSelector('#appShell', { state: 'visible' });
    await page.evaluate(async () => {const saved=await window.desktop.saveModel({ name: '其他服务模型', model: 'another-vision', endpoint: 'https://other-vision.example/v1', apiKey: 'test-persisted-api-key', concurrency: 1 });await window.desktop.selectModel(saved.models.find(model=>model.name==='其他服务模型').id);});
    await app.close(); app = await _electron.launch({ executablePath, args: [bootstrap], env }); page = await app.firstWindow();
    await page.waitForSelector('#appShell', { state: 'visible' });
    const restored = await page.evaluate(() => window.desktop.snapshot()); assert.equal(restored.user.id, 'persistent-qa'); assert.equal(restored.catalog.models.find(model=>model.id===restored.catalog.activeId).model, 'another-vision');
    const image = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 800; c.height = 1000; return c.toDataURL(); });
    const response = await fetch(`http://127.0.0.1:${restored.port}/v1/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Desktop-Token': restored.token },
      body: JSON.stringify({ query: image, items: Array.from({ length: 6 }, (_, index) => ({ id: String(index), imageUrl: `https://imgcdn.wsy.com/${index}.png` })) }) });
    assert.equal(response.status, 202); const { id } = await response.json();
    for (let i = 0; i < 60 && !(await app.evaluate(() => globalThis.testModelCalls)); i++) await page.waitForTimeout(50);
    assert.equal(await app.evaluate(() => globalThis.testModelCalls), 1);
    await assert.rejects(page.evaluate(() => window.desktop.selectModel('anything')), /等待当前模型任务/);
    await page.locator('#logout').click(); await page.waitForSelector('#loginScreen', { state: 'visible' });
    assert.equal((await page.evaluate(() => window.desktop.snapshot())).jobs.length, 0);
    await page.locator('#username').fill('persistent-qa'); await page.locator('#password').fill('fixture-password'); await page.locator('#loginButton').click();
    await page.waitForSelector('#appShell', { state: 'visible' });
    const interrupted = (await page.evaluate(() => window.desktop.snapshot())).jobs.find(job => job.id === id);
    assert.equal(interrupted.status, 'partial'); assert.match(interrupted.error, /账号已退出/); assert.equal(interrupted.items.filter(item => item.imageSimilarityStatus === 'unavailable').length, 4); assert.equal(interrupted.items.filter(item => item.imageSimilarityStatus === 'not_started').length, 2);
    assert.equal(await app.evaluate(() => globalThis.testModelCalls), 1, '重新登录不能自动重发被中断的模型请求');
    await app.close(); await writeBootstrap(true); app = await _electron.launch({ executablePath, args: [bootstrap], env }); page = await app.firstWindow();
    await page.waitForSelector('#loginScreen', { state: 'visible' }); assert.equal((await page.evaluate(() => window.desktop.snapshot())).authenticated, false);
    await assert.rejects(page.evaluate(() => window.desktop.queryImage('any')), /请先登录/);
  } finally { await app?.close(); await fs.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
