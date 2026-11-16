const crypto=require('node:crypto');
const sales=require('../taobao-sales');
const {downloadCandidate,validateQuery}=require('./images');
const {invokeJson}=require('./models');
const {retryModelJson}=require('./model-retry');
const {mergeStructuredSupplierFacts,validateSupplierFacts,buildPayload}=require('./buyer-evidence');
const {reliable}=require('./buyer-engine');
const {sourceLink}=require('./buyer-import');
const {safeItem,safePlatformSearches}=require('./bridge-server');
const {normalizeDraftListItem,normalizeDraftDetail}=require('./buyer-draft-view');
const {supplierRows,rankSuppliers,supplierSearchTerms,resolveSupplier,mappingControls,normalizeMapping}=require('./buyer-mapping');
const review=require('../review');
const imageData=buffer=>`data:image/jpeg;base64,${buffer.toString('base64')}`;
const tagError=(message,tag)=>Object.assign(new Error(message),{tag});
const pageErrorTag=message=>/平台(?:需要|要求)登录|请先登录|请在浏览器登录|安全验证|验证码|拖动滑块|平台要求.*验证/.test(message)?'平台登录或验证':'页面采集失败';
function selectSupplierImageIndices(details,maximum=4){
  const images=Array.isArray(details?.images)?details.images:[],groups=details?.imageGroups||{};
  const toIndices=values=>[...new Set((Array.isArray(values)?values:[]).map(url=>images.indexOf(url)).filter(index=>index>=0))];
  const detailIndices=toIndices(groups.details);
  const candidates=detailIndices.length?detailIndices:toIndices(groups.main).concat(toIndices(groups.colors));
  if(candidates.length<=maximum)return candidates;
  if(maximum<=1)return[candidates[0]];
  return[...new Set(Array.from({length:maximum},(_,index)=>candidates[Math.round(index*(candidates.length-1)/(maximum-1))]))];
}
const publicSource=result=>{
  if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('商品页面资料无效');
  const source=sourceLink(result.url);if(!source)throw new Error('商品页面未返回有效来源地址');
  const imageHosts=['wsy.com','17qcc.com','17zwd.com','e3hui.com','e3hui.cn','ximgs.net','alicdn.com','taobaocdn.com','tbcdn.cn','ecombdimg.com','byteimg.com','douyinpic.com'];
  const images=(Array.isArray(result.images)?result.images:[]).filter(value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&imageHosts.some(domain=>u.hostname===domain||u.hostname.endsWith('.'+domain));}catch{return false;}}).slice(0,60);
  const cleanImages=values=>(Array.isArray(values)?values:[]).filter(value=>images.includes(value)).slice(0,60);
  const imageGroups=result.imageGroups&&typeof result.imageGroups==='object'?Object.fromEntries(['main','colors','details'].map(key=>[key,cleanImages(result.imageGroups[key])])):{};
  const quality=result.quality&&typeof result.quality==='object'?{state:['complete','partial'].includes(result.quality.state)?result.quality.state:'partial',pageRole:['source','supplier'].includes(result.quality.pageRole)?result.quality.pageRole:'source',missingFields:(Array.isArray(result.quality.missingFields)?result.quality.missingFields:[]).slice(0,20).map(value=>String(value).slice(0,80)),imageCoverage:result.quality.imageCoverage&&typeof result.quality.imageCoverage==='object'?{detailNodes:Math.max(0,Math.min(500,Number(result.quality.imageCoverage.detailNodes)||0)),detailImages:Math.max(0,Math.min(500,Number(result.quality.imageCoverage.detailImages)||0)),placeholders:Math.max(0,Math.min(500,Number(result.quality.imageCoverage.placeholders)||0)),complete:result.quality.imageCoverage.complete===true}:null}:null;
  return{...source,url:source.sourceUrl,title:String(result.title||'').slice(0,1000),sku:String(result.sku||'').slice(0,200),shopName:String(result.shopName||'').slice(0,300),boothName:String(result.boothName||'').slice(0,300),address:String(result.address||'').slice(0,300),price:typeof result.price==='number'&&result.price>0?result.price:null,priceType:['supply','tiered'].includes(result.priceType)?result.priceType:'supply',priceTiers:(Array.isArray(result.priceTiers)?result.priceTiers:[]).slice(0,40).map(row=>({price:Number.isFinite(Number(row?.price))?Number(row.price):null,quantity:String(row?.quantity||'').slice(0,100)})).filter(row=>row.price>0),resaleFloor:typeof result.resaleFloor==='number'&&result.resaleFloor>0?result.resaleFloor:null,colors:(Array.isArray(result.colors)?result.colors:[]).slice(0,80).map(value=>String(value).slice(0,100)),sizes:(Array.isArray(result.sizes)?result.sizes:[]).slice(0,80).map(value=>String(value).slice(0,100)),quality,imageGroups,description:String(result.description||'').slice(0,6000),visibleText:String(result.visibleText||'').slice(0,40000),attributes:(Array.isArray(result.attributes)?result.attributes:[]).slice(0,80).map(value=>String(value).slice(0,500)),images,salesText:String(result.salesText||'').slice(0,200),collectedAt:new Date().toISOString()};
};
function createBuyerProviders({workflow,bridge,settings,model,signal,onTaskUpdated=async()=>{},now=Date.now}){
  const checkpoint=async(task,key,value)=>{const previous=task.automation.checkpoints?.[key]||{};const merged=previous.commandId&&value.commandId&&previous.commandId!==value.commandId?value:{...previous,...value};return workflow.patchAutomation(task.id,{checkpoints:{...task.automation.checkpoints,[key]:merged}});};
  const invokeModelJson=async(task,stage,request)=>{
    const states=task.automation.modelRetryState||{},previous=states[stage]||{autoRetryCount:0,manualRetryRounds:0},used=Math.max(0,Math.min(3,previous.autoRetryCount||0));
    try{return await retryModelJson(async()=>{const result=await invokeJson(model(),request,{signal});if(request.validate&&!request.validate(result))throw new Error('模型返回的字段结构不完整，请按指定商品表单字段返回');return result;},{signal,autoRetries:3-used,onRetry:async count=>{
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
    // A cached model result predates later human reviews. Read the live batch
    // before using a saved result when recovering the Taobao selection step.
    if(kind==='taobao'&&saved?.jobId){
      const job=bridge.snapshot().jobs.find(entry=>entry.id===saved.jobId);
      if(!job||job.buyerTaskId!==task.id)throw tagError('淘宝识别记录已移除或与当前商品不一致，请重新核对候选','识别记录缺失');
      if(['queued','processing'].includes(job.status))return{waiting:true};
      const result={status:job.status,items:job.items};
      await checkpoint(task,slot,{...saved,result});return result;
    }
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
  async function evidenceImages(task,details){
    const images=[imageData(await workflow.image(task.id))];images.supplierIndices=[];
    const all=Array.isArray(details.images)?details.images:[];
    for(const index of selectSupplierImageIndices(details,4))try{images.push((await downloadCandidate(all[index],signal)).dataUrl);images.supplierIndices.push(index);}catch{}
    return images;
  }
  async function collectionStep(task,poll){
    const a=task.automation,input={url:a.marketplace?.url,articleNo:a.facts?.articleNo,supplierName:a.facts?.supplierName,externalId:a.collectionExternalId};
    const previous=a.collectionPolling||{},startedAt=previous.startedAt||new Date().toISOString();
    const checkpoint=async(externalId,patch)=>workflow.patchAutomation(task.id,{collectionExternalId:externalId,collectionPolling:{...task.automation.collectionPolling,startedAt,...patch}});
    try{
      const client=await settings.erp();
      const result=poll?await client.pollCollection(input,{signal}):await client.startCollection(input,{signal,checkpoint});
      if(signal?.aborted)return{waiting:true,reason:'采集查询已暂停，进度已保留'};
      if(result.state!=='ready')return{waiting:true,reason:result.reason,externalId:result.externalId,pollAfterMs:result.uncertain?60000:30000,pollState:result.uncertain?'unknown':'waiting',startedAt};
      // The main record may become available before the original image list.
      // A transient failure here must resume readback, never resubmit the link.
      const extras=await client.originalImages(result.externalId,signal);
      const urls=value=>Array.isArray(value)?value.filter(item=>typeof item==='string'):typeof value==='string'?value.split(',').filter(Boolean):[];
      const full=[extras?.mainPic,...urls(extras?.mainPic11),...urls(extras?.mainPic34),...urls(extras?.detailPic)];
      return{...result.source,externalId:result.externalId,images:[...new Set([...result.source.images,...full].filter(Boolean))].slice(0,60),originalImages:extras};
    }catch(error){
      if(signal?.aborted||error.code==='ERP_CANCELLED')throw error;
      const temporary=['ERP_TIMEOUT','ERP_NETWORK','ERP_UPSTREAM_TIMEOUT'].includes(error.code)||[408,425,429,500,502,503,504].includes(error.status)
        ||typeof error.code==='number'&&error.code>=500&&error.code<600;
      if(temporary)return{waiting:true,reason:'互拓暂时无法返回采集资料，将在60秒后继续查询原记录',externalId:task.automation.collectionExternalId||'',pollAfterMs:60000,pollState:'query_error',queryError:String(error.message||'互拓采集查询暂不可用').slice(0,240),startedAt};
      if(error.code==='ERP_COLLECTION_FAILED')error.tag='互拓明确采集失败';
      else if(error.code==='ERP_COLLECTION_REJECTED')error.tag='互拓未接受采集';
      else if(error.code==='ERP_COLLECTION_MISMATCH')error.tag='采集记录冲突';
      throw error;
    }
  }
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
      if(comparison&&checkpoints[comparison]?.jobId){const saved={...checkpoints[comparison]};const job=bridge.snapshot().jobs.find(row=>row.id===saved.jobId);if(job&&['partial','failed'].includes(job.status)&&!(a.step==='marketplace'&&job.buyerTaskId===task.id&&job.items.some(item=>review.decision(item)?.verdict==='likely_same'&&(task.marketplaceCandidates||[]).some(source=>source.detailUrl===item.detailUrl&&source.imageUrl===item.imageUrl)))){const retried=await bridge.retry(job.id,false);checkpoints[comparison]={...saved,jobId:retried.id||job.id,result:undefined};}else if(!job)delete checkpoints[comparison];}
      if(a.step==='supplier_facts'){
        const modelRetryState={...(a.modelRetryState||{})};
        for(const key of ['supplier_facts','supplier_ocr'])modelRetryState[key]={...(modelRetryState[key]||{}),autoRetryCount:0,manualRetryRounds:(modelRetryState[key]?.manualRetryRounds||0)+1};
        if(a.supplier?.platform==='wsy'&&(a.supplierDetails?.attributes||[]).some(value=>/^(?:材质成分|面料成分|成分及含量)\s*[:：].*(?:\.\.\.|…)\s*$/.test(String(value)))){
          delete checkpoints.supplier;
          return{checkpoints,modelRetryState,step:'supplier_details'};
        }
        return{checkpoints,modelRetryState,step:'supplier_facts'};
      }
      if(a.step==='marketplace'&&task.sourceType!=='taobao'&&!task.marketplaceCandidates?.length){
        const command=bridge.snapshot().browserCommands.filter(row=>row.buyerTaskId===task.id&&row.kind==='taobao-image-search').at(-1);
        if(task.marketplaceSearch?.status==='failed'||command?.status==='failed'){
          const bytes=await workflow.image(task.id),next=await bridge.enqueueTaobaoSearch({buyerTaskId:task.id,imageData:imageData(bytes),sourceType:task.sourceType,sourceUrl:task.sourceUrl,queryName:task.sourceTitle||'自动买手套图'});
          await workflow.queueTaobaoSearch(task.id,next.id);await bridge.resumeTaobaoSearch();
        }
      }
      if(a.step==='mapping'){
        const modelRetryState={...(a.modelRetryState||{})};
        for(const key of ['mapping_category','mapping_fields','mapping_repair'])modelRetryState[key]={...(modelRetryState[key]||{}),autoRetryCount:0,manualRetryRounds:(modelRetryState[key]?.manualRetryRounds||0)+1};
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
    async searchSuppliers(task){return browserStep(task,'search',{kind:'buyer-supplier-search',searchMode:task.automation.searchMode==='detail'?'detail':'top',imageData:imageData(await workflow.image(task.id))});},
    async compareSuppliers(task){return compare(task,'supplier',task.automation.searchCandidates,'supplierComparison');},
    supplierDetails(task){const selected=task.automation.supplier;return browserStep(task,'supplier',{kind:'buyer-source',platform:selected.platform,detailUrl:selected.detailUrl});},
    async facts(task){
      const details=task.automation.supplierDetails;
      const images=await evidenceImages(task,details);
      const output=await invokeModelJson(task,'supplier_facts',{instruction:'提取供应商事实，返回 {articleNo,supplierName,cost,colors:string[],sizes:string[],materials:[{name,rate:number|null}],sizeImageIndex:number|null,fork:0|1|null,variant,warehouse,categoryName,priceConflict:boolean,evidence:{articleNo,supplierName,cost,colors,sizes,materials}}。evidence每项须为供应商原文连续引文；只有图片可清晰读到时可用{quote,imageIndex}，imageIndex对应supplier.images索引。输入第一张是选品原图，随后供应商图的原索引顺序见availableSupplierImageIndices。cost只能取明确供货价；阶梯价须连同数量档原文保留，不能将最低限价当作供货成本，规格或采购数量不明时将priceConflict设为true。成分优先读取当前商品的面料/成分属性，填充物和里料分别保留原文，不能混为面料比例。只给出名称未给比例时保留名称，rate为null，不得推定100%。尺码图索引对应supplier.images。fork仅在有公版/专版证据时确定；未知用null。不要把店铺推荐商品当当前商品。',data:{supplier:details,inputArticleNo:task.articleNo,availableSupplierImageIndices:images.supplierIndices},images});
      Object.assign(output,mergeStructuredSupplierFacts(output,details));
      output.verifiedOcrFields=[];
      const ocr=Object.entries(output.evidence||{}).filter(([,value])=>value&&typeof value==='object');
      if(ocr.length){const verification=await invokeModelJson(task,'supplier_ocr',{instruction:'独立复核供应商图片的OCR事实。第一张是选品原图，随后是供应商图片。只返回{verifiedFields:string[]}。逐个核对字段值、quote及imageIndex，数值/比例/颜色尺码有任何不清楚或不一致就不得列入verifiedFields，不使用常识猜测。',data:{facts:output,evidence:ocr,availableSupplierImageIndices:images.supplierIndices},images});output.verifiedOcrFields=Array.isArray(verification.verifiedFields)?verification.verifiedFields.filter(key=>images.supplierIndices.includes(output.evidence?.[key]?.imageIndex)):[];}
      return validateSupplierFacts(output,details);
    },
    async marketplace(task){
      if(task.sourceType==='taobao')return{url:task.sourceUrl,title:task.automation.source.title,salesText:task.automation.source.salesText,confirmedSame:true};
      if(!task.marketplaceCandidates?.length){
        const commands=bridge.snapshot().browserCommands;const latest=commands.filter(command=>command.buyerTaskId===task.id&&command.kind==='taobao-image-search').at(-1);
        if(latest?.status==='failed')throw tagError(latest.error||'淘宝搜款失败','淘宝登录或验证');
        const pending=commands.some(command=>command.buyerTaskId===task.id&&command.kind==='taobao-image-search'&&['queued','claimed'].includes(command.status));
        if(!pending){const bytes=await workflow.image(task.id);const command=await bridge.enqueueTaobaoSearch({buyerTaskId:task.id,imageData:imageData(bytes),sourceType:task.sourceType,sourceUrl:task.sourceUrl,queryName:task.sourceTitle||'自动买手套图'});await workflow.queueTaobaoSearch(task.id,command.id);}
        return{waiting:true};
      }
      const result=await compare(task,'taobao',sales.sort(task.marketplaceCandidates),'marketplaceComparison');if(result.waiting)return result;
      const jobId=task.automation.checkpoints?.marketplaceComparison?.jobId,live=jobId&&bridge.snapshot().jobs.find(job=>job.id===jobId&&job.buyerTaskId===task.id);
      const originalFor=item=>{
        const link=sourceLink(item.detailUrl);if(item.platform!=='taobao'||link?.sourceType!=='taobao')return null;
        return task.marketplaceCandidates.find(source=>sourceLink(source.detailUrl)?.sourceUrl===link.sourceUrl&&source.imageUrl===item.imageUrl);
      };
      const confirmed=live?(result.items||[]).filter(item=>review.decision(item)?.verdict==='likely_same'&&originalFor(item)):[];
      const selected=task.marketplaceCandidate?.confirmedSame&&task.marketplaceCandidate.jobId===jobId
        ?confirmed.find(item=>item.detailUrl===task.marketplaceCandidate.url):null;
      // A single valid v4 human review can be recovered without another model
      // request. Multiple confirmations require an explicit source choice.
      const choice=selected||(confirmed.length===1?confirmed[0]:null);
      if(choice){
        const source=originalFor(choice);
        await workflow.setMarketplaceLink(task.id,{url:choice.detailUrl,title:choice.title,salesText:source.salesText,confirmedSame:true,jobId,candidateIndex:live.items.findIndex(item=>item.detailUrl===choice.detailUrl&&item.imageUrl===choice.imageUrl)});
        return task.marketplaceCandidate;
      }
      return{requiresHuman:true,status:result.status,items:result.items};
    },
    async draftList(options){const data=await(await settings.erp()).listDrafts(options,signal);return{...data,list:data.list.map(normalizeDraftListItem).filter(Boolean)};},
    async draftDetail(id){const client=await settings.erp(),draft=await client.getDraft(id,signal);if(!draft||String(draft.id)!==String(id))throw new Error('互拓草稿不存在或无法读取');const results=await Promise.allSettled([client.draftAttributes(id,signal),client.draftPictures(id,signal)]);const failed=results.flatMap((result,index)=>result.status==='rejected'?[index===0?'动态属性与尺码':'商品图片']:[]);if(failed.length)throw new Error(`草稿基本资料已读取，但${failed.join('、')}未完整取得，请重新查看资料后再确认`);return normalizeDraftDetail({draft,attributes:results[0].value,pictures:results[1].value});},
    async deleteDraftEntry(id){const client=await settings.erp(),draft=await client.getDraft(id,signal);if(!draft||String(draft.id)!==String(id))throw new Error('互拓草稿不存在或无法读取');if(draft.draftState!=='DRAFT')throw new Error('只有 DRAFT 草稿可以删除，已转待审核的记录不能从这里删除');await client.deleteDraft(id,signal);return{draftId:String(id),deleted:true};},
    async convertDraftEntry(id,expectedRevision){const client=await settings.erp(),draft=await client.getDraft(id,signal);if(!draft||String(draft.id)!==String(id))throw new Error('互拓草稿不存在或无法读取');if(draft.draftState==='CONVERTED'&&draft.convertedProductId){const product=await client.productDetail(String(draft.convertedProductId),signal);if(!product?.productNo)throw new Error('草稿已转换，但产品编码回读失败');return{draftId:String(id),productId:String(draft.convertedProductId),productNo:product.productNo,productState:product.productState};}if(draft.draftState!=='DRAFT')throw new Error('草稿状态不是可转换的 DRAFT，请刷新详情确认，避免重复建品');const revision=Number(draft.draftVersion??draft.revision);if(!Number.isInteger(revision)||revision<1)throw new Error('草稿缺少有效版本号，无法安全转换');if(!Number.isInteger(expectedRevision)||expectedRevision!==revision)throw new Error('草稿资料版本已变化，请重新查看资料后再确认转换');let productId=String(draft.convertedProductId||'');if(!productId)productId=String(await client.convertDraft(id,revision,signal));if(!/^\d+$/.test(productId))throw new Error('草稿转换回执缺少有效产品编号');const product=await client.productDetail(productId,signal);if(!product?.productNo||![0,1].includes(product.productState))throw new Error('草稿已转换但产品池回读未通过，请刷新确认');return{draftId:String(id),productId,productNo:product.productNo,productState:product.productState};},
    collect:task=>collectionStep(task,false),
    pollCollection:task=>collectionStep(task,true),
    async map(task){
      const client=await settings.erp(),catalog=await settings.catalogs(signal),facts=task.automation.facts;
      const terms=supplierSearchTerms(task),lookups=[];
      let directory=[],directoryReady=false;
      try{directory=typeof settings.supplierDirectory==='function'?await settings.supplierDirectory(signal):typeof client.supplierDirectory==='function'?supplierRows(await client.supplierDirectory(signal)):[];directoryReady=directory.length>0;}catch(error){if(signal?.aborted)throw error;lookups.push({kind:'directory',ok:false});}
      const searchRows=[];
      // A complete cached directory already includes all candidates. Use
      // keyword requests only as a fallback, then validate the selected entry.
      if(!directoryReady)for(const term of terms){try{const rows=supplierRows(await client.suppliers(term,signal));searchRows.push(...rows);lookups.push({kind:'name',term,ok:true,count:rows.length});}catch(error){if(signal?.aborted)throw error;lookups.push({kind:'name',term,ok:false});}}
      const all=supplierRows([...directory,...searchRows]),candidates=rankSuppliers(all,task),candidateState={catalogCount:all.length,completeDirectory:directoryReady,candidates,lookups,at:new Date().toISOString()};
      await workflow.patchAutomation(task.id,{mappingCandidates:candidateState});
      if(!candidates.length)return{missing:['互拓未返回可用供应商档案，请检查供应商是否已审核启用'],payload:null,evidence:{supplierCandidates:candidateState}};
      const images=await evidenceImages(task,task.automation.supplierDetails);
      const preliminary=await invokeModelJson(task,'mapping_category',{instruction:'只从给定categories选择与供应商实际服装一致的categoryName，同时从supplierCandidates选择真实对应的互拓供应商，返回{productTypeName:string,supplierCandidateId:string,supplierEvidence:string}。supplierEvidence只返回商品页实际店铺名称的简短原文片段，不加解释性前后缀；档口地址可能不是ERP登记店名，要结合页面店名、发货地、档口编号和供应商缩写。不得只因同一服装城或图片同款就视为同一供货商。候选编号必须原样返回，不生成供应商缩写。标题不可靠时类别以商品可见结构为依据；夹克与棉服按供应商是否有填充物区分。无法核实对应关系返回空编号。',data:{categories:catalog.categories.map(row=>({categoryName:row.categoryName,categoryAb:row.categoryAb})),supplierCandidates:candidates,supplierCatalogCount:all.length,supplier:task.automation.supplierDetails,facts,origin:{supplierName:task.origin?.supplierName||'',externalCode:task.origin?.externalCode||''}},images});
      const selected=resolveSupplier(preliminary,candidates,task);
      if(!selected.supplier)return{missing:[selected.reason],payload:null,evidence:{supplierCandidates:candidateState,modelSelection:preliminary}};
      // The complete directory also contains historical names. Confirm the
      // selected identity through the ERP's enabled/approved sample list.
      const enabled=supplierRows(await client.suppliers(selected.supplier.supplierName,signal)).find(row=>row.supplierName===selected.supplier.supplierName&&row.supplierAb===selected.supplier.supplierAb);
      if(!enabled)return{missing:['已找到对应互拓供应商，但档案未在已审核启用列表中，请在互拓确认状态'],payload:null,evidence:{supplierCandidates:candidateState,selection:selected}};
      const supplier={...selected.supplier,...enabled,storeHouse:selected.supplier.storeHouse||enabled.storeHouse};
      await workflow.patchAutomation(task.id,{supplierMapping:{...supplier,method:selected.method,evidence:selected.evidence,...(selected.modelReason?{modelReason:selected.modelReason}:{}),sourceSupplierName:facts.supplierName,at:new Date().toISOString()}});
      const category=catalog.categories.find(row=>row.categoryName===preliminary.productTypeName);if(!category)return{missing:['无法确认互拓类别'],payload:null};
      const controls=await client.controls(category.categoryName,signal);
      const activeControls=mappingControls(controls,category.categoryName);
      const colors=[];for(const name of facts.colors){const found=await client.colors(name,signal);if(Array.isArray(found))colors.push(...found);}
      const instruction='根据供应商事实、全部互拓字典和当前类别控件一次性填写完整资料，返回 {productTypeName,storeHouse,pallet,industry,season,technology,style,ageState:string[],sizeType,extendedAttributes:object}。只使用给定启用选项；逐项处理required字段。ageState是商品推荐成交年龄，可结合页面适用人群、款式、图片和此前有效建议推断推荐范围，必须选择ages字典中的一个或多个标签；它不是实际买家年龄统计。industry、season、style、pallet、ageState、sizeType均需完整填写。款式、领型、袖型、厚度、适用场景等描述可根据商品图片和原文判断，无需软件人工逐项确认。仓库优先用已选择互拓供应商档案。sizeType必须为“国际码”“通用码”或“数值码”，不得返回字典类型键名。成本、货号、颜色尺码、成分比例采用已核实facts，不得改写；淘宝套图的规格是素材展示范围，不能删减供应商可供规格。特殊工艺无原文或图片证据时technology返回空字符串，不要从工艺字典随意选一个。品牌、质检及其他需要真实凭证的字段不猜测。图片字段仅从providedImageUrls选择。填写结果将直接保存互拓待审核，人工在互拓统一检查；只有真实信息缺失才留空。';
      const relevantTypes=new Set(['warehouse_infos','pallet_infos','industry','season','technology_infos','product_style','ages','international_code','universal_code','numerical_code','material_composition','suit_pic_source']);
      const data={responseShape:{productTypeName:category.categoryName,storeHouse:'从warehouse_infos选择',pallet:'从pallet_infos选择',industry:'从industry选择',season:'从season选择',technology:'没有特殊工艺为空字符串',style:'从product_style选择',ageState:['从ages选择'],sizeType:'国际码或通用码或数值码',extendedAttributes:'按controls的字段名填写JSON对象'},category:{categoryName:category.categoryName,categoryAb:category.categoryAb},dictionaries:catalog.dictionaries.filter(row=>relevantTypes.has(row.dictType)).map(({dictType,label,value})=>({dictType,label,value})),controls:activeControls,erpSupplier:supplier,supplier:{title:task.automation.supplierDetails.title,shopName:task.automation.supplierDetails.shopName,boothName:task.automation.supplierDetails.boothName,attributes:task.automation.supplierDetails.attributes,visibleText:task.automation.supplierDetails.visibleText?.slice(0,1800)},facts,providedImageUrls:[...(task.automation.source?.images||[]),...(task.automation.collection?.images||[]),...(task.automation.supplierDetails?.images||[]),facts.sizePic].filter(Boolean)};
      const {validateDraftPayload}=await import('./erp/contract.mjs');
      const build=output=>{const mapping=normalizeMapping({...output,productTypeName:category.categoryName},catalog,activeControls),result=buildPayload({mapping,facts,source:task.automation.source,marketplace:task.automation.marketplace,collection:task.automation.collection,catalog,controls,settings:settings.value,supplier,colors,supplierImages:task.automation.supplierDetails?.images});return{...result,missing:[...new Set([...result.missing,...validateDraftPayload(result.payload)])],mapping};};
      const enumValues=type=>[...new Set(catalog.dictionaries.filter(row=>row.dictType===type).map(row=>String(row.label).trim()).filter(Boolean))];
      const stringField=(values=[])=>({type:'string',...(values.length?{enum:[...new Set(['',...values])]}:{})});
      const attributeProperties=Object.fromEntries(Object.entries(activeControls).map(([key,rule])=>{const options=(rule.option||[]).map(value=>typeof value==='string'?value:String(value.value??value.label??''));const field=stringField(options);return[key,['multi_select','material_select','checkbox'].includes(rule.type)?{type:'array',items:field}:field];}));
      const properties={productTypeName:{type:'string',enum:[category.categoryName]},storeHouse:stringField(enumValues('warehouse_infos')),pallet:stringField(enumValues('pallet_infos')),industry:stringField(enumValues('industry')),season:stringField(enumValues('season')),technology:stringField(enumValues('technology_infos')),style:stringField(enumValues('product_style')),ageState:{type:'array',items:stringField(enumValues('ages'))},sizeType:{type:'string',enum:['国际码','通用码','数值码']},extendedAttributes:{type:'object',properties:attributeProperties,required:Object.keys(attributeProperties),additionalProperties:false}};
      const jsonSchema={type:'object',properties,required:Object.keys(properties),additionalProperties:false};
      const validFields=output=>typeof output.extendedAttributes==='object'&&!Array.isArray(output.extendedAttributes)&&typeof output.sizeType==='string'&&typeof output.industry==='string';
      let output=await invokeModelJson(task,'mapping_fields',{instruction,data,images,jsonSchema,validate:validFields}),result=build(output);
      await workflow.patchAutomation(task.id,{mappingModelResults:{category:preliminary,fields:output,at:new Date().toISOString()}});
      const repairable=missing=>missing.filter(value=>/类别必填|专版品牌|缺少 (?:industry|season|technology|style|ageState|pallet|storeHouse)|尺码类型|图.*字段/.test(value));
      if(repairable(result.missing).length){
        output=await invokeModelJson(task,'mapping_repair',{instruction:instruction+'这是本机校验后的自动修正，只补齐或修正列出的invalidFields；其他已填字段保留，不替换供应商或商品事实。返回完整表单对象，不要返回required或complete这类状态摘要。仍无法从证据判断的项留空。',data:{...data,previous:result.mapping,invalidFields:repairable(result.missing)},images,jsonSchema,validate:validFields});
        const filled=value=>value!==undefined&&value!==null&&value!==''&&(!Array.isArray(value)||value.length>0);
        const patch=Object.fromEntries(Object.entries(output).filter(([key,value])=>key!=='extendedAttributes'&&filled(value)));
        const attributes=Object.fromEntries(Object.entries(output.extendedAttributes||{}).filter(([,value])=>filled(value)));
        result=build({...result.mapping,...patch,extendedAttributes:{...result.mapping.extendedAttributes,...attributes}});
        await workflow.patchAutomation(task.id,{mappingModelResults:{...task.automation.mappingModelResults,repair:output}});
      }
      return{...result,evidence:{...result.evidence,erpSupplier:supplier,supplierSelection:{method:selected.method,evidence:selected.evidence},candidateCount:all.length,autoFilled:true}};
    },
    async prepare(payload){const {prepareDraftAttempt}=await import('./erp/contract.mjs');return prepareDraftAttempt(payload);},
    async prepareProduct(payload){const {prepareProductAttempt}=await import('./erp/contract.mjs');return prepareProductAttempt(payload);},
    async submitProduct(task){return(await settings.erp()).submitProduct(task.automation.productAttempt,{signal,priorSubmission:task.automation.productSubmission,checkpoint:productSubmission=>workflow.patchAutomation(task.id,{productSubmission})});},
    async verifyProduct(task){return(await settings.erp()).verifyProduct(task.automation.productAttempt,{signal});},
    async submit(task){return(await settings.erp()).submitDraft(task.automation.draftAttempt,{signal});},
    async verify(task){const draft=await(await settings.erp()).getDraft(task.automation.draftId,signal);if(!draft||String(draft.id)!==String(task.automation.draftId))throw new Error('互拓草稿回读未确认同一记录');return draft;},
    target:()=>settings.value.target,
    async convert(task){const client=await settings.erp(),a=task.automation;let id=a.result?.productId;const draft=await client.getDraft(a.draftId,signal);if(draft?.convertedProductId)id=String(draft.convertedProductId);if(!id)id=String(await client.convertDraft(a.draftId,a.draftVersion,signal));const product=await client.productDetail(id,signal);if(!product||!product.productNo||![0,1].includes(product.productState))throw tagError('转换后未取得有效产品编码和状态','互拓回执未知');return{productId:id,productNo:product.productNo,productState:product.productState};},
    async onTaskUpdated(task){return onTaskUpdated(task);}
  };
}
module.exports={createBuyerProviders,publicSource,selectSupplierImageIndices};
