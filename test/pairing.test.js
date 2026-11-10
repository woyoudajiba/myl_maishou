const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadOrCreatePairingToken } = require('../desktop/pairing');
const { createDesktopBridge } = require('../desktop/bridge-server');

test('本机长期配对码只生成一次、加密落盘，重启和再次登录后保持不变', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'product-pairing-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let generated = 0;
  const storage = { encrypt: value => `encrypted:${Buffer.from(value).toString('base64')}`, decrypt: value => Buffer.from(value.slice('encrypted:'.length), 'base64').toString() };
  const randomBytes = size => { generated++; return Buffer.alloc(size, 0xab); };
  const first = await loadOrCreatePairingToken({ dataDir, storage, randomBytes });
  const disk = await fs.readFile(path.join(dataDir, 'pairing.json'), 'utf8');
  assert.equal(disk.includes(first), false);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(await loadOrCreatePairingToken({ dataDir, storage, randomBytes }), first);
  assert.equal(generated, 1);
});

test('无法解密已有配对信息时失败关闭，不悄悄生成另一组配对码', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'product-pairing-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, 'pairing.json'), JSON.stringify({ version: 1, encrypted: 'unreadable' }));
  let generated = 0;
  await assert.rejects(loadOrCreatePairingToken({ dataDir, storage: { decrypt: () => { throw new Error('secure storage unavailable'); } }, randomBytes: () => { generated++; return Buffer.alloc(32); } }), /secure storage unavailable/);
  assert.equal(generated, 0);
});

test('本地桥接受并持续使用加密加载的64位长期配对码', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'product-pairing-'));
  const token = 'ab'.repeat(32);
  const bridge = createDesktopBridge({ dataDir, port: 0, token, canAccess: () => true });
  await bridge.start();
  t.after(async () => { await bridge.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  assert.equal(bridge.snapshot().token, token);
  await bridge.close();
  const restored = createDesktopBridge({ dataDir, port: 0, token, canAccess: () => true });
  await restored.start();
  t.after(() => restored.close());
  const response = await fetch(`http://127.0.0.1:${restored.snapshot().port}/v1/pair`, { method: 'POST', headers: { 'X-Desktop-Token': token } });
  assert.equal(response.status, 200);
});
