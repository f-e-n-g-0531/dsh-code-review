import test from 'node:test';
import assert from 'node:assert/strict';
import { reportSummaryMarkdown } from '../src/report-summary.mjs';
import { validateCandidateVerification } from '../src/candidate-verification.mjs';

const ref = side => ({snapshotId:'snapshot',sourceId:side,hash:'a'.repeat(64),start:1,count:1,text:side+'\n'});
function candidate({verdict='supported',classification='introduced'}={}) {
  const evidence=[ref('old'),ref('new')];
  const [verification]=validateCandidateVerification({verdicts:[{candidateId:'c1',verdict,reason:'checked',evidence,regression:{classification,reason:'same trigger compared',oldEvidence:[0],newEvidence:[1]}}]},['c1'],request=>evidence.find(item=>item.sourceId===request.id),value=>value,{catalog:[{id:'old',fileId:'f',side:'old'},{id:'new',fileId:'f',side:'new'}],fileIds:{c1:'f'}});
  return {fileId:'f',path:'file.ts',title:'candidate',verification:{status:'completed',...verification}};
}
const render = report => reportSummaryMarkdown(report).join('\n');
const classification = report => reportSummaryMarkdown(report).find(line=>line.startsWith('- 已确认新增'));

test('confirmed introduced requires an actual independently validated comparison result',()=>{
  const finding=candidate(),report={status:'completed',files:[{fileId:'f',path:'file.ts',status:'completed'}],findings:[finding]};
  assert.match(classification(report),/已校验）：1；未决／证据不足：0/);
  assert.match(render(report),/因果解释仍未经验证/);
  assert.match(render(report),/不是事实或因果证明/);
  assert.equal(finding.verification.causality,'unverified');
});

test('supported alone missing or incomplete verification and uncertain are never introduced',()=>{
  const cases=[{}, {verification:{status:'completed',verdict:'supported'}}, candidate(),candidate(),candidate(),candidate({verdict:'uncertain'}),candidate({classification:'uncertain'})];
  cases[2].verification.status='pending';cases[3].verification.status='incomplete';delete cases[4].verification.regression;
  const line=classification({findings:cases});
  assert.match(line,/已校验）：0；未决／证据不足：7/);
});

test('host markers plus valid nonempty nonoverlapping side references are required',()=>{
  const changes=[f=>delete f.verification.regression.status,f=>f.verification.regression.oldEvidence=[],f=>f.verification.regression.newEvidence=[9],f=>f.verification.regression.newEvidence=[0],f=>f.verification.regression.oldEvidence=[0,0],f=>f.verification.evidence[0].status='unchecked',f=>f.verification.evidence[1].sourceId='old'];
  const findings=changes.map(change=>{const f=candidate();change(f);return f;});
  assert.match(classification({findings}),/已校验）：0；未决／证据不足：7/);
});

test('refuted and supported preexisting are separate disjoint classifications',()=>{
  const findings=[candidate(),candidate({verdict:'refuted'}),candidate({classification:'preexisting'}),candidate({verdict:'uncertain'}),{}];
  assert.match(classification({findings}),/已校验）：1；未决／证据不足：2；已反驳候选：1；既有问题.*）：1/);
  const partialRefuted=candidate({verdict:'refuted'});partialRefuted.verification.status='pending';
  assert.match(classification({findings:[partialRefuted]}),/未决／证据不足：1；已反驳候选：0/);
});

test('project or current-source-only support never becomes a confirmed introduced regression',()=>{
  for(const project of [{reviewMode:'project'},{projectScope:{}}]){
    const text=render({...project,findings:[candidate()]});assert.match(text,/已校验）：0；未决／证据不足：0/);assert.match(text,/当前源码复核支持：1/);
  }
  const finding=candidate();finding.attribution={status:'not-applicable',causality:'current-source-only'};
  assert.match(render({findings:[finding]}),/当前源码模式不评估历史新增归因/);
});

test('partial cancelled failed and empty selection never imply approval',()=>{
  for(const status of ['partial','cancelled','failed','interrupted']){
    const text=render({status,files:[],findings:[]});assert.match(text,/不支持“审核通过”/);assert.doesNotMatch(text,/已审范围内没有候选问题记录/);
  }
  const text=render({status:'completed',findings:[],files:[{status:'completed'}]});
  assert.match(text,/没有候选问题记录；不证明不存在缺陷/);
  assert.match(text,/完成状态只表示处理进度/);
});

test('completed main files still expose failed synthesis verification windows and interaction gaps',()=>{
  const files=[{fileId:'a',path:'synthesis',status:'completed',stageFailures:[{phase:'window-synthesis'}]},{fileId:'b',path:'verification',status:'completed'},{path:'windows',status:'completed',windowCoverage:{pending:['w1']}},{path:'reader',status:'completed',retrievalLimited:true},{path:'excluded',status:'excluded'}];
  const text=render({status:'partial',files,findings:[{fileId:'b',verification:{status:'incomplete'}}],interactions:[{status:'pending'},{status:'completed'}],limitations:[{text:'PRIVATE_SOURCE'}]});
  assert.match(text,/关键未完成范围：synthesis、verification、windows、reader/);
  assert.doesNotMatch(text,/关键未完成范围：.*excluded/);
  assert.match(text,/跨文件综合未完成：1 项/);assert.match(text,/已记录限制：1 项/);assert.doesNotMatch(text,/PRIVATE_SOURCE/);
});

test('coverage totals stay explicit project counts and file paths are bounded escaped data',()=>{
  const files=Array.from({length:8},(_,i)=>({path:i===0?'[click](javascript:evil)\n<script>':'path'+i,status:'pending'}));
  const text=render({status:'partial',coverage:{total:12,completed:3,pending:8,excluded:1},files});
  assert.match(text,/范围：12 个文件；完成 3，排除 1/);assert.match(text,/另有 3 个文件/);assert.doesNotMatch(text,/<script>|\n<script>|path5/);assert.ok(text.includes('\\[click\\]\\(javascript:evil\\)'));
});

test('outdated and prior run findings preserve provenance rather than claiming fresh current evidence',()=>{
  const finding=candidate();finding.reused=true;finding.priorRun={jobId:'PRIVATE_JOB'};
  const text=render({status:'completed',outdated:true,findings:[finding]});
  assert.match(text,/不表示本轮重新取证/);assert.match(text,/仅对应原批准快照/);assert.doesNotMatch(text,/PRIVATE_JOB/);
});

test('summary is deterministic nonmutating and does not echo raw finding diagnostic or source text',()=>{
  const finding=candidate();finding.title='PRIVATE_TITLE';finding.evidence='PRIVATE_SOURCE';
  const report={status:'completed',findings:[finding],files:[],diagnostics:{error:'PRIVATE_ERROR'},regressionCoverage:{introduced:99}};
  const original=structuredClone(report),first=reportSummaryMarkdown(report);
  assert.deepEqual(report,original);assert.deepEqual(first,reportSummaryMarkdown(report));assert.doesNotMatch(first.join(''),/PRIVATE|99/);
  assert.match(classification(report),/已校验）：1；未决／证据不足：0/);
});

test('empty or excluded-only completed reports do not imply any code was audited',()=>{
  const empty=render({status:'completed',files:[],findings:[]});assert.match(empty,/未选择文件，没有执行代码审核/);assert.doesNotMatch(empty,/已审范围内没有候选问题记录/);
  const excluded=render({status:'completed',files:[{status:'excluded'}],findings:[]});assert.doesNotMatch(excluded,/已审范围内没有候选问题记录/);
});
