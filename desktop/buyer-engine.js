const reliable=item=>item?.visualComparison?.verdict==='likely_same'&&Number.isFinite(item.visualComparison.score)&&item.visualComparison.score>=92&&!item.visualComparison.differences?.length&&!item.visualComparison.uncertainties?.length;
const terminal=new Set(['completed','attention','stopped']);
function hasCompletedCollection(task,facts=task.automation?.facts){
  const a=task.automation||{},collection=a.collection;
  try{
    const url=new URL(a.marketplace?.url),id=url.searchParams.get('id'),article=collection?.rawPrefill?.article_no||collection?.rawPrefill?.articleNo;
    return ['item.taobao.com','detail.tmall.com'].includes(url.hostname)&&url.pathname==='/item.htm'&&!!id&&String(collection?.externalId)===id&&String(a.collectionExternalId)===id&&!!collection?.title&&collection?.images?.length>0&&!!article&&article===facts?.articleNo;
  }catch{return false;}
}
const bypassErpDuplicates=automation=>({erpDuplicatePolicy:'manual_after_pending',duplicateReview:automation.duplicateReview?{...automation.duplicateReview,previousStatus:automation.duplicateReview.previousStatus||automation.duplicateReview.status,status:'skipped',skippedAt:new Date().toISOString()}:null});
const confirmedSupplierArticleNo=task=>{
  const a=task?.automation;if(!['wsy','zwd','qcc','e3hui'].includes(a?.supplier?.platform))return '';
  const link=require('./buyer-links').sourceLink(a.supplier.detailUrl),detailsLink=require('./buyer-links').sourceLink(a.supplierDetails?.url);
  const sameDetails=!a.supplierDetails?.url||!!link&&detailsLink?.sourceUrl===link.sourceUrl;
  const value=(sameDetails?a.supplierDetails?.sku:'')||(sameDetails&&!(a.facts?.missing||[]).includes('供应商有效货号')?a.facts?.articleNo:'')||a.supplier.goodsId||'';
  const code=String(value).trim();return code&&code.length<=120&&!/[\r\n]/.test(code)?code:'';
};
class BuyerEngine {
  constructor({workflow,providers,signal,concurrency=3}){this.workflow=workflow;this.providers=providers;this.signal=signal;this.concurrency=concurrency;this.busy=new Set();this.draftConversions=new Set();this.lastTried=new Map();this.timer=null;this.closed=false;}
  snapshot(){const tasks=this.workflow.state.tasks.filter(task=>task.automation);return{paused:this.workflow.state.automationPaused,running:this.busy.size,queued:tasks.filter(task=>task.automation.enabled&&!terminal.has(task.automation.state)).length,attention:tasks.filter(task=>task.automation.state==='attention').length,completed:tasks.filter(task=>task.automation.state==='completed').length};}
  async init(){for(const task of this.workflow.state.tasks){const a=task.automation;
    if(a?.step==='collection'&&a.collectionExternalId&&a.state==='attention'&&/采集等待超时/.test(a.error||'')){
      await this.scheduleCollection(task,{externalId:a.collectionExternalId,reason:'原采集任务等待较久，已恢复定时查询原记录',pollAfterMs:30000,pollState:'waiting',checked:false},'旧采集超时任务已恢复定时查询');
    }else if(a?.inFlight){await this.attention(task,'上次请求结果未知','上次模型或互拓请求中断，请核对原结果后重试');}else if(a?.state==='running')await this.workflow.patchAutomation(task.id,{state:'queued'});
  }this.timer=setInterval(()=>this.kick(),1000);this.timer.unref?.();this.kick();}
  async start(ids,options={}){if(!Array.isArray(ids)||!ids.length||ids.length>500)throw new Error('请选择要自动处理的商品');const searchMode=options?.searchMode==='detail'?'detail':'top';await this.workflow.mutate(async()=>{const tasks=[...new Set(ids)].map(id=>{const task=this.workflow.task(id);if(!task)throw new Error('商品任务不存在');return task;});const now=new Date().toISOString();for(const task of tasks){if(['completed','attention'].includes(task.automation?.state))continue;task.automation={...task.automation,searchMode,enabled:true,state:'queued',step:task.automation?.step||'source',tags:task.automation?.tags||[],error:'',updatedAt:now};task.events.push({at:now,message:`已加入自动买手队列（${searchMode==='detail'?'详细':'Top'}搜索）`});task.updatedAt=now;}this.workflow.state.automationPaused=false;});for(const id of ids){const task=this.workflow.task(id);if(task)await this.providers.onTaskUpdated?.(task);}this.kick();return this.snapshot();}
  async pause(){await this.workflow.setAutoPaused(true);return this.snapshot();}
  async resume(){await this.workflow.setAutoPaused(false);this.kick();return this.snapshot();}
  async queryCollection(id){
    const task=this.workflow.task(id),a=task?.automation;
    if(!a||!['collection','collection_wait'].includes(a.step)||!a.collectionExternalId)throw new Error('当前商品没有可查询的原采集记录');
    if(this.closed||this.signal?.aborted)throw new Error('当前会话已结束，请重新打开商品任务');
    if(this.busy.has(id))throw new Error('该商品正在查询或处理，请等待本次完成');
    this.busy.add(id);
    try{
      await this.providers.validateTask?.(task);
      await this.backfillSupplierArticleNo(task);
      const value=await this.providers.pollCollection(task);
      if(this.closed||this.signal?.aborted)throw new Error('采集查询已取消，原任务进度保留');
      if(!value||value.waiting){
        await this.scheduleCollection(task,value||{},'已手动查询原互拓采集记录');
        return{state:'waiting',reason:task.automation.waitingReason,paused:this.workflow.state.automationPaused};
      }
      await this.next(task,'mapping',{collection:value,collectionPolling:{...a.collectionPolling,state:'ready',nextCheckAt:null,lastCheckedAt:new Date().toISOString(),checkCount:(a.collectionPolling?.checkCount||0)+1,lastError:''}},'手动查询已取得互拓资料，继续整理上架资料');
      return{state:'ready',paused:this.workflow.state.automationPaused};
    }catch(error){
      if(!this.closed&&!this.signal?.aborted)await this.attention(task,error.tag||'采集查询失败',error.message||'采集查询失败',{collectionPolling:{...task.automation.collectionPolling,state:'failed',nextCheckAt:null,lastError:String(error.message||error).slice(0,240)}});
      throw error;
    }finally{this.busy.delete(id);this.kick();}
  }
  async retry(id){
    const task=this.workflow.task(id),a=task?.automation;
    if(!a||!['attention','stopped'].includes(a.state))throw new Error('仅待处理或停止任务可重试');
    if(this.busy.has(id))throw new Error('当前任务仍在执行，请等待完成后继续');
    if(a.step==='draft_review')throw new Error('资料已保存在互拓草稿箱，请先在草稿箱检查后再转入待审核');
    await this.providers.validateTask?.(task);
    if(a.productAttempt&&a.productSubmission?.state==='rejected'&&a.productSubmission.code===400){
      const history=[...(a.productSubmissionHistory||[]),{attempt:a.productAttempt,submission:a.productSubmission}];
      await this.workflow.patchAutomation(id,{step:'mapping',productSubmissionHistory:history,productAttempt:null,productSubmission:null,enabled:true,state:'queued',error:'',tags:[],inFlight:null,missing:[]},'互拓明确拒绝的输入已归档，按原商品修正资料后继续');await this.providers.onTaskUpdated?.(task);await this.resume();return;
    }
    if(a.productAttempt&&a.productSubmission){
      await this.workflow.patchAutomation(id,{step:'verify',enabled:true,state:'queued',error:'',tags:[],inFlight:null},'继续查询原待审核商品回执，不重新提交');
      await this.providers.onTaskUpdated?.(task);await this.resume();return;
    }
    if(['collection','collection_wait'].includes(a.step)&&hasCompletedCollection(task)){
      await this.workflow.patchAutomation(id,{step:'mapping',enabled:true,state:'queued',error:'',tags:[],inFlight:null,waitingReason:'',missing:[]},'沿用同一商品已完成的采集资料，继续整理互拓字段');
      await this.providers.onTaskUpdated?.(task);await this.resume();return;
    }
    if(['collection','collection_wait'].includes(a.step)&&a.collectionExternalId){
      await this.workflow.patchAutomation(id,{step:'collection_wait',enabled:true,state:'waiting',error:'',tags:[],inFlight:null,waitingReason:'已恢复查询原采集记录',collectionPolling:{...a.collectionPolling,state:'waiting',nextCheckAt:new Date().toISOString(),lastError:''}},'继续查询原互拓采集记录，不重复提交');
      await this.providers.onTaskUpdated?.(task);await this.resume();return;
    }
    if(a.step==='duplicate_check'){
      if(a.draftAttempt||a.draftId||a.result?.productId)throw new Error('该任务已有互拓提交记录，请先核对原回执');
      const step=a.marketplace?.url?'collection':'marketplace';
      await this.workflow.patchAutomation(id,{...bypassErpDuplicates(a),step,enabled:true,state:'queued',error:'',waitingReason:'',tags:[],inFlight:null},'已取消互拓自动查重，继续原任务进入待审核；重复商品由人工在互拓处理');
      await this.providers.onTaskUpdated?.(task);await this.resume();return;
    }
    if(a.tags?.some(tag=>['多供应商同款','重复来源','表内重复'].includes(tag)))throw new Error('请先在详情选择供应商或处理重复关系');
    const patch=await this.providers.recover?.(task)||{};
    await this.workflow.patchAutomation(id,{...patch,enabled:true,state:'queued',error:'',tags:[],inFlight:null},'从原任务检查点继续');await this.resume();
  }
  async resolveSupplier(id,index,{manualConfirmed=false}={}){
    const task=this.workflow.task(id),a=task?.automation;
    if(!a||!Number.isInteger(index))throw new Error('供应商候选选择无效');
    const reliableRows=a.supplierCandidates||[];let supplier=manualConfirmed?a.searchCandidates?.[index]:reliableRows[index],sourceIndex=manualConfirmed?index:null;
    if(manualConfirmed){
      if(!supplier?.imageUrl)throw new Error('该候选缺少可核对的商品图片');
      if((a.rejectedSupplierCandidates||[]).some(row=>row.platform===supplier.platform&&row.detailUrl===supplier.detailUrl))throw new Error('此候选已被人工排除，请先恢复候选再确认');
      const compared=(a.supplierComparison?.items||a.checkpoints?.supplierComparison?.result?.items||[]).find(row=>row.platform===supplier.platform&&row.detailUrl===supplier.detailUrl);
      supplier={...supplier,...(compared||{})};
      const source=require('./buyer-import').sourceLink(supplier.detailUrl);
      if(!source||source.sourceType!==supplier.platform||!['wsy','zwd','qcc','e3hui'].includes(source.sourceType))throw new Error('请选择有效的供应商商品链接');
    }
    if(!supplier||(!manualConfirmed&&!reliable(supplier)))throw new Error('请对照图片后，明确选择“人工确认同款”');
    const selection=manualConfirmed?{method:'manual',confirmedAt:new Date().toISOString(),sourceIndex,detailUrl:supplier.detailUrl,verdict:'likely_same'}:{method:'model',detailUrl:supplier.detailUrl};
    await this.workflow.patchAutomation(id,{supplier,supplierSelection:selection,step:'supplier_details',state:'queued',enabled:true,tags:[],error:'',waitingReason:''},manualConfirmed?'已由人工对照图片确认供应商同款，继续采集资料':'已选择可靠同款供应商，后续自动继续');
    await this.backfillSupplierArticleNo(task);
    await this.providers.onTaskUpdated?.(task);
    await this.resume();
  }
  async backfillSupplierArticleNo(task){
    const code=confirmedSupplierArticleNo(task);
    if(code&&!task.articleNo)await this.workflow.patchTask(task.id,{articleNo:code},'已回填确认供应商货号：'+code);
  }
  async convertSavedDraft(draftId,revision){
    if(!/^\d+$/.test(String(draftId||'')))throw new Error('草稿编号无效');
    if(this.draftConversions.has(String(draftId)))throw new Error('该草稿正在转换，请等待本次操作完成');
    const task=this.workflow.state.tasks.find(row=>String(row.automation?.draftId||'')===String(draftId));
    if(task){
      const a=task.automation;
      if(a.step!=='draft_review'||a.state!=='attention')throw new Error('该任务当前不在草稿人工检查阶段');
      if(this.busy.has(task.id))throw new Error('该商品仍在处理，请稍后再操作');
    }
    this.draftConversions.add(String(draftId));
    try{
      if(task)await this.workflow.patchAutomation(task.id,{inFlight:{kind:'erp-convert',draftId:String(draftId)}},'人工确认将草稿转入互拓待审核');
      const result=await this.providers.convertDraftEntry(String(draftId),revision);
      if(task){
        await this.workflow.patchAutomation(task.id,{step:'completed',state:'completed',enabled:false,inFlight:null,error:'',waitingReason:'',tags:['已转入互拓待审核'],result:{...(task.automation.result||{}),...result,state:result.productState===1?'listed':'pending_approval',draftId:String(draftId)}},`草稿已转入互拓待审核：${result.productNo}`);
        await this.providers.onTaskUpdated?.(task);
      }
      return result;
    }catch(error){
      if(task)await this.workflow.patchAutomation(task.id,{step:'draft_review',state:'attention',enabled:false,inFlight:null,error:String(error.message||error).slice(0,400),tags:['互拓草稿待检查']},'草稿转换结果待核对，请刷新草稿详情后重试');
      throw error;
    }finally{this.draftConversions.delete(String(draftId));}
  }
  async convertDraftForReview(draftId,revision){return this.convertSavedDraft(draftId,revision);}
  async rejectSupplierCandidate(id,index){
    const task=this.workflow.task(id),a=task?.automation,candidate=a?.searchCandidates?.[index];
    if(!a||!candidate)throw new Error('供应商候选不存在');
    const key=candidate.platform+'|'+candidate.detailUrl,existing=a.rejectedSupplierCandidates||[];
    if(existing.some(row=>row.key===key))return;
    const rejected=[...existing,{key,platform:candidate.platform,detailUrl:candidate.detailUrl,title:String(candidate.title||'').slice(0,300),rejectedAt:new Date().toISOString()}];
    const remaining=(a.searchCandidates||[]).filter(row=>!rejected.some(entry=>entry.key===row.platform+'|'+row.detailUrl));
    await this.workflow.patchAutomation(id,{rejectedSupplierCandidates:rejected,manualReviewNeeded:true,state:'attention',error:remaining.length?`已排除“${candidate.title||candidate.shopName||'该候选'}”；请继续对照剩余图片`:'已排除全部供应商候选，尚未确认同款；可重新搜货或补充链接',tags:remaining.length?['人工核对中']:['未找到人工确认同款']},'人工核对后排除此供应商候选');
    await this.providers.onTaskUpdated?.(task);
  }
  async restoreSupplierCandidate(id,index){
    const task=this.workflow.task(id),candidate=task?.automation?.searchCandidates?.[index];if(!candidate)throw new Error('供应商候选不存在');
    const key=candidate.platform+'|'+candidate.detailUrl,rejected=task.automation.rejectedSupplierCandidates||[];
    await this.workflow.patchAutomation(id,{rejectedSupplierCandidates:rejected.filter(row=>row.key!==key),manualReviewNeeded:true,error:'已恢复候选，可以重新核对',tags:['人工核对中']},'已恢复供应商候选以便重新核对');await this.providers.onTaskUpdated?.(task);
  }
  async attention(task,tag,error,extra={}){await this.workflow.patchAutomation(task.id,{...extra,state:'attention',inFlight:null,waitingReason:'',tags:[tag],error:String(error).slice(0,400)},`待处理：${error}`);await this.providers.onTaskUpdated?.(task);}
  kick(){if(this.closed||this.signal?.aborted||this.workflow.state.automationPaused)return;for(const task of [...this.workflow.state.tasks].sort((a,b)=>(this.lastTried.get(a.id)||0)-(this.lastTried.get(b.id)||0))){if(this.busy.size>=this.concurrency)break;if(!task.automation?.enabled||terminal.has(task.automation.state)||this.busy.has(task.id)||this.collectionNotDue(task))continue;this.busy.add(task.id);this.lastTried.set(task.id,Date.now());void this.step(task).catch(error=>!this.closed&&!this.signal?.aborted?this.attention(task,error.tag||'处理失败',error.message||'商品处理失败'):undefined).finally(()=>{this.busy.delete(task.id);});}}
  collectionNotDue(task){return ['collection','collection_wait'].includes(task.automation?.step)&&Date.parse(task.automation?.collectionPolling?.nextCheckAt)>Date.now();}
  async scheduleCollection(task,value,message=''){
    const a=task.automation,previous=a.collectionPolling||{},now=Date.now(),interval=value.pollAfterMs===60000?60000:30000;
    const polling={...previous,state:value.pollState||'waiting',externalId:value.externalId||a.collectionExternalId||'',startedAt:value.startedAt||previous.startedAt||new Date(now).toISOString(),lastCheckedAt:value.checked===false?previous.lastCheckedAt||null:new Date(now).toISOString(),nextCheckAt:new Date(now+interval).toISOString(),intervalMs:interval,checkCount:(previous.checkCount||0)+(value.checked===false?0:1),lastError:value.queryError||''};
    const reason=`${value.reason||'互拓正在采集商品资料'}；每${interval/1000}秒查询一次`;
    const changed=a.step!=='collection_wait'||previous.state!==polling.state;
    await this.workflow.patchAutomation(task.id,{step:polling.externalId?'collection_wait':'collection',collectionExternalId:polling.externalId,state:'waiting',enabled:true,error:'',tags:[],inFlight:null,waitingReason:reason,collectionPolling:polling},message||(changed?reason:''));
    if(changed||message)await this.providers.onTaskUpdated?.(task);
  }
  async result(task,name,fn){
    if(task.automation.state!=='waiting'){await this.workflow.patchAutomation(task.id,{state:'running',waitingReason:''},name);await this.providers.onTaskUpdated?.(task);}
    const value=await fn();if(this.signal?.aborted||this.closed)return null;
    if(!value||value.waiting){
      const reason=value?.reason||'等待平台或模型返回结果';
      if(task.automation.state!=='waiting'||task.automation.waitingReason!==reason){await this.workflow.patchAutomation(task.id,{state:'waiting',waitingReason:reason},reason);await this.providers.onTaskUpdated?.(task);}
      return null;
    }
    return value;
  }
  async next(task,step,patch={},message=''){await this.workflow.patchAutomation(task.id,{...patch,step,state:'queued',error:'',waitingReason:'',inFlight:null},message);await this.backfillSupplierArticleNo(task);await this.providers.onTaskUpdated?.(task);}
  async step(task){
    const a=task.automation,p=this.providers;let value;
    if(this.collectionNotDue(task))return;
    await p.validateTask?.(task);
    if(a.step==='source'){
      value=await this.result(task,'读取表格商品来源',()=>p.source(task));if(!value)return;
      await this.next(task,'supplier_search',{source:value},'来源图片和套图资料已取得');
    }else if(a.step==='supplier_search'){
      value=await this.result(task,'在四个供应平台搜索同款',()=>p.searchSuppliers(task));if(!value)return;
      const candidates=Array.isArray(value.items)?value.items:[];
      if(!candidates.length)return this.attention(task,'无供应商结果','没有取得供应商候选。请检查各平台登录或搜图权限，再重新搜索',{platformResults:value.records||[]});
      await this.next(task,'supplier_compare',{searchCandidates:candidates,platformResults:value.records||[]});
    }else if(a.step==='supplier_compare'){
      value=await this.result(task,'模型核对四平台候选细节',()=>p.compareSuppliers(task));if(!value)return;
      if(value.status!=='complete')return this.attention(task,'供应商识别未完成','部分候选没有收到有效识别结果；请对照原商品主图和候选图片人工判断，或重试未完成候选',{supplierComparison:value,supplierCandidates:(value.items||[]).filter(reliable),manualReviewNeeded:true});
      const suppliers=[...new Map(value.items.filter(reliable).map(item=>[item.platform+':'+item.detailUrl,item])).values()];
      if(suppliers.length>1)return this.attention(task,'多供应商同款',`发现${suppliers.length}个可靠同款供应商；请对照商品图片后选择`,{supplierCandidates:suppliers,supplierComparison:value,manualReviewNeeded:true});
      if(!suppliers.length)return this.attention(task,'未确认供应商同款','没有证据充分的同款结论；请对照原商品主图和候选图片人工判断，确认后再继续',{supplierCandidates:[],supplierComparison:value,manualReviewNeeded:true});
      if((a.platformResults||[]).length<4||(a.platformResults||[]).some(row=>row.phase!=='complete'))return this.attention(task,'平台搜索不完整','部分供应平台未完成搜索；可登录失败平台后重新搜索，或人工对照已返回候选',{supplierCandidates:suppliers,supplierComparison:value,manualReviewNeeded:true});
      const same=this.workflow.state.tasks.find(other=>other.id!==task.id&&other.automation?.supplier?.detailUrl===suppliers[0].detailUrl&&other.automation.state!=='stopped');
      if(same)return this.attention(task,'重复来源','同一供应商商品已关联另一行，保留关系避免重复建款',{duplicateOf:same.id,supplierCandidates:suppliers});
      await this.next(task,'supplier_details',{supplier:suppliers[0],supplierCandidates:suppliers});
    }else if(a.step==='supplier_details'){
      value=await this.result(task,'采集供应商完整商品资料',()=>p.supplierDetails(task));if(!value)return;
      await this.next(task,'supplier_facts',{supplierDetails:value});
    }else if(a.step==='supplier_facts'){
      await this.workflow.patchAutomation(task.id,{inFlight:{kind:'model',at:new Date().toISOString()}});
      value=await this.result(task,'模型整理供应商颜色、尺码、成分及供货资料',()=>p.facts(task));if(!value)return;
      if(value.missing?.length)return this.attention(task,'供应商资料缺失',value.missing.join('；'),{facts:value,missing:value.missing});
      if(task.articleNo&&task.articleNo.toUpperCase()!==value.articleNo?.toUpperCase())return this.attention(task,'货号冲突','表格货号与供应商实际货号不一致，请核对来源后继续',{facts:value});
      await this.next(task,'marketplace',{facts:value},'供应商资料已按证据整理');
    }else if(a.step==='marketplace'){
      value=await this.result(task,'确认可采集的淘宝套图链接',()=>p.marketplace(task));if(!value)return;
      if(value.requiresHuman)return this.attention(task,'淘宝套图待人工确认','淘宝候选已按销量优先对比，请对照商品图片确认套图来源后继续',{marketplaceComparison:value});
      if(!value.url)return this.attention(task,'无可靠套图','淘宝未找到可靠同款套图，继续处理下一件');
      await this.next(task,'collection',{marketplace:value,...bypassErpDuplicates(a)},'套图已确认，直接整理到互拓待审核；重复商品由人工在互拓处理');
    }else if(a.step==='duplicate_check'){
      if(a.draftAttempt||a.draftId||a.result?.productId)throw new Error('该任务已有互拓提交记录，请先核对原回执');
      await this.next(task,a.marketplace?.url?'collection':'marketplace',bypassErpDuplicates(a),'旧查重步骤已跳过，继续整理到互拓待审核');
    }else if(['collection','collection_wait'].includes(a.step)){
      if(a.step==='collection'&&a.state!=='waiting')await this.workflow.patchAutomation(task.id,{state:'running'},'提交互拓淘宝采集任务');
      try{
        value=await(a.step==='collection_wait'&&p.pollCollection?p.pollCollection(task):p.collect(task));
        if(this.closed||this.signal?.aborted)return;
        if(!value||value.waiting){await this.scheduleCollection(task,value||{});return;}
        await this.next(task,'mapping',{collection:value,collectionPolling:{...task.automation.collectionPolling,state:'ready',nextCheckAt:null,lastCheckedAt:new Date().toISOString(),lastError:''}},'互拓采集资料已取得，继续整理上架资料');
      }catch(error){
        if(this.closed||this.signal?.aborted)throw error;
        await this.workflow.patchAutomation(task.id,{collectionPolling:{...task.automation.collectionPolling,state:'failed',nextCheckAt:null,lastError:String(error.message||error).slice(0,240)}});throw error;
      }
    }else if(a.step==='mapping'){
      await this.workflow.patchAutomation(task.id,{inFlight:{kind:'model',at:new Date().toISOString()}});
      value=await this.result(task,'按互拓真实类别和字典整理上架资料',()=>p.map(task));if(!value)return;
      if(value.missing?.length)return this.attention(task,'互拓必填资料缺失',value.missing.join('；'),{mapped:value,missing:value.missing});
      if(a.productSubmission||a.draftId||a.draftAttempt)throw new Error('该任务已有互拓提交检查点，请先核对原回执，不能覆盖后再次新增');
      const direct=typeof p.prepareProduct==='function',attempt=await(direct?p.prepareProduct(value.payload):p.prepare(value.payload));
      await this.next(task,'submit',{mapped:value,...(direct?{productAttempt:attempt,erpSaveMode:'direct_pending'}:{draftAttempt:attempt})},direct?'已固定待审核商品资料和本机提交检查点':'已固定互拓提交资料及幂等键');
    }else if(a.step==='submit'){
      if(a.productAttempt){
        await this.workflow.patchAutomation(task.id,{inFlight:{kind:'erp-product',key:a.productAttempt.key}});
        value=await this.result(task,'直接保存互拓待审核产品',()=>p.submitProduct(task));if(!value)return;
        if(value.state==='rejected')return this.attention(task,'互拓拒绝资料',value.error,{productSubmission:value});
        await this.next(task,'verify',{productSubmission:value},'查询本次保存的原商品回执，不重复新增');return;
      }
      await this.workflow.patchAutomation(task.id,{inFlight:{kind:'erp',key:a.draftAttempt.key}});
      value=await this.result(task,'保存互拓草稿',()=>p.submit(task));if(!value)return;
      if(value.state==='unknown')return this.attention(task,'互拓回执未知','保存结果未知，保留原请求及幂等键，禁止新建重复商品');
      await this.next(task,'verify',{draftId:value.draftId,result:{draftId:value.draftId,state:'draft_saved'}});
    }else if(a.step==='verify'){
      if(a.productAttempt){
        value=await this.result(task,'回读互拓待审核商品与编号',()=>p.verifyProduct(task));if(!value)return;
        await this.workflow.patchAutomation(task.id,{step:'completed',state:'completed',enabled:false,inFlight:null,error:'',waitingReason:'',tags:['已保存互拓待审核'],result:value},`已保存互拓待审核：${value.productNo}，最终上架由人工完成`);
        await p.onTaskUpdated?.(task);return;
      }
      value=await this.result(task,'回读互拓草稿核验保存结果',()=>p.verify(task));if(!value)return;
      const version=Number(value.draftVersion??value.revision);if(!Number.isInteger(version)||version<1)return this.attention(task,'互拓回执未知','草稿回读缺少有效版本，草稿已保留但无法转换');
      await this.attention(task,'互拓草稿待检查','商品资料已保存到互拓草稿箱。请在软件“互拓草稿箱”查看完整资料和图片，确认后再转入待审核。',{step:'draft_review',enabled:false,draftVersion:version,draftId:String(a.draftId),result:{...(a.result||{}),draftId:String(a.draftId),state:'draft_saved',productName:value.productName||value.productTypeName||'',articleNo:value.articleNo||task.automation.facts?.articleNo||task.articleNo||'',supplierName:value.supplierName||task.automation.facts?.supplierName||''},tags:['互拓草稿待检查']});return;
    }else if(a.step==='convert'){
      await this.next(task,'verify',{},'旧任务转换步骤改为先回读草稿，等待人工检查后再转入待审核');
    }else if(a.step==='draft_review'){
      return this.attention(task,'互拓草稿待检查','商品资料已保存在互拓草稿箱，请在草稿箱中查看并人工确认。',{enabled:false,tags:['互拓草稿待检查']});
    }
    else if(a.step==='completed'){await this.workflow.patchAutomation(task.id,{state:'completed',inFlight:null},'自动买手流程完成，互拓回执与原表行已关联');await p.onTaskUpdated?.(task);}
    else throw new Error('未知买手流程步骤');
  }
  async close(){this.closed=true;clearInterval(this.timer);}
}
module.exports={BuyerEngine,reliable,confirmedSupplierArticleNo,hasCompletedCollection};
