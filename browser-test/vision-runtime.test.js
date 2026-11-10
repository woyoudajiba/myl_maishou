const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchPersistentContext } = require('./browser');
const { onnx } = require('../node_modules/onnxruntime-web/lib/onnxjs/ort-schema/protobuf/onnx.js');
const root = path.resolve(__dirname, '..');

// Tiny synthetic image embedding graph: average the three color channels.
// This exercises the actual processor, Worker, WebGPU and packaged ONNX runtime,
// without downloading FashionCLIP weights or contacting a supplier.
function modelFixture() {
  const tensor = (name, shape) => ({ name, type: { tensorType: { elemType: 1, shape: { dim: shape.map(dimValue => ({ dimValue })) } } } });
  return onnx.ModelProto.encode(onnx.ModelProto.fromObject({
    irVersion: 8, opsetImport: [{ domain: '', version: 13 }],
    graph: { name: 'synthetic-color-embedding',
      input: [tensor('pixel_values', [1, 3, 2, 2])], output: [tensor('image_embeds', [1, 3])],
      node: [{ opType: 'ReduceMean', input: ['pixel_values'], output: ['image_embeds'],
        attribute: [{ name: 'axes', type: 7, ints: [2, 3] }, { name: 'keepdims', type: 2, i: 0 }] }]
    }
  })).finish();
}

test('真实模型Worker使用扩展内代码与WASM执行合成ONNX推理，无远程执行代码', { timeout: 60000 }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'find-vision-runtime-'));
  let context;
  try {
    context = await launchPersistentContext(profile, { headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
    const requested = [];
    await context.route('https://**/*', route => {
      const url = new URL(route.request().url()); requested.push(url.href);
      const headers = { 'access-control-allow-origin': '*' };
      if (url.hostname !== 'huggingface.co' || !url.pathname.startsWith('/Marqo/marqo-fashionCLIP/resolve/')) return route.abort();
      if (url.pathname.endsWith('/preprocessor_config.json')) return route.fulfill({ headers, json: { image_processor_type: 'CLIPImageProcessor', do_resize: true, size: { shortest_edge: 2 }, do_center_crop: true, crop_size: { height: 2, width: 2 }, do_rescale: true, rescale_factor: 1 / 255, do_normalize: true, image_mean: [0, 0, 0], image_std: [1, 1, 1] } });
      if (url.pathname.endsWith('/config.json')) return route.fulfill({ headers, json: { model_type: 'clip', projection_dim: 3, vision_config: { image_size: 2, num_channels: 3 } } });
      if (url.pathname.endsWith('/onnx/vision_model_q4f16.onnx')) return route.fulfill({ headers, contentType: 'application/octet-stream', body: Buffer.from(modelFixture()) });
      return route.fulfill({ headers, status: 404, body: 'fixture not found' });
    });
    const background = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(background.url().replace('background.js', 'workbench.html'));
    const result = await page.evaluate(async () => {
      await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      const color = value => { const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 4; const ctx = canvas.getContext('2d'); ctx.fillStyle = value; ctx.fillRect(0, 0, 4, 4); return canvas.toDataURL('image/png'); };
      const worker = new Worker(chrome.runtime.getURL('similarity-worker.js'), { type: 'module' });
      const call = (id, candidate) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('real Worker timeout')), 45000);
        worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message || 'worker import failed')); };
        worker.onmessage = ({ data }) => { if (data.id !== id || data.type === 'progress') return; clearTimeout(timer); if (data.type === 'error') reject(new Error(data.error)); else resolve(data.cosine); };
        worker.postMessage({ id, type: 'score', query: color('#ff0000'), candidate });
      });
      try { return { same: await call(1, color('#ff0000')), different: await call(2, color('#0000ff')) }; }
      finally { worker.terminate(); }
    });
    assert.ok(result.same > 0.999, JSON.stringify(result));
    assert.ok(Math.abs(result.different) < 0.001, JSON.stringify(result));
    assert.ok(requested.some(url => url.endsWith('/onnx/vision_model_q4f16.onnx')));
    assert.ok(requested.every(url => !/\.(?:m?js|wasm)(?:[?#]|$)/.test(url)), '执行代码不能来自外网');
  } finally {
    await context?.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
