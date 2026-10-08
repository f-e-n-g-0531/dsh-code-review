import { validateCandidateVerification } from '../src/candidate-verification.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRegressionAssessment as validate } from '../src/regression-assessment.mjs';
const catalog = [{ id: 'o', fileId: 'f', side: 'old' }, { id: 'n', fileId: 'f', side: 'new' }, { id: 'c', side: 'context' }];
const evidence = ['o', 'n', 'c'].map(sourceId => ({ sourceId, status: 'references-validated' }));
const claim = { classification: 'introduced', reason: 'old guard removed', oldEvidence: [0], newEvidence: [1] };
test('verification protocol resolves exact old/new evidence and preserves legacy unassessed', () => {
  const scope = createRetrievalScope({ id: 'snap', context: [], files: [{ id: 'f', path: 'a.js', eligibility: 'reviewable', left: { text: 'guard();' }, right: { text: 'run();' } }] });
  const refs = ['s1', 's2'].map(id => { const { endOfSource, ...ref } = scope.read({ id, start: 1, count: 1 }); return ref; });
  const item = { candidateId: 'c1', verdict: 'supported', reason: 'guard removed', evidence: refs, regression: claim };
  const options = { catalog: scope.catalog(), fileIds: { c1: 'f' } };
  const result = validateCandidateVerification({ verdicts: [item] }, ['c1'], scope.read, v => v, options);
  assert.equal(result[0].regression.classification, 'introduced');
  assert.equal(result[0].regression.causality, 'unverified');
  assert.throws(() => validateCandidateVerification({ verdicts: [{ ...item, regression: { ...claim, oldEvidence: [1] } }] }, ['c1'], scope.read, v => v, options));
  const { regression, ...legacy } = item;
  assert.equal(validateCandidateVerification({ verdicts: [legacy] }, ['c1'], scope.read)[0].regression.classification, 'unassessed');
});
test('both primary sides support reference validation but never causal proof', () => {
  for (const classification of ['introduced', 'preexisting']) { const result = validate({ ...claim, classification }, evidence, catalog, 'f'); assert.equal(result.causality, 'unverified'); assert.equal(result.status, 'comparison-references-validated'); }
});
test('wrong sides context other primary missing sides and forged indices fail closed', () => {
  for (const patch of [{ oldEvidence: [] }, { oldEvidence: [1] }, { newEvidence: [2] }, { newEvidence: [99] }, { newEvidence: [1, 1] }, { classification: 'proven' }]) assert.throws(() => validate({ ...claim, ...patch }, evidence, catalog, 'f'));
  assert.throws(() => validate(claim, evidence, catalog, 'other'));
  assert.throws(() => validate(claim, [{ ...evidence[0], status: 'missing' }, evidence[1]], catalog, 'f'));
});
test('uncertain and legacy unassessed do not invent comparison support', () => {
  assert.equal(validate(undefined, evidence, catalog, 'f').classification, 'unassessed');
  assert.equal(validate({ ...claim, classification: 'uncertain', oldEvidence: [], newEvidence: [] }, evidence, catalog, 'f').classification, 'uncertain');
});
