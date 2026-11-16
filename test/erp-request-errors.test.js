const test=require('node:test'),assert=require('node:assert/strict');
const managed={erpManaged:true,erpBaseUrl:'https://wsfile.cn/maishou/api',erpToken:'fixture'};

test('查重POST是只读查询，失败不会被误报成写入结果未知，原业务信息不泄漏',async()=>{
  const {ErpClient}=await import('../desktop/erp/client.mjs');
  let calls=0;
  const client=new ErpClient(managed,{fetchImpl:async()=>{calls++;return Response.json({code:500,msg:'private database details',data:null});}});
  await assert.rejects(()=>client.productPage({articleNo:'6803'}),error=>error.ambiguous===false&&error.code===500&&/查重未成功/.test(error.message)&&!/private/.test(error.message));
  assert.equal(calls,1,'查重失败不自动扩大请求压力或跳过查重');
  const network=new ErpClient(managed,{fetchImpl:async()=>{throw new TypeError('private upstream');}});
  await assert.rejects(()=>network.productPage({}),error=>!error.ambiguous&&error.code==='ERP_NETWORK'&&/查重/.test(error.message));
  await assert.rejects(()=>network.request('/erp/product-draft/add',{method:'POST',body:{}}),error=>error.ambiguous===true&&/原记录/.test(error.message));
});

test('托管查询等待覆盖原代理时限且包含响应体，取消与超时区分并只发送一次',async t=>{
  const {ErpClient}=await import('../desktop/erp/client.mjs');
  t.mock.timers.enable({apis:['setTimeout']});
  let signal,calls=0;
  const client=new ErpClient(managed,{fetchImpl:async(_url,options)=>{calls++;signal=options.signal;return new Promise(resolve=>setTimeout(()=>resolve(Response.json({code:0,data:{list:[],total:0}})),31000));}});
  const pending=client.productPage({articleNo:'6803'});t.mock.timers.tick(31000);
  assert.deepEqual(await pending,{list:[],total:0});assert.equal(signal.aborted,false);assert.equal(calls,1);
  const cancelled=new AbortController();
  const stalled=new ErpClient(managed,{fetchImpl:async(_url,options)=>({ok:true,status:200,text:()=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('abort')),{once:true}))})});
  const body=stalled.productPage({},cancelled.signal);await Promise.resolve();cancelled.abort();
  await assert.rejects(()=>body,error=>error.code==='ERP_CANCELLED'&&!error.ambiguous&&/已取消/.test(error.message));
});

test('托管查重等待可覆盖110秒代理上限，且不会自动重复请求',async t=>{
  const {ErpClient}=await import('../desktop/erp/client.mjs');
  t.mock.timers.enable({apis:['setTimeout']});
  let signal,calls=0;
  const client=new ErpClient(managed,{fetchImpl:async(_url,options)=>{calls++;signal=options.signal;return new Promise(resolve=>setTimeout(()=>resolve(Response.json({code:0,data:{list:[],total:0}})),72000));}});
  const pending=client.productPage({articleNo:'6803'});t.mock.timers.tick(72000);
  assert.deepEqual(await pending,{list:[],total:0});assert.equal(signal.aborted,false);assert.equal(calls,1);
});

test('云端互拓代理超时码显示为可诊断原因但不泄漏响应内容',async()=>{
  const {ErpClient}=await import('../desktop/erp/client.mjs');
  const client=new ErpClient(managed,{fetchImpl:async()=>new Response(JSON.stringify({code:'ERP_UPSTREAM_TIMEOUT',error:'private upstream details'}),{status:503,headers:{'content-type':'application/json'}})});
  await assert.rejects(()=>client.productPage({articleNo:'6803'}),error=>error.code==='ERP_UPSTREAM_TIMEOUT'&&/上游超过代理等待时限/.test(error.message)&&!/private upstream/.test(error.message)&&error.ambiguous===false);
});
