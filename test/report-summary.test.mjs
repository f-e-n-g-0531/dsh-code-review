import test from 'node:test';
import assert from 'node:assert/strict';
import { reportSummaryData, reportSummaryMarkdown } from '../src/report-summary.mjs';
import { validateCandidateVerification } from '../src/candidate-verification.mjs';

const ref = side => ({snapshotId:'snapshot',sourceId:side,hash:'a'.repeat(64),start:1,count:1,text:side+'\n'});
function candidate({verdict='supported',classification='introduced'}={}) {
  const evidence=[ref('old'),ref('new')];
  const [verification]=validateCandidateVerification({verdicts:[{candidateId:'c1',verdict,reason:'checked',evidence,regression:{classification,reason:'same trigger compared',oldEvidence:[0],newEvidence:[1]}}]},['c1'],request=>evidence.find(item=>item.sourceId===request.id),value=>value,{catalog:[{id:'old',fileId:'f',side:'old'},{id:'new',fileId:'f',side:'new'}],fileIds:{c1:'f'}});
  return {fileId:'f',path:'file.ts',title:'candidate',verification:{status:'completed',...verification}};
}
const render = report => reportSummaryMarkdown(report).join('\n');
const counts = report => reportSummaryData(report).counts;

test('introduced requires the actual validated comparison, not supported alone',()=>{
  const finding=candidate();
  assert.deepEqual(counts({findings:[finding]}),{total:1,introduced:1,unresolved:0,refuted:0,preexisting:0,current:0});
  assert.equal(finding.verification.causality,'unverified');
  const cases=[{}, {verification:{status:'completed',verdict:'supported'}}, candidate(),candidate(),candidate(),candidate({verdict:'uncertain'}),candidate({classification:'uncertain'})];
  cases[2].verification.status='pending';cases[3].verification.status='incomplete';delete cases[4].verification.regression;
  assert.equal(counts({findings:cases}).introduced,0);
  assert.equal(counts({findings:cases}).unresolved,7);
});

test('host markers and nonempty valid disjoint side references remain mandatory',()=>{
  const changes=[f=>delete f.verification.regression.status,f=>f.verification.regression.oldEvidence=[],f=>f.verification.regression.newEvidence=[9],f=>f.verification.regression.newEvidence=[0],f=>f.verification.regression.oldEvidence=[0,0],f=>f.verification.evidence[0].status='unchecked',f=>f.verification.evidence[1].sourceId='old',f=>f.verification.regression.oldEvidence=[-1],f=>f.verification.regression.oldEvidence=[0.5],f=>f.verification.regression.newEvidence=Array(9).fill(1)];
  const findings=changes.map(change=>{const f=candidate();change(f);return f;});
  assert.equal(counts({findings}).introduced,0);
  assert.equal(counts({findings}).unresolved,changes.length);
});

test('candidate categories are disjoint and model conclusions are not facts',()=>{
  const findings=[candidate(),candidate({verdict:'refuted'}),candidate({classification:'preexisting'}),candidate({verdict:'uncertain'}),{}];
  assert.deepEqual(counts({findings}),{total:5,introduced:1,unresolved:2,refuted:1,preexisting:1,current:0});
  const text=render({findings});
  assert.match(text,/复核支持本次新增 1；待核实 2；复核支持原有 1；复核反驳 1/);
  assert.match(text,/不是事实或因果证明/);
  assert.doesNotMatch(text,/已确认新增|已确认缺陷/);
  const partial=candidate({verdict:'refuted'});partial.verification.status='pending';
  const unchecked=candidate({verdict:'refuted'});unchecked.verification.evidence[0].status='unchecked';
  assert.equal(counts({findings:[partial,unchecked]}).unresolved,2);
});

test('project/current-source support is never attributed to this change',()=>{
  for(const project of [{mode:'project'},{reviewMode:'project'},{projectScope:{}}]){
    const data=reportSummaryData({...project,findings:[candidate()]});
    assert.equal(data.counts.introduced,0);assert.equal(data.counts.current,1);assert.equal(data.coverage.unit,'files');
    assert.match(render({...project,findings:[candidate()]}),/当前源码复核支持 1/);
  }
  const finding=candidate();finding.attribution={status:'not-applicable',causality:'current-source-only'};
  assert.equal(counts({findings:[finding]}).current,1);
  assert.match(render({findings:[finding]}),/当前源码模式不评估历史新增归因/);
});

test('clean completed summary leads with completion, zero candidates and no release approval',()=>{
  const report={status:'completed',files:[{status:'completed'}],findings:[]};
  const lines=reportSummaryMarkdown(report),text=lines.join('\n');
  assert.equal(lines[2],'- 所选范围已查完；未记录候选问题；不得据此放行。');
  assert.equal(reportSummaryData(report).complete,true);
  assert.doesNotMatch(text,/候选复核：|复核支持本次新增 0|待核实 0|已反驳|不支持“审核通过”/);
  assert.equal(lines.filter(line=>line.includes('技术限定：')).length,1);
  assert.equal(lines.filter(line=>line.includes('不证明')).length,1);
});

test('partial cancelled failed interrupted pending and running remain unfinished',()=>{
  const labels={partial:'部分完成',cancelled:'已取消',failed:'执行失败',interrupted:'已中断',pending:'待执行',running:'执行中'};
  for(const [status,label] of Object.entries(labels)){
    const report={status,files:[{status:'completed'}],findings:[]};
    assert.equal(reportSummaryData(report).complete,false);
    assert.ok(reportSummaryMarkdown(report)[2].includes('尚未查完（'+label+'）'));
    assert.match(render(report),/不得据此放行/);assert.doesNotMatch(render(report),/所选范围已查完/);
  }
});

test('main completion cannot hide synthesis, verification, window, pass or retrieval gaps',()=>{
  const files=[{fileId:'a',path:'synthesis',status:'completed',stageFailures:[{phase:'window-synthesis'}]},{fileId:'b',path:'verification',status:'completed'},{path:'windows',status:'completed',windowCoverage:{pending:['w1']}},{path:'reader',status:'completed',retrievalLimited:true},{path:'pass',status:'completed',reviewPasses:[{status:'pending'}]},{path:'synth-state',status:'completed',synthesisStatus:'pending'},{path:'verify-state',status:'completed',verificationStatus:'failed'},{path:'excluded',status:'excluded'}];
  const report={status:'completed',files,findings:[{fileId:'b',verification:{status:'incomplete'}}],interactions:[{status:'pending'},{status:'completed'}],limitations:[{text:'PRIVATE_SOURCE'}]};
  const data=reportSummaryData(report),text=render(report);
  assert.equal(data.complete,false);assert.equal(data.unfinished.length,7);
  assert.deepEqual(data.unfinished.map(item=>item.path),files.slice(0,7).map(item=>item.path));
  for(const label of ['阶段失败','复核未完成','窗口待审 1','取证受限','审查轮次未完成','综合未完成']) assert.ok(data.unfinished.some(item=>item.reasons.includes(label)));
  assert.match(text,/未完成条目 7（完整范围见后文及附录）/);
  assert.doesNotMatch(text,/synthesis|verification|windows|reader|synth-state|verify-state/);
  assert.ok(text.includes('跨文件综合：完成 1/2 项；未完成 1 项'));
  assert.match(text,/已记录限制：1 项/);assert.doesNotMatch(text,/PRIVATE_SOURCE|关键未完成/);
});

test('change coverage includes directories and keeps all pending paths in data only',()=>{
  const files=Array.from({length:8},(_,i)=>({path:i===0?'[click](javascript:evil)\n<script>':'path'+i,status:'pending'}));
  const report={status:'completed',coverage:{total:12,completed:3,pending:8,excluded:1},files};
  const text=render(report),data=reportSummaryData(report);
  assert.equal(data.complete,false);assert.equal(data.unfinished.length,8);
  assert.match(text,/12 个变更条目（含目录）；主审完成 3，排除 1，待审 8/);
  assert.deepEqual(data.unfinished.map(item=>item.path),files.map(item=>item.path));
  assert.match(text,/未完成条目 8（完整范围见后文及附录）/);
  assert.doesNotMatch(text,/<script>|javascript:evil|path[1-7]|全部/);
  assert.match(text,/明细仅 8\/12/);
  assert.match(render({...report,reviewMode:'project'}),/12 个文件/);
});

test('aggregate pending/failed/unknown coverage cannot claim finished without file rows',()=>{
  for(const coverage of [{total:2,completed:1,pending:1},{total:2,completed:1,failed:1},{total:2,completed:1},{total:2,completed:1,cancelled:1},{total:2,completed:1,running:1}]){
    const report={status:'completed',coverage,files:[{status:'completed'}]};
    assert.equal(reportSummaryData(report).complete,false);assert.match(render(report),/尚未查完/);
  }
  assert.match(render({status:'completed',coverage:{total:2,completed:1},files:[{status:'completed'}]}),/状态未记账 1/);
});

test('cross-file completion is independently visible and gates finished state',()=>{
  const report={status:'completed',files:[{status:'completed'}],interactions:[{status:'failed'}]};
  assert.equal(reportSummaryData(report).complete,false);
  assert.deepEqual(reportSummaryData(report).crossFile,{total:1,completed:0,pending:1});
  assert.equal(reportSummaryData(report).unfinished.length,0);
  assert.ok(render(report).includes('跨文件综合：完成 0/1 项；未完成 1 项'));
  report.interactions[0].status='completed';
  assert.equal(reportSummaryData(report).complete,true);
});

test('continuation stages cannot disappear behind completed main review',()=>{
  const report={status:'completed',files:[{path:'continued',status:'completed',continuationPending:true}],stageContinuation:{pending:1,running:1,stopped:1}};
  const data=reportSummaryData(report);
  assert.equal(data.complete,false);assert.deepEqual(data.stages,{pending:1,running:1,stopped:1});
  assert.match(render(report),/后续阶段：待执行 1，执行中 1，已停止 1/);
  assert.deepEqual(data.unfinished,[{path:'continued',reasons:['后续阶段待执行']}]);
  assert.match(render(report),/未完成条目 1（完整范围见后文及附录）/);
  report.files[0].continuationPending=false;
  assert.equal(reportSummaryData(report).complete,false);
});

test('outdated and reused evidence retain provenance in one technical qualification',()=>{
  const finding=candidate();finding.reused=true;finding.priorRun={jobId:'PRIVATE_JOB'};
  const report={status:'completed',outdated:true,files:[{fileId:'f',status:'completed'}],findings:[finding]};
  const lines=reportSummaryMarkdown(report),text=lines.join('\n');
  assert.match(lines[2],/报告已过期.*不得据此放行/);
  assert.match(text,/不表示本轮重新取证/);assert.match(text,/仅对应原批准快照/);assert.doesNotMatch(text,/PRIVATE_JOB/);
  assert.equal(lines.filter(line=>/重新取证|原批准快照|不是事实/.test(line)).length,1);
});

test('summary data and Markdown are deterministic, detached and nonmutating',()=>{
  const finding=candidate();finding.title='PRIVATE_TITLE';finding.evidence='PRIVATE_SOURCE';
  const report={status:'completed',findings:[finding],files:[{fileId:'f',path:'file.ts',status:'pending'}],diagnostics:{error:'PRIVATE_ERROR'},regressionCoverage:{introduced:99}};
  const original=structuredClone(report),data=reportSummaryData(report),first=reportSummaryMarkdown(report);
  assert.deepEqual(report,original);assert.deepEqual(first,reportSummaryMarkdown(report));
  assert.doesNotMatch(JSON.stringify(data)+first.join(''),/PRIVATE|99/);
  data.unfinished[0].reasons.push('changed');data.unfinished[0].path='changed';data.counts.introduced=999;
  assert.deepEqual(report,original);assert.equal(reportSummaryData(report).counts.introduced,1);
});

test('only nonzero candidate categories are displayed without relaxing strict counts',()=>{
  const report={findings:[candidate()]};
  assert.match(render(report),/候选复核：复核支持本次新增 1。/);
  assert.doesNotMatch(render(report),/待核实 0|复核支持原有 0|复核反驳 0|当前源码复核支持 0/);
  assert.deepEqual(counts(report),{total:1,introduced:1,unresolved:0,refuted:0,preexisting:0,current:0});
});

test('paginated coverage uses aggregate totals without claiming complete path detail',()=>{
  const files=Array.from({length:20},(_,i)=>({path:'loaded-'+i,status:'completed'}));
  for(const totals of [{coverage:{completed:50}},{coverage:{completed:50},totalFiles:60},{coverage:{total:70,completed:50},totalFiles:60}]){
    const report={status:'completed',files,...totals};
    const data=reportSummaryData(report),text=render(report);
    const total=totals.coverage.total??totals.totalFiles??50;
    assert.equal(data.coverage.total,total);
    assert.equal(data.coverage.completed,50);
    assert.equal(data.coverage.loaded,20);
    assert.equal(data.coverage.detailsComplete,false);
    assert.equal(data.complete,false);
    assert.ok(text.includes('明细仅 20/'+total));
    assert.doesNotMatch(text,/所选范围已查完|全部/);
  }
});

test('missing detail does not fabricate unfinished paths or hide known aggregate gaps',()=>{
  const report={status:'completed',coverage:{completed:50,pending:30},files:[{path:'loaded-pending',status:'pending'}],outdated:true,stageContinuation:{pending:1}};
  const data=reportSummaryData(report),text=render(report);
  assert.equal(data.coverage.total,80);
  assert.equal(data.complete,false);
  assert.deepEqual(data.unfinished,[{path:'loaded-pending',reasons:['待执行']}]);
  assert.match(text,/明细仅 1\/80/);
  assert.match(text,/未完成条目 1（完整范围见后文及附录）；仅计已加载明细/);
  assert.match(text,/待审 30/);
  assert.match(text,/报告已过期/);
  assert.match(text,/后续阶段：待执行 1/);
  assert.doesNotMatch(text,/loaded-pending|全部|所选范围已查完/);
});

test('zero selection and excluded-only runs never claim audited code',()=>{
  const empty={status:'completed',files:[],findings:[]};
  assert.equal(reportSummaryData(empty).emptySelection,true);assert.equal(reportSummaryData(empty).complete,false);
  assert.match(reportSummaryMarkdown(empty)[2],/未选择条目，没有执行代码审核/);
  const excluded={status:'completed',files:[{status:'excluded'}],findings:[]};
  assert.equal(reportSummaryData(excluded).complete,false);assert.match(render(excluded),/尚未查完/);
  assert.doesNotMatch(render(excluded),/所选范围已查完/);
});
