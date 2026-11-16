const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {launchPersistentContext}=require('./browser');
const root=path.resolve(__dirname,'..');
test('连接检查只读采集真实扩展页面；不读Cookie、不调用接口、不丢搜索结果；下载脱敏JSON', {timeout:30000}, async()=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'find-check-'));
  const context=await launchPersistentContext(profile,{
    headless:true,ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]
  });
  try {
    let unexpected=0;
    await context.route('https://**/*',route=>{
      if(route.request().method()!=='GET') unexpected++;
      return route.fulfill({contentType:'text/html',body:'<html><body>连接测试</body></html>'});
    });
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:10000});
    const platform=await context.newPage(); await platform.goto('https://stu.17zwd.com/SearchSimilar?session=secret-query');
    await platform.evaluate(()=>{
      Object.defineProperty(document,'cookie',{get(){throw new Error('cookie read denied');}});
      window.jQuery={ajax(){throw new Error('API must not be called');},cookie(){throw new Error('Cookie helper must not be called');}};
      const script=document.createElement('script');script.type='text/x-jsrender';script.id='fixture';script.textContent='{{:Price}} {{:Photo}}';document.body.append(script);
      const input=document.createElement('input');input.type='file';input.dataset.url='https://fabu.e3hui.com/upload?token=secret-upload';document.body.append(input);
      const m={'11':()=>{throw new Error('Site module must not be required');}};
      const cache={};
      window.webpackJsonp=[];
      window.webpackJsonp.push=entry=>{
        Object.assign(m,entry[1]); const require=id=>{cache[id]={}; return m[id]({}, {},require);}; require.m=m;require.c=cache;
        for(const execute of entry[2]) require(execute[0]);
      };
    });
    const login=await context.newPage();await login.goto('https://www.17qcc.com/imagesearch.html');
    await login.setContent('<html><body><form>请登录<input type="password" value="never-read-this"></form></body></html>');
    const permission=await context.newPage();await permission.goto('https://www.e3hui.cn/');
    await permission.setContent('<html><body><span class="icon-imgseek" data-forbidden="true">以图搜款</span></body></html>');
    const page=await context.newPage(); await page.goto(worker.url().replace('background.js','workbench.html'));
    await page.waitForFunction(()=>!document.getElementById('pick').disabled);
    assert.equal(await page.locator('#connectionDetails').isVisible(),true);
    assert.equal(await page.locator('.connection-row[data-code="not_checked"]').count(),5,'未检查时显示四个平台和淘宝连接');
    assert.equal(await page.locator('#connectionCheckedAt').isVisible(),false);
    assert.equal(await page.locator('#connectionOutput pre').count(),0);
    const statusBefore=await page.locator('#status').textContent();
    await page.locator('#checkConnection').click();
    assert.equal(await page.locator('#checkConnection').isDisabled(),true);
    assert.equal(await page.locator('#reset').isDisabled(),true,'检查期间不应重置或取消工作台状态');
    assert.equal(await page.locator('#connectionOutput').getAttribute('aria-busy'),'true');
    assert.equal(await page.locator('[data-connection-platform="wsy"]').isDisabled(),true,'检查期间不应切换平台');
    await page.waitForFunction(()=>document.getElementById('connectionStatus').textContent.includes('检查完成'));
    assert.equal(await page.locator('#reset').isDisabled(),false);
    const text=await page.locator('#connectionOutput').textContent();
    assert.equal(await page.locator('.connection-row').count(),5);
    assert.match(text,/网商园未打开/);assert.match(text,/17网页面已响应/);assert.match(text,/淘宝未打开/);
    assert.match(text,/青创网需要登录/);assert.match(text,/衣衫汇无搜图权限/);
    assert.equal(await page.locator('[data-connection-platform="qcc"]').textContent(),'前往登录');
    assert.equal(await page.locator('[data-connection-platform="e3hui"]').textContent(),'查看权限');
    assert.equal(await page.locator('[data-connection-platform="zwd"]').textContent(),'查看平台');
    assert.equal(await page.locator('#connectionOutput').getAttribute('aria-busy'),'false');
    assert.match(await page.locator('#connectionCheckedAt').textContent(),/检查于/);
    assert.equal(text.includes('"checkedAt"'),false);assert.equal(text.includes('never-read-this'),false);
    assert.match(await page.locator('#connectionStatus').textContent(),/1 个平台页面已响应，4 个需处理/);
    const downloadEvent=page.waitForEvent('download');await page.locator('#downloadConnection').click();const download=await downloadEvent;
    assert.equal(download.suggestedFilename(),'找商品-平台连接诊断.json');
    const output=JSON.parse(fs.readFileSync(await download.path(),'utf8'));assert.equal(output.mode,'workbench_diagnostic_snapshot');assert.equal(output.connectionCheck.mode,'read_only_existing_tabs');
    assert.equal(await page.locator('#connectionOutput').textContent(),text,'导出不应把简洁结果替换成JSON');
    assert.equal(JSON.stringify(output).includes('never-read-this'),false);
    const data=output.connectionCheck;
    const entry=data.pages.find(x=>x.platform==='zwd');
    assert.equal(entry.page,'https://stu.17zwd.com/SearchSimilar');
    assert.equal(entry.runtimes[0].captured,true); assert.equal(entry.runtimes[0].moduleCount,1);
    assert.deepEqual(entry.runtimes[0].moduleIds,['11']);
    assert.equal(entry.jquery.ajax,true); assert.equal(entry.uploadControls[0].uploadUrl,'https://fabu.e3hui.com/upload');
    assert.equal(entry.serviceWorker,'');
    assert.equal(entry.status,'inspected'); assert.equal(data.incomplete,true);
    assert.equal(await page.evaluate(async()=> (await chrome.tabs.query({active:true,currentWindow:true}))[0].url===location.href),true,'检查后回到工作台');
    assert.equal(text.includes('secret-'),false);
    assert.ok(data.pages.some(x=>x.platform==='qcc'&&x.access.state==='login_required'));
    assert.equal(await page.locator('#status').textContent(),statusBefore);
    assert.equal(context.pages().length,5,'检查不打开新平台或公司页');
    assert.equal(unexpected,0);
    // Existing platform actions reuse its page, keeping platform sessions intact.
    await page.locator('[data-connection-platform="qcc"]').click();
    assert.equal(context.pages().length,5);
    assert.equal(await page.evaluate(async()=> (await chrome.tabs.query({active:true,currentWindow:true}))[0].url.includes('17qcc.com')),true);
    await page.bringToFront();
    fs.mkdirSync(path.join(root,'output','qa'),{recursive:true});
    await page.setViewportSize({width:1440,height:900});
    await page.screenshot({path:path.join(root,'output','qa','connection-results-desktop.png')});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('#connectionDetails').evaluate(el=>el.scrollWidth>el.clientWidth),false);
    assert.equal(await page.locator('#connectionDetails').evaluate(el=>el.getBoundingClientRect().right <= innerWidth),true);
    await page.screenshot({path:path.join(root,'output','qa','connection-results-mobile.png')});
    const openedEvent=context.waitForEvent('page');
    await page.locator('[data-connection-platform="wsy"]').click();
    const opened=await openedEvent;await opened.waitForURL('https://www.wsy.com/new/search/image');
  }finally{await context.close();fs.rmSync(profile,{recursive:true,force:true});}
});
