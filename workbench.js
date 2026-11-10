(() => {
  const $ = id => document.getElementById(id);
  const key = 'core.session';
  const extension = location.protocol === 'chrome-extension:' && globalThis.chrome?.storage;
  if (extension) { const manifest = chrome.runtime.getManifest(); $('version').textContent = `v${manifest.version_name || manifest.version}`; }
  const defaultSelected = () => ['wsy', 'zwd', 'qcc', 'e3hui'].filter(key => Object.prototype.hasOwnProperty.call(FindTransport.platforms, key));
  const initialState = () => ({ queryId: '', queryName: '', searchGroupId: '', thumbnail: '', fingerprint: '', base64: '', goodsId: '', mode: 'select', reviewMode: 'manual', baseline: '', reduction: 5, raw: [], total: null, phase: 'idle', message: '', searched: false, selected: defaultSelected(), selectionCustomized: false, platforms: {} });
  const imageData = value => typeof value === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(value) && value.length <= 8 * 1024 * 1024 ? value : '';
  const selectedPlatforms = value => {
    if (!Array.isArray(value)) return defaultSelected();
    return [...new Set(value.filter(key => Object.prototype.hasOwnProperty.call(FindTransport.platforms, key)))];
  };
  const normalizeState = saved => {
    const base = initialState();
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return base;
    base.base64 = imageData(saved.base64);
    for (const field of ['queryId', 'queryName', 'searchGroupId', 'fingerprint']) base[field] = typeof saved[field] === 'string' ? saved[field].slice(0, 120) : '';
    base.thumbnail = imageData(saved.thumbnail);
    base.goodsId = typeof saved.goodsId === 'string' ? saved.goodsId : '';
    base.mode = saved.mode === 'optimize' ? 'optimize' : 'select';
    base.reviewMode = FindReview.mode(saved.reviewMode);
    base.baseline = typeof saved.baseline === 'string' || typeof saved.baseline === 'number' ? saved.baseline : '';
    base.reduction = typeof saved.reduction === 'string' || typeof saved.reduction === 'number' ? saved.reduction : 5;
    base.raw = Array.isArray(saved.raw) ? saved.raw.filter(item => item && typeof item === 'object' && !Array.isArray(item)).map(item => {
      return item.imageSimilaritySource === FindVision.algorithm ? item : FindVision.clearJudgment(item);
    }) : [];
    base.total = saved.total == null || Number.isFinite(Number(saved.total)) ? (saved.total == null ? null : Number(saved.total)) : null;
    base.phase = typeof saved.phase === 'string' ? saved.phase : 'idle';
    base.message = typeof saved.message === 'string' ? saved.message : '';
    base.searched = saved.searched === true;
    base.selectionCustomized = saved.selectionCustomized === true;
    base.selected = base.selectionCustomized ? selectedPlatforms(saved.selected) : defaultSelected();
    base.platforms = saved.platforms && typeof saved.platforms === 'object' && !Array.isArray(saved.platforms) ? saved.platforms : {};
    return base;
  };
  let state = initialState(), workspace;
  const reviewKey = item => JSON.stringify([FindReview.signature(item), item.title, Math.round(FindCore.number(item.price) * 100)]);
  const reviewIndex = item => state.raw.findIndex(raw => reviewKey(raw) === reviewKey(item));
  function renderPlatforms() {
    const root = $('platforms'); root.replaceChildren();
    for (const [key, config] of Object.entries(FindTransport.platforms)) {
      const record = state.platforms[key];
      const row = document.createElement('span'); row.className = 'platform-status';
      const text = document.createElement('span');
      const received = Array.isArray(record?.items) ? record.items.length : null;
      const groups = Array.isArray(record?.diagnostics?.searchGroups) ? record.diagnostics.searchGroups : [];
      const groupText = groups.map(group => `${group.type === 'accurate' ? '准确搜' : '相似搜'}报告 ${Number.isSafeInteger(group.total) ? group.total : '未知'} / 收到 ${Number.isSafeInteger(group.received) ? group.received : 0}`).join('；');
      const counts = record ? `本次收到 ${received ?? 0} 条候选；平台报告总数 ${Number.isSafeInteger(record.total) ? record.total : '未知'}` : '';
      text.textContent = `${config.name}：${record?.message || (state.selected.includes(key) ? '等待搜索' : '未选择，未发起搜索')}${counts ? `；${counts}` : ''}${groupText ? `；${groupText}` : ''}`;
      row.append(text);
      if (record?.phase === 'manual_required' || Number.isInteger(record?.openTabId)) {
        const open = document.createElement('button'); open.type = 'button'; open.className = 'platform-open'; open.dataset.platform = key; open.textContent = Number.isInteger(record?.openTabId) ? '打开处理页' : '打开平台';
        row.append(open);
      }
      root.append(row);
    }
  }
  $('platforms').addEventListener('click', async event => {
    const button = event.target.closest('button[data-platform]');
    const config = FindTransport.platforms[button?.dataset.platform];
    if (!config) return;
    const problemTabId = state.platforms[button.dataset.platform]?.openTabId;
    if (Number.isInteger(problemTabId)) {
      try {
        const problemTab = await chrome.tabs.get(problemTabId);
        await chrome.tabs.update(problemTabId, { active: true });
        await chrome.windows.update(problemTab.windowId, { focused: true });
        return;
      } catch {}
    }
    const tabs = await chrome.tabs.query({ url: config.matches });
    const tab = tabs.find(item => !item.discarded && item.frozen !== true);
    if (tab) { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }
    else await chrome.tabs.create({ url: config.url, active: true });
  });
  let generation = 0, busy = true, initializing = true, connectionBusy = false, showAll = false, saveQueue = Promise.resolve();
  let connectionReport = null;
  let desktopConnection = { endpoint: '', token: '', connected: false };
  let savedDesktopPair = null, autoPairTimer;
  const desktopMode = () => desktopConnection.connected && $('sendToDesktop').checked;
  function desktopBase() {
    const url = new URL($('desktopEndpoint').value.trim());
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('本机地址必须是 Electron 显示的 http://127.0.0.1 地址');
    return url.origin;
  }
  $('connectDesktop').addEventListener('click', async () => {
    if (!extension || busy || connectionBusy) return;
    connectionBusy = true; controls(); $('desktopStatus').textContent = '正在连接…';
    try {
      const endpoint = desktopBase();
      const pairingCode = $('desktopToken').value.trim();
      if (!pairingCode) throw new Error('请先从 Electron 复制长期配对码');
      const response = await fetch(`${endpoint}/v1/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Desktop-Token': pairingCode }, body: '{}', credentials: 'omit', signal: AbortSignal.timeout(5000) });
      const result = await response.json();
      if (!response.ok || !result?.ok) throw new Error(result?.error || `本机连接失败（HTTP ${response.status}）`);
      desktopConnection = { endpoint, token: pairingCode, connected: true };
      savedDesktopPair = { endpoint, token: pairingCode };
      await chrome.storage.local.set({ productComparisonDesktop: savedDesktopPair, productComparisonDesktopEnabled: $('sendToDesktop').checked });
      void chrome.runtime.sendMessage({ type: 'PROCESS_DESKTOP_BROWSER_WORKFLOW' }).catch(() => {});
      clearInterval(autoPairTimer);
      $('sendToDesktop').disabled = false; $('desktopStatus').textContent = `已连接 ${endpoint}`;
    } catch (error) {
      $('desktopStatus').textContent = error.message || '本机连接失败';
    } finally { connectionBusy = false; controls(); }
  });
  $('sendToDesktop').addEventListener('change', () => {
    $('desktopStatus').textContent = $('sendToDesktop').checked ? '已启用本地队列' : '已连接，当前仍在扩展内处理';
    if (extension) void chrome.storage.local.set({ productComparisonDesktopEnabled: $('sendToDesktop').checked });
    controls();
  });
  async function autoConnectSavedDesktop() {
    if (!savedDesktopPair || desktopConnection.connected || connectionBusy) return;
    try {
      $('desktopEndpoint').value = savedDesktopPair.endpoint;
      const endpoint = desktopBase();
      const response = await fetch(`${endpoint}/v1/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Desktop-Token': savedDesktopPair.token }, body: '{}', credentials: 'omit', signal: AbortSignal.timeout(2500) });
      const result = await response.json();
      if (!response.ok || !result?.ok) throw new Error(result?.error || '配对码已失效，请重新连接');
      desktopConnection = { endpoint, token: savedDesktopPair.token, connected: true };
      clearInterval(autoPairTimer);
      void chrome.runtime.sendMessage({ type: 'PROCESS_DESKTOP_BROWSER_WORKFLOW' }).catch(() => {});
      $('desktopToken').value = savedDesktopPair.token;
      $('sendToDesktop').disabled = false;
      $('desktopStatus').textContent = $('sendToDesktop').checked ? `已自动连接 ${endpoint}` : `已连接 ${endpoint}；当前识别使用浏览器模型`;
      controls();
    } catch {
      $('desktopStatus').textContent = '桌面端暂不可用，将自动重连；请确认桌面端已登录';
    }
  }
  async function restoreDesktopConnection() {
    if (!extension) return;
    try {
      const saved = await chrome.storage.local.get(['productComparisonDesktop', 'productComparisonDesktopEnabled']);
      savedDesktopPair = saved.productComparisonDesktop?.endpoint && saved.productComparisonDesktop?.token ? saved.productComparisonDesktop : null;
      $('sendToDesktop').checked = saved.productComparisonDesktopEnabled !== false;
      if (!savedDesktopPair) { $('desktopBridge').open = true; $('desktopStatus').textContent = '首次使用，请从桌面端复制长期配对码并连接一次'; return; }
      $('desktopEndpoint').value = savedDesktopPair.endpoint;
      $('desktopToken').value = savedDesktopPair.token;
      await autoConnectSavedDesktop();
      if (!desktopConnection.connected) {
        clearInterval(autoPairTimer);
        autoPairTimer = setInterval(() => { void autoConnectSavedDesktop(); }, 5000);
      }
    } catch (error) {
      $('desktopStatus').textContent = error.message || '无法读取已保存的桌面配对信息';
    }
  }
  async function submitDesktopJob(query, items) {
    const searchIssues = Object.entries(state.platforms).filter(([, record]) => ['partial', 'failed', 'manual_required'].includes(record?.phase))
      .map(([platform, record]) => ({ platform, phase: record.phase, message: String(record.message || '').slice(0, 240) }));
    const platformSearches = Object.keys(FindTransport.platforms).map(platform => {
      const record = state.platforms[platform];
      const searchGroups = (Array.isArray(record?.diagnostics?.searchGroups) ? record.diagnostics.searchGroups : [])
        .filter(group => ['accurate', 'similar'].includes(group.type) && ['complete', 'failed'].includes(group.phase)).slice(0, 2)
        .map(group => ({ type: group.type, phase: group.phase,
          receivedCount: Number.isSafeInteger(group.received) && group.received >= 0 ? group.received : 0,
          reportedTotal: Number.isSafeInteger(group.total) && group.total >= 0 ? group.total : null }));
      return { platform, selected: state.selected.includes(platform), phase: record?.phase || (state.selected.includes(platform) ? 'not_started' : 'not_selected'),
        receivedCount: Array.isArray(record?.items) ? record.items.length : 0,
        reportedTotal: Number.isSafeInteger(record?.total) && record.total >= 0 ? record.total : null,
        message: String(record?.message || '').slice(0, 240), searchGroups };
    });
    const response = await fetch(`${desktopConnection.endpoint}/v1/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Desktop-Token': desktopConnection.token },
      body: JSON.stringify({ query, items, searchIssues, platformSearches, queryId: state.queryId, queryName: state.queryName, searchGroupId: state.searchGroupId, mode: state.mode, reviewMode: state.reviewMode, goodsId: state.goodsId, baseline: state.baseline, reduction: state.reduction }),
      credentials: 'omit', signal: AbortSignal.timeout(15000)
    });
    let result;
    try { result = await response.json(); } catch { throw new Error(`Electron 未返回有效响应（HTTP ${response.status}）`); }
    if (!response.ok || !result?.ok) throw new Error(result?.error || `Electron 接收任务失败（HTTP ${response.status}）`);
    return result;
  }
  $('checkConnection').addEventListener('click', async () => {
    if (!extension) { $('connectionStatus').textContent='请从扩展图标打开工作台。'; return; }
    if (initializing || busy || connectionBusy) return;
    connectionBusy = true; renderConnectionReport(true); controls(); $('connectionStatus').textContent='正在检查已打开的平台，不会发起搜图…';
    try {
      connectionReport=await FindConnectionCheck.collect(message=>{$('connectionStatus').textContent=message;});
      renderConnectionReport();
    } catch (error) {
      connectionReport={version:chrome.runtime.getManifest().version_name || chrome.runtime.getManifest().version,checkedAt:new Date().toISOString(),mode:'read_only_existing_tabs',pages:[],inspected:0,incomplete:true,error:'无法完成页面检查，请重试'};
      renderConnectionReport();
    } finally { connectionBusy=false; controls(); }
  });
  function renderConnectionReport(checking = false) {
    const rows = FindConnectionCheck.summarize(checking ? null : connectionReport);
    const actions = { login_required:'前往登录',permission_required:'查看权限',inspected:'查看平台',discarded:'打开页面',inspect_timeout:'打开平台重试',no_response:'打开平台重试' };
    $('connectionOutput').setAttribute('aria-busy', String(checking));
    $('connectionOutput').innerHTML = rows.map(row=>`<div class="connection-row" data-code="${checking ? 'checking' : esc(row.code)}"><strong>${esc(row.name)}</strong><span class="connection-result">${checking ? '检查中' : esc(row.result)}</span><span class="connection-reason">${checking ? '正在检查已打开的页面…' : esc(row.reason)}</span><button type="button" data-connection-platform="${esc(row.platform)}" aria-label="${esc(row.name)}：${esc(actions[row.code] || '打开平台')}">${esc(actions[row.code] || '打开平台')}</button></div>`).join('');
    $('connectionCheckedAt').hidden = checking || !connectionReport?.checkedAt;
    if (connectionReport?.checkedAt && !checking) {
      $('connectionCheckedAt').dateTime = connectionReport.checkedAt;
      $('connectionCheckedAt').textContent = `检查于 ${new Date(connectionReport.checkedAt).toLocaleTimeString('zh-CN', { hour12:false })}`;
    }
    if (checking || !connectionReport) return;
    const responded=rows.filter(row=>row.code==='inspected').length;
    $('connectionStatus').textContent=connectionReport.error ? '检查未完成，请重试。' : `检查完成：${responded} 个平台页面已响应${responded < rows.length ? `，${rows.length-responded} 个需处理` : ''}。`;
  }
  $('connectionOutput').addEventListener('click', async event => {
    const button=event.target.closest('button[data-connection-platform]');
    const config=FindTransport.platforms[button?.dataset.connectionPlatform];
    if (!config || connectionBusy || busy) return;
    try {
      const tabs=await chrome.tabs.query({url:config.matches});
      const tab=tabs.find(tab=>!tab.discarded && tab.frozen!==true);
      if (tab) { await chrome.tabs.update(tab.id,{active:true}); await chrome.windows.update(tab.windowId,{focused:true}); }
      else await chrome.tabs.create({url:config.url,active:true});
    } catch { $('connectionStatus').textContent=`未能打开${config.name}，请手动打开平台后重试。`; }
  });
  $('downloadConnection').addEventListener('click', () => {
    const judgments = state.raw.filter(item => item.imageSimilaritySource === FindVision.algorithm && item.visualComparison);
    const visualComparison = {
      engine: FindVision.algorithm, batchSize: FindVision.batchSize, scoreMeaning: '同类结论内的视觉排序分；不是同款概率',
      status: busy ? 'search_in_progress' : judgments.length === state.raw.length && judgments.length ? 'complete' : judgments.length ? 'partial' : 'not_compared',
      compared: judgments.length, unavailable: state.raw.length - judgments.length,
      verdicts: Object.fromEntries(Object.keys(FindVision.labels).map(key => [key, judgments.filter(item => item.visualComparison.verdict === key).length])),
      models: [...new Set(judgments.map(item => item.imageSimilarityEngine))]
    };
    const diagnostic = {
      version: extension ? chrome.runtime.getManifest().version_name || chrome.runtime.getManifest().version : 'local', checkedAt: new Date().toISOString(), mode: 'workbench_diagnostic_snapshot',
      search: { busy, phase: state.phase, message: state.message, selectedPlatforms: state.selected,
        visualComparison, reviewMode: state.reviewMode, humanReview: FindReview.summary(state.raw, state.reviewMode),
        platforms: Object.fromEntries(Object.entries(state.platforms).map(([key,x])=>[key,{phase:x.phase,message:x.message,received:x.items?.length ?? 0,total:x.total ?? null,diagnostics:x.diagnostics || null}])) },
      connectionCheck: connectionReport,
      note: '不包含图片、图片Base64、商品原始记录、Cookie、账号信息或请求凭证。'
    };
    const url=URL.createObjectURL(new Blob([JSON.stringify(diagnostic,null,2)],{type:'application/json'}));
    const a=document.createElement('a'); a.href=url; a.download='找商品-平台连接诊断.json'; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const status = (phase, message) => { state.phase = phase; state.message = message; $('status').textContent = message; $('status').classList.toggle('error', phase === 'failed' || phase === 'input_invalid'); $('diagnostics').textContent = JSON.stringify({ phase, error: phase === 'failed' || phase === 'input_invalid' ? message : '', received: state.raw.length, platformTotal: state.total, platforms: Object.fromEntries(Object.entries(state.platforms).map(([key,x])=>[key,{phase:x.phase,message:x.message,received:x.items?.length ?? 0,total:x.total ?? null,diagnostics:x.diagnostics || null}])) }, null, 2); };
  function save() {
    if (!extension) return Promise.resolve();
    const snapshot = JSON.parse(JSON.stringify(state));
    const queryIndex = workspace?.capture(snapshot);
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      await chrome.storage.local.set({ [key]: snapshot });
      if (snapshot.queryId) await FindQueryStore.write([snapshot], queryIndex);
    });
    return saveQueue;
  }
  async function persist() {
    try {
      await save();
      $('storageNotice').hidden = true;
      $('storageNotice').textContent = '';
    } catch (error) {
      // Persistence is independent of a successful platform response. Keep
      // received results visible and disclose that refresh may lose changes.
      $('storageNotice').hidden = false;
      $('storageNotice').textContent = `storage_write：保存失败；本页可继续使用，刷新可能丢失本次更改。${error.message}`;
    }
  }
  function inputs() {
    return { mode: document.querySelector('[name=mode]:checked').value, baseline: $('baseline').value, reduction: $('reduction').value, goodsId: $('goodsId').value };
  }
  function renderResults() {
    let result;
    try { result = FindCore.evaluate(state.raw, state); }
    catch (error) {
      $('results').hidden = true; $('results').querySelector('tbody').innerHTML = ''; $('summary').textContent = '';
      $('empty').hidden = false; $('empty').textContent = error.message;
      $('showAll').hidden = true; $('excludedCount').textContent = '0'; $('excludedRows').innerHTML = '';
      return;
    }
    const { kept, excluded } = result;
    const scoreThreshold = FindReview.exclusionThreshold(state.raw);
    const scoreExcluded = excluded.filter(item => item.scoreExcluded);
    const reviewable = [...kept, ...scoreExcluded];
    const filtered = ($('reviewFilter').value === 'excluded' ? scoreExcluded : kept).filter(item => FindReview.matchesFilter(item, $('reviewFilter').value, state.reviewMode, state.raw)).sort((a,b) => FindReview.compare(a,b,state.reviewMode));
    const visible = showAll ? filtered : filtered.slice(0, 8);
    $('reviewSummary').textContent = FindReview.text(reviewable, state.reviewMode);
    $('reviewNext').disabled = busy || connectionBusy || !reviewable.some(item => !FindReview.belowThreshold(item, state.raw) && FindReview.comparison(item) && !FindReview.decision(item));
    $('results').hidden = !visible.length;
    $('empty').hidden = !!visible.length;
    const needsManual = Object.values(state.platforms).some(platform => platform.phase === 'manual_required');
    $('empty').textContent = state.searched ? (state.phase === 'failed' ? '搜索失败，未取得本次可靠结果。' : needsManual ? '自动平台没有符合条件的候选；可打开辅助平台登录并手动搜图。' : state.phase === 'partial' ? '已成功平台没有符合条件的候选；其余平台失败，搜索不完整。' : '没有符合条件的候选。') : state.phase === 'platform_search' ? '搜索进行中，平台完成后会更新这里。' : '尚未搜索。';
    if (!filtered.length && state.phase !== 'failed') $('empty').textContent = $('reviewFilter').value === 'final' ? '当前没有有效结论；人工模式需先审核模型建议。' : $('reviewFilter').value === 'excluded' ? '当前没有已排除的结果。' : $('reviewFilter').value === 'pending' ? '当前没有待人工审核的商品。' : '没有符合条件的候选。';
    const platformRecords = Object.values(state.platforms).filter(record => record?.phase && record.phase !== 'not_selected');
    const receivedCounts = platformRecords.map(record => Array.isArray(record.items) ? record.items.length : 0);
    const coverageText = receivedCounts.length && receivedCounts.every(count => count === receivedCounts[0])
      ? `${platformRecords.length} 个平台各收到 ${receivedCounts[0]} 条候选`
      : `平台覆盖：${Object.entries(state.platforms).map(([key, record]) => `${FindTransport.platforms[key]?.name || key} ${Array.isArray(record.items) ? record.items.length : 0} 条`).join('，')}`;
    $('summary').textContent = state.searched && state.phase !== 'failed' ? `实际收到 ${state.raw.length} 条，${coverageText}；条件通过 ${kept.length} 条，淘汰 ${excluded.length} 条；显示 ${visible.length} 条${state.total != null ? `（平台报告总量 ${state.total}，不代表全部已返回）` : ''}。` : '';
    if (state.searched && kept.length) {
      const counts = Object.entries(FindVision.labels).map(([verdict, label]) => `${label} ${kept.filter(item => FindReview.effective(item, state.reviewMode) === verdict).length} 条`);
      const unavailable = kept.filter(item => item.imageSimilaritySource !== FindVision.algorithm || !item.visualComparison).length;
      $('summary').textContent += ` ${state.reviewMode === "direct" ? "模型暂定建议" : "人工结论"}：${counts.join('，')}，${FindReview.thresholdText(scoreThreshold)}排除 ${scoreExcluded.length} 条，未完成识别 ${unavailable} 条。`;
    } else if (state.searched && scoreExcluded.length) {
      $('summary').textContent += ` ${FindReview.thresholdText(scoreThreshold)}排除 ${scoreExcluded.length} 条。`;
    }
    $('results').querySelector('tbody').innerHTML = visible.map(item => {
      const current = item.imageSimilaritySource === FindVision.algorithm;
      const comparison = current ? item.visualComparison : null;
      const verdict = comparison?.verdict || 'unavailable';
      const judgment = comparison ? (FindVision.labels[verdict] || '无法判断') : item.imageSimilarityStatus === 'delegated' ? '已移交 Electron' : current ? '未完成识别' : '等待大模型识别';
      const details = comparison ? ['matches', 'differences', 'uncertainties'].map((key, index) => {
        const title = ['吻合', '差异', '待核实'][index];
        return (comparison[key] || []).map(text => '<small>' + title + '：' + esc(text) + '</small>').join('');
      }).join('') : '<small>' + esc(item.imageSimilarityError || '平台分数仅为检索线索，尚无大模型细节判断') + '</small>';
      const judgmentNote = comparison ? '<small class="match-score">' + esc(FindReview.scoreStatus(item, state.reviewMode)) + '</small><small>' + esc(item.imageSimilarityEngine) + '</small>' : '';
      const human = FindReview.decision(item);
        const review = comparison ? `<span class="review-state ${human ? 'reviewed' : ''}">${esc(FindReview.status(item, state.reviewMode))}</span>${human?.note ? `<small>审核备注：${esc(human.note)}</small>` : ''}<button type="button" data-review-index="${reviewIndex(item)}" ${busy || connectionBusy ? 'disabled' : ''}>${human ? '查看 / 修改审核' : '人工审核'}</button>` : '';
      return `<tr data-id="${esc(item.id)}"><td><img src="${esc(item.imageUrl)}" referrerpolicy="no-referrer" alt="商品图"><small class="imageState">加载中</small></td><td>${esc(item.goodsId || '未提供款号')}<small>${esc(item.title)}</small>${item.platformTags?.length ? '<small>' + esc(item.platformTags.join(' · ')) + '</small>' : ''}${item.goodsMatch ? '<small>款号一致，需核对商品</small>' : ''}</td><td>¥${item.price.toFixed(2)}</td><td>${item.saving == null ? '无基准成本' : `¥${item.saving.toFixed(2)}`}</td><td class="judgment" data-verdict="${esc(verdict)}"><strong>${comparison ? '模型建议：' : ''}${esc(judgment)}</strong>${review}${judgmentNote}${details}</td><td>${esc(item.shopName || '档口名缺失')}<small>ID：${esc(item.supplierId || '平台未提供')}</small></td><td>${esc(item.address)}</td><td><a href="${esc(item.detailUrl)}" target="_blank" rel="noreferrer">打开详情</a></td></tr>`;
    }).join('');
    $('results').querySelectorAll('img').forEach(img => {
      const update = () => { img.parentElement.querySelector('.imageState').textContent = img.naturalWidth > 0 ? `已加载 ${img.naturalWidth}×${img.naturalHeight}` : '加载失败，可打开详情检查'; };
      img.addEventListener('load', update); img.addEventListener('error', update); if (img.complete) update();
    });
    $('showAll').hidden = filtered.length <= 8 || showAll;
    $('excludedCount').textContent = excluded.length;
    $('excludedRows').innerHTML = excluded.map(item => `<p>${esc(item.goodsId || item.id || '无ID记录')} · ${item.price == null ? '无价格' : `¥${item.price}`}：${esc(item.reasons.join('；'))}${item.scoreExcluded ? `<button type="button" data-review-index="${reviewIndex(item)}">人工核对低分结果</button>` : ''}</p>`).join('');
  }
  function controls() {
    $('pick').disabled = busy || connectionBusy;
    $('reset').disabled = initializing || connectionBusy;
    $('search').disabled = busy || connectionBusy || !state.base64 || !extension;
    $('stopSearch').disabled = !busy || initializing;
    const unrecognized = state.raw.some(item => !FindReview.comparison(item) && item.imageSimilarityStatus !== 'delegated');
    $('compareAgain').disabled = busy || connectionBusy || !extension || !state.searched || !unrecognized || ($('sendToDesktop').checked && !desktopConnection.connected);
    document.querySelectorAll('#visionSettings input,#visionSettings select,#visionSettings button').forEach(el => { el.disabled = busy || connectionBusy; });
    $('checkConnection').disabled = initializing || busy || connectionBusy;
    document.querySelectorAll('[data-connection-platform]').forEach(button => { button.disabled = initializing || busy || connectionBusy || !extension; });
    $('downloadConnection').disabled = initializing || !extension;
    $('connectDesktop').disabled = initializing || connectionBusy || busy;
    $('desktopEndpoint').disabled = initializing || connectionBusy || busy;
    $('desktopToken').disabled = initializing || connectionBusy || busy;
    $('sendToDesktop').disabled = !desktopConnection.connected || busy || connectionBusy;
    $('reviewMode').disabled = busy || connectionBusy;
    document.querySelectorAll('[data-review-index]').forEach(button => { button.disabled = busy || connectionBusy; });
    let reviewable = [];
    try { const result = FindCore.evaluate(state.raw, state); reviewable = [...result.kept, ...result.excluded.filter(item => item.scoreExcluded)]; } catch { /* Invalid cost inputs have no reviewable results. */ }
    $('reviewNext').disabled = busy || connectionBusy || !reviewable.some(item => !FindReview.belowThreshold(item, state.raw) && FindReview.comparison(item) && !FindReview.decision(item));
    document.querySelectorAll('[name=mode],#goodsId,#baseline,#reduction,#platformChoices input').forEach(el => { el.disabled = busy || connectionBusy; });
    $('costFields').hidden = state.mode !== 'optimize';
    $('sourceImage').hidden = !state.base64; if (state.base64) $('sourceImage').src = state.base64; else $('sourceImage').removeAttribute('src');
    workspace?.render();
  }
  async function run(reviewOnly = false, fromBatch = false) {
    if (busy || connectionBusy || (workspace?.running() && !fromBatch)) return;
    if (reviewOnly && $('sendToDesktop').checked && !desktopConnection.connected) { status('failed', '请先连接桌面端，再确认识别。'); return; }
    if (!extension) { status('failed', '这是本地文件预览，请从浏览器中的扩展图标打开工作台。'); return; }
    Object.assign(state, inputs()); state.selected = selectedPlatforms(Array.from(document.querySelectorAll('#platformChoices input:checked'), el => el.value));
    if (!reviewOnly) state.selectionCustomized = true;
    try { FindCore.evaluate([], state); if (!state.base64) throw new Error('input：请先提供图片'); if (!reviewOnly && !state.selected.length) throw new Error('input：至少选择一个平台'); }
    catch (error) { status('input_invalid', error.message); renderResults(); return; }
    const token = ++generation, requestId = crypto.randomUUID();
    const sendToDesktop = desktopMode();
    const queryDataUrl = state.base64;
    const existingScored = reviewOnly ? state.raw.filter(item => item.imageSimilarityStatus === 'compared' && item.visualComparison).length : 0;
    busy = true; showAll = false;
    if (reviewOnly) {
      const grouped = {};
      for (const item of state.raw) (grouped[item.platform] ||= []).push(item);
      for (const [key, items] of Object.entries(grouped)) state.platforms[key] = { ...(state.platforms[key] || {}), key, items, phase: state.platforms[key]?.phase || 'complete', message: state.platforms[key]?.message || '使用已有结果，未重新搜图' };
    } else { state.raw = []; state.total = null; state.searched = false; state.platforms = {}; }
    controls(); renderResults(); renderPlatforms();
    const scoreKey = item => [item.platform, item.id, item.detailUrl, item.imageUrl, item.title].map(value => String(value || '')).join('|');
    const scoreResults = new Map();
    const scoreKeys = new Set();
    let scoreQueue = Promise.resolve(), localScored = 0, localFailed = 0, localError = '', localLimit = '', queuedCandidates = 0;
    const applyScoredResults = () => {
      state.raw = Object.values(state.platforms).flatMap(record => record.items || []).map(item => scoreResults.get(scoreKey(item)) || item);
      for (const record of Object.values(state.platforms)) {
        record.items = (record.items || []).map(item => scoreResults.get(scoreKey(item)) || item);
      }
    };
    const enqueueScore = items => {
      const fresh = FindCore.evaluate(items || [], state).kept.filter(item => {
        if (item.imageSimilarityStatus === 'compared' && item.visualComparison) return false;
        const key = scoreKey(item);
        if (scoreKeys.has(key)) return false;
        scoreKeys.add(key); return true;
      });
      if (!fresh.length) return;
      const remaining = Math.max(0, FindVision.maxCandidatesPerRun - queuedCandidates);
      const allowed = fresh.slice(0, remaining);
      const overflow = fresh.slice(remaining);
      queuedCandidates += fresh.length;
      if (overflow.length) {
        localLimit = `本次候选超过${FindVision.maxCandidatesPerRun}张，超出部分未执行模型比对`;
        const unavailable = FindVision.markUnavailable(overflow, `vision_input：本次候选超过${FindVision.maxCandidatesPerRun}张，请分次搜索或先筛选价格/平台`);
        unavailable.forEach(item => scoreResults.set(scoreKey(item), item));
        localFailed += unavailable.length;
        applyScoredResults(); renderResults(); void persist();
      }
      if (!allowed.length) return;
      scoreQueue = scoreQueue.then(async () => {
        if (token !== generation) return;
        try {
          const batch = await FindVision.scoreItems(queryDataUrl, allowed, {
            isCancelled: () => token !== generation,
            blockedReason: localError,
            onProgress: progress => {
              if (token !== generation) return;
              status('image_match', `大模型正在逐张比较细节：已比对 ${localScored + (progress.scored || 0)} 张，未完成 ${localFailed + (progress.failed || 0)} 张；本批原图 + ${progress.batch || FindVision.batchSize} 张候选图`);
            },
            onBatch: items => {
              if (token !== generation) return;
              items.forEach(item => scoreResults.set(scoreKey(item), item));
              applyScoredResults(); renderResults(); void persist();
            }
          });
          if (token !== generation) return;
          batch.items.forEach(item => scoreResults.set(scoreKey(item), item));
          localScored += batch.scored; localFailed += batch.failed;
          if (batch.error) localError = batch.error;
          applyScoredResults(); renderResults();
        } catch (error) {
          // Retain the failed batch; the next run retries only unfinished items.
          localError = String(error.message || error).slice(0, 160);
        }
      });
    };
    try {
      status('preparing', reviewOnly ? '正在准备比对已确认的候选，不重复搜图…' : '正在准备平台搜图…'); await persist();
      if (token !== generation) return;
      let result;
      if (reviewOnly) {
        if (!sendToDesktop) enqueueScore(state.raw);
        result = { items: state.raw, records: Object.values(state.platforms) };
      } else result = await FindTransport.searchAll(queryDataUrl, requestId, state.selected, (key, record) => {
        if (token !== generation) return;
        const qccBlock = key === 'qcc' && record.phase === 'failed' && ['quota','verification'].includes(record.diagnostics?.failureKind);
        const e3Block = key === 'e3hui' && record.phase === 'failed' && record.diagnostics?.failureKind === 'permission';
        if (qccBlock || e3Block) {
          // These platform-side gates cannot be fixed by an immediate retry.
          // Pause repeated image uploads until the user restores eligibility.
          const checkbox = document.querySelector(`#platformChoices input[value="${key}"]`);
          if (checkbox) checkbox.checked = false;
          state.selected = state.selected.filter(platform => platform !== key);
          state.selectionCustomized = true;
          const recovery = key === 'qcc'
            ? (record.diagnostics.failureKind === 'quota' ? '额度恢复' : '账号认证完成')
            : '搜图权限开通';
          record.message = `${record.message}；已暂停后续${FindTransport.platforms[key].name}请求，${recovery}后可重新勾选`;
        }
        state.platforms[key] = record; renderPlatforms();
        applyScoredResults();
        status('platform_search', `${FindTransport.platforms[key].name}：${record.message}；各平台独立搜图，识别需你确认开始。`); renderResults();
        if (reviewOnly && !sendToDesktop) enqueueScore(record.items);
      });
      if (token !== generation) return;
      if (!reviewOnly) {
        // Keep a final platform record even when a late callback was missed.
        // This makes login, permission, and redirect failures diagnosable
        // after the user continues with the candidates that did arrive.
        for (const record of result.records || []) {
          if (record?.key && !state.platforms[record.key]) state.platforms[record.key] = record;
        }
      }
      if (sendToDesktop && reviewOnly) {
        const allItems = reviewOnly ? state.raw : Object.values(state.platforms).flatMap(record => record.items || []);
        const filtered = FindCore.evaluate(allItems, state).kept;
        const pending = reviewOnly ? filtered.filter(item => !(item.imageSimilarityStatus === 'compared' && item.visualComparison) && item.imageSimilarityStatus !== 'delegated') : filtered;
        const sendItems = pending.slice(0, FindVision.maxCandidatesPerRun);
        const overflow = pending.slice(FindVision.maxCandidatesPerRun);
        if (overflow.length) {
          const unavailable = new Map(FindVision.markUnavailable(overflow, `desktop_limit：本次 Electron 队列最多 ${FindVision.maxCandidatesPerRun} 张；超出部分未发送` ).map(item => [scoreKey(item), item]));
          state.raw = allItems.map(item => unavailable.get(scoreKey(item)) || item);
          for (const record of Object.values(state.platforms)) record.items = (record.items || []).map(item => unavailable.get(scoreKey(item)) || item);
        } else state.raw = allItems;
        state.searched = true;
        if (!sendItems.length) {
          status(reviewOnly ? 'complete' : 'partial', reviewOnly ? '没有未完成的合格候选；Electron 未创建重复任务。' : '平台搜索结束，但没有可交给 Electron 的合格候选；请查看平台状态和淘汰明细。');
          renderResults(); await persist(); return;
        }
        try {
          const job = await submitDesktopJob(queryDataUrl, sendItems);
          const delegatedKeys = new Set(sendItems.map(scoreKey));
          const markDelegated = item => delegatedKeys.has(scoreKey(item)) ? { ...item, imageSimilarityStatus: 'delegated', imageSimilarityError: `已移交 Electron 本地任务 ${job.id}；请在桌面端查看进度和结果` } : item;
          state.raw = state.raw.map(markDelegated);
          for (const record of Object.values(state.platforms)) record.items = (record.items || []).map(markDelegated);
          const limitText = overflow.length ? `；另有 ${overflow.length} 张超过本地队列上限，未发送` : '';
          status(overflow.length ? 'partial' : 'desktop_queue', `已将 ${sendItems.length} 张候选交给 Electron 本地队列（任务 ${job.id}）；比对进度和结果请在桌面端查看${limitText}。`);
        } catch (error) {
          status('partial', `平台结果已保留，但没有交给 Electron：${String(error.message || error).slice(0, 180)}。确认桌面端已启动、已配置模型后可重试未完成商品。`);
        }
        renderResults(); await persist(); return;
      }
      await scoreQueue;
      if (token !== generation) return;
      // No implicit retry of a paid model call and no pixel-score fallback.
      applyScoredResults();
      state.searched = true;
      const passed = result.records.filter(x => x.phase === 'complete');
      const usable = result.records.filter(x => x.phase === 'complete' || x.phase === 'partial');
      const manualCount = result.records.filter(x => x.phase === 'manual_required').length;
      const partialCount = result.records.filter(x => x.phase === 'partial').length;
      const failedCount = result.records.length - usable.length - manualCount;
      state.total = passed.length === 1 ? passed[0].total : null;
      const imageMessage = !reviewOnly
        ? '模型尚未调用；请检查候选后点击“确认候选并开始识别”'
        : localFailed || localError
        ? `大模型已比对 ${localScored} 张，${localFailed} 张未完成识别${localError || localLimit ? '：' + (localError || localLimit) : ''}；可继续比对未完成商品`
        : reviewOnly && !localScored
          ? `已有 ${existingScored} 张完成识别，本次没有重复请求模型`
          : `大模型细节比对完成（${localScored} 张）；查看每张商品的结论与细节依据`;
      const overallPhase = usable.length === 0 ? (manualCount ? 'partial' : 'failed') : partialCount || failedCount || manualCount || localFailed || localError ? 'partial' : 'complete';
      const coverage = result.records.map(record => `${FindTransport.platforms[record.key]?.name || record.key} 收到 ${Array.isArray(record.items) ? record.items.length : 0} 条候选`).join('；');
      status(!reviewOnly ? (usable.length ? 'search_ready' : overallPhase) : overallPhase, usable.length === 0
        ? manualCount ? `没有自动平台结果；${manualCount} 个辅助平台需要手动搜图。${imageMessage}。` : `所有平台请求失败：${result.records.map(x => `${FindTransport.platforms[x.key].name} ${x.message}`).join('；')}`
        : partialCount || failedCount
          ? `${usable.length} 个平台收到结果${partialCount ? `，${partialCount} 个仅完成部分检索` : ''}${failedCount ? `，${failedCount} 个失败` : ''}${manualCount ? `，${manualCount} 个辅助平台需手动搜图` : ''}；${coverage}。${imageMessage}。`
          : `${reviewOnly ? '已确认候选的识别完成，本次未重复搜图' : `${passed.length}/${result.records.length} 个平台搜索完成；${coverage}`}。${imageMessage}。`); renderResults(); await persist();
    } catch (error) {
      if (token !== generation) return;
      if (String(error?.message || error).startsWith('search_timeout')) finalizeIncompleteSearch('超过75秒，已停止等待未完成平台');
      else { state.raw = []; state.searched = true; status('failed', error.message); renderResults(); }
      await persist();
    } finally { if (token === generation) { busy = false; controls(); } }
  }
  function finalizeIncompleteSearch(reason) {
    for (const key of state.selected) if (!state.platforms[key] || !['complete','partial','failed','manual_required'].includes(state.platforms[key].phase)) state.platforms[key] = { phase:'failed', message:reason, items:[], total:null };
    state.raw = Object.values(state.platforms).flatMap(record => Array.isArray(record.items) ? record.items : []);
    state.total = null; state.searched = true;
    const kept = state.raw.length > 0;
    status(kept ? 'partial' : 'failed', kept ? `搜索已停止等待，保留 ${state.raw.length} 条已返回商品；未完成平台已标记失败。${reason}` : `搜索已停止，未取得平台结果。${reason}`);
    renderPlatforms(); renderResults();
  }
  function showQuery() {
    $('reviewMode').value = state.reviewMode;
    $('reviewFilter').value = 'all'; showAll = false;
    document.querySelectorAll('#platformChoices input').forEach(el => { el.checked = state.selected.includes(el.value); });
    $('goodsId').value = state.goodsId; $('baseline').value = state.baseline; $('reduction').value = state.reduction;
    document.querySelector('[name=mode][value=' + state.mode + ']').checked = true;
    status(state.phase, state.message || '图片已导入，请点击搜索。');
    renderResults(); renderPlatforms(); controls();
  }
  async function stopCurrent() {
    workspace?.cancel();
    if (!busy || initializing) { controls(); return; }
    ++generation; FindTransport.cancel(); FindVision.cancel(); busy = false;
    if (state.phase === 'image_match') { status('partial', '识别已暂停；已完成结果保留，可继续未完成候选。'); renderResults(); }
    else finalizeIncompleteSearch('已由用户停止等待');
    controls(); await persist();
  }
  workspace = FindQueryWorkspace.create({
    get: () => state, set: value => { state = normalizeState(value); }, empty: initialState, inputs,
    busy: () => busy || connectionBusy, initializing: () => initializing, setBusy: value => { busy = value; },
    generation: () => generation, bump: () => ++generation, save, status,
    refresh: controls, show: showQuery, run, stop: () => void stopCurrent(),
    canCompare: () => !$('sendToDesktop').checked || desktopConnection.connected
  });
  if (extension) chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if(message?.type==='PRODUCT_COMPARISON_BUYER_SEARCH'){
      if(sender.id!==chrome.runtime.id||!message.command||!imageData(message.command.imageData)){sendResponse({ok:false,error:'自动买手图搜请求无效'});return false;}
      if(initializing||busy||workspace.running()){sendResponse({ok:false,error:'浏览器工作台正忙，请稍后继续'});return false;}
      busy=true;controls();
      void FindTransport.searchAll(message.command.imageData,message.command.id,['wsy','zwd','qcc','e3hui'],()=>{}).then(result=>sendResponse({ok:true,result}),error=>sendResponse({ok:false,error:String(error.message||error).slice(0,180)})).finally(()=>{busy=false;controls();});
      return true;
    }
    if (message?.type !== 'PRODUCT_COMPARISON_DESKTOP_SEARCH') return false;
    if (sender.id !== chrome.runtime.id || !message.command || !/^[a-f0-9-]{36}$/i.test(message.command.id || '')) {
      sendResponse({ ok: false, error: '桌面搜图命令来源无效' }); return false;
    }
    if (initializing || busy || workspace.running()) { sendResponse({ ok: false, error: '浏览器工作台正忙，请稍后自动重试' }); return false; }
    void (async () => {
      const selected = Object.keys(FindTransport.platforms);
      const added = await workspace.addDataUrl(message.command.imageData, (message.command.queryName || '商品') + '-主图.jpg', selected);
      if (!added?.queryId) throw new Error('商品主图没有导入工作台');
      sendResponse({ ok: true, queryId: added.queryId, imported: added.imported });
      setTimeout(() => void workspace.searchById(added.queryId).catch(error => {
        $('queryNotice').hidden = false; $('queryNotice').textContent = '四平台搜图未启动：' + String(error.message || error).slice(0, 180);
      }), 0);
    })().catch(error => sendResponse({ ok: false, error: String(error.message || error).slice(0, 180) }));
    return true;
  });
  const importImages = (files, autoSearch) => void workspace.add(Array.from(files), autoSearch).catch(error => { $('queryNotice').hidden = false; $('queryNotice').textContent = error.message; });
  $('pick').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', () => { const files = Array.from($('file').files); $('file').value = ''; importImages(files, true); });
  document.addEventListener('paste', event => { const files = Array.from(event.clipboardData?.items || []).filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean); if (files.length) { event.preventDefault(); importImages(files, files.length === 1); } });
  $('dropZone').addEventListener('dragover', event => event.preventDefault());
  $('dropZone').addEventListener('drop', event => { event.preventDefault(); const files = Array.from(event.dataTransfer?.files || []); importImages(files, files.length === 1); });
  $('search').addEventListener('click', () => void run());
  $('compareAgain').addEventListener('click', () => void run(true));
  $('stopSearch').addEventListener('click', () => void stopCurrent());
  $('reset').addEventListener('click', async () => {
    workspace?.cancel();
    const token = ++generation; FindTransport.cancel(); FindVision.cancel(); busy = true;
    const selectedPlatformsBeforeReset = [...state.selected], selectionCustomizedBeforeReset = state.selectionCustomized;
    try { await workspace.forgetActive(); }
    catch (error) { status('failed', '重置未完成：' + error.message); busy = false; controls(); return; }
    state.base64 = ''; state.raw = []; state.total = null; state.searched = false; state.platforms = {}; state.selected = selectedPlatformsBeforeReset; state.selectionCustomized = selectionCustomizedBeforeReset; showAll = false; renderPlatforms();
    status('idle', '已重置图片和结果，请提供新图片。'); renderResults(); controls(); await persist();
    if (token === generation) { busy = false; controls(); }
  });
  $('showAll').addEventListener('click', () => { showAll = true; renderResults(); });
  function openReview(index) {
    if (busy || connectionBusy) return;
    const item = state.raw[index], token = generation;
    if (!item) return;
    FindReviewUI.open({ item, query: state.base64, onSave: async input => {
      if (busy || token !== generation || state.raw[index] !== item) throw new Error('商品结果已变化，请重新打开审核');
      const updated = input ? FindReview.apply(item, input) : { ...item };
      if (!input) delete updated.humanReview;
        const platformItems = Object.values(state.platforms).map(record => [record, record.items]);
      state.raw[index] = updated;
        for (const [record, items] of platformItems) record.items = (items || []).map(raw => reviewKey(raw) === reviewKey(item) ? updated : raw);
      renderResults();
      // Keep the draft on a storage failure, but keep the dialog open so a
      // failed save cannot be mistaken for a durable human confirmation.
      try { await save(); $('storageNotice').hidden = true; }
        catch (error) { state.raw[index] = item; for (const [record, items] of platformItems) record.items = items; renderResults(); throw new Error(`审核未保存：${error.message}`); }
    } });
  }
  $('results').addEventListener('click', event => { const button = event.target.closest('[data-review-index]'); if (button) openReview(Number(button.dataset.reviewIndex)); });
  $('excludedRows').addEventListener('click', event => { const button = event.target.closest('[data-review-index]'); if (button) openReview(Number(button.dataset.reviewIndex)); });
  $('reviewNext').addEventListener('click', () => {
    const result = FindCore.evaluate(state.raw, state);
    const item = result.kept.sort((a,b) => FindReview.compare(a,b,state.reviewMode)).find(item => FindReview.comparison(item) && !FindReview.decision(item));
    if (item) openReview(reviewIndex(item));
  });
  $('reviewFilter').addEventListener('change', () => { showAll = false; renderResults(); });
  $('reviewMode').addEventListener('change', () => { state.reviewMode = FindReview.mode($('reviewMode').value); renderResults(); void persist(); });
  document.querySelectorAll('[name=mode],#goodsId,#baseline,#reduction').forEach(el => el.addEventListener('change', () => {
    Object.assign(state, inputs()); controls(); renderResults(); void persist();
  }));
  document.querySelectorAll('#platformChoices input').forEach(el => el.addEventListener('change', () => {
      state.selected = selectedPlatforms(Array.from(document.querySelectorAll('#platformChoices input:checked'), input => input.value));
      state.selectionCustomized = true;
    renderPlatforms(); void persist();
  }));
  async function init() {
    if (!extension) { initializing = false; busy = false; controls(); status('failed', '本地预览无法搜索，请加载 v4-core 扩展并从扩展图标打开工作台。'); return; }
    try {
      const saved = (await chrome.storage.local.get(key))[key];
      if (saved) state = normalizeState(saved);
      await workspace.restore();
      if (saved || state.queryId) {
        $('reviewMode').value = state.reviewMode;
        document.querySelectorAll('#platformChoices input').forEach(el => { el.checked = state.selected.includes(el.value); });
        $('goodsId').value = state.goodsId; $('baseline').value = state.baseline; $('reduction').value = state.reduction;
        const mode = ['select', 'optimize'].includes(state.mode) ? state.mode : 'select'; document.querySelector(`[name=mode][value=${mode}]`).checked = true;
        if (['preparing', 'platform_connect', 'platform_search', 'image_decode', 'image_match'].includes(state.phase)) { state.searched = !!state.raw.length; status(state.raw.length ? 'partial' : 'idle', state.raw.length ? '上次搜索或比对中断，已保留返回商品；可继续比对未完成项，不会自动重复提交。' : '上次搜索中断，请点击重新搜索。不会自动重复提交。'); }
        else status(state.phase, state.message || '已恢复上次输入和结果。');
      }
    } catch (error) { status('failed', `storage_read：${error.message}`); }
    await refreshVisionConfig();
    await restoreDesktopConnection();
    if (extension) setInterval(() => {
      if (desktopConnection.connected) void chrome.runtime.sendMessage({ type: 'PROCESS_DESKTOP_BROWSER_WORKFLOW' }).catch(() => {});
    }, 5000);
    initializing = false; busy = false; controls(); renderResults(); renderPlatforms();
  }
  async function refreshVisionConfig() {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'VISION_STATUS' });
      $('visionStatus').textContent = result?.configured ? `已配置 ${result.model}（当前会话）` : '未配置，当前不会执行识别';
      if (result?.ok) $('visionModel').value = result.model;
      $('visionSettings').open = !result?.configured;
    } catch { $('visionStatus').textContent = '模型后台不可用，请重新加载扩展'; }
  }
  $('saveVision').addEventListener('click', async () => {
    if (busy || connectionBusy) return;
    const apiKey = $('visionKey').value.trim(); $('visionKey').value = '';
    busy = true; controls();
    try {
      const result = await chrome.runtime.sendMessage({ type: 'VISION_CONFIGURE', config: { apiKey, model: $('visionModel').value, provider: 'dashscope' } });
      if (!result?.ok) throw new Error(result?.error || '模型设置失败');
      await refreshVisionConfig();
      $('visionStatus').textContent += '；已保存，发起比对时验证连接';
    } catch (error) { $('visionStatus').textContent = error.message; }
    finally { busy = false; controls(); }
  });
  $('forgetVision').addEventListener('click', async () => {
    if (busy || connectionBusy) return;
    busy = true; controls(); $('visionKey').value = '';
    try { await chrome.runtime.sendMessage({ type: 'VISION_FORGET' }); await refreshVisionConfig(); }
    finally { busy = false; controls(); }
  });
  renderConnectionReport();
  controls();
  void init();
})();
