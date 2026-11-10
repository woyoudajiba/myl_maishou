const fs = require('node:fs/promises');
const path = require('node:path');
const dns = require('node:dns/promises');
const net = require('node:net');
const sharp = require('sharp');

const mobileUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const hostIs = (host, suffix) => host === suffix || host.endsWith('.' + suffix);
const isProductHost = host => ['douyin.com', 'jinritemai.com'].some(domain => hostIs(host, domain));
const isImageHost = host => ['ecombdimg.com', 'byteimg.com', 'douyinpic.com', 'douyinstatic.com'].some(domain => hostIs(host, domain));
const isPlatformHost = host => isProductHost(host) || ['ecombdimg.com', 'byteimg.com', 'douyinpic.com', 'douyinstatic.com', 'bytedance.com', 'bytedance.net', 'bytecdn.cn', 'bytecdn.com', 'snssdk.com', 'toutiao.com', 'zijieapi.com', 'bdstatic.com', 'bytednsdoc.com', 'yhgfb-cn-static.com', 'ibytedapm.com', 'bytescm.com'].some(domain => hostIs(host, domain));
function allowedUrl(value, predicate) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && predicate(url.hostname.toLowerCase()); } catch { return false; }
}
function extractUrls(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s\u4e00-\u9fff\u3000-\u303f\uff00-\uffef<>"'`]+/gi) || [];
  const seen = new Set(), result = [];
  for (let url of matches) {
    url = url.replace(/[.,;:!?)\]}]+$/, '');
    if (!allowedUrl(url, isProductHost)) continue;
    const key = url.replace(/\/+$/, '');
    if (!seen.has(key)) { seen.add(key); result.push(url); }
  }
  return result;
}
function normalizeUrl(value) {
  const url = new URL(value);
  if (url.hostname === 'haohuo.jinritemai.com' && url.pathname.endsWith('/index.html') && !url.searchParams.has('origin_type')) url.searchParams.set('origin_type', 'detail_share_v2');
  return url.href;
}
function safeName(value) {
  let name = String(value || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, 40).replace(/[. ]+$/g, '');
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '未命名商品';
  return name;
}
function detailInfo(data) {
  const figure = data?.promotion_h5?.head_figure_data?.media_list;
  const title = data?.promotion_h5?.basic_info_data?.title_info?.title;
  const urls = [];
  if (Array.isArray(figure)) for (const item of figure) for (const entry of Array.isArray(item?.content_list) ? item.content_list : []) if (typeof entry.url === 'string') urls.push(entry.url);
  // Fallback only to public merchandise assets, matching the original tool.
  if (!urls.length) {
    const visit = (value, depth = 0) => {
      if (depth > 30 || urls.length >= 100) return;
      if (typeof value === 'string' && value.includes('ecom-shop-material')) urls.push(value);
      else if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child, depth + 1);
    };
    visit(data);
  }
  const unique = new Set();
  const images = urls.filter(value => {
    if (!allowedUrl(value, isImageHost)) return false;
    const key = new URL(value).pathname.replace(/~tplv-[^/]*$/, '').split('/img/').at(-1);
    if (unique.has(key)) return false;
    unique.add(key); return true;
  }).slice(0, 50);
  return { title: typeof title === 'string' ? title.trim().slice(0, 300) : '', images };
}
function sourceOptions(value, quality) {
  const original = new URL(value);
  const originalUrl = original.href;
  // Signed URLs must remain unchanged; unknown CDN paths must not be rewritten.
  if ([...original.searchParams.keys()].some(k => /signature|token|credential|expires|accesskey/i.test(k)) || !original.pathname.includes('/img/ecom-shop-material/')) return [originalUrl];
  original.pathname = original.pathname.replace(/~tplv-[^/]*$/, '') + (quality === 'jpg' ? '~tplv-5mmsx3fupr-image.jpeg' : '~tplv-5mmsx3fupr-image.png');
  return [...new Set([original.href, originalUrl])];
}
function publicIp(ip) {
  if (net.isIP(ip) === 4) { const [a,b] = ip.split('.').map(Number); return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127); }
  if (net.isIP(ip) === 6) { const s = ip.toLowerCase(); return !(s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || /^fe[89ab]/.test(s) || s.startsWith('::ffff:')); }
  return false;
}
async function fetchImage(url, signal, transport = fetch) {
  let current = url;
  const timed = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  for (let redirects = 0; redirects < 5; redirects++) {
    if (!allowedUrl(current, isImageHost)) throw new Error('图片地址不在抖音商品图片域名范围');
    const addresses = await dns.lookup(new URL(current).hostname, { all: true });
    if (!addresses.length || addresses.some(item => !publicIp(item.address))) throw new Error('图片地址解析无效');
    const response = await transport(current, { signal: timed, redirect: 'manual', headers: { Accept: 'image/*', Referer: 'https://haohuo.jinritemai.com/' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location'); await response.body?.cancel();
      if (!next) throw new Error('图片跳转地址缺失');
      current = new URL(next, current).href; continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`图片返回 HTTP ${response.status}`); }
    if (Number(response.headers.get('content-length')) > 20 * 1024 * 1024) { await response.body?.cancel(); throw new Error('图片超过20MB'); }
    const reader = response.body?.getReader(); if (!reader) throw new Error('图片内容为空');
    const chunks = []; let size = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 20 * 1024 * 1024) { await reader.cancel(); throw new Error('图片超过20MB'); } chunks.push(Buffer.from(value)); } }
    finally { reader.releaseLock(); }
    const buffer = Buffer.concat(chunks); const meta = await sharp(buffer, { limitInputPixels: 50000000 }).metadata();
    if (!meta.width || !meta.height) throw new Error('图片无法解码');
    return { buffer, meta, source: current };
  }
  throw new Error('图片跳转次数过多');
}
function createBrowserParser() {
  let browser, context, launching;
  const getContext = async () => {
    if (context) return context;
    if (launching) return launching;
    launching = (async () => {
      const candidates = [
        process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
        process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
        process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')
      ].filter(Boolean);
      let executablePath;
      for (const candidate of candidates) { try { await fs.access(candidate); executablePath = candidate; break; } catch {} }
      if (!executablePath) throw new Error('未找到 Chrome 或 Edge，请先安装其中一个浏览器');
      const { chromium } = require('playwright-core');
      browser = await chromium.launch({ executablePath, headless: true });
      context = await browser.newContext({ userAgent: mobileUA, viewport: { width: 414, height: 896 }, isMobile: true,
        hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', acceptDownloads: false });
      await context.route('**/*', route => {
        const request = route.request();
        const mainNavigation = request.isNavigationRequest() && request.frame() === request.frame().page().mainFrame();
        const allowed = allowedUrl(request.url(), mainNavigation ? isProductHost : isPlatformHost);
        return !allowed || ['image', 'font', 'media'].includes(request.resourceType()) ? route.abort() : route.continue();
      });
      return context;
    })();
    try { return await launching; } finally { launching = null; }
  };
  const parse = async (input, signal) => {
    const ctx = await getContext();
    if (signal.aborted) throw new Error('已停止');
    const page = await ctx.newPage();
    let detail = null;
    const abort = () => { void page.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    page.on('response', async response => {
      if (detail || !response.url().includes('promotion/pack/h5') || !allowedUrl(response.url(), isProductHost)) return;
      try {
        const size = Number(response.headers()['content-length']);
        if (size > 8 * 1024 * 1024) return;
        const text = await response.text();
        if (text.length <= 8 * 1024 * 1024) detail = JSON.parse(text);
      } catch { /* Platform may return an incomplete or non-JSON response. */ }
    });
    try {
      await page.goto(normalizeUrl(input), { waitUntil: 'domcontentloaded', timeout: 45000 });
      for (let i = 0; i < 36 && !detail && !signal.aborted; i++) await page.waitForTimeout(250);
      const result = detailInfo(detail);
      const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 600);
      if (!result.images.length) {
        const html = (await page.content()).slice(0, 4000000);
        const matches = html.match(/https?:\/\/[a-z0-9.-]+-item\.ecombdimg\.com\/img\/ecom-shop-material\/[^\s"'\\<>]+/gi) || [];
        result.images = detailInfo({ assets: matches }).images;
      }
      if (!result.images.length) {
        if (/安全风险|扫码|验证码|验证|登录/.test(body)) throw new Error('平台要求登录或安全验证，当前隔离会话暂不支持登录');
        if (/下架|不存在/.test(body)) throw new Error('商品可能已下架或不存在');
        throw new Error('未找到商品主图，可能链接失效、平台要求登录或接口已变化');
      }
      if (!result.title) { try { result.title = JSON.parse(new URL(page.url()).searchParams.get('goods_detail') || '{}').title || ''; } catch {} }
      return { ...result, productId: new URL(page.url()).searchParams.get('id') || '' };
    } finally { signal.removeEventListener('abort', abort); await page.close().catch(() => {}); }
  };
  parse.close = async () => { const old = browser; browser = null; context = null; if (old) await old.close(); };
  return parse;
}

class DouyinDownloads {
  constructor({ defaultDir, parse, download = fetchImage, onItem = async () => {} }) {
    this.defaultDir = defaultDir; this.parse = parse; this.download = download; this.onItem = onItem; this.running = null; this.controller = null;
    this.state = { running: false, status: '就绪', total: 0, done: 0, succeeded: 0, failed: 0, images: 0, items: [], outdir: defaultDir };
  }
  snapshot() { return structuredClone(this.state); }
  setDirectory(dir) {
    if (this.running) throw new Error('下载期间不能修改保存位置');
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('保存位置无效');
    this.state.outdir = path.resolve(dir);
  }
  start({ text, outdir, quality } = {}) {
    if (this.running) throw new Error('已有下载任务正在运行');
    if (typeof text !== 'string' || text.length > 200000) throw new Error('链接文本过长');
    const urls = extractUrls(text); if (!urls.length) throw new Error('没有识别到抖音商品链接');
    if (urls.length > 200) throw new Error('每次最多处理200条商品链接');
    const dir = path.resolve(outdir || this.defaultDir);
    if (!path.isAbsolute(outdir || this.defaultDir) || !['png', 'jpg'].includes(quality)) throw new Error('请选择有效的保存位置和图片格式');
    this.controller = new AbortController();
    this.state = { running: true, status: '正在准备下载', total: urls.length, done: 0, succeeded: 0, failed: 0, images: 0, items: [], outdir: dir };
    this.running = this.run(urls, dir, quality, this.controller.signal).catch(error => { this.state.status = '下载中断：' + String(error.message || error).slice(0, 150); }).finally(async () => { await this.parse.close?.().catch(() => {}); this.state.running = false; this.running = null; this.controller = null; });
    return this.snapshot();
  }
  async stop() { this.controller?.abort(); if (this.running) await this.running; return this.snapshot(); }
  async reset() { await this.stop(); this.state = { running: false, status: '就绪', total: 0, done: 0, succeeded: 0, failed: 0, images: 0, items: [], outdir: this.defaultDir }; }
  async run(urls, outdir, quality, signal) {
    await fs.mkdir(outdir, { recursive: true });
    for (let i = 0; i < urls.length && !signal.aborted; i++) {
      this.state.status = `正在解析第 ${i + 1}/${urls.length} 个商品`;
      const result = { index: i + 1, title: '', url: urls[i], quality, status: 'failed', reason: '', count: 0, firstImage: false, searchStatus: 'not_started', searchError: '', searchCommandId: '', totalImages: 0, folder: '', preview: '' };
      try {
        const item = await this.parse(urls[i], signal); if (signal.aborted) break;
        if (!item.images?.length) throw new Error('未找到商品主图');
        result.title = item.title || `商品${item.productId || i + 1}`; result.totalImages = item.images.length;
        const base = `${String(i + 1).padStart(3, '0')}_${safeName(result.title)}`;
        for (let n = 0; n < 10000; n++) {
          const folder = path.join(outdir, n ? `${base}_${n + 1}` : base);
          try { await fs.mkdir(folder); result.folder = folder; break; } catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        if (!result.folder) throw new Error('无法创建不重复的商品目录');
        for (let k = 0; k < item.images.length && !signal.aborted; k++) {
          this.state.status = `商品 ${i + 1}/${urls.length}：下载第 ${k + 1}/${item.images.length} 张`;
          let saved = false, errorText = '';
          for (const source of sourceOptions(item.images[k], quality)) {
            try {
              const picture = await this.download(source, signal);
              // Convert to the requested format; never label a fallback JPEG as PNG.
              const output = quality === 'jpg' ? await sharp(picture.buffer).rotate().flatten({ background: '#fff' }).jpeg({ quality: 90 }).toBuffer() : await sharp(picture.buffer).rotate().png().toBuffer();
              await fs.writeFile(path.join(result.folder, `${k + 1}.${quality}`), output, { flag: 'wx' });
              if (!result.preview) result.preview = 'data:image/jpeg;base64,' + (await sharp(picture.buffer).resize({ width: 180, height: 180, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer()).toString('base64');
              if (k === 0) result.firstImage = true;
              result.count++; this.state.images++; saved = true; break;
            } catch (error) { if (signal.aborted) break; errorText = String(error.message || error); }
          }
          if (!saved && !signal.aborted) result.reason = `部分图片下载失败：${errorText.slice(0, 100)}`;
        }
        await fs.writeFile(path.join(result.folder, '商品信息.txt'), `标题：${result.title}\n链接：${urls[i]}\n商品ID：${item.productId || ''}\n主图数：${item.images.length}\n已下载：${result.count}\n下载时间：${new Date().toLocaleString('zh-CN')}\n`, { encoding: 'utf8', flag: 'wx' });
        result.status = result.count === item.images.length ? 'complete' : result.count ? 'partial' : 'failed';
        if (!result.reason && result.status !== 'complete') result.reason = signal.aborted ? '已停止，保留已下载图片' : '图片下载失败';
      } catch (error) { result.reason = signal.aborted ? '已停止' : String(error.message || error).slice(0, 180); }
      this.state.items.push(result); this.state.done++;
      if (result.status === 'complete') this.state.succeeded++; else this.state.failed++;
      if (result.firstImage) {
        result.searchStatus = 'queued';
        try { const command = await this.onItem(result); result.searchCommandId = command?.id || ''; }
        catch (error) { result.searchStatus = 'failed'; result.searchError = String(error.message || error).slice(0, 180); }
      }
      if (!signal.aborted && i + 1 < urls.length) await new Promise(resolve => setTimeout(resolve, 700));
    }
    this.state.status = signal.aborted ? `已停止，保留 ${this.state.images} 张图片` : `下载完成：成功 ${this.state.succeeded}，未完成 ${this.state.failed}，共 ${this.state.images} 张图片`;
  }
}
module.exports = { DouyinDownloads, createBrowserParser, extractUrls, normalizeUrl, detailInfo, sourceOptions, safeName, allowedUrl, isProductHost, isImageHost, fetchImage };
