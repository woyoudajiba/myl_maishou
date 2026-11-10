const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDesktopBridge } = require('../desktop/bridge-server');

test('批量任务保留图片名和独立原图；10个在途任务后限流，不挤掉排队记录，重启后可查', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'product-batch-'));
  let bridge, release;
  const options = { port: 0, dataDir, canProcess: () => true, processJob: async (_job, update) => {
    await new Promise(resolve => { release = resolve; });
    await update({ status: 'complete' });
  } };
  bridge = createDesktopBridge(options);
  t.after(async () => { release?.(); await bridge.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const local = await bridge.start(), group = crypto.randomUUID();
  const input = index => ({ query: 'data:image/jpeg;base64,' + Buffer.from('query-' + index).toString('base64'), queryName: index === 0 ? '裤子.png' : '上衣' + index + '.png', queryId: crypto.randomUUID(), searchGroupId: group, items: [{ id: 'same', imageUrl: 'https://images.example/item.jpg' }] });
  const post = body => fetch('http://127.0.0.1:' + local.port + '/v1/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Desktop-Token': local.token }, body: JSON.stringify(body) });
  const first = input(0), accepted = await (await post(first)).json();
  for (let i = 1; i < 10; i++) assert.equal((await post(input(i))).status, 202);
  const retained = bridge.snapshot().jobs;
  assert.equal(retained.length, 10);
  assert.equal(retained[0].queryName, '裤子.png');
  assert.equal(retained[0].searchGroupId, group);
  assert.equal(bridge.queryImage(accepted.id), first.query);
  const rejected = await post(input(10));
  assert.equal(rejected.status, 429);
  assert.deepEqual(bridge.snapshot().jobs.map(job => job.id), retained.map(job => job.id));
  const closing = bridge.close(); release(); await closing;
  bridge = createDesktopBridge({ ...options, canProcess: () => false }); await bridge.start();
  assert.equal(bridge.snapshot().jobs.length, 10);
  assert.equal(bridge.snapshot().jobs[0].queryId, first.queryId);
  assert.equal(bridge.queryImage(accepted.id), first.query);
});
