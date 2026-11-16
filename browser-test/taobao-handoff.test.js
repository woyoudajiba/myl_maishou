const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const sharp=require('../desktop/node_modules/sharp');
const {launchPersistentContext}=require('./browser');
const {createDesktopBridge}=require('../desktop/bridge-server');
const {BuyerWorkflow}=require('../desktop/buyer-workflow');
const root=path.resolve(__dirname,'..');

test('真实扩展进程：缺图搜令牌时初始化一次，两张图片串行回写，不泄漏Cookie',{timeout:35000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'taobao-handoff-'));let context,bridge,modelCalls=0;
  t.after(async()=>{await context?.close();await bridge?.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const buyer=new BuyerWorkflow({dataDir:dir});await buyer.load();
  const image=await sharp({create:{width:900,height:1200,channels:3,background:'#305274'}}).jpeg().toBuffer();
  const tasks=[];for(const name of ['裤子','上衣'])tasks.push(await buyer.create({sourceType:'image',sourceTitle:name},image));
  bridge=createDesktopBridge({port:0,dataDir:path.join(dir,'jobs'),processJob:async()=>{modelCalls++;},onTaobaoSearchResults:(id,items,commandId)=>buyer.saveTaobaoSearch(id,items,commandId),onTaobaoSearchFailed:(id,error)=>buyer.failTaobaoSearch(id,error)});
  const local=await bridge.start();
  context=await launchPersistentContext(path.join(dir,'browser'),{headless:true,ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
  await context.route('https://**/*',route=>route.abort());
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  await worker.evaluate(async({endpoint,token})=>{
    await chrome.storage.local.set({productComparisonDesktop:{endpoint,token},productComparisonDesktopEnabled:true});
    await chrome.cookies.set({url:'https://www.taobao.com',domain:'.taobao.com',name:'cookie2',value:'fixture-session',secure:true});
    const original=globalThis.fetch;globalThis.fixtureSearchCalls=[];globalThis.fixtureTokenRefreshes=0;
    globalThis.fetch=async(url,options)=>{
      if(String(url).startsWith('https://h5api.m.taobao.com/')){
        if(!fixtureTokenRefreshes){fixtureTokenRefreshes++;await chrome.cookies.set({url:'https://h5api.m.taobao.com',domain:'.taobao.com',name:'_m_h5_tk',value:'fixture-login-token_999999999',secure:true});return Response.json({ret:['FAIL_SYS_TOKEN_EMPTY::令牌为空'],data:{}});}
        const body=JSON.parse(new URLSearchParams(options.body).get('data')),params=JSON.parse(body.params);
        fixtureSearchCalls.push({strimg:params.strimg,page:params.page});
        const id=String(12345678+fixtureSearchCalls.length);
        return Response.json({ret:['SUCCESS::调用成功'],data:{itemsArray:[{item_id:id,title:'同款候选'+id,pic_path:'https://img.alicdn.com/bao/uploaded/'+id+'.jpg',priceWap:'35.5'}]}});
      }
      if(String(url).startsWith('https://'))throw new Error('测试禁止外网');
      return original(url,options);
    };
  },{endpoint:`http://127.0.0.1:${local.port}`,token:local.token});
  for(const task of tasks){const command=await bridge.enqueueTaobaoSearch({buyerTaskId:task.id,sourceType:'image',imageData:`data:image/jpeg;base64,${image.toString('base64')}`,queryName:task.sourceTitle});await buyer.queueTaobaoSearch(task.id,command.id);}
  await worker.evaluate(()=>pollDesktopCommands());
  assert.equal(bridge.snapshot().browserCommands.filter(command=>command.status==='accepted').length,2);
  assert.equal(buyer.snapshot().every(task=>task.marketplaceSearch.status==='ready'),true);
  assert.notEqual(buyer.snapshot()[0].marketplaceCandidates[0].detailUrl,buyer.snapshot()[1].marketplaceCandidates[0].detailUrl);
  assert.equal(modelCalls,0);assert.equal(bridge.snapshot().jobs.length,0);
  const output=await worker.evaluate(async()=>({calls:fixtureSearchCalls,refreshes:fixtureTokenRefreshes,session:await chrome.declarativeNetRequest.getSessionRules(),stored:JSON.stringify(await chrome.storage.local.get(null))}));
  assert.equal(output.refreshes,1);
  assert.equal(output.calls.length,2);assert.ok(output.calls[0].strimg.length<image.toString('base64').length);
  assert.equal(output.session.some(rule=>rule.id===6401),false);assert.equal(output.stored.includes('fixture-login-token'),false);
});

test('图搜被验证拦截时原插件浏览器打开真实验证页；队列暂停，按钮可重新打开且不重新搜图',{timeout:35000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'taobao-verification-'));let context,bridge;
  t.after(async()=>{await context?.close();await bridge?.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const buyer=new BuyerWorkflow({dataDir:dir});await buyer.load();
  const image=await sharp({create:{width:600,height:800,channels:3,background:'#306274'}}).jpeg().toBuffer();
  const task=await buyer.create({sourceType:'image',sourceTitle:'验证商品'},image),next=await buyer.create({sourceType:'image',sourceTitle:'后续商品'},image);
  bridge=createDesktopBridge({port:0,dataDir:path.join(dir,'jobs'),onTaobaoSearchFailed:(id,error,recovery,commandId)=>buyer.failTaobaoSearch(id,error,recovery,commandId)});
  const local=await bridge.start();
  context=await launchPersistentContext(path.join(dir,'browser'),{headless:true,ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
  await context.route('https://**/*',route=>route.fulfill({contentType:'text/html',body:'<h1>淘宝安全验证测试页</h1>'}));
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  await worker.evaluate(async({endpoint,token})=>{
    await chrome.storage.local.set({productComparisonDesktop:{endpoint,token},productComparisonDesktopEnabled:true});
    await chrome.cookies.set({url:'https://h5api.m.taobao.com',domain:'.taobao.com',name:'_m_h5_tk',value:'fixture-token_999999999',secure:true});
    const original=globalThis.fetch;globalThis.fixtureSecurityCalls=0;
    globalThis.fetch=async(url,options)=>{
        if(String(url).startsWith('https://h5api.m.taobao.com/')){fixtureSecurityCalls++;return Response.json({ret:['FAIL_SYS_USER_VALIDATE::RGV587_ERROR'],data:{url:'https://sec.taobao.com/_____tmd_____/punish?x5secdata=fixture-private-signature'}});}
      if(String(url).startsWith('https://'))throw new Error('测试禁止外网');
      return original(url,options);
    };
  },{endpoint:`http://127.0.0.1:${local.port}`,token:local.token});
  for(const item of [task,next]){const command=await bridge.enqueueTaobaoSearch({buyerTaskId:item.id,sourceType:'image',imageData:`data:image/jpeg;base64,${image.toString('base64')}`});await buyer.queueTaobaoSearch(item.id,command.id);}
  const opened=context.waitForEvent('page');await worker.evaluate(()=>pollDesktopCommands());const verificationPage=await opened;await verificationPage.waitForURL(/_____tmd_____\/punish/);
  assert.equal(bridge.snapshot().taobaoPaused,true);assert.equal(buyer.task(task.id).marketplaceSearch.recovery.page,'verification');
  assert.equal(buyer.task(next.id).marketplaceSearch.status,'queued');assert.equal(await worker.evaluate(()=>fixtureSecurityCalls),1);
  let tabs=await worker.evaluate(()=>chrome.tabs.query({url:'https://sec.taobao.com/*'}));assert.equal(tabs.length,1);assert.equal(tabs[0].active,true);assert.match(tabs[0].url,/fixture-private-signature/);
  const tabId=tabs[0].id;
  assert.equal((await worker.evaluate(()=>chrome.declarativeNetRequest.getSessionRules())).some(rule=>rule.id===6401),false);
  assert.equal(JSON.stringify(bridge.snapshot()).includes('fixture-private-signature'),false);assert.equal(JSON.stringify(buyer.snapshot()).includes('fixture-private-signature'),false);
  assert.equal((await worker.evaluate(async()=>JSON.stringify(await chrome.storage.local.get(null)))).includes('fixture-private-signature'),false);
  const open=await bridge.enqueueTaobaoVerification(task.id);assert.equal((await bridge.enqueueTaobaoVerification(task.id)).id,open.id);
  await worker.evaluate(()=>pollDesktopCommands());assert.equal(bridge.snapshot().browserCommands.find(command=>command.id===open.id).status,'accepted');
  tabs=await worker.evaluate(()=>chrome.tabs.query({url:'https://sec.taobao.com/*'}));assert.equal(tabs.length,1);assert.equal(tabs[0].id,tabId);assert.equal(await worker.evaluate(()=>fixtureSecurityCalls),1);
  await worker.evaluate(id=>chrome.tabs.remove(id),tabId);await bridge.enqueueTaobaoVerification(task.id);const reopened=context.waitForEvent('page');await worker.evaluate(()=>pollDesktopCommands());await(await reopened).waitForURL(/_____tmd_____\/punish/);
  tabs=await worker.evaluate(()=>chrome.tabs.query({url:'https://sec.taobao.com/*'}));assert.equal(tabs.length,1);assert.notEqual(tabs[0].id,tabId);assert.match(tabs[0].url,/fixture-private-signature/);
  const fallback=await worker.evaluate(id=>openTaobaoVerification(id,'https://evil.example/punish',true),next.id);
  assert.equal(fallback.page,'image_search');assert.equal((await worker.evaluate(()=>chrome.tabs.query({url:'https://evil.example/*'}))).length,0);
  assert.equal((await worker.evaluate(()=>chrome.tabs.query({url:'https://s.taobao.com/*'}))).length,1);
  assert.equal(await worker.evaluate(()=>fixtureSecurityCalls),1,'打开验证页不能自动重放搜图');
});
