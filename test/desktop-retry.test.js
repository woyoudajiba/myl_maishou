const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const review = require('../review');
const { createDesktopBridge } = require('../desktop/bridge-server');
const { compareCandidates } = require('../desktop/comparison');

const waitFor = async predicate => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('任务没有及时进入预期状态');
};

async function fixture(t, { hold = false, fail = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'product-retry-'));
  const id = crypto.randomUUID(), createdAt = '2026-10-29T06:09:11.000Z';
  const query = 'data:image/png;base64,YQ==', bytes = Buffer.from('saved-image');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const items = Array.from({ length: 4 }, (_, index) => ({ id: String(index + 1), platform: 'qcc', imageUrl: `https://pics.17qcc.com/${index + 1}.png`,
    ...(index < 2 ? { imageSimilaritySource: 'qwen_multimodal_v1', imageSimilarityStatus: 'compared', imageSimilarity: .9,
      imageEvidence: { sha256, width: 800, height: 1000 },
      visualComparison: { id: `candidate_${index + 1}`, verdict: 'similar', score: 90, matches: [], differences: [], uncertainties: [] } }
      : { imageSimilarityStatus: index === 2 ? 'unavailable' : 'not_started', imageSimilarityError: '模拟超时' }) }));
  items[0] = review.apply(items[0], { verdict: 'similar', score: 88, note: '人工核对通过' });
  const saved = { id, createdAt, updatedAt: createdAt, status: 'partial', total: 4, completed: 3, compared: 2, failed: 1, notStarted: 1,
    progress: 75, reviewMode: 'manual', queryName: '裤子.png', error: '模拟超时', items };
  await fs.mkdir(path.join(dataDir, 'queries'));
  await fs.writeFile(path.join(dataDir, 'queries', id + '.txt'), query);
  await fs.mkdir(path.join(dataDir, 'images', id), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'images', id, `0-${sha256}.jpg`), bytes);
  await fs.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([saved]));
  let bridge, release, holding = hold, failing = fail, allowed = true;
  const calls = [];
  const gate = new Promise(resolve => { release = resolve; });
  const options = { dataDir, port: 0, canProcess: () => allowed, processJob: async (job, update) => {
    await compareCandidates(job, update, {
      config: { model: 'fixture', concurrency: 1 }, signal: new AbortController().signal, allowed: () => true,
      downloadImage: async () => ({ buffer: bytes, dataUrl: query, evidence: { width: 800, height: 1000 } }),
      saveImage: (index, buffer) => bridge.storeCandidateImage(job.id, index, buffer),
      invoke: async (_config, batch) => {
        calls.push(batch.candidates.map(item => item.id));
        if (holding) await gate;
        if (failing) throw new Error('HTTP 504');
        return { model: 'fixture', judgments: batch.candidates.map(item => ({ id: item.id, verdict: 'similar', score: 80, matches: [], differences: [], uncertainties: [] })) };
      }
    });
  } };
  bridge = createDesktopBridge(options); await bridge.start();
  t.after(async () => { release(); await bridge.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { id, createdAt, query, dataDir, items, calls, get bridge() { return bridge; },
    release() { holding = false; release(); }, succeed() { failing = false; },
    async restart() { await bridge.close(); allowed = false; bridge = createDesktopBridge(options); await bridge.start(); } };
}

test('原任务重试只调用未完成图片，保留总数、创建时间、人工分和送模证据，重启不新增记录', async t => {
  const f = await fixture(t);
  const retried = await f.bridge.retry(f.id);
  assert.equal(retried.id, f.id);
  await waitFor(() => f.bridge.snapshot().jobs[0].status === 'complete');
  const job = f.bridge.snapshot().jobs[0];
  assert.equal(f.bridge.snapshot().jobs.length, 1);
  assert.equal(job.total, 4); assert.equal(job.compared, 4); assert.equal(job.failed, 0); assert.equal(job.notStarted, 0);
  assert.equal(job.createdAt, f.createdAt); assert.equal(job.queryName, '裤子.png'); assert.equal(job.retryCount, 1);
  assert.ok(Number.isFinite(Date.parse(job.lastRetryAt)));
  assert.equal(job.retryOf, undefined);
  assert.deepEqual(job.items[0].humanReview, f.items[0].humanReview);
  assert.deepEqual(job.items[0].imageEvidence, f.items[0].imageEvidence);
  assert.equal(job.items[0].finalScore, 88);
  assert.deepEqual(f.calls, [['candidate_3'], ['candidate_4']]);
  const image = await f.bridge.candidateImage(f.id, 0);
  assert.equal(image, 'data:image/jpeg;base64,' + Buffer.from('saved-image').toString('base64'));
  assert.equal(f.bridge.queryImage(f.id), f.query);
  await assert.rejects(f.bridge.retry(f.id), /没有未完成候选/);
  await f.restart();
  assert.deepEqual(f.bridge.snapshot().jobs.map(item => item.id), [f.id]);
  assert.equal(f.bridge.snapshot().jobs[0].items[0].finalScore, 88);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'queries')), [f.id + '.txt']);
});

test('连续点击及识别中重复重试只提交一次，原任务继续更新进度', async t => {
  const f = await fixture(t, { hold: true });
  const results = await Promise.all(Array.from({ length: 20 }, () => f.bridge.retry(f.id)));
  assert.ok(results.every(item => item.id === f.id));
  await waitFor(() => f.calls.length === 1);
  await Promise.all(Array.from({ length: 5 }, () => f.bridge.retry(f.id)));
  const job = f.bridge.snapshot().jobs[0];
  assert.equal(f.bridge.snapshot().jobs.length, 1);
  assert.equal(job.retryCount, 1); assert.equal(job.compared, 2); assert.equal(job.failed, 0); assert.equal(job.notStarted, 2);
  assert.deepEqual(f.calls, [['candidate_3']]);
  f.release();
  await waitFor(() => f.bridge.snapshot().jobs[0].status === 'complete');
  assert.deepEqual(f.calls, [['candidate_3'], ['candidate_4']]);
});

test('再次超时后仍在同一任务重试，保存失败则回滚且不发送模型请求', async t => {
  const f = await fixture(t, { fail: true });
  const before = f.bridge.snapshot().jobs[0];
  const blocked = path.join(f.dataDir, 'jobs.json.tmp');
  await fs.mkdir(blocked);
  await assert.rejects(f.bridge.retry(f.id));
  assert.deepEqual(f.bridge.snapshot().jobs, [before]);
  assert.equal(f.calls.length, 0);
  await fs.rmdir(blocked);
  await f.bridge.retry(f.id);
  await waitFor(() => f.bridge.snapshot().jobs[0].status === 'partial' && f.bridge.snapshot().jobs[0].autoRetryCount === 3);
  assert.equal(f.bridge.snapshot().jobs[0].retryCount, 4);
  assert.equal(f.bridge.snapshot().jobs[0].autoRetryCount, 3);
  assert.equal(f.bridge.snapshot().jobs[0].items[0].finalScore, 88);
  f.succeed();
  await f.bridge.retry(f.id);
  await waitFor(() => f.bridge.snapshot().jobs[0].status === 'complete');
  assert.equal(f.bridge.snapshot().jobs.length, 1);
  assert.equal(f.bridge.snapshot().jobs[0].retryCount, 5);
  assert.equal(f.bridge.snapshot().jobs[0].autoRetryCount, 0, '人工续轮后重新获得 3 次自动重试额度');
  assert.ok(f.calls.length >= 3);
  assert.ok(f.calls.every(batch => batch.every(id => ['candidate_3', 'candidate_4'].includes(id))));
  assert.ok(f.calls.some(batch => batch.includes('candidate_3')) && f.calls.some(batch => batch.includes('candidate_4')));
});

test('每轮自动重试严格止于3次，手动再开一轮仍可继续3次，重启保留耗尽状态', async t => {
  const f = await fixture(t, { fail: true });
  await f.bridge.retry(f.id);
  await waitFor(() => f.bridge.snapshot().jobs[0].status === 'partial' && f.bridge.snapshot().jobs[0].autoRetryCount === 3);
  let job = f.bridge.snapshot().jobs[0];
  assert.equal(job.retryCount, 4);
  assert.equal(job.manualRetryRounds, 1);
  assert.deepEqual(job.items[0].humanReview, f.items[0].humanReview);
  await f.bridge.retry(f.id);
  await waitFor(() => f.bridge.snapshot().jobs[0].status === 'partial' && f.bridge.snapshot().jobs[0].retryCount === 8);
  job = f.bridge.snapshot().jobs[0];
  assert.equal(job.autoRetryCount, 3);
  assert.equal(job.manualRetryRounds, 2);
  assert.equal(f.bridge.snapshot().jobs.length, 1);
  await f.restart();
  job = f.bridge.snapshot().jobs[0];
  assert.equal(job.status, 'partial');
  assert.equal(job.autoRetryCount, 3);
  assert.equal(job.retryCount, 8);
});
