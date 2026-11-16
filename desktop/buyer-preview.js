const crypto=require('node:crypto');
const {sourceLink}=require('./buyer-links');

const imageCache=new Map();
const platformNames={wsy:'网商园',zwd:'17网',qcc:'青创网',e3hui:'衣衫汇'};
const imageLimit=60;
let activeDownloads=0,downloadQueue=[];
const gallerySlot=(index,url)=>`gallery:${index}:${crypto.createHash('sha256').update(url).digest('hex').slice(0,10)}`;

async function limited(action){
  if(activeDownloads>=4)await new Promise(resolve=>downloadQueue.push(resolve));
  activeDownloads++;
  try{return await action();}finally{activeDownloads--;downloadQueue.shift()?.();}
}
async function thumbnails(urls,downloadImagePreview){
  const unique=[...new Set((Array.isArray(urls)?urls:[]).filter(url=>typeof url==='string'))].slice(0,imageLimit);
  const images=await Promise.all(unique.map(async url=>{
    if(imageCache.has(url))return imageCache.get(url);
    try{
      const preview=await limited(()=>downloadImagePreview(url));
      const item={image:preview.dataUrl,width:preview.width,height:preview.height};imageCache.set(url,item);
      if(imageCache.size>512)imageCache.delete(imageCache.keys().next().value);
      return item;
    }catch{return null;}
  }));
  return{images:images.filter(Boolean),total:unique.length,failed:images.filter(image=>!image).length};
}
function candidateGallery(task,index,candidate,bridge){
  const slot=gallerySlot(index,candidate.detailUrl),saved=task.automation.checkpoints?.[slot],command=saved?.commandId&&bridge?.snapshot().browserCommands.find(row=>row.id===saved.commandId);
  if(saved?.result&&Array.isArray(saved.result.images))return{slot,state:'ready',images:saved.result.images,total:saved.result.images.length};
  if(command&&['queued','claimed'].includes(command.status))return{slot,state:'waiting',images:[],total:0};
  if(command?.status==='failed')return{slot,state:'failed',error:command.error||'商品图集读取失败',images:[],total:0};
  if(saved?.error)return{slot,state:'failed',error:saved.error,images:[],total:0};
  return{slot,state:'idle',images:[],total:0};
}
async function queueBuyerCandidateGallery({workflow,bridge,task,index,retry=false}){
  if(!task?.automation||!Number.isInteger(index)||index<0||index>=task.automation.searchCandidates?.length)throw new Error('候选商品图集请求无效');
  const candidate=task.automation.searchCandidates[index],link=sourceLink(candidate.detailUrl);
  if(!link||link.sourceType!==candidate.platform||!['wsy','zwd','qcc','e3hui'].includes(candidate.platform))throw new Error('候选商品链接无效');
  const state=candidateGallery(task,index,candidate,bridge);
  if(state.state==='ready')return{state:'ready',total:state.total};
  if(state.state==='waiting')return{state:'waiting'};
  if(state.state==='failed'&&!retry)return{state:'failed',error:state.error};
  await workflow.patchAutomation(task.id,{checkpoints:{...(task.automation.checkpoints||{}),[state.slot]:{detailUrl:link.sourceUrl,status:'waiting'}}},'正在从供应商商品链接读取商品图片');
  let command;
  try{command=await bridge.enqueueBuyerBrowser({kind:'buyer-source',buyerTaskId:task.id,slot:state.slot,platform:candidate.platform,detailUrl:link.sourceUrl});}
  catch(error){
    const current=workflow.task(task.id),checkpoints={...(current.automation.checkpoints||{}),[state.slot]:{...(current.automation.checkpoints?.[state.slot]||{}),detailUrl:link.sourceUrl,error:String(error.message||'图集请求失败').slice(0,180)}};
    await workflow.patchAutomation(task.id,{checkpoints});throw error;
  }
  const current=workflow.task(task.id),checkpoints={...(current.automation.checkpoints||{}),[state.slot]:{...(current.automation.checkpoints?.[state.slot]||{}),detailUrl:link.sourceUrl,commandId:command.id,status:'waiting'}};
  await workflow.patchAutomation(task.id,{checkpoints});
  return{state:'waiting',commandId:command.id};
}

async function buyerTaskComparisonPreview({workflow,bridge,task,indexes,downloadCandidate,downloadImagePreview,kind='supplier'}){
  const marketplace=kind==='taobao',rows=marketplace?task?.marketplaceCandidates:task?.automation?.searchCandidates;
  if(!task?.automation||!Array.isArray(indexes)||indexes.length>4||indexes.some(index=>!Number.isInteger(index)||index<0||index>=(rows?.length||0)))throw new Error('供应商图片对照请求无效');
  const source=imageData(await workflow.image(task.id));
  const sourceRecord=task.automation.source||task.automation.checkpoints?.source?.result||{};
  const primaryUrl=sourceRecord.primaryImageUrl||sourceRecord.images?.[0]||'';
  const sourceUrls=[...new Set([...(marketplace?task.automation.supplierDetails?.images||[]:[]),...(sourceRecord.images||[])])].filter(url=>url!==primaryUrl);
  const sourceThumbs=await thumbnails(sourceUrls,downloadImagePreview);
  const sourceGallery=[{image:source,width:null,height:null},...sourceThumbs.images];
  const jobId=task.automation.checkpoints?.[marketplace?'marketplaceComparison':'supplierComparison']?.jobId||'';
  const job=bridge?.snapshot().jobs.find(row=>row.id===jobId&&row.buyerTaskId===task.id)||null;
  const comparisons=job?.items||task.automation.checkpoints?.[marketplace?'marketplaceComparison':'supplierComparison']?.result?.items||[];
  const candidates=await Promise.all(indexes.map(async index=>{
    const candidate=rows[index];
    const link=sourceLink(candidate?.detailUrl);
    if(!link||link.sourceType!==(marketplace?'taobao':candidate.platform)||!(marketplace?['taobao']:['wsy','zwd','qcc','e3hui']).includes(marketplace?'taobao':candidate.platform))return{index,image:'',error:'供应商链接无效，未加载图片'};
    const compared=comparisons.find(item=>item.detailUrl===candidate.detailUrl&&item.platform===(marketplace?'taobao':candidate.platform))||null;
    try{
      let image='';
      if(job&&compared){const compareIndex=job.items.indexOf(compared);if(compareIndex>=0)try{image=await bridge.candidateImage(job.id,compareIndex);}catch{}}
      let metadata=null;
      if(!image){const downloaded=await downloadCandidate(candidate.imageUrl);image=downloaded.dataUrl;metadata={width:downloaded.evidence.width,height:downloaded.evidence.height};}
      const gallery=candidateGallery(task,index,candidate,bridge),galleryThumbs=gallery.state==='ready'?await thumbnails(gallery.images,downloadImagePreview):{images:[],total:gallery.total,failed:0};
      return{index,image,imageWidth:metadata?.width||compared?.imageEvidence?.width||null,imageHeight:metadata?.height||compared?.imageEvidence?.height||null,title:candidate.title||'',shopName:candidate.shopName||'',platform:candidate.platform,price:candidate.price??null,detailUrl:link.sourceUrl,comparison:compared?{verdict:compared.visualComparison?.verdict||'',score:compared.visualComparison?.score??null,matches:compared.visualComparison?.matches||[],differences:compared.visualComparison?.differences||[],uncertainties:compared.visualComparison?.uncertainties||[],status:compared.imageSimilarityStatus||''}:null,galleryState:gallery.state,galleryError:gallery.error||'',galleryImages:galleryThumbs.images,galleryCount:gallery.total,galleryFailed:galleryThumbs.failed};
    }catch(error){return{index,image:'',error:String(error.message||'图片读取失败').slice(0,180),galleryState:'idle',galleryImages:[],comparison:compared?{verdict:compared.visualComparison?.verdict||'',score:compared.visualComparison?.score??null,matches:compared.visualComparison?.matches||[],differences:compared.visualComparison?.differences||[],uncertainties:compared.visualComparison?.uncertainties||[],status:compared.imageSimilarityStatus||''}:null};}
  }));
  return{sourceImage:source,sourceGallery,sourceGalleryCount:sourceUrls.length+1,sourceGalleryFailed:sourceThumbs.failed,candidates};
}

function imageData(buffer){return`data:image/jpeg;base64,${buffer.toString('base64')}`;}
async function supplierImagePreviews({task,indexes,downloadImagePreview,full=false,downloadFull}){
  const images=task?.automation?.supplierDetails?.images;
  if(!Array.isArray(images)||!Array.isArray(indexes)||indexes.length>12||indexes.some(index=>!Number.isInteger(index)||index<0||index>=images.length))throw new Error('供应商图片选择请求无效');
  if(full&&(indexes.length!==1||!downloadFull))throw new Error('一次仅能放大一张供应商图片');
  return Promise.all(indexes.map(async index=>{const url=images[index];try{if(full){const preview=await limited(()=>downloadFull(url));return{index,image:preview.dataUrl,width:preview.evidence?.width,height:preview.evidence?.height};}let item=imageCache.get(url);if(!item){const preview=await limited(()=>downloadImagePreview(url));item={image:preview.dataUrl,width:preview.width,height:preview.height};imageCache.set(url,item);if(imageCache.size>512)imageCache.delete(imageCache.keys().next().value);}return{index,...item};}catch{return{index,error:'图片暂时无法加载，请重试或打开供应商页面核对'};}}));
}
module.exports={supplierImagePreviews,buyerTaskComparisonPreview,queueBuyerCandidateGallery,candidateGallery,gallerySlot,platformNames};
