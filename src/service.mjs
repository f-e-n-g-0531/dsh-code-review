import { randomUUID } from 'node:crypto';
import { captureSnapshot } from './snapshot.mjs';
import { reviewSnapshot, markdownReport } from './review.mjs';
import { createDshModel } from './dsh-model.mjs';

function owner(exec) {
  const agent = exec?.agent;
  const cwd = agent?.session?.header?.cwd;
  if (!agent || typeof cwd !== 'string' || !cwd || !agent.options?.provider || !agent.options?.model) throw new Error('Active Agent with cwd and model is required');
  return { agent, cwd, route: { provider: agent.options.provider, model: agent.options.model, ...(agent.options.reasoningEffort ? { reasoningEffort: agent.options.reasoningEffort } : {}) } };
}
export function createReviewService(llm, { capture = captureSnapshot, now = Date.now, ttlMs = 300000, maxPreviews = 8, allowModelSending = false, authorize = async () => false } = {}) {
  for (const value of [ttlMs, maxPreviews]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid preview limit');
  const lifetime = new AbortController();
  const bind = exec => ({ ...exec, signal: exec.signal ? AbortSignal.any([exec.signal, lifetime.signal]) : lifetime.signal });
  const previews = new Map();
  let busy = false;
  function prune() { for (const [id, p] of previews) if (p.expires <= now()) previews.delete(id); }
  return {
    async preview(args, exec) {
      exec = bind(exec);
      exec.signal.throwIfAborted();
      if (busy) throw new Error('Review service busy');
      if (!args || Object.keys(args).some(k => !['selectedPaths', 'contextPaths'].includes(k))) throw new Error('Unknown preview argument');
      for (const key of ['selectedPaths', 'contextPaths']) if (args[key] !== undefined && (!Array.isArray(args[key]) || args[key].length > 200 || args[key].some(p => typeof p !== 'string'))) throw new Error('Invalid path list');
      const current = owner(exec);
      busy = true;
      try {
        const options = structuredClone(args);
        const snapshot = await capture(current.cwd, { ...options, signal: exec.signal });
        exec.signal?.throwIfAborted();
        if (owner(exec).cwd !== current.cwd) throw new Error('Agent directory changed; preview again');
        prune();
        while (previews.size >= maxPreviews) previews.delete(previews.keys().next().value);
        const previewId = randomUUID();
        previews.set(previewId, { ...current, options, snapshotId: snapshot.id, expires: now() + ttlMs });
        return { previewId, snapshotId: snapshot.id, repositoryRoot: snapshot.root, vcs: snapshot.vcs, model: current.route, modelSendingEnabled: allowModelSending, files: snapshot.files.map(f => ({ path: f.path, eligibility: f.eligibility, reason: f.reason })), contextPaths: snapshot.context.map(c => c.path), notice: '执行会向上述模型提供方发送可审查文件两侧内容及显式上下文。请先向用户展示范围，获得确认后执行。' };
      } finally { busy = false; }
    },
    async execute(args, exec) {
      exec = bind(exec);
      exec.signal.throwIfAborted();
      if (busy) throw new Error('Review service busy');
      if (!allowModelSending) throw new Error('Model sending is disabled by plugin configuration');
      if (!args || Object.keys(args).some(k => !['previewId', 'confirmed'].includes(k)) || args.confirmed !== true || typeof args.previewId !== 'string') throw new Error('Confirmed preview is required');
      prune();
      const current = owner(exec), preview = previews.get(args.previewId);
      if (!preview || preview.agent !== current.agent || preview.cwd !== current.cwd || JSON.stringify(preview.route) !== JSON.stringify(current.route)) throw new Error('Preview missing, expired or owner/model/directory changed');
      busy = true;
      previews.delete(args.previewId);
      try {
        const snapshot = await capture(current.cwd, { ...preview.options, signal: exec.signal });
        exec.signal?.throwIfAborted();
        if (snapshot.id !== preview.snapshotId || owner(exec).cwd !== current.cwd) throw new Error('Files changed since preview; preview again');
        if (await authorize({ snapshot, route: preview.route, exec }) !== true) throw new Error('Model sending approval denied or unavailable');
        exec.signal?.throwIfAborted();
        if (owner(exec).cwd !== current.cwd || JSON.stringify(owner(exec).route) !== JSON.stringify(preview.route)) throw new Error('Agent changed during approval');
        const report = await reviewSnapshot(snapshot, createDshModel(llm, preview.route), { signal: exec.signal });
        report.model = preview.route;
        const latest = await capture(current.cwd, { ...preview.options, signal: exec.signal }).catch(() => null);
        report.outdated = !latest || latest.id !== snapshot.id || owner(exec).cwd !== current.cwd;
        return { report, markdown: markdownReport(report) + (report.outdated ? '\n注意：代码已变化或无法重新验证，报告仅对应原快照。\n' : '') };
      } finally { busy = false; }
    },
    dispose() { lifetime.abort(new Error('Review service disposed')); previews.clear(); },
  };
}
