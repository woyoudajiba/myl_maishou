const test=require('node:test'),assert=require('node:assert/strict');
const {waitForBuyerPage}=require('../buyer-page');
test('来源采集等待动态页面超过旧4秒窗口，直到标题和主图齐备，不把首个空结果当失败',async()=>{
  let calls=0,waits=0;
  const result=await waitForBuyerPage({read:async()=>++calls<12?{title:'',images:[]}:{title:'外套',images:['https://p3-item.ecombdimg.com/main.webp']},sleep:async()=>{waits++;}});
  assert.equal(calls,12);assert.equal(waits,11);assert.equal(result.title,'外套');
});
test('已确认登录或验证立即阻塞；无图片的错误明确区分于登录失败',async()=>{
  let reads=0;
  await assert.rejects(()=>waitForBuyerPage({read:async()=>{reads++;return{error:'平台需要登录，请在浏览器登录后重试'};},sleep:async()=>{}}),/平台需要登录/);assert.equal(reads,1);
  await assert.rejects(()=>waitForBuyerPage({read:async()=>({title:'外套',images:[]}),sleep:async()=>{},attempts:2}),error=>/未识别到商品主图/.test(error.message)&&!/登录/.test(error.message));
});
