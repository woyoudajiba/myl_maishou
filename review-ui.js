globalThis.FindReviewUI = (() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let dialog;
  function open({ item, query, candidateImage, onSave, isBuyerSupplier = false }) {
    if (!FindReview.comparison(item)) return;
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.id = 'reviewDialog'; dialog.className = 'review-dialog';
      dialog.setAttribute('aria-labelledby', 'reviewTitle'); document.body.append(dialog);
    }
    if (dialog.open) return;
    const human = FindReview.decision(item), model = item.visualComparison;
    dialog.innerHTML = `<div class="review-heading"><h2 id="reviewTitle">核对商品款式</h2><button type="button" id="closeReview">关闭</button></div>
      <p>${esc(item.goodsId || item.title || item.id)} · ${esc(FindReview.status(item, 'manual'))}</p>
      <div class="review-images"><figure><figcaption>原图</figcaption><img class="review-source" alt="原始商品图"></figure><figure><figcaption>候选商品图</figcaption><img class="review-candidate" alt="候选商品图" referrerpolicy="no-referrer"></figure></div>
      <p class="review-hint">${item.imageEvidence ? `送模图片 ${esc(item.imageEvidence.width)}×${esc(item.imageEvidence.height)}，来源 ${esc(item.imageEvidence.sourceWidth)}×${esc(item.imageEvidence.sourceHeight)}。` : '旧任务未保存送模图片，建议用高清图重新比对。'}点击图片展开查看；无法看清时选择“无法判断”。</p>
      <section class="review-evidence"><div class="review-score"><strong>模型匹配分：${esc(FindReview.scoreText(FindReview.modelScore(item)))}</strong><span>模型原始建议：${esc(FindReview.labels[model.verdict])}</span></div>${['matches', 'differences', 'uncertainties'].map((key, index) => `<p>${['吻合', '差异', '待核实'][index]}：${esc((model[key] || []).join('；') || '无')}</p>`).join('')}</section>
      <p class="review-hint">优先核对品类、廓形、领口、门襟、袖型、口袋、下摆、拼接、图案位置和装饰。颜色、光线或拍摄背景不同通常不影响同款判断；匹配分只用于排序参考，不代表同款概率。</p>
      <p class="review-hint buyer-review-next-step">${isBuyerSupplier ? '确认同款后，将继续供应商资料采集。' : item.platform === 'taobao' ? '确认同款后，可回到买手任务选择套图来源。' : '确认同款后，将进入供应商资料采集。'}</p>
      <label class="review-note-label">补充说明（可选）<textarea id="reviewNote" maxlength="500" rows="2" placeholder="可记录款式细节或判断依据"></textarea></label>
      <details class="review-advanced"><summary>补充审核选项（可选）</summary><label>人工结论<select id="humanVerdict">${Object.entries(FindReview.labels).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label><label>调整参考分（可留空）<input id="humanScore" type="number" min="0" max="100" step="any"></label><button type="button" id="saveReview">保存补充审核</button><button type="button" id="agreeReview">采纳模型建议</button></details>
      <p id="reviewError" role="alert"></p><div class="review-actions"><button type="button" class="confirm-same" data-verdict="likely_same">确认同款并继续</button><button type="button" class="exclude-candidate" data-verdict="different">排除候选</button><button type="button" class="cannot-decide" data-verdict="uncertain">无法判断</button>${human ? '<button type="button" id="clearReview">撤销本条审核</button>' : ''}</div>`;
    dialog.querySelector('.review-source').src = query || '';
    dialog.querySelector('.review-candidate').src = candidateImage || item.imageEvidence?.sourceUrl || item.imageUrl;
    dialog.querySelector('#reviewNote').value = human?.note || '';
    dialog.querySelector('#humanVerdict').value = human?.verdict || model.verdict;
    dialog.querySelector('#humanScore').value = (human ? FindReview.effectiveScore(item) : FindReview.modelScore(item)) ?? '';
    dialog.querySelector('#humanScore').disabled = model.verdict === 'uncertain';
    dialog.querySelector('#humanVerdict').onchange = () => { dialog.querySelector('#humanScore').disabled = dialog.querySelector('#humanVerdict').value === 'uncertain'; };
    dialog.querySelector('#closeReview').onclick = () => dialog.close();
    dialog.querySelectorAll('img').forEach(img => {
      img.onclick = () => img.classList.toggle('expanded');
      img.onerror = () => { dialog.querySelector('.review-hint').textContent = '图片加载失败，请关闭后打开商品详情核实；不要凭空确认。'; };
    });
    let saving = false;
    const save = async input => {
      if (saving) return;
      saving = true;
      dialog.querySelectorAll('button').forEach(button => { button.disabled = true; });
      try { await onSave(input); dialog.close(); }
      catch (error) { dialog.querySelector('#reviewError').textContent = error.message || '审核保存失败'; }
      finally { saving = false; dialog.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
    };
    dialog.querySelectorAll('[data-verdict]').forEach(button => button.addEventListener('click', () => {
      const verdict = button.dataset.verdict, note = dialog.querySelector('#reviewNote').value.trim();
      const defaults = { likely_same: '人工确认同款', different: '人工排除候选', uncertain: '人工判断为无法判断' };
      void save({ verdict, note: note || defaults[verdict], ...(isBuyerSupplier && verdict === 'likely_same' ? { continueBuyer: true } : {}) });
    }));
    const compatSave = () => {
      const verdict = dialog.querySelector('#humanVerdict').value, rawScore = dialog.querySelector('#humanScore').value.trim();
      void save({ verdict, ...(verdict === 'uncertain' ? { score: null } : rawScore === '' ? {} : { score: Number(rawScore) }), note: dialog.querySelector('#reviewNote').value });
    };
    dialog.querySelector('#saveReview').onclick = compatSave;
    dialog.querySelector('#agreeReview').onclick = () => save({ verdict: model.verdict, score: FindReview.modelScore(item), note: dialog.querySelector('#reviewNote').value });
    const clear = dialog.querySelector('#clearReview');
    if (clear) clear.onclick = () => save(null);
    dialog.querySelector('#reviewNote').oninput = () => { dialog.querySelector('#reviewError').textContent = ''; };
    dialog.oncancel = event => { if (saving) event.preventDefault(); };
    dialog.showModal();
  }
  return { open, close: () => dialog?.close() };
})();
