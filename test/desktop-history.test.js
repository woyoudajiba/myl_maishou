const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDesktopBridge } = require('../desktop/bridge-server');

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'product-history-'));
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  const saved = ids.map((id, index) => ({ id, createdAt: '2026-10-28T06:17:00.000Z', updatedAt: '2026-10-28T06:18:00.000Z', status: ['complete', 'partial', 'queued'][index],
    total: 1, completed: 1, items: [{ id: String(index), title: '本地历史测试' }] }));
  await fs.mkdir(path.join(dataDir, 'queries'));
  for (const id of ids) {
    await fs.writeFile(path.join(dataDir, 'queries', id + '.txt'), 'data:image/jpeg;base64,YQ==');
    await fs.mkdir(path.join(dataDir, 'images', id), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'images', id, 'fixture.jpg'), 'saved image');
  }
  await fs.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify(saved));
  let allowed = true;
  const options = { dataDir, port: 0, canProcess: () => false, canAccess: () => allowed };
  let bridge = createDesktopBridge(options); await bridge.start();
  t.after(async () => { await bridge.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, ids, get bridge() { return bridge; }, deny() { allowed = false; }, async restart() { await bridge.close(); bridge = createDesktopBridge(options); await bridge.start(); } };
}

test('整批删除同时清理结果、原图和缓存；重启不复活，保留其他批次和排队任务', async t => {
  const f = await fixture(t);
  const result = await f.bridge.deleteJobs([f.ids[0]]);
  assert.deepEqual(result, { deleted: 1, retained: 2, warnings: [] });
  await assert.rejects(fs.access(path.join(f.dataDir, 'queries', f.ids[0] + '.txt')));
  await assert.rejects(fs.access(path.join(f.dataDir, 'images', f.ids[0])));
  for (const id of f.ids.slice(1)) {
    await fs.access(path.join(f.dataDir, 'queries', id + '.txt'));
    await fs.access(path.join(f.dataDir, 'images', id, 'fixture.jpg'));
  }
  await f.restart();
  assert.deepEqual(f.bridge.snapshot().jobs.map(job => job.id), f.ids.slice(1));
  assert.equal(f.bridge.queryImage(f.ids[1]), 'data:image/jpeg;base64,YQ==');
  const cleared = await f.bridge.deleteJobs([f.ids[1]]);
  assert.equal(cleared.deleted, 1);
  assert.deepEqual(f.bridge.snapshot().jobs.map(job => job.id), [f.ids[2]]);
});

test('删除失败回滚；禁止删除在途任务、跨路径、过期选项和未登录数据，整批校验后才修改', async t => {
  const f = await fixture(t);
  await assert.rejects(f.bridge.deleteJobs([f.ids[0], f.ids[2]]), /识别中的任务不能删除/);
  await assert.rejects(f.bridge.deleteJobs(['../../outside']), /编号无效/);
  await assert.rejects(f.bridge.deleteJobs([f.ids[0], f.ids[0]]), /请选择/);
  await assert.rejects(f.bridge.deleteJobs(['99999999-9999-4999-8999-999999999999']), /已变化/);
  const blocked = path.join(f.dataDir, 'jobs.json.tmp');
  await fs.mkdir(blocked);
  await assert.rejects(f.bridge.deleteJobs(f.ids.slice(0, 2)), /本地保存失败/);
  assert.deepEqual(f.bridge.snapshot().jobs.map(job => job.id), f.ids);
  for (const id of f.ids) await fs.access(path.join(f.dataDir, 'images', id, 'fixture.jpg'));
  await fs.rmdir(blocked);
  await f.bridge.setReviewMode(f.ids[0], 'direct');
  f.deny();
  await assert.rejects(f.bridge.deleteJobs([f.ids[0]]), /请先登录/);
  assert.equal(f.bridge.snapshot().jobs.length, 3);
});
