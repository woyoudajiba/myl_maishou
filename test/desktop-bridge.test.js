const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDesktopBridge } = require('../desktop/bridge-server');
const review = require('../review');

test('桌面审核不重调模型，保留原结论，重启后仍按人工结论生效并拒绝过期审核', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'product-review-'));
  let bridge; let calls = 0;
  t.after(async () => { await bridge?.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const options = { port: 0, dataDir, canProcess: () => true, processJob: async (job, update) => {
    calls++;
    await update({ status: 'complete', completed: 1, progress: 100, items: job.items.map(item => ({ ...item,
      imageSimilaritySource: 'qwen_multimodal_v1', imageSimilarity: 0.9,
      visualComparison: { verdict: 'likely_same', score: 90, matches: ['领口相同'], differences: [], uncertainties: [] } })) });
  } };
  bridge = createDesktopBridge(options);
  const initial = await bridge.start();
  const accepted = await fetch(`http://127.0.0.1:${initial.port}/v1/jobs`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Desktop-Token': initial.token },
    body: JSON.stringify({ query: 'data:image/jpeg;base64,YQ==', items: [{ id: '1', imageUrl: 'https://images.example/1.jpg' }] }) });
  const { id } = await accepted.json();
  for (let attempt = 0; attempt < 100 && bridge.snapshot().jobs[0]?.status !== 'complete'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  const job = bridge.snapshot().jobs[0];
  assert.equal(job.status, 'complete'); assert.equal(job.reviewMode, 'manual');
  assert.equal(job.items[0].finalVerdict, null);
  assert.equal(job.items[0].finalScore, null);
  await assert.rejects(bridge.reviewItem(id, 0, { verdict: 'different', note: '袖口不同' }, 'stale'), /已变化/);
  const noteFree = await bridge.reviewItem(id, 0, { verdict: 'different' }, review.signature(job.items[0]));
  assert.equal(noteFree.items[0].finalVerdict, 'different', '人工排除无需重新填写匹配分或备注');
  await bridge.reviewItem(id, 0, null, review.signature(noteFree.items[0]));
  await bridge.setReviewMode(id, 'manual');
  const blockedWrite = path.join(dataDir, 'jobs.json.tmp');
  await fs.mkdir(blockedWrite);
  await assert.rejects(bridge.reviewItem(id, 0, { verdict: 'different', note: '袖口不同' }, review.signature(job.items[0])));
  assert.equal(bridge.snapshot().jobs[0].items[0].finalVerdict, null, '写盘失败不能留下有效人工结论');
  await assert.rejects(bridge.setReviewMode(id, 'direct'));
  assert.equal(bridge.snapshot().jobs[0].reviewMode, 'manual', '模式写盘失败必须回滚');
  await fs.rmdir(blockedWrite);
  const corrected = await bridge.reviewItem(id, 0, { verdict: 'different', score: 25, note: '袖口不同' }, review.signature(job.items[0]));
  assert.equal(corrected.items[0].finalVerdict, 'different');
  assert.equal(corrected.items[0].finalScore, 25);
  assert.equal(corrected.items[0].visualComparison.score, 90);
  assert.equal(corrected.items[0].visualComparison.verdict, 'likely_same');
  assert.equal(corrected.reviewSummary.corrected, 1);
  await bridge.setReviewMode(id, 'direct');
  assert.equal(calls, 1);
  await bridge.close(); bridge = createDesktopBridge(options); await bridge.start();
  const restored = bridge.snapshot().jobs[0];
  assert.equal(restored.reviewMode, 'direct');
  assert.equal(restored.items[0].finalVerdict, 'different');
  assert.equal(restored.items[0].finalScore, 25);
  assert.equal(restored.items[0].humanReview.note, '袖口不同');
  assert.equal(Object.hasOwn(restored, 'query'), false);
  assert.equal(bridge.queryImage(id), 'data:image/jpeg;base64,YQ==');
  await bridge.setReviewMode(id, 'manual');
  const cleared = await bridge.reviewItem(id, 0, null, review.signature(restored.items[0]));
  assert.equal(cleared.items[0].finalVerdict, null);
  assert.equal(cleared.items[0].finalScore, null);
  assert.equal(cleared.reviewSummary.pending, 1);
  assert.equal(calls, 1);
});

test('本地桌面桥要求配对、限制候选数并且不向扩展返回原图或 Key', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'product-comparison-desktop-'));
  let bridge;
  t.after(async () => { await bridge?.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  bridge = createDesktopBridge({
    port: 0, dataDir, canProcess: () => true, getVisionStatus: () => ({ configured: true, model: 'qwen3.7-plus' }),
    processJob: async (job, update) => {
      assert.equal(job.query, 'data:image/jpeg;base64,YQ==');
      assert.equal(job.items[0].imageUrl, 'https://images.example/item.jpg');
      assert.equal(job.items[0].price, 0);
      assert.equal(job.items[0].detailUrl, '');
      await update({ status: 'complete', progress: 100, completed: 1, items: job.items });
    }
  });
  const initial = await bridge.start();
  const endpoint = `http://127.0.0.1:${initial.port}`;
  const unauthorized = await fetch(`${endpoint}/v1/jobs`);
  assert.equal(unauthorized.status, 401);

  const headers = { 'Content-Type': 'application/json', 'X-Desktop-Token': initial.token };
  const pair = await fetch(`${endpoint}/v1/pair`, { method: 'POST', headers, body: '{}' });
  assert.equal(pair.status, 200);
  const tooMany = await fetch(`${endpoint}/v1/jobs`, { method: 'POST', headers, body: JSON.stringify({ query: 'data:image/jpeg;base64,YQ==', items: Array.from({ length: 501 }, (_, i) => ({ id: String(i), imageUrl: 'https://images.example/item.jpg' })) }) });
  assert.equal(tooMany.status, 400);

  const accepted = await fetch(`${endpoint}/v1/jobs`, { method: 'POST', headers, body: JSON.stringify({
    query: 'data:image/jpeg;base64,YQ==', apiKey: 'not-to-be-stored',
    searchIssues: [{ platform: 'zwd', phase: 'failed', message: '需登录', cookie: 'ignored' }, { platform: 'unknown', phase: 'failed', message: '丢弃未知平台' }],
    platformSearches: [{ platform: 'wsy', selected: true, phase: 'complete', receivedCount: 1, reportedTotal: 80, searchGroups: [{ type: 'accurate', phase: 'complete', receivedCount: 1, reportedTotal: 80 }] }, { platform: 'zwd', selected: true, phase: 'failed', receivedCount: 0, reportedTotal: null }, { platform: 'qcc', selected: true, phase: 'failed', receivedCount: 0, reportedTotal: null, diagnostics: { stage: 'image_search', timeoutStage: 'image_search', failureKind: 'timeout', retryable: false, elapsedMs: 25001, errorCode: 'timeout' } }],
    items: [{ id: 'x', platform: 'wsy', searchGroup: 'accurate', title: '<script>unsafe</script>', imageUrl: 'https://images.example/item.jpg', detailUrl: 'javascript:alert(1)', price: 0, cookie: 'ignored' }]
  }) });
  assert.equal(accepted.status, 202);
  const { id } = await accepted.json();
  let job;
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(`${endpoint}/v1/jobs/${id}`, { headers: { 'X-Desktop-Token': initial.token } });
    job = (await response.json()).job;
    if (job.status === 'complete') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(job.status, 'complete');
  assert.equal(job.items[0].searchGroup, 'accurate');
  assert.deepEqual(job.searchIssues, [{platform:'zwd',phase:'failed',message:'需登录'}]);
  assert.equal(job.platformSearches[0].reportedTotal, 80);
  assert.equal(job.platformSearches[0].searchGroups[0].type, 'accurate');
  assert.equal(job.platformSearches[1].phase, 'failed');
  assert.equal(job.platformSearches[2].diagnostics.timeoutStage, 'image_search');
  assert.equal(job.platformSearches[2].diagnostics.retryable, false);
  assert.equal(Object.hasOwn(job, 'query'), false);
  assert.equal(JSON.stringify(job).includes('not-to-be-stored'), false);
  assert.equal(JSON.stringify(job).includes('<script>unsafe</script>'), true);
  const saved = await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8');
  assert.equal(saved.includes('not-to-be-stored'), false);
  assert.equal(saved.includes('cookie'), false);
  assert.equal(saved.includes('data:image/jpeg;base64,YQ=='), false);
  const queryFiles = await fs.readdir(path.join(dataDir, 'queries'));
  assert.equal(queryFiles.length, 1);
  assert.equal(await fs.readFile(path.join(dataDir, 'queries', queryFiles[0]), 'utf8'), 'data:image/jpeg;base64,YQ==');
});

test('本地桌面桥在未配置模型时拒绝创建付费任务', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'product-comparison-desktop-'));
  let bridge;
  t.after(async () => { await bridge?.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  bridge = createDesktopBridge({ port: 0, dataDir, canProcess: () => false, processJob: async () => {} });
  const initial = await bridge.start();
  const response = await fetch(`http://127.0.0.1:${initial.port}/v1/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Desktop-Token': initial.token },
    body: JSON.stringify({ query: 'data:image/jpeg;base64,YQ==', items: [{ imageUrl: 'https://images.example/item.jpg' }] })
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /vision_not_configured/);
});

test('桌面任务只重试未完成候选，成功项不重复消费', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'product-comparison-desktop-'));
  let bridge; let processCount = 0; const processedCounts = [];
  t.after(async () => { await bridge?.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  bridge = createDesktopBridge({
    port: 0, dataDir, canProcess: () => true,
    processJob: async (job, update) => {
      processCount++; processedCounts.push(job.items.filter(item => !item.visualComparison).length);
      const items = job.items.map((item, index) => item.visualComparison ? item : processCount === 1 && index === 1
        ? { ...item, imageSimilarityStatus: 'unavailable', imageSimilarityError: '模拟图片下载失败' }
        : { ...item, imageSimilarityStatus: 'compared', visualComparison: { verdict: 'similar', matches: ['衣领形状相近'], differences: [], uncertainties: [] } });
      await update({ items, completed: items.length, progress: 100, status: processCount === 1 ? 'partial' : 'complete' });
    }
  });
  const snapshot = await bridge.start();
  const endpoint = `http://127.0.0.1:${snapshot.port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Desktop-Token': snapshot.token };
  const accepted = await fetch(`${endpoint}/v1/jobs`, { method: 'POST', headers, body: JSON.stringify({
    query: 'data:image/jpeg;base64,YQ==', items: [1, 2, 3].map(id => ({ id: String(id), imageUrl: 'https://images.example/item.jpg' }))
  }) });
  const firstId = (await accepted.json()).id;
  const waitFor = async id => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await fetch(`${endpoint}/v1/jobs/${id}`, { headers: { 'X-Desktop-Token': snapshot.token } });
      const job = (await response.json()).job;
      if (['partial', 'complete', 'failed'].includes(job.status)) return job;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('任务没有及时完成');
  };
  const first = await waitFor(firstId);
  assert.equal(first.status, 'complete', '单个暂时失败由后台自动重试');
  assert.equal(first.autoRetryCount, 1);
  assert.equal(first.total, 3);
  assert.deepEqual(first.items.map(item => item.id), ['1', '2', '3']);
  assert.equal(bridge.snapshot().jobs.length, 1);
  await assert.rejects(bridge.retry(firstId), /没有未完成候选/);
  assert.deepEqual(processedCounts, [3, 1]);
});
