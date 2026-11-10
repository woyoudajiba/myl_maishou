const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../connection-check.js'),'utf8');
test('诊断激活后台平台；缺失/废弃页面标记不完整；异常也恢复工作台',async()=>{
  const actions=[]; const original={id:1,url:'chrome-extension://test/workbench.html'};
  const mock={runtime:{getManifest:()=>({version:'test'})},tabs:{
    query:async query=>query.active?[original]:query.url[0].includes('wsy')?[{id:2,url:'https://www.wsy.com/?secret=hidden',active:false,status:'complete'}]:query.url[0].includes('qcc')?[{id:3,url:'https://www.17qcc.com/imagesearch.html',active:false,discarded:true}]:[],
    update:async(id,opts)=>actions.push({id,opts})},scripting:{executeScript:async()=>{throw new Error('Cannot access contents of url containing sensitive data');}}};
  const context=vm.createContext({chrome:mock,setTimeout,clearTimeout,URL,FindTransport:{platforms:{wsy:{name:'网商园',matches:['https://www.wsy.com/*']},qcc:{name:'青创网',matches:['https://www.17qcc.com/*']},zwd:{name:'17网',matches:['https://stu.17zwd.com/*']}}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../connection-check.js'),'utf8'),context);
  const report=await context.FindConnectionCheck.collect();
  assert.deepEqual(actions.map(x=>x.id),[2,1]);
  assert.equal(report.pages[0].tabState.page,'https://www.wsy.com/');
  assert.equal(report.pages[0].status,'inspect_failed');assert.equal(report.pages[1].status,'discarded');assert.equal(report.pages[2].status,'not_open');
  assert.equal(report.inspected,0);assert.equal(report.incomplete,true);
  assert.equal(JSON.stringify(report).includes('sensitive data'),false);assert.equal(JSON.stringify(report).includes('hidden'),false);
});

function inspect({url='https://www.17qcc.com/imagesearch.html',password=false,hidden=false,forbidden=false,platform='qcc'}={}) {
  const element={getClientRects:()=>hidden?[]:[{}],getAttribute:()=>forbidden?'true':null};
  Object.defineProperty(element,'value',{get(){throw new Error('must not read account fields');}});
  const document={scripts:[],readyState:'complete',querySelectorAll:selector=>selector==='input[type=password]'&&password?[element]:selector==='.file-input,.icon-imgseek'&&forbidden?[element]:[]};
  Object.defineProperty(document,'cookie',{get(){throw new Error('must not read cookie');}});
  const context=vm.createContext({URL,location:new URL(url),window:{},document,performance:{getEntriesByType:()=>[]},navigator:{},getComputedStyle:()=>({visibility:'visible'})});
  vm.runInContext(source,context);
  return context.inspectPlatformConnection(platform);
}
test('只用公开登录页/可见表单判断需要登录；隐藏表单不算，且不读取凭证',()=>{
  assert.equal(inspect({password:true}).access.state,'login_required');
  assert.equal(inspect({password:true,hidden:true}).access.state,'unverified');
  assert.equal(inspect({url:'https://sso.e3hui.cn/',platform:'e3hui'}).access.state,'login_required');
  assert.equal(inspect({url:'https://www.17qcc.com/login.html?secret=not-exported'}).access.state,'login_required');
  assert.equal(inspect({forbidden:true,platform:'e3hui'}).access.state,'permission_required');
});
test('汇总保留未打开/超时/登录/权限差别，多个页面优先显示可用页',()=>{
  const platforms=Object.fromEntries(['wsy','zwd','qcc','e3hui'].map(key=>[key,{name:key}]));
  const context=vm.createContext({FindTransport:{platforms}});vm.runInContext(source,context);
  assert.ok(context.FindConnectionCheck.summarize(null).every(row=>row.code==='not_checked'),'尚未检查时不能误报页面读取失败');
  const rows=context.FindConnectionCheck.summarize({pages:[
    {platform:'wsy',status:'not_open'},{platform:'zwd',status:'inspect_timeout'},
    {platform:'qcc',status:'inspected',access:{state:'login_required'}},
    {platform:'e3hui',status:'inspected',access:{state:'permission_required'}}
  ]});
  assert.equal(rows[0].result,'未打开');assert.equal(rows[1].result,'页面未响应');
  assert.match(rows[1].reason,/暂不能判断是否已登录/);
  assert.equal(rows[2].result,'需要登录');assert.equal(rows[3].result,'无搜图权限');
  const mixed=context.FindConnectionCheck.summarize({pages:[{platform:'qcc',status:'login_required'},{platform:'qcc',status:'inspected',access:{state:'unverified'}}]});
  assert.equal(mixed[2].result,'页面已响应');
});
test('总检查到时保留已完成页面；未检查平台明确标注，迟到响应不改报告',async()=>{
  let now=0; let lateResponse; const actions=[];
  const mock={runtime:{getManifest:()=>({version:'test'})},tabs:{
    query:async query=>query.active?[{id:1}]:query.url[0].includes('wsy')?[{id:2,url:'https://www.wsy.com/',active:false}]:[{id:3,url:'https://www.17qcc.com/',active:false}],
    update:async id=>{actions.push(id);}},scripting:{executeScript:async({target})=>{
      if(target.tabId===2)return [{result:{access:{state:'unverified'}}}];
      now=20001;return new Promise(resolve=>{lateResponse=resolve;});
    }}};
  const context=vm.createContext({chrome:mock,URL,setTimeout:(fn)=>setTimeout(fn,5),clearTimeout,FindTransport:{platforms:{wsy:{name:'网商园',matches:['https://www.wsy.com/*']},qcc:{name:'青创网',matches:['https://www.17qcc.com/*']},zwd:{name:'17网',matches:['https://stu.17zwd.com/*']}}}});
  // Keep the real Date constructor for the report timestamp, with a controlled clock.
  context.Date=class extends Date {static now(){return now;}};
  vm.runInContext(source,context);
  const report=await context.FindConnectionCheck.collect();
  assert.equal(report.pages[0].status,'inspected');assert.equal(report.pages[1].status,'inspect_timeout');assert.equal(report.pages[2].status,'check_timeout');
  assert.equal(report.inspected,1);assert.equal(report.incomplete,true);assert.equal(actions.at(-1),1);
  const before=JSON.stringify(report);lateResponse([{result:{access:{state:'unverified'}}}]);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(JSON.stringify(report),before);
});
test('统一登录站和 HTTP 登录跳转只检查地址，不注入登录页',async()=>{
  let injected=0;
  const mock={runtime:{getManifest:()=>({version:'test'})},tabs:{query:async query=>query.active?[{id:1}]:query.url.some(url=>url.includes('sso'))?[{id:2,url:'https://sso.e3hui.cn/'}]:[{id:3,url:'http://www.17qcc.com/login.html?token=hidden'}],update:async()=>{}},scripting:{executeScript:async()=>{injected++;}}};
  const context=vm.createContext({chrome:mock,URL,setTimeout,clearTimeout,FindTransport:{platforms:{e3hui:{name:'衣衫汇',matches:['https://www.e3hui.cn/*']},qcc:{name:'青创网',matches:['https://www.17qcc.com/*']}}}});vm.runInContext(source,context);
  const report=await context.FindConnectionCheck.collect();
  assert.equal(injected,0);assert.ok(report.pages.every(x=>x.status==='login_required'));
  assert.equal(JSON.stringify(report).includes('hidden'),false);
});
