const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Extension, extensionFiles } = require('../desktop/extension');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'product-plugin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const sourceDir = path.join(root, 'source'), dataDir = path.join(root, 'profile');
  await fs.mkdir(sourceDir);
  for (const file of extensionFiles) await fs.writeFile(path.join(sourceDir, file), 'fixture:' + file);
  await fs.mkdir(path.join(sourceDir, 'vendor'));
  await fs.writeFile(path.join(sourceDir, 'vendor/runtime.js'), 'runtime');
  await fs.writeFile(path.join(sourceDir, '.env'), 'private fixture');
  await fs.mkdir(path.join(sourceDir, 'node_modules'));
  await fs.writeFile(path.join(sourceDir, 'node_modules/private.js'), 'private fixture');
  const setVersion = async version => fs.writeFile(path.join(sourceDir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: '找商品', version: version.replace('-v', '.'), version_name: version }));
  const create = async version => { await setVersion(version); const manager = new Extension({ sourceDir, dataDir, version }); await manager.load(); return manager; };
  return { root, sourceDir, dataDir, create };
}
test('只导出插件白名单和运行库，重复点击合并；固定目录不携带账号、源码依赖或环境文件', async t => {
  const f = await fixture(t), manager = await f.create('26.10.27-v11');
  const first = manager.prepare(), second = manager.prepare();
  assert.equal(first, second);
  const info = await first;
  assert.equal(info.prepared, true); assert.equal(info.preparedVersion, '26.10.27-v11');
  assert.equal(info.path, path.join(f.dataDir, 'browser-extension'));
  assert.equal(manager.snapshot().preparing, false);
  assert.deepEqual(await fs.readFile(path.join(info.path, 'vendor/runtime.js'), 'utf8'), 'runtime');
  await assert.rejects(fs.access(path.join(info.path, '.env')));
  await assert.rejects(fs.access(path.join(info.path, 'node_modules')));
  assert.equal((await fs.readdir(info.path)).length, extensionFiles.length + 3);
});
test('客户端升级显示插件版本差异，更新仍沿用原目录；失败不损坏已准备插件和账号数据', async t => {
  const f = await fixture(t), old = await f.create('26.10.27-v10');
  const first = await old.prepare();
  await fs.mkdir(path.join(f.dataDir, 'profiles'));
  await fs.writeFile(path.join(f.dataDir, 'profiles/keep.txt'), 'keep');
  const manager = await f.create('26.10.27-v11');
  assert.equal(manager.snapshot().updateAvailable, true);
  assert.equal(manager.snapshot().preparedVersion, '26.10.27-v10');
  await fs.rename(path.join(f.sourceDir, 'background.js'), path.join(f.sourceDir, 'background.backup'));
  await assert.rejects(manager.prepare());
  assert.equal(JSON.parse(await fs.readFile(path.join(first.path, 'manifest.json'))).version_name, '26.10.27-v10');
  await fs.rename(path.join(f.sourceDir, 'background.backup'), path.join(f.sourceDir, 'background.js'));
  const updated = await manager.prepare();
  assert.equal(updated.path, first.path); assert.equal(updated.updateAvailable, false);
  assert.equal(JSON.parse(await fs.readFile(path.join(first.path, 'manifest.json'))).version_name, '26.10.27-v11');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'profiles/keep.txt'), 'utf8'), 'keep');
  assert.deepEqual((await fs.readdir(f.dataDir)).sort(), ['browser-extension', 'profiles']);
});
test('不覆盖未由应用创建的目录，版本不一致或源插件缺失时明确报错', async t => {
  const f = await fixture(t), manager = await f.create('26.10.27-v11');
  await fs.mkdir(path.join(f.dataDir, 'browser-extension'), { recursive: true });
  await fs.writeFile(path.join(f.dataDir, 'browser-extension/keep.txt'), 'keep');
  await assert.rejects(manager.prepare(), /保留/);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'browser-extension/keep.txt'), 'utf8'), 'keep');
  const wrong = new Extension({ sourceDir: f.sourceDir, dataDir: f.dataDir, version: '26.10.27-v12' });
  assert.match((await wrong.load()).error, /不一致/);
  await assert.rejects(wrong.prepare(), /不一致/);
  const missing = new Extension({ sourceDir: path.join(f.root, 'absent'), dataDir: f.dataDir, version: '26.10.27-v11' });
  assert.match((await missing.load()).error, /文件缺失/);
});
