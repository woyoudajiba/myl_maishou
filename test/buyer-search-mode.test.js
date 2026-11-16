const test=require('node:test');
const assert=require('node:assert/strict');
const {createBuyerProviders}=require('../desktop/buyer-providers');

test('自动买手把选择的供应商搜索档位传到浏览器命令',async()=>{
  const sent=[];
  const workflow={image:async()=>Buffer.from('fixture-image'),patchAutomation:async()=>{}};
  const bridge={
    snapshot:()=>({browserClient:{state:'ready'},browserCommands:[]}),
    enqueueBuyerBrowser:async input=>{sent.push(input);return{id:'command-1',status:'queued',kind:input.kind}},
  };
  const settings={erp:async()=>({})};
  const providers=createBuyerProviders({workflow,bridge,settings,model:()=>null,signal:new AbortController().signal});
  const task={id:'00000000-0000-4000-8000-000000000001',automation:{searchMode:'detail',checkpoints:{}}};
  const result=await providers.searchSuppliers(task);
  assert.equal(result.waiting,true);
  assert.equal(sent[0].searchMode,'detail');
  task.automation.searchMode='top';task.automation.checkpoints={};
  await providers.searchSuppliers(task);
  assert.equal(sent[1].searchMode,'top');
});
