import test from 'node:test';
import assert from 'node:assert/strict';
import { ChildInputCapacityError, isUnsentChildCapacityError, splitUnsentChildBatch } from '../src/child-capacity-error.mjs';

test('host branded unsent overflow is recognized only for its exact unchanged cap', () => {
  const error = new ChildInputCapacityError(524289, 524288, { unsent: true });
  assert.ok(error instanceof Error); assert.equal(error.name, 'ChildInputCapacityError');
  assert.equal(error.code, 'WHOLE_SCOPE_INPUT_BUDGET'); assert.equal(error.requiredBytes, 524289);
  assert.equal(error.approvedCap, 524288); assert.equal(error.unsent, true);
  assert.equal(isUnsentChildCapacityError(error, 524288), true);
  for (const cap of [524287, 524289, 0, -1, NaN, Infinity, '524288', undefined]) assert.equal(isUnsentChildCapacityError(error, cap), false);
});
test('post-dispatch overflow cannot authorize replay even with genuine host brand', () => {
  const error = new ChildInputCapacityError(1001, 1000, { unsent: false });
  assert.equal(isUnsentChildCapacityError(error, 1000), false);
});
test('provider-shaped errors, prototype forgeries and serialized copies fail closed', () => {
  const real = new ChildInputCapacityError(1001, 1000, { unsent: true });
  const fields = { code: 'WHOLE_SCOPE_INPUT_BUDGET', requiredBytes: 1001, approvedCap: 1000, unsent: true };
  for (const error of [null, undefined, 1, 'WHOLE_SCOPE_INPUT_BUDGET', fields, Object.assign(new Error('provider'), fields), Object.assign(Object.create(ChildInputCapacityError.prototype), fields), JSON.parse(JSON.stringify(real)), structuredClone(real)]) assert.equal(isUnsentChildCapacityError(error, 1000), false);
});
test('capacity proof fields cannot be altered to another cap or to unsent', () => {
  const real = new ChildInputCapacityError(1001, 1000, { unsent: false });
  for (const [key, value] of [['unsent', true], ['approvedCap', 999], ['requiredBytes', 2000], ['code', 'other']]) assert.throws(() => { real[key] = value; }, TypeError);
  assert.equal(isUnsentChildCapacityError(real, 1000), false);
});
const batch = () => ({ id: 'old', instructions: 'exact instructions', fileIds: ['a', 'b', 'c'], changes: new Map(['a', 'b', 'c'].map(id => [id, { edits: [{ id: 'e1', text: 'change-' + id }] }])), payload: JSON.stringify({ snapshotId: 'approved', sourceMode: 'group-primary', rules: [{ path: 'rules.md', text: 'exact rule' }], context: [{ path: 'dep.js', text: 'approved context' }], businessRequirement: 'untrusted requirement', reviews: ['a', 'b', 'c'].map(fileId => ({ snapshotId: 'approved', fileId, file: { properties: [{ name: 'review:key', old: 'old', new: 'new' }], left: { text: 'old body ' + fileId }, right: { text: 'new body ' + fileId } } })) }) });
test('split strictly shrinks member counts and preserves complete sources properties and shared identity', () => {
  const original = batch(), before = structuredClone(original), error = new ChildInputCapacityError(2000, 1000, { unsent: true });
  const split = splitUnsentChildBatch(original, error, { approvedCap: 1000 });
  assert.equal(split.length, 2); assert.deepEqual(split.map(row => row.fileIds.length), [2, 1]);
  const input = JSON.parse(original.payload);
  assert.deepEqual(split.flatMap(row => JSON.parse(row.payload).reviews), input.reviews);
  assert.deepEqual(split.flatMap(row => row.fileIds), original.fileIds);
  for (const child of split) {
    const value = JSON.parse(child.payload);
    assert.deepEqual({ ...value, reviews: [] }, { ...input, reviews: [] });
    assert.equal(child.instructions, original.instructions); assert.ok(child.fileIds.length < original.fileIds.length);
    assert.match(child.id, /^whole-[a-f0-9]{64}$/); assert.notEqual(child.id, original.id);
    assert.deepEqual([...child.changes.keys()], child.fileIds);
  }
  assert.deepEqual(splitUnsentChildBatch(original, error, { approvedCap: 1000 }), split);
  split[0].changes.get('a').edits[0].text = 'mutated'; assert.deepEqual(original, before);
  assert.equal(splitUnsentChildBatch(split[1], error, { approvedCap: 1000 }), null);
});
test('split refuses foreign capacity provider-shaped and already-sent errors', () => {
  const original = batch(), unsent = new ChildInputCapacityError(2000, 1000, { unsent: true });
  for (const [error, approvedCap] of [[{ ...unsent }, 1000], [unsent, 999], [new ChildInputCapacityError(2000, 1000, { unsent: false }), 1000]]) assert.equal(splitUnsentChildBatch(original, error, { approvedCap }), null);
  const corrupted = batch(); corrupted.fileIds.reverse();
  assert.throws(() => splitUnsentChildBatch(corrupted, unsent, { approvedCap: 1000 }), /members/);
});
test('SVN root properties and complete per-review provenance survive split unchanged', () => {
  const original = batch();
  const input = JSON.parse(original.payload);
  input.history = { vcs: 'svn', repositoryUuid: 'uuid', base: '1', target: '2' };
  input.reviews[0] = { snapshotId: 'approved', fileId: 'a', file: { id: 'a', path: '.', kind: 'dir', eligibility: 'reviewable', properties: [{ name: 'svn:mergeinfo', old: '/branch:1', new: '/branch:1-2' }], left: { text: '' }, right: { text: '' }, workingSource: { repositoryUuid: 'uuid', url: 'https://example.invalid/repo', kind: 'dir' } }, changes: { propertiesOnly: true } };
  input.reviews[1].file.path = 'src/with spaces.cpp';
  input.reviews[1].file.oldPath = 'src/old.cpp';
  input.reviews[1].file.encoding = 'utf-8';
  input.reviews[1].file.right.text = '"quoted"\\path\r\n中文😀';
  original.payload = JSON.stringify(input);
  const result = splitUnsentChildBatch(original, new ChildInputCapacityError(2000, 1000, { unsent: true }), { approvedCap: 1000 });
  assert.deepEqual(result.flatMap(child => JSON.parse(child.payload).reviews), input.reviews);
  assert.equal(JSON.parse(result[0].payload).reviews[0].file.path, '.');
  assert.deepEqual(JSON.parse(result[0].payload).reviews[0].file.properties, input.reviews[0].file.properties);
  for (const child of result) {
    const payload = JSON.parse(child.payload);
    assert.equal(payload.snapshotId, input.snapshotId);
    assert.deepEqual(payload.history, input.history);
    assert.deepEqual(payload.context, input.context);
    assert.deepEqual(payload.rules, input.rules);
    for (const row of payload.reviews) assert.equal(row.snapshotId, 'approved');
  }
});
test('invalid capacities overflow ranges and policies reject before branding', () => {
  for (const [required, cap, options] of [[1, 1, { unsent: true }], [0, 1, { unsent: true }], [1, 0, { unsent: true }], [2.5, 2, { unsent: true }], [Infinity, 1, { unsent: true }], [Number.MAX_SAFE_INTEGER + 1, 1, { unsent: true }], [2, 1, {}], [2, 1, { unsent: 'yes' }], [2, 1, { unsent: true, retry: true }], [2, 1, null], [2, 1, undefined]]) assert.throws(() => new ChildInputCapacityError(required, cap, options), TypeError);
});
