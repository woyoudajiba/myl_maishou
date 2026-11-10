const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const AUTH_BASE = 'https://wsfile.cn/myladmin';
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, file);
}
function publicUser(user) {
  if (!user || !['string', 'number'].includes(typeof user.id) || !String(user.id)) throw new Error('TDL 返回的账号信息无效');
  return { id: String(user.id), username: String(user.username || '').slice(0, 120), displayName: String(user.displayName || user.username || 'TDL 用户').slice(0, 120), isAdmin: user.isAdmin === true || String(user.role || '').toUpperCase() === 'ADMIN' };
}
function profileId(user) { return crypto.createHash('sha256').update(`${AUTH_BASE}:${user.id}`).digest('hex').slice(0, 32); }
function encryptedStorage(safeStorage) {
  return {
    encrypt(value) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存凭据');
      return safeStorage.encryptString(value).toString('base64');
    },
    decrypt(value) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，请重新登录或填写 API Key');
      return safeStorage.decryptString(Buffer.from(value, 'base64'));
    }
  };
}
class Accounts {
  constructor({ dataDir, storage, transport = (...args) => fetch(...args) }) {
    this.file = path.join(dataDir, 'session.json'); this.storage = storage; this.transport = transport; this.session = null;
  }
  async request(route, { token, body } = {}) {
    let response;
    try {
      response = await this.transport(`${AUTH_BASE}/api/auth/${route}`, { method: body || route === 'logout' ? 'POST' : 'GET',
        redirect: 'error', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    } catch { throw new Error('无法连接 TDL 登录服务，请检查网络后重试'); }
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error(route === 'login' ? '账号或密码不正确，或账号已停用' : 'TDL 登录已失效，请重新登录'), { unauthorized: true });
    if (!response.ok) throw new Error(`TDL 登录服务暂不可用（HTTP ${response.status}）`);
    const text = await response.text();
    if (text.length > 65536) throw new Error('TDL 登录响应异常');
    try { return JSON.parse(text); } catch { throw new Error('TDL 登录响应格式无效'); }
  }
  async login({ username, password, remember = true } = {}) {
    if (typeof username !== 'string' || !username.trim() || username.length > 120 || typeof password !== 'string' || !password || password.length > 512) throw new Error('请填写 TDL 账号和密码');
    const result = await this.request('login', { body: { username: username.trim(), password, clientLabel: '找商品工作台' } });
    if (typeof result.token !== 'string' || !result.token || result.token.length > 16000 || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now()) throw new Error('TDL 登录会话无效');
    const session = { token: result.token, expiresAt: result.expiresAt, user: publicUser(result.user) };
    try {
      if (remember) await atomicJson(this.file, { encrypted: this.storage.encrypt(JSON.stringify(session)) });
      else await fs.rm(this.file, { force: true });
    } catch (error) { await this.request('logout', { token: session.token }).catch(() => {}); throw error; }
    this.session = session;
    return session.user;
  }
  async restore() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const session = JSON.parse(this.storage.decrypt(saved.encrypted));
      if (!session.token || Date.parse(session.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(session.expiresAt))) throw new Error('会话过期');
      this.session = { ...session, user: publicUser(session.user) };
      await this.validate();
      return this.session.user;
    } catch (error) {
      this.session = null;
      if (error.code !== 'ENOENT') await fs.rm(this.file, { force: true });
      return null;
    }
  }
  async validate() {
    if (!this.session || Date.parse(this.session.expiresAt) <= Date.now()) throw Object.assign(new Error('请登录 TDL 账号'), { unauthorized: true });
    const result = await this.request('me', { token: this.session.token });
    const user = publicUser(result.user);
    if (user.id !== this.session.user.id) throw Object.assign(new Error('登录账号发生变化，请重新登录'), { unauthorized: true });
    this.session.user = user;
    return user;
  }
  async logout() {
    const token = this.session?.token;
    this.session = null;
    await fs.rm(this.file, { force: true });
    if (token) await this.request('logout', { token }).catch(() => {});
  }
  authenticated() { return !!this.session && Date.parse(this.session.expiresAt) > Date.now(); }
}
module.exports = { Accounts, AUTH_BASE, profileId, publicUser, encryptedStorage, atomicJson };
