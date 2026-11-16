if (typeof importScripts === 'function') importScripts('taobao-sales.js', 'vision-protocol.js', 'vision-background.js', 'platform-login.js', 'taobao-search.js','buyer-page.js');

async function openWorkbench() {
  const url = chrome.runtime.getURL('workbench.html');
  const [tab] = await chrome.tabs.query({ url });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else await chrome.tabs.create({ url });
}
chrome.action.onClicked.addListener(() => openWorkbench().catch(error => console.error('[workbench_open]', error)));

const localEndpoint = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password && Number(url.port) > 0 ? url.origin : '';
  } catch { return ''; }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const platformLoginAttempts = new Map();
const loginHosts = { wsy: ['www.wsy.com','wsy.com','cs.wsy.com'], zwd: ['stu.17zwd.com','www.17zwd.com'], qcc: ['www.17qcc.com'], e3hui: ['www.e3hui.com','www.e3hui.cn'] };
async function ensurePlatformSession(tabId, platform) {
  if (!Object.hasOwn(loginHosts, platform) || !Number.isInteger(tabId)) throw new Error('平台登录目标无效');
  const saved = await chrome.storage.local.get(['productComparisonDesktop', 'productComparisonDesktopEnabled']);
  // Keep the existing browser-session workflow unchanged unless the user explicitly enabled desktop-managed accounts.
  if (saved.productComparisonDesktopEnabled === false || !saved.productComparisonDesktop) return { state: 'not_required' };
  for (let i = 0; i < 60; i++) {
    const info = await chrome.tabs.get(tabId);
    if (info.status === 'complete') break;
    if (i === 59) throw new Error('平台页面尚未就绪，请稍后重试');
    await sleep(200);
  }
  const info = await chrome.tabs.get(tabId);
  let url; try { url = new URL(info.url); } catch { throw new Error('平台页面地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !loginHosts[platform].includes(url.hostname)) throw new Error('平台跳转到未验证的登录地址，请手动登录后重试');
  const probe = async credential => (await chrome.scripting.executeScript({ target: { tabId }, func: FindPlatformLogin.platformLoginForm, args: [{ platform, ...(credential ? { credential } : {}) }] }))[0]?.result;
  const form = await probe();
  if (form?.state === 'not_required') return { state: 'not_required' };
  if (form?.state !== 'ready') throw new Error(form?.reason || '请在平台页面完成登录');
  if (Date.now() - (platformLoginAttempts.get(platform) || 0) < 300000) throw new Error('本平台已尝试登录，请检查账号或完成验证后再试，避免重复提交');
  const result = await desktopFetch(saved.productComparisonDesktop, `/v1/platform-credentials/${platform}`, { method: 'POST', body: JSON.stringify({ loginUrl: url.href }) });
  if (!result.credential) throw new Error('请先在桌面端设置中保存该平台账号');
  platformLoginAttempts.set(platform, Date.now());
  try {
    const sent = await probe(result.credential);
    if (sent?.state !== 'submitted') throw new Error(sent?.reason || '登录表单已变化，请手动登录');
  } finally { result.credential.username = ''; result.credential.password = ''; result.credential = null; }
  await sleep(1000);
  for (let i = 0; i < 40; i++) {
    const state = await chrome.tabs.get(tabId);
    if (state.status === 'complete') {
      const next = await probe();
      if (next?.state === 'not_required') return { state: 'signed_in' };
      if (next?.state === 'manual') throw new Error(next.reason);
    }
    await sleep(250);
  }
  throw new Error('登录尚未完成，请检查账号、验证码或平台提示后重试');
}
let desktopCommandPoll = false;
async function desktopFetch(pair, pathname, options = {}) {
  const endpoint = localEndpoint(pair.endpoint);
  if (!endpoint || typeof pair.token !== 'string' || !/^[a-f0-9]{64}$/.test(pair.token)) throw new Error('桌面配对信息无效');
  const manifest=chrome.runtime.getManifest();
  const response = await fetch(endpoint + pathname, { ...options, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(12000),
    headers: { 'X-Desktop-Token': pair.token, 'X-PC-Extension-Version':manifest.version, 'X-PC-Buyer-Protocol':'1', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) throw new Error(result?.error || `桌面连接失败（HTTP ${response.status}）`);
  return result;
}
async function workbenchTab() {
  const url = chrome.runtime.getURL('workbench.html');
  const existing = await chrome.tabs.query({ url });
  let tab = existing[0];
  if (!tab) tab = await chrome.tabs.create({ url, active: true });
  else { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }
  for (let i = 0; i < 50; i++) {
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (!current) throw new Error('扩展工作台已关闭');
    if (current.status === 'complete') return current;
    await sleep(200);
  }
  throw new Error('扩展工作台启动超时');
}
async function collectProductDetails(pair, command) {
  const domains = { wsy: ['wsy.com'], zwd: ['17zwd.com'], qcc: ['17qcc.com'], e3hui: ['e3hui.com', 'e3hui.cn'] }[command.platform] || [];
  const url = new URL(command.detailUrl);
  if (url.protocol !== 'https:' || !domains.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) throw new Error('候选详情页不属于预期供应商平台');
  const tab = await chrome.tabs.create({ url: url.href, active: true });
  let loaded = false;
  for (let i = 0; i < 150; i++) {
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (!current) throw new Error('商品详情页已关闭');
    if (current.status === 'complete') { loaded = true; break; }
    await sleep(200);
  }
  if (!loaded) throw new Error('商品详情页加载超时，页面仍保持打开');
  const login = await ensurePlatformSession(tab.id, command.platform);
  if (login.state === 'signed_in') {
    await chrome.tabs.update(tab.id, { url: url.href });
    for (let i = 0; i < 100; i++) { if ((await chrome.tabs.get(tab.id)).status === 'complete') break; await sleep(200); }
  }
  await sleep(1800);
  let scraped,lastError;
  for(let attempt=0;attempt<=3;attempt++){
    try{
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: FindBuyerPage.expandBuyerPage, args: [{ platform: command.platform }] });
      scraped=(await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: FindBuyerPage.scrapeBuyerPage, args: [{ platform: command.platform, pageRole: 'supplier' }] }))[0]?.result;
      if(scraped?.error)throw new Error(scraped.error);
      if(scraped?.quality?.state==='complete'||attempt===3)break;
    }catch(error){
      lastError=error;
      if(/平台(?:需要|要求)登录|验证码|安全验证|访问受限/.test(String(error.message||error))||attempt===3)throw error;
    }
    await sleep(250*(attempt+1));
  }
  if(lastError&&!scraped)throw lastError;
  if (!scraped) throw new Error('商品详情页面没有返回资料');
  if (!domains.some(domain => { try { const host = new URL(scraped.url).hostname; return host === domain || host.endsWith('.' + domain); } catch { return false; } })) throw new Error('商品详情跳转到其他站点，已停止采集');
  if (/验证码|安全验证|请输入验证码|请先登录|账号登录/.test(scraped.visibleText.slice(0, 1200))) throw new Error('平台要求登录或验证，已打开商品页；完成平台验证后请重新采集');
  if (!scraped.title || !scraped.images.length) throw new Error('商品详情页未返回商品标题或图片，请确认登录状态和页面内容后重试');
  return desktopFetch(pair, `/v1/browser-commands/${command.id}/ack`, { method: 'POST', body: JSON.stringify({ status: 'accepted', result: scraped }) });
}
async function deliverDouyinSearch(pair, command) {
  let lastError;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await workbenchTab();
      const result = await chrome.runtime.sendMessage({ type: 'PRODUCT_COMPARISON_DESKTOP_SEARCH', command });
      if (!result?.ok) throw new Error(result?.error || '插件工作台暂不能接收搜图任务');
      const acknowledgement = command.kind === 'product-search' ? { status: 'accepted', queryId: result.queryId } : { status: 'accepted' };
      return desktopFetch(pair, `/v1/browser-commands/${command.id}/ack`, { method: 'POST', body: JSON.stringify(acknowledgement) });
    } catch (error) { lastError = error; await sleep(500); }
  }
  throw lastError || new Error('插件工作台未响应');
}
async function deliverTaobaoImageSearch(pair, command) {
  if (!command.imageData) throw new Error('淘宝图搜任务缺少商品原图');
  let candidates;
  try{candidates=await FindTaobaoImageSearch.search(command.imageData);}
  catch(error){
    if(error.code==='TAOBAO_VERIFICATION_REQUIRED'){
      try{error.recovery=await openTaobaoVerification(command.buyerTaskId,error.verificationUrl,true);error.message=error.recovery.page==='verification'?'淘宝图搜需要安全验证，已在插件所在浏览器打开验证页；完成后回软件点击“继续原任务”':'淘宝图搜被安全验证拦截，但接口未返回可用验证链接；已打开淘宝搜图页，请在该页手动搜图完成验证后继续原任务';}
      catch{error.message='淘宝图搜需要安全验证，但验证页面未能打开；请点击任务中的“打开淘宝验证页”重试';error.recovery={kind:'taobao_verification',opened:false,page:'unavailable'};}
    }
    throw error;
  }
  if(!candidates.length)throw new Error('淘宝图搜没有返回有效商品链接，请换清晰主图后重试');
  await desktopFetch(pair, `/v1/browser-commands/${command.id}/ack`, {method:'POST',body:JSON.stringify({status:'accepted',candidates})});
}
function officialTaobaoPage(value){
  try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&/(^|\.)(?:taobao|tmall)\.com$/i.test(url.hostname)?url.href:'';}catch{return '';}
}
async function openTaobaoVerification(taskId,challengeUrl='',fresh=false){
  if(!/^[\da-f-]{36}$/i.test(taskId||''))throw new Error('淘宝验证任务无效');
  const key='productComparisonTaobaoVerification',now=Date.now();
  const stored=(await chrome.storage.session.get(key))[key]||{};
  const entries=Object.fromEntries(Object.entries(stored).filter(([,entry])=>entry&&entry.expiresAt>now).slice(-19));
  const previous=entries[taskId],newUrl=officialTaobaoPage(challengeUrl);
  const target=newUrl||(!fresh&&officialTaobaoPage(previous?.url))||'https://s.taobao.com/search';
  const page=newUrl||!fresh&&previous?.page==='verification'&&officialTaobaoPage(previous?.url)?'verification':'image_search';
  // Keep the full short-lived challenge URL only in extension session storage.
  // A desktop command carries the task ID, never the signed challenge URL.
  entries[taskId]={url:target,page,expiresAt:now+30*60*1000};
  await chrome.storage.session.set({[key]:entries});
  let tab;
  if(Number.isInteger(previous?.tabId)){
    const existing=await chrome.tabs.get(previous.tabId).catch(()=>null);
    const currentUrl=officialTaobaoPage(existing?.pendingUrl||existing?.url);
    if(existing&&currentUrl)tab=await chrome.tabs.update(existing.id,{active:true,...(fresh||currentUrl!==target?{url:target}:{})}).catch(()=>null);
  }
  if(!tab)tab=await chrome.tabs.create({url:target,active:true});
  entries[taskId].tabId=tab.id;
  await chrome.storage.session.set({[key]:entries});
  if(Number.isInteger(tab.windowId))await chrome.windows.update(tab.windowId,{focused:true}).catch(()=>{});
  return{kind:'taobao_verification',opened:true,page};
}
async function deliverTaobaoVerification(pair,command){
  const recovery=await openTaobaoVerification(command.buyerTaskId);
  await desktopFetch(pair,`/v1/browser-commands/${command.id}/ack`,{method:'POST',body:JSON.stringify({status:'accepted',recovery})});
}
async function collectBuyerSource(pair,command){
  const config={taobao:['taobao.com','tmall.com'],douyin:['douyin.com','jinritemai.com'],wsy:['wsy.com'],zwd:['17zwd.com'],qcc:['17qcc.com'],e3hui:['e3hui.com','e3hui.cn']};
  const url=new URL(command.detailUrl);if(url.protocol!=='https:'||url.username||url.password||!config[command.platform]?.some(domain=>url.hostname===domain||url.hostname.endsWith('.'+domain)))throw new Error('买手商品来源地址无效');
  const pageRole=command.slot==='source'?'source':'supplier';let lastError;
  for(let attempt=0;attempt<=3;attempt++){
    const tab=await chrome.tabs.create({url:url.href,active:false});let success=false,retryThisAttempt=false;
    try{
      for(let i=0;i<120;i++){const current=await chrome.tabs.get(tab.id);if(current.status==='complete')break;if(i===119)throw new Error('platform_timeout：商品页面加载超时');await sleep(250);}
      if(Object.hasOwn(loginHosts,command.platform)){const login=await ensurePlatformSession(tab.id,command.platform);if(login.state==='signed_in'){await chrome.tabs.update(tab.id,{url:url.href});for(let i=0;i<100;i++){if((await chrome.tabs.get(tab.id)).status==='complete')break;await sleep(200);}}}
      let result;
      if(pageRole==='source'){
        result=await FindBuyerPage.waitForBuyerPage({read:async()=>(await chrome.scripting.executeScript({target:{tabId:tab.id},func:FindBuyerPage.scrapeBuyerPage,args:[{platform:command.platform,pageRole}]}))[0]?.result,sleep,pageRole});
      }else{
        for(let qualityAttempt=0;qualityAttempt<=3;qualityAttempt++){
          if(qualityAttempt)await sleep(250*qualityAttempt);
          await chrome.scripting.executeScript({target:{tabId:tab.id},func:FindBuyerPage.expandBuyerPage,args:[{platform:command.platform}]});
          result=(await chrome.scripting.executeScript({target:{tabId:tab.id},func:FindBuyerPage.scrapeBuyerPage,args:[{platform:command.platform,pageRole}]}))[0]?.result;
          if(result?.error)throw new Error(result.error);
          if(result?.quality?.state==='complete'||qualityAttempt===3)break;
        }
        if(!result?.title||!result.images?.length)throw new Error('商品页面已打开，但未识别到商品主图或标题');
      }
      await desktopFetch(pair,`/v1/browser-commands/${command.id}/ack`,{method:'POST',body:JSON.stringify({status:'accepted',result})});success=true;return;
    }catch(error){
      lastError=error;
      const message=String(error.message||error);
      const permanent=/平台(?:需要|要求)登录|登录|验证码|安全验证|访问受限|商品页面跳转|来源地址无效/.test(message);
      const retryable=!permanent&&(/platform_timeout|商品页面已打开|商品主图已读取|未识别到商品主图/.test(message)||error instanceof TypeError);
      retryThisAttempt=retryable&&attempt<3;
      if(!retryable||attempt===3)throw error;
      await sleep(350*(attempt+1));
    }finally{if(success)await chrome.tabs.remove(tab.id).catch(()=>{});else if(retryThisAttempt)await chrome.tabs.remove(tab.id).catch(()=>{});else await chrome.tabs.update(tab.id,{active:true}).catch(()=>{});}
  }
  throw lastError||new Error('页面资料采集失败');
}
async function searchBuyerSuppliers(pair,command){
  await workbenchTab();
  const result=await chrome.runtime.sendMessage({type:'PRODUCT_COMPARISON_BUYER_SEARCH',command});
  if(!result?.ok)throw new Error(result?.error||'浏览器工作台尚未完成四平台搜索');
  await desktopFetch(pair,`/v1/browser-commands/${command.id}/ack`,{method:'POST',body:JSON.stringify({status:'accepted',result:result.result})});
}
async function pollDesktopCommands() {
  if (desktopCommandPoll) return;
  desktopCommandPoll = true;
  try {
    const saved = await chrome.storage.local.get(['productComparisonDesktop', 'productComparisonDesktopEnabled']);
    const pair = saved.productComparisonDesktop;
    if (saved.productComparisonDesktopEnabled === false || !pair?.endpoint || !pair?.token) return;
    for (let count = 0; count < 3; count++) {
      let command;
      try { command = (await desktopFetch(pair, '/v1/browser-commands/next')).command; } catch { return; }
      if (!command) return;
      try {
        if(command.kind==='taobao-verification')await deliverTaobaoVerification(pair,command);
        else if(command.kind==='buyer-source')await collectBuyerSource(pair,command);
        else if(command.kind==='buyer-supplier-search')await searchBuyerSuppliers(pair,command);
        else if(command.kind==='taobao-image-search') await deliverTaobaoImageSearch(pair,command);
        else if (['douyin-search','product-search'].includes(command.kind) && command.imageData) await deliverDouyinSearch(pair, command);
        else if (command.kind === 'product-details') await collectProductDetails(pair, command);
        else throw new Error('浏览器任务类型无效');
      } catch (error) {
        await desktopFetch(pair, `/v1/browser-commands/${command.id}/ack`, { method: 'POST', body: JSON.stringify({ status: 'failed', error: String(error.message || error).slice(0, 180),...(error.recovery?{recovery:error.recovery}:{}) }) }).catch(() => {});
      }
    }
    setTimeout(() => { void pollDesktopCommands(); },1000);
  } finally { desktopCommandPoll = false; }
}
if (chrome.alarms) {
  chrome.alarms.create('desktop-browser-commands', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'desktop-browser-commands') void pollDesktopCommands(); });
setTimeout(() => { void pollDesktopCommands(); }, 2500);
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ENSURE_PLATFORM_SESSION') {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('workbench.html')) { sendResponse({ ok: false, error: '平台登录请求来源无效' }); return false; }
    void ensurePlatformSession(message.tabId, message.platform).then(result => sendResponse({ ok: true, ...result }), () => sendResponse({ ok: false, error: '平台自动登录未完成，请检查桌面平台账号或在网页完成登录/验证' }));
    return true;
  }
  if (message?.type !== 'PROCESS_DESKTOP_BROWSER_WORKFLOW') return false;
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('workbench.html')) {
    sendResponse({ ok: false, error: '浏览器工作流来源无效' }); return false;
  }
  void pollDesktopCommands().then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: String(error.message || error).slice(0, 180) }));
  return true;
});

const imageHost = host => /(^|\.)wsy\.com$|(^|\.)17qcc\.com$|(^|\.)17zwd\.com$|(^|\.)e3hui\.com$|(^|\.)e3hui\.cn$/i.test(host) || ['e3h.i.ximgs.net','aodo.i.ximgs.net'].includes(host.toLowerCase());
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'PRODUCT_COMPARISON_DESKTOP_SEARCH') return false;
  if (message?.type !== 'FETCH_PUBLIC_IMAGE') return false;
  let target;
  try {
    target = new URL(String(message.url || ''));
    if (target.protocol === 'http:' && ['e3h.i.ximgs.net','aodo.i.ximgs.net'].includes(target.hostname.toLowerCase())) target.protocol = 'https:';
  } catch { sendResponse({ ok: false, error: 'image_match：图片地址无效' }); return false; }
  if (target.protocol !== 'https:' || target.username || target.password || target.port || !imageHost(target.hostname)) { sendResponse({ ok: false, error: 'image_match：图片域名或协议不在允许范围' }); return false; }
  (async () => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 12000);
    try {
      const response = await fetch(target.href, { credentials: 'omit', redirect: 'follow', signal: controller.signal });
      if (!response.ok) throw new Error(`image_match：图片 HTTP ${response.status}`);
      const finalUrl = new URL(response.url || target.href);
      if (finalUrl.protocol !== 'https:' || !imageHost(finalUrl.hostname)) throw new Error('image_match：图片被重定向到不允许的域名');
      const type = response.headers.get('content-type') || '';
      if (!/^image\//i.test(type)) throw new Error('image_match：响应不是图片');
      const maximum = 4 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > maximum) throw new Error('image_match：商品图片超过 4MB');
      let bytes;
      if (response.body?.getReader) {
        const reader = response.body.getReader(), chunks = [];
        let length = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > maximum) { void reader.cancel().catch(() => {}); throw new Error('image_match：商品图片超过 4MB'); }
            chunks.push(value);
          }
        } finally { reader.releaseLock?.(); }
        bytes = new Uint8Array(length);
        let offset = 0;
        for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
      } else {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > maximum) throw new Error('image_match：商品图片超过 4MB');
        bytes = new Uint8Array(buffer);
      }
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      sendResponse({ ok: true, dataUrl: `data:${type.split(';', 1)[0]};base64,${btoa(binary)}` });
    } catch (error) {
      if (timedOut) throw new Error('image_match：图片请求超过12秒');
      throw error;
    } finally { clearTimeout(timer); controller.abort(); }
  })().catch(error => sendResponse({ ok: false, error: String(error.message || error).slice(0, 160) }));
  return true;
});
