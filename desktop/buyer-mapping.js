const crypto=require('node:crypto');
const text=value=>String(value??'').trim();
const norm=value=>text(value).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
const core=value=>norm(value).replace(/^(?:gz|qz|cs|jx)/,'').replace(/(?:旗舰店|专营店|专卖店|服饰店|服装店|批发店|有限公司|服饰|服装|档口|店铺|店)$/,'');
const id=row=>'s'+crypto.createHash('sha256').update(row.supplierName+'\0'+row.supplierAb).digest('hex').slice(0,12);
function supplierRows(value){
  const input=Array.isArray(value)?value:value&&typeof value==='object'?Object.entries(value).map(([supplierName,row])=>({supplierName,...row})):[];
  const rows=new Map();
  for(const row of input){
    if(!row||typeof row!=='object')continue;
    const supplierName=text(row.supplierName),supplierAb=text(row.supplierAb||row.supplier_ab),storeHouse=text(row.storeHouse||row.store_house);
    if(!supplierName||!supplierAb||supplierName.length>300||supplierAb.length>120)continue;
    const item={supplierName,supplierAb,storeHouse};item.candidateId=id(item);const previous=rows.get(item.candidateId);rows.set(item.candidateId,{...item,storeHouse:item.storeHouse||previous?.storeHouse||''});
  }
  return[...rows.values()];
}
function mappingSource(task){
  const a=task.automation||{},details=a.supplierDetails||{},facts=a.facts||{};
  const names=[facts.supplierName,details.shopName,a.supplier?.shopName,task.supplierName,task.origin?.supplierName].map(text).filter(Boolean);
  const document=[...names,details.boothName,details.title,details.description,details.visibleText,...(details.attributes||[])].filter(Boolean).join('\n');
  // The merchant header precedes the product and recommendation sections.
  // This also recovers old captures whose shopName contains the booth address.
  const visible=text(details.visibleText),end=visible.search(/首页\s*全部商品|全部商品\s*下架商品|图片列表|(?:产品)?货号\s*[:：]|推荐商品|看了又看|相关商品|猜你喜欢|商品介绍/);
  const merchantHeader=visible.slice(0,end>=0?end:Math.min(visible.length,2000));
  return{names:[...new Set(names)],document,normalized:norm(document),merchantHeader,normalizedMerchant:norm(merchantHeader)};
}
function rankSuppliers(rows,task,limit=80){
  const source=mappingSource(task),names=source.names.map(norm),document=source.normalized;
  const score=row=>{
    const name=norm(row.supplierName),base=core(row.supplierName);
    if(names.includes(name))return 10000;
    if(name.length>=3&&document.includes(name))return 9000+name.length;
    if(base.length>=3&&!/^(?:国际服装城|四季星座|服装城|商贸城|批发市场|常熟|广州|泉州|石狮|嘉兴)$/.test(base)&&document.includes(base))return 7000+base.length;
    const tokens=new Set(name.match(/[\p{L}\p{N}]{2}/gu)||[]);let overlap=0;for(const part of tokens)if(document.includes(part))overlap++;
    return overlap;
  };
  const ranked=rows.map(row=>({...row,rank:score(row)})).sort((a,b)=>b.rank-a.rank||a.supplierName.localeCompare(b.supplierName,'zh-CN'));
  return ranked.slice(0,limit).map(({rank,...row})=>row);
}
function supplierSearchTerms(task){
  const {names}=mappingSource(task),values=[];
  for(const name of names){values.push(name);const match=name.match(/^(.{2,20}?)(?:\d|[A-Z]\d)/i);if(match)values.push(match[1]);}
  return[...new Set(values.map(text).filter(value=>value.length>=2))].slice(0,6);
}
function resolveSupplier(selection,candidates,task){
  const source=mappingSource(task),exact=candidates.filter(row=>source.names.some(name=>norm(name)===norm(row.supplierName)));
  const selected=selection?.supplierCandidateId?candidates.find(row=>row.candidateId===selection.supplierCandidateId):exact.length===1?exact[0]:null;
  if(!selected)return{supplier:null,reason:'模型尚未选出有依据的互拓供应商，请查看已取得的候选'};
  if(exact.length===1&&selected.candidateId===exact[0].candidateId)return{supplier:selected,evidence:source.names.find(name=>norm(name)===norm(selected.supplierName)),method:'exact'};
  const quote=text(selection.supplierEvidence),normalized=norm(quote),name=norm(selected.supplierName),base=core(selected.supplierName);
  // A model may explain its choice around a valid quote. Validate the actual
  // merchant name against the captured header instead of requiring the whole
  // explanation to occur verbatim. Do not use names from recommendation cards.
  const exactNames=candidates.filter(row=>norm(row.supplierName)===name);
  if(!quote||!source.normalized.includes(normalized)){
    if(quote&&normalized.includes(name)&&source.normalizedMerchant.includes(name)&&exactNames.length===1)return{supplier:selected,evidence:selected.supplierName,modelReason:quote,method:'page_name'};
    return{supplier:null,reason:'模型选择供应商缺少商品页原文依据，候选已保留'};
  }
  const coreSupported=base.length>=3&&!/^(?:国际服装城|四季星座|服装城|商贸城|批发市场|常熟|广州|泉州|石狮|嘉兴)$/.test(base)&&normalized.includes(base);
  if(!normalized.includes(name)&&!coreSupported)return{supplier:null,reason:'供应商候选与页面店铺名称没有可核实的对应关系，候选已保留'};
  return{supplier:selected,evidence:quote,method:'model_alias'};
}
function mappingControls(controls,categoryName){
  const area=controls?.[0]?.category?.[categoryName]||{},names=new Set(Object.values(area).flat().filter(value=>typeof value==='string'));
  for(const key of Object.keys(controls?.[1]?.control||{}))names.add(key);
  return Object.fromEntries([...names].map(key=>[key,controls?.[1]?.control?.[key]||controls?.[0]?.control?.[key]]).filter(([,value])=>value));
}
function normalizeMapping(mapping,catalog,controls){
  const canonical=(rows,value)=>{const same=rows.filter(row=>norm(row.label)===norm(value)||norm(row.value)===norm(value));const labels=[...new Set(same.map(row=>text(row.label)))];return labels.length===1?labels[0]:value;};
  const output={...mapping,extendedAttributes:{...(mapping.extendedAttributes||{})}};
  output.sizeType=({international_code:'国际码',universal_code:'通用码',numerical_code:'数值码'})[text(mapping.sizeType)]||mapping.sizeType;
  const fields={storeHouse:'warehouse_infos',pallet:'pallet_infos',industry:'industry',season:'season',technology:'technology_infos',style:'product_style'};
  for(const [key,type]of Object.entries(fields))if(mapping[key]!=null)output[key]=canonical(catalog.dictionaries.filter(row=>row.dictType===type),Array.isArray(mapping[key])?mapping[key].length===1?mapping[key][0]:mapping[key].length===0?'':mapping[key]:mapping[key]);
  if(mapping.ageState!=null)output.ageState=(Array.isArray(mapping.ageState)?mapping.ageState:[mapping.ageState]).map(value=>canonical(catalog.dictionaries.filter(row=>row.dictType==='ages'),value));
  for(const [key,rule]of Object.entries(controls||{})){
    const value=output.extendedAttributes[key];if(value==null)continue;
    const options=(Array.isArray(rule.option)?rule.option:[]).map(item=>typeof item==='string'?{value:item,label:item}:{value:String(item.value??item.label??''),label:String(item.label??item.value??'')});
    const match=value=>{if(typeof value!=='string')return value;const found=options.filter(row=>norm(row.value)===norm(value)||norm(row.label)===norm(value));return found.length===1?found[0].value:value;};
    const multi=['multi_select','material_select','checkbox'].includes(rule.type);
    output.extendedAttributes[key]=multi?(Array.isArray(value)?value:[value]).map(match):Array.isArray(value)&&value.length===1?match(value[0]):match(value);
  }
  return output;
}
module.exports={supplierRows,rankSuppliers,supplierSearchTerms,mappingSource,resolveSupplier,mappingControls,normalizeMapping};
