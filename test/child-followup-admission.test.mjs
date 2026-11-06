import test from 'node:test';
import assert from 'node:assert/strict';
import { createChildFollowupAdmission, ChildFollowupCapacityError, isChildFollowupCapacityError } from '../src/child-followup-admission.mjs';
const envelope = { system: 'review', messages: [{ role: 'user', content: [{ type: 'text', text: 'approved source' }] }], tools: [{ name: 'review_snapshot', parameters: {} }] };
const result = { results: [{ text: '"\\\r\n中文😀', hash: 'a'.repeat(64) }] };
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const delivery = value => bytes({ type: 'text', text: JSON.stringify(value) });
test('observes exact logical envelope and admits exact double-serialized Unicode tool text', () => {
  const policy = createChildFollowupAdmission({ maxInputBytes: 100000 });
  const first = policy.observe(envelope), accepted = policy.admit(result);
  assert.equal(first.lastEnvelopeBytes, bytes(envelope));
  assert.equal(accepted.deliveryBytes, delivery(result));
  assert.equal(accepted.requiredBytes, bytes(envelope) + delivery(result) + 16384);
  assert.equal(accepted.runtimeGuarantee, false); assert.equal(policy.finalOnly(), false);
  assert.equal(policy.summary().committedDeliveryBytes, delivery(result));
});
test('same-generation tool deliveries accumulate; rejected results do not commit or leak source', () => {
  const cap = bytes(envelope) + delivery(result) * 2 + 16;
  const policy = createChildFollowupAdmission({ maxInputBytes: cap, finalizationReserveBytes: 16 });
  policy.observe(envelope); policy.admit(result); policy.admit(result);
  assert.throws(() => policy.admit({ text: 'PRIVATE_SOURCE' }), error => {
    assert.equal(isChildFollowupCapacityError(error), true); assert.equal(error.approvedCap, cap);
    assert.ok(!JSON.stringify(error).includes('PRIVATE_SOURCE')); return true;
  });
  assert.equal(policy.summary().committedDeliveryBytes, delivery(result) * 2);
  assert.equal(policy.summary().acceptedDeliveries, 2); assert.equal(policy.finalOnly(), true);
});
test('new generation resets accumulated deliveries but cannot clear sticky final-only', () => {
  const policy = createChildFollowupAdmission({ maxInputBytes: bytes(envelope) + delivery(result), finalizationReserveBytes: 0 });
  policy.observe(envelope); policy.admit(result);
  policy.observe(envelope); assert.equal(policy.summary().committedDeliveryBytes, 0); policy.admit(result);
  assert.throws(() => policy.admit(result), isChildFollowupCapacityError);
  policy.observe({ system: '', messages: [], tools: [] });
  assert.equal(policy.summary().committedDeliveryBytes, 0); assert.equal(policy.summary().generation, 3);
  assert.equal(policy.finalOnly(), true); assert.throws(() => policy.admit({}), isChildFollowupCapacityError);
});
test('provider/prototype/serialized errors cannot acquire local capacity brand', () => {
  const policy = createChildFollowupAdmission({ maxInputBytes: 10, finalizationReserveBytes: 0 });
  let original; try { policy.admit(result); } catch (error) { original = error; }
  assert.ok(original instanceof ChildFollowupCapacityError);
  for (const value of [null, undefined, 5, { code: 'CHILD_FOLLOWUP_CAPACITY' }, { ...original }, Object.create(ChildFollowupCapacityError.prototype), JSON.parse(JSON.stringify(original)), structuredClone(original)]) assert.equal(isChildFollowupCapacityError(value), false);
  assert.throws(() => { original.approvedCap = 999; }, TypeError);
});
test('missing observation fails closed, snapshots are detached and no reader callback is used', () => {
  const policy = createChildFollowupAdmission({ maxInputBytes: 100000 });
  assert.throws(() => policy.admit(result), isChildFollowupCapacityError); assert.equal(policy.finalOnly(), true);
  const snapshot = policy.summary(); policy.observe(envelope);
  assert.equal(snapshot.observed, false); assert.ok(Object.isFrozen(snapshot));
  assert.ok(!JSON.stringify(policy.summary()).includes('approved source'));
});
test('accessor policy and envelope descriptors reject without evaluating getters; arithmetic cannot overflow', () => {
  let evaluated = false;
  const options = { get maxInputBytes() { evaluated = true; return 100000; } };
  assert.throws(() => createChildFollowupAdmission(options), TypeError);
  const policy = createChildFollowupAdmission({ maxInputBytes: 100000 });
  assert.throws(() => policy.observe({ get messages() { evaluated = true; return []; } }), TypeError);
  assert.equal(evaluated, false);
  const huge = createChildFollowupAdmission({ maxInputBytes: Number.MAX_SAFE_INTEGER, finalizationReserveBytes: Number.MAX_SAFE_INTEGER });
  huge.observe(envelope); assert.throws(() => huge.admit(result), TypeError);
  assert.equal(huge.summary().committedDeliveryBytes, 0);
  assert.throws(() => new ChildFollowupCapacityError({ requiredBytes: 1, approvedCap: 1, lastEnvelopeBytes: 0, deliveryBytes: 0, committedDeliveryBytes: 0, finalizationReserveBytes: 0, raw: 'SOURCE' }), TypeError);
});
test('invalid policies and unsafe numeric budgets reject without increasing cap', () => {
  for (const options of [null, {}, { maxInputBytes: 0 }, { maxInputBytes: Infinity }, { maxInputBytes: Number.MAX_SAFE_INTEGER + 1 }, { maxInputBytes: 100, finalizationReserveBytes: -1 }, { maxInputBytes: 100, finalizationReserveBytes: 1.5 }, { maxInputBytes: 100, model: 'guess' }]) assert.throws(() => createChildFollowupAdmission(options), TypeError);
  const policy = createChildFollowupAdmission({ maxInputBytes: 100000 });
  for (const value of [null, [], 'source']) assert.throws(() => policy.observe(value), TypeError);
  policy.observe(envelope); assert.throws(() => policy.admit(undefined), TypeError);
});
