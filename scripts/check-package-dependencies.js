const fs = require('node:fs');
const path = require('node:path');

// Only literal relative module imports are inspected. External packages are
// resolved by the real packaged Electron startup check before delivery.
function checkRelativeDependencies({ files, readFile }) {
  const names = new Set(files.map(name => name.replace(/\\/g, '/').replace(/^\//, '')));
  const missing = [];
  let checked = 0;
  for (const file of names) {
    if (!/\.(?:c?js|mjs)$/.test(file) || file.includes('node_modules/')) continue;
    const source = readFile(file).toString();
    const imports = [
      ...source.matchAll(/\b(?:require|import)\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g),
      ...source.matchAll(/\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g)
    ];
    for (const match of imports) {
      const request = match[1];
      // main.js reads the repository manifest only in app.isPackaged === false
      // branches. Production obtains its version from Electron's package.json.
      if (file === 'desktop/main.js' && request === '../manifest.json') continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), request));
      const candidates = [target, ...['.js', '.cjs', '.mjs', '.json'].map(ext => target + ext), target + '/index.js'];
      if (candidates.some(candidate => names.has(candidate))) checked++;
      else missing.push(`${file} -> ${request}`);
    }
  }
  if (missing.length) throw new Error(`打包缺少本地模块：\n${missing.join('\n')}`);
  return { files: names.size, relativeImports: checked };
}

function checkDirectory(root) {
  const files = [];
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.name === 'node_modules') continue;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) files.push(name);
      else throw new Error(`打包包含特殊文件：${name}`);
    }
  }
  visit('');
  return checkRelativeDependencies({ files, readFile: file => fs.readFileSync(path.join(root, file)) });
}

function checkAsar(archive) {
  const asar = require('../desktop/node_modules/@electron/asar');
  const files = asar.listPackage(archive).map(name => name.replace(/\\/g, '/').replace(/^\//, ''))
    .filter(name => !name.includes('node_modules/') && /\.(?:c?js|mjs|json)$/.test(name));
  return checkRelativeDependencies({ files, readFile: file => asar.extractFile(archive, path.normalize(file)) });
}

module.exports = { checkRelativeDependencies, checkDirectory, checkAsar };
if (require.main === module) {
  const target = process.argv[2];
  if (!target) throw new Error('请提供打包目录或 app.asar');
  console.log(JSON.stringify(target.endsWith('.asar') ? checkAsar(target) : checkDirectory(target)));
}
