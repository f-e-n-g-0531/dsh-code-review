import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareWholeScope } from '../src/whole-scope-plan.mjs';
import { initialInputBudget } from '../src/input-budget.mjs';
import { retrievalRequest } from '../src/retrieval-loop.mjs';
import { modelWireBudget, configureWireBudget } from '../src/model-wire-budget.mjs';
import { changeMap } from '../src/change-map.mjs';
import { CONTEXT_SIDE_NOTICE } from '../src/context-identity.mjs';
import { REQUIREMENT_NOTICE } from '../src/business-requirement.mjs';

const instructions = '只报告具体缺陷，保留所有归因字段。';
const file = (n, text = 'new\n') => ({ id: 'f' + n, path: String(n).padStart(3, '0') + '.txt', eligibility: 'reviewable', left: { text: 'old\n', hash: 'old-hash' }, right: { text, hash: 'new-hash' }, properties: [{ name: 'mode', before: 'a', after: 'b' }] });
const snapshot = files => ({ id: 'approved-snapshot', files, context: [], rules: [] });
const scopeFor = () => ({ catalog: () => [{ id: 's1', path: 'approved.txt', side: 'context', lineCount: 2, hash: 'approved-hash' }], budget: () => ({ remainingCalls: 3, remainingBytes: 4096 }) });
const bytes = (batch, scope) => initialInputBudget({ input: batch.payload, instructions: batch.instructions, nativeOutputTools: true }, scope, Number.MAX_SAFE_INTEGER).bytes;
const plan = (input, options = {}) => prepareWholeScope(input, { instructions, ...options });

test('74 small files remain one whole primary request with full original members', () => {
  const input = snapshot(Array.from({ length: 74 }, (_, n) => file(n)));
  const output = plan(input, { scope: scopeFor() });
  assert.equal(output.wholeScope, true);
  assert.equal(output.batches.length, 1);
  assert.deepEqual(output.oversized, []);
  const batch = output.batches[0], value = JSON.parse(batch.payload);
  assert.equal(batch.fileIds.length, 74);
  assert.equal(value.sourceMode, 'group-primary');
  assert.equal(value.reviews.length, 74);
  for (const [n, review] of value.reviews.entries()) {
    assert.deepEqual(review, { snapshotId: input.id, fileId: input.files[n].id, file: input.files[n], changes: changeMap(input.files[n].left.text, input.files[n].right.text) });
    assert.deepEqual(batch.changes.get(review.fileId), review.changes);
  }
  assert.match(batch.instructions, /跨文件调用/);
  assert.match(batch.instructions, /不得返回成员risks/);
  assert.match(batch.instructions, /不要求为主审资格/);
  assert.match(batch.instructions, /独立verification阶段另行要求新读取和回执/);
  assert.equal(value.groupInteraction, undefined);
});

test('exact native wire fit includes retrieval catalog, instructions, contract and result tools', () => {
  const input = snapshot([file(1), file(2)]), scope = scopeFor();
  const batch = plan(input, { scope }).batches[0];
  const actual = retrievalRequest({ input: batch.payload, instructions: batch.instructions, nativeOutputTools: true }, scope, [], {max:3,remaining:3});
  const required = modelWireBudget(actual, Number.MAX_SAFE_INTEGER).bytes;
  assert.equal(bytes(batch, scope), required);
  assert.ok(required > Buffer.byteLength(actual.input) + Buffer.byteLength(actual.instructions));
  assert.equal(plan(input, { scope, maxInputBytes: required }).batches.length, 1);
  const over = plan(input, { scope, maxInputBytes: required - 1 });
  assert.equal(over.batches.length, 2);
  assert.deepEqual(over.batches.flatMap(b => b.fileIds), ['f1', 'f2']);
  assert.ok(over.batches.every(b => bytes(b, scope) <= required - 1));
});

test('a single oversized file is reported at exact required bytes, never truncated or windowed', () => {
  const large = file(1, 'x'.repeat(110000));
  large.left.text = 'y'.repeat(110000);
  const input = snapshot([large]), before = structuredClone(input);
  const full = plan(input, { maxInputBytes: 1000000 }).batches[0];
  const required = bytes(full);
  assert.deepEqual(plan(input, { maxInputBytes: required - 1 }), { batches: [], oversized: [{ fileId: 'f1', path: large.path, requiredBytes: required }], wholeScope: true });
  const exact = plan(input, { maxInputBytes: required });
  assert.deepEqual(JSON.parse(exact.batches[0].payload).reviews[0].file, large);
  assert.deepEqual(input, before);
});

test('IDs are stable under input order and budget changes, and hash all member content', () => {
  const input = snapshot([file(3), file(1), file(2)]);
  const original = plan(input).batches[0];
  const reordered = plan({ ...input, files: [...input.files].reverse() }, { maxInputBytes: 1000000 }).batches[0];
  assert.equal(original.id, reordered.id);
  assert.match(original.id, /^whole-[a-f0-9]{64}$/);
  assert.deepEqual(original.fileIds, ['f1', 'f2', 'f3']);
  const changed = structuredClone(input);
  changed.files[0].right.text += 'extra'; // stale snapshot/side hashes cannot hide member changes
  assert.notEqual(plan(changed).batches[0].id, original.id);
  assert.notEqual(plan(snapshot([file(1), file(2)])).batches[0].id, original.id);
});

test('JSON escapes and multibyte text are measured rather than raw side lengths', () => {
  const item = file(1, '"\\\r\n中文'.repeat(100));
  const input = snapshot([item]), scope = scopeFor();
  const batch = plan(input, { scope }).batches[0], required = bytes(batch, scope);
  assert.deepEqual(JSON.parse(batch.payload).reviews[0].file, item);
  const rawSides = Buffer.byteLength(item.left.text) + Buffer.byteLength(item.right.text);
  assert.ok(Buffer.byteLength(batch.payload) > rawSides);
  assert.equal(plan(input, { scope, maxInputBytes: required }).batches.length, 1);
  assert.deepEqual(plan(input, { scope, maxInputBytes: required - 1 }).oversized, [{ fileId: item.id, path: item.path, requiredBytes: required }]);
});

test('shared context, scope, requirement and rules occur once without losing side notices', () => {
  const context = { path: 'ctx.txt', text: 'current-context', oldText: 'old-context', oldRevision: 'base' };
  const rule = { path: 'rules.txt', text: 'keep-this-rule' };
  const input = { ...snapshot([file(1), file(2)]), history: { base: 'base', target: 'target' }, changeScope: 'staged', businessRequirement: 'keep-this-requirement', context: [context, structuredClone(context)], rules: [rule, structuredClone(rule)] };
  const before = structuredClone(input), scope = Object.freeze(scopeFor());
  configureWireBudget(scope, { nativeOutputTools: false });
  const batch = plan(input, { scope }).batches[0], value = JSON.parse(batch.payload);
  assert.deepEqual(value.context, [context]);
  assert.deepEqual(value.rules, [rule]);
  assert.equal(value.changeScope, 'staged');
  assert.match(value.changeScopeNotice, /HEAD/);
  assert.equal(value.contextSideNotice, CONTEXT_SIDE_NOTICE);
  assert.equal(value.businessRequirement, input.businessRequirement);
  assert.equal(value.requirementNotice, REQUIREMENT_NOTICE);
  for (const row of value.reviews) for (const key of ['context', 'rules', 'businessRequirement', 'requirementNotice', 'changeScope', 'contextSideNotice']) assert.equal(Object.hasOwn(row, key), false);
  assert.equal(batch.payload.split('keep-this-rule').length - 1, 1);
  assert.equal(batch.payload.split('keep-this-requirement').length - 1, 1);
  assert.deepEqual(input, before);
  assert.deepEqual(scope.catalog(), scopeFor().catalog());
  const required = bytes(batch, scope);
  assert.equal(plan(input, { scope, maxInputBytes: required - 1 }).batches.length, 2);
});

test('greedy splitting follows deterministic paths, skips oversized intact members and caps at 200 not four', () => {
  const small = file(1), input = snapshot([file(3), file(2, 'x'.repeat(20000)), small]);
  const budget = bytes(plan(snapshot([small])).batches[0]);
  const output = plan(input, { maxInputBytes: budget });
  assert.deepEqual(output.batches.map(b => b.fileIds), [['f1'], ['f3']]);
  assert.deepEqual(output.oversized.map(row => row.fileId), ['f2']);
  const many = plan(snapshot(Array.from({ length: 201 }, (_, n) => file(n))), { maxInputBytes: 1000000 });
  assert.deepEqual(many.batches.map(b => b.fileIds.length), [200, 1]);
});

test('project scope semantics and empty eligibility are preserved; malformed options fail closed', () => {
  const input = { ...snapshot([file(1)]), projectScope: { mode: 'current' } };
  const value = JSON.parse(plan(input).batches[0].payload);
  assert.deepEqual(value.projectScope, input.projectScope);
  assert.match(value.reviewNotice, /sentinel/);
  assert.deepEqual(plan(snapshot([{ id: 'excluded', eligibility: 'binary' }])), { batches: [], oversized: [], wholeScope: true });
  for (const maxInputBytes of [0, -1, NaN, 1.5]) assert.throws(() => plan(input, { maxInputBytes }), /Invalid/);
  assert.throws(() => prepareWholeScope(input), /instructions/);
  assert.throws(() => plan(snapshot([file(1), file(1)])), /member/);
  assert.throws(() => plan(snapshot([{ ...file(1), left: {} }])), /member/);
});
