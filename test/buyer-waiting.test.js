const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {BuyerWorkflow}=require('../desktop/buyer-workflow');
const {BuyerEngine}=require('../desktop/buyer-engine');
const {createBuyerProviders}=require('../desktop/buyer-providers');
const {createDesktopBridge}=require('../desktop/bridge-server');

async function setup(t,expectedExtensionVersion=''){
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buyer-waiting-'));
  const workflow=new BuyerWorkflow({dataDir:dir});await workflow.load();
  const created=await workflow.create({sourceType:'douyin',sourceUrl:'https://v.douyin.com/test/'});
  await workflow.patchAutomation(created.id,{enabled:true,step:'source',state:'queued',tags:[],checkpoints:{}});
  let providers;
  const bridge=createDesktopBridge({port:0,dataDir:path.join(dir,'jobs'),expectedExtensionVersion,processJob:async()=>{},onBuyerBrowserResult:(...args)=>providers.onBrowserResult(...args)});
  const local=await bridge.start();
  providers=createBuyerProviders({workflow,bridge,settings:{},model:()=>null,signal:new AbortController().signal});
  const engine=new BuyerEngine({workflow,providers});
  t.after(async()=>{await engine.close();await bridge.close();await fs.rm(dir,{recursive:true,force:true});});
  return{workflow,bridge,engine,providers,task:workflow.task(created.id),advance:ms=>t.mock.timers.tick(ms),local};
}

test('来源等待明确显示插件未连接；超时释放命令，重试原任务可收到新回执并推进',async t=>{
  const {workflow,bridge,engine,providers,task,advance,local}=await setup(t);
  await engine.step(task);
  assert.equal(task.automation.state,'waiting');
  assert.match(task.automation.waitingReason,/插件.*连接/);
  const oldId=task.automation.checkpoints.source.commandId;
  advance(91000);
  await assert.rejects(()=>engine.step(task),error=>error.tag==='浏览器插件未连接');
  assert.equal(bridge.snapshot().browserCommands.find(row=>row.id===oldId).status,'failed');
  await engine.attention(task,'浏览器插件未连接','请连接插件');
  const recovered=await providers.recover(task);
  await workflow.patchAutomation(task.id,{...recovered,state:'queued',tags:[],error:''});
  await engine.step(task);
  const newId=task.automation.checkpoints.source.commandId;
  assert.notEqual(newId,oldId);
  const headers={'X-Desktop-Token':local.token,'Content-Type':'application/json'};
  const ack=id=>fetch(`http://127.0.0.1:${local.port}/v1/browser-commands/${id}/ack`,{method:'POST',headers,body:JSON.stringify({status:'accepted',result:{url:task.sourceUrl,title:'采集成功',images:[],visibleText:'测试'}})});
  assert.equal((await ack(oldId)).status,409,'超时旧回执不能覆盖新任务检查点');
  assert.equal((await ack(newId)).status,200);
  await workflow.attachImage(task.id,Buffer.alloc(128,7));
  await engine.step(task);
  assert.equal(task.automation.step,'supplier_search');
  assert.equal(task.automation.waitingReason,'');
});

test('旧插件或无法确认版本时提示具体更新步骤，不把采集任务交给旧插件；新版连接后原任务可继续',async t=>{
  const {workflow,bridge,engine,providers,task,local}=await setup(t,'26.11.08-v1');
  await engine.step(task);
  const poll=headers=>fetch(`http://127.0.0.1:${local.port}/v1/browser-commands/next`,{headers:{'X-Desktop-Token':local.token,...headers}}).then(response=>response.json());
  const old=await poll({'X-PC-Extension-Version':'26.10.27.18'});
  assert.equal(old.command,null,'旧插件不能领取不兼容采集命令');
  assert.equal(bridge.snapshot().browserClient.state,'update_required');
  await assert.rejects(()=>engine.step(task),error=>error.tag==='插件需要更新'&&/重新加载/.test(error.message));
  await engine.attention(task,'插件需要更新','请更新插件并重新加载');
  const legacy=await poll({});assert.equal(legacy.command,null);
  assert.equal(bridge.snapshot().browserClient.state,'unverified');
  const fresh=await poll({'X-PC-Extension-Version':'26.11.8.1','X-PC-Buyer-Protocol':'1'});
  assert.equal(fresh.command,null,'旧命令已停止，更新不会自动重跑');
  assert.equal(bridge.snapshot().browserClient.state,'ready');
  const patch=await providers.recover(task);await workflow.patchAutomation(task.id,{...patch,state:'queued',tags:[],error:''});
  await engine.step(task);
  const next=await poll({'X-PC-Extension-Version':'26.11.8.1','X-PC-Buyer-Protocol':'1'});
  assert.equal(next.command.buyerTaskId,task.id);
});

test('插件已领取但采集未回执也有截止时间；单件失败不阻挡下一件来源任务',async t=>{
  const {workflow,bridge,engine,providers,task,advance,local}=await setup(t);
  await engine.step(task);
  const headers={'X-Desktop-Token':local.token};
  const claimed=await(await fetch(`http://127.0.0.1:${local.port}/v1/browser-commands/next`,{headers})).json();
  assert.equal(claimed.command.buyerTaskId,task.id);
  await engine.step(task);assert.match(task.automation.waitingReason,/已接单/);
  advance(121000);
  await assert.rejects(()=>engine.step(task),error=>error.tag==='页面采集超时');
  await engine.attention(task,'页面采集超时','平台页面未回执');
  const next=await workflow.create({sourceType:'douyin',sourceUrl:'https://v.douyin.com/next/'});
  await workflow.patchAutomation(next.id,{enabled:true,state:'queued',step:'source',checkpoints:{}});
  await engine.step(workflow.task(next.id));
  assert.equal(bridge.snapshot().browserCommands.filter(row=>row.status==='queued').length,1);
  assert.equal(task.automation.state,'attention');
  await providers.recover(task);
});
test('供应平台登录未完成时重试重搜平台而不复用旧候选和旧识别结果',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buyer-platform-retry-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const workflow=new BuyerWorkflow({dataDir:dir});await workflow.load();const created=await workflow.create({sourceType:'douyin',sourceUrl:'https://v.douyin.com/test/'}),task=workflow.task(created.id),oldJob='19604642-cd8f-4885-bd91-eabffb74e339';
  await workflow.patchAutomation(task.id,{enabled:true,state:'attention',step:'supplier_compare',platformResults:[{key:'qcc',phase:'complete'},{key:'wsy',phase:'failed',message:'请先登录'}],searchCandidates:[{id:'old'}],supplierCandidates:[{id:'old'}],checkpoints:{search:{commandId:'old-search',result:{items:[{id:'old'}]}},supplierComparison:{jobId:oldJob,result:{status:'partial',items:[{id:'old'}]}}}});
  const bridge={snapshot:()=>({jobs:[{id:oldJob,status:'partial'}]}),failBuyerBrowserCommand:async()=>true,retry:async()=>{throw Error('登录失败后应重新搜平台，而不是只重试旧模型输入');}};
  const providers=createBuyerProviders({workflow,bridge,settings:{},model:()=>null,signal:new AbortController().signal}),recovered=await providers.recover(task);
  assert.equal(recovered.step,'supplier_search');assert.deepEqual(recovered.searchCandidates,[]);assert.deepEqual(recovered.platformResults,[]);assert.deepEqual(recovered.supplierCandidates,[]);assert.deepEqual(recovered.checkpoints,{});
});

test('未读取到主图不再因建议核对登录而误标平台登录；明确登录要求仍保留原分类',async t=>{
  const {engine,providers,task,bridge}=await setup(t);await engine.step(task);
  const command=bridge.snapshot().browserCommands[0];
  await providers.onBrowserResult(command,null,'页面没有可用商品资料或清晰图片，请核对链接和登录状态');
  await assert.rejects(()=>engine.step(task),error=>error.tag==='页面采集失败');
  await providers.onBrowserResult(command,null,'平台需要登录，请在浏览器登录后重试');
  await assert.rejects(()=>engine.step(task),error=>error.tag==='平台登录或验证');
});

test('衣衫汇两种站点标识可进入买手比对，保留返回数、可用数和未知报告总数',async t=>{
  const {providers,task,workflow,bridge}=await setup(t);
  const input=(platform,id,url)=>({platform,id,price:30,title:'供应商候选',imageUrl:'https://aodo.i.ximgs.net/'+id+'.jpg',detailUrl:url});
  await providers.onBrowserResult({id:require('node:crypto').randomUUID(),buyerTaskId:task.id,kind:'buyer-supplier-search',slot:'search'}, {
    items:[input('e3hui-cn','cn','https://www.e3hui.cn/product/cn.html'),input('e3hui-com','com','https://www.e3hui.com/product/com.html'),input('e3hui-cn','invalid','https://wrong.example/product/invalid')],
    records:[{key:'e3hui',phase:'complete',total:50},{key:'qcc',phase:'failed',total:null,message:'platform_timeout：青创网搜图回调等待 25 秒超时',diagnostics:{stage:'image_search',timeoutStage:'image_search',failureKind:'timeout',retryable:false,elapsedMs:25000}},
      {key:'zwd',phase:'partial',total:null,diagnostics:{searchGroups:[{type:'accurate',phase:'complete',received:2,total:10},{type:'similar',phase:'failed',received:0,total:null}]}}]
  },'');
  const result=workflow.task(task.id).automation.checkpoints.search.result;
  assert.deepEqual(result.items.map(item=>item.platform),['e3hui','e3hui']);
  const e3=result.platformSearches.find(row=>row.platform==='e3hui');
  assert.equal(e3.receivedCount,3);assert.equal(e3.acceptedCount,2);assert.equal(e3.reportedTotal,50);
  assert.equal(result.platformSearches.find(row=>row.platform==='qcc').reportedTotal,null);
  assert.equal(result.platformSearches.find(row=>row.platform==='qcc').diagnostics.timeoutStage,'image_search');
  assert.equal(result.platformSearches.find(row=>row.platform==='qcc').diagnostics.retryable,false);
  const zwd=result.platformSearches.find(row=>row.platform==='zwd');assert.equal(zwd.searchGroups[0].reportedTotal,10);assert.equal(zwd.searchGroups[1].phase,'failed');
  assert.equal(result.platformSearches.find(row=>row.platform==='wsy').phase,'unknown');
  const job=await bridge.enqueueBuyerComparison({kind:'supplier',buyerTaskId:task.id,queryId:require('node:crypto').randomUUID(),query:'data:image/png;base64,YQ==',items:result.items,platformSearches:result.platformSearches});
  assert.equal(job.items.length,2);assert.equal(job.platformSearches.find(row=>row.platform==='e3hui').receivedCount,3);
});
