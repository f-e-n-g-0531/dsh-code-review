import { reportSummaryData, verificationPresentation, modelComparisonValidated, singlePassCompletionData } from './report-summary.mjs';

const rows = value => Array.isArray(value) ? value : [];
const count = n => Number.isSafeInteger(n) && n >= 0;
const safe = (value, limit = 160) => {
  const text = typeof value === 'string' ? Array.from(value).map(c => { const n = c.charCodeAt(0); return n < 32 || n >= 127 && n <= 159 || n >= 8234 && n <= 8238 || n >= 8294 && n <= 8297 ? ' ' : c; }).join('').trim() : '';
  return Array.from(text.length > limit ? text.slice(0, Math.ceil(limit / 2)) + '…（中段已省略，完整内容见技术报告）…' + text.slice(-Math.floor(limit / 2)) : text).map(c =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '*_[]#|!()'.includes(c) || c.charCodeAt(0) === 96 || c.charCodeAt(0) === 92 ? String.fromCharCode(92) + c : c).join('');
};
const labels = { 'single-model': '单模型候选（未独立复核）', introduced: '本次新增（复核支持）', current: '当前源码问题（复核支持）', preexisting: '原有问题（非本次新增）', uncertain: '尚不能确认', incomplete: '尚未完成复核', refuted: '复核已反驳' };
const levels = { critical: 0, high: 1, medium: 2, low: 3 };
const order = { 'single-model': 0, introduced: 0, current: 1, uncertain: 2, incomplete: 3, preexisting: 4, refuted: 5 };
const executionCauses = {
  SINGLE_PASS_INPUT_BUDGET: '完整单次材料超过输入字节限制',
  SINGLE_PASS_CONTEXT_LIMIT: '完整请求超过模型上下文窗口',
  SINGLE_PASS_OUTPUT_LIMIT: '模型输出达到上限，结果不完整',
  SINGLE_PASS_MODEL_JSON_INVALID: '模型响应不是完整有效的 JSON',
  SINGLE_PASS_PROTOCOL_FAILED: '单次审核响应未通过协议验收',
  SINGLE_PASS_MODEL_INCOMPLETE: '模型未正常结束，结果不完整',
  SINGLE_PASS_MODEL_CAPACITY_CHANGED: '模型容量或计数策略变化，须重新预览',
  SINGLE_PASS_CALL_LIMIT: '没有可用的单次模型调用额度',
  PROJECT_INPUT_BUDGET: '超过项目审核的输入预算',
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

/** Presentation only: full evidence and execution diagnostics stay in technical output. */
export function renderUserReport(report = {}, { maxFindings = 5 } = {}) {
  if (!Number.isSafeInteger(maxFindings) || maxFindings < 1 || maxFindings > 20) throw new TypeError('Invalid user report finding limit');
  const data = reportSummaryData(report), coverage = data.coverage;
  const completion = singlePassCompletionData(report);
  const output = ['## 1. 改动内容', ''];
  const files = rows(report.files);
  for (const file of files.slice(0, 20)) {
    const summary = safe(file?.changeSummary, 600);
    output.push('- ' + (safe(file?.path, 200) || '位置未记录') + '：' + (summary || (data.currentSourceOnly ? '检查当前源码，未记录改动说明。' : '未记录改动说明。')));
  }
  if (!files.length) output.push('未提供改动内容。');
  if (files.length > 20) output.push('- 另有 ' + (files.length - 20) + ' 个文件未展开。');
  if (!coverage.detailsComplete) output.push('- 文件明细未齐，以上仅为已加载内容。');
  output.push('', '## 2. 报告', '');
  const states = { cancelled: '审核已取消', failed: '审核失败', interrupted: '审核已中断' };
  if (data.outdated) output.push('报告已过期，仅对应原快照；请先对当前源码重新预览审核。');
  if (data.emptySelection) output.push('未选择审核条目。');
  else if (!data.complete) output.push((Object.hasOwn(states, data.status) ? states[data.status] : '审核尚未完成') + '，不能据此判断全部改动是否有问题。');
  else if (data.outdated) output.push(rows(report.findings).length ? '以下候选来自原快照，不能作为当前源码结论。' : '原快照未记录候选；这不是当前源码无问题的结论。');
  else if (!rows(report.findings).length) output.push('代码检查已完成，未发现明确问题。');
  else output.push('代码检查已完成，发现以下需要关注的问题。');
  const failures = executionFailures(report);
  for (const [code, total] of failures.slice(0, 3)) output.push('- ' + (coverage.detailsComplete ? '未完成原因' : '已加载明细中的原因') + '：' + executionCauses[code] + '，' + total + ' 项。');
  if (coverage.failed && !failures.length) output.push('- 部分文件检查失败，具体原因未记录。');
  if (data.unfinished.length) output.push('- 尚未查完：' + data.unfinished.slice(0, 5).map(item => safe(item.path, 100)).join('；') + (data.unfinished.length > 5 ? '；另 ' + (data.unfinished.length - 5) + ' 项未展开' : '') + '。');
  if (!coverage.detailsComplete || coverage.unaccounted) output.push('- 文件明细未齐或仍有状态未记账，不能判断全范围完成。');
  if (data.crossFile.pending) output.push(data.crossBatchUnassessed ? '- 部分批内跨文件关系尚未查完。' : '- 部分跨文件关系尚未查完。');
  if (data.crossBatchUnassessed) output.push('- 未核查跨批次关系；各批次的完成状态不代表已核查这些关系。');
  if (completion) {
    for (const [label, entries] of [['尚未核实', completion.gaps], ['需注意', completion.notes]]) {
      for (const item of entries.slice(0, 5)) output.push('- ' + label + '：' + safe(item.path, 160) + '：' + safe(item.text, 400));
      if (entries.length > 5) output.push('- 另 ' + (entries.length - 5) + ' 项' + label + '内容未展开，完整内容见技术报告。');
    }
  }
  const findings = rows(report.findings).map((finding, index) => ({ finding, index, state: verificationPresentation(finding, report) }));
  const rank = f => Object.hasOwn(levels, f?.severity) ? levels[f.severity] : 4;
  findings.sort((a, b) => order[a.state] - order[b.state] || rank(a.finding) - rank(b.finding) || a.index - b.index);
  for (const { finding: f, index, state } of findings.slice(0, maxFindings)) {
    output.push('', '### 候选 ' + (index + 1) + ' · ' + (modelComparisonValidated(f)?'模型跨文件比较支持（关系由模型判断，未证明因果）':labels[state]) + '：' + (safe(f?.title, 100) || '未提供标题'));
    if (state !== 'single-model') output.push('- 判断：' + (safe(f?.verification?.reason, 420) || (state === 'incomplete' ? '尚未完成核实。' : '未记录判断理由。')));
    output.push('- 位置：' + location(f, report));
    if (f?.trigger) output.push('- 触发条件（候选描述）：' + safe(f.trigger, 150));
    if (['introduced', 'current', 'preexisting'].includes(state)) {
      if (f?.impact) output.push('- 可能影响：' + safe(f.impact, 150));
      output.push('- 下一步：' + (safe(f?.suggestion, 150) || '结合触发条件核对修复必要性和回归测试。'));
    } else if (state === 'single-model') {
      if (f?.impact) output.push('- 可能影响（模型评估）：' + safe(f.impact, 150));
      output.push('- 最小建议（模型建议，非必改项）：' + (safe(f?.suggestion, 150) || '结合触发条件判断修复必要性。'));
    } else if (state === 'refuted') output.push('- 下一步：不按此候选直接安排修复；如有新证据再核对。');
    else output.push('- 下一步：补齐相关契约、调用路径和旧实现对照，再决定是否修复；原始假说与证据见技术报告。');
  }
  if (findings.length > maxFindings) output.push('', '另有 ' + (findings.length - maxFindings) + ' 项候选未在简报展开，见完整技术报告。');
  return output.join(String.fromCharCode(10));
}
