import { groupDuplicateFindings } from './finding-groups.mjs';
import { comparisonValidated } from './report-summary.mjs';

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
  const sections = new Map([['本次新增（复核支持）',[]],['当前源码问题（复核支持）',[]],['待核实',[]],['原有问题（复核支持）',[]],['已反驳',[]]]);
  findings.forEach((f,i)=>{ if (!duplicate.has(i)) sections.get(findingDisposition(f,report)).push({f,i}); });
  const output = ['', '## 审查发现'];
  if (!findings.length) return [...output, '本轮没有形成问题记录；这不等于已经排除未完成范围内的问题。'];
  output.push('以下区分复核支持、待核实和已反驳的记录；证据引用通过校验不等于运行复现或因果证明。');
  for (const [label, items] of sections) {
    if (!items.length) continue;
    output.push('', '### ' + label);
    for (const {f,i} of items) {
      const severity = ({critical:'严重',high:'高',medium:'中',low:'低'})[f.severity] ?? safe(f.severity ?? '未分级');
      output.push('', '#### ' + (i+1) + '. ' + safe(f.title) + '（严重程度：' + severity + '）', '- 位置：' + location(f));
      for (const [key,title] of [['trigger','什么情况下发生'],['impact','可能造成的影响'],['evidence','已看到的依据']]) if (f[key]) output.push('- ' + title + '：' + safe(f[key]));
      if (label === '待核实') output.push('- 尚未确定：' + safe(f.verification?.reason ?? '候选尚未完成有效的独立复核或修改前后对照，不能作为已确认缺陷。'));
      if (label === '已反驳') output.push('- 反证结论：' + safe(f.verification?.reason ?? '复核反驳该候选；不计为待修缺陷。'));
      if (f.attribution?.beforeBehavior) output.push('- 修改前：' + safe(f.attribution.beforeBehavior));
      if (f.attribution?.afterBehavior) output.push('- 修改后：' + safe(f.attribution.afterBehavior));
      if (f.suggestion) output.push('- 建议：' + safe(f.suggestion));
      const related = [...duplicate].filter(([,first])=>first===i).map(([index])=>location(findings[index]));
      if (related.length) output.push('- 相同证据与解释的其他位置：' + related.join('；') + '。正文合并展示，原始候选仍保留。');
      if (f.reused || f.priorRun) output.push('- 来源：包含既往审核结果，不表示本轮重新取证。');
      output.push('- 完整证据与判定过程：见技术附录中的候选 ' + (i+1) + '。');
    }
  }
  return output;
}
