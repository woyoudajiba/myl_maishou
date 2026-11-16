const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright'),{startFetchSafeServer}=require('../test/http-fixture');
const root=path.resolve(__dirname,'..');
test('网页版选品表：TDL登录、录入编辑、确认身份、桌面回写同步、冲突保留和历史恢复',{timeout:45000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'web-table-')),users={admin:{id:'web-admin',username:'admin',displayName:'吴少凡',isAdmin:true}},staticRoot=path.join(root,'maishou-service/site');let browser,site,service;
  t.after(async()=>{await browser?.close();if(site)await new Promise(resolve=>site.close(resolve));await service?.close();await fs.rm(dir,{recursive:true,force:true});});
  const {createOnlineTableServer}=await import('../table-server/server.mjs');
  service=createOnlineTableServer({port:0,dataDir:dir,authUrl:'https://auth.fixture/me',fetchImpl:async()=>Response.json({user:users.admin}),logger:{error(){}}});
  site=http.createServer(async(req,res)=>{
    if(req.url.startsWith('/maishou/api/online-table/')){req.url=req.url.replace('/maishou/api/online-table','');service.server.emit('request',req,res);return;}
    if(req.url.startsWith('/myladmin/api/auth/')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(req.url.endsWith('/login')?{token:'admin',user:users.admin}:{user:users.admin}));return;}
    const url=new URL(req.url,'http://localhost'),file=path.join(staticRoot,url.pathname+(url.pathname.endsWith('/')?'index.html':''));
    if(!file.startsWith(staticRoot+path.sep)){res.writeHead(404);res.end();return;}
    try{const body=await fs.readFile(file);res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html; charset=utf-8'});res.end(body);}catch{res.writeHead(404);res.end();}
  });
  const origin=await startFetchSafeServer({server:site,start:async()=>{await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));return site.address();},close:async()=>{}});
  browser=await chromium.launch({headless:true,channel:'chromium'});const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/maishou/table/');assert.equal(await page.locator('#tableView').isVisible(),false);
  await page.locator('[name=username]').fill('admin');await page.locator('[name=password]').fill('fixture');await page.locator('#loginForm button').click();await page.locator('#tableView').waitFor({state:'visible'});assert.equal(await page.locator('[name=password]').inputValue(),'');
  page.once('dialog',dialog=>dialog.accept('秋冬买手选品表'));await page.locator('#createTable').click();await page.waitForFunction(()=>document.querySelector('#tablePicker').options.length===1);
  await page.locator('#addRow').click();await page.locator('[name=articleNo]').fill('6803');await page.locator('[name=sourceUrl]').fill('https://item.taobao.com/item.htm?id=12345678');await page.locator('[name=title]').fill('翻领夹克');await page.locator('[name=note]').fill('供应商图片已核对');await page.locator('#saveRow').click();await page.locator('#rowDialog').waitFor({state:'hidden'});await page.waitForSelector('#rows [data-row]');
  const row=page.locator('#rows [data-row]').first();page.once('dialog',dialog=>dialog.accept());await row.locator('[data-action=approve]').click();await page.waitForFunction(()=>document.querySelector('#rows').textContent.includes('吴少凡'));assert.match(await row.textContent(),/已确认/);
  const tableId=await page.locator('#tablePicker').inputValue(),id=await row.getAttribute('data-row'),headers={Authorization:'Bearer admin','Content-Type':'application/json'},base=origin+'/maishou/api/online-table/api/tables/'+tableId;
  const query=async(route='',options={})=>(await fetch(base+route,{...options,headers})).json();let saved=(await query()).rows[0];
  const taskId=crypto.randomUUID();saved=(await query('/claim/'+id,{method:'POST',body:JSON.stringify({taskId})})).row;
  saved=(await query('/rows/'+id,{method:'PATCH',body:JSON.stringify({ifVersion:saved.version,taskId,patch:{automationState:'waiting',automationStep:'collection_wait',automationError:'30秒后继续查询'}})})).row;
  await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#rows').textContent.includes('等待互拓采集结果'));assert.equal(saved.confirmedBy,'吴少凡');
  await row.locator('[data-action=edit]').click();assert.equal(await page.locator('[name=sourceUrl]').getAttribute('readonly'),'');await page.locator('[name=title]').fill('本机未保存的标题');
  await query('/rows/'+id,{method:'PATCH',body:JSON.stringify({ifVersion:saved.version,patch:{title:'他人修改后的标题'}})});await page.locator('#saveRow').click();await page.waitForFunction(()=>document.querySelector('#rowError').textContent.includes('其他人修改'));assert.equal(await page.locator('[name=title]').inputValue(),'本机未保存的标题');await page.locator('#closeRow').click();
  await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#rows').textContent.includes('他人修改后的标题'));await page.locator('#history').click();await page.locator('[data-history]').first().click();await page.waitForFunction(()=>document.querySelector('#historyDetail').textContent.includes('标题'));await page.locator('#closeHistory').click();
  await page.locator('#bulkRows').click();await page.locator('#bulkText').fill('A200\thttps://item.taobao.com/item.htm?id=12345679\t立领针织衫\t待核对供货信息\nhttps://item.taobao.com/item.htm?id=12345680');await page.locator('#bulkForm button[type=submit]').click();await page.locator('#bulkDialog').waitFor({state:'hidden'});assert.equal(await page.locator('#rows [data-row]').count(),3);
  const exported=page.waitForEvent('download');await page.locator('#exportRows').click();const download=await exported,downloadPath=await download.path();const csv=await fs.readFile(downloadPath,'utf8');assert.match(csv,/任务确认人/);assert.match(csv,/立领针织衫/);
  const last=page.locator('#rows [data-row]').last();page.once('dialog',dialog=>dialog.accept());await last.locator('[data-action=delete]').click();await page.waitForFunction(()=>document.querySelectorAll('#rows [data-row]').length===2);
  await page.locator('#history').click();page.once('dialog',dialog=>dialog.accept());await page.locator('[data-restore]').first().click();await page.locator('#historyDialog').waitFor({state:'hidden'});assert.equal(await page.locator('#rows [data-row]').count(),3);
  const qa=path.join(root,'output/qa/workspace-web-2026-11-15');await fs.mkdir(qa,{recursive:true});await page.screenshot({path:path.join(qa,'web-table-desktop.png')});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(qa,'web-table-mobile.png')});
  await page.locator('#logout').click();assert.equal(await page.locator('#tableView').isVisible(),false);assert.equal(await page.evaluate(()=>sessionStorage.getItem('maishou-tdl-token')),null);assert.deepEqual(errors,[]);
});
