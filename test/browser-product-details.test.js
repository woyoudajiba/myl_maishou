const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDesktopBridge } = require('../desktop/bridge-server');
const review = require('../review');

test('详情采集命令必须等人工确认疑似同款；限定平台来源、去重入队、回执关联并持久化图片和资料', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'product-detail-queue-'));
  let bridge;
  t.after(async () => { await bridge?.close(); await fs.rm(dataDir, { recursive:true, force:true }); });
  bridge=createDesktopBridge({ dataDir, port:0, canProcess:()=>true, processJob:async(job,update)=>{
    const item={...job.items[0],imageSimilaritySource:'qwen_multimodal_v1',imageSimilarityStatus:'compared',imageSimilarity:.92,
      visualComparison:{id:'candidate_1',verdict:'likely_same',score:92,matches:['图案和版型一致'],differences:[],uncertainties:[]}};
    const reviewed=review.apply(item,{verdict:'likely_same',score:95,note:''});
    await update({items:[reviewed],compared:1,completed:1,progress:100,status:'complete'});
  }});
  const local=await bridge.start(), headers={'Content-Type':'application/json','X-Desktop-Token':local.token};
  const response=await fetch(`http://127.0.0.1:${local.port}/v1/jobs`,{method:'POST',headers,body:JSON.stringify({query:'data:image/jpeg;base64,YQ==',items:[{id:'candidate',platform:'qcc',title:'供应商同款',imageUrl:'https://pics.17qcc.com/one.jpg',detailUrl:'https://www.17qcc.com/item/123.html'}]})});
  const accepted=await response.json(), jobId=accepted.id;
  for(let i=0;i<100&&bridge.snapshot().jobs[0].status!=='complete';i++)await new Promise(r=>setTimeout(r,10));
  await bridge.reviewItem(jobId,0,{verdict:'different',note:'款式细节不一致'},review.signature(bridge.snapshot().jobs[0].items[0]));
  await assert.rejects(bridge.enqueueDetails(jobId,0),/确认该商品为疑似同款/);
  const item=bridge.snapshot().jobs[0].items[0];
  await bridge.reviewItem(jobId,0,{verdict:'likely_same',score:97,note:'人工确认是同款'},review.signature(item));
  const command=await bridge.enqueueDetails(jobId,0);
  assert.equal((await bridge.enqueueDetails(jobId,0)).id,command.id);
  await assert.rejects(bridge.deleteJobs([jobId]),/详情正在等待浏览器采集/);
  const malformed=await fetch(`http://127.0.0.1:${local.port}/v1/browser-commands/${command.id}/ack`,{method:'POST',headers,body:JSON.stringify({status:'accepted',result:{title:'同款衬衫',price:36,sku:'A123',shopName:'工厂店',description:'纯棉翻领',attributes:['成分：100%棉'],images:['https://pics.17qcc.com/main.jpg','https://evil.example/tracker.jpg','http://127.0.0.1/private.jpg'],imageGroups:{main:['https://pics.17qcc.com/main.jpg'],details:['https://evil.example/tracker.jpg']},quality:{state:'complete',pageRole:'supplier',missingFields:[],imageCoverage:{detailNodes:1,detailImages:1,placeholders:0,complete:true}},visibleText:'商品详情'}})});
  assert.equal(malformed.status,200);
  const result=bridge.snapshot().jobs[0].items[0].productDetails;
  assert.equal(result.title,'同款衬衫');assert.equal(result.price,36);assert.equal(result.images.length,1);assert.equal(result.images[0],'https://pics.17qcc.com/main.jpg');assert.deepEqual(result.imageGroups,{main:['https://pics.17qcc.com/main.jpg'],colors:[],details:[]});assert.equal(result.quality.imageCoverage.complete,true);assert.equal(result.visibleText,'商品详情');
  const replay=await fetch(`http://127.0.0.1:${local.port}/v1/browser-commands/${command.id}/ack`,{method:'POST',headers,body:JSON.stringify({status:'accepted',result:{title:'被重放的结果'}})});
  assert.equal(replay.status,409);
  await bridge.close();bridge=createDesktopBridge({dataDir,port:0,canProcess:()=>true,processJob:async()=>{}});await bridge.start();
  assert.equal(bridge.snapshot().jobs[0].items[0].productDetails.sku,'A123');
});
