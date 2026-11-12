const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const yaml = require('../desktop/node_modules/js-yaml');
const display = require('../manifest.json').version_name;
const canonical = require('../desktop/updates').updateVersion(display);
const base = 'https://wsfile.cn/productC/';
const release = path.resolve(__dirname, '../desktop/release');
const output = path.resolve(__dirname, '../output/qa', `release-${display}`);

async function main() {
  const feedResponse = await fetch(base + 'updates/latest.yml', { signal: AbortSignal.timeout(20000) });
  assert.equal(feedResponse.status, 200);
  const feed = yaml.load(await feedResponse.text());
  assert.equal(feed.version, canonical);
  const installerName = feed.files[0].url;
  const extensionName = `ProductComparison-BrowserExtension-${display}.zip`;
  const pageResponse = await fetch(base, { signal: AbortSignal.timeout(20000) });
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  for (const value of [display, installerName, extensionName]) assert.ok(page.includes(value), value);
  const files = [];
  for (const name of [installerName, extensionName, installerName + '.blockmap']) {
    const response = await fetch(base + 'updates/' + name, { signal: AbortSignal.timeout(120000) });
    assert.equal(response.status, 200);
    const sha256 = crypto.createHash('sha256');
    const sha512 = crypto.createHash('sha512');
    let size = 0;
    for await (const chunk of response.body) { sha256.update(chunk); sha512.update(chunk); size += chunk.length; }
    const digest = sha256.digest('hex');
    const local = await fs.readFile(path.join(release, name));
    assert.equal(digest, crypto.createHash('sha256').update(local).digest('hex'));
    if (name === installerName) { assert.equal(size, feed.files[0].size); assert.equal(sha512.digest('base64'), feed.files[0].sha512); }
    files.push({ name, size, status: response.status, sha256: digest, matchesLocal: true });
  }
  const range = await fetch(base + 'updates/' + installerName, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(20000) });
  assert.equal(range.status, 206);
  const bytes = Buffer.from(await range.arrayBuffer());
  assert.equal(bytes.length, 1024);
  assert.deepEqual(bytes, (await fs.readFile(path.join(release, installerName))).subarray(0, 1024));
  const report = { version: display, feedVersion: feed.version, downloadPage: pageResponse.status, feedStatus: feedResponse.status, files, range: { status: range.status, first1024Match: true } };
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'public-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
