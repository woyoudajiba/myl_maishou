// Optional online smoke: public catalog fixture images only, never user profiles.
// The key is read from the process environment and is not printed or exported.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchPersistentContext } = require('../browser-test/browser');
const protocol = require('../vision-protocol');
const core = require('../core');
const root = path.resolve(__dirname, '..');

async function checkDirect(config) {
  const { chromium } = require('playwright');
  const items = core.parseWsy(JSON.parse(fs.readFileSync(path.join(root, 'fixtures/wsy-image-search.json'), 'utf8'))).items.slice(0, 3);
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const started = Date.now();
  try {
    const page = await browser.newPage();
    const images = [];
    for (const item of items) {
      const response = await fetch(item.imageUrl, { signal: AbortSignal.timeout(12000), credentials: 'omit' });
      if (!response.ok || !/^image\//.test(response.headers.get('content-type'))) throw new Error('catalog_image：公开样本图片不可用');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 4 * 1024 * 1024) throw new Error('catalog_image：公开样本图片过大');
      images.push(`data:${response.headers.get('content-type')};base64,${bytes.toString('base64')}`);
    }
    const data = await page.evaluate(async images => {
      const output = [];
      for (const image of images) {
        const bitmap = await createImageBitmap(await (await fetch(image)).blob());
        const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
        output.push(canvas.toDataURL('image/jpeg', .9));
      }
      return output;
    }, images);
    const candidates = [...data, data[0]].map((dataUrl, index) => ({ id: `candidate_${index + 1}`, dataUrl }));
    const response = await fetch(protocol.endpoints[config.provider], { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify(protocol.requestBody(config, { query: data[0], candidates })) });
    if (!response.ok) throw new Error(`vision_http：HTTP ${response.status}`);
    const json = await response.json();
    if (json.choices?.[0]?.finish_reason !== 'stop') throw new Error('vision_response：未正常完成');
    const results = protocol.parseResults(json.choices[0].message.content, candidates);
    const report = { checkedAt: new Date().toISOString(), model: config.model, provider: config.provider, transport: 'node_https',
      source: 'three_public_catalog_images_plus_duplicate_reference_control', imageCount: 5, elapsedMs: Date.now() - started,
      verdicts: results.map(item => ({ ...item, sameImageAsQuery: ['candidate_1', 'candidate_4'].includes(item.id) })),
      limitation: 'Checks the real API with real public product photos; does not verify extension HTTPS or a labeled same-style benchmark.' };
    fs.mkdirSync(path.join(root, 'output'), { recursive: true });
    fs.writeFileSync(path.join(root, 'output/vision-api-smoke.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (results.filter(item => ['candidate_1', 'candidate_4'].includes(item.id)).some(item => item.verdict !== 'likely_same')) process.exitCode = 1;
  } finally { await browser.close(); }
}

(async () => {
  const apiKey = process.env.PRODUCT_COMPARISON_API_KEY || process.env.DASHSCOPE_API_KEY;
  const config = protocol.configuration({ apiKey, model: process.env.PRODUCT_COMPARISON_MODEL || 'qwen3.7-plus', provider: 'dashscope' });
  if (process.argv.includes('--node')) { await checkDirect(config); return; }
  const items = core.parseWsy(JSON.parse(fs.readFileSync(path.join(root, 'fixtures/wsy-image-search.json'), 'utf8'))).items.slice(0, 3);
  items.push({ ...items[0], id: 'same-photo-control' });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'find-vision-api-'));
  let context;
  try {
    context = await launchPersistentContext(profile, { headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
    context.on('requestfailed', request => {
      try { console.log(JSON.stringify({ stage: 'extension_https', host: new URL(request.url()).hostname, networkError: request.failure()?.errorText?.match(/net::[A-Z_]+/)?.[0] || 'request_failed' })); } catch {}
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(worker.url().replace('background.js', 'workbench.html'));
    await page.waitForFunction(() => !document.getElementById('pick').disabled);
    const configured = await page.evaluate(config => chrome.runtime.sendMessage({ type: 'VISION_CONFIGURE', config }), config);
    if (!configured.ok) throw new Error('online_smoke：临时会话配置失败');
    const started = Date.now();
    const result = await page.evaluate(async items => {
      const response = await chrome.runtime.sendMessage({ type: 'FETCH_PUBLIC_IMAGE', url: items[0].imageUrl });
      if (!response.ok) return { error: response.error };
      const bitmap = await createImageBitmap(await (await fetch(response.dataUrl)).blob());
      const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
      const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
      const batch = await FindVision.scoreItems(canvas.toDataURL('image/jpeg', .9), items);
      return { compared: batch.scored, failed: batch.failed, error: batch.error || null, models: [...new Set(batch.items.map(item => item.imageSimilarityEngine))],
        verdicts: batch.items.map((item, index) => ({ index: index + 1, sameImageAsQuery: index === 0 || index === 3, verdict: item.visualComparison?.verdict || 'unavailable',
          error: item.imageSimilarityError || null,
          matches: item.visualComparison?.matches || [], differences: item.visualComparison?.differences || [], uncertainties: item.visualComparison?.uncertainties || [] })) };
    }, items);
    const report = { checkedAt: new Date().toISOString(), model: config.model, provider: config.provider,
      source: 'three_public_catalog_images_plus_duplicate_reference_control', intendedCandidates: items.length, elapsedMs: Date.now() - started, ...result };
    fs.mkdirSync(path.join(root, 'output'), { recursive: true });
    fs.writeFileSync(path.join(root, 'output/vision-smoke.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (report.compared !== items.length || report.verdicts?.filter(item => item.sameImageAsQuery).some(item => item.verdict !== 'likely_same')) process.exitCode = 1;
  } finally {
    await context?.close();
    if (path.dirname(profile) !== path.resolve(os.tmpdir()) || !path.basename(profile).startsWith('find-vision-api-')) throw new Error('Invalid temporary profile path');
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(error => {
  const detail = /^(vision_|catalog_image：)/.test(error.message) ? error.message : '请确认环境变量、网络和浏览器运行环境';
  console.error(`online_smoke：检查失败；${detail}。未输出凭证或请求内容。`); process.exitCode = 1;
});
