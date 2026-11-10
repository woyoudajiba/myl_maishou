// Explicit operator release; secrets arrive through SSH stdin and are persisted
// only in the existing AES-GCM mapping store. Never print the input or upstream bodies.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),{parseEnv}=require('node:util');
const root='/home/wsf/productC';
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function main(){
 const stage=path.resolve(process.argv[2]);if(path.dirname(stage)!=='/home/deploy'||!/^productC-cloud-erp-[a-f0-9-]{36}$/.test(path.basename(stage))||fs.realpathSync(stage)!==stage)throw Error('Invalid stage');
 const input=JSON.parse(fs.readFileSync(0,'utf8')),manifest=JSON.parse(fs.readFileSync(path.join(stage,'manifest.json'),'utf8'));
 for(const [relative,sha] of Object.entries(manifest.files)){if(relative.includes('..')||path.isAbsolute(relative)||digest(path.join(stage,relative))!==sha)throw Error('Stage checksum mismatch');}
 const envFile=path.join(root,'erp-proxy.env'),previousEnv=fs.readFileSync(envFile,'utf8'),env=parseEnv(previousEnv),database=env.ERP_MAPPING_FILE||path.join(root,'data/erp-mappings.json');
 if(fs.realpathSync(path.dirname(database))!==path.join(root,'data'))throw Error('Unexpected mapping path');
 const {createServer,ErpMappingStore}=require(path.join(stage,'server.js'));
 const liveStore=new ErpMappingStore(database,env.ERP_MAPPING_KEY);await liveStore.load();
 const existing=liveStore.listUsers().find(user=>user.id==='wsf');if(!existing)throw Error('Expected TDL user is not registered');
 const config={erpBaseUrl:input.baseUrl,erpTenantId:input.tenantId,erpClientId:input.clientId,erpClientSecret:input.clientSecret,draftApiConfirmed:liveStore.getSettings().draftApiConfirmed===true,draftConvertConfirmed:liveStore.getSettings().draftConvertConfirmed===true};
 const endpoint=new URL(config.erpBaseUrl);if(endpoint.origin!=='http://121.37.6.118:88'||config.erpTenantId!=='1')throw Error('Unexpected test environment');
 const cloneDir=path.join(stage,'probe');fs.mkdirSync(cloneDir,{mode:0o700});const cloneFile=path.join(cloneDir,'mappings.json');fs.copyFileSync(database,cloneFile);fs.chmodSync(cloneFile,0o600);
 const probeStore=new ErpMappingStore(cloneFile,env.ERP_MAPPING_KEY);await probeStore.load();await probeStore.setSettings(config);await probeStore.set(existing.id,{username:input.username,password:input.password});
 const testService=createServer({erpMappings:probeStore,env:{...env,ERP_HTTP_TEST_ORIGIN:endpoint.origin,TDL_AUTH_URL:'https://release-fixture.invalid/me'},fetchImpl:async(url,options)=>String(url)==='https://release-fixture.invalid/me'?Response.json({user:{...existing,isAdmin:false}}):fetch(url,options)});
 const address=await testService.listen(0,'127.0.0.1'),api=`http://127.0.0.1:${address.port}`,checks=[];
 const headers={Authorization:'Bearer isolated-release-probe','Content-Type':'application/json'};
 try{
  for(const [label,route,body] of [['connection','/erp-config/me'],['permissions','/system/auth/get-permission-info'],['dictionaries','/system/dict-data/list-all-simple'],['categories','/erp/category/list'],['draftQuery','/erp/product-draft/page',{pageNo:1,pageSize:1}],['productQuery','/erp/pool-product/page',{pageNo:1,pageSize:1}]]){
   const r=await fetch(api+route,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});const result=await r.json().catch(()=>null);
   const success=r.ok&&(label==='connection'?result?.ready:result?.code===0);
   checks.push({label,httpStatus:r.status,success,count:Array.isArray(result?.data)?result.data.length:undefined});
   if(['connection','permissions','dictionaries','categories'].includes(label)&&!success)throw Error('Required ERP read probe failed: '+label);
  }
 }finally{await testService.close();}
 const connections=cp.execFileSync('ss',['-Hnt','state','established','( sport = :4600 )'],{encoding:'utf8'}).trim();if(connections)throw Error('Gateway has active connections; retry release after requests finish');
 const backup=path.join('/home/deploy/productC-release-backups','cloud-erp-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(backup,{recursive:true,mode:0o700});
 for(const [source,name] of [[envFile,'erp-proxy.env'],[database,'erp-mappings.json'],[path.join(root,'backend/server.js'),'server-before.js']]){fs.copyFileSync(source,path.join(backup,name));fs.chmodSync(path.join(backup,name),0o600);}
 const copies=[['server.js','backend/server.js']];
 for(const relative of Object.keys(manifest.files).filter(name=>name.startsWith('site/'))){copies.push([relative,relative]);const dest=path.join(root,relative);if(fs.existsSync(dest)){const saved=path.join(backup,relative);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(dest,saved);}}
 const atomic=(target,data,mode)=>{const temp=target+'.cloud-new';if(fs.existsSync(temp))throw Error('Temporary release file exists');fs.writeFileSync(temp,data,{mode});fs.renameSync(temp,target);};
 cp.execFileSync('sudo',['-n','systemctl','stop','maishou.service']);
 try{
  const fresh=new ErpMappingStore(database,env.ERP_MAPPING_KEY);await fresh.load();await fresh.setSettings(config);await fresh.set(existing.id,{username:input.username,password:input.password});
  const lines=previousEnv.split(/\r?\n/).filter(line=>!/^ERP_HTTP_TEST_ORIGIN=/.test(line));lines.push('ERP_HTTP_TEST_ORIGIN='+endpoint.origin);atomic(envFile,lines.join('\n')+'\n',0o600);
  for(const [source,relative] of copies){const target=path.join(root,relative);fs.mkdirSync(path.dirname(target),{recursive:true});atomic(target,fs.readFileSync(path.join(stage,source)),0o644);}
  cp.execFileSync('sudo',['-n','systemctl','start','maishou.service']);
  let healthy=false;for(let i=0;i<10;i++){try{healthy=(await fetch('http://127.0.0.1:4600/healthz')).status===200;if(healthy)break;}catch{}await new Promise(resolve=>setTimeout(resolve,400));}if(!healthy)throw Error('Gateway not healthy');
  if((await fetch('http://127.0.0.1:4600/erp-config/me')).status!==401)throw Error('Authentication boundary failed');
 }catch(error){
  for(const [saved,target] of [['erp-proxy.env',envFile],['erp-mappings.json',database],['server-before.js',path.join(root,'backend/server.js')]])atomic(target,fs.readFileSync(path.join(backup,saved)),saved.endsWith('.js')?0o644:0o600);
  cp.execFileSync('sudo',['-n','systemctl','restart','maishou.service']);throw error;
 }
 const summary={deployed:true,backup,linkedTdlUser:existing.id,serverSha256:digest(path.join(root,'backend/server.js')),httpTestOrigin:endpoint.origin,checks,realProductWrites:0};
 fs.writeFileSync(path.join(stage,'result.json'),JSON.stringify(summary,null,2),{mode:0o600});
 await fsp.rm(cloneDir,{recursive:true,force:true});console.log(JSON.stringify(summary));
}
main().catch(error=>{console.error('Cloud ERP release stopped: '+error.message);process.exitCode=1});
