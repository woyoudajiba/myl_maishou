const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {_electron}=require('playwright'),sharp=require('../desktop/node_modules/sharp');
const {profileId}=require('../desktop/accounts');
const root=path.resolve(__dirname,'..');

test('淘宝85分优先后按销量：旧批次补回、图片分页、人工排除置后且确认后才继续互拓',{timeout:45000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'taobao-sales-ui-'));let app;
  t.after(async()=>{await app?.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const user={id:'sales-qa',username:'sales-qa',displayName:'淘宝销量测试'},id=crypto.randomUUID(),jobId=crypto.randomUUID(),now=new Date().toISOString();
  const image=await sharp(path.join(root,'fixtures/supplier-6803-photo.jpg')).resize(600,800,{fit:'inside'}).jpeg().toBuffer(),imageData='data:image/jpeg;base64,'+image.toString('base64');
  const profile=path.join(dir,'profile'),data=path.join(profile,'profiles',profileId(user));
  const values=['10万+人付款','1.2万+人付款','2000+人付款','0人付款',''].map((salesText,index)=>({id:String(12345678+index),title:'翻领外套 '+index,detailUrl:`https://item.taobao.com/item.htm?id=${12345678+index}`,imageUrl:`https://img.alicdn.com/qa/${index}.jpg`,salesText,shopName:'测试店铺 '+index,price:45+index*10}));
  const items=values.map(({salesText,...item},index)=>({...item,platform:'taobao',imageSimilaritySource:'qwen_multimodal_v1',imageSimilarity:[.60,.95,.85,.84,.99][index],visualComparison:{verdict:[0,4].includes(index)?'different':'similar',score:[60,95,85,84,99][index],matches:['领型相近'],differences:[],uncertainties:[]}}));
  const task={id,sourceType:'image',sourceTitle:'淘宝套图看图选择',sourceUrl:'',imageFile:id+'.jpg',createdAt:now,updatedAt:now,events:[],marketplaceCandidates:values,marketplaceSearch:{status:'scored',jobId},automation:{state:'attention',step:'marketplace',enabled:true,tags:['无可靠套图'],error:'淘宝未找到可靠同款套图，继续处理下一件',source:{images:[]},supplierDetails:{images:['https://imgcdn.wsy.com/qa-supplier.jpg']},checkpoints:{marketplaceComparison:{jobId,result:{status:'complete',items}}},facts:{articleNo:'6803',supplierName:'测试供应商'}}};
  await fs.mkdir(path.join(data,'buyer-images'),{recursive:true});await fs.writeFile(path.join(data,'buyer-images',id+'.jpg'),image);await fs.writeFile(path.join(data,'buyer-tasks.json'),JSON.stringify({tasks:[task],automationPaused:true}));
  await fs.mkdir(path.join(data,'jobs/queries'),{recursive:true});await fs.writeFile(path.join(data,'jobs/queries',jobId+'.txt'),imageData);await fs.writeFile(path.join(data,'jobs/jobs.json'),JSON.stringify([{id:jobId,buyerTaskId:id,queryId:crypto.randomUUID(),queryName:'淘宝套图',items,total:5,status:'complete',progress:100,completed:5,reviewMode:'direct',createdAt:now,updatedAt:now}]));
  const bootstrap=path.join(dir,'main.cjs');await fs.writeFile(bootstrap,`const {app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});require(${JSON.stringify(path.join(root,'desktop/main.js'))});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;app=await _electron.launch({executablePath:process.env.PC_QA_EXECUTABLE||path.join(root,'desktop/node_modules/electron/dist/electron.exe'),args:process.env.PC_QA_EXECUTABLE?[`--user-data-dir=${profile}`]:[bootstrap],env});
  const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await app.context().route('https://**/*',route=>/\.(jpg|jpeg|png)$/.test(route.request().url())?route.fulfill({body:image,contentType:'image/jpeg'}):route.abort());
  await app.evaluate((_,{user,image})=>{globalThis.externalCalls=[];process.getBuiltinModule('node:dns/promises').lookup=async()=>[{address:'93.184.216.34',family:4}];globalThis.fetch=async url=>{
    const target=String(url);if(target.startsWith('https://wsfile.cn/myladmin/api/auth/'))return Response.json(target.endsWith('/login')?{user,token:'fixture',expiresAt:new Date(Date.now()+3600000).toISOString()}:{user,ok:true});
    if(target.endsWith('/erp-config/me'))return Response.json({ready:false});
    if(target.startsWith('https://img.alicdn.com/')||target.startsWith('https://imgcdn.wsy.com/'))return new Response(Buffer.from(image,'base64'),{headers:{'content-type':'image/jpeg'}});
    externalCalls.push(target);throw new Error('隔离测试禁止实际ERP写入');
  };},{user,image:image.toString('base64')});
  await page.locator('#username').fill(user.username);await page.locator('#password').fill('fixture');await page.locator('#loginButton').click();await page.locator('#appShell').waitFor({state:'visible'});
  await page.locator('.buyer-auto-detail').click();const detail=page.locator('#buyerAutoDetailDialog');await detail.waitFor({state:'visible'});
  await page.waitForFunction(()=>[...document.querySelectorAll('.buyer-marketplace-panel .buyer-compare-image')].every(img=>img.naturalWidth>0));
  assert.equal(await detail.locator('.buyer-marketplace-panel .buyer-compare-candidate').count(),4);assert.match(await detail.locator('.buyer-compare-candidate').first().textContent(),/1.2万\+人付款/);
  assert.equal(await detail.locator('[data-source-gallery] img').count(),2);assert.equal(await detail.locator('#buyerSupplyFactsForm').count(),0);
  await detail.locator('.buyer-marketplace-page').last().click();await page.waitForFunction(()=>document.querySelector('.buyer-candidate-pagination').textContent.includes('5–5'));assert.match(await detail.locator('.buyer-compare-candidate').textContent(),/销量：未采集/);
  await detail.locator('.buyer-marketplace-page').first().click();await detail.locator('.buyer-marketplace-review').first().waitFor({state:'visible'});
  const qa=path.join(root,'output/qa/taobao-priority-2026-11-15');await fs.mkdir(qa,{recursive:true});await detail.locator('.buyer-marketplace-panel').scrollIntoViewIfNeeded();await page.locator('#buyerAutoDetailBody').evaluate(node=>{node.scrollTop=0;});await detail.screenshot({path:path.join(qa,'marketplace-picture-review.png')});
  await page.locator('#buyerAutoDetailClose').click();await page.locator('#navWork').click();const summary=page.locator('.taobao-comparison-summary'),preferred=summary.locator('[data-taobao-index="1"] .review-item');
  assert.equal(await page.locator('.platform-search-row').count(),1);assert.equal(await summary.locator('th').filter({hasText:'货号'}).count(),0);assert.equal(await page.locator('.price-comparison-summary:not(.taobao-comparison-summary)').count(),0);
  assert.deepEqual(await summary.locator('tbody .taobao-sales').allTextContents(),['1.2万+人付款','2000+人付款','0人付款','10万+人付款','未采集']);
  assert.deepEqual(await summary.locator('tbody tr').evaluateAll(rows=>rows.map(row=>Number(row.dataset.taobaoIndex))),[1,2,3,0,4]);
  await page.locator('.review-next').click();await page.locator('#reviewDialog').waitFor({state:'visible'});assert.match(await page.locator('#reviewDialog').textContent(),/翻领外套 1/);await page.locator('#closeReview').click();
  assert.equal((await page.evaluate(()=>window.desktop.snapshot())).buyerTasks[0].automation.step,'marketplace');
  await summary.scrollIntoViewIfNeeded();await summary.screenshot({path:path.join(qa,'sales-sorted-candidates.png')});
  await preferred.click();await page.locator('#reviewDialog').waitFor({state:'visible'});await page.locator('.exclude-candidate').click();await page.locator('#reviewDialog').waitFor({state:'hidden'});
  let reviewed=await page.evaluate(()=>window.desktop.snapshot());assert.equal(reviewed.jobs[0].items[1].humanReview.verdict,'different');assert.equal(reviewed.buyerTasks[0].automation.step,'marketplace');assert.match(await page.locator('#notice').textContent(),/已人工排除/);
  assert.equal(await summary.locator('tbody tr').last().getAttribute('data-taobao-index'),'1','人工排除后不能因销量高继续置顶');await summary.locator('[data-taobao-index="2"] .review-item').click();await page.locator('.cannot-decide').click();await page.locator('#reviewDialog').waitFor({state:'hidden'});
  reviewed=await page.evaluate(()=>window.desktop.snapshot());assert.equal(reviewed.jobs[0].items[2].humanReview.verdict,'uncertain');assert.equal(reviewed.buyerTasks[0].automation.step,'marketplace');
  await assert.rejects(page.evaluate(({id,jobId})=>window.desktop.confirmBuyerTaobao(id,jobId,1,{verdict:'likely_same',note:'过期测试'},'old-signature'),{id,jobId}),/模型结果已变化/);
  reviewed=await page.evaluate(()=>window.desktop.snapshot());assert.equal(reviewed.jobs[0].items[1].humanReview.verdict,'different');assert.equal(reviewed.buyerTasks[0].automation.step,'marketplace');
  await preferred.click();await page.locator('#reviewDialog').waitFor({state:'visible'});
  await page.waitForFunction(()=>[...document.querySelectorAll('#reviewDialog .review-images img')].every(img=>img.naturalWidth>0));
  assert.match(await page.locator('#reviewDialog').textContent(),/销量：1.2万\+人付款/);
  // Simulate the old confusing half-success: the review saves, but the buyer
  // task cannot be written. The modal must explain it and allow the same action
  // to be retried after storage recovers.
  const taskFile=path.join(data,'buyer-tasks.json'),taskBackup=path.join(data,'buyer-tasks-before-failure.json');
  await fs.rename(taskFile,taskBackup);await fs.mkdir(taskFile);
  await page.locator('.confirm-same').click();await page.waitForFunction(()=>document.querySelector('#reviewError').textContent.includes('人工同款结论已保存，但套图来源尚未继续关联'));
  assert.equal(await page.locator('#reviewDialog').isVisible(),true);
  const interrupted=await page.evaluate(id=>window.desktop.buyerTaskDetail(id),id);assert.equal(interrupted.automation.step,'marketplace');assert.equal(interrupted.marketplaceCandidate??null,null);
  await fs.rmdir(taskFile);await fs.rename(taskBackup,taskFile);
  await page.locator('.confirm-same').click();await page.locator('#reviewDialog').waitFor({state:'hidden'});
  const saved=await page.evaluate(()=>window.desktop.buyerTaskDetail(document.querySelector('[data-buyer-task]').dataset.buyerTask));assert.equal(saved.marketplaceCandidate.url,values[1].detailUrl);assert.equal(saved.marketplaceCandidate.salesText,'1.2万+人付款');assert.equal(saved.automation.step,'collection');assert.equal(saved.automation.marketplace.confirmedSame,true);assert.equal(errors.length,0,errors.join('\n'));
  const duplicate=await page.evaluate(({id,jobId})=>window.desktop.confirmBuyerTaobao(id,jobId,1),{id,jobId});assert.equal(duplicate.alreadyContinued,true);
  const afterDuplicate=await page.evaluate(id=>window.desktop.buyerTaskDetail(id),id);assert.equal(afterDuplicate.events.filter(event=>event.message==='人工看图确认淘宝套图来源，继续互拓采集').length,1);
  await page.setViewportSize({width:860,height:760});await page.locator('#navWork').click();await summary.scrollIntoViewIfNeeded();const layout=await summary.locator('.price-comparison-scroll').evaluate(node=>({viewport:node.clientWidth,table:node.scrollWidth}));assert.ok(layout.table>=layout.viewport);await page.screenshot({path:path.join(qa,'sales-sorted-compact.png')});
});
