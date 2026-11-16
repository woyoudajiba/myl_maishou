const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const {createDesktopBridge}=require('../desktop/bridge-server');
const {BuyerWorkflow}=require('../desktop/buyer-workflow');
const {createBuyerProviders}=require('../desktop/buyer-providers');
const {BuyerEngine}=require('../desktop/buyer-engine');
const imageData='data:image/jpeg;base64,YWJj';
const taskId='2c6522d8-9c85-4ad6-a3d9-90e8557dddc8';
const candidate={id:'12345678',title:'纯棉翻领衬衫',detailUrl:'https://item.taobao.com/item.htm?id=12345678',imageUrl:'https://img.alicdn.com/bao/uploaded/item.jpg_200x200.jpg',price:39.5,salesText:'1000+人付款'};

function adapter(fetchImpl,cookieValues=[{domain:'.taobao.com',name:'_m_h5_tk',value:'testtoken_999999'}]){
  const rules=[],calls=[];
  const chrome={runtime:{id:'a'.repeat(32)},cookies:{getAll(_query,done){done(cookieValues);}},declarativeNetRequest:{updateSessionRules(input,done){rules.push(input);done();}}};
  const context=vm.createContext({chrome,TextEncoder,TextDecoder,URL,URLSearchParams,Uint8Array,DataView,Array,Map,Set,Promise,Math,Date,JSON,AbortSignal,btoa,crypto:crypto.webcrypto,
    fetch:async(url,options)=>{if(String(url).startsWith('data:'))return{blob:async()=>({})};calls.push({url,options});return fetchImpl(url,options);},
    createImageBitmap:async()=>({width:900,height:1200,close(){}}),
    OffscreenCanvas:class{constructor(width,height){this.width=width;this.height=height;}getContext(){return{drawImage(){}};}async convertToBlob(){return{arrayBuffer:async()=>Buffer.from('resized-image')};}}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../taobao-sales.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../taobao-search.js'),'utf8'),context);
  return {api:context.FindTaobaoImageSearch,rules,calls};
}

test('淘宝适配签名与标准MD5一致；逐张串行、商品ID与链接严格匹配、搜索请求不使用高清原图',async()=>{
  let active=0,peak=0;
  const fixture=adapter(async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,8));active--;return{ok:true,status:200,text:async()=>JSON.stringify({ret:['SUCCESS::调用成功'],data:{itemsArray:[{item_id:'12345678',pic_path:candidate.imageUrl,title:candidate.title},{item_id:'12345678',pic_path:candidate.imageUrl},{item_id:'56789012',auctionUrl:'https://evil.example/item.htm?id=56789012',pic_path:candidate.imageUrl}]}})};});
  for(const text of ['', 'abc','服装同款', 'x'.repeat(1000)])assert.equal(fixture.api.md5(text),crypto.createHash('md5').update(text).digest('hex'));
  const results=await Promise.all([fixture.api.search(imageData),fixture.api.search(imageData)]);
  assert.equal(peak,1);assert.equal(results[0].length,1);assert.equal(results[0][0].detailUrl,candidate.detailUrl);
  assert.equal(fixture.rules.length,4);assert.deepEqual(Array.from(fixture.rules[1].removeRuleIds),[6401]);
  const request=fixture.calls[0],url=new URL(request.url),body=new URLSearchParams(request.options.body).get('data');
  assert.equal(url.searchParams.get('sign'),crypto.createHash('md5').update(`testtoken&${url.searchParams.get('t')}&12574478&${body}`).digest('hex'));
  const params=JSON.parse(JSON.parse(body).params);assert.equal(params.strimg,Buffer.from('resized-image').toString('base64'));assert.notEqual(params.strimg,imageData.split(',')[1]);
  assert.equal(request.options.credentials,'include');assert.equal(JSON.stringify(results).includes('testtoken'),false);
});

test('淘宝图搜按销量降序返回并保留销量原文，不使用价格排序',async()=>{
  const fixture=adapter(async()=>Response.json({ret:['SUCCESS'],data:{itemsArray:[{item_id:'12345678',pic_path:candidate.imageUrl,realSales:'100人付款',priceWap:'1'},{item_id:'12345679',pic_path:candidate.imageUrl,realSales:'1万+人付款',priceWap:'99'},{item_id:'12345680',pic_path:candidate.imageUrl}]}}));
  const items=await fixture.api.search(imageData);assert.deepEqual(Array.from(items,row=>[row.id,row.salesText,row.salesCount]),[['12345679','1万+人付款',10000],['12345678','100人付款',100],['12345680','',null]]);
});

test('淘宝令牌缺失不误报未登录，安全验证停止且清除临时请求规则',async()=>{
  const login=adapter(async()=>({ok:true,status:200,text:async()=>JSON.stringify({ret:['FAIL_SYS_TOKEN_EMPTY::令牌为空'],data:{}})}),[]);
  await assert.rejects(login.api.search(imageData),/图搜接口令牌未就绪/);assert.equal(login.calls.length,1);
  const security=adapter(async()=>({ok:true,status:200,text:async()=>JSON.stringify({ret:['FAIL_SYS_USER_VALIDATE::RGV587_ERROR'],data:{url:'https://sec.taobao.com/punish'}})}));
  await assert.rejects(security.api.search(imageData),/安全验证/);
  assert.equal(security.rules.length,2);assert.equal(security.rules.at(-1).addRules,undefined);
  await assert.rejects(security.api.search('https://evil.example/a.jpg'),/图片数据无效/);
});

test('图搜验证链接只交给浏览器，不出现在错误文本和JSON中；拒绝非官方地址',async()=>{
  const signed='https://h5api.m.taobao.com/_____tmd_____/punish?x5secdata=private-challenge';
  const fixture=adapter(async()=>Response.json({ret:['FAIL_SYS_USER_VALIDATE::RGV587_ERROR'],data:{url:signed}}));
  await assert.rejects(fixture.api.search(imageData),error=>{
    assert.equal(error.code,'TAOBAO_VERIFICATION_REQUIRED');assert.equal(error.verificationUrl,signed);
    assert.equal(error.message.includes('private-challenge'),false);assert.equal(JSON.stringify(error).includes('private-challenge'),false);return true;
  });
  assert.equal(fixture.calls.length,1);assert.equal(fixture.rules.at(-1).addRules,undefined);
  for(const url of ['https://taobao.com.evil.example/punish','https://evil.example/punish','http://sec.taobao.com/punish','https://user:password@sec.taobao.com/punish','javascript:alert(1)']){
    const invalid=adapter(async()=>Response.json({ret:['FAIL_SYS_USER_VALIDATE'],data:{url}}));
    await assert.rejects(invalid.api.search(imageData),error=>{assert.equal(error.verificationUrl,'');return true;});
  }
  const denied=adapter(async()=>Response.json({ret:['FAIL_SYS_ACCESS_DENIED'],data:{}}));
  await assert.rejects(denied.api.search(imageData),error=>{assert.equal(error.code,undefined);assert.match(error.message,/访问被拒绝/);return true;});
});

test('过期失败回执不覆盖新的淘宝任务，验证链接不会进入任务记录',async t=>{
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'taobao-failure-'));
  t.after(()=>fsp.rm(dir,{recursive:true,force:true}));const workflow=new BuyerWorkflow({dataDir:dir});await workflow.load();
  const task=await workflow.create({sourceType:'image'},Buffer.alloc(80,1));await workflow.queueTaobaoSearch(task.id,'new-command');
  await assert.rejects(()=>workflow.failTaobaoSearch(task.id,'过期失败',null,'old-command'),/过期/);
  assert.equal(workflow.task(task.id).marketplaceSearch.status,'queued');
  await workflow.failTaobaoSearch(task.id,'已打开验证页',{kind:'taobao_verification',opened:true,page:'verification',url:'https://sec.taobao.com/punish?token=private'},'new-command');
  assert.equal(workflow.task(task.id).marketplaceSearch.recovery.opened,true);assert.equal((await fsp.readFile(workflow.file,'utf8')).includes('token=private'),false);
});

test('淘宝缺少或过期签名令牌时，只在明确TOKEN拒绝且收到新令牌后重新签名一次',async()=>{
  for(const stale of [false,true]){
    const cookieValues=stale?[{domain:'.taobao.com',name:'_m_h5_tk',value:'oldtoken_123'}]:[];
    let requests=0;
    const fixture=adapter(async()=>{requests++;if(requests===1){cookieValues.splice(0,cookieValues.length,{domain:'.taobao.com',name:'_m_h5_tk',value:'newtoken_456'});return{ok:true,status:200,text:async()=>JSON.stringify({ret:[stale?'FAIL_SYS_TOKEN_EXOIRED::expired':'FAIL_SYS_TOKEN_EMPTY::empty'],data:{}})};}return{ok:true,status:200,text:async()=>JSON.stringify({ret:['SUCCESS'],data:{itemsArray:[{item_id:'12345678',pic_path:candidate.imageUrl}]}})};},cookieValues);
    const result=await fixture.api.search(imageData);assert.equal(result.length,1);assert.equal(requests,2);
    const request=fixture.calls[1],url=new URL(request.url),body=new URLSearchParams(request.options.body).get('data');assert.equal(url.searchParams.get('sign'),crypto.createHash('md5').update(`newtoken&${url.searchParams.get('t')}&12574478&${body}`).digest('hex'));
    assert.equal(fixture.rules.length,4);assert.equal(fixture.rules.at(-1).addRules,undefined);assert.equal(JSON.stringify(result).includes('newtoken'),false);
  }
});

test('淘宝真正登录失效或网络失败不自动重放搜图请求',async()=>{
  const expired=adapter(async()=>({ok:true,status:200,text:async()=>JSON.stringify({ret:['FAIL_SYS_SESSION_EXPIRED::expired'],data:{}})}));
  await assert.rejects(expired.api.search(imageData),/接口返回登录失效/);assert.equal(expired.calls.length,1);
  const network=adapter(async()=>{throw new Error('network unavailable');});await assert.rejects(network.api.search(imageData),/network unavailable/);assert.equal(network.calls.length,1);assert.equal(network.rules.at(-1).addRules,undefined);
});

test('淘宝令牌连续失效最多请求两次，始终清理临时规则',async()=>{
  const cookieValues=[{domain:'.taobao.com',name:'_m_h5_tk',value:'oldtoken_123'}];let requests=0;
  const fixture=adapter(async()=>{requests++;cookieValues.splice(0,cookieValues.length,{domain:'.taobao.com',name:'_m_h5_tk',value:'changedtoken_'+requests});return{ok:true,status:200,text:async()=>JSON.stringify({ret:['FAIL_SYS_TOKEN_EXPIRED::expired'],data:{}})};},cookieValues);
  await assert.rejects(fixture.api.search(imageData),/图搜接口令牌未就绪/);assert.equal(requests,2);assert.equal(fixture.rules.length,4);assert.equal(fixture.rules.at(-1).addRules,undefined);
});

test('人工继续原任务会新建淘宝搜图命令并恢复队列，旧失败记录不再阻塞新请求',async t=>{
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'taobao-recover-'));let bridge;
  t.after(async()=>{await bridge?.close();await fsp.rm(dir,{recursive:true,force:true});});
  const workflow=new BuyerWorkflow({dataDir:dir});await workflow.load();const created=await workflow.create({sourceType:'image',sourceTitle:'重试商品'},Buffer.alloc(80,1)),task=workflow.task(created.id);
  bridge=createDesktopBridge({port:0,dataDir:path.join(dir,'jobs'),onTaobaoSearchFailed:(id,error)=>workflow.failTaobaoSearch(id,error)});const local=await bridge.start(),headers={'Content-Type':'application/json','X-Desktop-Token':local.token},base=`http://127.0.0.1:${local.port}`;
  const original=await bridge.enqueueTaobaoSearch({buyerTaskId:task.id,imageData,sourceType:'image'});await workflow.queueTaobaoSearch(task.id,original.id);
  await fetch(base+'/v1/browser-commands/next',{headers});const response=await fetch(base+`/v1/browser-commands/${original.id}/ack`,{method:'POST',headers,body:JSON.stringify({status:'failed',error:'当前插件浏览器未登录淘宝，请先登录后重试'})});assert.equal(response.status,200);
  await workflow.patchAutomation(task.id,{step:'marketplace',state:'attention',enabled:true});const providers=createBuyerProviders({workflow,bridge,settings:{},model:()=>null}),engine=new BuyerEngine({workflow,providers});engine.resume=async()=>{};
  await engine.retry(task.id);const current=bridge.snapshot().browserCommands.at(-1);assert.notEqual(current.id,original.id);assert.equal(current.status,'queued');assert.equal(bridge.snapshot().taobaoPaused,false);assert.equal(task.marketplaceSearch.commandId,current.id);
  const result=await providers.marketplace(task);assert.equal(result.waiting,true);assert.equal(bridge.snapshot().browserCommands.length,2);assert.equal(task.automation.state,'queued');await engine.close();
});

test('旧网商园截断成分的原任务重试时重新采集供应商页面',async()=>{
  const providers=createBuyerProviders({workflow:{},bridge:{},settings:{},model:()=>null});
  const patch=await providers.recover({automation:{step:'supplier_facts',supplier:{platform:'wsy'},supplierDetails:{attributes:['材质成分:聚氨酯弹性纤维(氨纶)2.8%...']},checkpoints:{supplier:{result:{old:true}},source:{result:{keep:true}}}}});
  assert.equal(patch.step,'supplier_details');assert.equal(patch.checkpoints.supplier,undefined);assert.equal(patch.checkpoints.source.result.keep,true);
});

test('淘宝候选保存后等待人工识别；失败暂停后续淘宝任务；队列持久恢复且不阻塞四站任务',async t=>{
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'buyer-taobao-'));let bridge;
  t.after(async()=>{await bridge?.close();await fsp.rm(dir,{recursive:true,force:true});});
  const buyer=new BuyerWorkflow({dataDir:dir});await buyer.load();const task=await buyer.create({sourceType:'douyin',sourceUrl:'https://v.douyin.com/test/'},Buffer.alloc(80,1));
  const options={port:0,dataDir:path.join(dir,'jobs'),processJob:async()=>assert.fail('未确认开始识别不可调用模型'),onTaobaoSearchResults:(id,items,commandId)=>buyer.saveTaobaoSearch(id,items,commandId),onTaobaoSearchFailed:(id,error)=>buyer.failTaobaoSearch(id,error)};
  bridge=createDesktopBridge(options);let local=await bridge.start();
  const headers={'Content-Type':'application/json','X-Desktop-Token':local.token};let base=`http://127.0.0.1:${local.port}`;
  const first=await bridge.enqueueTaobaoSearch({buyerTaskId:task.id,imageData,queryName:'衬衫',sourceUrl:task.sourceUrl});await buyer.queueTaobaoSearch(task.id,first.id);
  const repeated=await bridge.enqueueTaobaoSearch({buyerTaskId:task.id,imageData,queryName:'衬衫',sourceUrl:task.sourceUrl});assert.equal(repeated.id,first.id);
  await fetch(base+'/v1/browser-commands/next',{headers});
  const ack=await fetch(base+`/v1/browser-commands/${first.id}/ack`,{method:'POST',headers,body:JSON.stringify({status:'accepted',candidates:[candidate]})});assert.equal(ack.status,200);
  assert.equal(bridge.snapshot().jobs.length,0);assert.equal(buyer.snapshot()[0].marketplaceSearch.status,'ready');assert.equal(buyer.snapshot()[0].marketplaceCandidates.length,1);
  const fail=await bridge.enqueueTaobaoSearch({buyerTaskId:task.id,imageData,queryName:'衬衫',sourceUrl:task.sourceUrl});
  await fetch(base+`/v1/browser-commands/${fail.id}/ack`,{method:'POST',headers,body:JSON.stringify({status:'failed',error:'淘宝要求安全验证'})});
  assert.equal(bridge.snapshot().taobaoPaused,true);assert.equal(buyer.snapshot()[0].marketplaceSearch.status,'failed');
  await bridge.enqueueTaobaoSearch({buyerTaskId:taskId,imageData,queryName:'裤子',sourceUrl:task.sourceUrl});
  const supplier=await bridge.enqueueDouyinSearch({imageData,queryName:'四站搜索',sourceUrl:task.sourceUrl});
  const claim=await(await fetch(base+'/v1/browser-commands/next',{headers})).json();assert.equal(claim.command.id,supplier.id);
  await bridge.close();bridge=createDesktopBridge(options);local=await bridge.start();base=`http://127.0.0.1:${local.port}`;
  assert.equal(bridge.snapshot().taobaoPaused,true);await bridge.resumeTaobaoSearch();assert.equal(bridge.snapshot().taobaoPaused,false);
  const next=await(await fetch(base+'/v1/browser-commands/next',{headers:{'X-Desktop-Token':local.token}})).json();assert.equal(next.command.kind,'taobao-image-search');
});

test('淘宝模型任务重复点击沿用同一批次；替换原图清除旧候选及确认证据',async t=>{
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'taobao-compare-'));const bridge=createDesktopBridge({port:0,dataDir:path.join(dir,'jobs'),processJob:async(_job,update)=>update({status:'complete'})});
  t.after(async()=>{await bridge.close();await fsp.rm(dir,{recursive:true,force:true});});await bridge.start();
  const input={buyerTaskId:taskId,queryId:'9a1a49c0-40fd-4aa3-99c4-8ddc6ad660c1',query:imageData,items:[candidate]};
  const first=await bridge.enqueueTaobaoComparison(input),again=await bridge.enqueueTaobaoComparison(input);assert.equal(first.id,again.id);assert.equal(bridge.snapshot().jobs.length,1);
  await assert.rejects(bridge.enqueueTaobaoComparison({...input,queryId:'3c6522d8-9c85-4ad6-a3d9-90e8557dddc8',items:[{...candidate,imageUrl:'https://evil.example/a.jpg'}]}),/图片地址无效/);
  const buyer=new BuyerWorkflow({dataDir:dir});await buyer.load();const task=await buyer.create({sourceType:'douyin',sourceUrl:'https://v.douyin.com/test/'},Buffer.alloc(100,1));
  await buyer.saveTaobaoSearch(task.id,[candidate]);await buyer.setMarketplaceLink(task.id,{url:candidate.detailUrl,confirmedSame:true});
  await buyer.attachImage(task.id,Buffer.alloc(100,2));assert.equal(buyer.snapshot()[0].marketplaceCandidate,null);assert.equal(buyer.snapshot()[0].marketplaceCandidates.length,0);assert.equal(buyer.snapshot()[0].marketplaceSearch.status,'idle');
});
