import { markdownReport } from './review.mjs';

export function renderProjectReport(report) {
  const merged = {
    ...report,
    reviewMode: 'project',
    findings: report.findings ?? [],
    interactions: (report.batches ?? []).flatMap(b => b.interactions ?? []),
    limitations: [...(report.limitations ?? []), ...(report.batches ?? []).flatMap(b => b.limitations ?? [])],
  };
  return markdownReport(merged).replace('# Code Review 报告', '# 全项目代码审查报告');
}
