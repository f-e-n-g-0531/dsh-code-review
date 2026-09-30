// Offline reference validation only; neither approval nor causal proof.
// read must be the existing approved snapshot reader, with its shared budgets.
export function validateEvidenceReference(value, read) {
  const keys = ['snapshotId', 'sourceId', 'hash', 'start', 'count', 'text'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw new Error('Invalid evidence reference');
  for (const k of ['snapshotId', 'sourceId']) if (typeof value[k] !== 'string' || !value[k] || value[k].length > 200) throw new Error('Invalid evidence identity');
  if (typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)) throw new Error('Invalid evidence hash');
  if (!Number.isSafeInteger(value.start) || value.start < 1 || !Number.isSafeInteger(value.count) || value.count < 1 || value.count > 200) throw new Error('Invalid evidence range');
  if (typeof value.text !== 'string' || !value.text || Buffer.byteLength(value.text) > 64 * 1024) throw new Error('Invalid evidence text');
  const actual = read({ id: value.sourceId, start: value.start, count: value.count });
  // Require the complete exact range: readers may otherwise clamp at EOF.
  const mismatches = keys.filter(k => actual[k] !== value[k]);
  // Only fixed schema keys; never echo source text or model-supplied values.
  if (mismatches.length) throw new Error('Evidence does not match approved snapshot: ' + mismatches.join(', '));
  return { ...value, status: 'references-validated', causality: 'unverified' };
}
