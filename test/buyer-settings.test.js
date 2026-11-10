const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { BuyerSettings } = require('../desktop/buyer-settings');
const { DEFAULT_TABLE_SERVICE_URL } = require('../desktop/online-table-client');

const storage = { encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() };
const tableId = '7d3790f7-5407-4963-9999-5a2521207e08';

test('买手自行配置不需要公司；重载和刷新授权保留个人配置，清除会真正删除凭据',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'buyer-personal-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const settings=new BuyerSettings({dataDir,storage});await settings.load();
  const saved=await settings.save({erpBaseUrl:'https://erp.example/api',erpTenantId:'1',erpClientId:'client',erpClientSecret:'fixture-secret',erpUsername:'buyer',erpPassword:'fixture-password'});
  assert.equal(saved.configured,true);assert.equal(saved.company,'');assert.equal(saved.managed,false);
  const restored=new BuyerSettings({dataDir,storage});await restored.load();
  const previous=global.fetch;global.fetch=async()=>{throw new Error('不应访问服务器映射');};
  try{assert.equal((await restored.syncManaged('tdl-token')).configured,true);}finally{global.fetch=previous;}
  await assert.rejects(()=>restored.save({erpUsername:'other-buyer'}),/对应密码/);assert.equal(restored.snapshot().erpUsername,'buyer');
  await restored.save({erpPassword:'',erpClientSecret:'',buyerName:'采购员'});assert.equal(restored.value.erpPassword,'fixture-password');
  await restored.clearLocal();const cleared=new BuyerSettings({dataDir,storage});await cleared.load();assert.equal(cleared.configured(),false);assert.equal(cleared.snapshot().hasPassword,false);assert.equal(cleared.snapshot().hasClientSecret,false);
  const persisted=storage.decrypt(JSON.parse(await fs.readFile(cleared.file,'utf8')).encrypted);assert.equal(persisted.includes('fixture-password'),false);assert.equal(persisted.includes('fixture-secret'),false);
});

test('在线表格地址固定为自有服务，仅保存共享表 ID；旧配置中的 token 和外链会迁移移除', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buyer-settings-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'buyer-settings.json');
  const legacy = { erpBaseUrl: '', onlineTableBaseUrl: 'https://external.example/table', onlineTableId: tableId, onlineTableToken: 'old-access-token', onlineTableUserToken: 'old-bearer-token' };
  await fs.writeFile(file, JSON.stringify({ encrypted: storage.encrypt(JSON.stringify(legacy)) }));
  const settings = new BuyerSettings({ dataDir, storage });
  const snapshot = await settings.load();
  assert.equal(snapshot.onlineTableBaseUrl, DEFAULT_TABLE_SERVICE_URL);
  assert.equal(snapshot.onlineTableConfigured, true);
  assert.equal('onlineTableToken' in snapshot, false);
  const saved = storage.decrypt(JSON.parse(await fs.readFile(file, 'utf8')).encrypted);
  assert.equal(saved.includes('old-access-token'), false);
  assert.equal(saved.includes('old-bearer-token'), false);
  assert.equal(saved.includes('external.example'), false);
  await settings.save({ onlineTableId: '' });
  assert.equal(settings.snapshot().onlineTableConfigured, false);
  assert.equal(settings.snapshot().onlineTableBaseUrl, DEFAULT_TABLE_SERVICE_URL);
});
test('买手资料目录必须使用绝对路径且按账号设置持久化',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'buyer-root-setting-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));const settings=new BuyerSettings({dataDir,storage});await settings.load();
  await assert.rejects(settings.save({productRootDir:'relative-folder'}),/绝对路径/);const root=path.resolve(dataDir,'买手');await settings.save({productRootDir:root});assert.equal(settings.snapshot().productRootDir,root);const restored=new BuyerSettings({dataDir,storage});await restored.load();assert.equal(restored.snapshot().productRootDir,root);
});
test('TDL 登录后自动同步服务端互拓映射，不把互拓密码写入桌面快照',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'buyer-managed-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));const previous=global.fetch;global.fetch=async(url,options)=>{assert.equal(url,'https://wsfile.cn/maishou/api/erp-config/me');assert.equal(options.headers.Authorization,'Bearer tdl-token');return Response.json({ready:true,config:{baseUrl:'https://wsfile.cn/maishou/api',tenantId:'managed',username:'erp-buyer',company:'厦门',buyerName:'采购员'}});};
  try{const settings=new BuyerSettings({dataDir,storage});await settings.load();const snapshot=await settings.syncManaged('tdl-token');assert.equal(snapshot.configured,true);assert.equal(snapshot.managed,true);assert.equal(snapshot.managedUsername,'erp-buyer');assert.equal(Object.hasOwn(snapshot,'erpToken'),false);assert.equal(Object.hasOwn(snapshot,'erpPassword'),false);}finally{global.fetch=previous;}
});
test('托管模式只接受服务器映射，不回退到旧的本机互拓密码配置',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'buyer-managed-only-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));const settings=new BuyerSettings({dataDir,storage,requireManaged:true});await settings.load();
  await settings.save({erpBaseUrl:'https://erp.example.test/api',erpTenantId:'1',erpClientId:'client',erpClientSecret:'secret',erpUsername:'buyer',erpPassword:'password',company:'厦门'}).catch(()=>{});
  assert.equal(settings.configured(),false);assert.equal(Object.hasOwn(settings.snapshot(),'erpPassword'),false);assert.equal(Object.hasOwn(settings.snapshot(),'erpClientSecret'),false);await assert.rejects(settings.erp(),/管理员关联互拓账号/);
});

test('服务器托管互拓映射不要求所属公司',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'buyer-managed-no-company-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const previous=global.fetch;
  global.fetch=async()=>Response.json({ready:true,config:{baseUrl:'https://wsfile.cn/maishou/api',tenantId:'managed',username:'erp-buyer'}});
  try{const settings=new BuyerSettings({dataDir:dir,storage});const snapshot=await settings.syncManaged('tdl-token');assert.equal(snapshot.configured,true);assert.equal(snapshot.managed,true);}finally{global.fetch=previous;}
});
