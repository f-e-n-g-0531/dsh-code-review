import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceReceipts } from '../src/evidence-receipts.mjs';
import { createSnapshotReader } from '../src/snapshot-reader.mjs';
import { validateEvidenceReference } from '../src/evidence-reference.mjs';

const fixture = (options) => createSnapshotReader('snap', [{ id: 's1', text: 'guard();' + String.fromCharCode(13, 10) }], options);
test('receipt resolves exact returned EOF range and CRLF through ordinary budgeted validation', () => {
  const reader = fixture();
  const receipts = createEvidenceReceipts(reader.read);
  const result = receipts.read({ id: 's1', start: 1, count: 200 });
  const reference = receipts.resolve({ receiptId: result.receiptId });
  assert.ok(reference.count < 200);
  assert.equal(reference.text, result.text);
  result.text = 'changed by caller';
  assert.notEqual(receipts.resolve({ receiptId: result.receiptId }).text, result.text);
  reference.text = 'another mutation';
  const verified = validateEvidenceReference(receipts.resolve({ receiptId: result.receiptId }), reader.read);
  assert.equal(verified.causality, 'unverified');
  assert.equal(reader.usage().calls, 2);
});
test('unknown, cross-review and mixed receipt references fail closed', () => {
  const reader = fixture();
  const a = createEvidenceReceipts(reader.read), b = createEvidenceReceipts(reader.read);
  const { receiptId } = a.read({ id: 's1', start: 1, count: 1 });
  for (const value of [{ receiptId: 'forged' }, { receiptId, text: 'override' }, { receiptId: null }]) assert.throws(() => a.resolve(value), /Invalid evidence receipt/);
  assert.throws(() => b.resolve({ receiptId }), /Invalid evidence receipt/);
  const legacy = { text: 'not silently repaired' };
  assert.equal(a.resolve(legacy), legacy);
});
test('receipts neither bypass read limits nor refund final validation budget', () => {
  const reader = fixture({ maxCalls: 1 });
  const receipts = createEvidenceReceipts(reader.read, { limit: 1 });
  const { receiptId } = receipts.read({ id: 's1', start: 1, count: 1 });
  assert.throws(() => receipts.read({ id: 's1', start: 1, count: 1 }), /receipt limit/);
  assert.throws(() => validateEvidenceReference(receipts.resolve({ receiptId }), reader.read), /budget/);
  assert.throws(() => createEvidenceReceipts(reader.read, { limit: 51 }), /configuration/);
});
