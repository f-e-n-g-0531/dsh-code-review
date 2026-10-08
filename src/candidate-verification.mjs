import { validateEvidenceReference } from './evidence-reference.mjs';
// Offline only. Candidate ids come from the host, not the model.
export function validateCandidateVerification(value, candidateIds, read, resolveEvidence = value => value) {
  if (!Array.isArray(candidateIds) || candidateIds.length > 50 || candidateIds.some(id => typeof id !== 'string' || !id || id.length > 200) || new Set(candidateIds).size !== candidateIds.length) throw new Error('Invalid candidate identities');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Array.isArray(value.verdicts) || value.verdicts.length !== candidateIds.length) throw new Error('Incomplete verification response');
  const seen = new Set();
  // Validate the entire envelope before any budgeted evidence read.
  for (const item of value.verdicts) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 4 || !['candidateId', 'verdict', 'reason', 'evidence'].every(k => Object.hasOwn(item, k))) throw new Error('Invalid verdict');
    if (!candidateIds.includes(item.candidateId) || seen.has(item.candidateId)) throw new Error('Unknown or duplicate candidate');
    seen.add(item.candidateId);
    if (!['supported', 'refuted', 'uncertain'].includes(item.verdict) || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 8000) throw new Error('Invalid verdict explanation');
    if (!Array.isArray(item.evidence) || item.evidence.length > 8 || (item.verdict !== 'uncertain' && !item.evidence.length)) throw new Error('Missing or excessive evidence');
  }
  const results = new Map(value.verdicts.map(item => [item.candidateId, {
    candidateId: item.candidateId, verdict: item.verdict, reason: item.reason,
    evidence: item.evidence.map(ref => validateEvidenceReference(resolveEvidence(ref), read)),
    causality: 'unverified',
  }]));
  return candidateIds.map(id => results.get(id));
}
