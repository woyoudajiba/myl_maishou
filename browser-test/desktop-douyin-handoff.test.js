const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchPersistentContext } = require('./browser');
const { createDesktopBridge } = require('../desktop/bridge-server');
const root = path.resolve(__dirname, '..');

test('桌面下载首图经已配对扩展导入，并自动调用四个平台页面搜索', { timeout: 35000 }, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'product-douyin-handoff-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'product-douyin-bridge-'));
  let context, bridge;
  t.after(async () => { await context?.close(); await bridge?.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  bridge = createDesktopBridge({ dataDir, port: 0, processJob: async () => {} });
  const local = await bridge.start();
  context = await launchPersistentContext(profile, { headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
  await context.route('https://**/*', route => route.abort());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(worker.url().replace('background.js', 'workbench.html'));
  await page.waitForFunction(() => !document.getElementById('pick').disabled);
  await page.evaluate(() => {
    window.searchCalls = [];
    FindTransport.searchAll = async (query, id, selected, update) => {
      searchCalls.push({ query, selected });
      const records = selected.map(key => {
        const detail = { wsy:'https://www.wsy.com/item.htm?id=1', zwd:'https://stu.17zwd.com/product/1.html', qcc:'https://www.17qcc.com/item/1.html', e3hui:'https://www.e3hui.cn/product/1.html' }[key];
        const item = { id: key + '-fixture', platform: key, title: key + '同款测试商品', price: 20, imageUrl: 'https://pics.17qcc.com/fixture.png', detailUrl: detail, goodsId:'fixture' };
        const record = { key, phase:'complete', message:'测试候选已返回', items:[item], total:1 }; update(key, record); return record;
      });
      return { items: records.flatMap(record=>record.items), records };
    };
  });
  const image = await page.evaluate(() => { const canvas=document.createElement('canvas');canvas.width=320;canvas.height=420;canvas.getContext('2d').fillRect(0,0,320,420);return canvas.toDataURL('image/jpeg'); });
  const sourceUrl = 'https://v.douyin.com/workflow-fixture/';
  await bridge.enqueueDouyinSearch({ imageData:image, queryName:'测试衬衫', sourceUrl });
  await page.evaluate(({ ENDPOINT, TOKEN }) => chrome.storage.local.set({ productComparisonDesktop:{endpoint:ENDPOINT,token:TOKEN}, productComparisonDesktopEnabled:true }), { ENDPOINT:`http://127.0.0.1:${local.port}`, TOKEN:local.token });
  const accepted = await page.evaluate(() => chrome.runtime.sendMessage({type:'PROCESS_DESKTOP_BROWSER_WORKFLOW'}));
  assert.equal(accepted.ok, true);
  await page.waitForFunction(() => document.querySelectorAll('.query-card').length === 1 && document.getElementById('queryProgress').textContent.includes('已搜索 1 张'));
  const calls = await page.evaluate(() => searchCalls);
  assert.equal(calls.length, 1);
  assert.deepEqual([...calls[0].selected].sort(), ['e3hui','qcc','wsy','zwd']);
  assert.match(calls[0].query, /^data:image\/jpeg;base64,/);
  assert.equal(bridge.snapshot().browserCommands[0].status, 'accepted');
  assert.equal(bridge.snapshot().jobs.length, 0, '搜图后仍需在插件工作台人工确认识别');
  assert.equal(await page.locator('#compareAgain').isDisabled(), true, '未建立工作台桌面连接时不允许启动模型识别');
});
