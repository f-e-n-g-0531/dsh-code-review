import test from 'node:test';
import assert from 'node:assert/strict';
import { modelJson } from '../src/model-json.mjs';
import { createDshModel } from '../src/dsh-model.mjs';
import { providerDiagnostic, jsonSyntaxDiagnostic } from '../src/model-diagnostics.mjs';
import { reviewSnapshot } from '../src/review.mjs';

const route = {provider:'p',model:'m'};
const request = {instructions:'review',input:JSON.stringify({file:{id:'f'}})};
const stop = {type:'finish',reason:{kind:'stop'}};
const snapshot={id:'s',vcs:'git',context:[],files:[{id:'f',path:'a.js',eligibility:'reviewable',properties:[],left:{text:'old();'},right:{text:'new();'}}]};

function rejected(text) { try { modelJson(text);assert.fail('must reject'); } catch(error) { assert.equal(error.code,'MODEL_INVALID_JSON');return error; } }
test('JSON failure retains exact UTF16 body position and hash without response or native error echo',()=>{
 const body='{\n  "SECRET😀": 1,\n  broken: 2\n}';
 const error=rejected('```json\n'+body+'\n```');
 assert.equal(error.diagnostic.syntaxCategory,'property-name');assert.equal(error.diagnostic.line,3);assert.equal(error.diagnostic.column,3);assert.equal(error.diagnostic.offset,body.indexOf('broken'));assert.match(error.diagnostic.responseHash,/^[a-f0-9]{64}$/);assert.equal(error.diagnostic.offsetUnit,'utf16-code-unit-in-json-body');assert.ok(!JSON.stringify(error).includes('SECRET'));assert.ok(!error.message.includes('SECRET'));
 assert.notEqual(rejected('{other:1}').diagnostic.responseHash,error.diagnostic.responseHash);
});
test('parser locations count CR, LF and CRLF as JSON line boundaries',()=>{
 for(const newline of ['\r','\n','\r\n']){const body='{'+newline+'  bad:1}';const d=rejected(body).diagnostic;assert.equal(d.offset,body.indexOf('bad'));assert.equal(d.line,2);assert.equal(d.column,3);}
});
test('strict JSON diagnostics classify syntax faults but never fix them',()=>{
 for(const [body,category]of [['{bad:1}','property-name'],['{"x" 1}','colon'],['{"x":1 "y":2}','separator'],['{"x":"\\q"}','invalid-escape'],['{"x":"a\nb"}','control-character'],['{"x":"a','unterminated-string'],['','unexpected-end'],['{} {}','trailing-content']]){const error=rejected(body);assert.equal(error.diagnostic.syntaxCategory,category,body);}
 const unknown=jsonSyntaxDiagnostic('secret',new SyntaxError('Localized or future runtime message'));assert.equal(unknown.syntaxCategory,'syntax');assert.equal(unknown.offset,undefined);
 assert.equal(modelJson('{"n":900719925474099312345}'),'{"n":900719925474099312345}');
});
test('correction uses trusted syntax feedback from last attempt and never replays malformed output',async()=>{
 const calls=[],events=[];const model=createDshModel({async *stream(req){calls.push(req);yield {type:'text-delta',text:calls.length===1?'{SECRET:1}':calls.length===2?'{"x" 1}':'{"findings":[],"limitations":[]}'};yield stop;}},route,{correctJson:true});
 assert.equal(await model({...request,onProtocolCorrection:e=>events.push(e)}),'{"findings":[],"limitations":[]}');assert.equal(calls.length,3);assert.match(calls[1].system,/property-name/);assert.match(calls[1].system,/JSON正文第1行/);assert.match(calls[2].system,/colon/);assert.doesNotMatch(calls[2].system,/property-name/);
 for(const req of calls){assert.equal(req.messages[0].content[0].text,request.input);assert.ok(!JSON.stringify(req).includes('SECRET'));assert.equal(req.responseFormat,undefined);assert.deepEqual(req.tools,[]);}
 assert.equal(events.length,2);
});
test('real finish.reason.failure survives into failed report without provider raw message or ID',async()=>{
 let calls=0;const model=createDshModel({async *stream(){calls++;yield {type:'finish',reason:{kind:'error',failure:{code:'CONTEXT_WINDOW_EXCEEDED',message:'SECRET https://example/?token=secret',status:400,requestId:'SECRET-id',providerRetryAfterMs:1200}}};}},route,{correctJson:true});
 const report=await reviewSnapshot(snapshot,model,{enableRetrieval:true});const f=report.files[0];assert.equal(calls,1);assert.equal(f.status,'failed');assert.equal(f.failureCode,'MODEL_INCOMPLETE_OUTPUT');assert.equal(f.protocolDiagnostic.providerCode,'CONTEXT_WINDOW_EXCEEDED');assert.equal(f.protocolDiagnostic.providerStatus,400);assert.equal(f.protocolDiagnostic.providerRetryAfterMs,1200);assert.match(f.protocolDiagnostic.providerRequestIdHash,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(report).includes('SECRET'));assert.equal(report.coverage.completed,0);
});
test('thrown provider error keeps exact identity and safe structured metadata, no retry',async()=>{
 let calls=0;const expected=Object.assign(new Error('provider failure'),{code:'RATE_LIMIT',failure:{code:'RATE_LIMIT',status:429,providerRetryAfterMs:1000,requestId:'secret-request',message:'SECRET'}});
 const model=createDshModel({stream(){calls++;throw expected;}},route,{correctJson:true});await assert.rejects(model(request),e=>{assert.equal(e,expected);assert.equal(e.diagnostic.providerCode,'RATE_LIMIT');assert.equal(e.diagnostic.providerStatus,429);assert.ok(!JSON.stringify(e.diagnostic).includes('SECRET'));return true;});assert.equal(calls,1);
});
test('provider diagnostics reject unsafe codes, URLs, invalid ranges and accessor-backed metadata',()=>{
 const d=providerDiagnostic({failure:{code:'SECRET https://example',status:999,providerRetryAfterMs:-1,requestId:'SECRET'}});assert.equal(d.providerCode,'UNRECOGNIZED');assert.match(d.providerCodeHash,/^[a-f0-9]{64}$/);assert.equal(d.providerStatus,undefined);assert.equal(d.providerRetryAfterMs,undefined);assert.ok(!JSON.stringify(d).includes('SECRET'));
 const value={};Object.defineProperty(value,'failure',{get(){throw Error('must not run');}});assert.deepEqual(providerDiagnostic(value),{});
});
test('callback mutations cannot affect private syntax diagnostics or inject prompt text',async()=>{
 let calls=0;const requests=[];const model=createDshModel({async *stream(req){requests.push(req);calls++;yield {type:'text-delta',text:'{bad:1}'};yield stop;}},route,{correctJson:true});
 await assert.rejects(model({...request,onProtocolCorrection(event){event.diagnostic.syntaxCategory={ [Symbol.toPrimitive](hint){return hint==='string'?'colon':'SECRET_CALLBACK';} };event.diagnostic.line=999;event.attempts[0].diagnostic.syntaxCategory='colon';event.attempts.push({diagnostic:{syntaxCategory:'SECRET_CALLBACK'}});}}),e=>{assert.equal(e.attempts.length,3);assert.equal(e.attempts[0].diagnostic.syntaxCategory,'property-name');return true;});
 assert.equal(calls,3);for(const req of requests.slice(1)){assert.match(req.system,/property-name/);assert.doesNotMatch(req.system,/SECRET_CALLBACK|第999行/);}
});
test('provider code or diagnostic getters cannot replace the original failure on initial or corrective calls',async()=>{
 for(const timing of [1,2])for(const key of ['code','diagnostic','attempts']){const expected=new Error('original');Object.defineProperty(expected,key,{get(){throw Error('getter');},set(){throw Error('setter');}});let calls=0;const model=createDshModel({async *stream(){if(++calls===timing)throw expected;yield {type:'text-delta',text:'{bad:1}'};yield stop;}},route,{correctJson:true});await assert.rejects(model(request),e=>e===expected);assert.equal(calls,timing);}
});
test('diagnostics do not replace frozen primitive or proxy thrown failures',async()=>{
 const proxy=new Proxy({}, {isExtensible(){throw Error('trap');}});for(const error of [Object.freeze(new Error('frozen')),null,'primitive',proxy]){const model=createDshModel({stream(){throw error;}},route,{correctJson:true});await assert.rejects(model(request),actual=>actual===error);}
});
