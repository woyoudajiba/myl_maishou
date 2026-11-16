const test=require('node:test'),assert=require('node:assert/strict');
const {buildSupplierCodeContext,parseProductCode,inferSupplierRegion}=require('../desktop/product-code');
const {erpProductImages,parseErpProductPage,rankProductCodeMatch,selectDuplicateProducts,duplicateReviewInstruction,validateDuplicateJudgments}=require('../desktop/buyer-duplicate');

test('拆解区域-类目-供应商缩写-货号编码，QZ对应泉州/石狮',()=>{
  assert.deepEqual(parseProductCode('GZ-休闲裤-1HYFS-K2028JR'),{raw:'GZ-休闲裤-1HYFS-K2028JR',regionCode:'GZ',region:'广州',category:'休闲裤',supplierAbbr:'1HYFS',articleNo:'K2028JR'});
  assert.deepEqual(parseProductCode('QZ-休闲裤-ABC-货号套装'),{raw:'QZ-休闲裤-ABC-货号套装',regionCode:'QZ',region:'泉州 / 石狮',category:'休闲裤',supplierAbbr:'ABC',articleNo:'货号套装'});
  assert.deepEqual(['CS','JX'].map(code=>parseProductCode(`${code}-休闲裤-SUP-2028`).region),['常熟','嘉兴']);
  assert.equal(parseProductCode('ZZ-休闲裤-SUP-2028'),null);assert.equal(inferSupplierRegion('江苏常熟发货').regionCode,'CS');
  assert.deepEqual(buildSupplierCodeContext({origin:{externalCode:'GZ-休闲裤-1HYFS-K2028JR'},facts:{articleNo:'K2028JR'},supplier:{supplierAb:'OTHER'}}),{productCode:'GZ-休闲裤-1HYFS-K2028JR',regionCode:'GZ',region:'广州',category:'休闲裤',supplierAbbr:'1HYFS',articleNo:'K2028JR'});
});

test('商品编码只排序候选相关性，不用地区或货号异同直接裁定款式',()=>{
  const source={regionCode:'GZ',category:'休闲裤',supplierAbbr:'1HYFS',articleNo:'K2028JR'};
  const candidates=[{id:1,productNo:'CS-休闲裤-2HYFS-X900',articleNo:'X900'},{id:2,productNo:'QZ-休闲裤-OTHER-A77',articleNo:'A77'},{id:3,productNo:'GZ-外套-1HYFS-K2028JR',articleNo:'K2028JR'},{id:4,productNo:'GZ-休闲裤-1HYFS-OTHER',articleNo:'OTHER'}];
  const selected=selectDuplicateProducts(candidates,source);
  assert.deepEqual(selected.map(x=>x.row.id),[3,4,1,2]);assert.equal(rankProductCodeMatch(candidates[0],source).categoryMatch,true);
  assert.equal(parseProductCode(candidates[0].productNo).region,'常熟','跨地区候选保留供图片比对');
  assert.match(duplicateReviewInstruction(),/图片是主要证据/);assert.match(duplicateReviewInstruction(),/地区或供应商不同、货号不同都不能单独判different/);
});

test('只提取ERP商品图片字段并校验模型返回的候选编号与结论',()=>{
  const allowed='https://imgcdn.wsy.com/main.jpg',row={id:1,mainPic:allowed,productData:JSON.stringify({publicPicInfo:{mainPic11:[allowed,'http://bad.example/x.jpg'],detailPic:['https://other.example/detail.jpg']},token:'private'})};
  assert.deepEqual(erpProductImages(row),[allowed]);
  const matches=validateDuplicateJudgments({matches:[{candidateId:'1',verdict:'same',visualEvidence:['门襟、口袋结构一致'],codeEvidence:['类目相同，货号不同仅作辅助'],uncertainties:[]}]},['1']);
  assert.equal(matches[0].verdict,'same');
  for(const value of [{matches:[]},{matches:[{candidateId:'2',verdict:'same'}]},{matches:[{candidateId:'1',verdict:'95'}]}])assert.throws(()=>validateDuplicateJudgments(value,['1']),/核对|编号/);
});

test('只接受明确的 ERP list/total 分页结构，异常时提供字段名而不暴露值',()=>{
  assert.deepEqual(parseErpProductPage({list:[],total:'0'}),{list:[],total:0});
  for(const value of [null,[],{rows:[],totalCount:4,secret:'do-not-print'},{list:[],total:null}])assert.throws(()=>parseErpProductPage(value),error=>/分页响应结构无效/.test(error.message)&&!/do-not-print/.test(error.message));
  assert.throws(()=>parseErpProductPage({rows:[],totalCount:4}),/rows,totalCount/);
});
