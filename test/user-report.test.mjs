import test from 'node:test';
import assert from 'node:assert/strict';
import { renderUserReport } from '../src/user-report.mjs';
const candidate = (verdict = 'uncertain', classification = 'introduced') => ({fileId:'f0',path:'src/task.cpp',severity:'high',title:'候选状态覆盖',trigger:'前一请求尚未结束时提交另一请求',impact:'可能丢失状态',suggestion:'修复状态保存',anchor:{kind:'line',side:'new',start:4,end:5},attribution:{beforeBehavior:'CONFLICTING_BEFORE',afterBehavior:'CONFLICTING_AFTER'},evidence:'RAW_SOURCE',verification:{status:'completed',verdict,reason:'旧实现存在相同机制；缺少完整契约，尚不能证明新增。',evidence:[{sourceId:'old',status:'references-validated',text:'SECRET_RECEIPT'},{sourceId:'new',status:'references-validated'}],regression:{classification,status:'comparison-references-validated',oldEvidence:[0],newEvidence:[1]}}});
const base = findings => ({status:'completed',files:[{fileId:'f0',path:'src/task.cpp',status:'completed'}],findings});
const nl = String.fromCharCode(10);

test('archived 0.90 shape produces decision-first concise report without raw dump',()=>{
 const report={status:'partial',files:Array.from({length:74},(_,i)=>({fileId:'f'+i,path:'src/file'+i+'.cpp',status:i<39?'completed':i===39?'blocked':'pending'})),findings:[candidate(),candidate()],interactions:Array.from({length:34},()=>({status:'pending'})),limitations:Array.from({length:224},()=>({text:'PRIVATE_LIMITATION'})),scopeNotices:Array(73).fill({text:'PRIVATE_NOTICE'}),stageContinuation:{pending:3,stopped:2},modelCalls:132,diagnostics:{executionWallMs:1017450},execution:{executionStrategy:'staged'}};
 const before=structuredClone(report),text=renderUserReport(report);
 assert.ok(text.split(nl).length<=60);assert.match(text,/本次新增复核支持 0 项.*尚不能确认 2 项/);
 assert.match(text,/主审完成 39.74.*待审 34.*阻断 1/);assert.match(text,/未完成条目 35/);assert.match(text,/另 30 项未展开/);assert.match(text,/跨文件综合完成 0.34/);
 assert.match(text,/模型调用 132 次；执行耗时 1017.5 秒/);assert.match(text,/224 条限制/);
 assert.doesNotMatch(text,/PRIVATE_|SECRET_RECEIPT|RAW_SOURCE|CONFLICTING_|<details>|SHA256/);
 assert.ok(text.indexOf('复核判断：')<text.indexOf('触发条件（候选描述）'));
 assert.match(text,/再决定是否修复/);assert.match(text,/technical/);assert.deepEqual(report,before);
});

test('supported classification stays evidence gated with original candidate numbers',()=>{
 const findings=[candidate(),candidate('supported','preexisting'),candidate('supported')];
 const text=renderUserReport(base(findings));assert.match(text,/本次新增复核支持 1 项；原有问题 1 项/);
 assert.ok(text.indexOf('候选 3 · 本次新增')<text.indexOf('候选 1 · 尚不能确认'));
 assert.match(text,/候选 2 · 原有问题（非本次新增）/);
 for(const mutate of [f=>f.verification.evidence=[],f=>f.verification.regression.newEvidence=[0],f=>delete f.verification.regression.status]){
  const f=candidate('supported');mutate(f);assert.match(renderUserReport(base([f])),/本次新增复核支持 0 项.*尚不能确认 1 项/);
 }
});

test('incomplete and refuted candidates never become fix requirements',()=>{
 const f=candidate();f.verification.status='pending';const text=renderUserReport(base([f,candidate('refuted')]));
 assert.match(text,/未完成复核 1 项/);assert.match(text,/尚未完成复核/);assert.match(text,/已被复核反驳/);
 assert.doesNotMatch(text,/- 下一步：修复状态保存/);
});

test('empty unknown cancelled failed and outdated reports preserve no-clean boundaries',()=>{
 for(const status of ['partial','unknown','cancelled','failed','interrupted']){
  const text=renderUserReport({...base([]),status});assert.doesNotMatch(text,/所选范围处理完成/);assert.match(text,/不等于审核通过/);
 }
 assert.match(renderUserReport(base([])),/所选范围处理完成/);
 assert.match(renderUserReport({...base([]),outdated:true}),/报告已过期.*原快照/);
 assert.match(renderUserReport({...base([]),outdated:true}),/先对当前源码重新预览审核/);
 assert.match(renderUserReport({}),/未选择审核条目/);
});

test('project and missing file details are not mislabeled introduced or fully covered',()=>{
 const report={...base([candidate('supported')]),mode:'project',coverage:{total:3,completed:1,pending:2}};
 const text=renderUserReport(report);assert.match(text,/当前源码复核支持 1 项/);assert.doesNotMatch(text,/本次新增复核支持 1/);assert.match(text,/文件明细未齐/);assert.match(text,/1.3 个文件/);
});

test('partial page labels unfinished entries as loaded only, not whole-scope total',()=>{
 const report={status:'partial',findings:[],coverage:{total:74,completed:39,blocked:1,pending:34},files:Array.from({length:20},(_,i)=>({fileId:'f'+i,path:'loaded/file'+i+'.cpp',status:i<14?'completed':'pending'}))};
 const text=renderUserReport(report);
 assert.ok(text.includes('- 已加载未完成条目 6：'));
 assert.ok(!text.includes('- 未完成条目 6：'));
 assert.match(text,/主审完成 39.74.*待审 34.*阻断 1/);
 assert.match(text,/文件明细未齐/);
 assert.doesNotMatch(text,/所选范围处理完成/);
});

test('untrusted text cannot inject markup lines links or raw status',()=>{
 const payload='<script>evil</script>'+nl+'# injected [click](javascript:evil)';const f=candidate('supported');
 for(const k of ['title','path','trigger','impact','suggestion'])f[k]=payload;f.verification.reason=payload;
 const report={...base([f]),status:payload};const text=renderUserReport(report);
 assert.doesNotMatch(text,/<script>|^# injected/m);assert.match(text,/&lt;script&gt;/);
 assert.match(text,/审核尚未完成/);
});

test('long fields and candidate count are explicitly bounded without source mutation',()=>{
 const findings=Array.from({length:9},()=>candidate());findings[0].verification.reason='长'.repeat(900);
 const report=base(findings),before=structuredClone(report),text=renderUserReport(report,{maxFindings:2});
 assert.equal(text.split('### 候选').length-1,2);assert.match(text,/另有 7 项候选未在简报展开/);assert.match(text,/中段已省略/);assert.deepEqual(report,before);
 for(const maxFindings of [0,-1,1.5,21,'5'])assert.throws(()=>renderUserReport(report,{maxFindings}));
});

test('long judgement retains beginning and ending without classifying or reordering prose',()=>{
 const f=candidate();f.verification.reason='局部现象成立。'+'中间取证说明'.repeat(130)+'但旧实现存在相同机制，尚不能证明新增，影响缺少契约支持。';
 const report=base([f]),before=structuredClone(report),text=renderUserReport(report);
 assert.match(text,/局部现象成立/);assert.match(text,/中段已省略/);assert.match(text,/但旧实现存在相同机制，尚不能证明新增，影响缺少契约支持/);
 assert.match(text,/本次新增复核支持 0 项/);assert.ok(text.split(nl).length<=60);assert.deepEqual(report,before);
});

test('execution failures lead the first screen using host codes, never model prose',()=>{
 const files=Array.from({length:74},(_,i)=>({fileId:'f'+i,path:'file'+i,status:i<64?'failed':i<68?'pending':i===68?'blocked':'completed',...(i<64?{failureCode:'WHOLE_SCOPE_INPUT_BUDGET'}:i<68?{failureCode:'WHOLE_SCOPE_MODEL_CALL_LIMIT'}:{})}));
 const report={status:'partial',files,findings:[],limitations:[],dispatch:{plannedChildCount:6},orchestration:{batchExecution:'host-subagents',childrenStarted:['a','b','c','d','e','f'],batches:[{execution:'host-subagent',childId:'f',status:'completed'}]}};
 const before=structuredClone(report),text=renderUserReport(report),lines=text.split(nl);
 assert.match(lines[3],/审核执行受阻，不能据此判断业务代码/);
 assert.match(lines[4],/子会话输入超过批准容量，64 项/);assert.match(lines[5],/子会话达到模型调用次数限制，4 项/);
 assert.ok(text.indexOf('WHOLE')<text.indexOf('本次新增复核支持 0 项'));
 assert.match(text,/计划 6，已启动 6，已完成批次 1；已记录返回身份 1/);
 assert.ok(lines.length<=60);assert.deepEqual(report,before);
 const fake={...base([]),status:'partial',files:[{status:'failed',path:'x',failureCode:'ALIEN',reason:'WHOLE_SCOPE_INPUT_BUDGET malicious prose'}]};
 const unknown=renderUserReport(fake);assert.match(unknown,/尚无可识别的执行原因代码/);assert.doesNotMatch(unknown,/子会话输入超过批准容量/);
});

test('paged execution cause counts are loaded only, never extrapolated to aggregate failures',()=>{
 const report={status:'partial',findings:[],coverage:{total:74,completed:5,failed:64,pending:4,blocked:1},files:Array.from({length:20},(_,i)=>({status:i===0?'blocked':'failed',path:'file'+i,...(i?{failureCode:'WHOLE_SCOPE_INPUT_BUDGET'}:{})}))};
 const text=renderUserReport(report);
 assert.match(text,/已加载明细中的原因：子会话输入超过批准容量，19 项/);
 assert.match(text,/原因计数仅覆盖已加载 20.74 项/);
 assert.doesNotMatch(text,/子会话输入超过批准容量，64 项/);
 assert.match(text,/主审失败 64 项/);
});

test('execution records actual children not planned fanout and unknown metrics stay absent',()=>{
 const report=base([]);report.orchestration={batchExecution:'host-subagents',batches:[{execution:'host-subagent',childId:'child-a'},{execution:'host-subagent',childId:'child-b'},{execution:'host-subagent',childId:'child-a'}]};
 let text=renderUserReport(report);assert.match(text,/已启动 未记录，已完成批次 0；已记录返回身份 2/);assert.doesNotMatch(text,/模型调用|执行耗时/);
 report.orchestration={batchExecution:'direct'};assert.match(renderUserReport(report),/主会话直接调用模型/);
 report.orchestration={batchExecution:'host-subagents',batches:[]};assert.doesNotMatch(renderUserReport(report),/实际执行：.*个宿主子会话/);
 report.orchestration={};report.dispatch={effectiveStrategy:'staged',reason:'complete-files-exceed-capacity',plannedChildCount:0};
 assert.match(renderUserReport(report),/完整文件超过单次输入容量.*未使用宿主子会话/);
});
test('model-assessed cross-file support is disclosed separately without strict support promotion',()=>{const f=candidate('supported');f.verification.evidence=f.verification.evidence.map((ref,index)=>({...ref,snapshotId:'s',hash:'a'.repeat(64),start:1,count:1,text:index?'new();':'old();'}));Object.assign(f.verification.regression,{status:'model-comparison-references-validated',relationshipStatus:'model-assessed',sourceReferencesValidated:true,causality:'unverified',comparison:{kind:'model-assessed-cross-file',roles:{oldEntry:[0],oldDelegate:[0],newEntry:[1],callers:[0]},relationshipReason:'Compare same request'}});const text=renderUserReport(base([f]));assert.match(text,/本次新增复核支持 0 项/);assert.match(text,/另有模型跨文件比较支持 1 项/);assert.match(text,/关系由模型判断，未证明因果/);assert.doesNotMatch(text,/SECRET_RECEIPT/);});
