const path=require('node:path');
const crypto=require('node:crypto');
const AdmZip=require('adm-zip');
const {DOMParser}=require('@xmldom/xmldom');
const {sourceLink,links}=require('./buyer-links');
const MAX_ROWS=500,MAX_BYTES=30*1024*1024;
const elements=(node,name)=>Array.from(node.getElementsByTagNameNS('*',name));
const content=node=>elements(node,'t').map(item=>item.textContent||'').join('');
function csvRows(text,delimiter){
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else if(!cell||quoted)quoted=!quoted;else cell+=c;}
    else if(!quoted&&(c===delimiter||c==='\n'||c==='\r')){row.push(cell);cell='';if(c!==delimiter){rows.push(row);row=[];if(c==='\r'&&text[i+1]==='\n')i++;if(rows.length>MAX_ROWS+30)throw new Error('表格超过500行，请分批导入');}if(row.length>200)throw new Error('表格列数过多');}
    else cell+=c;
  }
  if(quoted)throw new Error('CSV双引号未闭合');if(cell||row.length){row.push(cell);rows.push(row);}return rows;
}
function parseXlsx(buffer){
  const zip=new AdmZip(buffer),entries=zip.getEntries();let total=0;
  if(entries.length>12000)throw new Error('工作簿文件项过多');
  const files=new Map();
  for(const entry of entries){if(entry.entryName.includes('..')||entry.entryName.startsWith('/')||entry.entryName.includes('\\'))throw new Error('工作簿路径无效');total+=entry.header.size;if(entry.header.size>32*1024*1024||total>160*1024*1024)throw new Error('工作簿解压内容过大');files.set(entry.entryName,entry);}
  const xml=file=>{
    const entry=files.get(file);if(!entry)return null;if(entry.header.size>8*1024*1024)throw new Error('工作簿XML过大');const text=entry.getData().toString('utf8');
    if(/<!DOCTYPE|<!ENTITY/i.test(text))throw new Error('工作簿包含不支持的XML声明');
    return new DOMParser({onError(level){if(level==='fatalError'||level==='error')throw new Error('工作簿XML损坏');}}).parseFromString(text,'application/xml');
  };
  const relationships=(file,base)=>{const doc=xml(file);return new Map(doc?elements(doc,'Relationship').map(item=>{const target=item.getAttribute('Target')||'';return[item.getAttribute('Id'),item.getAttribute('TargetMode')==='External'?target:path.posix.normalize(path.posix.join(base,target))];}):[]);};
  const image=target=>{if(!/^xl\/media\/[^/]+\.(png|jpe?g|webp)$/i.test(target||''))return null;const entry=files.get(target);return entry&&entry.header.size<=10*1024*1024?entry.getData():null;};
  const shared=elements(xml('xl/sharedStrings.xml')||{getElementsByTagNameNS:()=>[]},'si').map(content);
  const wpsImages=new Map(),cellImages=xml('xl/cellimages.xml'),cellRels=relationships('xl/_rels/cellimages.xml.rels','xl');
  if(cellImages)for(const pic of elements(cellImages,'pic')){const name=elements(pic,'cNvPr')[0]?.getAttribute('name'),rel=elements(pic,'blip')[0]?.getAttribute('r:embed');const bytes=image(cellRels.get(rel));if(name&&bytes)wpsImages.set(name,bytes);}
  const workbook=xml('xl/workbook.xml');if(!workbook)throw new Error('文件不是有效的XLSX工作簿');
  const sheets=relationships('xl/_rels/workbook.xml.rels','xl'),result=[];
  for(const sheet of elements(workbook,'sheet')){
    const target=sheets.get(sheet.getAttribute('r:id'));if(!target?.startsWith('xl/worksheets/'))continue;
    const doc=xml(target);if(!doc)continue;
    const rels=relationships(path.posix.join(path.posix.dirname(target),'_rels',path.posix.basename(target)+'.rels'),path.posix.dirname(target));
    const hyperlinks=new Map(elements(doc,'hyperlink').map(node=>[node.getAttribute('ref'),rels.get(node.getAttribute('r:id'))||node.getAttribute('location')]));
    const drawingImages=new Map();
    for(const drawing of elements(doc,'drawing')){
      const file=rels.get(drawing.getAttribute('r:id'));if(!file?.startsWith('xl/drawings/'))continue;const drawingDoc=xml(file);if(!drawingDoc)continue;
      const pictureRels=relationships(path.posix.join(path.posix.dirname(file),'_rels',path.posix.basename(file)+'.rels'),path.posix.dirname(file));
      for(const anchor of [...elements(drawingDoc,'twoCellAnchor'),...elements(drawingDoc,'oneCellAnchor')]){const from=elements(anchor,'from')[0],row=Number(from&&elements(from,'row')[0]?.textContent)+1;const embed=elements(anchor,'blip')[0]?.getAttribute('r:embed');const bytes=image(pictureRels.get(embed));if(Number.isInteger(row)&&bytes&&!drawingImages.has(row))drawingImages.set(row,bytes);}
    }
    const rows=[];
    for(const row of elements(doc,'row')){
      const rowNo=Number(row.getAttribute('r'));if(!Number.isInteger(rowNo)||rowNo<1)continue;
      const values=[];let rowImage=drawingImages.get(rowNo)||null;
      for(const cell of elements(row,'c')){
        const address=cell.getAttribute('r')||'',letters=address.match(/^[A-Z]+/)?.[0]||'A';let column=0;for(const c of letters)column=column*26+c.charCodeAt(0)-64;if(column>200)continue;
        const type=cell.getAttribute('t'),value=elements(cell,'v')[0]?.textContent||'',formula=elements(cell,'f')[0]?.textContent||'';
        let text=type==='s'?shared[Number(value)]||'':type==='inlineStr'?content(cell):value;
        const href=hyperlinks.get(address)||formula.match(/HYPERLINK\s*\(\s*"([^"]+)"/i)?.[1];if(href)text+=' '+href;
        const disp=formula.match(/DISPIMG\s*\(\s*"([^"]+)"/i)?.[1];if(disp&&!rowImage)rowImage=wpsImages.get(disp)||null;
        values[column-1]=String(text).slice(0,10000);
      }
      rows.push({rowNo,values,image:rowImage});if(rows.length>MAX_ROWS+30)throw new Error('工作簿超过500行，请分批导入');
    }
    result.push({name:sheet.getAttribute('name')||'Sheet',rows});
  }
  return result;
}
function parseBuyerTable(buffer,filename){
  if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>MAX_BYTES)throw new Error('表格必须为非空文件且不超过30MB');
  const extension=path.extname(filename).toLowerCase();let sheets;
  if(extension==='.xlsx')sheets=parseXlsx(buffer);
  else if(['.csv','.tsv'].includes(extension)){
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{text=new TextDecoder('gb18030').decode(buffer);}
    text=text.replace(/^\uFEFF/,'');const delimiter=extension==='.tsv'?'\t':text.split(/\r?\n/,1)[0].includes('\t')?'\t':',';
    sheets=[{name:path.basename(filename),rows:csvRows(text,delimiter).map((values,index)=>({rowNo:index+1,values,image:null}))}];
  }else throw new Error('请导入XLSX、CSV或TSV；旧版XLS请先另存为XLSX');
  const digest=crypto.createHash('sha256').update(buffer).digest('hex'),batchId=crypto.randomUUID(),rows=[],seen=new Set(),seenTableIds=new Set();
  for(const sheet of sheets){
    const header=sheet.rows.slice(0,20).find(row=>row.values.some(value=>/^(表格ID|表格编号|选品日期|日期|供应商|店铺名|商品编码|款式编码|货号|款号|商品货号|供应商货号|articleNo|sku)$/i.test(String(value||'').trim()))||row.values.some(value=>/套图链接|平台链接|商品链接|选品链接/.test(value||'')));
    const column=pattern=>header?header.values.findIndex(value=>pattern.test(String(value||'').trim())):-1;
    const articleColumn=column(/^(货号|款号|商品货号|供应商货号|articleNo|sku)$/i);
    const tableIdColumn=column(/^(表格ID|表格编号|表格id|流水号|序号)$/i);
    const dateColumn=column(/^(选品日期|日期)$/i);
    const supplierColumn=column(/^(供应商|供应商名称|店铺名|店铺名称|档口)$/i);
    const shopColumn=column(/^(店铺名|店铺名称)$/i);
    const codeColumn=column(/^(商品编码|运营款式编码|款式编码|运营编码|商品款号)$/i);
    const selectOperatorColumn=column(/^(选品操作人|选品人)$/i);
    const buyerOperatorColumn=column(/^(买手操作人|买手|买手人)$/i);
    const noteColumn=column(/^(备注|备注1|备注2)$/i);
    const linkColumn=column(/^(平台链接|商品链接|套图链接|选品链接|链接)$/i);
    for(const row of sheet.rows){
      if(header&&row.rowNo<=header.rowNo)continue;
      const urls=[...new Set((linkColumn>=0?[row.values[linkColumn]]:row.values).flatMap(value=>links(value)))];if(!urls.length)continue;
      const valid=[...new Map(urls.map(sourceLink).filter(Boolean).map(link=>[link.sourceUrl,link])).values()],key=valid.map(link=>link.sourceUrl).join('|');
      const errors=[];if(!valid.length)errors.push('未找到支持的淘宝、抖音或供应商商品链接');
      if(valid.length>1)errors.push('同一行有多个商品链接，请拆行后导入');
      const tableFields={shopName:shopColumn>=0?String(row.values[shopColumn]||'').trim():'',sales7d:String(row.values[column(/^(近7天销量|近七天销量)$/i)]||'').trim(),peerPrice:String(row.values[column(/^(同行销售价|同行售价|同行销售价格)$/i)]||'').trim(),peerLocation:String(row.values[column(/^(同行发货地|同行发货地\/仓库)$/i)]||'').trim(),goodsCost:String(row.values[column(/^(货品成本|供货价|买手成本)$/i)]||'').trim(),warehouse:String(row.values[column(/^(发货仓|发货仓库|仓库)$/i)]||'').trim()};
      const item={id:crypto.randomUUID(),batchId,fileName:path.basename(filename),sheetName:sheet.name,rowNumber:row.rowNo,digest,tableId:String(tableIdColumn>=0?row.values[tableIdColumn]:'').trim()||String(rows.length+1).padStart(2,'0'),selectDate:dateColumn>=0?String(row.values[dateColumn]||'').trim():'',supplierName:supplierColumn>=0?String(row.values[supplierColumn]||'').trim():'',externalCode:codeColumn>=0?String(row.values[codeColumn]||'').trim():'',selectOperator:selectOperatorColumn>=0?String(row.values[selectOperatorColumn]||'').trim():'',buyerOperator:buyerOperatorColumn>=0?String(row.values[buyerOperatorColumn]||'').trim():'',note:noteColumn>=0?String(row.values[noteColumn]||'').trim():'',tableFields,articleNo:articleColumn>=0?String(row.values[articleColumn]||'').trim():'',...(valid[0]||{}),image:row.image,errors,tags:[]};
      const idKey=`${item.selectDate}\0${item.tableId}`;if(seenTableIds.has(idKey))item.errors.push('同一选品日期内表格ID重复');seenTableIds.add(idKey);
      if(key&&seen.has(key))item.tags.push('表内重复');if(key)seen.add(key);rows.push(item);if(rows.length>MAX_ROWS)throw new Error('每次最多导入500个商品');
    }
  }
  if(!rows.length)throw new Error('未读取到商品链接，请检查表格中是否包含完整HTTPS链接或超链接');
  return {batchId,fileName:path.basename(filename),digest,rows};
}
function xmlEscape(value){return String(value??'').replace(/[<>&"']/g,char=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[char]));}
function exportBuyerXlsx(rows){
  if(!Array.isArray(rows)||rows.length>50000)throw new Error('在线表格导出最多支持50000行');
  const headers=['选品日期','表格ID','图片','平台链接','供应商','店铺名','近7天销量','同行销售价','同行发货地','货品成本','发货仓','商品编码','互拓编码','选品操作人','买手操作人','备注','处理状态','商品文件夹','更新时间','任务ID','在线表ID','在线行ID'];
  const values=[headers,...rows.map(row=>[row.selectDate||'',row.tableId||'',row.image||'',row.sourceUrl||'',row.supplierName||'',row.shopName||'',row.sales7d||'',row.peerPrice||'',row.peerLocation||'',row.goodsCost||'',row.warehouse||'',row.externalCode||row.articleNo||'',row.erpProductNo||'',row.selectOperator||'',row.buyerOperator||'',row.note||'',row.automationState||'',row.productFolder||'',row.updatedAt||'',row.taskId||'',row.onlineTableId||'',row.onlineTableRowId||row.id||''])];
  const columnName=index=>{let value=index+1,result='';while(value){const remainder=(value-1)%26;result=String.fromCharCode(65+remainder)+result;value=Math.floor((value-1)/26);}return result;};
  const cell=(value,rowIndex,columnIndex)=>`<c r="${columnName(columnIndex)}${rowIndex+1}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
  const sheetRows=values.map((row,rowIndex)=>`<row r="${rowIndex+1}">${row.map((value,columnIndex)=>cell(value,rowIndex,columnIndex)).join('')}</row>`).join('');
  const zip=new AdmZip();
  zip.addFile('[Content_Types].xml',Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'));
  zip.addFile('_rels/.rels',Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'));
  zip.addFile('xl/workbook.xml',Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="在线表格" sheetId="1" r:id="rId1"/></sheets></workbook>'));
  zip.addFile('xl/_rels/workbook.xml.rels',Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'));
  zip.addFile('xl/worksheets/sheet1.xml',Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`));
  return zip.toBuffer();
}
function publicImport(preview){return{...preview,rows:preview.rows.map(({image,...row})=>({...row,hasImage:!!image}))};}
module.exports={parseBuyerTable,publicImport,sourceLink,csvRows,exportBuyerXlsx};
