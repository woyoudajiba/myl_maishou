const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const executablePath = process.env.PC_QA_EXECUTABLE || path.join(root, 'desktop/node_modules/electron/dist/electron.exe');

test('实际 Electron：TDL 登录、模型管理、图片比对、人工纠正、账号隔离与加密保存', { timeout: 75000 }, async t => {
  try { await fs.access(executablePath); } catch { return t.skip('需要先在 desktop 安装 Electron 开发依赖'); }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'product-electron-review-'));
  const dataDir = path.join(temp, 'profile'); await fs.mkdir(dataDir);
  const bootstrap = path.join(temp, 'main.cjs');
  await fs.writeFile(bootstrap, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(dataDir)});require(${JSON.stringify(path.join(root, 'desktop/main.js'))});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({ executablePath, args: [...(process.env.PC_QA_EXECUTABLE ? [] : [bootstrap]), `--user-data-dir=${dataDir}`], env });
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), dataDir);
    const page = await app.firstWindow();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('#loginScreen', { state: 'visible' });
    await fs.mkdir(path.join(root, 'output/playwright'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'output/playwright/desktop-login.png') });
    assert.equal((await page.evaluate(() => window.desktop.snapshot())).authenticated, false);
    await assert.rejects(page.evaluate(() => window.desktop.saveModel({})), /请先登录/);
    const image = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 1000;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#eee'; ctx.fillRect(0, 0, 240, 320);
      ctx.fillStyle = '#345776'; ctx.fillRect(50, 60, 140, 210); return canvas.toDataURL('image/png');
    });
    await app.context().route('https://**/*', route => {
      if (route.request().url().startsWith('https://imgcdn.wsy.com/')) return route.fulfill({ contentType: 'image/png', body: Buffer.from(image.split(',')[1], 'base64') });
      return route.abort();
    });
    // Exercise the actual main-process download, protocol, queue, IPC and disk
    // writes. Only remote transport and DNS are fixtures; no external calls.
    await app.evaluate((_, image) => {
      process.getBuiltinModule('node:dns/promises').lookup = async () => [{ address: '93.184.216.34', family: 4 }];
      globalThis.testModelCalls = 0;
      globalThis.fetch = async (url, options) => {
        if (String(url).startsWith('https://imgcdn.wsy.com/')) return new Response(Buffer.from(image.split(',')[1], 'base64'), { headers: { 'content-type': 'image/png' } });
        if (String(url).startsWith('https://wsfile.cn/myladmin/api/auth/')) {
          if (String(url).endsWith('/login')) {
            const input = JSON.parse(options.body);
            if (input.password === 'bad') return new Response('{}', { status: 401 });
            globalThis.fixtureUser = { id: input.username, username: input.username, displayName: '本地测试账号 ' + input.username };
            return Response.json({ token: 'fixture-cloud-token', expiresAt: new Date(Date.now() + 3600000).toISOString(), user: globalThis.fixtureUser });
          }
          return Response.json({ user: globalThis.fixtureUser, ok: true });
        }
        if (!String(url).startsWith('https://vision.example/')) throw new Error('测试禁止外网请求');
        globalThis.testModelCalls++;
        const content = JSON.parse(options.body).messages[1].content;
        const ids = content.filter(part => part.type === 'text' && part.text.startsWith('候选编号：')).map(part => part.text.slice(5));
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results: ids.map(id => ({ id, verdict: 'likely_same', score: 90,
          matches: ['领口一致', '口袋位置一致'], differences: [], uncertainties: [] })) }) } }] }), { headers: { 'content-type': 'application/json' } });
      };
    }, image);
    const login = async username => {
      await page.locator('#username').fill(username); await page.locator('#password').fill('fixture-password'); await page.locator('#loginButton').click();
      await page.waitForSelector('#appShell', { state: 'visible' });
    };
    await page.locator('#username').fill('qa-A'); await page.locator('#password').fill('bad'); await page.locator('#loginButton').click();
    await page.waitForFunction(() => document.getElementById('loginMessage').textContent.includes('账号或密码不正确'));
    await login('qa-A');
    await page.screenshot({ path: path.join(root, 'output/playwright/desktop-workspace-empty.png') });
    await page.locator('#navSettings').click(); await page.locator('#addModel').click();
    await page.locator('#modelName').fill('自定义视觉审核'); await page.locator('#modelCode').fill('custom-vision');
    await page.locator('#modelEndpoint').fill('https://vision.example/v1'); await page.locator('#apiKey').fill('sk-electron-fixture-credential');
    await page.locator('#saveModel').click(); await page.waitForSelector('#modelDialog', { state: 'hidden' });
    await page.waitForFunction(() => document.getElementById('modelState').textContent.includes('当前使用'));
    const modelCard = page.locator('.model-card').filter({ has: page.locator('.edit-model') });
    await modelCard.locator('.test-model').click(); await page.waitForFunction(() => document.getElementById('notice').textContent.includes('连接成功'));
    await modelCard.locator('.edit-model').click(); await page.locator('#modelName').fill('自定义视觉模型（已编辑）');
    await page.locator('#saveModel').click(); await page.waitForSelector('#modelDialog', { state: 'hidden' });
    await page.waitForFunction(() => document.getElementById('modelList').textContent.includes('已编辑'));
    await modelCard.locator('.use-model').click();
    await page.screenshot({ path: path.join(root, 'output/playwright/desktop-settings.png') });
    await page.locator('#navWork').click();
    const initial = await page.evaluate(() => window.desktop.snapshot());
    assert.match(initial.token, /^[a-f0-9]{64}$/);
    const response = await fetch(`http://127.0.0.1:${initial.port}/v1/jobs`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Desktop-Token': initial.token },
      body: JSON.stringify({ query: image, goodsId: '本地审核测试', platformSearches: [
        { platform:'wsy', selected:true, phase:'complete', receivedCount:2, reportedTotal:97 },
        { platform:'zwd', selected:true, phase:'failed', receivedCount:0, reportedTotal:null, message:'17网登录已失效', searchGroups:[{type:'accurate',phase:'failed',receivedCount:0,reportedTotal:null}] },
        { platform:'qcc', selected:false, phase:'not_selected', receivedCount:0, reportedTotal:null },
        { platform:'e3hui', selected:false, phase:'not_selected', receivedCount:0, reportedTotal:null }
      ], items: [1, 2].map(id => ({ platform: 'wsy', id: String(id), price: 20, searchGroup: id === 1 ? 'accurate' : 'similar',
        imageUrl: `https://imgcdn.wsy.com/${id}.png`, detailUrl: `https://www.wsy.com/item.htm?id=${id}`, platformTags: id === 2 ? ['新品', '闪电发货', 'discard-unknown'] : [], dataSource: 'qcc_api', raw: { private: 'never-copy' } })) }) });
    assert.equal(response.status, 202);
    const { id } = await response.json();
    let recognized;
    for (let attempt = 0; attempt < 200; attempt++) {
      recognized = await page.evaluate(async id => (await window.desktop.snapshot()).jobs.find(job => job.id === id), id);
      if (['complete','partial','failed'].includes(recognized?.status)) break;
      await page.waitForTimeout(25);
    }
    assert.equal(recognized.status, 'complete', JSON.stringify(recognized));
    await page.locator('#refresh').click();
    const job = page.locator(`article[data-job="${id}"]`);
    await job.locator('.review-next').waitFor({state:'visible'});
    assert.equal(await job.locator('.review-filter').inputValue(), 'recommended');
    assert.equal(await job.locator('.job-dashboard strong').allTextContents().then(x=>x.join(',')), '2,0,0,0');
    assert.equal(await job.locator('.job-results').getAttribute('open'), null);
    assert.equal(await job.locator('.platform-search-row').count(),4);
    assert.match(await job.locator('.platform-search-summary').textContent(),/网商园.*报告总数 97/);
    assert.match(await job.locator('.platform-search-summary').textContent(),/17 网.*搜索失败.*准确搜失败/);
    assert.match(await job.locator('.platform-search-summary').textContent(),/青创网.*未选择，未发起搜索/);
    await job.locator('.platform-search-summary').screenshot({path:path.join(root,'output/playwright/platform-coverage-desktop.png')});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(800,700));
    await job.locator('.platform-search-summary').scrollIntoViewIfNeeded();
    assert.equal(await job.locator('.platform-search-summary').evaluate(node=>node.scrollWidth<=node.clientWidth),true);
    await job.locator('.platform-search-summary').screenshot({path:path.join(root,'output/playwright/platform-coverage-800.png')});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1160,820));
    await job.locator('.review-next').click();
    await page.waitForSelector('#reviewDialog[open]');
    assert.match(await page.locator('.review-score').textContent(), /模型匹配分：90\/100/);
    assert.equal(await page.locator('#humanScore').isVisible(), false, '普通审核无需填写分数');
    await page.locator('#reviewNote').fill('袖型不同，本条模型误判');
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('#reviewNote').inputValue(), '袖型不同，本条模型误判');
    await page.locator('#reviewDialog').screenshot({path:path.join(root,'output/playwright/review-electron.png')});
    await page.locator('.exclude-candidate').click();
    await page.waitForSelector('#reviewDialog', {state:'hidden'});
    await page.waitForFunction(()=>document.getElementById('jobs').textContent.includes('人工已处理 1 条'));
    assert.equal((await page.evaluate(()=>window.desktop.snapshot())).browserCommands.some(c=>c.kind==='product-details'), false);
    await job.locator('.view-all-results').click();
    await job.locator('.job-results[open]').waitFor();
    assert.equal(await job.locator('.result-row').count(),2);
    assert.match(await job.locator('.result-row[data-index="1"] .result-tags').textContent(), /网商园.*相似搜/);
    await job.locator('.platform-filter').selectOption('zwd');
    await page.waitForFunction(()=>document.querySelectorAll('.result-row').length===0);
    await job.locator('.platform-filter').selectOption('wsy');
    await page.waitForFunction(()=>document.querySelectorAll('.result-row').length===2);
    await job.locator('.review-filter').selectOption('recommended');
    await page.waitForFunction(()=>document.querySelectorAll('.result-row').length===1);
    await job.locator('.review-item[data-index="1"]').click();
    await page.locator('.confirm-same').click();
    await page.waitForSelector('#reviewDialog',{state:'hidden'});
    let detailCommand;
    for(let i=0;i<100;i++){
      detailCommand=(await page.evaluate(()=>window.desktop.snapshot())).browserCommands.find(c=>c.kind==='product-details');
      if(detailCommand)break;
      await page.waitForTimeout(25);
    }
    assert.equal(detailCommand.itemIndex,1);
    assert.equal(detailCommand.status,'queued');
    await assert.rejects(page.evaluate(ids=>window.desktop.deleteJobs(ids),[id]),/详情正在等待浏览器采集/);
    const detailResponse=await fetch(`http://127.0.0.1:${initial.port}/v1/browser-commands/${detailCommand.id}/ack`,{
      method:'POST',headers:{'Content-Type':'application/json','X-Desktop-Token':initial.token},
      body:JSON.stringify({status:'accepted',result:{title:'供应商详情商品',price:20,sku:'WSY-002',shopName:'测试工厂店',description:'页面可见的商品资料',attributes:['成分：纯棉'],images:['https://imgcdn.wsy.com/detail-one.png','https://imgcdn.wsy.com/detail-two.png'],visibleText:'尺码和材质说明'}})
    });
    assert.equal(detailResponse.status,200);
    await page.locator('#refresh').click();
    await job.locator('.export-job').waitFor({state:'visible'});
    assert.match(await job.textContent(), /同款详情 · 供应商详情商品/);
    assert.equal(await job.locator('.product-detail-gallery img').count(),2);
    await job.locator('.review-mode').selectOption('direct');
    await page.waitForFunction(()=>document.getElementById('jobs').textContent.includes('模型建议仍为暂定结论'));
    assert.equal((await job.textContent()).includes('有效结论'),false);
    await page.reload();await page.locator('#navWork').click();
    await job.locator('.export-job').waitFor();
    await job.locator('.view-all-results').click();
    await job.locator('.job-results[open]').waitFor();
    await job.locator('.review-filter').selectOption('excluded');
    await page.waitForFunction(()=>document.querySelectorAll('.result-row').length===1);
    assert.match(await job.textContent(),/人工纠正：明显不同/);
    const saved=(await page.evaluate(()=>window.desktop.snapshot())).jobs.find(j=>j.id===id);
    assert.equal(saved.items[0].finalVerdict,'different');
    assert.equal(saved.items[0].visualComparison.score,90);
    assert.equal(saved.items[1].finalVerdict,'likely_same');
    assert.equal(saved.items[1].humanReview.score,undefined);
    assert.deepEqual(saved.items[1].platformTags,['新品','闪电发货']);
    assert.equal(saved.items[1].searchGroup,'similar');
    assert.equal(saved.items[1].raw,undefined);
    assert.equal(saved.reviewSummary.confirmed,1);
    assert.equal(saved.reviewSummary.excluded,1);
    assert.equal(await app.evaluate(()=>globalThis.testModelCalls),2);
    const disk=await fs.readFile(path.join(dataDir,'profiles',require('../desktop/accounts').profileId({id:'qa-A'}),'jobs/jobs.json'),'utf8');
    assert.equal(disk.includes('sk-electron-fixture'),false);
    assert.equal(disk.includes(image),false);
    await page.evaluate(()=>{const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{globalThis.exportText=blob.text();return create(blob);};HTMLAnchorElement.prototype.click=function(){};});
    await job.locator('.export-job').click();
    const exported=JSON.parse(await page.evaluate(()=>globalThis.exportText));
    assert.equal(exported.minimumScore,85);
    assert.deepEqual(exported.items.map(i=>[i.id,i.finalVerdict]),[['2','likely_same'],['1','different']]);
    assert.equal(exported.items[0].productDetails.title,'供应商详情商品');
    assert.equal(await app.evaluate(()=>globalThis.testModelCalls),2,'审核、筛选与导出不调用模型');
    await job.screenshot({path:path.join(root,'output/playwright/recognition-cockpit-complete.png')});
    const waitJob = async (jobId, predicate) => {
      for(let attempt=0;attempt<300;attempt++){
        const value=(await page.evaluate(()=>window.desktop.snapshot())).jobs.find(j=>j.id===jobId);
        if(value&&predicate(value))return value;
        await page.waitForTimeout(20);
      }
      assert.fail('识别批次未进入预期状态');
    };
    await app.evaluate(()=>{
      const previous=globalThis.fetch;
      globalThis.retryFixture=true;
      globalThis.fetch=async(url,options)=>{
        if(!String(url).startsWith('https://vision.example/'))return previous(url,options);
        const ids=JSON.parse(options.body).messages[1].content.filter(p=>p.type==='text'&&p.text.startsWith('候选编号：')).map(p=>p.text.slice(5));
        if(ids.some(id=>Number(id.split('_')[1])>4)&&globalThis.retryFixture)throw new Error('HTTP 504');
        return Response.json({choices:[{message:{content:JSON.stringify({results:ids.map((id)=>{
          const index=Number(id.split('_')[1]),score=index===1?95:index===2?85:index===3?84:index===4?null:80;
          return{id,verdict:index===4?'uncertain':index===1?'likely_same':'similar',score,matches:['领口一致','口袋位置一致'],differences:['颜色不同，结构一致'],uncertainties:index===4?['袖口遮挡']:[]};
        })})}}]});
      };
    });
    const response2=await fetch(`http://127.0.0.1:${initial.port}/v1/jobs`,{method:'POST',headers:{'Content-Type':'application/json','X-Desktop-Token':initial.token},body:JSON.stringify({query:image,queryName:'多平台识别与重试',items:Array.from({length:8},(_,i)=>({id:String(i+1),platform:['wsy','zwd','qcc','e3hui'][i%4],title:'不同色同款对照 '+(i+1),searchGroup:i===1?'accurate':i===2?'similar':'',price:20,imageUrl:`https://imgcdn.wsy.com/${i+1}.png`,detailUrl:`https://www.wsy.com/item.htm?id=${i+1}`}))})});
    assert.equal(response2.status,202);
    const id2=(await response2.json()).id;
    const partial=await waitJob(id2,j=>j.status==='partial'&&j.autoRetryCount===3);
    assert.equal(partial.retryCount,3,'首次识别失败后只自动重试3次');
    assert.equal(partial.reviewSummary.pending,3);
    assert.equal(partial.reviewSummary.excluded,1);
    assert.equal(partial.reviewSummary.unavailable,4);
    await page.locator('#refresh').click();
    const cockpit=page.locator(`article[data-job="${id2}"]`);
    await cockpit.locator('.review-next').waitFor();
    await cockpit.locator('.job-results summary').click();
    assert.equal(await cockpit.locator('.review-filter').inputValue(),'recommended');
    assert.equal(await cockpit.locator('.result-row').count(),3);
    assert.match(await cockpit.textContent(),/17 网/);
    assert.match(await cockpit.textContent(),/准确搜/);
    await cockpit.screenshot({path:path.join(root,'output/playwright/recognition-cockpit-pending.png')});
    await cockpit.locator('.platform-filter').selectOption('zwd');
    await page.waitForFunction(id=>document.querySelector(`article[data-job="${id}"] .filter-result-count`)?.textContent==='当前 1 条',id2);
    assert.equal(await cockpit.locator('.result-row[data-index="1"]').count(),1,'85分边界保留');
    await cockpit.locator('.platform-filter').selectOption('all');
    await cockpit.locator('.review-filter').selectOption('excluded');
    await cockpit.locator('.review-item[data-index="2"]').waitFor();
    await cockpit.locator('.review-item[data-index="2"]').click();
    await page.locator('.cannot-decide').click();
    await page.waitForSelector('#reviewDialog',{state:'hidden'});
    await cockpit.locator('.review-filter').selectOption('retry');
    await cockpit.locator('.retry-job').waitFor();
    await cockpit.locator('.retry-job').click();
    const twice=await waitJob(id2,j=>j.status==='partial'&&j.manualRetryRounds===1&&j.autoRetryCount===3);
    assert.equal(twice.retryCount,7,'手动启动1次后，另有3次自动重试');
    assert.equal(twice.items[2].humanReview.verdict,'uncertain','自动重试保留人工结论');
    await app.evaluate(()=>{globalThis.retryFixture=false;});
    await page.locator('#refresh').click();
    await cockpit.locator('.retry-job').click();
    await waitJob(id2,j=>j.status==='complete');
    await page.locator('#refresh').click();
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(800,700));
    await cockpit.scrollIntoViewIfNeeded();
    assert.equal(await cockpit.evaluate(node=>node.scrollWidth<=node.clientWidth),true);
    await cockpit.screenshot({path:path.join(root,'output/playwright/recognition-cockpit-800.png')});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1160,820));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(800, 620));
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(root, 'output/playwright/desktop-workspace-800.png') });
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1160, 820));
    await page.locator('#logout').click(); await page.waitForSelector('#loginScreen', { state: 'visible' });
    await assert.rejects(fetch(`http://127.0.0.1:${initial.port}/v1/jobs`, { headers: { 'X-Desktop-Token': initial.token } }));
    await login('qa-B');
    const other = await page.evaluate(() => window.desktop.snapshot());
    assert.equal(other.catalog.models.filter(model=>!model.managed).length, 0); assert.equal(other.jobs.length, 0); assert.notEqual(other.token, initial.token);
    const oldPair = await fetch(`http://127.0.0.1:${other.port}/v1/jobs`, { headers: { 'X-Desktop-Token': initial.token } }); assert.equal(oldPair.status, 401);
    await page.locator('#logout').click(); await page.waitForSelector('#loginScreen', { state: 'visible' }); await login('qa-A');
    const restored = await page.evaluate(() => window.desktop.snapshot());
    assert.equal(restored.token, initial.token, '同一 TDL 账号重新登录后长期配对码不变');
    assert.equal(restored.jobs.find(j=>j.id===id).items[0].humanReview.note, '袖型不同，本条模型误判'); assert.equal(restored.catalog.models.find(m=>m.name==='自定义视觉模型（已编辑）').name, '自定义视觉模型（已编辑）');
    assert.equal(JSON.stringify(restored).includes('sk-electron-fixture'), false);
    await page.locator('#navSettings').click();
    await page.locator('.model-card .delete-model').click(); await page.locator('#confirmDelete').click(); await page.waitForSelector('#deleteDialog', { state: 'hidden' });
    await page.waitForFunction(async () => (await window.desktop.snapshot()).catalog.models.filter(model=>!model.managed).length === 0);
    const noModel = await fetch(`http://127.0.0.1:${restored.port}/v1/jobs`, { method: 'POST', headers: { 'X-Desktop-Token': restored.token, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noModel.status, 400, '托管默认模型仍存在，但非法任务输入必须拒绝');
    const profile = path.join(dataDir, 'profiles', require('../desktop/accounts').profileId({ id: 'qa-A' }));
    const secrets = (await fs.readFile(path.join(profile, 'models.json'), 'utf8')) + (await fs.readFile(path.join(dataDir, 'session.json'), 'utf8'));
    assert.equal(secrets.includes('sk-electron-fixture'), false); assert.equal(secrets.includes('fixture-cloud-token'), false); assert.equal(secrets.includes('fixture-password'), false);
    assert.deepEqual(errors, []);
  } finally {
    await app?.close();
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
