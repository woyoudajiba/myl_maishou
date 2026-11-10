// The supplier is the source of supply facts; the marketplace is the source
// of marketing pictures. Keep both evidence records instead of merging them.
const supplierDomains = { wsy: ['wsy.com'], zwd: ['17zwd.com'], qcc: ['17qcc.com'], e3hui: ['e3hui.com','e3hui.cn'] };
const within = (host, domains) => domains.some(domain => host === domain || host.endsWith('.' + domain));
function sourceUrl(value, domains) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && within(url.hostname, domains) ? url.href : '';
  } catch { return ''; }
}
function taobaoUrl(value) {
  try {
    const url = new URL(value);
    if (!sourceUrl(value, ['taobao.com','tmall.com']) || !['item.taobao.com','detail.tmall.com'].includes(url.hostname) || url.pathname !== '/item.htm' || !/^\d{5,25}$/.test(url.searchParams.get('id') || '')) return '';
    return `${url.origin}/item.htm?id=${url.searchParams.get('id')}`;
  } catch { return ''; }
}
const imageUrls = values => [...new Set((Array.isArray(values) ? values : []).filter(value => sourceUrl(value, ['wsy.com','17zwd.com','17qcc.com','e3hui.com','e3hui.cn','ximgs.net','alicdn.com','ecombdimg.com','byteimg.com','douyinpic.com'])))].slice(0,60);
const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
function buildBuyerSource(item, marketplace = null) {
  if (!item || !supplierDomains[item.platform]) throw new Error('请选择已支持的供应商平台商品');
  const url = sourceUrl(item.detailUrl, supplierDomains[item.platform]);
  if (!url) throw new Error('供应商商品链接无效');
  const details = item.productDetails;
  if (!details || !details.collectedAt) throw new Error('请先采集人工确认商品的供应商资料');
  const supplier = {
    platform: item.platform, url, collectedAt: details.collectedAt,
    title: clean(details.title || item.title,1000), articleNo: clean(details.sku || item.goodsId,200),
    shopName: clean(details.shopName || item.shopName,300),
    listedPrice: Number.isFinite(details.price) && details.price > 0 ? details.price : null,
    candidateListingPrice: Number.isFinite(item.price) && item.price > 0 ? item.price : null,
    priceType: ['supply','tiered'].includes(details.priceType) ? details.priceType : 'supply',
    priceTiers: Array.isArray(details.priceTiers) ? details.priceTiers.slice(0,40) : [],
    resaleFloor: Number.isFinite(details.resaleFloor) && details.resaleFloor > 0 ? details.resaleFloor : null,
    colors: Array.isArray(details.colors) ? details.colors.slice(0,80) : [],
    sizes: Array.isArray(details.sizes) ? details.sizes.slice(0,80) : [],
    quality: details.quality || null,
    description: clean(details.description,6000), visibleText: clean(details.visibleText,24000),
    attributes: (Array.isArray(details.attributes) ? details.attributes : []).filter(value=>typeof value==='string').slice(0,80).map(value=>value.slice(0,300)),
    images: imageUrls(details.images),
    imageGroups: Object.fromEntries(['main','colors','details'].map(key=>[key,imageUrls(details.imageGroups?.[key]||[])]))
  };
  let marketing = null;
  if (marketplace) {
    const target = taobaoUrl(marketplace.url);
    if (!target) throw new Error('套图来源需要包含商品 ID 的完整淘宝或天猫链接');
    marketing = { platform: new URL(target).hostname === 'detail.tmall.com' ? 'tmall' : 'taobao', url: target,
      title: clean(marketplace.title,1000), images: imageUrls(marketplace.images),
      salesText: clean(marketplace.salesText,300), remark: clean(marketplace.remark,2000),
      matchState: marketplace.confirmedSame === true ? 'confirmed_same' : 'unconfirmed' };
  }
  const missing = [];
  if (details.quality && details.quality.state !== 'complete') missing.push(`供应商详情待补核${details.quality.missingFields?.length ? '：' + details.quality.missingFields.join('、') : ''}`);
  if (!supplier.articleNo) missing.push('供应商货号');
  if (!supplier.shopName) missing.push('供应商名称与互拓供应商映射');
  if (!supplier.images.length) missing.push('供应商商品图片');
  if (!marketing) missing.push('淘宝或天猫套图链接');
  else if (marketing.matchState !== 'confirmed_same') missing.push('套图同款确认');
  // These business values must come from supplier/business evidence later.
  missing.push('真实 ERP 类别和必填字典','供应商颜色尺码与套图交集','成分比例与尺码图','实际供货成本与周期');
  return { schemaVersion: 'buyer-source-1', supplier, marketing, trustedFacts: {}, missing,
    readiness: 'evidence_only', erpSubmission: 'not_submitted' };
}
module.exports = { buildBuyerSource, taobaoUrl };
