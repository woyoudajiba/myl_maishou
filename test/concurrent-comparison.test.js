const test = require('node:test');
const assert = require('node:assert/strict');
const { compareCandidates } = require('../desktop/comparison');
const { metadata } = require('../desktop/models');
const waitUntil = async predicate => { for (let i=0; i<100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(predicate()); };
const fixture = () => {
  const pending = [], history = [];
  let active = 0, peak = 0;
  const controller = new AbortController();
  const options = {
    config: { model: 'fixture' }, signal: controller.signal, allowed: () => true,
    downloadImage: async () => ({ buffer: Buffer.from('image'), dataUrl: 'fixture', evidence: { width: 800, height: 800 } }),
    saveImage: async index => String(index).padStart(64,'0'),
    invoke: async (_config, batch) => {
      active++; peak=Math.max(peak,active);
      try { return await new Promise((resolve,reject) => pending.push({
        ids: batch.candidates.map(entry=>entry.id), reject,
        resolve: () => resolve({ model:'fixture', judgments: batch.candidates.map(entry=>({ id:entry.id, verdict:'similar', score: Number(entry.id.split('_')[1]), matches:[], differences:[], uncertainties:[] })).reverse() })
      })); } finally { active--; }
    }
  };
  const start = count => compareCandidates({ query:'query', items:Array.from({length:count},(_,id)=>({id:String(id+1),imageUrl:'https://imgcdn.wsy.com/'+id+'.jpg'})) },
    async patch => { await new Promise(resolve=>setTimeout(resolve,1)); history.push(structuredClone(patch)); }, options);
  return { options, controller, pending, history, start, get peak(){return peak;} };
};
test('默认3批真正并发，乱序回执不串图；保存完整在途集合，成功结果不会被进度覆盖', async () => {
  const f=fixture(), running=f.start(16);
  await waitUntil(()=>f.pending.length===3);
  assert.equal(f.peak,3);
  assert.deepEqual(f.history.at(-1).inFlight,Array.from({length:12},(_,i)=>i));
  f.pending[2].resolve();
  await waitUntil(()=>f.pending.length===4);
  f.pending[3].resolve(); f.pending[0].resolve(); f.pending[1].resolve();
  await running;
  const last=f.history.at(-1);
  assert.equal(last.status,'complete');assert.equal(last.compared,16);assert.equal(last.notStarted,0);
  assert.deepEqual(last.inFlight,[]);assert.equal(last.concurrency,3);
  last.items.forEach((item,index)=>assert.equal(item.visualComparison.id,'candidate_'+(index+1)));
  last.items.forEach((item,index)=>assert.equal(item.visualComparison.score,index+1));
  const progress=f.history.map(patch=>patch.completed);
  assert.deepEqual(progress,[...progress].sort((a,b)=>a-b));
});
test('并发504停止新批派发，等待其他已发请求并保存成功项，剩余项明确尚未提交且不重试', async () => {
  const f=fixture(), running=f.start(20);
  await waitUntil(()=>f.pending.length===3);
  f.pending[1].reject(new Error('HTTP 504：上游超时'));
  await waitUntil(()=>f.history.some(patch=>patch.failed===4));
  assert.equal(f.pending.length,3);
  f.pending[2].resolve();f.pending[0].resolve();await running;
  const last=f.history.at(-1);
  assert.equal(last.status,'partial');assert.equal(last.compared,8);assert.equal(last.failed,4);assert.equal(last.notStarted,8);
  assert.match(last.error,/504/);assert.equal(f.pending.length,3);
  assert.equal(last.items[0].imageSimilarityStatus,'compared');
  assert.equal(last.items[4].imageSimilarityStatus,'unavailable');
  assert.equal(last.items[12].imageSimilarityStatus,'not_started');
});
test('退出取消覆盖所有并发在途请求，迟到回执不变成成功，未来批不提交', async () => {
  const f=fixture(), running=f.start(16);await waitUntil(()=>f.pending.length===3);
  f.controller.abort();f.pending.forEach(call=>call.resolve());await running;
  const last=f.history.at(-1);
  assert.equal(last.status,'partial');assert.equal(last.compared,0);assert.equal(last.failed,12);assert.equal(last.notStarted,4);
  assert.deepEqual(last.inFlight,[]);assert.equal(f.pending.length,3);
});
test('并发配置限制1～4，可持久化的默认值为3；串行保留给慢速服务', () => {
  const base={name:'fixture',model:'vision',endpoint:'https://model.example/v1'};
  assert.equal(metadata(base).concurrency,3);
  for(const concurrency of [1,2,3,4])assert.equal(metadata({...base,concurrency}).concurrency,concurrency);
  for(const concurrency of [0,5,-1,1.5,'4',null])assert.throws(()=>metadata({...base,concurrency}),/并发/);
});
