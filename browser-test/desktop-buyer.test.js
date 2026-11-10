const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const { _electron }=require('playwright');
const root=path.resolve(__dirname,'..');
const executablePath=process.env.PC_QA_EXECUTABLE||path.join(root,'desktop/node_modules/electron/dist/electron.exe');
test('实际 Electron：买手自动化入口创建本地任务，显示来源证据边界且不写 ERP',{timeout:40000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buyer-ui-'));let app;
  t.after(async()=>{await app?.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})});
  const bootstrap=path.join(dir,'main.cjs'),templateCopy=path.join(dir,'buyer-template.xlsx'),buyerRoot=path.join(dir,'picked-root');
  const fixture=[
    "const {app,dialog}=require('electron');",
    "app.setPath('userData',"+JSON.stringify(path.join(dir,'profile'))+");",
    "dialog.showSaveDialog=async()=>({canceled:false,filePath:"+JSON.stringify(templateCopy)+"});",
    "dialog.showOpenDialog=async()=>({canceled:false,filePaths:["+JSON.stringify(buyerRoot)+"]});",
    "globalThis.fetch=async url=>{",
    "if(!String(url).startsWith('https://wsfile.cn/myladmin/api/auth/'))throw new Error('测试禁止外网');",
    "const user={id:'buyer-ui-qa',username:'buyer-ui-qa',displayName:'买手界面测试'};",
    "return Response.json(String(url).endsWith('/login')?{token:'fixture-token',expiresAt:new Date(Date.now()+3600000).toISOString(),user}:{user,ok:true})};",
    "require("+JSON.stringify(path.join(root,'desktop/main.js'))+");"
  ].join('');
  await fs.writeFile(bootstrap,fixture);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath,args:process.env.PC_QA_EXECUTABLE?[`--user-data-dir=${path.join(dir,'profile')}`]:[bootstrap],env});
  const page=await app.firstWindow();
  const waitSnapshot=async predicate=>{for(let attempt=0;attempt<200;attempt++){const data=await page.evaluate(()=>window.desktop.snapshot());if(predicate(data))return data;await new Promise(resolve=>setTimeout(resolve,25));}const last=await page.evaluate(()=>window.desktop.snapshot()),urls=await app.evaluate(()=>globalThis.buyerFetches||[]);assert.fail('桌面任务状态未在5秒内达到预期：'+JSON.stringify({jobs:last.jobs?.map(job=>({status:job.status,error:job.error,items:job.items?.map(item=>({status:item.imageSimilarityStatus,error:item.imageSimilarityError,comparison:item.visualComparison}))})),tasks:last.buyerTasks?.map(task=>({state:task.automation?.state,error:task.automation?.error})),urls}));};
  const uiErrors=[];page.on('pageerror',error=>uiErrors.push(error.message));
  await app.context().route('https://**/*',route=>route.abort());
  if(process.env.PC_QA_EXECUTABLE)await app.evaluate(({dialog},{templateCopy,buyerRoot})=>{
    dialog.showSaveDialog=async()=>({canceled:false,filePath:templateCopy});
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[buyerRoot]});
    globalThis.fetch=async url=>{
      if(!String(url).startsWith('https://wsfile.cn/myladmin/api/auth/'))throw new Error('测试禁止外网');
      const user={id:'buyer-ui-qa',username:'buyer-ui-qa',displayName:'买手界面测试'};
      return Response.json(String(url).endsWith('/login')?{token:'fixture-token',expiresAt:new Date(Date.now()+3600000).toISOString(),user}:{user,ok:true});
    };
  },{templateCopy,buyerRoot});
  await page.locator('#username').fill('buyer-ui-qa');await page.locator('#password').fill('fixture-password');await page.locator('#loginButton').click();await page.locator('#appShell').waitFor({state:'visible'});
  await page.locator('#navBuyer').click();assert.equal(await page.locator('#buyerPage').isVisible(),true);assert.equal(await page.locator('#buyerTaskList .empty').isVisible(),true);
  await page.locator('#buyerTemplateExport').click();await page.waitForFunction(()=>document.querySelector('#buyerAutoMessage').textContent.includes('测试模板已保存'));assert.equal((await fs.stat(templateCopy)).size>5000,true);
  await page.locator('#navSettings').click();await page.locator('#buyerConfigSelectRoot').click();await page.waitForFunction(()=>document.querySelector('#buyerConfig_productRootDir').value.length>0);assert.equal((await page.evaluate(()=>window.desktop.snapshot())).buyerSettings.productRootDir,buyerRoot);
  await fs.mkdir(path.join(root,'output/playwright'),{recursive:true});await page.screenshot({path:path.join(root,'output/playwright/desktop-buyer-folder-setting.png')});
  await page.locator('#navBuyer').click();await page.locator('#buyerPage').waitFor({state:'visible'});
  await page.locator('.buyer-manual-entry > summary').click();
  await page.locator('#buyerArticleNo').fill('BUYER-001');await page.locator('#buyerSourceType').selectOption('taobao');await page.locator('#buyerSourceUrl').fill('https://item.taobao.com/item.htm?id=12345678');await page.locator('#createBuyerTask').click();
  await page.waitForFunction(()=>document.querySelector('#buyerTaskList').textContent.includes('淘宝/天猫'));assert.equal(await page.locator('#buyerTaskList [data-buyer-task]').count(),1);assert.match(await page.locator('#buyerTaskList').textContent(),/尚未添加商品图/);assert.doesNotMatch(await page.locator('#buyerTaskList').textContent(),/ERP 已写入|已提交/);
  const snapshot=await page.evaluate(()=>window.desktop.snapshot());assert.equal(snapshot.buyerTasks.length,1);assert.equal(snapshot.buyerTasks[0].status,'needs_image');assert.equal(snapshot.buyerTasks[0].sourceType,'taobao');
  const image=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=900;canvas.height=1200;canvas.getContext('2d').fillRect(0,0,900,1200);return canvas.toDataURL('image/png');});
  const imageFile=path.join(dir,'衬衫.png');await fs.writeFile(imageFile,Buffer.from(image.split(',')[1],'base64'));
  await page.locator('#buyerBatchImages').setInputFiles([imageFile]);
  await page.waitForFunction(()=>document.querySelectorAll('#buyerTaskList [data-buyer-task]').length===2);
  await page.locator('.buyer-manual-tools > summary').click();
  await page.locator('#buyerSelectAll').click();await page.locator('#buyerTaobaoBatch').click();
  await page.waitForFunction(()=>document.querySelector('#buyerMessage').textContent.includes('已提交 1 个'));
  let state=await page.evaluate(()=>window.desktop.snapshot());
  const task=state.buyerTasks.find(task=>task.sourceType==='image'),command=state.browserCommands.find(command=>command.kind==='taobao-image-search');
  assert.equal(command.buyerTaskId,task.id);assert.equal(state.jobs.length,0);
  const headers={'Content-Type':'application/json','X-Desktop-Token':state.token};
  const accepted=await fetch(`http://127.0.0.1:${state.port}/v1/browser-commands/${command.id}/ack`,{method:'POST',headers,body:JSON.stringify({status:'accepted',candidates:[{id:'12345678',title:'纯棉衬衫同款',imageUrl:'https://img.alicdn.com/item.jpg',detailUrl:'https://item.taobao.com/item.htm?id=12345678',price:29}]})});
  assert.equal(accepted.status,200);
  await page.waitForFunction(()=>!!document.querySelector('.buyer-taobao-compare'));
  assert.equal((await page.evaluate(()=>window.desktop.snapshot())).jobs.length,0,'返回淘宝候选不自动识别');
  await app.evaluate((_,image)=>{
    const original=globalThis.fetch;process.getBuiltinModule('node:dns/promises').lookup=async()=>[{address:'93.184.216.34',family:4}];globalThis.buyerModelCalls=0;globalThis.buyerFetches=[];
    globalThis.fetch=async(url,options)=>{
      buyerFetches.push(String(url));
      if(String(url).startsWith('https://img.alicdn.com/'))return new Response(Buffer.from(image.split(',')[1],'base64'));
      if(String(url).startsWith('http://127.0.0.1:12345/')){buyerModelCalls++;const content=JSON.parse(options.body).messages[1].content,ids=content.filter(x=>x.type==='text'&&x.text.startsWith('候选编号：')).map(x=>x.text.slice(5));return Response.json({choices:[{message:{content:JSON.stringify({results:ids.map(id=>({id,verdict:'likely_same',score:96,matches:['领口相同','口袋位置一致'],differences:[],uncertainties:[]}))})}}]});}
      return original(url,options);
    };
  },image);
  await page.evaluate(async()=>{const saved=await window.desktop.saveModel({name:'本地测试模型',model:'fixture',endpoint:'http://127.0.0.1:12345/v1'});await window.desktop.selectModel(saved.models.find(model=>model.name==='本地测试模型').id);});
  await page.locator('.buyer-taobao-compare').click();
  await waitSnapshot(data=>data.jobs[0]?.status==='complete'&&data.jobs[0]?.items[0]?.visualComparison?.score===96);
  state=await page.evaluate(()=>window.desktop.snapshot());assert.equal(state.jobs.length,1);assert.equal(await app.evaluate(()=>buyerModelCalls),1,JSON.stringify(state.jobs[0]));
  await assert.rejects(page.evaluate(({task,job})=>window.desktop.confirmBuyerTaobao(task,job,0),{task:task.id,job:state.jobs[0].id}),/请先核对模型分数/);
  await page.locator('.buyer-taobao-review').click();await page.locator('.review-next').click();await page.locator('.confirm-same').click();
  await page.locator('#reviewDialog').waitFor({state:'hidden'});await page.locator('#navBuyer').click();
  await page.waitForFunction(()=>!!document.querySelector('.buyer-taobao-confirm'));await page.locator('.buyer-taobao-confirm').click();
  await waitSnapshot(data=>data.buyerTasks.some(task=>task.marketplaceCandidate?.confirmedSame));
  state=await page.evaluate(()=>window.desktop.snapshot());assert.equal(state.buyerTasks.find(x=>x.id===task.id).marketplaceCandidate.url,'https://item.taobao.com/item.htm?id=12345678');
  assert.equal(state.browserCommands.some(command=>command.kind==='product-details'),false,'淘宝同款审核不触发四站详情采集器');
  assert.equal(await app.evaluate(()=>buyerModelCalls),1,'人工确认不再次调用模型');
  assert.deepEqual(uiErrors,[]);
  await fs.mkdir(path.join(root,'output/playwright'),{recursive:true});await page.screenshot({path:path.join(root,'output/playwright/desktop-buyer-workspace.png'),fullPage:true});
});
