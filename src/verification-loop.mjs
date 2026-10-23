import { VERIFICATION_INSTRUCTIONS } from './prompts.mjs';
import { CONTEXT_SIDE_NOTICE } from './context-identity.mjs';
import { defectGuidance } from './defect-guidance.mjs';
import { createEvidenceReceipts } from './evidence-receipts.mjs';
import { retrievalLoop, retrievalRequest } from './retrieval-loop.mjs';
import { verificationSeeds } from './verification-seeds.mjs';
import { validateCandidateVerification } from './candidate-verification.mjs';

export { VERIFICATION_INSTRUCTIONS };

// Caller must supply the approved scope, shared beforeCall counter and the
// SAME enclosing timeout signal used for candidate generation. No new timer.
// The review service authorizes the snapshot; this helper grants no authority.
export async function verificationLoop(model, request, candidates, scope, options = {}) {
  request.signal?.throwIfAborted();
  if (!Array.isArray(candidates) || candidates.length > 50) throw new Error('Invalid candidates');
  if (!candidates.length) return [];
  const ids = candidates.map((_, i) => 'c' + (i + 1));
  const envelope = request.input ? JSON.parse(request.input) : {};
  const rules = envelope.rules ?? [];
  const input = JSON.stringify({ contextSideNotice:CONTEXT_SIDE_NOTICE, ...(envelope.businessRequirement!==undefined?{businessRequirement:envelope.businessRequirement,requirementNotice:envelope.requirementNotice}:{}), defectGuidance: [...new Set(candidates.map(f => scope.catalog().find(s => s.fileId === f.fileId)?.path).filter(Boolean))].map(path => envelope.file?.path === path && envelope.defectGuidance ? envelope.defectGuidance : envelope.files?.find(f=>f.path===path)?.defectGuidance ?? defectGuidance(path)), rules, candidates: candidates.map((finding, i) => ({ candidateId: ids[i], finding })) });
  const seedReceipts = new Map();
  const verificationRequest = { ...request, input, instructions:envelope.file?.reviewMode==='project'?VERIFICATION_INSTRUCTIONS+' 本次为当前项目源码审查，空old只是传输占位，不是历史版本。不要要求回归因果；regression.classification用uncertain并说明不适用，仅凭new侧原文核实当前缺陷和反证。':VERIFICATION_INSTRUCTIONS };
  // Explicit final-only mode has extra finalization metadata/instructions and
  // permits no retrieval rounds. Do not spend its budget on optional prefetch.
  const initialRetrieved = options.maxRounds === 0 ? [] : verificationSeeds(candidates, scope, {
    signal: request.signal,
    onReceipt: (id, resolve) => seedReceipts.set(id, resolve),
    fits: seeds => {
      const next = retrievalRequest(verificationRequest, scope, seeds);
      return Buffer.byteLength(next.input) + Buffer.byteLength(next.instructions) <= (options.maxInputBytes ?? 96 * 1024);
    },
  });
  const receipts = createEvidenceReceipts(scope.read, { limit: 50 - seedReceipts.size });
  const retrievalScope = { ...scope, read: receipts.read };
  const resolveEvidence = value => (seedReceipts.get(value?.receiptId) ?? receipts.resolve)(value);
  // No caller/model-supplied seed inputs: every initial result above was freshly
  // read under this invocation's receipt table and the shared approved budget.
  const response = await retrievalLoop(model, verificationRequest, retrievalScope, { ...options, initialRetrieved });
  request.signal?.throwIfAborted();
  return validateCandidateVerification(response, ids, scope.read, resolveEvidence, { catalog: scope.catalog(), fileIds: Object.fromEntries(ids.map((id, i) => [id, candidates[i].fileId])) });
}
