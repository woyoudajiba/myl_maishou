import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOnlineTableServer } from '../server.mjs';
import { startFetchSafeServer } from '../../test/http-fixture.js';

async function setup(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'online-table-'));
  const server = createOnlineTableServer({ port: 0, dataDir, authUrl: options.authUrl || '', fetchImpl: options.fetchImpl, logger: { error() {} } });
  const origin = await startFetchSafeServer(server);
  t.after(async () => { await server.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { origin, headers: { 'Content-Type': 'application/json' } };
}
async function request(origin, route, options = {}) { const response = await fetch(`${origin}${route}`, options); const body = await response.json(); return { response, body }; }

async function tableFixture(t, options={}) {
  const {origin,headers}=await setup(t,options);
  const created=await request(origin,'/api/tables',{method:'POST',headers,body:'{}'}), base=`/api/tables/${created.body.table.id}`;
  const call=(route='',method='GET',body)=>request(origin,base+route,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
  await call('/rows','POST',{rows:[{articleNo:'A1',sourceType:'taobao',sourceUrl:'https://item.taobao.com/item.htm?id=12345678',title:'原始标题'}]});
  return {call,origin,headers,base};
}

test('失败的批量写入不留下半份商品、历史记录或事件',async t=>{
  const {call}=await tableFixture(t);
  const before=(await call()).body, history=(await call('/history')).body.history;
  const failed=await call('/rows','POST',{rows:[{sourceType:'douyin',sourceUrl:'https://v.douyin.com/example/'},{humanStatus:'invalid'}]});
  assert.equal(failed.response.status,400);
  assert.deepEqual((await call()).body,before);
  assert.deepEqual((await call('/history')).body.history,history);
  const invalid=await call(`/rows/${before.rows[0].id}`,'PATCH',{ifVersion:1,patch:{humanStatus:'invalid'}});
  assert.equal(invalid.response.status,400);assert.deepEqual((await call('/history')).body.history,history);
});

test('删除、找回、撤销回档均留痕；旧行版本和旧回档预览失效',async t=>{
  const {call}=await tableFixture(t);const original=(await call()).body.rows[0];
  await call(`/rows/${original.id}`,'DELETE',{ifVersion:original.version});
  assert.equal((await call()).body.rows.length,0);
  const entry=(await call('/history')).body.history[0];assert.equal(entry.action,'delete');
  const detail=(await call(`/history/${entry.id}`)).body;assert.equal(detail.changes[0].before.deleted,false);assert.equal(detail.changes[0].after.deleted,true);
  const plan=(await call(`/rollback/${entry.id}`)).body;assert.equal(plan.added,1);
  assert.equal((await call(`/rollback/${entry.id}`,'POST',{ifRevision:plan.revision})).response.status,200);
  const restored=(await call()).body.rows[0];assert.equal(restored.id,original.id);assert.ok(restored.version>original.version);
  assert.equal((await call(`/rows/${original.id}`,'PATCH',{ifVersion:original.version,patch:{title:'过期覆盖'}})).response.status,409);
  assert.equal((await call(`/rollback/${entry.id}`,'POST',{ifRevision:plan.revision})).response.status,409);
  const undo=(await call('/history')).body.history[0];assert.equal(undo.action,'rollback');
  const undoPlan=(await call(`/rollback/${undo.id}`)).body;
  await call(`/rollback/${undo.id}`,'POST',{ifRevision:undoPlan.revision});assert.equal((await call()).body.rows.length,0);
});

test('回档保留已领取任务和最新互拓编码，不可因回档再次领取',async t=>{
  const {call}=await tableFixture(t);let current=(await call()).body.rows[0];
  await call(`/rows/${current.id}`,'PATCH',{ifVersion:current.version,patch:{humanStatus:'approved'}});
  const claim=(await call(`/claim/${current.id}`,'POST',{})).body.row;
  const receipt=(await call(`/rows/${current.id}`,'PATCH',{ifVersion:claim.version,patch:{erpProductNo:'ERP-001',automationState:'completed'}})).body.row;
  const entry=(await call('/history')).body.history.find(item=>item.action==='claim');
  const plan=(await call(`/rollback/${entry.id}`)).body;assert.equal(plan.protectedRows,1);
  await call(`/rollback/${entry.id}`,'POST',{ifRevision:plan.revision});current=(await call()).body.rows[0];
  assert.equal(current.taskId,claim.taskId);assert.equal(current.erpProductNo,receipt.erpProductNo);assert.equal(current.automationState,'completed');assert.equal(current.humanStatus,'approved');
  const count=(await call('/history')).body.history.length;
  assert.equal((await call(`/claim/${current.id}`,'POST',{})).response.status,409);assert.equal((await call('/history')).body.history.length,count);
});

test('超过单次导入上限的完整表仍可恢复，并支持历史分页',async t=>{
  const {call}=await tableFixture(t);
  await call('/rows','POST',{rows:Array.from({length:1000},(_,i)=>({articleNo:`B${i}`,sourceType:'taobao',sourceUrl:`https://item.taobao.com/item.htm?id=${i+10000000}`}))});
  const current=(await call()).body;assert.equal(current.table.rowCount,1001);
  await call('/clear','POST',{ifRevision:current.table.revision});
  const entries=(await call('/history?limit=1')).body;assert.ok(entries.nextBefore);
  const older=(await call(`/history?limit=1&before=${entries.nextBefore}`)).body;assert.ok(older.history[0].id<entries.history[0].id);
  const id=entries.history[0].id,plan=(await call(`/rollback/${id}`)).body;
  const restored=await call(`/rollback/${id}`,'POST',{ifRevision:plan.revision});assert.equal(restored.response.status,200);assert.equal(restored.body.table.rowCount,1001);
});

test('增量历史跨检查点和服务重启仍可还原，恢复不自动启动未领取的已确认行',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'table-history-restart-'));let service;
  t.after(async()=>{await service?.close();await fs.rm(dataDir,{recursive:true,force:true});});
  async function start(){service=createOnlineTableServer({port:0,dataDir,logger:{error(){}}});return startFetchSafeServer(service);}
  let origin=await start();const headers={'Content-Type':'application/json'};
  const created=(await request(origin,'/api/tables',{method:'POST',headers,body:'{}'})).body.table;
  const base=`/api/tables/${created.id}`,call=(route='',method='GET',body)=>request(origin,base+route,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
  await call('/rows','POST',{rows:[{sourceType:'taobao',sourceUrl:'https://item.taobao.com/item.htm?id=12345678',selectDate:'11.6',tableId:'01',supplierName:'供应商甲',warehouse:'广州'}]});
  let current=(await call()).body.rows[0];
  for(let i=1;i<=55;i++)current=(await call(`/rows/${current.id}`,'PATCH',{ifVersion:current.version,patch:{title:`标题${i}`,humanStatus:'approved',warehouse:`仓库${i}`}})).body.row;
  assert.ok(service.db.prepare("SELECT COUNT(*) AS count FROM table_history WHERE snapshot_json <> 'null'").get().count<=2,'不会为每次单行修改复制整张表');
  const entries=(await call('/history?limit=100')).body.history;
  const target=entries.find(item=>item.id===54);
  await service.close();service=null;origin=await start();
  const plan=(await call(`/rollback/${target.id}`)).body;
  assert.equal((await call(`/rollback/${target.id}`,'POST',{ifRevision:plan.revision})).response.status,200);
  current=(await call()).body.rows[0];assert.equal(current.title,'标题52');assert.equal(current.warehouse,'仓库52');assert.equal(current.tableId,'01');assert.equal(current.selectDate,'11.6');assert.equal(current.humanStatus,'pending');
});

test('在线表格支持创建、分页、人工确认领取和回执更新', async t => {
  const { origin, headers } = await setup(t);
  const created = await request(origin, '/api/tables', { method: 'POST', headers, body: JSON.stringify({ name: '测试选品表' }) });
  assert.equal(created.response.status, 201); const table = created.body.table, auth = headers;
  const imported = await request(origin, `/api/tables/${table.id}/rows`, { method: 'POST', headers: auth, body: JSON.stringify({ rows: [{ articleNo: 'A1', sourceType: 'taobao', sourceUrl: 'https://item.taobao.com/item.htm?id=12345678' }, { articleNo: 'A2', sourceType: 'douyin', sourceUrl: 'https://v.douyin.com/example/' }] }) });
  assert.equal(imported.response.status, 200); const listed = await request(origin, `/api/tables/${table.id}?offset=0&limit=1`, { headers: auth }); assert.equal(listed.body.rows.length, 1);
  const row = listed.body.rows[0]; const approved = await request(origin, `/api/tables/${table.id}/rows/${row.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ ifVersion: row.version, patch: { humanStatus: 'approved' } }) }); assert.equal(approved.body.row.humanStatus, 'approved');
  const claimed = await request(origin, `/api/tables/${table.id}/claim/${row.id}`, { method: 'POST', headers: auth, body: '{}' }); assert.equal(claimed.body.row.taskId.length, 36); const repeated = await request(origin, `/api/tables/${table.id}/claim/${row.id}`, { method: 'POST', headers: auth, body: '{}' }); assert.equal(repeated.response.status, 409);
  const done = await request(origin, `/api/tables/${table.id}/rows/${row.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ ifVersion: claimed.body.row.version, patch: { automationState: 'completed', erpProductNo: 'ERP-001' } }) }); assert.equal(done.body.row.erpProductNo, 'ERP-001');
});

test('仅供应商搜索/比对异常可原子转移到另一台电脑；旧任务和其他阶段不可接管',async t=>{
  const {call}=await tableFixture(t),listed=await call(),first=listed.body.rows[0],oldTask='10000000-0000-4000-8000-000000000001',newTask='20000000-0000-4000-8000-000000000002';
  const approved=await call(`/rows/${first.id}`,'PATCH',{ifVersion:first.version,patch:{humanStatus:'approved'}});
  const claimed=await call(`/claim/${first.id}`,'POST',{taskId:oldTask});
  const failed=(await call(`/rows/${first.id}`,'PATCH',{ifVersion:claimed.body.row.version,patch:{automationState:'attention',automationStep:'supplier_compare',automationError:'部分候选未识别，补齐结果后再决定供应商'}})).body.row;
  const restarted=await call(`/restart/${first.id}`,'POST',{previousTaskId:oldTask,taskId:newTask,ifVersion:failed.version});
  assert.equal(restarted.response.status,200);assert.equal(restarted.body.row.taskId,newTask);assert.equal(restarted.body.row.automationState,'queued');assert.equal(restarted.body.row.automationStep,'source');assert.equal(restarted.body.row.automationError,'');assert.equal(restarted.body.row.sourceUrl,first.sourceUrl);assert.equal(restarted.body.row.humanStatus,'approved');assert.equal(restarted.body.row.version,failed.version+1);
  assert.equal((await call(`/restart/${first.id}`,'POST',{previousTaskId:oldTask,taskId:'30000000-0000-4000-8000-000000000003',ifVersion:restarted.body.row.version})).response.status,409,'旧任务不能再次接管');
  const second=(await call('/rows','POST',{rows:[{articleNo:'A2',sourceType:'douyin',sourceUrl:'https://v.douyin.com/example/',humanStatus:'approved'}]})).body.rows[0];
  const active=(await call(`/claim/${second.id}`,'POST',{taskId:'40000000-0000-4000-8000-000000000004'})).body.row;
  const unsafe=(await call(`/rows/${second.id}`,'PATCH',{ifVersion:active.version,patch:{automationState:'attention',automationStep:'submit',automationError:'草稿请求结果未知'}})).body.row;
  assert.equal((await call(`/restart/${second.id}`,'POST',{previousTaskId:unsafe.taskId,taskId:'50000000-0000-4000-8000-000000000005',ifVersion:unsafe.version})).response.status,409,'提交/未知回执阶段不得重建');
  const legacy={...restarted.body.row,automationStep:''};
  const legacyPatch=(await call(`/rows/${first.id}`,'PATCH',{ifVersion:restarted.body.row.version,patch:{automationState:'attention',automationStep:'',automationError:'没有证据充分的供应商同款，保留模型建议'}})).body.row;
  const legacyRetry=await call(`/restart/${first.id}`,'POST',{previousTaskId:newTask,taskId:'60000000-0000-4000-8000-000000000006',ifVersion:legacyPatch.version});
  assert.equal(legacyRetry.response.status,200,'旧客户端留下的供应商阶段错误仍可在严格消息匹配后恢复');
  assert.equal(legacy.automationState,'queued');
});

test('在线表允许空白行和缺字段内容，只有商品链接计入商品并可整表查找跳转', async t => {
  const {origin,headers}=await setup(t);
  const created=await request(origin,'/api/tables',{method:'POST',headers,body:'{}'}),tableId=created.body.table.id,base=`/api/tables/${tableId}`;
  const empty=await request(origin,`${base}/rows`,{method:'POST',headers,body:JSON.stringify({rows:[{title:'先记一个标题',note:'链接稍后补'}]})});
  assert.equal(empty.response.status,200);assert.equal(empty.body.table.rowCount,0);assert.equal(empty.body.table.rowTotal,1);
  const link=await request(origin,`${base}/rows`,{method:'POST',headers,body:JSON.stringify({rows:[{sourceUrl:'https://item.taobao.com/item.htm?id=12345678',title:'休闲裤'}]})});
  assert.equal(link.body.table.rowCount,1);assert.equal(link.body.table.rowTotal,2);
  const found=await request(origin,`${base}/find?search=${encodeURIComponent('休闲裤')}`,{headers});assert.equal(found.response.status,200);assert.equal(found.body.total,1);assert.equal(found.body.row.title,'休闲裤');assert.equal(found.body.matchFields.includes('title'),true);
  const located=await request(origin,`${base}/locate?position=${found.body.row.position}`,{headers});assert.equal(located.body.row.id,found.body.row.id);assert.equal(located.body.offset,1);
  const listed=await request(origin,`${base}?limit=20`,{headers});const blank=listed.body.rows.find(row=>!row.sourceUrl);assert.equal(blank.title,'先记一个标题');
  const approved=await request(origin,`${base}/rows/${blank.id}`,{method:'PATCH',headers,body:JSON.stringify({ifVersion:blank.version,patch:{humanStatus:'approved'}})});assert.equal(approved.response.status,400);
  const still=await request(origin,`${base}/history?limit=20`,{headers});assert.equal(still.body.history.at(-1).action,'import');
});

test('空白和待补链接都可保存，确认时才校验；补链接和清空链接同步更新商品数',async t=>{
  const {call}=await tableFixture(t);
  const imported=await call('/rows','POST',{rows:[{}, {note:'先存备注',sourceUrl:'待补链接'}]});
  assert.equal(imported.response.status,200);assert.equal(imported.body.table.rowCount,2);assert.equal(imported.body.table.rowTotal,3);
  const pending=imported.body.rows[1],history=(await call('/history')).body.history.length;
  assert.equal((await call(`/rows/${pending.id}`,'PATCH',{ifVersion:pending.version,patch:{humanStatus:'approved'}})).response.status,400);
  assert.equal((await call(`/claim/${pending.id}`,'POST',{})).response.status,409);
  assert.equal((await call('/history')).body.history.length,history);
  const fixed=(await call(`/rows/${pending.id}`,'PATCH',{ifVersion:pending.version,patch:{sourceUrl:'https://v.douyin.com/test/'}})).body.row;
  assert.equal(fixed.sourceType,'douyin');
  const approved=(await call(`/rows/${pending.id}`,'PATCH',{ifVersion:fixed.version,patch:{humanStatus:'approved'}})).body.row;
  const cleared=(await call(`/rows/${pending.id}`,'PATCH',{ifVersion:approved.version,patch:{sourceUrl:'   '}})).body.row;
  assert.equal(cleared.humanStatus,'pending');assert.equal(cleared.sourceUrl,'');
  assert.equal((await call()).body.table.rowCount,1);assert.equal((await call()).body.table.rowTotal,3);
});

test('跨页查找匹配业务内容和互拓编码，按字面量查找并定位删除后的行号',async t=>{
  const {call}=await tableFixture(t);
  const imported=(await call('/rows','POST',{rows:Array.from({length:120},(_,index)=>({title:index===2||index===119?'跨页共同标题':`普通 ${index}`,supplierName:index===100?'供应商%_甲':''}))})).body;
  const first=(await call('/find?search='+encodeURIComponent('跨页共同标题'))).body;
  const last=(await call('/find?search='+encodeURIComponent('跨页共同标题')+'&index=1')).body;
  assert.equal(first.total,2);assert.equal(last.total,2);assert.equal(last.offset,120);assert.equal(last.row.id,imported.rows[119].id);
  assert.equal((await call('/find?search='+encodeURIComponent('跨页共同标题')+'&index=-1')).body.row.id,last.row.id);
  assert.equal((await call('/find?search='+encodeURIComponent('%_'))).body.total,1);
  assert.equal((await call('/find?search='+encodeURIComponent("%' OR 1=1--"))).body.total,0);
  assert.equal((await call('/find?search=sourceUrl')).body.total,0,'固定字段名不应误匹配为业务内容');
  const erp=imported.rows[90];await call(`/rows/${erp.id}`,'PATCH',{ifVersion:erp.version,patch:{erpProductNo:'ERP-XYZ'}});
  assert.equal((await call('/find?search=ERP-XYZ')).body.row.id,erp.id);
  const gone=imported.rows[10];await call(`/rows/${gone.id}`,'DELETE',{ifVersion:gone.version});
  const located=(await call(`/locate?rowId=${last.row.id}`)).body;assert.equal(located.offset,119);assert.equal(located.row.position,last.row.position);
  assert.equal((await call(`/locate?position=${gone.position}`)).response.status,404);
  assert.equal((await call('?offset=21&limit=100')).body.nextOffset,null,'最后一页恰好 100 行时仍应结束');
});

test('并发编辑使用版本门禁，旧版本不能覆盖他人修改', async t => {
  const { origin, headers } = await setup(t); const created = await request(origin, '/api/tables', { method: 'POST', headers, body: '{}' }); const auth = headers;
  await request(origin, `/api/tables/${created.body.table.id}/rows`, { method: 'POST', headers: auth, body: JSON.stringify({ rows: [{ sourceType: 'wsy', sourceUrl: 'https://www.wsy.com/goods/1' }] }) }); const listed = await request(origin, `/api/tables/${created.body.table.id}?limit=10`, { headers: auth }); const row = listed.body.rows[0];
  const first = request(origin, `/api/tables/${created.body.table.id}/rows/${row.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ ifVersion: row.version, patch: { title: '甲' } }) }); const second = request(origin, `/api/tables/${created.body.table.id}/rows/${row.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ ifVersion: row.version, patch: { title: '乙' } }) }); const results = await Promise.all([first, second]); assert.equal(results.filter(item => item.response.status === 200).length, 1); assert.equal(results.filter(item => item.response.status === 409).length, 1);
});

test('在线表保存每次变更快照，并支持管理员查看历史和回档', async t => {
  const { origin, headers } = await setup(t);
  const created = await request(origin, '/api/tables', { method: 'POST', headers, body: JSON.stringify({ name: '历史表' }) });
  const tableId = created.body.table.id;
  const imported = await request(origin, `/api/tables/${tableId}/rows`, { method: 'POST', headers, body: JSON.stringify({ rows: [{ articleNo: 'A1', sourceType: 'taobao', sourceUrl: 'https://item.taobao.com/item.htm?id=12345678', title: '旧标题' }] }) });
  const row = (await request(origin, `/api/tables/${tableId}?limit=10`, { headers })).body.rows[0];
  const edited = await request(origin, `/api/tables/${tableId}/rows/${row.id}`, { method: 'PATCH', headers, body: JSON.stringify({ ifVersion: row.version, patch: { title: '新标题' } }) }); assert.equal(edited.body.row.title, '新标题');
  const history = await request(origin, `/api/tables/${tableId}/history?limit=20`, { headers }); assert.equal(history.response.status, 200); assert.ok(history.body.history.length >= 2); assert.ok(history.body.history.some(item => item.action === 'import'));
  const first = history.body.history.find(item => item.action === 'import'); assert.equal(first.rowCount, 0);
  const rolled = await request(origin, `/api/tables/${tableId}/rollback/${first.id}`, { method: 'POST', headers, body: JSON.stringify({ifRevision:(await request(origin, `/api/tables/${tableId}/rollback/${first.id}`, {headers})).body.revision}) }); assert.equal(rolled.response.status, 200); assert.equal(rolled.body.historyId, first.id);
  const after = await request(origin, `/api/tables/${tableId}?limit=10`, { headers }); assert.equal(after.body.rows.length, 0);
  const afterHistory = await request(origin, `/api/tables/${tableId}/history?limit=20`, { headers }); assert.ok(afterHistory.body.history.some(item => item.action === 'rollback'));
});

test('误清空前保存快照，管理员可回档清空前状态', async t => {
  const fetchImpl = async (_url, options) => Response.json({ user: { id: 'admin', username: 'admin', isAdmin: true } });
  const { origin, headers } = await setup(t, { authUrl: 'https://tdl.test/me', fetchImpl }); const auth = { ...headers, Authorization: 'Bearer admin' };
  const table = (await request(origin, '/api/tables', { method: 'POST', headers: auth, body: '{}' })).body.table;
  await request(origin, `/api/tables/${table.id}/rows`, { method: 'POST', headers: auth, body: JSON.stringify({ rows: [{ sourceType: 'douyin', sourceUrl: 'https://v.douyin.com/example/' }] }) });
  const before = (await request(origin, `/api/tables/${table.id}/history?limit=20`, { headers: auth })).body.history.find(item => item.action === 'import');
  const cleared = await request(origin, `/api/tables/${table.id}/clear`, { method: 'POST', headers: auth, body: JSON.stringify({ifRevision:(await request(origin, `/api/tables/${table.id}`, {headers:auth})).body.table.revision}) }); assert.equal(cleared.response.status, 200); assert.equal(cleared.body.table.rowCount, 0);
  const clearHistory = (await request(origin, `/api/tables/${table.id}/history?limit=20`, { headers: auth })).body.history.find(item => item.action === 'clear'); assert.ok(clearHistory); assert.equal(clearHistory.rowCount, 1);
  const restored = await request(origin, `/api/tables/${table.id}/rollback/${clearHistory.id}`, { method: 'POST', headers: auth, body: JSON.stringify({ifRevision:(await request(origin, `/api/tables/${table.id}/rollback/${clearHistory.id}`, {headers:auth})).body.revision}) }); assert.equal(restored.response.status, 200); assert.equal(restored.body.table.rowCount, 1);
  assert.equal((await request(origin, `/api/tables/${table.id}?limit=10`, { headers: auth })).body.rows.length, 1); assert.ok(before);
});

test('TDL 登录即可使用共享表；只允许管理员创建，接口不签发或要求表格访问令牌', async t => {
  const fetchImpl = async (_url, options) => {
    const token = options.headers.Authorization;
    if (token === 'Bearer admin') return Response.json({ user: { id: 'admin-id', username: 'admin', isAdmin: true } });
    if (token === 'Bearer buyer-a') return Response.json({ user: { id: 'buyer-a', username: 'buyer-a', isAdmin: false } });
    if (token === 'Bearer buyer-b') return Response.json({ user: { id: 'buyer-b', username: 'buyer-b', isAdmin: false } });
    return new Response('{}', { status: 401 });
  };
  const { origin, headers } = await setup(t, { authUrl: 'https://tdl.test/me', fetchImpl });
  const adminHeaders = { ...headers, Authorization: 'Bearer admin' };
  const buyerAHeaders = { ...headers, Authorization: 'Bearer buyer-a' };
  const buyerBHeaders = { ...headers, Authorization: 'Bearer buyer-b' };
  const unauthenticated = await request(origin, '/api/tables', { headers });
  assert.equal(unauthenticated.response.status, 401);
  const denied = await request(origin, '/api/tables', { method: 'POST', headers: buyerAHeaders, body: '{}' });
  assert.equal(denied.response.status, 403);
  const created = await request(origin, '/api/tables', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: '全员买手表' }) });
  assert.equal(created.response.status, 201);
  assert.equal('accessToken' in created.body, false);
  const listed = await request(origin, '/api/tables', { headers: buyerAHeaders });
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.tables.length, 1);
  const tableId = listed.body.tables[0].id;
  const imported = await request(origin, `/api/tables/${tableId}/rows`, { method: 'POST', headers: buyerAHeaders, body: JSON.stringify({ rows: [{ sourceType: 'taobao', sourceUrl: 'https://item.taobao.com/item.htm?id=12345678' }] }) });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.body.imported, 1);
  const visibleToOtherAccount = await request(origin, `/api/tables/${tableId}?limit=10`, { headers: buyerBHeaders });
  assert.equal(visibleToOtherAccount.response.status, 200);
  assert.equal(visibleToOtherAccount.body.rows.length, 1);
  const duplicate = await request(origin, '/api/tables', { method: 'POST', headers: adminHeaders, body: '{}' });
  assert.equal(duplicate.response.status, 409);
  const allTables = await request(origin, '/api/tables', { headers: buyerBHeaders });
  assert.equal(allTables.body.tables.length, 1);
  const history = await request(origin, `/api/tables/${tableId}/history`, {headers:buyerBHeaders});
  assert.equal(history.response.status,200);assert.match(history.body.history[0].actor,/buyer-a/);
  const entry=history.body.history[0];
  assert.equal((await request(origin,`/api/tables/${tableId}/rollback/${entry.id}`,{headers:buyerBHeaders})).response.status,403);
  assert.equal((await request(origin,`/api/tables/${tableId}/rollback/${entry.id}`,{method:'POST',headers:buyerBHeaders,body:'{}'})).response.status,403);
  assert.equal((await request(origin,`/api/tables/${tableId}/clear`,{method:'POST',headers:buyerBHeaders,body:'{}'})).response.status,403);
});
