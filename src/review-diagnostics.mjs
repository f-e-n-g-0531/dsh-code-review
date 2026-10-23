import { REVIEW_RUNTIME } from './runtime-identity.mjs';
const PHASES = ['business-grouping', 'risk-planning', 'primary', 'file-interaction', 'window-synthesis', 'verification'];
const number = n => Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
// Source-free counters only; call walls overlap and include lifecycle observation.
export function reviewDiagnostics(report, { reviewWallMs = null, executionWallMs = null } = {}) {
  const phases = [];
  for (const phase of PHASES) {
    const rows = (report.files ?? []).map(f => f.modelMetrics?.[phase]).filter(Boolean);
    if (!rows.length) continue;
    const sum = field => rows.every(r => number(r[field]) !== null) ? number(rows.reduce((n, r) => n + r[field], 0)) : null;
    phases.push({ phase, calls: sum('calls'), observedCallWallSumMs: sum('durationMs'), inputBytes: sum('inputBytes'), totalOutputBytes: sum('totalOutputBytes') });
  }
  const plans = (report.files ?? []).flatMap(f => f.riskPlans ?? []);
  const observedModelCalls = phases.length && phases.every(p => p.calls !== null) ? phases.reduce((n, p) => n + p.calls, 0) : null;
  return { schemaVersion: 1, pluginVersion: REVIEW_RUNTIME.version, reviewWallMs: number(reviewWallMs), executionWallMs: number(executionWallMs),
    modelCalls: number(report.modelCalls), observedModelCalls, phases,
    planning: { completed: plans.filter(p => p.status === 'completed').length, fallback: plans.filter(p => p.status === 'fallback').length, skipped: plans.filter(p => p.status === 'skipped').length },
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
  output.push('- 风险计划：完成 ' + d.planning.completed + '，回退 ' + d.planning.fallback + '，跳过 ' + d.planning.skipped + '。');
  return output;
}
