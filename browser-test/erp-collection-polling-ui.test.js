const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {_electron}=require('playwright');
const {profileId}=require('../desktop/accounts');
const root=path.resolve(__dirname,'..');

test('互拓采集独立步骤显示定时查询，30秒到期只回读，资料齐全自动推进',{timeout:35000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'erp-collection-ui-'));let app;
  t.after(async()=>{await app?.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const profile=path.join(dir,'profile'),user={id:'collection-ui',username:'collection-ui',displayName:'采集查询测试'},data=path.join(profile,'profiles',profileId(user)),id=crypto.randomUUID(),now=new Date().toISOString();
  const task={id,sourceType:'image',sourceTitle:'等待互拓采集的衣服',sourceUrl:'',createdAt:now,updatedAt:now,events:[],marketplaceCandidates:[],automation:{step:'collection_wait',state:'waiting',enabled:true,error:'',waitingReason:'ERP正在取得商品资料；每30秒查询一次',collectionExternalId:'12345678',collectionPolling:{state:'waiting',externalId:'12345678',startedAt:now,lastCheckedAt:now,nextCheckAt:new Date(Date.now()+30000).toISOString(),intervalMs:30000,checkCount:2},marketplace:{url:'https://item.taobao.com/item.htm?id=12345678'},facts:{articleNo:'6803',supplierName:'测试档口'},supplierDetails:{images:[],sku:'6803'},checkpoints:{}}};
  await fs.mkdir(data,{recursive:true});await fs.writeFile(path.join(data,'buyer-tasks.json'),JSON.stringify({tasks:[task],automationPaused:false}));
  const bootstrap=path.join(dir,'main.cjs');await fs.writeFile(bootstrap,`const {app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});require(${JSON.stringify(path.join(root,'desktop/main.js'))});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath:process.env.PC_QA_EXECUTABLE||path.join(root,'desktop/node_modules/electron/dist/electron.exe'),args:process.env.PC_QA_EXECUTABLE?[`--user-data-dir=${profile}`]:[bootstrap],env});
  const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));await app.context().route('https://**/*',route=>route.abort());
  await app.evaluate((_,user)=>{
    const originalNow=Date.now.bind(Date);globalThis.collectionClockOffset=0;Date.now=()=>originalNow()+collectionClockOffset;
    globalThis.collectionFixture={ready:false,failed:false,queries:0,posts:0,other:[]};
    globalThis.fetch=async(url,options={})=>{
      const target=String(url),fixture=collectionFixture;
      if(target.startsWith('https://wsfile.cn/myladmin/api/auth/'))return Response.json(target.endsWith('/login')?{user,token:'fixture',expiresAt:new Date(originalNow()+3600000).toISOString()}:{user,ok:true});
      if(target.endsWith('/erp-config/me'))return Response.json({ready:true,config:{baseUrl:'https://wsfile.cn/maishou/api',username:'fixture',canSubmitDrafts:true,canConvertDrafts:true}});
      if(target.includes('/taobao/product-crawler/get-original-images'))return Response.json({code:0,data:{mainPic:'https://img.alicdn.com/ready.jpg'}});
      if(target.includes('/taobao/product-crawler/get?id=')){fixture.queries++;return Response.json({code:0,data:fixture.failed?{title:'数据获取失败'}:fixture.ready?{externalId:'12345678',articleNo:'6803',supplierName:'测试档口',title:'淘宝夹克',productData:{main_pic:'https://img.alicdn.com/ready.jpg'}}:null});}
      if(target.includes('/taobao/product-crawler/taobao_product_crawler_add')){fixture.posts++;throw Error('不得重复提交');}
      fixture.other.push(target);throw Error('隔离测试禁止其他接口和ERP写入');
    };
  },user);
  await page.locator('#username').fill(user.username);await page.locator('#password').fill('fixture');await page.locator('#loginButton').click();await page.locator('#appShell').waitFor({state:'visible'});
  await page.locator('.buyer-auto-detail').click();const dialog=page.locator('#buyerAutoDetailDialog');await dialog.waitFor({state:'visible'});
  assert.match(await page.locator('#buyerDetailStatus').textContent(),/等待互拓采集结果/);assert.match(await dialog.locator('.buyer-collection-status').textContent(),/30秒查询.*最近查询[\s\S]*下次查询/);
  assert.equal(await dialog.locator('#buyerSupplyFactsForm').count(),0);assert.equal(await app.evaluate(()=>collectionFixture.queries),0);assert.equal(await page.locator('#buyerDetailTrack li[aria-current="step"]').textContent(),'5互拓采集');
  const check=dialog.locator('.buyer-collection-status .buyer-collection-query');assert.equal(await check.isEnabled(),true);
  await page.evaluate(()=>window.desktop.pauseBuyerAuto());await page.waitForFunction(()=>document.querySelector('.buyer-collection-status .buyer-detail-resume'));
  await dialog.locator('.buyer-collection-status .buyer-detail-resume').click();assert.equal(await dialog.isVisible(),true);assert.equal((await page.evaluate(()=>window.desktop.snapshot())).buyerAutomation.paused,false);
  await page.evaluate(()=>window.desktop.pauseBuyerAuto());await page.waitForFunction(()=>document.querySelector('.buyer-collection-status .buyer-detail-resume'));
  await check.click();await page.waitForFunction(()=>document.querySelector('.buyer-collection-status').textContent.includes('已检查 3 次'));assert.equal(await app.evaluate(()=>collectionFixture.queries),1);assert.equal((await page.evaluate(()=>window.desktop.snapshot())).buyerAutomation.paused,true);assert.equal(await dialog.isVisible(),true);
  await app.evaluate(()=>{collectionFixture.failed=true;});await check.click();await page.waitForFunction(()=>document.querySelector('#buyerDetailNotice').textContent.includes('采集失败'));assert.match(await check.textContent(),/重试查询原记录/);assert.equal(await dialog.isVisible(),true);
  await app.evaluate(()=>{collectionFixture.failed=false;});await check.click();await page.waitForFunction(()=>document.querySelector('.buyer-collection-status').textContent.includes('已检查 4 次'));assert.equal((await page.evaluate(()=>window.desktop.snapshot())).buyerAutomation.paused,true);
  const qa=path.join(root,'output/qa/erp-manual-query-2026-11-15');await fs.mkdir(qa,{recursive:true});await dialog.screenshot({path:path.join(qa,'collection-controls.png')});
  await app.evaluate(()=>{collectionFixture.ready=true;});await check.click();
  await page.waitForFunction(()=>window.desktop.buyerTaskDetail(document.querySelector('[data-buyer-task]').dataset.buyerTask).then(task=>task.automation.step==='mapping'));
  assert.equal((await page.evaluate(()=>window.desktop.snapshot())).buyerAutomation.paused,true,'单件手动查询成功不继续整队列');assert.equal(await dialog.isVisible(),true);assert.match(await page.locator('#buyerDetailNotice').textContent(),/队列仍暂停/);
  const saved=await page.evaluate(id=>window.desktop.buyerTaskDetail(id),id);assert.equal(saved.automation.collection.externalId,'12345678');assert.equal(saved.automation.collectionPolling.state,'ready');assert.equal(await app.evaluate(()=>collectionFixture.posts),0);assert.equal(errors.length,0,errors.join('\n'));
});
