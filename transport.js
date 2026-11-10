globalThis.FindTransport = (() => {
  let current = null;
  let batch = null;
  const platforms = {
    wsy: { name: '网商园', mode: 'automatic', url: 'https://www.wsy.com/new/search/image', matches: ['https://www.wsy.com/*', 'https://wsy.com/*'] },
    zwd: { name: '17网', mode: 'automatic', url: 'https://stu.17zwd.com/SearchSimilar', matches: ['https://stu.17zwd.com/*'] },
    qcc: { name: '青创网', mode: 'automatic', url: 'https://www.17qcc.com/imagesearch.html', matches: ['https://www.17qcc.com/*'] },
    e3hui: { name: '衣衫汇', mode: 'automatic', url: 'https://www.e3hui.cn/', matches: ['https://www.e3hui.cn/*', 'https://www.e3hui.com/*'] }
  };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function ensureSession(tabId, platform) {
    if (!chrome.runtime?.sendMessage) return;
    const result = await chrome.runtime.sendMessage({ type: 'ENSURE_PLATFORM_SESSION', tabId, platform });
    if (result?.ok === false) throw new Error(`platform_login：${result.error}`);
    if (result?.state === 'signed_in') {
      await chrome.tabs.update(tabId, { url: platforms[platform].url });
      for (let i = 0; i < 60; i++) { if ((await chrome.tabs.get(tabId)).status === 'complete') break; await delay(200); }
    }
  }
  function navigateTab(tabId, url, job) {
    return new Promise((resolve, reject) => {
      let navigated = false;
      let latestUrl = '';
      const cleanup = () => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
      };
      const fail = error => { cleanup(); reject(error); };
      const onUpdated = (id, changeInfo) => {
        if (id !== tabId) return;
        if (changeInfo.url) { navigated = true; latestUrl = changeInfo.url; }
        if (navigated && changeInfo.status === 'complete') {
          cleanup(); chrome.tabs.get(tabId).then(tab => resolve({ ...tab, url: tab?.url || latestUrl }), reject);
        }
      };
      const onRemoved = id => { if (id === tabId) fail(new Error(job.cancelled ? 'request_cancelled：请求已取消' : 'platform_navigation：衣衫汇临时页面已关闭')); };
      const timer = setTimeout(() => fail(new Error('platform_timeout：衣衫汇结果页导航超过 30 秒')), 30000);
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
      chrome.tabs.update(tabId, { url }).catch(fail);
    });
  }
  const batchTimeout = 75000;
  function cancel() {
    const activeBatch = batch;
    const activeCurrent = current;
    const cleanup = [];
    if (activeBatch) activeBatch.cancelled = true;
    activeBatch?.rejectCancel?.(new Error('request_cancelled：已停止搜索'));
    // Mark and signal the WSY request before awaiting cleanup for other sites.
    // Otherwise its response could settle and clear `current` during cleanup.
    if (activeCurrent) {
      activeCurrent.cancelled = true;
      if (activeCurrent.tabId != null) cleanup.push(chrome.tabs.sendMessage(activeCurrent.tabId, { type: 'CORE_CANCEL', requestId: activeCurrent.id }).catch(() => {}));
    }
    if (activeBatch) {
      cleanup.push(...activeBatch.tabs.map(tabId => chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: id => {
        const job = window.__findPlatformJobs?.[id]; if (job) { job.cancelled = true; job.aborts.forEach(fn => fn()); }
      }, args: [activeBatch.id] })));
      cleanup.push(...[...activeBatch.ownedTabs].map(tabId => chrome.tabs.remove(tabId).catch(() => {})));
    }
    void Promise.allSettled(cleanup);
  }
  async function search(base64, requestId, progress) {
    if (current) throw new Error('request_busy：已有搜索进行中');
    const job = { id: requestId, tabId: null, cancelled: false, owned: false };
    current = job;
    const check = () => { if (job.cancelled) throw new Error('request_cancelled：已取消搜索'); };
    try {
      progress('platform_connect', '连接网商园…');
      const tabs = await chrome.tabs.query({ url: ['https://www.wsy.com/*', 'https://wsy.com/*'] });
      check();
      const reusableTab = tabs.find(item => !/login/i.test(item.url || '') && !item.discarded && item.frozen !== true);
      const tab = reusableTab || await chrome.tabs.create({ url: 'https://www.wsy.com/new/search/image', active: false });
      // A matching tab may exist but still be unusable (login, frozen, or discarded).
      // Track ownership from the tab we actually selected so newly created tabs are cleaned up.
      job.owned = !reusableTab; job.tabId = tab.id;
      await ensureSession(tab.id, 'wsy'); check();
      let ready = false, lastError = '', recoveredErrorPage = false;
      // A fresh MV3 content script can take longer than the page load to
      // register its message listener. Keep this as a read-only handshake and
      // allow up to roughly 12 seconds before reporting the platform failure.
      for (let attempt = 0; attempt < 30; attempt++) {
        check();
        try {
          const pong = await chrome.tabs.sendMessage(tab.id, { type: 'CORE_PING' });
          if (pong?.ok && pong.version === '0.1.0') { ready = true; break; }
        } catch (error) { lastError = error.message; }
        const info = await chrome.tabs.get(tab.id);
        // Background tabs can expose a usable document while still reporting
        // loading and before document_idle content scripts run. Do not wait
        // for a complete event that may be delayed by unrelated page resources.
        const pageUrl = info.url || info.pendingUrl || tab.url || '';
        if (info.status === 'complete' || /^https:\/\/(?:www\.)?wsy\.com\//i.test(pageUrl)) {
          try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, injectImmediately: true, files: ['core.js', 'wsy-http.js', 'wsy-bridge.js'] }); }
          catch (error) {
            lastError = error.message;
            // Chromium can leave a newly created tab on its network error page
            // even after the original navigation has recovered. Re-navigate
            // once before reporting the platform as unavailable.
            if (!recoveredErrorPage && /error page|Frame with ID/i.test(lastError)) {
              recoveredErrorPage = true;
              await chrome.tabs.update(tab.id, { url: 'https://www.wsy.com/new/search/image' }).catch(() => {});
            }
          }
        }
        await delay(400);
      }
      if (!ready) throw new Error(`platform_connect：网商园页面未就绪；${lastError || '请确认网址和扩展权限'}`);
      check();
      progress('platform_search', '图片已提交网商园，等待接口结果（最多约 25 秒）…');
      let timer;
      const response = await Promise.race([
        chrome.tabs.sendMessage(tab.id, { type: 'CORE_SEARCH', requestId, base64 }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('bridge_timeout：页面没有回传结果，搜索未完成')), 30000); })
      ]).finally(() => clearTimeout(timer));
      check();
      if (!response?.ok) throw new Error(response?.error || 'bridge_response：页面未回传有效响应');
      if (response.requestId !== requestId) throw new Error('bridge_response：结果属于其他搜索，已拒绝显示');
      if (job.owned) await chrome.tabs.remove(tab.id).catch(() => {});
      return response;
    } catch (error) {
      if (job.tabId != null) await chrome.tabs.sendMessage(job.tabId, { type: 'CORE_CANCEL', requestId }).catch(() => {});
      if (job.cancelled && job.owned && job.tabId != null) await chrome.tabs.remove(job.tabId).catch(() => {});
      else if (job.owned && job.tabId != null && error && typeof error === 'object') error.openTabId = job.tabId;
      throw error;
    } finally { if (current === job) current = null; }
  }
  async function searchOther(key, base64, job, progress) {
    const config = platforms[key];
    const check = () => { if (job.cancelled) throw new Error('request_cancelled：请求已取消'); };
    if (config.mode === 'assisted') {
      check();
      return { assisted: true, phase: 'manual_required', message: `${config.name}需要在平台页面登录并手动完成搜图；本次不自动提交图片`, items: [], total: null,
        diagnostics: { mode: 'assisted', page: config.url, reason: 'platform_login_or_permission' } };
    }
    progress('platform_connect', '连接平台页面');
    const tabs = await chrome.tabs.query({ url: config.matches }); check();
    let tab = tabs.find(t => (key === 'qcc' ? /imagesearch\.html/i.test(t.url || '') : !/login/i.test(t.url || '')) && !t.discarded && t.frozen !== true);
    if (key === 'zwd' && tab && !/searchsimilar/i.test(tab.url)) tab = null;
    // E3's official flow navigates to the result page, so isolate it in a temporary tab.
    const isUsableE3Page = t => /^https:\/\/www\.e3hui\.(com|cn)\//i.test(t.url || '') && !t.discarded && t.frozen !== true;
    let originPage = null, e3OriginSource = 'configured_default';
    if (key === 'e3hui') {
      const candidates = tabs.filter(isUsableE3Page).sort((a,b) => Number(b.active) - Number(a.active));
      for (const candidate of candidates) {
        check();
        try {
          const probe = (await chrome.scripting.executeScript({ target: { tabId: candidate.id }, world: 'MAIN', func: () => {
            const input = document.querySelector('.file-input[data-url]');
            if (!input?.dataset.url) return false;
            try { return new URL(input.dataset.url, location.href).protocol === 'https:'; } catch { return false; }
          } }))[0]?.result;
          check();
          if (probe === true) { originPage = candidate; e3OriginSource = 'existing_upload_control'; break; }
        } catch {}
      }
      if (!originPage) {
        originPage = candidates.find(t => t.active) || candidates[0] || null;
        if (originPage) e3OriginSource = originPage.active ? 'active_site_tab' : 'first_site_tab';
      }
    }
    let e3Origin = null;
    let e3FlowStage = key === 'e3hui' ? 'page_load' : null;
    if (key === 'e3hui') {
      try {
        const parsed = new URL(originPage ? originPage.url : config.url);
        if (parsed.protocol !== 'https:' || !/^www\.e3hui\.(com|cn)$/i.test(parsed.hostname)) throw new Error('invalid origin');
        e3Origin = parsed.origin;
      } catch {
        const error = new Error('platform_url：衣衫汇站点基址无效，未创建上传任务');
        error.diagnostics = { platform: 'e3hui', stage: 'site_origin', originSource: e3OriginSource, originValid: false };
        throw error;
      }
    }
    if (key === 'e3hui') tab = null;
    const owned = !tab;
    if (!tab) {
      tab = await chrome.tabs.create({ url: e3Origin ? `${e3Origin}/` : config.url, active: false });
      job.tabs.push(tab.id);
      if (owned) job.ownedTabs.add(tab.id);
      if (job.cancelled) {
        if (owned) { await chrome.tabs.remove(tab.id).catch(() => {}); job.ownedTabs.delete(tab.id); }
        throw new Error('request_cancelled：请求已取消');
      }
    } else job.tabs.push(tab.id);
    try {
      for (let i=0; i<30; i++) {
        check(); const info = await chrome.tabs.get(tab.id);
        if (info.status === 'complete') break;
        if (i === 29) throw new Error('platform_connect：页面 12 秒内未就绪');
        await delay(400);
      }
      check();
      await ensureSession(tab.id, key); check();
      if (key === 'qcc') {
        // The public HTTPS image-search route can redirect anonymous sessions to an
        // HTTP login page. That page is outside the extension's HTTPS permissions;
        // detect it before scripting so the user gets an actionable login diagnosis.
        let loadedUrl;
        try { loadedUrl = new URL(String((await chrome.tabs.get(tab.id))?.url || '')); } catch { loadedUrl = null; }
        if (!loadedUrl || loadedUrl.protocol !== 'https:' || loadedUrl.hostname.toLowerCase() !== 'www.17qcc.com') {
          const isLogin = /login|passport/i.test(loadedUrl?.pathname || '') || /login|passport/i.test(loadedUrl?.hostname || '');
          const error = new Error(isLogin
            ? 'platform_login：青创网将搜图页重定向到登录页；请在 HTTPS 官方页面完成登录后重试（本次未注入登录页）'
            : 'platform_origin：青创网页面已跳出 HTTPS 官方域名，未执行注入');
          error.diagnostics = { platform: 'qcc', stage: 'page_load', pageProtocol: loadedUrl?.protocol || null, pageHost: loadedUrl?.hostname || null, redirectedToPage: true };
          throw error;
        }
      }
      progress('platform_search', key === 'qcc' ? '青创网已发送上传/搜图请求，等待页面回调（最多约 25 秒）…' : key === 'e3hui' ? '衣衫汇正在上传图片并打开官方结果页…' : '调用平台图片搜索接口');
      let result;
      if (key === 'e3hui') {
        e3FlowStage = 'image_upload';
        const uploaded = (await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: searchPlatformPage, args: ['e3hui_upload',base64,job.id] }))[0]?.result;
        check();
        if (!uploaded?.ok || uploaded.requestId !== job.id || !uploaded.searchPath) {
          const error = new Error(uploaded?.error || 'platform_upload：衣衫汇未取得官方结果地址');
          error.diagnostics = { ...(uploaded?.diagnostics || {}), originSource: e3OriginSource };
          throw error;
        }
        let searchUrl;
        e3FlowStage = 'result_url';
        try { searchUrl = new URL(String(uploaded.searchPath || ''), `${e3Origin}/`); }
        catch {
          const error = new Error('platform_contract：衣衫汇返回的结果地址无法构造，上传阶段已完成但未导航');
          error.diagnostics = { ...(uploaded.diagnostics || {}), stage: 'result_url', resultUrlValid: false };
          throw error;
        }
        const resultUrlValid = searchUrl.origin === e3Origin && searchUrl.pathname === '/purchaser/img-search';
        uploaded.diagnostics = { ...(uploaded.diagnostics || {}), stage: 'result_url', resultUrlValid, originSource: e3OriginSource };
        if (!resultUrlValid) {
          const error = new Error('platform_contract：衣衫汇返回的结果地址无效，未导航'); error.diagnostics = uploaded.diagnostics; throw error;
        }
        let resultTab;
        e3FlowStage = 'navigation';
        try { resultTab = await navigateTab(tab.id, searchUrl.href, job); }
        catch (error) { error.diagnostics = { ...uploaded.diagnostics, stage: 'navigation' }; throw error; }
        check();
        e3FlowStage = 'result_loaded';
        let finalUrl;
        try {
          const reportedUrl = String(resultTab?.url || '').trim();
          if (!reportedUrl) throw new Error('missing URL');
          finalUrl = new URL(reportedUrl);
        }
        catch {
          const error = new Error('platform_navigation：衣衫汇结果页地址不可读取，上传已完成但未取得可靠页面地址');
          error.diagnostics = { ...uploaded.diagnostics, stage: 'navigation', resultUrlValid: false };
          throw error;
        }
        const searchDiagnostics = { ...uploaded.diagnostics, stage: 'result_loaded', responseUrl: finalUrl.origin + finalUrl.pathname };
        if (/login|passport/i.test(finalUrl.pathname)) {
          const error = new Error('platform_login：衣衫汇结果页跳转到登录页面'); error.diagnostics = { ...searchDiagnostics, redirectedToPage: true }; throw error;
        }
        const currentImageSearchRoute = finalUrl.pathname === '/purchaser/search' && finalUrl.searchParams.has('params');
        if (finalUrl.origin !== searchUrl.origin || (finalUrl.pathname !== searchUrl.pathname && !currentImageSearchRoute)) {
          const safeResponseUrl = finalUrl.origin + finalUrl.pathname;
          const destination = finalUrl.pathname === '/' ? '站点首页' : safeResponseUrl;
          const error = new Error(`platform_redirect：衣衫汇结果页跳转到${destination}，可能是登录态未生效或账号没有以图搜款权限`);
          error.diagnostics = { ...searchDiagnostics, redirectedToPage: true, responseUrl: safeResponseUrl }; throw error;
        }
        searchDiagnostics.resultRoute = currentImageSearchRoute ? 'purchaser_search_params' : 'img_search_legacy';
        searchDiagnostics.stage = 'result_parse';
        e3FlowStage = 'result_parse';
        const parsed = (await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: searchPlatformPage, args: ['e3hui_parse','',job.id] }))[0]?.result;
        if (!parsed?.ok || parsed.requestId !== job.id) {
          const error = new Error(parsed?.error || 'platform_response：衣衫汇结果页未回传商品');
          error.diagnostics = { ...searchDiagnostics, ...parsed?.diagnostics }; throw error;
        }
        result = { ...parsed, diagnostics: { ...searchDiagnostics, ...parsed.diagnostics } };
      } else {
        // executeScript serializes the function; it must not depend on workbench closures.
        result = (await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: searchPlatformPage, args: [key,base64,job.id] }))[0]?.result;
      }
      check();
      if (!result?.ok || result.requestId !== job.id) { const error = new Error(result?.error || 'platform_response：未收到本次有效结果'); error.diagnostics = result?.diagnostics; throw error; }
      if (owned) { await chrome.tabs.remove(tab.id).catch(() => {}); job.ownedTabs.delete(tab.id); }
      return result;
    } catch (error) {
      if (job.cancelled && owned) { await chrome.tabs.remove(tab.id).catch(() => {}); job.ownedTabs.delete(tab.id); }
      else if (owned && error && typeof error === 'object') error.openTabId = tab.id;
      if (key === 'e3hui' && error && typeof error === 'object') {
        error.diagnostics = { platform: key, stage: e3FlowStage, originSource: e3OriginSource, ...(error.diagnostics || {}) };
      }
      throw error;
    }
  }
  async function searchAll(base64, requestId, selected, update) {
    if (batch || current) throw new Error('request_busy：已有搜索进行中');
    const keys = [...new Set(selected)].filter(key => platforms[key]);
    if (!keys.length) throw new Error('input：至少选择一个平台');
    const job = { id: requestId, tabs: [], ownedTabs: new Set(), cancelled: false };
    let rejectCancel;
    const cancelled = new Promise((_, reject) => { rejectCancel = reject; });
    job.rejectCancel = rejectCancel; batch = job;
    try {
      let timeoutId;
      const records = await Promise.race([
        Promise.all(keys.map(async key => {
        const progress = (phase, message) => { if (!job.cancelled) update(key, { phase, message }); };
        try {
          const result = key === 'wsy' ? await search(base64,requestId,progress) : await searchOther(key,base64,job,progress);
          if (job.cancelled) throw new Error('request_cancelled：请求已取消');
          if (result.assisted) { update(key, result); return { key, ...result }; }
          const partial = result.partial === true;
          const failedGroups = result.diagnostics?.searchGroups?.filter(group => group.phase === 'failed') || [];
          const groupSummary = result.diagnostics?.searchGroups?.map(group => `${group.type === 'accurate' ? '准确搜' : '相似搜'} ${group.phase === 'complete' ? group.received : '失败'}`).join('，');
          const record = { ...result, phase: partial ? 'partial' : 'complete', message: partial
            ? `部分检索完成，收到 ${result.items.length} 条；${groupSummary || failedGroups.map(group => `${group.type}失败`).join('、')}`
            : `实际收到 ${result.items.length} 条${groupSummary ? `（${groupSummary}）` : ''}` };
          update(key, record); return { key, ...record };
        } catch (error) {
          const record = { phase: 'failed', message: error.message, items: [], total: null, diagnostics: error.diagnostics || null, ...(Number.isInteger(error.openTabId) ? { openTabId: error.openTabId } : {}) };
          if (!job.cancelled) update(key,record); return { key, ...record };
        }
        })),
        cancelled,
        new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('search_timeout：并行平台搜索超过 75 秒，已停止等待并保留已返回结果')), batchTimeout); })
      ]).catch(error => {
        job.cancelled = true;
        if (String(error?.message || error).startsWith('search_timeout')) void cancel();
        throw error;
      }).finally(() => clearTimeout(timeoutId));
      if (job.cancelled) throw new Error('request_cancelled：请求已取消');
      return { items: records.flatMap(r => r.items), records };
    } finally { if (batch === job) batch = null; }
  }
  return { search, searchAll, cancel, platforms };
})();
