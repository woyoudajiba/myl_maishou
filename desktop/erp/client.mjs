import { parseErpJson, externalIdFromUrl, normalizeCollection, prepareDraftAttempt, prepareProductAttempt } from './contract.mjs';
import { setTimeout as waitFor } from 'node:timers/promises';

export class ErpError extends Error {
  constructor(message, { status = null, code = null, ambiguous = false } = {}) { super(message); this.name = 'ErpError'; this.status = status; this.code = code; this.ambiguous = ambiguous; }
}
export class ErpClient {
  #config; #fetch; #tenantId; #accessToken; #refreshToken = ''; #expiresAt = 0; #authPromise = null;
  constructor(config, { fetchImpl = fetch } = {}) {
    this.#config = config; this.#fetch = fetchImpl; this.#tenantId = config.erpTenantId || ''; this.#accessToken = config.erpToken || '';
  }
  #base() {
    let base;
    try { base = new URL(this.#config.erpBaseUrl); } catch { throw new ErpError('未配置有效的 ERP_BASE_URL'); }
    const allowedHttp = base.protocol === 'http:' && (['localhost','127.0.0.1','[::1]'].includes(base.hostname) || base.origin === this.#config.erpHttpTestOrigin);
    const managed = configManaged(this.#config);
    if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !allowedHttp) || (managed && !['wsfile.cn', 'localhost', '127.0.0.1'].includes(base.hostname))) throw new ErpError('ERP 授权接入需使用 HTTPS，或显式配置同源测试环境');
    return base.href.replace(/\/$/, '');
  }
  async #send(route, { method = 'GET', body, headers = {}, signal, auth = true } = {}) {
    if (!route.startsWith('/') || route.startsWith('//')) throw new ErpError('ERP 接口路径无效');
    const url = this.#base() + route;
    const combined = { Accept: 'application/json', ...headers };
    if (this.#tenantId !== '' && !configManaged(this.#config)) combined['tenant-id'] = String(this.#tenantId);
    if (auth) {
      if (!this.#accessToken || (this.#tenantId === '' && !configManaged(this.#config))) throw new ErpError('ERP 缺少访问令牌或租户身份');
      combined.Authorization = `Bearer ${this.#accessToken}`;
    }
    const content = typeof body === 'string' || body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body);
    if (body !== undefined && !(body instanceof FormData) && !combined['Content-Type']) combined['Content-Type'] = 'application/json;charset=UTF-8';
    const readOnly=method==='GET'||method==='POST'&&['/erp/pool-product/page','/erp/product-draft/page'].includes(route);
    const isDuplicate=route==='/erp/pool-product/page';
    let timeoutMs=configManaged(this.#config)?65000:readOnly?35000:20000;
    if(isDuplicate&&configManaged(this.#config))timeoutMs=115000;
    const deadline=AbortSignal.timeout(timeoutMs),requestSignal=AbortSignal.any([signal||new AbortController().signal,deadline]);
    const interrupted=()=>new ErpError(signal?.aborted?'ERP 请求已取消，任务进度已保留':isDuplicate?'互拓商品查重请求超时或连接失败；尚未取得查重结论，已暂停新增，可稍后重试查询':readOnly?'互拓资料查询超时或连接失败，请稍后重试查询':'ERP 请求中断或超时，请查询原记录后再处理',{code:signal?.aborted?'ERP_CANCELLED':deadline.aborted?'ERP_TIMEOUT':'ERP_NETWORK',ambiguous:!readOnly});
    let response,raw;
    try { response = await this.#fetch(url, { method, body: content, headers: combined, redirect: 'error', signal:requestSignal });raw=await response.text(); }
    catch { throw interrupted(); }
    let data;
    try { if (raw.length > 8 * 1024 * 1024) throw new Error(); data = parseErpJson(raw); }
    catch { throw new ErpError('ERP 响应无法按契约解析', { status: response.status, ambiguous: !readOnly && (response.ok || response.status >= 500) }); }
    if (!response.ok || data?.code !== 0) {
      // Upstream msg may contain credentials or private request fields. Keep status/code only.
      const diagnosticCode=typeof data?.code==='number'?data.code:typeof data?.code==='string'&&/^ERP_[A-Z0-9_]{1,48}$/.test(data.code)?data.code:null;
      const codeLabel=diagnosticCode??'缺失';
      const message=isDuplicate&&diagnosticCode==='ERP_UPSTREAM_TIMEOUT'
        ?'互拓商品查询上游超过代理等待时限，尚无查重结论，已暂停新增。可重试；若再次超时请 ERP 维护人员检查慢查询。'
        :isDuplicate?`互拓商品查重未成功（HTTP ${response.status}，业务码 ${codeLabel}）；尚无查重结论，已暂停新增。请检查互拓商品查询服务后重试`
          :`ERP 请求失败（HTTP ${response.status}，业务码 ${codeLabel}）`;
      throw new ErpError(message, { status: response.status, code: diagnosticCode, ambiguous: !readOnly && (response.status >= 500 || (response.ok && typeof data?.code !== 'number')) });
    }
    return data.data;
  }
  async #resolveTenant(signal) {
    if (this.#tenantId !== '') return;
    if (!this.#config.erpTenantName) throw new ErpError('缺少 ERP_TENANT_NAME 或 ERP_TENANT_ID');
    const id = await this.#send(`/system/tenant/get-id-by-name?name=${encodeURIComponent(this.#config.erpTenantName)}`, { auth:false, signal });
    if (id === null || !/^\d+$/.test(String(id))) throw new ErpError('未找到有效租户，请核对租户名称');
    this.#tenantId = String(id);
  }
  async #grant(refresh, signal) {
    const c = this.#config;
    if (!c.erpClientId || !c.erpClientSecret) throw new ErpError('缺少 OAuth 客户端配置');
    await this.#resolveTenant(signal);
    const form = new URLSearchParams();
    if (refresh) { if (!this.#refreshToken) throw new ErpError('令牌失效，请重新正常认证'); form.set('grant_type','refresh_token'); form.set('refresh_token',this.#refreshToken); }
    else { if (!c.erpUsername || !c.erpPassword) throw new ErpError('缺少授权用户配置'); form.set('grant_type','password'); form.set('username',c.erpUsername); form.set('password',c.erpPassword); }
    const result = await this.#send('/system/oauth2/token', { method:'POST', body:form.toString(), auth:false, signal, headers: { Authorization:`Basic ${Buffer.from(`${c.erpClientId}:${c.erpClientSecret}`).toString('base64')}`, 'Content-Type':'application/x-www-form-urlencoded' } });
    if (!result || typeof result.access_token !== 'string' || !result.access_token || typeof result.refresh_token !== 'string' || !result.refresh_token || !Number.isFinite(Number(result.expires_in)) || Number(result.expires_in) <= 0) throw new ErpError('OAuth 响应缺少有效令牌或有效期');
    this.#accessToken=result.access_token;this.#refreshToken=result.refresh_token;this.#expiresAt=Date.now()+Number(result.expires_in)*1000;
  }
  async #authenticate(refresh, signal) {
    if (!this.#authPromise) this.#authPromise=this.#grant(refresh,signal).catch(e=>{this.#accessToken='';this.#refreshToken='';this.#expiresAt=0;throw e}).finally(()=>{this.#authPromise=null});
    return this.#authPromise;
  }
  async request(route, options = {}) {
    if (configManaged(this.#config)) return this.#send(route, options);
    await this.#resolveTenant(options.signal);
    if (!this.#accessToken || (this.#expiresAt && Date.now() >= this.#expiresAt-5000)) await this.#authenticate(!!this.#refreshToken, options.signal);
    const usedToken = this.#accessToken;
    try { return await this.#send(route,options); }
    catch (e) {
      if (!(e instanceof ErpError) || (e.status!==401 && e.code!==401) || !this.#refreshToken) throw e;
      if (this.#accessToken===usedToken) await this.#authenticate(true,options.signal);
      return this.#send(route,options); // One retry only; a second 401 is returned to the caller.
    }
  }
  permissions(signal) { return this.request('/system/auth/get-permission-info',{signal}); }
  dictionaries(signal) { return this.request('/system/dict-data/list-all-simple',{signal}); }
  categories(signal) { return this.request('/erp/category/list',{signal}); }
  suppliers(name,signal) { if(!name?.trim())return Promise.resolve([]);return this.request(`/erp/supplier-infos/sample-list?name=${encodeURIComponent(name)}`,{signal}); }
  supplierDirectory(signal) { return this.request('/erp/supplier-infos/getSupplier',{signal}); }
  controls(categoryName,signal) { return Promise.all([this.request('/erp/category/info',{signal}),this.request(`/erp/attributes-extend/extend-category?categoryTypeName=${encodeURIComponent(categoryName)}&productNo=`,{signal})]); }
  colors(name,signal) { return this.request(`/erp/colors/query?colorName=${encodeURIComponent(name)}`,{signal}); }
  getCollection(id,signal) { return this.request(`/taobao/product-crawler/get?id=${encodeURIComponent(id)}`,{signal}); }
  originalImages(id,signal) { return this.request(`/taobao/product-crawler/get-original-images?externalId=${encodeURIComponent(id)}`,{signal}); }
  #collectionId(task) {
    const id=externalIdFromUrl(task.url);
    if(task.externalId&&String(task.externalId)!==id)throw new ErpError('任务链接与原采集商品 ID 不一致',{code:'ERP_COLLECTION_MISMATCH'});
    return id;
  }
  #collectionResult(record,task,id) {
    if(record&&((record.externalId&&String(record.externalId)!==id)
      ||(record.articleNo&&task.articleNo&&record.articleNo!==task.articleNo)
      ||(record.supplierName&&task.supplierName&&record.supplierName!==task.supplierName)))throw new ErpError('已存在采集记录的商品、货号或供应商与当前任务不一致，请核对来源',{code:'ERP_COLLECTION_MISMATCH'});
    const result=normalizeCollection(record);
    if(result.state==='failed')throw new ErpError(result.reason,{code:'ERP_COLLECTION_FAILED'});
    return result.state==='ready'?{...result,source:{...result.source,externalId:id},externalId:id}:{...result,externalId:id};
  }
  async startCollection(task,{signal,checkpoint=async()=>{}}={}) {
    const id=this.#collectionId(task);
    // A failed preflight GET cannot mean that the record does not exist.
    const record=await this.getCollection(id,signal),state=this.#collectionResult(record,task,id);
    if(record||task.externalId){await checkpoint(id,{state:state.state==='ready'?'ready':'waiting'});return state;}
    // Persist before the POST. If interrupted here or after server acceptance,
    // every subsequent attempt only reads the stable external product ID.
    await checkpoint(id,{state:'submitting'});
    let accepted;
    try{accepted=await this.request('/taobao/product-crawler/taobao_product_crawler_add',{method:'POST',body:{article_no:task.articleNo||'',supplier_name:task.supplierName||'',url:task.url},signal});}
    catch(error){
      if(error.ambiguous){await checkpoint(id,{state:'unknown'});return{state:'waiting',externalId:id,reason:'采集提交回执暂未确认，稍后查询原商品记录',uncertain:true};}
      throw error;
    }
    if(!accepted||!Object.hasOwn(accepted,'some_num')){
      await checkpoint(id,{state:'unknown'});return{state:'waiting',externalId:id,reason:'采集提交回执暂未确认，稍后查询原商品记录',uncertain:true};
    }
    if(typeof accepted.err_url==='string'&&accepted.err_url.trim())throw new ErpError('ERP 未接受本次采集，请在互拓平台商品爬虫中检查该链接',{code:'ERP_COLLECTION_REJECTED'});
    await checkpoint(id,{state:'waiting'});
    return{state:'waiting',externalId:id,reason:'已提交互拓采集，等待商品标题与图片资料'};
  }
  async pollCollection(task,{signal}={}) {
    const id=this.#collectionId(task);
    if(!task.externalId)throw new ErpError('缺少原采集商品 ID，不能查询采集结果',{code:'ERP_COLLECTION_MISMATCH'});
    return this.#collectionResult(await this.getCollection(id,signal),task,id);
  }
  async collect(task,{signal,checkpoint=async()=>{},wait=s=>waitFor(3000,undefined,{signal:s}),limit=40}={}) {
    const id=externalIdFromUrl(task.url);
    const resumed=!!task.externalId;
    if(resumed && String(task.externalId)!==id)throw new ErpError('任务链接与原采集商品 ID 不一致');
    // Read first: an auth/config failure must not become an uncertain write checkpoint.
    let record=await this.getCollection(id,signal);
    if(record && ((record.articleNo && task.articleNo && record.articleNo!==task.articleNo) || (record.supplierName && task.supplierName && record.supplierName!==task.supplierName))) throw new ErpError('已存在采集记录的货号或供应商与当前任务不一致，请核对来源');
    await checkpoint(id); // Persist the stable ID before a possible collection POST.
    if(!record && !resumed){
      const result=await this.request('/taobao/product-crawler/taobao_product_crawler_add',{method:'POST',body:{article_no:task.articleNo||'',supplier_name:task.supplierName||'',url:task.url},signal});
      if(!result || !Object.hasOwn(result,'some_num') || (typeof result.err_url==='string' && result.err_url.trim())) throw new ErpError('采集登记响应未通过契约校验，请查询该商品记录');
    }
    for(let i=0;i<limit;i++){
      if(!record || i>0)record=await this.getCollection(id,signal);
      const normalized=normalizeCollection(record);
      if(normalized.state==='ready')return {...normalized.source,externalId:id};
      if(normalized.state==='failed')throw new ErpError(normalized.reason);
      if(i<limit-1)await wait(signal);
    }
    throw new ErpError('采集等待超时，已保留商品 ID；重试只查询原记录');
  }
  getDraft(id,signal) { return this.request(`/erp/product-draft/get?id=${encodeURIComponent(id)}`,{signal}); }
  async deleteDraft(id,signal) {
    if(!/^\d+$/.test(String(id)))throw new ErpError('草稿 ID 无效');
    try { return await this.request(`/erp/product-draft/delete?id=${encodeURIComponent(id)}`,{method:'DELETE',signal}); }
    catch(error) { if(error instanceof ErpError&&error.status===404)throw new ErpError('正式互拓当前未提供草稿删除接口，未删除任何内容；请管理员确认该接口是否已部署',{status:404,code:'ERP_DRAFT_DELETE_UNAVAILABLE'}); throw error; }
  }
  draftAttributes(id,signal) { return this.request(`/erp/product-draft/attributes?id=${encodeURIComponent(id)}`,{signal}); }
  draftPictures(id,signal) { return this.request(`/erp/product-draft/public-pic?id=${encodeURIComponent(id)}`,{signal}); }
  draftPage({pageNo=1,pageSize=25,supplier='',articleNo=''}={},signal) {
    const body={pageNo,pageSize};if(supplier)body.supplier=supplier;if(articleNo)body.articleNo=articleNo;
    return this.request('/erp/product-draft/page',{method:'POST',body,signal});
  }
  async listDrafts({pageNo=1,pageSize=25,articleNo='',supplier=''}={},signal) {
    if(!Number.isInteger(pageNo)||pageNo<1||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw new ErpError('草稿分页参数无效');
    if([articleNo,supplier].some(value=>typeof value!=='string'||value.length>120))throw new ErpError('草稿筛选条件无效');
    const data=await this.draftPage({pageNo,pageSize,articleNo,supplier},signal);
    if(!data||typeof data!=='object'||!Number.isSafeInteger(data.total)||data.total<0||(!Array.isArray(data.list)&&!(data.list===null&&data.total===0)))throw new ErpError('ERP 草稿列表响应结构无效，未取得草稿查询结论，请稍后刷新');
    return {list:Array.isArray(data.list)?data.list:[],total:Number(data.total)};
  }
  async convertDraft(id,revision,signal) {
    if(!/^\d+$/.test(String(id))||!Number.isInteger(Number(revision))||Number(revision)<1)throw new ErpError('草稿 ID 或版本无效');
    if(!this.#config.erpDraftConvertConfirmed)throw new ErpError('互拓待审核转换未启用');
    return this.request(`/erp/product-draft/convert?id=${encodeURIComponent(id)}&revision=${encodeURIComponent(revision)}`,{method:'POST',signal});
  }
  productDetail(id,signal) { return this.request(`/erp/pool-product/getProductInfosDetailById?id=${encodeURIComponent(id)}`,{signal}); }
  productPage(body,signal) { return this.request('/erp/pool-product/page',{method:'POST',body,signal}); }
  async submitProduct(attempt,{signal,priorSubmission,checkpoint=async()=>{}}={}) {
    if(!this.#config.erpDirectSaveConfirmed)throw new ErpError('互拓直接保存到待审核未启用');
    const checked=prepareProductAttempt(parseErpJson(attempt.body),attempt.key);
    if(attempt.mode!=='direct_pending'||attempt.productNo!==checked.productNo)throw new ErpError('互拓提交快照与商品编码不一致');
    if(priorSubmission){
      if(priorSubmission.key!==checked.key||priorSubmission.productNo!==checked.productNo)throw new ErpError('原提交记录与当前商品不一致，禁止重新新增');
      return {...priorSubmission,queryOnly:true};
    }
    const journal={key:checked.key,productNo:checked.productNo,state:'submitting',startedAt:new Date().toISOString()};
    await checkpoint(journal); // A failed journal write must prevent the POST.
    try { await this.request('/erp/product-addition/add',{method:'POST',body:checked.body,signal}); }
    catch(error){
      if(error instanceof ErpError&&error.code===400&&!error.ambiguous){const rejected={...journal,state:'rejected',code:400,status:error.status,rejectedAt:new Date().toISOString(),error:'互拓明确拒绝本次商品资料，请修正必填字段后继续；本次没有成功回执'};await checkpoint(rejected);return rejected;}
      // Even an explicit rejection is retained. A later retry reconciles the
      // original request instead of assuming the non-idempotent write is safe.
      const result={...journal,state:'unknown',error:'互拓保存未取得可核验回执，将查询原商品编码；不会自动重复提交'};
      await checkpoint(result);return result;
    }
    // The existing ERP route may return 0 as a success acknowledgement. It is
    // not a product ID. Resolve identity from a product read, not this number.
    const result={...journal,state:'submitted',acknowledged:true,receivedAt:new Date().toISOString()};
    await checkpoint(result);return result;
  }
  async verifyProduct(attempt,{signal}={}) {
    const checked=prepareProductAttempt(parseErpJson(attempt.body),attempt.key),payload=parseErpJson(checked.body);
    if(attempt.mode!=='direct_pending'||checked.productNo!==attempt.productNo)throw new ErpError('原商品提交快照无效');
    const page=await this.productPage({pageNo:1,pageSize:25,productState:'all',productNo:checked.productNo,articleNo:payload.articleNo},signal);
    if(!page||!Number.isSafeInteger(page.total)||page.total<0||!Array.isArray(page.list))throw new ErpError('待审核保存回执查询未返回有效列表，原提交已保留，不能据此再次新增',{code:'ERP_PRODUCT_RECEIPT_UNKNOWN'});
    if(page.total>page.list.length)throw new ErpError('商品编码回执查询结果不完整，请核对原记录，未重复提交',{code:'ERP_PRODUCT_RECEIPT_UNKNOWN'});
    // The formal list may omit supplierName; the mandatory detail read below
    // still validates it before marking the task complete.
    const matches=page.list.filter(row=>row.productNo===checked.productNo&&row.articleNo===payload.articleNo&&(row.supplierName==null||row.supplierName===payload.supplierName));
    if(matches.length!==1)throw new ErpError(matches.length?'同一商品编码存在多条记录，请在互拓核对；未重复提交':'尚未查到原商品保存记录，请稍后继续查询；未重复提交',{code:'ERP_PRODUCT_RECEIPT_UNKNOWN'});
    const id=String(matches[0].id||'');if(!/^\d+$/.test(id))throw new ErpError('原商品回执缺少有效产品 ID');
    const product=await this.productDetail(id,signal);
    if(!product||String(product.id)!==id||product.productNo!==checked.productNo||product.articleNo!==payload.articleNo||product.supplierName!==payload.supplierName)throw new ErpError('产品回读与原提交商品身份不一致，未标记完成');
    if(product.productState!==0)throw new ErpError('原商品当前不在待审核状态，请在互拓核对，未重复提交或更改状态');
    return {productId:id,productNo:product.productNo,productState:0,productName:product.productName||'',state:'pending_approval'};
  }
  async submitDraft(attempt,{signal}={}) {
    if(!this.#config.erpDraftApiConfirmed)throw new ErpError('ERP 草稿接口尚未确认部署，远端写入未启用');
    const checked=prepareDraftAttempt(parseErpJson(attempt.body),attempt.key);
    try {
      const id=await this.request('/erp/product-draft/add',{method:'POST',body:checked.body,headers:{'Idempotency-Key':checked.key},signal});
      if(!/^\d+$/.test(String(id)))throw new ErpError('草稿保存响应缺少合法 draftId',{ambiguous:true});
      return {state:'saved',draftId:String(id),idempotencyKey:checked.key};
    }catch(error){
      if(error instanceof ErpError && error.ambiguous)return {state:'unknown',draftId:null,idempotencyKey:checked.key,error:'ERP 保存结果未知，须沿用同一请求键与正文恢复'};
      throw error;
    }
  }
}

function configManaged(config) { return config?.erpManaged === true; }
