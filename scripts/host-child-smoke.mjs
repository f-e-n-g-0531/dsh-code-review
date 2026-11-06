// Run with installed Electron ELECTRON_RUN_AS_NODE=1; never mounts into the live host.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { createHostReviewChildren } from '../src/host-review-children.mjs';
import { createReviewService } from '../src/service.mjs';
import { attachReviewChildMiddleware } from '../src/review-child-broker.mjs';
import { registerSnapshotTool } from '../src/review-child-plugin.mjs';
const host = process.argv[2];
if (!host || !process.versions.electron) throw new Error('Use installed Electron in RUN_AS_NODE mode and pass its ASAR dsh directory');
const load = name => import(pathToFileURL(path.join(host, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { Context } = await load('cordis');
const { LlmAdapter } = await load('dsh-llm');
const ctx = new Context();
const keepAlive = setInterval(() => {}, 1000);
const timeout = setTimeout(() => { console.error('Offline child smoke timed out'); process.exit(1); }, 45000);
const groupMode = process.argv.includes('--group');
const capacityCompletionMode=process.argv.includes('--capacity-completion');
const followupAdmissionMode=process.argv.includes('--followup-admission');
const supplementLimitMode=process.argv.includes('--supplement-limit');
const capacityMode = process.argv.includes('--capacity');
const hostOverheadMode = process.argv.includes('--host-overhead');
const expectResplit = process.argv.includes('--expect-resplit');
const packedMode = process.argv.includes('--packed') || hostOverheadMode;
const expectCapacityFit = process.argv.includes('--expect-capacity-fit');
const serviceMode = process.argv.includes('--service') || capacityMode || packedMode || supplementLimitMode || followupAdmissionMode || capacityCompletionMode;
const envelopes=[];
let serviceEvidence;
const finalResult = groupMode ? {reviews:[{fileId:'file-1',findings:[],limitations:[]}],limitations:[]} : {findings:[],limitations:[]};
const calls = new Map(), observations = [], active = new Set(), hostEvents = [];
const runningChildren=new Set();let peakRunningChildren=0;
ctx.on('session/event',(session,event)=>{if(session.header.parentSession!=='offline-parent')return;if(event.type==='turn/start'){runningChildren.add(session.id);peakRunningChildren=Math.max(peakRunningChildren,runningChildren.size);}if(event.type==='turn/end')runningChildren.delete(session.id);});
ctx.on('session/event',(session,event)=>{if(['turn/end','error','llm/error'].includes(event.type))hostEvents.push({id:session.id,event});});
let overlap = false, release;
const barrier = new Promise(resolve => { release = resolve; });
class OfflineAdapter extends LlmAdapter {
  async *stream(options) {
    assert.equal(options.provider, 'offline-child-smoke');
    assert.equal(options.model, 'none');
    const names = options.tools.map(t => t.name).sort();
    assert.deepEqual(names, ['review_snapshot', 'structured_output']);
    const id = options.sessionId, n = (calls.get(id) ?? 0) + 1;
    if (serviceMode) {
      const agent = ctx.agents.get(id);
      assert.equal(agent.session.header.parentSession,'offline-parent');
      assert.equal(agent.session.header.agentPreset,'dsh-code-review-restricted');
      const texts = options.messages.flatMap(message => message.content ?? []).filter(block=>block.type==='text').map(block=>block.text);
      const payloadText = texts.find(text=>text.includes('{"snapshotId"'));
      assert.ok(payloadText);
      const payload = JSON.parse(payloadText.slice(payloadText.indexOf('{"snapshotId"')));
      assert.equal(payload.sourceMode,'group-primary');
      calls.set(id,n);assert.ok(n<=(supplementLimitMode?4:2));
      observations.push({childId:id,call:n,tools:names,fileIds:payload.reviews.map(row=>row.fileId),messages:options.messages.length});
      if(n===1&&!capacityMode&&!capacityCompletionMode){active.add(id);if(active.size>=2){overlap=true;release();}await barrier;}
      else if(n>1) {
        const delivered=options.messages.filter(message=>message.role==='tool');
        assert.ok(delivered.length>0);
        if(capacityCompletionMode){const wire=JSON.stringify(delivered);observations.at(-1).capacityDenied=wire.includes('not-delivered-capacity-policy');if(!observations.at(-1).capacityDenied)assert.ok(wire.includes('x'.repeat(100)));}
        else if(followupAdmissionMode){const wire=JSON.stringify(delivered);assert.match(wire,/not-delivered-capacity-policy/);assert.ok(!wire.includes('x'.repeat(100)));assert.ok(!wire.includes('sourceId'));assert.match(wire,/results[^a-z]*\[\]/);const notice=JSON.parse(delivered.at(-1).content[0].text);assert.deepEqual(notice.results,[]);assert.equal(notice.capacityPolicy.runtimeGuarantee,false);assert.equal(notice.supplementalRetrieval.finalResponseRequired,true);observations.at(-1).capacityNotice={deliveryStatus:notice.deliveryStatus,resultCount:notice.results.length,finalResponseRequired:notice.supplementalRetrieval.finalResponseRequired,runtimeGuarantee:notice.capacityPolicy.runtimeGuarantee};}
        else assert.match(JSON.stringify(delivered),/old[(][)];/);
      }
      const source=payload.catalog.find(row=>row.fileId===payload.reviews[0].fileId&&row.side===(followupAdmissionMode||capacityCompletionMode?'new':'old'));
      assert.ok(source);
      if(supplementLimitMode&&n===4){const toolText=JSON.stringify(options.messages.filter(message=>message.role==='tool'));assert.match(toolText,/remainingRounds[^0-9]*0/);assert.match(toolText,/finalResponseRequired[^a-z]*true/);}
      const readNow=capacityCompletionMode?n===1&&payload.reviews.some(row=>row.fileId.startsWith('target-')):supplementLimitMode?n<=3:n===1;
      yield {type:'block-end',index:0,block:{type:'tool-call',id:'service-'+id+'-'+n,name:readNow?'review_snapshot':'structured_output',arguments:JSON.stringify(readNow?{requests:Array.from({length:followupAdmissionMode||capacityCompletionMode?3:1},()=>({kind:'read',id:source.id,start:1,count:1}))}:{reviews:payload.reviews.map(row=>({fileId:row.fileId,findings:[],limitations:[]})),limitations:[]})}};
      yield {type:'finish',reason:{kind:'tool-calls'}};return;
    }
    calls.set(id, n); assert.ok(n <= 2);
    observations.push({ childId: id, call: n, tools: names, messages: options.messages.length });
    if (n === 1) {
      active.add(id); if (active.size === 2) { overlap = true; release(); }
      await barrier;
    } else {
      assert.match(JSON.stringify(options.messages), /OFFLINE_APPROVED_SNAPSHOT/);
    }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'offline-' + id + '-' + n,
      name: n === 1 ? 'review_snapshot' : 'structured_output',
      arguments: JSON.stringify(n === 1 ? { requests: [{kind:'read',id:'source-1',start:1,count:1}] } : finalResult) } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}
let parentHandle, transport;
try {
  // All registries, loop, Inbox, schema validation, native dispatch and settlement are installed host implementations.
  for (const [name, config] of [
    ['dsh-session', {}], ['dsh-session-projection', {}], ['dsh-agent', {}],
    ['dsh-system-prompt', {includeRuntimeContext:false}], ['dsh-tools', {}],
    ['dsh-llm', {}], ['dsh-agent-loop', {}],
  ]) await ctx.plugin((await load(name)).default, config).await();
  // Offline cwd seam only; real Session header still records the exact cwd.
  ctx.provide('workingDirectory'); ctx.set('workingDirectory', {get:session=>session.header.cwd ?? process.cwd(),set:async()=>{}});
  const { Loader } = await load('cordis-plugin-loader');
  const loader = new Loader(ctx, {baseUrl:pathToFileURL(path.join(host,'package.json')).href});
  // Isolated resolver: only the tested repo child export and installed ASAR packages.
  // No installed package, profile, or live runtime is modified.
  const manifest = JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(typeof manifest.exports['./child'],'string');
  loader.internal = { import: async name => name === '@feng0531/dsh-code-review/child'
    ? import(new URL('../'+manifest.exports['./child'],import.meta.url).href) : load(name.replace('@deepseek-ai/','')) };
  await ctx.plugin((await load('dsh-agent-preset-registry')).default, {default:'offline-empty'}).await();
  await ctx.plugin((await load('dsh-subagent')).default, {maxDepth:1,maxActiveSubagents:2}).await();
  await ctx.plugin(await load('dsh-subagent-spawn-in-process'), {}).await();
  await ctx.fiber.await();
  ctx.llm.registerAdapter(['offline-child-smoke'], new OfflineAdapter());
  // Deliberately inherited dangerous capability: must never reach a restricted child.
  ctx.tools.register({name:'offline_forbidden_shell',description:'Forbidden sentinel',parameters:{type:'object',properties:{},additionalProperties:false},
    output:{schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},render:()=>[]},
    execute(){throw new Error('Forbidden inherited tool executed');}});
  if(capacityCompletionMode)ctx.systemPrompt.section({name:'offline-completion-host-overhead',order:102,text:'h'.repeat(70000)});
  if(followupAdmissionMode)ctx.systemPrompt.section({name:'offline-followup-host-overhead',order:101,text:'h'.repeat(100000)});
  if(hostOverheadMode)ctx.systemPrompt.section({name:'offline-large-host-overhead',order:100,text:'HOST_OVERHEAD_FIXTURE_'+ 'h'.repeat(150000)});
  registerSnapshotTool(ctx);
  ctx.on('llm/stream',(options,next)=>{
    const serialized=JSON.stringify({system:options.system,messages:options.messages,tools:options.tools});
    envelopes.push({childId:options.sessionId,logicalBytes:Buffer.byteLength(serialized),messageTextBytes:options.messages.reduce((sum,message)=>sum+(message.content??[]).filter(block=>block.type==='text').reduce((n,block)=>n+Buffer.byteLength(block.text),0),0),toolsBytes:Buffer.byteLength(JSON.stringify(options.tools))});
    return next();
  });
  attachReviewChildMiddleware(ctx);
  await ctx.agentPresets.register({id:'offline-empty',name:'Offline parent',plugins:[{name:'@deepseek-ai/dsh-tool-executor-native'}]});
  parentHandle = await ctx.agents.create({sessionId:'offline-parent',agentOptions:{provider:'offline-child-smoke',model:'none'},meta:{cwd:process.cwd()}});
  const parent = parentHandle.agent;
  assert.equal(ctx.agents.get(parent.id), parent);
  await assert.rejects(ctx.tools.get('review_snapshot').execute({requests:[]},{agent:parent,signal:new AbortController().signal}), /ownership|reservation|session|binding|match/i);
  transport = createHostReviewChildren(ctx); assert.equal(transport.capability(),true);
  const signal = new AbortController().signal;
  let reservations = 0, reads = 0;
  if (serviceMode) {
    const snapshot={id:'offline-service-fixed',vcs:'git',root:process.cwd(),context:[],rules:[],files:Array.from({length:3},(_,i)=>({id:'service-file-'+i,path:'src/service-'+i+'.js',eligibility:'reviewable',properties:[],left:{text:'old();'},right:{text:'x'.repeat(300000)}}))};
    let captures=0;
    const service=createReviewService(ctx.llm,{capture:async()=>{captures++;return structuredClone(snapshot);},hostChildren:transport,maxPreviews:1,executionStrategy:'auto',maxInputBytes:512*1024,wholeScopeConcurrency:2,allowModelSending:true,authorize:async()=>true,nativeOutputTools:true,enableGroupPrimary:true});
    try {
      const exec={agent:parent,signal};
      let measuredSize;
      if(capacityMode){
        // Near-full old-planner fixture measured at 517895 initial text bytes,
        // but over 1MiB after JSON message serialization. Synthetic source only.
        measuredSize=128000;
        for(const file of snapshot.files)file.right.text=String.fromCharCode(34,92).repeat(measuredSize);
      }
      if(packedMode)snapshot.files=Array.from({length:18},(_,i)=>({id:'service-file-'+i,path:'src/service-'+i+'.js',eligibility:'reviewable',properties:[],left:{text:'old();'},right:{text:String.fromCharCode(34,92).repeat(7000)}}));
      if(followupAdmissionMode)for(const file of snapshot.files)file.right.text='x'.repeat(40000)+String.fromCharCode(10)+'y'.repeat(260000);
      if(capacityCompletionMode)snapshot.files=[...Array.from({length:47},(_,i)=>({id:'sibling-'+i,path:'a/'+String(i).padStart(2,'0')+'.js',eligibility:'reviewable',properties:[],left:{text:'old();'},right:{text:'s'.repeat(8000)}})),...Array.from({length:3},(_,i)=>({id:'target-'+i,path:'z/'+i+'.js',eligibility:'reviewable',properties:[],left:{text:'old();'},right:{text:'x'.repeat(40000)+String.fromCharCode(10)+'y'.repeat(90000)}}))];
      const preview=await service.preview({},exec);
      assert.equal(calls.size,0);assert.equal(preview.dispatch.requested,'auto');
      if(capacityMode&&expectCapacityFit){
        assert.equal(preview.dispatch.effectiveStrategy,'staged');assert.equal(preview.dispatch.oversizedCount,3);assert.equal(calls.size,0);
        serviceEvidence={dispatch:preview.dispatch,expected:'oversized-not-misclassified',executed:false,measuredSize};
      } else {
      assert.equal(preview.dispatch.effectiveStrategy,'whole-scope');
      assert.equal(preview.dispatch.childMode,'host-subagents');if(packedMode||capacityCompletionMode)assert.ok(preview.dispatch.plannedChildCount>1);else assert.equal(preview.dispatch.plannedChildCount,3);
      const {report}=await service.execute({previewId:preview.previewId,confirmed:true},exec);
      assert.deepEqual(report.dispatch,preview.dispatch);
      assert.equal(report.orchestration.batchExecution,'host-subagents');
      if(capacityMode){
        const rejected=report.orchestration.batches.filter(batch=>batch.failureCode==='WHOLE_SCOPE_INPUT_BUDGET');
        if(expectCapacityFit)assert.equal(report.coverage.completed,3);
        else {assert.ok(rejected.length>0);assert.ok(envelopes.some(row=>row.logicalBytes>512*1024));}
        serviceEvidence={dispatch:report.dispatch,coverage:report.coverage,modelCalls:report.modelCalls,status:report.status,measuredSize,expected:expectCapacityFit?'fits':'reproduced-capacity-rejection',batches:report.orchestration.batches.map(batch=>({status:batch.status,failureCode:batch.failureCode,childId:batch.childId})),envelopes};
      } else if(capacityCompletionMode){
        assert.equal(report.coverage.completed,50);assert.equal(report.coverage.pending,0);
        const superseded=report.orchestration.batches.filter(batch=>batch.status==='capacity-superseded');assert.ok(superseded.length>0);
        for(let i=0;i<47;i++)assert.equal(observations.filter(row=>row.call===1&&row.fileIds.includes('sibling-'+i)).length,1);
        assert.equal(report.modelCalls,observations.length);assert.ok(envelopes.every(row=>row.logicalBytes<=512*1024));
        for(const id of new Set(envelopes.map(row=>row.childId)))assert.equal(ctx.agents.get(id),undefined);
        assert.ok(peakRunningChildren<=2);
        serviceEvidence={dispatch:report.dispatch,coverage:report.coverage,status:report.status,modelCalls:report.modelCalls,readerBudget:report.readerBudget,batches:report.orchestration.batches,allChildrenDisposed:true,peakRunningChildren,envelopes,capacityCompletion:true};
      } else if(followupAdmissionMode){
        assert.equal(report.coverage.completed,0);assert.equal(report.coverage.pending,3);assert.equal(report.modelCalls,6);
        assert.equal(report.readerBudget.calls,0);assert.equal(report.readerBudget.outputBytes,0);
        assert.ok(report.orchestration.batches.every(batch=>batch.status==='pending'&&!(batch.retrievalAudit?.length)));
        assert.ok(envelopes.every(row=>row.logicalBytes<=512*1024));
        for(const id of calls.keys())assert.equal(ctx.agents.get(id),undefined);
        serviceEvidence={dispatch:report.dispatch,coverage:report.coverage,status:report.status,modelCalls:report.modelCalls,readerBudget:report.readerBudget,batches:report.orchestration.batches,allChildrenDisposed:true,envelopes,notice:'best-effort finalization reserve, not runtime guarantee'};
      } else if(hostOverheadMode){
        const unsent=envelopes.filter(row=>!calls.has(row.childId));
        assert.ok(unsent.length>0);assert.ok(unsent.every(row=>row.logicalBytes>512*1024));
        if(expectResplit){assert.equal(report.coverage.completed,snapshot.files.length);assert.ok(observations.length>0);assert.equal(report.modelCalls,observations.length);assert.ok(report.orchestration.capacityReplans.every(row=>row.modelSent===false&&row.depth<8));assert.deepEqual(observations.filter(row=>row.call===1).flatMap(row=>row.fileIds).sort(),snapshot.files.map(file=>file.id).sort());}
        else {assert.ok(report.coverage.completed<snapshot.files.length);}
        assert.ok(envelopes.filter(row=>calls.has(row.childId)).every(row=>row.logicalBytes<=512*1024));
        assert.ok(peakRunningChildren<=2);assert.equal(runningChildren.size,0);
        const allChildIds=[...new Set(envelopes.map(row=>row.childId))];
        for(const id of allChildIds)assert.equal(ctx.agents.get(id),undefined);
        assert.ok(report.orchestration.capacityReplans.every(row=>row.approvedCap===512*1024));
        serviceEvidence={peakRunningChildren,allChildrenDisposed:true,allChildIds,approvedCap:512*1024,dispatch:report.dispatch,status:report.status,coverage:report.coverage,modelCalls:report.modelCalls,unsentProbeCount:unsent.length,unsentProbes:unsent,envelopes,batches:report.orchestration.batches,capacityReplans:report.orchestration.capacityReplans,expectResplit};
      } else {
      assert.equal(report.coverage.completed,snapshot.files.length);assert.equal(report.modelCalls,preview.dispatch.plannedChildCount*(supplementLimitMode?4:2));assert.equal(calls.size,preview.dispatch.plannedChildCount);assert.equal(overlap,true);
      assert.deepEqual(observations.filter(row=>row.call===1).flatMap(row=>row.fileIds).sort(),snapshot.files.map(file=>file.id).sort());
      for(const id of calls.keys())assert.equal(ctx.agents.get(id),undefined);
      assert.ok(envelopes.every(row=>row.logicalBytes<=512*1024));
      const batches=report.orchestration.batches.map(batch=>({childId:batch.childId,status:batch.status,fileIds:batch.fileIds,retrievalReads:batch.retrievalAudit?.length??0}));
      assert.ok(batches.every(batch=>batch.retrievalReads===(supplementLimitMode?3:1)&&calls.has(batch.childId)));
      serviceEvidence={dispatch:report.dispatch,status:report.status,coverage:report.coverage,modelCalls:report.modelCalls,captures,batches,mirroredIndexPolicy:{executionStrategy:'auto',maxInputBytes:512*1024},servicePreviewExecute:true,customCreateBatchModel:false,envelopes,retrievalProtocolTelemetry:report.diagnostics?.retrievalProtocolTelemetry??null};
      }
      }
    } finally {service.dispose();}
  } else {
  const scope = () => ({
    catalog:()=>[{id:'source-1'}], budget:()=>({remainingCalls:4}), preflight:()=>{}, transaction:fn=>fn(),
    read:() => { reads++; return {snapshotId:'offline-snapshot',sourceId:'source-1',hash:'offline',start:1,count:1,text:'OFFLINE_APPROVED_SNAPSHOT'}; },
  });
  const children = await Promise.all([0,1].map(()=>transport.create({parent,route:{provider:'offline-child-smoke',model:'none'},cwd:process.cwd(),signal})));
  try {
    const results = await Promise.all(children.map(child=>child.runPrimary({
      request:{instructions:'Offline lifecycle test only.',input:JSON.stringify({snapshotId:'offline-snapshot',...(groupMode?{sourceMode:'group-primary',files:[{id:'file-1'}]}:{file:{id:'file-1'}})})},
      scope:scope(), maxRounds:2,maxInputBytes:1000000,reserveModelCall:()=>{reservations++;},
    })));
    assert.deepEqual(results,[finalResult,finalResult]);
    assert.equal(overlap,true);assert.equal(reads,2);assert.equal(reservations,4);
    assert.equal(calls.size,2);assert.ok([...calls.values()].every(n=>n===2));
  } finally { await Promise.all(children.map(child=>child.dispose())); }
  for(const child of children) assert.equal(ctx.agents.get(child.childId),undefined);
  }
  const evidence = {status:'passed',realProviderCalls:0,realHostLoop:true,realNativeExecutor:true,realPresetRegistry:true,isolatedResolver:true,offlineCwdSeam:true,groupMode,serviceMode,capacityMode,serviceEvidence,overlap,...(serviceMode&&!capacityMode&&!hostOverheadMode&&!followupAdmissionMode&&!capacityCompletionMode?{reads:serviceEvidence.batches.reduce((sum,batch)=>sum+batch.retrievalReads,0),reservations:serviceEvidence.modelCalls}:{reads,reservations}),observations};
  if(process.argv[3]) await writeFile(process.argv[3],JSON.stringify(evidence,null,2)+String.fromCharCode(10));
  console.log(JSON.stringify(evidence,null,2));
} catch (error) {
  process.exitCode = 1;
  const evidence = {status:'failed',code:error.code,message:error.message,observations,hostEvents};
  if(process.argv[3]) await writeFile(process.argv[3],JSON.stringify(evidence,null,2)+String.fromCharCode(10));
  console.error(error);
} finally {
  try { await transport?.dispose(); await parentHandle?.dispose(); await ctx.fiber.dispose(); }
  finally { clearTimeout(timeout);clearInterval(keepAlive); }
}
