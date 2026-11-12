const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {scrapeBuyerPage}=require('../buyer-page');
test('来源页采集六个平台主图和供货文字，推荐区不混入；登录和站外跳转明确阻塞',{timeout:25000},async t=>{
  const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  const targets={taobao:'https://item.taobao.com/item.htm?id=12345678',douyin:'https://haohuo.jinritemai.com/views/product/item2?id=12345678',wsy:'https://www.wsy.com/item.htm?id=12345678',zwd:'https://stu.17zwd.com/product/123.html',qcc:'https://www.17qcc.com/goods/123.html',e3hui:'https://www.e3hui.cn/product/123.html'};
  await page.route('https://**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>纯棉衬衫</h1><main><p>货号ABC123 供货价39元 颜色黑色 尺码M L 成分100%棉</p><script type="application/ld+json">{"@type":"Product","name":"纯棉衬衫","sku":"ABC123","image":["https://pics.17qcc.com/main.jpg"],"offers":{"price":"39","seller":{"name":"测试档口"}}}</script></main><div class="recommend"><img data-original="https://pics.17qcc.com/unrelated.jpg"><p>推荐商品</p></div>'}));
  for(const [platform,url] of Object.entries(targets)){await page.goto(url);const result=await page.evaluate(scrapeBuyerPage,{platform});assert.equal(result.title,'纯棉衬衫');assert.equal(result.sku,'ABC123');assert.deepEqual(result.images,['https://pics.17qcc.com/main.jpg']);assert.match(result.visibleText,/供货价39元/);}
  await page.setContent('<h1>请登录</h1><input type="password">');assert.match((await page.evaluate(scrapeBuyerPage,{platform:'e3hui'})).error,/需要登录/);
  await page.goto(targets.qcc);assert.match((await page.evaluate(scrapeBuyerPage,{platform:'wsy'})).error,/跳转/);
});

test('抖音分享页主图是CSS背景且document.title为空时，读取轮播主图与商品标题，排除评论和店铺图',{timeout:15000},async t=>{
  const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  await page.route('https://**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<title></title><div class="title-info"><span class="title-info__text">法国Time Leap冬季羽绒服男士外套</span></div><div class="head-figure"><div class="head-figure__media-view__content" style="width:480px;height:480px;background-image:url('https://p3-item.ecombdimg.com/img/ecom-shop-material/main~tplv-5mmsx3fupr-resize_q:1080:1080:q90.webp')"></div><div class="head-figure__media-view__content" style="width:480px;height:480px;background-image:url('https://p26-item.ecombdimg.com/img/ecom-shop-material/back.webp')"></div></div><div class="shop-component__shop-content__basic-info__title-area__name">Time Leap旗舰店</div><div class="comment-info" style="width:480px;height:480px;background-image:url('https://p3-ecom-commentpic-sign.byteimg.com/review.webp')"></div><div class="shop-component" style="width:480px;height:480px;background-image:url('https://p3-item.ecombdimg.com/shop-logo.png')"></div>`}));
  await page.goto('https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=3786790923309023608');
  const result=await page.evaluate(scrapeBuyerPage,{platform:'douyin'});
  assert.equal(result.title,'法国Time Leap冬季羽绒服男士外套');assert.equal(result.shopName,'Time Leap旗舰店');
  assert.deepEqual(result.images,['https://p3-item.ecombdimg.com/img/ecom-shop-material/main~tplv-5mmsx3fupr-resize_q:1080:1080:q90.webp','https://p26-item.ecombdimg.com/img/ecom-shop-material/back.webp']);
  await page.setContent('<div class="title-info__text">页面商品</div><div class="head-figure__media-view__content" style="width:480px;height:480px;background-image:url(https://outside.example/evil.webp)"></div>');
  assert.deepEqual((await page.evaluate(scrapeBuyerPage,{platform:'douyin'})).images,[]);
});

test('四个供应商页面按商品区域读取货号、供货信息、颜色尺码和详情图源',{timeout:25000},async t=>{
  const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  const fixtures={
    wsy:`<div class="shop-info"><div class="name">四季星座505</div></div><div class="item-mb"><a>速干拼接长裤</a><div class="item-sale">货号：KY910</div></div><div class="J_Prop" id="J_TSaleProp"><a>米白色</a><a>黑色</a></div><table class="table-sku"><tr><td>M</td><td class="sku">sku：502839106</td><td class="price">39.00元</td></tr></table><span class="J_p_price">39.00</span><div class="wsy-gallery"><a class="J_pic_open" href="https://imgcdn.wsy.com/v/main.jpg">图</a></div><div id="J_DivItemDesc"><img src="https://imgcdn.wsy.com/v/detail.jpg"></div><div class="tjgoods"><img src="https://imgcdn.wsy.com/v/recommend.jpg"></div>`,
    zwd:`<div class="index-titleBox-hash">阔腿牛仔裤</div><div class="index-itemNoPanel-hash"><span>885</span></div><div class="index-shopName-hash"><h2><a>女神汇网络服饰</a></h2></div><div class="index-pifaPriceWrapper-hash"><b>30.00</b></div><div class="index-goodsParamsWrapper-hash"><div>颜色分类：浅蓝色 米白色</div><div>尺寸：S M L</div><div>货号：885</div></div><div><span class="index-detailSizeSelectorLabel-hash">S</span><span class="index-detailSizeSelectorLabel-hash">M</span><span class="index-detailSizeSelectorLabel-hash">L</span></div><a href="/SearchSimilar?img_url=https%3A%2F%2Fimg01-gms.17zwd.com%2Fmain.jpg">找同款</a><div class="index-detailWrapper-hash"><img src="https://img01-gms.17zwd.com/detail.jpg"></div>`,
    qcc:`<p class="toptitle">棉服套装</p><div class="shop-info"><a class="link">异频道潮牌</a></div><div class="price_detail"><dd><p class="pri_de_price">163.00</p><p class="pri_de_num">1-4件</p></dd><dd><p class="pri_de_price">158.00</p><p class="pri_de_num">5件</p></dd></div><ul class="pro_att"><li>产品货号：YPD6711AB加棉套装</li><li>颜色分类：象牙白,藏青色</li></ul><div class="J_clr"><a title="象牙白">白色</a><a title="藏青色">藏青</a></div><div class="pro_size_item"><span class="size_name">M</span><span class="size_name">L</span></div><div class="picsize"><a data-big="https://pics.17qcc.com/main.jpg"></a></div><div class="pro_detail"><img lazyload="https://pics.17qcc.com/detail.jpg"></div>`,
    e3hui:`<h1 class="product-title">秋冬加绒短外套</h1><div class="art-num"><span class="art-num-text">素町&amp;SD8021</span></div><div class="supplier-name"><a>素町</a></div><div class="product-price-info"><p class="price"><strong>￥<i>180</i></strong><span class="min-limit-price"><span class="p">368</span></span></p></div><ul class="sku-wrap"><li class="sku-warp-li" data-color="米灰"><span>米灰</span><span class="num">x0</span></li><li class="sku-warp-li" data-color="丈青"><span>丈青</span></li></ul><div class="all-size">S,M,L,XL</div><div class="details-attribute-list"><li class="details-attribute-item">领子：翻领</li></div><div class="small-img-item"><a href="http://e3h.i.ximgs.net/gallery.jpg"></a></div><div class="product-details-content"><img src="/images/loading.png" data-url="http://e3h.i.ximgs.net/detail.jpg"></div><img src="https://www.e3hui.cn/images/app-seller-qrcode.png">`
  };
  await page.route('https://**/*',route=>{const platform=new URL(route.request().url()).hostname.includes('wsy.com')?'wsy':new URL(route.request().url()).hostname.includes('17zwd.com')?'zwd':new URL(route.request().url()).hostname.includes('17qcc.com')?'qcc':'e3hui';return route.fulfill({contentType:'text/html; charset=utf-8',body:fixtures[platform]});});
  const cases=[
    {platform:'wsy',url:'https://www.wsy.com/item.htm?id=26088182',articleNo:'KY910',shopName:'四季星座505',price:39,colors:['米白色','黑色'],sizes:['M'],tierCount:0,details:1},
    {platform:'zwd',url:'https://gz.17zwd.com/item/125246401',articleNo:'885',shopName:'女神汇网络服饰',price:30,colors:['浅蓝色','米白色'],sizes:['S','M','L'],tierCount:0,details:1},
    {platform:'qcc',url:'https://www.17qcc.com/item/5911776.html',articleNo:'YPD6711AB加棉套装',shopName:'异频道潮牌',price:163,priceType:'tiered',colors:['象牙白','藏青色'],sizes:['M','L'],tierCount:2,details:1},
    {platform:'e3hui',url:'https://www.e3hui.cn/product/egmogcs.html',articleNo:'SD8021',shopName:'素町',price:180,colors:['米灰','丈青'],sizes:['S','M','L','XL'],tierCount:0,resaleFloor:368,details:1}
  ];
  for(const sample of cases){
    await page.goto(sample.url);const result=await page.evaluate(scrapeBuyerPage,{platform:sample.platform,pageRole:'supplier'});
    assert.equal(result.sku,sample.articleNo,sample.platform);assert.equal(result.shopName,sample.shopName,sample.platform);assert.equal(result.price,sample.price,sample.platform);if(sample.priceType)assert.equal(result.priceType,sample.priceType,sample.platform);
    assert.deepEqual(result.colors,sample.colors,sample.platform);assert.deepEqual(result.sizes,sample.sizes,sample.platform);assert.equal(result.priceTiers.length,sample.tierCount,sample.platform);
    assert.equal(result.imageGroups.details.length,sample.details,sample.platform);assert.equal(result.quality.state,'complete',sample.platform);
    if(sample.resaleFloor)assert.equal(result.resaleFloor,sample.resaleFloor);
    assert.ok(result.visibleText.length>0);
  }
});

test('淘宝无JSON-LD与og:image时从商品轮播读取高清主图，排除缩略图、店铺图和推荐图',{timeout:15000},async t=>{
  const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  const main='https://gw.alicdn.com/imgextra/O1CN01TucanoMain.jpg';
  await page.route('https://item.taobao.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<title>啄木鸟羽绒马甲男外穿</title><div id="ice-container"><div class="PicGallery-main"><img width="600" height="600" data-zoom-image="${main}" src="https://gw.alicdn.com/imgextra/O1CN01TucanoMain.jpg_80x80.jpg"></div><div class="PicGallery-thumbs"><img width="60" height="60" src="https://gw.alicdn.com/imgextra/O1CN01TucanoThumb.jpg_60x60.jpg"></div></div><div class="shop-logo"><img width="300" height="300" src="https://img.alicdn.com/tfs/TB1SellerLogo.jpg"></div><div class="recommend"><img width="600" height="600" src="https://gw.alicdn.com/imgextra/O1CN01recommend.jpg"></div>`}));
  await page.goto('https://item.taobao.com/item.htm?id=656532430996');
  const result=await page.evaluate(scrapeBuyerPage,{platform:'taobao'});
  assert.equal(result.title,'啄木鸟羽绒马甲男外穿');assert.deepEqual(result.images,[main]);assert.equal(result.quality.state,'complete');assert.equal(result.quality.missingFields.length,0);
});
