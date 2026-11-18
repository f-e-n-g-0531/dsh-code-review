import test from 'node:test';
import assert from 'node:assert/strict';
import { renderUserReport } from '../src/user-report.mjs';
const candidate = (verdict = 'uncertain', classification = 'introduced') => ({fileId:'f0',path:'src/task.cpp',severity:'high',title:'候选状态覆盖',trigger:'前一请求尚未结束时提交另一请求',impact:'可能丢失状态',suggestion:'修复状态保存',anchor:{kind:'line',side:'new',start:4,end:5},attribution:{beforeBehavior:'CONFLICTING_BEFORE',afterBehavior:'CONFLICTING_AFTER'},evidence:'RAW_SOURCE',verification:{status:'completed',verdict,reason:'旧实现存在相同机制；缺少完整契约，尚不能证明新增。',evidence:[{sourceId:'old',status:'references-validated',text:'SECRET_RECEIPT'},{sourceId:'new',status:'references-validated'}],regression:{classification,status:'comparison-references-validated',oldEvidence:[0],newEvidence:[1]}}});
const base = findings => ({status:'completed',files:[{fileId:'f0',path:'src/task.cpp',status:'completed'}],findings});
const nl = String.fromCharCode(10);

const headings = text => text.match(/^## .+$/gm);
test('default report has exactly two sections with concrete changes and no execution clutter',()=>{
 const report={...base([]),modelCalls:132,diagnostics:{executionWallMs:1017450},orchestration:{batchExecution:'host-subagents',childrenStarted:['private-child']}};
 report.files[0].changeSummary='移除中间字符串输出参数，直接返回名称。';
 const before=structuredClone(report),text=renderUserReport(report);
 assert.deepEqual(headings(text),['## 1. 改动内容','## 2. 报告']);
 assert.match(text,/移除中间字符串输出参数，直接返回名称/);assert.match(text,/代码检查已完成，未发现明确问题/);
 assert.doesNotMatch(text,/保证等级|模型调用|执行耗时|主审完成|覆盖与后续|建议顺序|宿主子会话|private-child|technical|候选总数/);
 assert.deepEqual(report,before);
});
test('legacy reports never invent change explanations',()=>{
 assert.match(renderUserReport(base([])),/未记录改动说明/);
 assert.match(renderUserReport({}),/未提供改动内容/);
});
test('findings retain evidence-gated classifications, locations and actionable detail',()=>{
 const report=base([candidate(),candidate('supported','preexisting'),candidate('supported')]);
 const text=renderUserReport(report);
 assert.ok(text.indexOf('候选 3 · 本次新增')<text.indexOf('候选 1 · 尚不能确认'));
 assert.match(text,/候选 2 · 原有问题（非本次新增）/);assert.match(text,/修改后 4–5/);
 assert.match(text,/可能丢失状态/);assert.match(text,/下一步：修复状态保存/);
 assert.doesNotMatch(text,/RAW_SOURCE|SECRET_RECEIPT|CONFLICTING_/);
 for(const mutate of [f=>f.verification.evidence=[],f=>f.verification.regression.newEvidence=[0],f=>delete f.verification.regression.status]){
  const f=candidate('supported');mutate(f);assert.match(renderUserReport(base([f])),/候选 1 · 尚不能确认/);
 }
});
test('unfinished, failed, outdated and paged reports cannot appear clean',()=>{
 for(const status of ['partial','unknown','cancelled','failed','interrupted']){
  const text=renderUserReport({...base([]),status});assert.doesNotMatch(text,/代码检查已完成|未发现明确问题/);assert.match(text,/不能据此判断全部改动/);
 }
 const partial={status:'partial',findings:[],coverage:{total:74,completed:5,failed:64,pending:4,blocked:1},files:Array.from({length:20},(_,i)=>({status:'failed',path:'file'+i,failureCode:'WHOLE_SCOPE_INPUT_BUDGET'}))};
 const text=renderUserReport(partial);assert.match(text,/已加载明细中的原因：子会话输入超过批准容量，20 项/);assert.match(text,/文件明细未齐/);assert.doesNotMatch(text,/容量，64 项/);
 assert.match(renderUserReport({...base([]),outdated:true}),/报告已过期.*原快照/);
});
test('refuted and incomplete findings do not become mandatory fixes',()=>{
 const f=candidate();f.verification.status='pending';const text=renderUserReport(base([f,candidate('refuted')]));
 assert.match(text,/尚未完成复核/);assert.match(text,/复核已反驳/);assert.doesNotMatch(text,/- 下一步：修复状态保存/);
});
test('untrusted change summaries and finding text cannot inject markup',()=>{
 const payload='<script>evil</script>'+nl+'# injected [click](javascript:evil)',f=candidate('supported');
 for(const k of ['title','path','trigger','impact','suggestion']) f[k]=payload;f.verification.reason=payload;
 const report=base([f]);report.files[0].changeSummary=payload;
 const text=renderUserReport(report);assert.doesNotMatch(text,/<script>|^# injected/m);assert.match(text,/&lt;script&gt;/);assert.equal(headings(text).length,2);
});
test('bounded expansion retains original finding numbers and long judgement ends',()=>{
 const report=base(Array.from({length:9},()=>candidate()));report.findings[0].verification.reason='起因。'+'中间'.repeat(500)+'但不能证明新增。';
 const before=structuredClone(report),text=renderUserReport(report,{maxFindings:2});
 assert.equal(text.split('### 候选').length-1,2);assert.match(text,/另有 7 项候选/);assert.match(text,/起因。.*中段已省略.*但不能证明新增/);assert.deepEqual(report,before);
 for(const maxFindings of [0,-1,1.5,21,'5'])assert.throws(()=>renderUserReport(report,{maxFindings}));
});
test('stale clean historical report cannot present a clean current verdict',()=>{
 const text=renderUserReport({...base([]),outdated:true});
 assert.match(text,/报告已过期.*原快照/);
 assert.doesNotMatch(text,/代码检查已完成，未发现明确问题/);
});
