const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createServer,ErpMappingStore}=require('../server');
test('账号密码云端保存、无公司映射、权限隔离、指定 HTTP 测试服和真实代理请求头',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'erp-cloud-'));let service;
 t.after(async()=>{await service?.close();await fs.rm(dir,{recursive:true,force:true});});
 const file=path.join(dir,'map.json'),store=new ErpMappingStore(file,Buffer.alloc(32,7).toString('hex'));await store.load();const calls=[];
 service=createServer({erpMappings:store,env:{ERP_HTTP_TEST_ORIGIN:'http://erp-test.fixture:88'},fetchImpl:async(url,options={})=>{
  if(String(url).includes('/auth/me')){const token=options.headers.Authorization;if(token==='Bearer expired')return Response.json({},{status:401});const id=token==='Bearer admin'?'admin':token==='Bearer other'?'other':'buyer';return Response.json({user:{id,username:id,isAdmin:id==='admin'}});}
  calls.push({url:String(url),options});if(String(url).endsWith('/system/oauth2/token'))return Response.json({code:0,data:{access_token:'hidden-access',refresh_token:'hidden-refresh',expires_in:3600}});
  return Response.json({code:0,data:String(url).includes('/get-permission-info')?{user:{nickname:'买手'}}:[{value:'fixture'}]});
 }});const address=await service.listen(0,'127.0.0.1'),origin=`http://127.0.0.1:${address.port}`;
 const api=async(route,token='buyer',method='GET',body)=>{const response=await fetch(origin+route,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};
 assert.equal((await api('/erp-config/me','expired')).status,401);
 assert.equal((await api('/erp-config/settings','buyer')).status,403);
 assert.equal((await api('/erp-config/me','buyer','PUT',{username:'my-erp',password:'private-password',erpBaseUrl:'http://evil.fixture'})).status,400);
 assert.equal((await api('/erp-config/me','buyer','PUT',{username:'my-erp',password:'private-password'})).status,200);
 const config={erpBaseUrl:'http://erp-test.fixture:88/prod-api/admin-api',erpTenantId:'1',erpClientId:'default',erpClientSecret:'private-secret'};
 assert.equal((await api('/erp-config/settings','admin','PUT',{...config,erpBaseUrl:'http://evil.fixture/api'})).status,400);
 const settings=await api('/erp-config/settings','admin','PUT',config);assert.equal(settings.status,200);assert.equal(settings.body.serviceReady,true);assert.equal(JSON.stringify(settings.body).includes('private-secret'),false);
 const mine=(await api('/erp-config/me')).body;assert.equal(mine.ready,true);assert.equal(mine.config.baseUrl,'https://wsfile.cn/maishou/api');assert.equal(mine.account.username,'my-erp');assert.equal(JSON.stringify(mine).includes('private-password'),false);
 assert.equal((await api('/erp-config/me','other')).body.ready,false);assert.equal((await api('/erp-config/accounts/buyer','other','DELETE')).status,403);
 const checked=await api('/erp-config/test','buyer','POST');assert.equal(checked.status,200);assert.equal(checked.body.dictionaries,1);
 assert.equal((await api('/system/dict-data/list-all-simple')).status,200);
 assert.equal((await api('/system/auth/get-permission-info')).status,200);
 const grant=calls.find(item=>item.url.endsWith('/token'));assert.equal(grant.options.headers['tenant-id'],'1');assert.equal(grant.options.redirect,'error');assert.equal(new URLSearchParams(grant.options.body).get('username'),'my-erp');
 assert.equal((await api('/erp-config/accounts/buyer/test','admin','POST')).body.ok,true);
 assert.equal((await api('/erp-config/accounts/buyer','admin','PUT',{username:'changed',password:''})).status,400);
 assert.equal((await api('/erp-config/accounts/buyer','admin','PUT',{username:'my-erp',password:'',company:'x'})).status,400);
 assert.equal((await api('/erp-config/accounts/buyer','admin','PUT',{username:'my-erp',password:''})).status,200);
 const encrypted=await fs.readFile(file,'utf8');assert.equal(encrypted.includes('private-password'),false);assert.equal(encrypted.includes('private-secret'),false);
 assert.equal((await api('/erp-config/me','buyer','DELETE')).status,200);assert.equal((await api('/erp-config/me')).body.ready,false);
});
