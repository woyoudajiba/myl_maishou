const sourceHosts={image:[],douyin:['douyin.com','jinritemai.com'],taobao:['taobao.com','tmall.com'],wsy:['wsy.com'],zwd:['17zwd.com'],qcc:['17qcc.com'],e3hui:['e3hui.com','e3hui.cn']};

function validSourceUrl(value,type){
  if(type==='image')return '';
  try{
    const url=new URL(String(value||'').trim());
    if(url.protocol!=='https:'||url.username||url.password||url.port||!(sourceHosts[type]||[]).some(domain=>url.hostname===domain||url.hostname.endsWith('.'+domain)))return '';
    if(type==='taobao'&&(!['item.taobao.com','detail.tmall.com'].includes(url.hostname)||url.pathname!=='/item.htm'||!/^\d{5,25}$/.test(url.searchParams.get('id')||'')))return '';
    return url.href;
  }catch{return '';}
}
function sourceLink(value){
  try{
    const u=new URL(String(value||'').trim());
    const type=Object.keys(sourceHosts).find(key=>validSourceUrl(u.href,key));
    if(!type)return null;
    if(type==='taobao')return{sourceType:type,sourceUrl:`${u.origin}/item.htm?id=${u.searchParams.get('id')}`};
    u.hash='';for(const key of [...u.searchParams.keys()])if(/^(spm|utm_|from$|track|scm)/i.test(key))u.searchParams.delete(key);
    return{sourceType:type,sourceUrl:u.href};
  }catch{return null;}
}
// Share messages use a literal URL followed by punctuation or Chinese copy.
// Percent-encoded URL paths and parameters stay intact.
const links=text=>[...new Set((String(text||'').match(/https:\/\/[^\s<>"'`\u3000-\u303f\u3400-\u9fff\uff00-\uffef\[\]{}()]+/gi)||[]).map(value=>value.replace(/[.,;!?]+$/,'')))];
const sourceLinks=text=>[...new Map(links(text).map(sourceLink).filter(Boolean).map(link=>[link.sourceUrl,link])).values()];
function normalizeSourceInput(input={}){
  if(!Object.hasOwn(input,'sourceUrl'))return input;
  const found=sourceLinks(input.sourceUrl);
  if(found.length>1)throw new Error('同一行有多个商品链接，请拆行后保存');
  return found.length?{...input,...found[0]}:input;
}
module.exports={sourceHosts,validSourceUrl,sourceLink,links,sourceLinks,normalizeSourceInput};
