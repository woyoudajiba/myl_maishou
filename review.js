(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FindReview = api;
})(globalThis, function () {
  const sales=typeof module==='object'&&module.exports?require('./taobao-sales'):globalThis.TaobaoSales;
  const labels = Object.freeze({ likely_same: '疑似同款', similar: '相似款', different: '明显不同', uncertain: '无法判断' });
  const mode = value => value === 'direct' ? 'direct' : 'manual';
  const comparison = item => item?.imageSimilaritySource === 'qwen_multimodal_v1' && Object.hasOwn(labels, item.visualComparison?.verdict) ? item.visualComparison : null;
  const validScore = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
  function modelScore(item) {
    const model = comparison(item);
    if (!model || model.verdict === 'uncertain') return null;
    if (validScore(model.score)) return model.score;
    return typeof item.imageSimilarity === 'number' && item.imageSimilarity >= 0 && item.imageSimilarity <= 1 ? item.imageSimilarity * 100 : null;
  }
  // Bind a decision to this exact candidate and model response. Re-analysis or
  // replacing an image must never silently inherit a previous human decision.
  const signature = item => {
    const model = comparison(item);
    // chrome.storage may restore object keys in another order. Bind the
    // decision to model values in a fixed order, not object serialization order.
    const values = [item.platform, item.id, item.imageUrl, item.detailUrl, item.imageSimilarityEngine, item.imageSimilarity,
      model ? [model.id, model.verdict, model.score, model.matches, model.differences, model.uncertainties] : null];
    if (item.imageEvidence?.sha256) values.push(item.imageEvidence.sha256);
    return JSON.stringify(values);
  };
  function decision(item) {
    const review = item?.humanReview;
    return comparison(item) && review && Object.hasOwn(labels, review.verdict) && typeof review.note === 'string' && review.note.length <= 500
      && typeof review.reviewedAt === 'string' && Number.isFinite(Date.parse(review.reviewedAt)) && review.signature === signature(item)
      && (!Object.hasOwn(review, 'score') || (review.verdict === 'uncertain' ? review.score === null : validScore(review.score))) ? review : null;
  }
  function apply(item, input) {
    if (!comparison(item)) throw new Error('商品尚未完成模型比对，不能审核');
    if (!input || !Object.hasOwn(labels, input.verdict)) throw new Error('请选择有效的人工结论');
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    if (note.length > 500) throw new Error('审核备注最多 500 字');
    const score = input.verdict === 'uncertain' ? null : Object.hasOwn(input, 'score') ? input.score : modelScore(item);
    if (input.verdict !== 'uncertain' && (Object.hasOwn(input, 'score') || score !== null) && !validScore(score)) throw new Error('人工匹配分须为 0～100 的数字；看不清时请选择无法判断');
    return { ...item, humanReview: { verdict: input.verdict, ...(Object.hasOwn(input, 'score') || input.verdict === 'uncertain' ? { score } : {}), note, signature: signature(item), reviewedAt: new Date().toISOString() } };
  }
  function effective(item, reviewMode = 'manual') {
    const human = decision(item);
    if (human) return human.verdict;
    return mode(reviewMode) === 'direct' ? comparison(item)?.verdict || null : null;
  }
  function effectiveScore(item, reviewMode = 'manual') {
    const human = decision(item);
    if (human) return human.verdict === 'uncertain' ? null : Object.hasOwn(human, 'score') ? human.score : modelScore(item);
    return mode(reviewMode) === 'direct' ? modelScore(item) : null;
  }
  const corrected = item => {
    const human = decision(item);
    return !!human && (human.verdict !== comparison(item).verdict || Object.hasOwn(human, 'score') && human.score !== modelScore(item));
  };
  const minimumScore = 50;
  function exclusionThreshold(items) {
    const highest = (Array.isArray(items) ? items : []).map(modelScore).filter(validScore).reduce((max, score) => Math.max(max, score), -1);
    if (highest >= 90) return 85;
    if (highest >= 85) return 70;
    return minimumScore;
  }
  // Pending manual review uses the model's draft score for display/filtering,
  // while effectiveScore continues to require a real human confirmation.
  const rankingScore = item => decision(item) ? effectiveScore(item) : modelScore(item);
  const belowThreshold = (item, items) => {
    const human = decision(item), score = rankingScore(item);
    if (human && !Object.hasOwn(human, 'score')) return false;
    const threshold = typeof items === 'number' ? items : Array.isArray(items) ? exclusionThreshold(items) : minimumScore;
    return score !== null && (threshold === minimumScore ? score <= threshold : score < threshold);
  };
  const excluded = (item, items) => belowThreshold(item, items) || (decision(item)?.verdict || comparison(item)?.verdict) === 'different';
  const thresholdText = threshold => `${threshold} 分${threshold === minimumScore ? '及以下' : '以下'}`;
  function taobaoPriority(item) {
    const human=decision(item),verdict=human?.verdict||comparison(item)?.verdict,score=rankingScore(item);
    if(human?.verdict==='likely_same')return 0;
    if(human?.verdict==='different')return 5;
    if(verdict==='different')return 4;
    if(['likely_same','similar'].includes(verdict))return score!==null&&score>=85?1:2;
    return 3;
  }
  function compareTaobao(a,b) {
    return taobaoPriority(a)-taobaoPriority(b)||(sales?.compare(a,b)||0)
      ||(rankingScore(b)??-1)-(rankingScore(a)??-1);
  }
  function compare(a, b, reviewMode = 'manual') {
    if(a.platform==='taobao'&&b.platform==='taobao')return compareTaobao(a,b);
    const rank = item => ({ likely_same: 4, similar: 3, uncertain: 2, different: 0 }[effective(item, reviewMode) || comparison(item)?.verdict] ?? 1);
    const score = item => rankingScore(item) ?? -1;
    return rank(b) - rank(a) || score(b) - score(a);
  }
  const scoreText = value => validScore(value) ? `${Number(value.toFixed(2))}/100` : '无法评分';
  function scoreStatus(item, reviewMode = 'manual') {
    if (!comparison(item)) return '';
    const original = `模型匹配分：${scoreText(modelScore(item))}`;
    return `${original} · ${decision(item) ? '人工已核对' + (Object.hasOwn(decision(item), 'score') ? ' · 人工参考分：' + scoreText(effectiveScore(item, reviewMode)) : '') : '仅供排序 · 待人工核对'}`;
  }
  function summary(items, reviewMode = 'manual') {
    const result = { compared: 0, pending: 0, reviewed: 0, confirmed: 0, manualExcluded: 0, scoreExcluded: 0, agreed: 0, corrected: 0, final: 0, unavailable: 0, excluded: 0 };
    const threshold = exclusionThreshold(items);
    for (const item of items) {
      if (!comparison(item)) { result.unavailable++; continue; }
      result.compared++;
      const human = decision(item);
      const scoreExcluded = belowThreshold(item, threshold), manualExcluded = human?.verdict === 'different';
      if (scoreExcluded) result.scoreExcluded++;
      if (manualExcluded) result.manualExcluded++;
      if (excluded(item, threshold)) result.excluded++;
      if (human) {
        result.reviewed++; result[corrected(item) ? 'corrected' : 'agreed']++;
        if (human.verdict === 'likely_same') result.confirmed++;
      } else if (!excluded(item, threshold)) result.pending++;
      if (effective(item, reviewMode)) result.final++;
    }
    return result;
  }
  function highSimilarityPriceGroups(items, minimumScore = 90) {
    const rows = [];
    for (const item of Array.isArray(items) ? items : []) {
      const score = rankingScore(item), verdict = comparison(item)?.verdict, price = Number(item?.price);
      if (score === null || score < minimumScore || !['likely_same','similar'].includes(verdict)
        || ['different','uncertain'].includes(decision(item)?.verdict) || !Number.isFinite(price) || price <= 0 || !item.detailUrl) continue;
      if (!rows.some(row => row.item.platform === item.platform && row.item.detailUrl === item.detailUrl)) rows.push({ item, price, score });
    }
    if (rows.length < 2) return [];
    return [{ goodsId: null, items: rows.sort((a, b) => a.price - b.price || b.score - a.score) }];
  }
  function text(items, reviewMode) {
    const stats = summary(items, reviewMode);
    const threshold = exclusionThreshold(items);
    return `模型建议：${stats.compared} 条 · 人工确认同款：${stats.confirmed} 条 · 待人工核对：${stats.pending} 条 · 人工已处理 ${stats.reviewed} 条 · 采纳模型 ${stats.agreed} 条，纠正 ${stats.corrected} 条 · ${thresholdText(threshold)}自动排除：${stats.scoreExcluded} 条${mode(reviewMode) === 'direct' ? '（模型建议仍为暂定结论）' : ''}`;
  }
  function status(item, reviewMode) {
    const human = decision(item);
    if (human) return `人工${corrected(item) ? '纠正' : '确认'}：${labels[human.verdict]}`;
    if (!comparison(item)) return '未完成识别';
    return mode(reviewMode) === 'manual' ? '待人工核对 · 模型建议尚未确认' : `模型暂定建议：${labels[item.visualComparison.verdict]}`;
  }
  const matchesFilter = (item, filter, reviewMode, items) => filter === 'excluded' ? excluded(item, items) : filter === 'retry' ? !comparison(item)
    : filter === 'all' ? true : excluded(item, items) ? false
    : filter === 'pending' ? !!comparison(item) && !decision(item)
    : filter === 'recommended' ? !!comparison(item) && !decision(item) && ['likely_same', 'similar', 'uncertain'].includes(comparison(item).verdict)
    : filter === 'final' ? !!effective(item, reviewMode) : true;
  return { labels, mode, comparison, modelScore, signature, decision, apply, effective, effectiveScore, corrected, compare, compareTaobao, taobaoPriority, scoreText, scoreStatus, summary, highSimilarityPriceGroups, text, status, matchesFilter, minimumScore, exclusionThreshold, thresholdText, excluded, rankingScore, belowThreshold };
});
