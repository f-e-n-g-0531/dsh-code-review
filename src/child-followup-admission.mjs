const errors = new WeakSet();
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const invalid = () => { throw new TypeError('Invalid child followup admission'); };
const data = (object, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor && !Object.hasOwn(descriptor, 'value')) invalid();
  return descriptor?.value;
};
const fields = (object, allowed) => {
  if (!object || typeof object !== 'object' || Array.isArray(object) || ![Object.prototype, null].includes(Object.getPrototypeOf(object)) || Reflect.ownKeys(object).some(key => typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(object, key), 'value'))) invalid();
};

export class ChildFollowupCapacityError extends Error {
  constructor(metadata) {
    fields(metadata, ['requiredBytes', 'approvedCap', 'lastEnvelopeBytes', 'deliveryBytes', 'committedDeliveryBytes', 'finalizationReserveBytes']);
    const { requiredBytes, approvedCap, lastEnvelopeBytes, deliveryBytes, committedDeliveryBytes, finalizationReserveBytes } = metadata;
    if (!positive(requiredBytes) || !positive(approvedCap) || !nonnegative(lastEnvelopeBytes) || !nonnegative(deliveryBytes) || !nonnegative(committedDeliveryBytes) || !nonnegative(finalizationReserveBytes)) invalid();
    super('Supplemental result cannot be admitted within the declared child input policy');
    Object.defineProperties(this, Object.fromEntries(Object.entries({ name: 'ChildFollowupCapacityError', code: 'CHILD_FOLLOWUP_CAPACITY', requiredBytes, approvedCap, lastEnvelopeBytes, deliveryBytes, committedDeliveryBytes, finalizationReserveBytes, runtimeGuarantee: false }).map(([key, value]) => [key, { value, enumerable: key !== 'name' }])));
    errors.add(this);
  }
}
export function isChildFollowupCapacityError(error) { return errors.has(error); }

// This is a conservative known-growth policy, NOT a next-envelope predictor.
// Public pre-stream options omit the subsequent assistant/tool-call messages and
// host wrappers. The real beforeModelCall hard cap remains mandatory, even after
// admission succeeds. No receipt, reader, audit callback or authority is created.
export function createChildFollowupAdmission(options = {}) {
  fields(options, ['maxInputBytes', 'finalizationReserveBytes']);
  const { maxInputBytes, finalizationReserveBytes = 16384 } = options;
  if (!positive(maxInputBytes) || !nonnegative(finalizationReserveBytes)) invalid();
  let lastEnvelopeBytes = 0, committedDeliveryBytes = 0, observed = false, stopped = false, generation = 0, acceptedDeliveries = 0, rejectedDeliveries = 0;
  const summary = () => Object.freeze({ maxInputBytes, finalizationReserveBytes, lastEnvelopeBytes, committedDeliveryBytes, generation, acceptedDeliveries, rejectedDeliveries, observed, finalOnly: stopped, runtimeGuarantee: false });
  return Object.freeze({
    observe(envelope) {
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) invalid();
      const bytes = Buffer.byteLength(JSON.stringify({ system: data(envelope, 'system'), messages: data(envelope, 'messages'), tools: data(envelope, 'tools') }));
      if (!positive(bytes) || generation === Number.MAX_SAFE_INTEGER) invalid();
      lastEnvelopeBytes = bytes; committedDeliveryBytes = 0; observed = true; generation++;
      return summary();
    },
    admit(result) {
      // Match snapshot tool execute's JSON string and renderer's text block. The
      // second serialization accounts for quotes, backslashes, controls and UTF8.
      if (acceptedDeliveries === Number.MAX_SAFE_INTEGER || rejectedDeliveries === Number.MAX_SAFE_INTEGER) invalid();
      const json = JSON.stringify(result);
      if (typeof json !== 'string') invalid();
      const deliveryBytes = Buffer.byteLength(JSON.stringify({ type: 'text', text: json }));
      const requiredBytes = lastEnvelopeBytes + committedDeliveryBytes + deliveryBytes + finalizationReserveBytes;
      if (!positive(deliveryBytes) || !positive(requiredBytes) || !Number.isSafeInteger(committedDeliveryBytes + deliveryBytes)) invalid();
      if (!observed || stopped || requiredBytes > maxInputBytes) {
        stopped = true; rejectedDeliveries++;
        throw new ChildFollowupCapacityError({ requiredBytes, approvedCap: maxInputBytes, lastEnvelopeBytes, deliveryBytes, committedDeliveryBytes, finalizationReserveBytes });
      }
      committedDeliveryBytes += deliveryBytes; acceptedDeliveries++;
      return Object.freeze({ admitted: true, deliveryBytes, requiredBytes, approvedCap: maxInputBytes, finalizationReserveBytes, runtimeGuarantee: false });
    },
    finalOnly: () => stopped,
    summary,
  });
}
