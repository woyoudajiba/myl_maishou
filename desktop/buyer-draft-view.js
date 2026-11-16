function parseObject(value){
  if(value&&typeof value==='object'&&!Array.isArray(value))return value;
  if(typeof value==='string'&&value.length<=2*1024*1024)try{const parsed=JSON.parse(value);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))return parsed;}catch{}
  return{};
}
function text(value,limit=500){return typeof value==='string'?value.slice(0,limit):value==null?'':String(value).slice(0,limit);}
function strings(value){if(Array.isArray(value))return value.flatMap(item=>typeof item==='string'?[item]:[]).slice(0,100);if(typeof value==='string')return value.split(',').map(item=>item.trim()).filter(Boolean).slice(0,100);return[];}
function first(value){return Array.isArray(value)?value[0]:typeof value==='string'?value.split(',')[0]:'';}
function safeImage(value){try{const url=new URL(String(value||'')),host=url.hostname.toLowerCase(),allowed=['wsy.com','17qcc.com','17zwd.com','e3hui.com','e3hui.cn','ximgs.net','alicdn.com','taobaocdn.com','tbcdn.cn','ecombdimg.com','byteimg.com','douyinpic.com','aliyuncs.com','wsfile.cn'];return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&allowed.some(domain=>host===domain||host.endsWith('.'+domain))?url.href:'';}catch{return'';}}
function draftSource(value){const row=parseObject(value);return{...parseObject(row.draftData),...parseObject(row.productData),...row};}
function normalizeDraftListItem(value){
  const row=draftSource(value),id=text(row.id??row.draftId,64);
  if(!/^\d+$/.test(id))return null;
  const draftState=row.draftState??row.status;
  const publicPics=parseObject(row.publicPicInfo);
  return{id,draftVersion:Number(row.draftVersion??row.revision)||0,draftState:['DRAFT','CONVERTED'].includes(draftState)?draftState:'UNKNOWN',articleNo:text(row.articleNo,160),productName:text(row.productName,400),productTypeName:text(row.productTypeName,160),supplierName:text(row.supplierName,240),storeHouse:text(row.storeHouse,160),talkCost:row.talkCost??null,platformPrice:row.platformPrice??null,createTime:row.createTime??row.createdAt??null,mainImage:safeImage(first(row.mainPic)||first(row.suitPicInfo?.[0]?.mainPic)||first(publicPics.mainPic11))};
}
function normalizeDraftDetail(value){
  const row=draftSource(value?.draft??value),attributes=parseObject(value?.attributes),id=text(row.id??row.draftId,64);
  if(!/^\d+$/.test(id))throw new Error('草稿详情编号无效');
  const draftState=row.draftState??row.status;
  const suitRows=Array.isArray(row.suitPicInfo)?row.suitPicInfo:[],publicPics=parseObject(row.publicPicInfo),images=[];
  const add=value=>{for(const url of strings(value)){const safe=safeImage(url);if(safe&&!images.includes(safe))images.push(safe);}};
  for(const suit of suitRows){add(suit?.mainPic);add(suit?.suitPic);add(suit?.colorPic);}
  for(const key of ['mainPic11','mainPic34','detailPic','shoppingPic','colorPic']){add(publicPics[key]);add(attributes[key]);}
  const pictureData=value?.pictures?.data??value?.pictures;
  const pictureRows=Array.isArray(pictureData)?pictureData:Array.isArray(pictureData?.list)?pictureData.list:[];
  for(const pic of pictureRows){add(pic?.mainPic);add(pic?.colorPic);add(pic?.suitPic);add(pic?.mainPic11);add(pic?.mainPic34);add(pic?.detailPic);add(pic?.shoppingPic);add(pic?.url);add(pic?.imageUrl);}
  const attrs=parseObject(attributes.extendedAttributes||row.extendedAttributes);
  const sizes=Array.isArray(attributes.sizeList)?attributes.sizeList:Array.isArray(row.sizeList)?row.sizeList:[];
  const materials=strings(row.material),rates=strings(row.materialRate);
  return{
    id,draftVersion:Number(row.draftVersion??row.revision)||0,draftState:['DRAFT','CONVERTED'].includes(draftState)?draftState:'UNKNOWN',
    productName:text(row.productName,400),articleNo:text(row.articleNo,160),productTypeName:text(row.productTypeName,160),supplierName:text(row.supplierName,240),supplierAb:text(row.supplierAb,100),storeHouse:text(row.storeHouse,160),
    talkCost:row.talkCost??null,platformPrice:row.platformPrice??null,supplyCycle:row.supplyCycle??null,colors:strings(row.colors),colorRemarks:strings(attributes.colorRemark??row.colorRemark),sizeCategory:strings(row.sizeCategory),materials:materials.map((name,index)=>({name,rate:rates[index]||''})),
    extendedAttributes:attrs,sizeList:sizes.slice(0,80).map(item=>({size:text(item?.size,80),height:text(item?.height,80),weight:text(item?.weight,80),remark:text(item?.remark,160)})),
    suitPictures:suitRows.slice(0,40).map(item=>({mainPic:safeImage(item?.mainPic),suitPic:safeImage(item?.suitPic),remark:text(item?.remark,300),mainPicSource:text(item?.mainPicSource,100)})),
    images:images.slice(0,100),convertedProductId:text(row.convertedProductId,64)
  };
}
module.exports={safeImage,normalizeDraftListItem,normalizeDraftDetail};
