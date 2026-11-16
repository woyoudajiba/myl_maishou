const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const review = require('../review');
const sales = require('../taobao-sales');

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_CANDIDATES = 500;
const dataImage = value => typeof value === 'string' && value.length <= 6 * 1024 * 1024 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value);
const safeTaobaoRecovery=value=>value?.kind==='taobao_verification'?{kind:'taobao_verification',opened:value.opened===true,page:['verification','image_search'].includes(value.page)?value.page:'unavailable'}:null;

function safeItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) item = {};
  const safeUrl = value => {
    if (typeof value !== 'string' || value.length > 4096) return '';
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' && ['e3h.i.ximgs.net', 'aodo.i.ximgs.net'].includes(url.hostname.toLowerCase())) url.protocol = 'https:';
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  };
  return {
    platform: /^e3hui-(?:cn|com)$/.test(item.platform) ? 'e3hui' : String(item.platform || '').slice(0, 40), id: String(item.id || '').slice(0, 200),
    ...(item.platform==='taobao'?sales.fields(item):{}),
    goodsId: String(item.goodsId || '').slice(0, 200), title: String(item.title || '').slice(0, 1000),
    price: item.price != null && item.price !== '' && Number.isFinite(Number(item.price)) ? Number(item.price) : null,
    saving: item.saving != null && item.saving !== '' && Number.isFinite(Number(item.saving)) ? Number(item.saving) : null,
    imageUrl: safeUrl(item.imageUrl), detailUrl: safeUrl(item.detailUrl),
    shopName: String(item.shopName || '').slice(0, 500), supplierId: String(item.supplierId || '').slice(0, 200),
    address: String(item.address || '').slice(0, 500), goodsMatch: item.goodsMatch === true,
    platformTags: Array.isArray(item.platformTags) ? [...new Set(item.platformTags.filter(tag => ['新品', '共享仓', '自营仓', '云仓闪发', '工厂直供', '闪电发货'].includes(tag)))] : [],
    searchGroup: ['accurate', 'similar'].includes(item.searchGroup) ? item.searchGroup : '',
    dataSource: ['qcc_api', 'qcc_template'].includes(item.dataSource) ? item.dataSource : ''
  };
}
function safeSearchIssues(input) {
  if (!Array.isArray(input)) return [];
  const platforms = new Set(['wsy', 'zwd', 'qcc', 'e3hui']);
  const phases = new Set(['partial', 'failed', 'manual_required']);
  return input.slice(0, 4).filter(item => item && platforms.has(item.platform) && phases.has(item.phase))
    .map(item => ({ platform: item.platform, phase: item.phase, message: String(item.message || '').slice(0, 240) }));
}
function safePlatformSearches(input) {
  if (!Array.isArray(input)) return [];
  const platforms = new Set(['wsy', 'zwd', 'qcc', 'e3hui']);
  const phases = new Set(['complete', 'partial', 'failed', 'manual_required', 'not_selected', 'not_started', 'unknown']);
  const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? value : null;
  const unique = new Map();
  for (const row of input.slice(0, 4)) {
    if (!row || !platforms.has(row.platform) || unique.has(row.platform)) continue;
    const searchGroups = Array.isArray(row.searchGroups) ? row.searchGroups.slice(0, 2)
      .filter(group => group && ['accurate', 'similar'].includes(group.type) && ['complete', 'failed'].includes(group.phase))
      .map(group => ({ type: group.type, phase: group.phase, receivedCount: count(group.receivedCount) ?? 0, reportedTotal: count(group.reportedTotal) })) : [];
    const rawDiagnostics = row.diagnostics && typeof row.diagnostics === 'object' ? row.diagnostics : {};
    const failureKinds = new Set(['timeout','quota','verification','permission','network','contract','response']);
    const diagnostics = {
      stage: String(rawDiagnostics.stage || '').slice(0, 60),
      timeoutStage: String(rawDiagnostics.timeoutStage || '').slice(0, 60),
      failureKind: failureKinds.has(rawDiagnostics.failureKind) ? rawDiagnostics.failureKind : '',
      retryable: typeof rawDiagnostics.retryable === 'boolean' ? rawDiagnostics.retryable : null,
      elapsedMs: count(rawDiagnostics.elapsedMs),
      httpStatus: Number.isInteger(rawDiagnostics.httpStatus) && rawDiagnostics.httpStatus >= 0 && rawDiagnostics.httpStatus <= 599 ? rawDiagnostics.httpStatus : null,
      errorCode: String(rawDiagnostics.errorCode || '').slice(0, 80)
    };
    unique.set(row.platform, { platform: row.platform, selected: row.selected === true, phase: phases.has(row.phase) ? row.phase : 'unknown',
      receivedCount: count(row.receivedCount) ?? 0, acceptedCount: count(row.acceptedCount), reportedTotal: count(row.reportedTotal), message: String(row.message || '').slice(0, 240), searchGroups, diagnostics });
  }
  return [...unique.values()];
}
const retryableItem = item => !item.visualComparison;
function resetRetryItem(item) {
  const copy = { ...item };
  for (const key of Object.keys(copy)) if (key.startsWith('imageSimilarity') || key === 'imageEvidence' || key === 'visualComparison' || key === 'humanReview') delete copy[key];
  return copy;
}

function createDesktopBridge({ port = 43821, host = '127.0.0.1', dataDir, token: pairingToken, expectedExtensionVersion = '', processJob, canProcess = () => true, canAccess = () => true, getVisionStatus = () => ({ configured: false }), getPlatformCredential = () => null, onProductSearchAccepted = async () => {}, onTaobaoSearchResults = async () => {}, onTaobaoSearchFailed = async () => {}, onBuyerBrowserResult = async()=>{} }) {
  if (!dataDir) throw new Error('dataDir is required');
  if (pairingToken !== undefined && (typeof pairingToken !== 'string' || !/^[a-f0-9]{64}$/.test(pairingToken))) throw new Error('长期配对码必须是64位十六进制字符串');
  const token = pairingToken || crypto.randomBytes(32).toString('hex');
  const jobs = new Map();
  const browserCommands = new Map();
  const retryRequests = new Map();
  const maxStoredJobs = 10;
  let server;
  let running = false, pendingAdmissions = 0;
  let taobaoPaused = false;
  let lastBrowserSeen='';
  let browserVersion='',buyerProtocol='';
  const versionParts=value=>{
    const match=/^(\d+)\.(\d+)\.(\d+)(?:-v|\.)(\d+)$/.exec(value||'');
    return match?match.slice(1).map(Number):null;
  };
  const browserClient=()=>{
    const info={version:browserVersion,expectedVersion:expectedExtensionVersion,protocol:buyerProtocol};
    if(!lastBrowserSeen||Date.now()-Date.parse(lastBrowserSeen)>=90000)return{...info,state:'disconnected',title:'浏览器插件尚未连接',message:'请在浏览器打开找商品插件工作台，启用桌面端连接。若刚更新客户端，请先更新插件文件，再在浏览器扩展管理页点击重新加载。'};
    const actual=versionParts(browserVersion),expected=versionParts(expectedExtensionVersion);
    let older=false;
    if(actual&&expected)for(let i=0;i<4;i++){if(actual[i]!==expected[i]){older=actual[i]<expected[i];break;}}
    if(older)return{...info,state:'update_required',title:'浏览器插件需要更新',message:`浏览器运行的插件为 ${browserVersion}，客户端配套版本为 ${expectedExtensionVersion}。请在使用说明中更新插件文件，再到浏览器扩展管理页对找商品点击重新加载，重新打开插件工作台连接桌面端。`};
    if(expectedExtensionVersion&&(!actual||buyerProtocol!=='1'))return{...info,state:'unverified',title:'插件版本或功能尚未确认',message:'已收到浏览器连接，但无法确认正在运行的插件支持当前自动买手流程。请更新插件文件，在浏览器扩展管理页点击重新加载，再打开插件工作台连接桌面端。'};
    return{...info,state:'ready',title:'浏览器插件已就绪',message:browserVersion?`运行版本 ${browserVersion}，自动买手已连接`:'浏览器插件已连接'};
  };
  const recordBrowser=request=>{
    lastBrowserSeen=new Date().toISOString();
    const reported=String(request.headers['x-pc-extension-version']||'');
    browserVersion=versionParts(reported)?reported:'';
    buyerProtocol=request.headers['x-pc-buyer-protocol']==='1'?'1':'';
  };
  let closed = false;
  let saveQueue = Promise.resolve();
  let browserSaveQueue = Promise.resolve();
  let historyQueue = Promise.resolve();
  let browserAdmissionQueue = Promise.resolve();
  let idle = Promise.resolve(), resolveIdle;

  const save = () => {
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      await fs.mkdir(dataDir, { recursive: true });
      const temporary = path.join(dataDir, 'jobs.json.tmp');
      const persisted = [...jobs.values()].map(job => { const { query, ...metadata } = job; return metadata; });
      await fs.writeFile(temporary, JSON.stringify(persisted), 'utf8');
      await fs.rename(temporary, path.join(dataDir, 'jobs.json'));
    });
    return saveQueue;
  };
  const publicJob = job => {
    const { query, ...visible } = job;
    const threshold = review.exclusionThreshold(job.items);
    return { ...visible, reviewMode: review.mode(job.reviewMode), reviewSummary: review.summary(job.items, job.reviewMode), minimumScore: threshold,
      items: job.items.map(item => ({ ...item, finalVerdict: review.effective(item, job.reviewMode), finalScore: review.effectiveScore(item, job.reviewMode), reviewStatus: review.status(item, job.reviewMode), scoreExcluded: review.belowThreshold(item, threshold), rankingScore: review.rankingScore(item) })) };
  };
  const allowedProductImage = (host, platform) => {
    const domains = { wsy: ['wsy.com'], zwd: ['17zwd.com'], qcc: ['17qcc.com', 'ecombdimg.com'], e3hui: ['e3hui.com', 'e3hui.cn', 'ximgs.net'], taobao: ['alicdn.com','taobaocdn.com','tbcdn.cn'] }[platform] || [];
    return domains.some(domain => host === domain || host.endsWith('.' + domain));
  };
  const makeServer = () => http.createServer((request, response) => {
    void route(request, response).catch(error => {
      if (!response.headersSent) send(response, error.status || 500, { ok: false, error: String(error?.message || error).slice(0, 240) });
      else response.destroy();
    });
  });
  const listen = targetPort => new Promise((resolve, reject) => {
    server = makeServer();
    server.once('error', reject);
    server.listen(targetPort, host, () => { server.removeListener('error', reject); resolve(); });
  });
  const snapshot = () => ({ host, port: server?.address()?.port ?? port, token, taobaoPaused,lastBrowserSeen,browserClient:browserClient(), vision: getVisionStatus(), jobs: [...jobs.values()].map(publicJob), browserCommands: [...browserCommands.values()].map(publicCommand) });
  const publicCommand = command => {
    const { imageData, ...visible } = command;
    return { ...visible };
  };
  const saveBrowserCommands = () => {
    const operation = browserSaveQueue.catch(() => {}).then(async () => {
      const file = path.join(dataDir, 'browser-commands.json'), temporary = file + '.tmp';
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(temporary, JSON.stringify([...browserCommands.values()]));
      await fs.rename(temporary, file);
      await fs.writeFile(path.join(dataDir, 'taobao-queue.json.tmp'), JSON.stringify({ paused: taobaoPaused }));
      await fs.rename(path.join(dataDir, 'taobao-queue.json.tmp'),path.join(dataDir,'taobao-queue.json'));
    });
    browserSaveQueue = operation.catch(() => {});
    return operation;
  };
  const enqueueBrowserCommand = command => {
    const operation = browserAdmissionQueue.catch(() => {}).then(async () => {
    if (closed || !canAccess()) throw new Error('请先登录桌面工作台');
    const existing = [...browserCommands.values()].find(entry => {
      if (!['queued', 'claimed'].includes(entry.status) || entry.kind !== command.kind) return false;
      return command.kind === 'douyin-search' ? entry.sourceUrl === command.sourceUrl
        : command.kind === 'product-search' || command.kind === 'taobao-image-search' || command.kind === 'taobao-verification' ? entry.buyerTaskId === command.buyerTaskId
        : command.kind === 'product-details' ? entry.jobId === command.jobId && entry.itemIndex === command.itemIndex
        : ['buyer-source','buyer-supplier-search'].includes(command.kind)?entry.buyerTaskId===command.buyerTaskId&&entry.slot===command.slot:false;
    });
    if (existing) return publicCommand(existing);
    const commandLimit=command.kind==='taobao-image-search'?50:10;
    if([...browserCommands.values()].filter(entry=>['queued','claimed'].includes(entry.status)&&(command.kind==='taobao-image-search'?entry.kind==='taobao-image-search':entry.kind!=='taobao-image-search')).length>=commandLimit)throw new Error(command.kind==='taobao-image-search'?'淘宝队列已有50个待搜索任务，请等待或暂停后再提交':'浏览器任务队列已满，请稍后再试');
    if (browserCommands.size >= 60) {
      for (const [id, old] of browserCommands) if (old.status !== 'queued' && old.status !== 'claimed') browserCommands.delete(id);
    }
    const id = crypto.randomUUID(), now = new Date().toISOString();
    const entry = { id, createdAt: now, updatedAt: now, status: 'queued', attempts: 0, ...command };
    browserCommands.set(id, entry);
    try { await saveBrowserCommands(); } catch (error) { browserCommands.delete(id); throw error; }
    return publicCommand(entry);
    });
    browserAdmissionQueue = operation.catch(() => {});
    return operation;
  };
  const update = async (id, patch) => {
    const job = jobs.get(id);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    await save();
    return publicJob(job);
  };
  const queueRetry = async (job, automatic) => {
    const pending = job.items.filter(retryableItem).length;
    if (!pending) return null;
    const compared = job.items.length - pending, now = new Date().toISOString();
    const autoRetryCount = automatic ? (Number.isInteger(job.autoRetryCount) ? job.autoRetryCount : 0) + 1 : 0;
    const next = { ...job,
      status: 'queued', error: '', inFlight: [], batchSize: automatic ? 4 : 1, continueOnFailure: true, autoRetryCount,
      manualRetryRounds: (Number.isInteger(job.manualRetryRounds) ? job.manualRetryRounds : 0) + (automatic ? 0 : 1),
      retryCount: (Number.isInteger(job.retryCount) ? job.retryCount : 0) + 1,
      lastRetryAt: now, ...(automatic ? { lastAutoRetryAt: now } : {}),
      completed: compared, compared, failed: 0, notStarted: pending, progress: Math.floor(compared * 100 / job.items.length),
      items: job.items.map(item => retryableItem(item) ? resetRetryItem(item) : item), updatedAt: now
    };
    jobs.set(job.id, next);
    try { await save(); } catch (error) { jobs.set(job.id, job); throw error; }
    return publicJob(next);
  };
  const enqueueTaobaoSearch = input => {
    if(!dataImage(input?.imageData))throw new Error('淘宝图搜图片数据无效');
    if(!/^[\da-f-]{36}$/i.test(input.buyerTaskId||''))throw new Error('买手任务编号无效');
    let source='';
    if(input.sourceType!=='image'){
      const sourceUrl=new URL(input.sourceUrl);
      if(sourceUrl.protocol!=='https:'||sourceUrl.username||sourceUrl.password||sourceUrl.port||!['douyin.com','jinritemai.com','taobao.com','tmall.com','wsy.com','17zwd.com','17qcc.com','e3hui.com','e3hui.cn'].some(domain=>sourceUrl.hostname===domain||sourceUrl.hostname.endsWith('.'+domain)))throw new Error('商品来源链接无效');
      source=sourceUrl.href;
    }
    return enqueueBrowserCommand({kind:'taobao-image-search',imageData:input.imageData,queryName:String(input.queryName||'淘宝同款搜索').trim().slice(0,120),sourceUrl:source,buyerTaskId:input.buyerTaskId});
  };
  const resume = () => { if (!closed) void runQueue(); };
  const historyPaths = id => {
    if (!/^[\da-f-]{36}$/i.test(id)) throw new Error('任务编号无效');
    const queryRoot = path.resolve(dataDir, 'queries'), imageRoot = path.resolve(dataDir, 'images');
    const query = path.resolve(queryRoot, `${id}.txt`), images = path.resolve(imageRoot, id);
    if (path.dirname(query) !== queryRoot || path.dirname(images) !== imageRoot) throw new Error('任务文件路径无效');
    return { query, images };
  };
  const removeHistoryFiles = async id => {
    const targets = historyPaths(id);
    await fs.rm(targets.query, { force: true });
    await fs.rm(targets.images, { recursive: true, force: true });
  };
  const deleteJobs = ids => {
    const result = historyQueue.catch(() => {}).then(async () => {
      if (closed || !canAccess()) throw new Error('请先登录桌面工作台');
      if (!Array.isArray(ids) || !ids.length || ids.length > maxStoredJobs || new Set(ids).size !== ids.length) throw new Error('请选择需要删除的任务记录');
      const targets = ids.map(id => {
        if (typeof id !== 'string') throw new Error('任务编号无效');
        historyPaths(id);
        const job = jobs.get(id);
        if (!job) throw new Error('任务记录已变化，请刷新后重新选择');
        if (['queued', 'processing'].includes(job.status)) throw new Error('排队或识别中的任务不能删除，请等待结束后再操作');
        if ([...browserCommands.values()].some(command => command.kind === 'product-details' && command.jobId === id && ['queued', 'claimed'].includes(command.status))) throw new Error('商品详情正在等待浏览器采集，暂不能删除该任务');
        return job;
      });
      const before = [...jobs.entries()];
      targets.forEach(job => jobs.delete(job.id));
      try { await save(); }
      catch (error) {
        const current = [...jobs.entries()];
        jobs.clear();
        for (const [id, job] of [...before, ...current]) jobs.set(id, job);
        throw new Error('任务记录未删除：本地保存失败，请重试');
      }
      const warnings = [];
      for (const job of targets) {
        try { await removeHistoryFiles(job.id); }
        catch { warnings.push('任务记录已删除，但部分本机图片文件未能清理'); }
      }
      return { deleted: targets.length, retained: jobs.size, warnings: [...new Set(warnings)] };
    });
    historyQueue = result.catch(() => {});
    return result;
  };
  async function trimJobs(keepId) {
    while (jobs.size > maxStoredJobs) {
      const oldest = [...jobs.values()].find(item => item.id !== keepId && !['processing', 'queued'].includes(item.status)
        && ![...browserCommands.values()].some(command => command.kind === 'product-details' && command.jobId === item.id && ['queued', 'claimed'].includes(command.status)));
      if (!oldest) break;
      jobs.delete(oldest.id);
      await removeHistoryFiles(oldest.id);
    }
  }

  async function runQueue() {
    if (running || closed || !canProcess()) return;
    running = true;
    idle = new Promise(resolve => { resolveIdle = resolve; });
    try {
      while (!closed && canProcess()) {
        const job = [...jobs.values()].find(item => item.status === 'queued');
        if (!job) break;
        await update(job.id, { status: 'processing', error: '' });
        try {
          let returnedPartial = false;
          await processJob({ ...job, items: job.items.map(item => ({ ...item })) }, patch => {
            if (patch.status === 'partial') { returnedPartial = true; return update(job.id, { ...patch, status: 'processing' }); }
            return update(job.id, patch);
          });
          const current = jobs.get(job.id);
          if (current?.status === 'processing' && !returnedPartial) await update(job.id, { status: 'complete' });
          const finished = jobs.get(job.id);
          if (returnedPartial && finished?.items.some(retryableItem) && (finished.autoRetryCount || 0) < 3 && canProcess()) {
            await queueRetry(finished, true);
          } else if (returnedPartial && finished?.items.some(retryableItem) && (finished.autoRetryCount || 0) >= 3) {
            const pending = finished.items.filter(retryableItem).length;
            await update(job.id, { status: 'partial', error: `自动重试 3 次后仍有 ${pending} 条候选未完成；点击“重试未识别候选”可再自动重试 3 次` });
          } else if (returnedPartial) {
            await update(job.id, { status: 'partial' });
          }
        } catch (error) {
          const current = jobs.get(job.id);
          if (current?.status === 'processing') await update(job.id, { status: 'failed', error: String(error?.message || error).slice(0, 240) });
        }
      }
    } finally { running = false; resolveIdle(); }
  }

  function send(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type,x-desktop-token,x-pc-extension-version,x-pc-buyer-protocol', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Private-Network': 'true', 'Cache-Control': 'no-store' });
    response.end(value == null ? '' : JSON.stringify(value));
  }
  const authorized = request => {
    const provided = Buffer.from(String(request.headers['x-desktop-token'] || ''));
    const expected = Buffer.from(token);
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  };
  async function readJson(request) {
    const chunks = []; let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) throw Object.assign(new Error('request_too_large：任务数据超过16MB'), { status: 413 });
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(new Error('invalid_json：任务数据不是有效 JSON'), { status: 400 }); }
  }
  async function route(request, response) {
    if (request.method === 'OPTIONS') return send(response, 204, null);
    if (closed || !canAccess()) return send(response, 401, { ok: false, error: '请先登录桌面工作台' });
    const url = new URL(request.url, `http://${host}`);
    if (request.method === 'POST' && url.pathname === '/v1/pair') {
      if (!authorized(request)) return send(response, 401, { ok: false, error: 'pairing_failed：本地配对码不正确' });
      return send(response, 200, { ok: true, app: 'ProductComparisonDesktop', vision: getVisionStatus() });
    }
    if (!authorized(request)) return send(response, 401, { ok: false, error: 'unauthorized：请先配对本地桌面应用' });
    const platformCredential = request.method === 'POST' && url.pathname.match(/^\/v1\/platform-credentials\/(wsy|zwd|qcc|e3hui)$/);
    if (platformCredential) {
      if (!/^chrome-extension:\/\/[a-p]{32}$/.test(String(request.headers.origin || ''))) return send(response, 403, { ok: false, error: '仅配对浏览器插件可取用平台账号' });
      const input = await readJson(request);
      let loginUrl; try { loginUrl = new URL(input.loginUrl); } catch { return send(response, 400, { ok: false, error: '平台登录地址无效' }); }
      const hosts = { wsy: ['www.wsy.com','wsy.com','cs.wsy.com'], zwd: ['stu.17zwd.com','www.17zwd.com'], qcc: ['www.17qcc.com'], e3hui: ['www.e3hui.com','www.e3hui.cn'] };
      if (loginUrl.protocol !== 'https:' || loginUrl.username || loginUrl.password || loginUrl.port || !hosts[platformCredential[1]].includes(loginUrl.hostname)) return send(response, 400, { ok: false, error: '平台登录地址与账号不匹配' });
      const credential = await getPlatformCredential(platformCredential[1]);
      return send(response, 200, { ok: true, credential: credential ? { username: credential.username, password: credential.password } : null });
    }
    if (request.method === 'POST' && url.pathname === '/v1/product-search') {
      let input; try { input = await readJson(request); } catch (error) { return send(response,error.status||400,{ok:false,error:error.message}); }
      try {
        if (!dataImage(input?.imageData)) throw new Error('商品图数据无效');
        if (typeof input.queryName !== 'string' || !input.queryName.trim()) throw new Error('商品名称缺失');
        const sourceUrl=new URL(input.sourceUrl);
        const allowed=['douyin.com','jinritemai.com','taobao.com','tmall.com','wsy.com','17zwd.com','17qcc.com','e3hui.com','e3hui.cn'];
        if(sourceUrl.protocol!=='https:'||sourceUrl.username||sourceUrl.password||!allowed.some(domain=>sourceUrl.hostname===domain||sourceUrl.hostname.endsWith('.'+domain)))throw new Error('只接受已支持平台 HTTPS 商品链接');
        if(!/^[\da-f-]{36}$/i.test(input.buyerTaskId||''))throw new Error('买手任务编号无效');
        const command=await enqueueBrowserCommand({kind:'product-search',imageData:input.imageData,queryName:input.queryName.trim().slice(0,120),sourceUrl:sourceUrl.href,buyerTaskId:input.buyerTaskId});
        return send(response,202,{ok:true,command});
      }catch(error){return send(response,400,{ok:false,error:String(error.message||error).slice(0,180)});}
    }
    if (request.method === 'POST' && url.pathname === '/v1/taobao-image-search') {
      let input; try { input = await readJson(request); } catch (error) { return send(response,error.status||400,{ok:false,error:error.message}); }
      try {
        const command = await enqueueTaobaoSearch(input);
        return send(response,202,{ok:true,command});
      } catch(error) { return send(response,400,{ok:false,error:String(error.message||error).slice(0,180)}); }
    }
    if (request.method === 'GET' && url.pathname === '/v1/jobs') return send(response, 200, { ok: true, jobs: [...jobs.values()].map(publicJob) });
    if (request.method === 'POST' && url.pathname === '/v1/douyin-search') {
      let input;
      try { input = await readJson(request); } catch (error) { return send(response, error.status || 400, { ok: false, error: error.message }); }
      try {
        if (!dataImage(input?.imageData)) throw new Error('下载首图数据无效');
        if (typeof input.queryName !== 'string' || !input.queryName.trim()) throw new Error('抖音商品标题缺失');
        const sourceUrl = new URL(input.sourceUrl);
        if (sourceUrl.protocol !== 'https:' || !/(^|\.)douyin\.com$|(^|\.)jinritemai\.com$/i.test(sourceUrl.hostname)) throw new Error('只接受 HTTPS 抖音商品链接');
        const command = await enqueueBrowserCommand({ kind: 'douyin-search', imageData: input.imageData, queryName: input.queryName.trim().slice(0, 120), sourceUrl: sourceUrl.href });
        return send(response, 202, { ok: true, command });
      }
      catch (error) { return send(response, 400, { ok: false, error: String(error.message || error).slice(0, 180) }); }
    }
    if (request.method === 'GET' && url.pathname === '/v1/browser-commands/next') {
      recordBrowser(request);
      const now = Date.now();
      const ready=!expectedExtensionVersion||browserClient().state==='ready';
      const command = [...browserCommands.values()].find(item => (ready||!['buyer-source','buyer-supplier-search'].includes(item.kind)) && !(taobaoPaused && item.kind==='taobao-image-search') && (item.status === 'queued' || item.status === 'claimed' && now - Date.parse(item.claimedAt) > 120000));
      if (!command) return send(response, 200, { ok: true, command: null });
      command.status = 'claimed'; command.claimedAt = new Date(now).toISOString(); command.attempts++;
      await saveBrowserCommands();
      return send(response, 200, { ok: true, command });
    }
    const commandAck = request.method === 'POST' && url.pathname.match(/^\/v1\/browser-commands\/([\da-f-]{36})\/ack$/i);
    if (commandAck) {
      recordBrowser(request);
      let input;
      try { input = await readJson(request); } catch (error) { return send(response, error.status || 400, { ok: false, error: error.message }); }
      const command = browserCommands.get(commandAck[1]);
      if (!command) return send(response, 404, { ok: false, error: 'browser_command_not_found：浏览器任务不存在' });
      if (!['accepted', 'failed'].includes(input.status)) return send(response, 400, { ok: false, error: 'invalid_command_status：浏览器任务状态无效' });
      if (!['queued', 'claimed'].includes(command.status)) return send(response, 409, { ok: false, error: 'browser_command_finished：浏览器任务已结束' });
      if(['buyer-source','buyer-supplier-search'].includes(command.kind)){
        if(input.status==='accepted'&&(!input.result||typeof input.result!=='object'||Array.isArray(input.result)))return send(response,400,{ok:false,error:'买手浏览器回执结构无效'});
        await onBuyerBrowserResult(publicCommand(command),input.status==='accepted'?input.result:null,input.status==='failed'?String(input.error||'浏览器处理失败').slice(0,180):'');
      }
      if (input.status === 'accepted' && command.kind === 'product-details') {
        const job = jobs.get(command.jobId), item = job?.items[command.itemIndex];
        if (!item || !review.decision(item) || review.decision(item).verdict !== 'likely_same') return send(response, 409, { ok: false, error: 'review_required：请先人工确认该商品为疑似同款' });
        const result = input.result;
        if (!result || typeof result !== 'object' || Array.isArray(result)) return send(response, 400, { ok: false, error: 'invalid_details：商品详情格式无效' });
        const images = Array.isArray(result.images) ? result.images.slice(0, 60).map(source => {
          if (typeof source !== 'string' || source.length > 4096) return '';
          try { const parsed = new URL(source); return parsed.protocol === 'https:' && !parsed.username && !parsed.password && allowedProductImage(parsed.hostname.toLowerCase(), item.platform) ? parsed.href : ''; } catch { return ''; }
        }).filter(Boolean) : [];
        const safeGroup = value => (Array.isArray(value) ? value : []).slice(0, 60).map(source => {
          if (typeof source !== 'string' || source.length > 4096) return '';
          try { const parsed = new URL(source); return parsed.protocol === 'https:' && !parsed.username && !parsed.password && allowedProductImage(parsed.hostname.toLowerCase(), item.platform) ? parsed.href : ''; } catch { return ''; }
        }).filter(Boolean);
        const imageGroups = result.imageGroups && typeof result.imageGroups === 'object'
          ? Object.fromEntries(['main','colors','details'].map(key => [key, safeGroup(result.imageGroups[key])])) : {};
        const quality = result.quality && typeof result.quality === 'object' ? {
          state: ['complete','partial'].includes(result.quality.state) ? result.quality.state : 'partial',
          pageRole: ['source','supplier'].includes(result.quality.pageRole) ? result.quality.pageRole : 'supplier',
          missingFields: (Array.isArray(result.quality.missingFields) ? result.quality.missingFields : []).slice(0, 20).map(value => String(value).slice(0, 80)),
          imageCoverage: result.quality.imageCoverage && typeof result.quality.imageCoverage === 'object' ? {
            detailNodes: Math.max(0, Math.min(500, Number(result.quality.imageCoverage.detailNodes) || 0)),
            detailImages: Math.max(0, Math.min(500, Number(result.quality.imageCoverage.detailImages) || 0)),
            placeholders: Math.max(0, Math.min(500, Number(result.quality.imageCoverage.placeholders) || 0)),
            complete: result.quality.imageCoverage.complete === true
          } : null
        } : null;
        const detailPrice = Number(result.price);
        item.productDetails = { collectedAt: new Date().toISOString(), title: String(result.title || item.title).slice(0, 500),
          price: Number.isFinite(detailPrice) && detailPrice > 0 ? detailPrice : null,
          priceType: ['supply','tiered'].includes(result.priceType) ? result.priceType : 'supply',
          priceTiers: (Array.isArray(result.priceTiers) ? result.priceTiers : []).slice(0, 40).map(row => ({ price: Number.isFinite(Number(row?.price)) ? Number(row.price) : null, quantity: String(row?.quantity || '').slice(0, 100) })).filter(row => row.price > 0),
          resaleFloor: Number.isFinite(Number(result.resaleFloor)) && Number(result.resaleFloor) > 0 ? Number(result.resaleFloor) : null,
          colors: (Array.isArray(result.colors) ? result.colors : []).slice(0, 80).map(value => String(value).slice(0, 100)),
          sizes: (Array.isArray(result.sizes) ? result.sizes : []).slice(0, 80).map(value => String(value).slice(0, 100)),
          sku: String(result.sku || '').slice(0, 200), shopName: String(result.shopName || '').slice(0, 300), boothName: String(result.boothName || '').slice(0, 300), address: String(result.address || '').slice(0, 200),
          description: String(result.description || '').slice(0, 6000), attributes: Array.isArray(result.attributes) ? result.attributes.slice(0, 80).map(value => String(value).slice(0, 300)) : [],
          images, imageGroups, quality, visibleText: String(result.visibleText || '').slice(0, 24000), detailUrl: item.detailUrl };
        job.updatedAt = new Date().toISOString(); await save();
      }
      if(input.status==='accepted'&&command.kind==='product-search'){
        if(!/^[\da-f-]{36}$/i.test(input.queryId||''))return send(response,400,{ok:false,error:'query_required：浏览器未返回有效搜图记录'});
        command.queryId=input.queryId;await onProductSearchAccepted(command.buyerTaskId,input.queryId);
      }
      if(command.kind==='taobao-image-search'&&input.status==='accepted') {
        if(!Array.isArray(input.candidates)||input.candidates.length<1||input.candidates.length>60)return send(response,400,{ok:false,error:'invalid_candidates：淘宝图搜候选数量无效'});
        const candidates=input.candidates.map(value=>{
          if(!value||typeof value!=='object'||Array.isArray(value))return null;
          const detail=safeItem({ ...value, platform:'taobao' });
          let detailUrl='';try{const target=new URL(detail.detailUrl);if(target.protocol==='https:'&&['item.taobao.com','detail.tmall.com'].includes(target.hostname)&&target.pathname==='/item.htm'&&/^\d{5,25}$/.test(target.searchParams.get('id')||''))detailUrl=`https://${target.hostname}/item.htm?id=${target.searchParams.get('id')}`;}catch{}
          if(!detailUrl||!detail.imageUrl)return null;
          return { ...detail, id:String(value.id||detail.goodsId||new URL(detailUrl).searchParams.get('id')).slice(0,120), platform:'taobao', detailUrl, location:String(value.location||'').slice(0,120) };
        }).filter(Boolean);
        if(!candidates.length)return send(response,400,{ok:false,error:'invalid_candidates：淘宝没有返回有效商品链接和图片'});
        await onTaobaoSearchResults(command.buyerTaskId,candidates,command.id);
        command.resultCount=candidates.length;
      }
      if(command.kind==='taobao-image-search'&&input.status==='failed') {
        const recovery=safeTaobaoRecovery(input.recovery);
        if(recovery)command.recovery=recovery;
        await onTaobaoSearchFailed(command.buyerTaskId,input.error,recovery,command.id);
        taobaoPaused=true;
      }
      if(command.kind==='taobao-verification'&&input.status==='accepted')command.recovery=safeTaobaoRecovery(input.recovery);
      command.status = input.status; command.updatedAt = new Date().toISOString(); command.error = input.status === 'failed' ? String(input.error || '浏览器处理失败').slice(0, 180) : '';
      if (input.status === 'accepted' || input.status === 'failed') delete command.imageData;
      if (input.status === 'accepted') command.resultAvailable = command.kind === 'product-details' || command.kind === 'taobao-image-search';
      await saveBrowserCommands();
      return send(response, 200, { ok: true, command: publicCommand(command) });
    }
    if (request.method === 'POST' && url.pathname === '/v1/jobs') {
      if (!canProcess()) return send(response, 409, { ok: false, error: 'vision_not_configured：请先在桌面端登录并选择已配置的视觉模型；如已配置请检查登录连接' });
      let input;
      try { input = await readJson(request); }
      catch (error) { return send(response, error.status || 400, { ok: false, error: error.message }); }
      if (!dataImage(input?.query)) return send(response, 400, { ok: false, error: 'invalid_query：原图数据格式无效' });
      if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_CANDIDATES) return send(response, 400, { ok: false, error: `invalid_items：一次需要提交 1～${MAX_CANDIDATES} 个候选` });
      if ([...jobs.values()].filter(job => ['queued', 'processing'].includes(job.status)).length + pendingAdmissions >= maxStoredJobs) return send(response, 429, { ok: false, error: '桌面队列已有10个进行中任务，请等待完成后继续提交剩余图片' });
      pendingAdmissions++;
      try {
        const job = {
          id: crypto.randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          status: 'queued', progress: 0, completed: 0, total: input.items.length, error: '',
          query: input.query, mode: input.mode === 'optimize' ? 'optimize' : 'select', reviewMode: review.mode(input.reviewMode),
          goodsId: String(input.goodsId || '').slice(0, 200), baseline: String(input.baseline || '').slice(0, 50), reduction: String(input.reduction || '').slice(0, 50),
          queryName: typeof input.queryName === 'string' ? input.queryName.slice(0, 120) : '',
          buyerTaskId: typeof input.buyerTaskId === 'string' && /^[\da-f-]{36}$/i.test(input.buyerTaskId) ? input.buyerTaskId : '',
          queryId: typeof input.queryId === 'string' && /^[a-f0-9-]{36}$/i.test(input.queryId) ? input.queryId : '',
          searchGroupId: typeof input.searchGroupId === 'string' && /^[a-f0-9-]{36}$/i.test(input.searchGroupId) ? input.searchGroupId : '',
          searchIssues: safeSearchIssues(input.searchIssues), platformSearches: safePlatformSearches(input.platformSearches), autoRetryCount: 0, manualRetryRounds: 0, retryCount: 0,
          items: input.items.map(safeItem)
        };
        await fs.mkdir(path.join(dataDir, 'queries'), { recursive: true });
        await fs.writeFile(path.join(dataDir, 'queries', `${job.id}.txt`), job.query, { encoding: 'utf8', flag: 'wx' });
        jobs.set(job.id, job);
        await trimJobs(job.id);
        await save();
        resume();
        return send(response, 202, { ok: true, id: job.id, status: job.status });
      } finally { pendingAdmissions--; }
    }
    const match = request.method === 'GET' && url.pathname.match(/^\/v1\/jobs\/([\da-f-]{36})$/i);
    if (match) {
      const job = jobs.get(match[1]);
      return job ? send(response, 200, { ok: true, job: publicJob(job) }) : send(response, 404, { ok: false, error: 'job_not_found：本地任务不存在' });
    }
    return send(response, 404, { ok: false, error: 'not_found：本地接口不存在' });
  }

  return {
    token, snapshot, resume, deleteJobs, enqueueTaobaoSearch,
    async enqueueTaobaoVerification(taskId){
      if(!/^[\da-f-]{36}$/i.test(taskId||''))throw new Error('淘宝验证任务无效');
      return enqueueBrowserCommand({kind:'taobao-verification',buyerTaskId:taskId});
    },
    async cancelBuyerTaskCommands(taskId){
      const changed=[];
      for(const command of browserCommands.values())if(command.buyerTaskId===taskId&&['queued','claimed'].includes(command.status)){
        changed.push([command,{...command}]);Object.assign(command,{status:'failed',error:'本机买手任务已删除',updatedAt:new Date().toISOString()});delete command.imageData;
      }
      try{await saveBrowserCommands();}catch(error){for(const [command,previous] of changed)Object.assign(command,previous);throw error;}
    },
    async failBuyerBrowserCommand(id,error){
      const command=browserCommands.get(id);
      if(!command||!['buyer-source','buyer-supplier-search'].includes(command.kind)||!['queued','claimed'].includes(command.status))return false;
      Object.assign(command,{status:'failed',error:String(error||'浏览器采集已停止').slice(0,180),updatedAt:new Date().toISOString()});
      delete command.imageData;await saveBrowserCommands();return true;
    },
    async enqueueBuyerBrowser(input){
      const gallerySlot=typeof input.slot==='string'&&/^gallery:\d{1,2}:[a-f0-9]{10}$/.test(input.slot);
      if(!['buyer-source','buyer-supplier-search'].includes(input.kind)||!/^[\da-f-]{36}$/i.test(input.buyerTaskId||'')||!(['source','supplier','search'].includes(input.slot)||gallerySlot)||gallerySlot&&input.kind!=='buyer-source')throw new Error('自动买手浏览器命令无效');
      if(input.kind==='buyer-source'){
        const url=new URL(input.detailUrl),domains={taobao:['taobao.com','tmall.com'],douyin:['douyin.com','jinritemai.com'],wsy:['wsy.com'],zwd:['17zwd.com'],qcc:['17qcc.com'],e3hui:['e3hui.com','e3hui.cn']}[input.platform]||[];
        if(url.protocol!=='https:'||url.username||url.password||url.port||!domains.some(domain=>url.hostname===domain||url.hostname.endsWith('.'+domain)))throw new Error('自动买手商品链接不属于对应平台');
        return enqueueBrowserCommand({kind:input.kind,buyerTaskId:input.buyerTaskId,slot:input.slot,platform:input.platform,detailUrl:url.href});
      }
      if(!dataImage(input.imageData))throw new Error('自动买手搜索图片无效');
      const searchMode=input.searchMode==='detail'?'detail':'top';
      return enqueueBrowserCommand({kind:input.kind,buyerTaskId:input.buyerTaskId,slot:'search',searchMode,imageData:input.imageData});
    },
    async resumeTaobaoSearch() { if(closed||!canAccess())throw new Error('请先登录桌面工作台');taobaoPaused=false;await saveBrowserCommands();return snapshot(); },
    async pauseTaobaoSearch() { if(closed||!canAccess())throw new Error('请先登录桌面工作台');taobaoPaused=true;await saveBrowserCommands();return snapshot(); },
    async enqueueDouyinSearch(input) {
      if (!dataImage(input?.imageData)) throw new Error('下载首图数据无效');
      if (typeof input.queryName !== 'string' || !input.queryName.trim()) throw new Error('抖音商品标题缺失');
      let sourceUrl = '';
      try { const parsed = new URL(input.sourceUrl); if (parsed.protocol === 'https:' && /(^|\.)douyin\.com$|(^|\.)jinritemai\.com$/i.test(parsed.hostname)) sourceUrl = parsed.href; } catch {}
      if (!sourceUrl) throw new Error('抖音商品链接无效');
      const existing = [...browserCommands.values()].find(command => command.kind === 'douyin-search' && command.sourceUrl === sourceUrl && ['queued', 'claimed'].includes(command.status));
      if (existing) return publicCommand(existing);
      return enqueueBrowserCommand({ kind: 'douyin-search', imageData: input.imageData, queryName: input.queryName.slice(0, 120), sourceUrl });
    },
    async enqueueProductSearch(input) {
      if(!dataImage(input?.imageData))throw new Error('商品图数据无效');
      if(typeof input.queryName!=='string'||!input.queryName.trim())throw new Error('商品名称缺失');
      if(!/^[\da-f-]{36}$/i.test(input.buyerTaskId||''))throw new Error('买手任务编号无效');
      let sourceUrl='';try{const u=new URL(input.sourceUrl);if(u.protocol==='https:'&&!u.username&&!u.password&&['douyin.com','jinritemai.com','taobao.com','tmall.com','wsy.com','17zwd.com','17qcc.com','e3hui.com','e3hui.cn'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d)))sourceUrl=u.href}catch{}
      if(!sourceUrl&&input.sourceType!=='image')throw new Error('商品来源链接无效');
      return enqueueBrowserCommand({kind:'product-search',imageData:input.imageData,queryName:input.queryName.trim().slice(0,120),sourceUrl,buyerTaskId:input.buyerTaskId});
    },
    async enqueueTaobaoComparison(input) { return this.enqueueBuyerComparison({...input,kind:'taobao'}); },
    async enqueueBuyerComparison(input) {
      if(closed||!canAccess())throw new Error('请先登录桌面工作台');
      if(!canProcess())throw new Error('请先在桌面设置中配置视觉模型');
      if(!dataImage(input?.query))throw new Error('商品原图数据无效');
      if(!/^[\da-f-]{36}$/i.test(input.buyerTaskId||''))throw new Error('买手任务编号无效');
      if(!/^[\da-f-]{36}$/i.test(input.queryId||''))throw new Error('淘宝搜索记录编号无效');
      const existing=[...jobs.values()].find(job=>job.buyerTaskId===input.buyerTaskId&&job.queryId===input.queryId);
      if(existing)return publicJob(existing);
      if(!Array.isArray(input.items)||input.items.length<1||input.items.length>(input.kind==='supplier'?500:60))throw new Error('候选数量超出本次识别范围');
      let items=input.items.map(value=>{
        const item=safeItem({...value,platform:input.kind==='supplier'?value.platform:'taobao'});let product='';
        try{const url=new URL(item.detailUrl);if(input.kind==='supplier'){const domains={wsy:['wsy.com'],zwd:['17zwd.com'],qcc:['17qcc.com'],e3hui:['e3hui.com','e3hui.cn']}[item.platform]||[];if(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&domains.some(domain=>url.hostname===domain||url.hostname.endsWith('.'+domain)))product=url.href;}else if(url.protocol==='https:'&&['item.taobao.com','detail.tmall.com'].includes(url.hostname)&&url.pathname==='/item.htm'&&/^\d{5,25}$/.test(url.searchParams.get('id')||''))product=`https://${url.hostname}/item.htm?id=${url.searchParams.get('id')}`;}catch{}
        if(!product||!item.imageUrl||(input.kind!=='supplier'&&!allowedProductImage(new URL(item.imageUrl).hostname,'taobao')))throw new Error('淘宝或供应商候选商品链接或图片地址无效');
        return {...item,detailUrl:product};
      });
      if(input.kind!=='supplier')items=sales.sort(items);
      if([...jobs.values()].filter(job=>['queued','processing'].includes(job.status)).length+pendingAdmissions>=maxStoredJobs)throw new Error('桌面队列已有10个进行中任务，请等待完成后继续');
      pendingAdmissions++;
      try {
        const id=crypto.randomUUID(),now=new Date().toISOString(),queryId=input.queryId;
        const job={id,createdAt:now,updatedAt:now,status:'queued',progress:0,completed:0,total:items.length,error:'',query:input.query,mode:'select',reviewMode:input.automatic===true&&input.kind==='supplier'?'direct':'manual',goodsId:'',baseline:'',reduction:'',queryName:String(input.queryName||'淘宝同款候选').slice(0,120),buyerTaskId:input.buyerTaskId,queryId,searchGroupId:queryId,searchIssues:safeSearchIssues(input.searchIssues),platformSearches:safePlatformSearches(input.platformSearches),autoRetryCount:0,manualRetryRounds:0,retryCount:0,items};
        await fs.mkdir(path.join(dataDir,'queries'),{recursive:true});await fs.writeFile(path.join(dataDir,'queries',`${id}.txt`),job.query,{encoding:'utf8',flag:'wx'});
        jobs.set(id,job);try{await trimJobs(id);await save();}catch(error){jobs.delete(id);await fs.rm(path.join(dataDir,'queries',`${id}.txt`),{force:true});throw error;}
        resume();return publicJob(job);
      } finally {pendingAdmissions--;}
    },
    async enqueueDetails(jobId, itemIndex) {
      const job = jobs.get(jobId), item = Number.isInteger(itemIndex) ? job?.items[itemIndex] : null;
      if (!job || !item) throw new Error('本地商品不存在');
      if (!review.decision(item) || review.decision(item).verdict !== 'likely_same') throw new Error('请先人工确认该商品为疑似同款');
      if (item.productDetails) throw new Error('该商品详情已采集');
      if (!item.detailUrl || !item.platform) throw new Error('候选商品缺少详情链接或平台信息');
      let url;
      try { url = new URL(item.detailUrl); } catch { throw new Error('商品详情链接无效'); }
      const allowed = { wsy: ['wsy.com'], zwd: ['17zwd.com'], qcc: ['17qcc.com'], e3hui: ['e3hui.com', 'e3hui.cn'] }[item.platform] || [];
      if (url.protocol !== 'https:' || url.username || url.password || !allowed.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) throw new Error('商品详情链接域名与候选平台不匹配');
      const existing = [...browserCommands.values()].find(command => command.kind === 'product-details' && command.jobId === jobId && command.itemIndex === itemIndex && ['queued', 'claimed'].includes(command.status));
      if (existing) return publicCommand(existing);
      return enqueueBrowserCommand({ kind: 'product-details', jobId, itemIndex, detailUrl: url.href, platform: item.platform, title: item.title.slice(0, 300) });
    },
    buyerCandidate(jobId, itemIndex) {
      const job=jobs.get(jobId),item=Number.isInteger(itemIndex)?job?.items[itemIndex]:null;
      if(!job||!item)throw new Error('桌面候选不存在');
      const decision=review.decision(item);
      if(!decision||decision.verdict!=='likely_same')throw new Error('请先人工确认该供应商候选为疑似同款');
      if(!item.productDetails)throw new Error('请先采集该供应商商品详情');
      return {queryId:job.queryId,itemIndex,platform:item.platform,id:item.id,title:item.title,goodsId:item.goodsId,price:item.productDetails.price??item.price,shopName:item.productDetails.shopName||item.shopName,detailUrl:item.detailUrl,productDetails:item.productDetails,confirmedReview:{verdict:decision.verdict,reviewedAt:decision.reviewedAt}};
    },
    browserCommandStatus() { return [...browserCommands.values()].map(publicCommand); },
    async storeCandidateImage(id, index, buffer) {
      const job = jobs.get(id);
      if (!job || !Number.isInteger(index) || !job.items[index]) throw new Error('本地商品不存在');
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      const dir = path.join(dataDir, 'images', id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${index}-${sha256}.jpg`), buffer);
      return sha256;
    },
    async candidateImage(id, index) {
      const job = jobs.get(id);
      const item = Number.isInteger(index) ? job?.items[index] : null;
      if (!item) throw new Error('本地商品不存在');
      const hash = item.imageEvidence?.sha256;
      if (!/^[a-f0-9]{64}$/.test(hash || '')) throw new Error('旧任务未保存送模图片；请使用高清图重新比对后审核');
      let buffer;
      try { buffer = await fs.readFile(path.join(dataDir, 'images', id, `${index}-${hash}.jpg`)); }
      catch { throw new Error('送模图片文件缺失，请重新比对后审核'); }
      if (crypto.createHash('sha256').update(buffer).digest('hex') !== hash) throw new Error('送模图片校验失败，请重新比对后审核');
      return `data:image/jpeg;base64,${buffer.toString('base64')}`;
    },
    queryImage(id) {
      const job = jobs.get(id);
      if (!job) throw new Error('本地任务不存在');
      return job.query || '';
    },
    async setReviewMode(id, value) {
      const job = jobs.get(id);
      if (!job) throw new Error('本地任务不存在');
      if (['queued', 'processing'].includes(job.status)) throw new Error('请等待本任务模型比对完成后切换');
      if (!['manual', 'direct'].includes(value)) throw new Error('结果模式无效');
      const before = job.reviewMode;
      const beforeUpdatedAt = job.updatedAt;
      job.reviewMode = value;
      job.updatedAt = new Date().toISOString();
      try { await save(); } catch (error) { job.reviewMode = before; job.updatedAt = beforeUpdatedAt; throw error; }
      return publicJob(job);
    },
    async reviewItem(id, index, input, expectedSignature) {
      const job = jobs.get(id);
      if (!job) throw new Error('本地任务不存在');
      if (['queued', 'processing'].includes(job.status)) throw new Error('请等待本任务模型比对完成后审核');
      const item = Number.isInteger(index) ? job.items[index] : null;
      if (!item || !review.comparison(item)) throw new Error('商品尚未完成模型比对，不能审核');
      if (expectedSignature !== review.signature(item)) throw new Error('模型结果已变化，请重新打开审核');
      const updated = input ? review.apply(item, input) : { ...item };
      if (!input) delete updated.humanReview;
      job.items[index] = updated;
      const beforeUpdatedAt = job.updatedAt;
      job.updatedAt = new Date().toISOString();
      try { await save(); } catch (error) { job.items[index] = item; job.updatedAt = beforeUpdatedAt; throw error; }
      return publicJob(job);
    },
    retry(id, all = false) {
      // Coalesce repeated clicks before any disk access, and serialize admission
      // with deletion so an original job cannot disappear during an in-place retry.
      if (retryRequests.has(id)) return retryRequests.get(id);
      const request = historyQueue.catch(() => {}).then(async () => {
        if (closed || !canAccess() || !canProcess()) throw new Error('请先登录桌面端，并在设置中添加和选择模型');
        const previous = jobs.get(id);
        if (!previous) throw new Error('本地任务不存在');
        if (['queued', 'processing'].includes(previous.status)) return publicJob(previous);
        const activeRecomparison = [...jobs.values()].find(job => job.retryOf === id && ['queued', 'processing'].includes(job.status));
        if (activeRecomparison) return publicJob(activeRecomparison);
        const pending = all ? previous.items : previous.items.filter(item => !item.visualComparison);
        if (!pending.length) throw new Error('没有未完成候选，无需重复调用模型');
        if ([...jobs.values()].filter(job => ['queued', 'processing'].includes(job.status)).length + pendingAdmissions >= maxStoredJobs) throw new Error('桌面队列已有10个进行中任务，请等待完成后重试');
        pendingAdmissions++;
        try {
          const query = previous.query || await fs.readFile(path.join(dataDir, 'queries', `${id}.txt`), 'utf8');
          const now = new Date().toISOString();
          if (!all) {
            const compared = previous.items.length - pending.length;
            const job = { ...previous, status: 'queued', updatedAt: now, completed: compared, compared, failed: 0,
              notStarted: pending.length, progress: Math.floor(compared * 100 / previous.items.length),
              error: '', inFlight: [], query, batchSize: 1, continueOnFailure: true, autoRetryCount: 0,
              manualRetryRounds: (Number.isInteger(previous.manualRetryRounds) ? previous.manualRetryRounds : 0) + 1, lastRetryAt: now,
              retryCount: (Number.isInteger(previous.retryCount) ? previous.retryCount : 0) + 1,
              items: previous.items.map(item => item.visualComparison ? item : resetRetryItem(item)) };
            jobs.set(id, job);
            try { await save(); }
            catch (error) { jobs.set(id, previous); throw error; }
            resume();
            return publicJob(job);
          }
          // An explicit full HD re-comparison is a separate operation; ordinary
          // retries above keep the original ID, candidate indexes, and evidence.
          const job = {
            ...previous, id: crypto.randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            status: 'queued', progress: 0, completed: 0, compared: 0, failed: 0, notStarted: pending.length,
            total: pending.length, error: '', inFlight: [], query, batchSize: 1, retryOf: id, autoRetryCount: 0, manualRetryRounds: 0, retryCount: 0,
            items: pending.map(resetRetryItem)
          };
          await fs.mkdir(path.join(dataDir, 'queries'), { recursive: true });
          await fs.writeFile(path.join(dataDir, 'queries', `${job.id}.txt`), query, { encoding: 'utf8', flag: 'wx' });
          jobs.set(job.id, job);
          await trimJobs(job.id);
          await save();
          resume();
          return publicJob(job);
        } finally { pendingAdmissions--; }
      }).finally(() => { retryRequests.delete(id); });
      retryRequests.set(id, request);
      historyQueue = request.catch(() => {});
      return request;
    },
    async start() {
      await fs.mkdir(dataDir, { recursive: true });
      try{taobaoPaused=JSON.parse(await fs.readFile(path.join(dataDir,'taobao-queue.json'),'utf8')).paused===true;}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
      try {
        const savedCommands = JSON.parse(await fs.readFile(path.join(dataDir, 'browser-commands.json'), 'utf8'));
        if (Array.isArray(savedCommands)) for (const command of savedCommands.slice(-60)) {
          if (command && /^[\da-f-]{36}$/i.test(command.id || '') && ['douyin-search', 'product-search', 'taobao-image-search', 'taobao-verification', 'product-details','buyer-source','buyer-supplier-search'].includes(command.kind) && ['queued', 'claimed', 'accepted', 'failed'].includes(command.status)) browserCommands.set(command.id, command);
        }
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      try {
        const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8'));
        if (Array.isArray(saved)) for (const job of saved.slice(-maxStoredJobs)) {
          if (job && typeof job.id === 'string' && /^[\da-f-]{36}$/i.test(job.id) && Array.isArray(job.items)) {
            job.reviewMode = review.mode(job.reviewMode);
            try { job.query = await fs.readFile(path.join(dataDir, 'queries', `${job.id}.txt`), 'utf8'); }
            catch (queryError) {
              if (queryError.code !== 'ENOENT') throw queryError;
              job.status = 'failed'; job.error = '本地原图文件缺失，无法恢复该任务';
            }
            if (job.status === 'processing' && job.query) {
              for (const index of Array.isArray(job.inFlight) ? job.inFlight : []) {
                if (Number.isInteger(index) && job.items[index] && !job.items[index].visualComparison) {
                  job.items[index].imageSimilarityStatus = 'unavailable';
                  job.items[index].imageSimilarityError = '桌面应用在本批请求期间关闭；为避免重复计费，本批没有自动重试';
                }
              }
              job.inFlight = [];
              job.status = job.items.some(item => !item.visualComparison && item.imageSimilarityStatus !== 'unavailable') ? 'queued' : 'partial';
            }
            jobs.set(job.id, job);
          }
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await listen(port); }
      catch (error) {
        if (error.code !== 'EADDRINUSE' || port === 0) throw error;
        port = 0;
        await listen(port);
      }
      return snapshot();
    },
    async close() {
      closed = true;
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      await idle;
      await historyQueue;
      await saveQueue;
      await browserSaveQueue;
      await browserAdmissionQueue;
    }
  };
}

module.exports = { createDesktopBridge, safeItem, safePlatformSearches, MAX_CANDIDATES };
