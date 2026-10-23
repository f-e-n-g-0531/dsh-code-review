import { modelContract } from './model-contract.mjs';
import { nativeResultWireBytes } from './model-tools.mjs';

// Same UTF-8 fields checked by the adapter immediately before transmission.
// Does not estimate provider tokens or invent hidden slack for later corrections.
export function modelWireBudget(request, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid model wire budget');
  if (!request || typeof request.instructions !== 'string' || typeof request.input !== 'string') throw new Error('Invalid model wire request');
  if (request.nativeOutputTools !== undefined && typeof request.nativeOutputTools !== 'boolean') throw new Error('nativeOutputTools must be boolean');
  const bytes = Buffer.byteLength(request.input) + Buffer.byteLength(request.instructions + '\n' + modelContract(request.input, request.instructions)) +
    (request.nativeOutputTools === true ? nativeResultWireBytes(request.input, request.instructions) : 0);
  return { bytes, maxBytes, fits: bytes <= maxBytes };
}

// Local to one already captured scope. This is measurement policy only, never a
// larger source authorization, reader budget, or cross-review/global default.
const scopePolicies = new WeakMap();
export function configureWireBudget(scope, { nativeOutputTools } = {}) {
  if (!scope || (typeof scope !== 'object' && typeof scope !== 'function')) throw new Error('Invalid model wire scope');
  if (typeof nativeOutputTools !== 'boolean') throw new Error('nativeOutputTools must be boolean');
  const previous = scopePolicies.get(scope);
  if (previous !== undefined && previous !== nativeOutputTools) throw new Error('Model wire policy already configured');
  scopePolicies.set(scope, nativeOutputTools);
  return scope;
}
export function nativeWireEnabled(request, scope) {
  if (request?.nativeOutputTools !== undefined) {
    if (typeof request.nativeOutputTools !== 'boolean') throw new Error('nativeOutputTools must be boolean');
    return request.nativeOutputTools;
  }
  return scope ? scopePolicies.get(scope) === true : false;
}
