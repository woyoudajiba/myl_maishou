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

test('真实扩展进程：桌面两张图片逐张图搜，候选回写不启动模型，临时Cookie规则被清除',{timeout:35000},async t=>{
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
    await chrome.cookies.set({url:'https://h5api.m.taobao.com',domain:'.taobao.com',name:'_m_h5_tk',value:'fixture-login-token_999999999',secure:true});
    const original=globalThis.fetch;globalThis.fixtureSearchCalls=[];
    globalThis.fetch=async(url,options)=>{
      if(String(url).startsWith('https://h5api.m.taobao.com/')){
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
  const output=await worker.evaluate(async()=>({calls:fixtureSearchCalls,session:await chrome.declarativeNetRequest.getSessionRules(),stored:JSON.stringify(await chrome.storage.local.get(null))}));
  assert.equal(output.calls.length,2);assert.ok(output.calls[0].strimg.length<image.toString('base64').length);
  assert.equal(output.session.some(rule=>rule.id===6401),false);assert.equal(output.stored.includes('fixture-login-token'),false);
});
