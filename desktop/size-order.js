(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SizeOrder=api;
})(globalThis,function(){
  function sizeKey(value){
    const key=String(value??'').trim().normalize('NFKC').toUpperCase().replace(/\s+/g,'');
    if(/^(?:XXS|2XS)(?:\((?:XXS|2XS)\))?$/.test(key))return 'XXS';
    if(/^X{2,8}L$/.test(key))return `${key.length-1}XL`;
    return key;
  }
  function sizeRank(value){
    const key=sizeKey(value),basic=['XXS','XS','S','M','L','XL'].indexOf(key);
    if(basic>=0)return basic;
    const large=key.match(/^([2-9]|[1-9]\d)XL$/);
    return large?Number(large[1])+4:Infinity;
  }
  function sortSizes(values){
    const seen=new Set();
    return(Array.isArray(values)?values:[]).map((value,index)=>({value:String(value??'').trim(),index})).filter(row=>{
      const key=sizeKey(row.value);if(!key||seen.has(key))return false;seen.add(key);return true;
    }).sort((a,b)=>{const left=sizeRank(a.value),right=sizeRank(b.value);return left===right?a.index-b.index:left<right?-1:1;}).map(row=>row.value);
  }
  return{sizeKey,sizeRank,sortSizes};
});
