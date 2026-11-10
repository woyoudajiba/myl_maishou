const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {_electron}=require('playwright');
const root=path.resolve(__dirname,'..');
test('桌面互拓只显示服务器状态，无任何技术或密码输入，账号入口固定打开云端页面',{timeout:30000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'managed-erp-ui-'));let app;t.after(async()=>{await app?.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 const bootstrap=path.join(dir,'main.cjs');await fs.writeFile(bootstrap,`require(${JSON.stringify(path.join(root,'desktop/main.js'))});`);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 app=await _electron.launch({executablePath:process.env.PC_QA_EXECUTABLE||path.join(root,'desktop/node_modules/electron/dist/electron.exe'),args:[...(process.env.PC_QA_EXECUTABLE?[]:[bootstrap]),'--user-data-dir='+path.join(dir,'profile')],env});
 const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await app.evaluate(({shell})=>{globalThis.cloudQa={ready:false,opened:[]};shell.openExternal=async url=>{cloudQa.opened.push(url);};globalThis.fetch=async(url)=>{
  const target=String(url);if(target.startsWith('https://wsfile.cn/myladmin/api/auth/')){const user={id:'cloud-buyer',username:'buyer',displayName:'买手'};return Response.json(target.endsWith('/login')?{token:'fixture',expiresAt:new Date(Date.now()+3600000).toISOString(),user}:{user});}
  if(target.endsWith('/erp-config/me'))return Response.json({ready:cloudQa.ready,error:cloudQa.ready?'':'请在账号页面保存互拓账号和密码',config:cloudQa.ready?{baseUrl:'https://wsfile.cn/maishou/api',tenantId:'managed',username:'my-erp',canSubmitDrafts:false,canConvertDrafts:false}:null});
  if(target.includes('/online-table/'))return Response.json({tables:[],ok:true});throw new Error('禁止真实外网');};});
 await page.locator('#username').fill('buyer');await page.locator('#password').fill('fixture');await page.locator('#loginButton').click();await page.locator('#appShell').waitFor({state:'visible'});await page.locator('#navSettings').click();
 assert.equal(await page.locator('#buyerConfigForm').count(),0);assert.equal(await page.locator('[id^=buyerConfig_erp]').count(),0);
 await page.locator('#buyerErpAccountPage').click();assert.deepEqual(await app.evaluate(()=>cloudQa.opened),['https://wsfile.cn/maishou/admin/']);
 await app.evaluate(()=>{cloudQa.ready=true;});await page.locator('#buyerManagedErpRefresh').click();await page.waitForFunction(()=>document.querySelector('#buyerManagedErpStatus').textContent==='互拓已连接');
 const snapshot=await page.evaluate(()=>window.desktop.snapshot());assert.equal(snapshot.buyerSettings.configured,true);assert.equal(snapshot.buyerSettings.managed,true);assert.equal(Object.hasOwn(snapshot.buyerSettings,'erpPassword'),false);assert.equal(Object.hasOwn(snapshot.buyerSettings,'erpClientSecret'),false);
 await assert.rejects(()=>page.evaluate(()=>window.desktop.saveBuyerSettings({erpBaseUrl:'https://evil.example'})),/服务器管理员/);
 await fs.mkdir(path.join(root,'output/qa/cloud-erp'),{recursive:true});await page.screenshot({path:path.join(root,'output/qa/cloud-erp/desktop-managed.png')});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(800,620));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
});
