import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareGroupPrimary, validateGroupPrimary } from '../src/group-primary.mjs';
import { REVIEW_INSTRUCTIONS, validateFindings } from '../src/review.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';

const finding = (fileId = 'a') => ({ fileId, severity: 'high', title: 'Guard removed', evidence: 'unsafe operation', trigger: 'invalid input', impact: 'invalid state', suggestion: 'restore guard', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'unsafe();' }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: 'guarded', afterBehavior: 'unguarded', reason: 'guard removed' } });
function fixture({ after = 'keep();\nunsafe();\nend();', risk = false } = {}) {
  const snapshot = { id: 'group-anchor', vcs: 'git', context: [], files: ['a', 'b'].map(id => ({ id, path: id + '.js', eligibility: 'reviewable', properties: [], left: { text: 'keep();\nguard();\nend();' }, right: { text: id === 'a' ? after : 'keep();\npeer();\nend();' } })) };
  const scope = createRetrievalScope(snapshot);
  const prepared = prepareGroupPrimary(snapshot, { id: 'g', fileIds: ['a', 'b'] }, { instructions: REVIEW_INSTRUCTIONS, scope, maxInputBytes: 98304, enableRiskPlanning: risk });
  assert.ok(prepared);
  const value = { reviews: ['a', 'b'].map(fileId => ({ fileId, findings: fileId === 'a' ? [finding()] : [], limitations: [fileId + ' limitation'], ...(risk ? { risks: [] } : {}) })), limitations: ['group limitation'] };
  return { snapshot, prepared, scope, value, check: (response = value, options = { enableAnchorCorrection: true }, validate = validateFindings) => validateGroupPrimary(response, prepared, snapshot, validate, scope.catalog(), options) };
}
const mismatch = { code: 'MODEL_ANCHOR_MISMATCH' };

test('opt-in group correction relocates unique exact text and preserves original candidate without mutation', () => {
  const f = fixture(), before = structuredClone(f.value);
  let calls = 0;
  const result = f.check(f.value, { enableAnchorCorrection: true }, (row, file, changes) => {
    calls++; assert.equal(changes, f.prepared.changes.get(file.id));
    return validateFindings(row, file);
  });
  assert.equal(calls, 2);
  const generated = result.get('a'), correction = generated.anchorCorrections[0];
  assert.equal(generated.findings[0].anchor.start, 2);
  assert.equal(correction.status, 'corrected');
  assert.equal(correction.reason, 'unique-exact-text-overlaps-edit');
  assert.deepEqual(correction.originalCandidate, before.reviews[0].findings[0]);
  assert.deepEqual(correction.candidate, { ...finding(), anchor: { ...finding().anchor, start: 2, end: 2 } });
  for (const key of ['title', 'evidence', 'trigger', 'impact', 'suggestion']) assert.equal(generated.findings[0][key], finding()[key]);
  assert.deepEqual(f.value, before);
  f.value.reviews[0].findings[0].title = 'mutated later';
  assert.equal(correction.originalCandidate.title, 'Guard removed');
});

test('legacy four/five argument calls and explicit false retain strict non-correcting default', () => {
  const f = fixture();
  assert.throws(() => validateGroupPrimary(f.value, f.prepared, f.snapshot, validateFindings), mismatch);
  assert.throws(() => validateGroupPrimary(f.value, f.prepared, f.snapshot, validateFindings, []), mismatch);
  assert.throws(() => f.check(f.value, { enableAnchorCorrection: false }), mismatch);
  f.value.reviews[0].findings[0].anchor.start = f.value.reviews[0].findings[0].anchor.end = 2;
  const old = validateGroupPrimary(f.value, f.prepared, f.snapshot, validateFindings);
  assert.equal(old.get('a').findings.length, 1);
  assert.equal(Object.hasOwn(old.get('a'), 'anchorCorrections'), false);
});

for (const [name, after] of [
  ['ambiguous exact text', 'keep();\nunsafe();\nunsafe();'],
  ['fuzzy spelling', 'keep();\nunsafe ();\nend();'],
  ['no exact match', 'keep();\nother();\nend();'],
]) test(name + ' remains a strict anchor mismatch', () => {
  const f = fixture({ after });
  assert.throws(() => f.check(), mismatch);
});

test('same group peer text cannot be borrowed and identity cannot be switched', () => {
  const f = fixture();
  f.value.reviews[0].findings[0].anchor.snippet = 'peer();';
  assert.throws(() => f.check(), mismatch);
  f.value.reviews[0].findings[0].fileId = 'b';
  assert.throws(() => f.check(), { code: 'MODEL_INVALID_FINDING_IDENTITY' });
});

test('same member opposite side is never searched', () => {
  const f = fixture();
  f.value.reviews[0].findings[0].anchor.side = 'old';
  assert.throws(() => f.check(), mismatch);
  f.value.reviews[0].findings[0].anchor.snippet = 'guard();';
  const corrected = f.check().get('a');
  assert.equal(corrected.findings[0].anchor.side, 'old');
  assert.equal(corrected.findings[0].anchor.start, 2);
});

test('unique context outside referenced edit and unknown edit references cannot relocate', () => {
  for (const patch of [{ anchor: { ...finding().anchor, start: 2, end: 2, snippet: 'keep();' } }, { attribution: { ...finding().attribution, editIds: ['fake'] } }]) {
    const f = fixture(); Object.assign(f.value.reviews[0].findings[0], patch);
    assert.throws(() => f.check(), mismatch);
  }
});

test('corrected locations still run ordinary business and attribution validation', () => {
  for (const patch of [{ severity: 'invented' }, { evidence: '' }, { attribution: { ...finding().attribution, reason: '' } }]) {
    const f = fixture(); Object.assign(f.value.reviews[0].findings[0], patch);
    assert.throws(() => f.check());
  }
});

test('member findings risks and member/group limitations survive correction and string envelope', () => {
  const f = fixture({ risk: true });
  f.value.reviews[1].findings = [{ ...finding('b'), anchor: { ...finding().anchor, start: 2, end: 2, snippet: 'peer();' } }];
  f.value.reviews[1].risks = [{ id: 'r1', fileIds: ['a', 'b'], editRefs: [{ fileId: 'a', editId: 'e1' }, { fileId: 'b', editId: 'e1' }], question: 'Both guards removed?', trigger: 'invalid input', impact: 'invalid state', checks: ['Inspect callers'], sourceIds: [] }];
  const result = f.check(JSON.stringify(f.value));
  assert.deepEqual(result.get('a').limitations, ['a limitation', 'group limitation']);
  assert.deepEqual(result.get('b').limitations, ['b limitation', 'group limitation']);
  assert.equal(result.get('b').findings[0].fileId, 'b');
  assert.equal(result.get('b').groupRisk.status, 'completed');
  assert.equal(result.get('b').groupRisk.risks[0].status, 'hypothesis');
  assert.deepEqual(result.get('a').groupRisk, { status: 'completed', risks: [] });
  assert.equal(Object.hasOwn(result.get('b'), 'anchorCorrections'), false);
});

test('interaction findings still cannot bypass dedicated validation with correction enabled', () => {
  const f = fixture(); f.value.reviews[0].findings[0].interaction = { editRefs: [] };
  assert.throws(() => f.check(), /cannot bypass/);
});

test('host correction honors cancellation', () => {
  const f = fixture(), reason = new Error('cancel correction');
  assert.throws(() => f.check(f.value, { enableAnchorCorrection: true, signal: AbortSignal.abort(reason) }), reason);
});
