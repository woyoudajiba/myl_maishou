(function () {
  const el = id => document.getElementById(id);
  let info = {}, busy = false;
  function render(snapshot) {
    info = snapshot.extension || {};
    el('pluginVersion').textContent = info.bundledVersion || snapshot.version || '读取中';
    el('pluginState').textContent = info.error || (info.updateAvailable ? `已准备 ${info.preparedVersion}，可以更新为内置版本。`
      : info.prepared ? '插件文件已准备，请按下方步骤在浏览器加载。' : '客户端已内置配套插件，无需另行下载。');
    el('preparePlugin').textContent = busy || info.preparing ? '正在准备…' : info.updateAvailable ? '更新插件文件' : info.prepared ? '重新准备插件' : '准备插件';
    el('preparePlugin').disabled = busy || !!info.preparing || !!info.error;
    el('openPluginFolder').disabled = !info.prepared || busy;
    el('copyPluginPath').disabled = !info.prepared || busy;
    el('pluginPathArea').hidden = !info.prepared;
    el('pluginPath').value = info.path || '';
  }
  async function action(callback) {
    if (busy) return;
    busy = true; el('preparePlugin').disabled = true; el('pluginMessage').textContent = '';
    try { await callback(); }
    catch (error) { el('pluginMessage').textContent = String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
    finally { busy = false; render({ extension: info }); }
  }
  async function copy(value, message) {
    try { await navigator.clipboard.writeText(value); el('pluginMessage').textContent = message; }
    catch { el('pluginMessage').textContent = '复制失败，请手动选择并复制页面中的内容。'; }
  }
  el('preparePlugin').addEventListener('click', () => { void action(async () => {
    info = await window.desktop.prepareExtension();
    el('pluginMessage').textContent = '已准备插件文件。首次安装请加载该文件夹；已经安装过的，请在浏览器扩展卡片点击重新加载。';
  }); });
  el('openPluginFolder').addEventListener('click', () => { void action(() => window.desktop.openExtension()); });
  el('copyPluginPath').addEventListener('click', () => { if (info.path) void copy(info.path, '插件目录已复制。'); });
  el('copyChromeAddress').addEventListener('click', () => { void copy('chrome://extensions/', 'Chrome 扩展页地址已复制，请粘贴到 Chrome 地址栏。'); });
  el('copyEdgeAddress').addEventListener('click', () => { void copy('edge://extensions/', 'Edge 扩展页地址已复制，请粘贴到 Edge 地址栏。'); });
  document.querySelectorAll('[data-help-page]').forEach(button => button.addEventListener('click', () => {
    el(button.dataset.helpPage === 'settings' ? 'navSettings' : 'navUpdates').click();
  }));
  window.FindHelpUI = Object.freeze({ render });
})();
