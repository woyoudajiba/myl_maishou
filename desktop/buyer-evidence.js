const text=value=>String(value??'').trim();
const array=value=>Array.isArray(value)?value:[];
function validateSupplierFacts(result,details){
  const document=[details.visibleText,details.description,...array(details.attributes)].join('\n').replace(/\s+/g,'');
  const supported=key=>{const evidence=result.evidence?.[key],quote=text(typeof evidence==='object'?evidence?.quote:evidence).replace(/\s+/g,'');const imageEvidence=evidence&&typeof evidence==='object'&&Number.isInteger(evidence.imageIndex)&&evidence.imageIndex>=0&&evidence.imageIndex<Math.min(3,array(details.images).length)&&array(result.verifiedOcrFields).includes(key);return quote.length>=2&&(document.includes(quote)||imageEvidence);};
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
  const sizeQuote=quote('sizes'),range=sizeQuote.match(/(XS|S|M|L|XL|[2-8]XL)\s*(?:-|~|～|到|至)\s*(XS|S|M|L|XL|[2-8]XL)/i),order=['XS','S','M','L','XL','2XL','3XL','4XL','5XL','6XL','7XL','8XL'];
  const expanded=range?order.slice(order.indexOf(range[1].toUpperCase()),order.indexOf(range[2].toUpperCase())+1):[];
  const sizes=supported('sizes')?array(result.sizes).map(text).filter(value=>value&&(sizeQuote.includes(value)||expanded.includes(value.toUpperCase()))):[];
  const materials=supported('materials')?array(result.materials).filter(row=>row&&typeof row.name==='string'&&quote('materials').includes(row.name)&&Number.isFinite(row.rate)&&row.rate>=0&&row.rate<=100&&(quote('materials').match(/\d+(?:\.\d+)?/g)||[]).some(value=>Number(value)===row.rate)):[];
  if(!colors.length)missing.push('供应商可供颜色');if(!sizes.length)missing.push('供应商尺码范围');
  if(!materials.length||Math.abs(materials.reduce((sum,row)=>sum+row.rate,0)-100)>0.01)missing.push('供应商成分及比例');
  const images=array(details.images),sizePic=Number.isInteger(result.sizeImageIndex)&&images[result.sizeImageIndex]?images[result.sizeImageIndex]:'';
  if(!sizePic)missing.push('供应商尺码图');
  if(![0,1].includes(result.fork))missing.push('公版或专版依据');
  const variant=text(result.variant),requiresQc=/(羽绒|冲锋衣|防晒衣)/.test([result.categoryName,details.title].join(' '));
  if(requiresQc)missing.push('对应类别的真实质检报告与洗水唛');
  if(result.priceConflict===true)missing.push('不同规格供货价需确认');
  return{articleNo,supplierName,cost,colors:[...new Set(colors)],sizes:[...new Set(sizes)],materials,sizePic,fork:result.fork,variant,warehouse:text(result.warehouse),categoryName:text(result.categoryName),evidence:result.evidence||{},missing};
}
function buildPayload({mapping,facts,source,marketplace,collection,catalog,controls,settings,supplier,colors}){
  const missing=[];const category=catalog.categories.find(row=>row.categoryName===mapping.productTypeName&&row.status===1);
  if(facts.articleNo&&!/^[A-Za-z0-9/]+$/.test(facts.articleNo))missing.push('当前互拓货号契约仅接受字母、数字和 /；原始中文货号已保留，需确认ERP支持后再提交');
  if(!category)missing.push('有效互拓类别');
  const dict=(type,value,mode='label')=>{const matches=catalog.dictionaries.filter(row=>row.dictType===type&&(row.label===value||String(row.value)===value));return matches.length===1?String(matches[0][mode]):'';};
  const rowColors=facts.colors.map(name=>{const matches=colors.filter(row=>row.colorName===name&&row.colorStatus===1&&row.colorId);if(matches.length!==1)missing.push(`颜色库未匹配：${name}`);return matches[0]||{};});
  const raw=collection.rawPrefill||{},collectionColors=array(collection.colors).map(row=>row.name),collectionSizes=array(collection.sizes).map(row=>typeof row==='string'?row:row.name||row.size||'');
  const keptColors=collectionColors.length?facts.colors.filter(name=>collectionColors.includes(name)):facts.colors;
  const keptSizes=collectionSizes.length?facts.sizes.filter(name=>collectionSizes.includes(name)):facts.sizes;
  if(!keptColors.length)missing.push('供应商与套图颜色无交集');if(!keptSizes.length)missing.push('供应商与套图尺码无交集');
  const omittedColors=collectionColors.filter(name=>!facts.colors.includes(name)),omittedSizes=collectionSizes.filter(name=>!facts.sizes.includes(name));
  const remarks=[marketplace.salesText,omittedColors.length?'供应商不供颜色：'+omittedColors.join('、'):'',omittedSizes.length?'供应商不供尺码：'+omittedSizes.join('、'):'',facts.variant].filter(Boolean).join('；');
  const fieldConfig={...(controls?.[0]?.control||{}),...(controls?.[1]?.control||{})};
  const area=controls?.[0]?.category?.[category?.categoryName]||{},fieldNames=new Set(Object.values(area).flat().filter(value=>typeof value==='string'));
  for(const key of Object.keys(controls?.[1]?.control||{}))fieldNames.add(key);
  const attributes={};
  for(const key of fieldNames){const rule=fieldConfig[key];if(!rule)continue;const value=mapping.extendedAttributes?.[key];const options=array(rule.option).map(option=>typeof option==='string'?option:String(option.value??option.label??''));
    if(key==='品牌'&&facts.fork===0)continue;
    const values=Array.isArray(value)?value:[value],multi=['multi_select','material_select','checkbox'].includes(rule.type);
    const allowedImages=new Set([...array(source.images),...array(collection.images),facts.sizePic]);
    const shape=multi?Array.isArray(value):typeof value==='string';
    if(value!==undefined&&shape&&values.every(item=>typeof item==='string'&&(!options.length||options.includes(item)))&&(rule.type!=='image'||allowedImages.has(value)))attributes[key]=value;
    if(Number(rule.required)===1&&(attributes[key]===undefined||attributes[key]===''||Array.isArray(attributes[key])&&!attributes[key].length))missing.push('类别必填：'+key);
  }
  const warehouse=dict('warehouse_infos',facts.warehouse||mapping.storeHouse,'value');
  const buyer=settings.buyerName||catalog.permissions?.user?.nickname||catalog.permissions?.user?.name||'';
  const sizeType=['通用码','数值码','国际码'].includes(mapping.sizeType)?mapping.sizeType:'';
  const sizeDict={'通用码':'universal_code','数值码':'numerical_code','国际码':'international_code'}[sizeType];
  for(const size of keptSizes)if(!dict(sizeDict,size))missing.push('尺码字典不匹配：'+size);
  const originalSuit=array(raw.suit_pic_info||raw.suitPicInfo)[0]||{};
  const sourceLabel=dict('suit_pic_source',new URL(marketplace.url).hostname==='detail.tmall.com'?'天猫链接':'淘宝链接')||dict('suit_pic_source','其他平台链接');
  const payload={articleNo:facts.articleNo,productType:category?.categoryAb||'',productTypeName:category?.categoryName||'',storeHouse:warehouse,supplierName:supplier?.supplierName||'',supplierAb:supplier?.supplierAb||'',pallet:settings.pallet||dict('pallet_infos',mapping.pallet),company:settings.company,buyerName:buyer,talkCost:facts.cost,supplyCycle:settings.supplyCycle,industry:dict('industry',mapping.industry),season:dict('season',mapping.season),technology:dict('technology_infos',mapping.technology),style:dict('product_style',mapping.style),ageState:array(mapping.ageState).map(value=>dict('ages',value,'value')).filter(Boolean).join(','),fork:facts.fork,colors:keptColors,colorNo:keptColors.map(name=>rowColors[facts.colors.indexOf(name)]?.colorId||''),colorPic:keptColors.map(name=>collection.colors?.find(row=>row.name===name)?.image||''),colorRemark:keptColors.map(()=>''),sizeType,sizeCategory:keptSizes,sizePic:facts.sizePic,sizeList:keptSizes.map(size=>({size,height:'',weight:'',remark:''})),material:facts.materials.map(row=>row.name),materialRate:facts.materials.map(row=>String(row.rate)),materialRemark:'',standardScore:[],extendedAttributes:attributes,suitPicInfo:[{...originalSuit,firstPic:1,mainPic:source.images?.[0]||collection.images?.[0]||'',mainPicSource:sourceLabel,picBuyerName:buyer,picState:1,recommend:0,remark:remarks,suitPic:marketplace.url,documenter:buyer}],publicPicInfo:{mainPic11:array(collection.images)[0]||'',mainPic34:'',background:'',shoppingPic:'',detailPic:array(collection.images).slice(1).join(','),mainVideo:''}};
  if(facts.fork===1&&!attributes['品牌'])missing.push('专版品牌');
  for(const material of payload.material)if(!dict('material_composition',material))missing.push('材质字典不匹配：'+material);
  const scope=String(category?.processScope||'').trim();
  if(scope&&scope!=='[]'){
    const groups=scope.split('*');
    if(groups.length>20||groups.some(group=>!group.includes('^')||!group.includes('|')))missing.push('类别评分规则结构需核验');
    else payload.standardScore=groups.map(group=>group.split('|').slice(1).map(()=> '0'));
  }
  // Company is optional. Do not invent one from the catalog or stop a buyer
  // who has not supplied it; the ERP account controls its own company scope.
  if(!settings.company)delete payload.company;
  return{payload,missing:[...new Set(missing)],evidence:{supplier:facts.evidence,sourceUrl:source.url,marketplace:marketplace.url,scoringBasis:'document_business_default_zero'}};
}
function manualSupplierFacts(input,previous,details){
  const articleNo=text(input.articleNo),supplierName=text(input.supplierName),cost=Number(input.cost),colors=array(input.colors).map(text).filter(Boolean),sizes=array(input.sizes).map(text).filter(Boolean),materials=array(input.materials).map(row=>({name:text(row?.name),rate:Number(row?.rate)}));
  if(!/^[\p{L}\p{N}][\p{L}\p{N}._/-]{0,63}$/u.test(articleNo)||!supplierName||supplierName.length>300)throw new Error('请填写有效的供应商货号和名称');
  if(!Number.isFinite(cost)||cost<=0||cost>1000)throw new Error('供货价须大于0且不超过1000');
  if(!colors.length||colors.length>60||colors.some(value=>value.length>100)||!sizes.length||sizes.length>60||sizes.some(value=>value.length>100))throw new Error('请填写供应商可供颜色和尺码');
  if(!materials.length||materials.length>20||materials.some(row=>!row.name||!Number.isFinite(row.rate)||row.rate<=0||row.rate>100)||Math.abs(materials.reduce((sum,row)=>sum+row.rate,0)-100)>0.01)throw new Error('成分与比例须合计100%');
  const index=Number(input.sizeImageIndex),sizePic=Number.isInteger(index)?details.images?.[index]:'';
  if(!sizePic)throw new Error('请从已采集的供应商图片中选择尺码图');
  if(![0,1].includes(input.fork))throw new Error('请选择公版或专版');
  const missing=[];if(/羽绒|冲锋衣|防晒衣/.test([previous?.categoryName,details.title].join(' ')))missing.push('对应类别的真实质检报告与洗水唛');
  return{...previous,articleNo,supplierName,cost,colors,sizes,materials,sizePic,fork:input.fork,warehouse:text(input.warehouse),missing,evidence:{...previous?.evidence,manual:{at:new Date().toISOString(),fields:['articleNo','supplierName','cost','colors','sizes','materials','sizePic','fork','warehouse']}}};
}
module.exports={validateSupplierFacts,buildPayload,manualSupplierFacts};
