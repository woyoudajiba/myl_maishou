const test = require('node:test');
const assert = require('node:assert/strict');
const { OnlineTableClient, DEFAULT_TABLE_SERVICE_URL, safeBaseUrl } = require('../desktop/online-table-client');

test('在线表新增和修改从分享文案提取唯一商品链接，多个商品拒绝歧义且不丢草稿',async()=>{
  const requests=[],id='7d3790f7-5407-4963-9999-5a2521207e08';
  const client=new OnlineTableClient({tableId:id,authToken:'fixture',transport:async(_url,options)=>{requests.push(JSON.parse(options.body));return Response.json({ok:true});}});
  await client.importRows([{sourceUrl:'推荐这件：https://v.douyin.com/DfVjoLZW2Fc/ JEEP秋冬外套，复制打开！',sourceType:'taobao',note:'原备注'}]);
  assert.equal(requests[0].rows[0].sourceUrl,'https://v.douyin.com/DfVjoLZW2Fc/');assert.equal(requests[0].rows[0].sourceType,'douyin');assert.equal(requests[0].rows[0].note,'原备注');
  await client.updateRow(id,{sourceUrl:'【商品】https://item.taobao.com/item.htm?id=12345678&spm=x。点击查看'},2);
  assert.equal(requests[1].patch.sourceUrl,'https://item.taobao.com/item.htm?id=12345678');
  await assert.rejects(()=>client.updateRow(id,{sourceUrl:'https://v.douyin.com/a/ https://v.douyin.com/b/'},2),/多个商品链接/);
  assert.equal(requests.length,2);
  await client.importRows([{sourceUrl:'链接待补'}]);assert.equal(requests[2].rows[0].sourceUrl,'链接待补');
});

test('共享在线表固定连接找商品自有服务，只使用当前 TDL 会话且不发送访问令牌', async () => {
  const id = '7d3790f7-5407-4963-9999-5a2521207e08';
  const requests = [];
  const client = new OnlineTableClient({ authToken: 'tdl-session', transport: async (url, options) => {
    requests.push({ url, options });
    if (String(url).endsWith('/api/tables')) return Response.json({ ok: true, tables: [{ id, name: '共享买手表' }] });
    return Response.json({ ok: true, table: { id, name: '共享买手表', rowCount: 0 }, rows: [], offset: 0, nextOffset: null });
  } });
  assert.equal(client.baseUrl, DEFAULT_TABLE_SERVICE_URL);
  const { tables } = await client.listTables();
  client.select(tables[0].id);
  const result = await client.getRows();
  assert.equal(result.table.id, id);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer tdl-session');
  assert.equal('X-Table-Token' in requests[0].options.headers, false);
  assert.match(requests[0].url, /^https:\/\/wsfile\.cn\/maishou\/api\/online-table\/api\/tables$/);
  assert.throws(() => safeBaseUrl('https://external.example/table'), /找商品云服务/);
  assert.throws(() => safeBaseUrl('http://external.example/table'), /找商品云服务/);
});

test('跨电脑重新开始仅发送旧任务ID、新本机ID与行版本，拒绝无效任务绑定',async()=>{
  const tableId='7d3790f7-5407-4963-9999-5a2521207e08',rowId='7d3790f7-5407-4963-9999-5a2521207e09',previousTaskId='7d3790f7-5407-4963-9999-5a2521207e10',taskId='7d3790f7-5407-4963-9999-5a2521207e11';let request;
  const client=new OnlineTableClient({tableId,authToken:'fixture',transport:async(url,options)=>{request={url:String(url),body:JSON.parse(options.body)};return Response.json({ok:true,row:{id:rowId,taskId,version:8}});}});
  const result=await client.restartRow(rowId,{previousTaskId,taskId,ifVersion:7});
  assert.equal(result.row.taskId,taskId);assert.match(request.url,new RegExp(`/api/tables/${tableId}/restart/${rowId}$`));assert.deepEqual(request.body,{previousTaskId,taskId,ifVersion:7});
  await assert.rejects(()=>client.restartRow(rowId,{previousTaskId,taskId:previousTaskId,ifVersion:7}),/参数无效/);
});

test('在线表区分超时、域名故障和登录失效，错误不会回显凭据',async()=>{
  const options={authToken:'do-not-leak'};
  const timeout=new OnlineTableClient({...options,transport:async()=>{throw Object.assign(new Error('secret'),{name:'TimeoutError'});}});
  await assert.rejects(()=>timeout.listTables(),/请求超时/);
  const dns=new OnlineTableClient({...options,transport:async()=>{throw Object.assign(new Error('secret'),{cause:{code:'ENOTFOUND'}});}});
  await assert.rejects(()=>dns.listTables(),/域名/);
  const denied=new OnlineTableClient({...options,transport:async()=>Response.json({error:'登录凭据已失效'},{status:401})});
  await assert.rejects(()=>denied.listTables(),error=>error.status===401&&error.message==='登录凭据已失效');
});

test('回档或人工编辑后，原任务只重试自己的流程回写，保留用户字段并拒绝不同任务',async()=>{
  const tableId='7d3790f7-5407-4963-9999-5a2521207e08',rowId='7d3790f7-5407-4963-9999-5a2521207e09',requests=[];
  const client=new OnlineTableClient({tableId,authToken:'fixture',transport:async(_url,options)=>{
    requests.push(JSON.parse(options.body));
    return requests.length===1?Response.json({error:'版本冲突',current:{taskId:'own-task',version:5}},{status:409}):Response.json({row:{version:6}});
  }});
  await client.updateTask(rowId,'own-task',{automationState:'completed',automationStep:'completed',erpProductNo:'ERP001',title:'不能覆盖人工标题'},2);
  assert.equal(requests[1].ifVersion,5);assert.deepEqual(requests[1].patch,{automationState:'completed',automationStep:'completed',erpProductNo:'ERP001'});
  assert.equal(requests[0].taskId,'own-task');assert.equal(requests[1].taskId,'own-task');
  requests.length=0;
  await assert.rejects(()=>client.updateTask(rowId,'other-task',{automationState:'completed'},2),error=>error.status===409);assert.equal(requests.length,1);
});
