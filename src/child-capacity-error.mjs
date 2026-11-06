import { splitWholeBatch } from './whole-batch-split.mjs';

const owned = new WeakSet();
const positive = value => Number.isSafeInteger(value) && value > 0;

// Created only by the host's synchronous pre-dispatch capacity guard. Provider
// error codes and model-authored fields never authorize splitting/replaying work.
export class ChildInputCapacityError extends Error {
  constructor(requiredBytes, approvedCap, options) {
    if (!positive(requiredBytes) || !positive(approvedCap) || requiredBytes <= approvedCap || !options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'unsent') || typeof options.unsent !== 'boolean') throw new TypeError('Invalid child input capacity error');
    super('Child logical model input exceeds approved capacity');
    Object.defineProperties(this, {
      name: { value: 'ChildInputCapacityError', configurable: true },
      code: { value: 'WHOLE_SCOPE_INPUT_BUDGET', enumerable: true },
      requiredBytes: { value: requiredBytes, enumerable: true },
      approvedCap: { value: approvedCap, enumerable: true },
      unsent: { value: options.unsent, enumerable: true },
    });
    owned.add(this);
  }
}

export function isUnsentChildCapacityError(error, cap) {
  return positive(cap) && owned.has(error) && error.code === 'WHOLE_SCOPE_INPUT_BUDGET' && positive(error.requiredBytes) && error.requiredBytes > cap && error.approvedCap === cap && error.unsent === true;
}

// No work is dispatched here. The scheduler must join/revoke the unsent parent
// before using these children, enforce its depth bound and never rerun sent peers.
export function splitUnsentChildBatch(batch, error, { approvedCap } = {}) {
  if (!isUnsentChildCapacityError(error, approvedCap)) return null;
  if (!batch || typeof batch.payload !== 'string' || typeof batch.instructions !== 'string' || !Array.isArray(batch.fileIds) || !(batch.changes instanceof Map)) throw new TypeError('Invalid unsent child batch');
  const input = JSON.parse(batch.payload);
  const rows = input?.reviews;
  if (input?.sourceMode !== 'group-primary' || !Array.isArray(rows) || rows.length !== batch.fileIds.length || rows.length > 200 || new Set(batch.fileIds).size !== rows.length || rows.some((row, index) => typeof row?.fileId !== 'string' || !row.fileId || row.fileId !== batch.fileIds[index] || !batch.changes.has(row.fileId))) throw new TypeError('Invalid unsent child members');
  // The host-owned unsent guard above is still mandatory. Share only the pure
  // partition so both recovery paths scope member-local navigation identically.
  return splitWholeBatch(batch);
}
