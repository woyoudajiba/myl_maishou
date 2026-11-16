const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Shared by the installer and the in-app exporter. Never copy the repository,
// dependency folders, local accounts, or model keys into a browser extension.
const extensionFiles = Object.freeze([
  'taobao-sales.js', 'platform-login.js', 'taobao-search.js', 'buyer-page.js',
  'manifest.json', 'background.js', 'connection-check.js', 'core.js', 'platform-page.js',
  'review.css', 'review.js', 'review-ui.js', 'similarity-worker.js', 'similarity.js',
  'transport.js', 'vision-background.js', 'vision-client.js', 'vision-protocol.js', 'image-policy.js', 'vision-queue.js',
  'workbench.css', 'workbench.html', 'workbench.js', 'query-store.js', 'query-workspace.js', 'wsy-bridge.js', 'wsy-http.js',
  'README.md', 'THIRD_PARTY_NOTICES.md'
]);
const markerName = '.product-comparison-extension.json';
async function copyTree(source, target) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error('插件文件不能是链接');
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true });
    for (const name of await fs.readdir(source)) await copyTree(path.join(source, name), path.join(target, name));
  } else if (stat.isFile()) await fs.copyFile(source, target);
  else throw new Error('插件目录包含不支持的文件');
}
class Extension {
  constructor({ sourceDir, dataDir, version }) {
    this.sourceDir = path.resolve(sourceDir);
    this.dataDir = path.resolve(dataDir);
    this.target = path.join(this.dataDir, 'browser-extension');
    this.version = version;
    this.operation = null;
    this.state = { bundledVersion: version, preparedVersion: '', prepared: false, updateAvailable: false, path: '', error: '' };
  }
  snapshot() { return { ...this.state, preparing: !!this.operation }; }
  async load() {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(this.sourceDir, 'manifest.json'), 'utf8'));
      if (manifest.version_name !== this.version) throw new Error('内置插件与客户端版本不一致，请重新安装客户端');
      await fs.access(path.join(this.sourceDir, 'workbench.html'));
      try {
        const stat = await fs.lstat(this.target);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('插件目录无效');
        const marker = JSON.parse(await fs.readFile(path.join(this.target, markerName), 'utf8'));
        const prepared = JSON.parse(await fs.readFile(path.join(this.target, 'manifest.json'), 'utf8'));
        if (marker.app !== 'ProductComparison' || marker.version !== prepared.version_name) throw new Error('插件导出标记无效');
        Object.assign(this.state, { prepared: true, preparedVersion: marker.version, path: this.target, updateAvailable: marker.version !== this.version });
      } catch { /* Export is optional; the source remains available offline. */ }
    } catch (error) { this.state.error = error.code === 'ENOENT' ? '内置插件文件缺失，请重新安装完整客户端' : error.message; }
    return this.snapshot();
  }
  prepare() {
    if (this.operation) return this.operation;
    this.operation = this.export().finally(() => { this.operation = null; });
    return this.operation;
  }
  async export() {
    if (this.state.error) throw new Error(this.state.error);
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const stat = await fs.lstat(this.target);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('插件目标路径不是应用管理的文件夹，已保留原文件');
      let marker;
      try { marker = JSON.parse(await fs.readFile(path.join(this.target, markerName), 'utf8')); } catch { /* Refuse unowned folders. */ }
      if (marker?.app !== 'ProductComparison') throw new Error('插件目录存在其他文件，已保留；请检查该目录后重试');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const stage = await fs.mkdtemp(path.join(this.dataDir, 'browser-extension-stage-'));
    const backup = path.join(this.dataDir, 'browser-extension-previous-' + crypto.randomUUID());
    let moved = false;
    try {
      for (const name of extensionFiles) await copyTree(path.join(this.sourceDir, name), path.join(stage, name));
      await copyTree(path.join(this.sourceDir, 'vendor'), path.join(stage, 'vendor'));
      const manifest = JSON.parse(await fs.readFile(path.join(stage, 'manifest.json'), 'utf8'));
      if (manifest.version_name !== this.version) throw new Error('插件版本与客户端不一致，请重新安装客户端');
      await fs.writeFile(path.join(stage, markerName), JSON.stringify({ app: 'ProductComparison', version: this.version }));
      await fs.writeFile(path.join(stage, '安装说明.txt'), '在 Chrome / Edge 扩展管理页开启开发人员模式，选择“加载解压缩的扩展”，选中当前目录。以后请保留此目录，更新插件后在扩展卡片点击重新加载。', 'utf8');
      try { await fs.rename(this.target, backup); moved = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await fs.rename(stage, this.target); }
      catch (error) { if (moved) await fs.rename(backup, this.target); throw error; }
      Object.assign(this.state, { prepared: true, preparedVersion: this.version, path: this.target, updateAvailable: false });
      if (moved) await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
      return this.snapshot();
    } finally {
      // Both paths are created under the exact app data directory above.
      if (path.dirname(stage) === this.dataDir) await fs.rm(stage, { recursive: true, force: true });
    }
  }
}
module.exports = { Extension, extensionFiles };
