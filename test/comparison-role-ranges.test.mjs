import test from 'node:test';
import assert from 'node:assert/strict';
import { buildComparisonRoleRanges } from '../src/comparison-role-ranges.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
const lines = (...rows) => rows.join(String.fromCharCode(10));
const file = (old, current) => ({ id: 'f', path: 'a.cpp', eligibility: 'reviewable', left: { text: old }, right: { text: current } });
const snapshot = files => ({ id: 'snapshot', context: [], files });

test('exact CRLF function spans mask comments literals and preserve source identities', () => {
  const current = lines('#define API export', 'bool Owner::Run(int value)', '{', '    const char* p = "} /* not comment */";', "    char c = '}';", '    /* { ignored', '       } ignored */', '    if (value) { value++; }', '    return value > 0;', '}', '');
  const old = lines('bool Run(int value)', '{', '    return false;', '}', '');
  const s = snapshot([file(old, current.split(String.fromCharCode(10)).join(String.fromCharCode(13, 10)))]), before = structuredClone(s);
  const result = buildComparisonRoleRanges(s), scope = createRetrievalScope(s);
  assert.equal(result.ranges.length, 2);
  const range = result.ranges.find(r => r.side === 'new');
  assert.equal(range.start, 2); assert.equal(range.count, 9); assert.equal(range.symbol, 'Owner::Run');
  for (const r of result.ranges) {
    const read = scope.read({ id: r.sourceId, start: r.start, count: r.count });
    assert.equal(read.hash, r.hash); assert.equal(read.count, r.count);
    assert.equal(r.textRangeOnly, true); assert.equal(r.relationshipStatus, 'unverified');
  }
  assert.ok(result.limitations.some(value => value.includes('macros not expanded')));
  assert.deepEqual(s, before);
});

test('raw strings template strings line splices malformed literals and braces reject whole sources', () => {
  const backslash = String.fromCharCode(92), quote = String.fromCharCode(96);
  for (const text of [lines('bool Bad()', '{'), lines('bool Bad()', '{', '/* unfinished', '}'), lines('bool Bad()', '{', 'char* p = "unfinished;', '}'), 'R"(raw)"', quote + 'template' + quote, 'x' + backslash + String.fromCharCode(10) + 'y']) {
    const result = buildComparisonRoleRanges(snapshot([file('', text)]));
    assert.equal(result.ranges.length, 0); assert.ok(result.limitations.length > 1);
  }
});

test('conditional and directive-bearing bodies cannot be certified while outside defines allow textual spans', () => {
  for (const current of [lines('#if FLAG', 'bool Run()', '{', 'return true;', '}', '#endif'), lines('bool Run()', '{', '#if FLAG', 'return true;', '#endif', '}')]) {
    assert.equal(buildComparisonRoleRanges(snapshot([file('', current)])).ranges.length, 0);
  }
  assert.equal(buildComparisonRoleRanges(snapshot([file('', lines('#define FLAG 1', 'bool Run()', '{', 'return true;', '}'))])).ranges.length, 1);
});

test('duplicate symbols are separate physical ranges and unsupported multiline or inline syntax is omitted', () => {
  const current = lines('bool Run(int a)', '{', 'return true;', '}', 'bool Run(float a)', '{', 'return false;', '}', 'bool Other(', 'int a)', '{', 'return true;', '}', 'bool Inline() { return true; }');
  const result = buildComparisonRoleRanges(snapshot([file('', current)]));
  assert.equal(result.ranges.length, 2); assert.deepEqual(result.ranges.map(r => r.start), [1, 5]);
  assert.ok(result.ranges.every(r => r.symbol === 'Run'));
  assert.ok(result.limitations.some(value => value.includes('multiline')));
});

test('JS standalone headers and captured context sides carry exact range hashes', () => {
  const s = snapshot([]); s.context = [{ path: 'helper.js', text: lines('export function run(a)', '{', 'return a;', '}') }];
  const result = buildComparisonRoleRanges(s), r = result.ranges[0];
  assert.equal(r.side, 'context'); assert.equal(r.symbol, 'run');
  assert.equal(createRetrievalScope(s).read({ id: r.sourceId, start: r.start, count: r.count }).hash, r.hash);
});



test('approved source filter preserves full catalog identities and avoids unrelated range cap', () => {
  const many = Array.from({ length: 201 }, (_, i) => lines('bool Function' + i + '()', '{', 'return true;', '}')).join(String.fromCharCode(10));
  const s = snapshot([file('', many), { ...file('', lines('bool Selected()', '{', 'return true;', '}')), id: 'selected', path: 'selected.cpp' }]);
  const catalog = createRetrievalScope(s).catalog(), source = catalog.find(r => r.fileId === 'selected' && r.side === 'new');
  assert.equal(buildComparisonRoleRanges(s).ranges.length, 200);
  const selected = buildComparisonRoleRanges(s, { sourceIds: [source.id] });
  assert.equal(selected.ranges.length, 1); assert.equal(selected.ranges[0].sourceId, source.id);
  assert.equal(selected.ranges[0].symbol, 'Selected');
  const small = structuredClone(s); small.files[0].right.text = lines('bool Small()', '{', 'return true;', '}');
  assert.deepEqual(buildComparisonRoleRanges(small, { sourceIds: [source.id] }).ranges, buildComparisonRoleRanges(small).ranges.filter(range => range.sourceId === source.id));
  assert.equal(selected.ranges[0].hash, createRetrievalScope(s).read({ id: source.id, start: 1, count: 4 }).hash);
  for (const sourceIds of [[], [source.id, source.id], ['unknown'], Array.from({ length: 17 }, (_, i) => 's' + i)]) assert.throws(() => buildComparisonRoleRanges(s, { sourceIds }), /source filter/);
});

test('source total file and output count caps explicitly disclose omissions', () => {
  assert.throws(() => buildComparisonRoleRanges(snapshot(Array(201).fill({}))), /Invalid/);
  const big = buildComparisonRoleRanges(snapshot([file('', ' '.repeat(262145))]));
  assert.equal(big.ranges.length, 0); assert.ok(big.limitations.some(value => value.includes('Per-source')));
  const total = buildComparisonRoleRanges(snapshot(Array.from({ length: 9 }, (_, i) => ({ ...file('', ' '.repeat(262144)), id: 'f' + i, path: i + '.cpp' }))));
  assert.ok(total.limitations.some(value => value.includes('Total captured')));
  const many = Array.from({ length: 201 }, (_, i) => lines('bool Function' + i + '()', '{', 'return true;', '}')).join(String.fromCharCode(10));
  const bounded = buildComparisonRoleRanges(snapshot([file('', many)]));
  assert.equal(bounded.ranges.length, 200); assert.ok(bounded.limitations.some(value => value.includes('Range count')));
});
