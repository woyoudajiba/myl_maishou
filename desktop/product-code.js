const REGIONS=Object.freeze({GZ:'广州',QZ:'泉州 / 石狮',CS:'常熟',JX:'嘉兴'});
function parseProductCode(value){
  const raw=String(value??'').trim().normalize('NFKC'),parts=raw.split('-').map(part=>part.trim());
  if(parts.length<4)return null;
  const regionCode=parts.shift().toUpperCase(),articleNo=parts.pop(),supplierAbbr=parts.pop(),category=parts.join('-');
  if(!REGIONS[regionCode]||!category||!supplierAbbr||!articleNo||!/^[A-Z0-9]+$/.test(supplierAbbr)||!/^[\p{L}\p{N}][\p{L}\p{N}._/]*$/u.test(articleNo))return null;
  return{raw,regionCode,region:REGIONS[regionCode],category,supplierAbbr:supplierAbbr.toUpperCase(),articleNo};
}
function inferSupplierRegion(value){
  const text=String(value??'');
  if(/广州|广东/.test(text))return{regionCode:'GZ',region:REGIONS.GZ};
  if(/泉州|石狮|晋江/.test(text))return{regionCode:'QZ',region:REGIONS.QZ};
  if(/常熟/.test(text))return{regionCode:'CS',region:REGIONS.CS};
  if(/嘉兴/.test(text))return{regionCode:'JX',region:REGIONS.JX};
  return null;
}
function buildSupplierCodeContext({origin={},facts={},details={},supplier={}}={}){
  const sourceCode=parseProductCode(origin.externalCode||origin.supplierProductNo||'');
  const region=sourceCode||inferSupplierRegion([details.address,details.visibleText,details.description].filter(Boolean).join(' '));
  const supplierAbbr=String(sourceCode?.supplierAbbr||supplier.supplierAb||supplier.supplierAbbreviation||supplier.abbreviation||supplier.code||'').trim().toUpperCase();
  const category=String(sourceCode?.category||facts.categoryName||facts.productTypeName||'').trim();
  const articleNo=String(facts.articleNo||details.sku||'').trim();
  return{productCode:region&&category&&supplierAbbr&&articleNo?[region.regionCode,category,supplierAbbr,articleNo].join('-'):'',regionCode:region?.regionCode||'',region:region?.region||'',category,supplierAbbr,articleNo};
}
module.exports={REGIONS,parseProductCode,inferSupplierRegion,buildSupplierCodeContext};
