const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createServer,ErpMappingStore}=require('../server');
test('遗留加密设置及测试开关不能改变真实代理的正式目标',async t=>{
 const calls=[],erpMappings={load:async()=>{},getSettings:()=>({erpBaseUrl:'http://legacy.fixture:88/prod-api/admin-api',erpTenantId:'1',erpClientId:'client',erpClientSecret:'secret'}),get:()=>({username:'buyer',password:'password',enabled:true})};
 const service=createServer({erpMappings,env:{ERP_TEST_MODE:'true',ERP_BASE_URL:'http://legacy.fixture:88/prod-api/admin-api',FORMAL_ERP_BASE_URL:'http://legacy.fixture:88',ERP_HTTP_TEST_ORIGIN:'http://legacy.fixture:88'},fetchImpl:async(url)=>{
  if(String(url).includes('/auth/me'))return Response.json({user:{id:'buyer',username:'buyer'}});
  calls.push(String(url));return Response.json({code:0,data:String(url).endsWith('/token')?{access_token:'access',refresh_token:'refresh',expires_in:3600}:null});
 }});t.after(()=>service.close());const address=await service.listen(0,'127.0.0.1');
 const response=await fetch(`http://127.0.0.1:${address.port}/taobao/product-crawler/get?id=1073221934071`,{headers:{Authorization:'Bearer test'}});
 assert.equal(response.status,200);assert.deepEqual(calls,['http://8.148.144.131/prod-api/admin-api/system/oauth2/token','http://8.148.144.131/prod-api/admin-api/taobao/product-crawler/get?id=1073221934071']);
});
test('生产默认连接固定正式互拓地址，不读取遗留测试地址',async t=>{
 const service=createServer({env:{},fetchImpl:async(url)=>String(url).includes('/auth/me')?Response.json({user:{id:'admin',username:'admin',isAdmin:true}}):Response.json({code:0,data:[]})});t.after(()=>service.close());
 const address=await service.listen(0,'127.0.0.1');const response=await fetch(`http://127.0.0.1:${address.port}/erp-config/settings`,{headers:{Authorization:'Bearer admin'}});const body=await response.json();
 assert.equal(response.status,200);assert.equal(body.settings.erpBaseUrl,'http://8.148.144.131/prod-api/admin-api');
});
test('直接保存待审核须明确启用，只开放新增接口而非审核或上架',async t=>{
 let posts=0;
 const start=async enabled=>{
  const service=createServer({env:{ERP_DIRECT_SAVE_CONFIRMED:enabled?'true':'false',ERP_TENANT_ID:'1',ERP_CLIENT_ID:'client',ERP_CLIENT_SECRET:'secret'},erpMappings:{rememberUser:async()=>{},get:()=>({username:'buyer',password:'password',enabled:true})},fetchImpl:async(url)=>{
   if(String(url).includes('/auth/me'))return Response.json({user:{id:'buyer',username:'buyer'}});
   if(String(url).endsWith('/token'))return Response.json({code:0,data:{access_token:'access',refresh_token:'refresh',expires_in:1800}});
   posts++;return Response.json({code:0,data:0});
  }});t.after(()=>service.close());const address=await service.listen(0,'127.0.0.1');return 'http://127.0.0.1:'+address.port;
 };
 const headers={Authorization:'Bearer fixture','Content-Type':'application/json'},disabled=await start(false),enabled=await start(true);
 assert.equal((await fetch(disabled+'/erp/product-addition/add',{method:'POST',headers,body:'{}'})).status,403);assert.equal(posts,0);
 assert.equal((await(await fetch(enabled+'/erp-config/me',{headers})).json()).config.canSavePending,true);
 assert.equal((await fetch(enabled+'/erp/product-addition/add',{method:'POST',headers,body:'{}'})).status,200);assert.equal(posts,1);
 assert.equal((await fetch(enabled+'/erp/product-addition/publish',{method:'POST',headers,body:'{}'})).status,404);assert.equal(posts,1);
});
test('账号密码云端保存、无公司映射、权限隔离、正式 ERP 地址约束和真实代理请求头',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'erp-cloud-'));let service;
 t.after(async()=>{await service?.close();await fs.rm(dir,{recursive:true,force:true});});
 const file=path.join(dir,'map.json'),store=new ErpMappingStore(file,Buffer.alloc(32,7).toString('hex'));await store.load();const calls=[];
 service=createServer({erpMappings:store,env:{ERP_TEST_MODE:'true',ERP_BASE_URL:'http://legacy.fixture:88/prod-api/admin-api',ERP_HTTP_TEST_ORIGIN:'http://legacy.fixture:88'},fetchImpl:async(url,options={})=>{
  if(String(url).includes('/auth/me')){const token=options.headers.Authorization;if(token==='Bearer expired')return Response.json({},{status:401});const id=token==='Bearer admin'?'admin':token==='Bearer other'?'other':'buyer';return Response.json({user:{id,username:id,isAdmin:id==='admin'}});}
  calls.push({url:String(url),options});if(String(url).endsWith('/system/oauth2/token'))return Response.json({code:0,data:{access_token:'hidden-access',refresh_token:'hidden-refresh',expires_in:3600}});
  return Response.json({code:0,data:String(url).includes('/get-permission-info')?{user:{nickname:'买手'}}:[{value:'fixture'}]});
 }});const address=await service.listen(0,'127.0.0.1'),origin=`http://127.0.0.1:${address.port}`;
 const api=async(route,token='buyer',method='GET',body)=>{const response=await fetch(origin+route,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};
 assert.equal((await api('/erp-config/me','expired')).status,401);
 assert.equal((await api('/erp-config/settings','buyer')).status,403);
 assert.equal((await api('/erp-config/me','buyer','PUT',{username:'my-erp',password:'private-password',erpBaseUrl:'http://evil.fixture'})).status,400);
 assert.equal((await api('/erp-config/me','buyer','PUT',{username:'my-erp',password:'private-password'})).status,200);
 const config={erpBaseUrl:'http://8.148.144.131/prod-api/admin-api',erpTenantId:'1',erpClientId:'default',erpClientSecret:'private-secret'};
 assert.equal((await api('/erp-config/settings','admin','PUT',{...config,erpBaseUrl:'http://evil.fixture/api'})).status,400);
 const settings=await api('/erp-config/settings','admin','PUT',config);assert.equal(settings.status,200);assert.equal(settings.body.serviceReady,true);assert.equal(JSON.stringify(settings.body).includes('private-secret'),false);
 const mine=(await api('/erp-config/me')).body;assert.equal(mine.ready,true);assert.equal(mine.config.baseUrl,'https://wsfile.cn/maishou/api');assert.equal(mine.account.username,'my-erp');assert.equal(JSON.stringify(mine).includes('private-password'),false);
 assert.equal((await api('/erp-config/me','other')).body.ready,false);assert.equal((await api('/erp-config/accounts/buyer','other','DELETE')).status,403);
 assert.equal((await api('/erp-config/settings','admin','PUT',{...config,erpBaseUrl:'http://legacy.fixture:88/prod-api/admin-api'})).status,400);
 const checked=await api('/erp-config/test','buyer','POST');assert.equal(checked.status,200);assert.equal(checked.body.dictionaries,1);
 assert.equal((await api('/system/dict-data/list-all-simple')).status,200);
 assert.equal((await api('/system/auth/get-permission-info')).status,200);
 assert.ok(calls.length>0);assert.ok(calls.every(item=>item.url.startsWith('http://8.148.144.131/prod-api/admin-api/')));
 const grant=calls.find(item=>item.url.endsWith('/token'));assert.equal(grant.options.headers['tenant-id'],'1');assert.equal(grant.options.redirect,'error');assert.equal(new URLSearchParams(grant.options.body).get('username'),'my-erp');
 assert.equal((await api('/erp-config/accounts/buyer/test','admin','POST')).body.ok,true);
 assert.equal((await api('/erp-config/accounts/buyer','admin','PUT',{username:'changed',password:''})).status,400);
 assert.equal((await api('/erp-config/accounts/buyer','admin','PUT',{username:'my-erp',password:'',company:'x'})).status,400);
 assert.equal((await api('/erp-config/accounts/buyer','admin','PUT',{username:'my-erp',password:''})).status,200);
 const encrypted=await fs.readFile(file,'utf8');assert.equal(encrypted.includes('private-password'),false);assert.equal(encrypted.includes('private-secret'),false);
 assert.equal((await api('/erp-config/me','buyer','DELETE')).status,200);assert.equal((await api('/erp-config/me')).body.ready,false);
});
