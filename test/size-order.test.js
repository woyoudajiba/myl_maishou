const test=require('node:test'),assert=require('node:assert/strict');
const {sortSizes,sizeKey}=require('../desktop/size-order');
const {mergeStructuredSupplierFacts,validateSupplierFacts,manualSupplierFacts,buildPayload}=require('../desktop/buyer-evidence');

test('国际码从XXS到大码排序，别名去重且不改动输入，未知规格保留原有顺序',()=>{
  const values=['XL','2XL','3XL','L','4XL','M','S','XS','2XS','XXS','XXL','XXXL','5XL','均码','170/88A','160/84A'];
  const original=[...values];
  assert.deepEqual(sortSizes(values),['2XS','XS','S','M','L','XL','2XL','3XL','4XL','5XL','均码','170/88A','160/84A']);
  assert.deepEqual(values,original);assert.equal(sizeKey('XXS（2XS）'),'XXS');assert.equal(sizeKey('2XS'),'XXS');
  assert.deepEqual(sortSizes(['4XL','XXS(2XS)','XS','L','M','XL','S','2XL','3XL']),['XXS(2XS)','XS','S','M','L','XL','2XL','3XL','4XL']);
});

test('页面/模型/人工尺码落库前排序，原始尺码证据保留，XXS范围可验证',()=>{
  const details={sku:'6803',shopName:'档口',sizes:['XL','2XL','3XL','L','4XL','M'],attributes:['尺码:XL 2XL 3XL L 4XL M'],images:['https://imgcdn.wsy.com/size.jpg']};
  const merged=mergeStructuredSupplierFacts({},details);
  assert.deepEqual(merged.sizes,['M','L','XL','2XL','3XL','4XL']);assert.equal(merged.evidence.sizes,'尺码:XL 2XL 3XL L 4XL M');
  assert.deepEqual(validateSupplierFacts(merged,details).sizes,merged.sizes);
  const manual=manualSupplierFacts({articleNo:'6803',supplierName:'档口',cost:65,colors:['黑色'],sizes:details.sizes,materials:[{name:'聚酯纤维',rate:100}],sizeImageIndex:0,fork:0},{},details);
  assert.deepEqual(manual.sizes,merged.sizes);
  const ranged=validateSupplierFacts({sizes:['4XL','XXS','XS','S','M','L','XL','2XL','3XL'],evidence:{sizes:'尺码2XS-4XL'}},{attributes:['尺码2XS-4XL']});
  assert.deepEqual(ranged.sizes,['XXS','XS','S','M','L','XL','2XL','3XL','4XL']);
});

test('互拓提交尺码分类和明细按同一顺序，XXS/2XS交集匹配真实字典名',()=>{
  const expected=['2XS','XS','S','M','L','XL','2XL','3XL','4XL'];
  const facts={articleNo:'6803',supplierName:'档口',colors:['黑色'],sizes:['XL','4XL','XXS','XS','M','S','L','3XL','2XL'],materials:[{name:'聚酯纤维',rate:100}],cost:65,sizePic:'https://imgcdn.wsy.com/size.jpg',fork:0};
  const mapping={productTypeName:'夹克',sizeType:'国际码'};
  const args={mapping,facts,source:{url:'https://www.wsy.com/item.htm?id=26716885',images:[]},marketplace:{url:'https://item.taobao.com/item.htm?id=12345678'},collection:{sizes:[...expected].reverse(),colors:[{name:'黑色'}],images:[]},catalog:{categories:[{categoryName:'夹克',categoryAb:'JK',status:1}],dictionaries:expected.map(label=>({dictType:'international_code',label,value:label})),permissions:{user:{nickname:'买手'}}},controls:[],settings:{supplyCycle:12},supplier:{supplierName:'档口',supplierAb:'SUP'},colors:[{colorName:'黑色',colorStatus:1,colorId:'BLACK'}]};
  const result=buildPayload(args);
  assert.deepEqual(result.payload.sizeCategory,expected);
  assert.deepEqual(result.payload.sizeList.map(row=>row.size),expected);
  assert.equal(result.missing.some(value=>/尺码/.test(value)),false);
  assert.doesNotMatch(result.payload.suitPicInfo[0].remark,/供应商不供尺码/);
  assert.deepEqual(facts.sizes,['XL','4XL','XXS','XS','M','S','L','3XL','2XL'],'构建提交内容不改动原始事实');
  const missingDictionary=buildPayload({...args,catalog:{...args.catalog,dictionaries:args.catalog.dictionaries.filter(row=>row.label!=='2XS')}});
  assert.ok(missingDictionary.missing.includes('尺码字典不匹配：XXS'),'无真实互拓字典项时保留缺项，不伪造字典');
});
