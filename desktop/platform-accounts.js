const path = require('node:path');
const fs = require('node:fs/promises');
const { atomicJson } = require('./accounts');

const platforms = Object.freeze({
  wsy: '网商园',
  zwd: '17网',
  qcc: '青创网',
  e3hui: '衣衫汇'
});

class PlatformAccounts {
  constructor({ dataDir, storage }) {
    this.file = path.join(dataDir, 'platform-accounts.json');
    this.storage = storage;
    this.accounts = {};
  }
  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const decrypted = JSON.parse(this.storage.decrypt(saved.encrypted));
      if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) throw new Error('平台账号配置无效');
      this.accounts = Object.fromEntries(Object.entries(decrypted).filter(([platform, account]) =>
        Object.hasOwn(platforms, platform) && account && typeof account.username === 'string' && typeof account.password === 'string'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this.list();
  }
  list() {
    return Object.entries(platforms).map(([platform, name]) => ({
      platform, name, username: this.accounts[platform]?.username || '', configured: !!this.accounts[platform]?.password
    }));
  }
  async persist(next) {
    await atomicJson(this.file, { encrypted: this.storage.encrypt(JSON.stringify(next)) });
    this.accounts = next;
    return this.list();
  }
  async save(platform, input = {}) {
    if (!Object.hasOwn(platforms, platform)) throw new Error('请选择支持的平台');
    const username = typeof input.username === 'string' ? input.username.trim() : '';
    const password = typeof input.password === 'string' ? input.password : '';
    if (!username || username.length > 120 || /[\r\n]/.test(username)) throw new Error('请填写有效的平台账号');
    if (password.length > 512 || /[\r\n]/.test(password)) throw new Error('平台密码格式无效');
    const old = this.accounts[platform];
    if (old && old.username !== username && !password) throw new Error('修改平台账号时请重新填写密码');
    const nextPassword = password || old?.password || '';
    if (!nextPassword) throw new Error('请填写平台密码');
    return this.persist({ ...this.accounts, [platform]: { username, password: nextPassword } });
  }
  async remove(platform) {
    if (!Object.hasOwn(platforms, platform)) throw new Error('平台账号不存在');
    const next = { ...this.accounts };
    delete next[platform];
    return this.persist(next);
  }
  credential(platform) {
    if (!Object.hasOwn(platforms, platform)) return null;
    const value = this.accounts[platform];
    return value?.password ? { username: value.username, password: value.password } : null;
  }
}

module.exports = { PlatformAccounts, platforms };
