const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {BuyerWorkflow}=require('../desktop/buyer-workflow');
const {createDesktopBridge}=require('../desktop/bridge-server');
const image=Buffer.from([0xff,0xd8,0xff,0xe0,...Buffer.alloc(80,7)]);

test('买手任务验证来源链接，图片独立落盘且Base64不进入任务快照',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buyer-workflow-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const buyer=new BuyerWorkflow({dataDir:dir});await buyer.load();
  await assert.rejects(buyer.create({sourceType:'taobao',sourceUrl:'https://taobao.com/item.htm?id=12345678'}),/有效的抖音/);
  const task=await buyer.create({articleNo:'Q123',sourceType:'douyin',sourceUrl:'https://v.douyin.com/abc/',sourceTitle:'测试商品'},image);
  assert.equal(task.hasImage,true);assert.equal(JSON.stringify(buyer.snapshot()).includes(image.toString('base64')),false);
  assert.deepEqual(await buyer.image(task.id),image);
  const restored=new BuyerWorkflow({dataDir:dir});await restored.load();assert.equal(restored.snapshot()[0].sourceUrl,'https://v.douyin.com/abc/');assert.equal((await restored.image(task.id)).length,image.length);
  const linked=await restored.linkSearch(task.id,'9a1a49c0-40fd-4aa3-99c4-8ddc6ad660c1');assert.equal(linked.queryId,'9a1a49c0-40fd-4aa3-99c4-8ddc6ad660c1');
  const market=await restored.setMarketplaceLink(task.id,{url:'https://item.taobao.com/item.htm?id=12345678&track=abc',confirmedSame:false,salesText:'300+'});
  assert.equal(market.marketplaceCandidate.url,'https://item.taobao.com/item.htm?id=12345678&track=abc');
});

test('买手图搜命令由配对插件接收并把原工作台queryId关联回买手任务',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buyer-command-'));let linked=null;
  const bridge=createDesktopBridge({port:0,dataDir:dir,processJob:async()=>{},onProductSearchAccepted:async(id,queryId)=>{linked={id,queryId};}});
  t.after(async()=>{await bridge.close();await fs.rm(dir,{recursive:true,force:true});});
  const local=await bridge.start(),imageData='data:image/jpeg;base64,'+Buffer.alloc(200,2).toString('base64'),buyerTaskId='2c6522d8-9c85-4ad6-a3d9-90e8557dddc8';
  const response=await fetch(`http://127.0.0.1:${local.port}/v1/product-search`,{method:'POST',headers:{'X-Desktop-Token':local.token,'Content-Type':'application/json'},body:JSON.stringify({buyerTaskId,imageData,queryName:'测试买手商品',sourceUrl:'https://v.douyin.com/abc/'})});
  assert.equal(response.status,202);const command=(await response.json()).command;
  const {command:claimed}=await(await fetch(`http://127.0.0.1:${local.port}/v1/browser-commands/next`,{headers:{'X-Desktop-Token':local.token}})).json();
  assert.equal(claimed.id,command.id);assert.equal(claimed.kind,'product-search');assert.match(claimed.imageData,/^data:image\/jpeg;base64,/);
  const queryId='9a1a49c0-40fd-4aa3-99c4-8ddc6ad660c1';
  const ack=await fetch(`http://127.0.0.1:${local.port}/v1/browser-commands/${command.id}/ack`,{method:'POST',headers:{'X-Desktop-Token':local.token,'Content-Type':'application/json'},body:JSON.stringify({status:'accepted',queryId})});
  assert.equal(ack.status,200);assert.deepEqual(linked,{id:buyerTaskId,queryId});
  const repeated=await(await fetch(`http://127.0.0.1:${local.port}/v1/product-search`,{method:'POST',headers:{'X-Desktop-Token':local.token,'Content-Type':'application/json'},body:JSON.stringify({buyerTaskId,imageData,queryName:'测试买手商品',sourceUrl:'https://v.douyin.com/abc/'})})).json();
  assert.notEqual(repeated.command.id,command.id,'已完成命令不被假冒成仍在等待的任务');
});

test('买手候选图集复用受信任商品页采集命令并保存完整图片URL列表',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buyer-gallery-command-'));let received=null;
  const bridge=createDesktopBridge({port:0,dataDir:dir,processJob:async()=>{},onBuyerBrowserResult:async(command,result)=>{received={slot:command.slot,result};}});
  t.after(async()=>{await bridge.close();await fs.rm(dir,{recursive:true,force:true});});
  const local=await bridge.start(),buyerTaskId='3c6522d8-9c85-4ad6-a3d9-90e8557dddc8',slot='gallery:0:0123456789';
  await assert.rejects(()=>bridge.enqueueBuyerBrowser({kind:'buyer-source',buyerTaskId,slot:'gallery:0:bad',platform:'qcc',detailUrl:'https://www.17qcc.com/item/123.html'}),/命令无效/);
  const command=await bridge.enqueueBuyerBrowser({kind:'buyer-source',buyerTaskId,slot,platform:'qcc',detailUrl:'https://www.17qcc.com/item/123.html'});
  const claimed=(await(await fetch(`http://127.0.0.1:${local.port}/v1/browser-commands/next`,{headers:{'X-Desktop-Token':local.token}})).json()).command;
  assert.equal(claimed.id,command.id);assert.equal(claimed.slot,slot);
  const ack=await fetch(`http://127.0.0.1:${local.port}/v1/browser-commands/${command.id}/ack`,{method:'POST',headers:{'X-Desktop-Token':local.token,'Content-Type':'application/json'},body:JSON.stringify({status:'accepted',result:{url:claimed.detailUrl,title:'供应商商品',images:['https://img.17qcc.com/one.jpg','https://img.17qcc.com/two.jpg']}})});
  assert.equal(ack.status,200);assert.equal(received.slot,slot);assert.equal(received.result.images.length,2);
});
