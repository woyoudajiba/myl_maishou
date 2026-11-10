const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
test('网商园文档已可访问但标签仍loading时，立即注入消息桥而不等待document_idle',async()=>{
  let injected=false,searches=0;
  const chrome={tabs:{query:async()=>[],create:async()=>({id:1,url:'https://www.wsy.com/new/search/image'}),
    get:async()=>({id:1,status:'loading',url:'',pendingUrl:'https://www.wsy.com/new/search/image'}),remove:async()=>{},
    sendMessage:async(_id,message)=>{
      if(message.type==='CORE_PING'){if(!injected)throw new Error('Receiving end does not exist');return{ok:true,version:'0.1.0'};}
      if(message.type==='CORE_SEARCH'){searches++;return{ok:true,requestId:message.requestId,items:[],total:0};}return{ok:true};
    }},scripting:{executeScript:async details=>{assert.equal(details.injectImmediately,true);injected=true;}}};
  const context=vm.createContext({chrome,setTimeout:(fn,ms)=>ms===400?setTimeout(fn,0):setTimeout(fn,ms),clearTimeout,URL});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../transport.js'),'utf8'),context);
  await context.FindTransport.search('data:image/jpeg;base64,AAAA','loading-document',()=>{});
  assert.equal(injected,true);assert.equal(searches,1);
});
test('网商园新标签页消息桥较慢启动时继续只读握手，不重复提交搜图',async()=>{
  let pings=0,searches=0,injections=0;
  const chrome={tabs:{query:async()=>[],create:async()=>({id:1}),get:async()=>({id:1,status:'complete',url:'https://www.wsy.com/new/search/image'}),remove:async()=>{},
    sendMessage:async(_id,message)=>{
      if(message.type==='CORE_PING'){if(++pings<18)throw new Error('Receiving end does not exist');return{ok:true,version:'0.1.0'};}
      if(message.type==='CORE_SEARCH'){searches++;return{ok:true,requestId:message.requestId,items:[],total:0};}
      return{ok:true};
    }},scripting:{executeScript:async()=>{injections++;}}};
  const context=vm.createContext({chrome,setTimeout:(fn,ms)=>ms===400?setTimeout(fn,0):setTimeout(fn,ms),clearTimeout,URL});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../transport.js'),'utf8'),context);
  const result=await context.FindTransport.search('data:image/jpeg;base64,AAAA','slow-bridge',()=>{});
  assert.equal(result.ok,true);assert.equal(searches,1);assert.ok(injections>0);
});
test('并行三站：单站失败保留其他结果；只关成功临时页；请求标识隔离',async()=>{
  const removed=[],events=[];
  const urls={}; let id=0; const updated=new Set(),removedEvents=new Set();
  const event=set=>({addListener:fn=>set.add(fn),removeListener:fn=>set.delete(fn)});
  const chrome={tabs:{onUpdated:event(updated),onRemoved:event(removedEvents),query:async()=>[],create:async ({url})=>{urls[++id]=url;return{id};},
    update:async(tab,{url})=>{urls[tab]=url; for(const fn of updated)fn(tab,{url,status:'loading'}); for(const fn of updated)fn(tab,{status:'complete'}); return{id:tab,url};},
    get:async tab=>({status:'complete',url:urls[tab]}),remove:async tab=>removed.push(tab)},
    scripting:{executeScript:async ({target,args})=>{const [key,_base64,requestId]=args;
      if(key==='e3hui_upload')return[{result:{ok:true,requestId,searchPath:'/purchaser/img-search?url=%2Fuploaded.jpg',items:[],diagnostics:{stage:'image_search'}}}];
      const result={ok:true,requestId,items:[{id:key,platform:key}],total:1,...(key==='qcc'?{diagnostics:{searchGroups:[{type:'accurate',phase:'complete',received:0},{type:'similar',phase:'complete',received:1}]}}:{})};
      return[{result}];}}};
  const context=vm.createContext({chrome,setTimeout,clearTimeout,URL,searchPlatformPage:function(){}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../transport.js'),'utf8'),context);
  const result=await context.FindTransport.searchAll('data:image/jpeg;base64,AAAA','batch1',['qcc','zwd','e3hui'],(key,status)=>events.push({key,status}));
  assert.deepEqual(Array.from(result.items,x=>x.id),['qcc','zwd','e3hui_parse']);
  assert.equal(result.records.find(x=>x.key==='qcc').phase,'complete');
  assert.match(result.records.find(x=>x.key==='qcc').message,/准确搜 0，相似搜 1/);
  assert.equal(result.records.find(x=>x.key==='e3hui').phase,'complete');
  assert.equal(removed.length,3); assert.ok(removed.some(x=>urls[x].includes('17qcc')));
  assert.ok(Object.values(urls).some(url=>url==='https://www.e3hui.cn/purchaser/img-search?url=%2Fuploaded.jpg'));
  assert.ok(events.some(x=>x.status.phase==='complete'));
});

test('四站真实调度分支全部调用并保留各站来源，青创失败不覆盖其余三站',async()=>{
  const calls=[],urls={},updated=new Set(),removedEvents=new Set();let nextId=0;
  const event=set=>({addListener:fn=>set.add(fn),removeListener:fn=>set.delete(fn)});
  const chrome={tabs:{onUpdated:event(updated),onRemoved:event(removedEvents),query:async()=>[],
    create:async({url})=>{const id=++nextId;urls[id]=url;return{id,url};},get:async id=>({id,status:'complete',url:urls[id]}),remove:async()=>{},
    update:async(id,{url})=>{urls[id]=url;for(const fn of updated)fn(id,{url,status:'loading'});for(const fn of updated)fn(id,{status:'complete'});return{id,url};},
    sendMessage:async(_id,message)=>{
      if(message.type==='CORE_PING')return{ok:true,version:'0.1.0'};
      assert.equal(message.type,'CORE_SEARCH');calls.push('wsy');return{ok:true,requestId:message.requestId,items:[{platform:'wsy',id:'w1'}],total:80};
    }},scripting:{executeScript:async({args})=>{
      const [key,,requestId]=args;calls.push(key);
      if(key==='qcc')return[{result:{ok:false,requestId,error:'platform_timeout：青创网25秒超时'}}];
      if(key==='e3hui_upload')return[{result:{ok:true,requestId,searchPath:'/purchaser/img-search?url=fixture',items:[]}}];
      return[{result:{ok:true,requestId,items:[{platform:key==='e3hui_parse'?'e3hui':key,id:'item-'+key}],total:key==='zwd'?12:50}}];
    }}};
  const context=vm.createContext({chrome,setTimeout,clearTimeout,URL,searchPlatformPage:function(){}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../transport.js'),'utf8'),context);
  const result=await context.FindTransport.searchAll('data:image/jpeg;base64,AAAA','all-four',['wsy','zwd','qcc','e3hui'],()=>{});
  assert.deepEqual([...calls].sort(),['e3hui_parse','e3hui_upload','qcc','wsy','zwd']);
  assert.deepEqual(Array.from(result.items,item=>item.platform),['wsy','zwd','e3hui']);
  assert.equal(result.records.length,4);
  assert.equal(result.records.find(row=>row.key==='qcc').phase,'failed');
  assert.equal(result.records.find(row=>row.key==='wsy').total,80);
  assert.equal(result.records.find(row=>row.key==='e3hui').total,50);
});

test('衣衫汇按官网整页导航且保留原页面；重定向失败留诊断页',async()=>{
  const urls={10:'https://www.e3hui.com/'}; const removed=[]; const updated=new Set(),removedEvents=new Set();
  const event=set=>({addListener:fn=>set.add(fn),removeListener:fn=>set.delete(fn)});
  const chrome={tabs:{onUpdated:event(updated),onRemoved:event(removedEvents),query:async()=>[{id:10,url:urls[10]}],
    create:async ({url})=>{urls[11]=url;return{id:11,url};},
    update:async(tab,{url})=>{for(const fn of updated)fn(tab,{url,status:'loading'});urls[tab]='https://www.e3hui.com/';for(const fn of updated)fn(tab,{url:urls[tab],status:'complete'});return{id:tab,url:urls[tab]};},
    get:async tab=>({status:'complete',...(tab===11 ? {} : {url:urls[tab]})}),remove:async tab=>removed.push(tab)},
    scripting:{executeScript:async ({args})=>[{result:{ok:true,requestId:args[2],searchPath:'/purchaser/img-search?url=%2Fimg.jpg',items:[],diagnostics:{stage:'image_search',uploadMode:'multipart_form_data',uploadField:'file'}}}]}};
  const context=vm.createContext({chrome,setTimeout,clearTimeout,URL,searchPlatformPage:function(){}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../transport.js'),'utf8'),context);
  const result=await context.FindTransport.searchAll('data:image/jpeg;base64,AAAA','redirect',['e3hui'],()=>{});
  assert.equal(result.records[0].phase,'failed');
  assert.match(result.records[0].message,/platform_redirect/);
  assert.equal(result.records[0].diagnostics.redirectedToPage,true);
  assert.equal(result.records[0].diagnostics.stage,'result_loaded');
  assert.equal(result.records[0].diagnostics.uploadField,'file');
  assert.equal(result.records[0].diagnostics.responseUrl,'https://www.e3hui.com/');
  assert.equal(result.records[0].openTabId,11);
  assert.equal(urls[10],'https://www.e3hui.com/');
  assert.deepEqual(removed,[],'失败时临时页保留以便处理登录或权限');
});

test('衣衫汇官网新图片搜索路由 /purchaser/search?params= 按有效结果页解析',async()=>{
  const urls={}; const removed=[]; const updated=new Set(),removedEvents=new Set(); let id=0;
  const event=set=>({addListener:fn=>set.add(fn),removeListener:fn=>set.delete(fn)});
  const chrome={tabs:{onUpdated:event(updated),onRemoved:event(removedEvents),query:async()=>[],
    create:async ({url})=>{urls[++id]=url;return{id};},
    update:async(tab,{url})=>{for(const fn of updated)fn(tab,{url,status:'loading'});urls[tab]='https://www.e3hui.cn/purchaser/search?params=fixture';for(const fn of updated)fn(tab,{url:urls[tab],status:'complete'});return{id:tab,url:urls[tab]};},
    get:async tab=>({id:tab,status:'complete',url:urls[tab]}),remove:async tab=>removed.push(tab)},
    scripting:{executeScript:async ({args})=>{
      if(args[0]==='e3hui_upload')return[{result:{ok:true,requestId:args[2],searchPath:'/purchaser/img-search?url=%2Fuploaded.jpg',items:[],diagnostics:{stage:'image_search',uploadField:'file'}}}];
      return[{result:{ok:true,requestId:args[2],items:[{id:'cssakos',price:380}],total:50,received:1,diagnostics:{stage:'complete',resultRoute:'purchaser_search_params'}}}];
    }}};
  const context=vm.createContext({chrome,setTimeout,clearTimeout,URL,searchPlatformPage:function(){}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../transport.js'),'utf8'),context);
  const result=await context.FindTransport.searchAll('data:image/jpeg;base64,AAAA','new-e3-route',['e3hui'],()=>{});
  const record=result.records[0];
  assert.equal(record.phase,'complete'); assert.equal(record.total,50); assert.equal(record.items[0].id,'cssakos');
  assert.equal(record.diagnostics.resultRoute,'purchaser_search_params'); assert.deepEqual(removed,[1]);
});

test('衣衫汇多个站点同时打开时优先复用有上传权限的站点',async()=>{
  const initialTabs=[{id:10,url:'https://www.e3hui.com/',active:false},{id:11,url:'https://www.e3hui.cn/',active:true}];
  const urls={10:initialTabs[0].url,11:initialTabs[1].url}; const removed=[]; let created=''; let next=20;
  const inspected=[];
  const updated=new Set(),removedEvents=new Set(); const event=set=>({addListener:fn=>set.add(fn),removeListener:fn=>set.delete(fn)});
  const chrome={tabs:{onUpdated:event(updated),onRemoved:event(removedEvents),query:async()=>initialTabs,create:async ({url})=>{created=url;urls[++next]=url;return{id:next,url};},
    update:async(tab,{url})=>{urls[tab]=url;for(const fn of updated)fn(tab,{url,status:'loading'});for(const fn of updated)fn(tab,{status:'complete'});return{id:tab,url};},
    get:async tab=>({id:tab,status:'complete',url:urls[tab]}),remove:async tab=>removed.push(tab)},
    scripting:{executeScript:async ({target,args})=>{
      if(!args){inspected.push(target.tabId);return[{result:target.tabId===10}];}
      const [stage,_image,requestId]=args;
      if(stage==='e3hui_upload')return[{result:{ok:true,requestId,searchPath:'/purchaser/img-search?url=%2Fimg.jpg',diagnostics:{stage:'image_upload'}}}];
      return[{result:{ok:true,requestId,items:[],total:null,diagnostics:{emptyResult:true}}}];
    }}};
  const context=vm.createContext({chrome,setTimeout,clearTimeout,URL,searchPlatformPage:function(){}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../transport.js'),'utf8'),context);
  const result=await context.FindTransport.searchAll('data:image/jpeg;base64,AAAA','active-origin',['e3hui'],()=>{});
  assert.equal(created,'https://www.e3hui.com/');
  assert.deepEqual(inspected,[11,10]);
  assert.ok(Object.values(urls).includes('https://www.e3hui.com/purchaser/img-search?url=%2Fimg.jpg'));
  assert.equal(result.records[0].diagnostics.originSource,'existing_upload_control');
  assert.equal(result.records[0].phase,'complete'); assert.deepEqual(removed,[21]);
  assert.equal(urls[10],'https://www.e3hui.com/'); assert.equal(urls[11],'https://www.e3hui.cn/');
});

test('衣衫汇无效上传结果地址报告独立阶段，不暴露原生 URL 异常',async()=>{
  const removed=[]; let createdUrl='';
  const chrome={tabs:{query:async()=>[],create:async ({url})=>{createdUrl=url;return{id:20};},get:async()=>({status:'complete'}),remove:async id=>removed.push(id)},
    scripting:{executeScript:async ({args})=>[{result:{ok:true,requestId:args[2],searchPath:'http://outside.example.org/purchaser/img-search',items:[],diagnostics:{stage:'image_search',uploadField:'file'}}}]}};
  const context=vm.createContext({chrome,setTimeout,clearTimeout,URL,searchPlatformPage:function(){}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../transport.js'),'utf8'),context);
  const result=await context.FindTransport.searchAll('data:image/jpeg;base64,AAAA','bad-result-url',['e3hui'],()=>{});
  const record=result.records[0];
  assert.equal(record.phase,'failed'); assert.match(record.message,/platform_contract/);
  assert.doesNotMatch(record.message,/Invalid URL|Invalid base URL/);
  assert.equal(record.diagnostics.stage,'result_url'); assert.equal(record.diagnostics.resultUrlValid,false);
  assert.equal(record.diagnostics.uploadField,'file'); assert.equal(removed.length,0); assert.match(createdUrl,/e3hui\.cn/);
});

test('网商园只复用可用页面；登录或冻结页导致新建页时正确清理',async()=>{
  const removed=[]; let createdUrl='';
  const chrome={tabs:{query:async()=>[
      {id:10,url:'https://www.wsy.com/',frozen:true},
      {id:11,url:'https://www.wsy.com/login'}
    ],create:async ({url})=>{createdUrl=url;return{id:20,url};},
    get:async id=>({id,status:'complete',url:id===20?createdUrl:'https://www.wsy.com/'}),
    remove:async id=>removed.push(id),
    sendMessage:async (_id,message)=> message.type==='CORE_PING'
      ? {ok:true,version:'0.1.0'}
      : {ok:true,requestId:message.requestId,items:[{id:'wsy'}],total:1}},
    scripting:{executeScript:async()=>[{result:{}}]}};
  const context=vm.createContext({chrome,setTimeout,clearTimeout,URL});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../transport.js'),'utf8'),context);
  const result=await context.FindTransport.search('data:image/jpeg;base64,AAAA','wsy-owned',()=>{});
  assert.equal(result.items[0].id,'wsy');
  assert.equal(createdUrl,'https://www.wsy.com/new/search/image');
  assert.deepEqual(removed,[20]);
});

test('网商园新建页失败时保留问题页并回传打开页签',async()=>{
  const removed=[]; let createdUrl='';
  const chrome={tabs:{query:async()=>[{id:10,url:'https://www.wsy.com/login'}],create:async ({url})=>{createdUrl=url;return{id:20,url};},
    get:async id=>({id,status:'complete',url:id===20?createdUrl:'https://www.wsy.com/login'}),
    remove:async id=>removed.push(id),
    sendMessage:async (_id,message)=>{
      if(message.type==='CORE_PING') return {ok:true,version:'0.1.0'};
      if(message.type==='CORE_CANCEL') return {ok:true};
      return {ok:false,requestId:message.requestId,error:'login_required：网商园要求登录'};
    }},
    scripting:{executeScript:async()=>[{result:{}}]}};
  const context=vm.createContext({chrome,setTimeout,clearTimeout,URL});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../transport.js'),'utf8'),context);
  const result=await context.FindTransport.searchAll('data:image/jpeg;base64,AAAA','wsy-failed',['wsy'],()=>{});
  const record=result.records[0];
  assert.equal(record.phase,'failed');
  assert.match(record.message,/login_required/);
  assert.equal(record.openTabId,20);
  assert.equal(createdUrl,'https://www.wsy.com/new/search/image');
  assert.deepEqual(removed,[]);
});

test('青创网跳转 HTTP 登录页时在注入前报告登录阻塞并保留页面',async()=>{
  const removed=[]; const executed=[]; let createdUrl='';
  const chrome={tabs:{query:async()=>[],create:async ({url})=>{createdUrl=url;return{id:20,url};},
    get:async()=>({id:20,status:'complete',url:'http://www.17qcc.com/Login.html?ReturnUrl=%2Fimagesearch.html'}),
    remove:async id=>removed.push(id)},
    scripting:{executeScript:async()=>{executed.push(true);return[];}}};
  const context=vm.createContext({chrome,setTimeout,clearTimeout,URL,searchPlatformPage:function(){}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../transport.js'),'utf8'),context);
  const result=await context.FindTransport.searchAll('data:image/jpeg;base64,AAAA','qcc-login-redirect',['qcc'],()=>{});
  const record=result.records[0];
  assert.equal(record.phase,'failed');
  assert.match(record.message,/platform_login/);
  assert.equal(record.diagnostics.platform,'qcc');
  assert.equal(record.diagnostics.stage,'page_load');
  assert.equal(record.diagnostics.pageProtocol,'http:');
  assert.equal(record.openTabId,20);
  assert.equal(createdUrl,'https://www.17qcc.com/imagesearch.html');
  assert.deepEqual(removed,[]);
  assert.equal(executed.length,0);
});

test('冻结平台页不复用，改用新的临时页',async()=>{
  const removed=[]; let createdUrl='';
  const chrome={tabs:{query:async()=>[{id:10,url:'https://stu.17zwd.com/SearchSimilar',frozen:true}],create:async ({url})=>{createdUrl=url;return{id:20};},get:async()=>({status:'complete'}),remove:async id=>removed.push(id)},
    scripting:{executeScript:async ({args})=>[{result:{ok:true,requestId:args[2],items:[{id:'qcc',platform:'qcc'}],total:1}}]}};
  const context=vm.createContext({chrome,setTimeout,clearTimeout,searchPlatformPage:function(){}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../transport.js'),'utf8'),context);
  const result=await context.FindTransport.searchAll('data:image/jpeg;base64,AAAA','frozen',['zwd'],()=>{});
  assert.equal(result.records[0].phase,'complete');
  assert.equal(createdUrl,'https://stu.17zwd.com/SearchSimilar');
  assert.deepEqual(removed,[20]);
});

test('取消与临时页创建并发时删除新建页且不提交请求',async()=>{
  let releaseCreate, createStartedResolve;
  const createStarted=new Promise(resolve=>{createStartedResolve=resolve;});
  const removed=[], executed=[];
  const chrome={tabs:{query:async()=>[],create:async()=>{createStartedResolve();return await new Promise(resolve=>{releaseCreate=resolve;});},get:async()=>({status:'complete'}),remove:async id=>removed.push(id)},
    scripting:{executeScript:async()=>{executed.push(true);return[{result:{ok:true}}];}}};
  const context=vm.createContext({chrome,setTimeout,clearTimeout,searchPlatformPage:function(){}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../transport.js'),'utf8'),context);
  const pending=context.FindTransport.searchAll('data:image/jpeg;base64,AAAA','cancel-race',['zwd'],()=>{});
  await createStarted;
  await context.FindTransport.cancel();
  releaseCreate({id:41});
  await assert.rejects(pending,/request_cancelled/);
  assert.deepEqual(removed,[41]);
  assert.equal(executed.length,0);
});

test('平台脚本无响应时总超时、清理临时页并释放批次锁',async()=>{
  const removed=[]; let hang=true, id=50;
  const chrome={tabs:{query:async()=>[],create:async()=>({id:++id}),get:async()=>({status:'complete'}),remove:async tab=>{removed.push(tab);}},
    scripting:{executeScript:async ({args})=>{
      if(args.length===1)return [];
      if(hang)return new Promise(()=>{});
      return[{result:{ok:true,requestId:args[2],items:[{id:'recovered'}],total:1}}];
    }}};
  const source=fs.readFileSync(path.join(__dirname,'../transport.js'),'utf8').replace('const batchTimeout = 75000;','const batchTimeout = 20;');
  const context=vm.createContext({chrome,setTimeout,clearTimeout,searchPlatformPage:function(){}});
  vm.runInContext(source,context);
  await assert.rejects(context.FindTransport.searchAll('data:image/jpeg;base64,AAAA','hung',['zwd'],()=>{}),/search_timeout/);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(removed,[51]);
  hang=false;
  const next=await context.FindTransport.searchAll('data:image/jpeg;base64,AAAA','next',['zwd'],()=>{});
  assert.equal(next.items[0].id,'recovered');
});
