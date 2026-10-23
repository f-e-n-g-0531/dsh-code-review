import { recoveryCoverage } from './recovery-coverage.mjs';

const NOTICE = 'Percent measures terminal primary-file processing, not successful review or synthesis completion. Unknown capture denominator is null, never invented.';

export function jobProgress(record) {
  const r = recoveryCoverage(record);
  const counts = { completed: 0, excluded: 0, blocked: 0, failed: 0, cancelled: 0, pending: 0 };
  for (const f of r.files) counts[f.status] = (counts[f.status] ?? 0) + 1;
  const terminal = !['queued', 'running'].includes(record.status);
  const processed = r.files.filter(f => !['pending'].includes(f.status)).length;
  return {
    stage: record.stage,
    terminal,
    elapsedMs: Math.max(0, (record.finishedAt ? Date.parse(record.finishedAt) : Date.now()) - Date.parse(record.createdAt)),
    total: r.manifestSaved ? r.files.length : null,
    counts,
    processed,
    percent: r.manifestSaved && r.files.length ? Math.floor(100 * processed / r.files.length) : null,
    notice: NOTICE,
  };
}
