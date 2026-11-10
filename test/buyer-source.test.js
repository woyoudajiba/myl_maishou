const test=require('node:test');
const assert=require('node:assert/strict');
const {buildBuyerSource,taobaoUrl}=require('../desktop/buyer-source');
test('买手资料分别保留供应商供货证据与淘宝套图，页面报价不冒充可信成本',()=>{
  const item={platform:'qcc',detailUrl:'https://www.17qcc.com/item/123.html',goodsId:'C123',price:39,productDetails:{title:'供应商衬衫',collectedAt:'2026-11-04T00:00:00.000Z',price:39,shopName:'测试供应商',images:['https://pics.17qcc.com/a.jpg','http://evil.example/a.jpg'],attributes:['颜色：灰色'],visibleText:'尺码 M L XL'}};
  const result=buildBuyerSource(item,{url:'https://item.taobao.com/item.htm?id=12345678&spm=tracking',title:'淘宝图',images:['https://img.alicdn.com/test.jpg'],salesText:'已售300+',confirmedSame:true});
  assert.equal(result.supplier.listedPrice,39);assert.equal(result.supplier.candidateListingPrice,39);assert.deepEqual(result.trustedFacts,{});assert.equal(result.marketing.url,'https://item.taobao.com/item.htm?id=12345678');assert.equal(result.marketing.salesText,'已售300+');
  assert.equal(result.supplier.images.length,1);assert.equal(result.marketing.matchState,'confirmed_same');assert.equal(result.erpSubmission,'not_submitted');assert.ok(result.missing.includes('供应商颜色尺码与套图交集'));
  assert.equal(buildBuyerSource(item).marketing,null);assert.throws(()=>buildBuyerSource({...item,productDetails:null}),/先采集/);assert.throws(()=>buildBuyerSource(item,{url:'https://example.com'}),/完整淘宝/);
  assert.equal(taobaoUrl('https://item.taobao.com.evil.example/item.htm?id=12345678'),'');
});
test('详情缺价时保留缺项并把候选页报价标记为另一来源',()=>{
  const item={platform:'qcc',detailUrl:'https://www.17qcc.com/item/123.html',price:39,productDetails:{title:'供应商衬衫',collectedAt:'2026-11-10T00:00:00.000Z',price:null,shopName:'测试供应商',images:['https://pics.17qcc.com/a.jpg'],quality:{state:'partial',missingFields:['price'],imageCoverage:{complete:false}}}};
  const result=buildBuyerSource(item);
  assert.equal(result.supplier.listedPrice,null);assert.equal(result.supplier.candidateListingPrice,39);assert.ok(result.missing.some(value=>value.includes('详情待补核')&&value.includes('price')));
});
