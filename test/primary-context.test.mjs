import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePrimaryInput } from '../src/primary-input.mjs';
import { primaryContextFocus } from '../src/primary-context.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { initialInputBudget } from '../src/input-budget.mjs';
import { REVIEW_INSTRUCTIONS } from '../src/prompts.mjs';
import { hash } from '../src/content.mjs';
const fixture = (context = []) => ({ id: 'focused', files: [{ id: 'f', path: 'main.js', eligibility: 'reviewable', left: { text: 'export const value = 1;\n' }, right: { text: 'export const value = 2;\n' } }], context, rules: [{ path: 'rules.md', text: 'preserve exact rule' }] });
const opts = (input, extra = {}) => ({ instructions: REVIEW_INSTRUCTIONS, scope: createRetrievalScope(input), maxInputBytes: 18000, riskPlanningMode: 'auto', enableRiskPlanning: true, focusPrimaryContext: true, ...extra });
const prepare = (input, options) => preparePrimaryInput(input, input.files[0], options);

test('large unrelated global context no longer forces main file windows and still permits inline', () => {
  const input = fixture([{ path: 'unrelated.js', text: 'x'.repeat(50000) }]);
  const options = opts(input); const before = structuredClone(input);
  const focused = prepare(input, options), payload = JSON.parse(focused.payload);
  assert.equal(focused.inlineRisk, true);
  assert.equal(focused.metadata.sourceMode, undefined);
  assert.equal(focused.batches, undefined);
  assert.deepEqual(payload.file, input.files[0]);
  assert.deepEqual(payload.context, []);
  assert.equal(focused.metadata.contextDeferredCount, 1);
  assert.equal(focused.metadata.contextProvidedCount, 0);
  assert.equal(payload.contextMode, 'approved-retrieval');
  assert.equal(payload.contextCatalog.length, 1);
  assert.deepEqual(payload.rules, input.rules);
  assert.deepEqual(input, before);
  const source = options.scope.catalog().find(s => s.path === 'unrelated.js');
  assert.equal(options.scope.read({ id: source.id, start: 1, count: 1 }).text, input.context[0].text);
  const legacy = prepare(input, { ...options, focusPrimaryContext: false });
  assert.equal(legacy.metadata.sourceMode, 'change-windows');
  assert.deepEqual(focused.changes, legacy.changes);
});

test('linked short header is provided whole while unrelated contexts are deferred in original order', () => {
  const input = fixture([{ path: 'other.h', text: 'not linked' }, { path: 'second.h', text: 'short second\r\n' }, { path: 'first.h', text: 'short first\r\n' }]);
  input.files[0].path = 'main.cpp'; input.files[0].left.text = '#include "first.h"\nold();\n'; input.files[0].right.text = '#include "second.h"\n#include "first.h"\nnew();\n';
  const focused = prepare(input, opts(input)); const p = JSON.parse(focused.payload);
  assert.deepEqual(p.context.map(c => c.path), ['second.h', 'first.h']);
  assert.equal(p.context[0].text, 'short second\r\n');
  assert.equal(focused.metadata.contextProvidedCount, 2);
  assert.equal(focused.metadata.contextDeferredCount, 1);
  assert.equal(p.contextCatalog.length, 3);
  assert.ok(Buffer.byteLength(JSON.stringify(p.context)) <= Math.min(16384, 18000 / 4));
});

test('huge directly included header is deferred without truncation or main window amplification', () => {
  const input = fixture([{ path: 'large.h', text: 'header'.repeat(5000) }]);
  input.files[0].path = 'main.cpp';input.files[0].left.text = '#include "large.h"\nold();';input.files[0].right.text = '#include "large.h"\nnew();';
  const focused = prepare(input, opts(input)), p = JSON.parse(focused.payload);
  assert.deepEqual(p.context, []);
  assert.deepEqual(p.file.left, input.files[0].left);
  assert.deepEqual(p.file.right, input.files[0].right);
  assert.equal(p.sourceMode, undefined);
  assert.equal(focused.metadata.contextDeferredCount, 1);
});

test('focus caps context bodies even when the original global input already fits', () => {
  const input = fixture([{ path: 'other.js', text: 'small unrelated' }]);
  const options = opts(input, { maxInputBytes: 96000 });
  const focused = prepare(input, options), legacy = prepare(input, { ...options, focusPrimaryContext: false });
  assert.equal(legacy.budget.fits, true);
  assert.equal(JSON.parse(legacy.payload).context.length, 1);
  assert.deepEqual(JSON.parse(focused.payload).context, []);
});

test('explicit false matches legacy exactly; no scope never defers; strict option', () => {
  const input = fixture([{ path: 'other.js', text: 'source' }]);
  const options = opts(input); const legacy = { ...options }; delete legacy.focusPrimaryContext;
  assert.deepEqual(prepare(input, legacy), prepare(input, { ...options, focusPrimaryContext: false }));
  const noScope = prepare(input, { ...options, scope: undefined });
  assert.deepEqual(JSON.parse(noScope.payload).context, input.context);
  assert.equal(noScope.metadata.contextDeferredCount, undefined);
  assert.throws(() => prepare(input, { ...options, focusPrimaryContext: 1 }), /boolean/);
});

test('historical old/new contexts preserve both raw sides and full approved catalog IDs', () => {
  const input = fixture([{ path: 'dep.js', text: 'export function Foo() { return 2; }\r\n', oldText: 'export function Foo() { return 1; }\r\n', revision: 'target', oldRevision: 'base' }, { path: 'unrelated.js', text: 'opaque' }]);
  input.history = { base: 'base', target: 'target' };
  input.files[0].left.text = 'import { Foo } from "./dep.js";\nFoo();'; input.files[0].right.text = 'import { Foo } from "./dep.js";\nFoo();\nnewCall();';
  const options = opts(input), focused = prepare(input, options), p = JSON.parse(focused.payload);
  assert.deepEqual(p.context, [input.context[0]]);
  assert.deepEqual(p.contextCatalog, options.scope.catalog().filter(s => s.side.startsWith('context')));
  assert.equal(p.contextCatalog.length, 3);
  for (const source of p.contextCatalog.filter(s => s.path === 'dep.js')) assert.equal(options.scope.read({ id: source.id, start: 1, count: 1 }).text, source.side === 'context-old' ? input.context[0].oldText : input.context[0].text);
  assert.equal(focused.metadata.contextDeferredCount, 1);
});

test('deferred old-only context remains independently readable and requirements are unchanged', () => {
  const oldText = 'old-only\r\n';
  const input = fixture([{ path: 'old.js', oldOnly: true, oldText, oldHash: hash(oldText), oldRevision: 'a'.repeat(40), oldBlobOid: 'c'.repeat(40) }]);
  input.history = { base: 'a'.repeat(40), target: 'b'.repeat(40) };
  input.businessRequirement = 'Preserve contract';
  const options = opts(input), focused = prepare(input, options), payload = JSON.parse(focused.payload);
  assert.deepEqual(payload.context, []);
  assert.equal(payload.contextCatalog.length, 1);
  assert.equal(payload.contextCatalog[0].side, 'context-old');
  assert.equal(options.scope.read({ id: payload.contextCatalog[0].id, start: 1, count: 20 }).text, oldText);
  assert.equal(payload.businessRequirement, input.businessRequirement);
  assert.deepEqual(payload.rules, input.rules);
  assert.equal(focused.metadata.contextDeferredCount, 1);
});

test('linked bodies cannot force windows at an exact main-plus-identities capacity boundary', () => {
  const input = fixture([{ path: 'dep.js', text: 'export function Foo() { return 1; }\n' + '// padding\n'.repeat(80) }]);
  input.files[0].left.text = 'import { Foo } from "./dep.js";\nFoo();';
  input.files[0].right.text = 'import { Foo } from "./dep.js";\nFoo();\nchanged();';
  const options = opts(input, { riskPlanningMode: 'separate' });
  const base = JSON.parse(prepare(input, options).payload); base.context = [];
  base.contextMode = 'approved-retrieval';
  base.contextNotice = 'Only focused approved context bodies are provided. Other catalog identities require version-specific read; omission is not absence or reviewed coverage.';
  const capacity = initialInputBudget({ instructions: options.instructions, input: JSON.stringify(base) }, options.scope, 96000).bytes;
  const focused = prepare(input, { ...options, maxInputBytes: capacity });
  assert.equal(focused.budget.fits, true);
  assert.deepEqual(JSON.parse(focused.payload).context, []);
  assert.deepEqual(JSON.parse(focused.payload).file, input.files[0]);
  assert.equal(focused.metadata.sourceMode, undefined);
});

test('caller/C# hints focus their approved contexts; budget boundary defers whole items', () => {
  const input = fixture([{ path: 'caller.js', text: 'CALLER' }, { path: 'Type.cs', text: 'TYPE' }, { path: 'unrelated.js', text: 'not requested' }]);
  const scope = createRetrievalScope(input);
  const base = { file: input.files[0], context: input.context, callerBindings: [{ fromPath: 'caller.js' }], csharpContextHints: [{ primaryPath: 'main.js', contextPath: 'Type.cs' }], rules: input.rules };
  const focused = primaryContextFocus(base, { scope, maxInputBytes: 96000, measure: value => initialInputBudget({ instructions: 'review', input: value }, scope, 96000) });
  assert.deepEqual(focused.base.context.map(c => c.path), ['caller.js', 'Type.cs']);
  const fullBytes = Buffer.byteLength(JSON.stringify(focused.base));
  const limited = primaryContextFocus(base, { scope, maxInputBytes: 96000, measure: value => ({ fits: Buffer.byteLength(value) < fullBytes }) });
  assert.equal(limited.base.context.length, 1);
  assert.equal(limited.metadata.contextDeferredCount, 2);
  assert.deepEqual(limited.base.rules, base.rules);
});
