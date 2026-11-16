const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../core.js');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/wsy-image-search.json'), 'utf8'));

test('真实响应夹具映射字段；实际收到数量与平台总量分开', () => {
  const parsed = core.parseWsy(fixture);
  assert.equal(parsed.received, 4); assert.equal(parsed.total, 97);
  assert.equal(parsed.items[0].detailUrl, 'https://www.wsy.com/item.htm?id=25095312');
  assert.equal(parsed.items[0].price, 60); assert.equal(parsed.items[0].supplierId, '2834466');
  assert.equal(parsed.items[0].similarity, .97); assert.equal(parsed.items[0].similaritySource, 'platform');
});
test('网商园候选保留平台返回的发货地字段', () => {
  const item = core.parseWsy({ code: 1, list: [{ mid: 1, goodsid: 'D2603', price: 42, imgUrl: 'https://img.wsy.com/a.jpg', address: '江苏苏州' }] }).items[0];
  assert.equal(item.address, '江苏苏州');
  const fallback = core.parseWsy({ code: 1, list: [{ mid: 2, price: 42, imgUrl: 'https://img.wsy.com/b.jpg', shippingAddress: '浙江杭州' }] }).items[0];
  assert.equal(fallback.address, '浙江杭州');
});
test('无成本不按价格和相似度淘汰；没有确定同款标签', () => {
  const parsed = core.parseWsy(fixture);
  const result = core.evaluate(parsed.items, { mode: 'select', baseline: 1, reduction: 5 });
  assert.equal(result.kept.length, 4); assert.equal(result.excluded.length, 0);
  assert.ok(result.kept.every(item => item.saving === null && !('tier' in item)));
});
test('成本优先：至少省5元；相似但高价仍淘汰；空价格不变成0', () => {
  const items = core.parseWsy(fixture).items;
  const result = core.evaluate(items, { mode: 'optimize', baseline: 65, reduction: 5 });
  assert.deepEqual(result.kept.map(item => item.price), [60, 59]);
  assert.equal(result.excluded.length, 2);
  assert.ok(result.excluded.every(item => item.reasons[0].includes('降本')));
  assert.equal(core.number(null), null); assert.equal(core.number(''), null); assert.equal(core.number(Infinity), null);
});
test('缺失图/ID/价格/链接及重复记录分开诊断', () => {
  const base = core.parseWsy(fixture).items[0];
  const result = core.evaluate([base, base, { ...base, id: '', detailUrl: '' }, { ...base, id: 'x', price: null }, { ...base, id: 'y', imageUrl: '' }]);
  assert.equal(result.kept.length, 1); assert.equal(result.excluded.length, 4);
  assert.match(result.excluded[0].reasons.join(), /重复/);
  assert.match(result.excluded[1].reasons.join(), /ID/);
  assert.match(result.excluded[2].reasons.join(), /价格/);
  assert.match(result.excluded[3].reasons.join(), /图片/);
});
test('货号全等；价格相等不达降本；输入必须有效', () => {
  const item = core.parseWsy(fixture).items[1];
  assert.equal(core.evaluate([item], { goodsId: '8650' }).kept[0].goodsMatch, false);
  assert.equal(core.evaluate([item], { goodsId: ' 18650 ' }).kept[0].goodsMatch, true);
  assert.equal(core.evaluate([item], { mode: 'optimize', baseline: 59, reduction: 0 }).kept.length, 0);
  assert.throws(() => core.evaluate([], { mode: 'optimize', baseline: null }), /成本/);
  assert.throws(() => core.evaluate([], { mode: 'optimize', baseline: 59, reduction: -1 }), /负数/);
});
test('接口异常不伪装为零结果，非法图片链接不进入候选', () => {
  assert.throws(() => core.parseWsy({ code: 0, list: [] }), /response_code/);
  assert.throws(() => core.parseWsy({ code: 1 }), /缺少 list/);
  assert.throws(() => core.parseWsy(null), /响应不是/);
  const item = core.parseWsy({ code: 1, list: [{ mid: 1, price: '12', imgUrl: 'javascript:alert(1)', probability: 99 }] }).items[0];
  assert.equal(item.imageUrl, ''); assert.equal(item.similarity, null);
  assert.equal(core.evaluate([item]).kept.length, 0);
});

test('金钱按分比较：精确边界不漏掉，额外小数不四舍五入放行', () => {
  const item = core.parseWsy(fixture).items[0];
  assert.equal(core.evaluate([{ ...item, price: .02 }], { mode: 'optimize', baseline: .03, reduction: .01 }).kept.length, 1);
  assert.equal(core.evaluate([{ ...item, price: 60.004 }], { mode: 'optimize', baseline: 65, reduction: 5 }).kept.length, 0);
  assert.equal(core.evaluate([{ ...item, price: 60.01 }], { mode: 'optimize', baseline: 65, reduction: 5 }).kept.length, 0);
  assert.equal(core.evaluate([{ ...item, price: 60 }], { mode: 'optimize', baseline: 65, reduction: 5 }).kept.length, 1);
  assert.throws(() => core.evaluate([], { mode: 'optimize', baseline: 65.001 }), /两位小数/);
  assert.equal(core.number(true), null); assert.equal(core.number([]), null);
  assert.equal(core.evaluate([{ ...item, price: true }]).kept.length, 0);
  assert.equal(core.parseWsy({ code: 1, list: [{ mid: 1, price: 10, imgUrl: '   ' }] }).items[0].imageUrl, '');
});
