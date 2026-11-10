const fs = require('node:fs/promises');
const path = require('node:path');

const safeSegment = (value, fallback = '未命名') => {
  const text = String(value ?? '').trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').slice(0, 120).trim();
  return text || fallback;
};

function dateSegment(task, now = new Date()) {
  const raw = String(task?.origin?.selectDate || '').trim();
  const match = raw.match(/(20\d{2})\D*(\d{1,2})\D*(\d{1,2})/) || raw.match(/(\d{1,2})\D+(\d{1,2})/);
  if (match) return `${Number(match[match.length - 2])}.${Number(match[match.length - 1])}`;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).format(now).replace('/', '.');
}

function tableId(task) {
  const supplied = String(task?.origin?.tableId || task?.onlineTableRowId || task?.origin?.rowId || '').trim();
  if (supplied) return safeSegment(supplied, '未编号');
  const row = Number(task?.origin?.rowNumber);
  return Number.isInteger(row) && row > 0 ? String(row).padStart(2, '0') : '未编号';
}

function productName(task) {
  return safeSegment(task?.automation?.result?.productNo || tableId(task), tableId(task));
}

async function syncBuyerFolder({ rootDir, task, sourceImage }) {
  if (!rootDir || !path.isAbsolute(rootDir) || !task?.id) return '';
  const root = path.resolve(rootDir), base = path.basename(root) === '买手' ? root : path.join(root, '买手'), parent = path.join(base, dateSegment(task));
  await fs.mkdir(parent, { recursive: true });
  const desired = path.join(parent, productName(task));
  const owner = async candidate => { try { return JSON.parse(await fs.readFile(path.join(candidate, '商品记录.json'), 'utf8')).taskId || ''; } catch { return ''; } };
  let folder = desired;
  const desiredOwner = await owner(desired);
  const exists = async candidate => !!(await fs.stat(candidate).catch(() => null));
  if ((desiredOwner && desiredOwner !== task.id) || (!desiredOwner && !task.productFolder && await exists(desired))) {
    const suffix = safeSegment(tableId(task), task.id.slice(0, 8));
    const stem = `${path.basename(desired)}_${suffix}`;
    folder = path.join(parent, stem);
    for (let attempt = 2; await exists(folder) && await owner(folder) !== task.id; attempt++) folder = path.join(parent, `${stem}_${attempt}`);
  }
  const previous = task.productFolder ? path.resolve(task.productFolder) : '';
  if (previous && previous !== folder && previous.startsWith(parent + path.sep) && await exists(previous) && await owner(previous) === task.id) {
    if (!await exists(folder)) await fs.rename(previous, folder);
  }
  await fs.mkdir(folder, { recursive: true });
  if (sourceImage?.length) {
    const imagePath = path.join(folder, '主图.jpg');
    try { await fs.access(imagePath); } catch { await fs.writeFile(imagePath, sourceImage, { flag: 'wx' }); }
  }
  const metadata = {
    taskId: task.id, tableId: task.origin?.tableId || task.onlineTableRowId || tableId(task), selectDate: task.origin?.selectDate || '',
    sourceUrl: task.sourceUrl || '', sourceType: task.sourceType || '', externalCode: task.externalCode || task.origin?.externalCode || '',
    supplierName: task.supplierName || task.origin?.supplierName || '', erpProductNo: task.automation?.result?.productNo || '',
    status: task.automation?.state || '', note: task.automation?.error || task.origin?.note || '',
    supplierFacts: task.automation?.facts || null, marketplace: task.automation?.marketplace || null,
    supplierImages: task.automation?.supplierDetails?.images || [], collectionImages: task.automation?.collection?.images || [],
    erpPayload: task.automation?.mapped?.payload || null, fieldEvidence: task.automation?.mapped?.evidence || null,
    operators: { selection: task.origin?.selectOperator || '', buyer: task.origin?.buyerOperator || '' },
    updatedAt: task.updatedAt || new Date().toISOString()
  };
  await fs.writeFile(path.join(folder, '商品记录.json'), JSON.stringify(metadata, null, 2), 'utf8');
  return folder;
}

module.exports = { safeSegment, dateSegment, tableId, productName, syncBuyerFolder };
