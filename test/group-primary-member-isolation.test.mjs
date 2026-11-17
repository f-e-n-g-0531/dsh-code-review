import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareGroupPrimary, validateGroupPrimary, validateGroupPrimaryMembers } from '../src/group-primary.mjs';
import { REVIEW_INSTRUCTIONS, validateResponse } from '../src/review.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';

const finding = fileId => ({ fileId, severity: 'high', title: 'Guard removed', evidence: 'unsafe operation', trigger: 'invalid input', impact: 'invalid state', suggestion: 'restore guard', anchor: { kind: 'line', side: 'new', start: 2, end: 2, snippet: fileId + '();' }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: 'guarded', afterBehavior: 'unguarded', reason: 'guard removed' } });
function fixture() {
  const snapshot = { id: 'member-isolation', vcs: 'git', context: [], files: ['a', 'b', 'c'].map(id => ({ id, path: id + '.js', eligibility: 'reviewable', properties: [], left: { text: 'keep();\nguard();\nend();' }, right: { text: 'keep();\n' + id + '();\nend();' } })) };
  const scope = createRetrievalScope(snapshot);
  const prepared = prepareGroupPrimary(snapshot, { id: 'g', fileIds: ['a', 'b', 'c'] }, { instructions: REVIEW_INSTRUCTIONS, scope, maxInputBytes: 98304, enableRiskPlanning: true });
  assert.ok(prepared);
  const value = { reviews: prepared.fileIds.map(fileId => ({ fileId, findings: [finding(fileId)], limitations: [fileId + ' limit'], risks: [] })), limitations: ['group limit'] };
  const check = (options = {}, validate = validateResponse, response = value) => validateGroupPrimaryMembers(response, prepared, snapshot, validate, [], options);
  return { snapshot, scope, prepared, value, check };
}
const bad = row => { row.findings[0].anchor.snippet = 'PRIVATE missing snippet'; };

for (const index of [0, 1, 2]) test('isolates bad anchor at row ' + index + ' without losing healthy peers', () => {
  const f = fixture(); bad(f.value.reviews[index]); const before = structuredClone(f.value);
  const result = f.check({ enableAnchorCorrection: true });
  assert.deepEqual([...result.failed.keys()], [f.prepared.fileIds[index]]);
  assert.deepEqual([...result.completed.keys()], f.prepared.fileIds.filter((_, i) => i !== index));
  for (const [id, generated] of result.completed) {
    assert.equal(generated.findings[0].fileId, id);
    assert.deepEqual(generated.limitations, [id + ' limit', 'group limit']);
    assert.deepEqual(generated.groupRisk, { status: 'completed', risks: [] });
  }
  assert.deepEqual(result.failed.get(f.prepared.fileIds[index]), { code: 'MODEL_ANCHOR_MISMATCH', reason: 'Grouped primary member anchor does not match approved source' });
  assert.doesNotMatch(JSON.stringify([...result.failed]), /PRIVATE|snippet|originalCandidate/);
  assert.deepEqual(f.value, before);
});

for (const badFirst of [false, true]) test('one good and one bad candidate fail the entire row, badFirst=' + badFirst, () => {
  const f = fixture(), row = f.value.reviews[1], broken = finding('b'); broken.anchor.snippet = 'absent();';
  row.findings = badFirst ? [broken, finding('b')] : [finding('b'), broken];
  const result = f.check({ enableAnchorCorrection: true });
  assert.equal(result.completed.has('b'), false); assert.equal(result.failed.has('b'), true);
  assert.equal(result.completed.size, 2);
});

for (const [name, mutate] of [
  ['missing member', f => f.value.reviews.pop()],
  ['duplicate member', f => f.value.reviews[2].fileId = 'b'],
  ['foreign member', f => f.value.reviews[2].fileId = 'foreign'],
  ['missing row limitations', f => delete f.value.reviews[2].limitations],
  ['invalid row limitations', f => f.value.reviews[2].limitations = ['']],
  ['missing findings', f => delete f.value.reviews[2].findings],
  ['missing group limitations', f => delete f.value.limitations],
  ['foreign finding identity', f => f.value.reviews[2].findings[0].fileId = 'a'],
  ['unknown finding identity', f => f.value.reviews[2].findings[0].fileId = 'unknown'],
  ['interaction bypass', f => f.value.reviews[2].findings[0].interaction = {}],
]) test(name + ' refuses the whole group before member validation', () => {
  const f = fixture(); bad(f.value.reviews[0]); mutate(f); let validations = 0;
  assert.throws(() => f.check({}, () => { validations++; throw new Error('must not validate'); }));
  assert.equal(validations, 0);
});

test('legacy atomic interface remains strict and correction remains opt-in', () => {
  const f = fixture(); f.value.reviews[0].findings[0].anchor.start = f.value.reviews[0].findings[0].anchor.end = 1;
  assert.throws(() => validateGroupPrimary(f.value, f.prepared, f.snapshot, validateResponse), { code: 'MODEL_ANCHOR_MISMATCH' });
  assert.equal(f.check().failed.has('a'), true);
  assert.equal(f.check({ enableAnchorCorrection: true }).completed.get('a').findings[0].anchor.start, 2);
  bad(f.value.reviews[1]);
  assert.throws(() => validateGroupPrimary(f.value, f.prepared, f.snapshot, validateResponse, [], { enableAnchorCorrection: true }), { code: 'MODEL_ANCHOR_MISMATCH' });
});

for (const mode of ['fuzzy', 'opposite-side', 'other-member', 'ambiguous', 'outside-edit']) test('strict correction never relaxes ' + mode, () => {
  const f = fixture(), candidate = f.value.reviews[0].findings[0]; candidate.anchor.start = candidate.anchor.end = 1;
  if (mode === 'fuzzy') candidate.anchor.snippet = 'a ();';
  if (mode === 'opposite-side') candidate.anchor.side = 'old';
  if (mode === 'other-member') candidate.anchor.snippet = 'b();';
  if (mode === 'ambiguous') f.snapshot.files[0].right.text = 'keep();\na();\na();';
  if (mode === 'outside-edit') { candidate.anchor.start = candidate.anchor.end = 2; candidate.anchor.snippet = 'keep();'; }
  assert.equal(f.check({ enableAnchorCorrection: true }).failed.has('a'), true);
});

for (const patch of [{ severity: 'invented' }, { evidence: '' }, { attribution: { ...finding('a').attribution, reason: '' } }]) test('correction still enforces ordinary validation ' + JSON.stringify(patch), () => {
  const f = fixture(); Object.assign(f.value.reviews[0].findings[0], patch); f.value.reviews[0].findings[0].anchor.start = f.value.reviews[0].findings[0].anchor.end = 1;
  assert.throws(() => f.check({ enableAnchorCorrection: true }));
});

for (const code of [undefined, 'HOST_FAILURE', 'ARTIFACT_WRITE_FAILED', 'READER_CALL_BUDGET_EXCEEDED', 'PROJECT_MODEL_CALL_LIMIT', 'MODEL_INVALID_ANCHOR']) test('propagates non-isolatable failure ' + code, () => {
  const f = fixture(), error = Object.assign(new Error('private host message'), { code });
  assert.throws(() => f.check({}, () => { throw error; }), e => e === error);
});

test('cancellation wins even if the validator throws a mismatch', () => {
  const f = fixture(), controller = new AbortController(), reason = new Error('cancel');
  assert.throws(() => f.check({ signal: controller.signal }, () => { controller.abort(reason); throw Object.assign(new Error('mismatch'), { code: 'MODEL_ANCHOR_MISMATCH' }); }), e => e === reason);
});

test('valid string envelope is identical to atomic output and isolation adds no read/model operations', () => {
  const f = fixture(), beforeBudget = structuredClone(f.scope.budget()); let validations = 0;
  bad(f.value.reviews[1]);
  const result = f.check({}, (row, file, changes) => { validations++; return validateResponse(row, file, changes); }, JSON.stringify(f.value));
  assert.equal(validations, 3); assert.equal(result.completed.size, 2); assert.equal(result.failed.size, 1);
  assert.deepEqual(f.scope.budget(), beforeBudget);
  f.value.reviews[1].findings = [finding('b')];
  const atomic = validateGroupPrimary(f.value, f.prepared, f.snapshot, validateResponse);
  assert.deepEqual(f.check({}, validateResponse, JSON.stringify(f.value)), { completed: atomic, failed: new Map() });
});
