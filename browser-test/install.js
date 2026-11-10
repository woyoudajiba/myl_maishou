const path = require('node:path');
const { spawnSync } = require('node:child_process');

const packageRoot = path.resolve(__dirname, '..');
const cli = path.join(packageRoot, 'node_modules', 'playwright', 'cli.js');
const result = spawnSync(process.execPath, [cli, 'install', 'chromium', '--no-shell'], {
  cwd: packageRoot,
  env: { ...process.env },
  stdio: 'inherit'
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
