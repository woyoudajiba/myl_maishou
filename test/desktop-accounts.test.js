const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Accounts, profileId, encryptedStorage } = require('../desktop/accounts');
const { Models, normalizeEndpoint, invokeModel, invokeJson } = require('../desktop/models');
const { createDesktopBridge } = require('../desktop/bridge-server');
const key = crypto.randomBytes(32);
const storage = {
  encrypt(text) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64'); },
  decrypt(text) { const data = Buffer.from(text, 'base64'), cipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'); }
};
async function temporary(t) { const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'product-accounts-')); t.after(() => fs.rm(folder, { recursive: true, force: true })); return folder; }
const user = { id: 'account-a', username: 'qa', displayName: '测试账号', passwordHash: 'never-expose' };
const session = { token: 'test-cloud-session', expiresAt: new Date(Date.now() + 3600000).toISOString(), user };
const baseModel = { name: '其他视觉模型', model: 'provider-vision-2026', endpoint: 'https://vision.example/v1', apiKey: 'test-provider-secret' };

test('TDL 登录只持久化加密会话，不保存密码，不向 UI 返回令牌；重启校验真实账号 ID', async t => {
  const dataDir = await temporary(t); const requests = [];
  const transport = async (url, options) => { requests.push({ url, options }); return Response.json(url.endsWith('/login') ? session : { user }); };
  const accounts = new Accounts({ dataDir, storage, transport });
  assert.deepEqual(await accounts.login({ username: 'qa', password: 'fixture-password' }), { id: 'account-a', username: 'qa', displayName: '测试账号', isAdmin: false });
  const disk = await fs.readFile(accounts.file, 'utf8');
  for (const value of ['test-cloud-session', 'fixture-password', 'never-expose']) assert.equal(disk.includes(value), false);
  const restored = new Accounts({ dataDir, storage, transport }); assert.equal((await restored.restore()).id, 'account-a');
  assert.match(requests.at(-1).url, /^https:\/\/wsfile.cn\/myladmin\/api\/auth\/me$/);
  assert.equal(requests.at(-1).options.redirect, 'error');
  assert.equal(requests.at(-1).options.headers.Authorization, 'Bearer test-cloud-session');
  await restored.logout(); assert.equal(restored.authenticated(), false); await assert.rejects(fs.access(restored.file));
});
test('被撤销或身份变化的 TDL 会话不能恢复，登录错误不泄露服务端原文', async t => {
  const dataDir = await temporary(t); const accounts = new Accounts({ dataDir, storage, transport: async () => Response.json(session) });
  await accounts.login({ username: 'qa', password: 'fixture' });
  const restored = new Accounts({ dataDir, storage, transport: async () => Response.json({ user: { ...user, id: 'account-b' } }) });
  assert.equal(await restored.restore(), null); await assert.rejects(fs.access(restored.file));
  const rejected = new Accounts({ dataDir, storage, transport: async () => new Response('sensitive-diagnostic', { status: 401 }) });
  await assert.rejects(rejected.login({ username: 'qa', password: 'bad' }), /账号或密码不正确/);
  assert.equal(rejected.authenticated(), false);
});
test('不记住登录会移除之前持久会话，系统安全存储不可用时不降级明文', async t => {
  const dataDir = await temporary(t); const accounts = new Accounts({ dataDir, storage, transport: async () => Response.json(session) });
  await accounts.login({ username: 'qa', password: 'fixture' });
  await accounts.login({ username: 'qa', password: 'fixture', remember: false }); await assert.rejects(fs.access(accounts.file));
  assert.throws(() => encryptedStorage({ isEncryptionAvailable: () => false }).encrypt('secret'), /安全存储不可用/);
});
test('自定义模型添加编辑切换删除、加密重载和账号目录隔离', async t => {
  const dataDir = await temporary(t); const dirA = path.join(dataDir, profileId(user)); const dirB = path.join(dataDir, profileId({ id: 'account-b' }));
  assert.notEqual(dirA, dirB);
  const models = new Models({ dataDir: dirA, storage }); await models.load();
  let list = await models.save(baseModel); const idA = list.activeId;
  assert.equal(JSON.stringify(list).includes('test-provider-secret'), false); assert.equal(JSON.stringify(list).includes('encryptedKey'), false);
  assert.equal((await fs.readFile(models.file, 'utf8')).includes('test-provider-secret'), false);
  list = await models.save({ ...baseModel, name: '第二个服务', endpoint: 'https://second.example/v1', apiKey: 'second-secret' }); const idB = list.models[1].id;
  await models.select(idB); await models.save({ ...baseModel, id: idA, name: '改名', apiKey: '' });
  assert.equal(models.config(idA).apiKey, 'test-provider-secret');
  await assert.rejects(models.save({ ...baseModel, id: idA, endpoint: 'https://attacker.example/v1', apiKey: '' }), /重新填写/);
  const restored = new Models({ dataDir: dirA, storage }); await restored.load(); assert.equal(restored.config().apiKey, 'second-secret');
  await restored.remove(idB); assert.equal(restored.list().activeId, idA); await restored.remove(idA); assert.equal(restored.config(), null);
  const other = new Models({ dataDir: dirB, storage }); assert.deepEqual(await other.load(), { activeId: '', models: [] });
});
test('模型地址拒绝凭据、查询和非加密远端，兼容本机服务并阻止重定向泄露 Key', async () => {
  assert.equal(normalizeEndpoint('https://vision.example/v1/'), 'https://vision.example/v1/chat/completions');
  assert.equal(normalizeEndpoint('http://127.0.0.1:11434/v1/chat/completions'), 'http://127.0.0.1:11434/v1/chat/completions');
  for (const url of ['http://vision.example/v1', 'https://user:pass@vision.example/v1', 'https://vision.example/v1?key=x', 'https://vision.example/v1#secret']) assert.throws(() => normalizeEndpoint(url));
  const image = 'data:image/png;base64,aGVsbG8=';
  const result = await invokeModel({ ...baseModel, endpoint: normalizeEndpoint(baseModel.endpoint) }, { query: image, candidates: [{ id: 'candidate_1', dataUrl: image }] }, { transport: async (url, options) => {
    assert.equal(url, 'https://vision.example/v1/chat/completions'); assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body); assert.equal(body.model, baseModel.model); assert.equal('enable_thinking' in body, false); assert.equal('response_format' in body, false);
    assert.equal(body.messages[1].content.filter(part => part.type === 'image_url').length, 2);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ results: [{ id: 'candidate_1', verdict: 'likely_same', score: 92, matches: ['领口一致', '口袋一致'], differences: [], uncertainties: [] }] }) } }] });
  } });
  assert.equal(result.judgments[0].verdict, 'likely_same');
});
test('每个新 TDL 档案默认获得不可编辑的托管模型，并通过登录令牌调用中转', async t => {
  const dataDir = await temporary(t);
  const models = new Models({ dataDir, storage });
  await models.load();
  await models.ensureManagedDefault();
  const config = models.config();
  assert.equal(config.managed, true);
  assert.equal(config.model, 'gpt-6.1-sol');
  assert.equal(config.endpoint, 'https://wsfile.cn/maishou/api/v1/chat/completions');
  assert.equal(config.apiKey, '');
  assert.equal(models.list().models[0].hasKey, false);
  await assert.rejects(models.save({ ...config, apiKey: 'attempt-to-edit' }), /不能编辑/);
  await assert.rejects(models.remove(config.id), /不能删除/);

  const image = 'data:image/png;base64,aGVsbG8=';
  const result = await invokeModel({ ...config, authToken: 'tdl-session-token' }, { query: image, candidates: [{ id: 'candidate_1', dataUrl: image }] }, { transport: async (url, options) => {
    assert.equal(url, config.endpoint);
    assert.equal(options.headers.Authorization, 'Bearer tdl-session-token');
    const body = JSON.parse(options.body);
    assert.equal(body.reasoning_effort, 'medium');
    assert.equal(body.temperature, undefined);
    assert.equal(body.max_completion_tokens, 4096);
    assert.equal(body.response_format.type, 'json_object');
    return Response.json({ model: 'gpt-6.1-sol', choices: [{ message: { content: JSON.stringify({ results: [{ id: 'candidate_1', verdict: 'likely_same', score: 90, matches: ['领口一致', '袖口一致'], differences: [], uncertainties: [] }] }) } }] });
  } });
  assert.equal(result.judgments[0].score, 90);

  await invokeJson({ ...config, authToken: 'tdl-session-token' }, { instruction: '提取事实', data: { title: '样品' }, images: [image] }, { transport: async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer tdl-session-token');
    const body = JSON.parse(options.body);
    assert.equal(body.reasoning_effort, 'medium');
    assert.equal(body.temperature, undefined);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"articleNo":"A1"}' } }] });
  } });
});
test('退出账号后本地桥拒绝读取历史任务，关闭桥等待在途任务写入完成', async t => {
  const dataDir = await temporary(t); let access = true;
  const bridge = createDesktopBridge({ dataDir, port: 0, canAccess: () => access, processJob: async () => {} });
  await bridge.start(); t.after(() => bridge.close());
  const url = `http://127.0.0.1:${bridge.snapshot().port}/v1/jobs`, headers = { 'X-Desktop-Token': bridge.token };
  assert.equal((await fetch(url, { headers })).status, 200); access = false;
  assert.equal((await fetch(url, { headers })).status, 401);
});
