(function(root){
  function scrapeBuyerPage(input={}){
    const supplierPlatforms=new Set(['wsy','zwd','qcc','e3hui']);
    const imageHosts=['wsy.com','17qcc.com','17zwd.com','e3hui.com','e3hui.cn','ximgs.net','alicdn.com','taobaocdn.com','tbcdn.cn','ecombdimg.com','byteimg.com','douyinpic.com'];
    const hostMap={taobao:['taobao.com','tmall.com'],douyin:['douyin.com','jinritemai.com'],wsy:['wsy.com'],zwd:['17zwd.com'],qcc:['17qcc.com'],e3hui:['e3hui.com','e3hui.cn']};
    const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
    const unique=values=>[...new Set(values.map(clean).filter(Boolean))];
    const visible=node=>!!node&&(node.offsetWidth||node.offsetHeight||node.getClientRects().length)>0&&getComputedStyle(node).visibility!=='hidden';
    const read=node=>clean(node?.innerText||node?.textContent);
    const firstText=selectors=>{for(const selector of selectors){const value=read(document.querySelector(selector));if(value)return value;}return '';};
    const validHost=(host,domains)=>(domains||[]).some(domain=>host===domain||host.endsWith('.'+domain));
    const safeImage=(value,platform)=>{
      if(typeof value!=='string'||!value||value.length>4096)return'';
      try{const url=new URL(value,location.href);if(platform==='e3hui'&&url.protocol==='http:'&&url.hostname.endsWith('.ximgs.net'))url.protocol='https:';if(url.protocol!=='https:'||url.username||url.password||url.port||url.href===location.href||!validHost(url.hostname,imageHosts))return'';if(/(?:qrcode|qr_code|preview_100_100|loading(?:\.s)?\.(?:gif|png)|banner_manage)/i.test(url.href))return'';if(!/\.(?:jpe?g|png|webp|gif|avif)(?:$|[?#])/i.test(url.pathname+url.search)&&!/\/(?:img|image|pic|photo)\//i.test(url.pathname))return'';return url.href;}catch{return'';}
    };
    const imageList=(selector,attributes,platform)=>{const output=[];for(const node of document.querySelectorAll(selector))for(const attribute of attributes){const image=safeImage(node.getAttribute(attribute),platform);if(image&&!output.includes(image))output.push(image);}return output;};
    const rowsToAttributes=rows=>{const output={};for(const row of rows){const match=clean(row).match(/^([^:：]{1,40})\s*[:：]\s*(.{1,300})$/);if(match&&!output[match[1]])output[match[1]]=match[2];}return output;};
    const splitValues=value=>unique(String(value||'').split(/[,，、\s]+/));
    const detailsResult=(platform,base)=>{
      const attributes=[...(Array.isArray(base.attributes)?base.attributes:[])];let title=base.title,sku=base.sku,shopName=base.shopName,price=base.price,priceType='supply',priceTiers=[],resaleFloor=null,colors=[],sizes=[],mainImages=base.images||[],colorImages=[],detailImages=[],detailImageNodes=0,placeholders=0;
      const productImageNode=node=>!node.closest('[class*="recommend"],[class*="Recommend"],[class*="related"],[class*="Related"]')&&!/(?:qrcode|qr_code|banner_manage)/i.test(Array.from(node.attributes).map(attribute=>attribute.value).join(' '));
      if(platform==='wsy'){
        const itemAttributes=Array.from(document.querySelectorAll('.item_sx .li a')).map(read).filter(Boolean);attributes.push(...itemAttributes);title=firstText(['.item-mb a','[class*="item-mb"] a','h1'])||title;
        const article=firstText(['.item-mb .item-no','.item-sku','.item-sale'])||read(document.querySelector('.item-mb'));sku=article.match(/货号\s*[:：]?\s*([\w\u3400-\u9fff-]+)/)?.[1]||itemAttributes.map(value=>value.match(/^货号\s*[:：]\s*(.+)$/)?.[1]).find(Boolean)||sku;
        shopName=firstText(['.shop-info .name','.shop-info [class*="name"]'])||shopName;price=Number(read(document.querySelector('.J_p_price')).replace(/[^\d.]/g,''))||price;
        colors=unique(Array.from(document.querySelectorAll('#J_TSaleProp a')).map(read));sizes=unique(Array.from(document.querySelectorAll('.table-sku tr')).map(row=>read(row.querySelector('td:first-child'))));
        const detailRoot=document.querySelector('#J_DivItemDesc'),hero=imageList('.wsy-booth img.J_ImgBooth',['data-zoom-image','src'],'wsy');mainImages=unique([...mainImages,...hero,...imageList('.wsy-gallery .J_pic_open[href]',['href'],'wsy')]);
        const detailNodes=detailRoot?Array.from(detailRoot.querySelectorAll('img')).filter(productImageNode):[];detailImageNodes=detailNodes.length;detailImages=unique(detailNodes.flatMap(node=>['data-original','data-src','data-zoom-image','src'].map(key=>safeImage(node.getAttribute(key),'wsy')).filter(Boolean)));
        const variants=Array.from(document.querySelectorAll('.table-sku tr')).map(row=>({size:read(row.querySelector('td:first-child')),sku:(read(row.querySelector('.sku'))||read(row.querySelector('td:nth-child(2)'))).replace(/^sku\s*[:：]?\s*/i,''),price:Number(read(row.querySelector('.price')).replace(/[^\d.]/g,''))||null})).filter(row=>row.size);
        if(variants.length)attributes.push('SKU规格：'+variants.map(row=>[row.size,row.sku,row.price].filter(Boolean).join('/')).join('、'));priceTiers=variants.some(row=>row.price&&row.price!==price)?variants.map(row=>({price:row.price,quantity:row.size})):[];if(priceTiers.length)priceType='tiered';
      }else if(platform==='zwd'){
        const root=document.querySelector('[class*="index-goodsParamsWrapper-"]'),rows=root?Array.from(root.children).map(read):[],labels=['颜色分类','尺寸','尺码','货号','适用年龄','腰型','工艺','年份季节','厚薄','颜色'],map=Object.fromEntries(rows.map(row=>{const label=labels.find(value=>row.startsWith(value));return[label||'',label?row.slice(label.length).replace(/^\s*[:：]?\s*/,'').trim():''];}).filter(row=>row[0]&&row[1]));attributes.push(...rows);
        title=firstText(['[class*="index-titleBox-"]','[class*="index-titleWrapper-"]'])||title;sku=firstText(['[class*="index-itemNoPanel-"] span'])||map['货号']||sku;shopName=firstText(['[class*="index-shopName-"] h2 a','[class*="index-shopName-"]'])||shopName;
        price=Number(firstText(['[class*="index-pifaPriceWrapper-"] b','[class*="index-pifaPriceWrapper-"]']).replace(/[^\d.]/g,''))||price;colors=splitValues(map['颜色分类']||map['颜色']);sizes=unique(Array.from(document.querySelectorAll('[class*="index-detailSizeSelectorLabel-"]')).map(read));
        try{const similar=document.querySelector('a[href*="SearchSimilar"]')?.getAttribute('href'),main=new URL(similar,location.href).searchParams.get('img_url'),image=safeImage(main,'zwd');if(image)mainImages.push(image);}catch{}
        const rootImages=document.querySelector('[class*="index-detailWrapper-"]'),nodes=rootImages?Array.from(rootImages.querySelectorAll('img')).filter(productImageNode):[];detailImageNodes=nodes.length;
        for(const node of nodes){const candidates=['data-original','data-src','lazyload','data-url','src'].map(key=>node.getAttribute(key)).filter(Boolean),found=candidates.map(value=>safeImage(value,'zwd')).find(Boolean);if(found)detailImages.push(found);else if(candidates.some(value=>/preview_100_100|loading/i.test(value)))placeholders++;}
        detailImages=unique(detailImages);colorImages=imageList('[class*="index-introSkuWrapper-"] img',['data-original','data-src','src'],'zwd');
      }else if(platform==='qcc'){
        const rows=Array.from(document.querySelectorAll('.pro_att li')).map(read).filter(Boolean),map=rowsToAttributes(rows);attributes.push(...rows);title=firstText(['.toptitle','[class*="toptitle"]'])||title;sku=map['产品货号']||map['货号']||sku;shopName=firstText(['.shop-info a.link','.shop-info .link'])||shopName;
        priceTiers=Array.from(document.querySelectorAll('.price_detail dd')).map(row=>({price:Number(read(row.querySelector('.pri_de_price')).replace(/[^\d.]/g,''))||null,quantity:read(row.querySelector('.pri_de_num'))})).filter(row=>row.price);price=priceTiers[0]?.price||price;priceType=priceTiers.length>1?'tiered':'supply';
        colors=unique(Array.from(document.querySelectorAll('.J_clr a[title],.J_clr a')).map(node=>node.getAttribute('title')||read(node)));if(!colors.length)colors=splitValues(map['颜色分类']||map['颜色']);sizes=unique(Array.from(document.querySelectorAll('.pro_size_item .size_name')).map(read));
        mainImages=unique([...mainImages,...imageList('.picsize a[data-big]',['data-big'],'qcc')]);const rootImages=document.querySelector('.pro_detail'),nodes=rootImages?Array.from(rootImages.querySelectorAll('img')).filter(productImageNode):[];detailImageNodes=nodes.length;
        for(const node of nodes){const value=node.getAttribute('lazyload')||node.getAttribute('data-original')||node.getAttribute('data-src')||node.getAttribute('src'),image=safeImage(value,'qcc');if(image)detailImages.push(image);else if(/loading/i.test(value||''))placeholders++;}detailImages=unique(detailImages);
      }else if(platform==='e3hui'){
        const rows=Array.from(document.querySelectorAll('.details-attribute-list .details-attribute-item')).map(read).filter(Boolean),map=rowsToAttributes(rows);attributes.push(...rows);title=firstText(['.art-title','.product-title','h1'])||base.title;
        const article=firstText(['.art-num-text']);sku=article.includes('&')?article.slice(article.indexOf('&')+1).split(/[\s-]/,1)[0]:sku;shopName=firstText(['.supplier-name a','.supplier-name'])||shopName;
        price=Number(firstText(['.product-price-info .price strong i']).replace(/[^\d.]/g,''))||price;resaleFloor=Number(firstText(['.product-price-info .min-limit-price .p']).replace(/[^\d.]/g,''))||null;
        colors=unique(Array.from(document.querySelectorAll('.sku-wrap .sku-warp-li[data-color]')).map(node=>node.getAttribute('data-color')));sizes=splitValues(firstText(['.all-size'])||map['尺码']);mainImages=unique([...mainImages,...imageList('.small-img-item a[href]',['href'],'e3hui')]);
        const rootImages=document.querySelector('.product-details-content'),nodes=rootImages?Array.from(rootImages.querySelectorAll('img')).filter(productImageNode):[];detailImageNodes=nodes.length;
        for(const node of nodes){const value=node.getAttribute('data-url')||node.getAttribute('data-original')||node.getAttribute('data-src')||node.getAttribute('src'),image=safeImage(value,'e3hui');if(image)detailImages.push(image);else if(/loading/i.test(value||''))placeholders++;}detailImages=unique(detailImages);
      }
      const allImages=unique([...mainImages,...colorImages,...detailImages]).slice(0,60),missingFields=[];
      if(!title)missingFields.push('title');if(!sku)missingFields.push('sku');if(!shopName)missingFields.push('shopName');if(!(price>0))missingFields.push('price');if(!colors.length)missingFields.push('colors');if(!sizes.length)missingFields.push('sizes');if(!mainImages.length)missingFields.push('mainImage');
      const imageCoverage={detailNodes:detailImageNodes,detailImages:detailImages.length,placeholders,complete:detailImageNodes===0||placeholders===0&&detailImages.length>=detailImageNodes};if(detailImageNodes&&!imageCoverage.complete)missingFields.push('detailImages');
      const pageRole=base.pageRole==='supplier'?'supplier':'source',required=pageRole==='supplier'?['title','sku','shopName','price','colors','sizes','mainImage']:['title','mainImage'];
      const quality={state:required.every(field=>!missingFields.includes(field))&&imageCoverage.complete?'complete':'partial',pageRole,missingFields,imageCoverage};
      return{...base,url:location.href,title,sku:clean(sku).slice(0,200),shopName:clean(shopName).slice(0,300),price:Number.isFinite(price)&&price>0?price:null,priceType,resaleFloor,priceTiers,colors,sizes,attributes:unique(attributes).slice(0,80),images:allImages,imageGroups:{main:mainImages.slice(0,20),colors:colorImages.slice(0,20),details:detailImages.slice(0,40)},quality,visibleText:clean(document.body?.innerText).slice(0,40000)};
    };
    if(location.protocol!=='https:'||!validHost(location.hostname,hostMap[input.platform]))return{error:'商品页面跳转到其他站点，请检查登录或链接'};
    const body=clean(document.body?.innerText).slice(0,40000);
    if([...document.querySelectorAll('input[type=password]')].some(visible))return{error:'平台需要登录，请在浏览器登录后重试',tag:'需要平台登录'};
    if([...document.querySelectorAll('iframe')].some(node=>visible(node)&&/captcha|verify|punish/i.test(node.src))||(/访问受限|请完成安全验证|拖动滑块|访问过于频繁/.test(body)&&body.length<2000))return{error:'平台要求安全验证，请在浏览器完成验证后重试',tag:'需要平台验证'};
    const products=[];
    function visit(value,depth=0){if(!value||depth>10)return;if(Array.isArray(value)){for(const row of value)visit(row,depth+1);return;}if(typeof value!=='object')return;if([value['@type']].flat().some(type=>/^(Product|ProductGroup)$/i.test(String(type))))products.push(value);if(value['@graph'])visit(value['@graph'],depth+1);}
    for(const script of document.querySelectorAll('script[type="application/ld+json"]'))if((script.textContent||'').length<500000)try{visit(JSON.parse(script.textContent));}catch{}
    const product=products[0]||{},offer=Array.isArray(product.offers)?product.offers[0]||{}:product.offers||{};
    const meta=selector=>document.querySelector(selector)?.content||'';
    const productImages=[];
    const addProductImage=value=>{const image=safeImage(value,input.platform);if(image&&!productImages.includes(image))productImages.push(image);};
    for(const item of [product.image].flat())addProductImage(typeof item==='string'?item:item?.url);
    addProductImage(meta('meta[property="og:image"]'));
    if(input.platform==='douyin')for(const node of document.querySelectorAll('.head-figure .head-figure__media-view__content')){
      if(!visible(node))continue;
      const style=getComputedStyle(node).backgroundImage;
      for(const match of style.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi))addProductImage(match[1]||match[2]||match[3]?.trim());
    }
    const taobaoImages=[];
    if(input.platform==='taobao'){
      const gallerySelector='#ice-container img,[class*="PicGallery"] img,[class*="picGallery"] img,[class*="MainPic"] img,[class*="mainPic"] img,[class*="PicList"] img,[class*="pic-list"] img,[class*="picList"] img,[class*="imageViewer"] img,[class*="ImageViewer"] img,[class*="carousel"] img,[class*="Carousel"] img';
      const nodes=new Set([...document.querySelectorAll(gallerySelector),...Array.from(document.images)]);
      const itemImage=/\/(?:imgextra|bao\/uploaded)\//i;
      const thumbnail=/(?:[._-])\d{2,3}x\d{2,3}(?:q\d+)?(?:[._-]|$)/i;
      for(const node of nodes){
        if(!visible(node)||node.closest('header,footer,nav,[class*="recommend"],[class*="Recommend"],[class*="related"],[class*="Related"],[class*="shop"],[class*="Shop"],[class*="comment"],[class*="Comment"]'))continue;
        const rect=node.getBoundingClientRect(),gallery=!!node.closest('#ice-container,[class*="PicGallery"],[class*="picGallery"],[class*="MainPic"],[class*="mainPic"],[class*="PicList"],[class*="pic-list"],[class*="picList"],[class*="imageViewer"],[class*="ImageViewer"],[class*="carousel"],[class*="Carousel"]');
        const values=[];
        for(const key of ['data-zoom-image','data-big','data-src','data-original','data-ks-lazyload','data-lazyload','src','currentSrc']){
          const value=key==='currentSrc'?node.currentSrc:node.getAttribute(key);
          if(value)values.push({value,priority:/zoom|big|original|ks-lazyload|lazyload/i.test(key)?2:1});
        }
        for(const value of [node.getAttribute('srcset'),node.getAttribute('data-srcset')].filter(Boolean)){
          for(const entry of value.split(',')){
            const [url,descriptor]=entry.trim().split(/\s+/),width=Number(descriptor?.replace(/w$/,''))||0;
            if(url)values.push({value:url,priority:2+Math.min(width,10000)/10000});
          }
        }
        values.sort((a,b)=>b.priority-a.priority);
        for(const candidate of values){
          const image=safeImage(candidate.value,'taobao');
          if(!image||!itemImage.test(new URL(image).pathname))continue;
          if(thumbnail.test(new URL(image).pathname))continue;
          if(rect.width<180&&rect.height<180&&candidate.priority<2.5)continue;
          if(!taobaoImages.includes(image))taobaoImages.push(image);
        }
      }
    }
    if(input.platform==='wsy')productImages.push(...imageList('.wsy-booth img.J_ImgBooth',['data-zoom-image','src'],'wsy'),...imageList('.wsy-gallery .J_pic_open[href]',['href'],'wsy'));
    if(input.platform==='zwd'){
      try{const similar=document.querySelector('a[href*="SearchSimilar"]')?.getAttribute('href');const value=new URL(similar,location.href).searchParams.get('img_url');addProductImage(value);}catch{}
      productImages.push(...imageList('[class*="index-introSkuWrapper-"] img',['data-original','data-src','src'],'zwd'));
    }
    if(input.platform==='qcc')productImages.push(...imageList('.picsize a[data-big]',['data-big'],'qcc'));
    if(input.platform==='e3hui')productImages.push(...imageList('.small-img-item a[href]',['href'],'e3hui'));
    const description=clean(product.description||meta('meta[name="description"]')).slice(0,6000);
    const attributes=Array.from(document.querySelectorAll('tr,[class*="param"],[class*="attribute"],[class*="specification"]')).filter(node=>visible(node)&&!node.closest('[class*="recommend"],[class*="related"],header,footer,nav')).map(read).filter(value=>value.length>1&&value.length<500);
    const genericTitle=input.platform==='douyin'?firstText(['.title-info__text']):'';
    const title=clean(product.name||firstText(['h1'])||genericTitle||meta('meta[property="og:title"]')||document.title).slice(0,1000);
    const shopName=clean(offer.seller?.name||firstText(['[class*="shopName"],[class*="shop-name"],[class*="store-name"]'])||(input.platform==='douyin'?firstText(['.shop-component__shop-content__basic-info__title-area__name']):'')).slice(0,300);
    const price=Number(offer.price);
    const base={url:location.href,title,sku:clean(product.sku||product.mpn||'').slice(0,200),shopName,price:Number.isFinite(price)&&price>0?price:null,description,attributes:unique(attributes),images:unique(input.platform==='taobao'?[...taobaoImages,...productImages]:productImages).slice(0,60),visibleText:body,salesText:(body.match(/(?:已售|总销量|销量|月售)\s*[\d.,万千+]+\s*(?:件|笔)?|[\d.,万千+]+\s*人(?:付款|购买)/)||[])[0]||'',productId:new URL(location.href).searchParams.get('id')||'',collectedAt:new Date().toISOString(),pageRole:input.pageRole};
    if(supplierPlatforms.has(input.platform))return detailsResult(input.platform,base);
    return{...base,quality:{state:base.title&&base.images.length?'complete':'partial',pageRole:input.pageRole||'source',missingFields:[!base.title?'title':'',!base.images.length?'mainImage':''].filter(Boolean),imageCoverage:{detailNodes:0,detailImages:0,placeholders:0,complete:true}}};
  }
  async function expandBuyerPage(input={}){
    const supplierPlatforms=new Set(['wsy','zwd','qcc','e3hui']),hostMap={wsy:['wsy.com'],zwd:['17zwd.com'],qcc:['17qcc.com'],e3hui:['e3hui.com','e3hui.cn']};
    const validHost=(host,domains)=>(domains||[]).some(domain=>host===domain||host.endsWith('.'+domain));
    if(!supplierPlatforms.has(input.platform)||location.protocol!=='https:'||!validHost(location.hostname,hostMap[input.platform]))return{visited:0};
    const selector={wsy:'#J_DivItemDesc img',zwd:'[class*="index-detailWrapper-"] img',qcc:'.pro_detail img',e3hui:'.product-details-content img'}[input.platform];
    const nodes=Array.from(document.querySelectorAll(selector)).slice(0,120);
    const original=window.scrollY;
    let visited=0;
    try{
      for(const node of nodes){
        const state=node.getBoundingClientRect();
        if(state.top<0||state.top>innerHeight)node.scrollIntoView({block:'center',behavior:'instant'});
        visited++;
        await new Promise(resolve=>setTimeout(resolve,80));
      }
    }finally{window.scrollTo(0,original);}
    return{visited,discovered:nodes.length};
  }
  async function waitForBuyerPage({read,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),attempts=40,interval=500,pageRole='source'}){
    let result;
    for(let i=0;i<attempts;i++){
      if(i)await sleep(interval);
      result=await read();
      if(result?.error)throw new Error(result.error);
      const required=pageRole==='supplier'?result?.quality?.state==='complete':!!result?.title&&!!result?.images?.length;
      if(required)return result;
    }
    if(pageRole==='supplier'&&result?.title&&result?.images?.length)return result;
    if(!result?.images?.length)throw new Error('商品页面已打开，但未识别到商品主图；可能页面仍未加载完成或图片布局暂不支持，请确认页面已显示商品图后继续原任务');
    if(!result?.title)throw new Error('商品主图已读取，但未识别到商品标题；请确认商品详情已加载完成后继续原任务');
    return result;
  }
  root.FindBuyerPage={scrapeBuyerPage,expandBuyerPage,waitForBuyerPage};if(typeof module==='object'&&module.exports)module.exports=root.FindBuyerPage;
})(globalThis);
