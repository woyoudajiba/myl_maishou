const text=value=>String(value??'').trim();
const array=value=>Array.isArray(value)?value:[];
const {sortSizes,sizeKey}=require('./size-order');
function supplierMaterialInfo(details={}){
  const sources=array(details.attributes).map(text).map(quote=>{const match=quote.match(/^(面料(?:成分|材质)?|主面料成分|材质成分|成分及含量|成分|材质|填充物材质|填充物|里料成分)\s*[:：]\s*(.+)$/);return match?{label:match[1],value:match[2].trim(),quote}:null;}).filter(Boolean);
  const primary=sources.filter(row=>!/^填充|^里料/.test(row.label));
  const selected=primary.find(row=>/成分/.test(row.label))||primary[0];
  const materials=selected?selected.value.split(/[，,、；;+]/).flatMap(value=>{
    const part=value.trim(),before=part.match(/^(\d+(?:\.\d+)?)\s*%\s*([^%]+)$/);
    if(before)return[{name:text(before[2]),rate:Number(before[1])}];
    return part.split(/(?<=%)\s*/).map(value=>{const entry=value.trim(),after=entry.match(/^(.+?)\s*(\d+(?:\.\d+)?)\s*%$/);return{name:text(after?.[1]||entry),rate:after?Number(after[2]):null};});
  }).filter(row=>row.name):[];
  return{materials,sources,quote:selected?.quote||'',proportionsKnown:materials.length>0&&materials.every(row=>Number.isFinite(row.rate))&&Math.abs(materials.reduce((sum,row)=>sum+row.rate,0)-100)<0.01};
}
function mergeStructuredSupplierFacts(result,details){
  const output={...result,evidence:{...(result.evidence||{})}};
  const attributes=array(details.attributes).map(text);
  const quoteFor=(labels,values)=>{
    const expected=values.map(value=>text(value)).filter(Boolean);
    const row=attributes.find(value=>labels.some(label=>value.startsWith(label))&&expected.every(needle=>value.includes(needle)));
    return row||expected.join(' ');
  };
  if(text(details.sku)){
    output.articleNo=text(details.sku);
    output.evidence.articleNo=quoteFor(['产品货号','货号'],[details.sku]);
  }
  if(text(details.shopName)){
    output.supplierName=text(details.shopName);
    output.evidence.supplierName=text(details.shopName);
  }
  if(details.priceType!=='tiered'&&Number.isFinite(Number(details.price))&&Number(details.price)>0){
    output.cost=Number(details.price);
    const price=String(Number(details.price));
    const row=attributes.find(value=>/(?:供货价|批价|批发价|SKU规格)/.test(value)&&value.includes(price));
    output.evidence.cost=row||price;
  }
  if(array(details.colors).length){
    output.colors=array(details.colors).map(text).filter(Boolean);
    output.evidence.colors=quoteFor(['颜色分类','颜色'],output.colors);
  }
  if(array(details.sizes).length){
    const sourceSizes=array(details.sizes).map(text).filter(Boolean);
    output.sizes=sortSizes(sourceSizes);
    output.evidence.sizes=quoteFor(['尺码','尺寸'],sourceSizes);
  }
  const materialInfo=supplierMaterialInfo(details);output.materialInfo=materialInfo;
  if(materialInfo.materials.length){output.materials=materialInfo.materials;output.evidence.materials=materialInfo.quote;}
  return output;
}
function validateSupplierFacts(result,details){
  const document=[details.visibleText,details.description,...array(details.attributes)].join('\n').replace(/\s+/g,'');
  const supported=key=>{const evidence=result.evidence?.[key],quote=text(typeof evidence==='object'?evidence?.quote:evidence).replace(/\s+/g,'');const imageEvidence=evidence&&typeof evidence==='object'&&Number.isInteger(evidence.imageIndex)&&evidence.imageIndex>=0&&evidence.imageIndex<array(details.images).length&&array(result.verifiedOcrFields).includes(key);return quote.length>=2&&(document.includes(quote)||imageEvidence);};
  const quote=key=>{const value=result.evidence?.[key];return text(typeof value==='object'?value?.quote:value);};
  const missing=[];
  const articleQuote=quote('articleNo').replace(/\s+/g,'');
  const articleValue=articleQuote.match(/(?:产品)?货号[:：]?(.+)$/)?.[1]||articleQuote;
  const articleNo=supported('articleNo')&&text(result.articleNo).replace(/\s+/g,'')===articleValue?text(result.articleNo):!text(result.articleNo)?text(details.sku):'';
  const supplierName=supported('supplierName')&&quote('supplierName').includes(text(result.supplierName))?text(result.supplierName):text(details.shopName);
  if(!articleNo||!/^[\p{L}\p{N}][\p{L}\p{N}._/-]{0,63}$/u.test(articleNo))missing.push('供应商有效货号');
  if(!supplierName)missing.push('供应商名称');
  const costEvidence=result.evidence?.cost,costQuote=text(typeof costEvidence==='object'?costEvidence?.quote:costEvidence);
  const cost=supported('cost')&&typeof result.cost==='number'&&Number.isFinite(result.cost)&&result.cost>0&&result.cost<=1000&&(costQuote.match(/\d+(?:\.\d+)?/g)||[]).some(value=>Number(value)===result.cost)?result.cost:null;
  if(cost===null)missing.push('供应商明确供货价');
  const colors=supported('colors')?array(result.colors).map(text).filter(value=>value&&quote('colors').includes(value)):[];
  const sizeQuote=quote('sizes'),range=sizeQuote.match(/(XXS(?:\(2XS\))?|2XS(?:\(XXS\))?|XS|S|M|L|XL|[2-9]XL)\s*(?:-|~|～|到|至)\s*(XXS(?:\(2XS\))?|2XS(?:\(XXS\))?|XS|S|M|L|XL|[2-9]XL)/i),order=['XXS','XS','S','M','L','XL','2XL','3XL','4XL','5XL','6XL','7XL','8XL','9XL'];
  const expanded=range?order.slice(order.indexOf(sizeKey(range[1])),order.indexOf(sizeKey(range[2]))+1):[];
  const quotedSizes=(sizeQuote.match(/(?:XXS(?:\(2XS\))?|2XS(?:\(XXS\))?|XS|[2-9]XL|X{2,8}L|XL|S|M|L)/gi)||[]).map(sizeKey);
  const sizes=supported('sizes')?array(result.sizes).map(text).filter(value=>value&&(sizeQuote.includes(value)||quotedSizes.includes(sizeKey(value))||expanded.includes(sizeKey(value)))):[];
  const materialInfo=supplierMaterialInfo(details);
  const materials=materialInfo.materials.length?materialInfo.materials:supported('materials')?array(result.materials).filter(row=>row&&typeof row.name==='string'&&quote('materials').includes(row.name)&&Number.isFinite(row.rate)&&row.rate>=0&&row.rate<=100&&(quote('materials').match(/\d+(?:\.\d+)?/g)||[]).some(value=>Number(value)===row.rate)):[];
  if(!colors.length)missing.push('供应商可供颜色');if(!sizes.length)missing.push('供应商尺码范围');
  if(!materials.length||materials.some(row=>!Number.isFinite(row.rate))||Math.abs(materials.reduce((sum,row)=>sum+row.rate,0)-100)>0.01)missing.push('供应商成分及比例');
  const images=array(details.images),sizePic=Number.isInteger(result.sizeImageIndex)&&images[result.sizeImageIndex]?images[result.sizeImageIndex]:'';
  if(!sizePic)missing.push('供应商尺码图');
  if(![0,1].includes(result.fork))missing.push('公版或专版依据');
  const variant=text(result.variant),requiresQc=/(羽绒|冲锋衣|防晒衣)/.test([result.categoryName,details.title].join(' '));
  if(requiresQc)missing.push('对应类别的真实质检报告与洗水唛');
  if(result.priceConflict===true)missing.push('不同规格供货价需确认');
  return{articleNo,supplierName,cost,colors:[...new Set(colors)],sizes:sortSizes(sizes),materials,materialInfo,sizePic,fork:result.fork,variant,warehouse:text(result.warehouse),categoryName:text(result.categoryName),evidence:result.evidence||{},missing};
}
function buildPayload({mapping,facts,source,marketplace,collection,catalog,controls,settings,supplier,colors,supplierImages=[]}){
  const missing=[];const category=catalog.categories.find(row=>row.categoryName===mapping.productTypeName&&row.status===1);
  if(facts.articleNo&&!/^[A-Za-z0-9/]+$/.test(facts.articleNo))missing.push('当前互拓货号契约仅接受字母、数字和 /；原始中文货号已保留，需确认ERP支持后再提交');
  if(!category)missing.push('有效互拓类别');
  const normalized=value=>String(value??'').normalize('NFKC').replace(/\s+/g,'').toLowerCase();
  const dict=(type,value,mode='label')=>{const matches=catalog.dictionaries.filter(row=>row.dictType===type&&(normalized(row.label)===normalized(value)||normalized(row.value)===normalized(value)));const values=[...new Set(matches.map(row=>String(row[mode]).trim()))];return values.length===1?values[0]:'';};
  const rowColors=facts.colors.map(name=>{const matches=[...new Map(colors.filter(row=>row.colorName===name&&row.colorStatus===1&&row.colorId).map(row=>[String(row.colorId),row])).values()];if(matches.length!==1)missing.push(`颜色库未匹配：${name}`);return matches[0]||{};});
  const raw=collection.rawPrefill||{},collectionColors=array(collection.colors).map(row=>row.name),collectionSizes=array(collection.sizes).map(row=>typeof row==='string'?row:row.name||row.size||'');
  // The supplier defines the offered SKU range; marketplace images may show a
  // subset or use different colour names. Do not delete real supplier SKUs.
  const keptColors=[...facts.colors];
  let keptSizes=sortSizes(facts.sizes);
  if(!keptColors.length)missing.push('供应商可供颜色缺失');if(!keptSizes.length)missing.push('供应商可供尺码缺失');
  const omittedColors=collectionColors.filter(name=>!facts.colors.includes(name)),omittedSizes=collectionSizes.filter(name=>!facts.sizes.some(value=>sizeKey(value)===sizeKey(name)));
  const remarks=[marketplace.salesText,omittedColors.length?'供应商不供颜色：'+omittedColors.join('、'):'',omittedSizes.length?'供应商不供尺码：'+omittedSizes.join('、'):'',facts.variant].filter(Boolean).join('；');
  const fieldConfig={...(controls?.[0]?.control||{}),...(controls?.[1]?.control||{})};
  const area=controls?.[0]?.category?.[category?.categoryName]||{},fieldNames=new Set(Object.values(area).flat().filter(value=>typeof value==='string'));
  for(const key of Object.keys(controls?.[1]?.control||{}))fieldNames.add(key);
  const attributes={};
  for(const key of fieldNames){const rule=fieldConfig[key];if(!rule)continue;const value=mapping.extendedAttributes?.[key];const options=array(rule.option).map(option=>typeof option==='string'?option:String(option.value??option.label??''));
    if(key==='品牌'&&facts.fork===0)continue;
    const values=Array.isArray(value)?value:[value],multi=['multi_select','material_select','checkbox'].includes(rule.type);
    const allowedImages=new Set([...array(source.images),...array(collection.images),...array(supplierImages),facts.sizePic]);
    const shape=multi?Array.isArray(value):typeof value==='string';
    if(value!==undefined&&shape&&values.every(item=>typeof item==='string'&&(!options.length||options.includes(item)))&&(rule.type!=='image'||allowedImages.has(value)))attributes[key]=value;
    if(Number(rule.required)===1&&(attributes[key]===undefined||attributes[key]===''||Array.isArray(attributes[key])&&!attributes[key].length))missing.push('类别必填：'+key);
  }
  const warehouse=dict('warehouse_infos',supplier?.storeHouse||facts.warehouse||mapping.storeHouse,'value')||dict('warehouse_infos',mapping.storeHouse,'value');
  const buyer=settings.buyerName||catalog.permissions?.user?.nickname||catalog.permissions?.user?.name||'';
  const sizeType=['通用码','数值码','国际码'].includes(mapping.sizeType)?mapping.sizeType:'';
  const sizeDict={'通用码':'universal_code','数值码':'numerical_code','国际码':'international_code'}[sizeType];
  keptSizes=sortSizes(keptSizes.map(size=>{
    const rows=catalog.dictionaries.filter(row=>row.dictType===sizeDict);
    const exact=rows.filter(row=>row.label===size||String(row.value)===size);
    const matches=exact.length?exact:rows.filter(row=>sizeKey(row.label)===sizeKey(size)||sizeKey(row.value)===sizeKey(size));
    if(matches.length!==1){missing.push('尺码字典不匹配：'+size);return size;}
    return String(matches[0].label);
  }));
  const originalSuit=array(raw.suit_pic_info||raw.suitPicInfo)[0]||{};
  const sourceLabel=dict('suit_pic_source',new URL(marketplace.url).hostname==='detail.tmall.com'?'天猫链接':'淘宝链接')||dict('suit_pic_source','其他平台链接');
  const payload={articleNo:facts.articleNo,productType:category?.categoryAb||'',productTypeName:category?.categoryName||'',storeHouse:warehouse,supplierName:supplier?.supplierName||'',supplierAb:supplier?.supplierAb||'',pallet:settings.pallet||dict('pallet_infos',mapping.pallet),company:settings.company,buyerName:buyer,talkCost:facts.cost,supplyCycle:settings.supplyCycle,industry:dict('industry',mapping.industry),season:dict('season',mapping.season),technology:dict('technology_infos',mapping.technology),style:dict('product_style',mapping.style),ageState:array(mapping.ageState).map(value=>dict('ages',value,'value')).filter(Boolean).join(','),fork:facts.fork,colors:keptColors,colorNo:keptColors.map(name=>rowColors[facts.colors.indexOf(name)]?.colorId||''),colorPic:keptColors.map(name=>collection.colors?.find(row=>row.name===name)?.image||''),colorRemark:keptColors.map(()=>''),sizeType,sizeCategory:keptSizes,sizePic:facts.sizePic,sizeList:keptSizes.map(size=>({size,height:'',weight:'',remark:''})),material:facts.materials.map(row=>row.name),materialRate:facts.materials.map(row=>String(row.rate)),materialRemark:'',standardScore:[],extendedAttributes:attributes,suitPicInfo:[{...originalSuit,firstPic:1,mainPic:source.images?.[0]||collection.images?.[0]||'',mainPicSource:sourceLabel,picBuyerName:buyer,picState:1,recommend:0,remark:remarks,suitPic:marketplace.url,documenter:buyer}],publicPicInfo:{mainPic11:array(collection.images)[0]||'',mainPic34:'',background:'',shoppingPic:'',detailPic:array(collection.images).slice(1).join(','),mainVideo:''}};
  if(facts.fork===1&&!attributes['品牌'])missing.push('专版品牌');
  payload.material=payload.material.map(material=>{const label=dict('material_composition',material);if(!label)missing.push('材质字典不匹配：'+material);return label||material;});
  const scope=String(category?.processScope||'').trim();
  if(scope&&scope!=='[]'){
    const groups=scope.split('*');
    if(groups.length>20||groups.some(group=>!group.includes('^')||!group.includes('|')))missing.push('类别评分规则结构需核验');
    else payload.standardScore=groups.map(group=>group.split('|').slice(1).map(()=> '0'));
  }
  // The formal ERP product form defaults company to 厦门. Follow that actual
  // form default only when it is present in this account's company dictionary.
  payload.company=settings.company||dict('company',catalog.permissions?.user?.company||'厦门');
  if(!payload.company)delete payload.company;
  return{payload,missing:[...new Set(missing)],evidence:{supplier:facts.evidence,sourceUrl:source.url,marketplace:marketplace.url,scoringBasis:'document_business_default_zero'}};
}
function manualSupplierFacts(input,previous,details){
  const articleNo=text(input.articleNo),supplierName=text(input.supplierName),cost=Number(input.cost),colors=array(input.colors).map(text).filter(Boolean),sizes=array(input.sizes).map(text).filter(Boolean),materials=array(input.materials).map(row=>({name:text(row?.name),rate:Number(row?.rate)}));
  if(!/^[\p{L}\p{N}][\p{L}\p{N}._/-]{0,63}$/u.test(articleNo)||!supplierName||supplierName.length>300)throw new Error('请填写有效的供应商货号和名称');
  if(!Number.isFinite(cost)||cost<=0||cost>1000)throw new Error('供货价须大于0且不超过1000');
  if(!colors.length||colors.length>60||colors.some(value=>value.length>100)||!sizes.length||sizes.length>60||sizes.some(value=>value.length>100))throw new Error('请填写供应商可供颜色和尺码');
  if(!materials.length||materials.length>20||materials.some(row=>!row.name||!Number.isFinite(row.rate)||row.rate<=0||row.rate>100)||Math.abs(materials.reduce((sum,row)=>sum+row.rate,0)-100)>0.01)throw new Error('成分与比例须合计100%');
  const index=input.sizeImageIndex===''||input.sizeImageIndex==null?NaN:Number(input.sizeImageIndex),sizePic=Number.isInteger(index)&&index>=0?details.images?.[index]:'';
  if(!sizePic)throw new Error('请从已采集的供应商图片中选择尺码图');
  if(![0,1].includes(input.fork))throw new Error('请选择公版或专版');
  const missing=[];if(/羽绒|冲锋衣|防晒衣/.test([previous?.categoryName,details.title].join(' ')))missing.push('对应类别的真实质检报告与洗水唛');
  return{...previous,articleNo,supplierName,cost,colors,sizes:sortSizes(sizes),materials,sizePic,fork:input.fork,warehouse:text(input.warehouse),missing,evidence:{...previous?.evidence,manual:{at:new Date().toISOString(),fields:['articleNo','supplierName','cost','colors','sizes','materials','sizePic','fork','warehouse']}}};
}
module.exports={supplierMaterialInfo,mergeStructuredSupplierFacts,validateSupplierFacts,buildPayload,manualSupplierFacts};
