'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer, UsageStore, ErpMappingStore, normalizeCompletionBody } = require('../server');

test('the managed gateway fixes the model and reasoning settings and bounds output', () => {
  const normalized = normalizeCompletionBody({
    model: 'attacker-selected-model', stream: false, temperature: 0, enable_thinking: false,
    max_tokens: 90000, messages: [{ role: 'user', content: 'hello' }]
  });
  assert.equal(normalized.model, 'gpt-6.1-sol');
  assert.equal(normalized.reasoning_effort, 'medium');
  assert.equal(normalized.max_completion_tokens, 8192);
  assert.equal('max_tokens' in normalized, false);
  assert.equal('temperature' in normalized, false);
  assert.equal('enable_thinking' in normalized, false);
  assert.throws(() => normalizeCompletionBody({ stream: true, messages: [{ role: 'user', content: 'x' }] }), /streaming_not_supported/);
});

test('ERP user mappings persist encrypted at rest and never expose passwords in admin lists', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maishou-erp-map-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'erp-mappings.json'), key = Buffer.alloc(32, 9).toString('hex');
  const store = new ErpMappingStore(file, key); await store.load(); await store.rememberUser({ id: 'tdl-user-1', username: 'buyer-one', displayName: '买手一' });
  await store.set('tdl-user-1', { username: 'erp-one', password: 'unique-erp-password', company: '厦门', buyerName: '采购员一' });
  const raw = await fs.readFile(file, 'utf8'); assert.equal(raw.includes('unique-erp-password'), false); assert.equal(raw.includes('erp-one'), false);
  assert.equal(store.list()[0].hasPassword, true); assert.equal(Object.hasOwn(store.list()[0], 'password'), false); assert.equal(store.listUsers()[0].mapped, true);
  const restored = new ErpMappingStore(file, key); await restored.load(); assert.equal(restored.get('tdl-user-1').password, 'unique-erp-password');
  const wrongKey = new ErpMappingStore(file, Buffer.alloc(32, 8).toString('hex')); await assert.rejects(wrongKey.load());
});

test('TDL identities are isolated and administrators can query account totals', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maishou-usage-'));
  const store = new UsageStore(path.join(dir, 'usage.json'));
  await store.load();
  const upstreamCalls = [];
  const service = createServer({
    usageStore: store,
    env: { VIAAPI_API_KEY: 'server-only-test-key', PORT: '0' },
    fetchImpl: async (url, options) => {
      if (String(url).includes('/auth/me')) {
        const token = options.headers.Authorization;
        if (token === 'Bearer expired') return new Response('{}', { status: 401 });
        const admin = token === 'Bearer admin-token';
        const other = token === 'Bearer other-token';
        return Response.json({ user: { id: admin ? 'admin-id' : other ? 'other-id' : 'buyer-id', username: admin ? 'manager' : other ? 'other' : 'buyer', displayName: admin ? '管理账号' : other ? '另一采购账号' : '采购账号', isAdmin: admin } });
      }
      upstreamCalls.push({ url: String(url), options });
      if (options.body.includes('fail-upstream')) return Response.json({ error: { message: 'private upstream details' } }, { status: 502 });
      return Response.json({ model: 'gpt-6.1-sol', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } });
    }
  });
  t.after(async () => { await service.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const address = await service.listen(0, '127.0.0.1');
  const root = `http://127.0.0.1:${address.port}`;
  const request = (token, value) => fetch(`${root}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const modelResponse = await request('buyer-token', { model: 'anything', temperature: 0, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(modelResponse.status, 200);
  assert.deepEqual(await modelResponse.json().then(data => data.usage), { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 });
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].options.headers.Authorization, 'Bearer server-only-test-key');
  const upstreamBody = JSON.parse(upstreamCalls[0].options.body);
  assert.equal(upstreamBody.model, 'gpt-6.1-sol');
  assert.equal(upstreamBody.reasoning_effort, 'medium');
  assert.equal(upstreamBody.max_completion_tokens, 100);
  assert.equal('temperature' in upstreamBody, false);
  assert.equal('max_tokens' in upstreamBody, false);
  assert.notEqual('Bearer buyer-token', upstreamCalls[0].options.headers.Authorization);

  const own = await fetch(`${root}/usage?days=30`, { headers: { Authorization: 'Bearer buyer-token' } }).then(response => response.json());
  assert.equal(own.scope, 'self');
  assert.equal(own.totals.requests, 1);
  assert.equal(own.totals.totalTokens, 19);
  const failed = await request('buyer-token', { messages: [{ role: 'user', content: 'fail-upstream' }] });
  assert.equal(failed.status, 502);
  const other = await request('other-token', { messages: [{ role: 'user', content: 'other account' }] });
  assert.equal(other.status, 200);
  const buyerAfter = await fetch(`${root}/usage?days=30`, { headers: { Authorization: 'Bearer buyer-token' } }).then(response => response.json());
  assert.equal(buyerAfter.totals.requests, 2);
  assert.equal(buyerAfter.totals.succeeded, 1);
  assert.equal(buyerAfter.totals.failed, 1);
  assert.equal(JSON.stringify(buyerAfter).includes('private upstream details'), false);
  const forbidden = await fetch(`${root}/usage?accountId=admin-id`, { headers: { Authorization: 'Bearer buyer-token' } });
  assert.equal(forbidden.status, 403);
  const admin = await fetch(`${root}/usage?days=30`, { headers: { Authorization: 'Bearer admin-token' } }).then(response => response.json());
  assert.equal(admin.scope, 'all');
  assert.equal(admin.accounts.length, 2);
  assert.equal(admin.totals.requests, 3);
  assert.equal(admin.accounts[0].username, 'buyer');
  const selected = await fetch(`${root}/usage?days=30&accountId=buyer-id`, { headers: { Authorization: 'Bearer admin-token' } }).then(response => response.json());
  assert.equal(selected.selectedAccountId, 'buyer-id');
  assert.equal(selected.scope, 'all');
  assert.equal(selected.totals.requests, 2);
  const expired = await fetch(`${root}/usage`, { headers: { Authorization: 'Bearer expired' } });
  assert.equal(expired.status, 401);
});

test('TDL users receive only their mapped ERP connection and ERP calls are proxied with server credentials', async t => {
  const mappings = new Map([['buyer-id', { accountId: 'buyer-id', username: 'erp-buyer', password: 'erp-password', company: '厦门', buyerName: '采购账号', enabled: true }]]);
  const erpMappings = {
    get: id => mappings.get(id) || null,
    list: () => [...mappings.values()].map(row => ({ accountId: row.accountId, username: row.username, company: row.company, buyerName: row.buyerName, enabled: row.enabled, hasPassword: true })),
    listUsers: () => [{ id: 'buyer-id', username: 'buyer', displayName: '采购账号', mapped: true }],
    rememberUser: async () => {},
    set: async (id, value) => { const row = { accountId: id, username: value.username, password: value.password, company: value.company, buyerName: value.buyerName, enabled: true }; mappings.set(id, row); return row; },
    remove: async id => mappings.delete(id)
  };
  const calls = [];
  const service = createServer({
    erpMappings,
    env: { VIAAPI_API_KEY: 'server-only', ERP_TENANT_ID: '1', ERP_CLIENT_ID: 'erp-client', ERP_CLIENT_SECRET: 'erp-secret', ERP_DRAFT_API_CONFIRMED: 'false', ERP_DRAFT_CONVERT_CONFIRMED: 'false', PORT: '0' },
    fetchImpl: async (url, options = {}) => {
      const target = String(url); calls.push({ url: target, options });
      if (target.includes('/auth/me')) { const admin=options.headers?.Authorization==='Bearer admin-token'; return Response.json({ user: { id: admin?'admin-id':'buyer-id', username: admin?'manager':'buyer', displayName: admin?'管理账号':'采购账号', isAdmin: admin } }); }
      if (target.endsWith('/system/oauth2/token')) return Response.json({ code: 0, data: { access_token: 'erp-access', refresh_token: 'erp-refresh', expires_in: 3600 } });
      if (target.endsWith('/erp/category/list')) return Response.json({ code: 0, data: [{ categoryName: '衬衫', status: 1 }] });
      if (target.endsWith('/erp/product-draft/add')) return Response.json({ code: 0, data: 'draft-1' });
      throw new Error(`unexpected ${target}`);
    }
  });
  t.after(async () => service.close());
  const address = await service.listen(0, '127.0.0.1'), root = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: 'Bearer tdl-token' };
  const me = await fetch(`${root}/erp-config/me`, { headers });
  assert.equal(me.status, 200); const meBody = await me.json(); assert.equal(meBody.config.username, 'erp-buyer'); assert.equal('password' in meBody.config, false); assert.equal('clientSecret' in meBody.config, false);
  const forbiddenAdminList=await fetch(`${root}/erp-config/accounts`,{headers});assert.equal(forbiddenAdminList.status,403);
  const adminHeaders={Authorization:'Bearer admin-token'};
  const adminList=await fetch(`${root}/erp-config/accounts`,{headers:adminHeaders});assert.equal(adminList.status,200);const listed=await adminList.json();assert.equal(listed.users[0].mapped,true);assert.equal('password' in listed.accounts[0],false);
  const adminSettings=await fetch(`${root}/erp-config/settings`,{headers:adminHeaders});assert.equal(adminSettings.status,200);assert.equal((await adminSettings.json()).serviceReady,true);
  const forbiddenSettings=await fetch(`${root}/erp-config/settings`,{headers});assert.equal(forbiddenSettings.status,403);
  const category = await fetch(`${root}/erp/category/list`, { headers }); assert.equal(category.status, 200); assert.deepEqual(await category.json(), { code: 0, data: [{ categoryName: '衬衫', status: 1 }] });
  const tokenCall = calls.find(call => call.url.endsWith('/system/oauth2/token')); assert.equal(tokenCall.options.headers.Authorization, `Basic ${Buffer.from('erp-client:erp-secret').toString('base64')}`); assert.match(tokenCall.options.body, /username=erp-buyer/); assert.match(tokenCall.options.body, /password=erp-password/);
  const erpCall = calls.find(call => call.url.endsWith('/erp/category/list')); assert.equal(erpCall.options.headers.Authorization, 'Bearer erp-access'); assert.equal(erpCall.options.headers['tenant-id'], '1');
  const disabledWrite=await fetch(`${root}/erp/product-draft/add`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'});assert.equal(disabledWrite.status,403);
  const enabledServer=createServer({erpMappings,env:{ERP_TENANT_ID:'1',ERP_CLIENT_ID:'erp-client',ERP_CLIENT_SECRET:'erp-secret',ERP_DRAFT_API_CONFIRMED:'true',PORT:'0'},fetchImpl:async(url,options={})=>{if(String(url).includes('/auth/me'))return Response.json({user:{id:'buyer-id',username:'buyer',displayName:'采购账号'}});if(String(url).endsWith('/system/oauth2/token'))return Response.json({code:0,data:{access_token:'access-2',refresh_token:'refresh-2',expires_in:3600}});if(String(url).endsWith('/erp/product-draft/add'))return Response.json({code:0,data:'draft-1'});throw new Error(String(url));}});t.after(async()=>enabledServer.close());const enabledAddress=await enabledServer.listen(0,'127.0.0.1');const allowedWrite=await fetch(`http://127.0.0.1:${enabledAddress.port}/erp/product-draft/add`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'});assert.equal(allowedWrite.status,200);
});

test('ERP mapping storage uses authenticated AES-GCM and rejects a wrong server key',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'maishou-erp-map-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'erp-mappings.json'),key=Buffer.alloc(32,9).toString('hex');
  const store=new ErpMappingStore(file,key);await store.load();await store.rememberUser({id:'tdl-user-1',username:'buyer-one',displayName:'买手一'});await store.set('tdl-user-1',{username:'erp-one',password:'unique-erp-password',company:'厦门',buyerName:'采购员一'});
  await store.setSettings({erpBaseUrl:'https://erp.example.test/api',erpTenantId:'1',erpClientId:'client',erpClientSecret:'oauth-secret'});const raw=await fs.readFile(file,'utf8');assert.equal(raw.includes('unique-erp-password'),false);assert.equal(raw.includes('erp-one'),false);assert.equal(raw.includes('oauth-secret'),false);assert.equal(store.list()[0].hasPassword,true);assert.equal('password' in store.list()[0],false);
  const restored=new ErpMappingStore(file,key);await restored.load();assert.equal(restored.get('tdl-user-1').password,'unique-erp-password');assert.equal(restored.getSettings().erpClientSecret,'oauth-secret');const wrong=new ErpMappingStore(file,Buffer.alloc(32,8).toString('hex'));await assert.rejects(wrong.load());
});
