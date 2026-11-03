import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot, REVIEW_INSTRUCTIONS } from '../src/review.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { prepareGroupPrimary, validateGroupPrimary } from '../src/group-primary.mjs';
import { createDshModel } from '../src/dsh-model.mjs';
import { buildResumeState } from '../src/review-resume.mjs';
import { buildCoveragePlan } from '../src/coverage-plan.mjs';
const snapshot=()=>({id:'group-s',vcs:'git',files:['a','b'].map(id=>({id,path:id+'.js',eligibility:'reviewable',properties:[],left:{text:'guard();\n'},right:{text:'unsafe();\n'}})),context:[]});
const opts={enableRetrieval:true,enableBusinessGrouping:true,enableGroupPrimary:true,enableRiskPlanning:true,skipSmallRiskPlans:true,enableGrouping:false,changesConcurrency:2};
const empty=p=>({reviews:p.reviews.map(row=>({fileId:row.fileId,findings:[],limitations:[],risks:[]})),limitations:[]});
test('two exact full-body members share one generation and retain original coverage',async()=>{let calls=0;const r=await reviewSnapshot(snapshot(),request=>{calls++;const p=JSON.parse(request.input);if(request.reviewPhase==='file-interaction')return{findings:[],limitations:[]};assert.equal(p.sourceMode,'group-primary');assert.equal(p.reviews.length,2);assert.equal(p.reviews[1].file.right.text,'unsafe();\n');return empty(p);},opts);assert.equal(calls,2);assert.equal(r.modelCalls,2);assert.equal(r.coverage.completed,2);assert.ok(r.files.every(f=>f.primaryMethod==='group-primary'));assert.equal(r.primaryGroups.length,1);assert.equal(r.resume.reusedFiles,0);});
test('group schema cannot silently omit duplicate or unknown members and cannot bypass interaction checks',()=>{const s=snapshot(),scope=createRetrievalScope(s),g={id:'g',fileIds:['a','b']};const p=prepareGroupPrimary(s,g,{instructions:REVIEW_INSTRUCTIONS,scope,maxInputBytes:98304});assert.ok(p);const validate=row=>({findings:row.findings,limitations:row.limitations});for(const reviews of [[{fileId:'a',findings:[],limitations:[]}],[{fileId:'a',findings:[],limitations:[]},{fileId:'a',findings:[],limitations:[]}],[{fileId:'a',findings:[],limitations:[]},{fileId:'x',findings:[],limitations:[]}],[{fileId:'a',findings:[{interaction:{editRefs:[]}}],limitations:[]},{fileId:'b',findings:[],limitations:[]}]])assert.throws(()=>validateGroupPrimary({reviews,limitations:[]},p,s,validate));});
test('oversized and inexact group candidates fall back before model send without dropping files',async()=>{const s=snapshot();s.files[1].right.text='unsafe();\n'.repeat(20000);const scope=createRetrievalScope(s);assert.equal(prepareGroupPrimary(s,{id:'g',fileIds:['a','b']},{instructions:REVIEW_INSTRUCTIONS,scope,maxInputBytes:98304}),null);const r=await reviewSnapshot(s,()=>({findings:[],limitations:[]}),{...opts,maxInputBytes:98304});assert.equal(r.primaryGroups.length,0);assert.equal(r.files.length,2);assert.equal(r.coverage.completed+r.coverage.failed+r.coverage.blocked+r.coverage.pending,2);});
test('already generated group members survive an exhausted call budget with unfinished interaction explicit',async()=>{let calls=0;const r=await reviewSnapshot(snapshot(),request=>{calls++;return empty(JSON.parse(request.input));},{...opts,maxCalls:1});assert.equal(calls,1);assert.equal(r.modelCalls,1);assert.equal(r.coverage.completed,2);assert.equal(r.status,'partial');assert.ok(r.interactions.some(i=>i.status!=='completed'));});
test('native group transport recovery and private artifacts are counted once across fanout and resume adds no calls',async()=>{const s=snapshot();let calls=0;const llm={stream:async function*(request){calls++;assert.ok(request.tools?.length);const p=JSON.parse(request.messages[0].content[0].text),value=p.sourceMode==='group-primary'?empty(p):{findings:[],limitations:[]};yield{type:'block-end',index:0,block:{type:'tool-call',id:'call'+calls,name:'submit_review_result',arguments:JSON.stringify(value)}};yield{type:'finish',reason:{kind:'tool-calls'}};}};const artifacts=[];const model=createDshModel(llm,{provider:'offline',model:'mock'},{useNativeTools:true});const r=await reviewSnapshot(s,model,{...opts,nativeOutputTools:true,onModelArtifact:async artifact=>{artifacts.push(artifact);return{recorded:true,omitted:false};}});assert.equal(calls,2);assert.deepEqual(r.diagnostics.transportRecoveries,[{kind:'native-tool',calls:2}]);assert.equal(r.diagnostics.artifacts.retained,2);assert.equal(artifacts[0].phase,'group-primary');const state=buildResumeState(s,{controlled:true},r);assert.equal(state.completed.length,2);const next=await reviewSnapshot(s,()=>{throw new Error('mustnotcall');},{...opts,resumeState:state});assert.equal(next.modelCalls,0);assert.equal(next.coverage.completed,2);assert.ok(next.interactions.every(i=>i.status==='completed'));});
test('group generation failure never reruns members as hidden extra review calls',async()=>{let calls=0;const r=await reviewSnapshot(snapshot(),()=>{calls++;throw new Error('synthetic');},opts);assert.equal(calls,1);assert.equal(r.coverage.failed,2);assert.equal(r.modelCalls,1);});
test('preview counts the same local group as one primary generation',()=>{const s=snapshot(),scope=createRetrievalScope(s);const plan=buildCoveragePlan(s,{...opts,instructions:REVIEW_INSTRUCTIONS,scope,maxInputBytes:98304,reviewRounds:1});assert.equal(plan.primaryGroups.length,1);assert.equal(plan.items.reduce((n,i)=>n+i.minimumCalls,0),1);});
test('second member finding keeps exact identity and original anchor then independently verifies',async()=>{const s=snapshot();let phases=[];const finding={fileId:'b',severity:'high',title:'controlled',evidence:'controlled',trigger:'controlled',impact:'controlled',suggestion:'controlled',anchor:{kind:'line',side:'new',start:1,end:1,snippet:'unsafe();'},attribution:{editIds:['e1'],properties:[],beforeBehavior:'guard',afterBehavior:'unsafe',reason:'changed'}};const r=await reviewSnapshot(s,request=>{phases.push(request.reviewPhase);const p=JSON.parse(request.input);if(request.reviewPhase==='file-interaction')return{findings:[],limitations:[]};if(request.reviewPhase==='verification'){const read=p.retrieved.find(row=>row.result.receiptId);assert.ok(read);return{verdicts:p.candidates.map(c=>({candidateId:c.candidateId,verdict:'refuted',reason:'controlled',evidence:[{receiptId:read.result.receiptId}]}))};}const result=empty(p);result.reviews[1].findings=[finding];return result;},{...opts,enableVerification:true});assert.equal(r.findings.length,1);assert.equal(r.findings[0].fileId,'b');assert.equal(r.findings[0].verification.verdict,'refuted');assert.deepEqual(phases,['group-primary','verification','file-interaction']);});

const continuationOptions = { ...opts, enableStageContinuation: true, enableRiskPlanning: false, readerBudgetPolicy: 'fixed', changesConcurrency: 1, maxRetrievalRounds: 10, timeoutMs: 5000 };
const retrievalBatch = turn => ({ requests: Array.from({ length: 8 }, (_, i) => ({ kind: 'find', query: 'group-fallback-' + turn + '-' + i, limit: 1 })) });

test('group local budget failure before acceptance falls back and really resumes after peer floors release', async () => {
  let turns = 0, groupTurns = 0; const calls = [], budgets = [];
  const report = await reviewSnapshot(snapshot(), request => {
    if (request.reviewPhase === 'group-primary') return retrievalBatch('group-' + groupTurns++);
    const p = JSON.parse(request.input); calls.push([p.file?.id, request.reviewPhase, request.callPurpose]);
    if (request.reviewPhase === 'file-interaction') return { findings: [], limitations: [] };
    if (p.file.id === 'a') {
      budgets.push(p.retrievalBudget.remainingCalls);
      assert.equal(p.retrievalFinalization, undefined);
      if (++turns <= 3) return retrievalBatch(turns);
    }
    return { findings: [], limitations: [] };
  }, continuationOptions);
  assert.equal(report.primaryGroups.length, 1);
  assert.equal(groupTurns, 3);
  assert.equal(report.primaryGroupFallbacks[0].reason, 'resumable-file-primary');
  assert.equal(calls.filter(([id, phase, purpose]) => id === 'a' && phase === 'primary' && purpose === 'primary-initial').length, 1);
  assert.equal(calls.filter(([id, phase]) => id === 'b' && phase === 'primary').length, 1);
  assert.ok(budgets.at(-1) > budgets[2], JSON.stringify({ budgets, continuation: report.stageContinuation, files: report.files }));
  // The dependent interaction also waits for the resumed primary.
  assert.equal(report.stageContinuation.completed, 2);
  assert.equal(report.stageContinuation.pending, 0);
  assert.equal(report.readerBudget.maxCalls, 50);
  assert.equal(report.readerBudget.calls, 40);
  assert.ok(report.files.every(file => file.status === 'completed'));
});

test('group fallback keeps round exhaustion final and does not mint an accepted generation', async () => {
  let turns = 0, starts = 0, groupTurns = 0;
  const report = await reviewSnapshot(snapshot(), request => {
    if (request.reviewPhase === 'group-primary') return retrievalBatch('group-' + groupTurns++);
    const p = JSON.parse(request.input);
    if (request.reviewPhase === 'file-interaction' || p.file.id !== 'a') return { findings: [], limitations: [] };
    if (request.callPurpose === 'primary-initial') starts++;
    if (p.retrievalFinalization) return { findings: [], limitations: ['round cap'] };
    return retrievalBatch(++turns);
  }, { ...continuationOptions, maxRetrievalRounds: 3 });
  assert.equal(starts, 1); assert.equal(turns, 3);
  assert.equal(report.readerBudget.calls, 40);
  assert.equal(report.status, 'partial');
  assert.equal(report.stageGenerations.some(stage => stage.fileId === 'a'), false);
});

test('fallback retains an accepted peer finding, verifies with fresh receipts, and saves no receipt authority', async () => {
  const s = snapshot(); let turns = 0, peerStarts = 0, verifications = 0, groupTurns = 0;
  const candidate = { fileId: 'b', severity: 'high', title: 'Guard removed', evidence: 'Unsafe operation', trigger: 'bad state', impact: 'failure', suggestion: 'restore guard', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'unsafe();' }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: 'guarded', afterBehavior: 'unguarded', reason: 'removed guard' } };
  const report = await reviewSnapshot(s, request => {
    if (request.reviewPhase === 'group-primary') return retrievalBatch('group-' + groupTurns++);
    const p = JSON.parse(request.input);
    if (request.reviewPhase === 'file-interaction') return { findings: [], limitations: [] };
    if (request.reviewPhase === 'verification') {
      verifications++;
      const receipt = p.retrieved.find(row => row.result.receiptId)?.result.receiptId;
      assert.ok(receipt);
      return { verdicts: p.candidates.map(c => ({ candidateId: c.candidateId, verdict: 'supported', reason: 'Fresh approved source', evidence: [{ receiptId: receipt }] })) };
    }
    if (p.file.id === 'a' && ++turns <= 3) return retrievalBatch(turns);
    if (p.file.id === 'b') { peerStarts++; return { findings: [candidate], limitations: [] }; }
    return { findings: [], limitations: [] };
  }, { ...continuationOptions, enableVerification: true });
  assert.equal(peerStarts, 1); assert.equal(verifications, 1);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].fileId, 'b');
  assert.equal(report.findings[0].verification.status, 'completed');
  assert.ok(report.files.every(file => file.status === 'completed'));
  assert.ok(report.readerBudget.calls <= 50);
  assert.doesNotMatch(JSON.stringify(buildResumeState(s, continuationOptions, report)), /receiptId/);
});

test('fallback cancellation after peer release cannot accept a resumed response', async () => {
  const controller = new AbortController(), reason = new Error('cancel group fallback'); let turns = 0, groupTurns = 0;
  await assert.rejects(reviewSnapshot(snapshot(), request => {
    if (request.reviewPhase === 'group-primary') return retrievalBatch('group-' + groupTurns++);
    const p = JSON.parse(request.input);
    if (request.reviewPhase === 'file-interaction' || p.file.id !== 'a') return { findings: [], limitations: [] };
    if (++turns <= 3) return retrievalBatch(turns);
    controller.abort(reason);
    return { findings: [], limitations: [] };
  }, { ...continuationOptions, signal: controller.signal }), error => error === reason);
  assert.equal(turns, 4);
});

test('fallback does not widen approved catalog authority', async () => {
  let starts = 0, groupTurns = 0;
  const report = await reviewSnapshot(snapshot(), request => {
    if (request.reviewPhase === 'group-primary') return retrievalBatch('group-' + groupTurns++);
    const p = JSON.parse(request.input);
    if (request.reviewPhase === 'file-interaction' || p.file.id !== 'a') return { findings: [], limitations: [] };
    starts++;
    return { requests: [{ kind: 'read', id: 'unapproved-source', start: 1, count: 1 }] };
  }, continuationOptions);
  assert.equal(starts, 1);
  assert.equal(report.readerBudget.calls, 16);
  assert.equal(report.files.find(file => file.fileId === 'a').status, 'failed');
  assert.equal(report.files.find(file => file.fileId === 'a').reason, 'Source not authorized');
  assert.equal(report.stageGenerations.some(stage => stage.fileId === 'a'), false);
});

test('stage continuation preserves a successful single group generation without member replay', async () => {
  const phases = [];
  const report = await reviewSnapshot(snapshot(), request => {
    phases.push(request.reviewPhase);
    return request.reviewPhase === 'group-primary' ? empty(JSON.parse(request.input)) : { findings: [], limitations: [] };
  }, continuationOptions);
  assert.deepEqual(phases, ['group-primary', 'file-interaction']);
  assert.equal(report.primaryGroupFallbacks, undefined);
  assert.equal(report.coverage.completed, 2);
  assert.ok(report.files.every(file => file.primaryMethod === 'group-primary'));
  assert.equal(report.readerAllocation.releasedUnits, report.readerAllocation.units);
});

test('group protocol and cancellation failures never fall back to member generation', async () => {
  let calls = 0;
  const report = await reviewSnapshot(snapshot(), () => { calls++; return { requests: [{ kind: 'read', id: 'unapproved-source', start: 1, count: 1 }] }; }, continuationOptions);
  assert.equal(calls, 1);
  assert.equal(report.primaryGroupFallbacks, undefined);
  assert.equal(report.coverage.failed, 2);
  const controller = new AbortController(), reason = new Error('cancel active group');
  calls = 0;
  const cancelled = await reviewSnapshot(snapshot(), () => { calls++; controller.abort(reason); return retrievalBatch('cancel'); }, { ...continuationOptions, signal: controller.signal });
  assert.equal(cancelled.primaryGroupFallbacks, undefined);
  assert.equal(cancelled.coverage.completed, 0);
  assert.ok(cancelled.files.every(file => file.status === 'cancelled'));
  assert.equal(calls, 1);
});
