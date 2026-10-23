import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshModel } from '../src/dsh-model.mjs';
import { reviewDiagnostics, diagnosticsMarkdown } from '../src/review-diagnostics.mjs';
const route = { provider: 'offline', model: 'scripted' };
const request = { instructions: 'review', input: '{}' };

test('huge invalid JSON exposes local semantic issue without response or error text', async () => {
  const modelEvents = [], protocolEvents = [], reservations = []; let calls = 0;
  const model = createDshModel({ async *stream() {
    calls++;
    yield { type: 'text-delta', text: calls === 1 ? '{"PRIVATE_SENTINEL_' + 'x'.repeat(200000) + '":1,}' : '{}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }, route, { correctJson: true, maxOutputBytes: 300000 });
  assert.equal(await model({ ...request, onModelEvent: e => modelEvents.push(e), onProtocolCorrection: e => reservations.push(e), onProtocolEvent: e => protocolEvents.push(e) }), '{}');
  assert.equal(calls, 2);
  const failed = modelEvents.find(e => e.action === 'model-end');
  assert.equal(failed.failureCode, 'MODEL_INVALID_JSON');
  assert.equal(failed.jsonIssue, 'property-name');
  assert.equal(reservations[0].type, 'json-syntax');
  assert.equal(reservations[0].code, 'MODEL_INVALID_JSON');
  assert.equal(reservations[0].attempt, 2);
  assert.equal(protocolEvents.length, 1);
  assert.equal(protocolEvents[0].action, 'json-correction-complete');
  assert.equal(reservations[0].jsonIssue, 'property-name');
  assert.equal(modelEvents.filter(e => e.action === 'model-end' && e.callPurpose === 'json-correction').length, 1);
  assert.ok(JSON.stringify({modelEvents,protocolEvents,reservations}).length < 7000);
  assert.ok(!JSON.stringify({modelEvents,protocolEvents,reservations}).includes('PRIVATE_SENTINEL'));
});

test('cancel or reservation veto does not emit actual correction-start event', async () => {
  const events = [], veto = new Error('private budget veto'); let calls = 0;
  const model = createDshModel({ async *stream() { calls++; yield {type:'text-delta',text:'{bad'}; yield {type:'finish',reason:{kind:'stop'}}; } }, route, {correctJson:true});
  await assert.rejects(model({...request,onProtocolEvent:e=>events.push(e),onProtocolCorrection(){throw veto;}}),e=>e===veto);
  assert.equal(calls,1); assert.deepEqual(events,[]);
});

test('local output and finish failures get safe codes but forged provider metadata does not', async () => {
  for (const kind of ['incomplete','length','limit','provider']) {
    const events = [], providerError = Object.assign(new Error('PRIVATE_RESPONSE'), {code:'MODEL_INVALID_JSON',diagnostic:{syntaxCategory:'PRIVATE_RESPONSE'}});
    const model = createDshModel({ async *stream() {
      if(kind==='provider')throw providerError;
      yield {type:'text-delta',text:'{}'};
      if(kind!=='incomplete')yield {type:'finish',reason:{kind:kind==='length'?'length':'stop'}};
    } }, route, {maxOutputBytes:kind==='limit'?1:100});
    await assert.rejects(model({...request,onModelEvent:e=>events.push(e)}));
    const end=events.find(e=>e.action==='model-end');
    assert.equal(end.failureCode,({incomplete:'MODEL_INCOMPLETE_OUTPUT',length:'MODEL_INCOMPLETE_OUTPUT',limit:'MODEL_OUTPUT_LIMIT'})[kind]);
    assert.equal(end.jsonIssue,undefined);
    assert.ok(!JSON.stringify(events).includes('PRIVATE_RESPONSE'));
  }
});

test('diagnostics count only correction starts and redact nonallowlisted fields', () => {
  const d=reviewDiagnostics({maxRetrievalRounds:3,files:[{
    modelCorrections:[
      {action:'explicit-json-correction',code:'MODEL_INVALID_JSON',jsonIssue:'separator',errorText:'PRIVATE'},
      {action:'model-end',code:'MODEL_INVALID_JSON',jsonIssue:'separator'},
      {action:'json-correction-complete',code:'MODEL_INVALID_JSON',jsonIssue:'separator'},
      {action:'review-format-correction',code:'MODEL_INVALID_ANCHOR',jsonIssue:'PRIVATE'},
      {action:'retrieval-protocol-correction',code:'RETRIEVAL_PROTOCOL_ERROR'},
      {action:'explicit-json-correction',code:'PRIVATE',jsonIssue:'PRIVATE'},
    ],
    retrievalLimits:[{code:'READER_CALL_BUDGET_EXCEEDED'},{code:'READER_OUTPUT_BUDGET_EXCEEDED'},{code:'RETRIEVAL_ROUND_BUDGET_EXCEEDED'},{code:'PRIVATE'}],
    riskPlanningFallbackReason:'input-budget',
  },{modelCorrections:[{action:'explicit-json-correction',code:'MODEL_INVALID_JSON',jsonIssue:'separator'}],riskPlanningFallbackReason:'PRIVATE'}]});
  assert.deepEqual(d.correctionReasons,[{code:'MODEL_INVALID_ANCHOR',jsonIssue:null,calls:1},{code:'MODEL_INVALID_JSON',jsonIssue:'separator',calls:2},{code:'RETRIEVAL_PROTOCOL_ERROR',jsonIssue:null,calls:1}]);
  assert.deepEqual(d.readerLimitReasons.map(r=>r.code),['READER_CALL_BUDGET_EXCEEDED','READER_OUTPUT_BUDGET_EXCEEDED','RETRIEVAL_ROUND_BUDGET_EXCEEDED']);
  assert.equal(d.readerLimits.maxRounds,3);
  assert.deepEqual(d.riskPlanningFallbackReasons,[{reason:'input-budget',calls:1}]);
  assert.ok(!JSON.stringify(d).includes('PRIVATE'));
  assert.match(diagnosticsMarkdown(d).join(' '),/READER_OUTPUT_BUDGET_EXCEEDED/);
  assert.match(d.callPurposeNotice,/not only primary/);
  assert.equal(reviewDiagnostics({}).readerLimits.maxRounds,null);
});

test('failed correction invocations retain their cause once without counting completion notifications', async () => {
  const state={modelCorrections:[]}; let pending, calls=0;
  const model=createDshModel({async *stream(){calls++;yield{type:'text-delta',text:'{"a":1,}'};yield{type:'finish',reason:{kind:'stop'}};}},route,{correctJson:true,maxJsonCorrections:1});
  await assert.rejects(model({...request,
    onProtocolCorrection(info){pending=info;},
    onModelEvent(event){if(event.action==='model-end'&&event.callPurpose==='json-correction')state.modelCorrections.push({action:'explicit-json-correction',code:pending.code,jsonIssue:pending.jsonIssue});},
  }),{code:'MODEL_INVALID_JSON'});
  assert.equal(calls,2);
  assert.deepEqual(reviewDiagnostics({files:[state]}).correctionReasons,[{code:'MODEL_INVALID_JSON',jsonIssue:'property-name',calls:1}]);
});
