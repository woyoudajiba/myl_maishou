const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('../desktop/node_modules/sharp');
const { DouyinDownloads, extractUrls, normalizeUrl, detailInfo, sourceOptions, safeName, allowedUrl, isImageHost } = require('../desktop/douyin');

test('分享文案提取去重，限制真实抖音域名、HTTPS 和凭据；保留原始 URL 顺序', () => {
  const text = '抖音 https://v.douyin.com/abc/ 商品\nhttps://v.douyin.com/abc/\nhttps://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=123456789\nhttps://douyin.com.evil.example/a\nhttps://a@douyin.com/a\nhttp://v.douyin.com/x';
  assert.deepEqual(extractUrls(text), ['https://v.douyin.com/abc/','https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=123456789']);
  assert.match(normalizeUrl(extractUrls(text)[1]), /origin_type=detail_share_v2/);
  assert.equal(allowedUrl('https://evil.example/x', isImageHost), false);
  assert.equal(safeName('CON'), '未命名商品'); assert.equal(safeName('  上衣:/测试... '), '上衣 测试');
});
test('正确读取有序主图，过滤外域和重复资源；签名图片保留原始地址', () => {
  const url='https://p1-item.ecombdimg.com/img/ecom-shop-material/abc~tplv-foo.webp';
  const data={promotion_h5:{basic_info_data:{title_info:{title:' 羽绒服 '}},head_figure_data:{media_list:[{content_list:[{url},{url:'https://p2-item.ecombdimg.com/img/ecom-shop-material/abc~tplv-foo.jpg'},{url:'https://evil.example/a.jpg'}]}]}}};
  assert.deepEqual(detailInfo(data), {title:'羽绒服',images:[url]});
  assert.match(sourceOptions(url,'png')[0],/~tplv-5mmsx3fupr-image.png$/);
  const signed=url+'?signature=abc'; assert.deepEqual(sourceOptions(signed,'png'),[signed]);
});
test('批量任务不覆盖旧目录、保存正确图片格式、部分失败可见且不泄露其他文件', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'douyin-batch-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const image=await sharp({create:{width:800,height:900,channels:3,background:'#bb9966'}}).jpeg().toBuffer();
  const parse=async()=>({title:'上衣',productId:'123',images:['https://p1-item.ecombdimg.com/img/ecom-shop-material/a','https://p1-item.ecombdimg.com/img/ecom-shop-material/b']});
  const download=async url=>{if(url.includes('/b'))throw new Error('HTTP 404');return {buffer:image};};
  const d=new DouyinDownloads({defaultDir:dir,parse,download});
  d.start({text:'https://v.douyin.com/test/',quality:'png'}); await d.running;
  let state=d.snapshot();assert.equal(state.items[0].status,'partial');assert.equal(state.items[0].count,1);assert.equal(state.failed,1);
  assert.equal((await sharp(await fs.readFile(path.join(state.items[0].folder,'1.png'))).metadata()).format,'png');
  assert.match(await fs.readFile(path.join(state.items[0].folder,'商品信息.txt'),'utf8'),/上衣/);
  const previous=state.items[0].folder;
  d.start({text:'https://v.douyin.com/test/',quality:'jpg'}); await d.running;state=d.snapshot();
  assert.notEqual(state.items[0].folder,previous);assert.equal((await sharp(await fs.readFile(path.join(state.items[0].folder,'1.jpg'))).metadata()).format,'jpeg');
});
test('每个商品的第一张主图下载后自动交接搜图；首图失败不提交', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'douyin-first-image-hook-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const image=await sharp({create:{width:800,height:900,channels:3,background:'#334455'}}).jpeg().toBuffer();
 const queued=[];
 const d=new DouyinDownloads({defaultDir:dir,parse:async()=>({title:'商品',images:['https://p1-item.ecombdimg.com/img/ecom-shop-material/one','https://p1-item.ecombdimg.com/img/ecom-shop-material/two']}),
  download:async url=>{if(url.includes('/one'))throw new Error('first image unavailable');return {buffer:image};},onItem:async item=>{queued.push(item.index);return {id:'command'};}});
 d.start({text:'https://v.douyin.com/first-fails/',quality:'png'});await d.running;
 assert.equal(d.snapshot().items[0].status,'partial');assert.equal(d.snapshot().items[0].firstImage,false);assert.deepEqual(queued,[]);
 d.download=async()=>({buffer:image});
 d.start({text:'https://v.douyin.com/first-succeeds/',quality:'png'});await d.running;
 assert.equal(d.snapshot().items[0].firstImage,true);assert.equal(d.snapshot().items[0].searchStatus,'queued');assert.equal(d.snapshot().items[0].searchCommandId,'command');
 assert.deepEqual(queued,[1]);
});
test('重复提交拒绝；停止中止在途并保留已完成文件，退出清除内存视图', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'douyin-stop-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const image=await sharp({create:{width:100,height:100,channels:3,background:'#ffffff'}}).png().toBuffer();
  let started;
  const reached=new Promise(r=>started=r);
  const d=new DouyinDownloads({defaultDir:dir,parse:async()=>({title:'商品',images:['https://p1-item.ecombdimg.com/img/ecom-shop-material/a','https://p1-item.ecombdimg.com/img/ecom-shop-material/b']}),download:async(url,signal)=>{if(url.includes('/a'))return {buffer:image};started();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}});
  d.start({text:'https://v.douyin.com/abc/',quality:'png'});assert.throws(()=>d.start({text:'https://v.douyin.com/a',quality:'png'}),/正在运行/);
  await reached;await d.stop();let state=d.snapshot();assert.equal(state.running,false);assert.equal(state.items[0].status,'partial');assert.equal(state.images,1);
  const folder=state.items[0].folder;await fs.access(path.join(folder,'1.png'));await d.reset();assert.equal(d.snapshot().items.length,0);await fs.access(path.join(folder,'1.png'));
});

