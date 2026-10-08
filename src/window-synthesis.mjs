// Pure approved-data preparation, no reads or sends. No source text is silently clipped.
export function prepareWindowSynthesis(batchPayloads, measure) {
  if (!Array.isArray(batchPayloads) || batchPayloads.length < 2 || batchPayloads.length > 20) throw new Error('Invalid synthesis batches');
  const batches = batchPayloads.map(payload => JSON.parse(payload));
  const base = batches[0];
  const windows = batches.flatMap(batch => batch.windows);
  if (batches.some(batch => batch.snapshotId !== base.snapshotId || batch.file.id !== base.file.id || batch.sourceMode !== 'change-windows') || windows.length > 200 || new Set(windows.map(w => w.id)).size !== windows.length) throw new Error('Inconsistent synthesis windows');
  const windowIndex = windows.map(w => ({ id: w.id, editIds: w.editIds, old: { start: w.old.start, count: w.old.count }, new: { start: w.new.start, count: w.new.count } }));
  const payload = JSON.stringify({ ...base, windows: undefined, windowIndex, sourceMode: 'window-synthesis', windowNotice: '本请求综合检查所有窗口的共同影响，不重报单窗口问题；windowIndex仅为原始定位目录，不含源码，必须在批准catalog中读取相关旧新片段，不能仅凭目录认定缺陷。输出仍仅主file的发现，归因至少关联两个不同窗口的编辑；证据不足明确限制。' });
  const budget = measure(payload);
  return { payload, windows, windowIds: windows.map(w => w.id), budget };
}
