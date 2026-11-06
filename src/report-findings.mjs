import { groupDuplicateFindings } from './finding-groups.mjs';
import { comparisonValidated, verificationPresentation, modelComparisonValidated } from './report-summary.mjs';

const safe = value => Array.from(String(value ?? '')).map(c => {
  if (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) return ' ';
  if (c === '&') return '&amp;';
  if (c === '<') return '&lt;';
  if (c === '>') return '&gt;';
  return '*_[]#|!()\\`'.includes(c) ? '\\' + c : c;
}).join('');

export function findingDisposition(finding, report = {}) {
  const v = finding.verification;
  const evidence = Array.isArray(v?.evidence) && v.evidence.length > 0 && v.evidence.every(e => e?.status === 'references-validated');
  if (v?.status !== 'completed' || !evidence) return '待核实';
  if (v.verdict === 'refuted') return '已反驳';
  if (v.verdict !== 'supported') return '待核实';
  if (report.mode === 'project' || report.reviewMode === 'project' || report.projectScope || finding.attribution?.causality === 'current-source-only') return '当前源码问题（复核支持）';
  if (modelComparisonValidated(finding)) return '模型跨文件比较支持（关系由模型判断，未证明因果）';
  const r = v.regression;
  if (!comparisonValidated(finding)) return '待核实';
  return r.classification === 'introduced' ? '本次新增（复核支持）' : r.classification === 'preexisting' ? '原有问题（复核支持）' : '待核实';
}

function location(finding) {
  const a = finding.anchor ?? {};
  return safe(finding.path ?? '未标明文件') + (a.kind === 'line' ? ' · ' + (a.side === 'old' ? '修改前' : a.side === 'new' ? '修改后' : safe(a.side)) + '第 ' + safe(a.start) + '–' + safe(a.end) + ' 行' : a.kind === 'property' ? ' · 属性 ' + safe(a.name) : ' · 文件级');
}

export function findingsMarkdown(report) {
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const duplicate = new Map();
  for (const group of groupDuplicateFindings(findings)) for (const i of group.findingIndices.slice(1)) duplicate.set(i, group.findingIndices[0]);
  const sections = new Map([['本次新增（复核支持）',[]],['当前源码问题（复核支持）',[]],['模型跨文件比较支持（关系由模型判断，未证明因果）',[]],['复核后不确定',[]],['复核未完成',[]],['原有问题（复核支持）',[]],['已反驳',[]]]);
  findings.forEach((f,i)=>{
    const state = verificationPresentation(f, report);
    const label = modelComparisonValidated(f) ? findingDisposition(f,report) : state === 'uncertain' ? '复核后不确定' : state === 'incomplete' ? '复核未完成' : findingDisposition(f,report);
    if (!duplicate.has(i)) sections.get(label).push({f,i});
  });
  const output = ['', '## 审查发现'];
  if (!findings.length) return [...output, '本轮没有形成问题记录；这不等于已经排除未完成范围内的问题。'];
  output.push('以下分开列示复核支持、复核后不确定、复核未完成和已反驳的记录；证据引用通过校验不等于运行复现或因果证明。');
  for (const [label, items] of sections) {
    if (!items.length) continue;
    output.push('', '### ' + label);
    const levels = {critical:0,high:1,medium:2,low:3};
    items.sort((a,b)=>(levels[a.f.severity]??4)-(levels[b.f.severity]??4)||a.i-b.i);
    for (const {f,i} of items) {
      const severity = ({critical:'严重',high:'高',medium:'中',low:'低'})[f.severity] ?? safe(f.severity ?? '未分级');
      if (modelComparisonValidated(f)) output.push('- 比较依据：角色引用已校验；角色关系及“' + (f.verification.regression.classification === 'introduced' ? '本次新增' : '原有') + '”为模型语义判断，不是宿主契约或因果证明。' + safe(f.verification.regression.comparison.relationshipReason));
      const hypothesis = label === '复核后不确定' || label === '复核未完成' || label === '已反驳';
      output.push('', '#### ' + (i+1) + '. ' + (hypothesis ? '主审假说：' : '') + safe(f.title) + '（' + (hypothesis ? '主审拟议严重程度' : '严重程度') + '：' + severity + '）', '- 位置：' + location(f));
      if (hypothesis) output.push('- 阅读方式：以下为主审记录的线索和假说，不是确定事实或必改建议；原始字段及完整证据保留在技术附录。');
      const fields = hypothesis ? [['evidence','已知差异／线索（主审记录，非缺陷证明）'],['trigger','待证触发条件'],['impact','影响假说']] : [['trigger','什么情况下发生'],['impact','可能造成的影响'],['evidence','已看到的依据']];
      for (const [key,title] of fields) if (f[key]) output.push('- ' + title + '：' + safe(f[key]));
      if (label === '复核后不确定') output.push('- 复核结论：本候选已完成复核记录，但缺陷或新增归因仍未确定。' + safe(f.verification?.reason ?? '现有证据不足以支持或排除该假说。'));
      if (label === '复核未完成') output.push('- 复核进度：尚未完成有效复核，不能当作已复核不确定或已确认缺陷。' + safe(f.verification?.reason ?? '尚无有效复核结论。'));
      if (label === '已反驳') output.push('- 反证结论：' + safe(f.verification?.reason ?? '复核反驳该候选；不计为待修缺陷。'));
      if (f.attribution?.beforeBehavior) output.push('- 修改前' + (hypothesis ? '（主审描述，待核实）' : '') + '：' + safe(f.attribution.beforeBehavior));
      if (f.attribution?.afterBehavior) output.push('- 修改后' + (hypothesis ? '（主审描述，待核实）' : '') + '：' + safe(f.attribution.afterBehavior));
      if (hypothesis) output.push('- 待验证方案：先核对触发条件、实际调用路径及修改前后行为，再决定是否需要修复。' + (f.suggestion ? '原主审建议（待验证，不是必改项）：' + safe(f.suggestion) : '原记录未提供建议。'));
      else if (f.suggestion) output.push('- 建议：' + safe(f.suggestion));
      const related = [...duplicate].filter(([,first])=>first===i).map(([index])=>location(findings[index]));
      if (related.length) output.push('- 相同证据与解释的其他位置：' + related.join('；') + '。正文合并展示，原始候选仍保留。');
      const ledgerItem = report.reviewHistory?.ledger?.findings?.find(row => row.findingIndices?.includes(i));
      if (ledgerItem?.observation === 'repeated') output.push('- 历史台账：本轮再次观察到相同定位与缺陷主张；不重复创建新问题，当前证据仍须独立核对。');
      if (ledgerItem?.humanDecisions?.length) output.push('- 人工处置记录：' + ledgerItem.humanDecisions.map(row => safe(row.decision) + '：' + safe(row.reason)).join('；') + '；这是历史决定，不是修复或缺陷证明。');
      if (f.reused || f.priorRun) output.push('- 来源：包含既往审核结果，不表示本轮重新取证。');
      output.push('- 完整证据与判定过程：见技术附录中的候选 ' + (i+1) + '。');
    }
  }
  return output;
}
