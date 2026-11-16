const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {BuyerWorkflow}=require('../desktop/buyer-workflow'),{BuyerEngine}=require('../desktop/buyer-engine'),{createBuyerProviders}=require('../desktop/buyer-providers');
const config={erpManaged:true,erpBaseUrl:'https://wsfile.cn/maishou/api',erpToken:'fixture'};
const input={url:'https://item.taobao.com/item.htm?id=12345678',articleNo:'6803',supplierName:'测试档口'};
const complete={externalId:'12345678',articleNo:'6803',supplierName:'测试档口',title:'淘宝夹克',productData:JSON.stringify({main_pic:'https://img.alicdn.com/jacket.jpg'})};
const response=data=>Response.json({code:0,data});

async function fixture(t,fetchImpl){
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'erp-polling-')),workflow=new BuyerWorkflow({dataDir:dir});await workflow.load();
  const created=await workflow.create({sourceType:'image'},Buffer.alloc(100,1)),task=workflow.task(created.id);
  await workflow.patchAutomation(task.id,{step:'collection',state:'queued',enabled:true,marketplace:{url:input.url},facts:{articleNo:input.articleNo,supplierName:input.supplierName},checkpoints:{}});
  const {ErpClient}=await import('../desktop/erp/client.mjs'),client=new ErpClient(config,{fetchImpl});
  const providers=createBuyerProviders({workflow,settings:{erp:async()=>client},bridge:{},model:()=>null});let syncs=0;providers.onTaskUpdated=async()=>{syncs++;};
  const engine=new BuyerEngine({workflow,providers,signal:new AbortController().signal});
  t.after(async()=>{await engine.close();await fs.rm(dir,{recursive:true,force:true});});
  return{workflow,task,providers,engine,client,dir,advance:ms=>t.mock.timers.tick(ms),syncs:()=>syncs};
}

test('互拓提交与定时回读分离；30秒只查一次，等待不占任务位，完整后自动进入资料整理',async t=>{
  const calls=[];let ready=false;
  const f=await fixture(t,async(url,options)=>{calls.push([new URL(url).pathname,options.method]);if(options.method==='POST')return response({some_num:1,err_url:''});if(url.includes('get-original-images'))return response({detailPic:['https://img.alicdn.com/detail.jpg']});return response(ready?complete:null);});
  await f.engine.step(f.task);assert.equal(f.task.automation.step,'collection_wait');assert.equal(f.task.automation.state,'waiting');assert.equal(f.task.automation.collectionExternalId,'12345678');assert.equal(f.engine.busy.size,0);
  const events=f.task.events.length;for(let i=0;i<10;i++)await f.engine.step(f.task);assert.equal(calls.length,2);assert.equal(f.task.events.length,events);
  f.advance(30000);await f.engine.step(f.task);assert.equal(calls.length,3);assert.equal(f.task.events.length,events,'等待轮询不重复堆积处理记录');assert.equal(f.syncs(),1,'状态相同的轮询不重复回写表行');
  ready=true;f.advance(30000);await f.engine.step(f.task);assert.equal(f.task.automation.step,'mapping');assert.equal(f.task.automation.collection.externalId,'12345678');assert.deepEqual(f.task.automation.collection.images,['https://img.alicdn.com/jacket.jpg','https://img.alicdn.com/detail.jpg']);assert.equal(f.task.automation.collectionPolling.state,'ready');assert.equal(calls.filter(row=>row[1]==='POST').length,1);
});

test('提交超时后60秒只查询原记录，ERP查询503继续等待，不重复提交',async t=>{
  let posts=0,gets=0,failGet=false;
  const f=await fixture(t,async(_url,options)=>{if(options.method==='POST'){posts++;throw new Error('request lost');}gets++;if(failGet)return new Response(JSON.stringify({code:'ERP_UPSTREAM_TIMEOUT'}),{status:503});return response(null);});
  await f.engine.step(f.task);assert.equal(posts,1);assert.equal(f.task.automation.step,'collection_wait');assert.equal(f.task.automation.collectionPolling.state,'unknown');
  f.advance(30000);await f.engine.step(f.task);assert.equal(gets,1);
  failGet=true;f.advance(30000);await f.engine.step(f.task);assert.equal(gets,2);assert.equal(f.task.automation.state,'waiting');assert.equal(f.task.automation.collectionPolling.intervalMs,60000);assert.equal(f.task.automation.collectionPolling.state,'query_error');
  f.advance(60000);await f.engine.step(f.task);assert.equal(gets,3);assert.equal(posts,1);
});

test('预查失败不能误当作无记录；恢复后只登记一次，原图回读失败也不重新登记',async t=>{
  let calls=0,posts=0,ready=false,preflightFail=true,imageFail=true;
  const f=await fixture(t,async(url,options)=>{calls++;if(options.method==='POST'){posts++;return response({some_num:1});}if(url.includes('get-original-images'))return imageFail?new Response(JSON.stringify({code:500}),{status:503}):response({});if(preflightFail)return new Response(JSON.stringify({code:500}),{status:503});return response(ready?complete:null);});
  await f.engine.step(f.task);assert.equal(posts,0);assert.equal(f.task.automation.step,'collection');assert.equal(f.task.automation.collectionExternalId,'');
  preflightFail=false;f.advance(60000);await f.engine.step(f.task);assert.equal(posts,1);assert.equal(f.task.automation.step,'collection_wait');
  ready=true;f.advance(30000);await f.engine.step(f.task);assert.equal(f.task.automation.step,'collection_wait');assert.equal(f.task.automation.collectionPolling.intervalMs,60000);
  imageFail=false;f.advance(60000);await f.engine.step(f.task);assert.equal(f.task.automation.step,'mapping');assert.equal(posts,1);assert.ok(calls>=6);
});

test('原任务与30秒查询计划持久化，重启和旧版超时恢复都只查询原ID',async t=>{
  let posts=0,gets=0;
  const f=await fixture(t,async(_url,options)=>{if(options.method==='POST'){posts++;return response({some_num:1});}gets++;return response(null);});
  await f.engine.step(f.task);const next=f.task.automation.collectionPolling.nextCheckAt;await f.engine.close();
  const restored=new BuyerWorkflow({dataDir:f.dir});await restored.load();const providers=createBuyerProviders({workflow:restored,settings:{erp:async()=>f.client},bridge:{},model:()=>null}),engine=new BuyerEngine({workflow:restored,providers});t.after(()=>engine.close());
  const task=restored.task(f.task.id);assert.equal(task.automation.collectionPolling.nextCheckAt,next);await engine.step(task);assert.equal(gets,1);f.advance(30000);await engine.step(task);assert.equal(gets,2);assert.equal(posts,1);
  await restored.patchAutomation(task.id,{step:'collection',state:'attention',error:'采集等待超时，已保留商品 ID；重试只查询原记录'});
  engine.kick=()=>{};await engine.init();assert.equal(task.automation.step,'collection_wait');assert.equal(task.automation.state,'waiting');assert.equal(posts,1);assert.ok(Date.parse(task.automation.collectionPolling.nextCheckAt)>Date.now());
});

test('ERP明确失败、认证错误和记录冲突不会无限重查；人工继续也只查原记录',async t=>{
  let record=null,auth=false,posts=0;
  const f=await fixture(t,async(_url,options)=>{if(options.method==='POST'){posts++;return response({some_num:1});}return auth?new Response(JSON.stringify({code:401}),{status:401}):response(record);});
  await f.engine.step(f.task);record={title:'数据获取失败'};f.advance(30000);
  await assert.rejects(()=>f.engine.step(f.task),error=>error.code==='ERP_COLLECTION_FAILED'&&error.tag==='互拓明确采集失败');assert.equal(f.task.automation.collectionPolling.state,'failed');
  await f.engine.attention(f.task,'互拓明确采集失败','ERP 标记采集失败');f.engine.resume=async()=>{};await f.engine.retry(f.task.id);assert.equal(f.task.automation.step,'collection_wait');assert.equal(f.task.automation.collectionPolling.nextCheckAt,new Date().toISOString());
  record={...complete,externalId:'99999999'};await assert.rejects(()=>f.engine.step(f.task),error=>error.code==='ERP_COLLECTION_MISMATCH');
  auth=true;await assert.rejects(()=>f.engine.step(f.task),error=>error.status===401);assert.equal(posts,1);
});

test('提交前检查点写失败不会发POST，原ID恢复或记录冲突都不能重复发POST',async()=>{
  const {ErpClient}=await import('../desktop/erp/client.mjs');let posts=0,record=null;
  const client=new ErpClient(config,{fetchImpl:async(_url,options)=>{if(options.method==='POST'){posts++;return response({some_num:1});}return response(record);}});
  await assert.rejects(()=>client.startCollection(input,{checkpoint:async()=>{throw Error('磁盘不可写');}}),/磁盘/);assert.equal(posts,0);
  assert.equal((await client.startCollection({...input,externalId:'12345678'})).state,'waiting');assert.equal(posts,0);
  await assert.rejects(()=>client.pollCollection({...input,externalId:'88888888'}),/ID 不一致/);
  record={...complete,articleNo:'other'};await assert.rejects(()=>client.startCollection(input),/货号或供应商/);assert.equal(posts,0);
  record=complete;assert.equal((await client.startCollection(input)).state,'ready');assert.equal(posts,0);
});

test('等待采集结果不阻塞下一件；暂停和取消不推进后续步骤',async t=>{
  const f=await fixture(t,async(_url,options)=>options.method==='POST'?response({some_num:1}):response(null));
  await f.engine.step(f.task);
  const another=await f.workflow.create({sourceType:'image'},Buffer.alloc(100,2));await f.workflow.patchAutomation(another.id,{step:'source',state:'queued',enabled:true});
  f.providers.source=async()=>({images:[]});f.engine.concurrency=1;
  await f.workflow.setAutoPaused(false);f.engine.kick();
  for(let n=0;n<50&&f.workflow.task(another.id).automation.step!=='supplier_search';n++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(f.workflow.task(another.id).automation.step,'supplier_search');assert.equal(f.task.automation.step,'collection_wait');
  await f.engine.pause();f.advance(30000);const count=f.task.automation.collectionPolling.checkCount;f.engine.kick();assert.equal(f.task.automation.collectionPolling.checkCount,count);
  const stopped=new AbortController();stopped.abort();
  const stoppedProviders=createBuyerProviders({workflow:f.workflow,settings:{erp:async()=>f.client},signal:stopped.signal,model:()=>null,bridge:{}});
  const stoppedEngine=new BuyerEngine({workflow:f.workflow,providers:stoppedProviders,signal:stopped.signal});t.after(()=>stoppedEngine.close());
  await stoppedEngine.step(f.task);assert.equal(f.task.automation.step,'collection_wait');assert.equal(f.task.automation.collectionPolling.checkCount,count);
});

test('暂停队列仍可单独立即查询，忽略下次计划但不启动其他任务、不重新提交',async t=>{
  let posts=0,queries=0,ready=false;
  const f=await fixture(t,async(url,options)=>{if(options.method==='POST'){posts++;return response({some_num:1});}if(url.includes('get-original-images'))return response({});queries++;return response(ready?complete:null);});
  await f.engine.step(f.task);await f.engine.pause();const next=f.task.automation.collectionPolling.nextCheckAt;
  assert.ok(Date.parse(next)>Date.now());assert.equal((await f.engine.queryCollection(f.task.id)).state,'waiting');assert.equal(queries,2);assert.equal(posts,1);assert.equal(f.workflow.state.automationPaused,true);
  ready=true;const result=await f.engine.queryCollection(f.task.id);assert.equal(result.state,'ready');assert.equal(result.paused,true);assert.equal(f.task.automation.step,'mapping');assert.equal(f.workflow.state.automationPaused,true);assert.equal(posts,1);assert.equal(f.engine.busy.size,0);
  await assert.rejects(()=>f.engine.queryCollection(f.task.id),/没有可查询/);
});

test('手动查询与定时处理互斥，失败明确提示，重试依然只查询原记录',async t=>{
  let release,posts=0,failed=true;
  const f=await fixture(t,async(_url,options)=>{if(options.method==='POST'){posts++;return response({some_num:1});}return response(failed?{title:'数据获取失败'}:null);});
  await f.workflow.patchAutomation(f.task.id,{step:'collection_wait',collectionExternalId:'12345678',state:'waiting'});await f.engine.pause();
  const validate=f.providers.validateTask;f.providers.validateTask=()=>new Promise(resolve=>{release=resolve;});
  const pending=f.engine.queryCollection(f.task.id);await Promise.resolve();assert.equal(f.engine.busy.has(f.task.id),true);await assert.rejects(()=>f.engine.queryCollection(f.task.id),/正在查询或处理/);release();
  await assert.rejects(()=>pending,/采集失败/);assert.equal(f.task.automation.state,'attention');assert.equal(f.engine.busy.size,0);assert.equal(f.task.automation.collectionPolling.state,'failed');
  f.providers.validateTask=validate;failed=false;assert.equal((await f.engine.queryCollection(f.task.id)).state,'waiting');assert.equal(posts,0);assert.equal(f.workflow.state.automationPaused,true);
});
