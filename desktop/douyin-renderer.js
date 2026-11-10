(function () {
  const el = id => document.getElementById(id);
  let info = {}, working = false, signedIn = false, dirtyFolder = false;
  function parseCount(text) {
    const raw = text.match(/https?:\/\/[^\s\u4e00-\u9fff\u3000-\u303f\uff00-\uffef<>"'`]+/gi) || [], unique = new Set();
    for (let entry of raw) { entry = entry.replace(/[.,;:!?)\]}]+$/, ''); try { const u = new URL(entry), host = u.hostname.toLowerCase(); if (u.protocol === 'https:' && !u.username && !u.password && !u.port && ['douyin.com','jinritemai.com'].some(d => host === d || host.endsWith('.'+d))) unique.add(entry.replace(/\/+$/, '')); } catch {} }
    return unique.size;
  }
  el('douyinLinks').addEventListener('input', () => { el('douyinCount').textContent = parseCount(el('douyinLinks').value) + ' 条'; });
  function render(snapshot) {
    if (!snapshot.authenticated) {
      if (signedIn) { el('douyinLinks').value = ''; el('douyinLinks').dispatchEvent(new Event('input')); el('douyinResults').textContent = ''; el('douyinFolder').value = ''; dirtyFolder = false; }
      signedIn = false; return;
    }
    signedIn = true; info = snapshot.douyin || {};
    if (!dirtyFolder) el('douyinFolder').value = info.outdir || '';
    el('douyinStart').disabled = working || !!info.running;
    el('douyinStop').disabled = working || !info.running;
    el('douyinBrowse').disabled = working || !!info.running;
    el('douyinQuality').disabled = !!info.running;
    el('douyinStatus').textContent = info.status || '就绪';
    el('douyinProgress').value = info.total ? Math.round((info.done || 0) / info.total * 100) : 0;
    el('douyinSummary').textContent = info.total ? `成功 ${info.succeeded} · 未完成 ${info.failed} · 已保存 ${info.images} 张` : '';
    const commands = snapshot.browserCommands || [];
    const key = JSON.stringify(info.items || []) + JSON.stringify(commands.map(command => [command.id, command.kind, command.status, command.sourceUrl]));
    if (el('douyinResults').dataset.key === key) return;
    el('douyinResults').dataset.key = key;
    el('douyinResults').replaceChildren();
    if (!info.items?.length) { const p = document.createElement('p'); p.className='muted'; p.textContent='下载后的商品和失败原因会显示在这里。'; el('douyinResults').append(p); return; }
    for (const item of info.items) {
      const row = document.createElement('article'); row.className='douyin-result';
      if (item.preview) { const img=document.createElement('img'); img.src=item.preview; img.alt='已下载主图预览'; row.append(img); }
      const body=document.createElement('div'), title=document.createElement('strong'), status=document.createElement('p');
      title.textContent=`${item.index}. ${item.title || '商品未完成'}`;
      status.textContent=`${item.status === 'complete' ? '下载完成' : item.status === 'partial' ? '部分完成' : '下载失败'} · ${item.count}/${item.totalImages} 张`;
      body.append(title,status);
      if (item.reason) { const reason=document.createElement('p'); reason.className='problem'; reason.textContent=item.reason; body.append(reason); }
      if (item.folder) { const folder=document.createElement('p'); folder.textContent=item.folder; body.append(folder); }
      if (item.firstImage) {
        const command = commands.find(entry => entry.kind === 'douyin-search' && entry.sourceUrl === item.url && ['queued','claimed','accepted'].includes(entry.status));
        const state = document.createElement('p');
        state.className = item.searchStatus === 'failed' || command?.status === 'failed' ? 'problem' : 'muted';
        state.textContent = item.searchError || (command?.status === 'claimed' ? '浏览器正在接收首图…'
          : command?.status === 'accepted' ? '首图已交给浏览器工作台，正在搜索四个平台。'
          : command?.status === 'queued' || item.searchStatus === 'queued' ? '主图已下载，正将首图交给浏览器插件…' : '首图已下载，可搜索四个平台。');
        body.append(state);
        const buyerButton=document.createElement('button');buyerButton.className='secondary douyin-buyer-import';buyerButton.dataset.index=String(item.index-1);buyerButton.textContent='加入买手任务';body.append(buyerButton);
        const buyer=document.createElement('button');buyer.className='secondary douyin-buyer-import';buyer.dataset.index=String(item.index-1);buyer.textContent='加入买手任务';body.append(buyer);
        if (item.searchStatus === 'failed' && !command) {
          const search = document.createElement('button'); search.className = 'secondary douyin-four-search'; search.dataset.index = String(item.index - 1); search.textContent = '重试四平台搜索'; body.append(search);
        }
      }
      row.append(body); el('douyinResults').append(row);
    }
  }
  async function action(fn) { if (working) return; working=true; el('douyinError').textContent=''; try { await fn(); } catch(error) { el('douyinError').textContent=String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); } finally { working=false; } }
  el('douyinPaste').addEventListener('click', () => { void action(async()=>{ const text=await navigator.clipboard.readText(); el('douyinLinks').value += (el('douyinLinks').value.trim()?'\n':'')+text; el('douyinLinks').dispatchEvent(new Event('input')); }); });
  el('douyinClear').addEventListener('click', () => { el('douyinLinks').value=''; el('douyinLinks').dispatchEvent(new Event('input')); });
  el('douyinBrowse').addEventListener('click', () => { void action(async()=>{ const folder=await window.desktop.selectDouyinFolder(); if(folder){dirtyFolder=true;el('douyinFolder').value=folder;} }); });
  el('douyinStart').addEventListener('click', () => { void action(async()=>{ await window.desktop.startDouyin({text:el('douyinLinks').value,outdir:el('douyinFolder').value,quality:el('douyinQuality').value});dirtyFolder=false; render(await window.desktop.snapshot()); }); });
  el('douyinStop').addEventListener('click', () => { void action(async()=>{ await window.desktop.stopDouyin(); render(await window.desktop.snapshot()); }); });
  el('douyinOpen').addEventListener('click', () => { void action(()=>window.desktop.openDouyinFolder()); });
  el('douyinResults').addEventListener('click', event => {
    const buyerButton=event.target.closest('.douyin-buyer-import');
    if(buyerButton)return void action(async()=>{await window.desktop.createBuyerFromDouyin(Number(buyerButton.dataset.index));el('douyinError').className='message message-ok';el('douyinError').textContent='已加入买手自动化工作区，可继续核对供应商资料。';render(await window.desktop.snapshot());});
    const buyer=event.target.closest('.douyin-buyer-import');
    if(buyer)return void action(async()=>{await window.desktop.createBuyerFromDouyin(Number(buyer.dataset.index));el('douyinError').className='message message-ok';el('douyinError').textContent='已加入买手自动化工作区，可继续核对供应商资料。';render(await window.desktop.snapshot());});
    const button = event.target.closest('.douyin-four-search'); if (!button || button.disabled) return;
    void action(async () => {
      const result = await window.desktop.queueDouyinSearch(Number(button.dataset.index));
      el('douyinError').className = 'message message-ok';
      el('douyinError').textContent = `已交给浏览器插件：${result.queryName}。插件将用首图搜索四个平台；请检查候选并在工作台确认开始识别。`;
      render(await window.desktop.snapshot());
    });
  });
  window.FindDouyinUI=Object.freeze({render});
})();

