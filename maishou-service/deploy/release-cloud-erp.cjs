const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),{parseEnv}=require('node:util');
const ROOT='/home/wsf/productC',FORMAL='http://8.148.144.131/prod-api/admin-api';
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const atomic=(file,data,mode=0o600)=>{const tmp=file+'.formal-new';fs.writeFileSync(tmp,data,{flag:'wx',mode});fs.renameSync(tmp,file);};
async function main(){
 const stage=path.resolve(process.argv[2]||'');if(path.dirname(stage)!=='/home/deploy'||!/^productC-formal-erp-[a-f0-9-]{36}$/.test(path.basename(stage))||fs.realpathSync(stage)!==stage)throw Error('Invalid stage');
 const manifest=JSON.parse(fs.readFileSync(path.join(stage,'manifest.json'),'utf8'));
 for(const [relative,sha]of Object.entries(manifest.files)){if(!['server.js','site/maishou/admin/erp-users/index.html'].includes(relative)||hash(path.join(stage,relative))!==sha)throw Error('Invalid staged file');}
 const envFile=path.join(ROOT,'erp-proxy.env'),previousEnv=fs.readFileSync(envFile,'utf8'),env=parseEnv(previousEnv),database=env.ERP_MAPPING_FILE||path.join(ROOT,'data/erp-mappings.json');
 if(fs.realpathSync(path.dirname(database))!==path.join(ROOT,'data'))throw Error('Unexpected mapping path');
 const {createServer,ErpMappingStore}=require(path.join(stage,'server.js'));
 const before=new ErpMappingStore(database,env.ERP_MAPPING_KEY);await before.load();
 const config={erpBaseUrl:FORMAL,erpTenantId:env.ERP_TENANT_ID||'',erpClientId:env.ERP_CLIENT_ID||'',erpClientSecret:env.ERP_CLIENT_SECRET||'',...before.getSettings(),erpBaseUrl:FORMAL};
 if(process.argv.includes('--enable-direct-pending'))config.directSaveConfirmed=true;
 const rows=before.list().filter(row=>row.enabled);if(!rows.length)throw Error('No existing enabled account mapping');
 const expectedRows=JSON.stringify(before.list().map(row=>before.get(row.accountId)));
 const cloneDir=path.join(stage,'probe');fs.mkdirSync(cloneDir,{mode:0o700});const cloneFile=path.join(cloneDir,'mappings.json');fs.copyFileSync(database,cloneFile);fs.chmodSync(cloneFile,0o600);
 const clone=new ErpMappingStore(cloneFile,env.ERP_MAPPING_KEY);await clone.load();await clone.setSettings(config);
 const checks=[],observedTargets=new Set();let current;
 const probe=createServer({erpMappings:clone,env:{...env,NODE_ENV:'production'},fetchImpl:async(url,options)=>{if(String(url).includes('/myladmin/api/auth/me'))return Response.json({user:{id:current.accountId,username:current.tdlUsername}});if(!String(url).startsWith(FORMAL+'/'))throw Error('Non-formal ERP request blocked');observedTargets.add(new URL(url).origin);return fetch(url,options);}});
 const address=await probe.listen(0,'127.0.0.1'),api='http://127.0.0.1:'+address.port,headers={Authorization:'Bearer isolated-formal-release-probe'};
 try{for(const row of rows){current=row;const accountCheck={accountId:row.accountId,reads:[]};
  for(const route of ['/erp-config/me','/system/auth/get-permission-info','/system/dict-data/list-all-simple','/erp/category/list','/erp/supplier-infos/getSupplier','/taobao/product-crawler/get?id=1073221934071']){
   const response=await fetch(api+route,{headers,signal:AbortSignal.timeout(115000)}),body=await response.json().catch(()=>null);const ok=response.ok&&(route==='/erp-config/me'?body?.ready===true:body?.code===0);
   accountCheck.reads.push({route,http:response.status,ok,...(route.includes('product-crawler')?{exists:!!body?.data}:{}),...(route==='/erp-config/me'?{canSavePending:body?.config?.canSavePending===true}:{})});if(!ok)throw Error('Formal ERP read failed: '+row.accountId+' '+route);if(config.directSaveConfirmed&&route==='/erp-config/me'&&body?.config?.canSavePending!==true)throw Error('Direct pending capability missing');
  }checks.push(accountCheck);
 }}finally{await probe.close();fs.rmSync(cloneDir,{recursive:true,force:true});}
 const backup=path.join('/home/deploy/productC-release-backups','formal-erp-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(backup,{recursive:true,mode:0o700});
 if(cp.execFileSync('ss',['-Hnt','state','established','( sport = :4600 )'],{encoding:'utf8'}).trim())throw Error('Gateway has active requests');
 cp.execFileSync('sudo',['-n','systemctl','stop','maishou.service']);
 let changed=false;
 try{
  for(const [file,name]of [[envFile,'erp-proxy.env'],[database,'erp-mappings.json'],[path.join(ROOT,'backend/server.js'),'server-before.js'],[path.join(ROOT,'site/maishou/admin/erp-users/index.html'),'erp-users-before.html']]){fs.copyFileSync(file,path.join(backup,name));fs.chmodSync(path.join(backup,name),0o600);}
  const store=new ErpMappingStore(database,env.ERP_MAPPING_KEY);await store.load();const freshConfig={...store.getSettings(),erpBaseUrl:FORMAL,...(config.directSaveConfirmed?{directSaveConfirmed:true}:{})};changed=true;await store.setSettings(freshConfig);
  const nextEnv=previousEnv.split(/\r?\n/).filter(line=>!/^\s*(?:ERP_BASE_URL|FORMAL_ERP_BASE_URL|ERP_HTTP_TEST_ORIGIN|ERP_TEST_MODE)\s*=/.test(line));nextEnv.push('ERP_BASE_URL='+FORMAL);atomic(envFile,nextEnv.join('\n').replace(/\n+$/,'')+'\n');
  atomic(path.join(ROOT,'backend/server.js'),fs.readFileSync(path.join(stage,'server.js')),0o644);atomic(path.join(ROOT,'site/maishou/admin/erp-users/index.html'),fs.readFileSync(path.join(stage,'site/maishou/admin/erp-users/index.html')),0o644);
  const verify=new ErpMappingStore(database,env.ERP_MAPPING_KEY);await verify.load();if(JSON.stringify(verify.list().map(row=>verify.get(row.accountId)))!==expectedRows)throw Error('Account mappings changed');if(verify.getSettings().erpBaseUrl!==FORMAL)throw Error('Endpoint not saved');
  cp.execFileSync('sudo',['-n','systemctl','start','maishou.service']);let healthy=false;for(let i=0;i<12;i++){try{healthy=(await fetch('http://127.0.0.1:4600/healthz')).status===200;if(healthy)break;}catch{}await new Promise(resolve=>setTimeout(resolve,500));}if(!healthy)throw Error('Gateway health failed');if((await fetch('http://127.0.0.1:4600/erp-config/me')).status!==401)throw Error('Auth boundary failed');
 }catch(error){cp.execFileSync('sudo',['-n','systemctl','stop','maishou.service']);if(changed){for(const [name,file]of [['erp-proxy.env',envFile],['erp-mappings.json',database],['server-before.js',path.join(ROOT,'backend/server.js')],['erp-users-before.html',path.join(ROOT,'site/maishou/admin/erp-users/index.html')]])atomic(file,fs.readFileSync(path.join(backup,name)),name.includes('.js')||name.includes('.html')?0o644:0o600);}cp.execFileSync('sudo',['-n','systemctl','start','maishou.service']);throw error;}
 const result={deployed:true,checkedAt:new Date().toISOString(),endpoint:FORMAL,backup,accountMappingsPreserved:true,mappedAccounts:rows.length,serverSha256:hash(path.join(ROOT,'backend/server.js')),observedTargets:[...observedTargets],checks,productWrites:0};fs.writeFileSync(path.join(stage,'result.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
}
main().catch(error=>{console.error('Formal ERP release stopped: '+error.message);process.exitCode=1});
