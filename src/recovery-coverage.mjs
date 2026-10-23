// Saved evidence is a ledger, not renewed source authority or automatic resume.
const NOTICE = 'Saved approved manifest (when present) plus checkpoints; before that, only observed scope, not a complete denominator. Completed windows are not a completed file. New source sends require fresh preview and confirmation; no approval is restored from this ledger.';

export function recoveryCoverage(record) {
  const states = new Map(), windows = new Map(), stages = new Map();
  for (const c of record.checkpoints ?? []) {
    if (c.stage === 'synthesis-failed') stages.set(c.path, { path: c.path, phase: c.phase, status: c.status, code: c.code });
    if (c.stage === 'approved-manifest') for (const f of c.files ?? []) states.set(f.path, { path: f.path, status: f.status, snapshotId: c.snapshotId });
    if (c.stage === 'file-started') states.set(c.path, { path: c.path, status: ['excluded', 'blocked'].includes(c.status) ? c.status : 'pending', snapshotId: c.snapshotId });
    if (c.stage === 'file-complete' && c.file) states.set(c.file.path, { path: c.file.path, status: c.file.status, snapshotId: c.snapshotId });
    if (c.stage === 'batch-complete') for (const f of c.files ?? []) states.set(f.path, { path: f.path, status: f.status, snapshotId: c.snapshotId });
    if (c.stage === 'window-complete') windows.set(c.path, { path: c.path, snapshotId: c.snapshotId, ...c.windowCoverage });
  }
  const final = record.result?.report;
  if (final?.files) for (const f of final.files) states.set(f.path, { path: f.path, status: f.status, snapshotId: f.batchSnapshotId ?? final.snapshotId });
  const files = [...states.values()];
  for (const f of final?.files ?? []) for (const failure of f.stageFailures ?? []) stages.set(f.path, { path: f.path, ...failure });
  return {
    unfinishedStages: [...stages.values()],
    manifestSaved: (record.checkpoints ?? []).some(c => c.stage === 'approved-manifest'),
    files,
    windows: [...windows.values()],
    suggestedPaths: [...new Set([...files.filter(f => !['completed', 'excluded'].includes(f.status)).map(f => f.path), ...stages.keys()])],
    notice: NOTICE,
  };
}
