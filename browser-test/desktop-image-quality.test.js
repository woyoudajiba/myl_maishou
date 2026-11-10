const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const sharp = require('../desktop/node_modules/sharp');

const root = path.resolve(__dirname, '..');

test('实际 Electron：高清图片证据、504 自动恢复，不重复发送成功商品', { timeout: 65000 }, async t => {
  const executablePath = process.env.PC_QA_EXECUTABLE || path.join(root, 'desktop/node_modules/electron/dist/electron.exe');
  try { await fs.access(executablePath); } catch { return t.skip('需要 Electron'); }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'product-hd-qa-'));
  const dataDir = path.join(temp, 'profile'); await fs.mkdir(dataDir);
  const source = await sharp(Buffer.from('<svg width="800" height="1000"><rect width="800" height="1000" fill="#e6e9eb"/><path d="M260 160 L340 120 Q400 220 460 120 L540 160 L720 390 L600 470 L540 390 L540 870 L260 870 L260 390 L200 470 L80 390Z" fill="#345776" stroke="#243e59" stroke-width="9"/><path d="M400 200V870M290 420H365V530H290Z" fill="none" stroke="#aec1d3" stroke-width="6"/></svg>')).png().toBuffer();
  const thumbnail = await sharp(source).resize(200, 200).png().toBuffer();
  const image = `data:image/png;base64,${source.toString('base64')}`;
  const bootstrap = path.join(temp, 'main.cjs');
  await fs.writeFile(bootstrap, `require(${JSON.stringify(path.join(root, 'desktop/main.js'))});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({ executablePath, args: [...(process.env.PC_QA_EXECUTABLE ? [] : [bootstrap]), `--user-data-dir=${dataDir}`], env });
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), dataDir);
    const page = await app.firstWindow(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('#loginScreen', { state: 'visible' });
    await app.context().route('https://**/*', route => route.request().url().startsWith('https://pics.17qcc.com/')
      ? route.fulfill({ contentType: 'image/png', body: route.request().url().includes('x-oss-process') ? thumbnail : source }) : route.abort());
    await app.evaluate((_, input) => {
      process.getBuiltinModule('node:dns/promises').lookup = async () => [{ address: '93.184.216.34', family: 4 }];
      globalThis.hdRequests = []; globalThis.modelPayloads = [];
      globalThis.fetch = async (url, options) => {
        const address = String(url);
        if (address.startsWith('https://pics.17qcc.com/')) {
          globalThis.hdRequests.push(address);
          return new Response(Buffer.from(address.includes('x-oss-process') ? input.thumbnail : input.source, 'base64'));
        }
        if (address.startsWith('https://wsfile.cn/myladmin/api/auth/')) {
          const user = { id: 'hd-qa', username: 'hd-qa', displayName: '高清识别测试' };
          return Response.json(address.endsWith('/login') ? { token: 'fixture-token', expiresAt: new Date(Date.now() + 3600000).toISOString(), user } : { user, ok: true });
        }
        if (!address.startsWith('https://vision.example/')) throw new Error('测试禁止外网请求');
        const content = JSON.parse(options.body).messages[1].content;
        globalThis.modelPayloads.push(content);
        if (globalThis.modelPayloads.length === 2) return new Response('upstream timeout', { status: 504 });
        const ids = content.filter(part => part.type === 'text' && part.text.startsWith('候选编号：')).map(part => part.text.slice(5));
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results: ids.map(id => ({ id, verdict: 'similar', score: 76, matches: ['衣身轮廓接近'], differences: ['口袋待核对'], uncertainties: [] })) }) } }] });
      };
    }, { source: source.toString('base64'), thumbnail: thumbnail.toString('base64') });
    await page.locator('#username').fill('hd-qa'); await page.locator('#password').fill('fixture-password'); await page.locator('#loginButton').click();
    await page.waitForSelector('#appShell', { state: 'visible' });
    await page.locator('#navWork').click();
    await page.evaluate(async () => {const result=await window.desktop.saveModel({ concurrency: 1, name: '高清视觉测试', model: 'fixture-vision', endpoint: 'https://vision.example/v1', apiKey: 'fixture-key' });await window.desktop.selectModel(result.models.find(m=>m.name==='高清视觉测试').id);});
    const snapshot = await page.evaluate(() => window.desktop.snapshot());
    const response = await fetch(`http://127.0.0.1:${snapshot.port}/v1/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Desktop-Token': snapshot.token },
      body: JSON.stringify({ query: image, goodsId: '高清图片与超时恢复', items: Array.from({ length: 9 }, (_, index) => ({ platform: 'qcc', id: String(index + 1), price: 42,
        imageUrl: `https://pics.17qcc.com/product/${index + 1}.png?x-oss-process=image/resize,m_fill,h_200,w_200`, detailUrl: `https://www.17qcc.com/item/${index + 1}.html` })) }) });
    assert.equal(response.status, 202);
    const { id } = await response.json();
    let completed;
    for(let i=0;i<200;i++){
      completed=(await page.evaluate(()=>window.desktop.snapshot())).jobs.find(j=>j.id===id);
      if(completed?.status==='complete')break;
      await page.waitForTimeout(25);
    }
    assert.equal(completed.status,'complete',JSON.stringify(completed));
    assert.equal(completed.autoRetryCount,1);
    assert.equal(completed.compared,9);
    const requests=await app.evaluate(()=>globalThis.hdRequests);
    assert.equal(requests.length,13);
    assert.equal(requests.some(url=>url.includes('x-oss-process')),false);
    const batches=await app.evaluate(()=>globalThis.modelPayloads.map(content=>content.filter(part=>part.type==='text'&&part.text.startsWith('候选编号：')).map(part=>part.text.slice(5))));
    assert.deepEqual(batches.map(batch=>batch.length),[4,4,4,1]);
    assert.ok(batches.slice(2).flat().every(candidate=>Number(candidate.split('_')[1])>=5),'自动恢复不重复发送前4张成功图片');
    const savedImage=await page.evaluate(id=>window.desktop.candidateImage(id,0),id);
    const sentImages=await app.evaluate(()=>globalThis.modelPayloads[0].filter(part=>part.type==='image_url').map(part=>part.image_url.url));
    assert.ok(sentImages.includes(savedImage));
    assert.deepEqual(await sharp(Buffer.from(savedImage.split(',')[1],'base64')).metadata().then(({width,height})=>[width,height]),[800,1000]);
    await page.locator('#refresh').click();
    const job=page.locator(`article[data-job="${id}"]`);
    await job.locator('.job-results summary').click();
    await job.locator('.view-image').first().click();
    await page.waitForFunction(()=>document.querySelector('#imageDialog img')?.naturalWidth===800);
    assert.equal(await page.locator('#imageDialog img').getAttribute('src'),savedImage);
    await fs.mkdir(path.join(root,'output/playwright'),{recursive:true});
    await page.screenshot({path:path.join(root,'output/playwright/desktop-hd-auto-recovered.png')});
    await page.locator('#imageDialog button').click();
    await job.locator('.review-item').first().click();
    await page.waitForFunction(()=>document.querySelector('#reviewDialog .review-candidate')?.naturalWidth===800);
    assert.equal(await page.locator('#reviewDialog .review-candidate').getAttribute('src'),savedImage);
    await page.locator('.cannot-decide').click();
    await page.waitForSelector('#reviewDialog',{state:'hidden'});
    assert.equal(await app.evaluate(()=>globalThis.modelPayloads.length),4);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(800,620));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors, []);
  } finally {
    await app?.close();
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
