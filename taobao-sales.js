(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.TaobaoSales=api;
})(globalThis,function(){
  // Keep the source wording (including period and '+'); the number is only a
  // sorting key, not an exact sales claim or a visual-match signal.
  function count(value){
    if(typeof value==='number')return Number.isFinite(value)&&value>=0?value:null;
    if(typeof value!=='string')return null;
    const text=value.trim().replace(/,/g,'').replace(/^(?:月销(?:量)?|总销(?:量)?|已售|销量|已付款)\s*[:：]?\s*/,'');
    if(!text||/暂无|未知|未采集|无数据/.test(text))return null;
    const match=text.match(/(?:^|[\s:：])([0-9]+(?:\.[0-9]+)?)\s*(亿|万|千)?\s*\+?\s*(?:人付款|人支付|人收货|人已买|人买过|件|笔|人|已售|已付款)?\s*$/)
      ||text.match(/([0-9]+(?:\.[0-9]+)?)\s*(亿|万|千)?\s*\+?\s*(?:人付款|人支付|人收货|人已买|人买过|件|笔)/);
    if(!match)return null;
    const number=Number(match[1])*({亿:100000000,万:10000,千:1000}[match[2]]||1);
    return Number.isFinite(number)&&number>=0?number:null;
  }
  function fields(item={}){
    const raw=[item.salesText,item.realSales,item.salesCount,item.saleCount,item.sales,item.payCount]
      .find(value=>(typeof value==='string'&&value.trim())||(typeof value==='number'&&Number.isFinite(value)&&value>=0));
    const salesText=raw==null?'':String(raw).trim().slice(0,200);
    return{salesText,salesCount:count(salesText)};
  }
  function compare(a,b){
    const left=fields(a).salesCount,right=fields(b).salesCount;
    return left===right?0:left===null?1:right===null?-1:right-left;
  }
  const sort=items=>[...items].sort(compare);
  const label=item=>fields(item).salesText||'未采集';
  return{count,fields,compare,sort,label};
});
