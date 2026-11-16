const test=require('node:test'),assert=require('node:assert/strict');
const {createBuyerProviders}=require('../desktop/buyer-providers');
const {supplierRows}=require('../desktop/buyer-mapping');
const dictionaries=[['warehouse_infos','常熟仓','CS'],['pallet_infos','休闲','leisure'],['industry','男装','mens'],['season','秋季','autumn'],['technology_infos','普通','normal'],['product_style','休闲','casual'],['ages','成年','adult'],['international_code','M','M'],['material_composition','棉','cotton'],['suit_pic_source','淘宝链接','taobao']].map(([dictType,label,value])=>({dictType,label,value}));
const directory=supplierRows({'动感地带旗舰店':{supplier_ab:'DGDDQJD',store_house:'CS'},'国际服装城1X16':{supplier_ab:'OTHER',store_house:'CS'}});
async function fixture(t,{enabled=true,repair=true,badSupplier=false,explanation=false}={}){
 const task={id:'mapping-fixture',automation:{facts:{supplierName:'国际服装城11020',articleNo:'D2603',cost:42,colors:['黑色'],sizes:['M'],materials:[{name:'棉',rate:100}],fork:0,sizePic:'https://imgcdn.wsy.com/size.jpg'},supplierDetails:{shopName:'国际服装城11020',title:'动感地带毛衣',visibleText:'国际服装城11020 动感地带旗舰店 9年店',images:[]},source:{images:['https://img.alicdn.com/main.jpg'],url:'https://www.wsy.com/item.htm?id=12345'},marketplace:{url:'https://item.taobao.com/item.htm?id=12345678'},collection:{images:['https://img.alicdn.com/main.jpg'],colors:[{name:'黑色'}],sizes:['M']}}};
 const workflow={image:async()=>Buffer.alloc(100),patchAutomation:async(_,patch)=>{Object.assign(task.automation,patch);}};
 const modelCalls=[];t.mock.method(globalThis,'fetch',async(_url,options)=>{
  const body=JSON.parse(options.body),instruction=body.messages[0].content,data=JSON.parse(body.messages[1].content[0].text);modelCalls.push({instruction,data});let result;
  if(data.supplierCandidates)result={productTypeName:'针织衫',supplierCandidateId:data.supplierCandidates.find(x=>x.supplierName===(badSupplier?'国际服装城1X16':'动感地带旗舰店')).candidateId,supplierEvidence:badSupplier?'国际服装城11020':explanation?'商品页店铺名称原文为“动感地带旗舰店”，页面同时显示档口“国际服装城11020”、发货地“江苏苏州”，与候选供应商“动感地带旗舰店”（DGDDQJD，CS）对应。':'国际服装城11020 动感地带旗舰店'};
  else result={productTypeName:'针织衫',storeHouse:'CS',pallet:'休闲',industry:'男装',season:'秋季',technology:'普通',style:'休闲',ageState:['成年'],sizeType:'国际码',extendedAttributes:{领型:repair&&!data.invalidFields?'':'翻领',功能:'保暖'}};
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]});
 });
 const client={suppliers:async name=>name==='动感地带旗舰店'?(enabled?[{supplierName:name,supplierAb:'DGDDQJD'}]:[]):name==='国际服装城'?[{supplierName:'国际服装城1X16',supplierAb:'OTHER'}]:[],controls:async()=>[{category:{针织衫:{基础:['领型','功能']}},control:{领型:{type:'select',required:1,option:['翻领']},功能:{type:'multi_select',required:1,option:['保暖']}}},{control:{}}],colors:async()=>[{colorName:'黑色',colorStatus:1,colorId:'BLACK'}]};
 const settings={value:{supplyCycle:12},erp:async()=>client,supplierDirectory:async()=>directory,catalogs:async()=>({dictionaries,categories:[{categoryName:'针织衫',categoryAb:'ZZS',status:1}],permissions:{user:{nickname:'买手'}}})};
 const providers=createBuyerProviders({workflow,settings,bridge:{},model:()=>({model:'fixture',endpoint:'https://mapping.fixture/v1',apiKey:'fixture'})});
 return{providers,task,modelCalls};
}
test('档口位置自动对应真实店名，全部字段一次填写并自动补齐校验缺项',async t=>{
 const f=await fixture(t),result=await f.providers.map(f.task);
 assert.deepEqual(result.missing,[]);assert.equal(result.payload.supplierName,'动感地带旗舰店');assert.equal(result.payload.supplierAb,'DGDDQJD');assert.equal(result.payload.storeHouse,'CS');assert.equal(result.payload.talkCost,42);assert.equal(result.payload.extendedAttributes.领型,'翻领');assert.deepEqual(result.payload.extendedAttributes.功能,['保暖']);assert.equal(f.modelCalls.length,3);assert.ok(f.modelCalls[1].data.dictionaries.length===dictionaries.length);assert.deepEqual(f.modelCalls[2].data.invalidFields,['类别必填：领型']);assert.equal(f.task.automation.supplierMapping.method,'model_alias');assert.equal(f.task.automation.mappingCandidates.catalogCount,2);
});
test('资料及动态字段齐全时只有类目供应商选择和统一填写两次模型调用',async t=>{
 const f=await fixture(t,{repair:false}),result=await f.providers.map(f.task);assert.deepEqual(result.missing,[]);assert.equal(f.modelCalls.length,2);
});
test('供应商解释句通过真实商家名称验证后继续填写，不再变成待人工异常',async t=>{
 const f=await fixture(t,{repair:false,explanation:true}),result=await f.providers.map(f.task);
 assert.deepEqual(result.missing,[]);assert.equal(result.payload.supplierName,'动感地带旗舰店');assert.equal(f.task.automation.supplierMapping.method,'page_name');assert.equal(f.task.automation.supplierMapping.evidence,'动感地带旗舰店');assert.match(f.task.automation.supplierMapping.modelReason,/商品页店铺名称原文为/);assert.equal(f.modelCalls.length,2);
});
test('模型选中未启用供应商或同服装城错误档口时，保存候选且不继续填造资料',async t=>{
 await t.test('未审核启用',async t=>{const f=await fixture(t,{enabled:false}),result=await f.providers.map(f.task);assert.match(result.missing[0],/未在已审核启用/);assert.equal(result.payload,null);assert.equal(f.modelCalls.length,1);assert.equal(f.task.automation.mappingCandidates.candidates.length,2);});
 await t.test('错误供应商',async t=>{const f=await fixture(t,{badSupplier:true}),result=await f.providers.map(f.task);assert.match(result.missing[0],/没有可核实/);assert.equal(result.payload,null);assert.equal(f.modelCalls.length,1);});
});
