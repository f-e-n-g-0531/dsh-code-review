import { markdownReport } from './review.mjs';

function dedupeFindings(findings) {
  const seen = new Set();
  const result = [];
  for (const f of findings ?? []) {
    const key = JSON.stringify([f.path, f.anchor, f.title, f.evidence]);
    if (!seen.has(key)) { seen.add(key); result.push(f); }
  }
  return result;
}

export function renderProjectReport(report) {
  const merged = {
    ...report,
    findings: dedupeFindings(report.findings),
    interactions: (report.batches ?? []).flatMap(b => b.interactions ?? []),
    limitations: (report.batches ?? []).flatMap(b => b.limitations ?? []),
  };
  const scope = '总体范围：' + report.coverage.completed + '/' + report.coverage.total + ' 个文件完成主审；排除 ' + report.coverage.excluded + '，阻断 ' + report.coverage.blocked + '，未完成 ' + report.coverage.pending + '。综合未完成项单独列出；主审完成不等于审核通过。';
  const outdated = report.outdated ? '\n注意：来源已变化或无法复核，仅对应原批准快照。' : '';
  return markdownReport(merged).replace('# Code Review 报告', '# 全项目代码审查报告') + '\n\n' + scope + outdated;
}
