const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeDraftListItem,normalizeDraftDetail,safeImage}=require('../desktop/buyer-draft-view');
const {createBuyerProviders}=require('../desktop/buyer-providers');

test('草稿分页拒绝异常空响应，不将查询失败显示成没有草稿',async()=>{
  const {ErpClient}=await import('../desktop/erp/client.mjs');
  let payload=null;const client=new ErpClient({erpManaged:true,erpBaseUrl:'https://wsfile.cn/maishou/api',erpToken:'fixture'},{fetchImpl:async()=>Response.json({code:0,data:payload})});
  await assert.rejects(()=>client.listDrafts(),/未取得草稿查询结论/);
  payload={list:null,total:null};await assert.rejects(()=>client.listDrafts(),/未取得草稿查询结论/);
  payload={list:[],total:0};assert.deepEqual(await client.listDrafts(),{list:[],total:0});
});

test('草稿列表只暴露允许的 HTTPS 图片，未知状态不作为可转换草稿',()=>{
  const item=normalizeDraftListItem({id:123,draftVersion:4,status:'REVIEWING',productName:'测试衣服',mainPic:'http://img.alicdn.com/a.jpg',token:'must-not-leak'});
  assert.equal(item.id,'123');
  assert.equal(item.draftState,'UNKNOWN');
  assert.equal(item.mainImage,'');
  assert.equal(Object.hasOwn(item,'token'),false);
  assert.equal(normalizeDraftListItem({id:'124',draftState:'DRAFT',publicPicInfo:{mainPic11:['https://img.alicdn.com/cover.jpg']}}).mainImage,'https://img.alicdn.com/cover.jpg');
  assert.equal(normalizeDraftListItem({id:'abc'}),null);
  assert.equal(safeImage('https://img.alicdn.com/a.jpg'),'https://img.alicdn.com/a.jpg');
  assert.equal(safeImage('https://evil.example/a.jpg'),'');
  assert.equal(safeImage('javascript:alert(1)'),'');
});

test('草稿详情读取套图、公版图片、分页图片响应、属性和尺码表',()=>{
  const item=normalizeDraftDetail({
    draft:{id:'123',draftVersion:2,draftState:'DRAFT',productName:'羽绒马甲',articleNo:'2086',material:['聚酯纤维'],materialRate:['100'],suitPicInfo:[{mainPic:'https://img.alicdn.com/main.jpg',suitPic:'https://img.alicdn.com/suit.jpg'}],publicPicInfo:{mainPic11:['https://img.alicdn.com/cover.jpg'],detailPic:['https://img.alicdn.com/detail.jpg']},secret:'must-not-leak'},
    attributes:{extendedAttributes:{面料:'聚酯纤维'},colorPic:['https://img.alicdn.com/color.jpg'],colorRemark:['深灰色'],sizeList:[{size:'M',height:'160',weight:'100'}]},
    pictures:{data:{list:[{mainPic11:['https://img.alicdn.com/extra.jpg'],detailPic:['https://img.alicdn.com/extra-detail.jpg']}]}}
  });
  assert.equal(item.draftState,'DRAFT');
  assert.deepEqual(item.images,['https://img.alicdn.com/main.jpg','https://img.alicdn.com/suit.jpg','https://img.alicdn.com/cover.jpg','https://img.alicdn.com/detail.jpg','https://img.alicdn.com/color.jpg','https://img.alicdn.com/extra.jpg','https://img.alicdn.com/extra-detail.jpg']);
  assert.deepEqual(item.colorRemarks,['深灰色']);
  assert.deepEqual(item.extendedAttributes,{面料:'聚酯纤维'});
  assert.deepEqual(item.sizeList,[{size:'M',height:'160',weight:'100',remark:''}]);
  assert.deepEqual(item.materials,[{name:'聚酯纤维',rate:'100'}]);
  assert.equal(Object.hasOwn(item,'secret'),false);
});

test('未明确返回 DRAFT 状态时禁止转换；转换后可按原草稿回读',async()=>{
  let convertCalls=0;
  const draft={id:'123',draftVersion:2};
  const client={
    getDraft:async()=>draft,
    convertDraft:async()=>{convertCalls++;return'456';},
    productDetail:async()=>({productNo:'GZ-CS-TEST-2086',productState:0})
  };
  const providers=createBuyerProviders({workflow:{},bridge:{},settings:{value:{},erp:async()=>client},model:()=>null,signal:new AbortController().signal});
  await assert.rejects(()=>providers.convertDraftEntry('123'),/状态不是可转换的 DRAFT/);
  assert.equal(convertCalls,0);
  draft.draftState='DRAFT';
  await assert.rejects(()=>providers.convertDraftEntry('123',1),/版本已变化/);
  assert.equal(convertCalls,0);
  const result=await providers.convertDraftEntry('123',2);
  assert.equal(result.productId,'456');
  assert.equal(result.productNo,'GZ-CS-TEST-2086');
  assert.equal(convertCalls,1);
});

test('草稿删除只允许明确的 DRAFT，并先回读确认状态',async()=>{
  let deletes=0;
  const draft={id:'321',draftState:'DRAFT'};
  const client={getDraft:async()=>draft,deleteDraft:async id=>{deletes++;assert.equal(String(id),'321');return {code:0,data:true};}};
  const providers=createBuyerProviders({workflow:{},bridge:{},settings:{value:{},erp:async()=>client},model:()=>null,signal:new AbortController().signal});
  assert.deepEqual(await providers.deleteDraftEntry('321'),{draftId:'321',deleted:true});
  assert.equal(deletes,1);
  draft.draftState='CONVERTED';
  await assert.rejects(()=>providers.deleteDraftEntry('321'),/只有 DRAFT 草稿可以删除/);
  assert.equal(deletes,1);
});

test('正式 ERP 未部署草稿删除接口时明确提示且不伪造已删除',async()=>{
  const {ErpClient}=await import('../desktop/erp/client.mjs');
  const client=new ErpClient({erpManaged:true,erpBaseUrl:'https://wsfile.cn/maishou/api',erpToken:'fixture'},{fetchImpl:async()=>Response.json({code:404,msg:'not found'},{status:404})});
  await assert.rejects(()=>client.deleteDraft('321'),/未提供草稿删除接口/);
});
