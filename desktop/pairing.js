const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicJson } = require('./accounts');

async function loadOrCreatePairingToken({ dataDir, storage, randomBytes = crypto.randomBytes }) {
  const file = path.join(dataDir, 'pairing.json');
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    const token = storage.decrypt(saved.encrypted);
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('本机长期配对码格式无效');
    return token;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(error.message || '无法读取本机长期配对码');
  }
  const token = randomBytes(32).toString('hex');
  await atomicJson(file, { version: 1, encrypted: storage.encrypt(token) });
  return token;
}

module.exports = { loadOrCreatePairingToken };
