globalThis.FindVision = (() => {
  const protocol = FindVisionProtocol;
  const active = new Set();
  const cancel = () => { for (const abort of [...active]) abort(); };
  const batchCall = batch => new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'vision-compare' });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearInterval(heartbeat); clearTimeout(deadline); active.delete(abort); port.disconnect();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new Error('request_cancelled：已停止大模型比对'));
    const heartbeat = setInterval(() => port.postMessage({ type: 'ping' }), 15000);
    const deadline = setTimeout(() => finish(new Error('vision_timeout：模型响应超时，本批未判定')), 95000);
    active.add(abort);
    port.onDisconnect.addListener(() => finish(new Error('vision_connection：模型后台连接中断，本批未判定')));
    port.onMessage.addListener(result => result?.ok ? finish(null, result) : finish(new Error(result?.error || 'vision_response：模型未返回可靠结果')));
    port.postMessage({ type: 'compare', batch });
  });
  const fetchImage = async (url, isCancelled) => {
    let lastError;
    for (const sourceUrl of FindImagePolicy.sources(url)) {
      try {
        let response;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (isCancelled()) throw new Error('request_cancelled：已停止候选图片下载');
          response = await chrome.runtime.sendMessage({ type: 'FETCH_PUBLIC_IMAGE', url: sourceUrl });
          if (response?.ok || attempt || !/Failed to fetch|超过12秒|HTTP 50[0234]/i.test(response?.error || '')) break;
        }
        if (!response?.ok) throw new Error(response?.error || '候选图片下载失败');
        const bitmap = await createImageBitmap(await (await fetch(response.dataUrl)).blob());
        try {
          const reason = FindImagePolicy.qualityError(bitmap.width, bitmap.height);
          if (reason) throw new Error(reason);
          const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
          const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
          const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          return { dataUrl: canvas.toDataURL('image/jpeg', 0.92), evidence: { sourceUrl,
            sourceWidth: bitmap.width, sourceHeight: bitmap.height, width: canvas.width, height: canvas.height, upgraded: sourceUrl !== url } };
        } finally { bitmap.close(); }
      } catch (error) { lastError = error; if (isCancelled()) throw error; }
    }
    throw lastError;
  };
  const clearJudgment = item => {
    const copy = { ...item };
    for (const key of Object.keys(copy)) if (key.startsWith('imageSimilarity') || key === 'imageEvidence' || key === 'visualComparison' || key === 'humanReview') delete copy[key];
    return copy;
  };
  const failedItem = (item, error) => ({ ...item, imageSimilarity: null, imageSimilaritySource: protocol.algorithm,
    imageSimilarityEngine: 'qwen_multimodal', imageSimilarityStatus: 'unavailable', imageSimilarityError: error });
  async function scoreItems(query, items, { isCancelled = () => false, onProgress = () => {}, onBatch = () => {}, blockedReason = '', concurrency = FindVisionQueue.defaultConcurrency } = {}) {
    const output = items.map(clearJudgment);
    let processed = 0, scored = 0, failed = 0, lastError = '', halted = false;
    if (items.length > protocol.maxCandidatesPerRun) {
      const error = `vision_input：本次候选超过${protocol.maxCandidatesPerRun}张，请分次搜索或先筛选价格/平台`;
      const unavailable = output.map(item => failedItem(item, error));
      onBatch(unavailable); onProgress({ current: items.length, total: items.length, scored: 0, failed: items.length });
      return { items: unavailable, scored: 0, failed: items.length, error };
    }
    const config = blockedReason ? null : await chrome.runtime.sendMessage({ type: 'VISION_STATUS' });
    if (isCancelled()) return { items: output, scored, failed, cancelled: true };
    if (!config?.ok || !config.configured) {
      lastError = blockedReason || 'vision_not_configured：请先设置视觉大模型，当前没有执行识别';
      const unavailable = output.map(item => failedItem(item, lastError));
      onBatch(unavailable); onProgress({ current: items.length, total: items.length, scored: 0, failed: items.length });
      return { items: unavailable, scored: 0, failed: items.length, error: lastError };
    }
    // Bound decoded image memory and model requests by the same worker limit.
    await FindVisionQueue.run(Math.ceil(output.length / protocol.batchSize), concurrency, () => halted || isCancelled(), async batchIndex => {
      const start = batchIndex * protocol.batchSize;
      const slice = output.slice(start, start + protocol.batchSize), imageCache = new Map(), ready = [];
      await Promise.all(slice.map(async (item, index) => {
        try {
          if (halted || isCancelled()) return;
          if (!imageCache.has(item.imageUrl)) imageCache.set(item.imageUrl, fetchImage(item.imageUrl, isCancelled));
          const image = await imageCache.get(item.imageUrl);
          if (halted || isCancelled()) return;
          output[start + index] = { ...output[start + index], imageEvidence: image.evidence };
          ready.push({ index: start + index, id: 'candidate_' + (start + index + 1), dataUrl: image.dataUrl });
        } catch (error) { if (!isCancelled()) { output[start + index] = failedItem(item, String(error.message || error).slice(0, 180)); failed++; } }
      }));
      if (isCancelled()) return;
      if (ready.length && !halted) {
        ready.sort((a, b) => a.index - b.index);
        onProgress({ current: processed, total: items.length, scored, failed, batch: ready.length, model: config.model });
        try {
          const response = await batchCall({ query, candidates: ready.map(({ id, dataUrl }) => ({ id, dataUrl })) });
          if (isCancelled()) return;
          const judgments = new Map(response.results.map(item => [item.id, item]));
          if (response.results.length !== ready.length || judgments.size !== ready.length || ready.some(entry => !judgments.has(entry.id))) throw new Error('模型结果编号不完整或重复，本批未判定');
          for (const entry of ready) {
            const judgment = judgments.get(entry.id);
            output[entry.index] = { ...output[entry.index], imageSimilarity: judgment.score == null ? null : judgment.score / 100,
              imageSimilaritySource: protocol.algorithm, imageSimilarityEngine: response.model,
              imageSimilarityStatus: 'compared', visualComparison: judgment };
            scored++;
          }
        } catch (error) {
          if (isCancelled()) return;
          lastError ||= String(error.message || error).slice(0, 180);
          halted = true;
          for (const entry of ready) { output[entry.index] = failedItem(output[entry.index], String(error.message || error).slice(0, 180)); failed++; }
        }
      }
      processed += slice.length;
      onBatch(output.slice(start, start + slice.length));
      onProgress({ current: processed, total: items.length, scored, failed, model: config.model });
    });
    if (halted && !isCancelled()) {
      const untouched = [];
      output.forEach((item, index) => {
        if (item.imageSimilarityStatus !== 'compared' && item.imageSimilarityStatus !== 'unavailable') {
          output[index] = { ...failedItem(item, '其他批次未取得结果，已暂停；本商品尚未提交模型'), imageSimilarityStatus: 'not_started' };
          untouched.push(output[index]);
        }
      });
      if (untouched.length) onBatch(untouched);
    }
    return { items: output, scored, failed, cancelled: isCancelled(), error: lastError, engine: config.model };
  }
  const markUnavailable = (items, error) => items.map(item => failedItem(item, error));
  return { algorithm: protocol.algorithm, labels: protocol.labels, batchSize: protocol.batchSize,
    maxCandidatesPerRun: protocol.maxCandidatesPerRun, clearJudgment, markUnavailable, scoreItems, cancel };
})();
