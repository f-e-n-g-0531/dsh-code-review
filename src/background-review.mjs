import path from 'node:path';
import os from 'node:os';
import { createReviewJobs } from './review-jobs.mjs';
import { reviewToolOutput } from './tool-view.mjs';

const START_DESCRIPTION = 'Start a durable background preview or confirmed review. Returns a job ID immediately, NOT task completion. Keep the user request active using code_review_wait until terminal status; never final-answer only that a task started. Preview phase never sends source. For execute supply the approved previewId and confirmed=true. Use code_review_status to collect progress/results; code_review_cancel to stop. Does not automatically resume after host restart or grant new source approval.';
const START_PARAMETERS = { type: 'object', additionalProperties: false, properties: { phase: { type: 'string', enum: ['preview', 'execute'] }, previewArgs: { type: 'object', description: 'Same parameters as code_review_preview; do not include execute fields.' }, previewId: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['phase'] };

const STATUS_DESCRIPTION = 'Read a background review task owned by this session, directory and model. Returns saved progress or final preview/report. completed task means the tool returned; inspect nested report coverage/status. Interrupted tasks retain checkpoints but require new preview and approval to resend.';
const STATUS_PARAMETERS = { type: 'object', additionalProperties: false, properties: { jobId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, checkpointIndex: { type: 'integer', minimum: 0, description: 'Read one checkpoint nested files/findings page; offset/limit apply within it.' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['jobId'] };

const CANCEL_DESCRIPTION = 'Cancel a background review task owned by this session. Does not discard saved checkpoints. No source is sent by cancellation.';
const CANCEL_PARAMETERS = { type: 'object', additionalProperties: false, properties: { jobId: { type: 'string' } }, required: ['jobId'] };

const WAIT_DESCRIPTION = 'Wait for review progress or terminal result without ending the user request. Prefer waitFor=terminal to ignore intermediate checkpoints; progress preserves checkpoint-by-checkpoint compatibility. Reuse the exact returned waitRevision as after; never guess increments or call status after every event. Timeout defaults to 60000ms and is bounded to 60000ms; changed=false means timeout, not completion or cancellation. Call again while queued/running. Preview completion requires confirmation; execute completion returns one final consolidated report.';
const WAIT_PARAMETERS = { type: 'object', additionalProperties: false, properties: { jobId: { type: 'string' }, after: { type: 'integer', minimum: 0, description: 'Exact waitRevision returned by start/status/wait; do not increment it yourself.' }, waitFor: { type: 'string', enum: ['progress', 'terminal'], default: 'progress', description: 'Use terminal to wait through intermediate saves; progress wakes on each durable checkpoint.' }, timeoutMs: { type: 'integer', minimum: 1, maximum: 60000, default: 60000 } }, required: ['jobId'] };

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'interrupted'];
const REPORT_STATUSES = ['completed', 'partial', 'failed', 'cancelled'];
const COVERAGE_FIELDS = ['completed', 'excluded', 'blocked', 'failed', 'cancelled', 'pending'];
const LIMIT_CODES = ['READER_CALL_BUDGET_EXCEEDED', 'READER_OUTPUT_BUDGET_EXCEEDED', 'RETRIEVAL_ROUND_BUDGET_EXCEEDED'];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : '不可用';
function terminalSummary(value) {
  const report = value.resultSummary;
  const lines = ['审查任务已结束：' + value.status, 'jobId: ' + value.jobId];
  if (value.progress) lines.push('elapsedMs: ' + count(value.progress.elapsedMs));
  if (report && REPORT_STATUSES.includes(report.status)) {
    lines.push('报告状态：' + report.status + '；任务结束不等于所有审查通过。');
    lines.push('文件覆盖：' + COVERAGE_FIELDS.map(key => key + ' ' + count(report.coverage?.[key])).join('；'));
    lines.push('总文件：' + count(report.totalFiles) + '；总发现：' + count(report.totalFindings) + '；限制项：' + count(report.totalLimitations));
    lines.push('模型调用：' + count(report.modelCalls ?? report.diagnostics?.modelCalls));
    const d = report.diagnostics;
    if (d?.readerBudget) {
      const b = d.readerBudget;
      lines.push('共享读取预算：调用 ' + count(b.calls) + '/' + count(b.maxCalls) + '，输出字节 ' + count(b.outputBytes) + '/' + count(b.maxOutputBytes) + '；剩余调用 ' + count(b.remainingCalls) + '，剩余字节 ' + count(b.remainingOutputBytes));
    }
    const reasons = Array.isArray(d?.readerLimitReasons) ? d.readerLimitReasons : [];
    const bounded = LIMIT_CODES.flatMap(code => { const row = reasons.find(item => item?.code === code); return row ? [code + ' ' + count(row.calls)] : []; });
    if (bounded.length) lines.push('读取限制原因：' + bounded.join('；'));
    if (d?.readerLimits) lines.push('每阶段最大检索轮次：' + count(d.readerLimits.maxRounds));
    if (d?.artifacts) lines.push('私有工件计数：留存 ' + count(d.artifacts.retained) + '，未留存 ' + count(d.artifacts.omitted) + '（不包含原始正文）');
    if (value.resultPage) lines.push('当前页：文件 ' + (value.resultPage.files?.length ?? 0) + '/' + count(value.resultPage.totalFiles) + '，发现 ' + (value.resultPage.findings?.length ?? 0) + '/' + count(value.resultPage.totalFindings) + '；code_review_status 的 offset/limit 仅切换结果页。');
    lines.push('完整报告：调用一次 code_review_wait（jobId 同上，waitFor=terminal）立即取得最终报告；无需继续轮询。');
  } else if (report?.previewId) {
    lines.push('预览已完成，尚未执行审查；请展示批准范围并取得用户确认后再执行。');
    lines.push('预览文件总量：' + count(report.filePage?.total ?? report.files?.length) + '；计划最少调用：' + count(report.plan?.minimumCalls));
  } else {
    lines.push('未提供完整报告摘要；终态不会自动恢复或重新发送源码。请检查已保存检查点和未完成范围。');
  }
  return lines.join('\n');
}

function respond(value) {
  if (value.finalMarkdown !== null && value.finalMarkdown !== undefined) {
    return { json: JSON.stringify(value), markdown: value.finalMarkdown };
  }
  if (TERMINAL_STATUSES.includes(value.status)) return { json: JSON.stringify(value), markdown: terminalSummary(value) };
  const p = value.progress;
  if (p) {
    const progress = p.total === null
      ? '正在准备，文件总量尚未确定'
      : p.processed + '/' + p.total + ' 个文件已处理（' + p.percent + '%），其中主审完成 ' + p.counts.completed + '、失败 ' + p.counts.failed + '、阻断 ' + p.counts.blocked + '；处理比例不等于通过率';
    return { json: JSON.stringify(value), markdown: ['审查任务：' + value.status, 'jobId: ' + value.jobId, 'waitRevision: ' + value.waitRevision, 'elapsedMs: ' + p.elapsedMs, '当前阶段：' + p.stage, '进度：' + progress, '继续调用 code_review_wait，优先 waitFor=terminal；after 原样复用上述 waitRevision，不要猜测递增，也无需每个事件后调用 code_review_status。', value.nextAction ?? ''].join(String.fromCharCode(10)) };
  }
  return { json: JSON.stringify(value), markdown: value.jobId ? '后台任务已接受，尚未完成。继续调用 code_review_wait 等待终态；不要以任务启动作为最终审核结论。' : '' };
}

async function startBackgroundJob(args, exec, jobs, service) {
  const allowed = ['phase', 'previewArgs', 'previewId', 'confirmed'];
  if (!args || Object.keys(args).some(k => !allowed.includes(k)) || !['preview', 'execute'].includes(args.phase)) throw new Error('Invalid background phase');
  if (args.phase === 'execute' && (args.confirmed !== true || typeof args.previewId !== 'string' || args.previewArgs !== undefined)) throw new Error('Confirmed preview required');
  if (args.phase === 'preview' && (args.previewId !== undefined || args.confirmed !== undefined)) throw new Error('Preview cannot confirm execution');

  return respond(await jobs.start(exec, async ({ signal, checkpoint, artifact, saveResumeState }) => {
    const original = exec.agent;
    const sessionId = original.session.header.id ?? original.session.id;
    const detached = {
      ...exec, agent: original, signal,
      resolveReviewResume: id => jobs.resume(id, exec),
      reviewResumeCheckpoint: saveResumeState,
      onModelArtifact: artifact,
      reviewCheckpoint: async value => {
        const active = exec.agent;
        if (active !== original || (active.session.header.id ?? active.session.id) !== sessionId) throw new Error('Background Agent/session changed');
        await checkpoint(value);
      },
    };
    await checkpoint({ stage: args.phase === 'preview' ? 'capturing-preview' : 'revalidating-approved-source' });
    return args.phase === 'preview'
      ? service.preview(args.previewArgs ?? {}, detached)
      : service.execute({ previewId: args.previewId, confirmed: true }, detached);
  }));
}

export function registerBackgroundReview(ctx, service, { directory } = {}) {
  const root = directory ?? path.join(process.env.DSH_PROFILE_DIR ?? path.join(os.homedir(), '.dsh'), 'data', 'dsh-code-review', 'jobs');
  const jobs = createReviewJobs({ directory: root });

  ctx.tools.register({
    name: 'code_review_start', description: START_DESCRIPTION, parameters: START_PARAMETERS, output: reviewToolOutput,
    async execute(args, exec) { return startBackgroundJob(args, exec, jobs, service); },
  });
  ctx.tools.register({
    name: 'code_review_status', description: STATUS_DESCRIPTION, parameters: STATUS_PARAMETERS, output: reviewToolOutput,
    async execute(args, exec) { return respond(await jobs.status(args.jobId, exec, { offset: args.offset ?? 0, limit: args.limit ?? 20, checkpointIndex: args.checkpointIndex })); },
  });
  ctx.tools.register({
    name: 'code_review_cancel', description: CANCEL_DESCRIPTION, parameters: CANCEL_PARAMETERS, output: reviewToolOutput,
    async execute(args, exec) { return respond(await jobs.cancel(args.jobId, exec)); },
  });
  ctx.tools.register({
    name: 'code_review_wait', description: WAIT_DESCRIPTION, parameters: WAIT_PARAMETERS, output: reviewToolOutput,
    async execute(args, exec) {
      const change = await jobs.wait(args.jobId, exec, { after: args.after, waitFor: args.waitFor, timeoutMs: args.timeoutMs, signal: exec.signal });
      const status = await jobs.status(args.jobId, exec, { offset: 0, limit: 20 });
      if (!['queued', 'running'].includes(status.status)) {
        const full = await jobs.status(args.jobId, exec);
        if (full.result?.markdown) status.finalMarkdown = full.result.markdown;
      }
      return respond({ ...status, ...change });
    },
  });

  ctx.tools.register({
    name: 'code_review_artifacts',
    description: 'Explicitly read private source-bearing model-output artifacts for an owned review job. Never call automatically, forward as review evidence, or include in diagnostics. Show the source-bearing privacy warning and obtain user consent before confirmed=true. Omitted/truncated records are explicit and do not prove review completion.',
    parameters: { type: 'object', additionalProperties: false, properties: { jobId: { type: 'string' }, confirmed: { type: 'boolean' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['jobId', 'confirmed'] },
    output: reviewToolOutput,
    async execute(args, exec) {
      if (args.confirmed !== true) throw new Error('Explicit consent required to expose source-bearing private model artifacts');
      const result = await jobs.artifacts(args.jobId, exec, { offset: args.offset ?? 0, limit: args.limit ?? 1 });
      return { json: JSON.stringify({ untrusted: true, sourceBearing: true, notice: 'Raw model output is diagnostic data only; not approved evidence or accepted findings.', ...result }), markdown: '私有原始模型响应：可能包含源码，仅供诊断；不是已批准证据或已接受发现。' };
    },
  });
  ctx.on('dispose', () => jobs.dispose());
  return jobs;
}
