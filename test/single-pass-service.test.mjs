import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewService } from '../src/service.mjs';
const execution = () => ({ agent: { session: { header: { cwd: '/repo' } }, options: { provider: 'fixture', model: 'offline' } }, signal: new AbortController().signal });
const snapshot = () => ({id:'fixed',root:'/repo',vcs:'git',context:[],rules:[],files:[{id:'f',path:'a.js',eligibility:'reviewable',left:{text:'old();'},right:{text:'new();'},properties:[]}]});
function fixture(t, options = {}, output) {
  let calls = 0, children = 0, request;
  const service = createReviewService({async *stream(r) { calls++; request = r; const input = JSON.parse(r.messages[0].content[0].text); assert.equal(input.sourceMode,'single-pass'); assert.deepEqual(r.tools,[]); yield {type:'text-delta',text:output ?? JSON.stringify({reviews:input.reviews.map(row=>({fileId:row.fileId,findings:[],limitations:[],completion:{status:'completed',gaps:[]},assuranceNotes:[]})),limitations:[],completion:{status:'completed',gaps:[]},assuranceNotes:[]})}; yield {type:'finish',reason:{kind:'stop'}}; }}, {executionStrategy:'auto',capture:async()=>snapshot(),allowModelSending:true,authorize:async()=>true,nativeOutputTools:true,hostChildren:{capability:()=>true,prepare:async()=>{children++;},create:async()=>{children++;throw new Error('forbidden');}},...options});
  t.after(()=>service.dispose()); return {service,exec:execution(),get calls(){return calls;},get children(){return children;},get request(){return request;}};
}
test('auto preview and execution share request identity; exactly one physical tool-free call',async t=>{
 const f=fixture(t),p=await f.service.preview({},f.exec); assert.equal(f.calls,0); assert.equal(p.plan.minimumCalls,1); assert.equal(p.plan.tokenFits,'unknown'); assert.equal(p.execution.verification,'not-requested');
 const {report}=await f.service.execute({previewId:p.previewId,confirmed:true},f.exec); assert.equal(f.calls,1); assert.equal(f.children,0); assert.equal(report.orchestration.requestHash,p.plan.requestHash); assert.equal(report.orchestration.input.inputHash,p.plan.input.inputHash); assert.equal(report.status,'completed'); assert.equal(report.execution.nativeOutputTools,false); assert.equal(f.request.maxTokens,4096);
});
for (const [name,output] of [['requests','{"requests":[{"kind":"read","sourceId":"s1"}]}'],['unsafeJSON','{"__proto__":{},"reviews":[]}'],['malformed','not json']]) test(name+' fails once without retry or children',async t=>{const f=fixture(t,{},output),p=await f.service.preview({},f.exec);const {report}=await f.service.execute({previewId:p.previewId,confirmed:true},f.exec);assert.equal(f.calls,1);assert.equal(f.children,0);assert.notEqual(report.status,'completed');});
test('over complete-material cap blocks zero calls and never uses staged or children',async t=>{const f=fixture(t,{singlePassMaxInputBytes:1}),p=await f.service.preview({},f.exec);assert.equal(p.plan.minimumCalls,0);assert.equal(p.execution.executionStrategy,'single-pass');assert.match(p.notice,/新preview/);const {report}=await f.service.execute({previewId:p.previewId,confirmed:true},f.exec);assert.equal(f.calls,0);assert.equal(f.children,0);assert.equal(report.coverage.blocked,1);});
test('authorization and changed snapshot reject before model',async t=>{for(const options of [{authorize:async()=>false},(()=>{let count=0;return {capture:async()=>({...snapshot(),id:++count===1?'fixed':'changed'})};})()]){const f=fixture(t,options),p=await f.service.preview({},f.exec);await assert.rejects(f.service.execute({previewId:p.previewId,confirmed:true},f.exec));assert.equal(f.calls,0);}});
test('capacity metadata change invalidates approved preview without sending',async t=>{let contextWindow=1000000;const f=fixture(t,{resolveModelCapacity:async()=>({context:{contextWindow}})}),p=await f.service.preview({},f.exec);assert.equal(p.plan.modelCapacity.contextWindowTokens,1000000);contextWindow++;await assert.rejects(f.service.execute({previewId:p.previewId,confirmed:true},f.exec),/capacity policy changed/);assert.equal(f.calls,0);});
test('same snapshot ID cannot conceal changed complete request bytes',async t=>{let count=0;const f=fixture(t,{capture:async()=>{const s=snapshot();if(++count>1)s.files[0].right.text='changed();';return s;}}),p=await f.service.preview({},f.exec);await assert.rejects(f.service.execute({previewId:p.previewId,confirmed:true},f.exec),/request changed/);assert.equal(f.calls,0);});
test('capacity mutation during authorization is rejected by actual stream guard',async t=>{let cap=1000000;const f=fixture(t,{resolveModelCapacity:async()=>({contextWindowTokens:cap}),authorize:async()=>{cap++;return true;}}),p=await f.service.preview({},f.exec);const {report}=await f.service.execute({previewId:p.previewId,confirmed:true},f.exec);assert.equal(f.calls,0);assert.equal(f.children,0);assert.notEqual(report.status,'completed');});
test('legitimate anchored finding survives full service and both renderers as single-model candidate',async t=>{const output=JSON.stringify({reviews:[{fileId:'f',findings:[{fileId:'f',severity:'high',title:'Changed behavior',evidence:'new call',trigger:'execution reaches call',impact:'behavior changes',suggestion:'retain guard',anchor:{kind:'line',side:'new',start:1,end:1,snippet:'new();'},attribution:{editIds:['e1'],properties:[],beforeBehavior:'old call',afterBehavior:'new call',reason:'changed call'}}],limitations:[],completion:{status:'completed',gaps:[]},assuranceNotes:[]}],limitations:[],completion:{status:'completed',gaps:[]},assuranceNotes:[]});const f=fixture(t,{},output),p=await f.service.preview({},f.exec);const {report,markdown,technicalMarkdown}=await f.service.execute({previewId:p.previewId,confirmed:true},f.exec);assert.equal(f.calls,1);assert.equal(report.status,'completed');assert.equal(report.findings.length,1);assert.equal(report.findings[0].verification.status,'not-requested');assert.equal(report.executionAssurance.protocolValid,true);assert.match(markdown,/单模型/);assert.match(technicalMarkdown,/Changed behavior/);});
test('route change invalidates approved preview without sending',async t=>{const f=fixture(t),p=await f.service.preview({},f.exec);f.exec.agent.options.model='changed';await assert.rejects(f.service.execute({previewId:p.previewId,confirmed:true},f.exec));assert.equal(f.calls,0);});
test('single-pass explicitly rejects multiround resume and project; auto preserves multiround staged',async t=>{const f=fixture(t);for(const args of [{reviewRounds:2},{resumeFromJobId:'00000000-0000-0000-0000-000000000000'},{reviewMode:'project'}])await assert.rejects(f.service.preview({...args,executionStrategy:'single-pass'},f.exec));const p=await f.service.preview({reviewRounds:2},f.exec);assert.equal(p.execution.executionStrategy,'staged');assert.equal(p.dispatch.reason,'multiple-rounds-require-staged');assert.equal(f.calls,0);});
test('single-pass hard policy independent of old maxInputBytes and bound to request/history hash',async t=>{const a=fixture(t,{maxInputBytes:1,singlePassMaxInputBytes:4194304}),b=fixture(t,{maxInputBytes:1,singlePassMaxInputBytes:4194303});const p=await a.service.preview({},a.exec),q=await b.service.preview({},b.exec);assert.equal(p.plan.status,'ready');assert.notEqual(p.plan.requestHash,q.plan.requestHash);const ar=await a.service.execute({previewId:p.previewId,confirmed:true},a.exec),br=await b.service.execute({previewId:q.previewId,confirmed:true},b.exec);assert.notDeepEqual(ar.report.reviewHistory.manifest.identity,br.report.reviewHistory.manifest.identity);});
test('single-pass policy validates independent deployment bounds',async t=>{for(const cap of [0,-1,4194305,1.5]){const f=fixture(t,{singlePassMaxInputBytes:cap});await assert.rejects(f.service.preview({},f.exec),/single-pass input capacity/);assert.equal(f.calls,0);}});
test('zero reviewable files use zero model calls',async t=>{const s=snapshot();s.files[0].eligibility='excluded';const f=fixture(t,{capture:async()=>s}),p=await f.service.preview({},f.exec);assert.equal(p.plan.minimumCalls,0);await f.service.execute({previewId:p.previewId,confirmed:true},f.exec);assert.equal(f.calls,0);});
test('legacy staged whole-scope and auto multiround never query single-pass model capacity',async t=>{
 let capacityQueries=0,streams=0;
 const service=createReviewService({async *stream(request){streams++;const input=JSON.parse(request.messages[0].content[0].text);yield {type:'text-delta',text:JSON.stringify(input.reviews?{reviews:input.reviews.map(row=>({fileId:row.fileId,findings:[],limitations:[],completion:{status:'completed',gaps:[]},assuranceNotes:[]})),limitations:[],completion:{status:'completed',gaps:[]},assuranceNotes:[]}:{findings:[],limitations:[]})};yield {type:'finish',reason:{kind:'stop'}};}},{executionStrategy:'auto',capture:async()=>snapshot(),allowModelSending:true,authorize:async()=>true,resolveModelCapacity:async()=>{capacityQueries++;throw new Error('single-pass-only resolver must not run');}});
 t.after(()=>service.dispose());const e=execution();for(const args of [{executionStrategy:'staged'},{executionStrategy:'whole-scope'},{reviewRounds:2}]){const p=await service.preview(args,e);const {report}=await service.execute({previewId:p.previewId,confirmed:true},e);assert.equal(report.status,'completed');}assert.equal(capacityQueries,0);assert.equal(streams,4);
});
test('auto resume keeps staged reuse without invoking throwing single-pass capacity resolver',async t=>{
 let queries=0,calls=0,saved;
 const service=createReviewService({async *stream(){calls++;yield {type:'text-delta',text:'{"findings":[],"limitations":[]}'};yield {type:'finish',reason:{kind:'stop'}};}},{executionStrategy:'auto',capture:async()=>snapshot(),allowModelSending:true,authorize:async()=>true,resolveModelCapacity:async()=>{queries++;throw new Error('not used by resume');}});t.after(()=>service.dispose());const e=execution();e.reviewResumeCheckpoint=async state=>{saved=state;};const p=await service.preview({executionStrategy:'staged'},e);await service.execute({previewId:p.previewId,confirmed:true},e);e.resolveReviewResume=async()=>saved;const q=await service.preview({resumeFromJobId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'},e);assert.equal(q.dispatch.reason,'resume-requires-staged');const {report}=await service.execute({previewId:q.previewId,confirmed:true},e);assert.equal(report.modelCalls,0);assert.equal(calls,1);assert.equal(queries,0);
});
test('single-pass checks capacity at preview execute and final physical send',async t=>{let queries=0;const f=fixture(t,{resolveModelCapacity:async()=>{queries++;return {contextWindowTokens:1000000};}}),p=await f.service.preview({},f.exec);assert.equal(queries,1);await f.service.execute({previewId:p.previewId,confirmed:true},f.exec);assert.equal(queries,3);assert.equal(f.calls,1);});
test('full 1.9MB source fits independent 4MiB policy without focused slicing',async t=>{const source=snapshot();source.files[0].right.text='x'.repeat(1900000);const f=fixture(t,{capture:async()=>source,maxInputBytes:512*1024,primaryInputMode:'focused'}),p=await f.service.preview({},f.exec);assert.equal(p.plan.status,'ready');const {report}=await f.service.execute({previewId:p.previewId,confirmed:true},f.exec);assert.equal(f.calls,1);assert.equal(report.status,'completed');const payload=JSON.parse(f.request.messages[0].content[0].text);assert.equal(payload.contents[payload.reviews[0].file.right.textRef].length,1900000);});

test('trusted count reserves output, blocks above the limit and matches the real request at the boundary', async t => {
 for (const [inputTokens, expectedCalls] of [[700, 1], [701, 0]]) {
  const counted = [];
  const f = fixture(t, {
   resolveModelCapacity: async () => ({ contextWindowTokens: 1000, maxOutputTokens: 800, defaultOutputTokens: 300 }),
   countSinglePassInputTokens: request => { counted.push(request); return { inputTokens, counterId: 'exact-v1' }; },
  });
  const p = await f.service.preview({}, f.exec);
  assert.equal(p.plan.minimumCalls, expectedCalls);
  assert.equal(p.plan.tokenFits, expectedCalls ? 'fits' : 'blocked');
  assert.equal(p.plan.capacity.output.requestedTokens, 300);
  const { report, markdown } = await f.service.execute({ previewId: p.previewId, confirmed: true }, f.exec);
  assert.equal(f.calls, expectedCalls);
  if (!expectedCalls) {
   assert.equal(report.coverage.blocked, 1);
   assert.match(markdown, /超出模型窗口/);
  } else {
   assert.equal(report.status, 'completed');
   assert.equal(counted.length, 3);
   assert.ok(counted.every(x => x.system === f.request.system));
   assert.ok(counted.every(x => x.messages[0].content[0].text === f.request.messages[0].content[0].text));
  }
 }
});

test('trusted counter identity change during approval rejects the physical send', async t => {
 let counterId = 'exact-v1';
 const f = fixture(t, {
  resolveModelCapacity: async () => ({ contextWindowTokens: 9000 }),
  countSinglePassInputTokens: () => ({ inputTokens: 20, counterId }),
  authorize: async () => { counterId = 'exact-v2'; return true; },
 });
 const p = await f.service.preview({}, f.exec);
 const { report, markdown } = await f.service.execute({ previewId: p.previewId, confirmed: true }, f.exec);
 assert.equal(f.calls, 0);
 assert.notEqual(report.status, 'completed');
 assert.match(markdown, /须重新预览/);
});
