const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const desktopDir = path.join(root, 'desktop');
const releaseDir = path.join(desktopDir, 'release');
const stageDir = path.join(desktopDir, '.build-app');
const desktopBase = path.join(process.env.USERPROFILE || process.env.HOME || 'C:/Users/Public', 'Desktop');
const desktopTarget = path.resolve(process.env.PC_RELEASE_DEST || desktopBase);
const numericVersion = require('../desktop/package.json').version;
const manifest = require('../manifest.json');
const releaseParts = /^(\d+\.\d+\.\d+)-v(\d+)$/.exec(manifest.version_name || '');
const normalizedReleaseBase = value => value.split('.').map(part => String(Number(part))).join('.');
if (!releaseParts || normalizedReleaseBase(releaseParts[1]) !== numericVersion || manifest.version !== `${numericVersion}.${releaseParts[2]}` || require('../desktop/package.json').build.buildVersion !== manifest.version) {
  throw new Error('版本号不同步：请递增 manifest.version_name 的 v 序号，并同步扩展 version 与桌面 buildVersion');
}
const version = manifest.version_name;
const updateVersion = require('../desktop/updates').updateVersion(version);
const extensionName = `ProductComparison-BrowserExtension-${version}`;
const desktopName = `ProductComparison-Desktop-${version}`;
const releaseMarker = `ProductComparison release ${version}`;
const priorChecksumFile = path.join(desktopTarget, `${desktopName}-SHA256.txt`);
const priorDeliveryFiles = new Set(fs.existsSync(priorChecksumFile) && fs.readFileSync(priorChecksumFile, 'utf8').startsWith(`${releaseMarker}\n`)
  ? fs.readFileSync(priorChecksumFile, 'utf8').split(/\r?\n/).slice(1).map(line => line.split(/\s{2,}/).at(-1)).filter(Boolean)
  : []);
const mayReplacePriorReleaseFile = target => path.dirname(path.resolve(target)) === desktopTarget && priorDeliveryFiles.has(path.basename(target));

const { extensionFiles } = require('../desktop/extension');

function remove(target) { fs.rmSync(target, { recursive: true, force: true }); }
function copyFile(relative, targetRoot) {
  const source = path.join(root, relative);
  if (!fs.existsSync(source)) throw new Error(`缺少扩展文件：${relative}`);
  const target = path.join(targetRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}
function copyDir(relative, targetRoot) {
  const source = path.join(root, relative);
  if (!fs.existsSync(source)) throw new Error(`缺少扩展目录：${relative}`);
  copyTree(source, path.join(targetRoot, relative));
}
function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
    else throw new Error(`打包目录不能包含链接或特殊文件：${from}`);
  }
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function deliverFile(source, target) {
  if (fs.existsSync(target)) {
    if (sha256(source) === sha256(target)) return;
    if (!mayReplacePriorReleaseFile(target)) throw new Error(`桌面上已有同名文件，已保留原文件：${target}`);
  }
  fs.copyFileSync(source, target);
}
function compressFolder(folder, archive) {
  const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command',
    '$ErrorActionPreference = "Stop"; Compress-Archive -Path (Join-Path -Path $env:PC_ARCHIVE_FOLDER -ChildPath "*") -DestinationPath $env:PC_ARCHIVE_PATH -Force'], {
      stdio: 'inherit', windowsHide: true,
      env: { ...process.env, PC_ARCHIVE_FOLDER: folder, PC_ARCHIVE_PATH: archive }
    });
  if (result.status !== 0) throw new Error(`压缩失败：${archive}`);
}
function deliverArchive(folder, target) {
  const temporary = `${target}.${process.pid}.tmp.zip`;
  compressFolder(folder, temporary);
  if (fs.existsSync(target)) {
    if (sha256(temporary) === sha256(target)) { fs.unlinkSync(temporary); return; }
    if (!mayReplacePriorReleaseFile(target)) { fs.unlinkSync(temporary); throw new Error(`桌面上已存在同名压缩包，已保留原文件：${target}`); }
    fs.copyFileSync(temporary, target); fs.unlinkSync(temporary); return;
  }
  fs.renameSync(temporary, target);
}
async function main() {
  const relativeTarget = path.relative(desktopBase, desktopTarget);
  if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) throw new Error('安装包只能交付至当前用户桌面或其子目录');
  if (manifest.version_name !== version || manifest.version !== `${numericVersion}.${releaseParts[2]}`) {
    throw new Error('桌面端与扩展版本不一致，停止打包');
  }
  fs.mkdirSync(desktopTarget, { recursive: true });
  fs.mkdirSync(releaseDir, { recursive: true });
  if (fs.existsSync(stageDir)) {
    const allowedStageFiles = new Set(['desktop', 'package.json', '.codex-release-stage', '.npmrc', 'review.js', 'review-ui.js', 'review.css', 'vision-protocol.js', 'image-policy.js', 'vision-queue.js']);
    const existingPackage = path.join(stageDir, 'package.json');
    const validStage = fs.readdirSync(stageDir).every(name => allowedStageFiles.has(name)) &&
      fs.existsSync(existingPackage) && [numericVersion, version, updateVersion].includes(JSON.parse(fs.readFileSync(existingPackage, 'utf8')).version) &&
      fs.existsSync(path.join(stageDir, 'desktop/main.js')) && fs.existsSync(path.join(stageDir, 'desktop/bridge-server.js'));
    if (!validStage) {
      throw new Error(`暂存目录不是本脚本生成的，已保留：${stageDir}`);
    }
  }
  remove(stageDir);
  const appStage = stageDir;
  const stagedDesktop = path.join(appStage, 'desktop');
  fs.mkdirSync(stagedDesktop, { recursive: true });
  fs.writeFileSync(path.join(appStage, '.codex-release-stage'), releaseMarker, 'utf8');
  for (const file of ['main.js', 'updates.js', 'updates-renderer.js', 'douyin.js', 'douyin-renderer.js', 'buyer-renderer.js','buyer-auto-renderer.js','buyer-import.js','buyer-engine.js','buyer-settings.js','online-table-client.js','buyer-providers.js','buyer-evidence.js','buyer-files.js','buyer-preview.js', 'extension.js', 'help-renderer.js', 'accounts.js', 'platform-accounts.js', 'buyer-workflow.js', 'buyer-source.js', 'pairing.js', 'models.js', 'images.js', 'comparison.js', 'bridge-server.js', 'preload.js', 'renderer.js', 'index.html', 'style.css']) {
    fs.copyFileSync(path.join(desktopDir, file), path.join(stagedDesktop, file));
  }
  fs.mkdirSync(path.join(stagedDesktop,'erp'),{recursive:true});
  for(const file of ['client.mjs','contract.mjs'])fs.copyFileSync(path.join(desktopDir,'erp',file),path.join(stagedDesktop,'erp',file));
  fs.copyFileSync(path.join(desktopDir,'buyer-links.js'),path.join(stagedDesktop,'buyer-links.js'));
  fs.mkdirSync(path.join(stagedDesktop, 'assets'), { recursive: true });
  for (const file of ['app-icon.png', 'app-icon.ico', '买手上架测试模板.xlsx']) fs.copyFileSync(path.join(desktopDir, 'assets', file), path.join(stagedDesktop, 'assets', file));
  for (const file of ['review.js', 'review-ui.js', 'review.css', 'vision-protocol.js', 'image-policy.js', 'vision-queue.js']) {
    fs.copyFileSync(path.join(root, file), path.join(appStage, file));
  }
  fs.writeFileSync(path.join(appStage, 'package.json'), JSON.stringify({
    name: 'product-comparison-desktop', version: updateVersion, productName: '找商品', main: 'desktop/main.js',
    description: '找商品本地桌面端', author: 'Product Comparison', dependencies: { ...require('../desktop/package.json').dependencies }
  }, null, 2), 'utf8');

  const extensionStage = path.join(releaseDir, extensionName);
  remove(extensionStage);
  fs.mkdirSync(extensionStage, { recursive: true });
  extensionFiles.forEach(file => copyFile(file, extensionStage));
  copyDir('vendor', extensionStage);
  const stagedManifest = require(path.join(extensionStage, 'manifest.json'));
  if (stagedManifest.version !== manifest.version || stagedManifest.version_name !== version) throw new Error('插件清单版本校验失败');
  await fsp.writeFile(path.join(extensionStage, '安装说明.txt'), [
    `找商品浏览器插件 ${version}`,
    '',
    '1. 将本压缩包解压到固定目录。',
    '2. Chrome 打开 chrome://extensions；Edge 打开 edge://extensions。',
    '3. 开启“开发人员模式”，选择“加载解压缩的扩展”，选中本目录。',
    '4. 以后从扩展图标打开工作台。移动目录后需要在扩展管理页重新选择目录。',
    '',
    `扩展清单内部版本为 ${manifest.version}，界面版本显示 ${version}。`
  ].join('\r\n'), 'utf8');

  const builder = require(path.join(desktopDir, 'node_modules/electron-builder'));
  await builder.build({ projectDir: desktopDir, win: ['nsis'], publish: 'never',
    config: { extraResources: [{ from: extensionStage, to: 'browser-extension', filter: ['**/*'] }] } });

  const installer = `ProductComparison-${updateVersion}-x64.exe`;
  if (!fs.existsSync(path.join(releaseDir, installer))) throw new Error('electron-builder 未生成 NSIS 安装器');
  const installerTarget = path.join(desktopTarget, `${desktopName}-Installer.exe`);
  deliverFile(path.join(releaseDir, installer), installerTarget);
  const unpackedDir = path.join(releaseDir, 'win-unpacked');
  if (!fs.existsSync(path.join(unpackedDir, 'ProductComparison.exe'))) throw new Error('Windows 解包目录缺少桌面程序');
  const portableZip = path.join(desktopTarget, `${desktopName}-Portable.zip`);
  deliverArchive(unpackedDir, portableZip);

  const extensionZip = path.join(desktopTarget, `${extensionName}.zip`);
  deliverArchive(extensionStage, extensionZip);
  fs.copyFileSync(extensionZip, path.join(releaseDir, `${extensionName}.zip`));

  const unpackedTarget = path.join(desktopTarget, extensionName);
  const folderMarker = path.join(unpackedTarget, '.codex-release-stage');
  if (fs.existsSync(unpackedTarget) && (!fs.existsSync(folderMarker) || fs.readFileSync(folderMarker, 'utf8') !== releaseMarker)) {
    throw new Error(`桌面上已有同名目录，已保留：${unpackedTarget}`);
  }
  remove(unpackedTarget);
  copyTree(extensionStage, unpackedTarget);
  fs.writeFileSync(path.join(unpackedTarget, '.codex-release-stage'), releaseMarker, 'utf8');

  const bundleStage = path.join(releaseDir, `${desktopName}-Bundle`);
  remove(bundleStage);
  fs.mkdirSync(bundleStage, { recursive: true });
  fs.copyFileSync(installerTarget, path.join(bundleStage, path.basename(installerTarget)));
  fs.copyFileSync(extensionZip, path.join(bundleStage, path.basename(extensionZip)));
  fs.writeFileSync(path.join(bundleStage, '使用说明.txt'), [
    `找商品工作台 ${version}`,
    '',
    '1. 运行 Installer.exe 安装桌面应用，使用已有的云端 TDL 账号和密码登录。',
    '2. TDL 登录后自动使用后台托管视觉模型；设置中可按需添加自己的 OpenAI 兼容模型。',
    '3. 客户端已内置浏览器插件：进入“使用说明”，点击“准备插件”并打开插件文件夹。也可使用随包提供的插件 ZIP。',
    '4. Chrome 打开 chrome://extensions，Edge 打开 edge://extensions。开启开发人员模式，加载客户端准备的插件文件夹；该固定目录请保留，更新插件后点击扩展的重新加载。',
    '5. 在桌面应用“设置”中复制配对信息，到插件工作台填写本机地址和配对码并启用“交给 Electron 比对”。',
    '6. 在“抖音主图”每个商品首张主图下载完成后，系统自动经已配对扩展搜索四个平台；浏览器会保持供应商登录会话。搜图不会自动调用模型。',
    '7. 模型建议显示后由人工核对。人工确认“疑似同款”时，客户端会自动将详情页交给已配对的浏览器扩展采集页面可见商品资料和图片地址，并关联回同一候选；其他结论不抓取详情。',
    '8. 单图可直接选图搜索；多图点击“批量添加图片”（每组最多10张），逐张设置款号或成本后点击“依次搜索未搜索图片”。搜图本身不会调用模型。',
    '9. 识别结果优先展示待人工核对、需重试、已排除和确认同款。按平台和状态筛选，直接确认同款、排除或无法判断，无需重新评分；未完成候选自动重试最多3次，手动开启新一轮后恢复3次自动重试额度。备注只留档，不会自动训练模型。“软件更新”登录后自动检查，发现新版可忽略公告或立即下载。',
    '10. 自动买手可导入 XLSX、CSV、TSV，每行一个商品链接，单批及本机任务总量最多500件。分享文案会自动提取链接；正常商品自动排队，异常商品单独进入待处理。也可用辅助工具批量导入最多50张商品图。',
    '11. 淘宝需在加载找商品插件的同一浏览器登录。安全验证会暂停淘宝队列；完成验证后继续，失败项可单独重试。买手工作台首先导入运营链接；自动任务和例外在同页追踪，识别记录用于查看比对和审核，抖音主图是可选的辅助输入。',
    '12. 第一阶段未推进时，查看商品卡片或详情中的原因及处理按钮。客户端会提示插件未连接、版本待确认、需要更新或页面采集超时。更新插件文件后必须在浏览器扩展管理页点击重新加载，再重新打开插件工作台。第二阶段找供应商时可逐张查看商品链接图集和候选详情图；人工确认同款后可以直接继续下一步，也可跳转到识别与复核查看模型细节，跳转会定位到相似度最高的候选。',
    '13. 买手任务可在录入表中点击“查看本机任务”继续；另一台电脑留下的供应商搜索/比对异常可点“本机重新开始”，使用本机浏览器登录状态重新读取商品页。其他阶段不允许跨设备接管；互拓提交中的任务必须回原处理电脑核对，避免重复建商品。队列暂停后点击“继续”，当前没有一键批量重试异常商品。',
    '',
    `本机已经解压好的插件目录：${unpackedTarget}`,
    'TDL密码不会保存；记住登录、平台账号及模型Key使用当前Windows用户的系统安全存储加密。',
    '此安装包未进行代码签名。'
  ].join('\r\n'), 'utf8');
  const bundleZip = path.join(desktopTarget, `${desktopName}-Bundle.zip`);
  deliverArchive(bundleStage, bundleZip);

  const delivered = [
    path.join(desktopTarget, `${extensionName}.zip`),
    installerTarget,
    portableZip,
    bundleZip
  ];
  const lines = delivered.map(file => `${sha256(file)}  ${path.basename(file)}`);
  const checksumFile = path.join(desktopTarget, `${desktopName}-SHA256.txt`);
  if (fs.existsSync(checksumFile) && !fs.readFileSync(checksumFile, 'utf8').startsWith(`${releaseMarker}\n`)) {
    throw new Error(`桌面上已有非本次构建的校验文件，已保留：${checksumFile}`);
  }
  await fsp.writeFile(checksumFile, `${releaseMarker}\n${lines.join('\n')}\n`, 'utf8');
  console.log(JSON.stringify({ version, desktopTarget, delivered, extensionFolder: unpackedTarget }, null, 2));
  remove(stageDir);
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
