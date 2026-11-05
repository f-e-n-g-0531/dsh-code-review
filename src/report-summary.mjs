const FILE_STATES = ['completed', 'excluded', 'blocked', 'failed', 'cancelled', 'pending', 'running', 'interrupted'];
const STATUS_LABELS = { completed: '已完成', partial: '部分完成', failed: '执行失败', cancelled: '已取消', interrupted: '已中断', pending: '待执行', running: '执行中' };
const rows = value => Array.isArray(value) ? value : [];
const validCount = n => Number.isSafeInteger(n) && n >= 0;
const supported = finding => finding?.verification?.status === 'completed' && finding.verification.verdict === 'supported' && rows(finding.verification.evidence).length > 0 && finding.verification.evidence.every(ref => ref?.status === 'references-validated');

// Presentation consumes host-validated results; it neither re-reads sources nor
// upgrades model verdicts, reference validation, or reuse into causal proof.
export function comparisonValidated(finding) {
  const { evidence, regression } = finding.verification ?? {};
  if (regression?.status !== 'comparison-references-validated' || !Array.isArray(evidence)) return false;
  const old = regression.oldEvidence, fresh = regression.newEvidence;
  if (![old, fresh].every(indices => Array.isArray(indices) && indices.length > 0 && indices.length <= 8 && new Set(indices).size === indices.length && indices.every(i => Number.isSafeInteger(i) && i >= 0 && i < evidence.length && evidence[i]?.status === 'references-validated'))) return false;
  if (old.some(index => fresh.includes(index))) return false;
  // The comparison validator already checks primary-file identity and sides.
  // Reject inconsistent copied summaries without guessing sides from source IDs.
  return old.every(i => typeof evidence[i].sourceId === 'string' && evidence[i].sourceId) && fresh.every(i => typeof evidence[i].sourceId === 'string' && evidence[i].sourceId && old.every(j => evidence[j].sourceId !== evidence[i].sourceId));
}

// Rendering-only states. A completed uncertain verdict may legitimately have no
// evidence (the verifier contract allows this); it is not an unfinished run.
export function verificationPresentation(finding, report = {}) {
  const v = finding?.verification;
  if (v?.status !== 'completed' || !['supported', 'uncertain', 'refuted'].includes(v.verdict)) return 'incomplete';
  const evidenceValid = rows(v.evidence).length > 0 && v.evidence.every(ref => ref?.status === 'references-validated');
  if (v.verdict === 'refuted' && evidenceValid) return 'refuted';
  if (v.verdict !== 'supported' || !evidenceValid) return 'uncertain';
  if (report.mode === 'project' || report.reviewMode === 'project' || report.projectScope || finding.attribution?.causality === 'current-source-only') return 'current';
  if (comparisonValidated(finding) && ['introduced', 'preexisting'].includes(v.regression.classification)) return v.regression.classification;
  return 'uncertain';
}

// Candidate numbers refer to the unchanged original finding/appendix order.
// Only evidence-qualified support is prioritized; severity never promotes a hypothesis.
export function supportedFindingPriorities(report = {}) {
  const severity = { critical: 0, high: 1, medium: 2, low: 3 };
  const category = { introduced: 0, current: 1, preexisting: 2 };
  return rows(report.findings).flatMap((finding, index) => {
    const state = verificationPresentation(finding, report);
    if (!Object.hasOwn(category, state)) return [];
    const level = Object.hasOwn(severity, finding.severity) ? finding.severity : 'unknown';
    return [{ candidate: index + 1, state, severity: level }];
  }).sort((a, b) => category[a.state] - category[b.state] ||
    (severity[a.severity] ?? 4) - (severity[b.severity] ?? 4) || a.candidate - b.candidate);
}

/**
 * Pure presentation data for Markdown/Lead renderers. Counts are candidate records,
 * not proven defects. coverage counts main-review entries (directories included in
 * change mode); unfinished preserves every loaded entry with incomplete stages, while
 * crossFile is separate. complete means processing finished, never release approval.
 * Returned objects/arrays are newly allocated and contain no raw model/source text.
 */
export function reportSummaryData(report = {}) {
  const findings = rows(report.findings), files = rows(report.files);
  const project = report.mode === 'project' || report.reviewMode === 'project' || Boolean(report.projectScope);
  const counts = { introduced: 0, unresolved: 0, refuted: 0, preexisting: 0, current: 0 };
  for (const finding of findings) {
    const verification = finding?.verification;
    if (verification?.status === 'completed' && verification.verdict === 'refuted' && rows(verification.evidence).length && verification.evidence.every(ref => ref?.status === 'references-validated')) counts.refuted++;
    else if (!supported(finding)) counts.unresolved++;
    else if (project || finding.attribution?.causality === 'current-source-only') counts.current++;
    else if (comparisonValidated(finding) && verification.regression.classification === 'introduced') counts.introduced++;
    else if (comparisonValidated(finding) && verification.regression.classification === 'preexisting') counts.preexisting++;
    else counts.unresolved++;
  }
  const coverage = Object.fromEntries(FILE_STATES.map(status => [status, validCount(report.coverage?.[status]) ? report.coverage[status] : files.filter(f => f?.status === status).length]));
  const accounted = FILE_STATES.reduce((sum, status) => sum + coverage[status], 0);
  const total = validCount(report.coverage?.total) ? report.coverage.total :
    validCount(report.totalFiles) ? report.totalFiles : Math.max(files.length, accounted);
  const detailsComplete = files.length >= total;
  const unfinished = files.flatMap(file => {
    if (file?.status === 'excluded') return [];
    const reasons = [];
    if (file?.status !== 'completed') reasons.push(STATUS_LABELS[file?.status] ?? '主审未完成');
    if (rows(file?.stageFailures).length) reasons.push('阶段失败');
    if (file?.retrievalLimited) reasons.push('取证受限');
    if (file?.continuationPending) reasons.push('后续阶段待执行');
    if (rows(file?.windowCoverage?.pending).length) reasons.push('窗口待审 ' + file.windowCoverage.pending.length);
    if (file?.synthesisStatus && file.synthesisStatus !== 'completed') reasons.push('综合未完成');
    if (file?.verificationStatus && file.verificationStatus !== 'completed' || findings.some(finding => file?.fileId != null && finding?.fileId === file.fileId && finding?.verification?.status !== 'completed')) reasons.push('复核未完成');
    if (rows(file?.reviewPasses).some(pass => pass?.status !== 'completed')) reasons.push('审查轮次未完成');
    return reasons.length ? [{ path: String(file?.path ?? '未命名条目'), reasons }] : [];
  });
  const interactions = rows(report.interactions);
  const crossFile = { total: interactions.length, completed: interactions.filter(item => item?.status === 'completed').length, pending: interactions.filter(item => item?.status !== 'completed').length };
  const stages = Object.fromEntries(['pending', 'running', 'stopped'].map(status => [status, validCount(report.stageContinuation?.[status]) ? report.stageContinuation[status] : 0]));
  const unverifiedCandidates = findings.filter(finding => finding?.verification?.status !== 'completed').length;
  coverage.unaccounted = Math.max(0, total - accounted);
  const complete = report.status === 'completed' && detailsComplete && total > 0 && coverage.completed > 0 &&
    !unfinished.length && !crossFile.pending && !Object.values(stages).some(Boolean) && !unverifiedCandidates && !coverage.unaccounted &&
    !FILE_STATES.some(status => !['completed', 'excluded'].includes(status) && coverage[status] > 0);
  return {
    status: typeof report.status === 'string' ? report.status : 'unknown',
    complete, outdated: Boolean(report.outdated), emptySelection: total === 0,
    counts: { total: findings.length, ...counts },
    coverage: { total, loaded: files.length, detailsComplete, unit: project ? 'files' : 'change-entries', ...coverage },
    unfinished, crossFile, stages, unverifiedCandidates,
    verification: {
      supported: counts.introduced + counts.preexisting + counts.current,
      uncertain: findings.filter(finding => verificationPresentation(finding, report) === 'uncertain').length,
      incomplete: findings.filter(finding => verificationPresentation(finding, report) === 'incomplete').length,
    },
    priorities: supportedFindingPriorities(report),
    limitations: rows(report.limitations).length,
    scopeNotices: rows(report.scopeNotices).length,
    reused: findings.some(finding => finding?.reused || finding?.priorRun),
    currentSourceOnly: Boolean(project || findings.some(finding => finding?.attribution?.causality === 'current-source-only')),
  };
}

export function reportSummaryMarkdown(report = {}) {
  const data = reportSummaryData(report), { counts, coverage } = data;
  const state = data.emptySelection ? '未选择条目，没有执行代码审核（' + (STATUS_LABELS[data.status] ?? '状态未知') + '）' :
    data.complete ? '所选范围已查完' : '尚未查完（' + (STATUS_LABELS[data.status] ?? '状态未知') + '）';
  const firstCounts = counts.total ? [
    counts.introduced ? '复核支持本次新增 ' + counts.introduced : '',
    counts.current ? '当前源码复核支持 ' + counts.current : '',
    counts.preexisting ? '复核支持原有 ' + counts.preexisting : '',
    !data.verification.supported ? '尚无复核支持的问题' : '',
  ].filter(Boolean).join('；') + '；' : '';
  const headline = firstCounts + state + (data.outdated ? '；报告已过期' : '') + '；' +
    (counts.total ? '记录 ' + counts.total + ' 个候选问题' : '未记录候选问题') + '；不得据此放行。';
  const output = ['', '## 结论摘要', '- ' + headline];
  if (counts.total || !data.complete || data.outdated) {
    output.push('- 下一步：' + (data.outdated ? '先基于当前批准快照重新审核；' : '') +
      (data.verification.supported ? '按下列候选编号核对触发条件与修复必要性；' : '无复核支持的问题不等于审核通过；') +
      '已复核不确定 ' + data.verification.uncertain + '、复核未完成 ' + data.verification.incomplete +
      '，先核实而非直接修复；已加载未完成条目 ' + data.unfinished.length +
      (coverage.detailsComplete ? '' : '，明细尚未加载齐') +
      (data.complete ? '；处理已结束，不代表所有疑点已排除。' : '；须补齐未完成范围和阶段，不能视为无问题。'));
  }
  if (data.priorities.length) {
    const labels = { introduced: '本次新增', current: '当前源码', preexisting: '原有' };
    const levels = { critical: '严重', high: '高', medium: '中', low: '低', unknown: '未分级' };
    output.push('- 优先核对（仅复核支持，类别内按严重程度）：' + data.priorities.slice(0, 5)
      .map(item => '候选 ' + item.candidate + '（' + labels[item.state] + '／' + levels[item.severity] + '）').join('；') +
      (data.priorities.length > 5 ? '；其余 ' + (data.priorities.length - 5) + ' 项见审查发现与技术附录' : '') + '。');
  }
  if (counts.total) {
    const labels = { introduced: '复核支持本次新增', unresolved: '待核实', preexisting: '复核支持原有', refuted: '复核反驳', current: '当前源码复核支持' };
    output.push('- 候选复核：' + Object.entries(labels).filter(([key]) => counts[key] > 0).map(([key, label]) => label + ' ' + counts[key]).join('；') + '。');
  }
  const { uncertain, incomplete } = data.verification;
  output.push('- 复核状态分列：复核支持 ' + (counts.introduced + counts.preexisting + counts.current) + '；已复核不确定 ' + uncertain + '；复核未完成（未复核或未完成有效复核） ' + incomplete + (counts.refuted ? '；已反驳 ' + counts.refuted : '') + '。');
  if (counts.unresolved) output.push('- “待核实”为合计：已复核不确定与复核未完成分开列示，前者不表示复核未执行；均不能直接视为缺陷或必改项。');
  const unit = coverage.unit === 'files' ? '个文件' : '个变更条目（含目录）';
  const labels = { completed: '主审完成', excluded: '排除', blocked: '阻断', failed: '失败', cancelled: '取消', pending: '待审', running: '执行中', interrupted: '中断', unaccounted: '状态未记账' };
  output.push('- 覆盖：' + coverage.total + ' ' + unit + '；' + Object.entries(labels).filter(([key]) => coverage[key] > 0).map(([key, label]) => label + ' ' + coverage[key]).join('，') + (coverage.total ? '。' : '未执行。'));
  if (!coverage.detailsComplete) output.push('- 明细仅 ' + coverage.loaded + '/' + coverage.total + ' 项；未加载条目的路径与阶段状态未在本摘要核实。');
  if (data.unfinished.length) output.push('- 未完成条目 ' + data.unfinished.length + '（完整范围见后文及附录）' + (coverage.detailsComplete ? '。' : '；仅计已加载明细。'));
  if (Object.values(data.stages).some(Boolean)) output.push('- 后续阶段：待执行 ' + data.stages.pending + '，执行中 ' + data.stages.running + '，已停止 ' + data.stages.stopped + '。');
  if (data.unverifiedCandidates) output.push('- 候选复核未完成：' + data.unverifiedCandidates + ' 项。');
  if (data.crossFile.total) output.push('- 跨文件综合：完成 ' + data.crossFile.completed + '/' + data.crossFile.total + ' 项；未完成 ' + data.crossFile.pending + ' 项。');
  if (data.limitations) output.push('- 已记录限制：' + data.limitations + ' 项，见限制明细。');
  if (data.scopeNotices) output.push('- 范围说明：' + data.scopeNotices + ' 项，见附录；不计为未完成限制，完成不等于全部批准上下文已核查。');
  const qualifications = ['完成仅指处理进度，空发现不证明无缺陷'];
  if (counts.total) qualifications.push('按候选记录而非去重根因计数，复核支持及引用校验不是事实或因果证明');
  if (data.currentSourceOnly) qualifications.push('当前源码模式不评估历史新增归因');
  if (data.reused) qualifications.push('含既往轮次复用发现，不表示本轮重新取证');
  if (data.outdated) qualifications.push('仅对应原批准快照，不能作为当前源码结论');
  output.push('- 技术限定：' + qualifications.join('；') + '。');
  return output;
}
