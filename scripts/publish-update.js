// Explicit operator command: uploads immutable files, verifies remote hashes,
// then atomically publishes latest.yml. Never invoked by normal packaging.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const yaml = require('../desktop/node_modules/js-yaml');
const { updateVersion, validateInfo } = require('../desktop/updates');
const version = require('../manifest.json').version_name;
const canonical = updateVersion(version);
const release = path.resolve(__dirname, '../desktop/release');
const key = process.env.PC_DEPLOY_KEY || 'D:/wsf_main/codex-deploy';
const host = 'deploy@47.100.22.0';
const stage = '/home/deploy/productC-upload-' + crypto.randomUUID();
const run = (bin, args) => {
  const result = spawnSync(bin, args, { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error(`${bin} failed (${result.status})`);
};
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const metadata = yaml.load(fs.readFileSync(path.join(release, 'latest.yml'), 'utf8'));
validateInfo(metadata);
if (metadata.version !== canonical) throw new Error('打包版本与更新元数据不一致');
const installer = `ProductComparison-${canonical}-x64.exe`;
const installerFile = path.join(release, installer);
if (crypto.createHash('sha512').update(fs.readFileSync(installerFile)).digest('base64') !== metadata.files[0].sha512
  || fs.statSync(installerFile).size !== metadata.files[0].size) throw new Error('安装包与更新清单校验不一致');
const publicFiles = [installer, installer + '.blockmap', `ProductComparison-BrowserExtension-${version}.zip`];
const extensionSource = path.join(release, `ProductComparison-BrowserExtension-${version}`);
const archive = path.join(release, publicFiles[2]);
if (!fs.existsSync(archive)) throw new Error('请先把桌面交付的插件ZIP复制到 release 目录');
if (!fs.existsSync(path.join(extensionSource, 'manifest.json'))) throw new Error('缺少插件发布目录');
const proofFile = path.join(release, `verified-${version}.json`);
if (!fs.existsSync(proofFile)) throw new Error('缺少实际打包EXE启动验收记录，请先完成打包验收');
const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
if (proof.version !== version || proof.updateVersion !== canonical || proof.installerSha256 !== sha(installerFile)
  || proof.extensionSha256 !== sha(archive) || proof.metadataSha256 !== sha(path.join(release, 'latest.yml'))
  || proof.startup?.version !== canonical || proof.startup?.packaged !== true || proof.startup?.loginVisible !== true
  || proof.startup?.modelRetryLoaded !== true || proof.startup?.buyerProvidersLoaded !== true || proof.startup?.buyerMappingLoaded !== true || proof.startup?.buyerDraftViewLoaded !== true
  || proof.startup?.buyerDraftUiLoaded !== true || proof.startup?.rendererErrors?.length !== 0) {
  throw new Error('打包EXE启动验收或产物哈希不一致，停止发布');
}
const manifest = { version, files: publicFiles.map(name => ({ name, sha256: sha(path.join(release, name)) })), metadataSha256: sha(path.join(release, 'latest.yml')) };
fs.writeFileSync(path.join(release, 'publish-manifest.json'), JSON.stringify(manifest));
const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', key];
run('ssh', [...sshArgs, host, `mkdir -m 700 '${stage}'`]);
run('scp', [...sshArgs, ...publicFiles.map(name => path.join(release, name)), path.join(release, 'latest.yml'),
  path.join(release, 'publish-manifest.json'), path.resolve(__dirname, '../deploy/publish-update.py'), `${host}:${stage}/`]);
run('ssh', [...sshArgs, host, `python3 '${stage}/publish-update.py' '${stage}'`]);
console.log(`Published ${version}: https://wsfile.cn/productC/`);
