import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareGroupPrimary, validateGroupPrimary } from '../src/group-primary.mjs';
import { validateGroupInteraction } from '../src/group-interaction.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { configureWireBudget, modelWireBudget } from '../src/model-wire-budget.mjs';
import { modelResultTools, validateNativeResult } from '../src/model-tools.mjs';
import { modelContract } from '../src/model-contract.mjs';
import { retrievalRequest } from '../src/retrieval-loop.mjs';
import { createDshModel } from '../src/dsh-model.mjs';
import { validateFindings, reviewSnapshot } from '../src/review.mjs';

const snapshot = () => ({ id: 'group-channel', vcs: 'git', context: [], files: ['a', 'b', 'outside'].map(id => ({ id, path: id + '.js', eligibility: 'reviewable', properties: [], left: { text: 'guard();\n' }, right: { text: 'unsafe();\n' } })) });
const finding = () => ({ fileId: 'a', severity: 'high', title: 'Combined contract', evidence: 'Two changed guards', trigger: 'Missing input', impact: 'Invalid state', suggestion: 'Align guards', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'unsafe();' }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: 'guarded', afterBehavior: 'unguarded', reason: 'combined edits' }, interaction: { editRefs: [{ fileId: 'a', editId: 'e1' }, { fileId: 'b', editId: 'e1' }] } });
function fixture({ native = false, enabled = true, ids = ['a', 'b'] } = {}) {
  const input = snapshot(), group = { id: 'g1', fileIds: ids }, scope = configureWireBudget(createRetrievalScope(input), { nativeOutputTools: native });
  const prepared = prepareGroupPrimary(input, group, { scope, instructions: 'Review approved snapshot', maxInputBytes: 98304, enableGroupInteractions: enabled });
  const response = { reviews: ids.map(fileId => ({ fileId, findings: [], limitations: [] })), limitations: [], interactions: { groupId: 'g1', findings: [finding()], limitations: [] } };
  const reads = ids.map(id => { const source = scope.catalog().find(source => source.fileId === id && source.side === 'new'), result = scope.read({ id: source.id, start: 1, count: 1 }); return { kind: 'read', snapshotId: input.id, sourceId: result.sourceId, hash: result.hash, start: 1, count: 1 }; });
  return { input, group, scope, prepared, response, reads, check(value = response, audit = reads, catalog = scope.catalog()) { return validateGroupInteraction(value, prepared, input, audit, catalog); } };
}

test('actual accepted group channel replaces only matching interaction generation and still independently verifies its candidate', async () => {
  async function run(enableGroupInteractions, channel = 'valid') {
    const input = snapshot(); input.files.pop(); input.files[0].path = 'src/a.js'; input.files[1].path = 'test/a.test.js';
    const seen = [];
    const report = await reviewSnapshot(input, request => {
      const p = JSON.parse(request.input); seen.push({ request, p });
      if (request.reviewPhase === 'verification') {
        const item = p.retrieved.find(item => item.result.receiptId); assert.ok(item);
        return { verdicts: [{ candidateId: 'c1', verdict: 'refuted', reason: 'Independent counterevidence', evidence: [{ receiptId: item.result.receiptId }] }] };
      }
      const sources = p.catalog.filter(source => source.side === 'new');
      if (!p.retrieved.length) return { requests: sources.map(source => ({ kind: 'read', id: source.id, start: 1, count: 1 })) };
      if (p.sourceMode === 'group-primary') return { reviews: p.reviews.map(row => ({ fileId: row.fileId, findings: [], limitations: [] })), limitations: [], ...(enableGroupInteractions ? { interactions: channel === 'invalid' ? { groupId: 'foreign', findings: [], limitations: [] } : { groupId: p.groupId, findings: [finding()], limitations: [] } } : {}) };
      assert.equal(p.sourceMode, 'file-interaction'); return { findings: [finding()], limitations: [] };
    }, { enableRetrieval: true, enableGrouping: true, enableGroupPrimary: true, enableGroupInteractions, enableVerification: true, optimizeReviewCalls: true, changesConcurrency: 1 });
    return { report, seen };
  }
  const off = await run(false), on = await run(true), invalid = await run(true, 'invalid');
  assert.equal(off.report.modelCalls, 5); assert.equal(on.report.modelCalls, 3); assert.equal(invalid.report.modelCalls, 5);
  for (const result of [off, on, invalid]) {
    assert.equal(result.report.status, 'completed'); assert.equal(result.report.interactions[0].status, 'completed'); assert.equal(result.report.findings.length, 1);
    assert.equal(result.report.findings[0].verification.verdict, 'refuted'); assert.deepEqual(result.report.coverage, off.report.coverage);
    assert.equal(result.seen.filter(item => item.p.sourceMode === 'group-primary').length, 2, 'no failed optional channel causes hidden primary rerun');
    assert.equal(result.seen.filter(item => item.request.reviewPhase === 'verification').length, 1);
  }
  assert.equal(on.seen.filter(item => item.p.sourceMode === 'file-interaction').length, 0);
  assert.equal(invalid.seen.filter(item => item.p.sourceMode === 'file-interaction').length, 2);
  assert.deepEqual(on.report.findings, off.report.findings);
});

test('optional group result accepts only independently validated multi-file edit reads and preserves primary identity', () => {
  const f = fixture(), before = structuredClone(f.response);
  const primary = validateGroupPrimary(f.response, f.prepared, f.input, validateFindings, f.scope.catalog());
  const result = f.check(); assert.equal(result.status, 'accepted'); assert.equal(result.groupId, 'g1');
  assert.equal(result.findings.length, 1); assert.equal(result.findings[0].interaction.status, 'references-and-reads-validated');
  assert.equal(result.findings[0].interaction.causality, 'unverified'); assert.deepEqual(result.findings[0].anchor, finding().anchor);
  assert.deepEqual([...primary.keys()], ['a', 'b']); assert.deepEqual(f.response, before);
});

test('missing invalid wrong-group duplicate and row interaction channels never erase valid primaries', () => {
  const f = fixture();
  const primaryFinding = finding(); delete primaryFinding.interaction; f.response.reviews[0].findings.push(primaryFinding);
  for (const mutate of [value => { delete value.interactions; }, value => { value.interactions = null; }, value => { value.interactions = [value.interactions]; }, value => { value.interactions.groupId = 'foreign'; }, value => { value.interactions.extra = true; }, value => { value.interactions.findings.push(finding()); }, value => { value.interactions.findings[0].interaction.editRefs[1].fileId = 'outside'; }]) {
    const value = structuredClone(f.response); mutate(value);
    const primary = validateGroupPrimary(value, f.prepared, f.input, validateFindings, f.scope.catalog());
    assert.equal(primary.size, 2); assert.equal(primary.get('a').findings[0].title, primaryFinding.title); assert.equal(f.check(value).status, 'fallback'); assert.deepEqual(f.check(value).findings, []);
  }
  const value = structuredClone(f.response); value.reviews[0].findings = [finding()];
  assert.throws(() => validateGroupPrimary(value, f.prepared, f.input, validateFindings), /cannot bypass/);
  assert.equal(f.check(value).status, 'fallback');
});

test('partial duplicate foreign member sets and incomplete current-generation evidence fall back', () => {
  const f = fixture();
  for (const rows of [f.response.reviews.slice(0, 1), [f.response.reviews[0], f.response.reviews[0]], [f.response.reviews[0], { fileId: 'outside', findings: [], limitations: [] }]]) {
    assert.equal(f.check({ ...f.response, reviews: rows }).status, 'fallback');
    assert.throws(() => validateGroupPrimary({ ...f.response, reviews: rows }, f.prepared, f.input, validateFindings));
  }
  for (const reads of [[], f.reads.slice(0, 1), f.reads.map(read => ({ ...read, snapshotId: 'foreign' })), f.reads.map(read => ({ ...read, hash: '0'.repeat(64) })), f.reads.map(read => ({ ...read, sourceId: 'foreign' })), f.reads.map(read => ({ ...read, omitted: true })), f.reads.map(read => ({ ...read, start: 2 }))]) assert.equal(f.check(f.response, reads).status, 'fallback');
  assert.equal(f.check(f.response, f.reads, [...f.scope.catalog(), f.scope.catalog()[0]]).status, 'fallback');
});

test('changed snapshot bodies and stale prepared member identities cannot transfer acceptance', () => {
  const f = fixture();
  const changed = structuredClone(f.input); changed.files[0].right.text = 'different();\n';
  assert.equal(validateGroupInteraction(f.response, f.prepared, changed, f.reads, f.scope.catalog()).status, 'fallback');
  const foreign = { ...f.input, id: 'foreign' };
  assert.equal(validateGroupInteraction(f.response, f.prepared, foreign, f.reads, f.scope.catalog()).status, 'fallback');
});

test('host-bound migration regression schema permits only an optional listed ID, never a model-supplied role contract', () => {
  const input = JSON.stringify({ candidates: [], migrationContracts: [{ id: 'migration-1' }] });
  const final = modelResultTools(input)[0].parameters.oneOf[0];
  const regression = final.properties.verdicts.items.properties.regression;
  assert.deepEqual(regression.required, ['classification', 'reason', 'oldEvidence', 'newEvidence']);
  assert.deepEqual(regression.properties.migrationContractId.enum, ['migration-1']); assert.equal(regression.properties.migrationContractId.maxLength, 200);
  assert.equal(regression.additionalProperties, false); assert.equal(regression.properties.contract, undefined);
  assert.match(modelContract(input), /migrationContractId/); assert.doesNotMatch(modelContract('{"candidates":[]}'), /migrationContractId/);
  const ordinary = modelResultTools('{"candidates":[]}')[0].parameters.oneOf[0].properties.verdicts.items.properties.regression;
  assert.equal(ordinary.type, 'object'); assert.equal(ordinary.additionalProperties, false);
  assert.deepEqual(Object.keys(ordinary.properties), ['classification', 'reason', 'oldEvidence', 'newEvidence']);
  assert.equal(ordinary.properties.migrationContractId, undefined);
});

test('empty result and subset findings cannot replace a full group with an unread third member', () => {
  const f = fixture({ ids: ['a', 'b', 'outside'] });
  assert.equal(f.check(f.response, f.reads.slice(0, 2)).status, 'fallback');
  const empty = { ...f.response, interactions: { groupId: 'g1', findings: [], limitations: [] } };
  assert.equal(f.check(empty, []).status, 'fallback'); assert.equal(f.check(empty, f.reads).status, 'accepted');
});

test('disabled policy and exact wire-boundary fallback preserve old full-body group and never force windows', () => {
  const f = fixture({ native: true }), old = fixture({ native: true, enabled: false });
  assert.equal(old.prepared.groupInteraction, undefined); assert.equal(old.check().status, 'disabled');
  assert.equal(JSON.parse(old.prepared.payload).groupInteraction, undefined);
  const actual = retrievalRequest({ input: f.prepared.payload, instructions: f.prepared.instructions, nativeOutputTools: true }, f.scope, [], {max:3,remaining:3});
  const bytes = modelWireBudget(actual, 98304).bytes;
  const prepare = maxInputBytes => prepareGroupPrimary(f.input, f.group, { scope: f.scope, instructions: 'Review approved snapshot', maxInputBytes, enableGroupInteractions: true });
  assert.equal(prepare(bytes).groupInteraction, true);
  const fallback = prepare(bytes - 1); assert.ok(fallback); assert.equal(fallback.groupInteraction, false); assert.equal(JSON.parse(fallback.payload).groupInteraction, undefined);
  assert.equal(fallback.payload, old.prepared.payload); assert.equal(fallback.instructions, old.prepared.instructions);
  assert.throws(() => prepareGroupPrimary(f.input, f.group, { scope: f.scope, instructions: '', maxInputBytes: 98304, enableGroupInteractions: 'true' }), /option/);
});

test('native and text contracts expose optional channel only under approved prepared marker', async () => {
  const f = fixture({ native: true }), old = fixture({ native: true, enabled: false });
  const schema = modelResultTools(f.prepared.payload, f.prepared.instructions)[0].parameters.oneOf[0];
  assert.equal(schema.properties.interactions.properties.groupId.const, 'g1'); assert.ok(!schema.required.includes('interactions'));
  assert.equal(modelResultTools(old.prepared.payload, old.prepared.instructions)[0].parameters.oneOf[0].properties.interactions, undefined);
  assert.match(modelContract(f.prepared.payload, f.prepared.instructions), /interactions/);
  assert.doesNotMatch(modelContract(old.prepared.payload, old.prepared.instructions), /interactions:/);
  assert.equal(validateNativeResult(JSON.stringify(f.response), f.prepared.payload, f.prepared.instructions), true);
  assert.equal(validateNativeResult(JSON.stringify(f.response), old.prepared.payload, old.prepared.instructions), false);
  // Shallow transport must leave malformed optional channel to host fallback,
  // not discard primaries or create another hidden model send.
  assert.equal(validateNativeResult(JSON.stringify({ ...f.response, interactions: null }), f.prepared.payload, f.prepared.instructions), true);
  for (const native of [false, true]) {
    let sends = 0;
    const adapter = createDshModel({ async *stream(wire) { sends++; if (native) yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'result', name: 'submit_review_result', arguments: JSON.stringify(f.response) } }; else yield { type: 'text-delta', text: JSON.stringify(f.response) }; yield { type: 'finish', reason: { kind: native ? 'tool-calls' : 'stop' } }; } }, { provider: 'offline', model: 'fixture' }, { useNativeTools: native });
    const response = await adapter({ instructions: f.prepared.instructions, input: f.prepared.payload, maxInputBytes: 98304 });
    assert.equal(f.check(response).status, 'accepted'); assert.equal(sends, 1);
  }
});
