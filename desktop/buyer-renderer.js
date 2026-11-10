(function () {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let snapshot = null, busy = false, rendered = '',visibleLimit=50;
  const selected = new Set();
  const expandedMarket = new Set();
  const sourceTypes = {image:'本机图片',douyin:'抖音',taobao:'淘宝/天猫',wsy:'网商园',zwd:'17网',qcc:'青创网',e3hui:'衣衫汇'};
  const statuses = {needs_image:'待添加商品图',ready_for_supplier_search:'可搜四个平台',supplier_search_queued:'已排队，等待插件',supplier_searching:'等待桌面识别',needs_business_data:'同款已确认，资料仍有缺项',evidence_only:'来源资料已整理，待补业务资料',ready_for_draft:'资料齐全，可进互拓草稿'};
  const fileData = file => new Promise((resolve,reject) => { if(!file)return resolve(''); const reader=new FileReader(); reader.onerror=()=>reject(new Error('无法读取商品图片')); reader.onload=()=>resolve(String(reader.result||'')); reader.readAsDataURL(file); });
  function sourceType(value) {
    try {
      const host=new URL(value).hostname;
      if(/(^|\.)douyin\.com$|(^|\.)jinritemai\.com$/.test(host))return 'douyin';
      if(host==='item.taobao.com'||host==='detail.tmall.com')return 'taobao';
      if(/(^|\.)wsy\.com$/.test(host))return 'wsy';
      if(/(^|\.)17zwd\.com$/.test(host))return 'zwd';
      if(/(^|\.)17qcc\.com$/.test(host))return 'qcc';
      if(/(^|\.)e3hui\.(com|cn)$/.test(host))return 'e3hui';
    } catch {}
    return '';
  }
  const timeText=value=>Number.isFinite(Date.parse(value||''))?new Date(value).toLocaleString('zh-CN',{hour12:false}):'时间未记录';
  async function refresh(){snapshot=await window.desktop.snapshot();render();}
  function candidates(task){return (snapshot.jobs||[]).filter(job=>job.queryId===task.queryId).flatMap(job=>(job.items||[]).map((item,index)=>({job,item,index})).filter(row=>row.item.humanReview?.verdict==='likely_same'&&row.item.productDetails));}
  function render(current){
    if(current)snapshot=current;
    if(!snapshot?.authenticated){selected.clear();expandedMarket.clear();rendered='';$('buyerTaskList').replaceChildren();$('buyerTaskForm').reset();$('buyerBulkRows').value='';$('buyerMessage').textContent='';return;}
    const tasks=[...(snapshot.buyerTasks||[])].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||(a.origin?.rowNumber||0)-(b.origin?.rowNumber||0));
    for(const id of selected)if(!tasks.some(task=>task.id===id))selected.delete(id);
    const next=JSON.stringify([tasks,(snapshot.jobs||[]).filter(job=>tasks.some(task=>!task.automation&&(job.buyerTaskId===task.id||task.queryId&&job.queryId===task.queryId))),(snapshot.browserCommands||[]).filter(command=>command.kind==='taobao-image-search'),snapshot.taobaoPaused,[...selected],[...expandedMarket],$('buyerAutoFilter').value,visibleLimit]);
    if(next===rendered)return;
    rendered=next;
    const queueCount=(snapshot.browserCommands||[]).filter(command=>command.kind==='taobao-image-search'&&['queued','claimed'].includes(command.status)).length;
    $('buyerTaobaoQueue').textContent=(snapshot.taobaoPaused?'淘宝队列已暂停':'淘宝搜索逐张排队')+' · 等待 '+queueCount+' 个 · 已选 '+selected.size+' 个';
    $('buyerTaobaoResume').hidden=!snapshot.taobaoPaused;
    $('buyerTaobaoPause').hidden=!!snapshot.taobaoPaused;
    $('buyerTaskCount').textContent=tasks.length+' 条';
    if(!tasks.length){$('buyerTaskList').innerHTML='<div class="empty"><h3>还没有买手任务</h3><p>粘贴运营表行，或从抖音主图页面把已下载商品加入。</p></div>';return;}
    const filter=$('buyerAutoFilter').value,filtered=tasks.filter(task=>filter==='all'||filter==='attention'&&task.automation?.state==='attention'||filter==='completed'&&task.automation?.state==='completed'||filter==='processing'&&task.automation?.enabled&&!['attention','completed','stopped'].includes(task.automation.state));
    $('buyerAutoMore').hidden=filtered.length<=visibleLimit;$('buyerAutoVisibleCount').textContent=`显示 ${Math.min(visibleLimit,filtered.length)}/${filtered.length} 件`;
    $('buyerTaskList').innerHTML=filtered.slice(0,visibleLimit).map(task=>{
      if(task.automation)return BuyerAutoUI.card(task,selected.has(task.id));
      const job=(snapshot.jobs||[]).find(x=>x.queryId===task.queryId), options=candidates(task), supplier=task.supplierCandidate?.source?.supplier, missing=task.supplierCandidate?.source?.missing||[], market=task.marketplaceCandidate||{};
      const stage=job?({queued:'候选已送桌面队列',processing:'候选识别中',complete:'候选识别完成',partial:'候选识别暂停',failed:'候选识别失败'}[job.status]||job.status):(statuses[task.status]||task.status);
      const choices=options.map(row=>'<option value="'+esc(row.job.id+':'+row.index)+'">'+esc(row.item.title||row.item.id)+' · '+esc(sourceTypes[row.item.platform]||row.item.platform)+' · ¥'+esc(row.item.productDetails.price??row.item.price??'未知')+'</option>').join('');
      const events=(task.events||[]).slice(-3).map(e=>'<small>'+esc(timeText(e.at))+' · '+esc(e.message)+'</small>').join('');
      const taobao=task.marketplaceSearch||{},taobaoJob=(snapshot.jobs||[]).find(entry=>entry.id===taobao.jobId),searchCommand=(snapshot.browserCommands||[]).find(command=>command.kind==='taobao-image-search'&&command.buyerTaskId===task.id&&['queued','claimed'].includes(command.status));
      let html='<article class="buyer-task" data-buyer-task="'+esc(task.id)+'"><div class="buyer-task-head"><label class="check"><input class="buyer-select" type="checkbox" '+(selected.has(task.id)?'checked':'')+' aria-label="选择此买手任务"><span><strong>'+esc(task.articleNo||task.sourceTitle||'未命名商品')+'</strong><small>'+esc(sourceTypes[task.sourceType]||task.sourceType)+' · '+esc(timeText(task.createdAt))+'</small></span></label><span class="pill">'+esc(stage)+'</span></div>';
      html+='<p class="buyer-source-url">'+esc(task.sourceUrl)+'</p><p class="'+(task.hasImage?'buyer-image-state':'problem')+'">'+(task.hasImage?'已保存商品主图':'尚未添加商品图，无法进行图搜')+'</p>';
      if(job)html+='<p>桌面比对：'+esc(job.queryName||job.id)+' · 人工已审核 '+esc(job.reviewSummary?.reviewed||0)+' 条</p>';
      if(supplier)html+='<p>供应商候选：'+esc(supplier.title)+' · '+esc(supplier.shopName)+' · 货号 '+esc(supplier.articleNo||'待核实')+' · '+(supplier.listedPrice==null?'价格缺失':'¥'+esc(supplier.listedPrice))+'</p>';
      if(market.url)html+='<p>淘宝套图：'+esc(market.url)+' · '+(market.confirmedSame?'人工确认同款':'待人工核对')+'</p>';
      if(missing.length)html+='<p class="buyer-missing">待补：'+esc(missing.join('、'))+'</p>';
      html+='<div class="buyer-task-actions"><button type="button" class="secondary buyer-attach-image">添加/替换图片</button><input class="buyer-file" type="file" accept="image/jpeg,image/png,image/webp" hidden><button type="button" class="buyer-search" '+(!task.hasImage?'disabled':'')+'>'+(task.queryId?'重新提交四平台搜货':'搜索四个平台')+'</button><button type="button" class="secondary buyer-marketplace">录入淘宝套图链接</button></div>';
      html+='<div class="buyer-taobao"><div class="buyer-task-head"><strong>淘宝套图同款</strong><small>'+esc(searchCommand?(snapshot.taobaoPaused?'排队已暂停':searchCommand.status==='claimed'?'正在搜款':'已排队'):taobaoJob?({queued:'等待模型识别',processing:'模型识别中',complete:'识别完成，待核对',partial:'识别暂停，可原批次重试',failed:'识别失败，可原批次重试'}[taobaoJob.status]||'候选已保存'):({ready:'候选已保存，等待开始识别',failed:'搜索未完成'}[taobao.status]||'待搜索'))+'</small></div>';
      if(taobao.error)html+='<p class="message">'+esc(taobao.error)+'</p>';
      html+='<div class="buyer-task-actions"><button type="button" class="secondary buyer-taobao-search" '+(!task.hasImage||searchCommand||taobaoJob&&['queued','processing'].includes(taobaoJob.status)?'disabled':'')+'>'+(taobao.status==='failed'?'重试淘宝搜款':'淘宝以图搜同款')+'</button>';
      if(task.marketplaceCandidates?.length&&!taobaoJob)html+='<button type="button" class="buyer-taobao-compare">开始识别 '+task.marketplaceCandidates.length+' 个淘宝候选</button>';
      if(taobaoJob)html+='<button type="button" class="secondary buyer-taobao-review">到工作台核对匹配分</button>';
      html+='</div>';
      const marketEligible=taobaoJob?taobaoJob.items.map((item,index)=>({item,index})).filter(({item})=>!FindReview.belowThreshold(item, taobaoJob.items)).sort((a,b)=>FindReview.compare(a.item,b.item)):[];
      const marketRows=marketEligible.slice(0,expandedMarket.has(task.id)?60:5);
      if(taobaoJob)html+='<p class="muted">已识别 '+taobaoJob.items.filter(item=>FindReview.comparison(item)).length+'/'+taobaoJob.total+' · 50分及以下已隐藏。先核对匹配分，再选择套图来源。</p>';
      html+=marketRows.map(({item,index})=>'<div class="buyer-market-result"><img src="'+esc(item.imageEvidence?.sourceUrl||item.imageUrl)+'" alt="淘宝候选图片" loading="lazy" referrerpolicy="no-referrer"><div><strong>'+esc(item.title||item.id)+'</strong><small>'+esc(FindReview.scoreStatus(item,'manual')||'尚未识别')+'</small><div class="buyer-task-actions"><button type="button" class="text-button buyer-taobao-open" data-job="'+esc(taobaoJob.id)+'" data-index="'+index+'">打开商品链接</button>'+(FindReview.decision(item)?.verdict==='likely_same'?'<button type="button" class="secondary buyer-taobao-confirm" data-job="'+esc(taobaoJob.id)+'" data-index="'+index+'">选作套图来源</button>':'')+'</div></div></div>').join('');
      if(marketEligible.length>5)html+='<button type="button" class="secondary buyer-taobao-more">'+(expandedMarket.has(task.id)?'收起候选':'查看全部 '+marketEligible.length+' 个淘宝候选')+'</button>';
      html+='</div>';
      if(options.length)html+='<div class="buyer-candidate"><label>已人工确认的供应商候选<select class="buyer-candidate-select">'+choices+'</select></label><button type="button" class="secondary buyer-assemble">检查资料缺项</button></div>';
      if(events)html+='<details class="buyer-events"><summary>最近记录</summary>'+events+'</details>';
      return html+'</article>';
    }).join('');
  }
  function notify(text,error=false){$('buyerMessage').classList.toggle('message-ok',!error);$('buyerMessage').textContent=String(text||'').replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'').slice(0,260);}
  async function action(button, fn){
    if(busy)return;busy=true;button.disabled=true;
    try{notify(await fn()||'已完成');await refresh();}
    catch(error){notify(error.message||'买手任务操作失败',true);}
    finally{busy=false;button.disabled=false;}
  }
  $('buyerTaskForm').addEventListener('submit',event=>{
    event.preventDefault();
    void action($('createBuyerTask'),async()=>{
      const imageData=await fileData($('buyerImageFile').files[0]);
      await window.desktop.createBuyerTask({articleNo:$('buyerArticleNo').value,sourceType:$('buyerSourceType').value,sourceUrl:$('buyerSourceUrl').value,sourceTitle:$('buyerImageFile').files[0]?.name||'',imageData});
      $('buyerTaskForm').reset();updateSourceFields();return '买手任务已保存。';
    });
  });
  function updateSourceFields(){const local=$('buyerSourceType').value==='image';$('buyerSourceUrl').required=!local;$('buyerSourceUrl').disabled=local;$('buyerImageFile').required=local;}
  $('buyerSourceType').addEventListener('change',updateSourceFields);updateSourceFields();
  $('buyerImportImages').addEventListener('click',()=>{if(!busy)$('buyerBatchImages').click();});
  $('buyerBatchImages').addEventListener('change',()=>{
    const files=Array.from($('buyerBatchImages').files||[]);$('buyerBatchImages').value='';if(!files.length||busy)return;
    void action($('buyerImportImages'),async()=>{
      if(files.length>50)throw new Error('每次最多导入50张图片，请分批添加');
      let count=0;const errors=[];
      for(const file of files){try{notify('正在保存图片 '+(count+errors.length+1)+'/'+files.length+'：'+file.name);await window.desktop.createBuyerTask({sourceType:'image',sourceTitle:file.name,imageData:await fileData(file)});count++;}catch(error){errors.push(file.name+'：'+error.message);}}
      return '已导入 '+count+' 张图片，每张建立独立任务。'+errors.slice(0,3).join('；');
    });
  });
  $('importBuyerRows').addEventListener('click',()=>{
    if(busy)return;const rows=$('buyerBulkRows').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);if(!rows.length)return notify('请粘贴货号和商品链接');
    busy=true;$('importBuyerRows').disabled=true;
    void (async()=>{let ok=0,errors=[];try{
      for(let i=0;i<rows.length;i++){const parts=rows[i].split(/\t|\|/).map(x=>x.trim());if(parts.length!==2){errors.push('第'+(i+1)+'行格式无效');continue}const type=sourceType(parts[1]);if(!type){errors.push('第'+(i+1)+'行链接域名无法识别');continue}try{await window.desktop.createBuyerTask({articleNo:parts[0],sourceType:type,sourceUrl:parts[1]});ok++}catch(error){errors.push('第'+(i+1)+'行：'+error.message)}}
      $('buyerBulkRows').value='';await refresh();notify('已导入 '+ok+' 条。'+errors.slice(0,5).join('；'));
    }finally{busy=false;$('importBuyerRows').disabled=false}})();
  });
  $('buyerSelectAll').addEventListener('click',()=>{for(const task of snapshot?.buyerTasks||[])if(task.hasImage)selected.add(task.id);render();});
  $('buyerAutoFilter').addEventListener('change',()=>{visibleLimit=50;render();});
  $('buyerAutoMore').addEventListener('click',()=>{visibleLimit+=50;render();});
  $('buyerTaobaoBatch').addEventListener('click',()=>void action($('buyerTaobaoBatch'),async()=>{
    const tasks=(snapshot?.buyerTasks||[]).filter(task=>selected.has(task.id)&&task.hasImage);
    if(!tasks.length)throw new Error('请先勾选有商品图片的买手任务');
    let count=0;const errors=[];
    for(const task of tasks)try{await window.desktop.searchBuyerTaobao(task.id);count++;}catch(error){errors.push((task.articleNo||task.sourceTitle||'商品')+'：'+error.message);}
    return '已提交 '+count+' 个淘宝搜款任务；搜索后需点击开始识别。'+errors.slice(0,3).join('；');
  }));
  $('buyerTaobaoResume').addEventListener('click',()=>void action($('buyerTaobaoResume'),async()=>{await window.desktop.resumeBuyerTaobao();return '淘宝队列已继续。失败项请点击对应任务的重试淘宝搜款。';}));
  $('buyerTaobaoPause').addEventListener('click',()=>void action($('buyerTaobaoPause'),async()=>{await window.desktop.pauseBuyerTaobao();return '淘宝队列已暂停；正在搜索的一张完成后，后续任务保持排队。';}));
  $('buyerTaobaoLogin').addEventListener('click',()=>void window.desktop.openProductDetail('https://s.taobao.com/search').catch(error=>notify(error.message)));
  $('buyerTaskList').addEventListener('click',event=>{
    const card=event.target.closest('[data-buyer-task]');if(!card)return;const taskId=card.dataset.buyerTask;
    if(event.target.closest('.buyer-attach-image')){card.querySelector('.buyer-file').click();return}
    if(event.target.closest('.buyer-taobao-more')){if(expandedMarket.has(taskId))expandedMarket.delete(taskId);else expandedMarket.add(taskId);render();return;}
    if(event.target.closest('.buyer-taobao-search'))return void action(event.target.closest('.buyer-taobao-search'),async()=>{await window.desktop.searchBuyerTaobao(taskId);return '已排队搜索淘宝。候选返回后，由你确认开始识别。';});
    if(event.target.closest('.buyer-taobao-compare'))return void action(event.target.closest('.buyer-taobao-compare'),async()=>{await window.desktop.compareBuyerTaobao(taskId);return '已开始识别淘宝候选，可在工作台核对匹配分。';});
    if(event.target.closest('.buyer-taobao-review'))return $('navWork').click();
    if(event.target.closest('.buyer-taobao-open')){const button=event.target.closest('.buyer-taobao-open'),item=(snapshot.jobs||[]).find(job=>job.id===button.dataset.job)?.items[Number(button.dataset.index)];if(item)return void window.desktop.openProductDetail(item.detailUrl).catch(error=>notify(error.message));return;}
    if(event.target.closest('.buyer-taobao-confirm')){const button=event.target.closest('.buyer-taobao-confirm');return void action(button,async()=>{await window.desktop.confirmBuyerTaobao(taskId,button.dataset.job,Number(button.dataset.index));return '已将人工确认的淘宝商品关联为套图来源。';});}
    if(event.target.closest('.buyer-search'))return void action(event.target.closest('.buyer-search'),async()=>{await window.desktop.searchBuyerSuppliers(taskId);return '已交给配对插件；识别仍需你在浏览器工作台确认。'});
    if(event.target.closest('.buyer-marketplace')){
      const task=(snapshot.buyerTasks||[]).find(entry=>entry.id===taskId);if(!task)return;
      $('buyerMarketplaceTask').value=taskId;$('buyerMarketplaceUrl').value=task.marketplaceCandidate?.url||'';$('buyerMarketplaceSame').checked=task.marketplaceCandidate?.confirmedSame===true;
      $('buyerMarketplaceError').textContent='';$('buyerMarketplaceDialog').showModal();return;
    }
    if(event.target.closest('.buyer-assemble')){
      const [jobId,index]=card.querySelector('.buyer-candidate-select').value.split(':');
      return void action(event.target.closest('.buyer-assemble'),async()=>{await window.desktop.assembleBuyerSource(taskId,jobId,Number(index));return '供应商资料与套图来源已分别保存；请核对显示的缺项。'});
    }
  });
  $('buyerMarketplaceCancel').addEventListener('click',()=>$('buyerMarketplaceDialog').close());
  $('buyerMarketplaceForm').addEventListener('submit',event=>{event.preventDefault();if(busy)return;
    busy=true;$('buyerMarketplaceSave').disabled=true;
    void(async()=>{try{await window.desktop.saveBuyerTaobaoLink($('buyerMarketplaceTask').value,{url:$('buyerMarketplaceUrl').value,confirmedSame:$('buyerMarketplaceSame').checked});$('buyerMarketplaceDialog').close();await refresh();notify('淘宝套图来源已保存。');}catch(error){$('buyerMarketplaceError').textContent=String(error.message||'保存失败').replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');}finally{busy=false;$('buyerMarketplaceSave').disabled=false;}})();
  });
  $('buyerTaskList').addEventListener('change',event=>{
    if(event.target.matches('.buyer-select')){const id=event.target.closest('[data-buyer-task]').dataset.buyerTask;if(event.target.checked)selected.add(id);else selected.delete(id);render();return;}
    if(!event.target.matches('.buyer-file'))return;const card=event.target.closest('[data-buyer-task]'),file=event.target.files?.[0];if(!card||!file)return;
    void action(card.querySelector('.buyer-attach-image'),async()=>{await window.desktop.attachBuyerImage(card.dataset.buyerTask,await fileData(file));return '商品图片已保存。'});
  });
  window.BuyerUI=Object.freeze({render});
})();
