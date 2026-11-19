const bytes = value => typeof value === 'string' ? Buffer.byteLength(value) : 0;
const rows = value => Array.isArray(value) ? value : [];
const count = value => Number.isSafeInteger(value) && value >= 0;

export function reviewSize(snapshot, report, plan) {
  const files = rows(snapshot?.files);
  const approved = files.filter(file => file.eligibility === 'reviewable');
  const side = name => approved.reduce((sum, file) => sum + bytes(file[name]?.text), 0);
  const oldSourceBytes = side('left'), newSourceBytes = side('right');
  const contextBytes = rows(snapshot?.context).reduce((sum, item) => sum + bytes(item.text) + bytes(item.oldText), 0);
  const initial = plan?.inputBudget?.wireBytes ?? report?.orchestration?.inputBudget?.wireBytes;
  const measured = count(initial) ? [initial] : rows(plan?.items ?? report?.files).map(file => file.initialInputBytes).filter(count);
  const reports = report?.batches ?? (report ? [report] : []);
  const metrics = reports.flatMap(batch => [batch.orchestration, ...rows(batch.files)].flatMap(row => Object.values(row?.modelMetrics ?? {})));
  const calls = metrics.reduce((sum, row) => sum + (count(row.calls) ? row.calls : 0), 0);
  const metric = key => metrics.reduce((sum, row) => sum + (count(row[key]) ? row[key] : 0), 0);
  return {
    unit: 'UTF-8 bytes', oldSourceBytes, newSourceBytes, sourceBytes: oldSourceBytes + newSourceBytes, contextBytes,
    sourceFileCount: approved.length, excludedFileCount: files.filter(file => file.eligibility === 'excluded').length,
    initialInputBytes: measured.length ? measured.reduce((sum, value) => sum + value, 0) : null,
    initialInputUnits: measured.length,
    modelPayloadInputBytes: calls ? metric('inputBytes') : null,
    modelObservedOutputBytes: calls ? metric('totalOutputBytes') : null,
    modelMeasuredCalls: calls,
  };
}
