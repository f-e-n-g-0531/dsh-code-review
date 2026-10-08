import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRegressionAssessment as validate } from '../src/regression-assessment.mjs';
const catalog = [{ id: 'o', fileId: 'f', side: 'old' }, { id: 'n', fileId: 'f', side: 'new' }, { id: 'c', side: 'context' }];
const evidence = ['o', 'n', 'c'].map(sourceId => ({ sourceId, status: 'references-validated' }));
const claim = { classification: 'introduced', reason: 'old guard removed', oldEvidence: [0], newEvidence: [1] };
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
