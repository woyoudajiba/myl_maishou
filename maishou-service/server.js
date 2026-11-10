'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_TDL_AUTH_URL = 'https://wsfile.cn/myladmin/api/auth/me';
const DEFAULT_UPSTREAM_URL = 'https://api.viaapi.cn/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-6.1-sol';
const MAX_BODY_BYTES = 15 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_USAGE_DAYS = 120;
const MAX_ERP_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_ERP_PROXY_BASE = 'https://wsfile.cn/maishou/api';
const allowedErpRoutes = [
  ['GET', /^\/system\/auth\/get-permission-info$/], ['GET', /^\/system\/dict-data\/list-all-simple$/],
  ['GET', /^\/system\/tenant\/get-id-by-name$/], ['GET', /^\/erp\/category\/list$/], ['GET', /^\/erp\/category\/info$/],
  ['GET', /^\/erp\/attributes-extend\/extend-category$/], ['GET', /^\/erp\/supplier-infos\/sample-list$/], ['GET', /^\/erp\/colors\/query$/],
  ['GET', /^\/taobao\/product-crawler\/get$/], ['GET', /^\/taobao\/product-crawler\/get-original-images$/],
  ['POST', /^\/taobao\/product-crawler\/taobao_product_crawler_add$/], ['POST', /^\/infra\/file\/upload$/],
  ['GET', /^\/erp\/product-draft\/get$/], ['GET', /^\/erp\/product-draft\/attributes$/], ['GET', /^\/erp\/product-draft\/public-pic$/],
  ['POST', /^\/erp\/product-draft\/page$/], ['POST', /^\/erp\/product-draft\/add$/], ['POST', /^\/erp\/product-draft\/convert$/],
  ['GET', /^\/erp\/pool-product\/getProductInfosDetailById$/], ['POST', /^\/erp\/pool-product\/page$/]
];

function json(response, status, value, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    ...headers
  });
  response.end(JSON.stringify(value));
}

function parseBearer(request) {
  const raw = String(request.headers.authorization || '');
  const match = raw.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] || '';
}

function parseEncryptionKey(value) {
  const raw = String(value || '').trim();
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length === 32) return decoded;
  throw new Error('ERP_MAPPING_KEY 必须是 32 字节 hex 或 base64 密钥');
}

function safeMapping(value = {}) {
  return {
    accountId: String(value.accountId || '').slice(0, 160),
    tdlUsername: String(value.tdlUsername || '').slice(0, 120),
    displayName: String(value.displayName || '').slice(0, 120),
    username: String(value.username || '').slice(0, 160),
    enabled: value.enabled !== false,
    updatedAt: String(value.updatedAt || '')
  };
}

class ErpMappingStore {
  constructor(file, key) { this.file = file; this.key = parseEncryptionKey(key); this.rows = new Map(); this.users = new Map(); this.settings = {}; this.queue = Promise.resolve(); }
  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const iv = Buffer.from(saved.iv || '', 'base64'), tag = Buffer.from(saved.tag || '', 'base64'), ciphertext = Buffer.from(saved.data || '', 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv); decipher.setAuthTag(tag);
      const decoded = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
      if (Array.isArray(decoded.rows)) for (const row of decoded.rows) if (row?.accountId && row?.username && row?.password) this.rows.set(String(row.accountId), { ...safeMapping(row), password: String(row.password).slice(0, 512) });
      if (Array.isArray(decoded.users)) for (const user of decoded.users) if (user?.id) this.users.set(String(user.id), { id: String(user.id), username: String(user.username || '').slice(0, 120), displayName: String(user.displayName || '').slice(0, 120), lastSeenAt: String(user.lastSeenAt || '') });
      if (decoded.settings && typeof decoded.settings === 'object' && !Array.isArray(decoded.settings)) this.settings = { ...decoded.settings };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async save() {
    const operation = this.queue.catch(() => {}).then(async () => {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
      const payload = JSON.stringify({ rows: [...this.rows.values()], users: [...this.users.values()], settings: this.settings });
      const data = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
      const envelope = { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`; await fs.writeFile(temporary, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 }); await fs.rename(temporary, this.file);
    }); this.queue = operation; return operation;
  }
  get(accountId) { const row = this.rows.get(String(accountId)); return row ? { ...row } : null; }
  list() { return [...this.rows.values()].map(row => ({ ...safeMapping(row), hasPassword: !!row.password })); }
  listUsers() { return [...this.users.values()].map(user => ({ ...user, mapped: this.rows.has(user.id) })); }
  getSettings() { return { ...this.settings }; }
  async setSettings(settings) { const previous=this.settings;this.settings = { ...settings };try{await this.save();}catch(error){this.settings=previous;throw error;} return { ...this.settings }; }
  async rememberUser(user) {
    const previous = this.users.get(String(user.id));
    this.users.set(String(user.id), { id: String(user.id), username: String(user.username || previous?.username || '').slice(0, 120), displayName: String(user.displayName || previous?.displayName || '').slice(0, 120), lastSeenAt: new Date().toISOString() });
    if (!previous || previous.username !== user.username || previous.displayName !== user.displayName) await this.save();
  }
  async set(accountId, value) {
    const id = String(accountId || '').trim(); const known = this.users.get(id); const username = String(value.username || '').trim(); const password = String(value.password || this.rows.get(id)?.password || '');
    if (!known) throw Object.assign(new Error('请先让该 TDL 用户登录一次，刷新后再登记互拓账号'), { status: 404 });
    if (!username || username.length > 160 || !password || password.length > 512 || /[\r\n]/.test(username+password)) throw Object.assign(new Error('请填写有效的互拓账号和密码'), { status: 400 });
    if (this.rows.has(id) && username!==this.rows.get(id).username && !value.password) throw Object.assign(new Error('更换互拓账号时请填写对应密码'), { status: 400 });
    const previous=this.rows.get(id);this.rows.set(id, { accountId: id, tdlUsername: known.username, displayName: known.displayName, username, password, enabled: value.enabled !== false, updatedAt: new Date().toISOString() });
    try{await this.save();}catch(error){if(previous)this.rows.set(id,previous);else this.rows.delete(id);throw error;}return safeMapping(this.rows.get(id));
  }
  async remove(accountId) { const id=String(accountId),previous=this.rows.get(id);this.rows.delete(id);try{await this.save();}catch(error){if(previous)this.rows.set(id,previous);throw error;} }
}
class EmptyErpMappingStore {
  async load() {}
  async rememberUser() {}
  get() { return null; }
  list() { return []; }
  listUsers() { return []; }
  getSettings() { return {}; }
  async setSettings() { throw Object.assign(new Error('ERP 映射服务未配置'), { status: 503 }); }
  async set() { throw Object.assign(new Error('ERP 映射服务未配置'), { status: 503 }); }
  async remove() {}
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('request_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value;
  } catch {
    throw Object.assign(new Error('invalid_json'), { status: 400 });
  }
}

function parseUsage(payload) {
  const usage = payload?.usage || {};
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? (inputTokens + outputTokens));
  return {
    inputTokens: Number.isFinite(inputTokens) && inputTokens > 0 ? Math.floor(inputTokens) : 0,
    outputTokens: Number.isFinite(outputTokens) && outputTokens > 0 ? Math.floor(outputTokens) : 0,
    totalTokens: Number.isFinite(totalTokens) && totalTokens > 0 ? Math.floor(totalTokens) : 0
  };
}

function normalizeCompletionBody(input) {
  if (input.stream === true) throw Object.assign(new Error('streaming_not_supported'), { status: 400 });
  if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 30) {
    throw Object.assign(new Error('invalid_messages'), { status: 400 });
  }
  if (input.tools || input.tool_choice || input.parallel_tool_calls) {
    throw Object.assign(new Error('tools_not_supported'), { status: 400 });
  }
  const body = { ...input, model: DEFAULT_MODEL, reasoning_effort: 'medium', stream: false };
  delete body.enable_thinking;
  delete body.temperature;
  delete body.top_p;
  delete body.presence_penalty;
  delete body.frequency_penalty;
  if (body.max_tokens !== undefined && body.max_completion_tokens === undefined) body.max_completion_tokens = body.max_tokens;
  delete body.max_tokens;
  // Keep each completion bounded to reduce accidental runaway charges.
  if (body.max_completion_tokens !== undefined) {
    const requested = Number(body.max_completion_tokens);
    if (!Number.isFinite(requested) || requested < 1) throw Object.assign(new Error('invalid_token_limit'), { status: 400 });
    body.max_completion_tokens = Math.min(Math.floor(requested), 8192);
  }
  return body;
}

function dayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function emptyCounters() {
  return { requests: 0, succeeded: 0, failed: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 0, lastUsedAt: '' };
}

class UsageStore {
  constructor(file) { this.file = file; this.state = { rows: [] }; this.queue = Promise.resolve(); }
  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (Array.isArray(saved.rows)) this.state.rows = saved.rows.filter(row => row && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.accountId && row.counters);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async record(user, { success, usage = emptyCounters(), latencyMs = 0, at = new Date() }) {
    const operation = this.queue.catch(() => {}).then(async () => {
      const date = dayKey(at);
      const existing = this.state.rows.find(row => row.date === date && row.accountId === user.id);
      const row = existing || { date, accountId: user.id, username: user.username, displayName: user.displayName, counters: emptyCounters() };
      row.username = user.username || row.username || '';
      row.displayName = user.displayName || row.displayName || row.username || 'TDL 用户';
      row.counters.requests++;
      row.counters[success ? 'succeeded' : 'failed']++;
      row.counters.inputTokens += usage.inputTokens || 0;
      row.counters.outputTokens += usage.outputTokens || 0;
      row.counters.totalTokens += usage.totalTokens || 0;
      row.counters.latencyMs += Math.max(0, Math.floor(latencyMs));
      row.counters.lastUsedAt = at.toISOString();
      if (!existing) this.state.rows.push(row);
      const cutoff = new Date(at.getTime() - MAX_USAGE_DAYS * 86400000);
      const cutoffDate = dayKey(cutoff);
      this.state.rows = this.state.rows.filter(item => item.date >= cutoffDate).slice(-50000);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      await fs.writeFile(temp, JSON.stringify(this.state), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temp, this.file);
    });
    this.queue = operation;
    return operation;
  }
  query({ accountId = '', days = 30, admin = false, user }) {
    const safeDays = Math.max(1, Math.min(90, Number(days) || 30));
    const cutoff = dayKey(new Date(Date.now() - (safeDays - 1) * 86400000));
    const targetId = accountId && admin ? accountId : admin && !accountId ? '' : user.id;
    const rows = this.state.rows.filter(row => row.date >= cutoff && (admin && !accountId || row.accountId === targetId));
    const totals = rows.reduce((sum, row) => {
      for (const key of Object.keys(sum)) sum[key] += Number(row.counters[key]) || 0;
      return sum;
    }, emptyCounters());
    const dailyByDate = rows.reduce((map, row) => {
      const counters = map.get(row.date) || emptyCounters();
      for (const key of Object.keys(counters)) counters[key] += Number(row.counters[key]) || 0;
      map.set(row.date, counters);
      return map;
    }, new Map());
    const daily = [...dailyByDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, counters]) => ({ date, ...counters }));
    const accounts = admin && !accountId
      ? this.state.rows.filter(row => row.date >= cutoff).reduce((map, row) => {
        const item = map.get(row.accountId) || { id: row.accountId, username: row.username, displayName: row.displayName, counters: emptyCounters() };
        for (const key of Object.keys(item.counters)) item.counters[key] += Number(row.counters[key]) || 0;
        item.username = row.username || item.username;
        item.displayName = row.displayName || item.displayName;
        map.set(row.accountId, item);
        return map;
      }, new Map())
      : null;
    return {
      scope: admin ? 'all' : 'self',
      rangeDays: safeDays,
      selectedAccountId: targetId,
      user: { id: targetId || user.id, username: accountId ? rows.at(-1)?.username || '' : user.username, displayName: accountId ? rows.at(-1)?.displayName || '' : admin ? '全部账号' : user.displayName },
      totals,
      daily,
      ...(accounts ? { accounts: [...accounts.values()].sort((a, b) => b.counters.totalTokens - a.counters.totalTokens) } : {})
    };
  }
}

function createServer({ env = process.env, fetchImpl = (...args) => fetch(...args), usageStore, erpMappings, authCacheMs = 0, now = () => Date.now() } = {}) {
  const store = usageStore || new UsageStore(env.USAGE_FILE || path.join(__dirname, 'data', 'usage.json'));
  const mappings = erpMappings || (env.ERP_MAPPING_KEY ? new ErpMappingStore(env.ERP_MAPPING_FILE || path.join(__dirname, 'data', 'erp-mappings.json'), env.ERP_MAPPING_KEY) : new EmptyErpMappingStore());
  const secret = String(env.VIAAPI_API_KEY || '').trim();
  const authUrl = env.TDL_AUTH_URL || DEFAULT_TDL_AUTH_URL;
  const upstreamUrl = env.VIAAPI_CHAT_COMPLETIONS_URL || DEFAULT_UPSTREAM_URL;
  const envErpSettings = { erpBaseUrl: String(env.ERP_BASE_URL || '').trim(), erpTenantId: String(env.ERP_TENANT_ID || '').trim(), erpClientId: String(env.ERP_CLIENT_ID || '').trim(), erpClientSecret: String(env.ERP_CLIENT_SECRET || '').trim(), draftApiConfirmed: env.ERP_DRAFT_API_CONFIRMED === 'true', draftConvertConfirmed: env.ERP_DRAFT_CONVERT_CONFIRMED === 'true' };
  const erpSettings = () => ({ ...envErpSettings, ...(mappings.getSettings ? mappings.getSettings() : {}) });
  const allowedTestOrigin=String(env.ERP_HTTP_TEST_ORIGIN||'').trim();
  const allowedEndpoint=endpoint => !endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash&&(endpoint.protocol==='https:'||(endpoint.protocol==='http:'&&!!allowedTestOrigin&&endpoint.origin===allowedTestOrigin));
  const validErpSettings = settings => {
    try { return allowedEndpoint(new URL(settings.erpBaseUrl)) && /^\d+$/.test(settings.erpTenantId || '') && !!settings.erpClientId && !!settings.erpClientSecret; } catch { return false; }
  };
  const publicErpSettings=settings=>({erpBaseUrl:settings.erpBaseUrl||'',erpTenantId:settings.erpTenantId||'',erpClientId:settings.erpClientId||'',hasClientSecret:!!settings.erpClientSecret,httpTestOrigin:allowedTestOrigin,draftApiConfirmed:settings.draftApiConfirmed===true,draftConvertConfirmed:settings.draftConvertConfirmed===true});
  const erpTokens = new Map();
  const authCache = new Map();
  const perAccount = new Map();

  async function identify(token) {
    if (!token || token.length > 16000) throw Object.assign(new Error('unauthorized'), { status: 401 });
    const cacheKey = crypto.createHash('sha256').update(token).digest('hex');
    const cached = authCache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return cached.user;
    let response;
    try {
      response = await fetchImpl(authUrl, { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    } catch {
      throw Object.assign(new Error('tdl_unavailable'), { status: 503 });
    }
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error('unauthorized'), { status: 401 });
    if (!response.ok) throw Object.assign(new Error('tdl_unavailable'), { status: 503 });
    let payload;
    try { payload = await response.json(); } catch { throw Object.assign(new Error('tdl_invalid_response'), { status: 503 }); }
    const source = payload?.user;
    if (!source || !['string', 'number'].includes(typeof source.id) || !String(source.id)) throw Object.assign(new Error('unauthorized'), { status: 401 });
    const user = { id: String(source.id), username: String(source.username || '').slice(0, 120), displayName: String(source.displayName || source.username || 'TDL 用户').slice(0, 120), isAdmin: source.isAdmin === true || String(source.role || '').toUpperCase() === 'ADMIN' };
    if (authCacheMs > 0) authCache.set(cacheKey, { user, expiresAt: now() + authCacheMs });
    return user;
  }

  async function erpToken(user, mapping, settings) {
    const cached = erpTokens.get(user.id);
    if (cached && cached.expiresAt > now() + 5000) return cached.accessToken;
    if (!validErpSettings(settings)) throw Object.assign(new Error('服务器互拓连接暂不可用'), { status: 503 });
    let base;
    try { base = new URL(settings.erpBaseUrl); } catch { throw Object.assign(new Error('互拓服务地址无效'), { status: 503 }); }
    const requestGrant = async refresh => {
      const form = new URLSearchParams({ grant_type: refresh ? 'refresh_token' : 'password', ...(refresh ? { refresh_token: cached?.refreshToken || '' } : { username: mapping.username, password: mapping.password }) });
      let response;
      try { response = await fetchImpl(`${settings.erpBaseUrl.replace(/\/$/, '')}/system/oauth2/token`, { method: 'POST', redirect: 'error', headers: { Authorization: `Basic ${Buffer.from(`${settings.erpClientId}:${settings.erpClientSecret}`).toString('base64')}`, 'tenant-id':settings.erpTenantId, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(), signal: AbortSignal.timeout(20000) }); }
      catch { throw Object.assign(new Error('互拓授权服务暂不可用'), { status: 503 }); }
      const payload = await response.json().catch(() => null), body = payload?.data;
      if (!response.ok || payload?.code !== 0 || !body?.access_token || !body?.refresh_token) throw Object.assign(new Error('互拓账号授权失败，请联系管理员检查映射'), { status: response.status >= 400 && response.status < 500 ? 403 : 503 });
      return { accessToken: String(body.access_token), refreshToken: String(body.refresh_token), expiresAt: now() + Number(body.expires_in || 3600) * 1000 };
    };
    let result;
    if (cached?.refreshToken) { try { result = await requestGrant(true); } catch { result = await requestGrant(false); } }
    else result = await requestGrant(false);
    erpTokens.set(user.id, result); return result.accessToken;
  }

  async function readRaw(request, maxBytes = MAX_ERP_BODY_BYTES) {
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > maxBytes) throw Object.assign(new Error('ERP 请求体超过大小限制'), { status: 413 }); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async function testErpAccount(user,mapping){
    if(!mapping?.enabled)throw Object.assign(new Error('请先保存互拓账号和密码'),{status:400});
    const settings=erpSettings(),access=await erpToken(user,mapping,settings),summary={};
    for(const [label,route] of [['permissions','/system/auth/get-permission-info'],['dictionaries','/system/dict-data/list-all-simple'],['categories','/erp/category/list']]){
      let upstream;try{upstream=await fetchImpl(settings.erpBaseUrl.replace(/\/$/,'')+route,{headers:{Authorization:`Bearer ${access}`,'tenant-id':settings.erpTenantId},redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw Object.assign(new Error('互拓连接检查超时，请稍后重试'),{status:503});}
      const body=await upstream.json().catch(()=>null);
      if(!upstream.ok||body?.code!==0)throw Object.assign(new Error('互拓登录或读取权限检查未通过'),{status:502});
      summary[label]=Array.isArray(body.data)?body.data.length:true;
    }
    return {ok:true,...summary};
  }

  async function proxyErp(request, response, user) {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (!allowedErpRoutes.some(([method, pattern]) => method === request.method && pattern.test(pathname))) return json(response, 404, { error: '互拓接口不在允许范围内。' });
    const settings = erpSettings();
    if (pathname === '/erp/product-draft/add' && settings.draftApiConfirmed !== true) return json(response, 403, { error: '互拓草稿写入未由管理员启用。' });
    if (pathname === '/erp/product-draft/convert' && settings.draftConvertConfirmed !== true) return json(response, 403, { error: '互拓待审核转换未由管理员启用。' });
    const mapping = mappings.get(user.id);
    if (!mapping || !mapping.enabled) return json(response, 403, { error: '当前 TDL 账号尚未配置互拓账号，请联系管理员。' });
    const token = await erpToken(user, mapping, settings);
    const url = new URL(request.url, 'http://localhost');
    const target = `${settings.erpBaseUrl.replace(/\/$/, '')}${url.pathname}${url.search}`;
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await readRaw(request);
    const headers = { Accept: 'application/json', Authorization: `Bearer ${token}`, 'tenant-id': settings.erpTenantId };
    for (const name of ['content-type', 'idempotency-key']) if (request.headers[name]) headers[name] = request.headers[name];
    let upstream;
    try { upstream = await fetchImpl(target, { method: request.method, redirect: 'error', headers, body, signal: AbortSignal.timeout(30000) }); }
    catch { return json(response, 503, { error: '互拓服务请求超时，请稍后重试。' }); }
    if (upstream.status === 401) { erpTokens.delete(user.id); return json(response, 401, { error: '互拓授权已失效，请联系管理员更新配置。' }); }
    const raw = await upstream.arrayBuffer();
    if (raw.byteLength > MAX_ERP_BODY_BYTES) return json(response, 502, { error: '互拓响应超过允许大小。' });
    response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(Buffer.from(raw));
  }

  async function route(request, response) {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && pathname === '/healthz') return json(response, 200, { status: 'ok' });
    const token = parseBearer(request);
    let user;
    try { user = await identify(token); }
    catch (error) { return json(response, error.status || 503, { error: error.status === 401 ? '请使用有效的 TDL 账号登录。' : 'TDL 登录服务暂不可用，请稍后重试。' }); }

    if (pathname === '/erp-config/me' && ['GET','PUT','DELETE'].includes(request.method)) {
      await mappings.rememberUser(user);
      if(request.method==='PUT'){
        const body=await readJson(request,4096);
        if(Object.keys(body).some(key=>!['username','password'].includes(key)))return json(response,400,{error:'此入口只接受互拓账号和密码'});
        await mappings.set(user.id,body);erpTokens.delete(user.id);
      }
      if(request.method==='DELETE'){await mappings.remove(user.id);erpTokens.delete(user.id);}
      const mapping = mappings.get(user.id);
      const settings=erpSettings(),ready=!!(mapping&&mapping.enabled&&validErpSettings(settings));
      const error=!mapping||!mapping.enabled?'请填写自己的互拓账号和密码。':!validErpSettings(settings)?'账号已保存，服务器连接设置暂不可用。':'';
      return json(response, 200, { ready, error, account:{username:mapping?.username||'',hasPassword:!!mapping?.password,configured:!!mapping?.enabled}, config: ready ? { baseUrl: DEFAULT_ERP_PROXY_BASE, tenantId:'managed', username:mapping.username, canSubmitDrafts:settings.draftApiConfirmed===true, canConvertDrafts:settings.draftConvertConfirmed===true } : null });
    }
    if(request.method==='POST'&&pathname==='/erp-config/test'){
      try{return json(response,200,await testErpAccount(user,mappings.get(user.id)));}catch(error){return json(response,error.status||503,{error:error.message});}
    }
    if (request.method === 'GET' && pathname === '/erp-config/accounts') {
      if (!user.isAdmin) return json(response, 403, { error: '仅 TDL 管理员可以管理互拓账号映射。' });
      const settings=erpSettings();return json(response, 200, { accounts:mappings.list(), users:mappings.listUsers(), serviceReady:validErpSettings(settings), service:publicErpSettings(settings) });
    }
    if (pathname === '/erp-config/settings') {
      if (!user.isAdmin) return json(response, 403, { error: '仅 TDL 管理员可以管理互拓服务连接。' });
      if (request.method === 'GET') { const settings=erpSettings(); return json(response,200,{serviceReady:validErpSettings(settings),settings:publicErpSettings(settings)}); }
      if (request.method === 'PUT') {
        const body=await readJson(request,1024*1024),current=erpSettings(),next={...current};
        for(const key of ['erpBaseUrl','erpTenantId','erpClientId'])if(Object.hasOwn(body,key))next[key]=String(body[key]||'').trim();
        if(Object.hasOwn(body,'erpClientSecret')&&String(body.erpClientSecret||''))next.erpClientSecret=String(body.erpClientSecret);
        for(const key of ['draftApiConfirmed','draftConvertConfirmed'])if(Object.hasOwn(body,key))next[key]=body[key]===true;
        let endpoint;try{endpoint=new URL(next.erpBaseUrl)}catch{return json(response,400,{error:'请输入有效的互拓 HTTPS API 地址。'})}
        if(!allowedEndpoint(endpoint))return json(response,400,{error:'请使用 HTTPS 地址，或服务器已授权的测试服地址。'});
        if(!/^\d+$/.test(next.erpTenantId||''))return json(response,400,{error:'互拓租户 ID 必须是数字。'});
        await mappings.setSettings(next);erpTokens.clear();return json(response,200,{serviceReady:validErpSettings(next),settings:publicErpSettings(next)});
      }
    }
    if (pathname.startsWith('/erp-config/accounts/')) {
      if (!user.isAdmin) return json(response, 403, { error: '仅 TDL 管理员可以管理互拓账号映射。' });
      if(request.method==='POST'&&pathname.endsWith('/test')){
        const accountId=decodeURIComponent(pathname.slice('/erp-config/accounts/'.length,-5));
        try{return json(response,200,await testErpAccount({id:accountId},mappings.get(accountId)));}catch(error){return json(response,error.status||503,{error:error.message});}
      }
      const accountId = decodeURIComponent(pathname.slice('/erp-config/accounts/'.length));
      if (request.method === 'PUT') { const body = await readJson(request, 4096);if(Object.keys(body).some(key=>!['username','password'].includes(key)))return json(response,400,{error:'账号映射只需互拓账号和密码'});const account=await mappings.set(accountId, body);erpTokens.delete(accountId);return json(response, 200, { account }); }
      if (request.method === 'DELETE') { await mappings.remove(accountId);erpTokens.delete(accountId);return json(response, 200, { ok: true }); }
    }
    if (pathname.startsWith('/erp/') || allowedErpRoutes.some(([method,pattern])=>request.method===method&&pattern.test(pathname))) {
      try { return await proxyErp(request, response, user); }
      catch (error) { return json(response, error.status || 503, { error: error.message || '互拓代理服务暂不可用。' }); }
    }

    if (request.method === 'GET' && pathname === '/usage') {
      const accountId = String(new URL(request.url, 'http://localhost').searchParams.get('accountId') || '').slice(0, 120);
      if (accountId && accountId !== user.id && !user.isAdmin) return json(response, 403, { error: '无权查看其他账号的使用情况。' });
      const result = store.query({ accountId, days: new URL(request.url, 'http://localhost').searchParams.get('days'), admin: user.isAdmin, user });
      return json(response, 200, result);
    }

    if (request.method !== 'POST' || pathname !== '/v1/chat/completions') return json(response, 404, { error: '接口不存在。' });
    if (!secret) return json(response, 503, { error: '模型服务尚未配置。' });
    const currentAccount = perAccount.get(user.id) || { active: 0 };
    if (currentAccount.active >= 8) return json(response, 429, { error: '当前账号同时提交的任务过多，请等待当前批次完成。' });
    let input;
    try { input = await readJson(request); input = normalizeCompletionBody(input); }
    catch (error) { return json(response, error.status || 400, { error: error.status === 413 ? '模型请求超过大小限制。' : '模型请求格式不受支持。' }); }
    const account = currentAccount;
    account.active++;
    perAccount.set(user.id, account);
    const started = now();
    let success = false;
    let usage = emptyCounters();
    let replyStatus = 502, replyBody = { error: '模型连接失败，请稍后重试。' }, replyRaw = null;
    try {
      const upstreamResponse = await fetchImpl(upstreamUrl, {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`, Accept: 'application/json' },
        body: JSON.stringify(input), signal: AbortSignal.timeout(120000)
      });
      const chunks = [];
      let length = 0;
      for await (const chunk of upstreamResponse.body || []) {
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) throw Object.assign(new Error('upstream_response_too_large'), { status: 502 });
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      if (!upstreamResponse.ok) {
        replyStatus = upstreamResponse.status >= 400 && upstreamResponse.status < 500 ? upstreamResponse.status : 502;
        replyBody = { error: '模型服务暂时无法完成请求。' };
      } else {
        let payload;
        try { payload = JSON.parse(raw.toString('utf8')); }
        catch { replyStatus = 502; replyBody = { error: '模型服务返回格式无效。' }; }
        if (payload) { usage = parseUsage(payload); success = true; replyStatus = 200; replyRaw = raw; }
      }
    } catch (error) {
      replyStatus = error.status || 502;
      replyBody = { error: '模型连接失败，请稍后重试。' };
    } finally {
      account.active = Math.max(0, account.active - 1);
      if (account.active === 0) perAccount.delete(user.id);
      try { await store.record(user, { success, usage, latencyMs: now() - started, at: new Date(now()) }); } catch { /* Usage-store failures never reveal request data. */ }
    }
    if (replyRaw) {
      response.writeHead(replyStatus, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      response.end(replyRaw);
      return;
    }
    return json(response, replyStatus, replyBody);
  }

  const server = http.createServer((request, response) => { void route(request, response).catch(error => { if (!response.headersSent) json(response, error.status||500, { error: [400,404,413].includes(error.status)?error.message:'服务暂时不可用。' }); else response.destroy(); }); });
  return { server, store, mappings, listen: (port = Number(env.PORT || 4600), host = env.HOST || '127.0.0.1') => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address()); });
  }), close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

if (require.main === module) {
  const service = createServer();
  void Promise.all([service.store.load(), service.mappings?.load?.()]).then(() => service.listen()).then(address => process.stdout.write(`maishou-service listening ${address.address}:${address.port}\n`)).catch(error => { process.stderr.write(`maishou-service failed to start: ${error.message}\n`); process.exitCode = 1; });
}

module.exports = { createServer, UsageStore, ErpMappingStore, normalizeCompletionBody, parseUsage, parseBearer, dayKey, DEFAULT_MODEL, DEFAULT_UPSTREAM_URL, DEFAULT_TDL_AUTH_URL };
