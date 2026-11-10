(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./review') : root.FindReview);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FindCore = api;
})(globalThis, function (review) {
  const number = value => !['string', 'number'].includes(typeof value) || String(value).trim() === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const cents = value => {
    const amount = number(value);
    if (amount == null) return null;
    const scaled = amount * 100, rounded = Math.round(scaled);
    return Number.isSafeInteger(rounded) && Math.abs(scaled - rounded) < 1e-7 ? rounded : null;
  };
  const norm = value => String(value ?? '').trim().replace(/\s+/g, '').toUpperCase();
  const httpUrl = value => {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return '';
    try { const url = new URL(raw, 'https://www.wsy.com/'); return /^https?:$/.test(url.protocol) ? url.href : ''; } catch { return ''; }
  };
  function parseWsy(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('response_parse：响应不是商品对象');
    if (json.code !== 1) throw new Error(`response_code：接口 code=${json.code ?? '缺失'}；${String(json.msg || json.message || '平台未返回成功结果').slice(0, 180)}`);
    if (!Array.isArray(json.list)) throw new Error('response_parse：缺少 list 数组');
    const items = json.list.map(raw => {
      const item = raw && typeof raw === 'object' ? raw : {};
      const id = String(item.mid ?? '').trim();
      const similarity = number(item.probability);
      return {
        platform: 'wsy', id, goodsId: String(item.goodsid ?? ''), title: String(item.title ?? ''),
        price: number(item.price), imageUrl: httpUrl(item.imgUrl),
        detailUrl: /^\d+$/.test(id) ? `https://www.wsy.com/item.htm?id=${id}` : '',
        supplierId: String(item.uid ?? ''), shopName: String(item.shopid ?? ''),
        address: String(item.address ?? ''), category: String(item.cid_name ?? ''),
        similarity: similarity != null && similarity >= 0 && similarity <= 1 ? similarity : null,
        similaritySource: similarity != null && similarity >= 0 && similarity <= 1 ? 'platform' : 'none'
      };
    });
    return { items, total: number(json.count), received: items.length };
  }
  function evaluate(items, { mode = 'select', baseline = null, reduction = 5, goodsId = '', reviewMode = 'manual' } = {}) {
    const costCents = cents(baseline), deltaCents = cents(reduction);
    const cost = costCents == null ? null : costCents / 100, delta = deltaCents == null ? null : deltaCents / 100;
    if (!['select', 'optimize'].includes(mode)) throw new Error('input：未知模式');
    if (mode === 'optimize' && (cost == null || cost <= 0)) throw new Error('input：降本模式需要大于 0 的当前成本，最多两位小数');
    if (mode === 'optimize' && (delta == null || delta < 0)) throw new Error('input：降本金额不能为负数或空值，最多两位小数');
    const kept = [], excluded = [], seen = new Set();
    const scoreThreshold = review?.exclusionThreshold(items) ?? review?.minimumScore ?? 50;
    for (const item of items) {
      const priceCents = cents(item.price), price = priceCents == null ? null : priceCents / 100;
      const savedCents = mode === 'optimize' && priceCents != null ? costCents - priceCents : null;
      const saving = savedCents == null ? null : savedCents / 100;
      const candidate = { ...item, price, saving, goodsMatch: !!norm(goodsId) && norm(goodsId) === norm(item.goodsId) };
      const reasons = [];
      if (!item.id) reasons.push('缺少商品 ID');
      if (!httpUrl(item.detailUrl)) reasons.push('缺少有效详情链接');
      if (!httpUrl(item.imageUrl)) reasons.push('缺少有效商品图片地址');
      if (price == null || price <= 0) reasons.push('价格缺失或无效');
      else if (mode === 'optimize' && (savedCents <= 0 || savedCents < deltaCents)) reasons.push(`未达到降本条件：当前 ${cost} 元，采购价 ${price} 元，至少省 ${delta} 元`);
      const key = `${item.platform}:${item.id}`;
      if (item.id && seen.has(key)) reasons.push('重复商品');
      if (!reasons.length) {
        seen.add(key);
        if (review?.belowThreshold(candidate, items)) excluded.push({ ...candidate, scoreExcluded: true, reasons: [`匹配分为${scoreThreshold}分及以下：` + review.scoreText(review.rankingScore(candidate))] });
        else kept.push(candidate);
      }
      else excluded.push({ ...candidate, reasons });
    }
    // Use confirmed human scores first, otherwise the model's draft score.
    kept.sort((a, b) => (review?.compare(a, b, reviewMode) || 0)
      || (review?.comparison(a) || review?.comparison(b) ? 0 : (b.imageSimilarity ?? -1) - (a.imageSimilarity ?? -1))
      || Number(b.goodsMatch) - Number(a.goodsMatch) || (b.similarity ?? -1) - (a.similarity ?? -1) || a.price - b.price);
    return { kept, excluded, mode, target: mode === 'optimize' ? (costCents - deltaCents) / 100 : null };
  }
  return { number, norm, parseWsy, evaluate };
});
