const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {_electron}=require('playwright');
const root=path.resolve(__dirname,'..');
const packagedExecutable=process.env.PC_QA_EXECUTABLE;
test('自动买手真实Electron全链路：导入表格、四站比较、供应商资料、互拓草稿与待审核回查，无逐条人工确认',{timeout:65000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'auto-buyer-e2e-'));let app;
  t.after(async()=>{await app?.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const file=path.join(dir,'运营选品.csv');await fs.writeFile(file,'货号,套图链接\nABC123,https://item.taobao.com/item.htm?id=12345678');
  const bootstrap=path.join(dir,'main.cjs');
  await fs.writeFile(bootstrap,`const {app,dialog}=require('electron');app.setPath('userData',${JSON.stringify(path.join(dir,'profile'))});dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(file)}]});require(${JSON.stringify(path.join(root,'desktop/main.js'))});`);
  const env={...process.env,PC_QA_LOCAL_ERP:'1'};delete env.ELECTRON_RUN_AS_NODE;app=await _electron.launch({executablePath:packagedExecutable||path.join(root,'desktop/node_modules/electron/dist/electron.exe'),args:packagedExecutable?[`--user-data-dir=${path.join(dir,'profile')}`]:[bootstrap],env});const page=await app.firstWindow();
  if(packagedExecutable)await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
  const uiErrors=[];page.on('pageerror',error=>uiErrors.push(error.message));await app.context().route('https://**/*',route=>route.abort());
  const image=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=900;canvas.height=1200;canvas.getContext('2d').fillRect(0,0,900,1200);return canvas.toDataURL('image/png');});
  await app.evaluate((_,image)=>{
    process.getBuiltinModule('node:dns/promises').lookup=async()=>[{address:'93.184.216.34',family:4}];
    globalThis.autoFixture={models:0,submits:0,converts:0,collection:false,payload:null};
    const dictionaries=[['warehouse_infos','GZ','广州仓'],['pallet_infos','leisure','休闲'],['industry','mens','男装'],['season','autumn','秋季'],['technology_infos','wash','水洗'],['product_style','casual','休闲'],['ages','adult','成年'],['suit_pic_source','qita','其他平台链接'],['material_composition','cotton','棉'],['international_code','M','M'],['international_code','L','L'],['company','0','厦门']].map(([dictType,value,label])=>({dictType,value,label}));
    globalThis.fetch=async(url,options={})=>{
      const target=String(url);
      if(target.startsWith('https://wsfile.cn/myladmin/api/auth/')){const user={id:'auto-qa',username:'auto-qa',displayName:'自动买手测试'};return Response.json(target.endsWith('/login')?{token:'fixture',expiresAt:new Date(Date.now()+3600000).toISOString(),user}:{user,ok:true});}
      if(/^https:\/\/(img\.alicdn\.com|pics\.17qcc\.com)\//.test(target))return new Response(Buffer.from(image.split(',')[1],'base64'),{headers:{'content-type':'image/png'}});
      if(target.startsWith('https://vision.fixture/')){
        autoFixture.models++;const body=JSON.parse(options.body),instruction=body.messages[0].content,content=body.messages[1].content;let result;
        if(instruction.includes('提取供应商事实'))result={articleNo:'ABC123',supplierName:'测试档口',cost:39,colors:['黑色'],sizes:['M','L'],materials:[{name:'棉',rate:100}],sizeImageIndex:0,fork:0,warehouse:'广州仓',categoryName:'衬衫',priceConflict:false,evidence:{articleNo:'货号ABC123',cost:'供货价39元',colors:'颜色黑色',sizes:'尺码M L',materials:'成分100%棉'}};
        else if(instruction.includes('只从给定categories'))result={productTypeName:'衬衫'};
        else if(instruction.includes('当前互拓字典'))result={productTypeName:'衬衫',storeHouse:'广州仓',pallet:'休闲',industry:'男装',season:'秋季',technology:'水洗',style:'休闲',ageState:['成年'],sizeType:'国际码',extendedAttributes:{款式:'衬衫'}};
        else{const ids=content.filter(part=>part.type==='text'&&part.text.startsWith('候选编号：')).map(part=>part.text.slice(5));result={results:ids.map(id=>({id,verdict:'likely_same',score:96,matches:['领型一致','口袋一致'],differences:[],uncertainties:[]}))};}
        return Response.json({model:'fixture-vision',choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]});
      }
      if(!target.startsWith('https://erp.fixture/'))throw new Error('验收禁止真实外网和远端写入');
      const route=new URL(target).pathname.replace('/api','');let data;
      if(route==='/system/oauth2/token')data={access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600};
      else if(route==='/system/auth/get-permission-info')data={user:{nickname:'测试买手'}};
      else if(route==='/system/dict-data/list-all-simple')data=dictionaries;
      else if(route==='/erp/category/list')data=[{categoryName:'衬衫',categoryAb:'CS',status:1,processScope:'面料^30|面料质量/证据/30*车缝^40|车缝/证据/40'}];
      else if(route==='/erp/category/info')data={category:{衬衫:{重要属性:['款式'],品牌区:['品牌']}},control:{款式:{field:'款式',type:'select',required:1,option:['衬衫']},品牌:{field:'品牌',type:'select',required:1,option:['测试品牌']}}};
      else if(route==='/erp/attributes-extend/extend-category')data={control:{}};
      else if(route==='/erp/supplier-infos/sample-list')data=[{supplier_id:'11',supplierName:'测试档口',supplierAb:'TEST'}];
      else if(route==='/erp/colors/query')data=[{colorName:'黑色',colorId:'BLACK',colorStatus:1}];
      else if(route==='/erp/pool-product/page')data={list:[],total:0};
      else if(route==='/taobao/product-crawler/get')data=autoFixture.collection?{externalId:'12345678',title:'纯棉衬衫',productData:JSON.stringify({title:'纯棉衬衫',main_pic:'https://img.alicdn.com/main.jpg',collection_colors:[{name:'黑色',image:'https://img.alicdn.com/black.jpg'}],collection_sizes:['M','L']})}:null;
      else if(route==='/taobao/product-crawler/taobao_product_crawler_add'){autoFixture.collection=true;data={some_num:1,err_url:''};}
      else if(route==='/taobao/product-crawler/get-original-images')data={mainPic:'https://img.alicdn.com/main.jpg',mainPic11:['https://img.alicdn.com/main11.jpg'],mainPic34:[],detailPic:['https://img.alicdn.com/detail.jpg']};
      else if(route==='/erp/product-draft/add'){autoFixture.submits++;autoFixture.payload=JSON.parse(options.body);data='101';}
      else if(route==='/erp/product-draft/get')data={id:'101',draftVersion:2,status:'DRAFT'};
      else if(route==='/erp/product-draft/convert'){autoFixture.converts++;data='201';}
      else if(route==='/erp/pool-product/getProductInfosDetailById')data={id:'201',productNo:'GZ-CS-TEST-ABC123',productState:0};
      else throw new Error('未约定的互拓接口：'+route);
      return Response.json({code:0,data});
    };
  },image);
  await page.locator('#username').fill('auto-qa');await page.locator('#password').fill('fixture-password');await page.locator('#loginButton').click();await page.locator('#appShell').waitFor({state:'visible'});
  await page.evaluate(async()=>{const saved=await window.desktop.saveModel({name:'验收模型',model:'fixture',endpoint:'https://vision.fixture/v1',apiKey:'fixture-key'});await window.desktop.selectModel(saved.models.find(model=>model.name==='验收模型').id);await window.desktop.saveBuyerSettings({erpBaseUrl:'https://erp.fixture/api',erpTenantId:'1',erpClientId:'fixture',erpClientSecret:'fixture-secret',erpUsername:'fixture',erpPassword:'fixture-password',target:'pending'});});
  await page.locator('#navBuyer').click();await page.locator('#buyerImportTable').click();await page.locator('#buyerImportDialog').waitFor({state:'visible'});assert.match(await page.locator('#buyerImportCounts').textContent(),/有效 1 行/);await page.locator('#buyerImportConfirm').click();await page.locator('#buyerImportDialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelectorAll('.buyer-auto-task').length===1);
  let final;
  for(let attempt=0;attempt<220;attempt++){
    const data=await page.evaluate(()=>window.desktop.snapshot()),task=data.buyerTasks[0];
    const headers={'X-Desktop-Token':data.token,'Content-Type':'application/json','X-PC-Extension-Version':require('../manifest.json').version,'X-PC-Buyer-Protocol':'1'};
    for(const command of data.browserCommands.filter(command=>command.status==='queued')){
      let result;
      if(command.kind==='buyer-source')result={url:command.detailUrl,title:'纯棉衬衫',sku:'ABC123',shopName:'测试档口',images:[command.platform==='taobao'?'https://img.alicdn.com/main.jpg':'https://pics.17qcc.com/size.jpg'],visibleText:'货号ABC123，供货价39元，颜色黑色，尺码M L，成分100%棉',salesText:'总销量300+'};
      else if(command.kind==='buyer-supplier-search')result={items:[{id:'supplier1',platform:'qcc',title:'纯棉衬衫',shopName:'测试档口',detailUrl:'https://www.17qcc.com/goods/123.html',imageUrl:'https://pics.17qcc.com/item.jpg',price:39}],records:['wsy','zwd','qcc','e3hui'].map(key=>({key,phase:'complete',items:[],total:1}))};
      if(result){const response=await fetch(`http://127.0.0.1:${data.port}/v1/browser-commands/${command.id}/ack`,{method:'POST',headers,body:JSON.stringify({status:'accepted',result})});assert.equal(response.status,200,await response.text());}
    }
    if(task?.automation?.state==='attention')assert.fail(task.automation.error);
    if(task?.automation?.state==='completed'){final=data;break;}
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  assert.ok(final,'自动队列应完成整条流水线');assert.equal(final.buyerTasks[0].automation.result.productNo,'GZ-CS-TEST-ABC123');assert.equal(final.buyerTasks[0].origin.rowNumber,2);
  const fixture=await app.evaluate(()=>autoFixture);assert.equal(fixture.submits,1);assert.equal(fixture.converts,1);assert.equal(fixture.payload.talkCost,39);assert.equal(Object.hasOwn(fixture.payload,'company'),false);assert.deepEqual(fixture.payload.standardScore,[['0'],['0']]);assert.equal(fixture.payload.suitPicInfo[0].mainPicSource,'其他平台链接');assert.equal(fixture.payload.extendedAttributes.品牌,undefined);assert.deepEqual(uiErrors,[]);
  await page.waitForFunction(()=>document.querySelector('#buyerAutoSummary').textContent.includes('已完成 1 件'));assert.equal(await page.locator('.buyer-stage-track li.done').count(),6);
  await page.locator('#buyerAddLink').click();await page.locator('#buyerSingleLinkValue').fill('https://item.taobao.com/item.htm?id=12345678');await page.locator('#buyerSingleLinkStart').click();await page.locator('#buyerSingleLinkDialog').waitFor({state:'hidden'});assert.equal((await page.evaluate(()=>window.desktop.snapshot())).buyerTasks.length,1);assert.equal((await app.evaluate(()=>autoFixture)).models,fixture.models,'再次输入已完成链接不重新识别');
  await fs.mkdir(path.join(root,'output/playwright'),{recursive:true});await page.locator('.buyer-auto-task').screenshot({path:path.join(root,'output/playwright/buyer-task-six-stages.png')});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(root,'output/playwright/buyer-automation-completed.png')});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(800,620));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(root,'output/playwright/buyer-automation-800.png')});
});
