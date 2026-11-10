const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchPersistentContext } = require('./browser');
const { createDesktopBridge } = require('../desktop/bridge-server');
const root = path.resolve(__dirname, '..');
async function launch(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'find-multi-'));
  const context = await launchPersistentContext(profile, { headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--disable-extensions-except=' + root, '--load-extension=' + root] });
  t.after(async () => { await context.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await context.route('https://**/*', route => route.abort());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.storage.local.set({ productComparisonDesktopEnabled: false }));
  const page = await context.newPage();
  await page.goto(worker.url().replace('background.js', 'workbench.html'));
  await ready(page);
  return page;
}
const ready = page => page.waitForFunction(() => !document.getElementById('pickMany').disabled);
async function images(page, count = 2) {
  const data = await page.evaluate(count => Array.from({ length: count }, (_, i) => {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 320;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'hsl(' + i * 31 + ',70%,40%)'; ctx.fillRect(0, 0, 240, 320);
    return canvas.toDataURL('image/png').split(',')[1];
  }), count);
  return data.map((base64, i) => ({ name: i === 0 ? '裤子.png' : i === 1 ? '上衣.png' : '商品' + i + '.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') }));
}
async function mocks(page, hold = false) {
  await page.evaluate(hold => {
    window.calls = []; window.visionCalls = []; window.activeSearches = 0; window.peakSearches = 0;
    FindTransport.searchAll = async (query, id, platforms, update) => {
      window.calls.push({ query, platforms }); window.activeSearches++; window.peakSearches = Math.max(window.peakSearches, window.activeSearches);
      if (hold && window.calls.length === 1) await new Promise(resolve => { window.releaseSearch = resolve; });
      else await new Promise(resolve => setTimeout(resolve, 30));
      const items = [{ id: 'same-id', platform: 'wsy', title: '独立候选' + window.calls.length, imageUrl: 'https://imgcdn.wsy.com/a.jpg', detailUrl: 'https://www.wsy.com/item.htm?id=1', price: 22 }];
      const record = { key: 'wsy', phase: 'complete', message: '1条候选', items, total: 1 };
      update('wsy', record); window.activeSearches--; return { items, records: [record] };
    };
    FindTransport.cancel = () => window.releaseSearch?.();
    FindVision.scoreItems = async (query, items, options) => {
      window.visionCalls.push(query);
      const scored = items.map(item => ({ ...item, imageSimilaritySource: FindVision.algorithm, imageSimilarityStatus: 'compared', imageSimilarity: 0.9, imageSimilarityEngine: 'fixture', visualComparison: { verdict: 'likely_same', score: 90, matches: ['版型一致'], differences: [], uncertainties: [] } }));
      options.onBatch(scored); return { items: scored, scored: scored.length, failed: 0 };
    };
  }, hold);
}
test('裤子和上衣独立保存条件、候选和审核；批量搜图串行、识别需确认、刷新不重发', { timeout: 40000 }, async t => {
  const page = await launch(t), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await mocks(page);
  const files = await images(page);
  await page.locator('#files').setInputFiles(files);
  await page.waitForFunction(() => document.querySelectorAll('.query-card').length === 2 && !document.getElementById('pickMany').disabled);
  assert.equal(await page.evaluate(() => calls.length), 0);
  await page.locator('#goodsId').fill('裤子款号'); await page.locator('#goodsId').dispatchEvent('change');
  await page.locator('.query-card').nth(1).click();
  await ready(page);
  assert.equal(await page.locator('#goodsId').inputValue(), '');
  await page.locator('#goodsId').fill('上衣款号'); await page.locator('#goodsId').dispatchEvent('change');
  await page.locator('#searchQueries').click();
  await page.waitForFunction(() => document.getElementById('queryProgress').textContent.includes('已搜索 2 张') && !document.getElementById('pickMany').disabled);
  assert.equal(await page.evaluate(() => calls.length), 2);
  assert.equal(await page.evaluate(() => peakSearches), 1);
  assert.equal(await page.evaluate(() => visionCalls.length), 0);
  const searches = await page.evaluate(() => calls.map(call => call.query));
  assert.notEqual(searches[0], searches[1]);
  await page.locator('#compareQueries').click();
  await page.waitForFunction(() => document.getElementById('queryProgress').textContent.includes('已处理 2 张') && !document.getElementById('pickMany').disabled);
  assert.deepEqual(await page.evaluate(() => visionCalls), searches);
  assert.equal(await page.locator('#compareQueries').isDisabled(), true);
  await page.locator('#reviewNext').click(); await page.locator('.confirm-same').click();
  await page.waitForFunction(() => !document.getElementById('reviewDialog').open);
  await page.locator('.query-card').nth(0).click(); await ready(page);
  assert.equal(await page.locator('#goodsId').inputValue(), '裤子款号');
  assert.match(await page.locator('#reviewSummary').textContent(), /人工已处理 0/);
  await page.locator('.query-card').nth(1).click(); await ready(page);
  assert.equal(await page.locator('#goodsId').inputValue(), '上衣款号');
  assert.match(await page.locator('#reviewSummary').textContent(), /人工已处理 1/);
  await page.reload(); await ready(page);
  assert.equal(await page.locator('.query-card').count(), 2);
  assert.equal(await page.locator('#goodsId').inputValue(), '上衣款号');
  assert.match(await page.locator('#reviewSummary').textContent(), /人工已处理 1/);
  await page.locator('#queryWorkspace').scrollIntoViewIfNeeded();
  fs.mkdirSync(path.join(root, 'output/playwright'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'output/playwright/multi-query-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(root, 'output/playwright/multi-query-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});
test('暂停阻止后续图片和迟到回调，未搜索项可继续；重复图片跳过、导入上限10张', { timeout: 40000 }, async t => {
  const page = await launch(t); await mocks(page, true);
  const files = await images(page, 11);
  await page.locator('#files').setInputFiles([files[0], files[0], files[1], ...files.slice(2)]);
  await page.waitForFunction(() => document.querySelectorAll('.query-card').length === 10 && !document.getElementById('pickMany').disabled);
  assert.match(await page.locator('#queryNotice').textContent(), /重复/);
  assert.match(await page.locator('#queryNotice').textContent(), /最多10张/);
  await page.locator('#searchQueries').click();
  await page.waitForFunction(() => calls.length === 1);
  await page.locator('#stopQueries').click(); await ready(page);
  assert.equal(await page.evaluate(() => calls.length), 1);
  assert.equal(await page.locator('#results tbody tr').count(), 0, '取消后的回调不写入当前图');
  await page.locator('#searchQueries').click();
  await page.waitForFunction(() => document.getElementById('queryProgress').textContent.includes('已搜索 9 张') && !document.getElementById('pickMany').disabled);
  assert.equal(await page.evaluate(() => calls.length), 10);
  assert.equal(await page.evaluate(() => visionCalls.length), 0);
  await page.locator('.query-card').nth(0).click(); await ready(page);
  assert.equal(await page.locator('#results tbody tr').count(), 0);
  page.once('dialog', dialog => dialog.accept()); await page.locator('#removeQuery').click();
  await page.waitForFunction(() => document.querySelectorAll('.query-card').length === 9);
  await page.reload(); await ready(page);
  assert.equal(await page.locator('.query-card').count(), 9);
  await page.evaluate(() => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async value => {
      if (value['core.session']?.base64 === '') throw new Error('TEST_CLEAR_MIRROR_FAILED');
      return original(value);
    };
  });
  page.once('dialog', dialog => dialog.accept()); await page.locator('#clearQueries').click(); await ready(page);
  await page.waitForFunction(() => document.getElementById('queryNotice').textContent.includes('TEST_CLEAR_MIRROR_FAILED'));
  await page.reload(); await ready(page);
  assert.equal(await page.locator('.query-card').count(), 0);
  assert.equal(await page.locator('#sourceImage').isVisible(), false);
});
test('本地写入失败停止推进后续图片，保留当前候选；恢复存储后可继续剩余图片', { timeout: 25000 }, async t => {
  const page = await launch(t); await mocks(page);
  await page.locator('#files').setInputFiles(await images(page)); await ready(page);
  await page.waitForFunction(() => document.querySelectorAll('.query-card').length === 2);
  await page.evaluate(() => {
    window.originalWrite = FindQueryStore.write;
    FindQueryStore.write = async (records, ...rest) => {
      if (records.some(state => state.searched)) throw new Error('TEST_DISK_FULL');
      return originalWrite(records, ...rest);
    };
  });
  await page.locator('#searchQueries').click();
  await page.waitForFunction(() => document.getElementById('queryNotice').textContent.includes('TEST_DISK_FULL') && !document.getElementById('pickMany').disabled);
  assert.equal(await page.evaluate(() => calls.length), 1);
  assert.equal(await page.locator('#results tbody tr').count(), 1);
  await page.evaluate(() => { FindQueryStore.write = originalWrite; });
  await page.locator('#searchQueries').click();
  await page.waitForFunction(() => calls.length === 2 && !document.getElementById('pickMany').disabled);
  assert.equal(await page.evaluate(() => visionCalls.length), 0);
});
test('批量遇到平台额度限制后后续图片跳过该平台，其余平台继续', { timeout: 25000 }, async t => {
  const page = await launch(t);
  await page.locator('#platformChoices input[value=qcc]').check();
  await page.evaluate(() => {
    window.calls = [];
    FindTransport.searchAll = async (_query, _id, selected, update) => {
      calls.push(selected);
      const records = selected.map(key => key === 'qcc'
        ? { key, phase: 'failed', message: '额度不足', diagnostics: { failureKind: 'quota' }, items: [] }
        : { key, phase: 'complete', message: '收到1条', items: [{ id: '1', platform: key, price: 22, imageUrl: 'https://imgcdn.wsy.com/a.jpg' }] });
      records.forEach(record => update(record.key, record)); return { records, items: records.flatMap(record => record.items) };
    };
  });
  await page.locator('#files').setInputFiles(await images(page)); await ready(page);
  await page.waitForFunction(() => document.querySelectorAll('.query-card').length === 2);
  await page.locator('#searchQueries').click();
  await page.waitForFunction(() => calls.length === 2 && !document.getElementById('pickMany').disabled);
  const calls = await page.evaluate(() => window.calls);
  assert.deepEqual(calls[0].sort(), ['e3hui', 'qcc', 'wsy', 'zwd']);
  assert.deepEqual(calls[1].sort(), ['e3hui', 'wsy', 'zwd']);
});
test('人工确认批量识别后，两张原图及文件名分别交给真实本地桥，不在浏览器调用模型', { timeout: 25000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-multi-bridge-'));
  const bridge = createDesktopBridge({ dataDir, port: 0, canProcess: () => true, processJob: async (_job, update) => update({ status: 'complete' }) });
  t.after(async () => { await bridge.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const local = await bridge.start(), page = await launch(t);
  await mocks(page);
  await page.locator('#desktopEndpoint').fill('http://127.0.0.1:' + local.port);
  await page.locator('#desktopToken').fill(local.token); await page.locator('#connectDesktop').click();
  await page.waitForFunction(() => !document.getElementById('sendToDesktop').disabled);
  await page.locator('#sendToDesktop').check();
  await page.locator('#files').setInputFiles(await images(page)); await ready(page);
  await page.waitForFunction(() => document.querySelectorAll('.query-card').length === 2);
  await page.locator('#searchQueries').click();
  await page.waitForFunction(() => calls.length === 2 && !document.getElementById('pickMany').disabled);
  assert.equal(bridge.snapshot().jobs.length, 0);
  await page.locator('#compareQueries').click();
  await page.waitForFunction(() => document.getElementById('queryProgress').textContent.includes('已处理 2 张') && !document.getElementById('pickMany').disabled);
  const jobs = bridge.snapshot().jobs, queries = await page.evaluate(() => calls.map(call => call.query));
  assert.deepEqual(jobs.map(job => job.queryName), ['裤子.png', '上衣.png']);
  assert.deepEqual(jobs.map(job => bridge.queryImage(job.id)), queries);
  assert.equal(jobs[0].searchGroupId, jobs[1].searchGroupId);
  assert.notEqual(jobs[0].queryId, jobs[1].queryId);
  assert.equal(await page.evaluate(() => visionCalls.length), 0);
  assert.equal(await page.locator('#compareQueries').isDisabled(), true);
});
