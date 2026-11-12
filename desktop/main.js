const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog } = require('electron');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sharp = require('sharp');
const { createDesktopBridge } = require('./bridge-server');
const { Accounts, profileId, encryptedStorage } = require('./accounts');
const { loadOrCreatePairingToken } = require('./pairing');
const { Models, invokeModel } = require('./models');
const { PlatformAccounts } = require('./platform-accounts');
const { BuyerWorkflow, imageData: buyerImageData } = require('./buyer-workflow');
const {resolveOnlineTask}=require('./online-task-binding');
const {parseBuyerTable,publicImport,sourceLink,exportBuyerXlsx}=require('./buyer-import');
const {BuyerSettings}=require('./buyer-settings');
const {BuyerEngine}=require('./buyer-engine');
const {createBuyerProviders}=require('./buyer-providers');
const { buildBuyerSource } = require('./buyer-source');
const { downloadCandidate, downloadImagePreview, validateQuery } = require('./images');
const { compareCandidates } = require('./comparison');
const { createUpdates, displayVersion } = require('./updates');
const { Extension } = require('./extension');
const { DouyinDownloads, createBrowserParser } = require('./douyin');
const review = require('../review');
const { syncBuyerFolder } = require('./buyer-files');
const { buyerTaskComparisonPreview, queueBuyerCandidateGallery, candidateGallery } = require('./buyer-preview');

// Honor Electron's standard profile switch before restoring any account or job.
const userDataDir = app.commandLine.getSwitchValue('user-data-dir');
if (userDataDir) app.setPath('userData', path.resolve(userDataDir));

let windowRef;
let bridge, accounts, models, platformAccounts, buyerWorkflow, profileController, authTimer;
let buyerSettings,buyerEngine,buyerProviders,buyerImportPreview=null;
let onlineTableSync=null;
let onlineTablePollTimer=null,onlineTablePollBusy=false,onlineTableDiscoveryAt=0;
let updates, installingUpdate = false;
let extension;
let douyin;
let accessAllowed = false, startupError = '', lastValidated = 0;
let mutations = Promise.resolve();
const serial = action => { const result = mutations.then(action); mutations = result.catch(() => {}); return result; };
const authenticated = () => accessAllowed && accounts?.authenticated();
const activeModelConfig = (id) => {
  const config = models?.config(id);
  if (config?.managed && accounts?.session?.token) config.authToken = accounts.session.token;
  return config;
};

const visionStatus = () => {
  const list = models?.list(); const selected = list?.models.find(item => item.id === list.activeId);
  return { configured: !!selected, model: selected?.model || '', name: selected?.name || '' };
};
async function syncTaskToOnlineTable(task) {
  if (task?.automation && buyerSettings?.value?.productRootDir) {
    try {
      let sourceImage = null;
      try { sourceImage = await buyerWorkflow.image(task.id); } catch {}
      const folder = await syncBuyerFolder({ rootDir: buyerSettings.value.productRootDir, task, sourceImage });
      if (folder && task.productFolder !== folder) await buyerWorkflow.patchTask(task.id, { productFolder: folder });
    } catch (error) {
      await buyerWorkflow.patchAutomation(task.id, { error: `商品文件夹保存失败：${String(error.message || error).slice(0,180)}` }, '商品文件夹保存失败，已保留自动处理结果');
    }
  }
  if (!task?.onlineTableRowId) return;
  try {
    const {client}=await resolveOnlineTask({task,settings:buyerSettings,authToken:accounts.session.token,workflow:buyerWorkflow});
    const result = await client.updateTask(task.onlineTableRowId, task.id, { automationState: task.automation?.state || '', automationStep: task.automation?.step || '', automationError: task.automation?.error || (task.automation?.state==='waiting'?task.automation.waitingReason||'':''), erpProductNo: task.automation?.result?.productNo || '' }, task.onlineTableRowVersion || 1);
    const updated = result.row || result;
    task.onlineTableRowVersion = updated.version;
    await buyerWorkflow.patchTask(task.id, { onlineTableRowVersion: updated.version });
    if(onlineTableSync?.snapshot?.id===client.tableId)onlineTableSync = { ...onlineTableSync, lastSyncAt: Date.now() };
  } catch (error) {
    if (error.status === 409) await buyerWorkflow.patchAutomation(task.id, { error: `在线表格同步冲突：${error.message}` }, '在线表格被其他人修改，已暂停自动覆盖');
  }
}
async function refreshOnlineTable() {
  if (!authenticated() || !buyerSettings) return null;
  const client = await buyerSettings.onlineTableClient(accounts.session.token);
  const result = await client.listTables();
  const selected = (result.tables || []).find(item => item.id === buyerSettings.value.onlineTableId) || result.tables?.[0] || null;
  if ((selected?.id || '') !== buyerSettings.value.onlineTableId) await buyerSettings.save({ onlineTableId: selected?.id || '' });
  const activeClient = await buyerSettings.onlineTableClient(accounts.session.token);
  if (selected) activeClient.select(selected.id);
  onlineTableSync = { client: activeClient, snapshot: selected, tables: result.tables || [], lastPollAt: Date.now() };
  onlineTableDiscoveryAt = Date.now();
  return selected;
}
function onlineRowOrigin(row,table=onlineTableSync?.snapshot){
  const tableFields=Object.fromEntries(['shopName','sales7d','peerPrice','peerLocation','goodsCost','warehouse'].map(key=>[key,row[key]||'']));
  return {batchId:'online-table',digest:'',fileName:'在线表格',sheetName:table?.name||'买手选品表',rowNumber:row.position,tableId:row.tableId||String(row.position).padStart(2,'0'),selectDate:row.selectDate||'',supplierName:row.supplierName||'',externalCode:row.externalCode||'',selectOperator:row.selectOperator||'',buyerOperator:row.buyerOperator||'',note:row.note||'',tableFields};
}
async function pollApprovedOnlineRows() {
  if(onlineTablePollBusy||!authenticated()||!buyerSettings||!buyerSettings.configured())return;
  if(!onlineTableSync?.snapshot){if(Date.now()-onlineTableDiscoveryAt<15000)return;try{await refreshOnlineTable();}catch{return;}if(!onlineTableSync?.snapshot)return;}
  onlineTablePollBusy=true;
  try{
    const client=await buyerSettings.onlineTableClient(accounts.session.token),page=await client.getRows({offset:0,limit:100,status:'approved'});
    if(buyerSettings.value.onlineTableId===page.table.id)onlineTableSync={client,snapshot:page.table,lastPollAt:Date.now()};
    for(const row of page.rows){
      if(!row.sourceUrl)continue;
      if(row.taskId||row.humanStatus!=='approved'||buyerWorkflow.state.tasks.some(task=>task.onlineTableRowId===row.id))continue;
      const taskId=crypto.randomUUID();let claimed;
      try{claimed=await client.claimRow(row.id,taskId);}catch(error){if(error.status===409)continue;throw error;}
      const remote=claimed.row;
      const task=await buyerWorkflow.create({id:taskId,articleNo:remote.articleNo,sourceType:remote.sourceType,sourceUrl:remote.sourceUrl,sourceTitle:remote.title});
      await buyerWorkflow.patchTask(task.id,{onlineTableId:page.table.id,onlineTableRowId:remote.id,onlineTableRowVersion:remote.version,externalCode:remote.externalCode||'',supplierName:remote.supplierName||'',origin:onlineRowOrigin(remote,page.table)});
      await buyerEngine.start([task.id]);
    }
  }catch(error){if(error.status===401||error.status===403)startupError=`在线表格登录需要重新连接：${error.message}`;}
  finally{onlineTablePollBusy=false;}
}
async function compareJob(job, update) {
  const config = activeModelConfig(), controller = profileController, currentBridge = bridge;
  if (!authenticated() || !config) throw new Error('请登录并选择视觉模型');
  try { await accounts.validate(); lastValidated = Date.now(); }
  catch (error) {
    if (error.unauthorized) setImmediate(() => { void serial(() => deactivate(error.message)); });
    throw error;
  }
  await validateQuery(job.query);
  return compareCandidates(job, update, { config, signal: controller.signal, allowed: authenticated,
    downloadImage: downloadCandidate, saveImage: (index, buffer) => currentBridge.storeCandidateImage(job.id, index, buffer), invoke: invokeModel });
}

async function activateProfile() {
  const dataDir = path.join(app.getPath('userData'), 'profiles', profileId(accounts.session.user));
  const pairingToken = await loadOrCreatePairingToken({ dataDir, storage: encryptedStorage(safeStorage) });
  models = new Models({ dataDir, storage: encryptedStorage(safeStorage) });
  await models.load();
  await models.ensureManagedDefault();
  if (models.list().activeId) models.config(); // Check that this Windows user can decrypt the selected key.
  platformAccounts = new PlatformAccounts({ dataDir, storage: encryptedStorage(safeStorage) });
  await platformAccounts.load();
  buyerWorkflow = new BuyerWorkflow({ dataDir });
  await buyerWorkflow.load();
  buyerSettings=new BuyerSettings({dataDir,storage:encryptedStorage(safeStorage),requireManaged:process.env.PC_QA_LOCAL_ERP!=='1'});await buyerSettings.load();await buyerSettings.syncManaged(accounts.session.token);
  profileController = new AbortController();
  lastValidated = Date.now();
  bridge = createDesktopBridge({ port: 43821, dataDir: path.join(dataDir, 'jobs'), token: pairingToken,
    expectedExtensionVersion:extension?.snapshot().bundledVersion||'',
    canAccess: () => authenticated() && !installingUpdate, canProcess: () => authenticated() && !installingUpdate && !!visionStatus().configured && Date.now() - lastValidated < 5 * 60000,
    getVisionStatus: visionStatus, getPlatformCredential: platform => platformAccounts.credential(platform),
    onProductSearchAccepted: (taskId, queryId) => buyerWorkflow.linkSearch(taskId, queryId),
    onTaobaoSearchResults: (taskId, candidates, commandId) => buyerWorkflow.saveTaobaoSearch(taskId,candidates,commandId),
    onTaobaoSearchFailed: (taskId, error) => buyerWorkflow.failTaobaoSearch(taskId,error),
    onBuyerBrowserResult:(command,result,error)=>buyerProviders.onBrowserResult(command,result,error),processJob: compareJob });
  await bridge.start();
  accessAllowed = true;
  void refreshOnlineTable().catch(() => { onlineTableSync = null; onlineTableDiscoveryAt = Date.now(); });
  buyerProviders=createBuyerProviders({workflow:buyerWorkflow,bridge,settings:buyerSettings,model:()=>activeModelConfig(),signal:profileController.signal,onTaskUpdated:task=>syncTaskToOnlineTable(task)});
  buyerProviders.validateTask=task=>resolveOnlineTask({task,settings:buyerSettings,authToken:accounts.session.token,workflow:buyerWorkflow});
  buyerEngine=new BuyerEngine({workflow:buyerWorkflow,providers:buyerProviders,signal:profileController.signal});await buyerEngine.init();if(!buyerSettings.configured())await buyerEngine.pause();
  clearInterval(onlineTablePollTimer);onlineTablePollTimer=setInterval(()=>void pollApprovedOnlineRows(),3000);onlineTablePollTimer.unref?.();void pollApprovedOnlineRows();
  bridge.resume();
  void updates?.onLogin();
}
async function deactivate(message = '') {
  updates?.onLogout();
  accessAllowed = false;
  clearInterval(onlineTablePollTimer);onlineTablePollTimer=null;onlineTableDiscoveryAt=0;
  await buyerEngine?.close();buyerImportPreview=null;
  await douyin?.reset();
  profileController?.abort();
  await bridge?.close();
  bridge = null; models = null; platformAccounts = null; buyerWorkflow = null;buyerSettings=null;buyerEngine=null;buyerProviders=null;onlineTableSync=null;
  await accounts.logout();
  startupError = message;
}
function snapshot() {
  const loggedIn = authenticated() && !!bridge;
  const version = app.isPackaged ? displayVersion(app.getVersion()) : require('../manifest.json').version_name;
  return { version, authenticated: loggedIn, user: loggedIn ? accounts.session.user : null, error: startupError,
    updates: updates?.snapshot(),
    extension: extension?.snapshot(),
    douyin: loggedIn ? douyin?.snapshot() : null,
    ...(loggedIn ? bridge.snapshot() : { port: null, token: '', vision: { configured: false }, jobs: [] }),
    catalog: loggedIn ? models.list() : { activeId: '', models: [] },
    platformAccounts: loggedIn ? platformAccounts.list() : [], buyerTasks: loggedIn ? buyerWorkflow.snapshot() : [],buyerAutomation:loggedIn?buyerEngine?.snapshot():null,buyerSettings:loggedIn?buyerSettings?.snapshot():null,onlineTable:loggedIn&&onlineTableSync?{table:onlineTableSync.snapshot,serviceAvailable:true}:null };
}
function createWindow() {
  windowRef = new BrowserWindow({ title: '找商品工作台', icon: path.join(__dirname, 'assets/app-icon.png'), autoHideMenuBar: true,
    width: 1160, height: 820, minWidth: 800, minHeight: 620,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  windowRef.loadFile(path.join(__dirname, 'index.html'));
  windowRef.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  windowRef.webContents.on('will-navigate', event => event.preventDefault());
  windowRef.on('closed', () => { windowRef = null; });
}

function handle(name, action, needsLogin = true) {
  ipcMain.handle(`desktop:${name}`, (event, ...args) => {
    if (event.sender !== windowRef?.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== pathToFileURL(path.join(__dirname, 'index.html')).href) throw new Error('不允许的桌面调用');
    return serial(async () => {
      if (needsLogin && !authenticated()) throw new Error('请先登录 TDL 账号');
      if (needsLogin && installingUpdate) throw new Error('正在准备安装更新，请稍候');
      return action(...args);
    });
  });
}
function assertModelEditable() {
  if (bridge.snapshot().jobs.some(job => job.status === 'processing')) throw new Error('请等待当前模型任务完成后再修改模型配置');
}
handle('snapshot', snapshot, false);
handle('login', async input => {
  if (authenticated()) throw new Error('请先退出当前账号');
  startupError = '';
  await accounts.login(input);
  try { await activateProfile(); }
  catch (error) { await deactivate(); throw error; }
  return snapshot();
}, false);
handle('logout', async () => { await deactivate(); return snapshot(); }, false);
handle('save-model', async value => { assertModelEditable(); const result = await models.save(value); bridge.resume(); return result; });
handle('delete-model', async id => { assertModelEditable(); return models.remove(id); });
handle('select-model', async id => { assertModelEditable(); const result = await models.select(id); bridge.resume(); return result; });
handle('test-model', async id => {
  assertModelEditable();
  const config = activeModelConfig(id);
  if (!config) throw new Error('请先保存模型');
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#0f766e' } }).png().toBuffer();
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  await invokeModel(config, { query: dataUrl, candidates: [{ id: 'candidate_1', dataUrl }] }, { signal: profileController.signal });
  return { ok: true, message: '连接成功，已验证图片输入和结构化比对响应' };
});
handle('save-platform-account', (platform, input) => platformAccounts.save(platform, input));
handle('delete-platform-account', platform => platformAccounts.remove(platform));
handle('buyer-import-preview',async()=>{
  const result=await dialog.showOpenDialog(windowRef,{title:'导入运营选品表',properties:['openFile'],filters:[{name:'选品表',extensions:['xlsx','csv','tsv']}]});
  if(result.canceled||!result.filePaths[0])return null;const file=result.filePaths[0],stat=await fs.stat(file);if(!stat.isFile()||stat.size>30*1024*1024)throw new Error('表格不能超过30MB');
  buyerImportPreview=parseBuyerTable(await fs.readFile(file),path.basename(file));
  for(const row of buyerImportPreview.rows)if(row.image){try{const ready=await sharp(row.image,{limitInputPixels:50000000}).rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).jpeg({quality:92}).toBuffer();row.image=ready;}catch{row.image=null;row.tags.push('表内图片无法读取');}}
  return publicImport(buyerImportPreview);
});
handle('buyer-import-confirm',async batchId=>{if(!buyerImportPreview||buyerImportPreview.batchId!==batchId)throw new Error('导入预览已过期，请重新选择表格');const result=await buyerWorkflow.importTable(buyerImportPreview);buyerImportPreview=null;return result;});
handle('buyer-auto-link',async value=>{
  if(typeof value!=='string'||!value.trim()||value.length>10000)throw new Error('请粘贴一条商品链接或抖音分享文案');
  const preview=parseBuyerTable(Buffer.from('商品链接\n"'+value.replace(/"/g,'""')+'"','utf8'),'单个链接.csv');
  if(preview.rows.length!==1||preview.rows[0].errors.length)throw new Error('请只填写一条有效的淘宝、抖音或供应商商品链接');
  const row=preview.rows[0],existing=buyerWorkflow.state.tasks.find(task=>task.sourceUrl===row.sourceUrl);
  if(existing){if(!existing.automation)await buyerWorkflow.patchAutomation(existing.id,{enabled:false,state:'queued',step:'source',tags:[],checkpoints:{}});return{taskId:existing.id,duplicate:true};}
  row.fileName='单个链接';row.sheetName='';row.rowNumber=1;preview.fileName='单个链接';
  await buyerWorkflow.importTable(preview);return{taskId:buyerWorkflow.state.tasks.find(task=>task.origin?.batchId===preview.batchId).id,duplicate:false};
});
handle('buyer-settings-save',input=>buyerSettings.save(input));
handle('buyer-erp-account-page',()=>shell.openExternal('https://wsfile.cn/maishou/admin/'));
handle('buyer-erp-clear',async()=>{await buyerEngine?.pause();return buyerSettings.clearLocal();});
handle('buyer-select-root',async()=>{const result=await dialog.showOpenDialog(windowRef,{title:'选择买手资料根目录',properties:['openDirectory','createDirectory']});return result.canceled||!result.filePaths[0]?null:path.resolve(result.filePaths[0]);});
handle('buyer-template-export',async()=>{const source=path.join(__dirname,'assets','买手上架测试模板.xlsx'),result=await dialog.showSaveDialog(windowRef,{title:'保存买手上架测试模板',defaultPath:path.join(app.getPath('desktop'),'买手上架测试模板.xlsx'),filters:[{name:'Excel工作簿',extensions:['xlsx']}]});if(result.canceled||!result.filePath)return null;await fs.copyFile(source,result.filePath);return result.filePath;});
handle('buyer-settings-import',async()=>{
  const result=await dialog.showOpenDialog(windowRef,{title:'从原买手工具导入互拓连接',defaultPath:'D:\\A_Electron\\maishouauto\\.env',properties:['openFile'],filters:[{name:'本机连接配置',extensions:['env']},{name:'所有文件',extensions:['*']}]});if(result.canceled||!result.filePaths[0])return null;
  const stat=await fs.stat(result.filePaths[0]);if(!stat.isFile()||stat.size>64*1024)throw new Error('连接配置文件无效');
  const env=require('node:util').parseEnv(await fs.readFile(result.filePaths[0],'utf8'));
  const keys={ERP_BASE_URL:'erpBaseUrl',ERP_TENANT_NAME:'erpTenantName',ERP_TENANT_ID:'erpTenantId',ERP_CLIENT_ID:'erpClientId',ERP_CLIENT_SECRET:'erpClientSecret',ERP_USERNAME:'erpUsername',ERP_PASSWORD:'erpPassword',ERP_HTTP_TEST_ORIGIN:'erpHttpTestOrigin',ERP_COMPANY:'company',ERP_BUYER_NAME:'buyerName'};
  const input=Object.fromEntries(Object.entries(keys).filter(([key])=>env[key]).map(([key,value])=>[value,env[key]]));
  if(!input.erpBaseUrl||!input.erpUsername||!input.erpPassword||!input.erpClientSecret)throw new Error('原配置未包含完整互拓连接信息');return buyerSettings.save(input);
});
handle('buyer-erp-test',async()=>{const result=await buyerSettings.catalogs(profileController.signal);const companies=[...new Set(result.dictionaries.filter(row=>row.dictType==='company'&&row.label).map(row=>row.label))];return{ok:true,categories:result.categories.length,dictionaries:result.dictionaries.length,companies};});
handle('online-table-list',async()=>{const selected=await refreshOnlineTable();return{tables:onlineTableSync?.tables||[],selectedId:selected?.id||''};});
handle('online-table-create',async name=>{if(!accounts.session.user.isAdmin)throw Object.assign(new Error('只有 TDL 管理员可以创建在线选品表'),{status:403});const client=await buyerSettings.onlineTableClient(accounts.session.token);const result=await client.create(name);await buyerSettings.save({onlineTableId:result.table.id});await refreshOnlineTable();return{table:result.table};});
handle('online-table-health',async()=>{const client=await buyerSettings.onlineTableClient(accounts.session.token);return client.health();});
handle('online-table-select',async tableId=>{const client=await buyerSettings.onlineTableClient(accounts.session.token),result=await client.listTables();if(!result.tables?.some(table=>table.id===tableId))throw new Error('在线选品表不存在');await buyerSettings.save({onlineTableId:tableId});await refreshOnlineTable();return{table:onlineTableSync.snapshot};});
handle('online-table-rows',async options=>{const client=await buyerSettings.onlineTableClient(accounts.session.token);const result=await client.getRows(options||{});onlineTableSync={client,snapshot:result.table};return result;});
handle('online-table-find',async({search,index=0})=>{const client=await buyerSettings.onlineTableClient(accounts.session.token);return client.findRows(search,index);});
handle('online-table-locate',async input=>{const client=await buyerSettings.onlineTableClient(accounts.session.token);return client.locateRow(input);});
handle('online-table-import',async rows=>{const client=await buyerSettings.onlineTableClient(accounts.session.token);const result=await client.importRows(rows);onlineTableSync={client,snapshot:result.table};return result;});
handle('online-table-update',async({rowId,version,patch})=>{const client=await buyerSettings.onlineTableClient(accounts.session.token);const result=await client.updateRow(rowId,patch,version);onlineTableSync={client,snapshot:onlineTableSync?.snapshot||null};return result;});
handle('online-table-approve',async({rowId,version,approved})=>{if(approved&&!buyerSettings.configured())throw new Error('当前 TDL 账号尚未连接互拓，请在设置中填写自己的账号后再确认并提交');const client=await buyerSettings.onlineTableClient(accounts.session.token);const result=await client.updateRow(rowId,{humanStatus:approved?'approved':'rejected'},version);if(approved){const existing=buyerWorkflow.state.tasks.find(task=>task.onlineTableRowId===rowId);if(!existing){const taskId=crypto.randomUUID(),row=result.row||result;const claimed=await client.claimRow(rowId,taskId);const claimedRow=claimed.row||row;const created=await buyerWorkflow.create({id:taskId,articleNo:claimedRow.articleNo,sourceType:claimedRow.sourceType,sourceUrl:claimedRow.sourceUrl,sourceTitle:claimedRow.title});await buyerWorkflow.patchTask(created.id,{onlineTableId:client.tableId,onlineTableRowId:rowId,onlineTableRowVersion:claimedRow.version,externalCode:claimedRow.externalCode||'',supplierName:claimedRow.supplierName||'',origin:onlineRowOrigin(claimedRow)});await buyerEngine.start([created.id]);}}return result;});
handle('online-table-restart-local',async({rowId,version,previousTaskId})=>{
  if(!models?.config())throw new Error('请先在本机设置并选择视觉模型');
  if(!buyerSettings.configured())throw new Error(buyerSettings.managedError||'请先在本机连接互拓账号');
  if(!/^[\da-f-]{36}$/i.test(String(rowId||''))||!/^[\da-f-]{36}$/i.test(String(previousTaskId||'')))throw new Error('共享任务编号无效');
  if(buyerWorkflow.task(previousTaskId))throw new Error('这条任务已在本机，请使用“查看本机任务”继续');
  if(buyerWorkflow.state.tasks.some(task=>task.onlineTableRowId===rowId))throw new Error('本机已有该共享行的任务，请刷新买手工作台后查看');
  const client=await buyerSettings.onlineTableClient(accounts.session.token),located=await client.locateRow({rowId}),row=located.row;
  if(!row||row.version!==Number(version)||row.taskId!==previousTaskId)throw new Error('共享表任务已在其他设备变化，请刷新表格后重试');
  const allowedStep=['supplier_search','supplier_compare'].includes(row.automationStep)||!row.automationStep&&/(供应商同款|候选未识别|供应商识别未完成|供应商搜索不完整)/.test(row.automationError||'');
  if(row.humanStatus!=='approved'||row.automationState!=='attention'||!allowedStep||row.erpProductNo)throw new Error('这条任务当前阶段不支持本机重新开始，请在原处理设备继续或联系管理员');
  const answer=await dialog.showMessageBox(windowRef,{type:'warning',buttons:['取消','在本机重新开始'],defaultId:0,cancelId:0,message:'在本机重新开始这条供应商任务？',detail:'会使用当前电脑的浏览器登录状态和本地任务记录重新读取商品链接，并将共享表任务绑定切换到这台电脑。原电脑的本地记录保留，但不会再回写这条共享表行。'});
  if(answer.response!==1)return{canceled:true};
  const taskId=crypto.randomUUID();let created,restarted;
  try{
    created=await buyerWorkflow.create({id:taskId,articleNo:row.articleNo,sourceType:row.sourceType,sourceUrl:row.sourceUrl,sourceTitle:row.title});
    await buyerWorkflow.patchTask(taskId,{onlineTableId:client.tableId,onlineTableRowId:row.id,onlineTableRowVersion:row.version+1,externalCode:row.externalCode||'',supplierName:row.supplierName||'',origin:onlineRowOrigin(row)});
    restarted=await client.restartRow(rowId,{previousTaskId,taskId,ifVersion:row.version});
  }catch(error){if(created)await buyerWorkflow.discardUnstartedTask(taskId).catch(()=>{});if(error.status===404)throw new Error('在线表服务器尚未支持跨电脑重新开始，请先更新在线表服务');throw error;}
  if(restarted.row.version!==row.version+1)await buyerWorkflow.patchTask(taskId,{onlineTableRowVersion:restarted.row.version});
  try{await buyerEngine.start([taskId]);}
  catch(error){await buyerWorkflow.patchAutomation(taskId,{enabled:false,state:'attention',step:'source',error:`本机启动失败：${String(error.message||error).slice(0,160)}`,tags:['本机启动失败']},'本机重新开始后未能启动，请在买手工作台重试');await client.updateTask(rowId,taskId,{automationState:'attention',automationStep:'source',automationError:'本机启动失败，请打开本机任务重试'},restarted.row.version).catch(()=>{});throw error;}
  onlineTableSync={client,snapshot:onlineTableSync?.snapshot||null};
  return{taskId,position:row.position};
});
handle('online-table-export',async()=>{const client=await buyerSettings.onlineTableClient(accounts.session.token);const rows=[];for(let offset=0;offset<50000;){const page=await client.getRows({offset,limit:1000});rows.push(...page.rows);if(page.nextOffset===null)break;offset=page.nextOffset;}const result=await dialog.showSaveDialog(windowRef,{title:'导出在线选品表',defaultPath:path.join(app.getPath('desktop'),'在线选品表.xlsx'),filters:[{name:'Excel工作簿',extensions:['xlsx']}]});if(result.canceled||!result.filePath)return null;await fs.writeFile(result.filePath,exportBuyerXlsx(rows.map(row=>({...row,onlineTableId:client.tableId,onlineTableRowId:row.id}))));return{filePath:result.filePath,rows:rows.length};});
handle('online-table-history',async (options={})=>{const client=await buyerSettings.onlineTableClient(accounts.session.token);return client.history(options);});
handle('online-table-history-detail',async id=>{const client=await buyerSettings.onlineTableClient(accounts.session.token);return client.historyDetail(id);});
handle('online-table-delete',async({rowId,version})=>{
  const answer=await dialog.showMessageBox(windowRef,{type:'warning',buttons:['取消','删除此行'],defaultId:0,cancelId:0,message:'确定删除此商品行？',detail:'删除会记录操作人和修改前内容。管理员可在修改记录中恢复。已启动的自动任务和已创建的互拓商品需要在任务中另行处理。'});
  if(answer.response!==1)return {canceled:true};
  const client=await buyerSettings.onlineTableClient(accounts.session.token);return client.deleteRow(rowId,version);
});
handle('online-table-rollback',async historyId=>{
  if(!accounts.session.user.isAdmin)throw Object.assign(new Error('只有 TDL 管理员可以回档在线选品表'),{status:403});
  const client=await buyerSettings.onlineTableClient(accounts.session.token),plan=await client.previewRollback(historyId);
  const answer=await dialog.showMessageBox(windowRef,{type:'warning',buttons:['取消','确认恢复'],defaultId:0,cancelId:0,message:`恢复记录 #${historyId} 操作前的表格内容？`,detail:`${plan.entry.summary}\n恢复后共 ${plan.rowCount} 行：找回 ${plan.added} 行，检查/恢复 ${plan.updated} 行内容，移出 ${plan.removed} 行。\n${plan.protectedRows} 行的任务绑定、来源和确认状态会保留当前值。自动处理进度和互拓编码不会回退；此操作不撤销互拓商品。未领取的恢复行将重置为待确认，需要人工重新提交。\n恢复前状态也会保存，可再次回档。如果其他人同时修改，系统会要求重新预览。`});
  if(answer.response!==1)return {canceled:true};
  const result=await client.rollback(historyId,plan.revision);await refreshOnlineTable();return result;
});
handle('buyer-erp-refresh',async()=>{if(!authenticated())throw new Error('请先登录 TDL 账号');const result=await buyerSettings.syncManaged(accounts.session.token);buyerSettings.client=null;buyerSettings.catalogCache=null;if(!result.configured)await buyerEngine.pause();return result;});
handle('buyer-auto-start',ids=>{if(!models?.config())throw new Error('请先添加并选择视觉模型');if(!buyerSettings.configured())throw new Error(buyerSettings.managedError||'请先填写当前买手的互拓账号配置');return buyerEngine.start(ids);});
handle('buyer-task-comparison-preview',async(id,indexes)=>{const task=buyerWorkflow.task(id);if(!task)throw new Error('买手任务不存在');return buyerTaskComparisonPreview({workflow:buyerWorkflow,bridge,task,indexes,downloadCandidate,downloadImagePreview});});
handle('buyer-load-supplier-gallery',async(id,index,retry)=>{const task=buyerWorkflow.task(id);if(!task)throw new Error('买手任务不存在');return queueBuyerCandidateGallery({workflow:buyerWorkflow,bridge,task,index,retry:retry===true});});
handle('buyer-supplier-gallery-status',(id,index)=>{const task=buyerWorkflow.task(id),candidate=task?.automation?.searchCandidates?.[index];if(!candidate)throw new Error('供应商候选不存在');const gallery=candidateGallery(task,index,candidate,bridge);return{state:gallery.state,error:gallery.error||'',total:gallery.total};});
handle('buyer-cancel-supplier-gallery',(id,index)=>{const task=buyerWorkflow.task(id),candidate=task?.automation?.searchCandidates?.[index];if(!candidate)throw new Error('供应商候选不存在');const gallery=candidateGallery(task,index,candidate,bridge),commandId=task.automation.checkpoints?.[gallery.slot]?.commandId;if(gallery.state==='waiting'&&commandId)return bridge.failBuyerBrowserCommand(commandId,'等待浏览器读取商品图集超时，已取消该请求');return false;});
handle('buyer-open-platform',async platform=>{const urls={wsy:'https://www.wsy.com/',zwd:'https://stu.17zwd.com/',qcc:'https://www.17qcc.com/',e3hui:'https://www.e3hui.cn/'};const url=urls[String(platform||'')];if(!url)throw new Error('供应平台无效');await shell.openExternal(url);return{platform,url};});
handle('buyer-auto-pause',()=>buyerEngine.pause());
handle('buyer-auto-resume',()=>buyerEngine.resume());
handle('buyer-auto-retry',id=>buyerEngine.retry(id));
handle('buyer-auto-supplier',(id,index,options)=>buyerEngine.resolveSupplier(id,index,options));
handle('buyer-auto-supplier-reject',(id,index)=>buyerEngine.rejectSupplierCandidate(id,index));
handle('buyer-auto-supplier-restore',(id,index)=>buyerEngine.restoreSupplierCandidate(id,index));
handle('buyer-auto-facts',async(id,input)=>{
  const task=buyerWorkflow.task(id);if(!task?.automation||task.automation.state!=='attention'||!task.automation.supplierDetails)throw new Error('当前任务不处于可补充供货资料状态');
  const {manualSupplierFacts}=require('./buyer-evidence');const facts=manualSupplierFacts(input,task.automation.facts,task.automation.supplierDetails);
  if(facts.missing.length){await buyerWorkflow.patchAutomation(id,{facts,missing:facts.missing,error:facts.missing.join('；')},'已保存人工补充供货资料，仍有特殊类别证明待补');return{continued:false};}
  await buyerWorkflow.patchTask(id,{articleNo:facts.articleNo});await buyerWorkflow.patchAutomation(id,{facts,step:'marketplace',state:'queued',enabled:true,tags:[],error:'',missing:[]},'例外供货资料已补齐，继续自动流程');await buyerEngine.resume();return{continued:true};
});
handle('buyer-task-detail',id=>{const task=buyerWorkflow.task(id);if(!task)throw new Error('买手任务不存在');const {imageFile,...safe}=structuredClone(task);return safe;});
handle('buyer-task-locate',async id=>{const task=buyerWorkflow.task(id);if(!task?.onlineTableRowId)throw new Error('该任务没有在线表格关联');const binding=await resolveOnlineTask({task,settings:buyerSettings,authToken:accounts.session.token,workflow:buyerWorkflow});await buyerSettings.save({onlineTableId:binding.tableId});await refreshOnlineTable();return{rowId:binding.row.id,offset:binding.offset};});
handle('buyer-task-delete',async id=>{
  const task=buyerWorkflow.assertDeletable(id);
  const assertIdle=()=>{if(buyerEngine.busy.has(id)||bridge.snapshot().jobs.some(job=>(job.buyerTaskId===id||task.queryId&&job.queryId===task.queryId)&&['queued','processing'].includes(job.status)))throw new Error('关联的模型任务仍在执行，请等待完成后再删除');};
  assertIdle();
  const answer=await dialog.showMessageBox(windowRef,{type:'warning',buttons:['取消','删除本机任务'],defaultId:0,cancelId:0,message:'删除这条本机买手任务？',detail:`任务 ID：${task.id}\n商品：${task.sourceTitle||task.articleNo||task.sourceUrl}\n将删除本机任务和主图、停止该任务的浏览器命令。在线表格、任务 ID 和互拓商品回执保留，不会自动重新提交。独立的识别记录与商品资料文件夹保留。`});
  if(answer.response!==1)return{canceled:true};
  assertIdle();buyerWorkflow.assertDeletable(id);
  if(task.onlineTableRowId&&task.automation?.state!=='completed'){
    // Persist the stop before removing the local record; a remote failure leaves a recoverable local task.
    try{
      const binding=await resolveOnlineTask({task,settings:buyerSettings,authToken:accounts.session.token,workflow:buyerWorkflow});
      await binding.client.updateTask(task.onlineTableRowId,id,{automationState:'stopped',automationStep:task.automation?.step||'',automationError:'本机任务已删除；保留原任务 ID 与互拓回执'},binding.row.version);
    }catch(error){if(error.tag!=='表格任务关联失效')throw error;}
  }
  await bridge.cancelBuyerTaskCommands(id);
  return buyerWorkflow.deleteTask(id);
});
handle('buyer-export-rows',async()=>{
  const result=await dialog.showSaveDialog(windowRef,{title:'导出运营表回填结果',defaultPath:path.join(app.getPath('desktop'),'买手处理结果.xlsx'),filters:[{name:'Excel工作簿',extensions:['xlsx']},{name:'CSV表格',extensions:['csv']}]});if(result.canceled||!result.filePath)return null;
  const cell=value=>'"'+String(value??'').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';
  const rows=buyerWorkflow.state.tasks.filter(task=>task.origin).map(task=>({taskId:task.id,onlineTableId:task.onlineTableId||'',onlineTableRowId:task.onlineTableRowId||'',selectDate:task.origin.selectDate,tableId:task.origin.tableId,supplierName:task.automation?.facts?.supplierName||task.origin.supplierName||task.supplierName,image:task.automation?.source?.images?.[0]||'',sourceUrl:task.sourceUrl,externalCode:task.externalCode||task.origin.externalCode,articleNo:task.articleNo,selectOperator:task.origin.selectOperator,buyerOperator:task.origin.buyerOperator,note:task.automation?.error||task.origin.note,automationState:task.automation?.state,erpProductNo:task.automation?.result?.productNo,productFolder:task.productFolder,updatedAt:task.updatedAt,...task.origin.tableFields}));
  if(path.extname(result.filePath).toLowerCase()==='.xlsx')await fs.writeFile(result.filePath,exportBuyerXlsx(rows));else{const headers=['选品日期','表格ID','图片','平台链接','供应商','店铺名','近7天销量','同行销售价','同行发货地','货品成本','发货仓','商品编码','互拓编码','选品操作人','买手操作人','备注','处理状态','商品文件夹','更新时间','任务ID','在线表ID','在线行ID'];const values=[headers,...rows.map(row=>[row.selectDate,row.tableId,row.image,row.sourceUrl,row.supplierName,row.shopName,row.sales7d,row.peerPrice,row.peerLocation,row.goodsCost,row.warehouse,row.externalCode||row.articleNo,row.erpProductNo,row.selectOperator,row.buyerOperator,row.note,row.automationState,row.productFolder,row.updatedAt,row.taskId,row.onlineTableId,row.onlineTableRowId])];await fs.writeFile(result.filePath,'\uFEFF'+values.map(row=>row.map(cell).join(',')).join('\r\n'),'utf8');}return result.filePath;
});
async function normalizeBuyerImage(dataUrl) {
  if (!buyerImageData(dataUrl)) throw new Error('请选择有效的 JPG、PNG 或 WebP 商品图');
  const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
  if (!buffer.length || buffer.length > 10 * 1024 * 1024) throw new Error('商品图片不能超过10MB');
  const normalized = await sharp(buffer, { limitInputPixels: 50000000 }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
  const metadata = await sharp(normalized).metadata();
  if (!metadata.width || !metadata.height || metadata.width < 100 || metadata.height < 100) throw new Error('商品图片宽高都至少需要100像素');
  return normalized;
}
handle('buyer-create-task', async input => {
  const image = input.imageData ? await normalizeBuyerImage(input.imageData) : null;
  const task = await buyerWorkflow.create(input, image);
  delete input.imageData;
  return task;
});
handle('buyer-attach-image', async (taskId, dataUrl) => {
  const task=buyerWorkflow.task(taskId);if(!task)throw new Error('买手任务不存在');
  const pending=bridge.snapshot().browserCommands.some(command=>command.buyerTaskId===taskId&&['queued','claimed'].includes(command.status));
  const processing=bridge.snapshot().jobs.some(job=>(job.buyerTaskId===taskId||task.queryId&&job.queryId===task.queryId)&&['queued','processing'].includes(job.status));
  if(pending||processing)throw new Error('商品正在搜索或识别，请等待当前任务完成后再替换图片');
  return buyerWorkflow.attachImage(taskId,await normalizeBuyerImage(dataUrl));
});
handle('buyer-create-from-douyin', async index => {
  const item = douyin.snapshot().items[Number(index)];
  if (!item?.firstImage || !item.folder) throw new Error('请先下载该抖音商品主图');
  const root = await fs.realpath(douyin.snapshot().outdir), folder = await fs.realpath(item.folder);
  const rel = path.relative(root, folder); if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('抖音图片目录无效');
  const source=await fs.realpath(path.join(folder,`1.${item.quality}`));
  if(!source.startsWith(folder+path.sep))throw new Error('抖音首图路径无效');
  const image = await normalizeBuyerImage(`data:image/${item.quality === 'png' ? 'png' : 'jpeg'};base64,${(await fs.readFile(source)).toString('base64')}`);
  return buyerWorkflow.create({ sourceType:'douyin', sourceUrl:item.url, sourceTitle:item.title || '抖音商品' }, image);
});
handle('buyer-search-suppliers', async taskId => {
  const task = buyerWorkflow.task(taskId); if (!task) throw new Error('买手任务不存在');
  const image = await buyerWorkflow.image(taskId);
  const ready = await sharp(image,{limitInputPixels:50000000}).rotate().resize({width:1200,height:1200,fit:'inside',withoutEnlargement:true}).jpeg({quality:90}).toBuffer();
  const command = await bridge.enqueueProductSearch({buyerTaskId:task.id,imageData:`data:image/jpeg;base64,${ready.toString('base64')}`,queryName:task.sourceTitle || task.articleNo || '买手商品',sourceUrl:task.sourceUrl,sourceType:task.sourceType});
  return buyerWorkflow.queueSearch(taskId,command.id);
});
handle('buyer-taobao-link', (taskId,input) => buyerWorkflow.setMarketplaceLink(taskId,input));
handle('buyer-taobao-search', async taskId => {
  const task=buyerWorkflow.task(taskId);if(!task)throw new Error('买手任务不存在');
  const pending=bridge.snapshot().browserCommands.find(command=>command.kind==='taobao-image-search'&&command.buyerTaskId===taskId&&['queued','claimed'].includes(command.status));
  if(pending)return pending;
  if(bridge.snapshot().jobs.some(job=>job.buyerTaskId===taskId&&['queued','processing'].includes(job.status)))throw new Error('淘宝候选正在识别，请等待完成');
  const image=await buyerWorkflow.image(taskId);
  const searchImage=await sharp(image,{limitInputPixels:50000000}).rotate().resize({width:300,height:300,fit:'inside',withoutEnlargement:true}).jpeg({quality:85}).toBuffer();
  const command=await bridge.enqueueTaobaoSearch({buyerTaskId:taskId,imageData:`data:image/jpeg;base64,${searchImage.toString('base64')}`,queryName:task.sourceTitle||task.articleNo||'买手商品',sourceUrl:task.sourceUrl,sourceType:task.sourceType});
  await buyerWorkflow.queueTaobaoSearch(taskId,command.id);return command;
});
handle('buyer-taobao-resume', () => bridge.resumeTaobaoSearch());
handle('buyer-taobao-pause', () => bridge.pauseTaobaoSearch());
handle('buyer-taobao-compare', async taskId => {
  const task=buyerWorkflow.task(taskId);if(!task)throw new Error('买手任务不存在');
  if(!task.marketplaceCandidates?.length)throw new Error('请先完成淘宝以图搜同款');
  const existing=bridge.snapshot().jobs.find(job=>job.id===task.marketplaceSearch?.jobId);
  if(existing)return existing;
  const query=`data:image/jpeg;base64,${(await buyerWorkflow.image(taskId)).toString('base64')}`;
  await validateQuery(query);
  const job=await bridge.enqueueTaobaoComparison({buyerTaskId:taskId,queryId:task.marketplaceQueryId,query,queryName:(task.sourceTitle||task.articleNo||'买手商品')+' · 淘宝同款',items:task.marketplaceCandidates});
  await buyerWorkflow.setMarketplaceJob(taskId,job.id,'scoring');return job;
});
handle('buyer-taobao-confirm', async (taskId,jobId,index) => {
  const task=buyerWorkflow.task(taskId),job=bridge.snapshot().jobs.find(entry=>entry.id===jobId),item=job?.items[index];
  if(!task||!job||job.buyerTaskId!==taskId||task.marketplaceSearch?.jobId!==jobId||item?.platform!=='taobao')throw new Error('淘宝候选不属于该买手任务');
  if(review.decision(item)?.verdict!=='likely_same')throw new Error('请先核对模型分数并人工确认该候选为同款');
  const source=task.marketplaceCandidates?.find(entry=>new URL(entry.detailUrl).searchParams.get('id')===new URL(item.detailUrl).searchParams.get('id'));
  if(!source)throw new Error('原始淘宝搜索证据已变化，请重新核对');
  return buyerWorkflow.setMarketplaceLink(taskId,{url:item.detailUrl,title:item.title,salesText:source.salesText,confirmedSame:true,jobId,candidateIndex:index});
});
handle('buyer-assemble-source', async (taskId, jobId, candidateIndex) => {
  const task=buyerWorkflow.task(taskId); if(!task?.queryId) throw new Error('请先完成四平台搜货');
  const candidate=bridge.buyerCandidate(jobId,Number(candidateIndex));
  if(candidate.queryId!==task.queryId)throw new Error('该桌面候选不属于当前买手任务');
  const compiled=buildBuyerSource(candidate,task.marketplaceCandidate);
  return buyerWorkflow.setSupplierCandidate(taskId,candidateIndex,compiled);
});
handle('retry-job', (id, all) => bridge.retry(id, all === true));
handle('delete-jobs', ids => bridge.deleteJobs(ids));
handle('candidate-image', (id, index) => bridge.candidateImage(id, index));
handle('query-image', id => bridge.queryImage(id));
handle('review-mode', (id, mode) => bridge.setReviewMode(id, mode));
handle('review-item', (id, index, input, signature) => bridge.reviewItem(id, index, input, signature));
handle('buyer-confirm-comparison-candidate',async(jobId,index)=>{
  const job=bridge.snapshot().jobs.find(row=>row.id===jobId),task=job?.buyerTaskId&&buyerWorkflow.task(job.buyerTaskId),item=job?.items?.[index];
  if(!job?.buyerTaskId||!String(job.queryName||'').includes('供应商同款')||!task?.automation||task.automation.checkpoints?.supplierComparison?.jobId!==jobId||!item)throw new Error('该比对结果没有关联可继续的买手供应商任务');
  const decision=review.decision(item);if(decision?.verdict!=='likely_same')throw new Error('请先在人工审核中确认该商品为疑似同款');
  const candidateIndex=(task.automation.searchCandidates||[]).findIndex(candidate=>candidate.platform===item.platform&&candidate.detailUrl===item.detailUrl);
  if(candidateIndex<0)throw new Error('该商品候选已变化，请重新打开买手任务核对');
  if(task.automation.step==='supplier_details'&&task.automation.supplierSelection?.detailUrl===item.detailUrl)return{continued:true,alreadyContinued:true,step:task.automation.step};
  if(task.automation.step!=='supplier_compare'||!['attention','waiting','running'].includes(task.automation.state))throw new Error('该买手任务已进入其他步骤，请在买手任务详情中继续');
  await buyerEngine.resolveSupplier(task.id,candidateIndex,{manualConfirmed:true});
  return{continued:true,alreadyContinued:false,step:'supplier_details',taskId:task.id};
});
// Checks and downloads return immediately; their progress is read via snapshot.
// Long network transfers must never hold the account/job mutation queue.
handle('check-update', () => { void updates.check(); return updates.snapshot(); });
handle('download-update', () => { void updates.download().catch(() => {}); return updates.snapshot(); });
handle('install-update', () => updates.install());
handle('prepare-extension', () => extension.prepare());
handle('open-extension', async () => {
  const info = extension.snapshot();
  if (!info.prepared) throw new Error('请先准备浏览器插件');
  const error = await shell.openPath(info.path);
  if (error) throw new Error('无法打开插件文件夹，可以复制页面中的目录路径后打开');
});
handle('open-usage-page', () => shell.openExternal('https://wsfile.cn/maishou/admin'));
handle('douyin-start', input => douyin.start(input));
handle('douyin-stop', () => douyin.stop());
async function enqueueDouyinSearch(item) {
  if (!item || !item.firstImage || !item.folder) throw new Error('请先完成该抖音商品首图下载');
  const root = await fs.realpath(douyin.snapshot().outdir), folder = await fs.realpath(item.folder);
  const relative = path.relative(root, folder);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('抖音图片目录无效');
  const source = await fs.realpath(path.join(folder, `1.${item.quality}`));
  if (!source.startsWith(folder + path.sep)) throw new Error('抖音首图路径无效');
  const bytes = await sharp(source, { limitInputPixels: 50000000 }).rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
  return bridge.enqueueDouyinSearch({ imageData: `data:image/jpeg;base64,${bytes.toString('base64')}`, queryName: item.title || '抖音商品', sourceUrl: item.url });
}
handle('queue-douyin-search', async index => enqueueDouyinSearch(douyin.snapshot().items[Number(index)]));
handle('douyin-select-folder', async () => {
  const result = await dialog.showOpenDialog(windowRef, { title: '选择抖音主图保存位置', properties: ['openDirectory', 'createDirectory'] });
  const folder = result.canceled ? '' : result.filePaths[0] || '';
  if (folder) douyin.setDirectory(folder);
  return folder;
});
handle('douyin-open-folder', async () => {
  const folder = douyin.snapshot().outdir;
  const error = await shell.openPath(folder);
  if (error) throw new Error('无法打开保存位置，请先选择已有文件夹或完成下载');
});
handle('collect-product-details', (jobId, itemIndex) => bridge.enqueueDetails(jobId, itemIndex));
handle('open-product-detail', async url => {
  const parsed = new URL(String(url || ''));
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !['wsy.com', '17zwd.com', '17qcc.com', 'e3hui.com', 'e3hui.cn', 'taobao.com', 'tmall.com','douyin.com','jinritemai.com'].some(domain => parsed.hostname === domain || parsed.hostname.endsWith('.' + domain))) throw new Error('商品详情链接无效');
  await shell.openExternal(parsed.href);
});

app.whenReady().then(async () => {
  douyin = new DouyinDownloads({ defaultDir: path.join(app.getPath('desktop'), '抖音主图'), parse: createBrowserParser(),
    onItem: item => item.firstImage ? enqueueDouyinSearch(item) : null });
  extension = new Extension({ sourceDir: app.isPackaged ? path.join(process.resourcesPath, 'browser-extension') : path.join(__dirname, '..'),
    dataDir: app.getPath('userData'), version: app.isPackaged ? displayVersion(app.getVersion()) : require('../manifest.json').version_name });
  await extension.load();
  updates = createUpdates({ currentVersion: app.isPackaged ? app.getVersion() : require('../manifest.json').version_name,
    enabled: app.isPackaged, busy: () => !!douyin?.snapshot().running || !!buyerEngine?.snapshot().running || bridge?.snapshot().jobs.some(job => ['queued', 'processing'].includes(job.status)) || bridge?.snapshot().browserCommands?.some(command => command.status === 'claimed') || false,
    beforeInstall: async () => {
      installingUpdate = true;
      try { await buyerEngine?.pause();await buyerEngine?.close();await bridge?.close(); }
      catch (error) { installingUpdate = false; throw error; }
    } });
  accounts = new Accounts({ dataDir: app.getPath('userData'), storage: encryptedStorage(safeStorage) });
  if (await accounts.restore()) {
    try { await activateProfile(); } catch { await deactivate('本地配置无法读取，请重新登录；如仍失败请检查 Windows 安全存储'); }
  }
  createWindow();
  authTimer = setInterval(() => { void serial(async () => {
    if (!accessAllowed) return;
    try { await accounts.validate(); lastValidated = Date.now(); bridge?.resume(); }
    catch (error) { if (error.unauthorized) await deactivate(error.message); }
  }); }, 60000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(error => {
  console.error(`桌面服务启动失败：${String(error?.message || error)}`);
  app.quit();
});

let quitting = false;
app.on('before-quit', event => {
  clearInterval(authTimer);
  if (quitting || !bridge && !douyin?.snapshot().running) return;
  event.preventDefault(); quitting = true; accessAllowed = false; profileController?.abort();
  void Promise.allSettled([buyerEngine?.close(),bridge?.close(), douyin?.stop()]).finally(() => app.quit());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
