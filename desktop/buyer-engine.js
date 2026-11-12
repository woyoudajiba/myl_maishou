const reliable=item=>item?.visualComparison?.verdict==='likely_same'&&Number.isFinite(item.visualComparison.score)&&item.visualComparison.score>=92&&!item.visualComparison.differences?.length&&!item.visualComparison.uncertainties?.length;
const terminal=new Set(['completed','attention','stopped']);
class BuyerEngine {
  constructor({workflow,providers,signal,concurrency=3}){this.workflow=workflow;this.providers=providers;this.signal=signal;this.concurrency=concurrency;this.busy=new Set();this.lastTried=new Map();this.timer=null;this.closed=false;}
  snapshot(){const tasks=this.workflow.state.tasks.filter(task=>task.automation);return{paused:this.workflow.state.automationPaused,running:this.busy.size,queued:tasks.filter(task=>task.automation.enabled&&!terminal.has(task.automation.state)).length,attention:tasks.filter(task=>task.automation.state==='attention').length,completed:tasks.filter(task=>task.automation.state==='completed').length};}
  async init(){for(const task of this.workflow.state.tasks){if(task.automation?.inFlight){await this.attention(task,'上次请求结果未知','上次模型或互拓请求中断，请核对原结果后重试');}else if(task.automation?.state==='running')await this.workflow.patchAutomation(task.id,{state:'queued'});}this.timer=setInterval(()=>this.kick(),1000);this.timer.unref?.();this.kick();}
  async start(ids){if(!Array.isArray(ids)||!ids.length||ids.length>500)throw new Error('请选择要自动处理的商品');await this.workflow.mutate(async()=>{const tasks=[...new Set(ids)].map(id=>{const task=this.workflow.task(id);if(!task)throw new Error('商品任务不存在');return task;});const now=new Date().toISOString();for(const task of tasks){if(['completed','attention'].includes(task.automation?.state))continue;task.automation={...task.automation,enabled:true,state:'queued',step:task.automation?.step||'source',tags:task.automation?.tags||[],error:'',updatedAt:now};task.events.push({at:now,message:'已加入自动买手队列'});task.updatedAt=now;}this.workflow.state.automationPaused=false;});for(const id of ids){const task=this.workflow.task(id);if(task)await this.providers.onTaskUpdated?.(task);}this.kick();return this.snapshot();}
  async pause(){await this.workflow.setAutoPaused(true);return this.snapshot();}
  async resume(){await this.workflow.setAutoPaused(false);this.kick();return this.snapshot();}
  async retry(id){const task=this.workflow.task(id);if(!task?.automation||!['attention','stopped'].includes(task.automation.state))throw new Error('仅待处理或停止任务可重试');await this.providers.validateTask?.(task);if(task.automation.tags?.some(tag=>['多供应商同款','重复来源','表内重复','互拓已有商品'].includes(tag)))throw new Error('请先在详情选择供应商或处理重复关系');const patch=await this.providers.recover?.(task)||{};await this.workflow.patchAutomation(id,{...patch,enabled:true,state:'queued',error:'',tags:[],inFlight:null},'从原任务检查点继续');await this.resume();}
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
    await this.resume();
  }
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
  kick(){if(this.closed||this.signal?.aborted||this.workflow.state.automationPaused)return;for(const task of [...this.workflow.state.tasks].sort((a,b)=>(this.lastTried.get(a.id)||0)-(this.lastTried.get(b.id)||0))){if(this.busy.size>=this.concurrency)break;if(!task.automation?.enabled||terminal.has(task.automation.state)||this.busy.has(task.id))continue;this.busy.add(task.id);this.lastTried.set(task.id,Date.now());void this.step(task).catch(error=>this.attention(task,error.tag||'处理失败',error.message||'商品处理失败')).finally(()=>{this.busy.delete(task.id);});}}
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
  async next(task,step,patch={},message=''){await this.workflow.patchAutomation(task.id,{...patch,step,state:'queued',error:'',waitingReason:'',inFlight:null},message);await this.providers.onTaskUpdated?.(task);}
  async step(task){
    const a=task.automation,p=this.providers;let value;
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
      if(!value.url)return this.attention(task,'无可靠套图','淘宝未找到可靠同款套图，继续处理下一件');
      await this.next(task,'duplicate_check',{marketplace:value});
    }else if(a.step==='duplicate_check'){
      value=await this.result(task,'检查互拓现有商品',()=>p.duplicates(task));if(!value)return;
      if(value.length)return this.attention(task,'互拓已有商品','互拓已存在相同货号供应商记录，需补套图或关联原编码',{existingProducts:value});
      await this.next(task,'collection');
    }else if(a.step==='collection'){
      value=await this.result(task,'取得互拓淘宝采集资料',()=>p.collect(task));if(!value)return;
      await this.next(task,'mapping',{collection:value});
    }else if(a.step==='mapping'){
      await this.workflow.patchAutomation(task.id,{inFlight:{kind:'model',at:new Date().toISOString()}});
      value=await this.result(task,'按互拓真实类别和字典整理上架资料',()=>p.map(task));if(!value)return;
      if(value.missing?.length)return this.attention(task,'互拓必填资料缺失',value.missing.join('；'),{mapped:value,missing:value.missing});
      const attempt=await p.prepare(value.payload);
      await this.next(task,'submit',{mapped:value,draftAttempt:attempt},'已固定互拓提交资料及幂等键');
    }else if(a.step==='submit'){
      await this.workflow.patchAutomation(task.id,{inFlight:{kind:'erp',key:a.draftAttempt.key}});
      value=await this.result(task,'保存互拓草稿',()=>p.submit(task));if(!value)return;
      if(value.state==='unknown')return this.attention(task,'互拓回执未知','保存结果未知，保留原请求及幂等键，禁止新建重复商品');
      await this.next(task,'verify',{draftId:value.draftId,result:{draftId:value.draftId,state:'draft_saved'}});
    }else if(a.step==='verify'){
      value=await this.result(task,'回读互拓草稿核验保存结果',()=>p.verify(task));if(!value)return;
      if(p.target()==='draft')await this.next(task,'completed',{result:{draftId:a.draftId,state:'draft_saved'}});
      else {const version=Number(value.draftVersion??value.revision);if(!Number.isInteger(version)||version<1)return this.attention(task,'互拓回执未知','草稿回读缺少有效版本，未执行待审核转换');await this.next(task,'convert',{draftVersion:version});}
    }else if(a.step==='convert'){
      await this.workflow.patchAutomation(task.id,{inFlight:{kind:'erp-convert',draftId:a.draftId}});
      value=await this.result(task,'转入互拓待审核并回查商品编码',()=>p.convert(task));if(!value)return;
      if(!value.productId||!value.productNo) return this.attention(task,'互拓回执未知','转换回执缺少产品ID或编码，请回查原草稿');
      await this.next(task,'completed',{result:{draftId:a.draftId,productId:value.productId,productNo:value.productNo,productState:value.productState,state:value.productState===1?'listed':'pending_approval'}});
      await p.onTaskUpdated?.(task);
    }else if(a.step==='completed'){await this.workflow.patchAutomation(task.id,{state:'completed',inFlight:null},'自动买手流程完成，互拓回执与原表行已关联');await p.onTaskUpdated?.(task);}
    else throw new Error('未知买手流程步骤');
  }
  async close(){this.closed=true;clearInterval(this.timer);}
}
module.exports={BuyerEngine,reliable};
