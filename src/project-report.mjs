import {markdownReport} from './review.mjs';
export function renderProjectReport(report){
 const seen=new Set(),findings=[];for(const f of report.findings??[]){const key=JSON.stringify([f.path,f.anchor,f.title,f.evidence]);if(!seen.has(key)){seen.add(key);findings.push(f);}}
 const merged={...report,findings,interactions:(report.batches??[]).flatMap(b=>b.interactions??[]),limitations:(report.batches??[]).flatMap(b=>b.limitations??[])};
 return markdownReport(merged).replace('# Code Review 报告','# 全项目代码审查报告')+'\n\n总体范围：'+report.coverage.completed+'/'+report.coverage.total+' 个文件完成主审；排除 '+report.coverage.excluded+'，阻断 '+report.coverage.blocked+'，未完成 '+report.coverage.pending+'。综合未完成项单独列出；主审完成不等于审核通过。'+(report.outdated?'\n注意：来源已变化或无法复核，仅对应原批准快照。':'');
}
