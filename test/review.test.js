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
