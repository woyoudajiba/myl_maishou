const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchPersistentContext } = require('./browser');
const root = path.resolve(__dirname, '..');
const core = fs.readFileSync(path.join(root, 'core.js'), 'utf8');
const transport = fs.readFileSync(path.join(root, 'wsy-http.js'), 'utf8');

test('网商园请求使用官网同款短边300像素JPEG预处理', { timeout: 30000 }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'find-wsy-image-'));
  const context = await launchPersistentContext(profile, {
    headless: true
  });
  try {
    await context.route('https://**/*', route => route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
    const page = await context.newPage();
    await page.goto('https://www.wsy.com/new/search/image');
    await page.addScriptTag({ content: core });
    await page.addScriptTag({ content: transport });
    const input = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 1200;
      const context = canvas.getContext('2d'); context.fillStyle = '#4169a1'; context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    });
    const result = await page.evaluate(async image => {
      let sent;
      const response = await FindWsyHttp.search(image, { fetchImpl: async (url, options) => {
        const payload = JSON.parse(options.body); const rendered = new Image();
        const loaded = new Promise((resolve, reject) => { rendered.onload = resolve; rendered.onerror = reject; });
        rendered.src = payload.base64; await loaded;
        sent = { url, credentials: options.credentials, width: rendered.naturalWidth, height: rendered.naturalHeight,
          mime: payload.base64.slice(0, payload.base64.indexOf(';')) };
        return { ok: true, status: 200, redirected: false, url: 'https://www.wsy.com/jsondata/search/image.json', text: async () => '{"code":1,"list":[],"count":0}' };
      } });
      return { sent, received: response.received };
    }, input);
    assert.equal(result.received, 0);
    assert.equal(result.sent.url, '/jsondata/search/image.json');
    assert.equal(result.sent.credentials, 'same-origin');
    assert.deepEqual([result.sent.width, result.sent.height], [300, 450]);
    assert.equal(result.sent.mime, 'data:image/jpeg');
  } finally { await context.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});
