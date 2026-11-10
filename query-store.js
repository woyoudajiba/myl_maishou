globalThis.FindQueryStore = (() => {
  const maxQueries = 10;
  let connection;
  const open = () => connection ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('find-product-query-workspace', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('queries', { keyPath: 'id' });
    request.onerror = () => { connection = null; reject(request.error || new Error('多图存储无法打开')); };
    request.onblocked = () => { connection = null; reject(new Error('多图存储正被其他页面占用，请关闭旧工作台')); };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); connection = null; }; resolve(request.result); };
  });
  const read = async id => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('queries', 'readonly');
      const request = transaction.objectStore('queries').get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };
  const write = async (records, index, removeIds = []) => {
    const db = await open();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('queries', 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('多图记录保存失败'));
      const store = transaction.objectStore('queries');
      for (const id of removeIds) store.delete(id);
      for (const state of records) store.put({ id: state.queryId, state });
      store.put({ id: '$index', index });
    });
  };
  const loadIndex = async () => {
    const saved = (await read('$index'))?.index;
    if (!saved || !Array.isArray(saved.entries)) return { activeId: '', groupId: '', entries: [], initialized: false };
    if (saved.entries.length > maxQueries || saved.entries.some(entry => !/^[a-f0-9-]{36}$/i.test(entry.id))) throw new Error('多图索引异常，请保留现场后重试');
    return { ...saved, initialized: true };
  };
  return { maxQueries, loadIndex, get: async id => (await read(id))?.state, write };
})();
