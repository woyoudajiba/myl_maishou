'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createServer } = require('../server');
const formGrant = (access, refresh = 'refresh') => Response.json({ code: 0, data: { access_token: access, refresh_token: refresh, expires_in: 1800 } });
const ok = data => Response.json({ code: 0, data });
async function fixture(t, handler) {
  const service = createServer({
    env: { ERP_TENANT_ID: '1', ERP_CLIENT_ID: 'client', ERP_CLIENT_SECRET: 'private-secret', ERP_DRAFT_API_CONFIRMED: 'true', ERP_DRAFT_CONVERT_CONFIRMED: 'true', ERP_DIRECT_SAVE_CONFIRMED: 'true' },
    erpMappings: { get: () => ({ username: 'buyer', password: 'private-password', enabled: true }) },
    fetchImpl: async (url, options) => {
      if (String(url).includes('/auth/me')) return options.headers.Authorization === 'Bearer expired'
        ? Response.json({}, { status: 401 }) : Response.json({ user: { id: 'buyer', username: 'buyer' } });
      assert.ok(String(url).startsWith('http://8.148.144.131/prod-api/admin-api/'));
      return handler(String(url), options);
    }
  });
  const address = await service.listen(0, '127.0.0.1'); t.after(() => service.close());
  return async (route = '/taobao/product-crawler/get?id=1073221934071', options = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${route}`, { headers: { Authorization: 'Bearer buyer', 'Content-Type': 'application/json' }, ...options });
    return { status: response.status, body: await response.json() };
  };
}

for (const kind of ['numeric', 'string', 'http']) test(`ERP ${kind} 401 只读查询刷新一次，保留 TDL 登录`, async t => {
  const grants = [], tokens = [];
  const api = await fixture(t, async (url, options) => {
    if (url.endsWith('/token')) { grants.push(new URLSearchParams(options.body).get('grant_type')); return formGrant(grants.length === 1 ? 'stale' : 'fresh'); }
    tokens.push(options.headers.Authorization);
    if (options.headers.Authorization === 'Bearer stale') return kind === 'http' ? new Response('not JSON', { status: 401 }) : Response.json({ code: kind === 'string' ? '401' : 401, msg: 'private upstream message' });
    return ok({ externalId: '1073221934071' });
  });
  const result = await api(); assert.equal(result.status, 200); assert.equal(result.body.code, 0);
  assert.deepEqual(grants, ['password', 'refresh_token']); assert.deepEqual(tokens, ['Bearer stale', 'Bearer fresh']);
  assert.equal((await api()).body.code, 0); assert.equal(grants.length, 2, '新令牌缓存可复用');
});

test('refresh 已失效时正常授权回退一次，连续业务 401 不循环且不泄露消息', async t => {
  const grants = []; let queries = 0;
  const api = await fixture(t, async (url, options) => {
    if (url.endsWith('/token')) {
      const type = new URLSearchParams(options.body).get('grant_type'); grants.push(type);
      return type === 'refresh_token' ? Response.json({ code: 400, msg: 'private-password' }) : formGrant('denied-' + grants.length);
    }
    queries++; return Response.json({ code: 401, msg: 'private-password' });
  });
  const result = await api(); assert.equal(result.status, 502); assert.equal(result.body.code, 'ERP_AUTH_EXPIRED');
  assert.equal(queries, 2); assert.deepEqual(grants, ['password', 'refresh_token', 'password']);
  assert.equal(JSON.stringify(result).includes('private-password'), false);
});

test('并发首次查询共享授权，多个过期回执及迟到回执只触发一次刷新', async t => {
  let grants = 0, expired = false, reached = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const api = await fixture(t, async (url, options) => {
    if (url.endsWith('/token')) { grants++; await Promise.resolve(); return formGrant(grants === 1 ? 'stale' : 'fresh'); }
    if (expired && options.headers.Authorization === 'Bearer stale') { reached++; if (reached === 3) release(); await barrier; return Response.json({ code: 401 }); }
    return ok([]);
  });
  assert.ok((await Promise.all([api(), api(), api()])).every(r => r.body.code === 0)); assert.equal(grants, 1);
  expired = true; assert.ok((await Promise.all([api(), api(), api()])).every(r => r.body.code === 0));
  assert.equal(grants, 2); assert.equal(reached, 3);
});

test('POST 查询可原样重读；新增、上传、转换、删除遇 401 不自动重发', async t => {
  let grants = 0; const calls = [];
  const api = await fixture(t, async (url, options) => {
    if (url.endsWith('/token')) { grants++; return formGrant('access-' + grants); }
    calls.push({ route: new URL(url).pathname, method: options.method, body: options.body?.toString() });
    if (url.endsWith('/erp/product-draft/page') && options.headers.Authorization === 'Bearer access-2') return ok({ list: [], total: 0 });
    return Response.json({ code: 401 });
  });
  const result = await api('/erp/product-draft/page', { method: 'POST', body: '{"pageNo":1,"pageSize":25}' });
  assert.equal(result.status, 200); assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
  for (const [route, method] of [['/erp/product-addition/add', 'POST'], ['/taobao/product-crawler/taobao_product_crawler_add', 'POST'], ['/erp/product-draft/add', 'POST'], ['/infra/file/upload', 'POST'], ['/erp/product-draft/convert?id=1&revision=1', 'POST'], ['/erp/product-draft/delete?id=1', 'DELETE']]) {
    const before = calls.length, response = await api(route, { method, body: '{}' });
    assert.equal(response.status, 502); assert.equal(response.body.code, 'ERP_AUTH_EXPIRED'); assert.equal(calls.length, before + 1);
  }
});

test('账号连接检查也自动恢复 ERP 401；TDL 401 不触发 ERP 授权', async t => {
  let grants = 0, requests = 0;
  const api = await fixture(t, async (url, options) => {
    if (url.endsWith('/token')) { grants++; return formGrant('access-' + grants); }
    requests++;
    return options.headers.Authorization === 'Bearer access-1' ? Response.json({ code: 401 }) : ok([]);
  });
  const denied = await api(undefined, { headers: { Authorization: 'Bearer expired' } }); assert.equal(denied.status, 401); assert.equal(grants, 0);
  const result = await api('/erp-config/test', { method: 'POST' }); assert.equal(result.status, 200); assert.equal(result.body.ok, true);
  assert.equal(grants, 2); assert.equal(requests, 4);
});
