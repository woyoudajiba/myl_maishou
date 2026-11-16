const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {_electron}=require('playwright');
const {profileId}=require('../desktop/accounts');
const root=path.resolve(__dirname,'..');

test('旧淘宝验证失败任务显示专用验证按钮，交给配对插件打开且商品弹窗保留',{timeout:30000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'taobao-verification-ui-'));let app;
  t.after(async()=>{await app?.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const user={id:'taobao-verification-qa',username:'taobao-verification-qa',displayName:'验证入口测试'},id=crypto.randomUUID();
  const profile=path.join(dir,'profile'),dataDir=path.join(profile,'profiles',profileId(user)),now=new Date().toISOString();
  const task={id,sourceType:'image',sourceUrl:'',sourceTitle:'等待淘宝验证的商品',imageFile:'',createdAt:now,updatedAt:now,events:[],marketplaceSearch:{status:'failed',error:'淘宝要求安全验证，请在浏览器完成验证后重新搜索'},automation:{state:'attention',step:'marketplace',enabled:false,error:'淘宝要求安全验证，请在浏览器完成验证后重新搜索',tags:[],checkpoints:{}}};
  await fs.mkdir(dataDir,{recursive:true});await fs.writeFile(path.join(dataDir,'buyer-tasks.json'),JSON.stringify({tasks:[task],automationPaused:true}));
  const bootstrap=path.join(dir,'main.cjs');await fs.writeFile(bootstrap,`const {app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});require(${JSON.stringify(path.join(root,'desktop/main.js'))});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath:process.env.PC_QA_EXECUTABLE||path.join(root,'desktop/node_modules/electron/dist/electron.exe'),args:process.env.PC_QA_EXECUTABLE?[`--user-data-dir=${profile}`]:[bootstrap],env});
  const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await app.context().route('https://**/*',route=>route.abort());
  await app.evaluate((_,user)=>{globalThis.fetch=async(url)=>{if(String(url).startsWith('https://wsfile.cn/myladmin/api/auth/'))return Response.json(String(url).endsWith('/login')?{user,token:'fixture',expiresAt:new Date(Date.now()+3600000).toISOString()}:{user,ok:true});if(String(url).endsWith('/erp-config/me'))return Response.json({ready:false});throw new Error('测试禁止外网和ERP写入');};},user);
  await page.locator('#username').fill(user.username);await page.locator('#password').fill('fixture');await page.locator('#loginButton').click();await page.locator('#appShell').waitFor({state:'visible'});
  await page.locator('.buyer-auto-detail').click();const dialog=page.locator('#buyerAutoDetailDialog');await dialog.waitFor({state:'visible'});
  const button=dialog.locator('.buyer-taobao-verification');await button.click();
  await page.waitForFunction(()=>document.querySelector('#buyerDetailNotice').textContent.includes('已请求配对插件'));
  assert.equal(await dialog.isVisible(),true);assert.match(await dialog.textContent(),/没有验证链接时会打开淘宝搜图页/);
  const snapshot=await page.evaluate(()=>window.desktop.snapshot());
  assert.equal(snapshot.browserCommands.length,1);assert.equal(snapshot.browserCommands[0].kind,'taobao-verification');assert.equal(snapshot.browserCommands[0].buyerTaskId,id);
  assert.equal(snapshot.buyerTasks[0].automation.state,'attention');assert.equal(snapshot.jobs.length,0);assert.equal(errors.length,0);
  await fs.mkdir(path.join(root,'output/qa/taobao-verification-2026-11-15'),{recursive:true});
  await page.screenshot({path:path.join(root,`output/qa/taobao-verification-2026-11-15/task-recovery-button${process.env.PC_QA_EXECUTABLE?'-packaged':''}.png`)});
});
