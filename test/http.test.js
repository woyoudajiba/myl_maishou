const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('../wsy-http.js');
const base64 = 'data:image/jpeg;base64,YQ==';
const response = (body, opts = {}) => ({ ok: true, status: 200, redirected: false, url: 'https://www.wsy.com/jsondata/search/image.json', text: async () => body, ...opts });
test('请求真实路径和base64字段，明确带同源Cookie', async () => {
  const result = await http.search(base64, { prepareImage: async image => image, fetchImpl: async (url, options) => {
    assert.equal(url, '/jsondata/search/image.json'); assert.equal(options.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(options.body), { base64 });
    return response('{"code":1,"list":[],"count":0}');
  } });
  assert.equal(result.received, 0);
});
test('登录页、验证码页和HTTP限流明确失败', async () => {
  await assert.rejects(http.search(base64, { prepareImage: async image => image, fetchImpl: async () => response('<html>请登录</html>') }), /login_required/);
  await assert.rejects(http.search(base64, { prepareImage: async image => image, fetchImpl: async () => response('<html>请完成验证</html>') }), /response_parse/);
  await assert.rejects(http.search(base64, { prepareImage: async image => image, fetchImpl: async () => response('', { ok: false, status: 429 }) }), /HTTP 429/);
  await assert.rejects(http.search('invalid', { fetchImpl: async () => { throw new Error('不应请求'); } }), /image_input/);
});
test('当前WSY前端定义的登录、服务繁忙和尺寸错误分别提示', async () => {
  await assert.rejects(http.search(base64, { prepareImage: async image => image, fetchImpl: async () => response('{"status":501}') }), /login_required.*status=501/);
  await assert.rejects(http.search(base64, { prepareImage: async image => image, fetchImpl: async () => response('{"code":403}') }), /platform_busy/);
  await assert.rejects(http.search(base64, { prepareImage: async image => image, fetchImpl: async () => response('{"code":"UnsupportedPicPixels"}') }), /image_dimensions/);
});
const hungFetch = (_url, { signal }) => new Promise((_, reject) => {
  if (signal.aborted) reject(new Error('aborted'));
  else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});
test('请求有超时，取消不会伪装成功', async () => {
  await assert.rejects(http.search(base64, { prepareImage: async image => image, fetchImpl: hungFetch, timeoutMs: 20 }), /request_timeout/);
  const controller = new AbortController();
  const pending = http.search(base64, { prepareImage: async image => image, fetchImpl: hungFetch, signal: controller.signal }); controller.abort();
  await assert.rejects(pending, /request_cancelled/);
});
