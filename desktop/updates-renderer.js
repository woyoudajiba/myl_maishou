(function () {
  const el = id => document.getElementById(id);
  const prompts = new Set();
  const labels = { idle: '尚未检查更新', checking: '正在检查更新…', current: '已是最新版本', available: '有新版本可用',
    downloading: '正在下载更新…', ready: '已下载，可以安装', installing: '正在准备安装…', error: '更新暂未完成', disabled: '开发模式' };
  let state = {}, loggedIn = false, action = false;
  const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';
  const mb = bytes => (bytes / 1048576).toFixed(1) + ' MB';
  const openPage = () => el('navUpdates').click();
  async function run(callback) {
    if (action) return;
    action = true;
    el('checkUpdate').disabled = el('downloadUpdate').disabled = el('installUpdate').disabled = true;
    try { await callback(); }
    catch (error) { el('updateError').textContent = String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
    finally { action = false; }
  }
  function render(snapshot) {
    loggedIn = !!snapshot.authenticated;
    if (!loggedIn) { el('updateDialog').close(); return; }
    state = snapshot.updates || {};
    el('updateCurrentVersion').textContent = snapshot.version;
    el('updateStatus').textContent = labels[state.status] || labels.idle;
    el('updateCheckedAt').textContent = state.checkedAt ? '上次检查：' + time(state.checkedAt) : '登录后自动检查，也可以手动检查。';
    el('updateNavHint').textContent = state.status === 'ready' ? '已下载，待安装' : state.hasUpdate ? '有新版本' : '版本与更新';
    el('checkUpdate').disabled = action || ['checking', 'downloading', 'ready', 'installing'].includes(state.status);
    el('updateError').textContent = state.error || '';
    el('updateRelease').hidden = !state.hasUpdate;
    el('updateLatestVersion').textContent = state.latestVersion || '';
    el('updateReleaseDate').textContent = state.releaseDate ? '发布时间：' + time(state.releaseDate) : '';
    el('updateNotes').textContent = state.notes || '本次更新包含功能优化与问题修复。';
    const downloading = state.status === 'downloading', ready = state.status === 'ready', installing = state.status === 'installing';
    el('updateProgressArea').hidden = !downloading && !ready;
    el('updateProgress').value = state.percent || 0;
    el('updateProgressText').textContent = ready ? '下载完成，已通过完整性校验。' : `已下载 ${Math.floor(state.percent || 0)}% · ${mb(state.transferred || 0)} / ${mb(state.total || 0)}`;
    el('downloadUpdate').hidden = ready || installing;
    el('downloadUpdate').disabled = action || downloading || !state.hasUpdate;
    el('downloadUpdate').textContent = downloading ? '正在下载…' : state.status === 'error' ? '重新下载' : '下载更新';
    el('installUpdate').hidden = !ready && !installing;
    el('installUpdate').disabled = action || installing || !!state.busy;
    el('installUpdate').textContent = installing ? '正在准备安装…' : '重启并安装';
    el('updateBusyHint').hidden = !state.busy || !state.hasUpdate;
    if (state.promptId && state.hasUpdate && !prompts.has(state.promptId) && !document.querySelector('dialog[open]')) {
      prompts.add(state.promptId);
      el('updateDialogVersion').textContent = `当前 ${snapshot.version} → 新版 ${state.latestVersion}`;
      el('updateDialogNotes').textContent = state.notes || '本次更新包含功能优化与问题修复。';
      el('updateNow').textContent = ready ? '查看并安装' : downloading ? '查看下载进度' : '立即更新';
      el('updateDialog').showModal();
    }
  }
  el('checkUpdate').addEventListener('click', () => { void run(() => window.desktop.checkUpdate()); });
  el('downloadUpdate').addEventListener('click', () => { void run(() => window.desktop.downloadUpdate()); });
  el('installUpdate').addEventListener('click', () => { void run(() => window.desktop.installUpdate()); });
  el('updateLater').addEventListener('click', () => el('updateDialog').close());
  el('updateNow').addEventListener('click', () => {
    el('updateDialog').close(); openPage();
    if (loggedIn && !['downloading', 'ready', 'installing'].includes(state.status)) void run(() => window.desktop.downloadUpdate());
  });
  window.FindUpdatesUI = Object.freeze({ render });
})();
