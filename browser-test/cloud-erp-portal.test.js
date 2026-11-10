const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');const {createServer,ErpMappingStore}=require('../maishou-service/server');
test('云端账号页只填账号密码；管理员服务配置与买手映射分离且能只读检查',{timeout:35000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cloud-erp-portal-')),store=new ErpMappingStore(path.join(dir,'mapping.json'),Buffer.alloc(32,6).toString('hex'));await store.load();
 const service=createServer({erpMappings:store,env:{ERP_BASE_URL:'https://erp.fixture/api',ERP_TENANT_ID:'1',ERP_CLIENT_ID:'default',ERP_CLIENT_SECRET:'server-fixture-secret'},fetchImpl:async(url,options={})=>{
  if(String(url).includes('/auth/me')){const admin=options.headers.Authorization==='Bearer manager';return Response.json({user:{id:admin?'manager':'buyer',username:admin?'manager':'buyer',displayName:admin?'管理员':'买手',isAdmin:admin}});}
  if(String(url).endsWith('/token'))return Response.json({code:0,data:{access_token:'erp-access',refresh_token:'erp-refresh',expires_in:3600}});
  return Response.json({code:0,data:String(url).endsWith('/get-permission-info')?{user:{nickname:'采购'}}:[{label:'fixture'}]});
 }});await service.listen(0,'127.0.0.1');
 const staticRoot=path.resolve(__dirname,'../maishou-service/site');
 const server=http.createServer(async(req,res)=>{if(req.url.startsWith('/maishou/api/')){req.url=req.url.slice('/maishou/api'.length);service.server.emit('request',req,res);return;}const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const file=path.join(staticRoot,name+(name.endsWith('/')?'index.html':''));if(!file.startsWith(staticRoot+path.sep)){res.writeHead(404);res.end();return;}try{const data=await fs.readFile(file);res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8'});res.end(data);}catch{res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true,channel:'chromium'});
 t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));await service.close();await fs.rm(dir,{recursive:true,force:true});});
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin+'/maishou/admin/');await page.evaluate(()=>sessionStorage.setItem('maishou-tdl-token','buyer'));await page.reload();await page.locator('#dashboard').waitFor({state:'visible'});
 assert.equal(await page.locator('#own-erp-form input').count(),2);assert.equal(await page.locator('#erp-users-link').isVisible(),false);
 await page.locator('#own-erp-username').fill('personal-erp');await page.locator('#own-erp-password').fill('fixture-private-password');await page.locator('#own-erp-form button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#own-erp-message').textContent.includes('加密保存'));
 assert.equal(await page.locator('#own-erp-password').inputValue(),'');await page.locator('#own-erp-test').click();await page.waitForFunction(()=>document.querySelector('#own-erp-message').textContent.includes('连接成功'));
 await page.goto(origin+'/maishou/admin/erp-users/');await page.locator('#login-warning').waitFor({state:'visible'});
 await page.evaluate(()=>sessionStorage.setItem('maishou-tdl-token','manager'));await page.reload();await page.locator('#mapping-view').waitFor({state:'visible'});
 assert.equal(await page.locator('#mapping-form input').count(),2);assert.equal(await page.locator('#erp-company').count(),0);assert.equal(await page.locator('.service-panel').getAttribute('open'),null);
 await page.locator('#tdl-user').selectOption('buyer');await page.locator('#test-mapping').click();await page.waitForFunction(()=>document.querySelector('#mapping-message').textContent.includes('连接成功'));
 await fs.mkdir(path.resolve(__dirname,'../output/qa/cloud-erp'),{recursive:true});await page.screenshot({path:path.resolve(__dirname,'../output/qa/cloud-erp/admin-erp.png')});assert.deepEqual(errors,[]);
});
