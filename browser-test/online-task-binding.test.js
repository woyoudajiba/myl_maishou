const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {_electron}=require('playwright');
const {createOnlineTableServer}=require('../table-server/server.mjs');
const {startFetchSafeServer}=require('../test/http-fixture');
const {profileId}=require('../desktop/accounts');
const root=path.resolve(__dirname,'..');

test('Electron：当前表与任务一一对应、历史隔离、删除确认、原行定位与失效任务禁止继续',{timeout:65000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'online-binding-ui-'));let app,service;
  t.after(async()=>{await app?.close();await service?.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const user={id:'binding-user',username:'binding-user',displayName:'任务关联验收',isAdmin:true};
  service=createOnlineTableServer({port:0,dataDir:path.join(dir,'tables'),authUrl:'https://fixture.test/me',fetchImpl:async()=>Response.json({user}),logger:{error(){}}});
  const origin=await startFetchSafeServer(service),headers={Authorization:'Bearer fixture','Content-Type':'application/json'};
  const call=async(route,method='GET',body)=>{const response=await fetch(origin+route,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});assert.ok(response.ok,await response.clone().text());return response.json();};
  const tableA=(await call('/api/tables','POST',{name:'当前冬装选品表'})).table;
  // Creation intentionally allows a single shared table. Seed a legacy second table to test persisted bindings.
  const tableB={id:'77777777-7777-4777-8777-777777777777',name:'历史夏装选品表'};
  service.db.prepare('INSERT INTO tables (id,name,owner_user_id,token_hash,created_at,updated_at,revision) SELECT ?,?,owner_user_id,token_hash,created_at,updated_at,0 FROM tables WHERE id=?').run(tableB.id,tableB.name,tableA.id);
  const tasks=[];
  async function seed(table,title,link,legacy=false){
    const base=`/api/tables/${table.id}`;let row=(await call(base+'/rows','POST',{rows:[{title,sourceType:'douyin',sourceUrl:link}]})).rows[0];
    row=(await call(base+`/rows/${row.id}`,'PATCH',{ifVersion:row.version,patch:{humanStatus:'approved'}})).row;
    const id=crypto.randomUUID();row=(await call(base+`/claim/${row.id}`,'POST',{taskId:id})).row;
    row=(await call(base+`/rows/${row.id}`,'PATCH',{ifVersion:row.version,patch:{automationState:'attention',automationStep:'supplier_facts',automationError:'待补齐供货资料'}})).row;
    const now=new Date().toISOString();tasks.push({id,createdAt:now,updatedAt:now,sourceType:'douyin',sourceUrl:link,sourceTitle:title,articleNo:'',imageFile:'',events:[],onlineTableRowId:row.id,onlineTableRowVersion:row.version,...(legacy?{}:{onlineTableId:table.id}),origin:{fileName:'在线表格',sheetName:table.name,rowNumber:row.position},automation:{enabled:true,state:'attention',step:'supplier_facts',tags:[],checkpoints:{},error:'待补齐供货资料'}});
    return{row,id};
  }
  const current=await seed(tableA,'本次冬装商品','https://v.douyin.com/current-winter/',true);
  const orphan=await seed(tableA,'旧表已删除商品','https://v.douyin.com/deleted-old/');
  const previous=await seed(tableB,'历史夏装商品','https://v.douyin.com/history-summer/');
  const remote=await seed(tableA,'另一台电脑的外套','https://v.douyin.com/remote-coat/');tasks.pop();
  await call(`/api/tables/${tableA.id}/rows/${orphan.row.id}`,'DELETE',{ifVersion:orphan.row.version});
  const profile=path.join(dir,'profile'),dataDir=path.join(profile,'profiles',profileId(user));await fs.mkdir(dataDir,{recursive:true});await fs.writeFile(path.join(dataDir,'buyer-tasks.json'),JSON.stringify({tasks,automationPaused:true}));
  const bootstrap=path.join(dir,'main.cjs');await fs.writeFile(bootstrap,`const{app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});require(${JSON.stringify(path.join(root,'desktop/main.js'))});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath:process.env.PC_QA_EXECUTABLE||path.join(root,'desktop/node_modules/electron/dist/electron.exe'),args:process.env.PC_QA_EXECUTABLE?[`--user-data-dir=${profile}`]:[bootstrap],env});
  const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));await app.context().route('https://**/*',route=>route.abort());
  await page.waitForLoadState('load');
  await app.evaluate(({dialog},{origin,user})=>{
    const actual=fetch;globalThis.bindingConfirm=0;globalThis.bindingDialogs=[];globalThis.unexpectedRequests=[];
    dialog.showMessageBox=async(_window,options)=>{bindingDialogs.push(options);return{response:bindingConfirm};};
    globalThis.fetch=async(url,options={})=>{
      const target=String(url);
      if(target.startsWith('https://wsfile.cn/maishou/api/online-table'))return actual(target.replace('https://wsfile.cn/maishou/api/online-table',origin),options);
      if(target.startsWith('https://wsfile.cn/myladmin/api/auth/'))return Response.json(target.endsWith('/login')?{token:'fixture',expiresAt:new Date(Date.now()+3600000).toISOString(),user}:{user,ok:true});
      if(target.endsWith('/erp-config/me'))return Response.json({ready:false,error:'测试未启用互拓'});
      unexpectedRequests.push(target);throw new Error('测试禁止调用模型或互拓');
    };
  },{origin,user});
  assert.deepEqual(errors,[]);
  await page.locator('#username').fill('binding-user');await page.locator('#password').fill('fixture');await page.locator('#loginButton').click({noWaitAfter:true});await page.locator('#appShell').waitFor({state:'visible'});await page.locator('#navBuyer').click();
  await page.locator('[data-buyer-tab=table]').click();await page.locator('#onlineTablePicker').waitFor({state:'visible'});await page.locator('#onlineTablePicker').selectOption(tableA.id);
  await page.waitForFunction(()=>document.querySelector('#onlineTableName').textContent==='当前冬装选品表');
  const currentCard=page.locator(`[data-buyer-task="${current.id}"]`);
  await page.locator('[data-buyer-tab=progress]').click();await currentCard.waitFor();assert.equal(await page.locator('#buyerTaskList [data-buyer-task]').count(),1);
  assert.match(await currentCard.textContent(),new RegExp(current.id));assert.match(await page.locator(`tr[data-online-row="${current.row.id}"] .online-task-id`).textContent(),new RegExp(current.id));
  // Dirty table edits are never silently discarded by task navigation.
  await page.locator('[data-buyer-tab=table]').click();const row=page.locator(`tr[data-online-row="${current.row.id}"]`);await row.locator('[data-field=title]').fill('尚未保存的标题');
  await row.locator('.online-row-number').click();await page.locator('#buyerAutoDetailDialog').waitFor({state:'visible'});
  assert.match(await page.locator('#buyerDetailStatus').textContent(),/第1行.*待处理.*整理供货资料/);
  assert.equal(await page.locator('#buyerDetailTrack [aria-current="step"]').textContent(),'3取得供货资料');
  await page.locator('#buyerDetailNav [data-detail-section=history]').click();assert.equal(await page.locator('#buyerDetailHistory').getAttribute('open'),'');
  assert.equal(await page.locator('#buyerAutoDetailClose').evaluate(node=>{const r=node.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),true,'滚动处理记录后仍能关闭');
  await page.locator('#buyerDetailReturnRow').click();await page.locator('#buyerAutoDetailDialog').waitFor({state:'hidden'});
  assert.equal(await row.locator('[data-field=title]').inputValue(),'尚未保存的标题','查看和返回流程不丢失未保存输入');
  assert.equal(await row.evaluate(node=>node.classList.contains('online-found')),true);
  await page.evaluate(async id=>{const current=await window.desktop.snapshot();const task=current.buyerTasks.find(row=>row.id===id);task.automation.step='supplier_details';task.automation.state='waiting';window.BuyerAutoUI.render(current);},current.id);
  assert.match(await row.locator('[data-online-flow-state]').textContent(),/等待平台.*采集供应商资料/);
  assert.equal(await row.locator('[data-field=title]').inputValue(),'尚未保存的标题','刷新流程状态不重建表格输入');
  const remoteRow=page.locator(`tr[data-online-row="${remote.row.id}"]`);await remoteRow.locator('.online-row-number').click();
  await page.locator('#buyerAutoDetailDialog').waitFor({state:'visible'});assert.match(await page.locator('#buyerAutoDetailTitle').textContent(),/另一台电脑/);
  assert.equal(await page.locator('#buyerAutoDetailBody .buyer-detail-retry').count(),0,'远端流程只读，不从本机启动或重试');
  await page.locator('#buyerDetailReturnRow').click();await page.locator('#buyerAutoDetailDialog').waitFor({state:'hidden'});
  assert.equal(await remoteRow.evaluate(node=>node.classList.contains('online-found')),true);assert.equal(await row.locator('[data-field=title]').inputValue(),'尚未保存的标题');
  await page.locator('[data-buyer-tab=progress]').click();await currentCard.locator('.buyer-locate-row').click();await page.waitForFunction(()=>document.querySelector('#buyerAutoMessage').textContent.includes('请先保存或撤销'));
  assert.equal(await row.locator('[data-field=title]').inputValue(),'尚未保存的标题');await page.locator('[data-buyer-tab=table]').click();await row.locator('.online-cancel-row').click();await page.locator('[data-buyer-tab=progress]').click();
  await page.locator('#buyerTaskScope').selectOption('all');await page.waitForFunction(()=>document.querySelectorAll('#buyerTaskList [data-buyer-task]').length===3);
  const oldCard=page.locator(`[data-buyer-task="${orphan.id}"]`);await oldCard.locator('.buyer-auto-retry').click();await page.waitForFunction(()=>document.querySelector('#buyerAutoMessage').textContent.includes('旧任务不能继续'));
  assert.equal((await page.evaluate(()=>window.desktop.snapshot())).buyerTasks.find(task=>task.id===orphan.id).automation.state,'attention');
  // Cancel first, then delete the invalid historical task without touching the new table row.
  await oldCard.locator('.buyer-delete-task').click();assert.equal(await oldCard.count(),1);
  await app.evaluate(()=>{bindingConfirm=1;});await oldCard.locator('.buyer-delete-task').click();await oldCard.waitFor({state:'detached'});
  assert.equal((await call(`/api/tables/${tableA.id}`)).rows[0].taskId,current.id);
  await page.locator('#buyerTaskScope').selectOption('current');await page.locator('[data-buyer-tab=table]').click();await page.locator('#onlineTablePicker').selectOption(tableB.id);
  await page.waitForFunction(id=>document.querySelector('#buyerTaskList [data-buyer-task]')?.dataset.buyerTask===id,previous.id);
  assert.equal(await page.locator('#buyerTaskList [data-buyer-task]').count(),1);
  await page.locator('[data-buyer-tab=progress]').click();await page.locator('#buyerTaskScope').selectOption('all');await currentCard.locator('.buyer-locate-row').click();
  await page.waitForFunction(()=>document.querySelector('#onlineTableName').textContent==='当前冬装选品表');assert.equal(await page.locator(`tr.online-found[data-online-row="${current.row.id}"]`).count(),1);
  let snapshot=await page.evaluate(()=>window.desktop.snapshot());assert.equal(snapshot.buyerTasks.find(task=>task.id===current.id).onlineTableId,tableA.id);
  await page.locator('[data-buyer-tab=progress]').click();await page.locator('#buyerTaskScope').selectOption('current');await page.waitForFunction(id=>document.querySelector('#buyerTaskList [data-buyer-task]')?.dataset.buyerTask===id,current.id);await page.locator('#buyerTaskList').scrollIntoViewIfNeeded();
  await fs.mkdir(path.join(root,'output/playwright'),{recursive:true});await page.screenshot({path:path.join(root,'output/playwright/task-table-binding-desktop.png')});
  await page.setViewportSize({width:800,height:900});await page.locator('#buyerTaskList').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'output/playwright/task-table-binding-narrow.png')});
  await currentCard.locator('.buyer-delete-task').click();await currentCard.waitFor({state:'detached'});
  const remaining=(await call(`/api/tables/${tableA.id}`)).rows[0];assert.equal(remaining.taskId,current.id);assert.equal(remaining.automationState,'stopped');
  snapshot=await page.evaluate(()=>window.desktop.snapshot());assert.equal(snapshot.buyerTasks.length,1);assert.equal(snapshot.buyerTasks[0].id,previous.id);
  assert.match(await app.evaluate(()=>bindingDialogs.at(-1).detail),/在线表格、任务 ID 和互拓商品回执保留/);assert.deepEqual(await app.evaluate(()=>unexpectedRequests),[]);assert.deepEqual(errors,[]);
});
