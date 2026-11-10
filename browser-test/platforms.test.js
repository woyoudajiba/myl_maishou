const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { launchPersistentContext } = require('./browser');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'platform-page.js'), 'utf8');
// Synthetic responses model fields observed in public website JS, not recorded
// logged-in responses. Keep those two kinds of evidence distinct.
test('三平台原生接口回放：17双组去重、青创压图和上传、衣衫汇上传与结果、登录阻塞', { timeout: 45000 }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'find-platforms-'));
  const context = await launchPersistentContext(profile, { headless:true });
  try {
    await context.route('https://**/*', route => route.fulfill({ contentType:'text/html',body:'<html><body></body></html>' }));
    const page = await context.newPage();
    await page.goto('https://stu.17zwd.com/SearchSimilar'); await page.addScriptTag({content:source});
    const zr = await page.evaluate(async () => {
      const calls=[]; window.__CONFIG__={areaList:[{id:'42',prefix:'gz'}]};
      const raw={gid:123,zdid:42,item_price_pifa:35,item_pic_url:'https://example.org/123.jpg',item_no:'A123',sid:9,shop_name:'档口'};
      const api={post:async param => {calls.push(param); return {items:[raw],total:1,cacheKey:'cache'};}};
      // Webpack 4 executeModules entries are arrays; use a runtime dispatcher
      // rather than calling the injected factory regardless of its registration.
      window.webpackJsonp=[]; window.webpackJsonp.push=entry=> {
        const require=id=>id.startsWith('find-')?entry[1][id]({}, {}, require):({a:api});
        require.m={'./node_modules/@17zwd/fe-egg-framework/src/app/web/component/framework/apiCaller/index.tsx':true};
        for(const execute of entry[2] || []) require(execute[0]);
      };
      const result=await searchPlatformPage('zwd','data:image/jpeg;base64,AAAA','z1');
      const partialCalls=[]; const partialApi={post:async param=>{partialCalls.push(param.data.type);if(param.data.type==='similar')throw new Error('platform_http：500');return {items:[raw],total:1,cacheKey:'partial'};}};
      window.webpackJsonp.push=entry=>{const require=id=>id.startsWith('find-')?entry[1][id]({}, {}, require):({a:partialApi});require.m={'./node_modules/@17zwd/fe-egg-framework/src/app/web/component/framework/apiCaller/index.tsx':true};for(const execute of entry[2]||[])require(execute[0]);};
      const partial=await searchPlatformPage('zwd','data:image/jpeg;base64,AAAA','z-partial'); return {calls,result,partialCalls,partial};
    });
    assert.equal(zr.result.ok,true); assert.equal(zr.result.items.length,1);
    assert.equal(zr.result.items[0].detailUrl,'https://gz.17zwd.com/item/123');
    assert.deepEqual(zr.calls.map(x=>x.data.type),['accurate','similar']);
    assert.equal(zr.calls[0].data.img_base64,'AAAA');
    assert.equal(zr.result.diagnostics.inputEncoding,'raw_base64');
    assert.equal(zr.calls[1].data.cacheKey,'cache'); assert.equal(zr.calls[0].isGlobal,4);
    assert.equal(zr.partial.ok,true); assert.equal(zr.partial.partial,true); assert.equal(zr.partial.total,null);
    assert.equal(zr.partial.items.length,1); assert.deepEqual(zr.partialCalls,['accurate','similar']);
    assert.equal(zr.partial.diagnostics.searchGroups[1].phase,'failed');
    const missing = await page.evaluate(async () => {
      window.webpackJsonp.push=entry=>{
        const require=()=>({}); require.m={}; Object.values(entry[1])[0]({}, {}, require);
      };
      return searchPlatformPage('zwd','data:image/jpeg;base64,AAAA','z2');
    });
    assert.equal(missing.ok,false); assert.equal(missing.diagnostics.modulePresent,false);
    assert.match(missing.error,/未发送图片/); assert.equal(missing.items,undefined);
    await page.goto('https://www.17qcc.com/imagesearch.html'); await page.addScriptTag({content:source});
    const qr = await page.evaluate(async () => {
      document.body.innerHTML='<script id="productlistTmpl" type="text/x-template"></script>';
      const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=1600;
      window.cfgPage={ImgSearchChannel:7}; const calls=[];
      window.jQuery={cookie:()=> 'test-only',ajax:options=>{calls.push({url:options.url,keys:Array.from(options.data.keys())});
        createImageBitmap(new Blob([Uint8Array.from(atob(options.data.get('image').split(',')[1]),c=>c.charCodeAt(0))],{type:'image/jpeg'})).then(bitmap=>{calls[0].dimensions=[bitmap.width,bitmap.height];bitmap.close();options.success({Result:{FileFullPath:'https://pics.17qcc.com/test.jpg?size=1'}});}); return {abort(){}};},
        qccAjax:(endpoint,params,callback)=>{calls.push({endpoint,params}); callback({Success:true,Result:{}});},
        templates:()=>({render:()=>'<li><a href="//www.17qcc.com/item/123.html"><span class="pic"><img lazyload="//pics.17qcc.com/real.jpg" src="//g1.17qcc.com/2018/load.jpg" alt="官方商品标题"></span></a><div class="desc"><p class="brprice"><span><i>￥</i>35</span></p><p class="rowtitle"><a href="//www.17qcc.com/item/123.html">官方商品标题</a></p><p class="size">货号:A123</p></div></li>'})};
      return {result:await searchPlatformPage('qcc',canvas.toDataURL('image/jpeg'),'q1'),calls};
    });
    assert.equal(qr.result.ok,true); assert.deepEqual(qr.calls[0].dimensions,[768,1024]);
    assert.deepEqual(qr.calls[0].keys,['image','enc_auth_token']);
    assert.equal(qr.calls[1].params.ImgUrl,'/test.jpg'); assert.equal(qr.calls[1].params.ImgSearchChannel,7);
    assert.equal(qr.result.items[0].price,35); assert.match(qr.result.items[0].imageUrl,/real.jpg/);
    assert.equal(qr.result.diagnostics.searchCallbackSource,'native_callback');
    assert.deepEqual(qr.result.diagnostics.searchResponseKeys,['Result','Success']);
    assert.deepEqual(qr.result.diagnostics.resultKeys,[]);
    assert.equal(qr.result.diagnostics.renderedListItems,1); assert.equal(qr.result.diagnostics.productAnchors,2);
    assert.equal(qr.result.items[0].id,'123'); assert.equal(qr.result.items[0].goodsId,'A123');
    assert.equal(qr.result.items[0].title,'官方商品标题'); assert.equal(qr.result.items[0].detailUrl,'https://www.17qcc.com/item/123.html');
    const qempty = await page.evaluate(async () => {
      const input=document.createElement('canvas'); input.width=220; input.height=220;
      window.jQuery.qccAjax=(_endpoint,_params,callback)=>{callback({Success:true,Result:{Items:[],DisplayVip:false,SearchTimes:0}});};
      window.jQuery.templates=()=>({render:()=>''});
      return searchPlatformPage('qcc',input.toDataURL('image/jpeg'),'q-empty');
    });
    assert.equal(qempty.ok,true); assert.deepEqual(qempty.items,[]); assert.equal(qempty.diagnostics.emptyResult,true);
    const qshape = await page.evaluate(async () => {
      const input=document.createElement('canvas'); input.width=220; input.height=220;
      const templates=window.jQuery.templates;
      window.jQuery.qccAjax=(_endpoint,_params,callback)=>{callback({Success:true,Result:{}});};
      window.jQuery.templates=()=>({render:()=>'<li><span>商品但缺少详情链接</span></li>'});
      const result=await searchPlatformPage('qcc',input.toDataURL('image/jpeg'),'q-shape');
      window.jQuery.templates=templates;
      return result;
    });
    assert.equal(qshape.ok,false); assert.match(qshape.error,/商品条目/); assert.equal(qshape.diagnostics.renderedListItems,1);
    const qCase = await page.evaluate(async () => {
      const input=document.createElement('canvas'); input.width=220; input.height=220;
      const templates=window.jQuery.templates;
      window.jQuery.qccAjax=(_endpoint,_params,callback)=>{callback({Success:true,Result:{}});};
      window.jQuery.templates=()=>({render:()=>'<li><a href="/Product/Detail/456"><img lazyload="https://pics.17qcc.com/case.jpg"><div class="money">36</div></a></li>'});
      const result=await searchPlatformPage('qcc',input.toDataURL('image/jpeg'),'q-case');
      window.jQuery.templates=templates;
      return result;
    });
    assert.equal(qCase.ok,true); assert.equal(qCase.items[0].id,'456');
    const qj = await page.evaluate(async () => {
      const input=document.createElement('canvas'); input.width=1200; input.height=1600;
      window.jQuery.qccAjax = (_endpoint, _params) => ({ done(fn) { fn({Success:true,Result:{Items:[]}}); return this; }, fail() { return this; } });
      return searchPlatformPage('qcc',input.toDataURL('image/jpeg'),'q-jqxhr');
    });
    assert.equal(qj.ok,true); assert.equal(qj.diagnostics.searchCallbackSource,'jqXHR.done');
    const qdoneOnly = await page.evaluate(async () => {
      const input=document.createElement('canvas'); input.width=220; input.height=220;
      window.jQuery.qccAjax=()=>({done(fn){fn({Success:true,Result:{Items:[]}});return this;}});
      return searchPlatformPage('qcc',input.toDataURL('image/jpeg'),'q-done-only');
    });
    assert.equal(qdoneOnly.ok,true); assert.equal(qdoneOnly.diagnostics.searchCallbackSource,'jqXHR.done');
    const qpromise = await page.evaluate(async () => {
      const input=document.createElement('canvas'); input.width=220; input.height=220;
      window.jQuery.qccAjax=()=>Promise.resolve({Success:true,Result:{Items:[]}});
      return searchPlatformPage('qcc',input.toDataURL('image/jpeg'),'q-promise');
    });
    assert.equal(qpromise.ok,true); assert.equal(qpromise.diagnostics.searchCallbackSource,'Promise.then');
    const quota = await page.evaluate(async () => {
      const input=document.createElement('canvas'); input.width=220; input.height=220;
      window.jQuery.qccAjax=(_endpoint,_params,callback)=>{callback({Success:false,Result:null,Error:{Code:-10001,Message:'您本月的搜索已达上限'}});};
      return searchPlatformPage('qcc',input.toDataURL('image/jpeg'),'q-quota');
    });
    assert.equal(quota.ok,false); assert.equal(quota.diagnostics.stage,'image_search');
    assert.equal(quota.diagnostics.failureKind,'quota'); assert.equal(quota.diagnostics.retryable,false);
    assert.match(quota.error,/platform_quota/); assert.match(quota.error,/-10001/);
    const verification = await page.evaluate(async () => {
      const input=document.createElement('canvas'); input.width=220; input.height=220;
      window.jQuery.qccAjax=(_endpoint,_params,callback)=>{callback({Success:false,Result:null,Error:{Code:910001,Message:'请先完成账号认证'}});};
      return searchPlatformPage('qcc',input.toDataURL('image/jpeg'),'q-verification');
    });
    assert.equal(verification.ok,false); assert.equal(verification.diagnostics.stage,'image_search');
    assert.equal(verification.diagnostics.failureKind,'verification'); assert.equal(verification.diagnostics.retryable,false);
    assert.match(verification.error,/platform_verification/); assert.match(verification.error,/910001/);
    const contract = await page.evaluate(async () => {
      delete window.cfgPage;
      return searchPlatformPage('qcc','data:image/jpeg;base64,AAAA','q2');
    });
    assert.equal(contract.ok,false); assert.match(contract.error,/已识别登录/);
    assert.equal(contract.diagnostics.config,false); assert.equal(contract.diagnostics.template,true);
    const missingRenderer = await page.evaluate(async () => {
      window.cfgPage={ImgSearchChannel:7}; window.jQuery.templates=undefined;
      window.jQuery.qccAjax=(_endpoint,_params,callback)=>callback({Success:true,Result:{}});
      const canvas=document.createElement('canvas'); canvas.width=640; canvas.height=800;
      return searchPlatformPage('qcc',canvas.toDataURL('image/png'),'q3');
    });
    assert.equal(missingRenderer.ok,false); assert.equal(missingRenderer.diagnostics.templateRenderer,false);
    assert.match(missingRenderer.error,/模板渲染器 false/);
    await page.goto('https://www.e3hui.cn/'); await page.addScriptTag({content:source});
    const uploadedE3 = await page.evaluate(async () => {
      document.body.innerHTML='<input class="file-input" data-url="https://upload.example.org/fixture-upload">'; const calls=[];
      window.jQuery={ajax:options=>{const upload=options.data instanceof FormData?options.data.get('file'):null;calls.push({url:options.url,type:options.type,field:options.data instanceof FormData?Array.from(options.data.keys()):null,
          fileName:upload?.name,fileType:upload?.type,fileSize:upload?.size,contentType:options.contentType,processData:options.processData,dataType:options.dataType});
        options.success({path:'/test+path.jpg'});return {abort(){}};}};
      const canvas=document.createElement('canvas');canvas.width=220;canvas.height=240;
      return {result:await searchPlatformPage('e3hui_upload',canvas.toDataURL('image/jpeg'),'e1'),calls};
    });
    assert.equal(uploadedE3.result.ok,true);
    assert.equal(uploadedE3.result.searchPath,'/purchaser/img-search?url=%2Ftest%2Bpath.jpg');
    assert.equal(uploadedE3.calls[0].url,'https://upload.example.org/fixture-upload');
    assert.equal(uploadedE3.calls[0].type,'POST'); assert.equal(uploadedE3.calls[0].fileName,'product.jpg');
    assert.equal(uploadedE3.calls[0].fileType,'image/jpeg'); assert.ok(uploadedE3.calls[0].fileSize>0);
    assert.equal(uploadedE3.calls[0].contentType,false); assert.equal(uploadedE3.calls[0].processData,false); assert.equal(uploadedE3.calls[0].dataType,'json');
    assert.equal(uploadedE3.result.diagnostics.imageWidth,220); assert.equal(uploadedE3.result.diagnostics.imageHeight,240);
    assert.equal(uploadedE3.result.diagnostics.uploadOrigin,'https://upload.example.org');
    assert.equal(uploadedE3.result.diagnostics.uploadMode,'multipart_form_data'); assert.equal(uploadedE3.result.diagnostics.uploadField,'file');
    assert.equal(uploadedE3.result.diagnostics.uploadResponseHasPath,true);
    assert.deepEqual(uploadedE3.calls[0].field,['file']);
    const er = await page.evaluate(async () => {
      document.title='图片搜索结果';
      document.body.innerHTML='<div id="searchPage"><ul class="pro-list"><li class="pro-224"><a href="/product/abcdef.html"><img data-url="http://e3h.i.ximgs.net/4/124/20221129/20221129124600117.jpg"></a><div class="price-dist-wrap"><span class="price">￥35</span></div></li></ul></div>';
      return searchPlatformPage('e3hui_parse','','e1');
    });
    assert.equal(er.ok,true); assert.equal(er.items[0].price,35); assert.equal(er.items[0].platform,'e3hui');
    assert.equal(er.items[0].imageUrl,'https://e3h.i.ximgs.net/4/124/20221129/20221129124600117.jpg');
    const currentE3 = await page.evaluate(async () => {
      document.title='衣衫汇女装-以图找款';
      history.replaceState({},'', '/purchaser/search?params=fixture');
      document.body.innerHTML='<div>已为您搜到 2 件相似货源</div><div class="list-seat"><li class="pro-224"><div class="top-info"><div class="img-box"><a href="/product/cssakos.html?from=img-search.0"><img data-original="http://e3h.i.ximgs.net/9/2090329/20260729/20260729043345086.jpg" data-url="http://e3h.i.ximgs.net/9/2090329/20260729/20260729043345086_450.jpg"></a></div><div class="info-wrap-hover"><div class="name">雅鹿品牌运营中心&YGDB9877款羽绒服</div></div><div class="price">￥380</div></div></li><li class="pro-224"><div class="top-info"><div class="img-box"><a href="/product/cgciiss.html?from=img-search.0"><img data-url="https://e3h.i.ximgs.net/item.jpg"></a></div><div class="info-wrap-hover"><div class="name">简大尚&3125</div></div><div class="price">￥228</div></div></li></div>';
      return searchPlatformPage('e3hui_parse','','e-current-route');
    });
    assert.equal(currentE3.ok,true); assert.equal(currentE3.total,2); assert.equal(currentE3.received,2);
    assert.equal(currentE3.diagnostics.resultRoute,'purchaser_search_params'); assert.equal(currentE3.diagnostics.renderedProductCards,2);
    assert.equal(currentE3.items[0].id,'cssakos'); assert.equal(currentE3.items[0].price,380);
    assert.equal(currentE3.items[0].title,'雅鹿品牌运营中心&YGDB9877款羽绒服');
    assert.equal(currentE3.items[0].imageUrl,'https://e3h.i.ximgs.net/9/2090329/20260729/20260729043345086.jpg', '优先平台明确标记的原图地址');
    const alternateCdn = await page.evaluate(async () => {
      document.body.innerHTML='<div id="searchPage"><ul class="pro-list"><li class="pro-224"><a href="/product/aodo123.html"><img data-url="http://aodo.i.ximgs.net/0/2138418/20261018201133792"></a><div class="price-dist-wrap"><span class="price">￥35</span></div></li></ul></div>';
      return searchPlatformPage('e3hui_parse','','e-aodo');
    });
    assert.equal(alternateCdn.ok,true); assert.equal(alternateCdn.items[0].imageUrl,'https://aodo.i.ximgs.net/0/2138418/20261018201133792');
    const eShape = await page.evaluate(async () => {
      document.body.innerHTML='<div id="searchPage"><ul class="pro-list"><li class="pro-224"><span>商品但缺少标准详情链接</span></li></ul></div>';
      return searchPlatformPage('e3hui_parse','','e-shape');
    });
    assert.equal(eShape.ok,false); assert.match(eShape.error,/没有可读取的结果|platform_contract/); assert.equal(eShape.diagnostics.renderedProductCards,1);
    const delayedE3 = await page.evaluate(async () => {
      document.title='图片搜索结果'; document.body.innerHTML='<div id="searchPage"><ul class="pro-list"></ul><p>正在搜索</p></div>';
      setTimeout(()=>{document.querySelector('.pro-list').innerHTML='<li class="pro-224"><a href="/product/delayed.html"><img data-url="https://example.org/delayed.jpg"></a><div class="price-dist-wrap"><span class="price">￥36</span></div></li>';},150);
      return searchPlatformPage('e3hui_parse','','e-delayed');
    });
    assert.equal(delayedE3.ok,true); assert.equal(delayedE3.items.length,1);
    const tooSmall=await page.evaluate(async()=>{document.body.innerHTML='<input class="file-input" data-url="https://upload.example.org/fixture-upload">';const canvas=document.createElement('canvas');canvas.width=200;canvas.height=240;return searchPlatformPage('e3hui_upload',canvas.toDataURL('image/jpeg'),'e-small');});
    assert.equal(tooSmall.ok,false); assert.equal(tooSmall.diagnostics.stage,'image_validate');
    assert.match(tooSmall.error,/至少 201 像素/); assert.equal(tooSmall.diagnostics.httpStatus,undefined);
    const forbidden=await page.evaluate(async()=>{document.body.innerHTML='<input class="file-input" data-url="https://upload.example.org/fixture-upload" data-forbidden="true">';return searchPlatformPage('e3hui_upload','data:image/jpeg;base64,AAAA','e-forbidden');});
    assert.equal(forbidden.ok,false); assert.match(forbidden.error,/platform_permission/); assert.equal(forbidden.diagnostics.failureKind,'permission'); assert.equal(forbidden.diagnostics.uploadControlForbidden,true);
    const blocked=await page.evaluate(async()=>{document.body.innerHTML='<input class="file-input" data-url="">';return searchPlatformPage('e3hui_upload','data:image/jpeg;base64,AAAA','e2');});
    assert.equal(blocked.ok,false); assert.match(blocked.error,/platform_login_or_permission/); assert.equal(blocked.diagnostics.uploadControlPresent,true); assert.equal(blocked.diagnostics.uploadControlForbidden,false);
    await page.goto('https://sso.e3hui.cn/'); await page.addScriptTag({content:source});
    const sso = await page.evaluate(() => searchPlatformPage('e3hui_upload','data:image/jpeg;base64,AAAA','e-sso'));
    assert.equal(sso.ok,false); assert.match(sso.error,/platform_login/); assert.match(sso.error,/统一登录站点/);
  } finally {await context.close(); fs.rmSync(profile, { recursive:true, force:true });}
});
