import test from 'node:test';
import assert from 'node:assert/strict';
import { reportSummaryData, reportSummaryMarkdown, verificationPresentation, supportedFindingPriorities } from '../src/report-summary.mjs';
import { renderUserReport } from '../src/user-report.mjs';
import { findingsMarkdown } from '../src/report-findings.mjs';

const finding = () => ({fileId:'f',path:'src/example.cpp',severity:'high',title:'候选标题',trigger:'输入失效时',impact:'请求状态可能丢失',suggestion:'仅在校验后更新状态',evidence:'PRIVATE_SOURCE',anchor:{kind:'line',side:'new',start:1,end:1,snippet:'PRIVATE_SNIPPET'},verification:{status:'not-requested',method:'single-pass-model',causality:'model-assessed'},validation:{schema:'validated',identity:'validated',anchor:'exact-snapshot'}});
const report = (n=1) => ({status:'completed',execution:{executionStrategy:'single-pass',assurance:{level:'single-model',independentVerification:false}},executionAssurance:{mode:'single-pass',independentVerification:false,protocolValid:true},files:[{fileId:'f',path:'src/example.cpp',status:'completed',primaryStatus:'completed',verificationStatus:'not-requested'}],findings:Array.from({length:n},finding),limitations:[{text:'PRIVATE_LIMITATION'}]});
const summary = r => reportSummaryMarkdown(r).join(String.fromCharCode(10));

test('host validated single-pass candidates are neither supported, uncertain nor pending',()=>{
  const r=report(), before=structuredClone(r), data=reportSummaryData(r);
  assert.equal(verificationPresentation(r.findings[0],r),'single-model');
  assert.equal(data.complete,true); assert.equal(data.unverifiedCandidates,0);
  assert.deepEqual(data.verification,{supported:0,uncertain:0,incomplete:0});
  assert.deepEqual(data.unfinished,[]); assert.deepEqual(supportedFindingPriorities(r),[]);
  assert.deepEqual(data.counts,{total:1,introduced:0,unresolved:0,refuted:0,preexisting:0,current:0,singleModel:1});
  for(const text of [summary(r),renderUserReport(r)]){
    assert.match(text,/单模型候选（未独立复核）/);
    assert.doesNotMatch(text,/补齐未.*阶段|未完成复核 1|已复核不确定 1|复核支持本次新增 1|PRIVATE_/);
  }
  assert.match(summary(r),/不可当放行/);
  assert.match(renderUserReport(r),/代码检查已完成/);
  assert.deepEqual(r,before);
});

test('old strategies cannot forge not-requested and retain exact legacy count shape',()=>{
  for(const execution of [undefined,{executionStrategy:'staged'},{executionStrategy:'whole-scope'}]){
    const r=report();r.execution=execution;
    const data=reportSummaryData(r);
    assert.equal(verificationPresentation(r.findings[0],r),'incomplete');assert.equal(data.complete,false);
    assert.equal(data.unverifiedCandidates,1);assert.equal(data.verification.incomplete,1);
    assert.equal(Object.hasOwn(data,'singlePass'),false);
    assert.deepEqual(data.counts,{total:1,introduced:0,unresolved:1,refuted:0,preexisting:0,current:0});
  }
});

test('strategy alone or forged per-finding markers never substitute host assurance',()=>{
  for(const mutate of [r=>delete r.executionAssurance,r=>r.executionAssurance.protocolValid=false,r=>r.executionAssurance.independentVerification=true,r=>r.executionAssurance.mode='staged',r=>r.executionAssurance='single-model',r=>delete r.findings[0].validation,r=>r.findings[0].validation.identity='unchecked',r=>r.findings[0].validation.anchor='validated',r=>r.findings[0].verification.method='other',r=>r.findings[0].verification.causality='verified']){
    const r=report();mutate(r);assert.equal(reportSummaryData(r).complete,false);
    assert.equal(verificationPresentation(r.findings[0],r),'incomplete');
  }
});

test('anchor validation markers must match the host-approved anchor kind',()=>{
  for(const [kind,marker] of [['line','exact-snapshot'],['property','approved-property'],['file','approved-file-scope']]){
    const r=report();r.findings[0].anchor={kind};r.findings[0].validation.anchor=marker;
    assert.equal(verificationPresentation(r.findings[0],r),'single-model');
    r.findings[0].validation.anchor='other';assert.equal(verificationPresentation(r.findings[0],r),'incomplete');
  }
});

test('partial failures cancellation and actual incomplete stages remain truthful',()=>{
  for(const status of ['partial','failed','cancelled','interrupted','running']){
    const r=report();r.status=status;assert.equal(reportSummaryData(r).complete,false);
    assert.doesNotMatch(renderUserReport(r),/所选范围处理完成|代码检查已完成/);assert.match(summary(r),/尚未查完/);
    assert.match(renderUserReport(r), status === 'failed' ? /审核失败/ : status === 'cancelled' ? /审核已取消/ : status === 'interrupted' ? /审核已中断/ : /审核尚未完成/);
  }
  for(const mutate of [r=>r.files[0].status='failed',r=>r.files[0].primaryStatus='failed',r=>r.files[0].verificationStatus='failed',r=>r.files[0].stageFailures=[{}],r=>r.files[0].retrievalLimited=true,r=>r.stageContinuation={pending:1},r=>r.interactions=[{status:'pending'}],r=>r.coverage={total:2,completed:1,pending:1}]){
    const r=report();mutate(r);assert.equal(reportSummaryData(r).complete,false);
  }
});

test('all candidates retained; summaries expand five with explicit remaining count',()=>{
  const r=report(8), before=structuredClone(r), head=summary(r), user=renderUserReport(r), technical=findingsMarkdown(r).join(String.fromCharCode(10));
  assert.match(head,/完整候选总数 8/);assert.match(head,/其余 3 项候选未在摘要展开/);
  assert.equal((head.match(/^- 候选 [0-9]+ ·/gm)||[]).length,5);
  assert.doesNotMatch(user,/候选总数|模型调用|已记录.*限制|保证等级|完成度统计/);assert.match(user,/另有 3 项候选未在简报展开/);
  assert.deepEqual(user.match(/^## .+$/gm),['## 1. 改动内容','## 2. 报告']);
  assert.equal((user.match(/^### 候选 /gm)||[]).length,5);
  assert.match(user,/输入失效时/);assert.match(user,/请求状态可能丢失/);assert.match(user,/仅在校验后更新状态/);
  assert.match(technical,/### 单模型候选（未独立复核）/);
  assert.equal((technical.match(/^#### [0-9]+[.]/gm)||[]).length,8);
  assert.match(head,/已记录限制：1 项/);assert.doesNotMatch(user,/已记录 1 条限制/);
  assert.deepEqual(r,before);
});

test('single-pass short summaries escape model text and never expose source receipts',()=>{
  const r=report(), payload='<script>bad</script>'+String.fromCharCode(10)+'# [link](javascript:bad) '+String.fromCharCode(8238);
  for(const key of ['title','trigger','impact','suggestion'])r.findings[0][key]=payload;
  r.findings[0].verification.evidence=[{text:'PRIVATE_RECEIPT'}];
  for(const text of [summary(r),renderUserReport(r)]){
    assert.doesNotMatch(text,/<script>|^# [link]|PRIVATE_SOURCE|PRIVATE_SNIPPET|PRIVATE_RECEIPT|PRIVATE_LIMITATION|\u202e/m);
    assert.match(text,/&lt;script&gt;/);assert.ok(text.includes(String.fromCharCode(92)+'[link'));
  }
});
