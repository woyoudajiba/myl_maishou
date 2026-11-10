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
const imageData='data:image/jpeg;base64,YWJj';
const taskId='2c6522d8-9c85-4ad6-a3d9-90e8557dddc8';
const candidate={id:'12345678',title:'纯棉翻领衬衫',detailUrl:'https://item.taobao.com/item.htm?id=12345678',imageUrl:'https://img.alicdn.com/bao/uploaded/item.jpg_200x200.jpg',price:39.5,salesText:'1000+人付款'};

function adapter(fetchImpl,cookieValues=[{domain:'.taobao.com',name:'_m_h5_tk',value:'testtoken_999999'}]){
  const rules=[],calls=[];
  const chrome={runtime:{id:'a'.repeat(32)},cookies:{getAll(_query,done){done(cookieValues);}},declarativeNetRequest:{updateSessionRules(input,done){rules.push(input);done();}}};
  const context=vm.createContext({chrome,TextEncoder,URL,URLSearchParams,Uint8Array,DataView,Array,Map,Set,Promise,Math,Date,JSON,AbortSignal,btoa,crypto:crypto.webcrypto,
    fetch:async(url,options)=>{if(String(url).startsWith('data:'))return{blob:async()=>({})};calls.push({url,options});return fetchImpl(url,options);},
    createImageBitmap:async()=>({width:900,height:1200,close(){}}),
    OffscreenCanvas:class{constructor(width,height){this.width=width;this.height=height;}getContext(){return{drawImage(){}};}async convertToBlob(){return{arrayBuffer:async()=>Buffer.from('resized-image')};}}
  });
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

test('淘宝登录失效和安全验证明确停止，不返回伪造候选，清除临时请求规则',async()=>{
  const login=adapter(async()=>assert.fail('缺少Cookie不可发起请求'),[]);
  await assert.rejects(login.api.search(imageData),/未登录淘宝/);
  const security=adapter(async()=>({ok:true,status:200,text:async()=>JSON.stringify({ret:['FAIL_SYS_USER_VALIDATE::RGV587_ERROR'],data:{url:'https://sec.taobao.com/punish'}})}));
  await assert.rejects(security.api.search(imageData),/安全验证/);
  assert.equal(security.rules.length,2);assert.equal(security.rules.at(-1).addRules,undefined);
  await assert.rejects(security.api.search('https://evil.example/a.jpg'),/图片数据无效/);
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
