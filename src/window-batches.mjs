// Bounded pure planner. Every window is either in one batch or explicitly blocked.
export function planWindowBatches(windows, serialize, measure, { maxBatches = 20 } = {}) {
  if (!Array.isArray(windows) || windows.length > 200 || typeof serialize !== 'function' || typeof measure !== 'function' || !Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 20) throw new Error('Invalid window batch plan');
  const ids = new Set();
  for (const window of windows) {
    if (!window || typeof window.id !== 'string' || !window.id || ids.has(window.id)) throw new Error('Invalid window identity');
    ids.add(window.id);
  }
  const batches = [], blocked = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    const payload = serialize(current);
    const budget = measure(payload);
    if (!budget.fits) throw new Error('Inconsistent window measurement');
    batches.push({ windowIds: current.map(w => w.id), payload, bytes: budget.bytes });
    current = [];
  };
  for (const window of windows) {
    if (batches.length >= maxBatches) { blocked.push({ windowId: window.id, reason: 'batch-limit' }); continue; }
    const candidate = [...current, window];
    if (measure(serialize(candidate)).fits) { current = candidate; continue; }
    flush();
    if (batches.length >= maxBatches) blocked.push({ windowId: window.id, reason: 'batch-limit' });
    else if (measure(serialize([window])).fits) current = [window];
    else blocked.push({ windowId: window.id, reason: 'input-budget' });
  }
  flush();
  return { batches, blocked, minimumCalls: batches.length };
}
