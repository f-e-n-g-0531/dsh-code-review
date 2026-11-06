import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMigrationRouteHints } from '../src/migration-route-hints.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
const file = (id, path, old, current) => ({ id, path, eligibility: 'reviewable', left: { text: old }, right: { text: current } });
const snapshot = files => ({ id: 'approved', context: [], files });
const code = (name, body) => 'bool Thing::' + name + '()\n{\n' + body + '\n}\n';

test('preprocessor files retain exact old/new lexical roles without inventing contracts', () => {
  const s = snapshot([file('old', 'old.cpp', '#if OLD\n' + code('Public', '    if (ready) Helper();') + code('Helper', '    return true;'), ''), file('new', 'new.cpp', '', '#if NEW\n' + code('Moved', '    state = 1;\n    Helper();'))]);
  const before = structuredClone(s), result = buildMigrationRouteHints(s), hint = result.hints[0];
  assert.equal(result.hints.length, 1);
  assert.equal(hint.candidateFileId, 'new'); assert.equal(hint.new.symbol, 'Moved');
  assert.equal(hint.oldReferences[0].symbol, 'Helper'); assert.equal(hint.ambiguous, true);
  assert.equal(hint.status, 'navigation-only'); assert.equal(hint.causality, 'unverified');
  assert.ok(result.limitations.some(x => x.includes('active branches unresolved')));
  const scope = createRetrievalScope(s);
  for (const role of [hint.new, ...hint.oldReferences]) {
    const source = scope.catalog().find(c => c.id === role.sourceId);
    assert.equal(source.path, role.path); assert.equal(source.side, role.side);
    const read = scope.read({ id: role.sourceId, start: role.line, count: 1 });
    assert.equal(read.hash, role.hash);
  }
  assert.deepEqual(s, before);
  assert.equal(result.contracts, undefined);
  assert.ok(!JSON.stringify(result).includes('state = 1'));
});

test('comments strings and macro directive tokens are not old references', () => {
  const old = '// Helper();\nconst char* p = "Helper()";\n/* Helper(); */\n#define X Helper()\n';
  assert.equal(buildMigrationRouteHints(snapshot([file('a', 'a.cpp', old, code('Moved', '    Helper();'))])).hints.length, 0);
});

test('same-name ambiguity remains navigation and lists bounded old alternatives', () => {
  const old = Array.from({ length: 12 }, () => '    Moved();').join('\n').replaceAll('\\n', '\n');
  const result = buildMigrationRouteHints(snapshot([file('a', 'a.cpp', old, code('Moved', '    return true;'))]));
  assert.equal(result.hints[0].ambiguous, true); assert.equal(result.hints[0].oldReferences.length, 8);
  assert.ok(result.hints[0].unresolved.some(x => x.includes('truncated')));
});

test('per-source total file and hint limits are explicit and never imply no prior route', () => {
  const oversized = buildMigrationRouteHints(snapshot([file('a', 'a.cpp', ' '.repeat(256 * 1024 + 1), code('Moved', '    return true;'))]));
  assert.equal(oversized.hints.length, 0); assert.ok(oversized.limitations.some(x => x.includes('Per-source')));
  const total = buildMigrationRouteHints(snapshot(Array.from({ length: 9 }, (_, i) => file('f' + i, i + '.cpp', ' '.repeat(256 * 1024), ''))));
  assert.ok(total.limitations.some(x => x.includes('Two MiB')));
  assert.throws(() => buildMigrationRouteHints(snapshot(Array.from({ length: 201 }, () => ({})))), /Invalid/);
  assert.throws(() => buildMigrationRouteHints(snapshot([]), { maxHints: 21 }), /Invalid/);
  const result = buildMigrationRouteHints(snapshot([file('a', 'a.cpp', 'First();\nSecond();', code('First', '    return true;') + code('Second', '    return true;'))]), { maxHints: 1 });
  assert.equal(result.hints.length, 1); assert.ok(result.limitations.some(x => x.includes('Hint count limit')));
});



test('one bounded old enclosing-method hop locates callers without a semantic contract', () => {
  const nl = String.fromCharCode(10);
  const helper = code('Prepare', '    Apply();') + code('Apply', '    return true;');
  const wrapper = code('Accept', '    if (allowed) Prepare();');
  const s = snapshot([file('h', 'helper.cpp', helper, ''), file('w', 'wrapper.cpp', wrapper, ''), file('n', 'new.cpp', '', code('Submit', '    Apply();'))]);
  const hint = buildMigrationRouteHints(s).hints[0];
  assert.equal(hint.new.symbol, 'Submit');
  assert.ok(hint.oldCallerReferences.some(r => r.path === 'wrapper.cpp' && r.symbol === 'Prepare'));
  assert.ok(hint.oldCallerReferences.length <= 4);
  assert.equal(hint.status, 'navigation-only'); assert.equal(hint.causality, 'unverified');
  assert.equal(hint.ambiguous, true);
  const scope = createRetrievalScope(s);
  for (const role of hint.oldCallerReferences) assert.equal(scope.read({ id: role.sourceId, start: role.line, count: 1 }).hash, role.hash);
  const changed = structuredClone(s); changed.files[1].left.text = nl + changed.files[1].left.text;
  assert.notEqual(buildMigrationRouteHints(changed).hints[0].id, hint.id);
  const crowded = structuredClone(s); crowded.files[1].left.text = Array.from({ length: 7 }, () => 'Prepare();').join(nl);
  const truncated = buildMigrationRouteHints(crowded).hints[0];
  assert.equal(truncated.oldCallerReferences.length, 4);
  assert.ok(truncated.unresolved.some(value => value.includes('truncated to four')));
});

test('unchanged methods and project mode never infer migration counterparts', () => {
  const text = code('Public', '    Helper();');
  assert.equal(buildMigrationRouteHints(snapshot([file('a', 'a.cpp', text, text)])).hints.length, 0);
  assert.equal(buildMigrationRouteHints({ ...snapshot([file('a', 'a.cpp', text, text)]), projectScope: true }).hints.length, 0);
});
