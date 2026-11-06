import { preparePrimaryInput } from './primary-input.mjs';
import { initialInputBudget } from './input-budget.mjs';
import { validateRiskPlan } from './risk-plan.mjs';
import { GROUP_INTERACTION_INSTRUCTIONS } from './group-interaction.mjs';
import { correctAnchor } from './anchor-correction.mjs';

export const GROUP_PRIMARY_INSTRUCTIONS = '批准的group-primary输入包含多个完整主文件。逐个审核所有reviews成员的新旧正文，并结合组内其他文件分析；不能仅审核一个文件。返回 {"reviews":[{"fileId":"原成员身份","findings":[],"limitations":[]}],"limitations":[]}，每个成员恰好一项，包括没有发现的成员。各finding仍需原审查指令全部字段、精确原行anchor及该fileId本次变化归因；不能用其他成员的身份或坐标替代。缺证据写limitations，不声明跨文件综合已完成；专门交互阶段仍独立校验。可按批准检索协议先返回requests。';

// Group output has a different envelope from single-file inline review. Keep the
// required risk field on each member, without inheriting optional/omit guidance.
const GROUP_PRIMARY_RISK_INSTRUCTIONS = '每个reviews成员必须包含risks字段（数组，可为[]），禁止省略或放到顶层；没有真实风险或精确编辑时返回risks:[]，不要为满足字段要求编造风险。组风险可引用本组所有成员的精确编辑，不增加规划调用。风险仅为待证假设，不是证据、缺陷或扩大范围/读取权限的授权；sourceIds不证明已读。先审核全部成员编辑与反证，再报告findings。中间可按批准检索协议返回requests，但不得与最终结果混用。Risk shape: {id:"r1",fileIds:["reviews[].fileId"],editRefs:[{fileId:"reviews[].fileId",editId:"changes.edits[].id"}],question:"Risk?",trigger:"Condition",impact:"Failure",checks:["Countercheck"],sourceIds:[]}. Exactly these 8 keys, all required. Each member risks: 0..20; serialized {risks} JSON UTF-8<=65536 bytes. id/question/trigger/impact and each check: nonblank string, JS length<=2000; id unique within each member risks. fileIds: 1..4 unique approved group member IDs. editRefs: 1..20 unique objects with ONLY string fileId/editId; fileId in this risk.fileIds and editId owned by that file. checks: 1..8 unique strings. sourceIds: 0..8 unique catalog IDs (no catalog: []), never paths. Copy real IDs, never guess.';

export function prepareGroupPrimary(snapshot, group, { instructions, scope, maxInputBytes, maxRetrievalRounds = 3, focusPrimaryContext = false, enableRiskPlanning = false, enableGroupInteractions = false, migrationContracts = [] } = {}) {
  if (typeof enableGroupInteractions !== 'boolean') throw new Error('Invalid group interaction option');
  if (!scope || snapshot.projectScope || !Array.isArray(group?.fileIds) || group.fileIds.length < 2 || group.fileIds.length > 4 || new Set(group.fileIds).size !== group.fileIds.length) return null;
  const members = group.fileIds.map(id => snapshot.files.find(file => file.id === id));
  if (members.some(file => !file || file.eligibility !== 'reviewable')) return null;
  const prepared = members.map(file => preparePrimaryInput(snapshot, file, { instructions, scope, maxInputBytes, maxRetrievalRounds, focusPrimaryContext, riskPlanningMode: 'separate', enableRiskPlanning: false }));
  if (prepared.some(p => p.batches || p.synthesis || p.metadata.sourceMode || p.changes.precision !== 'exact')) return null;
  const reviews = prepared.map((p, i) => ({ ...JSON.parse(p.payload), fileId: members[i].id }));
  const context = [...new Map(reviews.flatMap(r => r.context ?? []).map(item => [JSON.stringify(item), item])).values()];
  for (const item of reviews) { delete item.context; delete item.rules; delete item.businessRequirement; delete item.requirementNotice; }
  const value = { snapshotId: snapshot.id, sourceMode: 'group-primary', groupId: group.id, reviews, context, rules: snapshot.rules ?? [], ...(snapshot.businessRequirement !== undefined ? { businessRequirement: snapshot.businessRequirement } : {}) };
  let payload = JSON.stringify(value);
  const groupInstructions = enableRiskPlanning ? GROUP_PRIMARY_INSTRUCTIONS.replace('"findings":[],"limitations":[]}', '"findings":[],"limitations":[],"risks":[]}') + '\n' + GROUP_PRIMARY_RISK_INSTRUCTIONS : GROUP_PRIMARY_INSTRUCTIONS;
  let combined = instructions + '\n' + groupInstructions;
  if (!initialInputBudget({ input: payload, instructions: combined, maxRetrievalRounds }, scope, maxInputBytes).fits) return null;
  const contracts = migrationContracts.filter(contract => contract.candidateFileIds?.some(id => group.fileIds.includes(id)));
  if (contracts.length) { const proposed = JSON.stringify({ ...JSON.parse(payload), migrationContracts: contracts, migrationNotice: 'Host navigation hypotheses only. Compare the old public gate, new entry and callers under the same trigger. Neither semantics nor causality are established; independent verification is required.' }); if (initialInputBudget({ input: proposed, instructions: combined, maxRetrievalRounds }, scope, maxInputBytes).fits) payload = proposed; }
  let groupInteraction = false;
  if (enableGroupInteractions && typeof group.id === 'string' && group.id.length > 0 && group.id.length <= 200 && prepared.every(p => p.changes.status === 'changed' && p.changes.edits.length)) {
    const proposed = JSON.stringify({ ...JSON.parse(payload), groupInteraction: { groupId: group.id, fileIds: [...group.fileIds] } });
    if (initialInputBudget({ input: proposed, instructions: combined + GROUP_INTERACTION_INSTRUCTIONS, maxRetrievalRounds }, scope, maxInputBytes).fits) { payload = proposed; combined += GROUP_INTERACTION_INSTRUCTIONS; groupInteraction = true; }
  }
  return { payload, instructions: combined, fileIds: [...group.fileIds], inlineRisk: enableRiskPlanning, changes: new Map(members.map((f, i) => [f.id, prepared[i].changes])), ...(enableGroupInteractions ? { groupId: group.id, groupInteraction, ...(!groupInteraction ? { groupInteractionFallback: 'input-budget-or-inexact' } : {}) } : {}) };
}

export function validateGroupPrimary(response, prepared, snapshot, validate, catalog = [], { enableAnchorCorrection = false, signal } = {}) {
  if (Buffer.byteLength(typeof response === 'string' ? response : JSON.stringify(response) ?? '') > 128 * 1024) throw new Error('Grouped primary response too large');
  const value = typeof response === 'string' ? JSON.parse(response) : response;
  if (!value || !Array.isArray(value.reviews) || value.reviews.length !== prepared.fileIds.length || !Array.isArray(value.limitations) || value.limitations.length > 50 || value.limitations.some(s => typeof s !== 'string' || !s.trim() || s.length > 8000)) throw new Error('Invalid grouped primary response');
  const output = new Map();
  for (const row of value.reviews) {
    if (!prepared.fileIds.includes(row?.fileId) || output.has(row.fileId)) throw new Error('Unknown or duplicate grouped primary member');
    const file = snapshot.files.find(f => f.id === row.fileId);
    if (row.findings?.some(finding => finding.interaction !== undefined)) throw new Error('Grouped primary cannot bypass dedicated interaction evidence validation');
    const changes = prepared.changes.get(row.fileId);
    const anchorCorrections = [];
    let memberResponse = row;
    if (enableAnchorCorrection === true && Array.isArray(row.findings) && row.findings.length <= 50) {
      // Host correction only relocates exact text within this member and source side.
      // Preserve model output and still enforce every ordinary validation rule below.
      memberResponse = structuredClone(row);
      memberResponse.findings = memberResponse.findings.map(raw => {
        const correction = correctAnchor(raw, file, changes, { signal });
        if (!['unchanged', 'not-applicable'].includes(correction.status)) anchorCorrections.push(correction);
        return correction.status === 'corrected' ? correction.candidate : raw;
      });
    }
    const generated = validate(memberResponse, file, changes);
    if (anchorCorrections.length) generated.anchorCorrections = anchorCorrections;
    generated.limitations = [...generated.limitations, ...value.limitations];
    if (prepared.inlineRisk) {
      try { generated.groupRisk = row.risks === undefined ? { status: 'absent', risks: [] } : { status: 'completed', risks: validateRiskPlan({ risks: row.risks }, prepared.fileIds.map(id => ({ fileId: id, edits: prepared.changes.get(id).edits })), catalog) }; }
      catch { generated.groupRisk = { status: 'invalid', risks: [] }; }
    }
    output.set(row.fileId, generated);
  }
  return output;
}
