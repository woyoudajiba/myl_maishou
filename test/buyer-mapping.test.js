const test=require('node:test'),assert=require('node:assert/strict');
const {supplierRows,rankSuppliers,resolveSupplier,normalizeMapping,mappingControls}=require('../desktop/buyer-mapping');
const {buildPayload}=require('../desktop/buyer-evidence');
const task={automation:{facts:{supplierName:'国际服装城11020'},supplierDetails:{shopName:'国际服装城11020',title:'动感地带 秋冬针织衫',visibleText:'国际服装城11020 动感地带旗舰店 9年店，发货地 江苏苏州'}}};

test('完整目录与搜索结果合并保留仓库，只传供应商名称缩写仓库，不泄漏其他数据',()=>{
 const directory=supplierRows({'动感地带旗舰店':{store_house:'CS',supplier_ab:'DGDDQJD',phone:'private'}});
 const rows=supplierRows([...directory,{supplierName:'动感地带旗舰店',supplierAb:'DGDDQJD',supplier_id:1}]);
 assert.equal(rows.length,1);assert.equal(rows[0].storeHouse,'CS');assert.equal(rows[0].supplierAb,'DGDDQJD');assert.equal(JSON.stringify(rows).includes('private'),false);
 assert.deepEqual(supplierRows({bad:{supplier_ab:''}}),[]);
});
test('新采集字段将店名和档口位置分别保留，匹配时优先真实店名',()=>{
 const {publicSource}=require('../desktop/buyer-providers');
 const source=publicSource({url:'https://cs.wsy.com/item.htm?id=26536882',shopName:'动感地带旗舰店',boothName:'国际服装城11020',address:'江苏苏州',images:[]});
 assert.equal(source.shopName,'动感地带旗舰店');assert.equal(source.boothName,'国际服装城11020');assert.equal(source.address,'江苏苏州');
});
test('从完整目录把真实页面店名排在同服装城但不同档口之前，候选有界',()=>{
 const rows=supplierRows([...Array.from({length:200},(_,i)=>({supplierName:'普通店'+i,supplierAb:'A'+i})),{supplierName:'国际服装城1X16',supplierAb:'WRONG'},{supplierName:'动感地带旗舰店',supplierAb:'DGDDQJD',storeHouse:'CS'}]);
 const candidates=rankSuppliers(rows,task);assert.equal(candidates.length,80);assert.equal(candidates[0].supplierName,'动感地带旗舰店');
 const selected=resolveSupplier({supplierCandidateId:candidates[0].candidateId,supplierEvidence:'国际服装城11020 动感地带旗舰店 9年店'},candidates,task);
 assert.equal(selected.supplier.supplierName,'动感地带旗舰店');assert.equal(selected.method,'model_alias');
});
test('未提供候选编号或模型捏造证据不能替换供应商，相同服装城不等于同一家',()=>{
 const candidates=supplierRows([{supplierName:'国际服装城1X16',supplierAb:'WRONG'},{supplierName:'动感地带旗舰店',supplierAb:'DGDDQJD'}]);
 assert.equal(resolveSupplier({supplierCandidateId:'invented',supplierEvidence:'动感地带旗舰店'},candidates,task).supplier,null);
 assert.equal(resolveSupplier({supplierCandidateId:candidates[0].candidateId,supplierEvidence:'国际服装城11020'},candidates,task).supplier,null);
 assert.equal(resolveSupplier({supplierCandidateId:candidates[1].candidateId,supplierEvidence:'页面从未出现的店名'},candidates,task).supplier,null);
 const exactTask={automation:{facts:{supplierName:'动感地带旗舰店'}}};assert.equal(resolveSupplier({},candidates,exactTask).method,'exact');
});
test('真实失败回放：模型解释包裹正确店名时，依据页面商家头部通过校验',()=>{
 const candidates=supplierRows([{'supplierName':'动感地带旗舰店','supplierAb':'DGDDQJD',storeHouse:'CS'}]);
 const explanation='商品页店铺名称原文为“动感地带旗舰店”，页面同时显示档口“国际服装城11020”、发货地“江苏苏州”，与候选供应商“动感地带旗舰店”（DGDDQJD，CS）对应。';
 const selected=resolveSupplier({supplierCandidateId:candidates[0].candidateId,supplierEvidence:explanation},candidates,task);
 assert.equal(selected.supplier.supplierName,'动感地带旗舰店');assert.equal(selected.evidence,'动感地带旗舰店');assert.equal(selected.modelReason,explanation);assert.equal(selected.method,'page_name');
});
test('解释中出现候选名但只来自推荐区时，不误认为当前商家',()=>{
 const candidates=supplierRows([{supplierName:'错误推荐店铺',supplierAb:'WRONG'}]);
 const current={automation:{facts:{supplierName:'当前店铺'},supplierDetails:{shopName:'当前店铺',visibleText:'当前店铺 首页 全部商品 商品介绍 推荐商品 错误推荐店铺'}}};
 const result=resolveSupplier({supplierCandidateId:candidates[0].candidateId,supplierEvidence:'页面推荐商家是“错误推荐店铺”，因此选它'},candidates,current);
 assert.equal(result.supplier,null);
});
test('字典标签与value统一，动态多选形状自动纠正，禁用类别外控件不加入',()=>{
 const controls=[{category:{针织衫:{基础:['领型','功能']}},control:{领型:{type:'select',option:[{label:'翻领',value:'FL'}]},功能:{type:'multi_select',option:['保暖']},无关:{required:1}}},{control:{}}];
 const active=mappingControls(controls,'针织衫');assert.equal(active.无关,undefined);
 const out=normalizeMapping({storeHouse:' CS ',ageState:'adult',extendedAttributes:{领型:['翻领'],功能:'保暖'}},{dictionaries:[{dictType:'warehouse_infos',label:'常熟仓',value:'CS'},{dictType:'ages',label:'成年',value:'adult'}]},active);
 assert.equal(out.storeHouse,'常熟仓');assert.deepEqual(out.ageState,['成年']);assert.equal(out.extendedAttributes.领型,'FL');assert.deepEqual(out.extendedAttributes.功能,['保暖']);
});
test('重复材质字典标签不阻塞，供应商仓库优先，成本及比例仍取原事实',()=>{
 const facts={supplierName:'原网页档口',articleNo:'D2603',cost:42,colors:['黑色'],sizes:['M'],materials:[{name:'聚酯纤维',rate:100}],sizePic:'https://imgcdn.wsy.com/size.jpg',fork:0};
 const data=buildPayload({mapping:{productTypeName:'针织衫',storeHouse:'GZ',pallet:'休闲',industry:'男装',season:'秋季',technology:'普通',style:'休闲',ageState:['成年'],sizeType:'国际码',extendedAttributes:{面料图:'https://imgcdn.wsy.com/fabric.jpg'}},facts,source:{images:[],url:'https://www.wsy.com/item.htm?id=12345'},marketplace:{url:'https://item.taobao.com/item.htm?id=12345678'},collection:{images:[]},supplierImages:['https://imgcdn.wsy.com/fabric.jpg'],catalog:{categories:[{categoryName:'针织衫',categoryAb:'ZZS',status:1}],dictionaries:[['warehouse_infos','常熟仓','CS'],['material_composition','聚酯纤维','a'],['material_composition','聚酯纤维','b'],['international_code','M','M']].map(([dictType,label,value])=>({dictType,label,value})),permissions:{user:{nickname:'买手'}}},controls:[{category:{针织衫:{基础:['面料图']}},control:{面料图:{type:'image',required:1}}}],settings:{supplyCycle:12},supplier:{supplierName:'动感地带旗舰店',supplierAb:'DGDDQJD',storeHouse:'CS'},colors:[{colorName:'黑色',colorId:'BLACK',colorStatus:1},{colorName:'黑色',colorId:'BLACK',colorStatus:1}]});
 assert.equal(data.payload.storeHouse,'CS');assert.equal(data.payload.supplierName,'动感地带旗舰店');assert.equal(data.payload.talkCost,42);assert.deepEqual(data.payload.materialRate,['100']);assert.equal(data.payload.extendedAttributes.面料图,'https://imgcdn.wsy.com/fabric.jpg');assert.ok(!data.missing.some(x=>/材质|颜色库|类别必填/.test(x)));
});
test('模型返回字典类型键时转换尺码类型；没有特殊工艺时保留空值',()=>{
 const result=normalizeMapping({sizeType:'international_code',technology:[],extendedAttributes:{}},{dictionaries:[]},{});
 assert.equal(result.sizeType,'国际码');assert.equal(result.technology,'');
});
