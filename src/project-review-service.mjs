import { renderProjectReport } from './project-report.mjs';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hash } from './content.mjs';
import { resolveWorkspaceRepository } from './workspace-repository.mjs';
import { detectVcs } from './snapshot.mjs';
import { projectInventory, captureProjectBatch } from './project-snapshot.mjs';
import { reviewProjectBatches, projectConcurrency as validateProjectConcurrency, DEFAULT_PROJECT_CONCURRENCY } from './project-execution.mjs';
import { createDshModel } from './dsh-model.mjs';
import { retrievalRounds } from './review-execution-policy.mjs';

const PREVIEW_NOTICE_SUFFIX = ' Full current source audit, not regression-only diff. Shared session execution budget: no internal elapsed-time or model-call cutoff, 16MiB capture memory protection. Blocked/excluded/pending files are not reviewed successfully. No untracked/ignored/external bodies; no complete semantic call graph. Independent approved batches run with bounded concurrency; per-batch evidence and global model-call budgets remain enforced. Show scope and model before confirmed execute.';
const REPORT_NOTICE_SUFFIX = ' Coverage counts processing of selected tracked files only, not proof of correctness. Excluded and blocked are never completed. No cross-batch whole-program semantic coverage is claimed.';

function owner(exec) {
  const a = exec?.agent;
  if (!a?.session?.header?.cwd || !a.options?.provider || !a.options?.model) throw new Error('Active Agent with cwd and model required');
  return { agent: a, cwd: a.session.header.cwd, route: { provider: a.options.provider, model: a.options.model, ...(a.options.reasoningEffort ? { reasoningEffort: a.options.reasoningEffort } : {}) } };
}

function makeCaptureBudget(signal) {
  let commands = 0, metadataBytes = 0;
  return {
    signal,
    reserve() { signal.throwIfAborted(); commands++; },
    charge(size) {
      metadataBytes += size;
      if (metadataBytes > 8 * 1024 * 1024) throw Object.assign(new Error('Project shared metadata budget exceeded'), { code: 'PROJECT_CAPTURE_BUDGET' });
    },
  };
}

async function captureProject(cwd, args, signal) {
  const captureBudget = makeCaptureBudget(signal);
  const captureOptions = { signal, svnCaptureBudget: captureBudget, selectedPaths: args.selectedPaths };
  const root = await realpath(await resolveWorkspaceRepository(cwd, args.repositoryPath));
  const vcs = await detectVcs(root);
  const inventory = await projectInventory(root, vcs, captureOptions);

  let paths = inventory.records.map(record => record.path);
  if (args.selectedPaths !== undefined) {
    if (!Array.isArray(args.selectedPaths) || args.selectedPaths.length > 1000 || new Set(args.selectedPaths).size !== args.selectedPaths.length || args.selectedPaths.some(p => !paths.includes(p))) throw new Error('Invalid tracked project selection');
    paths = paths.filter(p => args.selectedPaths.includes(p));
  }
  if (paths.length > 1000) throw new Error('Project exceeds 1000 tracked nodes; explicitly select a bounded file set instead of claiming full review');

  const batches = [];
  let bytes = 0;
  for (let i = 0; i < paths.length; i += 12) {
    const batch = await captureProjectBatch(inventory, paths.slice(i, i + 12), captureOptions);
    bytes += Buffer.byteLength(JSON.stringify(batch));
    if (bytes > 16 * 1024 * 1024) throw new Error('Project capture exceeds shared 16MiB limit; select fewer files');
    batches.push(batch);
  }

  const verified = await projectInventory(root, vcs, captureOptions);
  if (verified.id !== inventory.id) throw new Error('Project inventory changed during capture');
  for (const b of batches) {
    if ((await captureProjectBatch(verified, b.files.map(f => f.path), captureOptions)).id !== b.id) throw new Error('Project source changed during capture');
  }

  const result = {
    root, vcs, inventoryId: inventory.id, inventoryComplete: inventory.inventoryComplete,
    inventoryScope: inventory.inventoryScope, inventoryNodes: inventory.records.length,
    totalTrackedNodes: inventory.totalTrackedNodes, selectedFiles: paths.length,
    selectionComplete: inventory.inventoryScope !== 'selected' && paths.length === inventory.records.length, notice: inventory.notice, batches,
  };
  return { ...result, id: hash(JSON.stringify(result)) };
}

export function createProjectReviewService(llm, { allowModelSending = false, authorize = async () => false, now = Date.now, ttlMs = 300000, maxPreviews = 8, projectMaxCalls = Number.MAX_SAFE_INTEGER, projectConcurrency = DEFAULT_PROJECT_CONCURRENCY, maxRetrievalRounds = 3 } = {}) {
  for (const n of [ttlMs, maxPreviews]) if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid project preview limit');
  if (!Number.isSafeInteger(projectMaxCalls) || projectMaxCalls < 1) throw new Error('Invalid project model call limit');

  validateProjectConcurrency(projectConcurrency);
  retrievalRounds(maxRetrievalRounds);
  const previews = new Map();
  const lifetime = new AbortController();
  let busy = false;

  const signalFor = exec => AbortSignal.any([lifetime.signal, ...(exec.signal ? [exec.signal] : [])]);

  return {
    owns: id => previews.has(id),

    async preview(args, exec) {
      if (busy) throw new Error('Review service busy');
      if (!args || typeof args !== 'object') throw new Error('Project preview parameters required');
      if (Object.keys(args).some(k => !['reviewMode', 'repositoryPath', 'selectedPaths'].includes(k)) || args.reviewMode !== 'project') throw new Error('Project mode supports only reviewMode/repositoryPath/selectedPaths; change/history context parameters are not project parameters');
      const current = owner(exec);
      busy = true;
      try {
        const s = await captureProject(current.cwd, args, signalFor(exec));
        for (const [id, p] of previews) if (p.expires <= now()) previews.delete(id);
        while (previews.size >= maxPreviews) previews.delete(previews.keys().next().value);
        const previewId = randomUUID();
        previews.set(previewId, { ...current, args: structuredClone(args), snapshotId: s.id, expires: now() + ttlMs });
        return {
          previewId, snapshotId: s.id, reviewMode: 'project', repositoryRoot: s.root, vcs: s.vcs,
          model: current.route, modelSendingEnabled: allowModelSending,
          totalTrackedNodes: s.totalTrackedNodes, selectedFiles: s.selectedFiles, selectionComplete: s.selectionComplete,
          inventoryComplete: s.inventoryComplete, inventoryScope: s.inventoryScope, inventoryNodes: s.inventoryNodes, batches: s.batches.length,
          execution: { batchConcurrency: projectConcurrency, maxRetrievalRounds },
          files: s.batches.flatMap(b => b.files.map(f => ({ path: f.path, eligibility: f.eligibility, reason: f.reason }))),
          notice: s.notice + PREVIEW_NOTICE_SUFFIX + ' Each stage allows at most ' + maxRetrievalRounds + ' retrieval rounds; exhaustion requires a final-only response and explicit unfinished coverage.',
        };
      } finally { busy = false; }
    },

    async execute(args, exec) {
      if (busy) throw new Error('Review service busy');
      if (!allowModelSending) throw new Error('Model sending disabled');
      if (args.confirmed !== true || typeof args.previewId !== 'string' || Object.keys(args).some(k => !['previewId', 'confirmed'].includes(k))) throw new Error('Confirmed preview required');
      const p = previews.get(args.previewId);
      const current = owner(exec);
      if (!p || p.expires <= now() || p.agent !== current.agent || p.cwd !== current.cwd || JSON.stringify(p.route) !== JSON.stringify(current.route)) throw new Error('Preview missing expired or owner/model/directory changed');
      previews.delete(args.previewId);
      busy = true;
      const signal = signalFor(exec);
      try {
        const s = await captureProject(current.cwd, p.args, signal);
        if (s.id !== p.snapshotId) throw new Error('Project changed since preview');
        if (await authorize({ snapshot: s, route: p.route, exec }) !== true) throw new Error('Model sending denied');
        if (owner(exec).cwd !== p.cwd || JSON.stringify(owner(exec).route) !== JSON.stringify(p.route)) throw new Error('Agent changed during approval');
        signal.throwIfAborted();

        await exec.reviewCheckpoint?.({
          stage: 'approved-manifest', snapshotId: s.id,
          files: s.batches.flatMap(b => b.files.map(f => ({ fileId: f.id, path: f.path, status: f.eligibility === 'reviewable' ? 'pending' : f.eligibility }))),
        });

        let calls = 0;
        const adapter = createDshModel(llm, p.route, { correctJson: true });
        const model = request => {
          if (calls >= projectMaxCalls) throw Object.assign(new Error('Shared project model call limit exceeded'), { code: 'PROJECT_MODEL_CALL_LIMIT' });
          calls++;
          return adapter({ ...request, onProtocolCorrection: async info => {
            if (calls >= projectMaxCalls) throw Object.assign(new Error('Shared project model call limit exceeded'), { code: 'PROJECT_MODEL_CALL_LIMIT' });
            calls++;
            await request.onProtocolCorrection?.(info);
          }});
        };

        const results = await reviewProjectBatches(s.batches, model, {
          concurrency: projectConcurrency, maxRetrievalRounds, signal, remainingCalls: () => projectMaxCalls - calls,
          onProgress: exec.reviewCheckpoint,
        });

        const files = results.flatMap(r => r.files.map(f => ({ ...f, batchSnapshotId: r.snapshotId })));
        const coverage = {
          total: s.selectedFiles,
          completed: files.filter(f => f.status === 'completed').length,
          excluded: files.filter(f => f.status === 'excluded').length,
          blocked: files.filter(f => f.status === 'blocked').length,
          pending: files.filter(f => !['completed', 'excluded', 'blocked'].includes(f.status)).length,
        };
        const findings = results.flatMap(r => r.findings.map(f => ({ ...f, batchSnapshotId: r.snapshotId })));

        const report = {
          schemaVersion: 1, mode: 'project', snapshotId: s.id,
          status: signal.aborted ? 'cancelled'
            : coverage.total === 0 || coverage.completed === 0 ? 'partial'
            : results.every(r => r.status === 'completed') && files.every(f => ['completed', 'excluded'].includes(f.status)) ? 'completed'
            : 'partial',
          repositoryRoot: s.root, vcs: s.vcs, model: p.route, modelCalls: calls, maxModelCalls: projectMaxCalls,
          totalTrackedNodes: s.totalTrackedNodes, selectionComplete: s.selectionComplete, inventoryComplete: s.inventoryComplete, inventoryScope: s.inventoryScope, inventoryNodes: s.inventoryNodes,
          coverage, files, findings, batches: results,
          execution: { batchConcurrency: projectConcurrency, maxRetrievalRounds },
          notice: s.notice + REPORT_NOTICE_SUFFIX,
        };

        if (report.status === 'cancelled') report.outdated = true;
        else {
          await exec.reviewCheckpoint?.({ stage: 'source-freshness', snapshotId: s.id });
          signal.throwIfAborted();
          try { report.outdated = (await captureProject(current.cwd, p.args, signal)).id !== s.id; }
          catch { signal.throwIfAborted(); report.outdated = true; }
          signal.throwIfAborted();
        }
        return { report, markdown: renderProjectReport(report) };
      } finally { busy = false; }
    },

    dispose() { lifetime.abort(); previews.clear(); },
  };
}
