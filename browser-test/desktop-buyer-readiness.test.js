const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {_electron}=require('playwright');
const root=path.resolve(__dirname,'..');

test('Electron：第一步显示插件缺项、旧版及重新加载步骤，处理入口可用且更新后保留原任务',{timeout:40000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buyer-readiness-'));let app;
  t.after(async()=>{await app?.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const bootstrap=path.join(dir,'main.cjs');
  await fs.writeFile(bootstrap,`const {app}=require('electron');app.setPath('userData',${JSON.stringify(path.join(dir,'profile'))});require(${JSON.stringify(path.join(root,'desktop/main.js'))});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath:process.env.PC_QA_EXECUTABLE||path.join(root,'desktop/node_modules/electron/dist/electron.exe'),args:process.env.PC_QA_EXECUTABLE?[`--user-data-dir=${path.join(dir,'profile')}`]:[bootstrap],env});
  const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await app.context().route('https://**/*',route=>route.abort());
  await app.evaluate(({shell})=>{
    globalThis.opened=[];shell.openExternal=async url=>{opened.push(url);};
    globalThis.fetch=async url=>{
      const target=String(url);
      if(target.startsWith('https://wsfile.cn/myladmin/api/auth/')){const user={id:'readiness-qa',username:'readiness-qa',displayName:'验收买手'};return Response.json(target.endsWith('/login')?{token:'fixture',expiresAt:new Date(Date.now()+3600000).toISOString(),user}:{user});}
      if(target.endsWith('/erp-config/me'))return Response.json({ready:true,config:{baseUrl:'https://wsfile.cn/maishou/api',username:'fixture',canSubmitDrafts:true,canConvertDrafts:true}});
      if(target.includes('/online-table/api/tables'))return Response.json({ok:true,tables:[]});
      throw new Error('验收禁止模型调用和远端写入');
    };
  });
  await page.locator('#username').fill('readiness-qa');await page.locator('#password').fill('fixture');await page.locator('#loginButton').click();await page.locator('#appShell').waitFor({state:'visible'});
  await page.locator('#buyerPluginPrompt').waitFor({state:'visible'});assert.match(await page.locator('#buyerPluginPrompt').textContent(),/尚未连接.*重新加载/s);
  await page.locator('#buyerAddLink').click();await page.locator('#buyerSingleLinkValue').fill('推荐：https://v.douyin.com/DfVjoLZW2Fc/复制打开');await page.locator('#buyerSingleLinkStart').click();await page.locator('#buyerSingleLinkDialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('.buyer-waiting-reason')?.textContent.includes('插件连接'));
  await page.locator('.buyer-auto-detail').click();await page.locator('#buyerAutoDetailDialog').waitFor({state:'visible'});
  assert.match(await page.locator('#buyerAutoDetailBody').textContent(),/等待浏览器插件连接/);
  await page.locator('#buyerAutoDetailBody .buyer-open-source').click();assert.deepEqual(await app.evaluate(()=>opened),['https://v.douyin.com/DfVjoLZW2Fc/']);
  await page.locator('#buyerAutoDetailBody .buyer-plugin-help').click();await page.locator('#helpPage').waitFor({state:'visible'});assert.equal(await page.locator('#buyerAutoDetailDialog').isVisible(),false);assert.equal(await page.locator('#preparePlugin').isVisible(),true);
  await page.locator('#navBuyer').click();
  let state=await page.evaluate(()=>window.desktop.snapshot());const taskId=state.buyerTasks[0].id;
  const poll=async(version,protocol)=>{const headers={'X-Desktop-Token':state.token,...(version?{'X-PC-Extension-Version':version}:{}),...(protocol?{'X-PC-Buyer-Protocol':protocol}:{})};return(await fetch(`http://127.0.0.1:${state.port}/v1/browser-commands/next`,{headers})).json();};
  assert.equal((await poll('26.10.27.18')).command,null);
  await page.waitForFunction(()=>document.querySelector('#buyerPluginPrompt').textContent.includes('需要更新'));
  await page.waitForFunction(()=>document.querySelector('.buyer-auto-error')?.textContent.includes('重新加载'));
  await page.locator('.buyer-auto-detail').click();assert.match(await page.locator('#buyerAutoDetailBody').textContent(),/更新插件文件.*重新加载.*处理后继续原任务/s);
  await fs.mkdir(path.join(root,'output/playwright'),{recursive:true});await page.screenshot({path:path.join(root,'output/playwright/buyer-plugin-update-detail.png')});
  await page.locator('#buyerAutoDetailClose').click();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(800,620));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.locator('#buyerPluginPrompt').screenshot({path:path.join(root,'output/playwright/buyer-plugin-update-prompt.png')});
  const version=require('../manifest.json').version;assert.equal((await poll(version,'1')).command,null);
  await page.waitForFunction(()=>document.querySelector('#buyerPluginPrompt').hidden);
  await page.locator('.buyer-auto-retry').click();
  await page.waitForFunction(()=>document.querySelector('.buyer-waiting-reason')?.textContent.includes('等待浏览器插件接单'));
  const next=await poll(version,'1');assert.equal(next.command.buyerTaskId,taskId);
  state=await page.evaluate(()=>window.desktop.snapshot());assert.equal(state.buyerTasks.length,1);assert.equal(state.browserClient.state,'ready');assert.deepEqual(errors,[]);
});
