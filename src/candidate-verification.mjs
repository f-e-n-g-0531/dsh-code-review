import { validateRegressionAssessment } from './regression-assessment.mjs';
import { validateEvidenceReference } from './evidence-reference.mjs';
// Offline only. Candidate ids come from the host, not the model.
export function validateCandidateVerificationEnvelope(value, candidateIds) {
  if (!Array.isArray(candidateIds) || candidateIds.length > 50 || candidateIds.some(id => typeof id !== 'string' || !id || id.length > 200) || new Set(candidateIds).size !== candidateIds.length) throw new Error('Invalid candidate identities');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Array.isArray(value.verdicts) || value.verdicts.length !== candidateIds.length) throw Object.assign(new Error('Incomplete verification response'), { code: 'MODEL_INCOMPLETE_VERIFICATION' });
  const seen = new Set();
  // Validate the entire envelope before any budgeted evidence read.
  for (const item of value.verdicts) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== (Object.hasOwn(item, 'regression') ? 5 : 4) || !['candidateId', 'verdict', 'reason', 'evidence'].every(k => Object.hasOwn(item, k))) throw new Error('Invalid verdict');
    if (!candidateIds.includes(item.candidateId) || seen.has(item.candidateId)) throw new Error('Unknown or duplicate candidate');
    seen.add(item.candidateId);
    if (!['supported', 'refuted', 'uncertain'].includes(item.verdict) || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 8000) throw new Error('Invalid verdict explanation');
    const evidenceFailure = kind => Object.assign(new Error('Missing or excessive evidence'),{code:'INVALID_VERIFICATION_EVIDENCE_SET',evidenceFailure:kind,...(Array.isArray(item.evidence)?{evidenceCount:item.evidence.length}:{})});
    if(!Array.isArray(item.evidence))throw evidenceFailure('not-array');
    if(item.evidence.length>8)throw evidenceFailure('too-many');
    if(item.verdict!=='uncertain'&&!item.evidence.length)throw evidenceFailure('required-evidence-missing');
  }
}

export function validateCandidateVerification(value, candidateIds, read, resolveEvidence = value => value, comparison = {}) {
  validateCandidateVerificationEnvelope(value, candidateIds);
  const results = new Map(value.verdicts.map(item => {
    const evidence = item.evidence.map(ref => validateEvidenceReference(resolveEvidence(ref), read));
    const regression = validateRegressionAssessment(item.regression, evidence, comparison.catalog ?? [], comparison.fileIds?.[item.candidateId], { ...comparison, candidateId: item.candidateId, modelComparisonCandidate: comparison.modelComparisonCandidates?.[item.candidateId], modelComparisonChanges: comparison.modelComparisonChanges?.[item.candidateId] });
    return [item.candidateId, { candidateId: item.candidateId, verdict: item.verdict, reason: item.reason, evidence, regression, causality: 'unverified' }];
  }));
  return candidateIds.map(id => results.get(id));
}
