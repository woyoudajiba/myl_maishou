const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const asar = require('../desktop/node_modules/@electron/asar');
const Zip = require('../desktop/node_modules/adm-zip');
const yaml = require('../desktop/node_modules/js-yaml');
const { checkAsar } = require('./check-package-dependencies');
const root = path.resolve(__dirname, '..');
const release = path.join(root, 'desktop/release');
const display = require('../manifest.json').version_name;
const canonical = require('../desktop/updates').updateVersion(display);
const qa = path.join(root, 'output/qa', `release-${display}`);
const bundle = path.join(release, 'win-unpacked/resources/app.asar');
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(bytes).digest(encoding);
const same = (left, right, label) => assert.equal(hash(left), hash(right), label);

const dependencies = checkAsar(bundle);
const bundledPackage = JSON.parse(asar.extractFile(bundle, 'package.json'));
assert.equal(bundledPackage.version, canonical);
for (const file of ['desktop/buyer-draft-view.js', 'desktop/buyer-drafts-renderer.js']) {
  same(fs.readFileSync(path.join(root, file)), asar.extractFile(bundle, path.normalize(file)), file);
}
let appSourceFiles = 0;
for (const item of asar.listPackage(bundle)) {
  const file = item.replace(/\\/g, '/').replace(/^\//, '');
  if (file.includes('node_modules/') || !/\.(?:js|mjs|html|css)$/.test(file)) continue;
  const source = path.join(root, file);
  if (fs.existsSync(source) && fs.statSync(source).isFile()) {
    same(fs.readFileSync(source), asar.extractFile(bundle, path.normalize(file)), file);
    appSourceFiles++;
  }
}
const extensionName = `ProductComparison-BrowserExtension-${display}.zip`;
const zip = new Zip(path.join(release, extensionName));
const extensionFiles = require('../desktop/extension').extensionFiles;
for (const file of extensionFiles) {
  const source = fs.readFileSync(path.join(root, file));
  same(source, zip.readFile(file), file);
  same(source, fs.readFileSync(path.join(release, 'win-unpacked/resources/browser-extension', file)), file);
}
const latest = yaml.load(fs.readFileSync(path.join(release, 'latest.yml'), 'utf8'));
assert.equal(latest.version, canonical);
const installer = fs.readFileSync(path.join(release, latest.path));
assert.equal(installer.length, latest.files[0].size);
assert.equal(hash(installer, 'sha512', 'base64'), latest.files[0].sha512);
for (const file of ['ProductComparison.exe', 'resources/app.asar']) {
  same(fs.readFileSync(path.join(qa, 'installer-payload', file)), fs.readFileSync(path.join(release, 'win-unpacked', file)), `Installer payload: ${file}`);
}
const report = {
  version: display, updateVersion: canonical, dependencies, appSourceFilesVerified: appSourceFiles,
  extensionSourceFilesVerified: extensionFiles.length, installerPayloadMatchesTestedExecutable: true,
  installer: { size: installer.length, sha256: hash(installer), sha512: latest.files[0].sha512 },
  extension: { sha256: hash(fs.readFileSync(path.join(release, extensionName))) }
};
fs.writeFileSync(path.join(qa, 'artifact-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
