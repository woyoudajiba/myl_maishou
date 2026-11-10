(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FindVisionQueue = api;
})(globalThis, function () {
  const defaultConcurrency = 3, maxConcurrency = 4;
  const concurrency = value => Number.isInteger(value) && value >= 1 && value <= maxConcurrency ? value : defaultConcurrency;
  // Drain already running work even when another worker fails. Callers own
  // cancellation and paid-request error handling; this never retries a task.
  async function run(count, limit, stopped, task) {
    let next = 0, failed = false;
    const worker = async () => {
      while (!failed && !stopped() && next < count) {
        const index = next++;
        try { await task(index); } catch (error) { failed = true; throw error; }
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(count, concurrency(limit)) }, worker));
    const error = results.find(result => result.status === 'rejected');
    if (error) throw error.reason;
  }
  return { defaultConcurrency, maxConcurrency, concurrency, run };
});
