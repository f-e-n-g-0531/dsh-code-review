import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildRejectionBranchNavigation } from '../src/rejection-branch-navigation.mjs';
const lines = (...rows) => rows.join(String.fromCharCode(10));
const file = (old, current = old) => ({ id: 'f', path: 'generic.cpp', left: { text: old }, right: { text: current } });

test('literal rejection exits and unresolved uppercase call are distinct, with no semantic conclusions', () => {
  const text = lines('REQUIRE_INPUT(name)', 'if (!mapped)', '    return false;', 'if (!object) return nullptr;', 'state = accepted;', 'return true;');
  const source = file('', text), before = structuredClone(source);
  const result = buildRejectionBranchNavigation(source);
  assert.deepEqual(result.branches.map(r => [r.line, r.kind]), [[1, 'macro-call-unresolved'], [3, 'literal-return-false'], [4, 'literal-return-null']]);
  assert.ok(result.branches.every(r => r.side === 'new' && r.status === 'navigation-only' && r.semantics === 'unresolved'));
  assert.ok(!JSON.stringify(result).includes('state = accepted'));
  assert.deepEqual(source, before);
});

test('comments strings escaped quotes and macro definitions do not create false return rows', () => {
  const text = lines('// return false;', 'char* p = "return NULL;";', '/* return nullptr;', 'return false; */', '#define SOMETHING return false;', 'return false;');
  const result = buildRejectionBranchNavigation(file('', text));
  assert.deepEqual(result.branches.map(r => r.line), [6]);
  assert.ok(result.limitations.some(x => x.includes('preprocessor')));
});

test('CRLF coordinates and full-source hashes remain exact on both sides', () => {
  const old = ['if (x)', 'return false;', ''].join(String.fromCharCode(13, 10));
  const current = lines('if (x)', '{', 'return NULL;', '}');
  const result = buildRejectionBranchNavigation(file(old, current));
  assert.deepEqual(result.branches.map(r => [r.side, r.line]), [['old', 2], ['new', 3]]);
  for (const row of result.branches) assert.equal(row.hash, createHash('sha256').update(row.side === 'old' ? old : current).digest('hex'));
});

test('fair total cap discloses side omissions without treating accepted writes as rejection', () => {
  const many = lines(...Array(30).fill('return false;'));
  const result = buildRejectionBranchNavigation(file(many, many), { maxBranches: 3 });
  assert.equal(result.branches.length, 3);
  assert.deepEqual(result.branches.map(r => r.side), ['old', 'new', 'old']);
  assert.ok(result.limitations.some(x => x.includes('omitted old=28, new=29')));
  assert.equal(buildRejectionBranchNavigation(file('value = true; return true;')).branches.length, 0);
});

test('unsupported literals and explicit source cap stop scanning with limitations', () => {
  const backtick = String.fromCharCode(96), slash = String.fromCharCode(92);
  for (const text of ['R"(raw)"; return false;', backtick + 'template' + backtick, 'x' + slash + String.fromCharCode(10) + 'return false;', '/* unclosed', '"unclosed']) {
    const result = buildRejectionBranchNavigation(file('', text)); assert.equal(result.branches.length, 0); assert.ok(result.limitations.some(x => x.includes('not scanned')));
  }
  assert.equal(buildRejectionBranchNavigation(file('', ' '.repeat(262145))).branches.length, 0);
  for (const maxBranches of [0, 25, 1.5]) assert.throws(() => buildRejectionBranchNavigation(file(''), { maxBranches }), /Invalid/);
});
