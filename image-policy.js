(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FindImagePolicy = api;
})(globalThis, function () {
  const platformImageHost = host => /(^|\.)wsy\.com$|(^|\.)17qcc\.com$|(^|\.)17zwd\.com$|(^|\.)e3hui\.com$|(^|\.)e3hui\.cn$/.test(host)
    || ['e3h.i.ximgs.net', 'aodo.i.ximgs.net'].includes(host);
  // Try known thumbnail forms before the platform-provided URL. Keep the
  // original as fallback and never rewrite signed image URLs.
  function sources(value) {
    const original = String(value || '');
    try {
      const url = new URL(original);
      const host = url.hostname.toLowerCase();
      const signed = [...url.searchParams.keys()].some(key => /signature|credential|token|accesskey/i.test(key));
      if (url.protocol === 'https:' && /(^|\.)(?:alicdn\.com|taobaocdn\.com|tbcdn\.cn)$/.test(host) && !signed) {
        url.pathname = url.pathname.replace(/(\.(?:jpe?g|png|webp))_\d+x\d+[^/]*$/i, '$1');
        url.searchParams.delete('x-oss-process');
        return [...new Set([url.href, original])];
      }
      if (url.protocol === 'https:' && platformImageHost(host) && !signed && url.searchParams.has('x-oss-process')) {
        url.searchParams.delete('x-oss-process');
        return [...new Set([url.href, original])];
      }
      if (url.protocol === 'https:' && ['e3h.i.ximgs.net', 'aodo.i.ximgs.net'].includes(host) && /_450(?=\.(?:jpe?g|png|webp)$)/i.test(url.pathname)) {
        url.pathname = url.pathname.replace(/_450(?=\.(?:jpe?g|png|webp)$)/i, '');
        return [...new Set([url.href, original])];
      }
    } catch { /* The downloader reports invalid addresses. */ }
    return [original];
  }
  function qualityError(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '图片尺寸无法读取，未执行识别';
    if (Math.max(width, height) < 600 || Math.min(width, height) < 320) {
      return `图片仅 ${width}×${height}，细节不足，未执行识别；请提供高清商品图`;
    }
    return '';
  }
  function httpError(status) {
    const reasons = {
      400: '模型不接受当前请求或图片，请检查模型是否支持图片输入',
      401: 'API Key 无效或已过期', 403: '账号无模型访问权限',
      404: '接口地址或模型 ID 不存在', 413: '图片请求过大',
      429: '模型额度或请求频率受限，请稍后重试',
      500: '模型服务内部异常，请稍后重试',
      502: '模型网关连接上游失败，请稍后重试',
      503: '模型服务暂不可用，请稍后重试',
      504: '模型网关等待上游超时，本批未取得结果；可逐张重试'
    };
    return `HTTP ${status}：${reasons[status] || '模型请求失败，本批未取得结果'}`;
  }
  return { sources, qualityError, httpError };
});
