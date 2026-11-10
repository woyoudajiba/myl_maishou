/* Runs only in the extension service worker. Provider credentials never enter
   supplier pages, persistent workbench state, diagnostics, or model prompts. */
(() => {
  const protocol = FindVisionProtocol;
  const configKey = 'vision.credentials';
  const trusted = sender => sender?.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('workbench.html');
  const readConfig = async () => {
    const config = (await chrome.storage.session.get(configKey))[configKey];
    if (!config) return undefined;
    try { return protocol.configuration(config); }
    catch { await chrome.storage.session.remove(configKey); return undefined; }
  };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!['VISION_CONFIGURE', 'VISION_STATUS', 'VISION_FORGET'].includes(message?.type)) return false;
    if (!trusted(sender)) { respond({ ok: false, error: 'vision_access：仅工作台可访问模型设置' }); return false; }
    (async () => {
      if (message.type === 'VISION_FORGET') await chrome.storage.session.remove(configKey);
      if (message.type === 'VISION_CONFIGURE') {
        const config = protocol.configuration(message.config);
        await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
        await chrome.storage.session.set({ [configKey]: config });
      }
      const config = await readConfig();
        return { ok: true, configured: !!config, model: config?.model || 'qwen3.7-plus', provider: config?.provider || 'dashscope' };
    })().then(respond, () => respond({ ok: false, error: 'vision_config：配置未保存，请检查模型与 API Key 格式后重试' }));
    return true;
  });
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'vision-compare' || !trusted(port.sender)) { port.disconnect(); return; }
    let controller = null, started = false, disconnected = false;
    port.onDisconnect.addListener(() => { disconnected = true; controller?.abort(); });
    port.onMessage.addListener(message => {
      // Client heartbeats keep a slow provider request alive in MV3. Closing
      // the page or cancelling disconnects the port and aborts the HTTP call.
      if (message?.type === 'ping' || started) return;
      if (message?.type !== 'compare') return;
      started = true;
      controller = new AbortController();
      let expired = false;
      const timer = setTimeout(() => { expired = true; controller.abort(); }, 90000);
      (async () => {
        protocol.validateBatch(message.batch);
        const config = await readConfig();
        if (!config) throw new Error('vision_not_configured：请先设置视觉大模型，当前没有执行识别');
        if (disconnected) return;
        const body = protocol.serializeRequest(config, message.batch);
        const response = await fetch(protocol.endpoints[config.provider], {
          method: 'POST', credentials: 'omit', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body
        });
        if (!response.ok) {
          const reasons = { 400: '请求或图片不被模型接受', 401: 'API Key 无效或已过期', 403: '账号无模型访问权限', 429: '额度或频率受限，请稍后手动重试', 502: '模型网关连接上游失败，本批未判定', 503: '模型服务暂不可用，本批未判定', 504: '模型网关等待上游超时，本批未取得结果' };
          await response.body?.cancel();
          throw new Error(`vision_http：HTTP ${response.status}，${reasons[response.status] || '模型服务请求失败'}`);
        }
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 256 * 1024) { await reader.cancel(); throw new Error('vision_response：模型响应过大'); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        let json;
        try { json = JSON.parse(new TextDecoder().decode(bytes)); }
        catch { throw new Error('vision_response：模型接口返回格式无效'); }
        const choice = json.choices?.[0];
        if (choice?.finish_reason !== 'stop') throw new Error('vision_response：模型输出被截断或未正常完成，本批未判定');
        return { ok: true, model: config.model, results: protocol.parseResults(choice.message?.content, message.batch.candidates) };
      })().then(result => { if (!disconnected) port.postMessage(result); }, error => {
        if (disconnected) return;
        // Never echo provider text/errors, which could contain request data.
        const safe = /^vision_[a-z_]+：/.test(error.message) ? error.message : 'vision_network：模型连接失败，请检查网络后手动重试';
        port.postMessage({ ok: false, error: expired ? 'vision_timeout：模型判断超过90秒，本批未判定' : safe });
      }).finally(() => { clearTimeout(timer); controller.abort(); });
    });
  });
})();
