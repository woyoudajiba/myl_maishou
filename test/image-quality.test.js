const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns/promises');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('../desktop/node_modules/sharp');
const policy = require('../image-policy');
const { downloadCandidate, downloadImagePreview, validateQuery } = require('../desktop/images');
const { compareCandidates } = require('../desktop/comparison');
const { invokeModel } = require('../desktop/models');
const { createDesktopBridge } = require('../desktop/bridge-server');
const review = require('../review');
const url = 'https://pics.17qcc.com/product/a.jpg?x-oss-process=image/resize,m_fill,h_200,w_200';
const png = (width, height) => sharp({ create: { width, height, channels: 3, background: '#365976' } }).png().toBuffer();
const imageData = buffer => `data:image/png;base64,${buffer.toString('base64')}`;

test('尝试已确认平台的原图地址，保留原图回退、路径和签名地址', () => {
  assert.equal(policy.sources(url)[0], 'https://pics.17qcc.com/product/a.jpg');
  const zwd = 'https://img.17zwd.com/item.jpg?x-oss-process=image/resize,w_300';
  assert.deepEqual(policy.sources(zwd), ['https://img.17zwd.com/item.jpg', zwd]);
  const e3 = 'https://e3h.i.ximgs.net/9/2090329/20260729/20260729043345086_450.jpg';
  assert.deepEqual(policy.sources(e3), ['https://e3h.i.ximgs.net/9/2090329/20260729/20260729043345086.jpg', e3]);
  assert.match(policy.sources(url + '&version=2')[0], /version=2/);
  assert.deepEqual(policy.sources(url + '&Signature=secret'), [url + '&Signature=secret']);
  assert.deepEqual(policy.sources(url.replace('pics.17qcc.com', 'other.example')), [url.replace('pics.17qcc.com', 'other.example')]);
  assert.match(policy.qualityError(200, 200), /细节不足/);
  assert.equal(policy.qualityError(800, 800), '');
});

test('实际解码高清来源，缩小超大图并拒绝放大缩略图；回退不绕过质量检查', async t => {
  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34' }]);
  const big = await png(1800, 1800), small = await png(200, 200), calls = [];
  const image = await downloadCandidate(url, undefined, { transport: async target => {
    calls.push(String(target)); return new Response(big);
  } });
  assert.equal(calls.length, 1); assert.equal(calls[0], policy.sources(url)[0]);
  assert.equal(image.evidence.sourceWidth, 1800); assert.equal(image.evidence.width, 1600);
  assert.equal((await sharp(image.buffer).metadata()).width, 1600);
  assert.equal(image.evidence.upgraded, true);
  const e3Calls = [];
  const e3Image = await downloadCandidate('https://e3h.i.ximgs.net/9/2090329/20260729/20260729043345086_450.jpg', undefined, { transport: async target => {
    e3Calls.push(String(target)); return new Response(big);
  } });
  assert.equal(e3Calls.length, 1); assert.ok(e3Calls[0].endsWith('20260729043345086.jpg'));
  assert.equal(e3Image.evidence.sourceWidth, 1800); assert.equal(e3Image.evidence.upgraded, true);
  const e3FallbackCalls = [];
  const e3Fallback = await downloadCandidate('https://e3h.i.ximgs.net/9/2090329/20260729/20260729043345086_450.jpg', undefined, { transport: async target => {
    e3FallbackCalls.push(String(target)); return e3FallbackCalls.length === 1 ? new Response('', { status: 404 }) : new Response(big);
  } });
  assert.equal(e3FallbackCalls.length, 2); assert.ok(e3FallbackCalls[1].endsWith('_450.jpg'));
  assert.equal(e3Fallback.evidence.sourceWidth, 1800); assert.equal(e3Fallback.evidence.upgraded, false);
  const fallback = [];
  await assert.rejects(downloadCandidate(url, undefined, { transport: async target => {
    fallback.push(String(target)); return String(target).includes('?') ? new Response(small) : new Response('', { status: 404 });
  } }), /200×200.*未执行识别/);
  assert.equal(fallback.length, 2);
  await assert.rejects(validateQuery(imageData(small)), /原图.*细节不足/);
  await validateQuery(imageData(await png(800, 800)));
});

test('商品图集缩略图仅请求已接入平台，拒绝私网及外站跳转并安全缩小图片',async t=>{
  t.mock.method(dns,'lookup',async()=>[{address:'93.184.216.34'}]);
  const big=await png(1200,900),preview=await downloadImagePreview('https://pics.17qcc.com/gallery/one.jpg',undefined,{transport:async()=>new Response(big)});
  const metadata=await sharp(Buffer.from(preview.dataUrl.split(',')[1],'base64')).metadata();
  assert.deepEqual([metadata.width,metadata.height],[420,315]);assert.match(preview.dataUrl,/^data:image\/jpeg;base64,/);
  await assert.rejects(downloadImagePreview('https://gallery.attacker.example/image.jpg',undefined,{transport:async()=>new Response(big)}),/域名不在/);
  await assert.rejects(downloadImagePreview('https://pics.17qcc.com/gallery/one.jpg',undefined,{transport:async()=>new Response('',{status:302,headers:{location:'http://127.0.0.1/private.jpg'}})}),/HTTPS/);
});

test('高清获取的每次跳转都检查域名与公网地址，拒绝内网与过大内容', async t => {
  t.mock.method(dns, 'lookup', async () => [{ address: '127.0.0.1' }]);
  await assert.rejects(downloadCandidate('https://imgcdn.wsy.com/a.jpg'), /局域网/);
  dns.lookup.mock.mockImplementation(async () => [{ address: '93.184.216.34' }]);
  await assert.rejects(downloadCandidate('https://imgcdn.wsy.com/a.jpg', undefined, { transport: async () => new Response('', { status: 302, headers: { location: 'https://example.org/private.jpg' } }) }), /域名/);
  await assert.rejects(downloadCandidate('https://imgcdn.wsy.com/a.jpg', undefined, { transport: async () => new Response('x', { headers: { 'content-length': String(13 * 1024 * 1024) } }) }), /超过12MB/);
});

test('504不冒充鉴权错误，不透出服务端原文；截断输出不能当成功', async () => {
  const config = { endpoint: 'https://model.example/v1/chat/completions', model: 'vision', apiKey: 'private' };
  const batch = { query: imageData(Buffer.from('fixture')), candidates: [{ id: 'c1', dataUrl: imageData(Buffer.from('fixture')) }] };
  await assert.rejects(invokeModel(config, batch, { transport: async () => new Response('provider-secret', { status: 504 }) }), error => {
    assert.match(error.message, /504.*等待上游超时/); assert.doesNotMatch(error.message, /权限|Key|provider-secret/); return true;
  });
  await assert.rejects(invokeModel(config, batch, { transport: async () => new Response('provider-secret', { status: 401 }) }), /Key 无效/);
  await assert.rejects(invokeModel(config, batch, { transport: async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }) }), /截断/);
  await assert.rejects(invokeModel(config, batch, { transport: async () => { throw new DOMException('private', 'TimeoutError'); } }), /95秒/);
});

const judgment = id => ({ id, verdict: 'likely_same', score: 90, matches: ['领口相同', '口袋位置相同'], differences: [], uncertainties: [] });
test('504只标记实际失败的批次，后续尚未调用，成功结果保留且不自动重试', async () => {
  const history = []; let calls = 0;
  await compareCandidates({ query: 'fixture', items: Array.from({ length: 9 }, (_, id) => ({ id, imageUrl: 'https://imgcdn.wsy.com/a.jpg' })) }, async patch => history.push(structuredClone(patch)), {
    config: { model: 'vision', concurrency: 1 }, signal: new AbortController().signal, allowed: () => true,
    downloadImage: async () => ({ buffer: Buffer.from('picture'), dataUrl: 'fixture', evidence: { width: 800, height: 800 } }),
    saveImage: async () => 'a'.repeat(64), invoke: async (_, batch) => {
      if (++calls === 2) throw new Error(policy.httpError(504));
      return { model: 'vision', judgments: batch.candidates.map(entry => judgment(entry.id)) };
    }
  });
  const last = history.at(-1);
  assert.equal(calls, 2); assert.equal(last.status, 'partial'); assert.equal(last.compared, 4);
  assert.equal(last.failed, 4); assert.equal(last.notStarted, 1); assert.equal(last.completed, 8);
  assert.equal(last.progress, 88); assert.match(last.items[8].imageSimilarityError, /尚未提交/);
  assert.equal(last.items[8].imageSimilarityStatus, 'not_started');
  assert.equal(last.items[0].visualComparison.verdict, 'likely_same');
});

test('图片质量不合格不调用模型、不产生商品判定', async () => {
  let last;
  await compareCandidates({ query: 'fixture', items: [{ imageUrl: url }] }, async patch => { last = structuredClone(patch); }, {
    config: { model: 'vision', concurrency: 1 }, signal: new AbortController().signal, allowed: () => true,
    downloadImage: async () => { throw new Error(policy.qualityError(200, 200)); },
    saveImage: async () => assert.fail('不应保存'), invoke: async () => assert.fail('不应调用模型')
  });
  assert.equal(last.compared, 0); assert.equal(last.failed, 1);
  assert.equal(last.items[0].visualComparison, undefined); assert.match(last.items[0].imageSimilarityError, /细节不足/);
});

test('送模图片可原样取回，篡改后拒绝读取；重比创建新任务且不继承旧人工结论', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'product-image-evidence-'));
  let bridge; let calls = 0;
  const options = { dataDir, port: 0, processJob: async (job, update) => {
    calls++;
    const bytes = await png(800, 800);
    const items = await Promise.all(job.items.map(async (item, index) => ({ ...item, imageEvidence: { sha256: await bridge.storeCandidateImage(job.id, index, bytes), width: 800, height: 800 },
      imageSimilaritySource: 'qwen_multimodal_v1', visualComparison: judgment(`candidate_${index + 1}`) })));
    await update({ items, status: 'complete' });
  } };
  bridge = createDesktopBridge(options); const initial = await bridge.start();
  t.after(async () => { await bridge.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${initial.port}/v1/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Desktop-Token': initial.token },
    body: JSON.stringify({ query: imageData(await png(800, 800)), items: [{ id: '1', imageUrl: url }] }) });
  const { id } = await response.json();
  for (let i = 0; i < 100 && bridge.snapshot().jobs[0]?.status !== 'complete'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const item = bridge.snapshot().jobs[0].items[0];
  assert.equal(await bridge.candidateImage(id, 0), 'data:image/jpeg;base64,' + (await png(800, 800)).toString('base64'));
  await bridge.reviewItem(id, 0, { verdict: 'different', note: '袖口不同' }, review.signature(item));
  assert.equal(review.decision({ ...bridge.snapshot().jobs[0].items[0], imageEvidence: { sha256: 'b'.repeat(64) } }), null);
  const newJob = await bridge.retry(id, true);
  assert.notEqual(newJob.id, id); assert.equal(newJob.batchSize, 1); assert.equal(newJob.items[0].humanReview, undefined);
  assert.equal(bridge.snapshot().jobs.find(job => job.id === id).items[0].humanReview.verdict, 'different');
  await bridge.close(); bridge = createDesktopBridge(options); await bridge.start();
  assert.ok(await bridge.candidateImage(id, 0), '重启仍能读取送模证据');
  await fs.writeFile(path.join(dataDir, 'images', id, `0-${item.imageEvidence.sha256}.jpg`), 'tampered');
  await assert.rejects(bridge.candidateImage(id, 0), /校验失败/);
});
