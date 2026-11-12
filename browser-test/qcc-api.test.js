const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchPersistentContext } = require('./browser');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'platform-page.js'), 'utf8');

test('青创精确字段契约：接口优先不依赖模板、原图与标签、异常回退和拒绝伪空结果', { timeout: 30000 }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qcc-api-contract-'));
  const context = await launchPersistentContext(profile, { headless: true });
  try {
    await context.route('https://**/*', route => route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
    const page = await context.newPage();
    await page.goto('https://www.17qcc.com/imagesearch.html');
    await page.addScriptTag({ content: source });
    const results = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 800;
      const image = canvas.toDataURL('image/png');
      // Reconstructed from the official template and rendered card, not a raw
      // JSON capture. Unrelated response fields must never be copied.
      const product = { ProductId: 5365583, ProductName: '220g重磅t恤圆领短袖宽松打底衫纯棉经典基础款', ProductNo: '2100-3',
        DefaultPrice: 16, Photo: '/imgextra/product/202602/04/20215776577793.png', IsNew: true, IsLightning: true, Token: 'never-copy-this' };
      let response = { Success: true, Result: { Items: [product], Token: 'private-response' } }, calls = 0;
      window.cfgPage = { ImgSearchChannel: 7 };
      window.jQuery = { cookie: () => 'fixture-auth', ajax: options => { options.success({ Result: { FileFullPath: 'https://pics.17qcc.com/fixture-query.jpg' } }); return { abort() {} }; },
        qccAjax: (_endpoint, _params, callback) => { calls++; callback(response); } };
      const direct = await searchPlatformPage('qcc', image, 'direct');
      response.Result.Items = [
        { ...product, ProductId: 1, CloudStoreType: 3 }, { ...product, ProductId: 2, CloudStoreType: 2 },
        { ...product, ProductId: 3, IsCloudStore: 1 }, { ...product, ProductId: 4, IsFactory: true }
      ];
      const tags = await searchPlatformPage('qcc', image, 'tags');
      response.Result.Items = [];
      const empty = await searchPlatformPage('qcc', image, 'empty');
      response = { Success: true, Result: { RelatedProducts: [product] } };
      const unknown = await searchPlatformPage('qcc', image, 'unknown');
      document.body.innerHTML = '<script id="productlistTmpl" type="text/x-jsrender"></script>';
      window.jQuery.templates = () => ({ render: () => '<li><a href="/item/42.html"><img src="//pics.17qcc.com/fallback.jpg" alt="回退商品"></a><p class="money">25</p><p class="size">货号:F42</p><span class="tagIcon">闪电发货</span></li>' });
      const fallback = await searchPlatformPage('qcc', image, 'fallback');
      window.jQuery.templates = () => ({ render: () => '' });
      response = { Success: true, Result: { Items: [{ ...product, DefaultPrice: null }] } };
      const invalid = await searchPlatformPage('qcc', image, 'invalid');
      delete window.jQuery.templates;
      response.Result.Items = [{ ...product, Photo: 'https://private.example/image.jpg' }];
      const unsafePhoto = await searchPlatformPage('qcc', image, 'unsafe-photo');
      response.Result.Items = [{ ...product, ProductId: '../999' }];
      const unsafeId = await searchPlatformPage('qcc', image, 'unsafe-id');
      response.Result.Items = { Unexpected: 'shape' };
      const shape = await searchPlatformPage('qcc', image, 'shape');
      response = { Success: false, Result: { Items: [product] }, Error: { Code: -10001, Message: '额度用尽' } };
      const quota = await searchPlatformPage('qcc', image, 'quota');
      return { direct, tags, empty, unknown, fallback, invalid, unsafePhoto, unsafeId, shape, quota, calls };
    });
    assert.equal(results.direct.ok, true);
    assert.equal(results.direct.diagnostics.dataSource, 'qcc_api');
    assert.equal(results.direct.diagnostics.templateRenderer, false);
    const item = results.direct.items[0];
    assert.equal(item.id, '5365583'); assert.equal(item.price, 16); assert.equal(item.goodsId, '2100-3');
    assert.equal(item.imageUrl, 'https://pics.17qcc.com/imgextra/product/202602/04/20215776577793.png');
    assert.deepEqual(item.platformTags, ['新品', '闪电发货']);
    assert.equal(item.supplierId, ''); assert.equal(item.address, '');
    assert.doesNotMatch(JSON.stringify(results.direct), /never-copy-this|private-response|fixture-auth/);
    assert.deepEqual(results.tags.items.map(item => item.platformTags[1]), ['共享仓', '自营仓', '云仓闪发', '工厂直供']);
    assert.equal(results.empty.ok, true); assert.deepEqual(results.empty.items, []);
    assert.equal(results.unknown.ok, false, '不递归猜测其他商品数组');
    assert.equal(results.fallback.ok, true); assert.equal(results.fallback.diagnostics.dataSource, 'qcc_template');
    assert.equal(results.fallback.items[0].goodsId, 'F42'); assert.deepEqual(results.fallback.items[0].platformTags, ['闪电发货']);
    for (const key of ['invalid', 'unsafePhoto', 'unsafeId', 'shape']) {
      assert.equal(results[key].ok, false, key); assert.match(results[key].error, /platform_contract/);
    }
    assert.equal(results.quota.ok, false); assert.match(results.quota.error, /platform_quota/);
    assert.equal(results.calls, 10);
  } finally {
    await context.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('青创慢回调和原生回调丢失时读取同一次请求，超时和失败不重复搜图且清理监听', { timeout: 15000 }, async () => {
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'qcc-response-recovery-'));
  const context=await launchPersistentContext(profile,{headless:true});
  try{
    await context.route('https://**/*',route=>route.fulfill({contentType:'text/html',body:'<html><body></body></html>'}));
    const page=await context.newPage();await page.goto('https://www.17qcc.com/imagesearch.html');await page.addScriptTag({content:source});
    const results=await page.evaluate(async()=>{
      const canvas=document.createElement('canvas');canvas.width=640;canvas.height=800;const image=canvas.toDataURL('image/png');
      const nativeTimeout=window.setTimeout.bind(window),listeners=new Map();
      window.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,ms>=25000?ms/100:ms,...args);
      const events={on(name,fn){listeners.set(name,fn);return this;},off(namespace){for(const name of listeners.keys())if(name.endsWith(namespace))listeners.delete(name);return this;}};
      const response={Success:true,Result:{Items:[{ProductId:42,ProductName:'回收同次响应的外套',ProductNo:'Q42',DefaultPrice:145,Photo:'/fixture.jpg'}]}};
      window.cfgPage={ImgSearchChannel:7};let uploads=0,searches=0;
      const jquery=()=>events;jquery.cookie=()=> 'fixture-auth';jquery.ajax=options=>{uploads++;options.success({Result:{FileFullPath:'https://pics.17qcc.com/query.jpg'}});return{abort(){}};};window.jQuery=jquery;
      const emit=(request,settings)=>{for(const fn of [...listeners.values()])fn({},request,settings);};
      jquery.qccAjax=(_url,_params,callback)=>{searches++;nativeTimeout(()=>callback(response),350);};
      const slow=await searchPlatformPage('qcc',image,'slow-callback');
      jquery.qccAjax=(url,data)=>{searches++;nativeTimeout(()=>{
        emit({status:200,responseJSON:{...response,Result:{Items:[]}}},{url,data:{...data,ImgUrl:'/another-image.jpg'}});
        emit({status:200,responseJSON:response},{url,data:new URLSearchParams(data).toString()});
      },10);};
      const recovered=await searchPlatformPage('qcc',image,'lost-callback');
      jquery.qccAjax=(url,data)=>{searches++;nativeTimeout(()=>emit({status:200,responseText:JSON.stringify(response)},{url,data:JSON.stringify(data)}),10);};
      const jsonBody=await searchPlatformPage('qcc',image,'json-request');
      jquery.qccAjax=(url,data)=>{searches++;nativeTimeout(()=>emit({status:503,statusText:'Unavailable'},{url,data}),10);};
      const failed=await searchPlatformPage('qcc',image,'http-failure');
      jquery.qccAjax=()=>{searches++;};
      const timeout=await searchPlatformPage('qcc',image,'no-response');
      jquery.qccAjax=()=>{searches++;nativeTimeout(()=>window.__findPlatformJobs['cancelled-search']?.cancel(),10);};
      const cancelled=await searchPlatformPage('qcc',image,'cancelled-search');
      return{slow,recovered,jsonBody,failed,timeout,cancelled,uploads,searches,listeners:listeners.size,jobs:Object.keys(window.__findPlatformJobs).length};
    });
    assert.equal(results.slow.ok,true,'超过旧25秒窗口的原回调仍接收');
    assert.equal(results.slow.diagnostics.searchWaitMs,45000);
    assert.equal(results.recovered.ok,true);assert.equal(results.recovered.items[0].id,'42');
    assert.equal(results.recovered.diagnostics.searchCallbackSource,'same_request.ajaxComplete');
    assert.equal(results.jsonBody.ok,true);assert.equal(results.jsonBody.items[0].id,'42');
    assert.equal(results.failed.ok,false);assert.match(results.failed.error,/HTTP 503/);
    assert.equal(results.timeout.ok,false);assert.equal(results.timeout.diagnostics.retryable,false);assert.match(results.timeout.error,/45 秒/);
    assert.equal(results.cancelled.ok,false);assert.match(results.cancelled.error,/request_cancelled/);
    assert.equal(results.uploads,6);assert.equal(results.searches,6,'每次操作只上传一次、搜图一次，不重放不确定请求');
    assert.equal(results.listeners,0);assert.equal(results.jobs,0);
  }finally{await context.close();fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
