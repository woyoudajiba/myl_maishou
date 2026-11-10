const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');

test('实际桌面：独立入口、链接识别、批量保存、预览、选择目录和退出账号隔离', { timeout: 40000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'product-douyin-ui-'));
  const profile = path.join(temp, 'profile'), output = path.join(temp, 'output');
  let app;
  try {
    const bootstrap = path.join(temp, 'main.cjs');
    const script = function () {
      const { app, dialog, shell } = require('electron');
      app.setPath('userData', PROFILE);
      const sharp = require(SHARP);
      const module = require(DOUYIN);
      module.createBrowserParser = () => async url => ({ title: url.includes('second') ? '裤子' : '上衣', productId: '123', images: ['https://p1-item.ecombdimg.com/img/ecom-shop-material/fixture'] });
      const Base = module.DouyinDownloads;
      module.DouyinDownloads = class extends Base { constructor(options) { super({ ...options, download: async () => ({ buffer: await sharp({ create: { width: 800, height: 900, channels: 3, background: '#517775' } }).png().toBuffer() }) }); } };
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [OUTPUT] });
      globalThis.opened = [];
      shell.openPath = async value => { globalThis.opened.push(value); return ''; };
      globalThis.fetch = async url => {
        if (!String(url).startsWith('https://wsfile.cn/myladmin/api/auth/')) throw new Error('禁止外部请求');
        const user = { id: 'douyin-qa', username: 'douyin-qa', displayName: '主图测试' };
        return Response.json(String(url).endsWith('/login') ? { user, token: 'fixture-token', expiresAt: new Date(Date.now() + 3600000).toISOString() } : { user, ok: true });
      };
      require(MAIN);
    };
    const source='('+script.toString().replace('PROFILE',JSON.stringify(profile)).replace('SHARP',JSON.stringify(path.join(root,'desktop/node_modules/sharp'))).replace('DOUYIN',JSON.stringify(path.join(root,'desktop/douyin.js'))).replace('OUTPUT',JSON.stringify(output)).replace('MAIN',JSON.stringify(path.join(root,'desktop/main.js')))+')();';
    await fs.writeFile(bootstrap,source);
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    app=await _electron.launch({executablePath:path.join(root,'desktop/node_modules/electron/dist/electron.exe'),args:[bootstrap],env});
    const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.waitForSelector('#loginScreen',{state:'visible'});
    await assert.rejects(page.evaluate(()=>window.desktop.startDouyin({})),/请先登录/);
    await page.locator('#username').fill('douyin-qa');await page.locator('#password').fill('fixture');await page.locator('#loginButton').click();
    await page.waitForSelector('#appShell',{state:'visible'});await page.locator('#navDouyin').click();
    assert.equal(await page.locator('#douyinPage').isVisible(),true);
    await page.locator('#douyinLinks').fill('分享 https://v.douyin.com/first/\n分享 https://v.douyin.com/second/\nhttps://evil.example/test');
    assert.equal(await page.locator('#douyinCount').textContent(),'2 条');
    await page.locator('#douyinBrowse').click();await page.waitForFunction(dir=>document.getElementById('douyinFolder').value===dir,output);
    await page.locator('#douyinQuality').selectOption('jpg');await page.locator('#douyinStart').click();
    await page.waitForFunction(async()=>{const state=(await window.desktop.snapshot()).douyin;return state?.done===2&&!state.running;},null,{timeout:15000});
    await page.waitForFunction(()=>document.querySelectorAll('.douyin-result').length===2);
    assert.match(await page.locator('#douyinSummary').textContent(),/成功 2/);
    assert.equal(await page.locator('.douyin-result img').count(),2);
    const files=await fs.readdir(output);assert.equal(files.length,2);
    await fs.access(path.join(output,files[0],'1.jpg'));await fs.access(path.join(output,files[0],'商品信息.txt'));
    await page.locator('#douyinOpen').click();assert.deepEqual(await app.evaluate(()=>opened),[output]);
    await fs.mkdir(path.join(root,'output/playwright'),{recursive:true});await page.screenshot({path:path.join(root,'output/playwright/douyin-module.png'),fullPage:true});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(800,620));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.locator('#logout').click();await page.waitForSelector('#loginScreen',{state:'visible'});
    assert.equal(await page.locator('#douyinLinks').inputValue(),'');
    assert.deepEqual(errors,[]);
  } finally { await app?.close();await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
});
