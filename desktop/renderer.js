const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let snapshot, refreshing = false, rendered = '', catalogRendered = '', platformAccountsRendered = '', previousUser = '';
const errorText = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const comparisonError = message => String(message || '').includes('HTTP 504') ? 'HTTP 504：模型网关等待上游超时，本批未取得结果；可逐张重试' : String(message || '');
const notify = text => { $('notice').textContent = text; $('notice').hidden = !text; };
function showPage(value) {
  if(value==='drafts'&&$('navDrafts').hidden)value='buyer';
  const page = ['work','settings','updates', 'help', 'douyin', 'buyer','drafts'].includes(value) ? value : value ? 'settings' : 'work';
  sessionStorage.setItem('product-comparison-view',page);
  for (const [key, label] of [['work', '识别记录'], ['buyer', '买手工作台'], ['drafts','互拓草稿箱'], ['douyin', '抖音主图'], ['settings', '设置'], ['updates', '软件更新'], ['help', '使用说明']]) {
    $(key + 'Page').hidden = page !== key;
    const nav = $('nav' + key[0].toUpperCase() + key.slice(1));
    nav.classList.toggle('active', page === key);
    nav.setAttribute('aria-current', page === key ? 'page' : 'false');
    if (page === key) $('pageCrumb').textContent = `工作空间 / ${label}`;
  }
  window.scrollTo(0, 0);
}
window.openBuyerComparisonJob = async (jobId, itemIndex = null) => {
  if (!/^[\da-f-]{36}$/i.test(String(jobId || ''))) throw new Error('没有可打开的供应商比对记录');
  await refresh();
  showPage('work');
  for (let attempt = 0; attempt < 30; attempt++) {
    await refresh();
    const article = [...document.querySelectorAll('#jobs article[data-job]')].find(node => node.dataset.job === jobId);
    if (article) {
      const job = snapshot?.jobs.find(row => row.id === jobId);
      const ranked = (job?.items || []).map((item,index)=>({item,index})).filter(({item})=>FindReview.comparison(item))
        .sort((a,b)=>FindReview.compare(a.item,b.item)||a.index-b.index);
      const targetIndex = Number.isInteger(itemIndex) && job?.items[itemIndex] ? itemIndex : ranked[0]?.index;
      filters.set(jobId,'all'); platforms.set(jobId,'all'); if(job)limits.set(jobId,job.items.length); rendered='';
      await refresh();
      const current=[...document.querySelectorAll('#jobs article[data-job]')].find(node=>node.dataset.job===jobId);
      if(!current)continue;
      const details=current.querySelector('.job-results');if(details)details.open=true;
      const target=Number.isInteger(targetIndex)?current.querySelector(`.result-row[data-index="${targetIndex}"]`):null;
      const focus=target||current;focus.scrollIntoView({behavior:'smooth',block:target?'center':'start'});focus.classList.add('buyer-job-focus');
      setTimeout(()=>focus.classList.remove('buyer-job-focus'),2200);return true;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('本地比对记录暂不可用；请刷新识别与复核页面后重试');
};
const filters = new Map(), platforms = new Map(), limits = new Map(), expanded = new Set(), retryingJobs = new Set();
const platformNames = Object.freeze({ wsy: '网商园', zwd: '17 网', qcc: '青创网', e3hui: '衣衫汇', taobao: '淘宝' });
const platformName = key => platformNames[key] || '未知平台';
const platformPhases = Object.freeze({ complete: '搜索完成', partial: '部分完成', failed: '搜索失败', manual_required: '需登录/手动搜索', not_selected: '未选择，未发起搜索', not_started: '已选择，等待搜索' });
function platformSearchRows(job) {
  const candidates = new Map();
  for (const item of job.items || []) candidates.set(item.platform, (candidates.get(item.platform) || 0) + 1);
  const recorded = new Map((Array.isArray(job.platformSearches) ? job.platformSearches : []).map(row => [row.platform, row]));
  const keys = candidates.size===1&&candidates.has('taobao')?['taobao']:['wsy', 'zwd', 'qcc', 'e3hui', ...(candidates.has('taobao') ? ['taobao'] : [])];
  return keys.map(platform => {
    const row = recorded.get(platform);
    const received = row ? row.receivedCount : candidates.get(platform) || 0;
    return { platform, phase: row?.phase || 'unknown', received: row ? received : null, submitted: candidates.get(platform) || 0, accepted: row?.acceptedCount ?? null,
      reported: row?.reportedTotal ?? null, groups: row?.searchGroups || [], selected: row?.selected === true, message: row?.message || '',
      legacy: !row && !(Array.isArray(job.platformSearches) && job.platformSearches.length) };
  });
}
const taskTime = value => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '时间未记录';
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
};
const collectingDetails = jobId => (snapshot?.browserCommands || []).some(command => command.kind === 'product-details' && command.jobId === jobId && ['queued','claimed'].includes(command.status));
const canDeleteJob = job => !['queued', 'processing'].includes(job.status) && !retryingJobs.has(job.id) && !collectingDetails(job.id);
let deletingJobs = [], deletingUser = '', deletingJobsBusy = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
  snapshot = await window.desktop.snapshot();
  $('appVersion').textContent = `本地桌面端 · ${snapshot.version || '版本未知'}`;
  $('loginScreen').hidden = snapshot.authenticated;
  $('appShell').hidden = !snapshot.authenticated;
  FindUpdatesUI.render(snapshot);
  FindHelpUI.render(snapshot);
  FindDouyinUI.render(snapshot);
  BuyerAutoUI.render(snapshot);
  window.BuyerDraftUI?.render(snapshot);
  if (!snapshot.authenticated) {
    if(previousUser)sessionStorage.removeItem('product-comparison-view');
    BuyerUI.render(snapshot);
    if (previousUser) { document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); filters.clear(); platforms.clear(); limits.clear(); expanded.clear(); $('jobs').innerHTML = ''; $('modelList').innerHTML = ''; $('platformAccountList').innerHTML = ''; $('buyerTaskList').innerHTML = ''; $('buyerTaskCount').textContent = '0 条'; $('endpoint').value = ''; $('token').value = ''; $('modelForm').reset(); $('apiKey').value = ''; $('platformAccountForm').reset(); $('platformAccountPassword').value = ''; }
    previousUser = ''; rendered = ''; catalogRendered = ''; platformAccountsRendered = '';
    if (snapshot.error) $('loginMessage').textContent = snapshot.error;
    return;
  }
  if (previousUser !== snapshot.user.id) { rendered = ''; catalogRendered = ''; platformAccountsRendered = ''; notify(''); showPage('buyer'); }
  previousUser = snapshot.user.id;
  $('accountName').textContent = snapshot.user.displayName;
  $('accountDetail').textContent = `${snapshot.user.displayName} · ${snapshot.user.username}`;
  $('serviceState').textContent = `本机服务运行中 · ${snapshot.port}`;
  $('endpoint').value = `http://127.0.0.1:${snapshot.port}`;
  $('token').value = snapshot.token;
  $('modelState').textContent = snapshot.vision.configured ? `当前使用：${snapshot.vision.name} · ${snapshot.vision.model}` : '尚未配置模型，请添加后使用。';
  $('taskCount').textContent = snapshot.jobs.length;
  const busy = snapshot.jobs.some(job => ['queued', 'processing'].includes(job.status));
  $('runningCount').textContent = snapshot.jobs.filter(job => ['queued', 'processing'].includes(job.status)).length;
  $('pendingCount').textContent = snapshot.jobs.reduce((sum, job) => sum + (job.reviewSummary?.pending || 0), 0);
  $('clearJobs').disabled = !snapshot.jobs.some(canDeleteJob) || deletingJobsBusy;
  $('clearJobs').textContent = busy ? '清空已结束记录' : '清空记录';
  $('activeModel').disabled = busy || !snapshot.catalog.models.length;
  $('activeModelHint').textContent = busy ? '当前任务使用的模型已锁定，处理完成后可切换。' : snapshot.vision.configured ? '新任务将使用此模型。历史任务与人工结论会保留。' : '先到设置添加支持图片输入的模型。';
  const catalogNext = JSON.stringify(snapshot.catalog);
  if (catalogNext !== catalogRendered) {
    catalogRendered = catalogNext;
    $('activeModel').innerHTML = snapshot.catalog.models.length ? snapshot.catalog.models.map(model => `<option value="${esc(model.id)}" ${model.id === snapshot.catalog.activeId ? 'selected' : ''}>${esc(model.name)} · ${esc(model.model)}</option>`).join('') : '<option value="">尚未添加模型</option>';
    $('modelList').innerHTML = snapshot.catalog.models.map(model => `<article class="model-card ${model.id === snapshot.catalog.activeId ? 'selected' : ''}" data-model="${esc(model.id)}"><div class="model-info"><strong>${esc(model.name)}</strong>${model.id === snapshot.catalog.activeId ? '<span class="model-tag">当前使用</span>' : ''}${model.managed ? '<span class="model-tag">后台托管 · 中等推理</span>' : ''}<p>${esc(model.model)}</p>${model.managed ? '<p>后台统一接入 · 密钥不会发送到客户端</p>' : `<p>${esc(model.endpoint)}</p>`}<small class="muted">${model.managed ? '由服务端安全代理' : `${model.hasKey ? 'API Key 已加密保存' : '无需 API Key'} · ${model.jsonMode ? 'JSON 模式' : '兼容模式'} · 并发 ${model.concurrency || 3} 批`}</small></div><div class="model-actions">${model.managed ? '' : `<button class="use-model secondary" ${model.id === snapshot.catalog.activeId ? 'disabled' : ''}>使用</button><button class="test-model secondary">测试连接</button><button class="edit-model secondary">编辑</button><button class="delete-model text-button">删除</button>`}</div></article>`).join('') || '<div class="empty"><h3>添加你的第一个视觉模型</h3><p>填写服务地址与模型 ID，可使用百炼、OpenAI 或其他兼容服务。</p></div>';
  }
  const platformAccountsNext = JSON.stringify(snapshot.platformAccounts || []);
  if (platformAccountsNext !== platformAccountsRendered) {
    platformAccountsRendered = platformAccountsNext;
    $('platformAccountList').innerHTML = (snapshot.platformAccounts || []).map(account => `<article class="platform-account-card ${account.configured ? 'configured' : ''}" data-platform-account="${esc(account.platform)}"><div><strong>${esc(account.name)}</strong><small>${account.configured ? `账号：${esc(maskAccount(account.username))}` : '尚未设置账号'}</small></div><span class="platform-account-status">${account.configured ? '密码已加密保存 · 更新后保留' : '未配置'}</span><div class="platform-account-actions"><button type="button" class="edit-platform-account secondary">${account.configured ? '修改' : '添加'}</button><button type="button" class="delete-platform-account text-button" ${account.configured ? '' : 'disabled'}>删除</button></div></article>`).join('');
  }
  BuyerUI.render(snapshot);
  const next = JSON.stringify(snapshot.jobs) + JSON.stringify(snapshot.browserCommands || []) + JSON.stringify([...filters]) + JSON.stringify([...platforms]) + JSON.stringify([...limits]) + JSON.stringify([...retryingJobs]);
  if (next === rendered) return;
  rendered = next;

  $('jobs').innerHTML = snapshot.jobs.length ? [...snapshot.jobs].reverse().map(job => {
    const compared = job.items.filter(item => FindReview.comparison(item)).length;
    const failed = job.items.filter(item => !FindReview.comparison(item) && item.imageSimilarityStatus === 'unavailable').length;
    const notStarted = job.total - compared - failed;
    const pct = Math.floor(compared * 100 / job.total);
    const legacy = job.items.some(item => item.visualComparison && !item.imageEvidence);
    const locked = ['queued', 'processing'].includes(job.status) || retryingJobs.has(job.id);
    const detailsBusy = collectingDetails(job.id);
    const status = ({ queued: '排队中', processing: '模型比对中', complete: '模型比对完成', partial: '比对已暂停', failed: '失败' })[job.status] || job.status;
    const filter = filters.get(job.id) || 'recommended', platform = platforms.get(job.id) || 'all', limit = limits.get(job.id) || 8;
    const scoreThreshold = FindReview.exclusionThreshold(job.items);
    const filtered = job.items.map((item, index) => ({ item, index })).filter(({ item }) => (platform === 'all' || item.platform === platform)
      && FindReview.matchesFilter(item, filter, job.reviewMode, scoreThreshold))
      .sort((a, b) => FindReview.compare(a.item, b.item, job.reviewMode) || a.index - b.index);
    const rows = filtered.slice(0, limit).map(({ item, index }) => {
      const human = FindReview.decision(item);
      const stage = item.searchGroup === 'accurate' ? '准确搜' : item.searchGroup === 'similar' ? '相似搜' : item.platform === 'taobao' ? '淘宝套图' : '图片搜款';
      return `<div class="result-row" data-index="${index}"><button class="view-image text-button" data-index="${index}" aria-label="放大商品图片"><img src="${esc(item.imageEvidence?.sourceUrl || item.imageUrl)}" alt="商品图片" loading="lazy" referrerpolicy="no-referrer"><small>放大查看</small></button><div><strong>${esc(item.platform==='taobao'?(item.title||'淘宝商品'):(item.goodsId || item.title || '未命名商品'))}</strong><span class="result-tags"><span class="source-tag">${esc(platformName(item.platform))}</span><span class="source-tag search-source">${stage}</span></span><span>${esc(item.title || '')} · ${item.price == null ? '价格未知' : `¥${esc(item.price)}`}</span>${item.platform==='taobao'?`<span>销量：${esc(TaobaoSales.label(item))}</span>`:''}<span class="review-state ${human ? 'reviewed' : ''}">${esc(FindReview.status(item, job.reviewMode))}</span>${item.visualComparison ? `<span>模型建议：${esc(FindReview.labels[item.visualComparison.verdict] || "无法判断")}</span>` : ""}${item.visualComparison ? `<span class="match-score">${esc(FindReview.scoreStatus(item, job.reviewMode))}${FindReview.belowThreshold(item, job.items) ? ` · ${FindReview.thresholdText(scoreThreshold)}，已排除` : ''}</span>` : ''}<span>${item.imageEvidence ? `来源 ${esc(item.imageEvidence.sourceWidth)}×${esc(item.imageEvidence.sourceHeight)} · 送模 ${esc(item.imageEvidence.width)}×${esc(item.imageEvidence.height)}` : item.visualComparison ? '旧任务：未记录送模图片，建议用高清图重比' : ''}</span>${item.platformTags?.length ? '<span>'+esc(item.platformTags.join(' · '))+'</span>' : ''}${human?.note ? `<span>审核备注：${esc(human.note)}</span>` : ''}${item.visualComparison ? `<span>吻合：${esc((item.visualComparison.matches || []).join('；') || '无')}<br>差异：${esc((item.visualComparison.differences || []).join('；') || '无')}<br>待核实：${esc((item.visualComparison.uncertainties || []).join('；') || '无')}</span><button class="review-item secondary" data-index="${index}" ${locked ? 'disabled' : ''}>${human ? '查看 / 修改审核' : '人工核对'}</button>` : `<span>${esc(comparisonError(item.imageSimilarityError))}</span>`}</div></div>`;
    }).join('');
    const counts = job.reviewSummary || FindReview.summary(job.items, job.reviewMode);
    const priceGroups=FindReview.highSimilarityPriceGroups(job.items.filter(item=>item.platform!=='taobao'));
    const taobaoItems=job.items.map((item,index)=>({item,index})).filter(({item})=>item.platform==='taobao').sort((a,b)=>FindReview.compareTaobao(a.item,b.item)||a.index-b.index);
    const taobaoComparison=taobaoItems.length?`<section class="price-comparison-summary taobao-comparison-summary"><h3>淘宝候选 · 85分及以上优先（${taobaoItems.length} 条）</h3><small>人工已确认的同款优先；模型建议为同款或相似款且匹配分达到85分的候选排在前面，同组按销量降序。明确不同款和人工排除项放在后面；销量和价格不作为同款依据。</small><div class="price-comparison-scroll"><table class="price-comparison-table taobao-comparison-table"><thead><tr><th>商品图片</th><th>店铺 / 商品</th><th>销量</th><th>价格</th><th>模型建议 / 人工确认</th></tr></thead><tbody>${taobaoItems.slice(0,limit).map(({item,index})=>`<tr data-taobao-index="${index}"><td><button type="button" class="view-image text-button" data-index="${index}"><img src="${esc(item.imageEvidence?.sourceUrl||item.imageUrl)}" alt="淘宝候选商品图" loading="lazy" referrerpolicy="no-referrer"><small>放大查看</small></button></td><td><strong>${esc(item.shopName||'店铺名未采集')}</strong><small>${esc(item.title||'')}</small></td><td class="taobao-sales">${esc(TaobaoSales.label(item))}</td><td>${item.price==null?'未采集':'¥'+esc(item.price)}</td><td><small>${esc(FindReview.status(item,job.reviewMode))}</small>${item.visualComparison?`<small>${esc(FindReview.labels[item.visualComparison.verdict])} · ${esc(FindReview.scoreText(FindReview.modelScore(item)))}</small><button type="button" class="secondary review-item" data-index="${index}" ${locked?'disabled':''}>看图人工确认</button>`:'<small>等待模型对比</small>'}<button type="button" class="secondary open-product-detail" data-index="${index}">打开淘宝商品链接</button></td></tr>`).join('')}</tbody></table></div>${taobaoItems.length>limit?'<button type="button" class="secondary show-more">再显示 8 条淘宝候选</button>':''}</section>`:'';
    const priceComparison=priceGroups.length?`<section class="price-comparison-summary"><h3>高相似候选价格参考（${priceGroups[0].items.length} 条）</h3><small>本批匹配分 ≥ 90 且模型建议为同款或相似款的候选，按候选列表价升序排列；货号可能不同。价格不是详情供货价，模型建议仍待人工核对，不代表已确认同款。</small><div class="price-comparison-scroll"><table class="price-comparison-table"><thead><tr><th>货号</th><th>平台 / 商品</th><th>候选列表价</th><th>模型建议 / 链接</th></tr></thead><tbody>${priceGroups.map(group=>group.items.map(row=>{const index=job.items.indexOf(row.item);return`<tr><td>${esc(row.item.goodsId||'货号未采集')}</td><td><strong>${esc(platformName(row.item.platform))}</strong><small>${esc(row.item.shopName||'店铺名待采集')}</small><small>${esc(row.item.title||'')}</small></td><td><strong>¥${esc(row.price)}</strong></td><td><small>${esc(FindReview.labels[row.item.visualComparison?.verdict]||'无法判断')} · ${esc(row.score)}/100 · ${esc(FindReview.status(row.item,job.reviewMode))}</small><button type="button" class="secondary open-product-detail" data-index="${index}">打开${esc(platformName(row.item.platform))}商品链接</button></td></tr>`;}).join('')).join('')}</tbody></table></div></section>`:'';
    const platformRows = platformSearchRows(job);
    const platformSummary = platformRows.map(row => {
      const groups = row.groups.length ? ` · ${row.groups.map(group => `${group.type === 'accurate' ? '准确' : '相似'}搜${group.phase==='failed'?'失败':`报告 ${group.reportedTotal == null ? '未知' : group.reportedTotal} / 返回 ${group.receivedCount}`}`).join('，')}` : '';
      const reported = row.reported == null ? '报告总数未知' : `${row.platform==='zwd'&&row.groups.length>1?'两组报告合计':'报告总数'} ${row.reported}${row.platform==='zwd'&&row.groups.length>1?'（可能重复）':''}`;
      return `<div class="platform-search-row"><strong>${esc(platformName(row.platform))}</strong><span class="platform-search-phase ${row.phase}">${esc(platformPhases[row.phase] || (row.legacy ? '历史任务未保存统计' : '未收到完成记录'))}</span><span>${row.received===null?'返回数量未保存':`本次收到 ${esc(row.received)} 条候选`}${row.accepted===null?'':` · 可用 ${esc(row.accepted)} 条`} · 本批候选 ${row.submitted} 条 · ${esc(reported)}${esc(groups)}${row.message&&['failed','partial','manual_required'].includes(row.phase)?`<small class="platform-search-reason">${esc(row.message)}</small>`:''}</span></div>`;
    }).join('');
    const stageName = counts.pending ? 'review' : failed + notStarted ? 'retry' : job.searchIssues?.length ? 'platform' : 'export';
    const isTaobao=taobaoItems.length===job.items.length;
    const followup = stageName === 'review' ? `<button class="review-next primary-action" ${locked ? 'disabled' : ''}>${isTaobao?'从推荐淘宝候选开始审核':'从最高相似开始审核'}</button><small>${isTaobao?'确认同款后，将作为套图来源继续互拓采集':'确认同款后，将进入供应商资料采集'}</small>`
      : stageName === 'retry' ? `<button class="retry-job primary-action" data-job="${esc(job.id)}" ${locked ? 'disabled' : ''}>${locked ? `自动重试中（${job.autoRetryCount || 0}/3）` : '重试未识别候选'}</button><small>每轮最多自动重试 3 次；连续失败后可手动开启新一轮</small>`
      : stageName === 'platform' ? `<button class="platform-problems primary-action" ${locked ? 'disabled' : ''}>查看登录问题</button><small>处理平台登录或验证后，可回到插件重新搜图</small>`
      : `<button class="export-job primary-action" data-job="${esc(job.id)}">导出结果</button><small>本批候选已处理完，可下载完整记录</small>`;
    const issueDetails = job.searchIssues?.length ? `<div class="platform-issue-list" hidden>${job.searchIssues.map(issue => `<p><strong>${esc(platformName(issue.platform))} · ${issue.phase === 'partial' ? '部分检索失败' : issue.phase === 'manual_required' ? '需要登录' : '平台异常'}</strong><span>${esc(issue.message)}</span></p>`).join('')}</div>` : '';
    return `<article class="job" data-job="${esc(job.id)}"><div class="job-title">${esc(job.queryName || job.goodsId || '未命名任务')} <span class="candidate-total">${esc(job.total)} 条候选</span>${job.searchIssues?.length ? '<span class="platform-issue-tag">有平台异常</span>' : ''}</div><div class="job-meta">${esc(status)}</div><div>已识别 ${compared}/${job.total}</div><progress max="100" value="${pct}"></progress><div class="job-dashboard"><div><span>待人工核对</span><strong>${counts.pending}</strong></div><div><span>需重试</span><strong>${failed + notStarted}</strong></div><div><span>已排除</span><strong>${counts.excluded}</strong></div><div><span>确认同款</span><strong>${counts.confirmed}</strong></div></div><div class="job-counts">抓取候选 ${esc(job.total)} 条 · 模型建议 ${compared} 条${job.autoRetryCount ? ` · 自动重试 ${job.autoRetryCount}/3` : ''}${job.manualRetryRounds ? ` · 手动续轮 ${job.manualRetryRounds} 次` : ''}</div><section class="platform-search-summary"><h3>${isTaobao?'淘宝搜索覆盖':'四个平台搜索覆盖'}</h3>${platformSummary}<small>“收到”是平台返回候选；“本批候选”是通过条件后进入本批的数量。平台报告总数可能更大；17网两组报告可能重复。历史统计未保存时标为未知。</small></section>${priceComparison}${taobaoComparison}<div class="job-followup">${followup}<button class="view-all-results secondary">查看全部候选</button></div>${issueDetails}${job.error ? `<div class="job-error">${esc(comparisonError(job.error))}</div>` : ''}
      <div class="job-times"><span>创建：<time>${esc(taskTime(job.createdAt))}</time></span><span>最近更新：<time>${esc(taskTime(job.updatedAt))}</time></span>${job.retryCount ? `<span>已重试 ${esc(job.retryCount)} 次 · 最近：<time>${esc(taskTime(job.lastRetryAt))}</time></span>` : ''}${job.retryOf ? '<span>重比记录</span>' : ''}</div>
      <div class="job-review"><label>结果口径<select class="review-mode" ${locked ? 'disabled' : ''}>${[['manual','人工确认模式'],['direct','模型建议模式（结论暂定）']].map(([value,label]) => `<option value="${value}" ${FindReview.mode(job.reviewMode) === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><p>${esc(FindReview.text(job.items, job.reviewMode))}</p><small>匹配分只用于排序参考，不代表同款概率；${FindReview.thresholdText(scoreThreshold)}自动排除。颜色、光线和拍摄背景不同通常不影响同款判断。</small><p class="review-message" role="status"></p></div>
      <details class="job-results" ${expanded.has(job.id) ? 'open' : ''}><summary>查看全部候选（${job.items.length}）</summary><div class="candidate-filters"><label>平台<select class="platform-filter">${[['all','全部平台'],['wsy','网商园'],['zwd','17 网'],['qcc','青创网'],['e3hui','衣衫汇'],['taobao','淘宝']].map(([value,label]) => `<option value="${value}" ${platform === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>状态<select class="review-filter">${[['recommended','推荐先看'],['pending','待人工'],['retry','需重试'],['excluded','已排除'],['all','全部候选']].map(([value,label]) => `<option value="${value}" ${filter === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><span class="filter-result-count">当前 ${filtered.length} 条</span></div>${filter === 'retry' && failed + notStarted ? `<button class="retry-job secondary" data-job="${esc(job.id)}" ${locked ? 'disabled' : ''}>重试本批未识别候选</button>` : ''}${rows || '<p class="muted">当前筛选没有结果。</p>'}${filtered.length > limit ? '<button class="show-more secondary">再显示 8 条</button>' : ''}${stageName !== 'export' ? `<button class="export-job secondary" data-job="${esc(job.id)}">导出完整记录</button>` : ''}</details>${legacy && !locked ? `<div class="legacy-warning">旧结果可能使用了缩略图。重新比对会创建新任务，原记录保留，并重新计费。<button class="recompare-job secondary" data-job="${esc(job.id)}">用高清图逐张重新比对</button></div>` : ''}<button class="delete-job secondary" ${(locked || detailsBusy) ? `disabled title="${detailsBusy ? '商品详情采集中，暂不能删除' : '排队和识别中的任务不能删除'}"` : ''}>删除本批记录</button></article>`;
  }).join('') : '<div class="empty"><img src="assets/app-icon.png" alt=""><h3>开始第一条商品比对</h3><p>先添加视觉模型并连接浏览器插件，再从插件提交候选商品。前期可逐条人工审核，模型建议与人工确认分开记录。</p><button class="secondary open-settings">前往设置</button></div>';
  for (const article of $('jobs').querySelectorAll('article[data-job]')) {
    const job = snapshot.jobs.find(item => item.id === article.dataset.job);
    if (!job) continue;
    const isLocked = ['queued', 'processing'].includes(job.status) || retryingJobs.has(job.id);
    for (let index = 0; index < job.items.length; index++) {
      const item = job.items[index], review = FindReview.decision(item);
      const row = article.querySelector(`.result-row[data-index="${index}"]`);
      if (!row) continue;
      if (item.detailUrl) {
        const open = document.createElement('button'); open.type = 'button'; open.className = 'secondary open-product-detail'; open.dataset.index = String(index); open.textContent = '打开商品链接'; row.lastElementChild.append(open);
      }
      if (review?.verdict !== 'likely_same' || item.platform === 'taobao') continue;
      const command = (snapshot.browserCommands || []).find(entry => entry.kind === 'product-details' && entry.jobId === job.id && entry.itemIndex === index && ['queued','claimed','failed'].includes(entry.status));
      const collect = document.createElement('button'); collect.type = 'button'; collect.className = 'secondary collect-product-details'; collect.dataset.index = String(index);
      collect.disabled = isLocked || command?.status === 'queued' || command?.status === 'claimed' || !!item.productDetails;
      collect.textContent = item.productDetails ? '商品详情已采集' : command?.status === 'queued' || command?.status === 'claimed' ? '正在采集详情…' : command?.status === 'failed' ? '重新采集详情' : '采集商品详情';
      row.lastElementChild.append(collect);
      if (command?.status === 'failed') { const error = document.createElement('span'); error.className = 'product-detail-error'; error.textContent = command.error || '详情采集失败'; row.lastElementChild.append(error); }
    }
    for (let index = 0; index < job.items.length; index++) {
      const details = job.items[index].productDetails;
      if (!details) continue;
      const panel = document.createElement('div'); panel.className = 'collected-product-details';
      const heading = document.createElement('h3'); heading.textContent = `同款详情 · ${details.title || job.items[index].title || '商品'}`; panel.append(heading);
      const facts = document.createElement('p'); facts.className = 'muted';
      facts.textContent = [details.shopName, details.address ? `发货地 ${details.address}` : '', details.price != null ? `${details.priceType === 'tiered' ? '阶梯价 ' : '供货价 '}¥${details.price}` : '', details.priceTiers?.length ? details.priceTiers.map(row => `${row.quantity} ¥${row.price}`).join(' / ') : '', details.resaleFloor != null ? `最低限价 ¥${details.resaleFloor}` : '', details.sku ? `货号 ${details.sku}` : '', details.colors?.length ? `颜色 ${details.colors.join('、')}` : '', details.sizes?.length ? `尺码 ${details.sizes.join('、')}` : '', details.attributes?.length ? `${details.attributes.length} 项规格` : ''].filter(Boolean).join(' · '); panel.append(facts);
      if (details.quality) { const quality = document.createElement('p'); quality.className = 'muted'; quality.textContent = `采集状态：${details.quality.state === 'complete' ? '资料齐全' : `资料部分缺失${details.quality.missingFields?.length ? '（' + details.quality.missingFields.join('、') + '）' : ''}`} · 详情图 ${details.quality.imageCoverage?.detailImages ?? '未知'}/${details.quality.imageCoverage?.detailNodes ?? '未知'} · ${details.quality.imageCoverage?.complete === true ? '图集完整' : '图集未完整'}`; panel.append(quality); }
      if (details.description) { const description = document.createElement('p'); description.textContent = details.description; panel.append(description); }
      if (details.attributes?.length) {
        const attributes = document.createElement('ul'); attributes.className = 'product-detail-attributes';
        for (const value of details.attributes) { const entry = document.createElement('li'); entry.textContent = value; attributes.append(entry); }
        panel.append(attributes);
      }
      const gallery = document.createElement('div'); gallery.className = 'product-detail-gallery';
      for (const [imageIndex, source] of (details.images || []).entries()) { const image = document.createElement('img'); image.src = source; image.alt = `采集的商品图片 ${imageIndex + 1}`; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; gallery.append(image); }
      if (gallery.childElementCount) panel.append(gallery);
      const visibleText = document.createElement('details'), summary = document.createElement('summary'), text = document.createElement('p');
      summary.textContent = `商品页面文字（${details.visibleText?.length || 0} 字）`; text.textContent = details.visibleText || '页面没有可读文字'; visibleText.append(summary, text); panel.append(visibleText);
      article.append(panel);
    }
  }
  document.querySelectorAll('.job-results').forEach(details => details.addEventListener('toggle', () => {
    const id = details.closest('[data-job]').dataset.job;
    if (details.open) expanded.add(id); else expanded.delete(id);
  }));
  document.querySelectorAll('.collect-product-details').forEach(button => button.addEventListener('click', async () => {
    if (button.disabled) return;
    const job = snapshot.jobs.find(item => item.id === button.closest('article[data-job]')?.dataset.job);
    if (!job) return;
    button.disabled = true; button.textContent = '正在提交…';
    try {
      await window.desktop.collectProductDetails(job.id, Number(button.dataset.index));
      if (window.chrome?.runtime?.sendMessage) await window.chrome.runtime.sendMessage({ type: 'PROCESS_DESKTOP_BROWSER_WORKFLOW' }).catch(() => {});
      rendered = ''; await refresh();
    }
    catch (error) { notify(errorText(error)); button.disabled = false; button.textContent = '重新采集详情'; }
  }));
  document.querySelectorAll('.open-product-detail').forEach(button => button.addEventListener('click', async () => {
    const job = snapshot.jobs.find(item => item.id === button.closest('article[data-job]')?.dataset.job);
    const url = job?.items[Number(button.dataset.index)]?.detailUrl;
    if (url) try { await window.desktop.openProductDetail(url); } catch (error) { notify(errorText(error)); }
  }));
  document.querySelectorAll('.retry-job, .recompare-job').forEach(button => button.addEventListener('click', async () => {
    const id = button.dataset.job;
    if (button.disabled || retryingJobs.has(id)) return;
    retryingJobs.add(id);
    button.disabled = true;
    button.textContent = '正在提交…';
    try { await window.desktop.retryJob(id, button.classList.contains('recompare-job')); }
    catch (error) { notify(errorText(error)); }
    finally { retryingJobs.delete(id); rendered = ''; await refresh(); }
  }));
  document.querySelectorAll('.platform-problems').forEach(button => button.addEventListener('click', () => {
    const details = button.closest('article[data-job]')?.querySelector('.platform-issue-list');
    if (details) { details.hidden = !details.hidden; button.textContent = details.hidden ? '查看登录问题' : '收起平台问题'; }
  }));
  document.querySelectorAll('.export-job').forEach(button => button.addEventListener('click', () => {
    const job = snapshot.jobs.find(item => item.id === button.dataset.job);
    if (!job) return;
    const result = { ...job, minimumScore: FindReview.exclusionThreshold(job.items), items: [...job.items].map(item => ({ ...item, scoreExcluded: FindReview.belowThreshold(item, job.items), rankingScore: FindReview.rankingScore(item) })).sort((a, b) => FindReview.compare(a, b, job.reviewMode)) };
    const file = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(file); link.download = `找商品-Electron任务-${job.id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }));
  } catch (error) { $('serviceState').textContent = error.message || '读取本地任务失败'; }
  finally { refreshing = false; }
}
function maskAccount(value) {
  const text = String(value || '');
  if (text.length <= 4) return '••••';
  return `${text.slice(0, 2)}${'•'.repeat(Math.min(8, text.length - 4))}${text.slice(-2)}`;
}

async function openReview(job, index) {
  try {
    const item = job.items[index];
    const query = await window.desktop.queryImage(job.id);
    const candidateImage = item.imageEvidence ? await window.desktop.candidateImage(job.id, index) : undefined;
    const isBuyerMarketplace=!!job.buyerTaskId&&item.platform==='taobao';
    const isBuyerSupplier=!!job.buyerTaskId&&String(job.queryName||'').includes('供应商同款');
    FindReviewUI.open({ item, query, candidateImage, isBuyerSupplier, isBuyerMarketplace, onSave: async input => {
      const {continueBuyer=false,...reviewInput}=input||{};
      if(continueBuyer&&isBuyerMarketplace){
        const result=await window.desktop.confirmBuyerTaobao(job.buyerTaskId,job.id,index,reviewInput,FindReview.signature(item));
        notify(result.continued?'已人工确认淘宝套图来源，自动流程继续到互拓采集。':'已人工确认同款并关联为淘宝套图来源。');showPage('buyer');
        await refresh();return;
      }
      await window.desktop.reviewItem(job.id, index, input ? reviewInput : null, FindReview.signature(item));
      if(continueBuyer){
        await window.desktop.confirmBuyerComparisonCandidate(job.id,index);
        notify('已人工确认这款商品，自动买手流程已继续到供应商资料采集。');
        showPage('buyer');
      } else if (input?.verdict === 'likely_same' && item.platform === 'taobao') {
        notify('淘宝同款结论已保存；请在买手自动化中点击“选作套图来源”。');
      } else if (input?.verdict === 'different') {
        notify('已人工排除此候选，请继续核对其他商品；不会将本候选用作套图来源。');
      } else if (input?.verdict === 'uncertain') {
        notify('已记录无法判断，请继续核对其他候选。');
      } else if (input?.verdict === 'likely_same' && !item.productDetails && !isBuyerSupplier) {
        try {
          await window.desktop.collectProductDetails(job.id, index);
          if (window.chrome?.runtime?.sendMessage) await window.chrome.runtime.sendMessage({ type: 'PROCESS_DESKTOP_BROWSER_WORKFLOW' }).catch(() => {});
          notify('已确认同款，正在从当前浏览器的供应商页面采集商品资料和图片。');
        } catch (error) { notify(`人工结论已保存；详情未能入队：${errorText(error)}`); }
      }
      await refresh();
    } });
  } catch (error) { $('serviceState').textContent = error.message || '读取审核图片失败'; }
}
window.openBuyerCandidateReview=async(jobId,index)=>{await refresh();const job=snapshot?.jobs.find(row=>row.id===jobId);if(!job?.items[index])throw new Error('没有可打开的淘宝候选记录');return openReview(job,index);};
async function viewImage(job, index) {
  try {
    const item = job.items[index];
    const image = item.imageEvidence ? await window.desktop.candidateImage(job.id, index) : item.imageUrl;
    let dialog = $('imageDialog');
    if (!dialog) { dialog = document.createElement('dialog'); dialog.id = 'imageDialog'; dialog.className = 'review-dialog image-dialog'; document.body.append(dialog); }
    dialog.innerHTML = `<div class="review-heading"><h2>商品图片</h2><button type="button">关闭</button></div><p>${item.imageEvidence ? `本次送模图片 ${esc(item.imageEvidence.width)}×${esc(item.imageEvidence.height)}，来源 ${esc(item.imageEvidence.sourceWidth)}×${esc(item.imageEvidence.sourceHeight)}` : '尚无送模图片记录，当前显示平台图片；旧结果建议重新比对。'}</p><img class="image-full" alt="放大商品图" referrerpolicy="no-referrer">`;
    dialog.querySelector('img').src = image;
    dialog.querySelector('button').onclick = () => dialog.close();
    dialog.showModal();
  } catch (error) { notify(errorText(error)); }
}
$('jobs').addEventListener('click', event => {
  const article = event.target.closest('article[data-job]');
  const job = snapshot?.jobs.find(job => job.id === article?.dataset.job);
  if (!job) return;
  if (event.target.closest('.delete-job')) openDeleteJobs([job]);
  if (event.target.closest('.view-image')) void viewImage(job, Number(event.target.closest('.view-image').dataset.index));
  if (event.target.closest('.review-item')) void openReview(job, Number(event.target.closest('.review-item').dataset.index));
  if (event.target.closest('.review-next')) {
    const index = job.items.map((item,index)=>({item,index})).filter(({item})=>FindReview.matchesFilter(item,'pending',job.reviewMode,job.items)).sort((a,b)=>FindReview.compare(a.item,b.item,job.reviewMode))[0]?.index;
    if (index !== undefined) void openReview(job, index);
  }
  if (event.target.closest('.show-more')) { limits.set(job.id, (limits.get(job.id) || 8) + 8); void refresh(); }
  if (event.target.closest('.view-all-results')) { filters.set(job.id, 'all'); platforms.set(job.id, 'all'); limits.set(job.id, job.items.length); expanded.add(job.id); rendered = ''; void refresh(); }
});
function openDeleteJobs(jobs) {
  if (deletingJobsBusy || !snapshot?.authenticated) return;
  const deletable = jobs.filter(canDeleteJob);
  if (!deletable.length) return;
  deletingJobs = deletable.map(job => job.id); deletingUser = snapshot.user.id;
  $('deleteJobsTitle').textContent = deletable.length === 1 ? '删除这批任务记录？' : `清空 ${deletable.length} 批任务记录？`;
  $('deleteJobsText').textContent = '请核对创建时间，以下批次将从当前账号的本机记录中删除。';
  $('deleteJobsList').innerHTML = deletable.map(job => `<li>${esc(taskTime(job.createdAt))} · ${esc(job.queryName || job.goodsId || '未命名任务')} · ${esc(job.total)} 张候选</li>`).join('');
  $('deleteJobsError').textContent = '';
  $('deleteJobsDialog').showModal();
}
$('clearJobs').addEventListener('click', () => openDeleteJobs(snapshot?.jobs || []));
$('cancelDeleteJobs').addEventListener('click', () => { if (!deletingJobsBusy) $('deleteJobsDialog').close(); });
$('deleteJobsDialog').addEventListener('cancel', event => { if (deletingJobsBusy) event.preventDefault(); });
$('confirmDeleteJobs').addEventListener('click', async () => {
  if (deletingJobsBusy) return;
  deletingJobsBusy = true; $('confirmDeleteJobs').disabled = true; $('cancelDeleteJobs').disabled = true;
  try {
    if (snapshot?.user?.id !== deletingUser) throw new Error('登录账号已变化，请重新选择任务');
    const result = await window.desktop.deleteJobs(deletingJobs);
    deletingJobs.forEach(id => { filters.delete(id); platforms.delete(id); limits.delete(id); expanded.delete(id); });
    $('deleteJobsDialog').close();
    notify(`已删除 ${result.deleted} 批任务记录。${result.warnings?.length ? result.warnings.join('；') : ''}`);
    await refresh();
  } catch (error) { $('deleteJobsError').textContent = errorText(error); }
  finally { deletingJobsBusy = false; $('confirmDeleteJobs').disabled = false; $('cancelDeleteJobs').disabled = false; $('clearJobs').disabled = !snapshot?.jobs.some(canDeleteJob); }
});
$('jobs').addEventListener('change', async event => {
  const article = event.target.closest('article[data-job]'), id = article?.dataset.job;
  if (!id) return;
  if (event.target.matches('.review-filter')) { filters.set(id, event.target.value); limits.set(id, 8); await refresh(); }
  if (event.target.matches('.platform-filter')) { platforms.set(id, event.target.value); limits.set(id, 8); await refresh(); }
  if (event.target.matches('.review-mode')) {
    event.target.disabled = true;
    try { await window.desktop.setReviewMode(id, event.target.value); await refresh(); }
    catch (error) {
      event.target.disabled = false;
      event.target.value = FindReview.mode(snapshot.jobs.find(job => job.id === id)?.reviewMode);
      article.querySelector('.review-message').textContent = error.message || '模式保存失败';
    }
  }
});

$('navWork').addEventListener('click', () => showPage(false));
$('navBuyer').addEventListener('click', () => showPage('buyer'));
$('navDrafts').addEventListener('click', () => {showPage('drafts');void window.loadBuyerDrafts?.(true);});
$('navDouyin').addEventListener('click', () => showPage('douyin'));
$('navSettings').addEventListener('click', () => showPage(true));
$('navUpdates').addEventListener('click', () => showPage('updates'));
$('navHelp').addEventListener('click', () => showPage('help'));
$('manageModels').addEventListener('click', () => showPage(true));
$('openUsagePage').addEventListener('click', async () => {
  try { await window.desktop.openUsagePage(); }
  catch (error) { notify(errorText(error)); }
});
$('jobs').addEventListener('click', event => { if (event.target.closest('.open-settings')) showPage(true); });
$('loginForm').addEventListener('submit', async event => {
  event.preventDefault(); $('loginButton').disabled = true; $('loginButton').textContent = '正在登录…'; $('loginMessage').textContent = '';
  const input = { username: $('username').value.trim(), password: $('password').value, remember: $('remember').checked };
  $('password').value = '';
  try { await window.desktop.login(input); await refresh(); }
  catch (error) { $('loginMessage').textContent = errorText(error); }
  finally { input.password = ''; $('loginButton').disabled = false; $('loginButton').textContent = '登录'; }
});
$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;
  try { await window.desktop.logout(); await refresh(); }
  catch (error) { notify(errorText(error)); }
  finally { $('logout').disabled = false; }
});
$('activeModel').addEventListener('change', async () => {
  try { await window.desktop.selectModel($('activeModel').value); await refresh(); }
  catch (error) { catalogRendered = ''; notify(errorText(error)); await refresh(); }
});
function openModel(model) {
  $('modelForm').reset(); $('modelMessage').textContent = '';
  $('modelDialogTitle').textContent = model ? '编辑视觉模型' : '添加视觉模型';
  $('modelId').value = model?.id || ''; $('modelName').value = model?.name || ''; $('modelCode').value = model?.model || ''; $('modelEndpoint').value = model?.endpoint || '';
  $('jsonMode').checked = model?.jsonMode || false;
  $('modelConcurrency').value = String(model?.concurrency || 3);
  $('apiKey').placeholder = model?.hasKey ? '已保存；留空保留，修改 API 地址时需重新填写' : '输入该服务的 API Key（本机服务可留空）';
  $('modelDialog').showModal();
}
$('addModel').addEventListener('click', () => openModel());
const closeModel = () => { $('apiKey').value = ''; $('modelDialog').close(); };
$('closeModel').addEventListener('click', closeModel); $('cancelModel').addEventListener('click', closeModel);
$('modelDialog').addEventListener('close', () => { $('apiKey').value = ''; });
$('providerPreset').addEventListener('change', () => {
  const preset = $('providerPreset').value;
  const endpoints = { qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1', openai: 'https://api.openai.com/v1', local: 'http://127.0.0.1:11434/v1', custom: '' };
  $('modelEndpoint').value = endpoints[preset];
  if (!$('modelId').value) { $('modelName').value = ({ qwen: '百炼视觉模型', openai: 'OpenAI 视觉模型', local: '本机视觉模型', custom: '' })[preset]; $('modelCode').value = preset === 'qwen' ? 'qwen3.7-plus' : ''; }
});
$('modelForm').addEventListener('submit', async event => {
  event.preventDefault(); $('saveModel').disabled = true; $('modelMessage').textContent = '';
  const input = { id: $('modelId').value || undefined, name: $('modelName').value, model: $('modelCode').value, endpoint: $('modelEndpoint').value, apiKey: $('apiKey').value, jsonMode: $('jsonMode').checked, concurrency: Number($('modelConcurrency').value) };
  $('apiKey').value = '';
  try { await window.desktop.saveModel(input); closeModel(); notify('模型配置已保存。可先测试连接，再提交比对任务。'); await refresh(); }
  catch (error) { $('modelMessage').textContent = errorText(error); }
  finally { input.apiKey = ''; $('saveModel').disabled = false; }
});
let deletingId = '';
$('modelList').addEventListener('click', async event => {
  const card = event.target.closest('[data-model]'); if (!card) return;
  const model = snapshot.catalog.models.find(item => item.id === card.dataset.model); if (!model) return;
  const button = event.target.closest('button'); if (!button) return;
  if (button.matches('.edit-model')) return openModel(model);
  if (button.matches('.delete-model')) { deletingId = model.id; $('deleteText').textContent = `确定删除“${model.name}”？${snapshot.catalog.models.length === 1 ? '这是最后一个模型，删除后需要重新添加才能提交任务。' : model.id === snapshot.catalog.activeId ? '删除后将切换到列表中的其他模型。' : ''}`; $('deleteDialog').showModal(); return; }
  button.disabled = true; const original = button.textContent;
  try {
    if (button.matches('.use-model')) { await window.desktop.selectModel(model.id); await refresh(); }
    if (button.matches('.test-model')) { button.textContent = '测试中…'; const result = await window.desktop.testModel(model.id); notify(`${model.name}：${result.message}`); }
  } catch (error) { notify(errorText(error)); }
  finally { button.textContent = original; button.disabled = false; }
});
$('cancelDelete').addEventListener('click', () => $('deleteDialog').close());
$('confirmDelete').addEventListener('click', async () => {
  $('confirmDelete').disabled = true;
  try { await window.desktop.deleteModel(deletingId); $('deleteDialog').close(); notify('模型配置已删除。'); await refresh(); }
  catch (error) { $('deleteDialog').close(); notify(errorText(error)); }
  finally { $('confirmDelete').disabled = false; }
});
function openPlatformAccount(platform) {
  const account = (snapshot.platformAccounts || []).find(item => item.platform === platform);
  if (!account) return;
  $('platformAccountForm').reset(); $('platformAccountMessage').textContent = '';
  $('platformAccountPlatform').value = platform;
  $('platformAccountTitle').textContent = `${account.configured ? '修改' : '添加'}${account.name}账号`;
  $('platformAccountPrompt').textContent = '加密保存在这台电脑，正常更新后继续保留。密码留空保留原值；更换账号时需重新填写对应密码。';
  $('platformAccountUsername').value = account.username || '';
  $('platformAccountPassword').value = '';
  $('platformAccountPassword').placeholder = account.configured ? '已加密保存；留空保留原密码' : '输入平台密码';
  $('platformAccountDialog').showModal();
}
const closePlatformAccount = () => { $('platformAccountPassword').value = ''; $('platformAccountDialog').close(); };
$('closePlatformAccount').addEventListener('click', closePlatformAccount);
$('cancelPlatformAccount').addEventListener('click', closePlatformAccount);
$('platformAccountDialog').addEventListener('close', () => { $('platformAccountPassword').value = ''; $('platformAccountUsername').value = ''; });
$('platformAccountForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('savePlatformAccount').disabled = true; $('platformAccountMessage').textContent = '';
  const platform = $('platformAccountPlatform').value;
  const input = { username: $('platformAccountUsername').value.trim(), password: $('platformAccountPassword').value };
  $('platformAccountPassword').value = '';
  try {
    await window.desktop.savePlatformAccount(platform, input);
    input.password = '';
    closePlatformAccount(); notify('平台账号已保存到本机，重启和正常覆盖升级后继续保留，可随时修改。'); await refresh();
  } catch (error) {
    input.password = ''; $('platformAccountMessage').textContent = errorText(error);
  } finally { $('savePlatformAccount').disabled = false; }
});
let deletingPlatformAccount = '';
$('platformAccountList').addEventListener('click', event => {
  const card = event.target.closest('[data-platform-account]');
  if (!card) return;
  const account = (snapshot.platformAccounts || []).find(item => item.platform === card.dataset.platformAccount);
  if (!account) return;
  if (event.target.closest('.edit-platform-account')) return openPlatformAccount(account.platform);
  if (event.target.closest('.delete-platform-account') && account.configured) {
    deletingPlatformAccount = account.platform;
    $('deletePlatformAccountText').textContent = `删除“${account.name}”保存在当前电脑的账号密码？`;
    $('deletePlatformAccountDialog').showModal();
  }
});
$('cancelDeletePlatformAccount').addEventListener('click', () => $('deletePlatformAccountDialog').close());
$('confirmDeletePlatformAccount').addEventListener('click', async () => {
  $('confirmDeletePlatformAccount').disabled = true;
  try { await window.desktop.deletePlatformAccount(deletingPlatformAccount); $('deletePlatformAccountDialog').close(); notify('平台账号已从本机删除。'); await refresh(); }
  catch (error) { $('deletePlatformAccountText').textContent = errorText(error); }
  finally { $('confirmDeletePlatformAccount').disabled = false; }
});
$('refresh').addEventListener('click', () => { void refresh(); });
$('copyPair').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(`${$('endpoint').value}\n${$('token').value}`); $('copyPair').textContent = '已复制'; setTimeout(() => { $('copyPair').textContent = '复制配对信息'; }, 1500); }
  catch { $('copyPair').textContent = '复制失败，请手动复制'; }
});
void refresh();
setInterval(() => { void refresh(); }, 2000);
