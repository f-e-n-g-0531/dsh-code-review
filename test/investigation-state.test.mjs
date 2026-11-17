import test from 'node:test';
import assert from 'node:assert/strict';
import { createInvestigationState, createChildInvestigationCompactor } from '../src/investigation-state.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { retrievalLoop } from '../src/retrieval-loop.mjs';
const catalog = [{id:'a',side:'old',lineCount:20,hash:'h'}];
const row = (text='x'.repeat(5000)) => ({request:{kind:'read',id:'a',start:1,count:1},result:{snapshotId:'s',sourceId:'a',hash:'h',start:1,count:1,text}});
test('navigation is identity and side bound, detached and cannot be a receipt',()=>{
  const state=createInvestigationState(catalog,'s'), item=row(), compact=state.compact(item);
  assert.equal(compact.result.omitted,true); assert.equal(compact.result.text,undefined); assert.equal(compact.result.receipt,undefined);
  assert.equal(compact.navigation.side,'old'); assert.match(compact.navigation.bodyHash,/^[a-f0-9]{64}$/);
  for(const patch of [{snapshotId:'other'},{sourceId:'other'},{hash:'other'},{side:'new'}])assert.throws(()=>state.compact({...item,result:{...item.result,...patch}}),/identity mismatch/);
  assert.throws(()=>state.describe([{...compact,navigation:compact.navigation}]),/identity mismatch/);
  assert.equal(state.describe([compact]).trust,'navigation-only');
});
test('host projection preserves call pairing, latest delivery and unknown blocks without mutating history',()=>{
  const state=createInvestigationState(catalog,'s'), compactor=createChildInvestigationCompactor(state);
  const first={snapshotId:'s',results:[row()]},last={snapshotId:'s',results:[row('late')]};
  compactor.delivered(first); compactor.delivered(last);
  const block=text=>({type:'text',text:JSON.stringify(text)});
  const messages=[{role:'assistant',content:[block(first),{type:'tool-call',id:'1',name:'review_snapshot'}]},{role:'tool',toolCallId:'1',content:[block(first)]},{role:'tool',name:'review_snapshot',toolCallId:'2',content:[block(last)]}];
  const original=structuredClone(messages), options={messages,system:'fixed',tools:[{name:'review_snapshot'}]};
  assert.equal(compactor.compact(options),true); assert.deepEqual(messages,original); assert.equal(options.messages[1].toolCallId,'1');
  assert.equal(JSON.parse(options.messages[1].content[0].text).results.length,0);
  assert.equal(options.messages[0].content[0].text,original[0].content[0].text); assert.equal(options.messages[2].content[0].text,original[2].content[0].text);
  assert.equal(options.system,'fixed');
  const frozen=Object.freeze({messages});
  assert.equal(compactor.compact(frozen),false); assert.deepEqual(messages,original);
  const other=createChildInvestigationCompactor(createInvestigationState(catalog,'s'));
  assert.equal(other.compact({messages}),false);
});
test('surface replacement changes only bound successful old tool content, preserves identity and aborts before append',()=>{
 const compactor=createChildInvestigationCompactor(createInvestigationState(catalog,'s'),'child');
 const first={snapshotId:'s',results:[row()]},last={snapshotId:'s',results:[row('late')]};
 compactor.delivered(first);
 const original={seq:12,type:'tool/result',surfaceOp:'append',sourceEventSeqs:[11],data:{turn:'turn',step:1,message:{id:'message',role:'tool',source:{kind:'tool',callId:'call'},toolCallId:'call',isError:false,content:[{type:'text',text:JSON.stringify(first)}]}}};
 const snapshot=structuredClone(original);
 const call={seq:11,type:'tool/call',data:{callId:'call',name:'review_snapshot',turn:'turn',step:1}};
 compactor.observeEvent(call,'other');compactor.observeEvent(original,'other');
 assert.equal(compactor.replaceSurface({append(){assert.fail('foreign session');}}),0);
 compactor.observeEvent(call,'child');compactor.observeEvent(original,'child');compactor.delivered(last);
 compactor.observeEvent({...original,seq:13,data:{...original.data,message:{...original.data.message,isError:true}}});
 compactor.observeEvent({...original,seq:14,data:{...original.data,message:{...original.data.message,content:[{type:'text',text:'unmatched'}]}}});
 let calls=0;const aborted=new AbortController();aborted.abort();assert.throws(()=>compactor.replaceSurface({append(){calls++;}},aborted.signal),/abort/i);assert.equal(calls,0);
 assert.throws(()=>compactor.replaceSurface({append(){calls++;throw new Error('append failed');}}),/append failed/);assert.equal(calls,1);
 compactor.observeEvent({seq:21,type:'tool/call',data:{callId:'unknown',name:'structured_output',turn:'turn',step:1}},'child');
 compactor.observeEvent({...original,seq:22,sourceEventSeqs:[21],data:{...original.data,message:{...original.data.message,toolCallId:'unknown',source:{kind:'tool',callId:'unknown'}}}},'child');
 assert.throws(()=>compactor.observeEvent(call,'child'),/Duplicate/);
 const events=[];assert.equal(compactor.replaceSurface({append(...args){events.push(args);}}),1);assert.equal(events.length,1);
 const [type,data,options]=events[0];assert.equal(type,'tool/result');assert.equal(data.message.id,'message');assert.equal(data.message.toolCallId,'call');
 assert.deepEqual({...data,message:{...data.message,content:null}},{...original.data,message:{...original.data.message,content:null}});
 assert.deepEqual(options,{surfaceOp:{op:'replace',startSeq:12,endSeq:12},sourceEventSeqs:[12]});assert.deepEqual(original,snapshot);
 assert.equal(compactor.replaceSurface({append(){assert.fail('no duplicate');}}),0);
});
test('foreign session, duplicate calls, unknown tool same hash and latest multi-block result never replace',()=>{
 const state=createInvestigationState(catalog,'s'), c=createChildInvestigationCompactor(state,'owner');
 const first={snapshotId:'s',results:[row()]},last={snapshotId:'s',results:[row('latest'.repeat(1000))]};c.delivered(first);c.delivered(last);
 const call=(id,name='review_snapshot')=>({type:'tool/call',seq:1,data:{callId:id,name,turn:'t',step:1}});
 const result=(id,blocks)=>({type:'tool/result',seq:2,surfaceOp:'append',sourceEventSeqs:[1],data:{turn:'t',step:1,message:{role:'tool',id,toolCallId:id,source:{callId:id},isError:false,content:blocks}}});
 const block=value=>({type:'text',text:JSON.stringify(value)});
 c.observeEvent(call('foreign'),'other');c.observeEvent(result('foreign',[block(first)]),'other');
 c.observeEvent(call('unknown','structured_output'),'owner');c.observeEvent(result('unknown',[block(first)]),'owner');
 c.observeEvent(call('latest'),'owner');c.observeEvent(result('latest',[block(last),block(first)]),'owner');
 assert.equal(c.replaceSurface({append(){assert.fail('must not append');}}),0);
 assert.throws(()=>c.observeEvent(call('latest'),'owner'),/Duplicate/);
 const extra={type:'text',text:'unrelated block preserved'};
 c.observeEvent({...call('old'),seq:3},'owner');c.observeEvent({...result('old',[block(first),extra]),seq:4,sourceEventSeqs:[3]},'owner');
 const events=[];assert.equal(c.replaceSurface({append(...args){events.push(args);}}),1);assert.deepEqual(events[0][1].message.content[1],extra);
});
const makeScope = id=>createRetrievalScope({id,files:[],context:[{path:'a',text:Array.from({length:4},(_,i)=>String(i).repeat(4000)+'\n').join('')}]},{maxCalls:20,maxOutputBytes:100000});
const read = start=>({kind:'read',id:'s1',start,count:1});
test('capacity compression retains late entire batch, earlier navigation, ledger and no extra calls; concurrent chains isolated',async()=>{
  const run=async id=>{
    const scope=makeScope(id); let calls=0,chain;
    const result=await retrievalLoop(async request=>{
      const input=JSON.parse(request.input);calls++;
      assert.ok(Buffer.byteLength(request.input)+Buffer.byteLength(request.instructions)<=14000);
      if(calls===1)return{requests:[read(1)]};
      if(calls===2){chain=input.investigationState.chainId;return{requests:[read(2),read(3)]};}
      assert.equal(input.retrieved.length,3);assert.equal(input.retrieved[0].result.omitted,true);
      assert.equal(input.retrieved[1].result.text.length,4001);assert.equal(input.retrieved[2].result.text.length,4001);
      assert.equal(input.investigationState.checked.length,3);assert.equal(input.investigationState.chainId,chain);
      return{findings:[],limitations:['unresolved']};
    },{input:JSON.stringify({snapshotId:id}),instructions:'review'},scope,{enableInvestigationState:true,correctProtocol:true,maxRounds:4,maxInputBytes:14000});
    assert.equal(calls,3);assert.equal(scope.usage().calls,3);assert.ok(scope.usage().outputBytes>12000);assert.deepEqual(result.limitations,['unresolved']);return chain;
  };
  const [a,b]=await Promise.all([run('one'),run('two')]);assert.notEqual(a,b);
});
test('irreducible late batch fails partial without silently omitting it or making a recovery call',async()=>{
 const scope=makeScope('s');let calls=0;
 await assert.rejects(retrievalLoop(()=>{calls++;return{requests:[read(1),read(2),read(3)]};},{input:'{"snapshotId":"s"}',instructions:'review'},scope,{enableInvestigationState:true,correctProtocol:true,maxInputBytes:10000}),error=>error.code==='INVESTIGATION_INPUT_CAPACITY');
 assert.equal(calls,1);assert.equal(scope.usage().calls,3);assert.ok(scope.usage().outputBytes>12000);
});
test('opt-in cancellation after model result neither reads nor creates another call',async()=>{
 const controller=new AbortController(),scope=makeScope('s');let calls=0;
 await assert.rejects(retrievalLoop(()=>{calls++;controller.abort();return{requests:[read(1)]};},{input:'{"snapshotId":"s"}',instructions:'review',signal:controller.signal},scope,{enableInvestigationState:true}),/abort/i);
 assert.equal(calls,1);assert.equal(scope.usage().calls,0);
});
