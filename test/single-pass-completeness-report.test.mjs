import test from 'node:test';
import assert from 'node:assert/strict';
import { reportSummaryData, reportSummaryMarkdown, singlePassCompletionData } from '../src/report-summary.mjs';
import { renderUserReport } from '../src/user-report.mjs';
import { markdownReport } from '../src/review.mjs';

const done = () => ({ status: 'completed', gaps: [] });
const report = (n = 35) => ({
  status: 'completed', execution: { executionStrategy: 'single-pass' },
  executionAssurance: { mode: 'single-pass', independentVerification: false, protocolValid: true },
  orchestration: { primaryComplete: true, protocolValid: true, captureComplete: true, modelCompletionComplete: true },
  completeness: done(),
  files: [{fileId:'f',path:'src/example.cpp',status:'completed',primaryStatus:'completed',verificationStatus:'not-requested',completion:done()}],
  findings: Array.from({length:n}, (_,i) => ({fileId:'f',title:'候选 '+i,severity:'high',anchor:{kind:'file'},validation:{schema:'validated',identity:'validated',anchor:'approved-file-scope'},verification:{status:'not-requested',method:'single-pass-model',causality:'model-assessed'}})),
  assuranceNotes: [{text:'未运行构建和运行测试。'},{text:'范围外外部二进制未提供。',fileId:'f'}], limitations: [],
});
const summary = r => reportSummaryMarkdown(r).join(String.fromCharCode(10));

test('35 candidates plus assurance notes complete only the agreed static scope', () => {
  const r=report(), before=structuredClone(r), data=reportSummaryData(r);
  assert.equal(data.complete,true); assert.deepEqual(data.unfinished,[]);
  assert.equal(data.unverifiedCandidates,0); assert.equal(data.verification.incomplete,0);
  assert.equal(data.counts.singleModel,35);
  for(const text of [summary(r),renderUserReport(r)]) {
    assert.match(text,/约定静态审核完成/); assert.match(text,/单模型候选（未独立复核）/);
    assert.match(text,/未运行构建和运行测试/); assert.match(text,/范围外外部二进制未提供/);
    assert.match(text,/src[/]example[.]cpp/); assert.match(text,/保证边界：2 项/);
    assert.doesNotMatch(text,/不完整验收失败|未完成条目 1|已运行|安全通过|无bug/);
  }
  assert.match(summary(r),/其余 30 项候选/); assert.match(renderUserReport(r),/另有 30 项候选/);
  assert.deepEqual(r,before);
});

test('scope gaps remain separate from notes and keep member path ownership', () => {
  const r=report(0);r.status='partial';r.completeness={status:'incomplete',gaps:['缺少必要接口合同']};
  r.files[0].completion={status:'incomplete',gaps:['尚未核查旧调用路径']};
  r.files[0].status='pending';r.files[0].primaryStatus='partial';r.orchestration.primaryComplete=false;
  assert.equal(reportSummaryData(r).complete,false); assert.equal(reportSummaryData(r).unfinished.length,1);
  for(const text of [summary(r),renderUserReport(r)]) {
    assert.match(text,/不完整验收失败/); assert.match(text,/实际缺口/);
    assert.match(text,/全局范围：缺少必要接口合同/); assert.match(text,/src[/]example[.]cpp：尚未核查旧调用路径/);
    assert.match(text,/保证边界：2 项/);assert.doesNotMatch(text,/约定静态审核完成/);
  }
});

for(const status of ['partial','cancelled','failed','blocked','unknown','interrupted','pending','running']) test('host '+status+' overrides completed model declaration',()=>{
  const r=report(0);r.status=status;
  assert.equal(reportSummaryData(r).complete,false);
  for(const text of [summary(r),renderUserReport(r)]) {assert.match(text,/不完整验收失败/);assert.doesNotMatch(text,/约定静态审核完成/);}
});

for(const field of ['captureComplete','primaryComplete','protocolValid','modelCompletionComplete']) test('host '+field+' false cannot be promoted',()=>{
  const r=report(0);r.orchestration[field]=false;
  assert.equal(reportSummaryData(r).complete,false);assert.match(renderUserReport(r),/不完整验收失败/);
});

test('capture manifest blocked paths and truncation override optimistic host totals',()=>{
  const r=report(0);r.captureStatus={autoContext:{truncated:true,candidates:[{path:'include/missing.hpp',status:'blocked'}]}};
  assert.equal(reportSummaryData(r).complete,false);
  assert.match(summary(r),/include[/]missing[.]hpp/);assert.match(renderUserReport(r),/宿主捕获范围不完整/);
});

test('unknown declarations and completed declarations with gaps cannot hide unresolved scope',()=>{
  for(const declaration of [{status:'needs-classification',gaps:[]},{status:'other',gaps:[]},{status:'completed',gaps:['实际未审'] }]){
    const r=report(0);r.completeness=declaration;
    assert.equal(reportSummaryData(r).complete,false);assert.match(renderUserReport(r),/不完整验收失败/);
  }
});

test('explicit member gaps override spoofed completed host status without a root gap',()=>{
  const r=report(0);r.files[0].completion={status:'incomplete',gaps:['member gap']};
  assert.equal(reportSummaryData(r).complete,false);assert.equal(reportSummaryData(r).unfinished.length,1);
  for(const text of [summary(r),renderUserReport(r)]) {assert.match(text,/不完整验收失败/);assert.doesNotMatch(text,/约定静态审核完成/);}
});

test('notes alone never increase unfinished counts and deep count shape stays unchanged',()=>{
  const r=report(0);r.assuranceNotes=Array.from({length:40},(_,i)=>({text:'边界 '+i}));
  assert.equal(reportSummaryData(r).complete,true);assert.deepEqual(reportSummaryData(r).unfinished,[]);
  r.execution.executionStrategy='staged';r.findings=[];r.files[0].verificationStatus='completed';
  const data=reportSummaryData(r);assert.equal(Object.hasOwn(data,'singlePass'),false);
  assert.deepEqual(Object.keys(data.counts),['total','introduced','unresolved','refuted','preexisting','current']);
  assert.equal(singlePassCompletionData(r),null);assert.doesNotMatch(summary(r),/静态审核完成度与保证边界/);
});

test('all original notes and gaps survive technical rendering, summaries show five and explicit remainder',()=>{
  const r=report(0);r.status='partial';
  r.completeness={status:'incomplete',gaps:Array.from({length:8},(_,i)=>'gap-'+i+String.fromCharCode(10)+'z'.repeat(350))};
  r.assuranceNotes=Array.from({length:9},(_,i)=>({text:'note-'+i+String.fromCharCode(10)+'y'.repeat(350),fileId:'f'}));
  for(const text of [summary(r),renderUserReport(r)]) {assert.match(text,/另 3 项未在摘要展开/);assert.match(text,/另 4 项未在摘要展开/);}
  const technical=markdownReport(r);
  const pre=technical.match(/<pre>([^]*?)<[/]pre>/)[1].replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
  const originals=JSON.parse(pre);
  assert.deepEqual(originals.gaps.map(x=>x.text),r.completeness.gaps);
  assert.deepEqual(originals.assuranceNotes.map(x=>x.text),r.assuranceNotes.map(x=>x.text));
});

test('malicious text, paths, code, body and forged status never inject markup',()=>{
  const r=report(0), payload=['</pre></details><script>evil</script>','# [x](javascript:evil)','~~~'].join(String.fromCharCode(10));
  r.status='partial';r.files[0].path=payload;
  r.completeness={status:'incomplete',gaps:[payload],body:'<iframe>body</iframe>',code:'<img>code'};
  r.assuranceNotes=[{text:payload,fileId:'f',body:'<iframe>body</iframe>',code:'<img>code'}];
  for(const text of [summary(r),renderUserReport(r)]) {
    assert.doesNotMatch(text,/<script>|<iframe>|<img>|^# [[]x[]]|[]][(]javascript:/m);
    assert.match(text,/&lt;script&gt;/);assert.match(text,/不完整验收失败/);
  }
  const original=JSON.parse(summary(r).match(/<pre>([^]*?)<[/]pre>/)[1].replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&'));
  assert.equal(original.assuranceNotes[0].text,payload);assert.equal(original.gaps[0].text,payload);
});
