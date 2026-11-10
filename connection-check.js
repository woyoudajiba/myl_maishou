// Serialized by chrome.scripting into MAIN. Inspect only: no fetch, no upload,
// no invocation of site APIs, no cookies/account fields/request headers.
function inspectPlatformConnection(platform) {
  const path = value => {
    if (typeof value !== 'string' || !value.trim()) return '';
    try { const u = new URL(value, location.href); return /^https?:$/.test(u.protocol) ? u.origin + u.pathname : ''; } catch { return ''; }
  };
  const globals = Object.getOwnPropertyDescriptors(window);
  const callable = value => typeof value === 'function';
  const describeJquery = value => ({ present:!!value, version: typeof value?.fn?.jquery === 'string' ? value.fn.jquery : null,
    ajax: callable(value?.ajax), qccAjax: callable(value?.qccAjax), templates: callable(value?.templates), cookie: callable(value?.cookie),
    helperNames: value ? Object.keys(value).filter(k=>/qcc|ajax|encrypt|api/i.test(k)).slice(0,80) : [] });
  const runtimes = [];
  if (platform === 'zwd') {
    for (const name of Object.keys(globals).filter(k=>/^webpack(Jsonp|Chunk)/i.test(k)).slice(0,12)) {
      const queue = globals[name].value;
      const record = { name, array:Array.isArray(queue), queuedChunks:Array.isArray(queue) ? queue.length : null, active:false, captured:false, moduleCount:null, moduleIds:[], error:'' };
      if (Array.isArray(queue) && queue.push !== Array.prototype.push) {
        record.active=true;
        const probe = 'find-connection-' + crypto.randomUUID();
        let requirePage;
        try {
          // Support the observed Webpack 4 executeModules and Webpack 5 runtime
          // callback conventions. Only our own probe executes; no site module is required.
          if (/^webpackChunk/i.test(name)) queue.push([[probe], {}, require => { requirePage=require; }]);
          else queue.push([[probe], { [probe]:(_module,_exports,require)=>{requirePage=require;} }, [[probe]]]);
          record.captured=typeof requirePage==='function';
          if (requirePage?.m) {
            const ids=Object.keys(requirePage.m).filter(k=>k!==probe);
            record.moduleCount=ids.length;
            record.moduleIds=ids.filter(k=>ids.length<=100 || /apiCaller|tusou|searchsimilar|config\/clientConfig/i.test(k)).slice(0,200);
            delete requirePage.m[probe];
            if (requirePage.c) delete requirePage.c[probe];
          }
        } catch { record.error='无法读取此运行时模块表'; }
      }
      runtimes.push(record);
    }
  }
  const scripts=Array.from(document.scripts).filter(x=>x.src).map(x=>({url:path(x.src), type:x.type || 'classic', async:x.async, defer:x.defer})).slice(0,80);
  const resources=performance.getEntriesByType('resource').filter(x=>/script|xmlhttprequest|fetch/.test(x.initiatorType)).slice(-100).map(x=>({
    url:path(x.name), initiator:x.initiatorType, durationMs:Math.round(x.duration), responseStatus:typeof x.responseStatus==='number'?x.responseStatus:null,
    // A zero transfer size alone cannot prove failure (cache and cross-origin limits).
    transferSize:x.transferSize ?? null
  }));
  const templates=Array.from(document.querySelectorAll('script[type="text/x-jsrender"],script[type="text/x-template"]')).map(x=>({
    id:x.id, fields:[...new Set(Array.from(x.textContent.matchAll(/\{\{[:>]\s*([A-Za-z][A-Za-z0-9_.]*)/g),m=>m[1]))].slice(0,80)
  })).slice(0,20);
  const qconfig=typeof cfgPage!=='undefined'?cfgPage:window.cfgPage;
  // Read only public page structure, never input values or session credentials.
  const visible = element => !!element?.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
  const loginPage = /(?:^|[/.\-_])(login|signin|passport)(?:[/.\-_]|$)/i.test(location.hostname + location.pathname) || location.hostname === 'sso.e3hui.cn';
  const loginForm = Array.from(document.querySelectorAll('input[type=password]')).some(visible);
  const forbidden = platform === 'e3hui' && Array.from(document.querySelectorAll('.file-input,.icon-imgseek')).some(element => /^(1|true)$/i.test(element.getAttribute('data-forbidden') || ''));
  const access = { state: loginPage || loginForm ? 'login_required' : forbidden ? 'permission_required' : document.readyState === 'loading' ? 'loading' : 'unverified' };
  return { platform, page:path(location.href), readyState:document.readyState,
    access,
    jquery:describeJquery(window.jQuery), dollar:describeJquery(typeof $!=='undefined'?$:null),
    globalHelperNames:Object.keys(globals).filter(k=>/qcc|ajax|webpack|apiCaller/i.test(k)).slice(0,80),
    qccConfigPresent:!!qconfig, qccChannelType:qconfig ? typeof qconfig.ImgSearchChannel : null,
    scripts, resources, templates, runtimes,
    uploadControls:Array.from(document.querySelectorAll('input[type=file]')).slice(0,12).map(x=>({id:x.id,className:x.className,accept:x.accept,uploadUrl:path(x.getAttribute('data-url'))})),
    serviceWorker:path(navigator.serviceWorker?.controller?.scriptURL),
    note:'未调用平台接口；不含Cookie、账号信息、URL查询参数、请求头或图片数据。资源状态0/体积0不能单独认定失败。'
  };
}

globalThis.FindConnectionCheck = {
  async collect(progress = () => {}) {
    const report={version:chrome.runtime.getManifest().version, checkedAt:new Date().toISOString(), mode:'read_only_existing_tabs', pages:[]};
    const deadline = Date.now() + 20000;
    const bounded = async operation => {
      let timer;
      try { return await Promise.race([operation, new Promise((_,reject) => { timer=setTimeout(()=>reject(new Error('inspect_timeout')),Math.max(1,Math.min(5000,deadline-Date.now()))); })]); }
      finally { clearTimeout(timer); }
    };
    const original=(await bounded(chrome.tabs.query({active:true,currentWindow:true})))[0];
    const safePath=value=>{try { if (!value) return ''; const u=new URL(value);return u.origin+u.pathname; } catch {return '';} };
    let activated = null;
    try {
    for (const [key,config] of Object.entries(FindTransport.platforms)) {
      if (Date.now() >= deadline) { report.pages.push({platform:key,status:'check_timeout'}); continue; }
      // Include known login redirects for diagnosis only. Search still uses its
      // original platform matches, and HTTP login pages are never injected.
      const loginMatches = key === 'e3hui' ? ['https://sso.e3hui.cn/*'] : key === 'qcc' ? ['http://www.17qcc.com/*'] : [];
      let tabs;
      try { tabs=await bounded(chrome.tabs.query({url:[...config.matches,...loginMatches]})); }
      catch { report.pages.push({platform:key,status:'inspect_failed'}); continue; }
      if (!tabs.length) { report.pages.push({platform:key,status:'not_open',message:`没有已打开的${config.name}页面；本次不自动打开`}); continue; }
      for (const tab of tabs.slice(0,6)) {
        if (Date.now() >= deadline) { report.pages.push({platform:key,status:'check_timeout'}); break; }
        const tabState={page:safePath(tab.url), loadStatus:tab.status || null, active:!!tab.active, discarded:!!tab.discarded, frozen:typeof tab.frozen==='boolean'?tab.frozen:null};
        try {
          const url = new URL(tab.url);
          if (/(?:^|[/.\-_])(login|signin|passport)(?:[/.\-_]|$)/i.test(url.hostname+url.pathname) || url.hostname === 'sso.e3hui.cn') {
            report.pages.push({platform:key,status:'login_required',tabState,access:{state:'login_required'}}); continue;
          }
          if (url.protocol !== 'https:') { report.pages.push({platform:key,status:'unsupported_page',tabState}); continue; }
          progress(`${config.name}：正在检查页面${tab.active?'':'（会短暂切换到该标签页）'}…`);
          // Hidden/frozen documents may not execute the probe in time. Activate
          // the existing tab before inspecting, then return to the workbench.
          // Do not reload a discarded tab or open a new platform automatically.
          if(tab.discarded) {report.pages.push({platform:key,status:'discarded',tabState,error:'标签页已被浏览器释放，请打开该平台后再检查'});continue;}
          if(!tab.active) {activated=tab.id; await bounded(chrome.tabs.update(tab.id,{active:true}));}
          if (Date.now() >= deadline) { report.pages.push({platform:key,status:'check_timeout',tabState}); break; }
          const injection=chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:inspectPlatformConnection,args:[key]});
          const result=await bounded(injection);
          report.pages.push({...result[0]?.result,platform:key,status:result[0]?.result?'inspected':'no_response',tabState});
        } catch (error) {
          const timeout = String(error?.message || '').includes('inspect_timeout');
          report.pages.push({platform:key,status:timeout?'inspect_timeout':'inspect_failed',tabState,error: timeout ? '页面未在检查时限内响应；尚不能判断登录状态' : '页面无法读取，请打开平台后重试'});
        }
      }
    }
    } finally {
      if(activated!==null && original?.id!=null) await bounded(chrome.tabs.update(original.id,{active:true})).catch(()=>{});
    }
    report.inspected=report.pages.filter(x=>x.status==='inspected').length;
    report.incomplete=report.pages.some(x=>x.status!=='inspected');
    return report;
  },
  summarize(report) {
    const messages = {
      not_checked: ['未检查','打开平台并登录后，点击“检查连接”。'],
      login_required: ['需要登录','页面显示登录入口，请先登录该平台。'],
      permission_required: ['无搜图权限','平台禁止当前账号上传，请先完成认证或开通权限。'],
      loading: ['页面加载中','等待平台页面加载完成后重试。'],
      inspected: ['页面已响应','登录状态和搜图权限需在平台确认。'],
      not_open: ['未打开','请先打开该平台，再检查连接。'],
      discarded: ['页面已休眠','请切换到该平台，刷新后重试。'],
      inspect_timeout: ['页面未响应','检查等待超时，请刷新平台后重试；暂不能判断是否已登录。'],
      check_timeout: ['尚未检查','本次检查已达时限，请重新检查。'],
      no_response: ['页面未响应','未收到页面信息，请刷新平台后重试。'],
      unsupported_page: ['页面地址不支持','请打开该平台的 HTTPS 搜图页。'],
      inspect_failed: ['无法读取页面','页面可能已跳转或关闭，请打开平台后重试。']
    };
    return Object.entries(FindTransport.platforms).map(([platform,config]) => {
      const pages = (report?.pages || []).filter(page=>page.platform===platform);
      // A working page takes priority over an older login/failed tab. Among
      // otherwise blocked pages, show the specific login/permission evidence.
      const priority = ['inspected','permission_required','login_required','loading','inspect_timeout','discarded','unsupported_page','no_response','inspect_failed','check_timeout','not_open'];
      const entries = pages.map(page=>({page,code:page.access?.state && page.access.state !== 'unverified' ? page.access.state : page.status}));
      entries.sort((a,b)=>priority.indexOf(a.code)-priority.indexOf(b.code));
      const code = entries[0]?.code || (report ? 'inspect_failed' : 'not_checked');
      const [result,reason] = messages[code] || messages.inspect_failed;
      return { platform, name:config.name, code, result, reason };
    });
  }
};
