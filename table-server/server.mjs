import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 8 * 1024 * 1024;
const MAX_ROWS_PER_REQUEST = 1000;
const TABLE_ID = /^[\da-f-]{36}$/i;
const sourceTypes = new Set(['douyin', 'taobao', 'wsy', 'zwd', 'qcc', 'e3hui']);
const sourceDomains = { douyin: ['douyin.com', 'jinritemai.com'], taobao: ['taobao.com', 'tmall.com'], wsy: ['wsy.com'], zwd: ['17zwd.com'], qcc: ['17qcc.com'], e3hui: ['e3hui.com', 'e3hui.cn'] };
const humanStates = new Set(['pending', 'approved', 'rejected']);
const businessFields = ['selectDate','tableId','supplierName','externalCode','selectOperator','buyerOperator','shopName','sales7d','peerPrice','peerLocation','goodsCost','warehouse'];
const rowFields = input => Object.fromEntries(businessFields.map(key=>[key,clean(input?.[key],200)]));
const storedFields = input => rowFields(JSON.parse(input.fields_json || '{}'));

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function fail(res, status, message, extra = {}) { json(res, status, { ok: false, error: message, ...extra }); }

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('请求体不能超过8MB'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('请求 JSON 无效'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function clean(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function validUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url.href : '';
  } catch { return ''; }
}

function normalizeRow(input = {}) {
  const sourceUrl = clean(input.sourceUrl, 2000);
  let host = ''; try { host = new URL(sourceUrl).hostname; } catch {}
  const inferredType = sourceUrl ? [...sourceTypes].find(type => (sourceDomains[type] || []).some(domain => host === domain || host.endsWith(`.${domain}`))) || '' : '';
  const sourceType = inferredType || (sourceTypes.has(input.sourceType) ? input.sourceType : '');
  const humanStatus = clean(input.humanStatus, 20) || 'pending';
  if (!humanStates.has(humanStatus)) throw new Error('人工确认状态无效');
  return {
    ...rowFields(input),
    articleNo: clean(input.articleNo, 120), sourceType, sourceUrl,
    title: clean(input.title, 300), note: clean(input.note, 2000), humanStatus,
  };
}
function processableRow(value) {
  const normalized = normalizeRow(value);
  if (!validUrl(normalized.sourceUrl) || !normalized.sourceType) return false;
  const host = new URL(normalized.sourceUrl).hostname;
  return sourceDomains[normalized.sourceType].some(domain => host === domain || host.endsWith(`.${domain}`));
}

function retryableSupplierRow(value) {
  if (value.automation_state !== 'attention' || value.human_status !== 'approved' || !value.task_id || value.erp_product_no) return false;
  const step = String(value.automation_step || '');
  if (step) return ['supplier_search', 'supplier_compare'].includes(step);
  // Older desktop builds did not sync the workflow step. Allow only the two
  // supplier-stage exception messages; never infer retry safety from attention alone.
  return /供应商同款|候选未识别|供应商识别未完成|供应商搜索不完整/.test(String(value.automation_error || ''));
}

function createSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS tables (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rows (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      article_no TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL,
      source_url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      human_status TEXT NOT NULL DEFAULT 'pending',
      task_id TEXT NOT NULL DEFAULT '',
      automation_state TEXT NOT NULL DEFAULT '',
      automation_step TEXT NOT NULL DEFAULT '',
      automation_error TEXT NOT NULL DEFAULT '',
      erp_product_no TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(table_id, id)
    );
    CREATE INDEX IF NOT EXISTS rows_table_position ON rows(table_id, position, id);
    CREATE INDEX IF NOT EXISTS rows_table_status ON rows(table_id, human_status, automation_state);
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      table_id TEXT NOT NULL,
      row_id TEXT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_table_seq ON events(table_id, seq);
    CREATE TABLE IF NOT EXISTS table_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS table_history_table_created ON table_history(table_id, created_at DESC, id DESC);
  `);
  // Additive migration: retain existing tables, rows and task receipts.
  for (const [name, column, definition] of [
    ['tables', 'revision', 'INTEGER NOT NULL DEFAULT 0'],
    ['rows', 'deleted', 'INTEGER NOT NULL DEFAULT 0'],
    ['rows', 'automation_step', "TEXT NOT NULL DEFAULT ''"],
    ['rows', 'fields_json', "TEXT NOT NULL DEFAULT '{}'"],
    ['table_history', 'row_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['table_history', 'changes_json', "TEXT NOT NULL DEFAULT '[]'"],
  ]) if (!db.prepare(`PRAGMA table_info(${name})`).all().some(item => item.name === column)) db.exec(`ALTER TABLE ${name} ADD COLUMN ${column} ${definition}`);
}

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function createOnlineTableServer({ port = Number(process.env.PORT || 43900), host = process.env.HOST || '127.0.0.1', dataDir = path.join(here, 'data'), authUrl = process.env.TABLE_AUTH_URL || '', fetchImpl = (...args) => fetch(...args), logger = console } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'online-tables.sqlite'));
  createSchema(db);
  // Existing table records and rows are retained, but shared access no longer uses per-table tokens.
  db.exec("UPDATE tables SET token_hash = '' WHERE token_hash <> ''");
  const streams = new Map();

  function table(id) { return db.prepare('SELECT * FROM tables WHERE id = ?').get(id); }
  function row(id) { return db.prepare('SELECT * FROM rows WHERE id = ?').get(id); }
  function publicRow(value) {
    if (!value) return null;
    return {
      ...storedFields(value),
      id: value.id, position: value.position, articleNo: value.article_no, sourceType: value.source_type,
      sourceUrl: value.source_url, title: value.title, note: value.note, humanStatus: value.human_status,
      taskId: value.task_id, automationState: value.automation_state, automationStep: value.automation_step || '', automationError: value.automation_error,
      erpProductNo: value.erp_product_no, version: value.version, updatedBy: value.updated_by,
      createdAt: value.created_at, updatedAt: value.updated_at,
    };
  }
  function publicTable(value) {
    if (!value) return null;
    const counts = db.prepare("SELECT human_status AS status, COUNT(*) AS count FROM rows WHERE table_id = ? AND deleted=0 AND trim(source_url) <> '' GROUP BY human_status").all(value.id);
    const rowTotal = db.prepare('SELECT COUNT(*) AS count FROM rows WHERE table_id = ? AND deleted=0').get(value.id).count;
    const rowCount = db.prepare("SELECT COUNT(*) AS count FROM rows WHERE table_id = ? AND deleted=0 AND trim(source_url) <> ''").get(value.id).count;
    const nextPosition = db.prepare('SELECT COALESCE(MAX(position),0)+1 AS n FROM rows WHERE table_id=?').get(value.id).n;
    return { id: value.id, name: value.name, revision: value.revision, rowCount, rowTotal, nextPosition, counts: Object.fromEntries(counts.map(item => [item.status, item.count])), createdAt: value.created_at, updatedAt: value.updated_at };
  }
  function userFromRequest(req) { return clean(req.headers['x-table-user'], 160) || 'local'; }
  async function authorize(req, target, { create = false } = {}) {
    let isAdmin = !authUrl;
    if (authUrl) {
      const bearer = String(req.headers.authorization || '');
      if (!/^Bearer\s+\S+$/.test(bearer)) throw Object.assign(new Error('需要登录凭据'), { status: 401 });
      let response;
      try { response = await fetchImpl(authUrl, { headers: { Authorization: bearer }, signal: AbortSignal.timeout(8000) }); }
      catch { throw Object.assign(new Error('账号认证服务暂不可用'), { status: 503 }); }
      if (response.status===401 || response.status===403) throw Object.assign(new Error('登录凭据已失效，请重新登录 TDL'), { status: 401 });
      if (!response.ok) throw Object.assign(new Error('账号认证服务暂不可用，请稍后重试'), { status: 503 });
      const body = await response.json().catch(() => null);
      if (!body?.user?.id) throw Object.assign(new Error('账号认证响应无效'), { status: 401 });
      req.tableUser = String(body.user.id);
      req.tableActor = clean(body.user.displayName || body.user.username, 100) + ` (${req.tableUser})`;
      isAdmin = body.user.isAdmin === true || String(body.user.role || '').toUpperCase() === 'ADMIN';
    }
    const user = req.tableUser || userFromRequest(req);
    req.tableAdmin = isAdmin;
    if (create && !isAdmin) throw Object.assign(new Error('只有 TDL 管理员可以创建选品表或恢复历史'), { status: 403 });
    return user;
  }
  function emit(tableId, rowId, kind, payload) {
    const createdAt = new Date().toISOString();
    const result = db.prepare('INSERT INTO events(table_id,row_id,kind,payload,created_at) VALUES(?,?,?,?,?)').run(tableId, rowId || null, kind, JSON.stringify(payload), createdAt);
    const event = { seq: Number(result.lastInsertRowid), tableId, rowId: rowId || '', kind, payload, createdAt };
    if (pendingEvents) pendingEvents.push(event); else broadcast(event);
    return event;
  }
  function broadcast(event) { for (const stream of streams.get(event.tableId) || []) { try { stream.write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`); } catch {} } }
  let pendingEvents = null;
  function snapshotRows(tableId) { return db.prepare('SELECT * FROM rows WHERE table_id = ? AND deleted=0 ORDER BY position ASC,id ASC').all(tableId); }
  function mutate(tableId, actor, action, summary, fn) {
    db.exec('BEGIN IMMEDIATE'); pendingEvents = [];
    try {
      const before = snapshotRows(tableId);
      const auditRows = () => db.prepare('SELECT * FROM rows WHERE table_id=?').all(tableId).map(item=>[item.id,{...publicRow(item),deleted:!!item.deleted}]);
      const old = new Map(auditRows()), result = fn(), current = new Map(auditRows());
      const changes = [...new Set([...old.keys(), ...current.keys()])].flatMap(id => JSON.stringify(old.get(id)) === JSON.stringify(current.get(id)) ? [] : [{ rowId: id, before: old.get(id) || null, after: current.get(id) || null }]);
      recordHistory(tableId, actor, action, summary, before, changes);
      db.prepare('UPDATE tables SET updated_at=?,revision=revision+1 WHERE id=?').run(new Date().toISOString(), tableId);
      db.exec('COMMIT');
      const committed = pendingEvents; pendingEvents = null; committed.forEach(broadcast); return result;
    } catch (error) { db.exec('ROLLBACK'); pendingEvents = null; throw error; }
  }
  function recordHistory(tableId, actor, action, summary, before, changes) {
    const now = new Date().toISOString();
    // Full baseline every 50 operations; intervening records keep row deltas.
    // This avoids duplicating thousands of rows for each automation progress update.
    const checkpoint = db.prepare("SELECT id FROM table_history WHERE table_id=? AND snapshot_json <> 'null' ORDER BY id DESC LIMIT 1").get(tableId);
    const last = db.prepare('SELECT MAX(id) AS id FROM table_history WHERE table_id=?').get(tableId);
    const snapshot = !checkpoint || Number(last.id)-Number(checkpoint.id)>=49 ? JSON.stringify(before) : 'null';
    const result = db.prepare('INSERT INTO table_history(table_id,action,actor,summary,snapshot_json,created_at,row_count,changes_json) VALUES(?,?,?,?,?,?,?,?)').run(tableId, clean(action, 40), clean(actor, 160), clean(summary, 500), snapshot, now, before.length, JSON.stringify(changes));
    return Number(result.lastInsertRowid);
  }
  function publicHistory(value) {
    return { id: Number(value.id), action: value.action, actor: value.actor, summary: value.summary, rowCount: value.row_count, createdAt: value.created_at };
  }
  function importRows(tableId, inputRows, user) {
    if (!Array.isArray(inputRows) || !inputRows.length || inputRows.length > MAX_ROWS_PER_REQUEST) throw new Error(`每次最多导入${MAX_ROWS_PER_REQUEST}行`);
    const now = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO rows(id,table_id,position,article_no,source_type,source_url,title,note,human_status,updated_by,created_at,updated_at,fields_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const inserted=[];
    const writeRows = rows => {
      const last = db.prepare('SELECT COALESCE(MAX(position),0) AS position FROM rows WHERE table_id = ?').get(tableId).position;
      rows.forEach((input, index) => {
        const normalized = normalizeRow(input);
        if (normalized.humanStatus==='approved' && !processableRow(normalized)) throw new Error('确认提交前需要填写支持的 HTTPS 商品链接');
        const id = /^[\da-f-]{36}$/i.test(String(input.id || '')) ? String(input.id) : crypto.randomUUID();
        if(!normalized.tableId)normalized.tableId=String(last+index+1).padStart(2,'0');
        insert.run(id, tableId, last + index + 1, normalized.articleNo, normalized.sourceType, normalized.sourceUrl, normalized.title, normalized.note, normalized.humanStatus, user, now, now,JSON.stringify(rowFields(normalized)));
        const saved=publicRow(row(id));inserted.push(saved);emit(tableId, id, 'row-upserted', saved);
      });
    };
    mutate(tableId, user, 'import', `新增/导入 ${inputRows.length} 行`, () => writeRows(inputRows));
    return { imported: inputRows.length, rows:inserted, table: publicTable(table(tableId)) };
  }
  function updateRow(tableId, rowId, patch, ifVersion, user) {
    const current = row(rowId);
    if (!current || current.table_id !== tableId || (current.deleted && !current.task_id)) throw Object.assign(new Error('表格行不存在'), { status: 404 });
    if(current.deleted && Object.keys(patch||{}).some(key=>!['automationState','automationStep','automationError','erpProductNo'].includes(key))) throw Object.assign(new Error('商品行已删除，只能由原任务回写处理进度'),{status:409,current:publicRow(current)});
    if (!Number.isInteger(Number(ifVersion)) || Number(ifVersion) !== current.version) throw Object.assign(new Error('表格行已被其他人修改，请刷新后重试'), { status: 409, current: publicRow(current) });
    if (current.task_id && ['articleNo', 'sourceType', 'sourceUrl', 'humanStatus','selectDate','tableId'].some(key => Object.hasOwn(patch || {}, key) && patch[key] !== publicRow(current)[key])) throw Object.assign(new Error('该行已领取，不能再修改货号、来源链接、目录编号或确认状态'), { status: 409, current: publicRow(current) });
    const next = { ...storedFields(current),articleNo: current.article_no, sourceType: current.source_type, sourceUrl: current.source_url, title: current.title, note: current.note, humanStatus: current.human_status };
    for (const key of Object.keys(next)) if (Object.hasOwn(patch || {}, key)) next[key] = patch[key];
    const normalized = normalizeRow(next);
    if (!current.task_id && Object.hasOwn(patch || {}, 'sourceUrl') && normalized.sourceUrl!==current.source_url) normalized.humanStatus='pending';
    if (patch?.humanStatus==='approved' && !processableRow(normalized)) throw new Error('确认提交前需要填写支持的 HTTPS 商品链接');
    const automationState = Object.hasOwn(patch || {}, 'automationState') ? clean(patch.automationState, 40) : current.automation_state, automationStep = Object.hasOwn(patch || {}, 'automationStep') ? clean(patch.automationStep, 40) : (current.automation_step || ''), automationError = Object.hasOwn(patch || {}, 'automationError') ? clean(patch.automationError, 400) : current.automation_error, erpProductNo = Object.hasOwn(patch || {}, 'erpProductNo') ? clean(patch.erpProductNo, 200) : current.erp_product_no, now = new Date().toISOString();
    return mutate(tableId, user, 'update', `修改 ${current.article_no || current.id}`, () => {
    db.prepare('UPDATE rows SET article_no=?,source_type=?,source_url=?,title=?,note=?,human_status=?,automation_state=?,automation_step=?,automation_error=?,erp_product_no=?,version=version+1,updated_by=?,updated_at=?,fields_json=? WHERE id=? AND table_id=?').run(normalized.articleNo, normalized.sourceType, normalized.sourceUrl, normalized.title, normalized.note, normalized.humanStatus, automationState, automationStep, automationError, erpProductNo, user, now,JSON.stringify(rowFields(normalized)), rowId, tableId);
    const updated = publicRow(row(rowId)); emit(tableId, rowId, 'row-updated', updated); return updated;
    });
  }
  function historyEntry(tableId, historyId) {
    const value = db.prepare('SELECT * FROM table_history WHERE id=? AND table_id=?').get(Number(historyId), tableId);
    if (!value) throw Object.assign(new Error('历史记录不存在'), { status: 404 });
    return value;
  }
  function historyRows(tableId, historyId) {
    historyEntry(tableId, historyId);
    const checkpoint = db.prepare("SELECT * FROM table_history WHERE table_id=? AND id<=? AND snapshot_json <> 'null' ORDER BY id DESC LIMIT 1").get(tableId, Number(historyId));
    if (!checkpoint) throw new Error('历史基线不存在，无法恢复');
    const restored = new Map(JSON.parse(checkpoint.snapshot_json).map(item=>[item.id,item]));
    const columns = {articleNo:'article_no',sourceType:'source_type',sourceUrl:'source_url',humanStatus:'human_status',taskId:'task_id',automationState:'automation_state',automationStep:'automation_step',automationError:'automation_error',erpProductNo:'erp_product_no',updatedBy:'updated_by',createdAt:'created_at',updatedAt:'updated_at'};
    for (const entry of db.prepare('SELECT changes_json FROM table_history WHERE table_id=? AND id>=? AND id<? ORDER BY id').all(tableId,checkpoint.id,Number(historyId))) {
      for (const change of JSON.parse(entry.changes_json)) {
        if (!change.after || change.after.deleted) {restored.delete(change.rowId);continue;}
        const saved = {};
        for (const [key,value] of Object.entries(change.after)) saved[columns[key] || key] = value;
        saved.fields_json=JSON.stringify(rowFields(change.after));
        saved.table_id = tableId; restored.set(change.rowId,saved);
      }
    }
    return [...restored.values()].sort((a,b)=>a.position-b.position || a.id.localeCompare(b.id));
  }
  function restoredContent(saved, existing) {
    const identity=existing?.task_id?existing:saved,fields=storedFields(saved);
    if(existing?.task_id){const current=storedFields(existing);fields.selectDate=current.selectDate;fields.tableId=current.tableId;}
    return {...saved,article_no:identity.article_no,source_type:identity.source_type,source_url:identity.source_url,human_status:existing?.task_id?identity.human_status:'pending',fields_json:JSON.stringify(fields)};
  }
  function restorePlan(tableId, historyId) {
    const entry = historyEntry(tableId, historyId), saved = historyRows(tableId, historyId);
    const current = snapshotRows(tableId), active = new Map(current.map(item => [item.id, item])), savedIds = new Set(saved.map(item => item.id));
    let added = 0, updated = 0, protectedRows = 0;
    for (const item of saved) {
      const present = row(item.id);
      if (present?.task_id) protectedRows++;
      if (!active.has(item.id)) added++;
      else {const next=restoredContent(item,present);if(['article_no', 'source_type', 'source_url', 'title', 'note', 'human_status','fields_json'].some(key => next[key] !== present[key]))updated++;}
    }
    return { historyId: Number(historyId), revision: table(tableId).revision, rowCount: saved.length, added, updated, removed: current.filter(item => !savedIds.has(item.id)).length, protectedRows, entry: publicHistory(entry) };
  }
  function requireRevision(tableId, revision) {
    if (!Number.isSafeInteger(revision) || revision !== table(tableId).revision) throw Object.assign(new Error('预览后表格已有变更，请重新预览后确认'), { status: 409 });
  }
  async function route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: 'online-table', time: new Date().toISOString() });
    const tableMatch = url.pathname.match(/^\/api\/tables\/([\da-f-]{36})(?:\/([^/]+))?(?:\/([^/]+))?$/i);
    try {
      if (req.method === 'GET' && url.pathname === '/api/tables') {
        await authorize(req, null);
        const tables = db.prepare('SELECT * FROM tables ORDER BY updated_at DESC,created_at DESC').all().map(publicTable);
        return json(res, 200, { ok: true, tables });
      }
      if (req.method === 'POST' && url.pathname === '/api/tables') {
        const user = await authorize(req, null, { create: true }); const body = await parseBody(req); const name = clean(body.name, 120) || '买手选品表';
        if (db.prepare('SELECT id FROM tables LIMIT 1').get()) return fail(res, 409, '共享选品表已经由管理员创建。');
        const id = crypto.randomUUID(), now = new Date().toISOString();
        // Keep token_hash for compatibility with older SQLite files; TDL login now authorizes all table access.
        db.prepare('INSERT INTO tables(id,name,owner_user_id,token_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, name, user, '', now, now);
        return json(res, 201, { ok: true, table: publicTable(table(id)) });
      }
      if (!tableMatch) return fail(res, 404, '接口不存在');
      const target = table(tableMatch[1]); if (!target) return fail(res, 404, '在线表格不存在');
      await authorize(req, target);
      const user = req.tableActor || req.tableUser || userFromRequest(req);
      const action = tableMatch[2] || '';
      if (req.method === 'GET' && (action === 'find' || action === 'locate')) {
        if (action==='locate') {
          const rowId=clean(url.searchParams.get('rowId'),36),position=Number(url.searchParams.get('position'));
          const found=rowId ? row(rowId) : Number.isSafeInteger(position) && position>0 ? db.prepare('SELECT * FROM rows WHERE table_id=? AND position=? AND deleted=0').get(target.id,position) : null;
          if(!found || found.table_id!==target.id || found.deleted)return fail(res,404,'该行不存在或已删除');
          const offset=db.prepare('SELECT COUNT(*) AS n FROM rows WHERE table_id=? AND deleted=0 AND (position < ? OR (position=? AND id<?))').get(target.id,found.position,found.position,found.id).n;
          return json(res,200,{ok:true,row:publicRow(found),offset});
        }
        const query=clean(url.searchParams.get('search'),300);
        if(!query)return json(res,200,{ok:true,total:0,index:0,row:null});
        const searchable=['article_no','source_url','title','note','erp_product_no',...businessFields.map(key=>`COALESCE(json_extract(fields_json,'$.${key}'),'')`)];
        const predicate=searchable.map(column=>`instr(lower(${column}),lower(?))>0`).join(' OR '),args=[target.id,...searchable.map(()=>query)];
        const total=db.prepare(`SELECT COUNT(*) AS n FROM rows WHERE table_id=? AND deleted=0 AND (${predicate})`).get(...args).n;
        if(!total)return json(res,200,{ok:true,total:0,index:0,row:null});
        const requested=Number(url.searchParams.get('index'))||0,index=((Math.trunc(requested)%total)+total)%total;
        const found=db.prepare(`SELECT * FROM rows WHERE table_id=? AND deleted=0 AND (${predicate}) ORDER BY position,id LIMIT 1 OFFSET ?`).get(...args,index);
        const offset=db.prepare('SELECT COUNT(*) AS n FROM rows WHERE table_id=? AND deleted=0 AND (position < ? OR (position=? AND id<?))').get(target.id,found.position,found.position,found.id).n;
        const publicValue=publicRow(found),matchFields=['articleNo','sourceUrl','title','note','erpProductNo',...businessFields].filter(key=>String(publicValue[key]||'').toLowerCase().includes(query.toLowerCase()));
        return json(res,200,{ok:true,total,index,row:publicValue,offset,matchFields});
      }
      if (req.method === 'GET' && !action) {
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 200)));
        const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
        const status = clean(url.searchParams.get('status'), 20);
        const search = clean(url.searchParams.get('search'), 300);
        const where = ' AND deleted=0' + (status && humanStates.has(status) ? " AND human_status = ? AND source_url<>''" : '');
        const searchWhere = search ? ` AND (article_no LIKE ? ESCAPE '\\' OR source_url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' OR fields_json LIKE ? ESCAPE '\\')` : '';
        const searchValue = `%${search.replace(/[\\%_]/g, char => `\\${char}`)}%`;
        const args = status && humanStates.has(status) ? [target.id, status] : [target.id];
        if (search) args.push(...Array(5).fill(searchValue));
        args.push(limit, offset);
        const rows = db.prepare(`SELECT * FROM rows WHERE table_id = ?${where}${searchWhere} ORDER BY position ASC,id ASC LIMIT ? OFFSET ?`).all(...args).map(publicRow);
        const countArgs = status && humanStates.has(status) ? [target.id, status] : [target.id];
        if (search) countArgs.push(...Array(5).fill(searchValue));
        const matchedCount = db.prepare(`SELECT COUNT(*) AS count FROM rows WHERE table_id = ?${where}${searchWhere}`).get(...countArgs).count;
        return json(res, 200, { ok: true, table: publicTable(table(target.id)), rows, offset, limit, search, matchedCount, nextOffset: offset+rows.length<matchedCount ? offset + rows.length : null });
      }
      if (req.method === 'GET' && action === 'events') {
        const after = Math.max(0, Number(url.searchParams.get('after') || 0));
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`retry: 1500\n\n`);
        const send = () => { for (const item of db.prepare('SELECT * FROM events WHERE table_id = ? AND seq > ? ORDER BY seq ASC LIMIT 200').all(target.id, after)) res.write(`event: ${item.kind}\ndata: ${JSON.stringify({ seq: item.seq, tableId: target.id, rowId: item.row_id || '', kind: item.kind, payload: JSON.parse(item.payload), createdAt: item.created_at })}\n\n`); };
        send(); const set = streams.get(target.id) || new Set(); set.add(res); streams.set(target.id, set);
        const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000); req.on('close', () => { clearInterval(heartbeat); set.delete(res); if (!set.size) streams.delete(target.id); }); return;
      }
      if (req.method === 'GET' && action === 'history') {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
        if (/^\d+$/.test(tableMatch[3] || '')) {
          const entry = historyEntry(target.id, tableMatch[3]);
          return json(res, 200, { ok: true, entry: publicHistory(entry), changes: JSON.parse(entry.changes_json) });
        }
        const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
        const rows = db.prepare('SELECT id,action,actor,summary,row_count,created_at FROM table_history WHERE table_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(target.id, before, limit).map(publicHistory);
        return json(res, 200, { ok: true, history: rows, nextBefore: rows.length === limit ? rows.at(-1).id : null });
      }
      if (req.method === 'GET' && action === 'rollback' && /^\d+$/.test(tableMatch[3] || '')) {
        if (!req.tableAdmin) return fail(res, 403, '只有 TDL 管理员可以回档在线选品表');
        return json(res, 200, { ok: true, ...restorePlan(target.id, tableMatch[3]) });
      }
      if (req.method === 'POST' && action === 'clear') {
        if (!req.tableAdmin) return fail(res, 403, '只有 TDL 管理员可以清空在线选品表');
        const body = await parseBody(req); requireRevision(target.id, body.ifRevision);
        const now = new Date().toISOString();
        mutate(target.id, user, 'clear', '清空在线选品表', () => {
          db.prepare('UPDATE rows SET deleted=1,version=version+1,updated_by=?,updated_at=? WHERE table_id=? AND deleted=0').run(user, now, target.id);
          emit(target.id, '', 'table-cleared', { tableId: target.id, updatedAt: now });
        });
        return json(res, 200, { ok: true, table: publicTable(table(target.id)) });
      }
      if (req.method === 'POST' && action === 'rollback' && /^\d+$/.test(tableMatch[3] || '')) {
        if (!req.tableAdmin) return fail(res, 403, '只有 TDL 管理员可以回档在线选品表');
        const body = await parseBody(req); requireRevision(target.id, body.ifRevision);
        const historyId = Number(tableMatch[3]);
        const savedRows = historyRows(target.id, historyId);
        const now = new Date().toISOString();
        mutate(target.id, user, 'rollback', `恢复记录 #${historyId} 操作前的表格内容`, () => {
          // Tombstones retain task IDs and receipts even when a restored version omits a row.
          db.prepare('UPDATE rows SET deleted=1,version=version+1,updated_by=?,updated_at=? WHERE table_id=?').run(user, now, target.id);
          const restore = db.prepare('UPDATE rows SET position=?,article_no=?,source_type=?,source_url=?,title=?,note=?,human_status=?,fields_json=?,deleted=0,updated_by=?,updated_at=? WHERE id=? AND table_id=?');
          for (const saved of savedRows) {
            const existing = row(saved.id);
            if (!existing || existing.table_id !== target.id) throw new Error('历史行不存在，无法安全恢复任务绑定');
            const next=restoredContent(saved,existing);
            restore.run(saved.position, next.article_no, next.source_type, next.source_url, next.title, next.note, next.human_status,next.fields_json, user, now, saved.id, target.id);
          }
          emit(target.id, '', 'table-rollback', { tableId: target.id, historyId, rowCount: savedRows.length, updatedAt: now });
        });
        return json(res, 200, { ok: true, table: publicTable(table(target.id)), historyId });
      }
      if (req.method === 'POST' && action === 'rows') { const body = await parseBody(req); return json(res, 200, { ok: true, ...importRows(target.id, body.rows, user) }); }
      if (req.method === 'POST' && action === 'restart' && TABLE_ID.test(tableMatch[3] || '')) {
        const body=await parseBody(req),rowId=tableMatch[3],previousTaskId=String(body.previousTaskId||''),taskId=String(body.taskId||''),ifVersion=Number(body.ifVersion);
        if(!TABLE_ID.test(previousTaskId)||!TABLE_ID.test(taskId)||taskId===previousTaskId)return fail(res,400,'重启任务编号无效');
        const candidate=row(rowId);
        if(!candidate||candidate.table_id!==target.id||candidate.deleted)return fail(res,404,'商品行不存在');
        if(ifVersion!==candidate.version)return fail(res,409,'表格行已被其他人修改，请刷新后重试',{current:publicRow(candidate)});
        if(candidate.task_id!==previousTaskId)return fail(res,409,'任务已在其他设备变更，请刷新查看最新状态',{current:publicRow(candidate)});
        if(!retryableSupplierRow(candidate))return fail(res,409,'仅可在供应商搜索或比对异常时从本机重新开始',{current:publicRow(candidate)});
        const now=new Date().toISOString();
        const restarted=mutate(target.id,user,'retry',`在本机重新开始供应商任务 ${rowId}`,()=>{
          const current=row(rowId);
          if(!current||current.table_id!==target.id||current.deleted||current.version!==ifVersion||current.task_id!==previousTaskId||!retryableSupplierRow(current))throw Object.assign(new Error('任务状态已变化，请刷新共享表后重试'),{status:409,current:publicRow(current)});
          const changed=db.prepare("UPDATE rows SET task_id=?,automation_state='queued',automation_step='source',automation_error='',version=version+1,updated_by=?,updated_at=? WHERE id=? AND table_id=? AND version=? AND task_id=? AND deleted=0 AND human_status='approved'").run(taskId,user,now,rowId,target.id,ifVersion,previousTaskId);
          if(!changed.changes)throw Object.assign(new Error('任务已在其他设备变更，请刷新共享表后重试'),{status:409,current:publicRow(row(rowId))});
          const updated=publicRow(row(rowId));emit(target.id,rowId,'row-updated',updated);return updated;
        });
        return json(res,200,{ok:true,row:restarted});
      }
      if (req.method === 'POST' && action === 'claim' && TABLE_ID.test(tableMatch[3] || '')) {
        const body = await parseBody(req); const rowId = tableMatch[3]; const taskId = TABLE_ID.test(String(body.taskId || '')) ? String(body.taskId) : crypto.randomUUID(); const now = new Date().toISOString();
        const candidate=row(rowId);
        if(!candidate || candidate.table_id!==target.id || !processableRow(publicRow(candidate)))return fail(res,409,'该行未填写支持的 HTTPS 商品链接，不能领取');
        const updated = mutate(target.id, user, 'claim', `领取商品行 ${rowId}`, () => {
          const claimed = db.prepare("UPDATE rows SET task_id=?,automation_state='queued',automation_step='source',automation_error='',version=version+1,updated_by=?,updated_at=? WHERE id=? AND table_id=? AND deleted=0 AND source_url<>'' AND human_status='approved' AND task_id=''").run(taskId, user, now, rowId, target.id);
          if (!claimed.changes) throw Object.assign(new Error('该行已被领取、删除、尚未人工确认或未填写商品链接'), { status: 409 });
          const value = publicRow(row(rowId)); emit(target.id, rowId, 'row-updated', value); return value;
        });
        return json(res, 200, { ok: true, row: updated });
      }
      if (req.method === 'DELETE' && action === 'rows' && TABLE_ID.test(tableMatch[3] || '')) {
        const body = await parseBody(req), current = row(tableMatch[3]);
        if (!current || current.table_id !== target.id || current.deleted) return fail(res, 404, '商品行不存在');
        if (body.ifVersion !== current.version) return fail(res, 409, '表格行已被修改，请刷新后再删除');
        mutate(target.id, user, 'delete', `删除 ${current.article_no || current.id}`, () => {
          db.prepare('UPDATE rows SET deleted=1,version=version+1,updated_by=?,updated_at=? WHERE id=?').run(user, new Date().toISOString(), current.id);
          emit(target.id, current.id, 'row-deleted', { id: current.id });
        });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'PATCH' && action === 'rows' && TABLE_ID.test(tableMatch[3] || '')) { const body = await parseBody(req); return json(res, 200, { ok: true, row: updateRow(target.id, tableMatch[3], body.patch || body, body.ifVersion, user) }); }
      return fail(res, 404, '接口不存在');
    } catch (error) { logger.error?.(error); return fail(res, error.status || 400, error.message || '请求失败', error.current ? { current: error.current } : {}); }
  }
  const server = http.createServer((req, res) => { void route(req, res); });
  return { server, db, async start() { await new Promise(resolve => server.listen(port, host, resolve)); return server.address(); }, async close() { await new Promise(resolve => server.close(resolve)); db.close(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const instance = createOnlineTableServer();
  instance.start().then(address => console.log(`online-table listening on http://127.0.0.1:${address.port}`));
}

export { createOnlineTableServer, normalizeRow };
