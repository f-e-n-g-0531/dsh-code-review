import test from 'node:test';
import assert from 'node:assert/strict';
import { runLiveReview } from '../src/live-review-runner.mjs';

// MOCK SDK ONLY: these fixtures prove orchestration, not a live review/model run.
const expected = { runtimeVersion: 'fixture', provider: 'p', model: 'm', fileCount: 25, baseRevision: '100', targetRevision: '101' };
const wrap = (value, markdown = '') => ({ json: JSON.stringify(value), markdown });
function fixture({ timeout = false, mutate, jobStatus = 'completed', reportStatus = 'partial' } = {}) {
  const calls = [], saved = [], jobs = new Map();
  const files = Array.from({length:25}, (_, i) => ({ path: 'f' + i, eligibility: 'eligible' }));
  const findings = Array.from({length:143}, (_, i) => ({ title: 'finding' + i }));
  let previewCount = 0;
  function view(jobId, offset = 0, limit = 20) {
    const j = jobs.get(jobId);
    const summary = j.phase === 'preview' ? {
      previewId: j.previewId, modelSendingEnabled: true, runtime: {version:'fixture'}, model: {provider:'p',model:'m'},
      history: {base:'100', target:'101'}, snapshotId:'source1', repositoryRoot:'/repo', vcs:'svn',
      files:files.slice(offset,offset+limit), filePage:{offset,limit,total:files.length},
    } : { status:reportStatus, snapshotId:'source1', coverage:{completed:2,pending:23}, modelCalls:47, diagnostics:{modelCalls:47}, totalFiles:25,totalFindings:143,totalLimitations:3 };
    if (j.phase === 'preview') mutate?.(summary, j.previewCount);
    return {jobId,status:j.phase === 'preview' ? 'completed' : jobStatus,waitRevision:19,resultSummary:summary,
      ...(j.phase === 'execute' ? {resultPage:{files:files.slice(offset,offset+limit),findings:findings.slice(offset,offset+limit),totalFiles:25,totalFindings:143}} : {})};
  }
  const tools = {
    async start(args) {
      calls.push(['start',structuredClone(args)]);
      const jobId = 'j' + jobs.size;
      jobs.set(jobId, {...args,previewId:'preview' + previewCount,previewCount:args.phase === 'preview' ? ++previewCount : previewCount,timed:false});
      return wrap({jobId,status:'queued',waitRevision:7},'accepted');
    },
    async wait(args) {
      calls.push(['wait',structuredClone(args)]);
      const j = jobs.get(args.jobId);
      if (timeout && !j.timed) { j.timed = true; return wrap({jobId:args.jobId,status:'running',waitRevision:11,changed:false}); }
      return wrap({...view(args.jobId),changed:true,...(j.phase === 'execute' ? {finalMarkdown:'# FULL REPORT\npartial 2/25, calls 47'} : {})},j.phase === 'execute' ? '# FULL REPORT\npartial 2/25, calls 47' : 'preview terminal');
    },
    async status(args) { calls.push(['status',structuredClone(args)]); return wrap(view(args.jobId,args.offset,args.limit),'paged'); },
    async cancel(args) { calls.push(['cancel',args]); return wrap({jobId:args.jobId,status:'cancelled'}); },
  };
  return {tools,calls,saved,options:{tools,previewArgs:{svnBaseRevision:'100',svnTargetRevision:'101',files:['f']},expected,authorized:true,onRecord:async r=>{saved.push(r);}}};
}

test('fixture: fresh bounded runs save raw responses/full markdown, exact waits and both result denominators',async()=>{
  const f=fixture({timeout:true});
  const original=structuredClone(expected);
  const r=await runLiveReview({...f.options,runs:2});
  assert.equal(r.status,'completed'); assert.equal(r.runs.length,2);
  assert.deepEqual(expected,original);
  assert.equal(f.calls.filter(([k])=>k==='start').length,4);
  assert.equal(new Set(f.calls.filter(([k,a])=>k==='start'&&a.phase==='execute').map(([,a])=>a.previewId)).size,2);
  for(const [,a] of f.calls.filter(([k])=>k==='wait')) {assert.equal(a.waitFor,'terminal');assert.equal(a.timeoutMs,60000); assert.ok([7,11].includes(a.after));}
  for(const attempt of r.runs) {
    assert.equal(attempt.jobStatus,'completed'); assert.equal(attempt.reportStatus,'partial');
    assert.equal(attempt.report.files.length,25); assert.equal(attempt.report.findings.length,143);
    assert.deepEqual(attempt.report.coverage,{completed:2,pending:23}); assert.equal(attempt.report.modelCalls,47);
    assert.equal(attempt.fullMarkdown,'# FULL REPORT\npartial 2/25, calls 47');
  }
  assert.deepEqual(f.saved,r.records);
  assert.ok(f.saved.some(x=>x.phase==='execute'&&x.kind==='wait'&&x.raw.markdown.startsWith('# FULL REPORT')));
  assert.deepEqual(f.calls.filter(([k,a])=>k==='status'&&jobsPhase(a.jobId)==='execute').map(([,a])=>a.offset),[20,120,20,120]);
  function jobsPhase(id) {return ['j1','j3'].includes(id)?'execute':'preview';}
});

test('fixture: explicit authorization, run limits and resume are refused before tools',async()=>{
  const f=fixture();
  for(const override of [{authorized:false},{authorized:undefined},{runs:4},{runs:0},{runs:1.2},{previewArgs:{resumeFromJobId:'old'}}])
    await assert.rejects(runLiveReview({...f.options,...override}));
  assert.equal(f.calls.length,0);
});

test('fixture: each preview expectation is independently enforced before execute',async()=>{
  const changes=[p=>p.modelSendingEnabled=false,p=>p.runtime.version='wrong',p=>p.model.provider='other',p=>p.model.model='other',p=>p.history.base='99',p=>p.history.target='102',p=>p.filePage.total=24,p=>p.snapshotId='other',p=>p.resume={}];
  for(const mutate of changes) {
    const f=fixture({mutate});
    const r=await runLiveReview({...f.options,expected:{...expected,snapshotId:'source1'}});
    assert.equal(r.status,'stopped');
    assert.equal(f.calls.filter(([k,a])=>k==='start'&&a.phase==='execute').length,0);
    assert.ok(f.saved.some(x=>x.kind==='wait'));
  }
});

test('fixture: source drift stops later runs without changing expected or resuming',async()=>{
  const f=fixture({mutate:(p,n)=>{if(n===2)p.snapshotId='source2';}});
  const r=await runLiveReview({...f.options,runs:3});
  assert.equal(r.status,'stopped'); assert.match(r.reason,/changed/);
  assert.equal(r.runs.length,2); assert.equal(r.runs[0].reportStatus,'partial');
  assert.equal(f.calls.filter(([k,a])=>k==='start'&&a.phase==='execute').length,1);
  assert.deepEqual(r.expected,expected);
});

test('fixture: failed job with partial report is preserved and never retried to improve outcome',async()=>{
  const f=fixture({jobStatus:'failed'});
  const r=await runLiveReview({...f.options,runs:3});
  assert.equal(r.status,'stopped');assert.equal(r.runs.length,1);
  assert.equal(r.runs[0].jobStatus,'failed');assert.equal(r.runs[0].reportStatus,'partial');
  assert.equal(r.runs[0].report.findings.length,143);assert.equal(r.runs[0].report.totalLimitations,3);
});

test('fixture: failed preview retains raw terminal without executing',async()=>{
  const f=fixture();f.tools.wait=async a=>wrap({jobId:a.jobId,status:'failed',waitRevision:9,error:'capture failed'},'failed preview');
  const r=await runLiveReview(f.options);
  assert.equal(r.status,'stopped');assert.equal(r.runs[0].previewTerminal.error,'capture failed');
  assert.equal(f.calls.filter(([k])=>k==='start').length,1);
  assert.ok(f.saved.some(x=>x.raw.markdown==='failed preview'));
});

test('fixture: registered SDK names accepted and malformed JSON is saved before failure',async()=>{
  const f=fixture();const sdk=Object.fromEntries(Object.entries(f.tools).map(([k,v])=>['code_review_'+k,v]));
  assert.equal((await runLiveReview({...f.options,tools:sdk})).runs[0].reportStatus,'partial');
  const bad=fixture();bad.tools.wait=async()=>({json:'{',markdown:'raw malformed terminal'});
  const r=await runLiveReview(bad.options);
  assert.equal(r.status,'stopped');assert.ok(bad.saved.some(x=>x.raw.markdown==='raw malformed terminal'));
  assert.ok(bad.calls.some(([k])=>k==='cancel'));
});

test('fixture: onRecord is awaited before execute; callback cannot rewrite pinned scope',async()=>{
  const f=fixture();let persisted=false;
  const start=f.tools.start;
  f.tools.start=async a=>{if(a.phase==='execute')assert.ok(persisted);return start(a);};
  const r=await runLiveReview({...f.options,onRecord:async record=>{await Promise.resolve();if(record.phase==='preview'&&record.kind==='status')persisted=true;record.raw.json='{}';}});
  assert.equal(r.status,'completed');assert.equal(r.runs[0].reportStatus,'partial');
});

test('fixture: interruption during a real pending wait invokes optional cancel and retains responses',async()=>{
  const f=fixture(),controller=new AbortController();let release,entered;
  const waiting=new Promise(r=>entered=r);
  f.tools.wait=async a=>{entered();await new Promise(r=>release=r);return wrap({jobId:a.jobId,status:'cancelled',waitRevision:8},'cancelled terminal');};
  f.tools.cancel=async a=>{f.calls.push(['cancel',a]);release();return wrap({jobId:a.jobId,status:'cancelled'});};
  const pending=runLiveReview({...f.options,signal:controller.signal});
  await waiting;controller.abort();
  const r=await pending;
  assert.equal(r.status,'interrupted');assert.equal(f.calls.filter(([k])=>k==='cancel').length,1);
  assert.ok(f.saved.some(x=>x.kind==='cancel'));assert.ok(f.saved.some(x=>x.raw.markdown==='cancelled terminal'));
});

test('fixture: cancellation during start cancels the accepted job before waiting',async()=>{
  const f=fixture(),controller=new AbortController();const start=f.tools.start;
  f.tools.start=async a=>{const raw=await start(a);controller.abort();return raw;};
  const r=await runLiveReview({...f.options,signal:controller.signal});
  assert.equal(r.status,'interrupted');assert.equal(f.calls.filter(([k])=>k==='cancel').length,1);
  assert.equal(f.calls.filter(([k])=>k==='wait').length,0);
  assert.ok(f.saved.some(x=>x.kind==='start'));
});

test('fixture: failed job without report preserves terminal error and denominator unknown',async()=>{
  const f=fixture();const wait=f.tools.wait;
  f.tools.wait=async a=>a.jobId==='j1'?wrap({jobId:a.jobId,status:'failed',waitRevision:21,error:'Snapshot changed; no code sent',recovery:{files:[{path:'a',status:'pending'}]}},'failure'):wait(a);
  const r=await runLiveReview({...f.options,runs:3});
  assert.equal(r.status,'stopped');assert.equal(r.runs.length,1);
  assert.equal(r.runs[0].reportStatus,null);assert.equal(r.runs[0].terminal.error,'Snapshot changed; no code sent');
  assert.equal(r.runs[0].report,undefined);
});

test('fixture: execution snapshot/model drift stops and retains the original full terminal',async()=>{
  for(const field of ['snapshot','model']) {
    const f=fixture();const wait=f.tools.wait;
    f.tools.wait=async a=>{const raw=await wait(a);if(a.jobId==='j1'){const v=JSON.parse(raw.json);if(field==='snapshot')v.resultSummary.snapshotId='other';else v.resultSummary.model={provider:'other',model:'m'};return wrap(v,raw.markdown);}return raw;};
    const r=await runLiveReview({...f.options,runs:3});
    assert.equal(r.status,'stopped');assert.equal(r.runs.length,1);assert.match(r.reason,/changed/);
    assert.ok(f.saved.some(x=>x.raw.markdown.startsWith('# FULL REPORT')));
  }
});

test('fixture: at most three specified fresh runs, even with failed report status',async()=>{
  const f=fixture({reportStatus:'failed'});
  const r=await runLiveReview({...f.options,runs:3});
  assert.equal(r.status,'completed');assert.equal(r.runs.length,3);
  assert.ok(r.runs.every(x=>x.reportStatus==='failed'));
  assert.equal(f.calls.filter(([k,a])=>k==='start'&&a.phase==='preview').length,3);
});

test('fixture: already aborted signal starts nothing; no optional cancel required',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();delete f.tools.cancel;
  const r=await runLiveReview({...f.options,signal:controller.signal});assert.equal(r.status,'interrupted');assert.equal(f.calls.length,0);
});

test('fixture: inconsistent or empty report pages stop with all earlier raw evidence retained',async()=>{
  for(const mode of ['empty','total']) {
    const f=fixture();const status=f.tools.status;
    f.tools.status=async a=>{
      const raw=await status(a);
      if(a.jobId==='j1') {const v=JSON.parse(raw.json);if(mode==='empty')v.resultPage.files=v.resultPage.findings=[];else v.resultPage.totalFindings++;return wrap(v);}
      return raw;
    };
    const r=await runLiveReview({...f.options,runs:3});assert.equal(r.status,'stopped');assert.equal(r.runs.length,1);
    assert.equal(r.runs[0].executeTerminal.resultSummary.coverage.pending,23);
    assert.ok(f.saved.some(x=>x.raw.markdown.startsWith('# FULL REPORT')));
  }
});
test('fixture: explicit execution policy and SVN repository identity are checked before source sending', async () => {
  for (const extra of [{ execution: { strategy: 'whole-scope' } }, { repositoryUuid: 'expected-uuid' }, { repositoryUrl: 'https://expected.example/repo' }]) {
    const f = fixture(); const r = await runLiveReview({ ...f.options, expected: { ...expected, ...extra } });
    assert.equal(r.status, 'stopped'); assert.equal(f.calls.filter(([k,a]) => k === 'start' && a.phase === 'execute').length, 0);
  }
});
test('fixture: execution strategy drift stops the next fresh run before executing it', async () => {
  const f = fixture({ mutate: (p, n) => { p.execution = { strategy: n === 1 ? 'whole-scope' : 'staged' }; } });
  const r = await runLiveReview({ ...f.options, runs: 2 });
  assert.equal(r.status, 'stopped'); assert.match(r.reason, /Source.scope.destination changed/);
  assert.equal(f.calls.filter(([k,a]) => k === 'start' && a.phase === 'execute').length, 1);
});
