(function (root, factory) {
  const api = factory(root.FindCore || (typeof require === 'function' ? require('./core.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FindWsyHttp = api;
})(globalThis, function (core) {
  async function preparePlatformImage(base64, signal) {
    const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(base64);
    if (!match) throw new Error('image_input：图片必须是可读取的 JPEG、PNG 或 WebP');
    const raw = atob(match[2]); const bytes = new Uint8Array(raw.length);
    for (let i=0;i<raw.length;i++) bytes[i]=raw.charCodeAt(i);
    let bitmap;
    try { bitmap = await createImageBitmap(new Blob([bytes], { type: `image/${match[1].toLowerCase()}` })); }
    catch { throw new Error('image_decode：网商园图片无法解码'); }
    try {
      if (signal?.aborted) throw new Error('request_cancelled：已取消搜索');
      const { width, height } = bitmap;
      if (width < 100 || height < 100 || width > 2048 || height > 2048) throw new Error('image_dimensions：网商园要求宽高均为 100～2048 像素');
      const shortEdge = Math.min(width, height);
      const scale = shortEdge > 300 ? 300 / shortEdge : 1;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('image_encode：网商园图片画布不可用');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (signal?.aborted) throw new Error('request_cancelled：已取消搜索');
      return canvas.toDataURL('image/jpeg', 0.9);
    } finally { bitmap.close(); }
  }
  async function search(base64, { fetchImpl = fetch, prepareImage = preparePlatformImage, signal, timeoutMs = 25000 } = {}) {
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(base64 || '')) throw new Error('image_input：图片必须是 JPEG、PNG 或 WebP 的 base64 数据');
    if (base64.length > 6 * 1024 * 1024) throw new Error('image_input：图片过大，请换一张图片');
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const platformImage = await prepareImage(base64, controller.signal);
      if (controller.signal.aborted) throw new Error('request_cancelled：已取消搜索');
      const response = await fetchImpl('/jsondata/search/image.json', {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base64: platformImage })
      });
      if (response.redirected && /login|passport|member\/login/i.test(response.url)) throw new Error('login_required：网商园要求登录，请在平台页面完成登录后重新搜索');
      if (!response.ok) throw new Error(`http_response：HTTP ${response.status}${response.status === 401 ? '，需要登录' : response.status === 403 ? '，平台拒绝请求' : response.status === 429 ? '，请求过于频繁，请稍后再试' : ''}`);
      const body = await response.text();
      let json;
      try { json = JSON.parse(body); } catch {
        if (/登录|login|passport/i.test(body.slice(0, 12000))) throw new Error('login_required：接口返回登录页面，未获得商品结果');
        throw new Error('response_parse：接口未返回 JSON；可能返回验证页或接口已改变，请查看网商园页面');
      }
      if (json?.status === 501) throw new Error('login_required：网商园接口要求登录（status=501），请在平台页面完成登录后重新搜索');
      if (json?.code === 403) throw new Error('platform_busy：网商园提示图搜服务正忙，请稍后再搜索');
      if (json?.code === 'UnsupportedPicPixels') throw new Error('image_dimensions：网商园不支持当前图片尺寸，请提供宽高均至少 100 像素的商品图');
      return core.parseWsy(json);
    } catch (error) {
      if (timedOut) throw new Error(`request_timeout：网商园请求超过 ${Math.round(timeoutMs / 1000)} 秒，未取得结果`);
      if (signal?.aborted) throw new Error('request_cancelled：已取消搜索');
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
  return { search, preparePlatformImage };
});
