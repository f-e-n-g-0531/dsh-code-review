import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMigrationContracts } from '../src/migration-contracts.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { changeMap } from '../src/change-map.mjs';
import { prepareMigrationRegression, migrationRegressionMetadata } from '../src/migration-regression.mjs';

function fixture(cpp = false) {
  const ext = cpp ? '.h' : '.mjs', imp = (name, file) => cpp ? '#include "./' + file + ext + '"' : 'import { ' + name + ' } from "./' + file + ext + '";';
  const fn = (name, body) => (cpp ? 'inline void ' : 'export function ') + name + (cpp ? '(State& state) {\n' : '(state) {\n') + body + '\n}\n';
  const publicOld = fn('mutate', '  if (!state.allowed) { return; }\n  state.value++;');
  const publicNew = fn('mutate', '  state.value++;');
  const preloadOld = fn('preload', '  state.ready = true;');
  const preloadNew = imp('mutate', 'public') + '\n' + fn('preload', '  if (!state.allowed) { return; }\n  mutate(state);');
  const caller = imp('mutate', 'public') + '\n' + fn('run', '  mutate(state);');
  return { id: 'snap', context: [], files: [
    { id: 'a', path: 'public' + ext, old: publicOld, new: publicNew },
    { id: 'b', path: 'preload' + ext, old: preloadOld, new: preloadNew },
    { id: 'c', path: 'caller' + ext, old: caller, new: caller },
  ].map(f => ({ id: f.id, path: f.path, eligibility: 'reviewable', properties: [], left: { text: f.old }, right: { text: f.new } })) };
}
for (const cpp of [false, true]) test('real guard-to-preloader migration keeps old public caller navigation, never semantic proof: ' + cpp, () => {
  const snapshot = fixture(cpp), before = structuredClone(snapshot), output = buildMigrationContracts(snapshot), again = buildMigrationContracts(snapshot);
  assert.deepEqual(output, again); assert.deepEqual(snapshot, before); assert.equal(output.contracts.length, 1);
  const contract = output.contracts[0]; assert.equal(contract.snapshotId, 'snap'); assert.equal(contract.status, 'navigation-only'); assert.equal(contract.causality, 'unverified');
  assert.deepEqual(contract.candidateFileIds, ['a', 'b']); assert.equal(contract.old[0].symbol, 'mutate'); assert.equal(contract.new[0].symbol, 'preload');
  assert.ok(contract.callers.some(c => c.fileId === 'c' && c.side === 'old')); assert.ok(contract.callers.some(c => c.fileId === 'c' && c.side === 'new'));
  assert.deepEqual(contract.unresolved, []); const catalog = createRetrievalScope(snapshot).catalog();
  for (const role of [...contract.old, ...contract.new]) {
    assert.equal(catalog.find(s => s.id === role.sourceId).fileId, role.fileId); assert.equal(catalog.find(s => s.id === role.sourceId).side, role.side);
    const f = snapshot.files.find(f => f.id === role.fileId), changes = changeMap(f.left.text, f.right.text);
    for (const editId of role.editIds) { const range = changes.edits.find(e => e.id === editId)[role.side]; assert.ok(range.count > 0); }
    const range = changes.edits.find(e => e.id === role.editId)[role.side]; assert.ok(role.line >= range.start && role.line < range.start + range.count);
  }
  assert.equal(output.groups.length, 1); assert.deepEqual(new Set(output.groups[0].fileIds), new Set(['a', 'b', 'c']));
  assert.match(output.limitations[0], /not semantic migration/);
});

test('separate old and new path indices resolve renamed old public entry without new-side fallback', () => {
  const s = fixture(), a = s.files[0]; a.oldPath = 'legacy/public.mjs'; a.path = 'modern/public.mjs';
  s.files[2].left.text = s.files[2].left.text.replace('./public.mjs', './legacy/public.mjs');
  for (const f of [s.files[1], s.files[2]]) f.right.text = f.right.text.replace('./public.mjs', './modern/public.mjs');
  const result = buildMigrationContracts(s); assert.equal(result.contracts.length, 1);
  assert.equal(result.contracts[0].old[0].path, 'legacy/public.mjs');
  assert.equal(result.contracts[0].old[0].sourcePath, 'modern/public.mjs');
  assert.equal(migrationRegressionMetadata(prepareMigrationRegression(s, createRetrievalScope(s), result.contracts, [])).length, 1);
  s.files[2].left.text = s.files[2].left.text.replace('./legacy/public.mjs', './modern/public.mjs');
  assert.equal(buildMigrationContracts(s).contracts.length, 0);
});

test('group cap retains cross-group links and unchanged unrelated files are not manufactured groups', () => {
  const s = fixture(); s.files.push({ ...s.files[2], id: 'unrelated', path: 'unrelated.mjs', left: { text: '' }, right: { text: '' } });
  const output = buildMigrationContracts(s, { maxGroupFiles: 1 }); assert.equal(output.groups.length, 3); assert.ok(output.links.every(l => l.split));
  assert.ok(output.links.some(l => l.from === 'a' && l.to === 'b')); assert.ok(!output.groups.some(g => g.fileIds.includes('unrelated')));
  s.files[1].right.text = s.files[1].left.text; const empty = buildMigrationContracts(s); assert.deepEqual(empty.contracts, []); assert.deepEqual(empty.groups, []);
});

test('similar names body text comments and missing or ambiguous bindings cannot imply migration', () => {
  for (const change of [
    s => { s.files[1].right.text = s.files[1].right.text.replace('  mutate(state);', '  // mutate(state);'); },
    s => { s.files[1].right.text = '/* pretend migration */\n' + s.files[1].right.text; },
    s => { s.files[0].left.text = s.files[0].right.text; },
    s => { s.files[1].right.text = s.files[1].right.text.replace('mutate(state);', 'similarMutate(state);'); },
    s => { s.files[2].left.text = ''; },
    s => { s.files[0].right.text += 'export function unrelated(state) {\n  state.other++;\n}\n'; s.files[1].right.text = s.files[1].right.text.replaceAll('mutate', 'unrelated'); },
    s => { s.files.push({ ...s.files[0], id: 'ambiguity', path: 'public.js', eligibility: 'excluded' }); for (const f of s.files) for (const side of ['left', 'right']) f[side].text = f[side].text.replaceAll('./public.mjs', './public'); },
  ]) { const s = fixture(); change(s); assert.equal(buildMigrationContracts(s).contracts.length, 0); }
  const s = fixture(); delete s.files[0].left; assert.throws(() => buildMigrationContracts(s), /Missing retrieval text/);
});

test('unresolved new-side caller is retained explicitly without reusing the old binding', () => {
  const s = fixture(); s.files[2].right.text = s.files[2].right.text.replace('  mutate(state);', '  // unresolved after migration');
  const output = buildMigrationContracts(s); assert.equal(output.contracts.length, 1); assert.match(output.contracts[0].unresolved[0], /new-side/);
  assert.ok(!output.contracts[0].callers.some(c => c.fileId === 'c' && c.side === 'new'));
});

test('approved context callers use only historical old bodies and never borrow current bodies as baseline', () => {
  const s = fixture(), caller = s.files.pop();
  s.history = { base: 'baseline', target: 'target' };
  s.context = [{ path: caller.path, text: caller.right.text, oldText: caller.left.text, oldRevision: 'baseline', revision: 'target' }];
  const output = buildMigrationContracts(s); assert.equal(output.contracts.length, 1);
  const contract = output.contracts[0]; assert.ok(contract.callers.some(c => c.side === 'context-old' && c.path === caller.path && !c.fileId));
  assert.ok(contract.callers.some(c => c.side === 'context' && c.path === caller.path && !c.fileId));
  assert.equal(migrationRegressionMetadata(prepareMigrationRegression(s, createRetrievalScope(s), output.contracts, [])).length, 1);
  assert.ok(!output.groups.some(g => g.fileIds.some(id => id.startsWith('@migration-context:'))));
  delete s.context[0].oldText; assert.deepEqual(buildMigrationContracts(s).contracts, []);
  s.context[0].oldText = caller.left.text; s.context[0].oldRevision = 'forged'; assert.throws(() => buildMigrationContracts(s), /provenance/);
});

test('explicit old entry delegation to new entry works without body equality or matching symbol names', () => {
  const s = fixture();
  s.files[0].right.text = 'import { preload } from "./preload.mjs";\nexport function mutate(state) {\n  preload(state);\n}\n';
  s.files[1].right.text = 'export function preload(state) {\n  if (!state.allowed) { return; }\n  state.value++;\n}\n';
  const result = buildMigrationContracts(s); assert.equal(result.contracts.length, 1);
  assert.equal(result.contracts[0].old[0].symbol, 'mutate'); assert.equal(result.contracts[0].new[0].symbol, 'preload');
});

test('contract count cap preserves unresolved overflow and retained cross-group links', () => {
  const s = fixture(), extra = structuredClone(s.files[1]); extra.id = 'd'; extra.path = 'second.mjs'; s.files.push(extra);
  const bounded = buildMigrationContracts(s, { maxContracts: 1, maxGroupFiles: 1 });
  assert.equal(bounded.contracts.length, 1); assert.ok(bounded.limitations.some(text => /contract limit/.test(text)));
  assert.ok(bounded.links.some(link => link.split));
});

test('C++ ambiguous overloads and local callee shadowing reject rather than guess', () => {
  const s = fixture(true); s.files[1].right.text += 'inline void mutate(State& state) {\n  state.value--;\n}\n';
  assert.equal(buildMigrationContracts(s).contracts.length, 0);
  const other = fixture(true); other.files[0].right.text += 'inline void mutate(int state) {\n  state++;\n}\n';
  assert.equal(buildMigrationContracts(other).contracts.length, 0);
  const shadow = fixture(true); shadow.files[1].right.text = shadow.files[1].right.text.replace('  mutate(state);', '  auto mutate = anotherFunction;\n  mutate(state);');
  assert.equal(buildMigrationContracts(shadow).contracts.length, 0);
});

test('producer roles compile under independent snapshot source/edit validation', () => {
  for (const cpp of [false, true]) {
    const s = fixture(cpp), scope = createRetrievalScope(s), produced = buildMigrationContracts(s);
    const compiled = prepareMigrationRegression(s, scope, produced.contracts, []);
    assert.equal(migrationRegressionMetadata(compiled).length, 1);
  }
});

function classSnapshot(pointer = false) {
  const receiver = pointer ? 'Engine* engine' : 'Engine& engine', op = pointer ? '->' : '.';
  const header = (klass, method) => '#ifndef ' + klass.toUpperCase() + '_H\n#define ' + klass.toUpperCase() + '_H\nclass ' + klass + ' {\npublic:\n  void ' + method + ';\n};\n#endif\n';
  const h = [['Engine.h', header('Engine', 'Mutate(int value)')], ['Preloader.h', header('Preloader', 'Load(' + receiver + ', int value)')], ['Caller.h', header('Caller', 'Run(' + receiver + ', int value)')]];
  const aOld = '#include "Engine.h"\nvoid Engine::Mutate(int value) {\n  if (value < 0) { return; }\n  value++;\n}\n';
  const aNew = aOld.replace('  if (value < 0) { return; }\n', '');
  const bOld = '#include "Preloader.h"\n#include "Engine.h"\nvoid Preloader::Load(' + receiver + ', int value) {\n  value++;\n}\n';
  const bNew = bOld.replace('  value++;', '  if (value < 0) { return; }\n  engine' + op + 'Mutate(value);');
  const c = '#include "Caller.h"\n#include "Engine.h"\nvoid Caller::Run(' + receiver + ', int value) {\n  engine' + op + 'Mutate(value);\n}\n';
  return { id: 'class-snap', history: { base: 'base', target: 'target' },
    context: h.map(([path, text]) => ({ path, text, oldText: text, revision: 'target', oldRevision: 'base' })),
    files: [['a', 'Engine.cpp', aOld, aNew], ['b', 'Preloader.cpp', bOld, bNew], ['c', 'Caller.cpp', c, c]].map(([id, path, before, after]) =>
      ({ id, path, eligibility: 'reviewable', properties: [], left: { text: before }, right: { text: after } })) };
}
for (const pointer of [false, true]) test('out-of-line Engine guard moves to preloader while typed caller still uses public route: ' + pointer, () => {
  const s = classSnapshot(pointer), before = structuredClone(s), output = buildMigrationContracts(s, { maxGroupFiles: 1 });
  assert.equal(output.contracts.length, 1); const c = output.contracts[0];
  assert.equal(c.old[0].symbol, 'Engine::Mutate'); assert.equal(c.new[0].symbol, 'Preloader::Load');
  assert.ok(c.callers.some(r => r.fileId === 'c' && r.side === 'old')); assert.ok(c.callers.some(r => r.fileId === 'c' && r.side === 'new'));
  assert.ok(c.navigationBindings.some(n => n.side === 'context-old' && n.path === 'Engine.h'));
  assert.ok(c.navigationBindings.some(n => n.side === 'context' && n.path === 'Engine.h'));
  assert.ok(c.navigationBindings.some(n => n.receiver === 'engine')); assert.ok(output.links.every(l => l.split));
  assert.ok(c.navigationBindings.every(n => c.sourceIds.includes(n.sourceId)));
  assert.equal(migrationRegressionMetadata(prepareMigrationRegression(s, createRetrievalScope(s), output.contracts, [])).length, 1);
  assert.deepEqual(s, before); assert.equal(c.causality, 'unverified');
});

test('missing or incorrect old header provenance cannot borrow approved current header', () => {
  const s = classSnapshot(); delete s.context[0].oldText;
  assert.deepEqual(buildMigrationContracts(s).contracts, []);
  const forged = classSnapshot(); forged.context[0].oldRevision = 'different'; assert.throws(() => buildMigrationContracts(forged), /provenance/);
  const mismatch = classSnapshot(); mismatch.context[0].oldText = mismatch.context[0].oldText.replace('int value', 'bool value');
  assert.deepEqual(buildMigrationContracts(mismatch).contracts, []);
});

test('class header paths are independently resolved on old and new sides', () => {
  const s = classSnapshot(), header = s.context[0];
  s.context = s.context.slice(1); s.files.push({ id: 'h', path: 'modern/Engine.h', oldPath: 'legacy/Engine.h', eligibility: 'reviewable', properties: [],
    left: { text: header.oldText }, right: { text: header.text } });
  for (const f of s.files.filter(f => f.id !== 'h')) {
    f.left.text = f.left.text.replace('"Engine.h"', '"legacy/Engine.h"'); f.right.text = f.right.text.replace('"Engine.h"', '"modern/Engine.h"');
  }
  const out = buildMigrationContracts(s); assert.equal(out.contracts.length, 1);
  assert.ok(out.contracts[0].navigationBindings.some(n => n.side === 'old' && n.path === 'legacy/Engine.h'));
  s.files[0].left.text = s.files[0].left.text.replace('legacy/Engine.h', 'modern/Engine.h');
  assert.deepEqual(buildMigrationContracts(s).contracts, []);
});

test('project mode unsupported syntax and invalid budgets fail closed and remain bounded', () => {
  const s = fixture(); s.projectScope = {}; assert.deepEqual(buildMigrationContracts(s).contracts, []);
  for (const opts of [{ maxContracts: 0 }, { maxContracts: 101 }, { maxGroupFiles: 0 }, { maxGroupFiles: 21 }]) assert.throws(() => buildMigrationContracts(fixture(), opts), /Invalid/);
  const cpp = fixture(true); cpp.files[1].right.text = '#ifdef ACTIVE\n' + cpp.files[1].right.text + '#endif\n'; assert.deepEqual(buildMigrationContracts(cpp).contracts, []);
});
