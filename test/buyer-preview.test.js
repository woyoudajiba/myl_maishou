const test=require('node:test'),assert=require('node:assert/strict');
const {buyerTaskComparisonPreview,queueBuyerCandidateGallery,gallerySlot}=require('../desktop/buyer-preview');

const image='data:image/jpeg;base64,fixture';
const candidate={platform:'qcc',detailUrl:'https://www.17qcc.com/item/123.html',imageUrl:'https://pics.17qcc.com/item.jpg',title:'夹克',price:99};
function fixture(source={}){return{id:'f85d70dc-a07e-4715-a968-2fcf94729400',automation:{source,searchCandidates:[candidate,{...candidate,detailUrl:'https://attacker.example/item/2'}],checkpoints:{supplierComparison:{result:{items:[{platform:'qcc',detailUrl:candidate.detailUrl,visualComparison:{verdict:'similar',score:81,matches:['领型相近'],differences:['口袋不同']}}]}}}}};}

test('供应商对照把来源链接完整图集作为缩略图返回，压缩并缓存图片，候选地址仍受验证',async()=>{
  const task=fixture({primaryImageUrl:'https://cdn.17qcc.com/source-1.jpg',images:['https://cdn.17qcc.com/source-1.jpg','https://cdn.17qcc.com/source-2.jpg','https://cdn.17qcc.com/source-3.jpg']});
  let sourceDownloads=0,candidateDownloads=0,failOnce=true;
  const args={workflow:{image:async()=>Buffer.alloc(128,1)},bridge:{snapshot:()=>({jobs:[]})},task,indexes:[0,1],downloadCandidate:async url=>{candidateDownloads++;assert.equal(url,candidate.imageUrl);return{dataUrl:image,evidence:{width:800,height:1000}};},downloadImagePreview:async url=>{sourceDownloads++;if(url.endsWith('source-3.jpg')&&failOnce){failOnce=false;throw Error('暂时不可用');}return{dataUrl:`data:image/jpeg;base64,${Buffer.from(url).toString('base64')}`,width:420,height:420};}};
  const result=await buyerTaskComparisonPreview(args);
  assert.match(result.sourceImage,/^data:image\/jpeg;base64,/);assert.equal(result.sourceGalleryCount,3);assert.equal(result.sourceGallery.length,2);assert.equal(result.sourceGallery[0].image,result.sourceImage);assert.equal(result.sourceGalleryFailed,1);assert.equal(result.candidates[0].title,'夹克');assert.equal(result.candidates[0].comparison.verdict,'similar');assert.equal(result.candidates[0].imageWidth,800);assert.match(result.candidates[1].error,/无效/);assert.equal(sourceDownloads,2);assert.equal(candidateDownloads,1);
  const retried=await buyerTaskComparisonPreview(args);assert.equal(retried.sourceGallery.length,3);assert.equal(retried.sourceGalleryFailed,0);assert.equal(sourceDownloads,3,'重试只下载上次失败的图片');
  await buyerTaskComparisonPreview(args);assert.equal(sourceDownloads,3,'再次打开不会重复下载已生成的缩略图');
  await assert.rejects(()=>buyerTaskComparisonPreview({...args,indexes:[24]}),/请求无效/);
});

test('候选商品图集通过配对浏览器打开受信任商品页，固定槽位避免重复排队',async()=>{
  const task=fixture(),commands=[];
  const workflow={task:()=>task,patchAutomation:async(_id,patch)=>{task.automation={...task.automation,...patch};}};
  const bridge={snapshot:()=>({browserCommands:commands}),enqueueBuyerBrowser:async input=>{commands.push({id:'gallery-command',status:'queued',...input});return commands.at(-1);}};
  const queued=await queueBuyerCandidateGallery({workflow,bridge,task,index:0});
  assert.equal(queued.state,'waiting');assert.match(commands[0].slot,/^gallery:0:[a-f0-9]{10}$/);assert.equal(commands[0].detailUrl,candidate.detailUrl);assert.equal(commands[0].kind,'buyer-source');
  assert.deepEqual(await queueBuyerCandidateGallery({workflow,bridge,task,index:0}),{state:'waiting'});assert.equal(commands.length,1);
  await assert.rejects(()=>queueBuyerCandidateGallery({workflow,bridge,task,index:1}),/候选商品链接无效/);
  const slot=gallerySlot(0,candidate.detailUrl);task.automation.checkpoints[slot]={commandId:'gallery-command',result:{images:['https://cdn.17qcc.com/source-1.jpg','https://cdn.17qcc.com/source-2.jpg']}};
  assert.deepEqual(await queueBuyerCandidateGallery({workflow,bridge,task,index:0}),{state:'ready',total:2});
});
