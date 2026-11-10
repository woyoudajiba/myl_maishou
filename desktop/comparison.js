const protocol = require('../vision-protocol');
const queue = require('../vision-queue');
const failure = (item, message, model, status = 'unavailable') => ({ ...item, imageSimilarity: null,
  imageSimilaritySource: protocol.algorithm, imageSimilarityEngine: model, imageSimilarityStatus: status, imageSimilarityError: message });

async function compareCandidates(job, update, { config, signal, allowed, downloadImage, saveImage, invoke }) {
  const output = job.items.map(item => ({ ...item }));
  const pending = output.map((item, index) => ({ item, index })).filter(({ item }) => !item.visualComparison && item.imageSimilarityStatus !== 'unavailable');
  const batchSize = job.batchSize === 1 ? 1 : protocol.batchSize;
  const concurrency = queue.concurrency(config.concurrency);
  const inFlight = new Set();
  let halted = '', writes = Promise.resolve();
  const stopped = () => !!halted || signal.aborted || !allowed();
  // Serialize durable progress with the complete union of all in-flight IDs.
  // Snapshot at execution time so a slower earlier write cannot erase results.
  const patch = (extra = {}) => {
    const operation = writes.then(async () => {
      const compared = output.filter(item => item.visualComparison).length;
      const failed = output.filter(item => !item.visualComparison && item.imageSimilarityStatus === 'unavailable').length;
      const completed = compared + failed;
      await update({ items: structuredClone(output), completed, compared, failed, notStarted: output.length - completed,
        progress: Math.floor(completed * 100 / output.length), status: 'processing', concurrency, inFlight: [...inFlight].sort((a,b) => a-b), ...extra });
    });
    writes = operation;
    return operation;
  };
  await patch();
  await queue.run(Math.ceil(pending.length / batchSize), concurrency, stopped, async batchIndex => {
    const slice = pending.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize), ready = [];
    const cache = new Map();
    await Promise.all(slice.map(async ({ item, index }) => {
      try {
        if (!item.imageUrl) throw new Error('候选图片地址缺失');
        if (stopped()) return;
        if (!cache.has(item.imageUrl)) cache.set(item.imageUrl, downloadImage(item.imageUrl, signal));
        const image = await cache.get(item.imageUrl);
        if (stopped()) return;
        const sha256 = await saveImage(index, image.buffer);
        output[index] = { ...item, imageEvidence: { ...image.evidence, sha256 } };
        ready.push({ index, dataUrl: image.dataUrl, id: 'candidate_' + (index + 1) });
      } catch (error) {
        output[index] = failure(item, signal.aborted ? '账号已退出，图片下载已停止' : String(error?.message || error).slice(0, 180), config.model);
      }
    }));
    ready.sort((a, b) => a.index - b.index);
    if (!ready.length || stopped()) { await patch(); return; }
    try {
      ready.forEach(entry => inFlight.add(entry.index));
      await patch();
      if (stopped()) { ready.forEach(entry => inFlight.delete(entry.index)); return; }
      const result = await invoke(config, { query: job.query, candidates: ready.map(({ id, dataUrl }) => ({ id, dataUrl })) }, { signal });
      if (signal.aborted || !allowed()) throw new Error('账号已退出，请求已停止');
      const judgments = result.judgments;
      const byId = new Map(judgments.map(item => [item.id, item]));
      if (judgments.length !== ready.length || byId.size !== ready.length || ready.some(({ id }) => !byId.has(id))) throw new Error('模型结果编号不完整或重复，本批未判定');
      for (const { index, id } of ready) {
        const judgment = byId.get(id);
        output[index] = { ...output[index], imageSimilarity: judgment.score == null ? null : judgment.score / 100,
          imageSimilaritySource: protocol.algorithm, imageSimilarityEngine: result.model,
          imageSimilarityStatus: 'compared', visualComparison: judgment };
      }
    } catch (error) {
      const message = signal.aborted ? '账号已退出，请求已停止；本批可能已计费，不会自动重试' : String(error?.message || error).slice(0, 220);
      if (!job.continueOnFailure) halted ||= message;
      for (const { index } of ready) output[index] = failure(output[index], message, config.model);
    } finally {
      ready.forEach(entry => inFlight.delete(entry.index));
      await patch();
    }
  });
  const interrupted = halted || signal.aborted || !allowed();
  if (interrupted) for (const { index } of pending) {
    if (!output[index].visualComparison && output[index].imageSimilarityStatus !== 'unavailable') output[index] = failure(output[index],
      signal.aborted || !allowed() ? '账号已退出；本商品尚未提交模型' : '其他批次未取得结果，已暂停；本商品尚未提交模型', config.model, 'not_started');
  }
  const failed = output.filter(item => !item.visualComparison).length;
  await patch({ status: failed ? 'partial' : 'complete', error: halted || (signal.aborted || !allowed() ? '账号已退出，剩余候选尚未识别' : failed ? failed + ' 张未识别，请查看各商品原因并重试' : ''), inFlight: [] });
}
module.exports = { compareCandidates };
