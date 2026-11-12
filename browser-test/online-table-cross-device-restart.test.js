const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {_electron}=require('playwright');
const {createOnlineTableServer}=require('../table-server/server.mjs');
const {startFetchSafeServer}=require('../test/http-fixture');
const root=path.resolve(__dirname,'..');

test('共享表供应商异常可在另一台电脑安全重新开始，并打开原商品链接',{timeout:60000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'online-restart-local-'));let app,service;
  t.after(async()=>{await app?.close();await service?.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  service=createOnlineTableServer({port:0,dataDir:path.join(dir,'tables'),authUrl:'https://fixture.test/me',fetchImpl:async(_url,options)=>Response.json({user:{id:'restart-user',displayName:'重试测试用户',isAdmin:true}}),logger:{error(){}}});
  const origin=await startFetchSafeServer(service),headers={Authorization:'Bearer restart-user','Content-Type':'application/json'};
  const created=await(await fetch(origin+'/api/tables',{method:'POST',headers,body:JSON.stringify({name:'跨设备重试验收'})})).json(),table=created.table,base=`${origin}/api/tables/${table.id}`;
  const imported=await(await fetch(base+'/rows',{method:'POST',headers,body:JSON.stringify({rows:[{articleNo:'TEST-02',sourceType:'douyin',sourceUrl:'https://v.douyin.com/restart-02/',title:'供应商比对异常商品'}]})})).json();
  let row=imported.rows[0];row=(await(await fetch(`${base}/rows/${row.id}`,{method:'PATCH',headers,body:JSON.stringify({ifVersion:row.version,patch:{humanStatus:'approved'}})})).json()).row;
  const previousTaskId='11111111-1111-4111-8111-111111111111';row=(await(await fetch(`${base}/claim/${row.id}`,{method:'POST',headers,body:JSON.stringify({taskId:previousTaskId})})).json()).row;
  row=(await(await fetch(`${base}/rows/${row.id}`,{method:'PATCH',headers,body:JSON.stringify({ifVersion:row.version,patch:{automationState:'attention',automationStep:'supplier_compare',automationError:'没有证据充分的供应商同款，保留模型建议'}})})).json()).row;
  const bootstrap=path.join(dir,'main.cjs'),profile=path.join(dir,'profile');await fs.writeFile(bootstrap,`const{app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});require(${JSON.stringify(path.join(root,'desktop/main.js'))});`);
  const env={...process.env,PC_QA_LOCAL_ERP:'1'};delete env.ELECTRON_RUN_AS_NODE;
  const packaged=!!process.env.PC_QA_EXECUTABLE,executablePath=process.env.PC_QA_EXECUTABLE||path.join(root,'desktop/node_modules/electron/dist/electron.exe');
  app=await _electron.launch({executablePath,args:packaged?[`--user-data-dir=${profile}`]:[bootstrap],env});
  const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await app.evaluate(({dialog,shell},tableOrigin)=>{
    const actual=globalThis.fetch;globalThis.openedLinks=[];globalThis.confirmationDetails=[];
    shell.openExternal=async url=>{openedLinks.push(String(url));};
    dialog.showMessageBox=async(_window,options)=>{confirmationDetails.push(options);return{response:1};};
    globalThis.fetch=async(url,options={})=>{
      const target=String(url);
      if(target.startsWith('https://wsfile.cn/maishou/api/online-table'))return actual(target.replace('https://wsfile.cn/maishou/api/online-table',tableOrigin),options);
      if(target.startsWith('https://wsfile.cn/myladmin/api/auth/')){const user={id:'restart-user',username:'restart-user',displayName:'重试测试用户'};return Response.json(target.endsWith('/login')?{token:'restart-user',expiresAt:new Date(Date.now()+3600000).toISOString(),user}:{user,ok:true});}
      if(target.endsWith('/erp-config/me'))return Response.json({ready:false,error:'验收使用本地互拓配置'});
      if(target.startsWith('https://vision.fixture/'))throw new Error('供应商异常阶段不应再次调用模型');
      throw new Error('测试禁止访问外网');
    };
  },origin);
  await page.locator('#username').fill('restart-user');await page.locator('#password').fill('fixture');await page.locator('#loginButton').click();await page.locator('#appShell').waitFor({state:'visible'});
  await page.evaluate(async()=>{const saved=await window.desktop.saveModel({name:'本机测试模型',model:'fixture',endpoint:'https://vision.fixture/v1',apiKey:'fixture-key'});await window.desktop.selectModel(saved.models.find(model=>model.name==='本机测试模型').id);await window.desktop.saveBuyerSettings({erpBaseUrl:'https://erp.fixture/api',erpTenantId:'fixture',erpClientId:'fixture-client',erpClientSecret:'fixture-secret',erpUsername:'fixture-user',erpPassword:'fixture-password',target:'draft'});});
  await page.locator('#navBuyer').click();const target=page.locator(`tr[data-online-row="${row.id}"]`);await target.waitFor();
  assert.equal(await target.locator('.online-restart-local-task').textContent(),'本机重新开始');assert.equal(await target.locator('.online-open-source-link').count(),1);
  await fs.mkdir(path.join(root,'output/playwright'),{recursive:true});await page.screenshot({path:path.join(root,'output/playwright/online-table-cross-device-restart.png')});
  await target.locator('.online-open-source-link').click();assert.deepEqual(await app.evaluate(()=>openedLinks),[row.sourceUrl]);
  await target.locator('.online-restart-local-task').click();
  for(let i=0;i<100;i++){const current=(await(await fetch(base+`?limit=50`,{headers})).json()).rows.find(item=>item.id===row.id);if(current?.taskId&&current.taskId!==previousTaskId){row=current;break;}await page.waitForTimeout(100);}
  assert.notEqual(row.taskId,previousTaskId);assert.equal(row.humanStatus,'approved');assert.ok(['queued','waiting','running'].includes(row.automationState));
  assert.equal(row.automationStep,'source');
  if(row.automationState==='waiting')assert.match(row.automationError,/等待浏览器插件连接/,'新任务当前等待原因应立即同步到对应原表行');
  else assert.equal(row.automationError,'');
  const local=await page.evaluate(()=>window.desktop.snapshot()),task=local.buyerTasks.find(item=>item.id===row.taskId);assert.ok(task);assert.equal(task.sourceUrl,'https://v.douyin.com/restart-02/');assert.ok(task.automation.enabled);assert.equal(task.automation.step,'source');
  assert.equal(await app.evaluate(()=>confirmationDetails.at(-1).buttons[1]),'在本机重新开始');assert.match(await app.evaluate(()=>confirmationDetails.at(-1).detail),/原电脑的本地记录保留/);
  assert.deepEqual(errors,[]);
});
