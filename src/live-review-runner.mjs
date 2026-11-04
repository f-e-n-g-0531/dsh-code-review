// Orchestrates registered host tools only. Fixture tests are NOT live review evidence.
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const clone = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function requireValue(ok, message) { if (!ok) throw new Error(message); }
function decode(raw) {
  const value = typeof raw?.json === 'string' ? JSON.parse(raw.json) : raw;
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Invalid tool JSON object');
  return value;
}
function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function aborted() { const error = new Error('Live review interrupted'); error.name = 'AbortError'; return error; }

/**
 * Inject {start,wait,status,cancel?} aliases OR the registered code_review_* methods.
 * authorized:true is explicit caller authorization, not a replacement for host policy.
 * onRecord is awaited after EVERY tool response, before inspection or the next call;
 * persist record.raw unchanged (including its complete markdown/json strings).
 * Returns every requested attempt, not the best attempt. No resume or private reads.
 */
export async function runLiveReview({ tools, previewArgs, expected, runs = 1, authorized, onRecord, signal } = {}) {
  requireValue(authorized === true, 'Explicit authorized:true required');
  requireValue(Number.isSafeInteger(runs) && runs >= 1 && runs <= 3, 'runs must be 1..3');
  requireValue(typeof onRecord === 'function', 'Durable onRecord callback required');
  requireValue(previewArgs && typeof previewArgs === 'object' && !Array.isArray(previewArgs), 'previewArgs required');
  requireValue(!Object.hasOwn(previewArgs, 'resumeFromJobId'), 'Resume is forbidden; every run requires a fresh preview');
  requireValue(expected && ['runtimeVersion', 'provider', 'model', 'baseRevision'].every(k => typeof expected[k] === 'string' && expected[k]), 'Fixed runtime/model/baseRevision expected values required');
  requireValue(count(expected.fileCount), 'Fixed fileCount required');
  const fixed = clone(expected), args = clone(previewArgs);
  const api = Object.fromEntries(['start', 'wait', 'status', 'cancel'].map(k => [k, tools?.[k]?.bind(tools) ?? tools?.['code_review_' + k]?.bind(tools)]));
  for (const k of ['start', 'wait', 'status']) requireValue(typeof api[k] === 'function', 'Registered tool missing: ' + k);
  const result = { status: 'completed', requestedRuns: runs, expected: clone(fixed), runs: [], records: [] };
  let activeJob, currentRun = 0, baseline, cancelPromise;
  async function save(kind, phase, raw, extra = {}) {
    const record = { run: currentRun, kind, phase, ...extra, raw: clone(raw) };
    result.records.push(record);
    await onRecord(clone(record));
    return record;
  }
  async function cancel() {
    if (!activeJob || !api.cancel) return;
    if (!cancelPromise) cancelPromise = (async () => {
      try { await save('cancel', 'interrupt', await api.cancel({ jobId: activeJob })); }
      catch (error) { result.cancelError = error.message; }
    })();
    await cancelPromise;
  }
  // The registered wait really blocks for up to 60s; no status polling or sleeps.
  async function call(kind, phase, input) {
    if (signal?.aborted) throw aborted();
    const raw = await api[kind](input);
    // Learn a newly accepted job even if cancellation arrived during start.
    if (kind === 'start') {
      try { activeJob = decode(raw).jobId; cancelPromise = undefined; } catch { /* preserve malformed raw below */ }
    }
    await save(kind, phase, raw, { args: clone(input) });
    if (signal?.aborted) { await cancel(); throw aborted(); }
    return decode(raw);
  }
  async function terminal(phase, input) {
    let value = await call('start', phase, input);
    requireValue(typeof value.jobId === 'string' && value.jobId, 'Missing background jobId');
    const jobId = value.jobId;
    // Even an immediately terminal start gets a terminal wait for the full Markdown.
    do {
      requireValue(count(value.waitRevision), 'Missing exact waitRevision');
      value = await call('wait', phase, { jobId, after: value.waitRevision, waitFor: 'terminal', timeoutMs: 60000 });
      requireValue(value.jobId === jobId, 'Background job identity changed');
      requireValue(TERMINAL.has(value.status) || ['queued', 'running'].includes(value.status), 'Unknown job status');
    } while (!TERMINAL.has(value.status));
    activeJob = undefined;
    return value;
  }
  async function previewFiles(value) {
    const p = value.resultSummary;
    requireValue(p?.previewId, 'Terminal preview has no previewId');
    const total = p.filePage?.total ?? p.files?.length;
    requireValue(count(total), 'Preview file total unavailable');
    const files = [...(p.files ?? [])];
    while (files.length < total) {
      const page = await call('status', 'preview', { jobId: value.jobId, offset: files.length, limit: 100 });
      const summary = page.resultSummary;
      requireValue(summary?.previewId === p.previewId && summary.filePage?.total === total, 'Preview pagination identity/total changed');
      requireValue(summary.files?.length > 0, 'Preview pagination made no progress');
      files.push(...summary.files);
    }
    requireValue(files.length === total, 'Preview file pagination overflow');
    return { ...p, files, fileCount: total };
  }
  function inspect(p) {
    requireValue(!p.resume, 'Resumed preview forbidden');
    requireValue(p.modelSendingEnabled === true, 'Preview model sending not enabled');
    if (fixed.execution !== undefined) requireValue(same(p.execution, fixed.execution), 'Preview execution policy mismatch');
    if (fixed.repositoryUuid !== undefined) requireValue(p.history?.repositoryUuid === fixed.repositoryUuid, 'Preview repository UUID mismatch');
    if (fixed.repositoryUrl !== undefined) requireValue(p.history?.url === fixed.repositoryUrl, 'Preview repository URL mismatch');
    requireValue(p.runtime?.version === fixed.runtimeVersion, 'Preview runtimeVersion mismatch');
    requireValue(p.model?.provider === fixed.provider && p.model?.model === fixed.model, 'Preview model destination mismatch');
    requireValue(p.history?.base === fixed.baseRevision, 'Preview baseRevision mismatch');
    if (fixed.targetRevision !== undefined) requireValue(p.history?.target === fixed.targetRevision, 'Preview targetRevision mismatch');
    requireValue(p.fileCount === fixed.fileCount, 'Preview selected fileCount mismatch');
    requireValue(typeof p.snapshotId === 'string' && p.snapshotId, 'Preview snapshotId required');
    if (fixed.snapshotId !== undefined) requireValue(p.snapshotId === fixed.snapshotId, 'Preview snapshot mismatch');
    // Pin first observed source too: expected is never rewritten on source drift.
    const identity = { snapshotId: p.snapshotId, history: p.history, model: p.model, repositoryRoot: p.repositoryRoot, vcs: p.vcs, changeScope: p.changeScope, files: p.files, execution: p.execution, rules: p.rules, contextPaths: p.contextPaths, businessRequirement: p.businessRequirement };
    if (baseline) requireValue(same(identity, baseline), 'Source/scope/destination changed between fresh previews; stopped');
    else baseline = clone(identity);
  }
  async function collect(value) {
    const summary = value.resultSummary;
    if (!summary || summary.previewId) return { jobStatus: value.status, reportStatus: null, terminal: value };
    const files = [], findings = [];
    const totalFiles = summary.totalFiles, totalFindings = summary.totalFindings;
    requireValue(count(totalFiles) && count(totalFindings), 'Report totals unavailable');
    let page = value, offset = 0;
    while (offset < Math.max(totalFiles, totalFindings) || offset === 0) {
      const data = page.resultPage;
      requireValue(data && data.totalFiles === totalFiles && data.totalFindings === totalFindings, 'Report pagination totals changed');
      requireValue(page.resultSummary?.status === summary.status && page.resultSummary?.snapshotId === summary.snapshotId, 'Report pagination identity changed');
      const f = data.files ?? [], g = data.findings ?? [];
      requireValue(Array.isArray(f) && Array.isArray(g), 'Invalid result page arrays');
      const width = Math.max(f.length, g.length);
      files.push(...f); findings.push(...g);
      if (files.length === totalFiles && findings.length === totalFindings) break;
      requireValue(width > 0 && files.length <= totalFiles && findings.length <= totalFindings, 'Report pagination made no progress/overflow');
      offset += width;
      page = await call('status', 'execute', { jobId: value.jobId, offset, limit: 100 });
    }
    requireValue(files.length === totalFiles && findings.length === totalFindings, 'Incomplete report pagination');
    return { jobStatus: value.status, reportStatus: summary.status, report: { ...summary, files, findings }, terminal: value, fullMarkdown: value.finalMarkdown ?? null };
  }
  const onAbort = () => { void cancel(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (currentRun = 1; currentRun <= runs; currentRun++) {
      const attempt = { run: currentRun };
      result.runs.push(attempt);
      const preview = await terminal('preview', { phase: 'preview', previewArgs: clone(args) });
      attempt.previewTerminal = preview;
      if (preview.status !== 'completed') { result.status = 'stopped'; result.reason = 'Preview job ' + preview.status; break; }
      const selected = await previewFiles(preview);
      inspect(selected);
      attempt.preview = selected;
      const executed = await terminal('execute', { phase: 'execute', previewId: selected.previewId, confirmed: true });
      attempt.executeTerminal = executed;
      if (executed.resultSummary?.snapshotId !== undefined) requireValue(executed.resultSummary.snapshotId === selected.snapshotId, 'Execute report snapshot changed');
      if (executed.resultSummary?.model !== undefined) requireValue(executed.resultSummary.model.provider === fixed.provider && executed.resultSummary.model.model === fixed.model, 'Execute report model destination changed');
      Object.assign(attempt, await collect(executed));
      if (attempt.report?.outdated === true) { result.status = 'stopped'; result.reason = 'Source freshness check failed; stopped'; break; }
      // Failure/partial is data, never a reason to add retries or resume.
      // A host source revalidation failure must stop all remaining runs.
      if (executed.status !== 'completed') { result.status = 'stopped'; result.reason = 'Execute job ' + executed.status; break; }
    }
  } catch (error) {
    result.status = signal?.aborted ? 'interrupted' : 'stopped';
    result.reason = error.message;
    await cancel();
    await save('error', 'orchestration', { name: error.name, message: error.message });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) await cancel();
    if (cancelPromise) await cancelPromise;
  }
  return result;
}
