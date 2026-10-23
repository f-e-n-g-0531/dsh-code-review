import { REVIEW_RUNTIME } from './runtime-identity.mjs';
const PHASES = ['business-grouping', 'risk-planning', 'primary', 'group-primary', 'file-interaction', 'window-synthesis', 'verification'];
const PURPOSES = ['primary-initial', 'retrieval-followup', 'budget-finalization', 'json-correction', 'business-grouping', 'risk-planning', 'group-primary', 'window-synthesis', 'file-interaction', 'verification'];
const READER_FIELDS = ['calls', 'outputBytes', 'maxCalls', 'maxOutputBytes', 'remainingCalls', 'remainingOutputBytes', 'maxResultBytes'];
const JSON_ISSUES = ['property-name', 'colon', 'separator', 'invalid-escape', 'control-character', 'unterminated-string', 'unexpected-end', 'trailing-content', 'syntax'];
const CORRECTION_CODES = ['MODEL_INVALID_JSON', 'MODEL_INVALID_REVIEW_RESPONSE', 'MODEL_INVALID_FINDING_IDENTITY', 'MODEL_INVALID_FINDING_SEVERITY', 'MODEL_MISSING_FINDING_FIELD', 'MODEL_INVALID_ANCHOR', 'MODEL_ANCHOR_MISMATCH', 'RETRIEVAL_PROTOCOL_ERROR'];
const LIMIT_CODES = ['READER_CALL_BUDGET_EXCEEDED', 'READER_OUTPUT_BUDGET_EXCEEDED', 'RETRIEVAL_ROUND_BUDGET_EXCEEDED'];
const RECOVERY_KINDS = ['native-tool', 'text-compatible', 'trailing-prose'];
const FALLBACK_REASONS = ['mode-notauto', 'smallchange', 'disabled', 'project', 'laterround', 'multi-batch', 'incomplete-edit-scope', 'input-budget'];
const number = n => Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
// Source-free counters only; call walls overlap and include lifecycle observation.
export function reviewDiagnostics(report, { reviewWallMs = null, executionWallMs = null } = {}) {
  // Shared orchestration is one aggregator, not copied into each file's work.
  const sources = [...(report.files ?? []), ...(report.orchestration ? [report.orchestration] : [])];
  const phases = [];
  for (const phase of PHASES) {
    const rows = sources.map(f => f.modelMetrics?.[phase]).filter(Boolean);
    if (!rows.length) continue;
    const sum = field => rows.every(r => number(r[field]) !== null) ? number(rows.reduce((n, r) => n + r[field], 0)) : null;
    phases.push({ phase, calls: sum('calls'), observedCallWallSumMs: sum('durationMs'), inputBytes: sum('inputBytes'), totalOutputBytes: sum('totalOutputBytes') });
  }
  const plans = (report.files ?? []).flatMap(f => f.riskPlans ?? []);
  const observedModelCalls = phases.length && phases.every(p => p.calls !== null) ? phases.reduce((n, p) => n + p.calls, 0) : null;
  const modelCallPurposes = PURPOSES.flatMap(purpose => {
    const values = sources.map(f => f.modelCallPurposes?.[purpose]).filter(value => value !== undefined);
    if (!values.length) return [];
    return [{ purpose, calls: values.every(value => number(value) !== null) ? number(values.reduce((sum, value) => sum + value, 0)) : null }];
  });
  const readerBudget = Object.fromEntries(READER_FIELDS.map(field => [field, number(report.readerBudget?.[field])]));
  const correctionCounts = new Map();
  for (const event of sources.flatMap(f => f.modelCorrections ?? [])) {
    if (!['explicit-json-correction', 'retrieval-protocol-correction', 'review-format-correction'].includes(event?.action) || !CORRECTION_CODES.includes(event.code)) continue;
    const jsonIssue = JSON_ISSUES.includes(event.jsonIssue) ? event.jsonIssue : null;
    const key = JSON.stringify([event.code, jsonIssue]);
    correctionCounts.set(key, (correctionCounts.get(key) ?? 0) + 1);
  }
  const correctionReasons = [...correctionCounts].map(([key, calls]) => { const [code, jsonIssue] = JSON.parse(key); return { code, jsonIssue, calls }; }).sort((a, b) => a.code.localeCompare(b.code) || String(a.jsonIssue).localeCompare(String(b.jsonIssue)));
  const limits = sources.flatMap(f => f.retrievalLimits ?? []);
  const readerLimitReasons = LIMIT_CODES.flatMap(code => { const calls = limits.filter(row => row?.code === code).length; return calls ? [{ code, calls }] : []; });
  const readerLimits = { maxRounds: number(report.readerLimits?.maxRounds ?? report.maxRetrievalRounds) };
  const riskPlanningFallbackReasons = FALLBACK_REASONS.flatMap(reason => { const calls = (report.files ?? []).filter(f => f.riskPlanningFallbackReason === reason).length; return calls ? [{ reason, calls }] : []; });
  const recoveryEvents = sources.flatMap(source => source.modelRecoveries ?? []);
  const transportRecoveries = RECOVERY_KINDS.flatMap(kind => { const calls = recoveryEvents.filter(event => event?.action === 'json-transport-recovery' && event.kind === kind).length; return calls ? [{ kind, calls }] : []; });
  const resume = { reusedFiles: number(report.resume?.reusedFiles) };
  const artifactRecords = Array.isArray(report.artifacts) ? report.artifacts : null;
  const artifacts = { retained: artifactRecords ? artifactRecords.filter(record => record?.omitted === false && record.recorded === true).length : null, omitted: artifactRecords ? artifactRecords.filter(record => record?.omitted === true).length : null };
  return { schemaVersion: 2, resume, artifacts, transportRecoveries, pluginVersion: REVIEW_RUNTIME.version, reviewWallMs: number(reviewWallMs), executionWallMs: number(executionWallMs),
    modelCalls: number(report.modelCalls), observedModelCalls, phases, modelCallPurposes, readerBudget, correctionReasons, readerLimitReasons, readerLimits, riskPlanningFallbackReasons,
    planning: { completed: plans.filter(p => p.status === 'completed' && p.method !== 'inline').length, inline: plans.filter(p => p.method === 'inline' && p.status === 'completed').length, inlineAbsent: plans.filter(p => p.method === 'inline' && p.status === 'absent').length, inlineInvalid: plans.filter(p => p.method === 'inline' && p.status === 'invalid').length, fallback: plans.filter(p => p.status === 'fallback').length, skipped: plans.filter(p => p.status === 'skipped').length },
    callPurposeNotice: 'primary-initial is the first call of a retrieval-enabled stage, not only primary review; phase identifies the stage. Correction reason counts include actual correction invocation records only, not both failures and completion notices.',
    timingNotice: 'Observed call wall sums overlap under concurrency and include lifecycle observation; not pure provider latency. Missing values are unavailable, not zero.' };
}
export function diagnosticsMarkdown(d) {
  if (!d) return [];
  const ms = value => number(value) === null ? '不可用' : (value / 1000).toFixed(1) + ' 秒';
  const output = ['', '## 执行诊断', '- 插件版本：' + d.pluginVersion + '；审查阶段墙钟：' + ms(d.reviewWallMs) + '；已计调用：' + (d.modelCalls ?? '不可用')];
  if (d.phases?.length) {
    output.push('', '| 阶段 | 观测调用数 | 累计调用墙钟 |', '|---|---:|---:|');
    for (const p of d.phases) output.push('| ' + p.phase + ' | ' + (p.calls ?? '不可用') + ' | ' + ms(p.observedCallWallSumMs) + ' |');
    output.push('', '累计调用墙钟可能并发重叠，且包含生命周期观察／初始检查点等待，不是纯提供方耗时，也不能从总耗时中相减当作本地开销。');
  } else output.push('- 逐阶段模型观测不可用（未产生或旧报告未记录），不按零耗时解释。');
  if (d.modelCallPurposes?.length) {
    const labels = { 'primary-initial': '阶段初始', 'retrieval-followup': '检索后续', 'budget-finalization': '预算受限最终答复', 'json-correction': 'JSON纠正', 'business-grouping': '业务分组', 'risk-planning': '风险计划', 'group-primary': '分组主审', 'window-synthesis': '窗口综合', 'file-interaction': '跨文件综合', verification: '复核' };
    output.push('- 调用目的：' + d.modelCallPurposes.filter(row => PURPOSES.includes(row.purpose)).map(row => labels[row.purpose] + ' ' + (number(row.calls) ?? '不可用')).join('；') + '。');
  }
  if (d.readerBudget && READER_FIELDS.some(field => number(d.readerBudget[field]) !== null)) {
    const n = field => number(d.readerBudget[field]) ?? '不可用';
    output.push('- 共享读取预算：调用 ' + n('calls') + '/' + n('maxCalls') + '，序列化输出字节 ' + n('outputBytes') + '/' + n('maxOutputBytes') + '；剩余调用 ' + n('remainingCalls') + '，剩余输出字节 ' + n('remainingOutputBytes') + '。');
  }
  if (d.correctionReasons?.length) output.push('- 纠正原因（仅实际纠正调用，不重复计失败／完成通知）：' + d.correctionReasons.filter(r => CORRECTION_CODES.includes(r.code)).map(r => r.code + (JSON_ISSUES.includes(r.jsonIssue) ? '/' + r.jsonIssue : '') + ' ' + (number(r.calls) ?? '不可用')).join('；') + '。');
  if (d.readerLimitReasons?.length) output.push('- 读取限制原因：' + d.readerLimitReasons.filter(r => LIMIT_CODES.includes(r.code)).map(r => r.code + ' ' + (number(r.calls) ?? '不可用')).join('；') + '。');
  if (number(d.readerLimits?.maxRounds) !== null) output.push('- 每阶段最大检索轮次：' + number(d.readerLimits.maxRounds) + '；调用数／输出字节耗尽与轮次耗尽分别记录，不能混同。');
  if (d.riskPlanningFallbackReasons?.length) output.push('- 风险策略回退原因：' + d.riskPlanningFallbackReasons.filter(r => FALLBACK_REASONS.includes(r.reason)).map(r => r.reason + ' ' + (number(r.calls) ?? '不可用')).join('；') + '。');
  if (d.transportRecoveries?.length) output.push('- 本地结果传输：' + d.transportRecoveries.filter(row => RECOVERY_KINDS.includes(row.kind)).map(row => row.kind + ' ' + (number(row.calls) ?? '不可用')).join('；') + '；仅计成功解析的传输事件，不表示额外模型调用或缺陷确认。');
  if (number(d.resume?.reusedFiles) !== null) output.push('- 续审复用已完成文件：' + number(d.resume.reusedFiles) + '；复用成果不计为本次模型调用或新读取证据。');
  if (number(d.artifacts?.retained) !== null || number(d.artifacts?.omitted) !== null) output.push('- 私有模型工件：已留存 ' + (number(d.artifacts.retained) ?? '不可用') + '，未留存 ' + (number(d.artifacts.omitted) ?? '不可用') + '；诊断仅含计数，不包含正文或访问标识。');
  output.push('- primary-initial 表示启用检索的某阶段初始调用，不仅是主审；具体阶段以阶段统计为准。');
  output.push('- 风险计划：完成 ' + d.planning.completed + '，回退 ' + d.planning.fallback + '，跳过 ' + d.planning.skipped + '；合并主审问题 ' + (d.planning.inline ?? 0) + '，缺失 ' + (d.planning.inlineAbsent ?? 0) + '，无效 ' + (d.planning.inlineInvalid ?? 0) + '（非独立规划）。');
  return output;
}
