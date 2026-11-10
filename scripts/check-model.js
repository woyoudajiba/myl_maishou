// Optional online acceptance: only generated images and public model assets.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launchPersistentContext } = require('../browser-test/browser');

(async () => {
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'find-real-model-'));
  let context;
  try {
    context = await launchPersistentContext(profile, { headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
    await context.route('https://**/*', route => {
      const host = new URL(route.request().url()).hostname;
      if (['huggingface.co', 'hf.co'].some(domain => host === domain || host.endsWith('.' + domain))) return route.continue();
      return route.abort();
    });
    const background = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(background.url().replace('background.js', 'workbench.html'));
    const result = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 320;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 240, 320); ctx.fillStyle = '#244c92'; ctx.fillRect(70, 50, 100, 220);
      const image = canvas.toDataURL('image/png');
      const worker = new Worker(chrome.runtime.getURL('similarity-worker.js'), { type: 'module' });
      try {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('model_timeout：真实模型下载或推理超过90秒')), 90000);
          worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message || 'model_worker')); };
          worker.onmessage = ({ data }) => {
            if (data.type === 'progress') return;
            clearTimeout(timer);
            if (data.type === 'error') reject(new Error(data.error));
            else resolve({ cosine: data.cosine, version: chrome.runtime.getManifest().version, model: 'Marqo/marqo-fashionCLIP', engine: 'webgpu' });
          };
          worker.postMessage({ id: 1, type: 'score', query: image, candidate: image });
        });
      } finally { worker.terminate(); }
    });
    assert.ok(result.cosine > 0.999, '同图嵌入余弦值应接近1');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context?.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(error => {
  console.error(String(error.message || error).split(' ').map(word => word.startsWith('http') ? word.split('?')[0] : word).join(' ').slice(0, 600));
  process.exitCode = 1;
});
