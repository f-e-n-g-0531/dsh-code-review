import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeEvaluation } from '../evaluation/summarize.mjs';
test('adjudication summary keeps failed and unresolved cases in total', () => {
  const rows = ['hit','miss','falsePositive','clean','uncertain','failed','incomplete'].map((outcome,i) => ({ id: String(i), outcome, expectedRegression: !['falsePositive','clean'].includes(outcome) }));
  const result = summarizeEvaluation(rows);
  assert.equal(result.total, 7); assert.equal(result.decided, 4); assert.equal(result.unresolved, 3);
  assert.equal(result.decidedCaseRecall, 0.5);
  assert.equal(result.decidedNegativeFalsePositiveRate, 0.5);
  assert.deepEqual(result, summarizeEvaluation([...rows].reverse()));
  assert.equal(summarizeEvaluation([]).decidedCaseRecall, null);
  assert.equal(summarizeEvaluation(rows.slice(4)).decidedNegativeFalsePositiveRate, null);
});
test('summary rejects coercible non-string outcomes before counting', () => {
  for (const outcome of [['hit'], new String('hit'), null, 1, { toString: () => 'hit' }]) {
    assert.throws(() => summarizeEvaluation([{ id: 'a', expectedRegression: false, outcome }]), /Invalid evaluation row/);
  }
});
test('summary rejects contradictory truth, duplicate cases and unknown decisions', () => {
  const row = { id: 'a', outcome: 'hit', expectedRegression: true };
  for (const rows of [[row,row], [{...row, expectedRegression:false}], [{...row,outcome:'supported'}], Array(201).fill(row)]) assert.throws(() => summarizeEvaluation(rows), /evaluation/);
});
