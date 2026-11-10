const UPDATE_URL = 'https://wsfile.cn/productC/updates/';

// Numeric prerelease components sort correctly: -10 > -9. Keep the familiar
// -v10 spelling in the interface, while the installer uses standard SemVer.
const displayVersion = version => String(version || '').replace(/^(\d+)\.(\d{1,2})\.(\d{1,2})-(?:v)?(\d+)$/, (_, year, month, day, revision) => `${year}.${month.padStart(2, '0')}.${day.padStart(2, '0')}-v${revision}`);
const updateVersion = version => {
  const raw = String(version || '').replace(/-v(\d+)$/, '-$1');
  const match = /^(\d+)\.(\d+)\.(\d+)-(\d+)$/.exec(raw);
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}-${Number(match[4])}` : raw;
};
const releaseNotes = value => (typeof value === 'string' ? value : Array.isArray(value)
  ? value.map(item => typeof item?.note === 'string' ? item.note : '').join('\n') : '').slice(0, 12000);
function validateInfo(info) {
  if (!/^\d+\.\d+\.\d+-\d+$/.test(info?.version || '')) throw new Error('更新版本信息无效');
  if (!Array.isArray(info.files) || info.files.length !== 1) throw new Error('更新文件信息无效');
  const file = info.files[0];
  if (file.url !== `ProductComparison-${info.version}-x64.exe` || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512 || '')
    || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 1024 * 1024 * 1024 || info.packages) {
    throw new Error('更新文件校验信息无效');
  }
  return true;
}
function friendlyError(error) {
  const text = String(error?.code || '') + ' ' + String(error?.message || error);
  if (/sha512|checksum|sha256|digest|signature/i.test(text)) return '更新文件校验失败，请重新下载；不会安装该文件。';
  if (/404|CHANNEL_FILE_NOT_FOUND/.test(text)) return '暂时没有可用的更新信息，请稍后再试。';
  if (/ENOSPC/i.test(text)) return '磁盘空间不足，请清理空间后重新下载。';
  if (/取消|cancel/i.test(text)) return '下载已取消，可以稍后重新下载。';
  return '连接更新服务失败，请检查网络后重试。';
}

class Updates {
  constructor({ updater, currentVersion, enabled = true, busy = () => false, beforeInstall = async () => {} }) {
    this.updater = updater;
    this.enabled = enabled;
    this.busy = busy;
    this.beforeInstall = beforeInstall;
    this.checkPromise = null;
    this.downloadPromise = null;
    this.login = 0;
    this.state = { currentVersion: displayVersion(currentVersion), status: 'idle', latestVersion: '', notes: '',
      releaseDate: '', checkedAt: '', percent: 0, transferred: 0, total: 0, error: '', hasUpdate: false, promptId: '', enabled };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = true;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.disableDifferentialDownload = true;
    updater.logger = null;
    updater.setFeedURL({ provider: 'generic', url: UPDATE_URL, channel: 'latest', useMultipleRangeRequest: false });
    updater.isUpdateSupported = validateInfo;
    updater.on('update-available', info => {
      validateInfo(info);
      Object.assign(this.state, { status: 'available', hasUpdate: true, latestVersion: displayVersion(info.version),
        notes: releaseNotes(info.releaseNotes), releaseDate: typeof info.releaseDate === 'string' ? info.releaseDate : '', error: '' });
    });
    updater.on('update-not-available', info => {
      Object.assign(this.state, { status: 'current', latestVersion: displayVersion(info?.version || currentVersion), hasUpdate: false, error: '' });
    });
    updater.on('download-progress', progress => {
      Object.assign(this.state, { status: 'downloading', percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
        transferred: Number(progress.transferred) || 0, total: Number(progress.total) || 0 });
    });
    updater.on('update-downloaded', () => { Object.assign(this.state, { status: 'ready', percent: 100, error: '' }); });
    updater.on('error', error => {
      Object.assign(this.state, { status: 'error', error: friendlyError(error) });
    });
  }
  snapshot() { return { ...this.state, busy: this.busy() }; }
  async check() {
    if (this.checkPromise) return this.checkPromise;
    if (['downloading', 'ready', 'installing'].includes(this.state.status)) return this.snapshot();
    if (!this.enabled) {
      Object.assign(this.state, { status: 'disabled', error: '开发模式不下载和安装更新，请使用安装版。' });
      return this.snapshot();
    }
    Object.assign(this.state, { status: 'checking', error: '' });
    this.checkPromise = (async () => {
      try { await this.updater.checkForUpdates(); }
      catch (error) { Object.assign(this.state, { status: 'error', error: friendlyError(error) }); }
      finally { this.state.checkedAt = new Date().toISOString(); this.checkPromise = null; }
      return this.snapshot();
    })();
    return this.checkPromise;
  }
  async onLogin() {
    const login = ++this.login;
    this.state.promptId = '';
    await this.check();
    if (login === this.login && this.state.hasUpdate) this.state.promptId = `${login}:${this.state.latestVersion}`;
  }
  onLogout() { this.login++; this.state.promptId = ''; }
  async download() {
    if (this.downloadPromise) return this.downloadPromise;
    if (this.state.status === 'ready') return this.snapshot();
    if (!this.enabled || !this.state.hasUpdate || !['available', 'error'].includes(this.state.status)) throw new Error('请先检查可用的新版本');
    Object.assign(this.state, { status: 'downloading', error: '', percent: 0, transferred: 0 });
    this.downloadPromise = (async () => {
      try { await this.updater.downloadUpdate(); }
      catch (error) { Object.assign(this.state, { status: 'error', error: friendlyError(error) }); }
      finally { this.downloadPromise = null; }
      return this.snapshot();
    })();
    return this.downloadPromise;
  }
  async install() {
    if (!this.enabled || this.state.status !== 'ready') throw new Error('请先下载完整的新版本');
    if (this.busy()) throw new Error('还有排队、识别或主图下载任务，请等任务结束后再安装。');
    this.state.status = 'installing';
    try { await this.beforeInstall(); this.updater.quitAndInstall(true, true); }
    catch (error) { this.state.status = 'ready'; throw error; }
    return this.snapshot();
  }
}

function createUpdates(options) {
  const { autoUpdater } = require('electron-updater');
  return new Updates({ ...options, updater: autoUpdater });
}
module.exports = { Updates, createUpdates, UPDATE_URL, displayVersion, updateVersion, validateInfo };
