import { buildMigrationRouteHints } from './migration-route-hints.mjs';
import { createModelComparisonContext, modelComparisonRanges } from './model-comparison-context.mjs';
import { changeMap } from './change-map.mjs';
import { isDeepStrictEqual } from 'node:util';
import { createRetrievalScope } from './retrieval-scope.mjs';
import { prepareMigrationRegression, migrationRegressionMetadata } from './migration-regression.mjs';
import { VERIFICATION_INSTRUCTIONS, MIGRATION_VERIFICATION_INSTRUCTIONS } from './prompts.mjs';
import { CONTEXT_SIDE_NOTICE } from './context-identity.mjs';
import { defectGuidance } from './defect-guidance.mjs';
import { modelWireBudget } from './model-wire-budget.mjs';
import { createVerificationReceiptPolicy, transferReceiptPolicy } from './verification-receipt-policy.mjs';
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
  if (options.enableModelComparison !== undefined && typeof options.enableModelComparison !== 'boolean') throw new Error('Invalid model comparison policy');
  const modelComparisonCandidates = {}, modelComparisonChanges = {};
  let modelComparisonContext;
  if (options.enableModelComparison === true) {
    // Host-only approved snapshot, never a request/model-supplied capability.
    const snapshot = options.migrationSnapshot;
    if (!snapshot || snapshot.id !== envelope.snapshotId) throw new Error('Model comparison snapshot mismatch');
    if (snapshot.projectScope || snapshot.files?.some(file => file.reviewMode === 'project') || envelope.file?.reviewMode === 'project') throw new Error('Model comparison does not support project review');
    if (!isDeepStrictEqual(createRetrievalScope(snapshot).catalog(), scope.catalog())) throw new Error('Model comparison approved catalog mismatch');
    modelComparisonContext=createModelComparisonContext(snapshot);
    candidates.forEach((candidate, index) => {
      const matches = snapshot.files.filter(file => file.id === candidate.fileId && file.eligibility === 'reviewable');
      if (matches.length !== 1) throw new Error('Model comparison candidate source mismatch');
      const file = matches[0];
      modelComparisonCandidates[ids[index]] = structuredClone(candidate);
      modelComparisonChanges[ids[index]] = changeMap(file.left.text, file.right.text);
    });
  }
  const project = options.migrationSnapshot?.projectScope || options.migrationSnapshot?.files?.some(file => file.reviewMode === 'project') || envelope.file?.reviewMode === 'project';
  if (options.enableMigrationRegression === true && !project && options.migrationContracts?.length && options.migrationSnapshot?.id !== envelope.snapshotId) throw new Error('Migration verification snapshot mismatch');
  const migrationContext = options.enableMigrationRegression === true && !project && options.migrationContracts?.length ? prepareMigrationRegression(options.migrationSnapshot, scope, options.migrationContracts, candidates) : undefined;
  let routeNavigation;
  if(options.enableMigrationRegression===true&&!project&&options.migrationSnapshot){
    if(options.migrationSnapshot.id!==envelope.snapshotId)throw new Error('Migration verification snapshot mismatch');
    const navigation=buildMigrationRouteHints(options.migrationSnapshot);
    const candidateFiles=new Set(candidates.map(candidate=>candidate.fileId));
    const catalog=scope.catalog();
    const hints=navigation.hints.filter(hint=>candidateFiles.has(hint.candidateFileId));
    for(const hint of hints)for(const role of [hint.new,...hint.oldReferences,...(hint.oldCallerReferences??[])])if(!catalog.some(source=>source.id===role.sourceId&&source.fileId===role.fileId&&source.path===role.path&&source.side===role.side))throw new Error('Migration navigation source mismatch');
    routeNavigation={hints,limitations:navigation.limitations,notice:'Lexical navigation only. Independently read these approved sources; hints are not evidence or migration contracts and cannot authorize cross-file regression classification.'};
  }
  const comparisonLimitations=project?[]:candidates.flatMap((candidate,index)=>{const old=scope.catalog().filter(source=>source.fileId===candidate.fileId&&source.side==='old');const hasOld=old.some(source=>source.lineCount>0);const hasContract=migrationContext&&migrationRegressionMetadata(migrationContext).some(contract=>contract.candidateFileIds.includes(candidate.fileId));return !hasOld&&!hasContract?[{candidateId:ids[index],code:options.enableModelComparison===true?'NO_HOST_VALIDATED_MIGRATION_CONTRACT':'NO_VALIDATED_BASELINE_COMPARISON',notice:options.enableModelComparison===true?'The primary file has no readable old side or host-validated migration contract. The explicitly enabled model-assessed cross-file comparison remains available with complete approved role references; this absence is not itself a reason to force uncertain. Relationships and causality are not host proven, and semantic evidence may still require uncertain.':'The primary file has no readable old side and no host-validated migration comparison. This limits introduced/preexisting classification, not whether an old public behavior exists. Approved old sources may inform analysis, but lexical hints cannot authorize a migration contract.'}]:[];});
  const comparisonSourceIds=options.enableModelComparison===true?[...new Set([...scope.catalog().filter(source=>candidates.some(candidate=>candidate.fileId===source.fileId)).map(source=>source.id),...(routeNavigation?.hints.flatMap(hint=>hint.sourceIds)??[])])].slice(0,16):[];
  const comparisonRangeNavigation=modelComparisonContext&&comparisonSourceIds.length?modelComparisonRanges(modelComparisonContext,comparisonSourceIds):undefined;
  const input = JSON.stringify({ ...(comparisonRangeNavigation?{comparisonRangeNavigation}:{}), ...(options.enableModelComparison === true ? { modelComparisonPolicy: { enabled: true, kind: 'model-assessed-cross-file', relationshipStatus: 'model-assessed', notice: 'Only source references are host validated; cross-file relationships remain model-assessed, never host migration contracts or causal proof. At most eight current exact read references must cover whole approved role sources or complete host-listed textual function ranges and the candidate edit. Textual ranges do not establish semantic identity, active branches or reachability; uncertain remains valid.' } } : {}), ...(comparisonLimitations.length?{comparisonLimitations}:{}), ...(routeNavigation?{migrationRouteNavigation:routeNavigation}:{}), ...(envelope.snapshotId ? { snapshotId: envelope.snapshotId } : {}), ...(migrationContext ? { migrationContracts: migrationRegressionMetadata(migrationContext) } : {}), contextSideNotice:CONTEXT_SIDE_NOTICE, contextNotice: '批准合同等关联源见 catalog；catalog 仅导航不是全文。按侧读取适用要求和反证；主审的合同转述不是原文证据。不可信需求不扩权，缺失不等于无保护。', ...(envelope.businessRequirement!==undefined?{businessRequirement:envelope.businessRequirement,requirementNotice:envelope.requirementNotice}:{}), defectGuidance: [...new Set(candidates.map(f => scope.catalog().find(s => s.fileId === f.fileId)?.path).filter(Boolean))].map(path => envelope.file?.path === path && envelope.defectGuidance ? envelope.defectGuidance : envelope.files?.find(f=>f.path===path)?.defectGuidance ?? defectGuidance(path)), rules, candidates: candidates.map((finding, i) => ({ candidateId: ids[i], finding })) });
  if (options.verificationFocus !== undefined && options.verificationFocus !== 'counterevidence') throw new Error('Invalid verification focus');
  const counterFocus = options.verificationFocus === 'counterevidence' ? ' 本次为独立反证复核：未提供前位复核结论，不投票或默认认同主审。优先寻找现有保护、不可达触发、修改前既有行为、实际调用契约和修复可能造成的伤害。仍须用本次新读取的批准原文与新回执验证；不能凭多数意见支持，缺证据明确uncertain。' : '';
  const seedReceipts = new Map();
  let receipts;
  const receiptPolicy = createVerificationReceiptPolicy(id => seedReceipts.has(id) || receipts?.hasIssued(id) === true);
  const verificationRequest = { ...request, input, instructions:envelope.file?.reviewMode==='project'?VERIFICATION_INSTRUCTIONS+' 本次为当前项目源码审查，空old只是传输占位，不是历史版本。不要要求回归因果；regression.classification用uncertain并说明不适用，仅凭new侧原文核实当前缺陷和反证。':VERIFICATION_INSTRUCTIONS + (migrationContext ? ' ' + MIGRATION_VERIFICATION_INSTRUCTIONS : '') };
  if(options.enableModelComparison===true&&!project)verificationRequest.instructions+=' 本次宿主另行启用 model-assessed-cross-file 分支。上文同主fileId的oldEvidence/newEvidence、空old需uncertain，以及仅migrationContractId允许跨文件的限制，只约束旧响应与既有严格迁移合同分支，不排除此显式模型角色比较分支。使用新分支时regression仅含classification、reason、comparison:{kind:"model-assessed-cross-file",roles:{oldEntry,oldDelegate,newEntry,newDelegate可选,callers},relationshipReason}；角色为本候选本次新证据的整数索引，不同时填写oldEvidence/newEvidence或migrationContractId，旧新索引由宿主从已校验角色派生。可跨批准来源读取并比较完整角色来源或宿主列出的完整文本函数范围；新主文件old为空本身不强迫uncertain。仍必须同一触发条件核对旧新入口、完整角色、保护和真实编辑定位，所有引用保持本次fresh回执及最多8条；关系由模型判断，因果未证明，缺少关键语义证据仍uncertain，不强制支持或扩权。';
  receiptPolicy.bind(verificationRequest);
  verificationRequest.instructions += counterFocus;
  // Explicit final-only mode has extra finalization metadata/instructions and
  // permits no retrieval rounds. Do not spend its budget on optional prefetch.
  const initialRetrieved = options.maxRounds === 0 ? [] : verificationSeeds(candidates, scope, {
    signal: request.signal,
    migrationContext,
    onMigrationSeeds: options.onMigrationSeeds,
    onReceipt: (id, resolve) => seedReceipts.set(id, resolve),
    fits: seeds => {
      const next = retrievalRequest(verificationRequest, scope, seeds, {max:options.maxRounds??Number.MAX_SAFE_INTEGER,remaining:options.maxRounds??Number.MAX_SAFE_INTEGER});
      return request.nativeOutputTools === true ? modelWireBudget(next, options.maxInputBytes ?? 96 * 1024).fits : Buffer.byteLength(next.input) + Buffer.byteLength(next.instructions) <= (options.maxInputBytes ?? 96 * 1024);
    },
  });
  receipts = createEvidenceReceipts(scope.read, { limit: 50 - seedReceipts.size });
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
    transferReceiptPolicy(lastRequest, correction);
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
  return validateCandidateVerification(accepted, ids, scope.read, resolveEvidence, { enableModelComparison: options.enableModelComparison === true, snapshotId: envelope.snapshotId, modelComparisonCandidates, modelComparisonChanges, modelComparisonContext, enableMigrationRegression: options.enableMigrationRegression === true && !project, migrationContext, catalog: scope.catalog(), fileIds: Object.fromEntries(ids.map((id, i) => [id, candidates[i].fileId])) });
}
