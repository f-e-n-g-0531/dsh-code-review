import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewService } from '../src/service.mjs';

const snapshot = (count = 2, body = 'new();\n') => ({
  id: 'whole-service-fixed', vcs: 'git', root: '/repo', context: [],
  files: Array.from({ length: count }, (_, i) => ({
    id: 'f' + i, path: 'src/file' + String(i).padStart(3, '0') + '.js',
    eligibility: 'reviewable', properties: [], left: { text: 'old();\n' }, right: { text: body },
  })),
});
const execution = () => ({
  agent: { session: { header: { cwd: '/repo' } }, options: { provider: 'mock', model: 'never-network' } },
  signal: new AbortController().signal,
});
function fixture({ source = snapshot(), capture, authorize, ...options } = {}) {
  const calls = [], events = [];
  const llm = { async *stream(request) {
    events.push('model');
    const input = JSON.parse(request.messages[0].content[0].text);
    calls.push(input);
    assert.equal(input.sourceMode, 'group-primary');
    assert.deepEqual(request.tools, []);
    yield { type: 'text-delta', text: JSON.stringify({ reviews: input.reviews.map(({ fileId }) => ({ fileId, findings: [], limitations: [] })), limitations: [] }) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  let captures = 0, approvals = 0;
  const service = createReviewService(llm, {
    executionStrategy: 'whole-scope', allowModelSending: true,
    capture: async (...args) => {
      captures++; events.push('capture');
      return structuredClone(capture ? await capture(captures, ...args) : source);
    },
    authorize: async args => {
      approvals++; events.push('authorize');
      assert.equal(calls.length, 0);
      assert.equal(args.snapshot.id, source.id);
      assert.deepEqual(args.route, { provider: 'mock', model: 'never-network' });
      return authorize ? await authorize(args) : true;
    },
    ...options,
  });
  return { service, calls, events, get captures() { return captures; }, get approvals() { return approvals; } };
}

for (const [label, source, expectedBatches] of [
  ['74 tiny files', snapshot(74), 1],
  ['byte-split complete files', snapshot(2, 'new();\n' + 'x'.repeat(45000)), 2],
]) test('whole-scope service preview batch IDs match execution: ' + label, async t => {
  const childDeliveries=[];
  const hostChildren=expectedBatches>1?{capability:()=>true,prepare:async()=>{},create:async()=>({invoke:async request=>{const p=JSON.parse(request.input);childDeliveries.push(...p.reviews);return{reviews:p.reviews.map(row=>({fileId:row.fileId,findings:[],limitations:[]})),limitations:[]};},dispose:async()=>{}})}:undefined;
  const f = fixture({ source, ...(hostChildren?{hostChildren}:{}), enableRiskPlanning: true, skipSmallRiskPlans: false, enableBusinessGrouping: true, enableGroupPrimary: true, enableGroupInteractions: true, enableMigrationContracts: true, enableMigrationRegression: true, enableStageContinuation: true });
  t.after(() => f.service.dispose());
  const exec = execution(), checkpoints = [];
  exec.reviewCheckpoint = async event => { checkpoints.push(event); };
  const preview = await f.service.preview({}, exec);
  assert.equal(f.calls.length, 0);
  assert.equal(f.approvals, 0);
  assert.equal(preview.execution.executionStrategy, 'whole-scope');
  assert.equal(preview.plan.executionStrategy, 'whole-scope');
  assert.equal(preview.plan.minimumCalls, expectedBatches);
  assert.equal(preview.plan.primaryGroups.length, expectedBatches);
  assert.deepEqual(preview.plan.interactions, []);
  assert.equal(preview.plan.businessGrouping, undefined);
  assert.equal(preview.plan.migrationContracts, undefined);
  assert.equal(preview.plan.continuation, undefined);
  assert.ok(preview.plan.items.every(item => item.primaryMethod === 'whole-scope' && item.riskPlanning === undefined));
  assert.ok(!JSON.stringify(preview).includes(source.files[0].right.text));
  assert.match(preview.notice, /整体优先主审/);
  assert.doesNotMatch(preview.notice, /执行按plan阈值|独立文件审查链|动态综合数执行前未知|后续轮不带首轮风险计划|已验收主审生成可精确续用|组主审可附带交互结果/);
  assert.doesNotMatch(preview.plan.notice, /动态综合|独立规划|专门交互证据阶段仍独立执行/);
  const { report } = await f.service.execute({ previewId: preview.previewId, confirmed: true }, exec);
  assert.equal(f.calls.length, hostChildren ? 0 : expectedBatches);
  assert.equal(report.modelCalls, expectedBatches);
  assert.equal(f.captures, 3);
  assert.equal(f.approvals, 1);
  assert.deepEqual(f.events, ['capture', 'capture', 'authorize', ...Array(hostChildren ? 0 : expectedBatches).fill('model'), 'capture']);
  assert.equal(report.outdated, false);
  assert.equal(report.coverage.completed, source.files.length);
  assert.equal(report.orchestration.strategy, 'whole-scope');
  assert.deepEqual(report.orchestration.batches.map(({ id, fileIds }) => ({ groupId: id, fileIds })), preview.plan.primaryGroups.map(({ groupId, fileIds }) => ({ groupId, fileIds })));
  assert.ok(report.orchestration.batches.every(batch => batch.status === 'completed'));
  assert.deepEqual(report.interactions, []);
  assert.ok(checkpoints.some(event => event.stage === 'source-freshness'));
  assert.ok(checkpoints.filter(event => event.phase).every(event => event.phase === 'group-primary'));
  const delivered = hostChildren ? childDeliveries : f.calls.flatMap(input => input.reviews);
  assert.deepEqual(delivered.map(row => row.fileId).sort(), source.files.map(file => file.id).sort());
  for (const row of delivered) {
    const original = source.files.find(file => file.id === row.fileId);
    assert.equal(row.file.left.text, original.left.text);
    assert.equal(row.file.right.text, original.right.text);
  }
  assert.equal(report.status, expectedBatches === 1 ? 'completed' : 'partial');
});

for (const mode of ['disabled', 'unconfirmed', 'denied']) test('whole-scope service prevents model sending when ' + mode, async t => {
  const f = fixture({ allowModelSending: mode !== 'disabled', authorize: async () => false });
  t.after(() => f.service.dispose());
  const exec = execution(), preview = await f.service.preview({}, exec);
  const error = mode === 'disabled' ? /Model sending is disabled/ : mode === 'unconfirmed' ? /Confirmed preview is required/ : /approval denied or unavailable/;
  await assert.rejects(f.service.execute({ previewId: preview.previewId, confirmed: mode !== 'unconfirmed' }, exec), error);
  assert.equal(f.calls.length, 0);
  assert.equal(f.approvals, mode === 'denied' ? 1 : 0);
  assert.equal(f.captures, mode === 'denied' ? 2 : 1);
});

test('whole-scope rejects changed source before authorization or model execution', async t => {
  const source = snapshot();
  const f = fixture({ source, capture: n => ({ ...source, id: n === 1 ? source.id : 'changed-before' }) });
  t.after(() => f.service.dispose());
  const exec = execution(), preview = await f.service.preview({}, exec);
  await assert.rejects(f.service.execute({ previewId: preview.previewId, confirmed: true }, exec), /Files changed since preview/);
  assert.equal(f.captures, 2);
  assert.equal(f.approvals, 0);
  assert.equal(f.calls.length, 0);
});

for (const mode of ['changed', 'unavailable']) test('whole-scope retains original report but marks source ' + mode + ' after execution', async t => {
  const source = snapshot();
  const f = fixture({ source, capture: n => {
    if (n < 3) return source;
    if (mode === 'unavailable') throw new Error('mock capture unavailable');
    return { ...source, id: 'changed-after' };
  } });
  t.after(() => f.service.dispose());
  const exec = execution(), preview = await f.service.preview({}, exec);
  const { report, markdown } = await f.service.execute({ previewId: preview.previewId, confirmed: true }, exec);
  assert.equal(f.captures, 3);
  assert.equal(f.calls.length, 1);
  assert.equal(report.snapshotId, source.id);
  assert.equal(report.status, 'completed');
  assert.equal(report.outdated, true);
  assert.match(markdown, /报告已过期，仅对应原快照/);
});

for (const [label, options, args] of [
  ['explicit multiple rounds', {}, { reviewRounds: 2 }],
  ['configured multiple rounds', { reviewRounds: 2 }, {}],
  ['durable resume', {}, { resumeFromJobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }],
]) test('whole-scope refuses ' + label + ' before capture', async t => {
  const f = fixture(options);
  t.after(() => f.service.dispose());
  const exec = execution();
  exec.resolveReviewResume = async () => { assert.fail('whole-scope must not resolve old staged state'); };
  await assert.rejects(f.service.preview(args, exec), /Whole-scope requires fresh single-round changes review/);
  assert.equal(f.captures, 0);
  assert.equal(f.approvals, 0);
  assert.equal(f.calls.length, 0);
});
test('whole-scope explicitly refuses project mode instead of silently using staged execution', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await assert.rejects(f.service.preview({ reviewMode: 'project' }, execution()), /Whole-scope currently supports fresh single-round changes only/);
  assert.equal(f.calls.length, 0);
});
test('explicit capacity is previewed and used by the same complete-file batch planner during execution', async t => {
  const f = fixture({ source: snapshot(2, 'x'.repeat(45000)), maxInputBytes: 262144 }); t.after(() => f.service.dispose());
  const e = execution(), p = await f.service.preview({}, e);
  assert.equal(p.execution.maxInputBytes, 262144); assert.equal(p.plan.maxInputBytes, 262144); assert.equal(p.plan.primaryGroups.length, 1);
  const { report } = await f.service.execute({ previewId: p.previewId, confirmed: true }, e);
  assert.equal(f.calls.length, 1); assert.equal(report.orchestration.batches.length, 1); assert.equal(report.status, 'completed');
});
test('invalid configured input capacities are refused before capture or model sending', async () => {
  for (const maxInputBytes of [0, -1, 1.5, 4194305, '262144']) {
    const f = fixture({ maxInputBytes });
    await assert.rejects(f.service.preview({}, execution()), /Invalid configured input capacity/);
    assert.equal(f.captures, 0); assert.equal(f.calls.length, 0); f.service.dispose();
  }
});
test('host child policy is fixed in preview and factory executes only capacity-split groups',async t=>{let prepared=0,children=0,reserved=0;const hostChildren={prepare:async()=>{prepared++;},capability:()=>true,create:async args=>{assert.ok(args.parent);assert.deepEqual(args.route,{provider:'mock',model:'never-network'});return{transport:'host-subagent',childId:'fixture-'+children++,runPrimary:async({request,reserveModelCall})=>{reserveModelCall();reserved++;return{reviews:JSON.parse(request.input).reviews.map(r=>({fileId:r.fileId,findings:[],limitations:[]})),limitations:[]};},dispose:async()=>{}};}};const f=fixture({source:snapshot(3,'x'.repeat(45000)),hostChildren,wholeScopeConcurrency:2});t.after(()=>f.service.dispose());const e=execution(),p=await f.service.preview({},e);assert.equal(p.execution.batchExecution,'host-subagents');assert.equal(p.execution.batchConcurrency,2);assert.equal(prepared,1);const {report}=await f.service.execute({previewId:p.previewId,confirmed:true},e);assert.equal(children,3);assert.equal(reserved,3);assert.equal(report.modelCalls,3);assert.equal(f.calls.length,0);assert.equal(report.orchestration.batchExecution,'host-subagents');});
test('host child capability loss after preview refuses execution before authorization',async t=>{let enabled=true;const f=fixture({source:snapshot(2,'x'.repeat(45000)),hostChildren:{prepare:async()=>{},capability:()=>enabled}});t.after(()=>f.service.dispose());const e=execution(),p=await f.service.preview({},e);enabled=false;await assert.rejects(f.service.execute({previewId:p.previewId,confirmed:true},e),/capability changed/);assert.equal(f.approvals,0);assert.equal(f.calls.length,0);});
