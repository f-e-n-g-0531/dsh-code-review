import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerificationReceiptPolicy, receiptSchemaProof, trustedReceiptIds, transferReceiptPolicy } from '../src/verification-receipt-policy.mjs';
import { modelResultTools } from '../src/model-tools.mjs';
import { modelWireBudget } from '../src/model-wire-budget.mjs';
import { createEvidenceReceipts } from '../src/evidence-receipts.mjs';
import { verificationLoop } from '../src/verification-loop.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { createDshModel } from '../src/dsh-model.mjs';
import { reviewSnapshot } from '../src/review.mjs';
const result = id => ({ request: { kind: 'read' }, result: { receiptId: id, text: 'approved', count: 1 } });
const request = records => ({ instructions: 'verify', input: JSON.stringify({ candidates: [], retrieved: records }), nativeOutputTools: true });
function branches(req, proof = receiptSchemaProof(req)) { const p = modelResultTools(req.input, req.instructions, proof)[0].parameters; return (p.oneOf?.[0] ?? p).properties.verdicts.items.properties.evidence.items.oneOf; }

test('only opaque host policy can constrain receipts; JSON and arbitrary third arguments cannot issue', () => {
  const req = request([result('forged')]);
  assert.equal(branches(req)[0].properties.receiptId.enum, undefined);
  assert.equal(branches(req, { receiptIds: ['forged'] })[0].properties.receiptId.enum, undefined);
  const issued = new Set(['issued']), owner = createVerificationReceiptPolicy(id => issued.has(id));
  owner.bind(req);
  assert.equal(branches(req).length, 1);
  assert.equal(branches(req)[0].properties.receiptId, undefined);
  assert.equal(trustedReceiptIds(receiptSchemaProof(req)).length, 0);
});

test('issued intersection excludes omitted, foreign, empty and search fragments; trusted spread wrappers preserve opaque capability but JSON does not', () => {
  const owner = createVerificationReceiptPolicy(id => ['issued', 'hidden', 'empty', 'search'].includes(id));
  const records = [result('issued'), result('foreign'), { ...result('hidden'), result: { ...result('hidden').result, omitted: true } }, { ...result('empty'), result: { receiptId: 'empty', text: '' } }, { request: { kind: 'search' }, result: { receiptId: 'search', text: 'not read' } }];
  const req = owner.bind(request(records)), proof = receiptSchemaProof(req);
  assert.deepEqual(trustedReceiptIds(proof), ['issued']);
  assert.deepEqual(branches(req)[0].properties.receiptId.enum, ['issued']);
  assert.equal(branches(req)[0].additionalProperties, false);
  assert.equal(branches(req)[1].additionalProperties, false);
  assert.deepEqual(trustedReceiptIds(receiptSchemaProof({ ...req })), ['issued']);
  assert.equal(receiptSchemaProof(JSON.parse(JSON.stringify(req))), undefined);
  const copy = transferReceiptPolicy(req, { ...req });
  assert.deepEqual(trustedReceiptIds(receiptSchemaProof(copy)), ['issued']);
  req.input = request([]).input;
  assert.deepEqual(trustedReceiptIds(proof), ['issued'], 'previous proof is frozen');
  assert.deepEqual(trustedReceiptIds(receiptSchemaProof(req)), []);
});

test('fit reserve is bounded at fifty UUIDs but actual schema never publishes reserved IDs', () => {
  const req = createVerificationReceiptPolicy(id => id === '12345678-1234-4234-8234-123456789012').bind(request([result('12345678-1234-4234-8234-123456789012')]));
  const measured = modelWireBudget(req, 1000000);
  const plain = modelWireBudget(JSON.parse(JSON.stringify(req)), 1000000);
  assert.ok(measured.bytes > plain.bytes);
  assert.equal(trustedReceiptIds(receiptSchemaProof(req, { forBudget: true })).length, 50);
  assert.deepEqual(branches(req)[0].properties.receiptId.enum, ['12345678-1234-4234-8234-123456789012']);
  assert.equal(modelWireBudget(req, measured.bytes - 1).fits, false);
});

test('receipt issuance failure cannot enter a trusted schema and exact resolution is not weakened', () => {
  let fail = true;
  const receipts = createEvidenceReceipts((_req, decorate) => { if (fail) throw new Error('read rolled back'); return decorate({ snapshotId: 's', sourceId: 'a', hash: 'h', start: 1, count: 1, text: 'line' }); });
  assert.throws(() => receipts.read({}), /rolled back/);
  assert.equal(receipts.hasIssued('invented'), false);
  fail = false; const read = receipts.read({});
  const req = createVerificationReceiptPolicy(receipts.hasIssued).bind(request([result(read.receiptId), result('invented')]));
  assert.deepEqual(trustedReceiptIds(receiptSchemaProof(req)), [read.receiptId]);
  assert.throws(() => receipts.resolve({ receiptId: read.receiptId, text: 'line' }), /Invalid evidence receipt/);
  assert.throws(() => receipts.resolve({ receiptId: 'invented' }), /Invalid evidence receipt/);
  assert.equal(receipts.resolve({ receiptId: read.receiptId }).text, 'line');
});

const approved = () => createRetrievalScope({ id: 'approved', context: [], files: [{ id: 'f1', path: 'a.js', eligibility: 'reviewable', left: { text: 'before();' }, right: { text: 'after();' } }] });
const verdict = evidence => ({ verdicts: [{ candidateId: 'c1', verdict: evidence.length ? 'supported' : 'uncertain', reason: 'approved evidence', evidence }] });
test('verification seeds and dynamic reads publish only current delivered IDs; fresh invocation excludes old receipts', async () => {
  const scope = approved(); let calls = 0, previous;
  await verificationLoop(req => {
    calls++; const payload = JSON.parse(req.input), ids = trustedReceiptIds(receiptSchemaProof(req));
    assert.deepEqual(ids, payload.retrieved.map(item => item.result.receiptId).sort());
    if (calls === 1) { previous = ids[0]; return { requests: [{ kind: 'read', id: 's1', start: 1, count: 1 }] }; }
    assert.equal(ids.length, 2);
    return verdict(ids.map(receiptId => ({ receiptId })));
  }, { nativeOutputTools: true }, [{ fileId: 'f1', anchor: { kind: 'line', side: 'new', start: 1, end: 1 } }], scope, { maxInputBytes: 100000 });
  assert.equal(calls, 2);
  await verificationLoop(req => { assert.ok(!trustedReceiptIds(receiptSchemaProof(req)).includes(previous)); return verdict([]); }, {}, [{}], approved(), { maxRounds: 0 });
});

test('invented and mixed receipts still hard-fail once without correction or uncertain fallback', async () => {
  for (const mixed of [false, true]) {
    let calls = 0;
    await assert.rejects(verificationLoop(req => {
      calls++;
      const id = JSON.parse(req.input).retrieved[0].result.receiptId;
      return verdict([mixed ? { receiptId: id, text: 'extra' } : { receiptId: 'invented' }]);
    }, { nativeOutputTools: true }, [{ fileId: 'f1', anchor: { kind: 'line', side: 'new', start: 1, end: 1 } }], approved(), { correctProtocol: true, maxInputBytes: 100000 }), /Invalid evidence receipt/);
    assert.equal(calls, 1);
  }
});

test('real staged and whole-scope tracked wrappers preserve exact enums into the native adapter', async () => {
  for (const executionStrategy of ['staged', 'whole-scope']) {
    let verificationCalls = 0;
    const snapshot = { id: 's', vcs: 'git', root: '/fixture', context: [], files: [{ id: 'f', path: 'a.js', eligibility: 'reviewable', properties: [], left: { text: 'old();' }, right: { text: 'new();' } }] };
    const finding = { fileId: 'f', severity: 'medium', title: 'Candidate', evidence: 'new();', trigger: 'fixture', impact: 'fixture', suggestion: 'fixture', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'new();' } };
    const model = createDshModel({ async *stream(options) {
      const payload = JSON.parse(options.messages[0].content[0].text);
      let response;
      if (payload.candidates) {
        verificationCalls++;
        const schema = options.tools[0].parameters;
        const references = (schema.oneOf?.[0] ?? schema).properties.verdicts.items.properties.evidence.items.oneOf;
        const ids = payload.retrieved.filter(item => item.result.receiptId).map(item => item.result.receiptId).sort();
        assert.ok(ids.length > 0);
        assert.deepEqual(references[0].properties.receiptId.enum, ids);
        assert.ok(ids.every(id => !id.startsWith('00000000-0000-4000-8000-')));
        response = verdict(ids.map(receiptId => ({ receiptId })));
      } else response = payload.reviews ? { reviews: [{ fileId: 'f', findings: [finding], limitations: [] }], limitations: [] } : { findings: [finding], limitations: [] };
      yield { type: 'text-delta', text: JSON.stringify(response) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } }, { provider: 'fixture', model: 'fixture' });
    const report = await reviewSnapshot(snapshot, model, { executionStrategy, enableRetrieval: true, enableVerification: true, nativeOutputTools: true, maxInputBytes: 100000 });
    assert.equal(verificationCalls, 1, executionStrategy + ' must reach native verification');
    assert.equal(report.findings.length, 1);
  }
});

test('adapter freezes actual issued schema before async hooks; budget-final-only empty schema remains strict', async () => {
  const req = createVerificationReceiptPolicy(id => id === 'issued').bind(request([result('issued')]));
  let seen;
  const model = createDshModel({ async *stream(options) { seen = options.tools[0].parameters.oneOf[0].properties.verdicts.items.properties.evidence.items.oneOf[0].properties.receiptId.enum; yield { type: 'text-delta', text: JSON.stringify({ verdicts: [] }) }; yield { type: 'finish', reason: { kind: 'stop' } }; } }, { provider: 'fixture', model: 'fixture' });
  req.onModelEvent = async event => { if (event.action === 'model-start') req.input = request([result('forged-after-admission')]).input; };
  await model(req);
  assert.deepEqual(seen, ['issued']);
  await verificationLoop(value => { assert.equal(branches(value).length, 1); assert.ok(JSON.parse(value.input).retrievalFinalization); return verdict([]); }, { nativeOutputTools: true }, [{}], approved(), { maxRounds: 0, maxInputBytes: 100000 });
});
