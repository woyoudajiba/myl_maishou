'use strict';
const {normalizeSourceInput}=require('./buyer-links');

const TABLE_ID = /^[\da-f-]{36}$/i;
const DEFAULT_TABLE_SERVICE_URL = 'https://wsfile.cn/maishou/api/online-table';

function safeBaseUrl(value = DEFAULT_TABLE_SERVICE_URL) {
  const url = new URL(String(value || ''));
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const ownedService = url.protocol === 'https:' && url.hostname === 'wsfile.cn' && !url.port && url.pathname.replace(/\/$/, '') === '/maishou/api/online-table';
  if (!(ownedService || url.protocol === 'http:' && loopback) || url.username || url.password || url.hash || url.search) {
    throw new Error('在线选品表只能连接找商品云服务或本机联调服务');
  }
  return url.href.replace(/\/$/, '');
}

class OnlineTableClient {
  constructor({ baseUrl = DEFAULT_TABLE_SERVICE_URL, tableId = '', authToken = '', transport = (...args) => fetch(...args) } = {}) {
    this.transport = transport;
    this.configure({ baseUrl, tableId, authToken });
  }
  getBaseUrl(){return this.baseUrl;}
  configure({ baseUrl = this.baseUrl || DEFAULT_TABLE_SERVICE_URL, tableId = this.tableId || '', authToken = this.authToken || '' } = {}) {
    this.baseUrl = safeBaseUrl(baseUrl);
    this.tableId = TABLE_ID.test(String(tableId || '')) ? String(tableId) : '';
    this.authToken = typeof authToken === 'string' ? authToken : '';
  }
  configured() { return !!(this.baseUrl && this.authToken && TABLE_ID.test(this.tableId)); }
  async request(route, options = {}) {
    if (!this.baseUrl || !this.authToken) throw new Error('请先登录 TDL 账号');
    let response;
    try {
      response = await this.transport(`${this.baseUrl}${route}`, {
        ...options,
        redirect: 'error',
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.authToken}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
        signal: options.signal || AbortSignal.timeout(15000)
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error('在线选品表服务请求超时，请点击刷新表格重试');
      const code = String(error?.cause?.code || error?.code || '');
      if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) throw new Error('无法解析在线选品表服务器域名，请检查网络或 DNS 后刷新');
      if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code)) throw new Error('在线选品表 HTTPS 证书验证失败，请检查系统时间或网络代理');
      throw new Error('在线选品表服务无法连接，请检查网络或登录状态后重试');
    }
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { throw new Error('在线选品表服务返回格式无效'); }
    if (!response.ok || body?.ok === false) {
      const error = new Error(body?.error || `在线选品表请求失败（HTTP ${response.status}）`);
      error.status = response.status;
      error.current = body?.current;
      throw error;
    }
    return body;
  }
  async listTables() { return this.request('/api/tables'); }
  async create(name = '买手选品表') {
    const body = await this.request('/api/tables', { method: 'POST', body: JSON.stringify({ name: String(name || '').trim().slice(0, 120) }) });
    if (!TABLE_ID.test(String(body?.table?.id || ''))) throw new Error('服务器没有返回有效的选品表');
    this.tableId = body.table.id;
    return body;
  }
  select(tableId) {
    if (!TABLE_ID.test(String(tableId || ''))) throw new Error('请选择有效的在线选品表');
    this.tableId = String(tableId);
  }
  async getRows({ offset = 0, limit = 200, status = '', search = '' } = {}) {
    if (!this.configured()) throw new Error('请先选择在线选品表');
    const query = new URLSearchParams({ offset: String(Math.max(0, offset)), limit: String(Math.min(1000, Math.max(1, limit))) });
    if (status) query.set('status', status);
    if (String(search || '').trim()) query.set('search', String(search).trim().slice(0, 300));
    return this.request(`/api/tables/${this.tableId}?${query}`);
  }
  async importRows(rows) {
    if (!this.configured()) throw new Error('请先选择在线选品表');
    return this.request(`/api/tables/${this.tableId}/rows`, { method: 'POST', body: JSON.stringify({ rows: rows.map(normalizeSourceInput) }) });
  }
  async findRows(search, index = 0) {
    if (!this.configured()) throw new Error('请先选择在线选品表');
    return this.request(`/api/tables/${this.tableId}/find?${new URLSearchParams({search:String(search||'').trim().slice(0,300),index:String(index)})}`);
  }
  async locateRow({rowId='',position=''}={}) {
    if (!this.configured()) throw new Error('请先选择在线选品表');
    return this.request(`/api/tables/${this.tableId}/locate?${new URLSearchParams({rowId:String(rowId),position:String(position)})}`);
  }
  async history(options = {}) {
    if (!this.configured()) throw new Error('请先选择在线选品表');
    const {limit = 50, before = ''} = typeof options === 'number' ? {limit: options} : options;
    return this.request(`/api/tables/${this.tableId}/history?limit=${encodeURIComponent(Math.min(200, Math.max(1, Number(limit) || 50)))}&before=${encodeURIComponent(before)}`);
  }
  async historyDetail(historyId) {
    if (!this.configured() || !/^\d+$/.test(String(historyId || ''))) throw new Error('历史记录编号无效');
    return this.request(`/api/tables/${this.tableId}/history/${historyId}`);
  }
  async previewRollback(historyId) {
    if (!this.configured() || !/^\d+$/.test(String(historyId || ''))) throw new Error('历史版本编号无效');
    return this.request(`/api/tables/${this.tableId}/rollback/${historyId}`);
  }
  async rollback(historyId, ifRevision) {
    if (!this.configured() || !/^\d+$/.test(String(historyId || ''))) throw new Error('历史版本编号无效');
    return this.request(`/api/tables/${this.tableId}/rollback/${historyId}`, { method: 'POST', body: JSON.stringify({ifRevision}) });
  }
  async deleteRow(rowId, ifVersion) {
    if (!this.configured() || !TABLE_ID.test(String(rowId || ''))) throw new Error('在线选品表行编号无效');
    return this.request(`/api/tables/${this.tableId}/rows/${rowId}`, { method: 'DELETE', body: JSON.stringify({ifVersion}) });
  }
  async updateRow(rowId, patch, ifVersion, taskId) {
    if (!this.configured() || !TABLE_ID.test(String(rowId || ''))) throw new Error('在线选品表行编号无效');
    return this.request(`/api/tables/${this.tableId}/rows/${rowId}`, { method: 'PATCH', body: JSON.stringify({ patch: normalizeSourceInput(patch), ifVersion, ...(taskId?{taskId}:{}) }) });
  }
  async updateTask(rowId, taskId, patch, ifVersion) {
    // Rebase only workflow fields belonging to the same claimed task. User edits stay intact.
    const workflowPatch = Object.fromEntries(['automationState','automationStep','automationError','erpProductNo','supplierArticleNo'].filter(key=>Object.hasOwn(patch,key)).map(key=>[key,patch[key]]));
    try { return await this.updateRow(rowId,workflowPatch,ifVersion,taskId); }
    catch(error){
      if(error.status!==409 || !taskId || error.current?.taskId!==taskId)throw error;
      return this.updateRow(rowId,workflowPatch,error.current.version,taskId);
    }
  }
  async claimRow(rowId, taskId) {
    if (!this.configured() || !TABLE_ID.test(String(rowId || ''))) throw new Error('在线选品表行编号无效');
    return this.request(`/api/tables/${this.tableId}/claim/${rowId}`, { method: 'POST', body: JSON.stringify({ taskId }) });
  }
  async restartRow(rowId, { previousTaskId, taskId, ifVersion } = {}) {
    if (!this.configured() || !TABLE_ID.test(String(rowId || '')) || !TABLE_ID.test(String(previousTaskId || '')) || !TABLE_ID.test(String(taskId || '')) || taskId === previousTaskId || !Number.isSafeInteger(Number(ifVersion))) throw new Error('在线任务重新开始参数无效');
    return this.request(`/api/tables/${this.tableId}/restart/${rowId}`, { method: 'POST', body: JSON.stringify({ previousTaskId, taskId, ifVersion: Number(ifVersion) }) });
  }
  async health() { return this.request('/health'); }
}

module.exports = { OnlineTableClient, safeBaseUrl, DEFAULT_TABLE_SERVICE_URL };
