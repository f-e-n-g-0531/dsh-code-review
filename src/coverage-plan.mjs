import {reviewRounds} from './review-rounds.mjs';
import { prepareWholeScope } from './whole-scope-plan.mjs';
import {riskPlanningDecision, RISK_PLAN_INSTRUCTIONS} from './risk-plan.mjs';
import { canonicalRiskInput } from './risk-scope.mjs';
import { chooseRiskStrategy, riskPlanningMode } from './risk-strategy.mjs';
import {localBusinessGroups} from './business-groups.mjs';
import { prepareInteractionInput } from './interaction-input.mjs';
import { initialInputBudget } from './input-budget.mjs';
import { preparePrimaryInput } from './primary-input.mjs';
import { prepareGroupPrimary } from './group-primary.mjs';
import { prepareInteractionRisk } from './interaction-risk.mjs';
import { buildMigrationContracts } from './migration-contracts.mjs';
import { buildReviewGroups } from './review-groups.mjs';
import { inferFileRelations } from './file-relations.mjs';

// Metadata only. No retained payload, file reads, model calls, or approval grants.
export function buildCoveragePlan(input, options) {
  const rounds=reviewRounds(options?.reviewRounds);
  if (options?.executionStrategy === 'whole-scope') {
    if (rounds !== 1 || input?.projectScope || options.resumeState) throw new Error('Whole-scope requires fresh single-round changes review');
    const prepared = prepareWholeScope(input, options);
    return { snapshotId: input.id, executionStrategy: 'whole-scope', reviewRounds: 1, maxInputBytes: options.maxInputBytes, minimumCalls: prepared.batches.length, initialRequestsOnly: true, interactions: [], primaryGroups: prepared.batches.map(batch => ({ groupId: batch.id, fileIds: batch.fileIds, minimumCalls: 1 })), oversized: prepared.oversized, items: input.files.map(file => ({ fileId: file.id, path: file.path, eligibility: file.eligibility, primaryMethod: 'whole-scope', minimumCalls: 0 })), notice: '完整双侧按实际线缆字节合批；补读与候选集中复核可能增加调用，超大文件及跨批覆盖不足不会标成完成。' };
  }
  riskPlanningMode(options?.riskPlanningMode);
  for (const key of ['enableEvidenceContext', 'inlineInteractionRisks', 'enableMigrationContracts', 'enableMigrationRegression', 'enableGroupInteractions', 'enableStageContinuation']) if (options?.[key] !== undefined && typeof options[key] !== 'boolean') throw new Error('Invalid review optimization option');
  if (!input || typeof input.id !== 'string' || !input.id || !Array.isArray(input.files) || input.files.length > 200) throw new Error('Invalid planning snapshot');
  if (!options || typeof options.instructions !== 'string' || !Number.isSafeInteger(options.maxInputBytes) || options.maxInputBytes < 1) throw new Error('Invalid planning budget');
  const ids = new Set(), paths = new Set();
  for (const file of input.files) {
    if (!file || typeof file.id !== 'string' || !file.id || ids.has(file.id) || typeof file.path !== 'string' || !file.path || paths.has(file.path) || !['reviewable','excluded','blocked'].includes(file.eligibility)) throw new Error('Invalid planning file');
    ids.add(file.id); paths.add(file.path);
  }
  const migrationContracts = options.enableMigrationContracts === true && options.scope && !input.projectScope ? buildMigrationContracts(input) : null;
  if (migrationContracts?.contracts.length) options = { ...options, grouping: buildReviewGroups(input.files, [...inferFileRelations(input.files), ...migrationContracts.links.map(link => ({ from: link.from, to: link.to, reason: link.reasons.join(',') }))]) };
  const items = [...input.files].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => {
    options.signal?.throwIfAborted();
    const item = { fileId: file.id, path: file.path, status: file.eligibility, minimumCalls: 0 };
    if (file.eligibility !== 'reviewable') return item;
    const prepared = preparePrimaryInput(input, file, options);
    const strategy = chooseRiskStrategy(input, file, prepared, options);
    const riskPlanning = prepared.inlineRisk ? { ...strategy.decision, mode: 'inline' } : strategy.decision;
    const primaryCalls = prepared.batches?.length ?? 1;
    const canonical = riskPlanning.required && !prepared.inlineRisk && prepared.budget.fits
      ? canonicalRiskInput(input, file, prepared, { ...options, instructions: RISK_PLAN_INSTRUCTIONS }) : null;
    const planningCalls = riskPlanning.required && !prepared.inlineRisk ? (canonical?.cacheable ? 1 : primaryCalls) : 0;
    return { ...item, ...prepared.metadata, riskPlanning, status: prepared.budget.fits ? 'ready' : 'input-blocked', minimumCalls: prepared.budget.fits ? (primaryCalls * rounds + planningCalls + (prepared.synthesis?.status === 'ready' ? rounds : 0)) : 0 };
  });
  const local = options.resumeState?.businessGrouping ?? (options.enableBusinessGrouping === true ? localBusinessGroups(input.files) : null);
  const groups = [...(options.grouping?.groups ?? [])];
  for(const group of local?.groups ?? [])if(!groups.some(g=>[...g.fileIds].sort().join(',')===[...group.fileIds].sort().join(',')))groups.push(group);
  const interactions = options.scope && groups.length ? groups.filter(g => g.fileIds.length > 1).map(group => {
    const prepared = prepareInteractionInput(input, group, payload => initialInputBudget({ instructions: options.instructions, input: payload }, options.scope, options.maxInputBytes));
    const strategy = prepareInteractionRisk(input, group, prepared, options);
    const riskPlanning = { ...strategy.decision, mode: strategy.mode };
    return { groupId: group.id, fileIds: prepared.fileIds, riskPlanning, status: prepared.status, reason: prepared.reason, minimumCalls: prepared.status === 'ready' ? rounds + strategy.planningCalls : 0 };
  }) : [];
  const businessGrouping = options.enableBusinessGrouping === true && input.files.filter(f => f.eligibility === 'reviewable').length > 1 ? local ? {minimumCalls:0,strategy:local.strategy,churn:local.churn,notice:'本地调度无语义依赖证明。'} : { minimumCalls: 1, dynamicInteractionCalls: 'unknown-until-execution', maximumAdditionalInitialCalls: Math.floor(input.files.filter(f => f.eligibility === 'reviewable').length / 2) * (rounds + (options.enableRiskPlanning === true ? 1 : 0)), notice: '模型分组假设仅调度，额外综合动态且不保证预算或覆盖。' } : null;
  for (const interaction of interactions) if (interaction.fileIds.every(id => options.resumeState?.completed?.some(row => row.fileId === id))) { interaction.minimumCalls = 0; interaction.reused = true; }
  const primaryGroups = [];
  if (options.enableGroupPrimary === true && rounds === 1 && options.scope) {
    const seen = new Set();
    for (const group of [...(migrationContracts?.groups ?? []), ...(local?.groups ?? options.grouping?.groups ?? [])]) {
      if (group.fileIds.some(id => seen.has(id) || options.resumeState?.completed?.some(row => row.fileId === id) || options.resumeState?.stageGenerations?.some(row => row.fileId === id))) continue;
      const prepared = prepareGroupPrimary(input, group, { ...options, migrationContracts: migrationContracts?.contracts ?? [] });
      if (!prepared) continue;
      primaryGroups.push({ groupId: group.id, fileIds: prepared.fileIds, minimumCalls: 1, ...(prepared.groupInteraction ? { interactionChannel: 'conditional', fallback: 'dedicated-stage' } : {}) });
      if (prepared.groupInteraction) for (const interaction of interactions.filter(item => [...item.fileIds].sort().join(',') === [...prepared.fileIds].sort().join(','))) { interaction.fallbackMinimumCalls = interaction.minimumCalls; interaction.minimumCalls = 0; interaction.method = 'conditional-group-channel'; interaction.notice = 'Only current-generation fully read and host-validated group channel replaces the dedicated stage; missing/invalid channel retains its fallback cost and independent candidate verification.'; }
      for (const id of group.fileIds) { seen.add(id); const item = items.find(item => item.fileId === id); item.primaryMethod = 'group-primary'; item.primaryGroupId = group.id; item.minimumCalls = id === group.fileIds[0] ? 1 : 0; }
    }
  }
  for (const row of options.resumeState?.completed ?? []) { const item = items.find(item => item.fileId === row.fileId); if (item) { item.minimumCalls = 0; item.reused = true; } }
  for (const file of input.files) { const records = options.resumeState?.stageGenerations?.filter(record => record.fileId === file.id && record.phase === 'primary') ?? []; if (!records.length) continue; const item = items.find(item => item.fileId === file.id); const prepared = preparePrimaryInput(input, file, options); const expected = (prepared.batches?.length ?? 1) * rounds; if (records.length === expected) { item.minimumCalls = prepared.synthesis?.status === 'ready' ? rounds : 0; item.reusedGenerations = records.length; item.freshVerificationRequired = true; } }
  return { ...(migrationContracts ? { migrationContracts } : {}), ...(options.enableStageContinuation ? { continuation: { maxRetries: 2, ledger: 'same-approved-root', notice: 'Release-driven bounded retry of unfinished stages; accepted primary generations may resume under exact identity, verification reads/receipts are fresh. Pending remains pending if quota/deadline/dependency does not permit continuation.' } } : {}), ...(options.enableGroupPrimary ? { primaryGroups, primaryGroupNotice: businessGrouping?.dynamicInteractionCalls ? '执行时模型分组可能改变组主审单元，当前为静态估计而非确定调用承诺。' : options.enableGroupInteractions ? '相同完整正文单元可附带交互通道；仅当前代完整取证且host校验通过时替代对应专门阶段，否则回退；候选仍独立复核。' : '相同完整正文单元在预算内合并，专门交互证据阶段仍独立执行。' } : {}), ...(businessGrouping ? { businessGrouping } : {}), interactions, snapshotId: input.id, reviewRounds:rounds, maxInputBytes: options.maxInputBytes, items, minimumCalls: (businessGrouping?.minimumCalls ?? 0) + items.reduce((sum,item) => sum + item.minimumCalls, 0) + interactions.reduce((sum,item) => sum + item.minimumCalls, 0), initialRequestsOnly: true };
}
