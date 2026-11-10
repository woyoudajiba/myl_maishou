const test=require('node:test');
const assert=require('node:assert/strict');
const {retryModelJson}=require('../desktop/model-retry');

test('model JSON retries transient failures three times and then returns the valid result',async()=>{
  let calls=0;const waits=[],progress=[];
  const result=await retryModelJson(async()=>{calls++;if(calls<4)throw new Error('模型未返回有效JSON');return{ok:true};},{sleep:async ms=>waits.push(ms),onRetry:async count=>progress.push(count)});
  assert.deepEqual(result,{ok:true});assert.equal(calls,4);assert.deepEqual(progress,[1,2,3]);assert.deepEqual(waits,[250,500,1000]);
});

test('model retry stops immediately for authentication and cancellation errors',async()=>{
  let calls=0;
  await assert.rejects(()=>retryModelJson(async()=>{calls++;throw new Error('模型 API key 无效');},{sleep:async()=>{}}),/API key/);
  assert.equal(calls,1);
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>retryModelJson(async()=>{calls++;throw new Error('网络连接失败');},{signal:controller.signal,sleep:async()=>{}}),/网络连接失败/);
  assert.equal(calls,2);
  await assert.rejects(()=>retryModelJson(async()=>{calls++;throw new Error('HTTP 429 请求过于频繁');},{sleep:async()=>{}}),/429/);
  assert.equal(calls,3);
});
