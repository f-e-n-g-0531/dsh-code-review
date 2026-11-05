import { verificationLoop } from './verification-loop.mjs';

const confirmed = value => value?.verdict === 'supported' && Array.isArray(value.evidence) && value.evidence.length > 0 && value.evidence.every(ref => ref?.status === 'references-validated');
const classification = value => value?.regression?.classification;
const comparable = value => ['introduced', 'preexisting'].includes(classification(value)) && value.regression.status === 'comparison-references-validated';
const fatal = (error, options) => ['MODEL_ARTIFACT_FAILED', 'CHECKPOINT_FAILED', 'RESUME_CHECKPOINT_FAILED'].includes(error?.code) || options.isFatalError?.(error) === true;

// Input baseline must be the just-completed strict verificationLoop result, not
// historical findings or model-supplied verdicts. This pass grants no authority.
export async function runCounterVerification(model, request, candidates, baseline, scope, options = {}) {
  request.signal?.throwIfAborted();
  if (!Array.isArray(candidates) || candidates.length > 50 || !Array.isArray(baseline) || baseline.length !== candidates.length) throw new Error('Invalid counterverification candidates or baseline');
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') throw new Error('Invalid counterverification policy');
  if (options.isFatalError !== undefined && typeof options.isFatalError !== 'function') throw new Error('Invalid counterverification fatal predicate');
  const results = structuredClone(baseline);
  if (options.enabled !== true) return results;
  const indices = candidates.flatMap((candidate, index) => ['critical', 'high'].includes(candidate?.severity) && confirmed(baseline[index]) ? [index] : []);
  if (!indices.length) return results;
  const independent = indices.map(index => {
    const value = structuredClone(candidates[index]);
    delete value.verification;
    delete value.counterVerification;
    return value;
  });
  let counter, failureCode;
  try {
    counter = await verificationLoop(model, request, independent, scope, { ...options, verificationFocus: 'counterevidence', correctProtocol: false });
    request.signal?.throwIfAborted();
  } catch (error) {
    request.signal?.throwIfAborted();
    if (error?.name === 'AbortError' || fatal(error, options)) throw error;
    // Never echo an untrusted model exception (which may contain source text).
    failureCode = 'COUNTER_VERIFICATION_INCOMPLETE';
  }
  indices.forEach((index, offset) => {
    const original = baseline[index], extra = counter?.[offset];
    const metadata = extra ? { status: 'completed', result: structuredClone(extra), baselineResult: structuredClone(original) } : { status: 'incomplete', failureCode, baselineResult: structuredClone(original) };
    results[index].counterVerification = metadata;
    if (extra && confirmed(extra) && comparable(original) && comparable(extra) && classification(original) === classification(extra)) return;
    // Preserve both independent records. Uncertainty is a conservative aggregate,
    // not a new model verdict or evidence borrowed from the second receipt table.
    results[index].verdict = 'uncertain';
    results[index].reason = extra ? 'Independent counterevidence verification did not confirm the same supported classification.' : 'Independent counterevidence verification is incomplete.';
    results[index].causality = 'unverified';
    results[index].regression = { classification: 'uncertain', reason: results[index].reason, oldEvidence: [], newEvidence: [], causality: 'unverified' };
  });
  return results;
}
