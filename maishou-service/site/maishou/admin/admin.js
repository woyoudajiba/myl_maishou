'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const TOKEN_KEY = 'maishou-tdl-token';
async function loadOwnErp(){
  const result=await api('/maishou/api/erp-config/me');
  $('own-erp-status').textContent=result.ready?'已连接互拓':result.error||'请保存互拓账号';
  $('own-erp-username').value=result.account?.username||'';$('own-erp-password').value='';
  $('own-erp-password').placeholder=result.account?.hasPassword?'已在服务器加密保存，留空保持':'请填写互拓密码';
}
async function ownErpAction(button,callback){button.disabled=true;$('own-erp-message').textContent='';try{const message=await callback();if(message)$('own-erp-message').textContent=message;}catch(error){$('own-erp-message').textContent=error.message;}finally{button.disabled=false;}}
$('own-erp-form').addEventListener('submit',event=>{event.preventDefault();void ownErpAction(event.submitter,async()=>{await api('/maishou/api/erp-config/me',{method:'PUT',body:JSON.stringify({username:$('own-erp-username').value,password:$('own-erp-password').value})});$('own-erp-password').value='';await loadOwnErp();return'账号已在服务器加密保存。';});});
$('own-erp-test').addEventListener('click',event=>void ownErpAction(event.currentTarget,async()=>{const result=await api('/maishou/api/erp-config/test',{method:'POST'});return`连接成功：${result.dictionaries} 项字典、${result.categories} 个类别。`;}));
$('own-erp-clear').addEventListener('click',event=>void ownErpAction(event.currentTarget,async()=>{await api('/maishou/api/erp-config/me',{method:'DELETE'});await loadOwnErp();return'当前账号凭据已清除。';}));
let accountId = '';
let currentData = null;
const number = value => new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
const when = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : '暂无';
function token(){return sessionStorage.getItem(TOKEN_KEY)||'';}
async function api(url, options={}){
  const response=await fetch(url,{...options,cache:'no-store',headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(token()?{Authorization:`Bearer ${token()}`}:{}) ,...(options.headers||{})}});
  let payload={};try{payload=await response.json();}catch{}
  if(!response.ok)throw new Error(payload.error||`请求失败（HTTP ${response.status}）`);
  return payload;
}
function renderSummary(data){
  void loadOwnErp().catch(error=>{$('own-erp-message').textContent=error.message;});
  currentData=data;
  $('requests').textContent=number(data.totals.requests);
  $('success-line').textContent=`成功 ${number(data.totals.succeeded)} · 失败 ${number(data.totals.failed)}`;
  $('total-tokens').textContent=number(data.totals.totalTokens);
  $('token-line').textContent=`输入 ${number(data.totals.inputTokens)} · 输出 ${number(data.totals.outputTokens)}`;
  $('average-latency').textContent=`${data.totals.requests?((data.totals.latencyMs/data.totals.requests)/1000).toFixed(1):'0.0'} 秒`;
  $('last-used').textContent=`最近使用：${when(data.totals.lastUsedAt)}`;
  $('selected-account').textContent=data.user.displayName?`${data.user.displayName} · ${data.user.username||''}`:'';
  $('daily-table').innerHTML=data.daily.map(row=>`<tr><td>${esc(row.date)}</td><td>${number(row.requests)}</td><td>${number(row.succeeded)}</td><td>${number(row.failed)}</td><td>${number(row.inputTokens)}</td><td>${number(row.outputTokens)}</td><td>${number(row.totalTokens)}</td><td>${row.requests?((row.latencyMs/row.requests)/1000).toFixed(1):'0.0'} 秒</td></tr>`).join('');
  $('empty-state').hidden=!!data.daily.length;
  $('daily-title').textContent=accountId?'账号每日用量':'每日用量';
  $('back-to-all').hidden=!accountId;
  const accounts=data.accounts;
  $('accounts-panel').hidden=!accounts;
  $('erp-users-link').hidden=!accounts;
  $('scope-copy').textContent=data.scope==='all'?'TDL 管理员视图 · 当前范围内的账号汇总与每日记录':'个人视图 · 仅显示当前 TDL 账号的用量';
  $('account-badge').textContent=`${data.scope==='all'?'管理员':'账号'}：${data.user.displayName||data.user.username}`;
  $('account-badge').hidden=false;
  renderAccounts(accounts||[]);
}
function renderAccounts(accounts){
  const query=$('search-accounts').value.trim().toLowerCase();
  const rows=accounts.filter(row=>`${row.displayName} ${row.username} ${row.id}`.toLowerCase().includes(query));
  $('accounts-table').innerHTML=rows.map(row=>`<tr data-account="${esc(row.id)}"><td><span class="account-name">${esc(row.displayName||row.username||'TDL 用户')}</span><br><small>${esc(row.username)}</small></td><td>${number(row.counters.requests)}</td><td>${number(row.counters.succeeded)} / ${number(row.counters.failed)}</td><td>${number(row.counters.inputTokens)}</td><td>${number(row.counters.outputTokens)}</td><td>${esc(when(row.counters.lastUsedAt))}</td></tr>`).join('');
}
async function load(){
  $('page-error').textContent='';
  const days=$('range').value;
  const suffix=`?days=${encodeURIComponent(days)}${accountId?`&accountId=${encodeURIComponent(accountId)}`:''}`;
  const data=await api(`/maishou/api/usage${suffix}`);
  renderSummary(data);
}
function showDashboard(){ $('login-view').hidden=true; $('dashboard').hidden=false; }
function showLogin(){ $('login-view').hidden=false; $('dashboard').hidden=true; $('account-badge').hidden=true; sessionStorage.removeItem(TOKEN_KEY);$('own-erp-password').value='';$('own-erp-username').value=''; }
$('login-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget;$('login-error').textContent='';
  const button=event.submitter;button.disabled=true;
  try{
    const values=Object.fromEntries(new FormData(form));
    const response=await fetch('/myladmin/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...values,clientLabel:'找商品模型用量'})});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok||!payload.token)throw new Error(payload.message||'TDL 登录失败，请检查账号或密码。');
    sessionStorage.setItem(TOKEN_KEY,payload.token);form.reset();accountId='';showDashboard();await load();
  }catch(error){$('login-error').textContent=error.message;}
  finally{button.disabled=false;}
});
$('refresh').addEventListener('click',()=>void load().catch(error=>{$('page-error').textContent=error.message;}));
$('range').addEventListener('change',()=>{accountId='';void load().catch(error=>{$('page-error').textContent=error.message;});});
$('search-accounts').addEventListener('input',()=>renderAccounts(currentData?.accounts||[]));
$('accounts-table').addEventListener('click',event=>{const row=event.target.closest('[data-account]');if(!row)return;accountId=row.dataset.account;void load().catch(error=>{$('page-error').textContent=error.message;});});
$('back-to-all').addEventListener('click',()=>{accountId='';void load().catch(error=>{$('page-error').textContent=error.message;});});
$('logout').addEventListener('click',async()=>{try{await api('/myladmin/api/auth/logout',{method:'POST'});}catch{}showLogin();});
if(token()){showDashboard();void load().catch(error=>{showLogin();$('login-error').textContent=error.message;});}
