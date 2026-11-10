const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const protocol = require('../vision-protocol');
const core = require('../core');
const picture = 'data:image/png;base64,aGVsbG8=';
const candidate = id => ({ id, dataUrl: picture });
const judgment = (id, extra = {}) => ({ id, verdict: 'likely_same', score: 91, matches: ['相同尖领', '左胸两个贴袋'], differences: [], uncertainties: [], ...extra });

test('多图请求把原图和四张候选图分开标号，不发送 API Key 或商品价格', () => {
  const config = protocol.configuration({ model: 'qwen3.7-plus', provider: 'dashscope', apiKey: 'sk-unit-test-credential' });
  const body = protocol.requestBody(config, { query: picture, candidates: ['c1', 'c2', 'c3', 'c4'].map(candidate) });
  assert.equal(body.messages[1].content.filter(part => part.type === 'image_url').length, 5);
  assert.equal(body.enable_thinking, false);
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(JSON.stringify(body).includes(config.apiKey), false);
  assert.match(body.messages[0].content, /领口|袖型|口袋/);
  assert.match(body.messages[0].content, /颜色、光线和拍摄背景不同通常不影响同款判断/);
  assert.match(body.messages[0].content, /不能单独判为 different/);
  assert.throws(() => protocol.validateBatch({ query: picture, candidates: ['1','2','3','4','5'].map(candidate) }), /1～4/);
  assert.throws(() => protocol.validateBatch({ query: picture, candidates: [candidate('1'), candidate('1')] }), /重复/);
  assert.throws(() => protocol.validateBatch({ query: 'https://example.com/private.jpg', candidates: [candidate('1')] }), /原图/);
});

test('候选图仍要求经过本机压缩的图片数据，不能让模型直接抓取任意地址', () => {
  assert.throws(() => protocol.validateBatch({ query: picture, candidates: [{ id: 'url', url: 'https://images.example/a.jpg' }] }), /图片无效/);
});

test('协议拒绝过大的 Base64 请求体，即使图片数量没有超过四张', () => {
  const config = protocol.configuration({ model: 'qwen3.7-plus', provider: 'dashscope', apiKey: 'sk-unit-test-credential' });
  const large = `data:image/jpeg;base64,${'A'.repeat(3 * 1024 * 1024)}`;
  assert.throws(() => protocol.serializeRequest(config, { query: large, candidates: [1, 2, 3, 4].map(id => ({ id: String(id), dataUrl: large })) }), /超过12MB/);
  assert.equal(protocol.maxRequestBytes, 12 * 1024 * 1024);
  assert.equal(protocol.maxCandidatesPerRun, 500);
});

test('Coding Plan Key 和接口不能配置到自定义扩展', () => {
  assert.throws(() => protocol.configuration({ model: 'qwen3.7-plus', provider: 'coding', apiKey: 'sk-unit-test-credential' }), /支持图片理解/);
  assert.throws(() => protocol.configuration({ model: 'qwen3.7-plus', provider: 'dashscope', apiKey: 'sk-sp-plan-credential' }), /标准 API Key/);
});

test('模型乱序响应按 ID 关联；缺失、重复、未知编号和非法分数拒绝整批', () => {
  const expected = [candidate('a'), candidate('b')];
  const parse = results => protocol.parseResults(JSON.stringify({ results }), expected);
  assert.equal(parse([judgment('b'), judgment('a')])[0].id, 'b');
  for (const results of [[judgment('a')], [judgment('a'), judgment('a')], [judgment('a'), judgment('c')], [judgment('a'), judgment('b', { score: 101 })]]) assert.throws(() => parse(results), /vision_response/);
  assert.throws(() => protocol.parseResults('not json', expected), /有效 JSON/);
});

test('关键细节不清或证据不足时不能保留肯定同款，无法判断没有排序分', () => {
  const parse = extra => protocol.parseResults(JSON.stringify({ results: [judgment('a', extra)] }), [candidate('a')])[0];
  assert.equal(parse({ matches: ['都是黑色'] }).verdict, 'similar');
  assert.equal(parse({ uncertainties: ['袖口被遮挡'] }).verdict, 'similar');
  assert.equal(parse({ verdict: 'uncertain', score: 99, uncertainties: ['袖口被遮挡'] }).score, null);
  assert.equal(parse({}).verdict, 'likely_same');
  assert.equal(parse({ matches: ['背景相同', '衣架相同'] }).verdict, 'uncertain');
  assert.equal(parse({ verdict: 'different', differences: ['背景完全不同'] }).verdict, 'uncertain');
});

test('已分析结果按款式类别优先，动态低分候选排除', () => {
  const items = [
    { id: 'wrong', verdict: 'different', score: 1 },
    { id: 'same', verdict: 'likely_same', score: .9 },
    { id: 'unknown', verdict: 'uncertain', score: null }
  ].map(item => ({ platform: 'wsy', id: item.id, price: 10, imageUrl: 'https://img.wsy.com/x.jpg', detailUrl: 'https://www.wsy.com/item.htm?id=1',
    imageSimilaritySource: protocol.algorithm, imageSimilarity: item.score, visualComparison: { verdict: item.verdict } }));
  assert.deepEqual(core.evaluate(items).kept.map(item => item.id), ['same', 'unknown', 'wrong']);
});

test('只有受信任的扩展工作台可以配置模型，回执不包含 Key', async () => {
  let listener, value;
  const session = { get: async () => ({ 'vision.credentials': value }), setAccessLevel: async () => {}, set: async item => { value = item['vision.credentials']; }, remove: async () => { value = undefined; } };
  const chrome = { runtime: { id: 'test', getURL: value => `chrome-extension://test/${value}`, onMessage: { addListener(fn) { listener = fn; } }, onConnect: { addListener() {} } }, storage: { session } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../vision-background.js'), 'utf8'), { FindVisionProtocol: protocol, chrome });
  const send = (message, sender) => new Promise(resolve => listener(message, sender, resolve));
  const config = { provider: 'dashscope', model: 'qwen3.7-plus', apiKey: 'sk-unit-test-credential' };
  const rejected = await send({ type: 'VISION_CONFIGURE', config }, { id: 'test', url: 'https://www.wsy.com/' });
  assert.equal(rejected.ok, false); assert.equal(value, undefined);
  const sender = { id: 'test', url: 'chrome-extension://test/workbench.html' };
  const accepted = await send({ type: 'VISION_CONFIGURE', config }, sender);
  assert.equal(accepted.configured, true); assert.equal(JSON.stringify(accepted).includes(config.apiKey), false);
  const status = await send({ type: 'VISION_STATUS' }, sender);
  assert.equal(status.model, config.model); assert.equal(JSON.stringify(status).includes(config.apiKey), false);
});
