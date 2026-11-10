import { parseErpJson, externalIdFromUrl, normalizeCollection, prepareDraftAttempt } from './contract.mjs';
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
    let response;
    try { response = await this.#fetch(url, { method, body: content, headers: combined, redirect: 'error', signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(20000)]) }); }
    catch { throw new ErpError('ERP 请求中断或超时，请查询原记录后再处理', { ambiguous: method !== 'GET' }); }
    let data;
    try { const text = await response.text(); if (text.length > 8 * 1024 * 1024) throw new Error(); data = parseErpJson(text); }
    catch { throw new ErpError('ERP 响应无法按契约解析', { status: response.status, ambiguous: method !== 'GET' && (response.ok || response.status >= 500) }); }
    if (!response.ok || data?.code !== 0) {
      // Upstream msg may contain credentials or private request fields. Keep status/code only.
      throw new ErpError(`ERP 请求失败（HTTP ${response.status}，业务码 ${typeof data?.code === 'number' ? data.code : '缺失'}）`, { status: response.status, code: typeof data?.code === 'number' ? data.code : null, ambiguous: method !== 'GET' && (response.status >= 500 || (response.ok && typeof data?.code !== 'number')) });
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
  controls(categoryName,signal) { return Promise.all([this.request('/erp/category/info',{signal}),this.request(`/erp/attributes-extend/extend-category?categoryTypeName=${encodeURIComponent(categoryName)}&productNo=`,{signal})]); }
  colors(name,signal) { return this.request(`/erp/colors/query?colorName=${encodeURIComponent(name)}`,{signal}); }
  getCollection(id,signal) { return this.request(`/taobao/product-crawler/get?id=${encodeURIComponent(id)}`,{signal}); }
  originalImages(id,signal) { return this.request(`/taobao/product-crawler/get-original-images?externalId=${encodeURIComponent(id)}`,{signal}); }
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
  draftAttributes(id,signal) { return this.request(`/erp/product-draft/attributes?id=${encodeURIComponent(id)}`,{signal}); }
  draftPictures(id,signal) { return this.request(`/erp/product-draft/public-pic?id=${encodeURIComponent(id)}`,{signal}); }
  draftPage({pageNo=1,pageSize=25,supplier='',articleNo=''}={},signal) {
    const body={pageNo,pageSize};if(supplier)body.supplier=supplier;if(articleNo)body.articleNo=articleNo;
    return this.request('/erp/product-draft/page',{method:'POST',body,signal});
  }
  async listDrafts({pageNo=1,pageSize=25,articleNo=''}={},signal) {
    if(!Number.isInteger(pageNo)||pageNo<1||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw new ErpError('草稿分页参数无效');
    const data=await this.draftPage({pageNo,pageSize,articleNo},signal);
    if(data===null)return {list:[],total:0};
    if(!data||typeof data!=='object'||(data.list!==null&&!Array.isArray(data.list))||!Number.isFinite(Number(data.total)))throw new ErpError('ERP 草稿列表响应结构无效');
    return {list:Array.isArray(data.list)?data.list:[],total:Number(data.total)};
  }
  async convertDraft(id,revision,signal) {
    if(!/^\d+$/.test(String(id))||!Number.isInteger(Number(revision))||Number(revision)<1)throw new ErpError('草稿 ID 或版本无效');
    if(!this.#config.erpDraftConvertConfirmed)throw new ErpError('互拓待审核转换未启用');
    return this.request(`/erp/product-draft/convert?id=${encodeURIComponent(id)}&revision=${encodeURIComponent(revision)}`,{method:'POST',signal});
  }
  productDetail(id,signal) { return this.request(`/erp/pool-product/getProductInfosDetailById?id=${encodeURIComponent(id)}`,{signal}); }
  productPage(body,signal) { return this.request('/erp/pool-product/page',{method:'POST',body,signal}); }
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
