// Run only against the consistent backup copied into a private release staging folder.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createOnlineTableServer } from './server.mjs';

const [backup, dataDir] = process.argv.slice(2);
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.copyFileSync(backup, path.join(dataDir, 'online-tables.sqlite'));
const service = createOnlineTableServer({ port: 0, dataDir, authUrl: '', logger: { error() {} } });
try {
  const address = await service.start(), origin = `http://127.0.0.1:${address.port}`;
  const request = async (route, body) => {
    const response = await fetch(origin + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const result = await response.json(); assert.ok(response.ok, result.error); return result;
  };
  let listed = await request('/api/tables');
  if (!listed.tables.length) { await request('/api/tables', { name: 'Release probe' }); listed = await request('/api/tables'); }
  const table = listed.tables[0], base = `/api/tables/${table.id}`;
  const written = await request(base + '/rows', { rows: [{ note: 'release-probe-empty' }, { title: 'release-probe-search', sourceUrl: 'https://v.douyin.com/release-probe/' }] });
  assert.equal(written.table.rowCount, table.rowCount + 1);
  assert.equal(written.table.rowTotal, table.rowTotal + 2);
  const found = await request(base + '/find?search=release-probe-search');
  assert.equal(found.row.id, written.rows[1].id);
  const located = await request(base + `/locate?position=${found.row.position}`);
  assert.equal(located.row.id, found.row.id);
  const mutate=async(route,method,body)=>{const response=await fetch(origin+route,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error||`HTTP ${response.status}`);return result;};
  let remote=(await mutate(base+`/rows/${found.row.id}`,'PATCH',{ifVersion:found.row.version,patch:{humanStatus:'approved'}})).row;
  const previousTaskId='11111111-1111-4111-8111-111111111111',newTaskId='22222222-2222-4222-8222-222222222222';
  remote=(await mutate(base+`/claim/${remote.id}`,'POST',{taskId:previousTaskId})).row;
  remote=(await mutate(base+`/rows/${remote.id}`,'PATCH',{ifVersion:remote.version,taskId:previousTaskId,patch:{supplierArticleNo:'SKU-PROBE-001'}})).row;
  assert.equal(remote.articleNo,'SKU-PROBE-001');
  const badSku=await fetch(origin+base+`/rows/${remote.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({ifVersion:remote.version,taskId:previousTaskId,patch:{supplierArticleNo:'OTHER'}})});assert.equal(badSku.status,409);
  remote=(await mutate(base+`/rows/${remote.id}`,'PATCH',{ifVersion:remote.version,patch:{automationState:'attention',automationStep:'supplier_compare',automationError:'候选未识别'}})).row;
  const restarted=(await mutate(base+`/restart/${remote.id}`,'POST',{previousTaskId,taskId:newTaskId,ifVersion:remote.version})).row;
  assert.equal(restarted.taskId,newTaskId);assert.equal(restarted.automationState,'queued');assert.equal(restarted.automationStep,'source');
  const unsafe=await fetch(origin+base+`/restart/${restarted.id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({previousTaskId:newTaskId,taskId:'33333333-3333-4333-8333-333333333333',ifVersion:restarted.version})});
  assert.equal(unsafe.status,409,'source/new task cannot be reclaimed again');
  const history = await request(base + '/history'); assert.ok(history.history.length > 0);
  assert.equal(service.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  console.log(JSON.stringify({ backupMigrationVerified: true, blankRowsVerified: true, productCountsVerified: true, searchAndLocateVerified: true, crossDeviceSupplierRestartVerified: true, supplierArticleBackfillVerified:true, historyVerified: true }));
} finally { await service.close(); }
