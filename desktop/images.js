const dns = require('node:dns/promises');
const net = require('node:net');
const sharp = require('sharp');
const policy = require('../image-policy');

function isPrivateAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127;
  }
  if (version === 6) {
    const value = address.toLowerCase();
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value) || value.startsWith('::ffff:');
  }
  return true;
}
async function validatePublicImageUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('仅允许公开 HTTPS 图片地址');
  const host = url.hostname.toLowerCase();
  const approved = /(^|\.)wsy\.com$|(^|\.)17qcc\.com$|(^|\.)17zwd\.com$|(^|\.)e3hui\.com$|(^|\.)e3hui\.cn$|(^|\.)alicdn\.com$|(^|\.)taobaocdn\.com$|(^|\.)tbcdn\.cn$|(^|\.)ecombdimg\.com$|(^|\.)byteimg\.com$|(^|\.)douyinpic\.com$/.test(host) || ['e3h.i.ximgs.net', 'aodo.i.ximgs.net'].includes(host);
  if (!approved) throw new Error('候选图片域名不在已接入平台范围内');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(record => isPrivateAddress(record.address))) throw new Error('拒绝访问本机或局域网图片地址');
  return url;
}
async function download(url, signal, transport) {
  let current = await validatePublicImageUrl(url);
  const timed = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]);
  let response;
  for (let redirects = 0; redirects <= 4; redirects++) {
    response = await transport(current, { redirect: 'manual', headers: { Accept: 'image/*' }, signal: timed });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const target = response.headers.get('location');
      await response.body?.cancel();
      if (!target || redirects === 4) throw new Error('候选图片跳转次数过多');
      current = await validatePublicImageUrl(new URL(target, current).href);
    } else break;
  }
  if (!response?.ok) { await response?.body?.cancel(); throw new Error(`候选图片返回 HTTP ${response?.status || '未知错误'}`); }
  const maxBytes = 12 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('候选图片超过12MB'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('候选图片没有响应内容');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('候选图片超过12MB'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return { buffer: Buffer.concat(chunks), sourceUrl: current.href };
}
async function dimensions(buffer) {
  return sharp(buffer, { limitInputPixels: 50000000 }).metadata();
}
async function downloadCandidate(url, signal, { transport = (...args) => fetch(...args) } = {}) {
  let lastError;
  for (const source of policy.sources(url)) {
    if (signal?.aborted) throw new Error('图片下载已停止');
    try {
      const { buffer, sourceUrl } = await download(source, signal, transport);
      const metadata = await dimensions(buffer);
      const reason = policy.qualityError(metadata.width, metadata.height);
      if (reason) throw new Error(reason);
      // Resizing only reduces large images; a thumbnail is never enlarged and
      // passed off as a high resolution source.
      const result = await sharp(buffer, { limitInputPixels: 50000000 }).rotate().flatten({ background: '#ffffff' })
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
      return { buffer: result.data, dataUrl: `data:image/jpeg;base64,${result.data.toString('base64')}`,
        evidence: { sourceUrl, sourceWidth: metadata.width, sourceHeight: metadata.height, width: result.info.width, height: result.info.height, upgraded: source !== url } };
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      if (policy.sources(url).length === 1) break;
    }
  }
  throw lastError || new Error('高清图片获取失败，未执行识别');
}
async function downloadImagePreview(url, signal, { transport = (...args) => fetch(...args) } = {}) {
  const { buffer, sourceUrl } = await download(url, signal, transport);
  const result = await sharp(buffer, { limitInputPixels: 50000000 }).rotate().flatten({ background: '#ffffff' })
    .resize({ width: 420, height: 420, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer({ resolveWithObject: true });
  return { dataUrl: `data:image/jpeg;base64,${result.data.toString('base64')}`, sourceUrl, width: result.info.width, height: result.info.height };
}
async function validateQuery(dataUrl) {
  const metadata = await dimensions(Buffer.from(String(dataUrl).split(',')[1] || '', 'base64'));
  const reason = policy.qualityError(metadata.width, metadata.height);
  if (reason) throw new Error(`原图${reason}`);
}
module.exports = { downloadCandidate, downloadImagePreview, validateQuery, validatePublicImageUrl };
