const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchPersistentContext } = require('./browser');
const { createDesktopBridge } = require('../desktop/bridge-server');
const review = require('../review');
const root = path.resolve(process.env.PC_QA_EXTENSION || path.join(__dirname, '..'));

async function launch(t, endpoint, token) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'product-douyin-workflow-'));
  let context, detailFixtureRequests = 0;
  try {
    context = await launchPersistentContext(profile, { headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
    t.after(async () => { await context?.close(); fs.rmSync(profile, { recursive:true, force:true, maxRetries:5, retryDelay:100 }); });
    await context.route('**/*', route => {
      if (route.request().url().startsWith('https://www.17qcc.com/item/123.html')) {
        detailFixtureRequests++;
        return route.fulfill({ status:200, contentType:'text/html; charset=utf-8', body:`<!doctype html><html><head><meta charset="utf-8"><title>青创同款衬衫</title><script type="application/ld+json">${JSON.stringify({"@type":"Product",name:'青创同款衬衫',sku:'QCC-123',description:'纯棉翻领工装衬衫',image:['https://pics.17qcc.com/products/main.jpg','https://pics.17qcc.com/products/detail.jpg'],offers:{price:'36',seller:{name:'测试工厂店'}}})}</script></head><body><main><h1>青创同款衬衫</h1><table><tr><th>成分</th><td>100%棉</td></tr><tr><th>货号</th><td>QCC-123</td></tr></table><p>标准商品详情页面</p></main></body></html>` });
      }
      if (route.request().url().startsWith('https://')) return route.abort();
      return route.continue();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout:10000});
    await worker.evaluate(async pair => chrome.storage.local.set({productComparisonDesktop:pair,productComparisonDesktopEnabled:true}), {endpoint,token});
    const page = await context.newPage(); await page.goto(worker.url().replace('background.js','workbench.html'));
    await page.waitForFunction(() => !document.getElementById('pick').disabled);
    return {context,worker,page,get detailFixtureRequests() { return detailFixtureRequests; }};
  } catch(error) { await context?.close();fs.rmSync(profile,{recursive:true,force:true});throw error; }
}
async function submitJob(bridge, local, item) {
  const response=await fetch(`http://127.0.0.1:${local.port}/v1/jobs`,{method:'POST',headers:{'Content-Type':'application/json','X-Desktop-Token':local.token},body:JSON.stringify({query:'data:image/jpeg;base64,YQ==',items:[item]})});
  assert.equal(response.status,202);return (await response.json()).id;
}
test('下载首图命令进入配对扩展，自动调用四个平台搜图但不自动提交模型识别', {timeout:35000}, async t=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'product-douyin-search-'));let bridge;
    t.after(async()=>{await bridge?.close();fs.rmSync(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  bridge=createDesktopBridge({dataDir,port:0,canProcess:()=>true,processJob:async()=>{}});const local=await bridge.start();
  const {context,page}=await launch(t,`http://127.0.0.1:${local.port}`,local.token),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.evaluate(()=>{window.searchCalls=[];FindTransport.searchAll=async(_query,_id,selected,update)=>{searchCalls.push(selected);const records=selected.map(platform=>{const item={id:platform+'-1',platform,title:'四平台同款候选',price:36,imageUrl:'https://pics.17qcc.com/candidate.jpg',detailUrl:'https://www.17qcc.com/item/123.html'};const record={key:platform,phase:'complete',message:'测试候选',items:[item],total:1};update(platform,record);return record;});return {items:records.flatMap(r=>r.items),records};};});
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=360;c.height=480;c.getContext('2d').fillRect(0,0,360,480);return c.toDataURL('image/jpeg');});
  const staged=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=220;c.height=300;c.getContext('2d').fillRect(0,0,220,300);return c.toDataURL('image/png').split(',')[1];});
  await page.locator('#files').setInputFiles({name:'staged-before-douyin.png',mimeType:'image/png',buffer:Buffer.from(staged,'base64')});
  await page.waitForFunction(()=>document.querySelectorAll('.query-card').length===1);
  assert.equal(await page.evaluate(()=>searchCalls.length),0,'导入暂存图片本身不启动搜图');
  await bridge.enqueueDouyinSearch({imageData:image,queryName:'测试衬衫',sourceUrl:'https://v.douyin.com/workflow-test/'});
  await page.evaluate(()=>chrome.runtime.sendMessage({type:'PROCESS_DESKTOP_BROWSER_WORKFLOW'}));
  await page.waitForFunction(()=>document.getElementById('queryProgress').textContent.includes('已搜索 1 张'));
  const calls=await page.evaluate(()=>searchCalls);
  assert.equal(calls.length,1);assert.deepEqual([...calls[0]].sort(),['e3hui','qcc','wsy','zwd']);
  assert.equal(await page.locator('.query-card').count(),2);
  assert.match(await page.locator('.query-card').first().textContent(),/待搜索/,'自动交接只执行当前 Douyin 首图，不提前启动其他暂存图片');
  assert.equal(await page.locator('#compareAgain').isEnabled(),true);
  assert.equal(bridge.snapshot().jobs.length,0);
  assert.equal(bridge.snapshot().browserCommands[0].status,'accepted');
  assert.deepEqual(errors,[]);
});

test('人工确认后扩展在同一浏览器会话采集当前商品详情并回传桌面任务', {timeout:35000}, async t=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'product-details-browser-'));let bridge;
  bridge=createDesktopBridge({dataDir,port:0,canProcess:()=>true,processJob:async(job,update)=>{
    const items=job.items.map(item=>({...item,imageSimilaritySource:'qwen_multimodal_v1',imageSimilarityStatus:'compared',imageSimilarity:.91,visualComparison:{id:'candidate_1',verdict:'likely_same',score:91,matches:['领口一致','口袋位置一致'],differences:[],uncertainties:[]}}));
    await update({items,status:'complete',completed:items.length,compared:items.length,progress:100});
  }});
  t.after(async()=>{await bridge?.close();fs.rmSync(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const local=await bridge.start(),item={id:'123',platform:'qcc',title:'模型相似衬衫',price:38,imageUrl:'https://pics.17qcc.com/candidate.jpg',detailUrl:'https://www.17qcc.com/item/123.html'};
  const jobId=await submitJob(bridge,local,item);
  for(let i=0;i<100&&bridge.snapshot().jobs[0].status!=='complete';i++)await new Promise(r=>setTimeout(r,10));
  await assert.rejects(bridge.enqueueDetails(jobId,0),/确认该商品为疑似同款/);
  const {context,worker}=await launch(t,`http://127.0.0.1:${local.port}`,local.token);
  const detailPage=await context.newPage();await detailPage.goto('https://www.17qcc.com/item/123.html');
  const tab=await worker.evaluate(async()=>({...(await chrome.tabs.query({url:'https://www.17qcc.com/item/123.html'}))[0]}));
  assert.ok(tab.id);
  await worker.evaluate(id=>Object.defineProperty(chrome.tabs,'create',{configurable:true,value:async options=>options.url==='https://www.17qcc.com/item/123.html'?{id}:Promise.reject(new Error('unexpected tab'))}),tab.id);
  const original=bridge.snapshot().jobs[0].items[0];
  await bridge.reviewItem(jobId,0,{verdict:'likely_same',score:97,note:'人工核对确认为同款'},review.signature(original));
  const command=await bridge.enqueueDetails(jobId,0);
  assert.equal((await bridge.enqueueDetails(jobId,0)).id,command.id);
  await worker.evaluate(()=>chrome.runtime.sendMessage({type:'PROCESS_DESKTOP_BROWSER_WORKFLOW'}));
  for(let i=0;i<100&&!bridge.snapshot().jobs[0].items[0].productDetails;i++)await new Promise(r=>setTimeout(r,100));
  const saved=bridge.snapshot().jobs[0].items[0].productDetails;
  assert.ok(saved,`详情未写回：${bridge.snapshot().browserCommands.at(-1)?.error}`);
  assert.equal(saved.title,'青创同款衬衫');assert.equal(saved.price,36);assert.equal(saved.sku,'QCC-123');assert.equal(saved.shopName,'测试工厂店');
  assert.deepEqual(saved.images,['https://pics.17qcc.com/products/main.jpg','https://pics.17qcc.com/products/detail.jpg']);
  assert.ok(saved.attributes.some(text=>text.includes('QCC-123')));
  assert.equal(bridge.snapshot().browserCommands.find(entry=>entry.id===command.id).status,'accepted');
});

