(() => {
  if (globalThis.__findCoreBridge) return;
  globalThis.__findCoreBridge = true;
  let job = null;
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'CORE_PING') { respond({ ok: true, version: '0.1.0', pageUrl: location.href }); return; }
    if (message?.type === 'CORE_CANCEL') { if (job?.id === message.requestId) job.controller.abort(); respond({ ok: true }); return; }
    if (message?.type !== 'CORE_SEARCH') return;
    if (!message.requestId) { respond({ ok: false, error: 'request_input：缺少请求标识' }); return; }
    if (job) { respond({ ok: false, requestId: message.requestId, error: 'request_busy：此平台页面已有搜索进行中，请等待完成' }); return; }
    const current = { id: message.requestId, controller: new AbortController() };
    job = current;
    FindWsyHttp.search(message.base64, { signal: current.controller.signal })
      .then(result => respond({ ok: true, requestId: current.id, ...result }))
      .catch(error => respond({ ok: false, requestId: current.id, error: error?.message || String(error) }))
      .finally(() => { if (job === current) job = null; });
    return true;
  });
})();
