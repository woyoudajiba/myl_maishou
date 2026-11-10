const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchPersistentContext } = require('./browser');
const root = path.resolve(__dirname, '..');
const fixtureKey = 'sk-browser-fixture-credential';

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'find-vision-'));
  const context = await launchPersistentContext(profile, { headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
  await context.route('https://**/*', route => route.abort());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.storage.local.set({ productComparisonDesktopEnabled: false }));
  const page = await context.newPage();
  await page.goto(worker.url().replace('background.js', 'workbench.html'));
  await page.waitForFunction(() => !document.getElementById('pick').disabled);
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 1000;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#eee'; ctx.fillRect(0, 0, 240, 320);
    ctx.fillStyle = '#345776'; ctx.fillRect(50, 60, 140, 210);
    return canvas.toDataURL('image/png');
  });
  await context.route('https://imgcdn.wsy.com/**', route => route.fulfill({ contentType: 'image/png', body: Buffer.from(image.split(',')[1], 'base64') }));
  await worker.evaluate(image => {
    const original = globalThis.fetch;
    globalThis.testRequests = []; globalThis.testVisionMode = 'ok'; globalThis.testAborted = 0;
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('https://imgcdn.wsy.com/')) {
        return new Response(Uint8Array.from(atob(image.split(',')[1]), c => c.charCodeAt(0)), { headers: { 'content-type': 'image/png' } });
      }
      if (!String(url).startsWith('https://dashscope.aliyuncs.com/')) return original(url, options);
      const body = JSON.parse(options.body), content = body.messages[1].content;
      const ids = content.filter(part => part.type === 'text' && part.text.startsWith('候选编号：')).map(part => part.text.slice(5));
      globalThis.testRequests.push({ ids, imageCount: content.filter(part => part.type === 'image_url').length, model: body.model, enableThinking: body.enable_thinking });
      if (globalThis.testVisionMode === 'delay') return new Promise((_, reject) => options.signal.addEventListener('abort', () => { globalThis.testAborted++; reject(new Error('aborted')); }));
      if (globalThis.testVisionMode === 'unauthorized') return new Response('provider private text must not escape', { status: 401 });
      const results = ids.map(id => { const number = Number(id.slice('candidate_'.length)); return { id, verdict: number === 2 ? 'different' : 'likely_same', score: number === 2 ? 80 : 90,
        matches: ['尖领形状一致', `候选 ${id} 左胸贴袋一致`], differences: number === 2 ? ['袖型不同'] : [], uncertainties: [] }; }).reverse();
      if (globalThis.testVisionMode === 'duplicate' && results.length > 1) results[0].id = results[1].id;
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results }) } }] }), { headers: { 'content-type': 'application/json' } });
    };
  }, image);
  return { context, page, worker, image, async close() { await context.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}
async function configure(page) {
  await page.locator('#visionKey').fill(fixtureKey);
  await page.locator('#saveVision').click();
  await page.waitForFunction(() => document.getElementById('visionStatus').textContent.includes('已配置'));
}
async function seed(page, image, count = 9) {
  await page.evaluate(async ({ image, count }) => {
    const items = Array.from({ length: count }, (_, index) => ({ platform: 'wsy', id: String(index + 1), title: '测试服装', price: 20,
      imageUrl: `https://imgcdn.wsy.com/${index + 1}.png`, detailUrl: `https://www.wsy.com/item.htm?id=${index + 1}` }));
    await chrome.storage.local.set({ 'core.session': { base64: image, raw: items, mode: 'select', searched: true, phase: 'complete', selected: ['wsy'], selectionCustomized: true, platforms: { wsy: { key: 'wsy', items, phase: 'complete', total: count, message: '已返回测试商品' } } } });
  }, { image, count });
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('compareAgain').disabled);
}

test('真实扩展多图通路：9张候选分3批，乱序回执正确对应，单独重比不请求平台', { timeout: 30000 }, async () => {
  const app = await launch();
  const { page, worker, image } = app;
  try {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await configure(page);
    assert.equal(await page.locator('#visionKey').inputValue(), '');
    assert.equal(await page.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)).includes('sk-browser')), false);
    await seed(page, image);
    await page.evaluate(() => { FindTransport.searchAll = () => { throw new Error('比对不应请求平台'); }; });
    await page.locator('#compareAgain').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('已确认候选的识别完成'));
    const requests = await worker.evaluate(() => globalThis.testRequests);
    assert.deepEqual(requests.map(item => item.imageCount).sort((a,b)=>b-a), [5, 5, 2]);
    assert.equal(requests[0].model, 'qwen3.7-plus'); assert.equal(requests[0].enableThinking, false);
    if(await page.locator('#showAll').isVisible())await page.locator('#showAll').click();
    const rows = await page.locator('#results tbody tr').allTextContents();
    assert.match(rows[0], /疑似同款/); assert.match(rows[0], /candidate_1/);
    assert.match(await page.locator('#excludedRows').textContent(), /85/);
    assert.equal(await page.locator('#results tbody tr').count(), 8);
    assert.match(await page.locator('#status').textContent(), /比对完成（9 张）/);
    await page.reload(); await page.waitForSelector('#results tbody tr');
    assert.match(await page.locator('#results').textContent(), /尖领形状一致/);
    assert.equal((await worker.evaluate(() => globalThis.testRequests)).length, 3, '刷新不重发模型请求');
    assert.equal(await page.locator('#compareAgain').isDisabled(), true);
    assert.equal((await worker.evaluate(() => globalThis.testRequests)).length, 3, '已完成候选不重复请求模型');
    fs.mkdirSync(path.join(root, 'output/playwright'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'output/playwright/multimodal-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(root, 'output/playwright/multimodal-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
});

test('低于50分自动从主列表排除；50分保留，人工改分后动态进出列表', { timeout: 30000 }, async () => {
  const app = await launch();
  try {
    await configure(app.page); await seed(app.page, app.image, 3);
    await app.page.evaluate(async () => {
      const index = await FindQueryStore.loadIndex();
      const session = await FindQueryStore.get(index.activeId);
      session.raw.forEach((item,index) => {
        item.imageSimilaritySource = FindVision.algorithm; item.imageSimilarityStatus = 'compared';
        item.visualComparison = { id:'candidate_'+(index+1), verdict:'likely_same', score:[49,50,80][index], matches:[], differences:[], uncertainties:[] };
      });
      session.platforms.wsy.items = session.raw;
      await chrome.storage.local.set({ 'core.session': session });
      await FindQueryStore.write([session], index);
    });
    await app.page.reload(); await app.page.waitForFunction(() => document.querySelectorAll('#results tbody tr').length === 1);
    assert.equal(await app.page.locator('#results tbody tr').count(), 1);
    assert.match(await app.page.locator('#summary').textContent(), /50 分及以下排除 2 条/);
    await app.page.locator('#reviewFilter').selectOption('excluded');
    assert.equal(await app.page.locator('#results tbody tr').count(), 2);
    assert.equal(await app.page.locator('#reviewNext').isDisabled(), false, '其余高分结果仍可进入人工审核队列');
    await app.page.locator('#results tbody tr[data-id="2"] [data-review-index]').click();
    await app.page.locator('.confirm-same').click();
    await app.page.waitForFunction(() => !document.getElementById('reviewDialog').open);
    await app.page.locator('#reviewFilter').selectOption('all');
    assert.equal(await app.page.locator('#results tbody tr').count(), 2);
    const { kept, excluded } = await app.page.evaluate(async () => { const s=(await chrome.storage.local.get('core.session'))['core.session']; const result=FindCore.evaluate(s.raw,s); return {kept:result.kept.length,excluded:result.excluded.filter(x=>x.scoreExcluded).length}; });
    assert.deepEqual({kept,excluded},{kept:2,excluded:1});
  } finally { await app.close(); }
});

test('没有配置或鉴权失败时保留商品且明确未识别，不调用本地回退、不重复收费请求', { timeout: 30000 }, async () => {
  const app = await launch();
  const { page, worker, image } = app;
  try {
    await seed(page, image);
    await page.evaluate(() => { FindSimilarity.scoreItems = () => { throw new Error('不允许像素回退'); }; });
    await page.locator('#compareAgain').click();
    await page.waitForFunction(() => !document.getElementById('compareAgain').disabled);
    assert.match(await page.locator('#results').textContent(), /未完成识别/);
    assert.equal((await worker.evaluate(() => globalThis.testRequests)).length, 0);
    await configure(page);
    await worker.evaluate(() => { globalThis.testVisionMode = 'unauthorized'; });
    await page.locator('#compareAgain').click();
    await page.waitForFunction(() => !document.getElementById('compareAgain').disabled);
    assert.equal((await worker.evaluate(() => globalThis.testRequests)).length, 3);
    assert.match(await page.locator('#results').textContent(), /HTTP 401/);
    assert.doesNotMatch(await page.locator('body').textContent(), /provider private text/);
    assert.match(await page.locator('#summary').textContent(), /实际收到 9 条/);
    assert.match(await page.locator('#status').textContent(), /9 张未完成识别/);
  } finally { await app.close(); }
});

test('模型返回重复候选编号时拒绝整批，禁止把其他商品的细节回填过来', { timeout: 30000 }, async () => {
  const app = await launch();
  try {
    await configure(app.page); await seed(app.page, app.image, 4);
    await app.worker.evaluate(() => { globalThis.testVisionMode = 'duplicate'; });
    await app.page.locator('#compareAgain').click();
    await app.page.waitForFunction(() => document.getElementById('status').textContent.includes('已确认候选的识别完成'));
    assert.equal(await app.page.locator('[data-verdict="unavailable"]').count(), 4);
    assert.match(await app.page.locator('#status').textContent(), /候选编号或结论无效/);
  } finally { await app.close(); }
});

test('停止比对会断开扩展端口并中止模型HTTP，重新比对可正常继续', { timeout: 30000 }, async () => {
  const app = await launch();
  try {
    await configure(app.page); await seed(app.page, app.image, 4);
    await app.worker.evaluate(() => { globalThis.testVisionMode = 'delay'; });
    await app.page.locator('#compareAgain').click();
    await app.page.waitForFunction(() => document.getElementById('status').textContent.includes('大模型正在'));
    await app.page.waitForTimeout(80);
    await app.page.locator('#stopSearch').click();
    await app.page.waitForFunction(() => !document.getElementById('compareAgain').disabled);
    assert.equal(await app.worker.evaluate(() => globalThis.testAborted), 1);
    await app.worker.evaluate(() => { globalThis.testVisionMode = 'ok'; });
    await app.page.locator('#compareAgain').click();
    await app.page.waitForFunction(() => document.getElementById('status').textContent.includes('已确认候选的识别完成'));
    assert.match(await app.page.locator('#status').textContent(), /比对完成（4 张）/);
  } finally { await app.close(); }
});

test('候选图片瞬时超时只重取一次；404不重取，成功图片继续交给模型', { timeout: 30000 }, async () => {
  const app = await launch();
  try {
    await configure(app.page);
    const result = await app.page.evaluate(async image => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      const calls = {};
      chrome.runtime.sendMessage = async message => {
        if (message.type !== 'FETCH_PUBLIC_IMAGE') return send(message);
        calls[message.url] = (calls[message.url] || 0) + 1;
        if (message.url.endsWith('404.png')) return { ok: false, error: 'image_match：图片 HTTP 404' };
        if (calls[message.url] === 1) return { ok: false, error: 'image_match：图片请求超过12秒' };
        return { ok: true, dataUrl: image };
      };
      const result = await FindVision.scoreItems(image, [{ id: 'a', imageUrl: 'https://imgcdn.wsy.com/retry.png' }, { id: 'b', imageUrl: 'https://imgcdn.wsy.com/404.png' }]);
      return { calls, scored: result.scored, failed: result.failed };
    }, app.image);
    assert.equal(result.calls['https://imgcdn.wsy.com/retry.png'], 2);
    assert.equal(result.calls['https://imgcdn.wsy.com/404.png'], 1);
    assert.equal(result.scored, 1); assert.equal(result.failed, 1);
  } finally { await app.close(); }
});

test('超过500个候选时只标记任务过大，不下载图片或调用模型', { timeout: 30000 }, async () => {
  const app = await launch();
  try {
    await configure(app.page);
    const result = await app.page.evaluate(image => {
      const items = Array.from({ length: 501 }, (_, index) => ({ id: String(index), imageUrl: `https://imgcdn.wsy.com/${index}.png` }));
      return FindVision.scoreItems(image, items);
    }, app.image);
    assert.equal(result.scored, 0); assert.equal(result.failed, 501);
    assert.match(result.error, /超过500张/);
    assert.equal((await app.worker.evaluate(() => globalThis.testRequests)).length, 0);
  } finally { await app.close(); }
});

test('人工审核闭环：三种动作无需重新评分，保存失败保留草稿，模式切换及刷新不重调模型', {timeout:45000}, async()=>{
  const app=await launch();const {page,worker,image}=app;
  try{
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await configure(page);await seed(page,image,3);
    await page.locator('#compareAgain').click();
    await page.waitForFunction(()=>document.getElementById('status').textContent.includes('已确认候选的识别完成'));
    assert.match(await page.locator('#reviewSummary').textContent(),/待人工核对：2 条/);
    await page.locator('#reviewFilter').selectOption('final');
    assert.equal(await page.locator('#results').isVisible(),false);
    await page.locator('#reviewNext').click();
    await page.waitForSelector('#reviewDialog[open]');
    assert.equal(await page.locator('#humanScore').isVisible(),false);
    assert.equal(await page.locator('.review-actions button[data-verdict]').count(),3);
    await page.locator('#reviewNote').fill('袖口被遮挡，无法核对');
    await page.setViewportSize({width:390,height:844});
    fs.mkdirSync(path.join(root,'output/playwright'),{recursive:true});
    await page.screenshot({path:path.join(root,'output/playwright/review-mobile.png'),fullPage:true});
    assert.equal(await page.locator('#reviewDialog').evaluate(node=>node.scrollWidth<=node.clientWidth),true);
    await page.setViewportSize({width:1280,height:900});
    await page.evaluate(()=>{const original=chrome.storage.local.set.bind(chrome.storage.local);chrome.storage.local.set=async()=>{chrome.storage.local.set=original;throw new Error('fixture storage full');};});
    await page.locator('.cannot-decide').click();
    await page.waitForFunction(()=>document.getElementById('reviewError').textContent.includes('审核未保存'));
    assert.equal(await page.locator('#reviewNote').inputValue(),'袖口被遮挡，无法核对');
    assert.match(await page.locator('#reviewSummary').textContent(),/人工已处理 0 条/);
    await page.locator('.cannot-decide').click();
    await page.waitForSelector('#reviewDialog',{state:'hidden'});
    assert.match(await page.locator('#reviewSummary').textContent(),/人工已处理 1 条/);
    assert.equal(await page.locator('#results tbody tr').count(),1);
    const saved=await page.evaluate(async()=>(await chrome.storage.local.get('core.session'))['core.session']);
    const reviewed=saved.raw.find(item=>item.humanReview);
    assert.equal(reviewed.humanReview.verdict,'uncertain');
    assert.equal(reviewed.humanReview.score,null);
    assert.equal(reviewed.visualComparison.score,90);
    await page.locator('#reviewMode').selectOption('direct');
    await page.locator('#reviewFilter').selectOption('all');
    await page.reload();await page.waitForSelector('#results tbody tr');
    assert.equal(await page.locator('#reviewMode').inputValue(),'direct');
    assert.match(await page.locator('#reviewSummary').textContent(),/模型建议仍为暂定结论/);
    await page.locator(`#results tr[data-id="${reviewed.id}"] [data-review-index]`).click();
    await page.locator('#clearReview').click();await page.waitForSelector('#reviewDialog',{state:'hidden'});
    assert.match(await page.locator('#reviewSummary').textContent(),/人工已处理 0 条/);
    await page.locator('#reviewNext').click();await page.locator('.confirm-same').click();
    await page.waitForSelector('#reviewDialog',{state:'hidden'});
    const confirmed=await page.evaluate(async()=>(await chrome.storage.local.get('core.session'))['core.session']);
    assert.equal(confirmed.raw.find(i=>i.humanReview).humanReview.score,undefined);
    assert.equal((await worker.evaluate(()=>globalThis.testRequests)).length,1);
    assert.deepEqual(errors,[]);
  }finally{await app.close();}
});
