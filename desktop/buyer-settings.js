const path=require('node:path');
const fs=require('node:fs/promises');
const {atomicJson}=require('./accounts');
const {OnlineTableClient,DEFAULT_TABLE_SERVICE_URL}=require('./online-table-client');
const DEFAULT_MANAGED_ERP_URL='https://wsfile.cn/maishou/api';
class BuyerSettings{
  constructor({dataDir,storage,requireManaged=false}){this.file=path.join(dataDir,'buyer-settings.json');this.storage=storage;this.requireManaged=requireManaged;this.value={target:'pending',erpManaged:false,erpToken:'',erpBaseUrl:'',erpTenantName:'',erpTenantId:'',erpClientId:'',erpClientSecret:'',erpUsername:'',erpPassword:'',company:'',buyerName:'',pallet:'',supplyCycle:12,productRootDir:'',erpHttpTestOrigin:'',onlineTableBaseUrl:DEFAULT_TABLE_SERVICE_URL,onlineTableId:''};this.client=null;this.onlineTable=null;this.managedError='';}
  async load(){try{const data=JSON.parse(await fs.readFile(this.file,'utf8')),saved=JSON.parse(this.storage.decrypt(data.encrypted)),{onlineTableToken,onlineTableUserToken,onlineTableBaseUrl,...safeSaved}=saved;this.value={...this.value,...safeSaved,onlineTableBaseUrl:DEFAULT_TABLE_SERVICE_URL,onlineTableId:typeof saved.onlineTableId==='string'?saved.onlineTableId:''};const legacy=Object.hasOwn(saved,'onlineTableToken')||Object.hasOwn(saved,'onlineTableUserToken')||saved.onlineTableBaseUrl!==DEFAULT_TABLE_SERVICE_URL;if(this.requireManaged){for(const key of ['erpBaseUrl','erpTenantName','erpTenantId','erpClientId','erpClientSecret','erpUsername','erpPassword','erpToken','company','buyerName','erpHttpTestOrigin'])this.value[key]='';this.value.erpManaged=false;}if(legacy||this.requireManaged)await atomicJson(this.file,{encrypted:this.storage.encrypt(JSON.stringify(this.value))});}catch(error){if(error.code!=='ENOENT')throw error;}return this.snapshot();}
  configured(){const c=this.value;if(this.requireManaged)return!!(c.erpManaged&&c.erpBaseUrl&&c.erpToken);if(c.erpManaged)return!!(c.erpBaseUrl&&c.erpToken);return!!(c.erpBaseUrl&&(c.erpTenantId||c.erpTenantName)&&c.erpClientId&&c.erpClientSecret&&c.erpUsername&&c.erpPassword);}
  snapshot(){const {erpClientSecret,erpPassword,erpToken,...safe}=this.value;if(this.requireManaged)return{target:safe.target,pallet:safe.pallet,supplyCycle:safe.supplyCycle,productRootDir:safe.productRootDir,buyerName:this.value.erpManaged?this.value.buyerName:'',configured:this.configured(),managed:true,managedUsername:this.value.erpManaged?this.value.erpUsername:'',managedError:this.managedError,onlineTableBaseUrl:DEFAULT_TABLE_SERVICE_URL,onlineTableConfigured:!!this.value.onlineTableId};return{...safe,configured:this.configured(),managed:!!this.value.erpManaged,managedUsername:this.value.erpUsername||'',managedError:this.managedError,hasClientSecret:!!erpClientSecret,hasPassword:!!erpPassword,onlineTableBaseUrl:DEFAULT_TABLE_SERVICE_URL,onlineTableConfigured:!!this.value.onlineTableId};}
  async syncManaged(authToken=''){
    this.managedError='';
    // A buyer supplied connection is authoritative for this Windows profile.
    // The server mapping remains a fallback for accounts that have not entered credentials.
    if(!this.requireManaged&&!this.value.erpManaged&&this.configured())return this.snapshot();
    this.value.erpManaged=false; this.value.erpToken='';
    if(!authToken)return this.snapshot();
    try{
      const response=await fetch(`${DEFAULT_MANAGED_ERP_URL}/erp-config/me`,{headers:{Authorization:`Bearer ${authToken}`,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});
      const body=await response.json().catch(()=>({}));
      if(!response.ok||body.ready!==true||!body.config)throw new Error(this.requireManaged?(body.error||'请在账号页面保存互拓账号和密码'):'还没有配置互拓账号，请在账号页面填写');
      const config=body.config;this.value={...this.value,erpManaged:true,erpToken:authToken,erpBaseUrl:String(config.baseUrl||DEFAULT_MANAGED_ERP_URL),erpTenantId:String(config.tenantId||'managed'),erpClientId:'',erpClientSecret:'',erpUsername:String(config.username||''),erpPassword:'',company:'',buyerName:String(config.buyerName||''),erpDraftApiConfirmed:config.canSubmitDrafts===true,erpDraftConvertConfirmed:config.canConvertDrafts===true};
      return this.snapshot();
    }catch(error){this.managedError=String(error.message||'互拓自动连接失败').slice(0,240);return this.snapshot();}
  }
  async save(input={}){
    if(this.requireManaged&&['erpBaseUrl','erpTenantName','erpTenantId','erpClientId','erpClientSecret','erpUsername','erpPassword','company','buyerName','erpHttpTestOrigin'].some(key=>Object.hasOwn(input,key)))throw new Error('互拓账号由服务器管理员按 TDL 用户关联，不能在客户端设置');
    const next={...this.value};
    for(const key of ['erpBaseUrl','erpTenantName','erpTenantId','erpClientId','erpUsername','company','buyerName','pallet','productRootDir','erpHttpTestOrigin'])if(Object.hasOwn(input,key)){if(typeof input[key]!=='string'||input[key].length>512||/[\r\n]/.test(input[key]))throw new Error('配置字段格式无效');next[key]=input[key].trim();}
    if(next.productRootDir){if(!path.isAbsolute(next.productRootDir))throw new Error('买手资料根目录必须是绝对路径');next.productRootDir=path.resolve(next.productRootDir);}
    if(Object.hasOwn(input,'onlineTableId')){if(typeof input.onlineTableId!=='string'||input.onlineTableId.length>64||/[\r\n]/.test(input.onlineTableId)||input.onlineTableId&& !/^[\da-f-]{36}$/i.test(input.onlineTableId))throw new Error('在线选品表编号无效');next.onlineTableId=input.onlineTableId.trim();}
    if(input.erpBaseUrl){const u=new URL(next.erpBaseUrl),allow=u.protocol==='http:'&&(u.origin===next.erpHttpTestOrigin||['127.0.0.1','localhost','[::1]'].includes(u.hostname));if((u.protocol!=='https:'&&!allow)||u.username||u.password||u.hash||u.search)throw new Error('互拓API地址需使用HTTPS；测试HTTP需填写完全一致的测试Origin');if(next.erpBaseUrl!==this.value.erpBaseUrl&&(!input.erpClientSecret||!input.erpPassword))throw new Error('更换互拓服务地址时必须重新填写对应的客户端密钥与账号密码');}
    for(const key of ['erpClientSecret','erpPassword'])if(input[key]){if(typeof input[key]!=='string'||input[key].length>16000||/[\r\n]/.test(input[key]))throw new Error('凭据格式无效');next[key]=input[key];}
    if(['erpBaseUrl','erpTenantName','erpTenantId','erpClientId','erpClientSecret','erpUsername','erpPassword','company','buyerName'].some(key=>Object.hasOwn(input,key))){next.erpManaged=false;next.erpToken='';}
    if(next.erpUsername!==this.value.erpUsername&&!input.erpPassword)throw new Error('更换互拓账号时请填写对应密码');
    if(next.erpClientId!==this.value.erpClientId&&!input.erpClientSecret)throw new Error('更换 OAuth 客户端时请填写对应密钥');
    if(input.target!==undefined){if(!['draft','pending'].includes(input.target))throw new Error('互拓完成位置无效');next.target=input.target;}
    if(input.supplyCycle!==undefined){if(!Number.isInteger(input.supplyCycle)||input.supplyCycle<1||input.supplyCycle>120)throw new Error('业务默认供货周期须为1～120天');next.supplyCycle=input.supplyCycle;}
    const persisted={...next,erpToken:''};await atomicJson(this.file,{encrypted:this.storage.encrypt(JSON.stringify(persisted))});this.value=next;this.managedError='';this.client=null;this.catalogCache=null;this.onlineTable=null;return this.snapshot();
  }
  async clearLocal(){
    const next={...this.value,erpManaged:false,erpToken:'',erpBaseUrl:'',erpTenantName:'',erpTenantId:'',erpClientId:'',erpClientSecret:'',erpUsername:'',erpPassword:'',company:'',buyerName:'',erpHttpTestOrigin:'',erpDraftApiConfirmed:false,erpDraftConvertConfirmed:false};
    await atomicJson(this.file,{encrypted:this.storage.encrypt(JSON.stringify(next))});this.value=next;this.managedError='';this.client=null;this.catalogCache=null;return this.snapshot();
  }
  async erp(){if(!this.configured())throw Object.assign(new Error(this.managedError||(this.requireManaged?'请先由管理员关联互拓账号':'请先填写当前买手的互拓账号配置')),{tag:'互拓未配置'});if(!this.client){const {ErpClient}=await import('./erp/client.mjs');this.client=new ErpClient({...this.value,erpDraftApiConfirmed:this.value.erpManaged?this.value.erpDraftApiConfirmed===true:true,erpDraftConvertConfirmed:this.value.erpManaged?this.value.erpDraftConvertConfirmed===true:this.value.target==='pending'});}return this.client;}
  async catalogs(signal){if(this.catalogCache&&Date.now()-this.catalogCache.at<5*60000)return this.catalogCache.value;if(this.catalogPromise)return this.catalogPromise;this.catalogPromise=(async()=>{const client=await this.erp();const [permissions,dictionaries,categories]=await Promise.all([client.permissions(signal),client.dictionaries(signal),client.categories(signal)]);if(!Array.isArray(dictionaries)||!Array.isArray(categories))throw new Error('互拓字典或类别结构无效');const value={permissions,dictionaries,categories:categories.filter(row=>row.status===1)};this.catalogCache={at:Date.now(),value};return value;})();try{return await this.catalogPromise;}finally{this.catalogPromise=null;}}
  async onlineTableClient(authToken=''){if(!authToken)throw new Error('请先登录 TDL 账号');if(!this.onlineTable)this.onlineTable=new OnlineTableClient({baseUrl:DEFAULT_TABLE_SERVICE_URL,tableId:this.value.onlineTableId,authToken});else this.onlineTable.configure({baseUrl:DEFAULT_TABLE_SERVICE_URL,tableId:this.value.onlineTableId,authToken});return this.onlineTable;}
}
module.exports={BuyerSettings,DEFAULT_MANAGED_ERP_URL};
