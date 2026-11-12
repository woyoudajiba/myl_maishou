const test = require('node:test');
const assert = require('node:assert/strict');
const { checkRelativeDependencies } = require('../scripts/check-package-dependencies');

test('打包依赖检查拦截遗漏的间接模块，并支持ERP动态导入', () => {
  const source = {
    'desktop/main.js': "require('./buyer-providers'); const version = app.isPackaged ? app.getVersion() : require('../manifest.json').version_name;",
    'desktop/buyer-providers.js': "require('./model-retry'); import('./erp/contract.mjs'); require('../review');",
    'desktop/erp/contract.mjs': "import { randomUUID } from 'node:crypto';",
    'review.js': 'module.exports = {};'
  };
  const check = () => checkRelativeDependencies({ files: Object.keys(source), readFile: file => Buffer.from(source[file]) });
  assert.throws(check, /desktop\/buyer-providers\.js -> \.\/model-retry/);
  source['desktop/model-retry.js'] = 'module.exports = { retryModelJson() {} };';
  assert.equal(check().relativeImports, 4);
  delete source['desktop/erp/contract.mjs'];
  assert.throws(check, /\.\/erp\/contract\.mjs/);
});
