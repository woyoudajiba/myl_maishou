globalThis.FindQueryWorkspace = (() => {
  const $ = id => document.getElementById(id);
  const clone = value => JSON.parse(JSON.stringify(value));
  const terminal = new Set(['complete', 'partial', 'failed', 'manual_required']);
  function create(hooks) {
    let index = { activeId: '', groupId: '', entries: [] }, batch = null, importing = false, message = '';
    const pending = entry => entry.pending > 0;
    const notice = text => { $('queryNotice').textContent = text; $('queryNotice').hidden = !text; };
    function capture(state) {
      if (state.queryId) {
        let kept = [];
        try { kept = FindCore.evaluate(state.raw, state).kept; } catch {}
        const old = index.entries.find(entry => entry.id === state.queryId);
        const entry = {
          id: state.queryId, name: state.queryName || '商品图片', thumbnail: state.thumbnail || old?.thumbnail || '',
          fingerprint: state.fingerprint || old?.fingerprint || '', searched: state.searched,
          phase: state.phase, count: state.raw.length,
          pending: kept.filter(item => !FindReview.comparison(item) && item.imageSimilarityStatus !== 'delegated').length,
          compared: state.raw.filter(item => FindReview.comparison(item)).length,
          delegated: state.raw.filter(item => item.imageSimilarityStatus === 'delegated').length
        };
        if (old) Object.assign(old, entry); else index.entries.push(entry);
        index.activeId = state.queryId;
      }
      return clone(index);
    }
    function render() {
      const state = hooks.get();
      capture(state);
      $('queryWorkspace').hidden = !index.entries.length;
      $('queryProgress').textContent = message || ('共 ' + index.entries.length + ' 张 · 已搜索 ' + index.entries.filter(entry => entry.searched).length + ' 张');
      $('queryName').textContent = state.queryName ? '当前图片：' + state.queryName : '';
      const list = $('queryList');
      for (const button of list.querySelectorAll('[data-query-id]')) if (!index.entries.some(entry => entry.id === button.dataset.queryId)) button.remove();
      for (const entry of index.entries) {
        let button = Array.from(list.children).find(button => button.dataset.queryId === entry.id);
        if (!button) { button = document.createElement('button'); list.append(button); }
        button.type = 'button';
        button.className = 'query-card'; button.dataset.queryId = entry.id;
        button.setAttribute('aria-pressed', String(entry.id === state.queryId));
        button.disabled = hooks.busy() || !!batch;
        let image = button.querySelector('img');
        if (entry.thumbnail && !image) { image = document.createElement('img'); image.alt = ''; button.prepend(image); }
        if (image && entry.thumbnail && image.getAttribute('src') !== entry.thumbnail) image.src = entry.thumbnail;
        if (image && !entry.thumbnail) image.remove();
        let text = button.querySelector('span');
        if (!text) { text = document.createElement('span'); text.append(document.createElement('strong'), document.createElement('small')); button.append(text); }
        const name = text.querySelector('strong'), progress = text.querySelector('small');
        name.textContent = entry.name;
        progress.textContent = entry.delegated ? '已交桌面 ' + entry.delegated + ' 张候选'
          : entry.compared ? '已识别 ' + entry.compared + '/' + entry.count + ' 张候选'
          : entry.searched ? (entry.count ? entry.count + ' 张候选 · 待确认识别' : '无候选 · 查看平台状态') : '待搜索';
        if (entry.id === state.queryId && hooks.busy() && !hooks.initializing()) progress.textContent = '处理中…';
      }
      const locked = hooks.busy() || !!batch;
      $('pickMany').disabled = locked;
      if (importing) { $('reset').disabled = true; $('stopSearch').disabled = true; }
      $('removeQuery').disabled = locked || !state.queryId;
      $('clearQueries').disabled = locked || !index.entries.length;
      $('searchQueries').disabled = locked || !index.entries.some(entry => !entry.searched);
      $('compareQueries').disabled = locked || !index.entries.some(pending) || !hooks.canCompare();
      $('stopQueries').hidden = !batch;
      if (batch) document.querySelectorAll('#input button:not(#stopSearch),#input input,#platformChoices input,#reviewMode,#reviewNext,[data-review-index],#visionSettings input,#visionSettings select,#visionSettings button,#connectDesktop,#desktopEndpoint,#desktopToken,#sendToDesktop,#checkConnection,#compareAgain,[data-connection-platform]').forEach(el => { el.disabled = true; });
    }
    async function restore() {
      index = await FindQueryStore.loadIndex();
      if (index.entries.length) {
        const id = index.entries.some(entry => entry.id === index.activeId) ? index.activeId : index.entries[0].id;
        const saved = await FindQueryStore.get(id);
        if (!saved) throw new Error('图片记录缺失，请保留现场后重试');
        hooks.set(saved); index.activeId = id;
      } else if (hooks.get().base64 && !index.initialized) {
        Object.assign(hooks.get(), { queryId: crypto.randomUUID(), queryName: '上次商品图片', searchGroupId: crypto.randomUUID() });
        index.groupId = hooks.get().searchGroupId;
        await FindQueryStore.write([hooks.get()], capture(hooks.get()));
      } else if (index.initialized) hooks.set(hooks.empty());
    }
    async function switchTo(id, fromBatch = false) {
      if ((!fromBatch && (hooks.busy() || batch)) || hooks.get().queryId === id) return;
      FindReviewUI.close();
      hooks.setBusy(true); hooks.refresh();
      try {
        await hooks.save();
        const saved = await FindQueryStore.get(id);
        if (!saved) throw new Error('找不到该图片的本地记录');
        hooks.bump(); hooks.set(saved); index.activeId = id;
        hooks.show(); await hooks.save();
      } finally { hooks.setBusy(false); hooks.refresh(); }
    }
    async function decode(file) {
      if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
      if (file.size > 20 * 1024 * 1024) throw new Error('原图超过20MB');
      const bitmap = await createImageBitmap(file);
      try {
        if (bitmap.width < 100 || bitmap.height < 100) throw new Error('图片尺寸 ' + bitmap.width + '×' + bitmap.height + ' 太小，宽高均需至少100像素');
        if (bitmap.width * bitmap.height > 50000000) throw new Error('图片像素过大，请先缩小到5000万像素以内');
        const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
        if (canvas.width < 100 || canvas.height < 100) throw new Error('图片比例过于狭长，压缩后短边不足100像素');
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const base64 = canvas.toDataURL('image/jpeg', 0.9);
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(base64));
        const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        const thumb = document.createElement('canvas'); thumb.width = Math.max(1, Math.round(canvas.width * 120 / Math.max(canvas.width, canvas.height))); thumb.height = Math.max(1, Math.round(canvas.height * 120 / Math.max(canvas.width, canvas.height)));
        thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);
        return { base64, fingerprint, thumbnail: thumb.toDataURL('image/jpeg', 0.65) };
      } finally { bitmap.close(); }
    }
    async function add(files, autoSearch = false, options = {}) {
      if (hooks.busy() || batch || !files.length) return;
      const previous = clone(hooks.get()), selected = [...new Set(options.selectedPlatforms || previous.selected)], first = [], warnings = [];
      let duplicateId = '';
      const token = hooks.bump(); importing = true; hooks.setBusy(true); message = ''; hooks.refresh();
      if (!index.groupId) index.groupId = crypto.randomUUID();
      try {
        await hooks.save();
        for (const file of files) {
          if (token !== hooks.generation()) break;
          if (index.entries.length >= FindQueryStore.maxQueries) { warnings.push('每组最多10张，请先移除不需要的图片'); break; }
          try {
            notice('正在导入 ' + file.name + '…');
            const image = await decode(file);
            if (token !== hooks.generation()) break;
            const duplicate = index.entries.find(entry => entry.fingerprint === image.fingerprint);
            if (duplicate) { duplicateId ||= duplicate.id; warnings.push(file.name + '：与“' + duplicate.name + '”重复，已跳过'); continue; }
            const next = { ...hooks.empty(), ...image, queryId: crypto.randomUUID(), queryName: file.name.slice(0, 120), searchGroupId: index.groupId, selected, selectionCustomized: true };
            // A batch starts with independent blank cost/style inputs.
            if (autoSearch) Object.assign(next, hooks.inputs());
            const nextIndex = capture(next);
            try { await FindQueryStore.write([next], nextIndex); }
            catch (error) { index.entries = index.entries.filter(entry => entry.id !== next.queryId); error.storageWrite = true; throw error; }
            first.push(next.queryId);
          } catch (error) { warnings.push(file.name + '：' + error.message); if (error.storageWrite) break; }
        }
        if (first.length) { hooks.set(await FindQueryStore.get(first[0])); hooks.show(); await hooks.save(); }
        else if (autoSearch && files.length === 1 && !index.entries.length) { hooks.set(hooks.empty()); hooks.status('failed', 'image_decode：' + warnings.join('；')); }
        notice((first.length ? '已添加 ' + first.length + ' 张。' : '') + warnings.join('；'));
      } finally { importing = false; hooks.setBusy(false); message = ''; hooks.refresh(); }
      if (autoSearch && first.length && token === hooks.generation()) await hooks.run(false);
      return { queryId: first[0] || duplicateId, imported: first.length > 0 };
    }
    async function addDataUrl(dataUrl, name, selected) {
      if (typeof dataUrl !== 'string' || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(dataUrl) || dataUrl.length > 8 * 1024 * 1024) throw new Error('桌面交接的首图格式无效');
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], String(name || '抖音商品首图.jpg').slice(0, 120), { type: blob.type || 'image/jpeg' });
      return add([file], false, { selectedPlatforms: selected });
    }
    async function searchById(id) {
      if (!id || hooks.busy() || batch) return;
      if (hooks.get().queryId !== id) await switchTo(id);
      if (hooks.get().queryId === id && !hooks.get().searched) await hooks.run(false);
    }
    async function remove() {
      if (hooks.busy() || batch || !hooks.get().queryId) return;
      const state = hooks.get();
      if (state.searched && !confirm('移除“' + state.queryName + '”及其浏览器搜索、审核记录？桌面任务仍保留。')) return;
      hooks.setBusy(true); hooks.refresh();
      try {
        await hooks.save();
        const nextIndex = clone(index);
        nextIndex.entries = nextIndex.entries.filter(entry => entry.id !== state.queryId);
        nextIndex.activeId = nextIndex.entries[0]?.id || '';
        if (!nextIndex.entries.length) nextIndex.groupId = '';
        await FindQueryStore.write([], nextIndex, [state.queryId]);
        index = nextIndex; hooks.bump();
        hooks.set(nextIndex.activeId ? await FindQueryStore.get(nextIndex.activeId) : hooks.empty());
        hooks.show(); await hooks.save(); message = '';
      } finally { hooks.setBusy(false); hooks.refresh(); }
    }
    async function forgetActive() {
      await hooks.save();
      const id = hooks.get().queryId, next = clone(index);
      next.entries = next.entries.filter(entry => entry.id !== id);
      next.activeId = '';
      if (!next.entries.length) next.groupId = '';
      await FindQueryStore.write([], next, id ? [id] : []);
      index = next; hooks.set(hooks.empty()); message = '';
    }
    async function clear() {
      if (hooks.busy() || batch || !index.entries.length) return;
      if (!confirm('清空这组 ' + index.entries.length + ' 张图片及其浏览器搜索、审核记录？桌面任务仍保留。')) return;
      hooks.setBusy(true); hooks.refresh();
      try {
        await hooks.save();
        const next = { activeId: '', groupId: '', entries: [] };
        await FindQueryStore.write([], next, index.entries.map(entry => entry.id));
        index = next; hooks.bump(); hooks.set(hooks.empty()); hooks.show(); await hooks.save();
        message = ''; notice('图片队列已清空，可以开始新一组。');
      } finally { hooks.setBusy(false); hooks.refresh(); }
    }
    async function runBatch(compare) {
      if (hooks.busy() || batch) return;
      const ids = index.entries.filter(entry => compare ? pending(entry) : !entry.searched).map(entry => entry.id);
      if (!ids.length) return;
      const current = { cancelled: false, blocked: new Set(), wake: null }; batch = current;
      hooks.refresh();
      let finished = 0;
      try {
        await hooks.save();
        for (const id of ids) {
          if (current.cancelled) break;
          await switchTo(id, true);
          if (current.cancelled) break;
          const state = hooks.get();
          if (!compare) {
            state.selected = state.selected.filter(key => !current.blocked.has(key));
            hooks.show();
            if (!state.selected.length) { message = '队列已暂停：所选平台需恢复权限或额度，请处理后继续。'; break; }
          }
          message = (compare ? '正在识别 ' : '正在搜索 ') + (finished + 1) + '/' + ids.length + ' · ' + state.queryName;
          hooks.refresh();
          await hooks.run(compare, true);
          await hooks.save();
          if (current.cancelled) break;
          for (const [key, record] of Object.entries(state.platforms)) {
            if (['quota', 'verification', 'permission', 'login', 'login_required'].includes(record.diagnostics?.failureKind)) current.blocked.add(key);
          }
          if (['input_invalid', 'failed'].includes(state.phase) || (compare && !['complete', 'desktop_queue'].includes(state.phase))) { message = '队列已暂停：' + state.message.slice(0, 180); break; }
          if (!compare && !Object.values(state.platforms).some(record => terminal.has(record.phase))) { message = '队列已暂停，请查看当前图片的平台状态。'; break; }
          finished++;
          if (finished < ids.length) await new Promise(resolve => { const timer = setTimeout(resolve, 1000); current.wake = () => { clearTimeout(timer); resolve(); }; });
        }
        if (finished === ids.length) message = compare ? '已处理 ' + finished + ' 张图片，请查看识别结果或桌面队列。' : '已搜索 ' + finished + ' 张图片，请逐张检查候选，再确认开始识别。';
      } catch (error) { notice('队列已暂停：' + error.message); }
      finally { if (batch === current) batch = null; hooks.refresh(); }
    }
    function cancel() {
      if (!batch) return;
      batch.cancelled = true; batch.wake?.(); message = '队列已暂停；未开始的图片可稍后继续。';
    }
    const handle = action => { void action().catch(error => notice(error.message)); };
    $('pickMany').onclick = () => $('files').click();
    $('files').onchange = () => { const files = Array.from($('files').files); $('files').value = ''; handle(() => add(files)); };
    $('queryList').onclick = event => { const button = event.target.closest('[data-query-id]'); if (button) handle(() => switchTo(button.dataset.queryId)); };
    $('removeQuery').onclick = () => handle(remove);
    $('clearQueries').onclick = () => handle(clear);
    $('searchQueries').onclick = () => handle(() => runBatch(false));
    $('compareQueries').onclick = () => handle(() => runBatch(true));
    $('stopQueries').onclick = () => { cancel(); hooks.stop(); };
    return { restore, capture, render, add, addDataUrl, searchById, cancel, forgetActive, running: () => !!batch };
  }
  return { create };
})();
