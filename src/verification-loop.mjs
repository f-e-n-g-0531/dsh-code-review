import { prepareMigrationRegression, migrationRegressionMetadata } from './migration-regression.mjs';
import { VERIFICATION_INSTRUCTIONS, MIGRATION_VERIFICATION_INSTRUCTIONS } from './prompts.mjs';
import { CONTEXT_SIDE_NOTICE } from './context-identity.mjs';
import { defectGuidance } from './defect-guidance.mjs';
import { modelWireBudget } from './model-wire-budget.mjs';
import { createEvidenceReceipts } from './evidence-receipts.mjs';
import { retrievalLoop, retrievalRequest } from './retrieval-loop.mjs';
import { verificationSeeds } from './verification-seeds.mjs';
import { validateCandidateVerification, validateCandidateVerificationEnvelope } from './candidate-verification.mjs';

export { VERIFICATION_INSTRUCTIONS };

// Caller must supply the approved scope, shared beforeCall counter and the
// SAME enclosing timeout signal used for candidate generation. No new timer.
// The review service authorizes the snapshot; this helper grants no authority.
export async function verificationLoop(model, request, candidates, scope, options = {}) {
  request.signal?.throwIfAborted();
  if (!Array.isArray(candidates) || candidates.length > 50) throw new Error('Invalid candidates');
  if (options.enableMigrationRegression !== undefined && typeof options.enableMigrationRegression !== 'boolean') throw new Error('Invalid migration regression policy');
  if (!candidates.length) return [];
  const ids = candidates.map((_, i) => 'c' + (i + 1));
  const envelope = request.input ? JSON.parse(request.input) : {};
  const rules = envelope.rules ?? [];
  const project = options.migrationSnapshot?.projectScope || options.migrationSnapshot?.files?.some(file => file.reviewMode === 'project') || envelope.file?.reviewMode === 'project';
  if (options.enableMigrationRegression === true && !project && options.migrationContracts?.length && options.migrationSnapshot?.id !== envelope.snapshotId) throw new Error('Migration verification snapshot mismatch');
  const migrationContext = options.enableMigrationRegression === true && !project && options.migrationContracts?.length ? prepareMigrationRegression(options.migrationSnapshot, scope, options.migrationContracts, candidates) : undefined;
  const input = JSON.stringify({ ...(envelope.snapshotId ? { snapshotId: envelope.snapshotId } : {}), ...(migrationContext ? { migrationContracts: migrationRegressionMetadata(migrationContext) } : {}), contextSideNotice:CONTEXT_SIDE_NOTICE, ...(envelope.businessRequirement!==undefined?{businessRequirement:envelope.businessRequirement,requirementNotice:envelope.requirementNotice}:{}), defectGuidance: [...new Set(candidates.map(f => scope.catalog().find(s => s.fileId === f.fileId)?.path).filter(Boolean))].map(path => envelope.file?.path === path && envelope.defectGuidance ? envelope.defectGuidance : envelope.files?.find(f=>f.path===path)?.defectGuidance ?? defectGuidance(path)), rules, candidates: candidates.map((finding, i) => ({ candidateId: ids[i], finding })) });
  const seedReceipts = new Map();
  const verificationRequest = { ...request, input, instructions:envelope.file?.reviewMode==='project'?VERIFICATION_INSTRUCTIONS+' 本次为当前项目源码审查，空old只是传输占位，不是历史版本。不要要求回归因果；regression.classification用uncertain并说明不适用，仅凭new侧原文核实当前缺陷和反证。':VERIFICATION_INSTRUCTIONS + (migrationContext ? ' ' + MIGRATION_VERIFICATION_INSTRUCTIONS : '') };
  // Explicit final-only mode has extra finalization metadata/instructions and
  // permits no retrieval rounds. Do not spend its budget on optional prefetch.
  const initialRetrieved = options.maxRounds === 0 ? [] : verificationSeeds(candidates, scope, {
    signal: request.signal,
    migrationContext,
    onMigrationSeeds: options.onMigrationSeeds,
    onReceipt: (id, resolve) => seedReceipts.set(id, resolve),
    fits: seeds => {
      const next = retrievalRequest(verificationRequest, scope, seeds);
      return request.nativeOutputTools === true ? modelWireBudget(next, options.maxInputBytes ?? 96 * 1024).fits : Buffer.byteLength(next.input) + Buffer.byteLength(next.instructions) <= (options.maxInputBytes ?? 96 * 1024);
    },
  });
  const receipts = createEvidenceReceipts(scope.read, { limit: 50 - seedReceipts.size });
  const retrievalScope = { ...scope, read: receipts.read };
  const resolveEvidence = value => (seedReceipts.get(value?.receiptId) ?? receipts.resolve)(value);
  // No caller/model-supplied seed inputs: every initial result above was freshly
  // read under this invocation's receipt table and the shared approved budget.
  let lastRequest;
  const response = await retrievalLoop(value => { lastRequest = value; return model(value); }, verificationRequest, retrievalScope, { ...options, initialRetrieved });
  let accepted = response;
  try { validateCandidateVerificationEnvelope(response, ids); } catch (error) {
    request.signal?.throwIfAborted();
    // Correct only a structurally incomplete batch, before any final evidence
    // reads. Never retry bad identities, invented receipts or regression failures.
    if (options.correctProtocol !== true || error.code !== 'MODEL_INCOMPLETE_VERIFICATION' || JSON.parse(lastRequest.input).retrievalFinalization) throw error;
    // Admit only an otherwise valid subset of evidence-free uncertain entries.
    // Do not let a missing member hide an invalid identity, receipt or regression.
    if (!response || Object.keys(response).length !== 1 || !Array.isArray(response.verdicts) || response.verdicts.length >= ids.length) throw error;
    const subset = response.verdicts.map(item => item?.candidateId);
    validateCandidateVerificationEnvelope(response, subset);
    if (subset.some(id => !ids.includes(id)) || response.verdicts.some(item => item.verdict !== 'uncertain' || item.evidence.length || Object.hasOwn(item, 'regression'))) throw error;
    const correction = { ...lastRequest, callPurpose: 'verification-correction', instructions: lastRequest.instructions + '\n本次仅纠正不完整的候选复核批次。必须为本次 candidates 每个 candidateId 恰好返回一个 verdict；不可漏项、重复或添加身份。仅返回完整 verdicts，不得 requests，不得再次检索。沿用已提供的原文回执；缺证据的候选明确 uncertain 并说明缺失条件，不得编造支持或删除候选。全部结果仍须通过原校验。' };
    const max = options.maxInputBytes ?? 96 * 1024;
    if (!(request.nativeOutputTools === true ? modelWireBudget(correction, max).fits : Buffer.byteLength(correction.input) + Buffer.byteLength(correction.instructions) <= max)) throw error;
    options.beforeCall?.();
    request.signal?.throwIfAborted();
    await request.onProtocolEvent?.({ action: 'verification-response-correction', code: error.code });
    request.signal?.throwIfAborted();
    const next = await model(correction);
    request.signal?.throwIfAborted();
    const serialized = typeof next === 'string' ? next : JSON.stringify(next);
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 128 * 1024) throw new Error('Verification response too large');
    accepted = JSON.parse(serialized);
    validateCandidateVerificationEnvelope(accepted, ids);
  }
  request.signal?.throwIfAborted();
  return validateCandidateVerification(accepted, ids, scope.read, resolveEvidence, { enableMigrationRegression: options.enableMigrationRegression === true && !project, migrationContext, catalog: scope.catalog(), fileIds: Object.fromEntries(ids.map((id, i) => [id, candidates[i].fileId])) });
}
