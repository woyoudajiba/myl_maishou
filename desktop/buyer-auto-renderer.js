(function(){
  const $=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const steps={source:'打开商品网页并读取主图',supplier_search:'四平台搜货',supplier_compare:'模型核对供应商',supplier_details:'采集供应商资料',supplier_facts:'整理供货资料',marketplace:'匹配套图',duplicate_check:'按货号检查互拓记录',collection:'互拓采集套图',mapping:'整理上架资料',submit:'保存互拓草稿',verify:'回读核验',convert:'转入互拓待审核',completed:'完成'};
  const stageGroups=[['读取链接图片',['source']],['寻找供应商',['supplier_search','supplier_compare']],['取得供货资料',['supplier_details','supplier_facts']],['核对套图',['marketplace','duplicate_check','collection']],['整理互拓资料',['mapping','submit','verify']],['进入待审核',['convert','completed']]];
  let snapshot=null,preview=null,busy=false,currentTask=null,settingsSignature='',onlineOffset=0,onlineNextOffset=null,onlineRows=[],onlineTables=[],onlineTableUser='',onlineTableLoading=null,historyNext=null,onlineSearch='',onlineBlankRows=[],onlineTableInfo=null,onlineFindResult=null,onlineLoadingRows=false;
  const supplierPreviewPages=new Map(),supplierPreviewBusy=new Set(),supplierPreviewQueued=new Set();
  const dirtyRows=new Set();
  let detailChromeSignature='';
  let detailImageTask='';
  const makeBlankRows=count=>Array.from({length:count},()=>({id:`new-${crypto.randomUUID()}`,articleNo:'',sourceType:'',sourceUrl:'',title:'',note:'',humanStatus:'pending',version:0,isNew:true}));
  const onlineExtraFields=[['selectDate','选品日期（如 11.7）'],['tableId','表格ID（用于商品目录）'],['supplierName','供应商'],['externalCode','运营商品编码'],['selectOperator','选品操作人'],['buyerOperator','买手操作人'],['shopName','店铺名'],['sales7d','近7天销量'],['peerPrice','同行销售价'],['peerLocation','同行发货地'],['goodsCost','货品成本（原表）'],['warehouse','发货仓']];
  $('onlineExtraFields').innerHTML=onlineExtraFields.map(([key,label])=>`<label>${label}<input id="onlineField_${key}" maxlength="200" ${key==='tableId'?'placeholder="留空自动编号"':''}></label>`).join('');
  const errorText=error=>String(error?.message||error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');
  const notify=(message,error=false)=>{for(const id of ['buyerAutoMessage','buyerConfigMessage']){if($(id)){$(id).textContent=message;$(id).classList.toggle('message-ok',!error);}}};
  async function action(button,fn){
    const online=button.id.startsWith('online')||!!button.closest('.online-table-panel,#onlineHistoryDialog,#onlineAddRowDialog');
    if(busy||(online&&onlineLoadingRows))return;
    busy=true;button.disabled=true;if(online)$('onlineTableGrid').inert=true;
    try{const message=await fn();if(message){notify(message);if(online)onlineMessage(message+(dirtyRows.size?' 仍有未保存输入，请保存或撤销。':''));}const current=await window.desktop.snapshot();render(current);window.BuyerUI?.render(current);}
    catch(error){const message=errorText(error);notify(message,true);if(online)onlineMessage(message,true);if($('onlineAddRowDialog').open)$('onlineAddMessage').textContent=message;if($('onlineHistoryDialog').open)$('onlineHistoryMessage').textContent=message;}
    finally{busy=false;if(online)$('onlineTableGrid').inert=false;button.disabled=(button.id==='onlineTableSearchPrev'||button.id==='onlineTableSearchNext')?!onlineFindResult?.total:false;}
  }
  const taskMessage=a=>a.error||(a.state==='waiting'?(a.waitingReason||'等待平台或模型返回结果'):a.state==='completed'?'自动买手流程已完成':snapshot?.buyerAutomation?.paused?'自动队列已暂停，请点击继续队列':a.state==='queued'?'等待自动队列处理':'任务正在按步骤自动处理');
  function helpActions(task,detail=false){
    if(task.readOnly)return '';
    const a=task.automation;if(!a||!['source','supplier_search','supplier_compare','supplier_details'].includes(a.step)||!['waiting','attention'].includes(a.state))return '';
    const message=[a.error,a.waitingReason,...(a.tags||[])].join(' '),urls={wsy:'https://www.wsy.com/',zwd:'https://stu.17zwd.com/',qcc:'https://www.17qcc.com/',e3hui:'https://www.e3hui.cn/'},failed=(a.platformResults||[]).find(row=>row.phase==='failed'||row.phase==='manual_required'),page=a.step==='supplier_details'?a.supplier?.detailUrl:task.sourceUrl;
    return `<div class="buyer-task-actions buyer-recovery-actions">${/插件|浏览器|回执/.test(message)?'<button type="button" class="secondary buyer-plugin-help">查看插件更新与连接步骤</button>':''}${a.step==='supplier_search'&&failed?`<button type="button" class="secondary buyer-platform-login" data-platform="${esc(failed.key)}">打开${esc(platformLabels[failed.key]||'供应商')}登录页</button>`:''}${page?`<button type="button" class="secondary buyer-open-source" data-url="${esc(page)}">打开商品页面检查登录</button>`:''}${detail&&a.state==='attention'?`<button type="button" class="secondary buyer-detail-retry">${a.step==='supplier_search'?'登录后重新搜供应商':a.step==='supplier_compare'?'重试未完成对比':'处理后继续原任务'}</button>`:''}</div>`;
  }
  const platformLabels={wsy:'网商园',zwd:'17网',qcc:'青创网',e3hui:'衣衫汇'};
  const platformPhase=row=>({complete:'已完成',partial:'部分完成',failed:'未完成',manual_required:'需要人工登录或验证'})[row.phase]||row.phase||'状态未知';
  function supplierDiagnostics(task){
    const a=task.automation,rows=a.platformResults||[],incomplete=rows.filter(row=>row.phase!=='complete');
    if(!rows.length)return '<p class="muted">暂时没有四个平台搜索状态。</p>';
    return '<section id="buyerDetailPlatforms" class="buyer-platform-diagnostics"><h3>四个平台搜索状态</h3><div class="buyer-platform-list">'+rows.map(row=>{
      const received=Number.isSafeInteger(row.receivedCount)?row.receivedCount:null;
      const report=row.total==null||row.phase==='failed'?'未知':row.total;
      const groups=(row.searchGroups||[]).map(group=>`${group.type==='accurate'?'准确搜':'相似搜'}${group.phase==='failed'?'失败':`报告 ${group.reportedTotal??'未知'} / 返回 ${group.receivedCount}`}`).join('；');
      const diagnostics=row.diagnostics||{};
      const uncertainQcc=row.key==='qcc'&&diagnostics.failureKind==='timeout'&&diagnostics.retryable===false;
      const diagnosticText=[diagnostics.stage?`阶段 ${diagnostics.stage}`:'',diagnostics.timeoutStage?`超时阶段 ${diagnostics.timeoutStage}`:'',diagnostics.elapsedMs?`耗时 ${Math.ceil(diagnostics.elapsedMs/1000)} 秒`:''].filter(Boolean).join(' · ');
      return `<article class="buyer-platform-state"><div><strong>${esc(platformLabels[row.key]||row.key)}</strong><small>${esc(platformPhase(row))} · ${received===null?'返回数未保存':`本次收到 ${received} 条`} · ${row.key==='zwd'&&row.searchGroups?.length>1?'两组报告合计（可能重复）':'平台报告总数'} ${esc(report)}${Number.isSafeInteger(row.acceptedCount)?` · 可用 ${row.acceptedCount} 条`:''}</small>${groups?'<small>'+esc(groups)+'</small>':''}${diagnosticText?'<small>'+esc(diagnosticText)+'</small>':''}${row.message?'<p>'+esc(row.message)+'</p>':''}${uncertainQcc?'<small>请求已提交，青创网可能已处理；为避免重复消耗搜图额度，不会自动重发。</small>':''}</div>${row.phase!=='complete'?`<button type="button" class="secondary buyer-platform-login" data-platform="${esc(row.key)}">${uncertainQcc?'核对后手动重新搜索':'在浏览器登录'+esc(platformLabels[row.key]||'平台')}</button>`:''}</article>`;
    }).join('')+'</div>'+(incomplete.length?'<p class="muted">登录或完成平台验证后，点“重新搜索未完成平台”；已保存的来源主图会继续使用。</p>':'')+(incomplete.length?'<button type="button" class="secondary buyer-retry-platform-search">重新搜索未完成平台</button>':'')+'</section>';
  }
  function supplierComparisonPanel(task){
    if(task.readOnly)return '';
    const a=task.automation;if(!['supplier_search','supplier_compare'].includes(a.step)||!['attention','waiting','running'].includes(a.state))return '';
    const candidates=(a.searchCandidates||[]).slice(0,500),compared=a.supplierComparison?.items||a.checkpoints?.supplierComparison?.result?.items||[],selected=new Set((a.supplierCandidates||[]).map(row=>row.platform+'|'+row.detailUrl)),sourceTitle=task.sourceType==='image'?'商品原图':'商品链接图片';
    if(!candidates.length)return `<section id="buyerDetailCandidates" class="buyer-visual-review"><h3>供应商搜索未返回候选</h3><p class="muted">请查看失败平台，完成登录或验证后重新搜索；不会直接把商品判为不同款。</p>${supplierDiagnostics(task)}<button type="button" class="secondary buyer-retry-platform-search">重新搜索供应商</button></section>`;
    const page=Math.min(supplierPreviewPages.get(task.id)||0,Math.floor((candidates.length-1)/4)),start=page*4,visible=candidates.slice(start,start+4),jobId=a.checkpoints?.supplierComparison?.jobId||a.comparisonJobId||'';
    supplierPreviewPages.set(task.id,page);
    const cards=visible.map((item,offset)=>{const index=start+offset,verdict=compared.find(row=>row.platform===item.platform&&row.detailUrl===item.detailUrl),decision=verdict?.visualComparison?.verdict||'',reliableIndex=(a.supplierCandidates||[]).findIndex(row=>row.platform===item.platform&&row.detailUrl===item.detailUrl),rejected=(a.rejectedSupplierCandidates||[]).some(row=>row.platform===item.platform&&row.detailUrl===item.detailUrl),status=rejected?'你已人工排除此候选':decision?({likely_same:'模型建议疑似同款',similar:'模型建议相似款',different:'模型建议不同款',uncertain:'模型无法判断'}[decision]||'模型已有结果'):verdict?.imageSimilarityError?'模型未完成识别':'等待模型识别';
      const choice=rejected?`<button type="button" class="secondary buyer-restore-candidate" data-index="${index}">恢复候选</button>`:reliableIndex>=0?`<button type="button" class="secondary buyer-detail-select-supplier buyer-supplier-choice" data-index="${reliableIndex}" ${a.state==='attention'?'':'disabled'}>按模型建议确认同款并继续</button>`:`<button type="button" class="secondary buyer-confirm-candidate buyer-supplier-choice" data-index="${index}" ${a.state==='attention'?'':'disabled'}>我确认是同款，按此供应商继续</button><button type="button" class="secondary buyer-reject-candidate buyer-supplier-choice" data-index="${index}" ${a.state==='attention'?'':'disabled'}>不是同款，排除此候选</button>`;
      return `<article class="buyer-compare-candidate ${rejected?'buyer-candidate-rejected':''}" data-candidate="${index}"><div class="buyer-compare-image-wrap"><img class="buyer-compare-image" data-preview-index="${index}" alt="${esc(platformLabels[item.platform]||item.platform)}供应商候选图" loading="lazy"><span class="buyer-image-loading">正在取得对照图…</span></div><div class="buyer-compare-copy"><strong>${esc(platformLabels[item.platform]||item.platform)} · ${esc(item.shopName||item.title||'供应商候选')}</strong><small>${esc(item.title||'')}${item.price!=null?` · ¥${esc(item.price)}`:''}</small><small>${esc(status)}${verdict?.visualComparison?.score!=null?` · ${esc(verdict.visualComparison.score)}/100`:''}</small>${verdict?.visualComparison?.matches?.length?`<small>吻合：${esc(verdict.visualComparison.matches.join('；'))}</small>`:''}${verdict?.visualComparison?.differences?.length?`<small>差异：${esc(verdict.visualComparison.differences.join('；'))}</small>`:''}${verdict?.visualComparison?.uncertainties?.length?`<small>待核实：${esc(verdict.visualComparison.uncertainties.join('；'))}</small>`:''}${verdict?.imageSimilarityError?`<small class="buyer-auto-error">${esc(verdict.imageSimilarityError)}</small>`:''}<div class="buyer-task-actions"><button type="button" class="secondary buyer-open-candidate" data-url="${esc(item.detailUrl)}">打开候选商品页</button>${choice}</div><div class="buyer-link-gallery-block"><button type="button" class="secondary buyer-load-gallery" data-index="${index}">读取链接全部图片</button><small data-candidate-gallery-status="${index}">从商品页面读取详情图集以便核对</small><div class="buyer-gallery-grid" data-candidate-gallery="${index}"></div></div></div></article>`;}).join('');
    return `<section id="buyerDetailCandidates" class="buyer-visual-review"><div class="section-heading"><div><h3>对照商品图片，人工选择供应商</h3><p class="muted">上方展示商品链接图集，可逐张放大；候选可读取商品链接中的详情图片，再对照判断。人工确认后，软件继续采集该供应商资料。</p></div>${jobId?'<button type="button" class="secondary buyer-open-comparison" data-job="'+esc(jobId)+'">跳转到识别与复核</button>':''}</div><div class="buyer-source-gallery-block"><strong>${esc(sourceTitle)}（${esc(task.automation?.source?.images?.length||task.automation?.checkpoints?.source?.result?.images?.length||1)}张）</strong><div class="buyer-gallery-grid buyer-source-gallery" data-source-gallery></div><small data-source-preview-state>正在读取商品图集…</small><button type="button" class="secondary buyer-source-gallery-retry" hidden>重试加载未成功图片</button></div><div class="buyer-source-compare"><div class="buyer-source-compare-list"><strong>供应商候选（${esc(a.searchCandidateCount||a.searchCandidates.length)}）</strong><div class="buyer-compare-grid">${cards}</div><div class="buyer-candidate-pagination"><button type="button" class="secondary buyer-more-candidates" data-next="${page-1}" ${page===0?'disabled':''}>上一组</button><small>第 ${start+1}–${start+visible.length} / ${candidates.length} 个候选</small><button type="button" class="secondary buyer-more-candidates" data-next="${page+1}" ${start+visible.length>=candidates.length?'disabled':''}>下一组</button></div></div></div><p class="buyer-manual-caution">无法分辨时可以保留待处理。请确认款式一致后再点击“我确认是同款”。</p>${supplierDiagnostics(task)}</section>`;
  }
  function card(task,selected=false){const a=task.automation,origin=task.origin||{},status={queued:'等待自动处理',running:'自动处理中',waiting:'等待平台或模型',attention:'待集中处理',completed:'已完成',stopped:'已停止'}[a.state]||a.state,comparisonJobId=a.comparisonJobId||a.checkpoints?.supplierComparison?.jobId||snapshot?.jobs?.find(job=>job.buyerTaskId===task.id&&String(job.queryName||'').includes('供应商同款'))?.id||'';
    const stage=Math.max(0,stageGroups.findIndex(([,keys])=>keys.includes(a.step))),track='<ol class="buyer-stage-track">'+stageGroups.map(([label],index)=>`<li class="${a.state==='completed'||index<stage?'done':index===stage?'current':''}"><span>${index+1}</span>${esc(label)}</li>`).join('')+'</ol>';
    const rowLabel=[origin.fileName||'补录商品',origin.sheetName&&origin.sheetName!==origin.fileName?origin.sheetName:'',origin.rowNumber?'第'+origin.rowNumber+'行':''].filter(Boolean).join(' · ');
    return `<article class="buyer-task buyer-auto-task" data-buyer-task="${esc(task.id)}"><div class="buyer-task-head"><label class="check"><input class="buyer-select" type="checkbox" ${selected?'checked':''} aria-label="选择此买手任务"><span><strong>${esc(task.sourceTitle||task.articleNo||`第${origin.rowNumber||''}行商品链接`)}</strong><small>${esc(rowLabel)}</small><small>任务 ID：${esc(task.id)}</small></span></label><span class="pill ${a.state==='attention'?'attention-pill':''}">${esc(status)}</span></div>${track}<p class="buyer-step-text">${a.state==='completed'?(a.result?.productNo?'已进入互拓待审核':'互拓草稿已保存'):'当前：'+esc(steps[a.step]||a.step)}</p><p class="buyer-source-url">${esc(task.sourceUrl)}</p>${a.state==='waiting'?'<p class="muted buyer-waiting-reason">'+esc(a.waitingReason||'等待平台或模型返回结果')+'</p>':''}${a.tags?.length?'<div class="buyer-tags">'+a.tags.map(tag=>'<span>'+esc(tag)+'</span>').join('')+'</div>':''}${a.error?'<p class="buyer-auto-error">'+esc(a.error)+'</p>':''}${a.result?.productNo?'<p class="buyer-code">互拓编码：'+esc(a.result.productNo)+'</p>':''}<div class="buyer-task-actions"><button class="secondary buyer-auto-detail" type="button">${a.state==='attention'?'处理例外':'查看详情'}</button>${a.state==='attention'?'<button class="secondary buyer-auto-retry" type="button">继续原任务</button>':''}${['supplier_search','supplier_compare'].includes(a.step)?`<button class="secondary buyer-open-comparison-card" ${comparisonJobId?`data-job="${esc(comparisonJobId)}"`:''} type="button">跳转到识别与复核</button>`:''}</div>${helpActions(task)}<div class="buyer-task-actions">${task.onlineTableRowId?'<button class="secondary buyer-locate-row" type="button">定位原表行</button>':''}<button class="secondary buyer-delete-task" type="button" ${a.enabled&&!['attention','completed','stopped'].includes(a.state)?'disabled':''}>删除本机任务</button></div></article>`;
  }
  function render(current){snapshot=current;if(!snapshot?.authenticated){settingsSignature='';preview=null;currentTask=null;onlineTableUser='';onlineTables=[];onlineRows=[];onlineBlankRows=[];onlineTableInfo=null;onlineFindResult=null;onlineSearch='';dirtyRows.clear();$('onlineTableGrid').querySelector('tbody').innerHTML='';$('onlineHistoryDialog').close();$('onlineHistoryList').innerHTML='';$('onlineHistoryDetails').innerHTML='';$('onlineAddRowDialog').close();return;}
    if(!snapshot.user?.isAdmin)$('onlineTableCreate').hidden=true;
    const userId=snapshot.user?.id||'';if(userId&&onlineTableUser!==userId){onlineTableUser=userId;onlineTables=[];onlineRows=[];onlineSearch='';onlineFindResult=null;onlineTableInfo=null;onlineBlankRows=makeBlankRows(12);$('onlineTableSearch').value='';$('onlineTableState').textContent='正在读取';$('onlineTableName').textContent='正在读取…';void loadOnlineTables().catch(error=>onlineMessage(errorText(error),true));}
    if(currentTask&&$('buyerAutoDetailDialog').open&&!busy){const task=(snapshot.buyerTasks||[]).find(row=>row.id===currentTask.id);if(task){renderDetailChrome(task);if(task.updatedAt!==currentTask.updatedAt&&!$('buyerSupplyFactsForm'))void window.desktop.buyerTaskDetail(task.id).then(detail=>{if($('buyerAutoDetailDialog').open&&currentTask?.id===detail.id&&!$('buyerSupplyFactsForm'))showDetail(detail);}).catch(()=>{});}}
    refreshVisibleFlowStates();
    const auto=snapshot.buyerAutomation||{},scoped=tasksForScope(snapshot);$('buyerAutoSummary').textContent=`当前范围：已完成 ${scoped.filter(task=>task.automation?.state==='completed').length} 件 · 待处理 ${scoped.filter(task=>task.automation?.state==='attention').length} 件 · 全局队列 ${auto.queued||0} 件`;
    $('buyerAutoPause').disabled=auto.paused!==false;$('buyerAutoResume').disabled=auto.paused===false;
    const pending=scoped.filter(task=>task.automation?.state==='queued'&&!task.automation.enabled).length;
    $('buyerAutoStart').hidden=pending===0;
    $('buyerAutoPause').hidden=auto.paused!==false||!auto.queued;
    $('buyerAutoResume').hidden=auto.paused===false||!auto.queued;
    $('buyerExportRows').hidden=!(auto.completed||auto.attention);
    $('buyerAutoQueueState').textContent=pending?`${pending} 件商品等待启动`:!auto.queued?((auto.completed||auto.attention)?'自动处理已结束，例外可单独继续':'等待导入商品链接'):auto.paused?'自动队列已暂停':'自动队列运行中';
    $('buyerAutoSetup').hidden=!!snapshot.vision?.configured&&!!snapshot.buyerSettings?.configured;
    const browser=snapshot.browserClient;
    $('buyerAutoConnections').textContent=[snapshot.vision?.configured?'视觉模型已配置':'需要配置视觉模型',snapshot.buyerSettings?.configured?'互拓已配置':'需要配置互拓账号',browser?.title||'等待浏览器插件连接'].join(' · ');
    let prompt=$('buyerPluginPrompt');
    if(!prompt){prompt=document.createElement('div');prompt.id='buyerPluginPrompt';prompt.className='buyer-plugin-prompt';prompt.setAttribute('role','status');prompt.innerHTML='<strong></strong><p></p><button type="button" class="secondary buyer-plugin-help">查看插件更新与连接步骤</button>';$('buyerAutoConnections').after(prompt);}
    prompt.hidden=!browser||browser.state==='ready';
    if(!prompt.hidden){prompt.querySelector('strong').textContent=browser.title;prompt.querySelector('p').textContent=browser.message;}
    const settings=snapshot.buyerSettings||{};if($('buyerConfig_productRootDir'))$('buyerConfig_productRootDir').value=settings.productRootDir||'';
    $('buyerErpState').textContent=settings.configured?'已由服务器连接互拓':settings.managedError||'请在账号页面保存互拓账号和密码';
    $('buyerManagedErpStatus').textContent=settings.configured?'互拓已连接':'互拓未连接';$('buyerManagedErpUser').textContent=settings.managedUsername||'未关联';
  }
  const onlineFields=['articleNo','sourceUrl','title','note'];
  const onlineAllFields=[...onlineFields,'sourceType',...onlineExtraFields.map(([key])=>key)];
  const isBlankRow=row=>!!row?.isNew;
  const onlineAutomationLabel=value=>({queued:'排队中',running:'处理中',waiting:'等待平台/模型',attention:'待处理',completed:'已完成',stopped:'已停止'}[value]||value||'');
  const restartableOnlineRow=row=>!!row?.taskId&&row.humanStatus==='approved'&&row.automationState==='attention'&&(['supplier_search','supplier_compare'].includes(row.automationStep)||!row.automationStep&&/(供应商同款|候选未识别|供应商识别未完成|供应商搜索不完整)/.test(row.automationError||''))&&!row.erpProductNo;
  const onlineRowById=id=>onlineRows.find(row=>row.id===id)||onlineBlankRows.find(row=>row.id===id);
  function onlineFlowMarkup(row,task){
    const a=task?.automation||{state:row.automationState,step:row.automationStep,error:row.automationError};
    const reason=a.error||(a.state==='waiting'?a.waitingReason||'':'');
    return `${esc(onlineAutomationLabel(a.state)||(row.sourceUrl?'等待人工确认':''))}${a.step?'<small>阶段：'+esc(steps[a.step]||a.step)+'</small>':''}${reason?'<small>'+esc(reason)+'</small>':''}`;
  }
  function refreshVisibleFlowStates(){
    for(const row of onlineRows){const task=(snapshot?.buyerTasks||[]).find(task=>task.id===row.taskId&&(!task.onlineTableId||task.onlineTableId===onlineTableInfo?.id)&&task.onlineTableRowId===row.id);if(!task)continue;
      const tr=onlineRowElement(row.id),state=tr?.querySelector('[data-online-flow-state]');if(state)state.innerHTML=onlineFlowMarkup(row,task);
      const code=tr?.querySelector('[data-online-flow-code]');if(code)code.textContent=task.automation?.result?.productNo||row.erpProductNo||'';
    }
  }
  async function openOnlineFlow(row){
    const task=row.taskId&&(snapshot?.buyerTasks||[]).find(task=>task.id===row.taskId);
    if(task){if(task.onlineTableRowId!==row.id||task.onlineTableId&&task.onlineTableId!==onlineTableInfo?.id)throw new Error('表行与本机任务关联不一致，请刷新后重新打开。');await window.desktop.locateBuyerTask(task.id);showDetail(await window.desktop.buyerTaskDetail(task.id));}
    else showDetail(onlineReadOnlyTask(row));
  }
  function onlineReadOnlyTask(row){return{id:row.taskId||`row:${row.id}`,readOnly:true,updatedAt:row.updatedAt||row.version,sourceTitle:row.title||row.articleNo||'商品流程',articleNo:row.articleNo,sourceUrl:row.sourceUrl,onlineTableId:onlineTableInfo?.id,onlineTableRowId:row.id,origin:{sheetName:onlineTableInfo?.name,rowNumber:row.position},events:[],automation:{state:row.automationState||'queued',step:row.automationStep||'source',error:row.taskId?(row.automationError||'此任务在原处理电脑运行，当前显示表格已同步的流程；不会在本机重复启动。'):'该商品尚未创建任务，请返回表格确认并提交。',result:{productNo:row.erpProductNo||''}}};}
  async function returnToTaskRow(){
    if(!currentTask?.onlineTableRowId){$('buyerAutoDetailDialog').close();$('navBuyer').click();return;}
    const sameTable=!currentTask.onlineTableId||currentTask.onlineTableId===onlineTableInfo?.id;
    if(dirtyRows.size&&(!sameTable||!onlineRowElement(currentTask.onlineTableRowId)))throw new Error('请先保存或撤销表格输入，再跨表或跨页定位。');
    const located=currentTask.readOnly?await window.desktop.locateOnlineTableRow({rowId:currentTask.onlineTableRowId}):await window.desktop.locateBuyerTask(currentTask.id);
    const rowId=located.rowId||located.row?.id;
    if(!sameTable||!onlineRowElement(rowId)){onlineRows=[];onlineTableInfo=null;onlineBlankRows=makeBlankRows(12);onlineOffset=Math.floor(located.offset/100)*100;clearOnlineFind();await loadOnlineTables();}
    $('buyerAutoDetailDialog').close();$('navBuyer').click();highlightOnlineRow(rowId,[],true);onlineMessage('已返回此商品对应表行；当前流程状态持续同步。');
  }
  function onlineRowElement(id){return $('onlineTableGrid').querySelector(`[data-online-row="${id}"]`);}
  function readRowInput(row){
    const tr=onlineRowElement(row.id),values={...row};
    if(tr)tr.querySelectorAll('.online-edit').forEach(input=>values[input.dataset.field]=input.value.trim());
    return Object.fromEntries(onlineAllFields.map(key=>[key,String(values[key]||'').trim()]));
  }
  const hasRowContent=data=>onlineAllFields.filter(key=>key!=='sourceType').some(key=>!!String(data[key]||'').trim());
  function rowMarkup(row,index){
    const blank=isBlankRow(row),hasLink=!!String(row.sourceUrl||'').trim(),number=blank?Number(onlineTableInfo?.nextPosition||1)+index:row.position;
    const localTask=row.taskId&&(snapshot?.buyerTasks||[]).find(task=>task.id===row.taskId);
    const taskAction=row.taskId?(localTask?`<button type="button" class="secondary online-open-local-task" data-task-id="${esc(row.taskId)}">查看商品流程</button>`:restartableOnlineRow(row)?`<button type="button" class="online-restart-local-task" data-task-id="${esc(row.taskId)}">本机重新开始</button>`:`<small class="online-remote-task-hint">本机没有此任务记录，已保留原处理记录；新商品请新增表格行</small>`):'';
    return `<tr tabindex="${blank?-1:0}" title="${blank?'填写商品':'点击行号、状态或空白处查看商品流程'}" data-online-row="${esc(row.id)}" data-version="${row.version||0}" data-position="${number}" class="${dirtyRows.has(row.id)?'online-dirty ':''}${blank?'online-new-row':''}"><th scope="row" class="online-row-number">${number}</th>${onlineFields.map((field,i)=>`<td><input class="online-edit ${field==='sourceUrl'?'online-url':''}" data-field="${field}" value="${esc(row[field])}" maxlength="${field==='articleNo'?120:field==='title'?300:2000}" aria-label="第${number}行${['货号','商品链接','标题','备注'][i]}" ${row.taskId&&['articleNo','sourceUrl'].includes(field)?'readonly':''}>${field==='sourceUrl'&&hasLink?'<button type="button" class="text-button online-open-source-link">打开链接</button>':''}</td>`).join('')}<td>${!hasLink?'<span class="muted">—</span>':`<span class="pill ${row.humanStatus==='approved'?'approved-pill':''}">${row.humanStatus==='approved'?'已确认':row.humanStatus==='rejected'?'已驳回':'待确认'}</span>`}</td><td><div data-online-flow-state>${onlineFlowMarkup(row,localTask)}</div>${row.taskId?'<small class="online-task-id">任务 ID：'+esc(row.taskId)+'</small>':''}${taskAction}</td><td data-online-flow-code>${esc(localTask?.automation?.result?.productNo||row.erpProductNo||'')}</td><td class="online-row-actions"><button type="button" class="secondary online-save-row">保存</button><button type="button" class="secondary online-cancel-row">${blank?'清空':'撤销输入'}</button><button type="button" class="secondary online-details-row">更多字段</button>${!blank&&!row.taskId&&hasLink?'<button type="button" class="online-approve-row">确认并提交</button><button type="button" class="secondary online-reject-row">驳回</button>':''}${!blank?'<button type="button" class="secondary online-delete-row">删除</button>':''}</td></tr>`;
  }
  function renderOnlineRows(result){
    const view=$('onlineTableViewport'),scrollTop=view.scrollTop,scrollLeft=view.scrollLeft;
    const drafts=new Map([...dirtyRows].map(id=>[id,{row:onlineRowById(id),values:onlineRowById(id)?readRowInput(onlineRowById(id)):null}]));
    onlineTableInfo=result.table||onlineTableInfo;
    const fetched=new Set((result.rows||[]).map(row=>row.id));
    onlineRows=(result.rows||[]).map(row=>drafts.get(row.id)?.row||row).concat([...drafts].filter(([id,draft])=>draft.row&&!draft.row.isNew&&!fetched.has(id)).map(([,draft])=>({...draft.row,remoteDeleted:true})));
    onlineNextOffset=result.nextOffset??null;
    if(!onlineBlankRows.length)onlineBlankRows=makeBlankRows(12);
    $('onlineTableState').textContent=onlineTableInfo?.name||'已连接';$('onlineTableName').textContent=onlineTableInfo?.name||'在线选品表';
    $('onlineTableGrid').querySelector('tbody').innerHTML=onlineRows.map(row=>rowMarkup(row,0)).join('')+(onlineNextOffset===null?onlineBlankRows.map(rowMarkup).join(''):'');
    for(const [id,draft] of drafts){const tr=onlineRowElement(id);if(tr&&draft.values)for(const field of onlineFields)tr.querySelector(`[data-field="${field}"]`).value=draft.values[field];}
    const total=onlineTableInfo?.rowTotal??onlineTableInfo?.rowCount??0;
    $('onlineTablePageInfo').textContent=`商品 ${onlineTableInfo?.rowCount||0} 件 · 已保存 ${total} 行`+(result.rows?.length?` · 当前第 ${result.rows[0].position}–${result.rows.at(-1).position} 行`:' · 空白行可直接填写');
    $('onlineTablePrev').disabled=onlineOffset===0;$('onlineTableNext').disabled=onlineNextOffset===null;
    $('onlineTableImportLocal').hidden=!onlineTableInfo;$('onlineTableExport').hidden=!onlineTableInfo;
    view.scrollTop=scrollTop;view.scrollLeft=scrollLeft;window.BuyerUI?.render(snapshot);
    if(currentTask?.readOnly&&$('buyerAutoDetailDialog').open&&currentTask.onlineTableId===onlineTableInfo?.id){const row=onlineRows.find(row=>row.id===currentTask.onlineTableRowId);if(row&&(row.updatedAt||row.version)!==currentTask.updatedAt)showDetail(onlineReadOnlyTask(row));}
    if(onlineFindResult?.row)highlightOnlineRow(onlineFindResult.row.id,onlineFindResult.matchFields||[],false);
  }
  function addBlankRows(count=12){
    if(!onlineTableInfo||onlineNextOffset!==null)return;
    const start=onlineBlankRows.length,rows=makeBlankRows(count);onlineBlankRows.push(...rows);
    $('onlineTableGrid').querySelector('tbody').insertAdjacentHTML('beforeend',rows.map((row,index)=>rowMarkup(row,start+index)).join(''));
  }
  async function loadOnlineRows(offset=onlineOffset){
    if(dirtyRows.size&&offset!==onlineOffset)throw new Error('请先保存或撤销当前页输入，再跳转。');
    const user=onlineTableUser;onlineLoadingRows=true;
    try{
      const desired=offset===onlineOffset?Math.max(100,onlineRows.length):100,rows=[];let result;
      do{result=await window.desktop.loadOnlineTableRows({offset:offset+rows.length,limit:Math.min(1000,Math.max(100,desired-rows.length))});rows.push(...result.rows);}while(result.nextOffset!==null&&rows.length<desired);
      if(user!==onlineTableUser)return;onlineOffset=offset;renderOnlineRows({...result,rows,offset});return result;
    }
    finally{onlineLoadingRows=false;}
  }
  function highlightOnlineRow(id,fields=[],scroll=true){
    $('onlineTableGrid').querySelectorAll('.online-found').forEach(node=>node.classList.remove('online-found'));
    const tr=onlineRowElement(id);if(!tr)return;tr.classList.add('online-found');
    const input=tr.querySelector(`[data-field="${fields.find(field=>onlineFields.includes(field))||'articleNo'}"]`);
    if(scroll){tr.scrollIntoView({block:'center',inline:'nearest'});input?.focus({preventScroll:true});input?.scrollIntoView({block:'nearest',inline:'center'});}
  }
  function clearOnlineFind(){
    onlineSearch='';onlineFindResult=null;$('onlineTableSearch').value='';$('onlineTableSearchStatus').textContent='';
    $('onlineTableSearchPrev').disabled=true;$('onlineTableSearchNext').disabled=true;
    $('onlineTableGrid').querySelectorAll('.online-found').forEach(node=>node.classList.remove('online-found'));
  }
  async function findOnline(direction=0){
    if(dirtyRows.size)throw new Error('请先保存或撤销未保存输入，再查找跳转。');
    const query=$('onlineTableSearch').value.trim();if(!query){clearOnlineFind();return '';}
    const index=query===onlineSearch&&direction?(onlineFindResult?.index||0)+direction:0;
    const result=await window.desktop.findOnlineTableRows({search:query,index});onlineSearch=query;onlineFindResult=result;
    $('onlineTableSearchPrev').disabled=!result.total;$('onlineTableSearchNext').disabled=!result.total;
    if(!result.row){$('onlineTableSearchStatus').textContent='未找到匹配内容';$('onlineTableGrid').querySelectorAll('.online-found').forEach(node=>node.classList.remove('online-found'));return '';}
    await loadOnlineRows(Math.floor(result.offset/100)*100);
    $('onlineTableSearchStatus').textContent=`第 ${result.index+1} / ${result.total} 处 · 已跳到第 ${result.row.position} 行`;
    highlightOnlineRow(result.row.id,result.matchFields);return '';
  }
  async function saveBlankPrefix(lastIndex){
    if(lastIndex<0)return 0;
    const rows=onlineBlankRows.slice(0,lastIndex+1),data=rows.map(row=>({...readRowInput(row),id:row.id.slice(4)}));
    if(!data.some(hasRowContent))return 0;
    let saved=0;
    // Reserve preceding empty rows in the same order, so typing in row 10 stays in row 10.
    for(let offset=0;offset<rows.length;offset+=1000){
      const chunk=rows.slice(offset,offset+1000),result=await window.desktop.importOnlineTableRows(data.slice(offset,offset+1000));
      for(const row of chunk){dirtyRows.delete(row.id);onlineBlankRows=onlineBlankRows.filter(item=>item.id!==row.id);onlineRowElement(row.id)?.remove();}
      onlineRows.push(...(result.rows||[]));onlineTableInfo=result.table;saved+=chunk.length;
    }
    return saved;
  }
  async function saveOnlineRow(row){
    if(row.remoteDeleted)throw new Error('此行已被其他人删除；输入仍保留，请复制所需内容后撤销输入。');
    const data=readRowInput(row);
    if(row.isNew){
      if(!hasRowContent(data)){dirtyRows.delete(row.id);return false;}
      return !!(await saveBlankPrefix(onlineBlankRows.findIndex(item=>item.id===row.id)));
    }
    const patch=Object.fromEntries(Object.entries(data).filter(([key,value])=>value!==String(row[key]||'')));
    if(Object.keys(patch).length)await window.desktop.updateOnlineTableRow({rowId:row.id,version:row.version,patch});dirtyRows.delete(row.id);return true;
  }
  function markOnlineDirty(input){
    const tr=input.closest('[data-online-row]');if(!tr)return;
    dirtyRows.add(tr.dataset.onlineRow);tr.classList.add('online-dirty');
    if(onlineBlankRows.slice(-3).some(row=>row.id===tr.dataset.onlineRow))addBlankRows(20);
    onlineMessage('有尚未保存的输入；自动刷新已暂停，请保存或撤销输入。');
  }
  async function loadOnlineTables(){
    if(onlineTableLoading)return onlineTableLoading;
    if(!snapshot?.authenticated)return;
    const user=onlineTableUser;
    onlineTableLoading=(async()=>{
    try{
      const result=await window.desktop.listOnlineTables();if(user!==onlineTableUser)return;onlineTables=result.tables||[];
      const selected=onlineTables.find(table=>table.id===result.selectedId)||onlineTables[0]||null;
      const admin=snapshot.user?.isAdmin===true;
      $('onlineTableCreate').hidden=!!selected||!admin;
      $('onlineTablePickerLabel').hidden=onlineTables.length<2;$('onlineTablePicker').innerHTML=onlineTables.map(table=>`<option value="${esc(table.id)}" ${table.id===selected?.id?'selected':''}>${esc(table.name)}</option>`).join('');
      if(!selected){
        $('onlineTableState').textContent='未创建';$('onlineTableName').textContent='尚无共享选品表';
      $('onlineTableHint').textContent=admin?'先创建一张共享选品表，其他 TDL 账号即可登录使用。':'等待 TDL 管理员创建共享选品表；创建后本页会自动显示。';
        $('onlineTableGrid').querySelector('tbody').innerHTML='<tr><td colspan="9" class="muted">尚无共享选品表</td></tr>';
        $('onlineTablePageInfo').textContent='0 行';$('onlineTablePrev').disabled=true;$('onlineTableNext').disabled=true;$('onlineTableImportLocal').hidden=true;$('onlineTableExport').hidden=true;
      }else{
        $('onlineTableHint').textContent='直接在空白行填写，按 Enter 或点击保存。所有字段均可留空；只有链接列不为空才计为商品，支持粘贴整段分享文案，保存时自动提取商品链接，确认提交时再校验。可粘贴 Excel 多行多列，填写到末尾会继续延伸。';
        await loadOnlineRows(onlineOffset);
      }
      onlineMessage(onlineRows.some(row=>row.remoteDeleted)?'有编辑中的商品行已被其他人删除；输入仍保留，请复制所需内容后撤销输入。':dirtyRows.size?'有尚未保存的输入；请先保存或撤销输入。':'');
      for(const id of ['onlineTableAddRow','onlineTableHistory'])$(id).disabled=!selected;
    }catch(error){
      $('onlineTableState').textContent='连接失败';$('onlineTableName').textContent='暂时无法连接共享表';$('onlineTableHint').textContent='检查本机网络后点击“刷新表格”重试。';$('onlineTableCreate').hidden=true;
      onlineMessage(errorText(error),true);
      throw error;
    }finally{onlineTableLoading=null;}
    })();return onlineTableLoading;
  }
  function onlineMessage(message,error=false){$('onlineTableMessage').textContent=message;$('onlineTableMessage').classList.toggle('message-ok',!error);}
  $('onlineTablePicker').addEventListener('change',()=>void action($('onlineTablePicker'),async()=>{if(dirtyRows.size){$('onlineTablePicker').value=onlineTableInfo?.id||'';throw new Error('请先保存或撤销当前表格输入，再切换表格。');}await window.desktop.selectOnlineTable($('onlineTablePicker').value);onlineRows=[];onlineTableInfo=null;onlineBlankRows=makeBlankRows(12);clearOnlineFind();onlineOffset=0;await loadOnlineTables();return'已切换选品表，任务列表按当前表格显示。';}));
  $('onlineTableCreate').addEventListener('click',()=>void action($('onlineTableCreate'),async()=>{const name=onlineTables.length?'买手选品表 '+new Date().toLocaleDateString('zh-CN'):'买手共享选品表';const result=await window.desktop.createOnlineTable(name);await loadOnlineTables();return result.table?'共享选品表已创建，所有 TDL 账号均可登录使用。':'共享选品表已创建。';}));
  $('onlineTableConnect').addEventListener('click',()=>void action($('onlineTableConnect'),async()=>{await loadOnlineTables();return onlineTables.length?'共享选品表已刷新。':'已刷新；等待管理员创建共享表。';}));
  $('onlineTableHealth').addEventListener('click',()=>void action($('onlineTableHealth'),async()=>{await window.desktop.healthOnlineTable();await loadOnlineTables();return'在线选品表服务正常。';}));
  async function focusOnlineBlank(){
    if(!onlineTableInfo)throw new Error('请先连接共享表');
    if(onlineNextOffset!==null){if(dirtyRows.size)throw new Error('请先保存或撤销未保存输入，再跳到表格末尾。');await loadOnlineRows(Math.floor(Math.max(0,onlineTableInfo.rowTotal-1)/100)*100);}
    if(!onlineBlankRows.length)addBlankRows();
    const row=onlineBlankRows[0],tr=onlineRowElement(row.id);tr?.scrollIntoView({block:'center'});
    // Focus runs once the table leaves its temporary saving state.
    requestAnimationFrame(()=>tr?.querySelector('[data-field="sourceUrl"]')?.focus());
    return '';
  }
  $('onlineTableAddRow').addEventListener('click',()=>void action($('onlineTableAddRow'),focusOnlineBlank));
  $('onlineTableMoreRows').addEventListener('click',()=>void action($('onlineTableMoreRows'),async()=>{await focusOnlineBlank();addBlankRows(20);return'已增加 20 行空白录入行；只有填写链接的行计入商品。';}));
  $('onlineTableSaveAll').addEventListener('click',()=>void action($('onlineTableSaveAll'),async()=>{
    const newIds=[...dirtyRows].filter(id=>onlineRowById(id)?.isNew),existingIds=[...dirtyRows].filter(id=>!onlineRowById(id)?.isNew);let saved=0;
    for(const id of existingIds){const row=onlineRowById(id);if(row&&await saveOnlineRow(row))saved++;}
    const lastIndex=Math.max(-1,...newIds.map(id=>onlineBlankRows.findIndex(row=>row.id===id)));
    saved+=await saveBlankPrefix(lastIndex);for(const id of newIds)if(!hasRowContent(onlineRowById(id)?readRowInput(onlineRowById(id)):{}))dirtyRows.delete(id);
    await loadOnlineRows(onlineOffset);return saved?`已保存 ${saved} 行，商品数量按链接统计。`:'没有需要保存的内容。';
  }));
  $('onlineTableSearchButton').addEventListener('click',()=>void action($('onlineTableSearchButton'),()=>findOnline(0)));
  $('onlineTableSearchPrev').addEventListener('click',()=>void action($('onlineTableSearchPrev'),()=>findOnline(-1)));
  $('onlineTableSearchNext').addEventListener('click',()=>void action($('onlineTableSearchNext'),()=>findOnline(1)));
  $('onlineTableSearchClear').addEventListener('click',()=>{clearOnlineFind();onlineMessage('已清除查找条件。');});
  $('onlineTableSearch').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();void action($('onlineTableSearchButton'),()=>findOnline(0));}});
  $('onlineTableGoButton').addEventListener('click',()=>void action($('onlineTableGoButton'),async()=>{const position=Number($('onlineTableGoRow').value);if(!Number.isInteger(position)||position<1)throw new Error('请输入有效的行号');const result=await window.desktop.locateOnlineTableRow({position});await loadOnlineRows(Math.floor(result.offset/100)*100);highlightOnlineRow(result.row.id,[],true);return`已跳到第 ${result.row.position} 行。`;}));
  $('onlineTableGoRow').addEventListener('keydown',event=>{if(event.key==='Enter')$('onlineTableGoButton').click();});
  $('onlineAddCancel').addEventListener('click',()=>$('onlineAddRowDialog').close());
  function openOnlineRow(row=null){
    const form=$('onlineAddRowForm');form.reset();form.dataset.rowId=row?.id||'';form.dataset.version=row?.version||'';
    for(const [key,id] of [['articleNo','onlineAddArticleNo'],['sourceType','onlineAddSourceType'],['sourceUrl','onlineAddSourceUrl'],['title','onlineAddTitle'],['note','onlineAddNote']]){$(id).value=row?.[key]||'';$(id).readOnly=!!row?.taskId&&['articleNo','sourceUrl'].includes(key);}
    $('onlineAddSourceType').disabled=!!row?.taskId;
    for(const [key] of onlineExtraFields){$('onlineField_'+key).value=row?.[key]||'';$('onlineField_'+key).readOnly=!!row?.taskId&&['selectDate','tableId'].includes(key);}
    $('onlineAddRowTitle').textContent=row?.isNew?'编辑空白行':row?'编辑在线表商品':'新增在线表内容';form.querySelector('button[type=submit]').textContent=row?'保存修改':'写入共享表';$('onlineAddMessage').textContent='';$('onlineAddRowDialog').showModal();
  }
  $('onlineAddRowForm').addEventListener('submit',event=>{event.preventDefault();void action(event.submitter,async()=>{
    const form=$('onlineAddRowForm'),rowId=form.dataset.rowId,row=onlineRowById(rowId),data={articleNo:$('onlineAddArticleNo').value.trim(),sourceType:$('onlineAddSourceType').value,sourceUrl:$('onlineAddSourceUrl').value.trim(),title:$('onlineAddTitle').value.trim(),note:$('onlineAddNote').value.trim(),...Object.fromEntries(onlineExtraFields.map(([key])=>[key,$('onlineField_'+key).value.trim()]))};
    if(row?.isNew){if(!hasRowContent(data))throw new Error('内容全部为空，暂不写入云端。');Object.assign(row,data);for(const field of onlineFields)onlineRowElement(row.id).querySelector(`[data-field="${field}"]`).value=data[field];await saveOnlineRow(row);}
    else if(rowId){const patch=Object.fromEntries(Object.entries(data).filter(([key,value])=>value!==String(row?.[key]||'')));if(Object.keys(patch).length)await window.desktop.updateOnlineTableRow({rowId,version:Number(form.dataset.version),patch});}
    else await window.desktop.importOnlineTableRows([data]);
    dirtyRows.delete(rowId);$('onlineAddRowDialog').close();await loadOnlineRows(onlineOffset);return rowId?'修改已保存并留痕。':'内容已写入共享表。';
  });});
  $('onlineTableGrid').addEventListener('input',event=>markOnlineDirty(event.target));
  $('onlineTableGrid').addEventListener('click',event=>{const tr=event.target.closest('[data-online-row]'),button=event.target.closest('button');if(!tr||!button)return;const row=onlineRowById(tr.dataset.onlineRow);if(!row)return;void action(button,async()=>{
    if(button.classList.contains('online-save-row')){const saved=await saveOnlineRow(row);await loadOnlineRows(onlineOffset);return saved?'已保存，商品数量只按链接统计。':'空白行未写入云端。';}
    if(button.classList.contains('online-cancel-row')){dirtyRows.delete(row.id);if(row.isNew)for(const key of onlineAllFields)row[key]='';await loadOnlineRows(onlineOffset);return row.isNew?'已清空空白行。':'已撤销此行尚未保存的输入。';}
    if(button.classList.contains('online-details-row')){if(!row.isNew&&dirtyRows.has(row.id))throw new Error('请先保存或撤销此行输入，再编辑更多字段。');if(row.isNew)Object.assign(row,readRowInput(row));openOnlineRow(row);return'';}
    if(dirtyRows.has(row.id))throw new Error('请先保存或撤销此行输入，再确认或删除。');
    if(button.classList.contains('online-open-source-link')){await window.desktop.openProductDetail(row.sourceUrl);return'已在默认浏览器打开商品链接；若需自动处理，请确认本机浏览器插件已连接。';}
    if(button.classList.contains('online-open-local-task')){await openOnlineFlow(row);return'已打开该商品当前流程。';}
    if(button.classList.contains('online-restart-local-task')){const result=await window.desktop.restartOnlineTableTask({rowId:row.id,version:row.version,previousTaskId:button.dataset.taskId});if(result.canceled)return'已取消，原共享表任务未更改。';await loadOnlineRows(onlineOffset);$('navBuyer').click();showDetail(await window.desktop.buyerTaskDetail(result.taskId));return'已在本机重新开始该商品，自动流程正在读取链接图片。';}
    if(button.classList.contains('online-delete-row')){const result=await window.desktop.deleteOnlineTableRow({rowId:row.id,version:row.version});if(result.canceled)return'';await loadOnlineRows(onlineOffset);return'已删除商品行；管理员可从修改记录中恢复。';}
    if(button.classList.contains('online-approve-row')){if(!row.sourceUrl)throw new Error('请先填写商品链接，再确认并提交');await window.desktop.approveOnlineTableRow({rowId:row.id,version:row.version,approved:true});await loadOnlineRows(onlineOffset);return'人工确认已记录，自动流程正在启动。';}
    if(button.classList.contains('online-reject-row')){await window.desktop.approveOnlineTableRow({rowId:row.id,version:row.version,approved:false});await loadOnlineRows(onlineOffset);return'已驳回该行。';}
  });});
  $('onlineTableGrid').addEventListener('click',event=>{const tr=event.target.closest('[data-online-row]');if(!tr||event.target.closest('button,a,input:not([readonly]),textarea,select,label')||window.getSelection()?.toString())return;const row=onlineRowById(tr.dataset.onlineRow);if(!row||row.isNew)return;void openOnlineFlow(row).catch(error=>onlineMessage(errorText(error),true));});
  $('onlineTableGrid').addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.matches('tr[data-online-row]')){event.preventDefault();const row=onlineRowById(event.target.dataset.onlineRow);if(row&&!row.isNew)void openOnlineFlow(row).catch(error=>onlineMessage(errorText(error),true));}});
  $('onlineTableGrid').addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.matches('.online-edit')){event.preventDefault();event.target.closest('tr').querySelector('.online-save-row').click();}});
  async function loadHistory(before=''){
    const result=await window.desktop.loadOnlineTableHistory({limit:50,before}),names={import:'新增/导入',update:'修改',claim:'领取任务',delete:'删除行',clear:'清空',rollback:'回档'};historyNext=result.nextBefore;
    const html=(result.history||[]).map(item=>`<article class="online-history-item"><div><strong>#${esc(item.id)} · ${esc(names[item.action]||item.action)}</strong><small>${esc(new Date(item.createdAt).toLocaleString('zh-CN'))} · ${esc(item.actor||'未知用户')} · 操作前 ${esc(item.rowCount)} 行</small><p>${esc(item.summary||'')}</p></div><div class="online-history-actions"><button type="button" class="secondary online-history-detail" data-history-id="${item.id}">查看变更</button>${snapshot?.user?.isAdmin?`<button type="button" class="secondary online-history-rollback" data-history-id="${item.id}">恢复操作前内容</button>`:''}</div></article>`).join('');
    if(before)$('onlineHistoryList').insertAdjacentHTML('beforeend',html);else $('onlineHistoryList').innerHTML=html||'<p class="muted">还没有修改记录；启用记录前的操作不会补录。</p>';
    $('onlineHistoryMore').hidden=historyNext===null;
  }
  $('onlineTableHistory').addEventListener('click',()=>void action($('onlineTableHistory'),async()=>{await loadHistory();$('onlineHistoryMessage').textContent='';$('onlineHistoryDetails').innerHTML='';$('onlineHistoryDialog').showModal();return'';}));
  $('onlineHistoryMore').addEventListener('click',()=>void action($('onlineHistoryMore'),async()=>{await loadHistory(historyNext);return'';}));
  $('onlineHistoryClose').addEventListener('click',()=>$('onlineHistoryDialog').close());
  $('onlineHistoryList').addEventListener('click',event=>{const button=event.target.closest('[data-history-id]');if(!button)return;void action(button,async()=>{
    if(button.classList.contains('online-history-detail')){const result=await window.desktop.loadOnlineTableHistoryDetail(button.dataset.historyId),names={articleNo:'货号',sourceUrl:'商品链接',title:'标题',note:'备注',humanStatus:'人工确认',taskId:'任务编号',automationState:'处理状态',automationError:'处理异常',erpProductNo:'互拓编码',...Object.fromEntries(onlineExtraFields),deleted:'已删除'};$('onlineHistoryDetails').innerHTML=`<h3>记录 #${esc(button.dataset.historyId)} 的变更</h3>`+(result.changes||[]).slice(0,100).map(change=>`<article><strong>${esc(change.after?.articleNo||change.before?.articleNo||change.rowId)} · ${!change.before?'新增':change.after?.deleted?'删除':change.before?.deleted?'恢复':'修改'}</strong>${Object.entries(names).filter(([key])=>change.before?.[key]!==change.after?.[key]).map(([key,label])=>`<p>${label}：<del>${esc(change.before?.[key]??'空')}</del> → <ins>${esc(change.after?.[key]??'空')}</ins></p>`).join('')}</article>`).join('');return'';}
    if(dirtyRows.size)throw new Error('请先保存或撤销表格中尚未保存的输入，再回档。');const result=await window.desktop.rollbackOnlineTable(button.dataset.historyId);if(result.canceled)return'';$('onlineHistoryDialog').close();await loadOnlineRows(0);return`已恢复记录 #${result.historyId} 操作前的内容，恢复前状态已留痕。`;
  });});
  $('onlineTableGrid').addEventListener('focusin',event=>{const tr=event.target.closest('[data-online-row]');if(tr&&onlineBlankRows.slice(-2).some(row=>row.id===tr.dataset.onlineRow))addBlankRows(20);});
  $('onlineTableViewport').addEventListener('scroll',()=>{
    const view=$('onlineTableViewport');if(!onlineTableInfo||busy||onlineLoadingRows||view.scrollHeight-view.clientHeight-view.scrollTop>160)return;
    if(onlineNextOffset===null){addBlankRows(20);return;}
    if(!dirtyRows.size)void action($('onlineTableNext'),async()=>{const oldRows=onlineRows,result=await window.desktop.loadOnlineTableRows({offset:onlineNextOffset,limit:100});renderOnlineRows({...result,rows:oldRows.concat(result.rows)});return '';});
  });
  $('onlineTableGrid').addEventListener('paste',event=>{
    const input=event.target;if(!input.matches('.online-edit')||input.readOnly||busy||onlineLoadingRows)return;
    const text=event.clipboardData?.getData('text/plain')||'';if(!/[\t\r\n]/.test(text))return;
    const lines=text.replace(/\r\n?/g,'\n').replace(/\n$/,'').split('\n').map(line=>line.split('\t'));
    event.preventDefault();if(lines.length>1000||text.length>2*1024*1024)return onlineMessage('单次请粘贴不超过 1000 行、2MB 的内容，可分批继续。',true);
    const tr=input.closest('[data-online-row]'),start=onlineRows.concat(onlineBlankRows).findIndex(row=>row.id===tr.dataset.onlineRow),column=onlineFields.indexOf(input.dataset.field);
    if(lines.some(line=>line.length>onlineFields.length-column))return onlineMessage('粘贴列数超出货号、商品链接、标题、备注这四列，请从对应列开始。',true);
    if(onlineNextOffset!==null&&start+lines.length>onlineRows.length)return onlineMessage('请先加载下一页，再粘贴跨页内容。',true);
    if(start+lines.length>onlineRows.length+onlineBlankRows.length)addBlankRows(start+lines.length-onlineRows.length-onlineBlankRows.length+12);
    const all=onlineRows.concat(onlineBlankRows),changes=[];
    for(let i=0;i<lines.length;i++)for(let j=0;j<lines[i].length;j++){
      const row=all[start+i],target=onlineRowElement(row.id)?.querySelector(`[data-field="${onlineFields[column+j]}"]`);
      if(!target||target.readOnly)return onlineMessage('粘贴区域含已领取任务的只读字段，本次未写入。',true);
      if(lines[i][j].length>Number(target.maxLength))return onlineMessage('粘贴内容超过单元格长度限制，本次未写入。',true);
      changes.push([target,lines[i][j]]);
    }
    for(const [target,value] of changes){target.value=value;markOnlineDirty(target);}
    onlineMessage(`已粘贴 ${lines.length} 行，请点击“保存未保存行”。`);
  });
  $('buyerPage').addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'&&!$('onlineAddRowDialog').open&&!$('onlineHistoryDialog').open){event.preventDefault();$('onlineTableSearch').focus();$('onlineTableSearch').select();}});
  setInterval(()=>{if(snapshot?.authenticated&&!busy&&!dirtyRows.size&&!onlineLoadingRows&&!$('onlineTableGrid').contains(document.activeElement)&&!$('onlineHistoryDialog').open&&!$('onlineAddRowDialog').open)void loadOnlineTables().catch(()=>{});},10000);
  $('onlineTableImportLocal').addEventListener('click',()=>void action($('onlineTableImportLocal'),async()=>{if(dirtyRows.size)throw new Error('请先保存或撤销表格输入，再导入文件。');const preview=await window.desktop.previewBuyerTable();if(!preview)return'';const rows=preview.rows.filter(row=>!row.errors.length).map(row=>({articleNo:row.articleNo,sourceType:row.sourceType,sourceUrl:row.sourceUrl,title:row.title||'',note:row.note||'',selectDate:row.selectDate,tableId:row.tableId,supplierName:row.supplierName,externalCode:row.externalCode,selectOperator:row.selectOperator,buyerOperator:row.buyerOperator,...row.tableFields}));if(!rows.length)throw new Error('本地表格没有有效商品链接');const result=await window.desktop.importOnlineTableRows(rows);await loadOnlineRows(0);return`已导入 ${result.imported} 行；异常行未写入在线表格。`;}));
  $('onlineTableExport').addEventListener('click',()=>void action($('onlineTableExport'),async()=>{const result=await window.desktop.exportOnlineTable();return result?`已导出 ${result.rows} 行：${result.filePath}`:'';}));
  $('onlineTablePrev').addEventListener('click',()=>void action($('onlineTablePrev'),async()=>{await loadOnlineRows(Math.max(0,onlineOffset-100));return'';}));
  $('onlineTableNext').addEventListener('click',()=>void action($('onlineTableNext'),async()=>{if(onlineNextOffset!==null)await loadOnlineRows(onlineNextOffset);return'';}));
  $('buyerImportTable').addEventListener('click',()=>void action($('buyerImportTable'),async()=>{preview=await window.desktop.previewBuyerTable();if(!preview)return'';const rows=preview.rows;$('buyerImportTitle').textContent=`${preview.fileName} · ${rows.length}行`;$('buyerImportRows').innerHTML=rows.slice(0,100).map(row=>`<tr><td>${esc(row.selectDate||'未填写')}</td><td>${esc(row.tableId||'')}</td><td>${esc(row.externalCode||'')}</td><td>${esc(row.sheetName)} / ${row.rowNumber}</td><td>${esc(row.articleNo||'待从供应商读取')}</td><td>${esc(({taobao:'淘宝/天猫',douyin:'抖音',wsy:'网商园',zwd:'17网',qcc:'青创网',e3hui:'衣衫汇'})[row.sourceType]||'无法识别')}</td><td>${esc(row.errors.join('；')||row.tags.join('、')||'可导入')}</td></tr>`).join('');$('buyerImportCounts').textContent=`有效 ${rows.filter(row=>!row.errors.length).length} 行，异常 ${rows.filter(row=>row.errors.length).length} 行。日期和表格ID用于商品文件夹命名；商品编码保留为来源编码。`;$('buyerImportDialog').showModal();return'';}));
  $('buyerImportCancel').addEventListener('click',()=>$('buyerImportDialog').close());
  $('buyerAddLink').addEventListener('click',()=>{$('buyerSingleLinkValue').value='';$('buyerSingleLinkError').textContent='';$('buyerSingleLinkDialog').showModal();});
  $('buyerSingleLinkCancel').addEventListener('click',()=>$('buyerSingleLinkDialog').close());
  $('buyerSingleLinkForm').addEventListener('submit',event=>{event.preventDefault();void action($('buyerSingleLinkStart'),async()=>{try{const result=await window.desktop.addBuyerLink($('buyerSingleLinkValue').value),current=await window.desktop.snapshot();if(current.vision?.configured&&current.buyerSettings?.configured)await window.desktop.startBuyerAuto([result.taskId]);$('buyerSingleLinkDialog').close();return result.duplicate?'已找到原任务，保留原进度。':'商品链接已加入自动队列，可以直接查看六阶段进度。';}catch(error){$('buyerSingleLinkError').textContent=errorText(error);throw error;}});});
  $('buyerImportConfirm').addEventListener('click',()=>void action($('buyerImportConfirm'),async()=>{if(!preview)return'';const batchId=preview.batchId,result=await window.desktop.confirmBuyerTable(preview.batchId);preview=null;$('buyerImportDialog').close();const current=await window.desktop.snapshot(),ids=current.buyerTasks.filter(task=>task.origin?.batchId===batchId&&task.automation?.state==='queued').map(task=>task.id);if(ids.length&&current.vision?.configured&&current.buyerSettings?.configured){await window.desktop.startBuyerAuto(ids);return`已导入并自动处理 ${ids.length} 行；有例外会打标签，不影响下一件。`;}return`已导入 ${result.imported} 行。先完成视觉模型和互拓账号配置，再继续自动队列。`;}));
  $('buyerAutoStart').addEventListener('click',()=>void action($('buyerAutoStart'),async()=>{const checked=[...document.querySelectorAll('#buyerTaskList .buyer-select:checked')].map(node=>node.closest('[data-buyer-task]').dataset.buyerTask);const ids=checked.length?checked:tasksForScope(snapshot).filter(task=>task.automation&&!['attention','completed'].includes(task.automation.state)).map(task=>task.id);await window.desktop.startBuyerAuto(ids);return'自动处理已启动。资料完整时进入互拓待审核；有例外会标记并继续下一件。';}));
  $('buyerAutoPause').addEventListener('click',()=>void action($('buyerAutoPause'),async()=>{await window.desktop.pauseBuyerAuto();return'已暂停新步骤，当前已发出的请求会保存结果。';}));
  $('buyerAutoResume').addEventListener('click',()=>void action($('buyerAutoResume'),async()=>{await window.desktop.resumeBuyerAuto();return'自动队列已继续。';}));
  $('buyerExportRows').addEventListener('click',()=>void action($('buyerExportRows'),async()=>{const file=await window.desktop.exportBuyerRows();return file?'回填结果已导出：'+file:'';}));
  $('buyerTemplateExport').addEventListener('click',()=>void action($('buyerTemplateExport'),async()=>{const file=await window.desktop.exportBuyerTemplate();return file?'测试模板已保存：'+file:'';}));
  $('buyerAutoSetup').addEventListener('click',()=>$('navSettings').click());
  $('buyerConfigSelectRoot').addEventListener('click',()=>void action($('buyerConfigSelectRoot'),async()=>{const folder=await window.desktop.selectBuyerRoot();if(folder){await window.desktop.saveBuyerSettings({productRootDir:folder});$('buyerConfig_productRootDir').value=folder;}return folder?'买手资料根目录已保存。':'未修改买手资料根目录。';}));
  $('buyerManagedErpRefresh').addEventListener('click',()=>void action($('buyerManagedErpRefresh'),async()=>{const result=await window.desktop.refreshBuyerErp();return result.configured?'互拓连接已刷新。':result.managedError||'请在账号页面保存互拓账号和密码。';}));
  $('buyerErpAccountPage').addEventListener('click',()=>void action($('buyerErpAccountPage'),async()=>{await window.desktop.openBuyerErpAccountPage();return'已打开互拓账号页面；只需填写账号和密码。';}));
  function renderDetailChrome(task){
    const a=task.automation||{},stage=stageGroups.findIndex(([,keys])=>keys.includes(a.step)),signature=JSON.stringify([task.id,task.sourceTitle,task.articleNo,task.onlineTableRowId,a.step,a.state,a.error,a.waitingReason,task.origin]);
    if(signature===detailChromeSignature)return;detailChromeSignature=signature;
    $('buyerAutoDetailTitle').textContent=task.sourceTitle||task.articleNo||'商品流程';
    if(detailImageTask!==task.id){detailImageTask=task.id;const image=$('buyerDetailImage');image.hidden=true;image.removeAttribute('src');if(!task.readOnly)void window.desktop.buyerTaskComparisonPreview(task.id,[]).then(result=>{if(currentTask?.id===task.id&&result.sourceImage){image.src=result.sourceImage;image.hidden=false;}}).catch(()=>{});}
    $('buyerDetailReturnRow').hidden=!task.onlineTableRowId;
    $('buyerDetailStatus').textContent=`${task.origin?.sheetName||'本地商品'}${task.origin?.rowNumber?' · 第'+task.origin.rowNumber+'行':''} · ${onlineAutomationLabel(a.state)} · 当前：${steps[a.step]||a.step||'等待开始'}`;
    $('buyerDetailTrack').innerHTML=stageGroups.map(([label],index)=>`<li class="${a.state==='completed'||index<stage?'done':index===stage?'current':''}" ${index===stage?'aria-current="step"':''}><span>${index+1}</span>${esc(label)}</li>`).join('');
    $('buyerDetailNav').innerHTML=[['overview','当前步骤'],['candidates','供应商图片'],['platforms','平台状态'],['facts','供货资料'],['history','处理记录']].map(([section,label])=>`<button type="button" class="secondary" data-detail-section="${section}">${label}</button>`).join('');
  }
  function detailSectionTarget(section){
    if(section==='overview'){const step=currentTask?.automation?.step;if(['supplier_search','supplier_compare'].includes(step)&&$('buyerDetailCandidates'))return $('buyerDetailCandidates');if(['supplier_details','supplier_facts'].includes(step))return $('buyerSupplyFactsForm')||$('buyerDetailFacts');}
    if(section==='facts'&&$('buyerSupplyFactsForm'))return $('buyerSupplyFactsForm');
    return $({overview:'buyerDetailOverview',candidates:'buyerDetailCandidates',platforms:'buyerDetailPlatforms',facts:'buyerDetailFacts',history:'buyerDetailHistory'}[section]);
  }
  function showDetail(task){const sameTask=currentTask?.id===task.id&&$('buyerAutoDetailDialog').open,scrollTop=sameTask?$('buyerAutoDetailBody').scrollTop:0,historyOpen=sameTask&&$('buyerDetailHistory')?.open;currentTask=task;const a=task.automation;renderDetailChrome(task);const suppliers=a.supplierCandidates||[],facts=a.facts||{};
    supplierPreviewPages.set(task.id,supplierPreviewPages.get(task.id)||0);
    $('buyerAutoDetailBody').innerHTML=`<section id="buyerDetailOverview"><p class="muted">${esc(task.origin?.sheetName||'')} 第${esc(task.origin?.rowNumber||'—')}行 · ${esc(steps[a.step]||a.step)}</p>${task.productFolder?'<p>商品文件夹：'+esc(task.productFolder)+'</p>':''}${a.supplierSelection?.method==='manual'?'<p class="buyer-manual-decision">你已人工确认供应商同款：'+esc(a.supplierSelection.detailUrl)+'</p>':''}<p>${esc(taskMessage(a))}</p>${helpActions(task,true)}${!task.readOnly&&a.state==='attention'?'<div class="buyer-task-actions"><button type="button" class="secondary buyer-detail-retry">继续原任务 / 重试未完成项</button></div>':''}</section>${supplierComparisonPanel(task)}${a.missing?.length?'<p class="buyer-auto-error">待补：'+esc(a.missing.join('、'))+'</p>':''}<div id="buyerDetailFacts" class="buyer-detail-facts"><p>供应商：${esc(facts.supplierName||'待取得')}</p><p>货号：${esc(facts.articleNo||task.articleNo||'待取得')}</p><p>供货价：${facts.cost==null?'待核实':'¥'+esc(facts.cost)}</p><p>颜色：${esc(facts.colors?.join('、')||'待取得')}</p><p>尺码：${esc(facts.sizes?.join('、')||'待取得')}</p><p>成分：${esc(facts.materials?.map(row=>row.name+row.rate+'%').join('、')||'待取得')}</p></div>${suppliers.length?'<h3>模型证据充分的同款候选</h3>'+suppliers.map((item,index)=>`<div class="buyer-market-result"><img src="${esc(item.imageEvidence?.sourceUrl||item.imageUrl)}" alt="供应商候选图" loading="lazy" referrerpolicy="no-referrer"><div><strong>${esc(item.shopName||item.title)}</strong><small>匹配分 ${esc(item.visualComparison?.score)} · ${item.price==null?'价格未知':'¥'+esc(item.price)}</small><button class="secondary buyer-detail-select-supplier" data-index="${index}" type="button">选择此供应商并继续</button></div></div>`).join(''):''}<details id="buyerDetailHistory"><summary>处理记录</summary>${(task.events||[]).slice(-50).map(event=>'<p class="muted">'+esc(new Date(event.at).toLocaleString('zh-CN',{hour12:false}))+' · '+esc(event.message)+'</p>').join('')}</details>`;
    const quality=a.supplierDetails?.quality;if(quality){const summary=document.createElement('p');summary.className='muted';summary.textContent=`供应商详情采集：${quality.state==='complete'?'资料齐全':'部分资料缺失'}${quality.missingFields?.length?' · '+quality.missingFields.join('、'):''} · 详情图 ${quality.imageCoverage?.detailImages??'未知'}/${quality.imageCoverage?.detailNodes??'未知'}`;$('buyerAutoDetailBody').querySelector('.buyer-detail-facts')?.before(summary);}
    if((a.searchCandidates||[]).length&&['supplier_search','supplier_compare'].includes(a.step))void loadComparisonImages(task);
    if(a.state==='attention'&&a.supplierDetails){
      const platformNames={wsy:'网商园',zwd:'17网',qcc:'青创网',e3hui:'衣衫汇'},detailUrl=a.supplierDetails.url||a.supplier?.detailUrl||'';
      const listedPrice=a.supplierDetails.price==null?'价格待核实':`${a.supplierDetails.priceType==='tiered'?'阶梯价':'页面供货价'} ¥${a.supplierDetails.price}`;
      const sourceLink=detailUrl?`<a href="${esc(detailUrl)}" target="_blank" rel="noreferrer">打开当前${esc(platformNames[a.supplier?.platform]||'供应商')}商品页</a>`:'';
      const form=document.createElement('form');form.id='buyerSupplyFactsForm';form.innerHTML=`<h3>补充已核实的供货资料</h3><p class="muted">当前来源：${esc(platformNames[a.supplier?.platform]||a.supplier?.platform||'供应平台')} · ${esc(a.supplierDetails.title||a.supplier?.title||'')} · ${esc(listedPrice)} · 货号 ${esc(a.supplierDetails.sku||'待取得')} · ${esc(a.supplierDetails.shopName||'档口待核对')}</p>${sourceLink}<p class="muted">只需处理缺项或冲突；保存后继续当前商品，其余商品继续自动运行。</p><div class="form-grid"><label>供应商货号<input name="articleNo" value="${esc(facts.articleNo||task.articleNo||a.supplierDetails.sku||'')}" required maxlength="64"></label><label>供应商名称<input name="supplierName" value="${esc(facts.supplierName||a.supplierDetails.shopName||'')}" required maxlength="300"></label><label>已核实供货价<input name="cost" type="number" min="0.01" max="1000" step="0.01" value="${facts.cost??(a.supplierDetails.priceType!=='tiered'?a.supplierDetails.price??'':'')}" required></label><label>供应仓库<input name="warehouse" value="${esc(facts.warehouse||'')}" placeholder="例如：广州仓"></label><label>可供颜色（每行一个）<textarea name="colors" rows="3" required>${esc((facts.colors?.length?facts.colors:a.supplierDetails.colors||[]).join('\n'))}</textarea></label><label>可供尺码（空格分隔）<input name="sizes" value="${esc((facts.sizes?.length?facts.sizes:a.supplierDetails.sizes||[]).join(' '))}" required></label><label>成分及比例（每行：名称 比例）<textarea name="materials" rows="3" placeholder="棉 100" required>${esc(facts.materials?.map(row=>row.name+' '+row.rate).join('\n')||'')}</textarea></label><label>商品类型<select name="fork"><option value="0" ${facts.fork===0?'selected':''}>公版</option><option value="1" ${facts.fork===1?'selected':''}>专版</option></select></label><label>供应商尺码图<select name="sizeImageIndex">${(a.supplierDetails.images||[]).map((url,index)=>`<option value="${index}" ${url===facts.sizePic?'selected':''}>供应商图片 ${index+1}</option>`).join('')}</select></label></div><p id="buyerSupplyFactsError" class="message" role="alert"></p><button type="submit">保存并继续当前商品</button>`;
      form.addEventListener('submit',event=>{event.preventDefault();const data=new FormData(form);void action(form.querySelector('button[type=submit]'),async()=>{const materials=String(data.get('materials')).split(/\r?\n/).filter(Boolean).map(row=>{const match=row.trim().match(/^(.+?)\s+(\d+(?:\.\d+)?)%?$/);if(!match)throw new Error('成分请按每行“棉 100”的格式填写');return{name:match[1],rate:Number(match[2])};});const input={articleNo:data.get('articleNo'),supplierName:data.get('supplierName'),cost:Number(data.get('cost')),warehouse:data.get('warehouse'),colors:String(data.get('colors')).split(/\r?\n/).map(value=>value.trim()).filter(Boolean),sizes:String(data.get('sizes')).split(/\s+/).filter(Boolean),materials,fork:Number(data.get('fork')),sizeImageIndex:Number(data.get('sizeImageIndex'))};try{const result=await window.desktop.saveBuyerFacts(task.id,input);$('buyerAutoDetailDialog').close();return result.continued?'已补齐供货资料并继续当前商品。':'补充资料已保存，特殊类别的证明仍待核实。';}catch(error){$('buyerSupplyFactsError').textContent=errorText(error);throw error;}});});
      $('buyerAutoDetailBody').append(form);
    }
    if(!$('buyerAutoDetailDialog').open)$('buyerAutoDetailDialog').showModal();
    if(historyOpen&&$('buyerDetailHistory'))$('buyerDetailHistory').open=true;
    $('buyerAutoDetailBody').scrollTop=scrollTop;
    for(const button of $('buyerDetailNav').querySelectorAll('[data-detail-section]'))button.disabled=!detailSectionTarget(button.dataset.detailSection);
  }
  async function loadComparisonImages(task){
    const targetId=task.id,body=$('buyerAutoDetailBody'),nodes=[...body.querySelectorAll('[data-preview-index]')],indexes=nodes.map(node=>Number(node.dataset.previewIndex));if(!indexes.length)return;
    if(supplierPreviewBusy.has(targetId)){supplierPreviewQueued.add(targetId);return;}supplierPreviewBusy.add(targetId);
    try{const result=await window.desktop.buyerTaskComparisonPreview(targetId,indexes);if(!body.isConnected||currentTask?.id!==targetId)return;const source=body.querySelector('[data-source-preview]'),sourceState=body.querySelector('[data-source-preview-state]'),sourceReady=!!result.sourceImage;if(source&&sourceReady)source.src=result.sourceImage;if(sourceState)sourceState.textContent=sourceReady?`原图已读取；商品链接共识别 ${result.sourceGalleryCount||1} 张图片${result.sourceGalleryFailed?`，${result.sourceGalleryFailed} 张详情图未能加载`:''}`:'商品链接主图暂不可读取';const sourceGallery=body.querySelector('[data-source-gallery]');if(sourceGallery)sourceGallery.innerHTML=(result.sourceGallery||[]).map((item,index)=>`<img src="${esc(item.image)}" alt="商品图片 ${index+1}" loading="lazy" title="商品图片 ${index+1}${item.width&&item.height?` · ${item.width}×${item.height}`:''}">`).join('');const sourceRetry=body.querySelector('.buyer-source-gallery-retry');if(sourceRetry)sourceRetry.hidden=!result.sourceGalleryFailed;for(const candidate of result.candidates||[]){const node=body.querySelector(`[data-preview-index="${candidate.index}"]`),status=node?.closest('.buyer-compare-image-wrap')?.querySelector('.buyer-image-loading'),buttons=node?.closest('.buyer-compare-candidate')?.querySelectorAll('.buyer-supplier-choice'),gallery=body.querySelector(`[data-candidate-gallery="${candidate.index}"]`),galleryStatus=body.querySelector(`[data-candidate-gallery-status="${candidate.index}"]`),galleryButton=body.querySelector(`.buyer-load-gallery[data-index="${candidate.index}"]`);if(!node)continue;if(candidate.image){node.src=candidate.image;if(status)status.textContent=`${candidate.imageWidth||''}×${candidate.imageHeight||''}`;buttons?.forEach(button=>button.disabled=!sourceReady);}else{if(status)status.textContent=candidate.error||'候选图暂不可读取';buttons?.forEach(button=>{button.disabled=true;button.title='候选图片未加载，无法进行人工判断';});}if(gallery)gallery.innerHTML=(candidate.galleryImages||[]).map((item,index)=>`<img src="${esc(item.image)}" alt="供应商商品图片 ${index+1}" loading="lazy" title="供应商商品图片 ${index+1}${item.width&&item.height?` · ${item.width}×${item.height}`:''}">`).join('');if(galleryStatus)galleryStatus.textContent=candidate.galleryState==='ready'?`商品链接共识别 ${candidate.galleryCount||0} 张详情图${candidate.galleryFailed?`，${candidate.galleryFailed} 张无法加载`:''}`:candidate.galleryState==='waiting'?'已提交浏览器读取商品链接，正在等待图片…':candidate.galleryState==='failed'?`读取失败：${candidate.galleryError||'请检查平台登录状态后重试'}`:'从商品页面读取详情图集以便核对';if(galleryButton&&candidate.galleryState==='waiting'){galleryButton.disabled=true;galleryButton.dataset.requested='1';galleryButton.textContent='正在读取商品图集…';}if(galleryButton&&candidate.galleryState==='ready'&&!candidate.galleryFailed)galleryButton.hidden=true;if(galleryButton&&candidate.galleryState==='ready'&&candidate.galleryFailed){galleryButton.textContent='重试加载未成功图片';galleryButton.dataset.retry='1';galleryButton.disabled=false;}if(galleryButton&&candidate.galleryState==='failed'){galleryButton.textContent='重试读取商品图集';galleryButton.dataset.retry='1';galleryButton.disabled=false;}}}
    catch(error){const state=body.querySelector('[data-source-preview-state]');if(state)state.textContent='图片对照暂不可用：'+errorText(error);}finally{supplierPreviewBusy.delete(targetId);if(supplierPreviewQueued.delete(targetId)&&body.isConnected&&currentTask?.id===targetId)setTimeout(()=>void loadComparisonImages(currentTask),0);}
  }
  function showBuyerGalleryImage(image){
    let dialog=$('buyerGalleryImageDialog');
    if(!dialog){dialog=document.createElement('dialog');dialog.id='buyerGalleryImageDialog';dialog.className='buyer-gallery-full-dialog';dialog.innerHTML='<div class="buyer-gallery-full-heading"><strong></strong><button type="button" class="secondary">关闭</button></div><img alt="商品图片放大预览">';document.body.append(dialog);dialog.querySelector('button').addEventListener('click',()=>dialog.close());dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});}
    dialog.querySelector('strong').textContent=image.alt||'商品图片';dialog.querySelector('img').src=image.currentSrc||image.src;dialog.showModal();
  }
  document.addEventListener('click',event=>{
    if(event.target.closest('.buyer-source-gallery-retry')){if(currentTask)void loadComparisonImages(currentTask);return;}
    const galleryImage=event.target.closest('.buyer-gallery-grid img,.buyer-compare-image,[data-source-preview]');if(galleryImage){showBuyerGalleryImage(galleryImage);return;}
    const button=event.target.closest('.buyer-plugin-help,.buyer-open-source,.buyer-detail-retry,.buyer-platform-login,.buyer-retry-platform-search,.buyer-confirm-candidate,.buyer-more-candidates,.buyer-open-comparison,.buyer-open-comparison-card,.buyer-open-candidate,.buyer-reject-candidate,.buyer-restore-candidate,.buyer-load-gallery');if(!button)return;
    if(button.classList.contains('buyer-load-gallery')){const id=button.closest('[data-buyer-task]')?.dataset.buyerTask||currentTask?.id,index=Number(button.dataset.index),targetId=id,body=$('buyerAutoDetailBody'),status=body.querySelector(`[data-candidate-gallery-status="${index}"]`);button.disabled=true;button.textContent='正在请求商品链接图集…';if(status)status.textContent='正在配对浏览器中打开商品页面读取图片…';void(async()=>{try{let state=await window.desktop.loadBuyerSupplierGallery(id,index,button.dataset.retry==='1');if(state.state==='failed')throw new Error(state.error||'读取商品图片失败');if(state.state!=='ready'){for(let attempt=0;attempt<180;attempt++){if(!body.isConnected||currentTask?.id!==targetId)return;await new Promise(resolve=>setTimeout(resolve,1000));state=await window.desktop.buyerSupplierGalleryStatus(id,index);if(state.state==='ready')break;if(state.state==='failed')throw new Error(state.error||'读取商品图片失败');if(status)status.textContent='正在等待配对浏览器读取商品链接图片…';}}if(state.state!=='ready'){await window.desktop.cancelBuyerSupplierGallery(id,index);throw new Error('等待商品页面读取超时；请检查浏览器插件连接后重试');}await loadComparisonImages(currentTask);if(button.isConnected&&button.dataset.retry!=='1')button.hidden=true;}catch(error){if(status)status.textContent='读取失败：'+errorText(error);if(button.isConnected){button.disabled=false;button.dataset.retry='1';button.textContent='重试读取商品图集';}}})();return;}
    if(button.classList.contains('buyer-open-candidate')){void window.desktop.openProductDetail(button.dataset.url).catch(error=>notify(errorText(error),true));return;}
    if(button.classList.contains('buyer-more-candidates')){supplierPreviewPages.set(currentTask.id,Math.max(0,Number(button.dataset.next)||0));showDetail(currentTask);$('buyerAutoDetailBody').querySelector('.buyer-source-compare')?.scrollIntoView({block:'start'});return;}
    if(button.classList.contains('buyer-open-comparison')||button.classList.contains('buyer-open-comparison-card')){void(async()=>{const taskId=button.closest('[data-buyer-task]')?.dataset.buyerTask||currentTask?.id,task=currentTask?.id===taskId?currentTask:taskId?await window.desktop.buyerTaskDetail(taskId):null,jobId=button.dataset.job||task?.automation?.checkpoints?.supplierComparison?.jobId||task?.automation?.comparisonJobId;if($('buyerAutoDetailDialog').open)$('buyerAutoDetailDialog').close();await window.openBuyerComparisonJob(jobId);})().catch(error=>notify(errorText(error),true));return;}
    if(button.classList.contains('buyer-plugin-help')){if($('buyerAutoDetailDialog').open)$('buyerAutoDetailDialog').close();$('navHelp').click();$('helpPlugin').scrollIntoView({block:'start'});$('preparePlugin').focus({preventScroll:true});return;}
    const id=button.closest('[data-buyer-task]')?.dataset.buyerTask||currentTask?.id;if(!id)return;
    void action(button,async()=>{if(button.classList.contains('buyer-confirm-candidate')){await window.desktop.resolveBuyerSupplier(id,Number(button.dataset.index),{manualConfirmed:true});if($('buyerAutoDetailDialog').open)$('buyerAutoDetailDialog').close();return'已记录你的人工同款确认，并继续采集该供应商资料。';}if(button.classList.contains('buyer-detail-select-supplier')){await window.desktop.resolveBuyerSupplier(id,Number(button.dataset.index));if($('buyerAutoDetailDialog').open)$('buyerAutoDetailDialog').close();return'已选择证据可靠的同款供应商，继续采集资料。';}if(button.classList.contains('buyer-reject-candidate')){await window.desktop.rejectBuyerSupplier(id,Number(button.dataset.index));showDetail(await window.desktop.buyerTaskDetail(id));return'已排除此候选；原商品和其他候选仍保留供核对。';}if(button.classList.contains('buyer-restore-candidate')){await window.desktop.restoreBuyerSupplier(id,Number(button.dataset.index));showDetail(await window.desktop.buyerTaskDetail(id));return'已恢复候选，可以重新对照。';}if(button.classList.contains('buyer-platform-login')){await window.desktop.openBuyerPlatform(button.dataset.platform);return`已在默认浏览器打开${platformLabels[button.dataset.platform]||'供应商平台'}。请用已加载找商品插件的浏览器资料登录，再回来点击“重新搜索未完成平台”。`;}if(button.classList.contains('buyer-retry-platform-search')){await window.desktop.retryBuyerAuto(id);if($('buyerAutoDetailDialog').open)$('buyerAutoDetailDialog').close();return'已重启四个平台搜索；已保存的商品主图会继续使用。';}if(button.classList.contains('buyer-detail-retry')){await window.desktop.retryBuyerAuto(id);if($('buyerAutoDetailDialog').open)$('buyerAutoDetailDialog').close();return'已从原任务继续；未完成的比对会重试，失败平台会重新搜索。';}
      const task=await window.desktop.buyerTaskDetail(id),url=button.dataset.url||task.sourceUrl;await window.desktop.openProductDetail(url);return'已打开商品页面，请在装有找商品插件的同一浏览器资料中完成登录或验证，再继续原任务。';});
  });
  $('buyerDetailNav').addEventListener('click',event=>{const button=event.target.closest('[data-detail-section]');if(!button)return;const target=detailSectionTarget(button.dataset.detailSection);if(target){if(target.tagName==='DETAILS')target.open=true;target.scrollIntoView({block:'start'});}});
  $('buyerDetailReturnRow').addEventListener('click',()=>void returnToTaskRow().catch(error=>{$('buyerDetailNotice').textContent=errorText(error);}));
  $('buyerAutoDetailDialog').addEventListener('close',()=>{$('buyerDetailNotice').textContent='';});
  $('buyerAutoDetailClose').addEventListener('click',()=>$('buyerAutoDetailDialog').close());
  $('buyerAutoDetailBody').addEventListener('click',event=>{const button=event.target.closest('.buyer-detail-select-supplier');if(!button||!currentTask)return;void action(button,async()=>{await window.desktop.resolveBuyerSupplier(currentTask.id,Number(button.dataset.index));$('buyerAutoDetailDialog').close();return'供应商已确定，后续步骤自动继续。';});});
  $('buyerTaskList').addEventListener('click',event=>{const card=event.target.closest('[data-buyer-task]');if(!card)return;
    const locate=event.target.closest('.buyer-locate-row');if(locate)return void action(locate,async()=>{if(dirtyRows.size)throw new Error('请先保存或撤销表格输入，再定位。');const result=await window.desktop.locateBuyerTask(card.dataset.buyerTask);onlineRows=[];onlineTableInfo=null;onlineBlankRows=makeBlankRows(12);onlineOffset=Math.floor(result.offset/100)*100;clearOnlineFind();await loadOnlineTables();highlightOnlineRow(result.rowId);return'已定位到任务对应的原表格行。';});
    const remove=event.target.closest('.buyer-delete-task');if(remove)return void action(remove,async()=>{const result=await window.desktop.deleteBuyerTask(card.dataset.buyerTask);if(result.canceled)return'';window.BuyerUI?.render(await window.desktop.snapshot());if(onlineTableInfo)await loadOnlineRows(onlineOffset);return result.cleanupWarning||'已删除本机任务，在线表格与互拓回执保留。';});
    const detail=event.target.closest('.buyer-auto-detail');if(detail)return void action(detail,async()=>{showDetail(await window.desktop.buyerTaskDetail(card.dataset.buyerTask));return'';});
    const retry=event.target.closest('.buyer-auto-retry');if(retry)return void action(retry,async()=>{await window.desktop.retryBuyerAuto(card.dataset.buyerTask);return'已从原检查点继续该商品。';});
  });
  function tasksForScope(current){
    const table=current?.onlineTable?.table,tableId=table?.id,ids=Array.isArray(table?.activeTaskIds)?new Set(table.activeTaskIds):null;
    return(current?.buyerTasks||[]).filter(task=>$('buyerTaskScope').value==='all'||!task.onlineTableRowId||
      (!task.onlineTableId||task.onlineTableId===tableId)&&(ids?ids.has(task.id):task.onlineTableId===tableId||onlineRows.some(row=>row.id===task.onlineTableRowId&&row.taskId===task.id&&row.sourceUrl===task.sourceUrl)));
  }
  window.BuyerAutoUI={render,card,tasksForScope};
})();
