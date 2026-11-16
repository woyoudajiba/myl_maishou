const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const sales=require('../taobao-sales'),review=require('../review');
const {BuyerWorkflow}=require('../desktop/buyer-workflow');
const {createDesktopBridge}=require('../desktop/bridge-server');
const {createBuyerProviders}=require('../desktop/buyer-providers');
const {BuyerEngine}=require('../desktop/buyer-engine');
const candidate=(id,text)=>({id,platform:'taobao',detailUrl:`https://item.taobao.com/item.htm?id=${id}`,imageUrl:`https://img.alicdn.com/${id}.jpg`,title:'翻领针织衫',salesText:text,price:55});

test('淘宝销量保留原始口径，万/千/加号可排序，缺失不是零销量',()=>{
  for(const [value,count] of [['1.2万+人付款',12000],['月销2000+',2000],['已售 3千+件',3000],['10,000人付款',10000],['0人付款',0],['30天内100人付款',100],['未知',null],['',null],['99元',null]])assert.equal(sales.count(value),count,value);
  assert.deepEqual(sales.sort([candidate('10000',''),candidate('20000','1000+人付款'),candidate('30000','1万+人付款'),candidate('40000','0人付款')]).map(item=>item.id),['30000','20000','40000','10000']);
  assert.equal(sales.fields({realSales:0}).salesCount,0);
  assert.equal(sales.label({}),'未采集');
});

test('淘宝销量写入任务和识别批次并在模型处理前降序；重启后保留口径',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'taobao-sales-'));let bridge;
  t.after(async()=>{await bridge?.close();await fs.rm(dir,{recursive:true,force:true});});
  const workflow=new BuyerWorkflow({dataDir:dir});await workflow.load();const task=await workflow.create({sourceType:'image'},Buffer.alloc(80,1));
  const values=[candidate('12345678','200人付款'),candidate('12345679','1.2万+人付款'),candidate('12345680','')];
  await workflow.saveTaobaoSearch(task.id,values);
  assert.deepEqual(workflow.task(task.id).marketplaceCandidates.map(row=>row.id),['12345679','12345678','12345680']);
  let ordered;
  bridge=createDesktopBridge({port:0,dataDir:path.join(dir,'jobs'),processJob:async(job,update)=>{ordered=job.items.map(row=>[row.id,row.salesText]);await update({status:'complete'});}});await bridge.start();
  const job=await bridge.enqueueTaobaoComparison({buyerTaskId:task.id,queryId:crypto.randomUUID(),query:'data:image/jpeg;base64,YWJj',automatic:true,items:values});
  assert.equal(job.reviewMode,'manual');assert.deepEqual(job.items.map(row=>row.salesCount),[12000,200,null]);
  for(let n=0;!ordered&&n<50;n++)await new Promise(r=>setTimeout(r,5));
  assert.deepEqual(ordered,[['12345679','1.2万+人付款'],['12345678','200人付款'],['12345680','']]);
  const restored=new BuyerWorkflow({dataDir:dir});await restored.load();assert.equal(restored.task(task.id).marketplaceCandidates[0].salesText,'1.2万+人付款');
});

test('淘宝高分也等待人工选图，不能自动以销量或模型分数确认并采集',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'taobao-confirm-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const workflow=new BuyerWorkflow({dataDir:dir});await workflow.load();const created=await workflow.create({sourceType:'image'},Buffer.alloc(80,1)),task=workflow.task(created.id);
  const matched={...candidate('12345678','1万+人付款'),imageSimilaritySource:'qwen_multimodal_v1',visualComparison:{verdict:'likely_same',score:99,matches:['领型一致'],differences:[],uncertainties:[]}};
  await workflow.saveTaobaoSearch(task.id,[matched]);
  await workflow.patchAutomation(task.id,{enabled:true,state:'queued',step:'marketplace',checkpoints:{marketplaceComparison:{jobId:'2c6522d8-9c85-4ad6-a3d9-90e8557dddc8',result:{status:'complete',items:[matched]}}}});
  const liveJob={id:'2c6522d8-9c85-4ad6-a3d9-90e8557dddc8',buyerTaskId:task.id,status:'complete',items:[matched]};
  const providers=createBuyerProviders({workflow,bridge:{snapshot:()=>({jobs:[liveJob]})},settings:{},model:()=>null}),engine=new BuyerEngine({workflow,providers});engine.resume=async()=>{};t.after(()=>engine.close());
  await engine.step(task);assert.equal(task.automation.step,'marketplace');assert.equal(task.automation.state,'attention');assert.equal(task.automation.tags[0],'淘宝套图待人工确认');assert.equal(task.automation.marketplace,undefined);
  const reviewed=review.apply(matched,{verdict:'likely_same',note:'人工看图确认'});assert.equal(review.decision(reviewed).verdict,'likely_same');
  liveJob.items=[reviewed];
  await workflow.patchAutomation(task.id,{state:'queued'});await engine.step(task);assert.equal(task.automation.step,'collection');assert.equal(task.automation.marketplace.salesText,'1万+人付款');
});

test('v4已人工确认的相似款在继续原任务时读取最新审核，不重放模型或搜索',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'taobao-v4-recover-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const workflow=new BuyerWorkflow({dataDir:dir});await workflow.load();const created=await workflow.create({sourceType:'image'},Buffer.alloc(80,1)),task=workflow.task(created.id),jobId=crypto.randomUUID();
  const old={...candidate('12345678','1000+人付款'),imageSimilaritySource:'qwen_multimodal_v1',imageSimilarity:.99,visualComparison:{verdict:'similar',score:99,matches:['领型相近'],differences:[],uncertainties:['下摆未展示']}};
  const reviewed=review.apply(old,{verdict:'likely_same',note:'人工确认同款'});
  await workflow.saveTaobaoSearch(task.id,[old]);
  await workflow.patchAutomation(task.id,{enabled:true,state:'attention',step:'marketplace',error:'淘宝未找到可靠同款套图，继续处理下一件',checkpoints:{marketplaceComparison:{jobId,result:{status:'complete',items:[old]}}}});
  let retried=0,validated=0;
  const job={id:jobId,buyerTaskId:task.id,status:'partial',items:[reviewed]};
  const bridge={snapshot:()=>({jobs:[job],browserCommands:[]}),retry:async()=>{retried++;throw Error('不应再调用模型');}};
  const providers=createBuyerProviders({workflow,bridge,settings:{},model:()=>null});providers.validateTask=async()=>{validated++;};
  const engine=new BuyerEngine({workflow,providers});engine.resume=async()=>{};t.after(()=>engine.close());
  await engine.retry(task.id);await engine.step(task);
  assert.equal(task.automation.step,'collection');assert.equal(task.marketplaceCandidate.jobId,jobId);assert.equal(task.marketplaceCandidate.candidateIndex,0);assert.equal(task.automation.marketplace.url,old.detailUrl);
  assert.equal(task.automation.checkpoints.marketplaceComparison.result.items[0].humanReview.verdict,'likely_same');assert.equal(retried,0);assert.equal(validated,2);
  // A later exclusion or a different candidate image must not reuse a prior
  // source selection merely because the URL is still present.
  job.items=[review.apply(old,{verdict:'different',note:'人工排除'})];
  await workflow.patchAutomation(task.id,{step:'marketplace',state:'queued'});await engine.step(task);assert.equal(task.automation.step,'marketplace');assert.equal(task.automation.state,'attention');
  job.items=[reviewed];workflow.task(task.id).marketplaceCandidates[0].imageUrl='https://img.alicdn.com/changed.jpg';
  await workflow.patchAutomation(task.id,{state:'queued'});await engine.step(task);assert.equal(task.automation.step,'marketplace');
});

test('多个v4人工同款不擅自选一个；撤销审核或丢失活批次不能使用缓存确认',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'taobao-choice-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const workflow=new BuyerWorkflow({dataDir:dir});await workflow.load();const created=await workflow.create({sourceType:'image'},Buffer.alloc(80,1)),task=workflow.task(created.id),jobId=crypto.randomUUID();
  const reviewed=['12345678','12345679'].map(id=>review.apply({...candidate(id,'100人付款'),imageSimilaritySource:'qwen_multimodal_v1',visualComparison:{verdict:'similar',score:99,matches:[],differences:[],uncertainties:[]}},{verdict:'likely_same',note:'人工同款'}));
  await workflow.saveTaobaoSearch(task.id,reviewed);await workflow.patchAutomation(task.id,{step:'marketplace',state:'attention',checkpoints:{marketplaceComparison:{jobId,result:{status:'complete',items:reviewed}}}});
  let jobs=[{id:jobId,buyerTaskId:task.id,status:'complete',items:reviewed}];
  const providers=createBuyerProviders({workflow,bridge:{snapshot:()=>({jobs})},settings:{},model:()=>null});
  assert.equal((await providers.marketplace(task)).requiresHuman,true);assert.equal(task.marketplaceCandidate,null);
  await workflow.setMarketplaceLink(task.id,{url:reviewed[1].detailUrl,jobId,candidateIndex:1,confirmedSame:true});
  assert.equal((await providers.marketplace(task)).url,reviewed[1].detailUrl);
  jobs[0].items=reviewed.map(({humanReview,...item})=>item);
  assert.equal((await providers.marketplace(task)).requiresHuman,true);
  jobs=[];await assert.rejects(()=>providers.marketplace(task),/识别记录已移除/);
  jobs=[{id:jobId,buyerTaskId:crypto.randomUUID(),status:'complete',items:reviewed}];await assert.rejects(()=>providers.marketplace(task),/当前商品不一致/);
});

test('套图关联与任务推进一次落盘，保存失败不留下半完成的来源或采集状态',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'taobao-atomic-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const workflow=new BuyerWorkflow({dataDir:dir});await workflow.load();const created=await workflow.create({sourceType:'image'},Buffer.alloc(80,1)),task=workflow.task(created.id),jobId=crypto.randomUUID();
  await workflow.patchAutomation(task.id,{step:'marketplace',state:'attention',error:'旧错误',tags:['无可靠套图'],enabled:true});
  const file=workflow.file;workflow.file=path.join(dir,'blocked');await fs.mkdir(workflow.file);
  await assert.rejects(()=>workflow.setMarketplaceLink(task.id,{url:candidate('12345678','').detailUrl,jobId,candidateIndex:0,confirmedSame:true},{continueAutomation:true}));
  assert.equal(task.marketplaceCandidate,null);assert.equal(task.automation.step,'marketplace');assert.equal(task.automation.state,'attention');
  workflow.file=file;
  await workflow.setMarketplaceLink(task.id,{url:candidate('12345678','').detailUrl,jobId,candidateIndex:0,confirmedSame:true},{continueAutomation:true});
  const restored=new BuyerWorkflow({dataDir:dir});await restored.load();const saved=restored.task(task.id);
  assert.equal(saved.automation.step,'collection');assert.equal(saved.automation.marketplace.url,saved.marketplaceCandidate.url);assert.equal(saved.automation.error,'');assert.deepEqual(saved.automation.tags,[]);
});
