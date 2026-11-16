// Adapted from gggann/image_search_taobao (MIT). See THIRD_PARTY_NOTICES.md.
(() => {
  const endpoint = 'https://h5api.m.taobao.com/h5/mtop.relationrecommend.wirelessrecommend.recommend/2.0/';
  const appKey = '12574478';
  const ruleId = 6401;
  let queue = Promise.resolve();
  function verificationUrl(value) {
    if(typeof value!=='string'||!value||value.length>8192)return '';
    try {const url=new URL(value,endpoint);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&/(^|\.)(?:taobao|tmall)\.com$/i.test(url.hostname)?url.href:'';}catch{return '';}
  }
  function verificationRequired(value) {
    const error=new Error('淘宝图搜触发安全验证，请打开验证页处理后继续原任务；首页已登录不代表图搜验证已通过');
    error.code='TAOBAO_VERIFICATION_REQUIRED';
    // Challenge links may contain temporary signatures. Keep them out of logs,
    // JSON exports and desktop persistence; only the extension opens the link.
    Object.defineProperty(error,'verificationUrl',{value:verificationUrl(value)});
    return error;
  }

  function md5(value) {
    const bytes = new TextEncoder().encode(String(value));
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const data = new Uint8Array(paddedLength);
    data.set(bytes); data[bytes.length] = 0x80;
    const view = new DataView(data.buffer);
    const bitLength = bytes.length * 8;
    view.setUint32(paddedLength - 8, bitLength >>> 0, true);
    view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);
    const shifts = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    const constants = Array.from({length:64},(_,index)=>Math.floor(Math.abs(Math.sin(index+1))*0x100000000));
    let a0=0x67452301,b0=0xefcdab89,c0=0x98badcfe,d0=0x10325476;
    const rotate=(number,count)=>(number<<count)|(number>>>(32-count));
    for(let offset=0;offset<paddedLength;offset+=64){
      const words=Array.from({length:16},(_,index)=>view.getUint32(offset+index*4,true));
      let a=a0,b=b0,c=c0,d=d0;
      for(let index=0;index<64;index++){
        let f,g;
        if(index<16){f=(b&c)|(~b&d);g=index;}
        else if(index<32){f=(d&b)|(~d&c);g=(5*index+1)%16;}
        else if(index<48){f=b^c^d;g=(3*index+5)%16;}
        else{f=c^(b|~d);g=(7*index)%16;}
        const next=d;d=c;c=b;b=(b+rotate((a+f+constants[index]+words[g])|0,shifts[index]))|0;a=next;
      }
      a0=(a0+a)|0;b0=(b0+b)|0;c0=(c0+c)|0;d0=(d0+d)|0;
    }
    return [a0,b0,c0,d0].map(word=>Array.from({length:4},(_,i)=>((word>>>(8*i))&255).toString(16).padStart(2,'0')).join('')).join('');
  }
  const base64 = bytes => { let binary=''; for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000)); return btoa(binary); };
  async function digestSign(text) { return base64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))); }
  function cookieList(query) { return new Promise((resolve,reject)=>chrome.cookies.getAll(query,cookies=>{const error=chrome.runtime.lastError;if(error)reject(new Error(error.message));else resolve(cookies||[]);})); }
  async function cookies() {
    const results=[];
    results.push(...await cookieList({url:'https://h5api.m.taobao.com'}));
    if(!results.some(cookie=>cookie.name==='_m_h5_tk'&&cookie.value))for(const query of [{url:'https://h5api.m.taobao.com',partitionKey:{topLevelSite:'https://taobao.com'}},{url:'https://h5api.m.taobao.com',partitionKey:{topLevelSite:'https://www.taobao.com'}}])try{const found=await cookieList(query);if(found.some(cookie=>cookie.name==='_m_h5_tk'&&cookie.value)){results.splice(0,results.length,...found);break;}}catch{}
    const unique=new Map();
    for(const cookie of results)if(/(^|\.)taobao\.com$/i.test(cookie.domain||'')&&(!unique.has(cookie.name)||cookie.partitionKey))unique.set(cookie.name,cookie);
    return [...unique.values()];
  }
  async function updateRules(options) { await new Promise((resolve,reject)=>chrome.declarativeNetRequest.updateSessionRules(options,()=>{const error=chrome.runtime.lastError;if(error)reject(new Error('淘宝请求环境未就绪，请重新加载插件'));else resolve();})); }
  function parse(text) { const trimmed=String(text||'').trim();return JSON.parse(trimmed.startsWith('{')?trimmed:trimmed.replace(/^[^(]*\(/,'').replace(/\);?$/,'')); }
  async function resize(imageData) {
    const response=await fetch(imageData),bitmap=await createImageBitmap(await response.blob()),size=300,scale=Math.min(1,size/Math.max(bitmap.width,bitmap.height));
    const canvas=new OffscreenCanvas(Math.max(1,Math.round(bitmap.width*scale)),Math.max(1,Math.round(bitmap.height*scale)));
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close?.();
    return `data:image/jpeg;base64,${base64(new Uint8Array(await (await canvas.convertToBlob({type:'image/jpeg',quality:.8})).arrayBuffer()))}`;
  }
  function candidate(item) {
    try {
    const id=String(item.item_id||item.itemId||item.nid||'');if(!/^\d{5,25}$/.test(id))return null;
    const detail=new URL(item.auctionUrl||`https://item.taobao.com/item.htm?id=${id}`,'https://item.taobao.com');
    if(!['http:','https:'].includes(detail.protocol)||detail.username||detail.password||detail.port||!['item.taobao.com','detail.tmall.com'].includes(detail.hostname)||!/^(?:\/item\.htm)?$/.test(detail.pathname)||detail.searchParams.get('id')!==id)return null;
    const rawImage=String(item.pic_path||item.picUrl||'');let imageUrl='';
    try{const image=new URL(rawImage.startsWith('//')?'https:'+rawImage:rawImage);if(image.protocol==='https:'&&!image.username&&!image.password&&!image.port&&/(^|\.)(?:alicdn\.com|taobaocdn\.com|tbcdn\.cn)$/.test(image.hostname))imageUrl=image.href;}catch{}
    if(!imageUrl)return null;
    const price=Number(item.umpPriceLog?.item_price||item.priceShow?.price||item.priceWap||'');
    return {id,title:String(item.title||'').slice(0,1000),detailUrl:`https://${detail.hostname}/item.htm?id=${id}`,imageUrl,price:Number.isFinite(price)&&price>0?price:null,...TaobaoSales.fields(item),shopName:String(item.shopInfo?.title||'').slice(0,300),location:String(item.procity||'').slice(0,120)};
    } catch { return null; }
  }
  async function perform(imageData) {
    const resized=await resize(imageData),params={m:'pc_picture_search',device:'HMA-AL00',isBeta:'false',grayHair:'false',from:'nt_history',brand:'HUAWEI',info:'wifi',index:'4',rainbow:'',schemaType:'auction',elderHome:'false',isEnterSrpSearch:'true',newSearch:'false',network:'wifi',subtype:'',hasPreposeFilter:'false',prepositionVersion:'v2',client_os:'Android',gpsEnabled:'false',searchDoorFrom:'srp',debug_rerankNewOpenCard:'false',homePageVersion:'v7',searchElderHomeOpen:'false',search_action:'initiative',sugg:'_4_1',sversion:'13.6',style:'list',ttid:'1@tbwang_mac_1.0.0#pc',needTabs:'true',areaCode:'CN',vm:'nw',countryNum:'156',page:1,n:48,q:'',qSource:'manual',pageSource:'a21bo.jianhua/a.201856.dimagesearch',myCNA:'',tab:'all',sort:'_coefp',filterTag:'',service:'',prop:'',loc:'',start_price:null,end_price:null,startPrice:null,endPrice:null,categoryp:'',pageSize:60,strimg:resized.slice(resized.indexOf(',')+1),imgFrom:'upload',pageFrom:'a21n57.imgsearch'};
    const random=base64(crypto.getRandomValues(new Uint8Array(32))),timestamp=String(Date.now()),security={pageFrom:'a21n57.imgsearch',imgFrom:'upload',random,timestamp};
    params.pcSign=await digestSign(JSON.stringify(security)+'6dbd0668a0634ae9badd25d3da236f47');params.random=random;params.timestamp=timestamp;
    const body={appId:'46006',params:JSON.stringify(params)},bodyText=JSON.stringify(body);
    // The official H5 SDK lets an initial TOKEN_EMPTY response establish the
    // signing cookie. A missing signing token alone does not prove logout.
    for(let attempt=0;attempt<2;attempt++){
    const rawCookies=await cookies(),tokenCookie=rawCookies.find(item=>item.name==='_m_h5_tk'&&item.value);
    let token;try{token=tokenCookie?decodeURIComponent(tokenCookie.value).split('_')[0]:undefined;}catch{token=tokenCookie.value.split('_')[0];}
    const requestTime=String(Date.now());
    const searchUrl=endpoint+'?'+new URLSearchParams({jsv:'2.7.4',appKey,t:requestTime,sign:md5(`${token}&${requestTime}&${appKey}&${bodyText}`),api:'mtop.relationrecommend.wirelessrecommend.recommend',v:'2.0',timeout:'10000',type:'originaljson',dataType:'jsonp'});
    const requestHeaders=[{header:'Referer',operation:'set',value:'https://s.taobao.com/search/'},{header:'Origin',operation:'set',value:'https://s.taobao.com'}];
    if(tokenCookie?.partitionKey)requestHeaders.push({header:'Cookie',operation:'set',value:rawCookies.map(cookie=>`${cookie.name}=${cookie.value}`).join('; ')});
    await updateRules({removeRuleIds:[ruleId],addRules:[{id:ruleId,priority:1,action:{type:'modifyHeaders',requestHeaders},condition:{regexFilter:'^https://h5api\\.m\\.taobao\\.com/h5/mtop\\.relationrecommend\\.wirelessrecommend\\.recommend/.*',resourceTypes:['xmlhttprequest'],initiatorDomains:[chrome.runtime.id]}}]});
    try {
      const response=await fetch(searchUrl,{method:'POST',credentials:'include',cache:'no-store',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:new URLSearchParams({data:bodyText}).toString(),signal:AbortSignal.timeout(20000)});
      if(Number(response.headers?.get('content-length'))>5*1024*1024){await response.body?.cancel();throw new Error('淘宝图搜响应过大，已停止本次搜索');}
      let text='';
      if(response.body?.getReader){const reader=response.body.getReader(),decoder=new TextDecoder();let bytes=0;try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>5*1024*1024){await reader.cancel();throw new Error('淘宝图搜响应过大，已停止本次搜索');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}}
      else text=await response.text();
      if(text.length>5*1024*1024)throw new Error('淘宝图搜响应过大，已停止本次搜索');
      let result;try{result=parse(text);}catch{if(/punish|_____tmd_____|validate/i.test(response.url||'')&&verificationUrl(response.url))throw verificationRequired(response.url);throw new Error(`淘宝接口返回 HTTP ${response.status}，请检查登录或稍后重试`);}
      const ret=Array.isArray(result?.ret)?result.ret.join('; '):'';
      const securityBlocked=/RGV587|USER_VALIDATE|punish|_____tmd_____/i.test(ret+' '+(result?.data?.url||''));
      if(securityBlocked)throw verificationRequired(result?.data?.url);
      if(/DENY|DENIED/i.test(ret))throw new Error('淘宝图搜访问被拒绝，接口没有明确返回验证要求；请在淘宝搜图页检查权限或稍后重试');
      const tokenRejected=/FAIL_SYS_TOKEN_(?:EMPTY|EXOIRED|EXPIRED)/i.test(ret);
      if(response.ok&&tokenRejected){
        if(attempt===0){const refreshed=await cookies(),next=refreshed.find(item=>item.name==='_m_h5_tk'&&item.value);if(next?.value&&next.value!==tokenCookie?.value)continue;}
        throw new Error('淘宝图搜接口令牌未就绪或未能刷新，不能据此判断账号未登录；请在装有插件的同一浏览器资料中打开淘宝搜同款页面后重试，仍失败请检查 Cookie 权限或浏览器资料是否一致');
      }
      if(!response.ok||/FAIL|ERROR|ILLEGAL|SESSION_EXPIRED/i.test(ret))throw new Error(/SESSION_EXPIRED|LOGIN/i.test(ret)?'淘宝图搜接口返回登录失效，请在插件所在的同一浏览器资料重新登录后重试':`淘宝图搜暂不可用${ret.match(/^[A-Z][A-Z0-9_]{2,80}/)?.[0]?`（${ret.match(/^[A-Z][A-Z0-9_]{2,80}/)[0]}）`:''}`);
      const values=Array.isArray(result?.data?.itemsArray)?result.data.itemsArray:Array.isArray(result?.data?.data?.itemsArray)?result.data.data.itemsArray:null;
      if(!values)throw new Error('淘宝未返回同款候选，请确认登录状态或稍后重试');
      const seen=new Set();return TaobaoSales.sort(values.slice(0,120).map(candidate).filter(item=>item&&!seen.has(item.id)&&seen.add(item.id))).slice(0,60);
    } catch(error) {
      if(error?.name==='TimeoutError'||error?.name==='AbortError')throw new Error('淘宝图搜等待超过20秒，请稍后重试');
      throw error;
    } finally { await updateRules({removeRuleIds:[ruleId]}).catch(()=>{}); }
    }
  }
  function search(imageData) {
    if(typeof imageData!=='string'||imageData.length>6*1024*1024||!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageData))return Promise.reject(new Error('淘宝搜索图片数据无效'));
    const operation=queue.catch(()=>{}).then(()=>perform(imageData));
    queue=operation.catch(()=>{});
    return operation;
  }
  globalThis.FindTaobaoImageSearch=Object.freeze({search,md5});
})();
