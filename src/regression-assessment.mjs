// Host-validated comparison references are not proof of a model's causal claim.
export function validateRegressionAssessment(value, evidence, catalog, fileId) {
  if (value === undefined) return { classification: 'unassessed', causality: 'unverified' };
  const keys = ['classification', 'reason', 'oldEvidence', 'newEvidence'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw new Error('Invalid regression assessment');
  if (!['introduced', 'preexisting', 'uncertain'].includes(value.classification) || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 8000) throw new Error('Invalid regression explanation');
  const sources = new Map(catalog.map(source => [source.id, source]));
  for (const [field, side] of [['oldEvidence', 'old'], ['newEvidence', 'new']]) {
    const indices = value[field];
    if (!Array.isArray(indices) || indices.length > 8 || new Set(indices).size !== indices.length) throw new Error('Invalid regression evidence indices');
    for (const index of indices) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= evidence.length) throw new Error('Unknown regression evidence');
      const ref = evidence[index], source = sources.get(ref.sourceId);
      if (ref.status !== 'references-validated' || source?.fileId !== fileId || source?.side !== side) throw new Error('Regression evidence side or primary mismatch');
    }
    if (value.classification !== 'uncertain' && !indices.length) throw new Error('Regression conclusion requires both source sides');
  }
  return { ...value, oldEvidence: [...value.oldEvidence], newEvidence: [...value.newEvidence], status: 'comparison-references-validated', causality: 'unverified' };
}
