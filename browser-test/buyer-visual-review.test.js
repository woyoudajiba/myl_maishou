const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {_electron}=require('playwright'),sharp=require('../desktop/node_modules/sharp');
const root=path.resolve(__dirname,'..');

test('打包买手例外：对照原图和候选图、按平台登录入口重搜、人工确认相似候选并跳识别记录',{timeout:65000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buyer-visual-review-'));let app;
  t.after(async()=>{await app?.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const profile=path.join(dir,'profile'),bootstrap=path.join(dir,'main.cjs'),image=await sharp({create:{width:1000,height:1200,channels:3,background:'#52695c'}}).png().toBuffer();
  await fs.writeFile(bootstrap,`const {app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});require(${JSON.stringify(path.join(root,'desktop/main.js'))});`);
  const env={...process.env,PC_QA_LOCAL_ERP:'1'};delete env.ELECTRON_RUN_AS_NODE;
  const executable=process.env.PC_QA_EXECUTABLE||path.join(root,'desktop/node_modules/electron/dist/electron.exe');
  app=await _electron.launch({executablePath:executable,args:process.env.PC_QA_EXECUTABLE?[`--user-data-dir=${profile}`]:[bootstrap],env});
  const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));await app.context().route('https://**/*',route=>route.abort());
  await app.evaluate(({shell},imageBase64)=>{
    globalThis.buyerVisualCalls={opened:[],models:0};const originalFetch=globalThis.fetch;process.getBuiltinModule('node:dns/promises').lookup=async()=>[{address:'93.184.216.34',family:4}];
    shell.openExternal=async url=>{buyerVisualCalls.opened.push(url);};
    globalThis.fetch=async(url,options={})=>{
      const target=String(url);
      if(target.startsWith('https://wsfile.cn/myladmin/api/auth/')){const user={id:'visual-review-qa',username:'visual-review-qa',displayName:'图片核对测试'};return Response.json(target.endsWith('/login')?{user,token:'fixture-session',expiresAt:new Date(Date.now()+3600000).toISOString()}:{user,ok:true});}
      if(target.endsWith('/erp-config/me'))return Response.json({ready:true,config:{baseUrl:'https://erp.fixture/api',username:'fixture-user',canSubmitDrafts:true,canConvertDrafts:true}});
      if(target.startsWith('https://vision.fixture/')){buyerVisualCalls.models++;const body=JSON.parse(options.body),content=body.messages[1].content,ids=content.filter(part=>part.type==='text'&&part.text.startsWith('候选编号：')).map(part=>part.text.slice(5));return Response.json({model:'visual-fixture',choices:[{finish_reason:'stop',message:{content:JSON.stringify({results:ids.map((id,index)=>({id,verdict:index?'uncertain':'similar',score:index?null:83,matches:['领型相近'],differences:['口袋结构不同'],uncertainties:['袖口被遮挡']}))})}}]});}
      if(/^https:\/\/(?:pics\.17qcc\.com|p\d+-item\.ecombdimg\.com)\//.test(target))return new Response(Buffer.from(imageBase64,'base64'),{headers:{'content-type':'image/png'}});
      if(target.startsWith('https://erp.fixture/'))throw new Error('该验收禁止写入互拓');
      return originalFetch(url,options);
    };
  },image.toString('base64'));
  await page.locator('#username').fill('visual-review-qa');await page.locator('#password').fill('fixture');await page.locator('#loginButton').click();await page.locator('#appShell').waitFor({state:'visible'});
  const model=await page.evaluate(async()=>window.desktop.saveModel({name:'图片核对模型',model:'vision-fixture',endpoint:'https://vision.fixture/v1',apiKey:'fixture'}));await page.evaluate(id=>window.desktop.selectModel(id),model.models.find(item=>item.name==='图片核对模型').id);
  await page.evaluate(()=>window.desktop.saveBuyerSettings({erpBaseUrl:'https://erp.fixture/api',erpTenantId:'1',erpClientId:'fixture',erpClientSecret:'fixture-secret',erpUsername:'fixture-user',erpPassword:'fixture-password',target:'draft'}));
  await page.locator('#navBuyer').click();const added=await page.evaluate(()=>window.desktop.addBuyerLink('商品分享 https://v.douyin.com/herTF0zw-Ac/ 点击打开'));await page.evaluate(id=>window.desktop.startBuyerAuto([id]),added.taskId);
  let state,command;
  for(let i=0;i<100;i++){state=await page.evaluate(()=>window.desktop.snapshot());command=state.browserCommands.find(row=>row.buyerTaskId===added.taskId&&row.kind==='buyer-source'&&row.status==='queued');if(command)break;await page.waitForTimeout(50);}
  assert.ok(command,'自动队列应打开来源页');
  const ack=async(row,result)=>fetch(`http://127.0.0.1:${state.port}/v1/browser-commands/${row.id}/ack`,{method:'POST',headers:{'X-Desktop-Token':state.token,'Content-Type':'application/json','X-PC-Extension-Version':require('../manifest.json').version,'X-PC-Buyer-Protocol':'1'},body:JSON.stringify({status:'accepted',result})});
  assert.equal((await ack(command,{url:command.detailUrl,title:'法国Time Leap冬季羽绒服',shopName:'Time Leap',images:['https://p3-item.ecombdimg.com/img/ecom-shop-material/original.webp','https://p3-item.ecombdimg.com/img/ecom-shop-material/side.webp','https://p3-item.ecombdimg.com/img/ecom-shop-material/back.webp'],visibleText:'羽绒服商品页面'})).status,200);
  for(let i=0;i<100;i++){state=await page.evaluate(()=>window.desktop.snapshot());command=state.browserCommands.find(row=>row.buyerTaskId===added.taskId&&row.kind==='buyer-supplier-search'&&row.status==='queued');if(command)break;await page.waitForTimeout(50);}
  assert.ok(command,'读取主图后应搜索供应商');
  const supplier=(id,platform,host)=>({id,platform,title:`${platform}外套`,shopName:`${platform}档口`,detailUrl:`https://www.${host}/goods/${id}.html`,imageUrl:`https://pics.17qcc.com/${id}.jpg`,price:99});
  assert.equal((await ack(command,{items:[supplier('same','qcc','17qcc.com'),supplier('uncertain','zwd','17zwd.com')],records:[{key:'wsy',phase:'failed',message:'平台需要登录后才能搜图'},{key:'zwd',phase:'complete',total:2},{key:'qcc',phase:'complete',total:2},{key:'e3hui',phase:'complete',total:0}]})).status,200);
  for(let i=0;i<300;i++){state=await page.evaluate(()=>window.desktop.snapshot());const current=state.buyerTasks?.find(task=>task.id===added.taskId);if(current?.automation?.state==='attention')break;await page.waitForTimeout(100);}
  assert.ok(state.buyerTasks?.find(task=>task.id===added.taskId)?.automation?.state==='attention',JSON.stringify({authenticated:state.authenticated,error:state.error,tasks:state.buyerTasks?.map(task=>({state:task.automation?.state,error:task.automation?.error,step:task.automation?.step})),messages:await page.locator('#loginMessage').textContent()}));
  const detailed=await page.evaluate(id=>window.desktop.buyerTaskDetail(id),added.taskId),jobId=detailed.automation.checkpoints?.supplierComparison?.jobId;assert.ok(jobId);assert.equal(await page.locator('.buyer-open-comparison-card').count(),1,JSON.stringify({summary:state.buyerTasks[0].automation,jobs:state.jobs.map(job=>({id:job.id,queryName:job.queryName,buyerTaskId:job.buyerTaskId})),step:detailed.automation.step,status:detailed.automation.state}));await page.locator('.buyer-open-comparison-card').click();await page.waitForFunction(()=>!document.getElementById('workPage').hidden);assert.equal(await page.locator(`#jobs article[data-job="${jobId}"] .job-results`).getAttribute('open'),'');await page.locator('#navBuyer').click();
  await page.locator('.buyer-auto-detail').click();await page.locator('#buyerAutoDetailDialog').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelectorAll('[data-source-gallery] img').length===3);
  await page.waitForFunction(()=>[...document.querySelectorAll('.buyer-compare-image')].filter(node=>node.src.startsWith('data:image/jpeg;base64,')).length===2);
  assert.match(await page.locator('[data-source-preview-state]').textContent(),/共识别 3 张图片/);
  assert.match(await page.locator('#buyerAutoDetailBody').textContent(),/商品链接图片[\s\S]*供应商候选/);
  assert.match(await page.locator('#buyerAutoDetailBody').textContent(),/吻合|差异|模型未完成识别/);assert.match(await page.locator('#buyerAutoDetailBody').textContent(),/网商园/);
  await page.locator('.buyer-load-gallery[data-index="0"]').click();
  for(let i=0;i<100;i++){state=await page.evaluate(()=>window.desktop.snapshot());command=state.browserCommands.find(row=>row.buyerTaskId===added.taskId&&row.kind==='buyer-source'&&row.slot.startsWith('gallery:0:')&&['queued','claimed'].includes(row.status));if(command)break;await page.waitForTimeout(50);}
  assert.ok(command,'应按需排队读取候选商品详情图集');assert.equal((await ack(command,{url:command.detailUrl,title:'供应商裤装',shopName:'同款档口',images:['https://pics.17qcc.com/supplier-main.jpg','https://pics.17qcc.com/supplier-side.jpg','https://pics.17qcc.com/supplier-back.jpg'],visibleText:'尺码和商品说明'})).status,200);
  await page.waitForFunction(()=>document.querySelectorAll('[data-candidate-gallery="0"] img').length===3);
  const galleryThumb=page.locator('[data-candidate-gallery="0"] img').first(),galleryImage=await galleryThumb.getAttribute('src');await galleryThumb.click();await page.locator('#buyerGalleryImageDialog').waitFor({state:'visible'});assert.equal(await page.locator('#buyerGalleryImageDialog img').getAttribute('src'),galleryImage);await page.locator('#buyerGalleryImageDialog button').click();
  await page.locator('.buyer-platform-login[data-platform=wsy]').click();assert.deepEqual(await app.evaluate(()=>buyerVisualCalls.opened),['https://www.wsy.com/']);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(800,700));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await page.locator('#buyerAutoDetailDialog').evaluate(node=>node.scrollWidth<=node.clientWidth),true);await fs.mkdir(path.join(root,'output/playwright'),{recursive:true});await page.screenshot({path:path.join(root,'output/playwright/buyer-visual-review-detail-800.png')});
  await page.locator('.buyer-open-comparison').click();await page.waitForFunction(()=>!document.getElementById('workPage').hidden);assert.equal(await page.locator(`#jobs article[data-job="${jobId}"]`).count(),1);assert.equal(await page.locator(`#jobs article[data-job="${jobId}"] .job-results`).getAttribute('open'),'');
  const highestRow=page.locator(`#jobs article[data-job="${jobId}"] .result-row[data-index="0"]`);await page.waitForFunction(()=>{const row=document.querySelector('#jobs .result-row[data-index="0"]');if(!row)return false;const top=row.getBoundingClientRect().top;return top>80&&top<innerHeight-100;});assert.equal(await highestRow.evaluate(node=>node.classList.contains('buyer-job-focus')),true);
  await page.locator(`#jobs article[data-job="${jobId}"] .review-item[data-index="1"]`).click();await page.locator('#reviewDialog').waitFor({state:'visible'});assert.equal(await page.locator('#humanScore').isDisabled(),true);assert.match(await page.locator('.buyer-review-next-step').textContent(),/资料采集/);await page.locator('.confirm-same').click();await page.waitForFunction(()=>!document.getElementById('buyerPage').hidden);
  for(let i=0;i<100;i++){state=await page.evaluate(()=>window.desktop.snapshot());const current=state.buyerTasks?.find(item=>item.id===added.taskId);if(current?.automation?.supplierSelection?.method==='manual'&&current.automation.supplierSelection.sourceIndex===1)break;await page.waitForTimeout(100);}
  const selected=state.buyerTasks?.find(item=>item.id===added.taskId);assert.ok(selected?.automation?.supplierSelection?.method==='manual',JSON.stringify({authenticated:state.authenticated,error:state.error,notice:await page.locator('#buyerAutoMessage').textContent(),detail:(await page.locator('#buyerAutoDetailBody').textContent()).slice(0,600),task:selected?.automation},null,2));
  state=await page.evaluate(()=>window.desktop.snapshot());const task=state.buyerTasks.find(item=>item.id===added.taskId);
  assert.equal(task.automation.step,'supplier_details');assert.equal(task.automation.supplier.detailUrl,'https://www.17zwd.com/goods/uncertain.html');assert.equal(task.automation.supplier.visualComparison.verdict,'uncertain');assert.equal(task.automation.supplierSelection.verdict,'likely_same');assert.ok(task.events.some(event=>/人工对照图片确认/.test(event.message)));assert.equal(await app.evaluate(()=>buyerVisualCalls.models),1);assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(root,'output/playwright/buyer-visual-review.png')});
});
