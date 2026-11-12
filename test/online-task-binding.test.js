const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {resolveOnlineTask}=require('../desktop/online-task-binding');
const {BuyerWorkflow}=require('../desktop/buyer-workflow');
const {BuyerEngine}=require('../desktop/buyer-engine');
const taskId='11111111-1111-4111-8111-111111111111',rowId='22222222-2222-4222-8222-222222222222',tableA='33333333-3333-4333-8333-333333333333',tableB='44444444-4444-4444-8444-444444444444';
const sourceUrl='https://v.douyin.com/current/';

test('回填工作簿包含任务、在线表与行的独立编号，不替换原表格目录编号',()=>{
  const {exportBuyerXlsx}=require('../desktop/buyer-import'),Zip=require('../desktop/node_modules/adm-zip');
  const zip=new Zip(exportBuyerXlsx([{tableId:'07',taskId,onlineTableId:tableA,onlineTableRowId:rowId,sourceUrl}]));
  const xml=zip.readAsText('xl/worksheets/sheet1.xml');
  for(const value of ['任务ID','在线表ID','在线行ID','07',taskId,tableA,rowId])assert.ok(xml.includes(value));
});

test('切换当前表格后，任务验证与回写仍发送到原表；旧任务只有完全匹配才补齐绑定',async()=>{
  const urls=[],patches=[],task={id:taskId,onlineTableId:tableA,onlineTableRowId:rowId,sourceUrl},row={id:rowId,taskId,sourceUrl,version:4};
  const options={task,settings:{value:{onlineTableId:tableB}},authToken:'fixture',workflow:{patchTask:async(_id,patch)=>patches.push(patch)},transport:async(url)=>{urls.push(url);return Response.json({row,offset:120});}};
  const binding=await resolveOnlineTask(options);await binding.client.updateTask(rowId,taskId,{automationState:'attention'},4);
  assert.ok(urls.every(url=>url.includes(tableA)));assert.equal(binding.offset,120);assert.deepEqual(patches,[]);
  delete task.onlineTableId;options.settings.value.onlineTableId=tableA;
  await resolveOnlineTask(options);assert.deepEqual(patches,[{onlineTableId:tableA}]);
});

test('表行换任务、换链接、删除时，原任务不能沿用缓存；不会自动认领新商品',async()=>{
  const task={id:taskId,onlineTableId:tableA,onlineTableRowId:rowId,sourceUrl};let writes=0;
  for(const response of [Response.json({row:{id:rowId,taskId:tableB,sourceUrl}}),Response.json({row:{id:rowId,taskId,sourceUrl:'https://v.douyin.com/replacement/'}}),Response.json({error:'不存在'},{status:404})]){
    await assert.rejects(resolveOnlineTask({task,settings:{value:{onlineTableId:tableA}},authToken:'fixture',workflow:{patchTask:()=>writes++},transport:async()=>response}),error=>error.tag==='表格任务关联失效');
  }
  assert.equal(writes,0);
});

test('旧任务缺少表ID且界面已切到另一张表时，按原行和任务链接发现原表后再绑定',async()=>{
  const patches=[],task={id:taskId,onlineTableRowId:rowId,sourceUrl};
  const binding=await resolveOnlineTask({task,settings:{value:{onlineTableId:tableB}},authToken:'fixture',workflow:{patchTask:async(_id,patch)=>patches.push(patch)},transport:async(url)=>{
    if(url.endsWith('/api/tables'))return Response.json({tables:[{id:tableB},{id:tableA}]});
    if(url.includes(tableA))return Response.json({row:{id:rowId,taskId,sourceUrl},offset:0});
    return Response.json({error:'行不存在'},{status:404});
  }});
  assert.equal(binding.tableId,tableA);assert.deepEqual(patches,[{onlineTableId:tableA}]);
});

test('继续任务和每个自动步骤都先核验表格绑定，失效时不调用恢复、模型或互拓',async()=>{
  const task={id:taskId,automation:{state:'attention',step:'source'}};let calls=0;
  const engine=new BuyerEngine({workflow:{task:()=>task},providers:{validateTask:async()=>{throw new Error('关联失效');},recover:()=>calls++,source:()=>calls++}});
  await assert.rejects(engine.retry(taskId),/关联失效/);await assert.rejects(engine.step(task),/关联失效/);assert.equal(calls,0);
});

test('删除只移除指定终态任务和本机主图，其他任务与资料目录保留；重启不恢复已删除任务',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buyer-delete-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const workflow=new BuyerWorkflow({dataDir:dir});await workflow.load();
  const task=await workflow.create({sourceType:'douyin',sourceUrl},Buffer.alloc(100));
  const other=await workflow.create({sourceType:'douyin',sourceUrl:'https://v.douyin.com/other/'});
  await workflow.patchAutomation(task.id,{enabled:true,state:'waiting'});
  await assert.rejects(workflow.deleteTask(task.id),/仍在处理/);
  await workflow.patchAutomation(task.id,{state:'attention',inFlight:{kind:'erp'}});
  await assert.rejects(workflow.deleteTask(task.id),/结果未知/);
  await workflow.patchAutomation(task.id,{inFlight:null});
  const product=path.join(dir,'商品资料');await fs.mkdir(product);await fs.writeFile(path.join(product,'回执.txt'),'保留');await workflow.patchTask(task.id,{productFolder:product});
  const result=await workflow.deleteTask(task.id);assert.equal(result.deleted,true);assert.equal(workflow.task(task.id),null);assert.ok(workflow.task(other.id));
  await assert.rejects(fs.access(path.join(workflow.imageDir,task.id+'.jpg')));assert.equal(await fs.readFile(path.join(product,'回执.txt'),'utf8'),'保留');
  const restored=new BuyerWorkflow({dataDir:dir});await restored.load();assert.equal(restored.task(task.id),null);assert.ok(restored.task(other.id));
});
