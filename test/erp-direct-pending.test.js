const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {BuyerWorkflow}=require('../desktop/buyer-workflow'),{BuyerEngine}=require('../desktop/buyer-engine');
test('修正档口名后仅在同一淘宝ID与原货号的完整采集可用时直接继续整理',()=>{
 const {hasCompletedCollection}=require('../desktop/buyer-engine');const task={automation:{collectionExternalId:'12345678',marketplace:{url:'https://item.taobao.com/item.htm?id=12345678'},collection:{externalId:'12345678',title:'原商品',images:['https://img.alicdn.com/a.jpg'],rawPrefill:{article_no:'D2603',supplier_name:'国际服装城11020'}}}};
 assert.equal(hasCompletedCollection(task,{articleNo:'D2603',supplierName:'动感地带旗舰店'}),true);
 assert.equal(hasCompletedCollection(task,{articleNo:'OTHER'}),false);
 task.automation.marketplace.url='https://item.taobao.com/item.htm?id=99999999';assert.equal(hasCompletedCollection(task,{articleNo:'D2603'}),false);
});
const config={erpManaged:true,erpBaseUrl:'https://wsfile.cn/maishou/api',erpToken:'fixture',erpDirectSaveConfirmed:true};
const payload={company:'厦门',articleNo:'K2028JR',productType:'XXK',productTypeName:'休闲裤',storeHouse:'GZ',supplierName:'测试供应商',supplierAb:'1HYFS',pallet:'休闲',sizeType:'国际码',sizeCategory:['M'],colors:['黑'],colorNo:['BLACK'],colorPic:[''],colorRemark:[''],material:['棉'],materialRate:['100'],sizePic:'https://img.alicdn.com/size.jpg',buyerName:'买手',industry:'男装',season:'秋季',technology:'水洗',style:'休闲',ageState:'成年',talkCost:65,supplyCycle:12,fork:0,extendedAttributes:{},sizeList:[],standardScore:[],suitPicInfo:[{mainPic:'https://img.alicdn.com/main.jpg',mainPicSource:'其他平台链接',suitPic:'https://item.taobao.com/item.htm?id=12345678',picBuyerName:'买手'}]};
const product={id:'201',articleNo:payload.articleNo,supplierName:payload.supplierName,productNo:'GZ-XXK-1HYFS-K2028JR',productState:0};
const response=data=>Response.json({code:0,data});

test('直接保存0回执不能当产品ID；完整编码回读后才确认待审核',async()=>{
 const {ErpClient}=await import('../desktop/erp/client.mjs'),{prepareProductAttempt}=await import('../desktop/erp/contract.mjs');let writes=0,journal;const seen=[];
 const client=new ErpClient(config,{fetchImpl:async(url,options)=>{seen.push(url);if(url.endsWith('/product-addition/add')){writes++;assert.equal(journal.state,'submitting');return response(0);}if(url.endsWith('/pool-product/page')){assert.deepEqual(JSON.parse(options.body),{pageNo:1,pageSize:25,productState:'all',productNo:product.productNo,articleNo:product.articleNo});return response({list:[product],total:1});}return response(product);}});
 const attempt=prepareProductAttempt(payload);assert.equal((await client.submitProduct(attempt,{checkpoint:async value=>{journal=value;}})).state,'submitted');
 const saved=await client.verifyProduct(attempt);assert.equal(saved.productId,'201');assert.equal(saved.state,'pending_approval');assert.equal(writes,1);assert.ok(seen.every(url=>!url.includes('draft')&&!url.includes('convert')));
});

test('直接保存先写检查点，失败阻止POST；网络或业务失败重启后不重复提交',async()=>{
 const {ErpClient}=await import('../desktop/erp/client.mjs'),{prepareProductAttempt}=await import('../desktop/erp/contract.mjs');let writes=0,journal;
 const client=new ErpClient(config,{fetchImpl:async()=>{writes++;throw Error('private request timeout');}}),attempt=prepareProductAttempt(payload);
 await assert.rejects(()=>client.submitProduct(attempt,{checkpoint:async()=>{throw Error('磁盘失败');}}),/磁盘/);assert.equal(writes,0);
 assert.equal((await client.submitProduct(attempt,{checkpoint:async value=>{journal=value;}})).state,'unknown');assert.equal(writes,1);
 await client.submitProduct(attempt,{priorSubmission:journal});assert.equal(writes,1);
 const restored=new ErpClient(config,{fetchImpl:async()=>{throw Error('禁止重发');}});assert.equal((await restored.submitProduct(attempt,{priorSubmission:journal})).queryOnly,true);
 await assert.rejects(()=>restored.submitProduct({...attempt,productNo:'wrong'},{priorSubmission:journal}),/编码不一致/);
});

test('回执缺失、查询失败、多条、身份不同和已上架不算待审核保存成功',async()=>{
 const {ErpClient}=await import('../desktop/erp/client.mjs'),{prepareProductAttempt}=await import('../desktop/erp/contract.mjs');const attempt=prepareProductAttempt(payload);let page={list:[],total:0},detail=product;
 const client=new ErpClient(config,{fetchImpl:async url=>url.endsWith('/page')?response(page):response(detail)});
 await assert.rejects(()=>client.verifyProduct(attempt),/尚未查到/);page={list:[product,product],total:2};await assert.rejects(()=>client.verifyProduct(attempt),/多条/);
 page={list:null,total:null};await assert.rejects(()=>client.verifyProduct(attempt),/有效列表/);
 page={list:[product],total:1};detail={...product,productState:1};await assert.rejects(()=>client.verifyProduct(attempt),/不在待审核/);
 detail={...product,supplierName:'其他档口'};await assert.rejects(()=>client.verifyProduct(attempt),/身份不一致/);
 const disabled=new ErpClient({...config,erpDirectSaveConfirmed:false},{fetchImpl:()=>{throw Error('不应发请求');}});await assert.rejects(()=>disabled.submitProduct(attempt),/未启用/);
});
test('正式分页供应商名称为空时必须进一步读详情确认身份',async()=>{
 const {ErpClient}=await import('../desktop/erp/client.mjs'),{prepareProductAttempt}=await import('../desktop/erp/contract.mjs');let detailReads=0;
 const client=new ErpClient(config,{fetchImpl:async url=>{if(url.endsWith('/page'))return response({list:[{...product,supplierName:null}],total:1});detailReads++;return response(product);}});
 const result=await client.verifyProduct(prepareProductAttempt(payload));assert.equal(result.productId,'201');assert.equal(detailReads,1);
});

test('自动流程跳过草稿并回填编号；未知回执重试只进入核验，原资料不能改写',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'direct-pending-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const workflow=new BuyerWorkflow({dataDir:dir});await workflow.load();const created=await workflow.create({sourceType:'taobao',sourceUrl:'https://item.taobao.com/item.htm?id=12345678'}),task=workflow.task(created.id);let writes=0,ready=false,syncs=0;
 const {prepareProductAttempt}=await import('../desktop/erp/contract.mjs');const providers={map:async()=>({payload,missing:[]}),prepareProduct:async value=>prepareProductAttempt(value),submitProduct:async t=>{writes++;await workflow.patchAutomation(t.id,{productSubmission:{key:t.automation.productAttempt.key,productNo:product.productNo,state:'unknown'}});return task.automation.productSubmission;},verifyProduct:async()=>{if(!ready)throw Error('尚未查到');return{productId:'201',productNo:product.productNo,productState:0,state:'pending_approval'};},onTaskUpdated:async()=>{syncs++;}};
 const engine=new BuyerEngine({workflow,providers,signal:new AbortController().signal});t.after(()=>engine.close());await workflow.patchAutomation(task.id,{step:'mapping',state:'queued',enabled:true});await engine.step(task);assert.equal(task.automation.productAttempt.mode,'direct_pending');await engine.step(task);assert.equal(task.automation.step,'verify');await assert.rejects(()=>engine.step(task),/尚未查到/);
 await engine.attention(task,'回执未知','尚未查到');engine.kick=()=>{};await engine.retry(task.id);assert.equal(task.automation.step,'verify');ready=true;await engine.step(task);assert.equal(task.automation.state,'completed');assert.equal(task.automation.enabled,false);assert.equal(task.automation.result.productNo,product.productNo);assert.equal(writes,1);assert.ok(syncs>=3);assert.equal(task.automation.draftId,undefined);
});
