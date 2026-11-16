const test = require('node:test');
const assert = require('node:assert/strict');
const review = require('../review');
const core = require('../core');

function candidate(id = '1', verdict = 'likely_same') {
  return { id, platform: 'wsy', price: 20, imageUrl: `https://imgcdn.wsy.com/${id}.png`, detailUrl: `https://www.wsy.com/item.htm?id=${id}`,
    imageSimilaritySource: 'qwen_multimodal_v1', imageSimilarityEngine: 'qwen3.7-plus', imageSimilarity: 0.9,
    visualComparison: { verdict, score: verdict === 'uncertain' ? null : 90, matches: ['领口一致'], differences: [], uncertainties: [] } };
}

test('默认人工审核拦住待审建议，直出允许模型结论，两种模式均以有效人工结论为准', () => {
  const original = candidate();
  assert.equal(review.effective(original), null);
  assert.equal(review.effective(original, 'direct'), 'likely_same');
  assert.equal(review.mode('unknown'), 'manual');
  assert.throws(() => review.apply(original, { verdict: 'invalid' }), /有效/);
  const corrected = review.apply(original, { verdict: 'different' });
  assert.equal(review.effective(corrected), 'different');
  assert.equal(review.effective(corrected, 'direct'), 'different');
  assert.equal(corrected.visualComparison, original.visualComparison);
  assert.equal(original.humanReview, undefined);
  assert.equal(corrected.visualComparison.verdict, 'likely_same');
  const agreed = review.apply(candidate('2'), { verdict: 'likely_same', note: '' });
  const unavailable = { id: '3', imageSimilarityStatus: 'unavailable' };
  assert.throws(() => review.apply(unavailable, { verdict: 'similar' }), /尚未完成/);
  assert.deepEqual(review.summary([original, corrected, agreed, unavailable]), { compared: 3, pending: 1, reviewed: 2, confirmed: 1, manualExcluded: 1, scoreExcluded: 0, agreed: 1, corrected: 1, final: 2, unavailable: 1, excluded: 1 });
  assert.equal(review.summary([original, corrected, agreed, unavailable], 'direct').final, 3);
  assert.equal(review.matchesFilter(original, 'pending', 'manual'), true);
  assert.equal(review.matchesFilter(original, 'final', 'manual'), false);
  assert.equal(review.matchesFilter(corrected, 'pending', 'direct'), false);
  assert.equal(review.matchesFilter(unavailable, 'final', 'direct'), false);
});

test('更换图片、商品或模型响应使旧审核失效，JSON恢复后的原始审核仍有效', () => {
  const item = review.apply(candidate(), { verdict: 'similar', note: '仅花纹接近' });
  assert.equal(review.effective(JSON.parse(JSON.stringify(item))), 'similar');
  const reordered = { ...item, visualComparison: Object.fromEntries(Object.entries(item.visualComparison).reverse()) };
  assert.equal(review.effective(reordered), 'similar', '存储恢复的对象字段顺序不能使有效审核丢失');
  for (const change of [{ id: 'other' }, { imageUrl: 'https://imgcdn.wsy.com/new.png' }, { imageSimilarity: 91 },
    { imageSimilarityEngine: 'new-model' }, { visualComparison: { ...item.visualComparison, differences: ['新证据'] } },
    { imageSimilaritySource: 'untrusted' }]) {
    assert.equal(review.effective({ ...item, ...change }), null);
  }
  assert.equal(review.decision({ ...item, humanReview: { ...item.humanReview, reviewedAt: 'invalid' } }), null);
  assert.equal(review.decision({ ...item, humanReview: { ...item.humanReview, note: '' } }).verdict, 'similar');
});

test('人工纠正参与结果排序，模型原始判断仍保留以便回看', () => {
  const corrected = review.apply(candidate('1'), { verdict: 'different', note: '袖型不同' });
  const other = candidate('2', 'similar');
  const { kept } = core.evaluate([corrected, other]);
  assert.deepEqual(kept.map(item => item.id), ['2', '1']);
  assert.equal(kept[1].visualComparison.verdict, 'likely_same');
});

test('只纠正匹配分也生效：同类排序、统计和最终分数使用人工值，备注不改变模型', () => {
  const original = candidate('1');
  assert.equal(review.modelScore(original), 90);
  assert.equal(review.effectiveScore(original), null);
  assert.equal(review.effectiveScore(original, 'direct'), 90);
  const corrected = review.apply(original, { verdict: 'likely_same', score: 40, note: '' });
  const other = { ...candidate('2'), imageSimilarity: 0.88, visualComparison: { ...candidate('2').visualComparison, score: 88 } };
  assert.equal(review.effectiveScore(corrected), 40);
  assert.equal(review.effectiveScore(corrected, 'direct'), 40);
  assert.equal(review.corrected(corrected), true);
  assert.equal(review.summary([corrected]).corrected, 1);
  assert.deepEqual(core.evaluate([corrected, other]).kept.map(item => item.id), ['2']);
  assert.equal(core.evaluate([corrected, other]).excluded[0].scoreExcluded, true);
  assert.equal(corrected.visualComparison.score, 90);
  assert.equal(corrected.imageSimilarity, 0.9);
  const agreed = review.apply(original, { verdict: 'likely_same', score: 90, note: '人工检查了领口' });
  assert.equal(review.summary([agreed]).agreed, 1);
  assert.equal(review.effectiveScore(agreed), 90);
  const legacy = JSON.parse(JSON.stringify(agreed)); delete legacy.humanReview.score;
  assert.ok(review.decision(legacy));
  assert.equal(review.effectiveScore(legacy), 90, '旧审核没有分数时沿用模型分数');
  const changedModel = { ...corrected, visualComparison: { ...corrected.visualComparison, score: 95 } };
  assert.equal(review.effectiveScore(changedModel), null, '模型结果变更必须重新核对');
});

test('人工匹配分边界与无法判断：不接受空值、越界或非数字，不强行给看不清的图评分', () => {
  for (const score of [-1, 101, NaN, Infinity, '60', null]) {
    assert.throws(() => review.apply(candidate(), { verdict: 'likely_same', score, note: '' }), /0～100/);
  }
  for (const score of [0, 100, 65.5]) {
    const item = review.apply(candidate(), { verdict: 'likely_same', score, note: '' });
    assert.equal(review.effectiveScore(item), score);
    assert.equal(review.decision({ ...item, humanReview: { ...item.humanReview, score: -1 } }), null);
  }
  const uncertain = review.apply(candidate(), { verdict: 'uncertain', score: 90, note: '图片看不清' });
  assert.equal(review.effective(uncertain), 'uncertain');
  assert.equal(review.effectiveScore(uncertain), null);
  assert.equal(review.modelScore(candidate('2', 'uncertain')), null);
});

test('整批动态排除线按最高模型分调整，并优先排序同款建议类别', () => {
  const item = (id, score, verdict = 'similar') => ({ ...candidate(id, verdict), imageSimilarity: score / 100,
    visualComparison: { ...candidate(id, verdict).visualComparison, score } });
  const high = [item('90', 92), item('85', 85), item('70', 70), item('50', 50)];
  assert.equal(review.exclusionThreshold(high), 85);
  assert.deepEqual(high.map(value => review.belowThreshold(value, high)), [false, false, true, true]);
  const medium = [item('85', 85), item('70', 70), item('69', 69)];
  assert.equal(review.exclusionThreshold(medium), 70);
  assert.deepEqual(medium.map(value => review.belowThreshold(value, medium)), [false, false, true]);
  const low = [item('84', 84), item('50', 50)];
  assert.equal(review.exclusionThreshold(low), 50);
  const ranked = [item('same', 80, 'likely_same'), item('similar', 100, 'similar'), item('unknown', 99, 'uncertain')].sort(review.compare);
  assert.deepEqual(ranked.map(value => value.id), ['same', 'similar', 'unknown']);
  assert.equal(review.matchesFilter({ id: 'not-started' }, 'recommended', 'manual', high), false);
  assert.equal(review.matchesFilter({ id: 'not-started' }, 'retry', 'manual', high), true);
  const corrected = review.apply(high[3], { verdict: 'likely_same', note: '结构一致，人工确认' });
  assert.equal(review.belowThreshold(corrected, high), false, '直接确认同款应能纠正模型低分，不要求人工重新评分');
});

test('高相似候选跨平台展示价格，不要求货号相同或伪造人工同款确认',()=>{
  const item=(id,platform,price,score,verdict='similar',goodsId='2086')=>({...candidate(id,verdict),platform,goodsId,price,detailUrl:`https://${platform}.example/item/${id}`,visualComparison:{...candidate(id,verdict).visualComparison,score}});
  const rows=[item('wsy','wsy',150,96),item('qcc','qcc',145,94,'similar','QCC-2086'),item('other','e3hui',138,80,'similar','E3-77'),item('excluded','zwd',120,99,'different')];
  const groups=review.highSimilarityPriceGroups(rows);
  assert.equal(groups.length,1);assert.equal(groups[0].goodsId,null);assert.deepEqual(groups[0].items.map(row=>[row.item.platform,row.item.goodsId,row.price]),[['qcc','QCC-2086',145],['wsy','2086',150]]);
  assert.equal(review.decision(groups[0].items[0].item),null);
  const reviewedDifferent=review.apply(item('manual-different','e3hui',130,97),{verdict:'different',note:'领口不同'});
  assert.equal(review.highSimilarityPriceGroups([rows[0],rows[1],reviewedDifferent])[0].items.length,2);
  const reviewedLow=review.apply(item('manual-low','e3hui',130,97),{verdict:'likely_same',score:70,note:'关键款式细节仍需核对'});
  assert.equal(review.highSimilarityPriceGroups([rows[0],rows[1],reviewedLow])[0].items.length,2,'人工将匹配分降到阈值以下后，不纳入高相似比价');
  assert.deepEqual(review.highSimilarityPriceGroups([rows[0]]),[],'只有一条可比候选时不显示价格比较区');
});

test('淘宝先85分及以上同款建议、再销量；不同款高销量也不能排前，边界85包含在前组',()=>{
  const item=(id,score,verdict,salesText)=>({...candidate(id,verdict),platform:'taobao',salesText,visualComparison:{...candidate(id,verdict).visualComparison,score}});
  const rows=[item('different-high-sales',99,'different','100万+人付款'),item('low',84,'likely_same','10万+人付款'),item('high-score',99,'likely_same','10人付款'),item('boundary',85,'similar','100人付款'),item('unknown',null,'uncertain','20万+人付款'),item('missing-sales',95,'similar','')];
  const sorted=[...rows].sort(review.compare);
  assert.deepEqual(sorted.map(row=>row.id),['boundary','high-score','missing-sales','low','unknown','different-high-sales']);
  assert.deepEqual([...rows].sort(review.compareTaobao).map(row=>row.id),sorted.map(row=>row.id));
  assert.equal(rows[0].visualComparison.verdict,'different');assert.equal(review.decision(rows[1]),null,'排序不修改同款结论');
  const rejected=review.apply(item('rejected',99,'likely_same','200万+人付款'),{verdict:'different',note:'人工排除'});
  const confirmed=review.apply(item('confirmed',60,'different','1人付款'),{verdict:'likely_same',note:'人工确认结构一致'});
  const uncertain=review.apply(item('human-uncertain',99,'likely_same','300万+人付款'),{verdict:'uncertain',note:'看不清'});
  assert.deepEqual([rejected,uncertain,rows[3],confirmed].sort(review.compare).map(row=>row.id),['confirmed','boundary','human-uncertain','rejected']);
  const lowered=review.apply(item('lowered',99,'similar','10万+人付款'),{verdict:'similar',score:84,note:'人工下调参考分'});
  assert.equal(review.taobaoPriority(lowered),2);
});

test('淘宝未识别仍按销量排序，相同销量按分数；供应商款式排序沿用原规则',()=>{
  const raw=[{id:'unknown',platform:'taobao'},{id:'low',platform:'taobao',salesText:'100人付款'},{id:'high',platform:'taobao',salesText:'1万+人付款'}];
  assert.deepEqual(raw.sort(review.compare).map(row=>row.id),['high','low','unknown']);
  const same={...candidate('same','likely_same'),salesText:'1人付款',visualComparison:{...candidate().visualComparison,score:80}},similar={...candidate('similar','similar'),salesText:'1万+人付款',visualComparison:{...candidate().visualComparison,verdict:'similar',score:99}};
  assert.deepEqual([similar,same].sort(review.compare).map(row=>row.id),['same','similar']);
});
