const crypto=require('node:crypto');
const {downloadCandidate,validateQuery}=require('./images');
const {invokeJson}=require('./models');
const {retryModelJson}=require('./model-retry');
const {validateSupplierFacts,buildPayload}=require('./buyer-evidence');
const {reliable}=require('./buyer-engine');
const {sourceLink}=require('./buyer-import');
const {safeItem,safePlatformSearches}=require('./bridge-server');
const imageData=buffer=>`data:image/jpeg;base64,${buffer.toString('base64')}`;
const tagError=(message,tag)=>Object.assign(new Error(message),{tag});
const pageErrorTag=message=>/平台(?:需要|要求)登录|请先登录|请在浏览器登录|安全验证|验证码|拖动滑块|平台要求.*验证/.test(message)?'平台登录或验证':'页面采集失败';
const publicSource=result=>{
  if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('商品页面资料无效');
  const source=sourceLink(result.url);if(!source)throw new Error('商品页面未返回有效来源地址');
  const imageHosts=['wsy.com','17qcc.com','17zwd.com','e3hui.com','e3hui.cn','ximgs.net','alicdn.com','taobaocdn.com','tbcdn.cn','ecombdimg.com','byteimg.com','douyinpic.com'];
  const images=(Array.isArray(result.images)?result.images:[]).filter(value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&imageHosts.some(domain=>u.hostname===domain||u.hostname.endsWith('.'+domain));}catch{return false;}}).slice(0,60);
  const cleanImages=values=>(Array.isArray(values)?values:[]).filter(value=>images.includes(value)).slice(0,60);
  const imageGroups=result.imageGroups&&typeof result.imageGroups==='object'?Object.fromEntries(['main','colors','details'].map(key=>[key,cleanImages(result.imageGroups[key])])):{};
  const quality=result.quality&&typeof result.quality==='object'?{state:['complete','partial'].includes(result.quality.state)?result.quality.state:'partial',pageRole:['source','supplier'].includes(result.quality.pageRole)?result.quality.pageRole:'source',missingFields:(Array.isArray(result.quality.missingFields)?result.quality.missingFields:[]).slice(0,20).map(value=>String(value).slice(0,80)),imageCoverage:result.quality.imageCoverage&&typeof result.quality.imageCoverage==='object'?{detailNodes:Math.max(0,Math.min(500,Number(result.quality.imageCoverage.detailNodes)||0)),detailImages:Math.max(0,Math.min(500,Number(result.quality.imageCoverage.detailImages)||0)),placeholders:Math.max(0,Math.min(500,Number(result.quality.imageCoverage.placeholders)||0)),complete:result.quality.imageCoverage.complete===true}:null}:null;
  return{...source,url:source.sourceUrl,title:String(result.title||'').slice(0,1000),sku:String(result.sku||'').slice(0,200),shopName:String(result.shopName||'').slice(0,300),price:typeof result.price==='number'&&result.price>0?result.price:null,priceType:['supply','tiered'].includes(result.priceType)?result.priceType:'supply',priceTiers:(Array.isArray(result.priceTiers)?result.priceTiers:[]).slice(0,40).map(row=>({price:Number.isFinite(Number(row?.price))?Number(row.price):null,quantity:String(row?.quantity||'').slice(0,100)})).filter(row=>row.price>0),resaleFloor:typeof result.resaleFloor==='number'&&result.resaleFloor>0?result.resaleFloor:null,colors:(Array.isArray(result.colors)?result.colors:[]).slice(0,80).map(value=>String(value).slice(0,100)),sizes:(Array.isArray(result.sizes)?result.sizes:[]).slice(0,80).map(value=>String(value).slice(0,100)),quality,imageGroups,description:String(result.description||'').slice(0,6000),visibleText:String(result.visibleText||'').slice(0,40000),attributes:(Array.isArray(result.attributes)?result.attributes:[]).slice(0,80).map(value=>String(value).slice(0,500)),images,salesText:String(result.salesText||'').slice(0,200),collectedAt:new Date().toISOString()};
};
function createBuyerProviders({workflow,bridge,settings,model,signal,onTaskUpdated=async()=>{},now=Date.now}){
  const checkpoint=async(task,key,value)=>{const previous=task.automation.checkpoints?.[key]||{};const merged=previous.commandId&&value.commandId&&previous.commandId!==value.commandId?value:{...previous,...value};return workflow.patchAutomation(task.id,{checkpoints:{...task.automation.checkpoints,[key]:merged}});};
  const invokeModelJson=async(task,stage,request)=>{
    const states=task.automation.modelRetryState||{},previous=states[stage]||{autoRetryCount:0,manualRetryRounds:0},used=Math.max(0,Math.min(3,previous.autoRetryCount||0));
    try{return await retryModelJson(()=>invokeJson(model(),request,{signal}),{signal,autoRetries:3-used,onRetry:async count=>{
      const modelRetryState={...states,[stage]:{...previous,autoRetryCount:used+count,lastError:'模型响应暂不可用'}};
      await workflow.patchAutomation(task.id,{modelRetryState});
    }});}
    catch(error){if(used+(error.retryCount||0)>=3)throw new Error(`模型自动重试3次后仍失败：${String(error.message||error).slice(0,220)}；点击“继续原任务”可再自动重试3次`);throw error;}
  };
  async function browserStep(task,slot,input){
    const saved=task.automation.checkpoints?.[slot];
    if(saved?.error)throw tagError(saved.error,pageErrorTag(saved.error));
    if(saved?.result)return saved.result;
    const current=bridge.snapshot().browserCommands.find(command=>command.id===saved?.commandId);
    if(current?.status==='failed')throw tagError(current.error||'浏览器采集失败','页面采集失败');
    const client=bridge.snapshot().browserClient;
    if(['update_required','unverified'].includes(client?.state)){
      if(current)await bridge.failBuyerBrowserCommand(current.id,client.message);
      throw tagError(client.message,client.state==='update_required'?'插件需要更新':'插件版本待确认');
    }
    const waiting=async command=>{
      const online=now()-Date.parse(bridge.snapshot().lastBrowserSeen)<90000;
      let reason,tag='';
      if(command.status==='claimed'){
        reason='浏览器插件已接单，正在打开商品页面或采集平台资料';
        const timeout=command.kind==='buyer-source'?120000:8*60000;
        // Use the original creation time as an overall bound: a re-claim cannot extend it forever.
        if(now()-Date.parse(command.claimedAt)>timeout||now()-Date.parse(command.createdAt)>10*60000)tag='页面采集超时';
      }else{
        reason=online?'等待浏览器插件接单，前面的平台任务完成后自动继续':'等待浏览器插件连接：请在装有找商品插件的浏览器打开工作台并连接桌面端';
        if(!online&&now()-Date.parse(command.createdAt)>90000)tag='浏览器插件未连接';
        else if(now()-Date.parse(command.createdAt)>10*60000)tag='浏览器队列等待超时';
      }
      if(tag){
        const error=tag==='浏览器插件未连接'?'浏览器插件未连接或连接已中断，请打开插件工作台连接桌面端后继续原任务':tag==='页面采集超时'?'浏览器已接单但平台页面长时间未回执，请检查页面登录或验证后继续原任务':'浏览器长时间未接单，请检查插件工作台后继续原任务';
        const stopped=await bridge.failBuyerBrowserCommand(command.id,error);
        if(stopped)throw tagError(error,tag);
      }
      return{waiting:true,reason};
    };
    if(current&&['queued','claimed'].includes(current.status))return waiting(current);
    if(saved?.commandId&&current?.status==='accepted')throw tagError('浏览器回执未保存，请重试当前步骤','采集回执缺失');
    try{const command=await bridge.enqueueBuyerBrowser({buyerTaskId:task.id,slot,...input});await checkpoint(task,slot,{commandId:command.id});return waiting(command);}catch(error){if(/队列已满/.test(error.message))return{waiting:true,reason:'等待前面的浏览器采集任务完成，随后自动接单'};throw error;}
  }
  async function compare(task,kind,items,slot){
    const saved=task.automation.checkpoints?.[slot];
    if(saved?.result)return saved.result;
    if(saved?.jobId){const job=bridge.snapshot().jobs.find(entry=>entry.id===saved.jobId);if(!job)throw tagError('本地比对记录已移除，请重试该商品','识别记录缺失');if(['queued','processing'].includes(job.status))return{waiting:true};const result={status:job.status,items:job.items};await checkpoint(task,slot,{...saved,result});return result;}
    if(!model())throw tagError('请先添加并选择视觉模型','模型未配置');
    const query=imageData(await workflow.image(task.id));await validateQuery(query);
    const queryId=saved?.queryId||crypto.randomUUID();await checkpoint(task,slot,{queryId});
    const searchResult=task.automation.checkpoints?.search?.result;
    const searchIssues=kind==='supplier'?(searchResult?.records||[]).filter(row=>['partial','failed','manual_required'].includes(row.phase)).map(row=>({platform:row.key,phase:row.phase,message:row.message})):[];
    const platformSearches=kind==='supplier'&&Array.isArray(searchResult?.platformSearches)?searchResult.platformSearches:[];
    try{const job=await bridge.enqueueBuyerComparison({buyerTaskId:task.id,kind,automatic:true,queryId,query,searchIssues,platformSearches,queryName:(task.articleNo||task.sourceTitle||`表格第${task.origin?.rowNumber||''}行`)+(kind==='supplier'?' · 供应商同款':' · 淘宝套图'),items});await checkpoint(task,slot,{queryId,jobId:job.id});}catch(error){if(/队列已有10/.test(error.message))return{waiting:true};throw error;}
    return{waiting:true};
  }
  async function evidenceImages(task,details){const images=[imageData(await workflow.image(task.id))];images.supplierIndices=[];for(const [index,source] of (details.images||[]).slice(0,3).entries()){try{images.push((await downloadCandidate(source,signal)).dataUrl);images.supplierIndices.push(index);}catch{}}return images;}
  return{
    async recover(task){
      const a=task.automation,checkpoints={...a.checkpoints};
      if(a.step==='supplier_compare'&&(a.platformResults||[]).some(row=>row.phase!=='complete')){
        delete checkpoints.search;delete checkpoints.supplierComparison;
        return{step:'supplier_search',checkpoints,searchCandidates:[],platformResults:[],supplierCandidates:[],supplier:null,supplierSelection:null};
      }
      const slot={source:'source',supplier_search:'search',supplier_details:'supplier'}[a.step];if(slot){
        if(checkpoints[slot]?.commandId)await bridge.failBuyerBrowserCommand(checkpoints[slot].commandId,'已重试原任务，旧采集命令停止接收回执');
        delete checkpoints[slot];
      }
      const comparison={supplier_compare:'supplierComparison',marketplace:'marketplaceComparison'}[a.step];
      if(comparison&&checkpoints[comparison]?.jobId){const saved={...checkpoints[comparison]};const job=bridge.snapshot().jobs.find(row=>row.id===saved.jobId);if(job&&['partial','failed'].includes(job.status)){const retried=await bridge.retry(job.id,false);checkpoints[comparison]={...saved,jobId:retried.id||job.id,result:undefined};}else if(!job)delete checkpoints[comparison];}
      if(a.step==='supplier_facts'){
        const modelRetryState={...(a.modelRetryState||{})};
        for(const key of ['supplier_facts','supplier_ocr'])modelRetryState[key]={...(modelRetryState[key]||{}),autoRetryCount:0,manualRetryRounds:(modelRetryState[key]?.manualRetryRounds||0)+1};
        return{checkpoints,modelRetryState,step:'supplier_facts'};
      }
      if(a.step==='mapping'){
        const modelRetryState={...(a.modelRetryState||{})};
        for(const key of ['mapping_category','mapping_fields'])modelRetryState[key]={...(modelRetryState[key]||{}),autoRetryCount:0,manualRetryRounds:(modelRetryState[key]?.manualRetryRounds||0)+1};
        return{checkpoints,modelRetryState,step:'mapping'};
      }
      return{checkpoints};
    },
    async onBrowserResult(command,result,error){
      const task=workflow.task(command.buyerTaskId);if(!task?.automation?.enabled)throw new Error('自动买手任务未启用');
      const saved=task.automation.checkpoints?.[command.slot];if(saved?.commandId&&saved.commandId!==command.id)throw new Error('买手页面采集回执已过期');
      let clean=null;
      if(result&&command.kind==='buyer-source'){
        clean=publicSource(result);const expected=sourceLink(command.detailUrl);if(clean.sourceType!==expected.sourceType)throw new Error('商品页面平台不一致');
        if(clean.sourceType==='taobao'&&new URL(clean.url).searchParams.get('id')!==new URL(command.detailUrl).searchParams.get('id'))throw new Error('商品页面ID与当前任务不一致');
        if(['wsy','zwd','qcc','e3hui'].includes(clean.sourceType)){const actual=new URL(clean.url),requested=new URL(command.detailUrl);if(actual.pathname.replace(/\/$/,'')!==requested.pathname.replace(/\/$/,''))throw new Error('供应商详情跳转到其他页面，未采集到原商品');for(const key of ['id','goodsId','goods_id','productId'])if(requested.searchParams.has(key)&&requested.searchParams.get(key)!==actual.searchParams.get(key))throw new Error('供应商商品ID不一致');}
      }else if(result){
        if(!Array.isArray(result.items)||result.items.length>500)throw new Error('供应商候选数量无效');
        const returned=result.items.map(safeItem);
        const items=returned.filter(item=>{const link=sourceLink(item.detailUrl);return link&&['wsy','zwd','qcc','e3hui'].includes(link.sourceType)&&link.sourceType===item.platform&&item.imageUrl;});
        const rawRecords=Array.isArray(result.records)?result.records:[];
        const platformSearches=safePlatformSearches(['wsy','zwd','qcc','e3hui'].map(platform=>{
          const row=rawRecords.find(row=>row?.key===platform);
          return {platform,selected:true,phase:row?.phase||'unknown',receivedCount:Array.isArray(row?.items)?row.items.length:returned.filter(item=>item.platform===platform).length,
            acceptedCount:items.filter(item=>item.platform===platform).length,reportedTotal:row?.total??null,message:row?.message||'',
            searchGroups:(Array.isArray(row?.diagnostics?.searchGroups)?row.diagnostics.searchGroups:[]).map(group=>({type:group.type,phase:group.phase,receivedCount:group.received,reportedTotal:group.total})),diagnostics:row?.diagnostics||null};
        }));
        const records=platformSearches.map(row=>({key:row.platform,phase:row.phase,message:row.message,total:row.reportedTotal,receivedCount:row.receivedCount,acceptedCount:row.acceptedCount,searchGroups:row.searchGroups,diagnostics:row.diagnostics}));
        clean={items,records,platformSearches};
      }
      await checkpoint(task,command.slot,{commandId:command.id,result:clean,error:String(error||'').slice(0,200)});
    },
    async source(task){
      if(task.sourceType==='image')return{title:task.sourceTitle,images:[],url:'',salesText:''};
      const result=await browserStep(task,'source',{kind:'buyer-source',platform:task.sourceType,detailUrl:task.sourceUrl});if(result.waiting)return result;
      let primaryImageUrl=result.primaryImageUrl||'';
      if(!task.imageFile){let selected=null;for(const url of result.images.slice(0,5)){try{selected=await downloadCandidate(url,signal);primaryImageUrl=selected.evidence.sourceUrl;break;}catch{}}if(!selected)throw tagError('未取得足够清晰的来源商品图','原图细节不足');await workflow.attachImage(task.id,selected.buffer);}
      if(!task.sourceTitle)await workflow.patchTask(task.id,{sourceTitle:result.title});return{...result,primaryImageUrl};
    },
    async searchSuppliers(task){return browserStep(task,'search',{kind:'buyer-supplier-search',imageData:imageData(await workflow.image(task.id))});},
    async compareSuppliers(task){return compare(task,'supplier',task.automation.searchCandidates,'supplierComparison');},
    supplierDetails(task){const selected=task.automation.supplier;return browserStep(task,'supplier',{kind:'buyer-source',platform:selected.platform,detailUrl:selected.detailUrl});},
    async facts(task){
      const details=task.automation.supplierDetails;
      const images=await evidenceImages(task,details);
      const output=await invokeModelJson(task,'supplier_facts',{instruction:'提取供应商事实，返回 {articleNo,supplierName,cost,colors:string[],sizes:string[],materials:[{name,rate:number}],sizeImageIndex:number|null,fork:0|1|null,variant,warehouse,categoryName,priceConflict:boolean,evidence:{articleNo,supplierName,cost,colors,sizes,materials}}。evidence每项须为供应商原文连续引文；只有图片可清晰读到时可用{quote,imageIndex}，imageIndex对应supplier.images索引。输入第一张是选品原图，随后供应商图的原索引顺序见availableSupplierImageIndices。cost只能取明确供货价；阶梯价须连同数量档原文保留，不能将最低限价当作供货成本，规格或采购数量不明时将priceConflict设为true。尺码图索引对应supplier.images。fork仅在有公版/专版证据时确定；未知用null。不要把店铺推荐商品当当前商品。',data:{supplier:details,inputArticleNo:task.articleNo,availableSupplierImageIndices:images.supplierIndices},images});
      output.verifiedOcrFields=[];
      const ocr=Object.entries(output.evidence||{}).filter(([,value])=>value&&typeof value==='object');
      if(ocr.length){const verification=await invokeModelJson(task,'supplier_ocr',{instruction:'独立复核供应商图片的OCR事实。第一张是选品原图，随后是供应商图片。只返回{verifiedFields:string[]}。逐个核对字段值、quote及imageIndex，数值/比例/颜色尺码有任何不清楚或不一致就不得列入verifiedFields，不使用常识猜测。',data:{facts:output,evidence:ocr,availableSupplierImageIndices:images.supplierIndices},images});output.verifiedOcrFields=Array.isArray(verification.verifiedFields)?verification.verifiedFields.filter(key=>images.supplierIndices.includes(output.evidence?.[key]?.imageIndex)):[];}
      return validateSupplierFacts(output,details);
    },
    async marketplace(task){
      if(task.sourceType==='taobao')return{url:task.sourceUrl,title:task.automation.source.title,salesText:task.automation.source.salesText,confirmedSame:true};
      if(!task.marketplaceCandidates?.length){
        const commands=bridge.snapshot().browserCommands;const failed=commands.find(command=>command.buyerTaskId===task.id&&command.kind==='taobao-image-search'&&command.status==='failed');
        if(failed)throw tagError(failed.error||'淘宝搜款失败','淘宝登录或验证');
        const pending=commands.some(command=>command.buyerTaskId===task.id&&command.kind==='taobao-image-search'&&['queued','claimed'].includes(command.status));
        if(!pending){const bytes=await workflow.image(task.id);const command=await bridge.enqueueTaobaoSearch({buyerTaskId:task.id,imageData:imageData(bytes),sourceType:task.sourceType,sourceUrl:task.sourceUrl,queryName:task.sourceTitle||'自动买手套图'});await workflow.queueTaobaoSearch(task.id,command.id);}
        return{waiting:true};
      }
      const result=await compare(task,'taobao',task.marketplaceCandidates,'marketplaceComparison');if(result.waiting)return result;
      if(result.status!=='complete')throw tagError('淘宝套图候选尚未完整识别','套图识别未完成');
      const matches=result.items.filter(reliable).sort((a,b)=>b.visualComparison.score-a.visualComparison.score);
      if(!matches.length)return{};
      const selected=matches[0],original=task.marketplaceCandidates.find(item=>item.detailUrl===selected.detailUrl);
      return{url:selected.detailUrl,title:selected.title,salesText:original?.salesText||'',confirmedSame:true,modelScore:selected.visualComparison.score};
    },
    async duplicates(task){const client=await settings.erp(),facts=task.automation.facts,pageSize=100,all=[];let pageNo=1,total=null;for(;pageNo<=100;pageNo++){const data=await client.productPage({pageNo,pageSize,productState:'all',articleNo:facts.articleNo},signal);if(!data||!Number.isFinite(Number(data.total))||!Array.isArray(data.list))throw tagError('互拓查重返回未确认状态','互拓查重未知');if(total===null)total=Number(data.total);all.push(...data.list);if(all.length>=total||data.list.length<pageSize)break;}if(total>all.length)throw tagError('互拓查重结果未取全，已暂停新增','互拓查重不完整');return all.filter(row=>row.articleNo===facts.articleNo).map(row=>({id:String(row.id),productNo:row.productNo,articleNo:row.articleNo,supplierName:row.supplierName||row.supplier,createTime:row.createTime,productName:row.productName,productState:row.productState,platformPrice:row.platformPrice,talkCost:row.talkCost}));},
    async collect(task){const client=await settings.erp(),a=task.automation,result=await client.collect({url:a.marketplace.url,articleNo:a.facts.articleNo,supplierName:a.facts.supplierName,externalId:a.collectionExternalId},{signal,checkpoint:externalId=>workflow.patchAutomation(task.id,{collectionExternalId:externalId})});const extras=await client.originalImages(result.externalId,signal);const urls=value=>Array.isArray(value)?value.filter(item=>typeof item==='string'):typeof value==='string'?value.split(',').filter(Boolean):[];const full=[extras?.mainPic, ...urls(extras?.mainPic11), ...urls(extras?.mainPic34), ...urls(extras?.detailPic)];return{...result,images:[...new Set([...result.images,...full].filter(Boolean))].slice(0,60),originalImages:extras};},
    async map(task){
      const client=await settings.erp(),catalog=await settings.catalogs(signal),facts=task.automation.facts;
      const suppliers=await client.suppliers(facts.supplierName,signal),matched=(Array.isArray(suppliers)?suppliers:[]).filter(row=>row.supplierName===facts.supplierName);
      if(matched.length!==1)return{missing:['供应商未唯一对应互拓档案'],payload:null};
      const preliminary=await invokeModelJson(task,'mapping_category',{instruction:'只从给定categories选择与供应商实际服装一致的categoryName，返回{productTypeName:string}。标题不可靠时以商品可见结构为依据；夹克与棉服按供应商是否有填充物区分，证据不明返回空字符串。',data:{categories:catalog.categories.map(row=>({categoryName:row.categoryName,categoryAb:row.categoryAb})),supplier:task.automation.supplierDetails,facts},images:await evidenceImages(task,task.automation.supplierDetails)});
      const category=catalog.categories.find(row=>row.categoryName===preliminary.productTypeName);if(!category)return{missing:['无法确认互拓类别'],payload:null};
      const controls=await client.controls(category.categoryName,signal);
      const categoryAreas=controls[0]?.category?.[category.categoryName]||{},names=new Set(Object.values(categoryAreas).flat());for(const key of Object.keys(controls[1]?.control||{}))names.add(key);
      const activeControls=Object.fromEntries([...names].filter(key=>typeof key==='string').map(key=>[key,controls[1]?.control?.[key]||controls[0]?.control?.[key]]).filter(([,value])=>value));
      const types=new Set(['warehouse_infos','pallet_infos','industry','season','technology_infos','product_style','ages','universal_code','numerical_code','international_code','material_composition']);
      const output=await invokeModelJson(task,'mapping_fields',{instruction:'根据供应商事实和当前互拓字典/控件整理字段，返回 {productTypeName,storeHouse,pallet,industry,season,technology,style,ageState:string[],sizeType,extendedAttributes:object}。只能使用给定启用枚举，不得自行创建字典。未知必填字段留空。不要猜成分、成本、仓库、品牌或质检。',data:{category:{categoryName:category.categoryName,categoryAb:category.categoryAb},dictionaries:catalog.dictionaries.filter(row=>types.has(row.dictType)),controls:activeControls,supplier:task.automation.supplierDetails,facts},images:await evidenceImages(task,task.automation.supplierDetails)});
      output.productTypeName=category.categoryName;
      const colors=[];for(const name of facts.colors){const found=await client.colors(name,signal);if(Array.isArray(found))colors.push(...found);}
      const result=buildPayload({mapping:output,facts,source:task.automation.source,marketplace:task.automation.marketplace,collection:task.automation.collection,catalog,controls,settings:settings.value,supplier:matched[0],colors});
      const {validateDraftPayload}=await import('./erp/contract.mjs');return{...result,missing:[...new Set([...result.missing,...validateDraftPayload(result.payload)])]};
    },
    async prepare(payload){const {prepareDraftAttempt}=await import('./erp/contract.mjs');return prepareDraftAttempt(payload);},
    async submit(task){return(await settings.erp()).submitDraft(task.automation.draftAttempt,{signal});},
    async verify(task){const draft=await(await settings.erp()).getDraft(task.automation.draftId,signal);if(!draft||String(draft.id)!==String(task.automation.draftId))throw new Error('互拓草稿回读未确认同一记录');return draft;},
    target:()=>settings.value.target,
    async convert(task){const client=await settings.erp(),a=task.automation;let id=a.result?.productId;const draft=await client.getDraft(a.draftId,signal);if(draft?.convertedProductId)id=String(draft.convertedProductId);if(!id)id=String(await client.convertDraft(a.draftId,a.draftVersion,signal));const product=await client.productDetail(id,signal);if(!product||!product.productNo||![0,1].includes(product.productState))throw tagError('转换后未取得有效产品编码和状态','互拓回执未知');return{productId:id,productNo:product.productNo,productState:product.productState};},
    async onTaskUpdated(task){return onTaskUpdated(task);}
  };
}
module.exports={createBuyerProviders,publicSource};
