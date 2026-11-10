import { AutoProcessor, CLIPVisionModelWithProjection, RawImage, env } from './vendor/transformers.js';

const MODEL_ID = 'Marqo/marqo-fashionCLIP';
env.allowRemoteModels = true;
env.allowLocalModels = false;
env.useBrowserCache = true;
env.useFSCache = false;
// Execute only packaged code. Disable the library's blob/CDN WASM loader.
env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL('./vendor/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href,
  wasm: new URL('./vendor/ort-wasm-simd-threaded.asyncify.wasm', import.meta.url).href
};
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
env.cacheKey = 'find-product-fashionclip-v1';

let modelPromise;
let queryDataUrl = '';
let queryVector = null;

function normalize(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (!norm || !Number.isFinite(norm)) throw new Error('model_output：模型未返回有效图像向量');
  return Float32Array.from(vector, value => value / norm);
}

async function getModel(id) {
  if (!navigator.gpu) throw new Error('model_webgpu_unavailable：此设备没有可用的 WebGPU，使用基础本地评分');
  if (!modelPromise) {
    const progress_callback = progress => self.postMessage({ id, type: 'progress', ...progress });
    modelPromise = Promise.all([
      AutoProcessor.from_pretrained(MODEL_ID, { progress_callback }),
      CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { device: 'webgpu', dtype: 'q4f16', progress_callback })
    ]);
  }
  return modelPromise;
}

async function embed(dataUrl, id) {
  const [processor, model] = await getModel(id);
  const image = await RawImage.read(dataUrl);
  const output = await model(await processor(image));
  const values = output?.image_embeds?.data;
  if (!values?.length) throw new Error('model_output：服装模型未返回图像特征');
  return normalize(values);
}

self.onmessage = async ({ data }) => {
  const { id, type, query, candidate } = data || {};
  try {
    if (type !== 'score') throw new Error('model_request：不支持的图像判断任务');
    if (query !== queryDataUrl || !queryVector) {
      queryVector = await embed(query, id);
      queryDataUrl = query;
    }
    const candidateVector = await embed(candidate, id);
    if (candidateVector.length !== queryVector.length) throw new Error('model_output：图像向量维度不匹配');
    let cosine = 0;
    for (let index = 0; index < queryVector.length; index++) cosine += queryVector[index] * candidateVector[index];
    self.postMessage({ id, type: 'result', cosine: Math.max(-1, Math.min(1, cosine)) });
  } catch (error) {
    if (!queryVector) modelPromise = null;
    self.postMessage({ id, type: 'error', error: String(error?.message || error).slice(0, 220) });
  }
};
