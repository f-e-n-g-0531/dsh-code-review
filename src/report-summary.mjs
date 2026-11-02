const FILE_STATES = ['completed', 'excluded', 'blocked', 'failed', 'cancelled', 'pending'];
const STATUS_LABELS = { completed: '已完成', partial: '部分完成', failed: '执行失败', cancelled: '已取消', interrupted: '已中断', pending: '待执行', running: '执行中' };
const safe = value => Array.from(String(value ?? '').slice(0, 240)).map(c => {
  if (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) return ' ';
  if (c === '&') return '&amp;';
  if (c === '<') return '&lt;';
  if (c === '>') return '&gt;';
  if ('*_[]#|!()\\'.includes(c) || c.charCodeAt(0) === 96) return '\\' + c;
  return c;
}).join('');
const rows = value => Array.isArray(value) ? value : [];
const validCount = n => Number.isSafeInteger(n) && n >= 0;
const supported = finding => finding?.verification?.status === 'completed' && finding.verification.verdict === 'supported' && rows(finding.verification.evidence).length > 0 && finding.verification.evidence.every(ref => ref?.status === 'references-validated');

// Presentation consumes host-validated results; it neither re-reads sources nor
// upgrades model verdicts, reference validation, or reuse into causal proof.
function comparisonValidated(finding) {
  const { evidence, regression } = finding.verification ?? {};
  if (regression?.status !== 'comparison-references-validated' || !Array.isArray(evidence)) return false;
  const old = regression.oldEvidence, fresh = regression.newEvidence;
  if (![old, fresh].every(indices => Array.isArray(indices) && indices.length > 0 && indices.length <= 8 && new Set(indices).size === indices.length && indices.every(i => Number.isSafeInteger(i) && i >= 0 && i < evidence.length && evidence[i]?.status === 'references-validated'))) return false;
  if (old.some(index => fresh.includes(index))) return false;
  // The comparison validator already checks primary-file identity and sides.
  // Reject inconsistent copied summaries without guessing sides from source IDs.
  return old.every(i => typeof evidence[i].sourceId === 'string' && evidence[i].sourceId) && fresh.every(i => typeof evidence[i].sourceId === 'string' && evidence[i].sourceId && old.every(j => evidence[j].sourceId !== evidence[i].sourceId));
}

export function reportSummaryMarkdown(report = {}) {
  const findings = rows(report.findings), files = rows(report.files);
  const counts = { introduced: 0, unresolved: 0, refuted: 0, preexisting: 0, current: 0 };
  for (const finding of findings) {
    const verification = finding?.verification;
    if (verification?.status === 'completed' && verification.verdict === 'refuted' && rows(verification.evidence).length && verification.evidence.every(ref => ref?.status === 'references-validated')) counts.refuted++;
    else if (!supported(finding)) counts.unresolved++;
    else if (report.reviewMode === 'project' || report.projectScope || finding.attribution?.causality === 'current-source-only') counts.current++;
    else if (comparisonValidated(finding) && verification.regression.classification === 'introduced') counts.introduced++;
    else if (comparisonValidated(finding) && verification.regression.classification === 'preexisting') counts.preexisting++;
    else counts.unresolved++;
  }
  const coverage = Object.fromEntries(FILE_STATES.map(status => [status, validCount(report.coverage?.[status]) ? report.coverage[status] : files.filter(f => f?.status === status).length]));
  const total = validCount(report.coverage?.total) ? report.coverage.total : files.length;
  const unfinished = files.filter(file => !['completed', 'excluded'].includes(file?.status) || rows(file.stageFailures).length || file.retrievalLimited || rows(file.windowCoverage?.pending).length || file.synthesisStatus && file.synthesisStatus !== 'completed' || file.verificationStatus && file.verificationStatus !== 'completed' || rows(file.reviewPasses).some(pass => pass?.status !== 'completed') || findings.some(finding => finding?.fileId === file.fileId && finding?.verification?.status !== 'completed'));
  const incompleteInteractions = rows(report.interactions).filter(item => item?.status !== 'completed');
  const output = ['', '## 结论摘要', '- 整体状态：' + (STATUS_LABELS[report.status] ?? '未知') + '；完成状态只表示处理进度，不表示代码正确。',
    '- 已确认新增（独立复核支持、旧新对照引用已校验）：' + counts.introduced + '；未决／证据不足：' + counts.unresolved + '；已反驳候选：' + counts.refuted + '；既有问题（复核支持且旧新对照已校验）：' + counts.preexisting + '。'];
  if (counts.current) output.push('- 当前源码复核支持：' + counts.current + '；当前源码模式不评估历史新增归因，不计为已确认新增。');
  output.push('- 以上按候选记录计数，不是去重根因数；“已确认新增”仅指模型复核支持及引用校验成立，因果解释仍未经验证，不是事实或因果证明。');
  if (findings.some(finding => finding?.reused || finding?.priorRun)) output.push('- 含既往轮次复用发现；保留原复核来源，不表示本轮重新取证。');
  if (report.outdated) output.push('- 注意：来源已变化或无法复核；这些结论仅对应原批准快照，不能当作当前源码结论。');
  output.push('- 范围：' + total + ' 个文件；完成 ' + coverage.completed + '，排除 ' + coverage.excluded + '，阻断 ' + coverage.blocked + '，失败 ' + coverage.failed + '，取消 ' + coverage.cancelled + '，待审 ' + coverage.pending + '。排除／阻断不是通过。');
  if (unfinished.length) {
    output.push('- 关键未完成范围：' + unfinished.slice(0, 5).map(file => safe(file.path ?? '未命名文件')).join('、') + (unfinished.length > 5 ? '；另有 ' + (unfinished.length - 5) + ' 个文件，见覆盖明细。' : '；阶段和限制见覆盖明细。'));
  }
  if (incompleteInteractions.length) output.push('- 跨文件综合未完成：' + incompleteInteractions.length + ' 项；主文件完成不能替代交互覆盖。');
  if (rows(report.limitations).length) output.push('- 已记录限制：' + report.limitations.length + ' 项；完整内容保留在限制明细，不能据空发现判定通过。');
  if (total === 0) output.push('- 未选择文件，没有执行代码审核；不能解释为零缺陷结论。');
  if (!findings.length) output.push(total > 0 && coverage.completed > 0 && report.status === 'completed' && !unfinished.length && !incompleteInteractions.length && !rows(report.limitations).length && !report.outdated ? '- 已审范围内没有候选问题记录；不证明不存在缺陷。' : '- 当前没有候选问题记录；执行状态、未完成范围或限制不支持“审核通过”。');
  return output;
}
