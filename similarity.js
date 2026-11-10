// Local, privacy-preserving image comparison. Platform scores remain separate.
globalThis.FindSimilarity = (() => {
  const SIZE = 32;
  const HASH_SIDE = 8;
  const ALGORITHM = 'fashionclip_rank_v2';
  const MODEL_ENGINE = 'marqo_fashionclip_webgpu';
  const FALLBACK_ENGINE = 'local_structure_fallback_v5';
  const THRESHOLDS = Object.freeze({ high: 0.85, review: 0.6 });
  const clamp = value => Math.max(0, Math.min(1, value));
  const validImageUrl = value => {
    try { const url = new URL(String(value || '')); return /^https?:$/.test(url.protocol) ? url.href : ''; }
    catch { return ''; }
  };
  const loadImage = dataUrl => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image_match：商品图片无法读取'));
    image.src = dataUrl;
  });
  const features = async dataUrl => {
    const image = await loadImage(dataUrl);
    const canvas = document.createElement('canvas'); canvas.width = SIZE; canvas.height = SIZE;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff'; context.fillRect(0, 0, SIZE, SIZE);
    const scale = Math.min(SIZE / image.naturalWidth, SIZE / image.naturalHeight);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    context.drawImage(image, Math.round((SIZE - width) / 2), Math.round((SIZE - height) / 2), width, height);
    const pixels = context.getImageData(0, 0, SIZE, SIZE).data;
    const luminancePixels = new Float32Array(SIZE * SIZE);
    const gray = new Array(HASH_SIDE * HASH_SIDE).fill(0);
    const edges = new Array(HASH_SIDE * HASH_SIDE).fill(0);
    const orientationBins = new Array(HASH_SIDE * HASH_SIDE * 4).fill(0);
    const histogram = new Array(64).fill(0);
    const meanColor = [0, 0, 0];
    const border = [[], [], []];
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const offset = (y * SIZE + x) * 4;
      const red = pixels[offset], green = pixels[offset + 1], blue = pixels[offset + 2];
      meanColor[0] += red; meanColor[1] += green; meanColor[2] += blue;
      if (x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1) {
        border[0].push(red); border[1].push(green); border[2].push(blue);
      }
      const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
      luminancePixels[y * SIZE + x] = luminance;
      const cell = Math.floor(y / (SIZE / HASH_SIDE)) * HASH_SIDE + Math.floor(x / (SIZE / HASH_SIDE));
      gray[cell] += luminance;
    }
    const cellPixels = (SIZE / HASH_SIDE) ** 2;
    gray.forEach((value, index) => { gray[index] = value / cellPixels; });
    const average = gray.reduce((sum, value) => sum + value, 0) / gray.length;
    const deviation = Math.sqrt(gray.reduce((sum, value) => sum + (value - average) ** 2, 0) / gray.length) || 1;
    const spatial = gray.map(value => clamp(0.5 + (value - average) / (deviation * 5)));
    const hash = gray.map(value => value >= average ? 1 : 0);

    const median = values => {
      values.sort((left, right) => left - right);
      const middle = Math.floor(values.length / 2);
      return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    };
    const background = border.map(median);
    const foreground = new Float32Array(SIZE * SIZE);
    let foregroundTotal = 0;
    for (let index = 0; index < SIZE * SIZE; index++) {
      const offset = index * 4;
      const distance = Math.sqrt(
        ((pixels[offset] - background[0]) ** 2 + (pixels[offset + 1] - background[1]) ** 2 + (pixels[offset + 2] - background[2]) ** 2) / 3
      ) / 255;
      const weight = clamp((distance - 0.055) / 0.22);
      foreground[index] = weight;
      foregroundTotal += weight;
    }
    // Uniform or very pale images do not provide a useful border-derived mask.
    if (foregroundTotal < SIZE * SIZE * 0.015) foreground.fill(1);

    const silhouette = new Array(HASH_SIDE * HASH_SIDE).fill(0);
    const localColorSums = Array.from({ length: 16 }, () => [0, 0, 0]);
    const localColorPlainSums = Array.from({ length: 16 }, () => [0, 0, 0]);
    const localColorWeights = new Array(16).fill(0);
    const localColorPresence = new Array(16).fill(0);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const index = y * SIZE + x, offset = index * 4, mask = foreground[index];
      const cell8 = Math.floor(y / (SIZE / HASH_SIDE)) * HASH_SIDE + Math.floor(x / (SIZE / HASH_SIDE));
      const cell4 = Math.floor(y / (SIZE / 4)) * 4 + Math.floor(x / (SIZE / 4));
      silhouette[cell8] += mask / cellPixels;
      localColorPresence[cell4] += mask / ((SIZE / 4) ** 2);
      localColorWeights[cell4] += mask;
      for (let channel = 0; channel < 3; channel++) {
        const value = pixels[offset + channel] / 255;
        localColorSums[cell4][channel] += value * mask;
        localColorPlainSums[cell4][channel] += value;
      }
      const bucket = (pixels[offset] >> 6) * 16 + (pixels[offset + 1] >> 6) * 4 + (pixels[offset + 2] >> 6);
      histogram[bucket] += mask;
    }
    const localColor = localColorSums.map((sum, index) => {
      const weight = localColorWeights[index];
      const denominator = weight > 0.25 ? weight : (SIZE / 4) ** 2;
      const source = weight > 0.25 ? sum : localColorPlainSums[index];
      return source.map(value => value / denominator);
    });
    for (let y = 1; y < SIZE - 1; y++) for (let x = 1; x < SIZE - 1; x++) {
      const at = (dx, dy) => luminancePixels[(y + dy) * SIZE + x + dx];
      const horizontal = -at(-1,-1) + at(1,-1) - 2 * at(-1,0) + 2 * at(1,0) - at(-1,1) + at(1,1);
      const vertical = -at(-1,-1) - 2 * at(0,-1) - at(1,-1) + at(-1,1) + 2 * at(0,1) + at(1,1);
      const cell = Math.floor(y / (SIZE / HASH_SIDE)) * HASH_SIDE + Math.floor(x / (SIZE / HASH_SIDE));
      const weight = Math.max(
        foreground[y * SIZE + x], foreground[y * SIZE + x - 1], foreground[y * SIZE + x + 1],
        foreground[(y - 1) * SIZE + x], foreground[(y + 1) * SIZE + x]
      );
      const magnitude = Math.hypot(horizontal, vertical) * weight;
      edges[cell] += magnitude;
      let angle = Math.atan2(vertical, horizontal);
      if (angle < 0) angle += Math.PI;
      const orientation = Math.min(3, Math.floor(angle / Math.PI * 4));
      orientationBins[cell * 4 + orientation] += magnitude;
    }
    const edgeTotal = edges.reduce((sum, value) => sum + value, 0);
    const normalizedEdges = edgeTotal ? edges.map(value => value / edgeTotal) : edges;
    const orientationTotal = orientationBins.reduce((sum, value) => sum + value, 0);
    const normalizedOrientation = orientationTotal ? orientationBins.map(value => value / orientationTotal) : orientationBins;
    const histogramTotal = histogram.reduce((sum, value) => sum + value, 0) || 1;
    return {
      hash, spatial, edges: normalizedEdges, orientation: normalizedOrientation,
      histogram: histogram.map(value => value / histogramTotal),
      meanColor: meanColor.map(value => value / (SIZE * SIZE * 255)),
      silhouette, localColor, localColorPresence, hasEdges: edgeTotal > 0, hasOrientation: orientationTotal > 0
    };
  };
  const compareFeatures = (left, right) => {
    if (!left?.hash || !right?.hash || !left?.spatial || !right?.spatial || !left?.edges || !right?.edges || !left?.orientation || !right?.orientation || !left?.histogram || !right?.histogram || !left?.meanColor || !right?.meanColor || !left?.silhouette || !right?.silhouette || !left?.localColor || !right?.localColor || !left?.localColorPresence || !right?.localColorPresence) return null;
    let equal = 0; for (let i = 0; i < left.hash.length; i++) if (left.hash[i] === right.hash[i]) equal++;
    let histogramIntersection = 0, orientationIntersection = 0, silhouetteDistance = 0;
    for (let i = 0; i < left.histogram.length; i++) histogramIntersection += Math.min(left.histogram[i], right.histogram[i]);
    for (let i = 0; i < left.orientation.length; i++) orientationIntersection += Math.min(left.orientation[i], right.orientation[i]);
    let spatialDistance = 0, edgeIntersection = 0;
    for (let i = 0; i < left.spatial.length; i++) spatialDistance += Math.abs(left.spatial[i] - right.spatial[i]);
    for (let i = 0; i < left.edges.length; i++) edgeIntersection += Math.min(left.edges[i], right.edges[i]);
    for (let i = 0; i < left.silhouette.length; i++) silhouetteDistance += Math.abs(left.silhouette[i] - right.silhouette[i]);
    const colorDistance = Math.sqrt(left.meanColor.reduce((sum, value, index) => sum + (value - right.meanColor[index]) ** 2, 0) / 3);
    const colorSimilarity = clamp(1 - colorDistance);
    const spatialSimilarity = clamp(1 - spatialDistance / left.spatial.length);
    let localColorDistance = 0, localColorWeight = 0;
    for (let cell = 0; cell < left.localColor.length; cell++) {
      const weight = Math.max(left.localColorPresence[cell], right.localColorPresence[cell]);
      if (weight <= 0.015) continue;
      const distance = Math.sqrt(left.localColor[cell].reduce((sum, value, channel) => sum + (value - right.localColor[cell][channel]) ** 2, 0) / 3);
      localColorDistance += distance * weight;
      localColorWeight += weight;
    }
    const localColorSimilarity = localColorWeight ? clamp(1 - localColorDistance / localColorWeight) : colorSimilarity;
    const silhouetteSimilarity = clamp(1 - silhouetteDistance / left.silhouette.length);
    const edgeSimilarity = left.hasEdges || right.hasEdges ? edgeIntersection : 1;
    const orientationSimilarity = left.hasOrientation || right.hasOrientation ? orientationIntersection : 1;
    return clamp(
      equal / left.hash.length * 0.12 + spatialSimilarity * 0.14 + edgeSimilarity * 0.12 +
      histogramIntersection * 0.08 + colorSimilarity * 0.05 + localColorSimilarity * 0.15 +
      silhouetteSimilarity * 0.18 + orientationSimilarity * 0.16
    );
  };
  const classify = score => {
    if (!Number.isFinite(score)) return 'unavailable';
    if (score >= THRESHOLDS.high) return 'high';
    if (score >= THRESHOLDS.review) return 'review';
    return 'low';
  };
  const fetchImage = async url => {
    const target = validImageUrl(url);
    if (!target) throw new Error('image_match：商品图片地址无效');
    if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('image_match：扩展后台不可用');
    const response = await chrome.runtime.sendMessage({ type: 'FETCH_PUBLIC_IMAGE', url: target });
    if (!response?.ok || !response.dataUrl) throw new Error(response?.error || 'image_match：图片下载失败');
    return response.dataUrl;
  };
  const bounded = (promise, ms = 15000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`image_match：单张图片判断超过${ms / 1000}秒`)), ms);
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  let modelWorker = null, modelUnavailable = false, nextWorkerRequest = 0;
  const workerRequests = new Map();
  const stopWorker = error => {
    modelWorker?.terminate(); modelWorker = null;
    workerRequests.forEach(request => request.reject(error));
    workerRequests.clear();
  };
  const cancel = () => stopWorker(new Error('request_cancelled：已停止本地图像判断'));
  const getModelWorker = () => {
    if (modelWorker) return modelWorker;
    if (typeof Worker !== 'function') throw new Error('model_unavailable：当前环境不支持本地模型 Worker');
    const worker = modelWorker = new Worker(chrome.runtime.getURL('similarity-worker.js'), { type: 'module' });
    worker.onmessage = event => {
      const message = event.data || {}, pending = workerRequests.get(message.id);
      if (!pending) return;
      if (message.type === 'progress') { pending.onProgress?.(message); return; }
      workerRequests.delete(message.id);
      if (message.type === 'result') pending.resolve(message);
      else pending.reject(new Error(message.error || 'model_inference：本地模型不可用'));
    };
    worker.onerror = event => {
      if (modelWorker !== worker) return;
      const error = new Error(`model_worker：${String(event.message || '本地模型工作线程失败').slice(0,120)}`);
      modelUnavailable = true; stopWorker(error);
    };
    return modelWorker;
  };
  const modelCall = (type, payload, onProgress) => new Promise((resolve, reject) => {
    if (modelUnavailable) { reject(new Error('model_unavailable：本地服装模型此前未能启动')); return; }
    const id = ++nextWorkerRequest;
    workerRequests.set(id, { resolve, reject, onProgress });
    try { getModelWorker().postMessage({ id, type, ...payload }); }
    catch (error) { workerRequests.delete(id); reject(error); }
  });
  const modelSimilarity = (left, right, onProgress) => modelCall('score', { query: left, candidate: right }, onProgress);
  async function scoreItems(queryDataUrl, items, { isCancelled = () => false, onProgress = () => {} } = {}) {
    const output = new Array(items.length); const imageCache = new Map();
    let processed = 0, scored = 0, failed = 0, modelReady = false, fallbackUsed = false, fallbackReason = '';
    let fallbackQueryPromise = null;
    const fetchCached = url => {
      const target = validImageUrl(url);
      if (!imageCache.has(target)) imageCache.set(target, fetchImage(target));
      return imageCache.get(target);
    };
    for (let index = 0; index < items.length; index++) {
      if (isCancelled()) break;
      const item = { ...items[index] };
      try {
        const candidateData = await fetchCached(item.imageUrl);
        if (isCancelled()) break;
        let score;
        try {
          const result = await bounded(modelSimilarity(queryDataUrl, candidateData, onProgress), 90000);
          score = result.cosine;
          item.imageSimilarityEngine = MODEL_ENGINE;
          modelReady = true;
          onProgress({ type: 'model_ready', current: processed, total: items.length });
        } catch (error) {
          if (isCancelled()) break;
          if (modelReady) throw error;
          modelUnavailable = true;
          stopWorker(error);
          fallbackUsed = true;
          fallbackReason = String(error.message || error).slice(0,160);
          onProgress({ type: 'model_fallback', message: fallbackReason });
          fallbackQueryPromise ||= features(queryDataUrl);
          const query = await fallbackQueryPromise;
          const candidate = await bounded(features(candidateData));
          score = compareFeatures(query, candidate);
          item.imageSimilarityEngine = FALLBACK_ENGINE;
          item.imageSimilarityFallbackReason = fallbackReason;
        }
        if (isCancelled()) break;
        const normalizedScore = item.imageSimilarityEngine === MODEL_ENGINE ? (score + 1) / 2 : score;
        item.imageSimilarity = score == null ? null : Math.max(0, Math.min(1, normalizedScore));
        item.imageSimilaritySource = ALGORITHM;
        item.imageSimilarityLabel = item.imageSimilarityEngine === MODEL_ENGINE ? 'rank' : classify(item.imageSimilarity);
        item.imageSimilarityStatus = item.imageSimilarity == null ? 'unavailable' : 'scored';
        if (item.imageSimilarity == null) failed++; else scored++;
      } catch (error) {
        if (isCancelled()) break;
        item.imageSimilarity = null;
        item.imageSimilaritySource = ALGORITHM;
        item.imageSimilarityEngine ||= modelReady ? MODEL_ENGINE : FALLBACK_ENGINE;
        item.imageSimilarityStatus = 'unavailable';
        item.imageSimilarityError = String(error.message || error).slice(0, 160);
        failed++;
      }
      output[index] = item; processed++;
      onProgress({ current: processed, total: items.length, scored, failed, engine: modelReady ? MODEL_ENGINE : fallbackUsed ? FALLBACK_ENGINE : null });
    }
    for (let index = 0; index < items.length; index++) if (!output[index]) output[index] = { ...items[index] };
    return { items: output, scored, failed, cancelled: processed < items.length, engine: modelReady ? MODEL_ENGINE : fallbackUsed ? FALLBACK_ENGINE : null, fallbackReason };
  }
  return { algorithm: ALGORITHM, engines: { model: MODEL_ENGINE, fallback: FALLBACK_ENGINE }, thresholds: THRESHOLDS, classify, compareFeatures, scoreDataUrls: async (left, right) => compareFeatures(await features(left), await features(right)), scoreItems, cancel };
})();
