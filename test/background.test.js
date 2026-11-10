const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../background.js'), 'utf8');

function setup(fetchImpl, timers = {}) {
  let listener;
  const chrome = {
    action: { onClicked: { addListener() {} } },
    runtime: { getURL: path => `chrome-extension://test/${path}`, onMessage: { addListener(fn) { listener = fn; } } },
    tabs: { query: async () => [], create: async () => {}, update: async () => {}, windows: {} }
  };
  const context = vm.createContext({ chrome, fetch: fetchImpl, AbortController, URL, setTimeout, clearTimeout, btoa, ...timers });
  vm.runInContext(source, context);
  return message => new Promise(resolve => listener(message, {}, resolve));
}

test('衣衫汇 ximgs 图片 HTTP 地址升级为 HTTPS 后可读取', async () => {
  let requested;
  const send = setup(async (url, options) => {
    requested = { url, options };
    return { ok: true, status: 200, url, headers: { get: name => name === 'content-type' ? 'image/jpeg' : '' }, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
  });
  const result = await send({ type: 'FETCH_PUBLIC_IMAGE', url: 'http://e3h.i.ximgs.net/a.jpg' });
  assert.equal(result.ok, true); assert.equal(requested.url, 'https://e3h.i.ximgs.net/a.jpg');
  assert.equal(requested.options.credentials, 'omit'); assert.match(result.dataUrl, /^data:image\/jpeg;base64,/);
});

test('图片响应头返回后响应体卡住，仍在12秒边界中止并报告超时', async () => {
  let expire, cleared = false, bodyStarted;
  const started = new Promise(resolve => { bodyStarted = resolve; });
  const send = setup(async (url, { signal }) => {
    const read = () => {
      bodyStarted();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
    };
    return { ok: true, url, headers: { get: name => name === 'content-type' ? 'image/png' : null },
      arrayBuffer: read, body: { getReader: () => ({ read, cancel: async () => {} }) } };
  }, { setTimeout(fn, ms) { assert.equal(ms, 12000); expire = fn; return 1; }, clearTimeout() { cleared = true; } });
  const pending = send({ type: 'FETCH_PUBLIC_IMAGE', url: 'https://imgcdn.wsy.com/slow.png' });
  await started;
  assert.equal(cleared, false, '不能在收到响应头后提前撤掉超时保护');
  expire();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /超过12秒/);
  assert.equal(cleared, true);
});

test('图片流超过4MB立即取消，不继续读取剩余响应体', async () => {
  let reads = 0, cancelled = false;
  const send = setup(async url => ({ ok: true, url, headers: { get: name => name === 'content-type' ? 'image/png' : null },
    arrayBuffer: async () => { throw new Error('不应一次性读取整个响应体'); },
    body: { getReader: () => ({
      async read() { reads++; return { done: false, value: new Uint8Array(3 * 1024 * 1024) }; },
      async cancel() { cancelled = true; }
    }) } }));
  const result = await send({ type: 'FETCH_PUBLIC_IMAGE', url: 'https://imgcdn.wsy.com/large.png' });
  assert.match(result.error, /超过 4MB/);
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
});

test('图像读取仍拒绝非平台域名和带凭据地址', async () => {
  const send = setup(async () => { throw new Error('不应请求'); });
  assert.match((await send({ type: 'FETCH_PUBLIC_IMAGE', url: 'https://example.org/a.jpg' })).error, /域名或协议/);
  assert.match((await send({ type: 'FETCH_PUBLIC_IMAGE', url: 'https://user:pass@e3h.i.ximgs.net/a.jpg' })).error, /域名或协议/);
});

test('图像读取拒绝其他 ximgs 子域和重定向到站外的图片', async () => {
  let requests = 0;
  const sibling = setup(async () => { requests++; throw new Error('不应请求'); });
  assert.match((await sibling({ type: 'FETCH_PUBLIC_IMAGE', url: 'https://other.i.ximgs.net/a.jpg' })).error, /域名或协议/);
  const redirect = setup(async url => ({ ok: true, status: 200, url: 'https://outside.example.org/a.jpg', headers: { get: name => name === 'content-type' ? 'image/jpeg' : '' }, arrayBuffer: async () => new ArrayBuffer(0) }));
  assert.match((await redirect({ type: 'FETCH_PUBLIC_IMAGE', url: 'https://e3h.i.ximgs.net/a.jpg' })).error, /重定向/);
  assert.equal(requests, 0);
});

test('清单只为衣衫汇公开使用的两个 CDN 主机增加 HTTPS 权限', () => {
  const manifest = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '../manifest.json'), 'utf8'));
  assert.ok(manifest.host_permissions.includes('https://e3h.i.ximgs.net/*'));
  assert.ok(manifest.host_permissions.includes('https://aodo.i.ximgs.net/*'));
  assert.equal(manifest.host_permissions.some(permission => /ximgs\.net/.test(permission) && !['https://e3h.i.ximgs.net/*','https://aodo.i.ximgs.net/*'].includes(permission)), false);
});
