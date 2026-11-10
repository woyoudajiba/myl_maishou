const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const Zip=require('../desktop/node_modules/adm-zip');
const {parseBuyerTable}=require('../desktop/buyer-import');
const {BuyerWorkflow}=require('../desktop/buyer-workflow');
const {BuyerEngine}=require('../desktop/buyer-engine');
const {validateSupplierFacts,buildPayload,manualSupplierFacts}=require('../desktop/buyer-evidence');
const {BuyerSettings}=require('../desktop/buyer-settings');
const {syncBuyerFolder}=require('../desktop/buyer-files');
const {exportBuyerXlsx}=require('../desktop/buyer-import');
const image=Buffer.alloc(120,7),uuid=require('node:crypto').randomUUID;
test('导入识别夹在文案中间的商品链接和紧贴中文后缀，去重同一商品而非误判多链接',()=>{
  const csv='商品链接\n推荐：https://v.douyin.com/DfVjoLZW2Fc/复制打开抖音！\n【淘宝】HTTPS://item.taobao.com/item.htm?id=12345678&spm=abc。点击查看\nhttps://v.douyin.com/a/ https://v.douyin.com/a/';
  const parsed=parseBuyerTable(Buffer.from(csv),'分享.csv');assert.equal(parsed.rows.length,3);
  assert.deepEqual(parsed.rows.map(row=>row.errors),[[],[],[]]);
  assert.equal(parsed.rows[0].sourceUrl,'https://v.douyin.com/DfVjoLZW2Fc/');
  assert.equal(parsed.rows[1].sourceUrl,'https://item.taobao.com/item.htm?id=12345678');
});
test('运营表三类来源统一导入，原行号和重复标签保留，恶意链接不被采集',()=>{
  const table=parseBuyerTable(Buffer.from('货号,套图链接\r\nA1,https://item.taobao.com/item.htm?id=12345678&spm=x\r\nA2,https://v.douyin.com/example/\r\nA3,https://www.17qcc.com/goods/123.html\r\nA4,https://item.taobao.com/item.htm?id=12345678\r\nA5,https://evil.example/image.jpg'),'运营.csv');
  assert.equal(table.rows.length,5);assert.deepEqual(table.rows.slice(0,3).map(row=>row.sourceType),['taobao','douyin','qcc']);assert.equal(table.rows[0].rowNumber,2);assert.equal(table.rows[0].sourceUrl,'https://item.taobao.com/item.htm?id=12345678');assert.deepEqual(table.rows[3].tags,['表内重复']);assert.equal(table.rows[4].errors.length,1);
});
test('固定买手测试表字段读取日期、表格ID、运营商品编码及操作人',()=>{
  const csv='选品日期,表格ID,图片,平台链接,供应商,店铺名,近7天销量,同行销售价,同行发货地,货品成本,发货仓,商品编码,互拓编码,选品操作人,买手操作人,备注,处理状态,商品文件夹\n11.6,01,,https://v.douyin.com/example/,远鑫伦,测试店,120,109,广州,39,广州仓,CS-款式01,,小王,小周,加绒待询,,';
  const parsed=parseBuyerTable(Buffer.from(csv),'买手测试表.csv');assert.equal(parsed.rows.length,1);const row=parsed.rows[0];assert.equal(row.tableId,'01');assert.equal(row.selectDate,'11.6');assert.equal(row.sourceType,'douyin');assert.equal(row.externalCode,'CS-款式01');assert.equal(row.supplierName,'远鑫伦');assert.equal(row.selectOperator,'小王');assert.equal(row.buyerOperator,'小周');assert.equal(row.note,'加绒待询');assert.equal(row.tableFields.goodsCost,'39');
});
test('同一选品日期内不能重复使用商品目录表格ID',()=>{
  const csv='选品日期,表格ID,平台链接\n11.6,01,https://v.douyin.com/a/\n11.6,01,https://v.douyin.com/b/\n11.7,01,https://v.douyin.com/c/';const parsed=parseBuyerTable(Buffer.from(csv),'重复ID.csv');assert.deepEqual(parsed.rows.map(row=>row.errors.length),[0,1,0]);assert.ok(parsed.rows[1].errors.includes('同一选品日期内表格ID重复'));
});
test('回填工作簿保持固定模板字段顺序并单独保留互拓编码',()=>{
  const zip=new Zip(exportBuyerXlsx([{tableId:'01',selectDate:'11.6',sourceUrl:'https://v.douyin.com/example/',externalCode:'CS-款式01',erpProductNo:'ERP-001'}]));
  const sheet=zip.readAsText('xl/worksheets/sheet1.xml');for(const [index,label] of ['选品日期','表格ID','平台链接','商品编码','互拓编码'].entries()){const col=String.fromCharCode(65+index);assert.ok(sheet.includes(`<c r="${col}1"`));}assert.match(sheet,/ERP-001/);assert.match(sheet,/CS-款式01/);
});
test('商品文件夹先使用表格ID，取得互拓编码后安全改名并保留商品主图',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buyer-folders-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const task={id:uuid(),sourceType:'douyin',sourceUrl:'https://v.douyin.com/example/',externalCode:'CS-ORIGIN',origin:{tableId:'01',selectDate:'11.6',rowNumber:2},updatedAt:new Date().toISOString(),automation:{state:'running'}};
  const initial=await syncBuyerFolder({rootDir:root,task,sourceImage:image});assert.equal(initial,path.join(root,'买手','11.6','01'));assert.deepEqual(await fs.readFile(path.join(initial,'主图.jpg')),image);task.productFolder=initial;task.automation={state:'completed',result:{productNo:'CS-休闲裤'}};
  const final=await syncBuyerFolder({rootDir:root,task,sourceImage:image});assert.equal(final,path.join(root,'买手','11.6','CS-休闲裤'));assert.equal(await fs.stat(initial).then(()=>true,()=>false),false);assert.equal(JSON.parse(await fs.readFile(path.join(final,'商品记录.json'),'utf8')).erpProductNo,'CS-休闲裤');
  const another={...task,id:uuid(),productFolder:'',origin:{...task.origin,tableId:'02'}};const occupied=path.join(root,'买手','11.6','CS-休闲裤_02');await fs.mkdir(occupied,{recursive:true});await fs.writeFile(path.join(occupied,'keep.txt'),'keep');const collision=await syncBuyerFolder({rootDir:root,task:another,sourceImage:image});assert.notEqual(collision,final);assert.ok(collision.endsWith('CS-休闲裤_02_2'));assert.equal(await fs.readFile(path.join(occupied,'keep.txt'),'utf8'),'keep');assert.equal(JSON.parse(await fs.readFile(path.join(final,'商品记录.json'),'utf8')).taskId,task.id);
});
test('XLSX识别单元格超链接、WPS DISPIMG图片和隐藏缓存值，不执行公式或请求外部链接',()=>{
  const zip=new Zip();const add=(name,text)=>zip.addFile(name,Buffer.from(text));
  add('xl/workbook.xml','<workbook xmlns="urn:w" xmlns:r="urn:r"><sheets><sheet name="选品" r:id="s1"/></sheets></workbook>');
  add('xl/_rels/workbook.xml.rels','<Relationships xmlns="urn:r"><Relationship Id="s1" Target="worksheets/sheet1.xml"/></Relationships>');
  add('xl/worksheets/sheet1.xml','<worksheet xmlns="urn:w" xmlns:r="urn:r"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>货号</t></is></c><c r="B1" t="inlineStr"><is><t>商品链接</t></is></c></row><row r="5"><c r="A5" t="inlineStr"><is><t>ABC12</t></is></c><c r="B5" t="inlineStr"><is><t>点击看图</t></is></c><c r="C5"><f>_xlfn.DISPIMG("ID_TEST",1)</f><v>0</v></c></row></sheetData><hyperlinks><hyperlink ref="B5" r:id="link1"/></hyperlinks></worksheet>');
  add('xl/worksheets/_rels/sheet1.xml.rels','<Relationships xmlns="urn:r"><Relationship Id="link1" Target="https://item.taobao.com/item.htm?id=12345678" TargetMode="External"/></Relationships>');
  add('xl/cellimages.xml','<cellImages xmlns="urn:w" xmlns:r="urn:r"><pic><cNvPr name="ID_TEST"/><blip r:embed="picture"/></pic></cellImages>');
  add('xl/_rels/cellimages.xml.rels','<Relationships xmlns="urn:r"><Relationship Id="picture" Target="media/a.jpg"/></Relationships>');zip.addFile('xl/media/a.jpg',image);
  const parsed=parseBuyerTable(zip.toBuffer(),'选品.xlsx');assert.equal(parsed.rows.length,1);assert.equal(parsed.rows[0].rowNumber,5);assert.equal(parsed.rows[0].articleNo,'ABC12');assert.deepEqual(parsed.rows[0].image,image);
});
test('重复导入同一表不会新增任务，跨表同链接关联为例外；落盘后检查点可恢复',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buyer-table-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const workflow=new BuyerWorkflow({dataDir:dir});await workflow.load();
  const first=parseBuyerTable(Buffer.from('货号,链接\nA1,https://v.douyin.com/a/'),'first.csv');assert.equal((await workflow.importTable(first)).imported,1);assert.equal((await workflow.importTable(first)).skipped,1);
  const second=parseBuyerTable(Buffer.from('货号,链接\nA2,https://v.douyin.com/a/'),'second.csv');await workflow.importTable(second);assert.equal(workflow.snapshot()[1].automation.state,'attention');assert.ok(workflow.snapshot()[1].automation.tags.includes('重复来源'));
  const restored=new BuyerWorkflow({dataDir:dir});await restored.load();assert.equal(restored.snapshot().length,2);assert.equal(restored.snapshot()[0].origin.rowNumber,2);
});
const same=(id,platform='qcc')=>({id,platform,title:'同款衬衫',detailUrl:'https://www.17qcc.com/goods/'+id+'.html',imageUrl:'https://pics.17qcc.com/'+id+'.jpg',visualComparison:{verdict:'likely_same',score:96,differences:[],uncertainties:[]}});
async function setup(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buyer-engine-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const workflow=new BuyerWorkflow({dataDir:dir});await workflow.load();const preview=parseBuyerTable(Buffer.from('货号,链接\nA1,https://v.douyin.com/a/\nA2,https://v.douyin.com/b/\nA3,https://v.douyin.com/c/'),'队列.csv');await workflow.importTable(preview);return workflow;}
test('完整商品自动进互拓待审核，多供应商同款与缺资料打标签，后续商品不中断',async t=>{
  const workflow=await setup(t);let submits=0,converts=0;
  const providers={source:async()=>({images:[],url:'https://v.douyin.com/a/'}),searchSuppliers:async()=>({items:[same('123')],records:['wsy','zwd','qcc','e3hui'].map(key=>({key,phase:'complete'}))}),compareSuppliers:async task=>({status:'complete',items:task.articleNo==='A2'?[same('2'),same('3')]:[same(task.id)]}),supplierDetails:async()=>({images:[],visibleText:'真实资料'}),facts:async task=>({articleNo:task.articleNo,supplierName:'测试供应商',missing:task.articleNo==='A3'?['供应商成分及比例']:[]}),marketplace:async()=>({url:'https://item.taobao.com/item.htm?id=12345678'}),duplicates:async()=>[],collect:async()=>({rawPrefill:{}}),map:async()=>({payload:{test:'固定正文'},missing:[]}),prepare:async payload=>({key:uuid(),body:JSON.stringify(payload)}),submit:async()=>{submits++;return{state:'saved',draftId:'101'};},verify:async()=>({draftVersion:2}),target:()=> 'pending',convert:async()=>{converts++;return{productId:'201',productNo:'QCC-ABC-001',productState:0};}};
  const engine=new BuyerEngine({workflow,providers,signal:new AbortController().signal});await engine.start(workflow.snapshot().map(task=>task.id));
  for(let i=0;i<20;i++)for(const task of workflow.state.tasks)if(!['attention','completed'].includes(task.automation.state))await engine.step(task);
  assert.equal(workflow.state.tasks[0].automation.state,'completed');assert.equal(workflow.state.tasks[0].automation.result.productNo,'QCC-ABC-001');assert.deepEqual(workflow.state.tasks[1].automation.tags,['多供应商同款']);assert.deepEqual(workflow.state.tasks[2].automation.tags,['供应商资料缺失']);assert.equal(submits,1);assert.equal(converts,1);await engine.close();
});
test('互拓超时保留同一幂等键与正文；崩溃不把未知回执当成功或自动重新创建',async t=>{
  const workflow=await setup(t),task=workflow.state.tasks[0];await workflow.patchAutomation(task.id,{enabled:true,step:'submit',state:'queued',draftAttempt:{key:'same-key',body:'{"value":1}'}});
  let used;const engine=new BuyerEngine({workflow,providers:{submit:async task=>{used=task.automation.draftAttempt;return{state:'unknown'};}},signal:new AbortController().signal});await engine.step(task);assert.equal(used.key,'same-key');assert.equal(task.automation.state,'attention');assert.equal(task.automation.draftAttempt.body,'{"value":1}');await engine.close();
});
test('人工对照候选可绕过不确定的模型结论继续采集，并单独记录人工确认',async t=>{
  const workflow=await setup(t),task=workflow.state.tasks[0];
  const candidate={platform:'qcc',title:'需人工核对的棉服',detailUrl:'https://www.17qcc.com/goods/manual.html',imageUrl:'https://pics.17qcc.com/manual.jpg',visualComparison:{verdict:'similar',score:78,differences:['口袋细节不同'],uncertainties:['袖口被遮挡']}};
  await workflow.patchAutomation(task.id,{enabled:true,state:'attention',step:'supplier_compare',searchCandidates:[candidate],supplierCandidates:[],tags:['未确认供应商同款']});
  const engine=new BuyerEngine({workflow,providers:{},signal:new AbortController().signal});await engine.close();
  await assert.rejects(()=>engine.resolveSupplier(task.id,0),/人工确认同款/);
  await engine.resolveSupplier(task.id,0,{manualConfirmed:true});
  assert.equal(task.automation.step,'supplier_details');assert.equal(task.automation.supplier.detailUrl,candidate.detailUrl);assert.equal(task.automation.supplier.visualComparison.score,78);assert.equal(task.automation.supplierSelection.method,'manual');assert.match(task.events.at(-1).message,/人工对照图片确认/);
});
test('供应商成本、颜色尺码和成分必须有原文依据，模型臆测不能进入互拓资料',()=>{
  const details={title:'衬衫',visibleText:'货号ABC123，供货价39元，颜色黑色，尺码M L，成分100%棉',images:['https://pics.17qcc.com/size.jpg'],shopName:'测试店'};
  const valid={articleNo:'ABC123',supplierName:'测试店',cost:39,colors:['黑色'],sizes:['M','L'],materials:[{name:'棉',rate:100}],fork:0,sizeImageIndex:0,evidence:{articleNo:'货号ABC123',cost:'供货价39元',colors:'颜色黑色',sizes:'尺码M L',materials:'成分100%棉'}};
  assert.equal(validateSupplierFacts(valid,details).missing.length,0);const bad=validateSupplierFacts({...valid,cost:19,evidence:{...valid.evidence,cost:'最低价19元'}},details);assert.ok(bad.missing.includes('供应商明确供货价'));assert.equal(bad.cost,null);
  const invented=validateSupplierFacts({...valid,cost:19,colors:['红色'],materials:[{name:'聚酯纤维',rate:100}]},details);assert.equal(invented.cost,null);assert.deepEqual(invented.colors,[]);assert.deepEqual(invented.materials,[]);
});
test('保留中文供应商货号并要求原文完整匹配',()=>{
  const articleNo='YPD6711AB加棉套装',details={title:'棉衣套装',shopName:'异频道潮牌',visibleText:`产品货号：${articleNo}；供货价163元；颜色象牙白；尺码M；成分锦纶100%`,images:['https://pics.17qcc.com/size.jpg']};
  const facts={articleNo,supplierName:'异频道潮牌',cost:163,colors:['象牙白'],sizes:['M'],materials:[{name:'锦纶',rate:100}],fork:0,sizeImageIndex:0,evidence:{articleNo:`产品货号：${articleNo}`,supplierName:'异频道潮牌',cost:'供货价163元',colors:'颜色象牙白',sizes:'尺码M',materials:'成分锦纶100%'}};
  assert.equal(validateSupplierFacts(facts,details).articleNo,articleNo);assert.equal(validateSupplierFacts(facts,details).missing.length,0);
  assert.ok(validateSupplierFacts({...facts,articleNo:'YPD6711AB'},details).missing.includes('供应商有效货号'));
  const manuallyEntered=manualSupplierFacts({articleNo,supplierName:'异频道潮牌',cost:163,colors:['象牙白'],sizes:['M'],materials:[{name:'锦纶',rate:100}],sizeImageIndex:0,fork:0},null,details);
  assert.equal(manuallyEntered.articleNo,articleNo);
});
test('互拓连接按账号加密保存，快照不回传密码或OAuth密钥，更换服务需重新输入对应凭据',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buyer-settings-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const storage={encrypt:value=>Buffer.from(value).toString('base64'),decrypt:value=>Buffer.from(value,'base64').toString('utf8')};const settings=new BuyerSettings({dataDir:dir,storage});await settings.load();
  await settings.save({erpBaseUrl:'https://erp.example/api',erpTenantId:'1',erpClientId:'client',erpClientSecret:'fixture-secret',erpUsername:'fixture-user',erpPassword:'fixture-password',company:'厦门',target:'pending'});
  const snapshot=settings.snapshot();assert.equal(snapshot.configured,true);assert.equal(snapshot.hasPassword,true);assert.equal(Object.hasOwn(snapshot,'erpPassword'),false);assert.equal(Object.hasOwn(snapshot,'erpClientSecret'),false);assert.equal((await fs.readFile(settings.file,'utf8')).includes('fixture-password'),false);
  await assert.rejects(settings.save({erpBaseUrl:'https://other.example/api'}),/重新填写/);const restored=new BuyerSettings({dataDir:dir,storage});await restored.load();assert.equal(restored.snapshot().configured,true);assert.equal(restored.value.target,'pending');
});
