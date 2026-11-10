const test = require('node:test');
test('打包的日期版本补齐前导零，与内置插件的显示版本保持一致',()=>{
  const {displayVersion,updateVersion}=require('../desktop/updates');
  assert.equal(displayVersion('26.11.7-4'),'26.11.07-v4');
  assert.equal(displayVersion('26.1.3-12'),'26.01.03-v12');
  assert.equal(displayVersion('26.11.07-v4'),'26.11.07-v4');
  const current=require('../manifest.json').version_name;
  assert.equal(displayVersion(updateVersion(current)),current);
});
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const semver = require('../desktop/node_modules/semver');
const { Updates, displayVersion, updateVersion, validateInfo } = require('../desktop/updates');
const info = (version = '26.10.27-11') => ({ version, releaseNotes: '更新测试', releaseDate: '2026-10-29T00:00:00.000Z',
  files: [{ url: `ProductComparison-${version}-x64.exe`, sha512: Buffer.alloc(64).toString('base64'), size: 100 }] });
function fixture(options = {}) {
  const updater = new EventEmitter();
  let checks = 0, downloads = 0, installs = 0, before = 0;
  updater.setFeedURL = value => { updater.feed = value; };
  updater.checkForUpdates = async () => { checks++; updater.emit('update-available', info()); };
  updater.downloadUpdate = async () => { downloads++; updater.emit('download-progress', { percent: 50, transferred: 50, total: 100 }); updater.emit('update-downloaded', info()); };
  updater.quitAndInstall = (...args) => { assert.deepEqual(args, [true, true]); installs++; };
  const updates = new Updates({ updater, currentVersion: '26.10.27-10', beforeInstall: async () => { before++; }, ...options });
  return { updates, updater, get checks() { return checks; }, get downloads() { return downloads; }, get installs() { return installs; }, get before() { return before; } };
}
test('版本按数字递增，v10与v9及后续v11不按字典序比较；发布元数据限制安装器与校验值', () => {
  assert.equal(updateVersion('26.10.27-v10'), '26.10.27-10');
  assert.equal(updateVersion('26.11.06-v1'), '26.11.6-1');
  assert.equal(displayVersion('26.10.27-10'), '26.10.27-v10');
  assert.ok(semver.gt(updateVersion('26.10.27-v10'), updateVersion('26.10.27-v9')));
  assert.ok(semver.gt(updateVersion('26.10.27-v11'), updateVersion('26.10.27-v10')));
  assert.ok(validateInfo(info()));
  for (const file of [{ url: 'https://other.example/installer.exe' }, { sha512: 'invalid' }, { size: -1 }]) {
    assert.throws(() => validateInfo({ ...info(), files: [{ ...info().files[0], ...file }] }), /校验信息/);
  }
});
test('每次登录只检查和提示，不自动下载、不退出即安装；用户点击才下载和安装', async () => {
  const f = fixture();
  assert.equal(f.updater.autoDownload, false); assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.allowDowngrade, false);
  await f.updates.onLogin();
  assert.equal(f.checks, 1); assert.equal(f.downloads, 0); assert.equal(f.installs, 0);
  const first = f.updates.snapshot();
  assert.equal(first.latestVersion, '26.10.27-v11'); assert.ok(first.promptId);
  f.updates.onLogout(); assert.equal(f.updates.snapshot().promptId, '');
  await f.updates.onLogin(); assert.equal(f.checks, 2); assert.notEqual(f.updates.snapshot().promptId, first.promptId);
  await f.updates.download(); assert.equal(f.downloads, 1); assert.equal(f.updates.snapshot().status, 'ready');
  assert.equal(f.installs, 0);
  await f.updates.install(); assert.equal(f.installs, 1); assert.equal(f.before, 1);
  await assert.rejects(f.updates.install(), /下载完整/);
});
test('重复检查与下载合并，正在识别可下载但不可安装；失败后可以重试', async () => {
  let busy = true, release;
  const f = fixture({ busy: () => busy });
  f.updater.checkForUpdates = async () => { await new Promise(resolve => { release = resolve; }); f.updater.emit('update-available', info()); };
  const a = f.updates.check(), b = f.updates.check(); release(); await Promise.all([a, b]);
  let calls = 0;
  f.updater.downloadUpdate = async () => { calls++; await new Promise(resolve => { release = resolve; }); f.updater.emit('update-downloaded', info()); };
  const d = f.updates.download(), e = f.updates.download();
  assert.equal(calls, 1); release(); await Promise.all([d, e]);
  await assert.rejects(f.updates.install(), /识别或主图下载任务/); assert.equal(f.installs, 0);
  busy = false; await f.updates.install(); assert.equal(f.installs, 1);
  const failed = fixture(); await failed.updates.check();
  failed.updater.downloadUpdate = async () => { throw new Error('sha512 checksum mismatch'); };
  await failed.updates.download(); assert.match(failed.updates.snapshot().error, /校验失败/);
  await assert.rejects(failed.updates.install(), /下载完整/);
  failed.updater.downloadUpdate = async () => failed.updater.emit('update-downloaded', info());
  await failed.updates.download(); assert.equal(failed.updates.snapshot().status, 'ready');
});
test('登录检查不阻塞业务，退出后迟到检查不弹窗；服务故障不伪装已是最新', async () => {
  let release;
  const f = fixture();
  f.updater.checkForUpdates = async () => { await new Promise(resolve => { release = resolve; }); f.updater.emit('update-available', info()); };
  const checking = f.updates.onLogin();
  assert.equal(f.updates.snapshot().status, 'checking');
  f.updates.onLogout(); release(); await checking;
  assert.equal(f.updates.snapshot().promptId, '');
  const broken = fixture(); broken.updater.checkForUpdates = async () => { throw new Error('timeout'); };
  await broken.updates.check(); assert.equal(broken.updates.snapshot().status, 'error'); assert.equal(broken.downloads, 0);
  assert.match(broken.updates.snapshot().error, /网络/);
  const dev = fixture({ enabled: false }); await dev.updates.onLogin();
  assert.equal(dev.checks, 0); assert.equal(dev.updates.snapshot().status, 'disabled');
});
