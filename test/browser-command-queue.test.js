const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createDesktopBridge}=require('../desktop/bridge-server');

test('配对扩展专属领取抖音搜图命令；快照隐藏首图、完成状态持久化并去重',async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'product-browser-command-'));let bridge;
 t.after(async()=>{await bridge?.close();await fs.rm(dataDir,{recursive:true,force:true});});
 bridge=createDesktopBridge({dataDir,port:0,processJob:async()=>{}});let local=await bridge.start();
 const base=`http://127.0.0.1:${local.port}`,headers={'Content-Type':'application/json','X-Desktop-Token':local.token};
 const input={imageData:'data:image/jpeg;base64,YWJj',queryName:'抖音衬衫',sourceUrl:'https://v.douyin.com/example/'};
 const response=await fetch(base+'/v1/douyin-search',{method:'POST',headers,body:JSON.stringify(input)});assert.equal(response.status,202);
 const command=(await response.json()).command;assert.equal(command.kind,'douyin-search');assert.equal(Object.hasOwn(command,'imageData'),false);
 assert.equal(bridge.snapshot().browserCommands.length,1);assert.equal(Object.hasOwn(bridge.snapshot().browserCommands[0],'imageData'),false);
 const unauthorized=await fetch(base+'/v1/browser-commands/next');assert.equal(unauthorized.status,401);
 const claim=await fetch(base+'/v1/browser-commands/next',{headers:{'X-Desktop-Token':local.token}}),claimed=(await claim.json()).command;
 assert.equal(claimed.id,command.id);assert.equal(claimed.status,'claimed');assert.equal(claimed.imageData,input.imageData);
 const ack=await fetch(base+`/v1/browser-commands/${command.id}/ack`,{method:'POST',headers,body:JSON.stringify({status:'accepted'})});assert.equal(ack.status,200);
 assert.notEqual((await bridge.enqueueDouyinSearch(input)).id,command.id, '已完成的命令不应阻止用户重新搜索同一商品');
 const replay=await fetch(base+`/v1/browser-commands/${command.id}/ack`,{method:'POST',headers,body:JSON.stringify({status:'accepted'})});assert.equal(replay.status,409);
 await bridge.close();bridge=createDesktopBridge({dataDir,port:0,processJob:async()=>{}});local=await bridge.start();
 assert.equal(bridge.snapshot().browserCommands[0].status,'accepted');assert.equal(Object.hasOwn(bridge.snapshot().browserCommands[0],'imageData'),false);
});

test('并发提交抖音任务时原子限量，不超过十项等待中的浏览器队列',async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'product-browser-command-limit-'));let bridge;
 t.after(async()=>{await bridge?.close();await fs.rm(dataDir,{recursive:true,force:true});});
 bridge=createDesktopBridge({dataDir,port:0,processJob:async()=>{}});await bridge.start();
 const results=await Promise.allSettled(Array.from({length:15},(_,i)=>bridge.enqueueDouyinSearch({imageData:'data:image/jpeg;base64,YWJj',queryName:'商品'+i,sourceUrl:`https://v.douyin.com/${i}/`})));
 assert.equal(results.filter(item=>item.status==='fulfilled').length,10);
 assert.equal(results.filter(item=>item.status==='rejected').length,5);
 assert.equal(bridge.snapshot().browserCommands.filter(item=>['queued','claimed'].includes(item.status)).length,10);
});
