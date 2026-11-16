import { randomUUID } from 'node:crypto';

export const ERP_CONTRACT_VERSION = '2026-11-03-drafts';

// Preserve Java Longs in responses and in nested productData before JS rounds them.
export function parseErpJson(text) {
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source)) return context.source;
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error('当前运行时不能无损解析 ERP 长整数');
    return value;
  });
}

export function externalIdFromUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || !['detail.tmall.com', 'item.taobao.com'].includes(url.hostname) || url.pathname !== '/item.htm') throw new Error('请使用完整的淘宝或天猫商品链接');
  const id = url.searchParams.get('id');
  if (!/^\d{5,25}$/.test(id || '')) throw new Error('商品链接缺少可解析的数字 id');
  return id;
}

const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' ? v : '';
const strings = v => Array.isArray(v) ? v.filter(i => typeof i === 'string') : typeof v === 'string' ? v.split(',').map(s => s.trim()) : [];
const present = v => typeof v === 'string' && !!v.trim();
const numericId = v => (typeof v === 'string' && /^\d+$/.test(v)) || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);

export function normalizeCollection(record) {
  if (record === null) return { state: 'waiting', reason: '采集记录尚未返回' };
  if (!object(record)) throw new Error('采集详情响应不是对象');
  const title = text(record.title);
  if (/数据获取失败|信息获取失败|采集失败/.test(title)) return { state: 'failed', reason: 'ERP 标记采集失败，请在 ERP 检查原记录' };
  if (!record.productData || /信息获取中/.test(title)) return { state: 'waiting', reason: 'ERP 正在取得商品资料' };
  let p;
  try { p = typeof record.productData === 'string' ? parseErpJson(record.productData) : record.productData; } catch { return { state: 'waiting', reason: '商品预填资料暂不可解析' }; }
  if (!object(p) || !Object.keys(p).length) return { state: 'waiting', reason: '商品预填资料仍为空' };
  const image = text(p.main_pic) || text(p.mainPic) || text(record.mainPic);
  const publicPic = object(p.public_pic) ? p.public_pic : {};
  const images = [...new Set([image, ...strings(publicPic.main_pic11), ...strings(publicPic.main_pic34), ...strings(publicPic.detail_pic)].filter(Boolean))];
  const productTitle = title || text(p.title);
  if (!productTitle || !images.length) return { state: 'waiting', reason: '等待商品标题与图片资料' };
  const legacyColors = strings(p.colors), legacyPics = strings(p.color_pic), legacyRemarks = strings(p.color_remark);
  const colors = Array.isArray(p.collection_colors)
    ? p.collection_colors.filter(object).map(c => ({ name: text(c.name), sourceName: text(c.sourceName), image: text(c.image), remark: text(c.remark) }))
    : legacyColors.map((name, i) => ({ name, sourceName: name, image: legacyPics[i] || '', remark: legacyRemarks[i] || '' }));
  return { state: 'ready', source: {
    title: productTitle, description: text(p.description), category: text(p.product_type_name), industry: text(p.industry), season: text(p.season),
    images, variants: [], colors, sizes: Array.isArray(p.collection_sizes) ? p.collection_sizes : strings(p.size_category),
    originalPlatformData: object(p.collection_product_data) ? p.collection_product_data : null,
    origin: 'erp', externalId: String(record.externalId || ''), collectionSource: text(p.collection_source),
    // ERP prefill frequently contains placeholder zeroes; none are trusted commercial facts.
    trustedFacts: {}, rawPrefill: p
  } };
}

// Source information only: do not turn marketplace SKU/value IDs into ERP color IDs.
export function resolveColorRows(rows, colorCatalog) {
  return rows.map(row => {
    const matches = colorCatalog.filter(c => c.colorName === row.name && c.colorStatus === 1 && present(c.colorId));
    if (matches.length !== 1) return { ...row, colorId: null, issue: '颜色未唯一匹配到启用颜色库' };
    return { ...row, colorId: matches[0].colorId, issue: null };
  });
}

// Freeze the exact DTO and key before a write; after timeout use this same attempt.
export function prepareDraftAttempt(payload, key = randomUUID()) {
  if (!present(key) || key.length > 64 || /[\r\n]/.test(key)) throw new Error('Idempotency-Key 必须为 1–64 字符且不能换行');
  const errors = validateDraftPayload(payload);
  if (errors.length) throw new Error(`ERP 草稿资料未就绪：${errors.join('；')}`);
  return Object.freeze({ key, body: JSON.stringify(payload), contractVersion: ERP_CONTRACT_VERSION });
}

// Direct product saves do not have a documented server idempotency guarantee.
// The key identifies a local journal only; an attempted request must be read
// back by its complete product code, never replayed automatically.
export function prepareProductAttempt(payload, key = randomUUID()) {
  if (!present(key) || key.length > 64 || /[\r\n]/.test(key)) throw new Error('本机提交检查点编号无效');
  const errors = validateDraftPayload(payload);
  if(!present(payload.company))errors.push('缺少 company');
  if (errors.length) throw new Error(`待审核商品资料未就绪：${errors.join('；')}`);
  return Object.freeze({ key, body: JSON.stringify(payload), contractVersion: ERP_CONTRACT_VERSION, mode: 'direct_pending', productNo: [payload.storeHouse, payload.productType, payload.supplierAb, payload.articleNo].join('-') });
}

export const additionFields = new Set([
  'articleNo','productType','productTypeName','storeHouse','supplierName','supplierAb','pallet','costPlus','payment','platformPrice','colors','industry',
  'supplyCycle','recPlatform','sizeType','sizeCategory','material','materialRate','sizePic','season','style','unit','technology','marketTime','recommendedStore',
  'extranetMonthSale','standardScore','ageState','materialRemark','suitPicInfo','role','company','productMinSuggestedSellingPrice','productMaxSuggestedSellingPrice',
  'colorNo','colorPic','colorRemark','sizeList','downJacketInfo','qcReportInfo','extendedAttributes','publicPicInfo','talkCost','buyerName','fork',
  'qualityInspectionPdf','qualityInspectionUrl','nationalStandard'
]);
export function validateDraftPayload(p) {
  if (!object(p)) return ['请求必须是商品资料对象'];
  const errors = [];
  for (const key of Object.keys(p)) if (!additionFields.has(key)) errors.push(`新增 DTO 不接收 ${key}`);
  for (const key of ['articleNo','productType','productTypeName','storeHouse','supplierName','supplierAb','pallet']) if (!present(p[key])) errors.push(`缺少 ${key}`);
  if (present(p.articleNo) && !/^[A-Za-z0-9/]+$/.test(p.articleNo)) errors.push('货号须使用字母、数字或 /，不可使用中文或连字符');
  if (!['通用码','数值码','国际码'].includes(p.sizeType)) errors.push('尺码类型无效');
  if (!Array.isArray(p.sizeCategory) || !p.sizeCategory.length || p.sizeCategory.some(v => !present(v))) errors.push('尺码明细不能为空');
  if (!Array.isArray(p.colors) || !p.colors.length || p.colors.some(v => !present(v))) errors.push('颜色不能为空');
  for (const key of ['colorNo','colorPic','colorRemark']) if (!Array.isArray(p[key]) || p[key].length !== p.colors?.length || p[key].some(v => typeof v !== 'string')) errors.push(`${key} 必须与颜色一一对应`);
  if (Array.isArray(p.colorNo) && p.colorNo.some(v => !present(v))) errors.push('颜色必须匹配真实 colorId');
  if (!Array.isArray(p.material) || !p.material.length || p.material.some(v => !present(v)) || !Array.isArray(p.materialRate) || p.materialRate.length !== p.material.length) errors.push('材质与比例必须成对提供');
  else { const rates = p.materialRate.map(v => typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN); if (rates.some(v => !Number.isFinite(v) || v < 0 || v > 100) || Math.abs(rates.reduce((a,b)=>a+b,0) - 100) > 1e-7) errors.push('材质比例合计必须为 100'); }
  if (!present(p.sizePic)) errors.push('缺少尺码参考图');
  if (!present(p.buyerName)) errors.push('缺少登录买手身份');
  for (const key of ['industry','season','style','ageState']) if (!present(p[key])) errors.push(`缺少 ${key}`);
  if (typeof p.talkCost !== 'number' || !Number.isFinite(p.talkCost) || p.talkCost <= 0 || p.talkCost > 1000) errors.push('买手成本须大于 0 且不超过 1000');
  if (!Number.isInteger(p.supplyCycle) || p.supplyCycle < 1 || p.supplyCycle > 120) errors.push('供货周期须为 1–120 的整数');
  if (p.platformPrice !== null && p.platformPrice !== undefined && (typeof p.platformPrice !== 'number' || !Number.isFinite(p.platformPrice) || p.platformPrice < 0 || p.platformPrice >= 100000000 || Math.abs(Math.round(p.platformPrice * 100) - p.platformPrice * 100) > 1e-6)) errors.push('平台价须非负、最多 8 位整数与 2 位小数');
  if (![0,1,2].includes(p.fork)) errors.push('商品类型 fork 无效');
  if (!object(p.extendedAttributes)) errors.push('缺少动态属性对象');
  if (!Array.isArray(p.sizeList) || !Array.isArray(p.standardScore)) errors.push('sizeList 和 standardScore 必须是数组');
  if (!Array.isArray(p.suitPicInfo) || !p.suitPicInfo.length) errors.push('套图不能为空');
  else for (const row of p.suitPicInfo) {
    if (!object(row) || !present(row.mainPic) || !present(row.mainPicSource) || !present(row.suitPic) || !(present(row.picBuyerName) || present(row.selfUploadOperator))) errors.push('套图缺少主图、来源、链接或操作人');
    for (const key of ['id','collectionImportId']) if (row?.[key] !== null && row?.[key] !== undefined && !numericId(row[key])) errors.push(`套图 ${key} 无效`);
  }
  return [...new Set(errors)];
}
