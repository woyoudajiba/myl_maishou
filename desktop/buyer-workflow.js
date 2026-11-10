const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicJson } = require('./accounts');

const imageData = value => typeof value === 'string' && value.length <= 12 * 1024 * 1024 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value);
const {sourceHosts,validSourceUrl,normalizeSourceInput}=require('./buyer-links');
class BuyerWorkflow {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'buyer-tasks.json');
    this.imageDir = path.join(dataDir, 'buyer-images');
    this.state = { tasks: [], automationPaused: true };
    this.mutation = Promise.resolve();
  }
  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!data || !Array.isArray(data.tasks) || data.tasks.length > 500) throw new Error('买手任务数据无效');
      this.state.automationPaused=data.automationPaused!==false;
      this.state.tasks = data.tasks.filter(task => task && /^[\da-f-]{36}$/i.test(task.id) && sourceHosts[task.sourceType] && (task.sourceType==='image'||validSourceUrl(task.sourceUrl, task.sourceType)))
        .map(task => ({ ...task, sourceUrl: validSourceUrl(task.sourceUrl, task.sourceType), imageFile: typeof task.imageFile === 'string' && /^[\da-f-]{36}\.jpg$/i.test(task.imageFile) ? task.imageFile : '', queryId: typeof task.queryId === 'string' && /^[\da-f-]{36}$/i.test(task.queryId) ? task.queryId : '', marketplaceQueryId: typeof task.marketplaceQueryId === 'string' && /^[\da-f-]{36}$/i.test(task.marketplaceQueryId) ? task.marketplaceQueryId : '', marketplaceCandidates: Array.isArray(task.marketplaceCandidates) ? task.marketplaceCandidates.slice(0, 60).map(candidate => this.safeTaobaoCandidate(candidate)).filter(Boolean) : [], marketplaceSearch: task.marketplaceSearch && ['queued','searching','ready','failed','scoring','scored'].includes(task.marketplaceSearch.status) ? task.marketplaceSearch : { status: 'idle', error: '' } }));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this.snapshot();
  }
  snapshot() { return this.state.tasks.map(({imageFile,automation,...task})=>({...structuredClone(task),hasImage:!!imageFile,...(automation?{automation:{enabled:automation.enabled,step:automation.step,state:automation.state,error:automation.error||'',waitingReason:automation.waitingReason||'',tags:automation.tags||[],updatedAt:automation.updatedAt,result:structuredClone(automation.result||null),supplierCount:automation.supplierCandidates?.length||0,searchCandidateCount:automation.searchCandidates?.length||0,searchCandidates:(automation.searchCandidates||[]).slice(0,24).map(row=>({platform:row.platform,id:row.id,title:row.title,shopName:row.shopName,detailUrl:row.detailUrl,imageUrl:row.imageUrl,price:row.price,visualComparison:row.visualComparison,imageSimilarityStatus:row.imageSimilarityStatus,imageSimilarityError:row.imageSimilarityError})),rejectedSupplierCandidates:(automation.rejectedSupplierCandidates||[]).map(row=>({platform:row.platform,title:row.title,detailUrl:row.detailUrl,rejectedAt:row.rejectedAt})),supplierCandidates:(automation.supplierCandidates||[]).map(row=>({platform:row.platform,id:row.id,title:row.title,shopName:row.shopName,detailUrl:row.detailUrl,imageUrl:row.imageUrl,price:row.price,visualComparison:row.visualComparison})),supplierSelection:structuredClone(automation.supplierSelection||null),supplier:automation.supplier?{platform:automation.supplier.platform,detailUrl:automation.supplier.detailUrl,title:automation.supplier.title,shopName:automation.supplier.shopName,visualComparison:automation.supplier.visualComparison,imageSimilarityStatus:automation.supplier.imageSimilarityStatus}:null,supplierComparison:automation.supplierComparison?{status:automation.supplierComparison.status,items:(automation.supplierComparison.items||[]).slice(0,24).map(row=>({platform:row.platform,detailUrl:row.detailUrl,visualComparison:row.visualComparison,imageSimilarityStatus:row.imageSimilarityStatus,imageSimilarityError:row.imageSimilarityError}))}:null,comparisonJobId:automation.checkpoints?.supplierComparison?.jobId||'',platformResults:(automation.platformResults||[]).slice(0,4).map(row=>({key:String(row.key||'').slice(0,15),phase:String(row.phase||'').slice(0,40),message:String(row.message||'').slice(0,200),total:Number(row.total)||0})),missing:automation.missing||[]}}:{})})); }
  async patchTask(id,patch,message='') {
    return this.mutate(async()=>{const task=this.task(id);if(!task)throw new Error('买手任务不存在');Object.assign(task,patch);task.updatedAt=new Date().toISOString();if(message)task.events.push({at:task.updatedAt,message:String(message).slice(0,300)});return this.snapshot().find(item=>item.id===id);});
  }
  async patchAutomation(id,patch,message='') {
    return this.mutate(async()=>{const task=this.task(id);if(!task)throw new Error('买手任务不存在');task.automation={...task.automation,...patch,updatedAt:new Date().toISOString()};task.updatedAt=task.automation.updatedAt;if(message)task.events.push({at:task.updatedAt,message:String(message).slice(0,300)});return this.snapshot().find(item=>item.id===id);});
  }
  async discardUnstartedTask(id){
    const task=this.task(id);if(!task)return false;
    if(task.automation?.enabled||task.automation?.inFlight||task.imageFile)throw new Error('任务已开始或已有本地图片，不能作为未启动任务回滚');
    return this.mutate(async()=>{const index=this.state.tasks.findIndex(row=>row.id===id);if(index<0)return false;this.state.tasks.splice(index,1);return true;});
  }
  async setAutoPaused(paused){return this.mutate(async()=>{this.state.automationPaused=paused===true;return{paused:this.state.automationPaused};});}
  async importTable(preview){
    const written=[];
    try{return await this.mutate(async()=>{
      const rows=preview.rows.filter(row=>!row.errors.length);if(!rows.length)throw new Error('没有可导入的有效商品行');
      const existing=new Map(this.state.tasks.map(task=>[task.sourceUrl,task]));
      const fresh=rows.filter(row=>!this.state.tasks.some(task=>task.origin?.digest===row.digest&&task.origin?.sheetName===row.sheetName&&task.origin?.rowNumber===row.rowNumber));
      if(this.state.tasks.length+fresh.length>500)throw new Error('买手任务最多500条，请分批处理并清理完成记录');
      await fs.mkdir(this.imageDir,{recursive:true});const now=new Date().toISOString();
      for(const row of fresh){
        const duplicate=existing.get(row.sourceUrl),id=crypto.randomUUID(),imageFile=row.image?`${id}.jpg`:'';
        if(row.image){await fs.writeFile(path.join(this.imageDir,imageFile),row.image,{flag:'wx'});written.push(imageFile);}
        const tags=[...row.tags,...(duplicate?['重复来源']:[])];
        const blocked=tags.some(tag=>tag.includes('重复'));
        const task={id,sourceType:row.sourceType,sourceUrl:row.sourceUrl,articleNo:row.articleNo,externalCode:row.externalCode||'',supplierName:row.supplierName||'',sourceTitle:'',createdAt:now,updatedAt:now,imageFile,queryId:'',supplierCandidate:null,marketplaceCandidate:null,marketplaceCandidates:[],marketplaceSearch:{status:'idle'},status:row.image?'ready_for_supplier_search':'needs_image',productFolder:'',origin:{batchId:preview.batchId,digest:row.digest,fileName:row.fileName,sheetName:row.sheetName,rowNumber:row.rowNumber,tableId:row.tableId||'',selectDate:row.selectDate||'',supplierName:row.supplierName||'',externalCode:row.externalCode||'',selectOperator:row.selectOperator||'',buyerOperator:row.buyerOperator||'',note:row.note||'',tableFields:row.tableFields||{}},automation:{enabled:false,state:blocked?'attention':'queued',step:'source',tags,duplicateOf:duplicate?.id||'',error:blocked?'同一来源已存在，保留行号并跳过自动处理':'',checkpoints:{}},events:[{at:now,message:`从 ${row.sheetName} 第${row.rowNumber}行导入`}],erpDraftId:'',erpDraftVersion:null};
        this.state.tasks.push(task);existing.set(row.sourceUrl,task);
      }
      return{imported:fresh.length,skipped:rows.length-fresh.length,invalid:preview.rows.length-rows.length,batchId:preview.batchId};
    });}catch(error){await Promise.all(written.map(file=>fs.rm(path.join(this.imageDir,file),{force:true}).catch(()=>{})));throw error;}
  }
  task(id) { return this.state.tasks.find(task => task.id === id) || null; }
  safeTaobaoCandidate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const url = validSourceUrl(value.detailUrl, 'taobao');
    if (!url) return null;
    let imageUrl = '';
    try { const image = new URL(value.imageUrl); if (image.protocol === 'https:' && !image.username && !image.password && !image.port && /(^|\.)(?:alicdn\.com|taobaocdn\.com|tbcdn\.cn)$/.test(image.hostname)) imageUrl = image.href; } catch {}
    if (!imageUrl) return null;
    return { id: String(value.id || new URL(url).searchParams.get('id')).slice(0, 120), title: String(value.title || '').slice(0, 1000), detailUrl: url, imageUrl, price: Number.isFinite(Number(value.price)) && Number(value.price) > 0 ? Number(value.price) : null, salesText: String(value.salesText || '').slice(0, 200), shopName: String(value.shopName || '').slice(0, 300), location: String(value.location || '').slice(0, 120) };
  }
  async mutate(action) {
    const operation = this.mutation.catch(() => {}).then(async () => {
      const previous = structuredClone(this.state);
      try { const result = await action(); await atomicJson(this.file, this.state); return result; }
      catch (error) {
        const current=new Map(this.state.tasks.map(task=>[task.id,task]));
        this.state.tasks=previous.tasks.map(saved=>{const task=current.get(saved.id);if(!task)return saved;for(const key of Object.keys(task))delete task[key];Object.assign(task,saved);return task;});
        throw error;
      }
    });
    this.mutation = operation.catch(() => {});
    return operation;
  }
  async create(input = {}, imageBuffer = null) {
    input=normalizeSourceInput(input);
    const sourceType = String(input.sourceType || '');
    const sourceUrl = validSourceUrl(input.sourceUrl, sourceType);
    if (sourceType!=='image'&&!sourceUrl) throw new Error('请提供有效的抖音、淘宝或四个平台商品链接');
    if(sourceType==='image'&&!imageBuffer)throw new Error('本机图片任务需要选择清晰商品图片');
    const articleNo = String(input.articleNo || '').trim();
    if (articleNo.length > 64 || /[\r\n]/.test(articleNo)) throw new Error('货号最多64字，且不能换行');
    if (imageBuffer && (!Buffer.isBuffer(imageBuffer) || imageBuffer.length < 64 || imageBuffer.length > 10 * 1024 * 1024)) throw new Error('商品图须为有效图片且不超过10MB');
    const id = /^[\da-f-]{36}$/i.test(String(input.id||''))?String(input.id):crypto.randomUUID(), now = new Date().toISOString();
    const task = { id, createdAt: now, updatedAt: now, articleNo, sourceType, sourceUrl, sourceTitle: String(input.sourceTitle || '').trim().slice(0, 300), supplierCandidate: null, marketplaceCandidate: null, queryId: '', status: imageBuffer ? 'ready_for_supplier_search' : 'needs_image', imageFile: imageBuffer ? `${id}.jpg` : '', events: [{ at: now, message: imageBuffer ? '买手任务已建立，可启动四平台搜货' : '买手任务已建立，需先提供清晰商品图' }], erpDraftId: '', erpDraftVersion: null };
    try { return await this.mutate(async () => {
      if (this.state.tasks.length >= 500) throw new Error('买手任务达到500条上限，请清理已完成任务');
      if (imageBuffer) { await fs.mkdir(this.imageDir, { recursive: true }); await fs.writeFile(path.join(this.imageDir, task.imageFile), imageBuffer, { flag: 'wx' }); }
      this.state.tasks.unshift(task); return this.snapshot().find(item => item.id === id);
    }); } catch (error) { if (task.imageFile) await fs.rm(path.join(this.imageDir,task.imageFile),{force:true}).catch(()=>{}); throw error; }
  }
  async attachImage(id, buffer) {
    const task = this.task(id); if (!task) throw new Error('买手任务不存在');
    if (!Buffer.isBuffer(buffer) || buffer.length < 64 || buffer.length > 10 * 1024 * 1024) throw new Error('商品图须为有效图片且不超过10MB');
    const file=path.join(this.imageDir,`${task.id}.jpg`);let previous=null;
    try { previous=await fs.readFile(file); } catch(error) { if(error.code!=='ENOENT') throw error; }
    try { return await this.mutate(async () => {
      await fs.mkdir(this.imageDir, { recursive: true });
      task.imageFile = `${task.id}.jpg`; task.status = 'ready_for_supplier_search'; task.updatedAt = new Date().toISOString();
      task.queryId='';task.searchCommandId='';task.supplierCandidate=null;task.marketplaceCandidate=null;
      task.marketplaceQueryId='';task.marketplaceCandidates=[];task.marketplaceSearch={status:'idle',error:''};
      task.events.push({ at: task.updatedAt, message: '已添加商品图，可启动四平台搜货' });
      await fs.writeFile(path.join(this.imageDir, task.imageFile), buffer, { flag: 'w' }); return this.snapshot().find(item => item.id === id);
    }); } catch(error) { if(previous) await fs.writeFile(file,previous).catch(()=>{}); else await fs.rm(file,{force:true}).catch(()=>{}); throw error; }
  }
  async image(id) {
    const task = this.task(id); if (!task?.imageFile) throw new Error('请先给买手任务添加商品图');
    const file = path.join(this.imageDir, task.imageFile), bytes = await fs.readFile(file);
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('本地商品图无效');
    return bytes;
  }
  async linkSearch(id, queryId) {
    const task = this.task(id); if (!task) throw new Error('买手任务不存在');
    if (!/^[\da-f-]{36}$/i.test(queryId || '')) throw new Error('浏览器搜图记录无效');
    return this.mutate(async () => { task.queryId = queryId; task.status = 'supplier_searching'; task.updatedAt = new Date().toISOString(); task.events.push({ at: task.updatedAt, message: '已交给配对浏览器搜索四个供应平台' }); return this.snapshot().find(item => item.id === id); });
  }
  async queueTaobaoSearch(id, commandId) {
    const task = this.task(id); if (!task) throw new Error('买手任务不存在');
    if (!task.imageFile) throw new Error('请先给买手任务添加商品图');
    if (['queued','searching'].includes(task.marketplaceSearch?.status)) return this.snapshot().find(item => item.id === id);
    return this.mutate(async () => { task.marketplaceSearch = { status: 'queued', commandId: String(commandId || '').slice(0,80), error: '' }; task.updatedAt = new Date().toISOString(); task.events.push({ at: task.updatedAt, message: '淘宝以图搜同款已排队，等待配对浏览器' }); return this.snapshot().find(item => item.id === id); });
  }
  async saveTaobaoSearch(id, candidates, commandId = '') {
    const task = this.task(id); if (!task) throw new Error('买手任务不存在');
    if(commandId&&task.marketplaceSearch?.completedCommandId===commandId)return this.snapshot().find(item=>item.id===id);
    if(commandId&&task.marketplaceSearch?.commandId&&task.marketplaceSearch.commandId!==commandId)throw new Error('淘宝搜索结果已过期，请刷新任务');
    if (!Array.isArray(candidates) || candidates.length > 60) throw new Error('淘宝候选数量无效');
    const safe = candidates.map(value => this.safeTaobaoCandidate(value)).filter(Boolean);
    if (!safe.length) throw new Error('淘宝图搜没有返回可用商品链接');
    return this.mutate(async () => {
      task.marketplaceCandidates = safe; task.marketplaceQueryId = crypto.randomUUID();
      task.marketplaceSearch = { status: 'ready', count: safe.length, error: '', completedCommandId: commandId }; task.updatedAt = new Date().toISOString();
      task.events.push({ at: task.updatedAt, message: `淘宝图搜返回 ${safe.length} 个候选；等待人工确认开始模型筛选` });
      return this.snapshot().find(item => item.id === id);
    });
  }
  async failTaobaoSearch(id, message) {
    const task = this.task(id); if (!task) return null;
    return this.mutate(async () => { task.marketplaceSearch = { status: 'failed', error: String(message || '淘宝搜索失败').slice(0,180) }; task.updatedAt = new Date().toISOString(); task.events.push({ at: task.updatedAt, message: `淘宝图搜暂停：${task.marketplaceSearch.error}` }); return this.snapshot().find(item => item.id === id); });
  }
  async setMarketplaceJob(id, jobId, status) {
    const task = this.task(id); if (!task) throw new Error('买手任务不存在');
    return this.mutate(async () => { task.marketplaceSearch = { ...task.marketplaceSearch, jobId, status }; task.updatedAt = new Date().toISOString(); return this.snapshot().find(item => item.id === id); });
  }
  async queueSearch(id, commandId) {
    const task = this.task(id); if (!task) throw new Error('买手任务不存在');
    if (!task.imageFile) throw new Error('请先给买手任务添加商品图');
    return this.mutate(async () => { task.searchCommandId = String(commandId || '').slice(0,80); task.status='supplier_search_queued'; task.updatedAt=new Date().toISOString(); task.events.push({at:task.updatedAt,message:'已排队，等待配对浏览器启动四平台搜货'}); return this.snapshot().find(item=>item.id===id); });
  }
  async setMarketplaceLink(id, input = {}) {
    const task = this.task(id); if (!task) throw new Error('买手任务不存在');
    const url = validSourceUrl(input.url, 'taobao'); if (!url) throw new Error('请填写完整有效的淘宝/天猫商品链接');
    return this.mutate(async () => { task.marketplaceCandidate = { url, title: String(input.title || '').slice(0,500), salesText: String(input.salesText || '').slice(0,300), remark: String(input.remark || '').slice(0,2000), confirmedSame: input.confirmedSame === true, jobId: /^[\da-f-]{36}$/i.test(input.jobId || '') ? input.jobId : '', candidateIndex: Number.isInteger(input.candidateIndex) ? input.candidateIndex : null }; task.updatedAt = new Date().toISOString(); task.events.push({ at: task.updatedAt, message: task.marketplaceCandidate.confirmedSame ? '人工确认了淘宝套图同款' : '已保存淘宝套图链接，等待同款核对' }); return this.snapshot().find(item => item.id === id); });
  }
  async setSupplierCandidate(id, candidateIndex, compiled) {
    const task=this.task(id);if(!task)throw new Error('买手任务不存在');
    if(!Number.isInteger(candidateIndex)||candidateIndex<0)throw new Error('供应商候选选择无效');
    return this.mutate(async()=>{task.supplierCandidate={candidateIndex,source:compiled};task.status=compiled.readiness==='ready_for_draft'?'ready_for_draft':'needs_business_data';task.updatedAt=new Date().toISOString();task.events.push({at:task.updatedAt,message:compiled.missing.length?`供应商同款已关联；仍缺 ${compiled.missing.length} 项可信资料`:'资料已齐备，可继续生成互拓草稿'});return this.snapshot().find(item=>item.id===id)});
  }
}
module.exports = { BuyerWorkflow, validSourceUrl, imageData };
