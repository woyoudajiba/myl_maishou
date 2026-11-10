const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchPersistentContext } = require('./browser');
const { createDesktopBridge } = require('../desktop/bridge-server');
const root = path.resolve(__dirname, '..');
const pixel = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/wsy-image-search.json'), 'utf8'));
const profiles = new WeakMap();
async function closeContext(context) {
  try { await context.close(); }
  finally {
    const profile = profiles.get(context);
    if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'find-core-'));
  let context;
  try {
    context = await launchPersistentContext(profile, { headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
    // Individual tests override this with fixtures. Never use live supplier or
    // model endpoints in the workbench regression suite.
    await context.route('https://**/*', route => route.abort());
    profiles.set(context, profile);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
    await worker.evaluate(() => chrome.storage.local.set({ productComparisonDesktopEnabled: false }));
    const page = await context.newPage();
    await page.goto(worker.url().replace('background.js', 'workbench.html'));
    await page.waitForFunction(() => !document.getElementById('pick').disabled);
    for (const key of ['qcc','zwd','e3hui']) await page.locator(`#platformChoices input[value=${key}]`).uncheck();
    return { context, page };
  } catch (error) {
    await context?.close();
    fs.rmSync(profile, { recursive: true, force: true });
    throw error;
  }
}

test('新工作台默认选择四个平台，平台覆盖统计可从结果记录读取', { timeout: 30000 }, async () => {
  const { context, page } = await launch();
  try {
    await page.evaluate(async () => chrome.storage.local.set({ 'core.session': { base64: '', mode: 'select', raw: [], phase: 'idle', selected: [], selectionCustomized: false, platforms: {} } }));
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('pick').disabled);
    assert.deepEqual(await page.locator('#platformChoices input:checked').evaluateAll(inputs => inputs.map(input => input.value)), ['wsy', 'qcc', 'zwd', 'e3hui']);
  } finally { await closeContext(context); }
});

test('四个平台默认并行搜图，逐站显示报告数并随候选交给 Electron', { timeout: 30000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-desktop-'));
  const bridge = createDesktopBridge({
    port: 0, dataDir, canProcess: () => true,
    processJob: async (job, update) => update({ status: 'complete', progress: 100, completed: job.items.length })
  });
  const local = await bridge.start();
  const { context, page } = await launch();
  try {
    const requestFailures = []; page.on('requestfailed', request => requestFailures.push(`${request.url()} ${request.failure()?.errorText || ''}`));
    const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 240;
      await chrome.storage.local.set({ 'core.session': { base64: canvas.toDataURL('image/jpeg'), mode: 'select', raw: [], phase: 'idle', selected: ['wsy','zwd','qcc','e3hui'], selectionCustomized: true, platforms: {} } });
    });
    await page.reload(); await page.waitForFunction(() => !document.getElementById('pick').disabled);
    await page.evaluate(() => {
      FindTransport.searchAll = async (_query, _requestId, selected, update) => {
        window.searchDispatched = [...selected];
        const entries = [
          ['wsy',{platform:'wsy',id:'w1',title:'网商园候选',price:22,imageUrl:'https://imgcdn.wsy.com/a.jpg',detailUrl:'https://www.wsy.com/item.htm?id=1'},80],
          ['zwd',{platform:'zwd',id:'z1',title:'17网候选',price:22,imageUrl:'https://pics.17zwd.com/a.jpg',detailUrl:'https://www.17zwd.com/item/1',searchGroup:'accurate'},22],
          ['qcc',{platform:'qcc',id:'q1',title:'青创网候选',price:22,imageUrl:'https://pics.17qcc.com/a.jpg',detailUrl:'https://www.17qcc.com/item/1.html'},40],
          ['e3hui',{platform:'e3hui',id:'e1',title:'衣衫汇候选',price:22,imageUrl:'https://aodo.i.ximgs.net/a.jpg',detailUrl:'https://www.e3hui.cn/item/1.html'},18]
        ];
        const records=entries.map(([key,item,total])=>({key,phase:'complete',message:'实际收到 1 条',items:[item],total,
          diagnostics:key==='zwd'?{searchGroups:[{type:'accurate',phase:'complete',received:2,total:12},{type:'similar',phase:'complete',received:2,total:10}]}:{}}));
        records.forEach(record=>update(record.key,record));
        return {items:records.flatMap(record=>record.items),records};
      };
      FindVision.scoreItems = async () => { throw new Error('该路径不应在扩展中调用视觉模型'); };
    });
    assert.deepEqual(await page.locator('#platformChoices input:checked').evaluateAll(inputs=>inputs.map(input=>input.value)),['wsy','qcc','zwd','e3hui']);
    await page.locator('#desktopBridge').evaluate(element => { element.open = true; });
    await page.locator('#desktopEndpoint').fill(`http://127.0.0.1:${local.port}`);
    await page.locator('#desktopToken').fill(local.token);
    await page.locator('#connectDesktop').click();
    await page.waitForFunction(() => document.getElementById('desktopStatus').textContent.includes('已连接') || !document.getElementById('connectDesktop').disabled, null, { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(100);
    assert.match(await page.locator('#desktopStatus').textContent(), /已连接/, `本机连接状态异常；请求失败：${requestFailures.join(' | ')}；页面错误：${pageErrors.join(' | ')}`);
    await page.locator('#sendToDesktop').check();
    await page.locator('#search').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('4/4 个平台搜索完成'));
    assert.deepEqual(await page.evaluate(()=>window.searchDispatched),['wsy','qcc','zwd','e3hui']);
    assert.match(await page.locator('#platforms').textContent(), /网商园：.*本次收到 1 条候选；平台报告总数 80/);
    assert.match(await page.locator('#platforms').textContent(), /17网：.*本次收到 1 条候选；平台报告总数 22.*准确搜报告 12.*相似搜报告 10/);
    assert.match(await page.locator('#platforms').textContent(), /青创网：.*平台报告总数 40/);
    assert.match(await page.locator('#platforms').textContent(), /衣衫汇：.*平台报告总数 18/);
    assert.equal(await page.locator('#results tbody tr').count(),4);
    fs.mkdirSync(path.join(root,'output/playwright'),{recursive:true});
    await page.locator('#platforms').screenshot({path:path.join(root,'output/playwright/platform-coverage-extension.png')});
    assert.match(await page.locator('#summary').textContent(),/4 个平台各收到 1 条候选/);
    assert.equal(bridge.snapshot().jobs.length, 0, '搜图完成不自动排入模型队列');
    assert.equal(await page.locator('#compareAgain').isEnabled(), true);
    await page.locator('#compareAgain').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('已将 4 张候选交给 Electron'));
    assert.equal(bridge.snapshot().jobs.length, 1);
    assert.deepEqual(bridge.snapshot().jobs[0].items.map(item=>item.platform),['wsy','zwd','qcc','e3hui']);
    assert.deepEqual(bridge.snapshot().jobs[0].platformSearches.map(row=>row.reportedTotal),[80,22,40,18]);
    assert.equal(await page.locator('#results tbody tr').count(), 4);
    assert.match(await page.locator('#results tbody').textContent(), /已移交 Electron/);
    const savedPair = await page.evaluate(async () => (await chrome.storage.local.get('productComparisonDesktop')).productComparisonDesktop);
    assert.equal(savedPair.token, local.token);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('desktopStatus').textContent.includes('已自动连接'));
    assert.equal(await page.locator('#sendToDesktop').isChecked(), true, '刷新后恢复配对与桌面默认路由');
  } finally {
    await context.close(); await bridge.close(); fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('停止后立即重搜，旧评分完成不能覆盖新结果或解除新搜索锁', { timeout: 30000 }, async () => {
  const { context, page } = await launch();
  try {
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 250;
      await chrome.storage.local.set({ 'core.session': { base64: canvas.toDataURL('image/png'), mode: 'select', raw: [], phase: 'idle', selected: ['wsy'], selectionCustomized: true, platforms: {} } });
    });
    await page.reload(); await page.waitForFunction(() => !document.getElementById('pick').disabled);
    await page.evaluate(() => {
      window.reviewResolvers = []; window.reviewRunCount = 0;
      FindTransport.cancel = () => {};
      FindTransport.searchAll = async (_query, _request, _selected, update) => {
        const id = String(++window.reviewRunCount);
        const item = { platform: 'wsy', id, title: 'fixture ' + id, price: 20, imageUrl: 'https://imgcdn.wsy.com/a.png', detailUrl: 'https://www.wsy.com/item.htm?id=' + id };
        const record = { key: 'wsy', phase: 'complete', message: 'fixture', items: [item], total: 1 };
        update('wsy', record); return { items: [item], records: [record] };
      };
      FindVision.scoreItems = async (_query, items) => new Promise(resolve => window.reviewResolvers.push(() => resolve({ items, scored: items.length, failed: 0 })));
    });
    await page.locator('#search').click(); await page.waitForFunction(() => document.getElementById('status').textContent.includes('模型尚未调用'));
    assert.equal(await page.evaluate(() => window.reviewResolvers.length), 0, '搜图后尚未人工确认，不调用模型');
    await page.locator('#compareAgain').click(); await page.waitForFunction(() => window.reviewResolvers.length === 1);
    await page.locator('#stopSearch').click();
    await page.locator('#search').click(); await page.waitForFunction(() => document.getElementById('status').textContent.includes('模型尚未调用'));
    await page.locator('#compareAgain').click(); await page.waitForFunction(() => window.reviewResolvers.length === 2);
    await page.evaluate(async () => { window.reviewResolvers[0](); await new Promise(resolve => setTimeout(resolve, 50)); });
    assert.equal(await page.locator('#pick').isDisabled(), true);
    assert.equal(await page.locator('#stopSearch').isDisabled(), false);
    assert.equal(await page.locator('#results tbody tr').getAttribute('data-id'), '2');
    await page.evaluate(() => window.reviewResolvers[1]());
    await page.waitForFunction(() => !document.getElementById('pick').disabled);
    assert.equal(await page.locator('#results tbody tr').getAttribute('data-id'), '2');
  } finally { await closeContext(context); }
});

test('停止真实评分队列释放旧Worker，新搜索仍能使用模型', { timeout: 30000 }, async () => {
  const { context, page } = await launch();
  try {
    await context.route('https://e3h.i.ximgs.net/**', route => route.fulfill({ contentType: 'image/gif', body: pixel }));
    const result = await page.evaluate(async () => {
      const workers = [];
      window.Worker = class {
        constructor() { workers.push(this); }
        postMessage(message) { this.message = message; }
        terminate() { this.terminated = true; }
      };
      const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
      const query = canvas.toDataURL('image/png');
      const items = [{ id: 'cancel-model', imageUrl: 'https://e3h.i.ximgs.net/cancel.gif' }];
      let cancelled = false;
      const first = FindSimilarity.scoreItems(query, items, { isCancelled: () => cancelled });
      while (!workers[0]?.message) await new Promise(resolve => setTimeout(resolve, 10));
      cancelled = true; FindSimilarity.cancel();
      const stopped = await first;
      const second = FindSimilarity.scoreItems(query, items);
      while (!workers[1]?.message) await new Promise(resolve => setTimeout(resolve, 10));
      workers[1].onmessage({ data: { id: workers[1].message.id, type: 'result', cosine: 0.8 } });
      return { stopped, resumed: await second, oldTerminated: workers[0].terminated };
    });
    assert.equal(result.oldTerminated, true);
    assert.equal(result.stopped.cancelled, true);
    assert.equal(result.stopped.scored, 0);
    assert.equal(result.resumed.engine, 'marqo_fashionclip_webgpu');
    assert.equal(result.resumed.scored, 1);
  } finally { await closeContext(context); }
});

test('平台选择变化立即保存并在刷新后恢复', { timeout: 30000 }, async () => {
  const { context, page } = await launch();
  try {
    await page.locator('#platformChoices input[value=qcc]').uncheck();
    assert.match(await page.locator('#dropZone').textContent(), /每组最多10张/);
    await page.waitForFunction(async () => {
      const saved = (await chrome.storage.local.get('core.session'))['core.session'];
      return Array.isArray(saved?.selected) && !saved.selected.includes('qcc');
    });
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('pick').disabled);
    assert.equal(await page.locator('#platformChoices input[value=qcc]').isChecked(), false);
    assert.equal(await page.locator('#platformChoices input[value=wsy]').isChecked(), true);
  } finally { await closeContext(context); }
});

test('青创网返回额度上限后自动暂停重复请求，仍可手动重新启用', { timeout: 35000 }, async () => {
  const { context, page } = await launch();
  try {
    let requests = 0;
    await page.locator('#platformChoices input[value=qcc]').check();
    await page.evaluate(() => {
      FindTransport.searchAll = async (_image, _id, selected, update) => {
        const failure = { phase:'failed', message:'platform_quota：青创网本月图片搜索次数已达上限（-10001）', items:[], total:null,
          diagnostics:{ failureKind:'quota', retryable:false, errorCode:'-10001' } };
        window.__quotaRequestCount = (window.__quotaRequestCount || 0) + 1;
        update('qcc', failure);
        return { items:[], records:selected.includes('qcc') ? [{ key:'qcc', ...failure }] : [] };
      };
    });
    const source = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 180; canvas.height = 220;
      const context = canvas.getContext('2d'); context.fillStyle = '#456789'; context.fillRect(0, 0, 180, 220);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.locator('#file').setInputFiles({ name:'quota-test.png', mimeType:'image/png', buffer:Buffer.from(source, 'base64') });
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('所有平台请求失败'));
    assert.equal(await page.locator('#platformChoices input[value=qcc]').isChecked(), false);
    assert.match(await page.locator('#platforms').textContent(), /额度恢复后可重新勾选/);
    const saved = await page.evaluate(async () => (await chrome.storage.local.get('core.session'))['core.session']);
    assert.equal(saved.selectionCustomized, true);
    assert.equal(saved.selected.includes('qcc'), false);
    assert.equal(saved.platforms.qcc.diagnostics.retryable, false);
    assert.equal(await page.evaluate(() => window.__quotaRequestCount), 1);
    await page.locator('#platformChoices input[value=qcc]').check();
    await page.waitForFunction(async () => (await chrome.storage.local.get('core.session'))['core.session']?.selected?.includes('qcc'));
    assert.equal(await page.locator('#platformChoices input[value=qcc]').isChecked(), true);
    assert.equal(await page.evaluate(() => window.__quotaRequestCount), 1, '重新启用只改勾选状态，不会自动重发图片');
  } finally { await closeContext(context); }
});

test('青创网要求账号认证后自动暂停重复请求，认证后可手动重新启用', { timeout: 35000 }, async () => {
  const { context, page } = await launch();
  try {
    await page.locator('#platformChoices input[value=qcc]').check();
    await page.evaluate(() => {
      FindTransport.searchAll = async (_image, _id, selected, update) => {
        const failure = { phase:'failed', message:'platform_verification：青创网要求先完成账号认证后才能图片搜索（910001）', items:[], total:null,
          diagnostics:{ failureKind:'verification', retryable:false, errorCode:'910001' } };
        window.__verificationRequestCount = (window.__verificationRequestCount || 0) + 1;
        update('qcc', failure);
        return { items:[], records:selected.includes('qcc') ? [{ key:'qcc', ...failure }] : [] };
      };
    });
    const source = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 180; canvas.height = 220;
      const context = canvas.getContext('2d'); context.fillStyle = '#456789'; context.fillRect(0, 0, 180, 220);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.locator('#file').setInputFiles({ name:'verification-test.png', mimeType:'image/png', buffer:Buffer.from(source, 'base64') });
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('所有平台请求失败'));
    assert.equal(await page.locator('#platformChoices input[value=qcc]').isChecked(), false);
    assert.match(await page.locator('#platforms').textContent(), /账号认证完成后可重新勾选/);
    const saved = await page.evaluate(async () => (await chrome.storage.local.get('core.session'))['core.session']);
    assert.equal(saved.selectionCustomized, true);
    assert.equal(saved.selected.includes('qcc'), false);
    assert.equal(saved.platforms.qcc.diagnostics.failureKind, 'verification');
    assert.equal(saved.platforms.qcc.diagnostics.retryable, false);
    assert.equal(await page.evaluate(() => window.__verificationRequestCount), 1);
    await page.locator('#platformChoices input[value=qcc]').check();
    await page.waitForFunction(async () => (await chrome.storage.local.get('core.session'))['core.session']?.selected?.includes('qcc'));
    assert.equal(await page.locator('#platformChoices input[value=qcc]').isChecked(), true);
    assert.equal(await page.evaluate(() => window.__verificationRequestCount), 1, '重新启用只改勾选状态，不会自动重发图片');
  } finally { await closeContext(context); }
});

test('衣衫汇明确拒绝搜图权限后自动暂停重复请求，开通后可手动重新启用', { timeout: 35000 }, async () => {
  const { context, page } = await launch();
  try {
    await page.locator('#platformChoices input[value=e3hui]').check();
    await page.evaluate(() => {
      FindTransport.searchAll = async (_image, _id, selected, update) => {
        const failure = { phase:'failed', message:'platform_permission：衣衫汇当前账号未获得以图搜款权限，官方控件禁止上传', items:[], total:null,
          diagnostics:{ failureKind:'permission', retryable:false } };
        window.__e3PermissionRequestCount = (window.__e3PermissionRequestCount || 0) + 1;
        update('e3hui', failure);
        return { items:[], records:selected.includes('e3hui') ? [{ key:'e3hui', ...failure }] : [] };
      };
    });
    const source = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 180; canvas.height = 220;
      const context = canvas.getContext('2d'); context.fillStyle = '#456789'; context.fillRect(0, 0, 180, 220);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.locator('#file').setInputFiles({ name:'permission-test.png', mimeType:'image/png', buffer:Buffer.from(source, 'base64') });
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('所有平台请求失败'));
    assert.equal(await page.locator('#platformChoices input[value=e3hui]').isChecked(), false);
    assert.match(await page.locator('#platforms').textContent(), /搜图权限开通后可重新勾选/);
    const saved = await page.evaluate(async () => (await chrome.storage.local.get('core.session'))['core.session']);
    assert.equal(saved.selectionCustomized, true);
    assert.equal(saved.selected.includes('e3hui'), false);
    assert.equal(saved.platforms.e3hui.diagnostics.failureKind, 'permission');
    assert.equal(await page.evaluate(() => window.__e3PermissionRequestCount), 1);
    await page.locator('#platformChoices input[value=e3hui]').check();
    await page.waitForFunction(async () => (await chrome.storage.local.get('core.session'))['core.session']?.selected?.includes('e3hui'));
    assert.equal(await page.locator('#platformChoices input[value=e3hui]').isChecked(), true);
    assert.equal(await page.evaluate(() => window.__e3PermissionRequestCount), 1, '重新启用只改勾选状态，不会自动重发图片');
  } finally { await closeContext(context); }
});

test('剪贴板图片导入工作台后正常提交搜索，衣衫汇改走文件上传', { timeout: 40000 }, async () => {
  const { context, page } = await launch();
  try {
    await context.route('https://imgcdn.wsy.com/**', route => route.fulfill({ contentType: 'image/gif', body: pixel }));
    await context.route('https://www.wsy.com/**', route => {
      if (route.request().url().includes('/jsondata/search/image.json')) {
        assert.equal(route.request().method(), 'POST');
        assert.match(route.request().postDataJSON().base64, /^data:image\/jpeg;base64,/);
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixture) });
      }
      return route.fulfill({ contentType: 'text/html', body: '<html><body>本地网商园夹具</body></html>' });
    });
    const platform = await context.newPage(); await platform.goto('https://www.wsy.com/new/search/image');
    const source = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 360; canvas.height = 480;
      const context = canvas.getContext('2d'); context.fillStyle = '#315a89'; context.fillRect(0, 0, 360, 480);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const prevented = await page.evaluate(value => {
      const binary = atob(value); const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      const file = new File([bytes], 'clipboard.png', { type: 'image/png' });
      const clipboard = new DataTransfer(); clipboard.items.add(file);
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard });
      document.dispatchEvent(event); return event.defaultPrevented;
    }, source);
    assert.equal(prevented, true, '工作台识别并接管图片粘贴事件');
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('搜索完成'), null, { timeout: 12000 });
    assert.equal(await page.locator('#results tbody tr').count(), 4);
    assert.match(await page.locator('#platforms').textContent(), /网商园：实际收到 4 条/);
    assert.match(await page.locator('#dropZone').textContent(), /每张图独立搜图和审核/);
    assert.match(await page.locator('body').textContent(), /衣衫汇不需要支持站内粘贴/);
    assert.match(await page.locator('body').textContent(), /-10001/);
  } finally { await closeContext(context); }
});

test('失败的平台临时页可从工作台直接打开处理', { timeout: 30000 }, async () => {
  const { context, page } = await launch();
  try {
    const tabId = await page.evaluate(async () => {
      const problem = await chrome.tabs.create({ url: chrome.runtime.getURL('workbench.html'), active: false });
      await chrome.storage.local.set({ 'core.session': {
        base64: '', goodsId: '', mode: 'select', baseline: '', reduction: 5, raw: [], total: null,
        phase: 'failed', message: '衣衫汇结果页跳转到首页', searched: true, selected: ['wsy', 'e3hui'], selectionCustomized: true,
        platforms: { e3hui: { phase: 'failed', message: '衣衫汇结果页跳转到首页', items: [], openTabId: problem.id } }
      } });
      return problem.id;
    });
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('pick').disabled);
    const button = page.locator('#platforms button[data-platform=e3hui]');
    assert.equal(await button.textContent(), '打开处理页');
    await button.click();
    await page.waitForFunction(async id => (await chrome.tabs.get(id)).active, tabId);
    assert.equal((await page.evaluate(async id => (await chrome.tabs.get(id)).active, tabId)), true);
  } finally { await closeContext(context); }
});

test('异常旧存储经过归一化后仍可打开工作台', { timeout: 30000 }, async () => {
  const { context, page } = await launch();
  try {
    await page.evaluate(async () => chrome.storage.local.set({ 'core.session': {
      base64: 'not-image-data', goodsId: {}, mode: 'unexpected', baseline: {}, reduction: {}, raw: 'broken', total: 'bad',
      phase: 'complete', message: '状态恢复', searched: true, selected: ['wsy', 'unknown-platform'], platforms: []
    } }));
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('pick').disabled);
    assert.equal(await page.locator('#sourceImage').isVisible(), false);
    assert.equal(await page.locator('[name=mode][value=select]').isChecked(), true);
    assert.equal(await page.locator('#platformChoices input[value=wsy]').isChecked(), true);
    assert.equal(await page.locator('#platformChoices input[value=qcc]').isChecked(), true);
    assert.equal(await page.locator('#results tbody tr').count(), 0);
    assert.match(await page.locator('#status').textContent(), /状态恢复/);
  } finally { await closeContext(context); }
});

test('算法升级后不继续显示旧缓存视觉分数', { timeout: 30000 }, async () => {
  const { context, page } = await launch();
  try {
    await page.evaluate(async () => {
      const canvas=document.createElement('canvas'); canvas.width=120; canvas.height=120;
      const image=canvas.toDataURL('image/jpeg');
      const item={platform:'wsy',id:'stale-1',goodsId:'A1',title:'测试商品',price:20,imageUrl:'https://imgcdn.wsy.com/test.gif',detailUrl:'https://www.wsy.com/item.htm?id=1',imageSimilarity:.99,imageSimilaritySource:'local_basic_v2',imageSimilarityLabel:'high'};
      await chrome.storage.local.set({'core.session':{base64:image,selected:['wsy'],selectionCustomized:true,raw:[item],total:1,phase:'complete',searched:true,platforms:{wsy:{phase:'complete',message:'实际收到 1 条',items:[item],total:1}},mode:'select',goodsId:'',baseline:'',reduction:5}});
    });
    await page.reload(); await page.waitForFunction(()=>!document.getElementById('pick').disabled);
    const judgment=await page.locator('#results tbody tr td').nth(4).textContent();
    assert.match(judgment,/等待大模型识别/); assert.doesNotMatch(judgment,/高相似 99/);
  } finally { await closeContext(context); }
});

test('搜索卡住时可直接导出状态诊断并停止搜索保留已到结果', { timeout: 30000 }, async () => {
  const { context, page } = await launch();
  try {
    await page.evaluate(async () => {
      const canvas=document.createElement('canvas'); canvas.width=120; canvas.height=120;
      await chrome.storage.local.set({'core.session':{base64:canvas.toDataURL('image/jpeg'),selected:['wsy','zwd','qcc'],selectionCustomized:true,raw:[],total:null,phase:'idle',searched:false,platforms:{},mode:'select',goodsId:'',baseline:'',reduction:5}});
    });
    await page.reload(); await page.waitForFunction(()=>!document.getElementById('search').disabled);
    await page.evaluate(f=>{const node=document.createElement('script');node.id='testFixture';node.type='application/json';node.textContent=JSON.stringify(f);document.body.append(node);},fixture);
    await page.evaluate(() => {
      const item=FindCore.parseWsy(JSON.parse(document.getElementById('testFixture').textContent)).items[0];
      FindTransport.searchAll=(_image,_id,_selected,update)=>{
        update('wsy',{phase:'complete',message:'实际收到 1 条',items:[item],total:1});
        update('qcc',{phase:'manual_required',message:'青创网需要在平台页面登录并手动完成搜图',items:[],total:null});
        update('zwd',{phase:'platform_search',message:'等待平台响应',items:[],total:null});
        return new Promise(()=>{});
      };
      FindTransport.cancel=()=>{};
      FindVision.scoreItems = () => new Promise(() => {});
    });
    await page.locator('#search').click();
    await page.waitForFunction(()=>document.getElementById('status').textContent.includes('等待平台响应'));
    assert.equal(await page.locator('#downloadConnection').isEnabled(),true);
    const event=page.waitForEvent('download'); await page.locator('#downloadConnection').click(); const download=await event;
    const data=JSON.parse(fs.readFileSync(await download.path(),'utf8'));
    assert.equal(data.mode,'workbench_diagnostic_snapshot'); assert.equal(data.search.busy,true);
    assert.equal(data.search.platforms.wsy.received,1); assert.equal(data.search.platforms.zwd.phase,'platform_search');
    assert.equal(data.search.visualComparison.engine,'qwen_multimodal_v1');
  assert.equal(data.search.visualComparison.status,'search_in_progress');
    assert.equal(await page.locator('#platforms button[data-platform=qcc]').textContent(),'打开平台');
    assert.equal(JSON.stringify(data).includes('data:image/'),false);
    assert.match(await page.locator('#status').textContent(),/等待平台响应/);
    await page.locator('#stopSearch').click();
    await page.waitForFunction(()=>document.getElementById('status').textContent.includes('保留 1 条已返回商品'));
    assert.equal(await page.locator('#results tbody tr').count(),1);
    assert.match(await page.locator('#platforms').textContent(),/已由用户停止等待/);
  } finally { await closeContext(context); }
});

test('本地视觉判断同图高分，同色但不同服装轮廓不会拿高分', { timeout: 30000 }, async () => {
  const { context, page } = await launch();
  try {
    const scores = await page.evaluate(async () => {
      const make = (kind, garmentColor='#252525') => {
        const canvas=document.createElement('canvas'); canvas.width=160; canvas.height=160; const ctx=canvas.getContext('2d');
        ctx.fillStyle='#eeeeee'; ctx.fillRect(0,0,160,160); ctx.fillStyle=garmentColor; ctx.beginPath();
        if (kind === 'jacket') { ctx.moveTo(55,25);ctx.lineTo(35,35);ctx.lineTo(20,72);ctx.lineTo(38,80);ctx.lineTo(44,62);ctx.lineTo(44,135);ctx.lineTo(116,135);ctx.lineTo(116,62);ctx.lineTo(122,80);ctx.lineTo(140,72);ctx.lineTo(125,35);ctx.lineTo(105,25);ctx.lineTo(95,40);ctx.lineTo(65,40); }
        else { ctx.moveTo(48,25);ctx.lineTo(112,25);ctx.lineTo(108,72);ctx.lineTo(100,140);ctx.lineTo(75,140);ctx.lineTo(72,82);ctx.lineTo(68,140);ctx.lineTo(42,140);ctx.lineTo(52,72); }
        ctx.closePath();ctx.fill(); return canvas.toDataURL('image/png');
      };
      const source=make('jacket');
      return {
        same: await FindSimilarity.scoreDataUrls(source, source),
        recolored: await FindSimilarity.scoreDataUrls(source, make('jacket','#345776')),
        different: await FindSimilarity.scoreDataUrls(source, make('pants'))
      };
    });
    assert.ok(scores.same > 0.99, `同图分数异常：${scores.same}`);
    assert.ok(scores.recolored > scores.different, `同版型异色应排在同色异版型之前：${JSON.stringify(scores)}`);
    assert.ok(scores.recolored > 0.6, `颜色改变不应抹掉相同轮廓特征：${scores.recolored}`);
    assert.ok(scores.different < 0.85 && scores.different < scores.same, `同色不同轮廓分数过高：${scores.different}`);
    assert.equal(await page.evaluate(() => FindSimilarity.classify(0.9)), 'high');
    assert.equal(await page.evaluate(() => FindSimilarity.classify(0.7)), 'review');
    assert.equal(await page.evaluate(() => FindSimilarity.classify(0.2)), 'low');
  } finally { await closeContext(context); }
});

test('FashionCLIP 不可用时明确降级到基础像素分', { timeout: 30000 }, async () => {
  const { context, page } = await launch();
  try {
    await context.route('https://e3h.i.ximgs.net/**', route => route.fulfill({ contentType: 'image/gif', body: pixel }));
    const result = await page.evaluate(async () => {
      window.Worker = class {
        postMessage({ id }) { queueMicrotask(() => this.onmessage?.({ data: { id, type: 'error', error: 'model_webgpu_unavailable：没有可用 WebGPU' } })); }
        terminate() {}
      };
      const canvas=document.createElement('canvas'); canvas.width=80; canvas.height=100;
      const ctx=canvas.getContext('2d'); ctx.fillStyle='#eeeeee'; ctx.fillRect(0,0,80,100); ctx.fillStyle='#222222'; ctx.fillRect(20,15,40,75);
      const query=canvas.toDataURL('image/png');
      const fetched=await chrome.runtime.sendMessage({ type:'FETCH_PUBLIC_IMAGE', url:'https://e3h.i.ximgs.net/fallback.gif' });
      if (!fetched?.ok || !fetched.dataUrl) throw new Error(fetched?.error || '测试图片读取失败');
      const expected=await FindSimilarity.scoreDataUrls(query,fetched.dataUrl);
      const result=await FindSimilarity.scoreItems(query, [{ id:'fallback-1', imageUrl:'https://e3h.i.ximgs.net/fallback.gif' }]);
      return { expected, result, query };
    });
    assert.equal(result.result.scored,1);
    assert.equal(result.result.engine,'local_structure_fallback_v5');
    assert.equal(result.result.items[0].imageSimilarityEngine,'local_structure_fallback_v5');
    assert.equal(result.result.items[0].imageSimilaritySource,'fashionclip_rank_v2');
    assert.equal(result.result.items[0].imageSimilarity,result.expected,'像素相似值保持原始 0–1 口径，不按模型余弦值二次换算');
    assert.ok(result.expected >= 0 && result.expected <= 1);
    const savedItem = { ...result.result.items[0], platform:'wsy', goodsId:'', title:'像素回退测试商品', price:20, detailUrl:'https://www.wsy.com/item.htm?id=1', supplierId:'test', shopName:'测试档口', address:'杭州站' };
    await page.evaluate(async ({ query, item }) => chrome.storage.local.set({ 'core.session': {
      base64:query, goodsId:'', mode:'select', baseline:'', reduction:5, raw:[item], total:1, phase:'complete', message:'搜索完成', searched:true,
      selected:['wsy'], selectionCustomized:true, platforms:{ wsy:{ phase:'complete', message:'实际收到 1 条', items:[item], total:1 } }
    } }), { query:result.query, item:savedItem });
    await page.reload();
    await page.waitForFunction(()=>!document.getElementById('pick').disabled);
    const judgment=await page.locator('#results tbody tr td').nth(4).textContent();
    assert.match(judgment,/等待大模型识别/);
    assert.doesNotMatch(judgment,/像素回退/);
  } finally { await closeContext(context); }
});

test('服装模型余弦相似值仍正确映射为0–1排序值', { timeout: 30000 }, async () => {
  const { context, page } = await launch();
  try {
    await context.route('https://e3h.i.ximgs.net/**', route => route.fulfill({ contentType: 'image/gif', body: pixel }));
    const result = await page.evaluate(async () => {
      window.Worker = class {
        postMessage({ id }) { queueMicrotask(() => this.onmessage?.({ data: { id, type: 'result', cosine: 0.72 } })); }
        terminate() {}
      };
      const canvas=document.createElement('canvas'); canvas.width=80; canvas.height=100;
      const query=canvas.toDataURL('image/png');
      return FindSimilarity.scoreItems(query, [{ id:'model-1', imageUrl:'https://e3h.i.ximgs.net/model.gif' }]);
    });
    assert.equal(result.scored,1);
    assert.equal(result.engine,'marqo_fashionclip_webgpu');
    assert.ok(Math.abs(result.items[0].imageSimilarity - 0.86) < 1e-12);
  } finally { await closeContext(context); }
});

test('真实扩展全链路：选图、平台消息、JSON、成本、刷新、失败及重置隔离', { timeout: 60000 }, async () => {
  const { context, page } = await launch();
  try {
    let calls = 0, mode = 'success', releaseDelay;
    const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
    await context.route('https://imgcdn.wsy.com/**', route => route.fulfill({ contentType: 'image/gif', body: pixel }));
    await context.route('https://www.wsy.com/**', async route => {
      if (route.request().url().includes('/jsondata/search/image.json')) {
        calls++; assert.equal(route.request().method(), 'POST');
        assert.match(route.request().postDataJSON().base64, /^data:image\/jpeg;base64,/);
        if (mode === 'login') return route.fulfill({ contentType: 'text/html', body: '<html>请登录</html>' });
        if (mode === 'empty') return route.fulfill({ contentType: 'application/json', body: '{"code":1,"list":[],"count":0}' });
        if (mode === 'delay') await new Promise(resolve => { releaseDelay = resolve; });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixture) });
      }
      return route.fulfill({ contentType: 'text/html', body: '<html><title>平台测试夹具</title><body>网商园接口测试</body></html>' });
    });
    // The platform fixture serves locally, with no requests to real sites.
    await page.evaluate(() => {
      window.Worker = class {
        postMessage({ id }) { queueMicrotask(() => this.onmessage?.({ data: { id, type: 'result', cosine: 0.72 } })); }
        terminate() {}
      };
    });
    const platform = await context.newPage(); await platform.goto('https://www.wsy.com/new/search/image');
    const sourcePng = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 160;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#4169a1'; ctx.fillRect(10, 10, 100, 140);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.locator('#file').setInputFiles({ name: 'product.png', mimeType: 'image/png', buffer: Buffer.from(sourcePng, 'base64') });
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('搜索完成'), null, { timeout: 10000 }).catch(async error => { throw new Error(`${error.message} · 页面状态=${await page.locator('#status').textContent()} · 页面异常=${JSON.stringify(pageErrors)}`); });
    assert.equal(await page.locator('#results tbody tr').count(), 4);
    assert.match(await page.locator('#summary').textContent(), /实际收到 4 条/);
    assert.match(await page.locator('#results').textContent(), /等待大模型识别/);
    assert.match(await page.locator('#status').textContent(), /模型尚未调用/);
    assert.match(await page.locator('#summary').textContent(), /总量 97/);
    assert.equal(await page.locator('#results a').first().getAttribute('href'), 'https://www.wsy.com/item.htm?id=25095312');
    assert.equal(calls, 1);
    await page.reload(); await page.waitForSelector('#results tbody tr');
    assert.equal(calls, 1, '刷新不重复上传');
    await page.locator('[value=optimize]').check(); await page.locator('#baseline').fill('65'); await page.locator('#baseline').dispatchEvent('change');
    assert.equal(await page.locator('#results tbody tr').count(), 2);
    assert.equal(await page.locator('#excludedCount').textContent(), '2');
    assert.match(await page.locator('#excludedRows').textContent(), /70/);
    mode = 'login'; await page.locator('#search').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('login_required'));
    assert.equal(await page.locator('#results tbody tr').count(), 0, '失败清除上次候选');
    assert.match(await page.locator('#empty').textContent(), /搜索失败/);
    mode = 'delay'; await page.locator('#search').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('图片已提交'), null, { timeout: 5000 }).catch(async error => { throw new Error(error.message + ' · status=' + await page.locator('#status').textContent() + ' · notice=' + await page.locator('#queryNotice').textContent() + ' · errors=' + JSON.stringify(pageErrors)); });
    await page.locator('#reset').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('已重置'), null, {timeout: 5000}).catch(async error => { throw new Error(error.message + ' · status=' + await page.locator('#status').textContent() + ' · errors=' + JSON.stringify(typeof pageErrors !== 'undefined' ? pageErrors : [])); });
    releaseDelay?.();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#results tbody tr').count(), 0);
    assert.equal(await page.locator('#sourceImage').isVisible(), false);
    assert.equal(context.pages().filter(tab => tab.url().startsWith('https://www.wsy.com')).length, 1, '复用已打开平台，不创建多余标签页');
    await platform.close(); mode = 'success';
    await page.bringToFront();
    await page.locator('#file').setInputFiles({ name: 'product.png', mimeType: 'image/png', buffer: Buffer.from(sourcePng, 'base64') });
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('搜索完成'), null, { timeout: 12000 }).catch(async error => { const tabs=await page.evaluate(async()=>{const tabs=await chrome.tabs.query({url:['https://www.wsy.com/*']});const data=[];for(const tab of tabs){let script;try{script=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>({bridge:globalThis.__findCoreBridge,ready:document.readyState,url:location.href,api:!!chrome.runtime?.id})});}catch(e){script=e.message;}data.push({id:tab.id,status:tab.status,url:tab.url,script});}return data;}); throw new Error(error.message + ' · 页面状态=' + await page.locator('#status').textContent()+' · tabs='+JSON.stringify(tabs)); });
    assert.equal(context.pages().filter(tab => tab.url().startsWith('https://www.wsy.com')).length, 0, '成功后关闭本次创建的临时平台页面');
    mode = 'empty'; await page.locator('#search').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('搜索完成'));
    assert.equal(await page.locator('#results tbody tr').count(), 0);
    assert.match(await page.locator('#empty').textContent(), /没有符合条件/);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('empty').textContent.includes('没有符合条件'));
    assert.equal(context.pages().some(tab => tab.url().includes('8.148.144.131')), false);
    assert.deepEqual(pageErrors, []);
  } finally { await closeContext(context); }
});

test('成功后修改无效成本必须显示原因；保存失败不丢失真实结果', { timeout: 30000 }, async () => {
  const { context, page } = await launch();
  try {
    let calls = 0;
    await context.route('https://imgcdn.wsy.com/**', route => route.fulfill({ contentType: 'image/gif', body: pixel }));
    await context.route('https://www.wsy.com/**', route => {
      if (route.request().url().includes('/jsondata/search/image.json')) {
        calls++; return route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixture) });
      }
      return route.fulfill({ contentType: 'text/html', body: '<html><body>平台测试夹具</body></html>' });
    });
    const platform = await context.newPage(); await platform.goto('https://www.wsy.com/new/search/image');
    const sourcePng = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 160;
      canvas.getContext('2d').fillRect(0, 0, 120, 160); return canvas.toDataURL().split(',')[1];
    });
    await page.locator('#file').setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: Buffer.from(sourcePng, 'base64') });
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('搜索完成'));
    await page.locator('[value=optimize]').check(); await page.locator('#baseline').fill('65'); await page.locator('#baseline').dispatchEvent('change');
    await page.locator('#baseline').fill(''); await page.locator('#baseline').dispatchEvent('change');
    assert.equal(await page.locator('#empty').isVisible(), true, '输入错误必须可见');
    assert.match(await page.locator('#empty').textContent(), /当前成本/);
    assert.equal(await page.locator('#results tbody tr').count(), 0);
    assert.equal(await page.locator('#excludedCount').textContent(), '0', '输入错误不显示旧淘汰记录');
    await page.locator('#baseline').fill('65'); await page.locator('#baseline').dispatchEvent('change');
    assert.equal(await page.locator('#results tbody tr').count(), 2);
    assert.equal(calls, 1, '成本更改只用当前结果重筛');
    await page.evaluate(() => { chrome.storage.local.set = async () => { throw new Error('TEST_STORAGE_QUOTA'); }; });
    await page.locator('#search').click();
    await page.waitForFunction(() => !document.getElementById('search').disabled);
    assert.equal(calls, 2, '存储失败不应阻止已选图片搜索');
    assert.equal(await page.locator('#results tbody tr').count(), 2, '结果不会因存储异常被清空');
    assert.match(await page.locator('#storageNotice').textContent(), /TEST_STORAGE_QUOTA/);
    assert.match(await page.locator('#status').textContent(), /搜索完成/);
  } finally { await closeContext(context); }
});

test('初始化阻止旧存储覆盖新操作；准备阶段重置不发送平台请求', { timeout: 30000 }, async () => {
  const { context, page } = await launch();
  try {
    await page.addInitScript(() => {
      const get = chrome.storage.local.get.bind(chrome.storage.local);
      chrome.storage.local.get = async (...args) => { await new Promise(resolve => setTimeout(resolve, 1000)); return get(...args); };
    });
    await page.reload();
    assert.equal(await page.locator('#pick').isDisabled(), true);
    assert.equal(await page.locator('#reset').isDisabled(), true);
    await page.waitForFunction(() => !document.getElementById('pick').disabled);
    assert.equal(await page.locator('#reset').isDisabled(), false);
    let calls = 0;
    await context.route('https://www.wsy.com/**', route => { calls++; return route.fulfill({ contentType: 'text/html', body: '<html>不应访问的平台</html>' }); });
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
      await chrome.storage.local.set({ 'core.session': { base64: canvas.toDataURL('image/jpeg'), raw: [], mode: 'select', goodsId: '', baseline: '', reduction: 5, phase: 'idle', searched: false } });
    });
    await page.reload(); await page.waitForFunction(() => !document.getElementById('search').disabled);
    await page.evaluate(() => {
      const set = chrome.storage.local.set.bind(chrome.storage.local);
      chrome.storage.local.set = async (...args) => { await new Promise(resolve => setTimeout(resolve, 300)); return set(...args); };
    });
    await page.locator('#search').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('正在准备平台搜图'));
    await page.locator('#reset').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('已重置'), null, {timeout: 5000}).catch(async error => { throw new Error(error.message + ' · status=' + await page.locator('#status').textContent() + ' · errors=' + JSON.stringify(typeof pageErrors !== 'undefined' ? pageErrors : [])); });
    await page.waitForFunction(() => !document.getElementById('pick').disabled);
    await page.waitForTimeout(400);
    assert.equal(calls, 0, '取消准备任务不应随后启动平台');
    await page.reload(); await page.waitForFunction(() => !document.getElementById('pick').disabled);
    assert.equal(await page.locator('#sourceImage').isVisible(), false);
  } finally { await closeContext(context); }
});

test('批量工作台拒绝损坏或过小图片，保留原有图片与搜索记录', { timeout: 30000 }, async () => {
  const { context, page } = await launch();
  try {
    let calls = 0;
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await context.route('https://www.wsy.com/**', route => { calls++; return route.fulfill({ body: '不应请求平台' }); });
    await page.evaluate(async fixture => {
      const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 160;
      await chrome.storage.local.set({ 'core.session': { base64: canvas.toDataURL('image/jpeg'), raw: FindCore.parseWsy(fixture).items, mode: 'select', goodsId: '', baseline: '', reduction: 5, phase: 'complete', message: '旧结果', searched: true } });
    }, fixture);
    await page.reload(); await page.waitForSelector('#results tbody tr');
    await page.locator('#file').setInputFiles({ name: 'damaged.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
    await page.waitForFunction(() => document.getElementById('queryNotice').textContent.includes('damaged.png') && !document.getElementById('pick').disabled);
    assert.equal(await page.locator('#results tbody tr').count(), 4);
    await page.reload(); await page.waitForFunction(() => !document.getElementById('pick').disabled);
    assert.equal(await page.locator('#results tbody tr').count(), 4);
    assert.equal(await page.locator('#sourceImage').isVisible(), true);
    const tiny = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 99; canvas.height = 160; return canvas.toDataURL().split(',')[1]; });
    await page.locator('#file').setInputFiles({ name: 'small.png', mimeType: 'image/png', buffer: Buffer.from(tiny, 'base64') });
    await page.waitForFunction(() => document.getElementById('queryNotice').textContent.includes('99×160') && !document.getElementById('pick').disabled);
    assert.equal(calls, 0);
    assert.equal(await page.locator('#sourceImage').isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await closeContext(context); }
});
