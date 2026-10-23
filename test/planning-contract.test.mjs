import test from 'node:test';
import assert from 'node:assert/strict';
import { RISK_PLAN_INSTRUCTIONS, RISK_PLAN_SCHEMA, RETRIEVAL_INSTRUCTIONS } from '../src/prompts.mjs';
import { modelContract } from '../src/model-contract.mjs';
import { validateRiskPlan } from '../src/risk-plan.mjs';

const files = Array.from({ length: 4 }, (_, i) => ({ fileId: 'f' + (i + 1), edits: [{ id: 'e' + (i + 1) }] }));
const catalog = Array.from({ length: 8 }, (_, i) => ({ id: 's' + (i + 1) }));
const example = () => JSON.parse(RISK_PLAN_SCHEMA.match(/\{"risks":\[\{"id".*\}\]\}/u)[0]);
const check = value => validateRiskPlan(value, files, catalog);
const patched = patch => ({ risks: [{ ...example().risks[0], ...patch }] });

test('literal planning example satisfies unchanged strict validator and shared transport contract', () => {
  const value = example(), before = structuredClone(value);
  const result = check(JSON.stringify(value));
  assert.deepEqual(value, before);
  assert.equal(result[0].status, 'hypothesis');
  assert.equal(result[0].causality, 'unverified');
  assert.deepEqual(result[0].editRefs, [{ fileId: 'f1', editId: 'e1' }]);
  assert.ok(RISK_PLAN_INSTRUCTIONS.includes(RISK_PLAN_SCHEMA));
  const contract = modelContract(JSON.stringify({ file: { id: 'f1' } }), RISK_PLAN_INSTRUCTIONS);
  assert.match(contract, /上述risks schema/);
  assert.ok(!contract.includes(RISK_PLAN_SCHEMA), 'do not duplicate full schema in system prompt');
  assert.equal(modelContract('{}', '仅制定审查计划'), RISK_PLAN_SCHEMA);
  assert.deepEqual(check({ risks: [] }), []);
  assert.deepEqual(check(patched({ sourceIds: [] }))[0].sourceIds, []);
  const finalized = modelContract(JSON.stringify({ retrievalFinalization: true }), RISK_PLAN_INSTRUCTIONS);
  assert.match(finalized, /上述risks schema/);
  assert.match(finalized, /禁止requests/);
});

test('strict planning types identities and exact keys reject former malformed responses', () => {
  const invalid = [
    { fileIds: ['src/main.mjs'] }, { fileIds: ['f1', 'f1'] }, { fileIds: [1] },
    { editRefs: ['e1'] }, { editRefs: [{ fileId: 'f1', editId: 'e2' }] },
    { editRefs: [{ fileId: 'f2', editId: 'e2' }] }, { editRefs: [{ fileId: 'f1', editId: 'e1', line: 1 }] },
    { editRefs: [{ fileId: 'f1', editId: 'e1' }, { fileId: 'f1', editId: 'e1' }] },
    { checks: [{ question: 'inspect' }] }, { checks: ['same', 'same'] }, { checks: [' '] },
    { sourceIds: [{ id: 's1' }] }, { sourceIds: ['f1'] }, { sourceIds: ['s1', 's1'] },
    { question: 1 }, { trigger: '' }, { impact: ' ' }, { id: 1 },
    { requests: [] }, { extra: true },
  ];
  for (const patch of invalid) assert.throws(() => check(patched(patch)), undefined, JSON.stringify(patch));
  for (const key of Object.keys(example().risks[0])) {
    const value = example(); delete value.risks[0][key];
    assert.throws(() => check(value), undefined, key);
  }
  assert.throws(() => check({ risks: [], requests: [] }));
  assert.throws(() => check({ risks: [], findings: [] }));
  assert.throws(() => check({ risks: [example().risks[0], example().risks[0]] }));
});

test('planning documented count string and byte limits match strict boundaries', () => {
  const risk = example().risks[0];
  assert.equal(check({ risks: Array.from({ length: 20 }, (_, i) => ({ ...risk, id: 'r' + i })) }).length, 20);
  assert.throws(() => check({ risks: Array.from({ length: 21 }, (_, i) => ({ ...risk, id: 'r' + i })) }));
  for (const key of ['id', 'question', 'trigger', 'impact']) {
    assert.doesNotThrow(() => check(patched({ [key]: 'x'.repeat(2000) })));
    assert.throws(() => check(patched({ [key]: 'x'.repeat(2001) })));
  }
  assert.doesNotThrow(() => check(patched({ checks: Array.from({ length: 8 }, (_, i) => 'x'.repeat(1999) + i) })));
  for (const patch of [{ checks: [] }, { checks: Array.from({ length: 9 }, (_, i) => 'check' + i) }, { checks: ['x'.repeat(2001)] }, { fileIds: [] }, { editRefs: [] }]) assert.throws(() => check(patched(patch)));
  assert.doesNotThrow(() => check(patched({ fileIds: files.map(f => f.fileId), sourceIds: catalog.map(s => s.id) })));
  const manyEdits = [{ fileId: 'f1', edits: Array.from({ length: 21 }, (_, i) => ({ id: 'e' + i })) }];
  const refs = manyEdits[0].edits.map(e => ({ fileId: 'f1', editId: e.id }));
  assert.doesNotThrow(() => validateRiskPlan(patched({ editRefs: refs.slice(0, 20) }), manyEdits, catalog));
  assert.throws(() => validateRiskPlan(patched({ editRefs: refs }), manyEdits, catalog));
  const large = { risks: Array.from({ length: 20 }, (_, i) => ({ ...risk, id: 'r' + i, question: '中'.repeat(2000) })) };
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 65536);
  assert.throws(() => check(large), /Invalid risk plan/);
});

test('retrieval guidance uses physical catalog bounds and independent version identities', () => {
  assert.match(RETRIEVAL_INSTRUCTIONS, /1<=start<=lineCount/);
  assert.ok(RETRIEVAL_INSTRUCTIONS.includes('count<=min(200,lineCount-start+1)'));
  assert.match(RETRIEVAL_INSTRUCTIONS, /lineCount为0不可read/);
  assert.ok(RETRIEVAL_INSTRUCTIONS.includes('old/new/context/context-old各自独立'));
  assert.ok(RISK_PLAN_SCHEMA.includes('>=2 group files'));
});
