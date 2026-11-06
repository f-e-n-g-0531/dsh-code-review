// Host-only capabilities. JSON fields can filter delivery but never issue authority.
// Enumerable symbol survives trusted request spread wrappers, never JSON serialization.
const policySlot = Symbol('host verification receipt policy');
const proofs = new WeakMap();
const RESERVED_IDS = Array.from({ length: 50 }, (_, i) => '00000000-0000-4000-8000-' + String(i).padStart(12, '0'));
export function createVerificationReceiptPolicy(hasIssued) {
  if (typeof hasIssued !== 'function') throw new Error('Receipt issuer capability required');
  const policy = Object.freeze({});
  proofs.set(policy, hasIssued);
  return Object.freeze({ bind(request) { request[policySlot] = policy; return request; } });
}
export function transferReceiptPolicy(from, to) {
  const policy = from?.[policySlot];
  if (proofs.has(policy)) to[policySlot] = policy;
  return to;
}
export function receiptSchemaProof(request, { forBudget = false } = {}) {
  const policy = request?.[policySlot];
  if (!proofs.has(policy)) return undefined;
  const hasIssued = proofs.get(policy);
  let ids = [];
  if (forBudget) ids = RESERVED_IDS;
  else {
    const payload = JSON.parse(request.input);
    for (const item of payload.retrieved ?? []) {
      const result = item?.result;
      if (item?.request?.kind === 'read' && result?.omitted !== true && typeof result?.text === 'string' && result.text && typeof result.receiptId === 'string' && hasIssued(result.receiptId)) ids.push(result.receiptId);
    }
  }
  const proof = Object.freeze({});
  proofs.set(proof, Object.freeze([...new Set(ids)].sort()));
  return proof;
}
export function trustedReceiptIds(proof) {
  const ids = proof && proofs.get(proof);
  return Array.isArray(ids) ? [...ids] : undefined;
}
