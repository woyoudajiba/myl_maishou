// Runs only through chrome.scripting in the selected platform's MAIN world.
// Uses that website's request helpers so login/CSRF/signature rules stay native.
async function searchPlatformPage(platform, base64, requestId) {
  const jobs = window.__findPlatformJobs ||= {};
  if (Object.keys(jobs).length) return { ok: false, requestId, error: 'request_busy：此页面已有请求' };
  const job = { cancelled: false, aborts: [] }; jobs[requestId] = job;
  const startedAt = Date.now();
  const diagnostics = { platform, page: location.origin + location.pathname, stage: 'page_ready', retryable: false };
  const check = () => { if (job.cancelled) throw new Error('request_cancelled：请求已取消'); };
  const bounded = promise => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      job.cancelled = true; job.aborts.forEach(fn => fn());
      diagnostics.timeoutStage = diagnostics.stage;
      diagnostics.failureKind = 'timeout';
      diagnostics.retryable = platform!=='qcc'||!['image_upload','image_search'].includes(diagnostics.stage);
      const requestName=platform==='qcc'&&diagnostics.stage==='image_search'?'青创网搜图回调':platform==='qcc'&&diagnostics.stage==='image_upload'?'青创网图片上传':`${platform}平台请求`;
      reject(new Error(`platform_timeout：${requestName}等待 25 秒超时；${diagnostics.retryable?'可重试':'请求可能已被平台接收，不自动重发以避免重复消耗额度'}`));
    }, 25000);
    Promise.resolve(promise).then(x => { clearTimeout(timer); try { check(); resolve(x); } catch (e) { reject(e); } }, e => { clearTimeout(timer); reject(e); });
  });
  const url = (v, base = location.href) => { try { if (!v) return ''; const u = new URL(v, base); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; } };
  const dataUrlBlob = value => {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(value || ''));
    if (!match) throw new Error('image_input：图片数据格式无效');
    const mime = match[1] || 'application/octet-stream';
    if (match[2]) {
      const raw = atob(match[3]); const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(match[3])], { type: mime });
  };
  const num = v => (typeof v === 'number' || typeof v === 'string' && v.trim()) && Number.isFinite(Number(v)) ? Number(v) : null;
  const qccTags = raw => {
    const yes = value => value === true || value === 1 || value === '1';
    const tags = [];
    if (yes(raw.IsNew)) tags.push('新品');
    if (Number(raw.CloudStoreType) === 3) tags.push('共享仓');
    else if (Number(raw.CloudStoreType) === 2) tags.push('自营仓');
    else if (num(raw.IsCloudStore) > 0) tags.push('云仓闪发');
    else if (yes(raw.IsFactory)) tags.push('工厂直供');
    else if (yes(raw.IsLightning)) tags.push('闪电发货');
    return tags;
  };
  // Field names and Result.Items are grounded in the official search-page
  // template observed with a real 24-product search. This is deliberately not
  // a recursive search for arbitrary arrays or a fuzzy field-name matcher.
  const qccApiItems = response => {
    if (response?.Result && Object.hasOwn(response.Result, 'Items') && !Array.isArray(response.Result.Items)) throw new Error('青创网 Result.Items 格式变化');
    if (!Array.isArray(response?.Result?.Items)) return null;
    return response.Result.Items.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('青创网商品记录格式变化');
      const id = typeof raw.ProductId === 'number' && Number.isSafeInteger(raw.ProductId) ? String(raw.ProductId) : typeof raw.ProductId === 'string' ? raw.ProductId.trim() : '';
      const title = typeof raw.ProductName === 'string' ? raw.ProductName.trim() : '';
      const photo = typeof raw.Photo === 'string' ? raw.Photo.trim() : '';
      let imageUrl = '';
      try {
        const parsed = new URL(photo, 'https://pics.17qcc.com/');
        if (photo && parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port && /(^|\.)17qcc\.com$/i.test(parsed.hostname)) imageUrl = parsed.href;
      } catch {}
      const price = num(raw.DefaultPrice);
      if (!/^[1-9]\d*$/.test(id) || !title || !imageUrl || price == null || price <= 0) throw new Error('青创网商品关键字段缺失或格式变化');
      return { platform: 'qcc', id, title: title.slice(0, 1000), goodsId: typeof raw.ProductNo === 'string' || typeof raw.ProductNo === 'number' ? String(raw.ProductNo).slice(0, 200) : '',
        price, imageUrl, detailUrl: `https://www.17qcc.com/item/${id}.html`, supplierId: '', shopName: '', address: '', similarity: null,
        platformTags: qccTags(raw), dataSource: 'qcc_api' };
    });
  };
  const imageSources = img => {
    if (!img) return [];
    const explicit = ['data-original', 'data-zoom-image', 'data-large', 'data-full']
      .map(name => img.getAttribute(name)).filter(Boolean);
    const srcset = [img.getAttribute('data-srcset'), img.getAttribute('srcset')].filter(Boolean).flatMap(value => value.split(',')).map(entry => {
      const [source, descriptor] = entry.trim().split(/\s+/, 2);
      return { source, size: Number.parseFloat(descriptor) || 1 };
    }).filter(entry => entry.source).sort((a, b) => b.size - a.size).map(entry => entry.source);
    return [...explicit, ...srcset, img.getAttribute('data-url'), img.getAttribute('lazyload'), img.getAttribute('data-src'), img.getAttribute('src')].filter(Boolean);
  };
  const cards = (root, selector, platformKey) => Array.from(root.querySelectorAll(selector)).map(card => {
    const anchor = Array.from(card.querySelectorAll('a[href]')).find(candidate => {
      const href = String(candidate.getAttribute('href') || '');
      // The current QCC image-search template links to /item/{id}.html. Older
      // templates used /product/detail/{id}; accept both official shapes.
      return platform === 'qcc' ? /\/(?:product\/detail|item)\/[0-9]+(?:\.html)?/i.test(href) : /\/product\//i.test(href);
    });
    const detailUrl = url(anchor?.getAttribute('href'));
    const id = detailUrl.match(platform === 'qcc' ? /\/(?:product\/detail|item)\/([0-9]+)(?:\.html)?/i : /\/product\/([a-z0-9]+)\.html/i)?.[1] || '';
    const img = anchor?.querySelector('img');
    let imageUrl = imageSources(img).map(source => url(source)).find(Boolean) || '';
    // E3's public product images use ximgs.net and are emitted as HTTP URLs.
    // The extension result page is secure, so use the CDN's verified HTTPS URL.
    if (/^e3hui(?:-|$)/.test(platformKey) && imageUrl) {
      try { const image = new URL(imageUrl); if (['e3h.i.ximgs.net','aodo.i.ximgs.net'].includes(image.hostname.toLowerCase())) { image.protocol = 'https:'; imageUrl = image.href; } } catch { imageUrl = ''; }
    }
    const priceText = card.querySelector(platform === 'qcc' ? '.brprice, .money, .pirceBox .money' : '.money, .price-dist-wrap .price, .price .num, .price')?.textContent?.trim().replace(/^\s*[¥￥]\s*/, '') || '';
    const qccGoodsId = card.querySelector('.size')?.textContent?.replace(/^\s*货号\s*[:：]?\s*/i, '').trim() || '';
    const qccTitle = card.querySelector('.rowtitle a, .rowtitle')?.textContent?.trim() || '';
    return { platform: platformKey, id, detailUrl, imageUrl: /placeholder|\/load\.jpg/i.test(imageUrl) ? '' : imageUrl, price: num(priceText),
      goodsId: platform === 'qcc' ? qccGoodsId || card.querySelector('.number')?.textContent?.trim() || '' : card.querySelector('.number')?.textContent?.trim() || '',
      title: platform === 'qcc' ? qccTitle || img?.alt || '' : card.querySelector('.rowtitle .txt, .info-wrap .name, .info-wrap-hover .name, .name')?.textContent?.trim() || img?.alt || '',
      supplierId: '', shopName: card.querySelector('.shopname, .shop-name')?.textContent?.trim() || '', address: '', similarity: null,
      ...(platformKey === 'qcc' ? { dataSource: 'qcc_template', platformTags: [...new Set(Array.from(card.querySelectorAll('.tagIcon'), tag => tag.textContent.trim()).filter(tag => ['新品', '共享仓', '自营仓', '云仓闪发', '工厂直供', '闪电发货'].includes(tag)))] } : {}) };
  });
  const ajax = options => bounded(new Promise((resolve, reject) => {
    const xhr = window.jQuery.ajax({ ...options, timeout: 25000, success: resolve, error: (request, status) => {
      const code = Number(request?.status) || 0;
      let responseUrl = '';
      try { const parsed = new URL(request?.responseURL || '', location.href); responseUrl = /^https?:$/.test(parsed.protocol) ? `${parsed.origin}${parsed.pathname}` : ''; } catch {}
      const detail = code ? `HTTP ${code}` : 'HTTP 0，可能是跨域、网络或上传地址失效';
      diagnostics.httpStatus = code;
      diagnostics.httpStatusText = String(request?.statusText || status || '').slice(0, 80);
      diagnostics.responseUrl = responseUrl;
      const redirectedToPage = code === 302 && responseUrl === location.origin + '/';
      diagnostics.redirectedToPage = redirectedToPage;
      reject(new Error(`platform_http：${status}（${detail}${responseUrl ? `，响应 ${responseUrl}` : ''}${redirectedToPage ? '，可能是登录态或搜图权限被重定向' : ''}），未取得可靠响应`));
    } });
    job.aborts.push(() => xhr.abort());
  }));
  const waitReady = async predicate => {
    const start = Date.now();
    while (!predicate() && Date.now()-start < 5000) { check(); await new Promise(resolve => setTimeout(resolve,200)); }
    check(); return !!predicate();
  };
  try {
    const needsImage = platform !== 'e3hui_parse';
    if (needsImage && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(base64) || base64.length > 8 * 1024 * 1024)) throw new Error('image_input：图片数据无效');
    if (platform.startsWith('e3hui') && location.hostname === 'sso.e3hui.cn') throw new Error('platform_login：衣衫汇跳转到了统一登录站点，请先完成登录');
    if (/login|passport/i.test(location.pathname)) throw new Error('platform_login：请先在该平台登录');
    let items, total = null, partial = false;
    if (platform === 'zwd') {
      if (location.hostname !== 'stu.17zwd.com') throw new Error('platform_origin：17网需使用图搜页面');
      let requirePage;
      await waitReady(() => Array.isArray(window.webpackJsonp) && window.webpackJsonp.push !== Array.prototype.push);
      diagnostics.runtimeActive = Array.isArray(window.webpackJsonp) && window.webpackJsonp.push !== Array.prototype.push;
      if (Array.isArray(window.webpackJsonp)) {
        window.webpackJsonp.push([[`find-${requestId}`], { [`find-${requestId}`]: (_module, _exports, require) => { requirePage = require; } }, [[`find-${requestId}`]]]);
      }
      const moduleId = './node_modules/@17zwd/fe-egg-framework/src/app/web/component/framework/apiCaller/index.tsx';
      diagnostics.requireCaptured = typeof requirePage === 'function';
      diagnostics.moduleCount = requirePage?.m ? Object.keys(requirePage.m).length : null;
      diagnostics.modulePresent = requirePage?.m ? !!requirePage.m[moduleId] : null;
      const exports = diagnostics.modulePresent === false ? null : requirePage?.(moduleId);
      const api = exports?.a || exports?.default;
      if (!api?.post) {
        throw new Error(`platform_contract：17网请求模块未就绪（运行时 ${diagnostics.runtimeActive}，捕获 ${diagnostics.requireCaptured}，模块 ${diagnostics.modulePresent}），未发送图片`);
      }
      const all = [], reports = [], searchGroups = [];
      diagnostics.searchGroups = searchGroups;
      const rawBase64 = base64.replace(/^data:image\/(?:jpeg|png|webp);base64,/i, '');
      diagnostics.inputEncoding = 'raw_base64';
      let cacheKey = '';
      for (const type of ['accurate', 'similar']) {
        check();
        diagnostics.stage = `search_${type}`;
        try {
          const data = await bounded(api.post({ action: '/tusou/_api/searchsimilar/image64Search', isGlobal: 4,
            data: { img_base64: rawBase64, img_keys: 'by_message', current: 1, pageSize: 100, cacheKey, sort: 'default', type, showAllSite: false },
            isThrowError: true, isShowError: false, isLogError: false, isLimit: false }));
          if (!Array.isArray(data?.items)) throw new Error(`platform_response：17网未返回 items；${String(data?.message || data?.code || '字段变化').slice(0,120)}`);
          cacheKey = data.cacheKey || ''; reports.push(num(data.total));
          const areas = window.__CONFIG__?.areaList || [];
          all.push(...data.items.map(raw => {
            const area = areas.find(x => String(x.id) === String(raw.zdid));
            return { platform: 'zwd', id: String(raw.gid ?? ''), goodsId: String(raw.item_no ?? ''), title: String(raw.item_title ?? ''), price: num(raw.item_price_pifa),
              imageUrl: url(raw.item_pic_url), detailUrl: /^\d+$/.test(String(raw.gid)) && /^[a-z]+$/.test(area?.prefix || '') ? `https://${area.prefix}.17zwd.com/item/${raw.gid}` : '',
              supplierId: String(raw.sid ?? ''), shopName: String(raw.shop_name ?? ''), address: [raw.shop_market_name, raw.shop_floor_name, raw.shop_dangkou_no].filter(Boolean).join(' '), similarity: null, searchGroup: type };
          }));
          searchGroups.push({ type, phase: 'complete', received: data.items.length, total: num(data.total) });
        } catch (error) {
          const message = String(error.message || error).slice(0,180);
          searchGroups.push({ type, phase: 'failed', message });
          if (job.cancelled) throw error;
        }
      }
      const failedGroups = searchGroups.filter(group => group.phase === 'failed');
      const completeGroups = searchGroups.filter(group => group.phase === 'complete');
      partial = failedGroups.length > 0;
      if (!completeGroups.length) throw new Error(`platform_response：17网准确搜和相似搜均失败；${failedGroups.map(group => `${group.type}: ${group.message}`).join('；')}`);
      const seen = new Set(); items = all.filter(x => { if (!x.id) return true; if (seen.has(x.id)) return false; seen.add(x.id); return true; });
      total = !partial && reports.every(x => x != null) ? reports.reduce((a,b) => a+b,0) : null;
    } else if (platform === 'qcc') {
      const getPageConfig = () => typeof cfgPage !== 'undefined' ? cfgPage : window.cfgPage;
      await waitReady(() => !!window.jQuery?.qccAjax && !!getPageConfig());
      const pageConfig = getPageConfig();
      diagnostics.jquery = !!window.jQuery; diagnostics.ajaxHelper = !!window.jQuery?.qccAjax;
      diagnostics.templateRenderer = typeof window.jQuery?.templates === 'function';
      diagnostics.config = !!pageConfig; diagnostics.template = !!document.querySelector('#productlistTmpl');
      diagnostics.templateIds = Array.from(document.querySelectorAll('script[type="text/x-jsrender"]'), x=>x.id).slice(0,20);
      const token = window.jQuery?.cookie?.('token');
      if (!token) throw new Error('platform_login：青创网未登录');
      if (!window.jQuery?.qccAjax || !pageConfig) throw new Error(`platform_contract：青创网已识别登录，但搜图页面未就绪（请求模块 ${diagnostics.ajaxHelper}，配置 ${diagnostics.config}）`);
      // The official clipboard flow uploads base64, then requests by FileFullPath.
      // Decode the data URL locally; page fetch(data:) is blocked in some real sessions.
      diagnostics.stage = 'image_decode';
      const bitmap = await createImageBitmap(dataUrlBlob(base64));
      let scaled;
      try {
        const scale = Math.min(1,1024/Math.max(bitmap.width,bitmap.height));
        const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width*scale); canvas.height = Math.round(bitmap.height*scale);
        if (canvas.width < 80 || canvas.height < 80) throw new Error('image_dimensions：青创网短边至少 80 像素');
        canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height); scaled=canvas.toDataURL('image/jpeg',0.9);
      } finally { bitmap.close(); }
      check(); diagnostics.stage = 'image_upload'; const form = new FormData(); form.append('image',scaled); form.append('enc_auth_token',token);
      const uploaded = await ajax({ url: 'https://img.17qcc.com/picture/UploadBase64Image', type: 'POST', contentType: false, processData: false, data: form, dataType: 'json' });
      let path = uploaded?.Result?.FileFullPath;
      if (!path) throw new Error(`platform_upload：青创网未返回图片路径；${String(uploaded?.Error?.Message || '').slice(0,120)}`);
      path = path.split('?')[0].replace(/^https:\/\/pics\.17qcc\.com/, ''); check();
      diagnostics.stage = 'image_search'; const response = await bounded(new Promise((resolve, reject) => {
        let settled = false;
        const finish = (value, source = 'native_callback') => {
          if (!settled) { settled = true; diagnostics.searchCallbackSource = source; resolve(value); }
        };
        const fail = (request, status, error) => {
          if (settled) return;
          settled = true;
          const code = Number(request?.status) || 0;
          diagnostics.httpStatus = code;
          diagnostics.httpStatusText = String(request?.statusText || status || error || '').slice(0, 80);
          reject(new Error(`platform_http：青创网搜图请求失败${code ? `（HTTP ${code}）` : '（HTTP 0，可能是网络或登录态）'}`));
        };
        let xhr;
        try { xhr = window.jQuery.qccAjax('/api/services/app/ImgSearch/GetProductListByImg', { ImgUrl: path, ImgSearchChannel: pageConfig.ImgSearchChannel }, finish, { mustLogin: true }); }
        catch (error) { fail(null, 'exception', error.message); return; }
        diagnostics.requestReturnType = typeof xhr;
        diagnostics.requestHasDone = typeof xhr?.done === 'function';
        diagnostics.requestHasThen = typeof xhr?.then === 'function';
        if (xhr?.done) {
          const completed = xhr.done(value => finish(value, 'jqXHR.done'));
          const failed = typeof completed?.fail === 'function' ? completed : xhr;
          if (typeof failed?.fail === 'function') failed.fail(fail);
        }
        else if (xhr?.then) xhr.then(value => finish(value, 'Promise.then'), fail);
        if (xhr?.abort) job.aborts.push(() => xhr.abort());
      }));
      diagnostics.searchResponseKeys = response && typeof response === 'object' ? Object.keys(response).sort().slice(0,40) : [];
      diagnostics.resultType = response?.Result == null ? String(response?.Result) : Array.isArray(response.Result) ? 'array' : typeof response.Result;
      diagnostics.resultKeys = response?.Result && typeof response.Result === 'object' && !Array.isArray(response.Result) ? Object.keys(response.Result).sort().slice(0,80) : [];
      if (!response?.Success || response.Result == null) {
        const code = String(response?.Error?.Code || '');
        const message = String(response?.Error?.Message || '响应失败');
        diagnostics.errorCode = code || null;
        if (code === '-10001') {
          diagnostics.failureKind = 'quota'; diagnostics.retryable = false;
          throw new Error(`platform_quota：青创网本月图片搜索次数已达上限（${code}）；${message}`);
        }
        if (code === '910001') {
          diagnostics.failureKind = 'verification'; diagnostics.retryable = false;
          throw new Error(`platform_verification：青创网要求先完成账号认证后才能图片搜索（${code}）；${message}`);
        }
        throw new Error(`platform_response：青创网 ${code} ${message}`);
      }
      diagnostics.stage = 'result_parse';
      let apiProblem = '';
      try { items = qccApiItems(response); } catch (error) { apiProblem = error.message; }
      if (items) {
        diagnostics.dataSource = 'qcc_api';
        diagnostics.apiItems = items.length;
        diagnostics.emptyResult = items.length === 0;
      } else {
        diagnostics.apiFallbackReason = apiProblem || '未返回已确认的 Result.Items 数组';
        if (!diagnostics.templateRenderer || !diagnostics.template) throw new Error(`platform_contract：青创网接口结构无法解析且模板回退不可用（模板渲染器 ${diagnostics.templateRenderer}）`);
        let rendered;
        try { rendered = window.jQuery.templates('#productlistTmpl').render(response); }
        catch { throw new Error('platform_contract：青创网接口结构与页面模板均无法解析'); }
        const root = new DOMParser().parseFromString(`<ul>${rendered}</ul>`, 'text/html');
        diagnostics.templateOutputLength = rendered.length;
        diagnostics.renderedListItems = root.querySelectorAll('li').length;
        diagnostics.productAnchors = root.querySelectorAll('a[href*="/product/detail/"], a[href*="/item/"]').length;
        items = cards(root, 'li', 'qcc').filter(x => x.id);
        if (!items.length) throw new Error('platform_contract：青创网模板未产生可验证的商品条目；接口结构变化不能当作无商品');
        diagnostics.dataSource = 'qcc_template';
        diagnostics.emptyResult = diagnostics.renderedListItems === 0;
      }
    } else if (platform === 'e3hui_upload') {
      if (!/^www\.e3hui\.(com|cn)$/.test(location.hostname)) throw new Error('platform_origin：衣衫汇地址不匹配');
      if (!window.jQuery?.ajax) throw new Error('platform_contract：衣衫汇页面尚未加载');
      const input = document.querySelector('.file-input');
      const endpoint = url(input?.dataset.url);
      diagnostics.uploadControlPresent = !!input;
      const permissionGate = document.querySelector('.icon-imgseek');
      const forbiddenValues = [input?.getAttribute('data-forbidden'), permissionGate?.getAttribute('data-forbidden')];
      try { if (permissionGate && typeof window.jQuery === 'function') forbiddenValues.push(window.jQuery(permissionGate).data('forbidden')); } catch {}
      diagnostics.uploadControlForbidden = forbiddenValues.some(value => value === true || value === 1 || /^(1|true)$/i.test(String(value ?? '').trim()));
      diagnostics.permissionGatePresent = !!permissionGate;
      diagnostics.uploadOrigin = endpoint ? new URL(endpoint).origin : null;
      if (diagnostics.uploadControlForbidden) {
        diagnostics.failureKind = 'permission'; diagnostics.retryable = false;
        throw new Error('platform_permission：衣衫汇当前账号未获得以图搜款权限，官方控件禁止上传；请完成平台要求的认证/权限开通后重试');
      }
      if (!endpoint) throw new Error('platform_login_or_permission：衣衫汇未提供上传地址，请确认已登录且账号具备搜图权限');
      if (new URL(endpoint).protocol !== 'https:') throw new Error('platform_contract：衣衫汇上传地址不是 HTTPS，未发送图片');
      diagnostics.stage = 'image_decode';
      const blob = dataUrlBlob(base64);
      if (blob.size > 4194304) throw new Error('image_size：衣衫汇图片须小于 4MB');
      diagnostics.uploadMode = 'multipart_form_data'; diagnostics.uploadField = 'file'; diagnostics.imageMime = blob.type || null; diagnostics.imageBytes = blob.size;
      diagnostics.stage = 'image_validate';
      const bitmap = await createImageBitmap(blob);
      try {
        diagnostics.imageWidth = bitmap.width; diagnostics.imageHeight = bitmap.height;
        if (bitmap.width < 201 || bitmap.height < 201) throw new Error(`image_dimensions：衣衫汇要求宽高均至少 201 像素（当前 ${bitmap.width}×${bitmap.height}），未上传图片`);
      } finally { bitmap.close(); }
      const form = new FormData(); form.append('file', blob, 'product.jpg'); check();
      diagnostics.stage = 'image_upload'; const uploaded = await ajax({ url: endpoint, type: 'POST', data: form, dataType: 'json', contentType: false, processData: false });
      diagnostics.uploadResponseHasPath = !!uploaded?.path;
      if (!uploaded?.path) throw new Error('platform_upload：衣衫汇未返回 path，不能开始检索');
      diagnostics.stage = 'image_search';
      const searchPath = `/purchaser/img-search?url=${encodeURIComponent(String(uploaded.path))}`;
      diagnostics.resultPagePath = '/purchaser/img-search';
      return { ok: true, requestId, searchPath, items: [], total: null, received: 0, diagnostics };
    } else if (platform === 'e3hui_parse') {
      if (!/^www\.e3hui\.(com|cn)$/.test(location.hostname)) throw new Error('platform_origin：衣衫汇地址不匹配');
      diagnostics.pageTitle = String(document.title || '').slice(0,120);
      if (/登录|发生错误/.test(document.title)) throw new Error('platform_login_or_response：衣衫汇返回登录/错误页');
      const currentImageSearch = location.pathname === '/purchaser/search' && new URLSearchParams(location.search).has('params');
      const legacyRoot = document.querySelector('#searchPage');
      const currentRoot = currentImageSearch && /已为您搜到\s*\d+\s*件相似货源/.test(document.body.textContent || '') ? document.querySelector('.list-seat') : null;
      const root = currentRoot || legacyRoot;
      const resultSelector = currentRoot ? 'li.pro-224' : '.pro-list > li.pro-224';
      diagnostics.stage = 'result_wait';
      const ready = await waitReady(() => {
        const activeRoot = currentRoot || document.querySelector('#searchPage');
        const selector = currentRoot ? 'li.pro-224' : '.pro-list > li.pro-224';
        return !!activeRoot && (!!activeRoot.querySelector(selector) || /没有找到|暂无商品|无搜索结果/.test(activeRoot.textContent));
      });
      diagnostics.resultContainerPresent = !!root;
      diagnostics.resultRoute = currentImageSearch ? 'purchaser_search_params' : 'img_search_legacy';
      if (!root) throw new Error('platform_contract：衣衫汇图片结果容器未确认，未将其他商品冒充结果');
      if (!ready) throw new Error('platform_timeout：衣衫汇结果列表 5 秒内未就绪，不能判定无商品');
      diagnostics.stage = 'result_parse';
      diagnostics.renderedProductCards = root.querySelectorAll(resultSelector).length;
      const countMatch = currentImageSearch && (document.body.textContent || '').match(/已为您搜到\s*(\d+)\s*件相似货源/);
      total = countMatch ? Number(countMatch[1]) : null;
      items = cards(root, resultSelector, 'e3hui').filter(x => x.id);
      diagnostics.parsedProductCards = items.length;
      if (!items.length && !/没有找到|暂无商品|无搜索结果/.test(root.textContent)) throw new Error('platform_contract：衣衫汇没有可读取的结果或明确空结果标记');
      diagnostics.emptyResult = items.length === 0;
    } else throw new Error('platform_input：未知平台');
    check(); diagnostics.stage = partial ? 'partial' : 'complete'; return { ok: true, requestId, items, total, received: items.length, partial, diagnostics };
  } catch (error) { diagnostics.elapsedMs=Date.now()-startedAt;return { ok: false, requestId, error: String(error.message || error).slice(0,300), diagnostics }; }
  finally { delete jobs[requestId]; }
}
