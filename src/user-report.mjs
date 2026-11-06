import { reportSummaryData, verificationPresentation, modelComparisonValidated } from './report-summary.mjs';

const rows = value => Array.isArray(value) ? value : [];
const count = n => Number.isSafeInteger(n) && n >= 0;
const safe = (value, limit = 160) => {
  const text = typeof value === 'string' ? Array.from(value).map(c => { const n = c.charCodeAt(0); return n < 32 || n >= 127 && n <= 159 || n >= 8234 && n <= 8238 || n >= 8294 && n <= 8297 ? ' ' : c; }).join('').trim() : '';
  return Array.from(text.length > limit ? text.slice(0, Math.ceil(limit / 2)) + '…（中段已省略，完整内容见技术报告）…' + text.slice(-Math.floor(limit / 2)) : text).map(c =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '*_[]#|!()'.includes(c) || c.charCodeAt(0) === 96 || c.charCodeAt(0) === 92 ? String.fromCharCode(92) + c : c).join('');
};
const labels = { introduced: '本次新增（复核支持）', current: '当前源码问题（复核支持）', preexisting: '原有问题（非本次新增）', uncertain: '尚不能确认', incomplete: '尚未完成复核', refuted: '复核已反驳' };
const levels = { critical: 0, high: 1, medium: 2, low: 3 };
const order = { introduced: 0, current: 1, uncertain: 2, incomplete: 3, preexisting: 4, refuted: 5 };
const executionCauses = {
  WHOLE_SCOPE_INPUT_BUDGET: '子会话输入超过批准容量',
  WHOLE_SCOPE_MODEL_CALL_LIMIT: '子会话达到模型调用次数限制',
  MODEL_CALL_LIMIT: '达到模型调用次数限制',
  PROJECT_MODEL_CALL_LIMIT: '达到项目共享模型调用次数限制',
  MODEL_TIMEOUT: '模型执行超时',
};
function executionFailures(report) {
  const groups = new Map();
  for (const file of rows(report.files)) {
    if (!file || file.status === 'completed' || file.status === 'excluded') continue;
    const code = file.failureCode ?? file.blockCode;
    if (typeof code === 'string' && Object.hasOwn(executionCauses, code)) groups.set(code, (groups.get(code) ?? 0) + 1);
  }
  return [...groups].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
function location(f, report) {
  const matches = rows(report.files).filter(file => file?.fileId === f?.fileId && (f?.batchSnapshotId === undefined || file.batchSnapshotId === f.batchSnapshotId));
  const path = safe(f?.path ?? (matches.length === 1 ? matches[0].path : '')) || '位置未记录', a = f?.anchor;
  return path + (a?.kind === 'line' && count(a.start) && a.start > 0 ? ' · ' + (a.side === 'old' ? '修改前' : a.side === 'new' ? '修改后' : '行') + ' ' + a.start + (count(a.end) && a.end > a.start ? '–' + a.end : '') : a?.kind === 'property' ? ' · 属性 ' + safe(a.name, 60) : '');
}

/** Presentation only: full evidence is unchanged, model prose never defines status. */
export function renderUserReport(report = {}, { maxFindings = 5 } = {}) {
  if (!Number.isSafeInteger(maxFindings) || maxFindings < 1 || maxFindings > 20) throw new TypeError('Invalid user report finding limit');
  const data = reportSummaryData(report), c = data.counts, coverage = data.coverage;
  const states = { cancelled: '审核已取消', failed: '审核失败', interrupted: '审核已中断' };
  const status = data.emptySelection ? '未选择审核条目' : data.complete ? '所选范围处理完成' : Object.hasOwn(states, data.status) ? states[data.status] : '审核尚未完成';
  const failures = executionFailures(report), executionBlocked = failures.length > 0 || coverage.failed > 0;
  const output = ['# 代码审核简报', '', '## 结论'];
  if (executionBlocked) {
    output.push('- 审核执行受阻，不能据此判断业务代码。主审失败 ' + coverage.failed + ' 项，待审 ' + coverage.pending + ' 项。');
    for (const [code, total] of failures.slice(0, 3)) output.push('- ' + (coverage.detailsComplete ? '已记录原因' : '已加载明细中的原因') + '：' + executionCauses[code] + '，' + total + ' 项（' + safe(code) + '）。');
    if (!coverage.detailsComplete) output.push('- 原因计数仅覆盖已加载 ' + coverage.loaded + '/' + coverage.total + ' 项；未加载条目的具体原因尚未核实。');
    else if (!failures.length) output.push('- 尚无可识别的执行原因代码，请查技术报告；不从模型描述推断原因。');
  }
  output.push('- ' + (data.currentSourceOnly ? '当前源码复核支持 ' + c.current + ' 项' : '本次新增复核支持 ' + c.introduced + ' 项') + '；原有问题 ' + c.preexisting + ' 项；尚不能确认 ' + data.verification.uncertain + ' 项；未完成复核 ' + data.verification.incomplete + ' 项。',
    '- ' + status + (data.outdated ? '；报告已过期，仅对应原快照' : '') + '。未发现获支持的问题也不等于审核通过。');
  const modelAssessed=rows(report.findings).filter(modelComparisonValidated);
  if(modelAssessed.length)output.push('- 另有模型跨文件比较支持 '+modelAssessed.length+' 项（关系由模型判断，未证明因果）；不计入上述严格新增支持统计。');
  if (c.refuted) output.push('- 另有 ' + c.refuted + ' 项候选已被复核反驳，不计为待修问题。');
  output.push('', '## 需要关注的内容');
  const findings = rows(report.findings).map((finding, index) => ({ finding, index, state: verificationPresentation(finding, report) }));
  const rank = f => Object.hasOwn(levels, f?.severity) ? levels[f.severity] : 4;
  findings.sort((a, b) => order[a.state] - order[b.state] || rank(a.finding) - rank(b.finding) || a.index - b.index);
  if (!findings.length) output.push('本轮未记录候选问题；仍需结合下方未完成范围判断。');
  for (const { finding: f, index, state } of findings.slice(0, maxFindings)) {
    output.push('', '### 候选 ' + (index + 1) + ' · ' + (modelComparisonValidated(f)?'模型跨文件比较支持（关系由模型判断，未证明因果）':labels[state]) + '：' + (safe(f?.title, 100) || '未提供标题'));
    output.push('- 复核判断：' + (safe(f?.verification?.reason, 420) || (state === 'incomplete' ? '尚无有效复核结论。' : '未记录判断理由；请查完整技术报告。')));
    output.push('- 位置：' + location(f, report));
    if (f?.trigger) output.push('- 触发条件（候选描述）：' + safe(f.trigger, 150));
    if (['introduced', 'current', 'preexisting'].includes(state)) {
      if (f?.impact) output.push('- 可能影响：' + safe(f.impact, 150));
      output.push('- 下一步：' + (safe(f?.suggestion, 150) || '结合触发条件核对修复必要性和回归测试。'));
    } else if (state === 'refuted') output.push('- 下一步：不按此候选直接安排修复；如有新证据再核对。');
    else output.push('- 下一步：补齐相关契约、调用路径和旧实现对照，再决定是否修复；原始假说与证据见技术报告。');
  }
  if (findings.length > maxFindings) output.push('', '另有 ' + (findings.length - maxFindings) + ' 项候选未在简报展开，见完整技术报告。');
  output.push('', '## 覆盖与后续', '- 主审完成 ' + coverage.completed + '/' + coverage.total + ' 个' + (coverage.unit === 'files' ? '文件' : '变更条目（含目录）') + '；待审 ' + coverage.pending + '；阻断 ' + coverage.blocked + '；失败 ' + coverage.failed + '；取消 ' + coverage.cancelled + '。');
  if (data.unfinished.length) output.push('- ' + (coverage.detailsComplete ? '未完成条目 ' : '已加载未完成条目 ') + data.unfinished.length + '：' + data.unfinished.slice(0, 5).map(item => safe(item.path, 100)).join('；') + (data.unfinished.length > 5 ? '；另 ' + (data.unfinished.length - 5) + ' 项未展开' : '') + '。');
  if (!coverage.detailsComplete || coverage.unaccounted) output.push('- 文件明细未齐或仍有状态未记账，不能据已加载条目判断全范围完成。');
  if (data.crossFile.total) output.push('- 跨文件综合完成 ' + data.crossFile.completed + '/' + data.crossFile.total + ' 项' + (data.crossFile.pending ? '；其余关系尚未核查。' : '。'));
  if (Object.values(data.stages).some(Boolean)) output.push('- 后续阶段：待执行 ' + data.stages.pending + '，执行中 ' + data.stages.running + '，已停止 ' + data.stages.stopped + '。');
  if (data.limitations) output.push('- 已记录 ' + data.limitations + ' 条限制；完整原因与对应范围见技术报告。');
  output.push('- 建议顺序：' + (data.outdated ? '先对当前源码重新预览审核。' : executionBlocked ? '先排查审核执行容量或调用限制，再重新预览补审；不要按空发现放行业务代码。' : !data.complete ? '先补齐未审范围和未完成阶段，再处理缺少证据的候选。' : '结合上述复核判断决定修复与测试；处理完成不是放行批准。'));
  const metrics = [], calls = report.modelCalls ?? report.diagnostics?.modelCalls, wall = report.diagnostics?.executionWallMs;
  if (count(calls)) metrics.push('模型调用 ' + calls + ' 次');
  if (typeof wall === 'number' && Number.isFinite(wall) && wall >= 0) metrics.push('执行耗时 ' + (wall / 1000).toFixed(1) + ' 秒');
  if (metrics.length) output.push('- ' + metrics.join('；') + '。');
  const o = report.orchestration;
  const childId = value => typeof value === 'string' && value ? value : typeof value?.childId === 'string' && value.childId ? value.childId : null;
  const started = Array.isArray(o?.childrenStarted) ? [...new Set(o.childrenStarted.map(childId).filter(Boolean))] : null;
  const childBatches = rows(o?.batches).filter(b => b?.execution === 'host-subagent' && childId(b));
  const returned = [...new Set(childBatches.map(childId))];
  const completed = [...new Set(childBatches.filter(b => b.status === 'completed').map(childId))];
  const planned = count(report.dispatch?.plannedChildCount) ? report.dispatch.plannedChildCount : null;
  if (started !== null || returned.length || o?.batchExecution === 'host-subagents') {
    output.push('- 宿主子会话：计划 ' + (planned ?? '未记录') + '，已启动 ' + (started === null ? '未记录' : started.length) + '，已完成批次 ' + completed.length + '；已记录返回身份 ' + returned.length + '。');
    const identities = started ?? returned;
    if (identities.length) output.push('- 子会话身份（最多列三项）：' + identities.slice(0, 3).map(id => safe(id, 70)).join('、') + '。');
  }
  else if (o?.batchExecution === 'direct') output.push('- 实际执行：主会话直接调用模型，未记录宿主子会话执行。');
  else if (o?.strategy === 'staged' || report.execution?.executionStrategy === 'staged' || report.dispatch?.effectiveStrategy === 'staged') {
    const reasons = { 'explicit-staged': '明确选择分阶段策略', 'complete-files-exceed-capacity': '部分完整文件超过单次输入容量，改用分阶段审查', 'project-requires-staged': '项目审核使用分阶段策略', 'resume-requires-staged': '恢复审查使用分阶段策略', 'multiple-rounds-require-staged': '多轮审查使用分阶段策略' };
    const reason = Object.hasOwn(reasons, report.dispatch?.reason) ? reasons[report.dispatch.reason] : '分阶段策略';
    output.push('- 实际执行：' + reason + '；该策略未使用宿主子会话。');
  }
  output.push('', '完整候选、原始证据、逐项覆盖和执行诊断保留在显式 technical 技术报告中；本简报未展开这些记录。');
  return output.join(String.fromCharCode(10));
}
