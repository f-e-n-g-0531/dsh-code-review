import { preparePrimaryInput } from './primary-input.mjs';
import { initialInputBudget } from './input-budget.mjs';
import { INLINE_RISK_INSTRUCTIONS } from './prompts.mjs';
import { validateRiskPlan } from './risk-plan.mjs';

export const GROUP_PRIMARY_INSTRUCTIONS = '批准的group-primary输入包含多个完整主文件。逐个审核所有reviews成员的新旧正文，并结合组内其他文件分析；不能仅审核一个文件。返回 {"reviews":[{"fileId":"原成员身份","findings":[],"limitations":[]}],"limitations":[]}，每个成员恰好一项，包括没有发现的成员。各finding仍需原审查指令全部字段、精确原行anchor及该fileId本次变化归因；不能用其他成员的身份或坐标替代。缺证据写limitations，不声明跨文件综合已完成；专门交互阶段仍独立校验。可按批准检索协议先返回requests。';

export function prepareGroupPrimary(snapshot, group, { instructions, scope, maxInputBytes, focusPrimaryContext = false, enableRiskPlanning = false } = {}) {
  if (!scope || snapshot.projectScope || !Array.isArray(group?.fileIds) || group.fileIds.length < 2 || group.fileIds.length > 4 || new Set(group.fileIds).size !== group.fileIds.length) return null;
  const members = group.fileIds.map(id => snapshot.files.find(file => file.id === id));
  if (members.some(file => !file || file.eligibility !== 'reviewable')) return null;
  const prepared = members.map(file => preparePrimaryInput(snapshot, file, { instructions, scope, maxInputBytes, focusPrimaryContext, riskPlanningMode: 'separate', enableRiskPlanning: false }));
  if (prepared.some(p => p.batches || p.synthesis || p.metadata.sourceMode || p.changes.precision !== 'exact')) return null;
  const reviews = prepared.map((p, i) => ({ ...JSON.parse(p.payload), fileId: members[i].id }));
  const context = [...new Map(reviews.flatMap(r => r.context ?? []).map(item => [JSON.stringify(item), item])).values()];
  for (const item of reviews) { delete item.context; delete item.rules; delete item.businessRequirement; delete item.requirementNotice; }
  const value = { snapshotId: snapshot.id, sourceMode: 'group-primary', groupId: group.id, reviews, context, rules: snapshot.rules ?? [], ...(snapshot.businessRequirement !== undefined ? { businessRequirement: snapshot.businessRequirement } : {}) };
  const payload = JSON.stringify(value), combined = instructions + '\n' + GROUP_PRIMARY_INSTRUCTIONS + (enableRiskPlanning ? '\n各成员可附带risks；组风险可引用所有成员精确编辑，仍只是假设，不增加规划调用。' + INLINE_RISK_INSTRUCTIONS.replace('Final JSON requires findings/limitations;', 'Each reviews member requires findings/limitations;') : '');
  return initialInputBudget({ input: payload, instructions: combined }, scope, maxInputBytes).fits ? { payload, instructions: combined, fileIds: [...group.fileIds], inlineRisk: enableRiskPlanning, changes: new Map(members.map((f, i) => [f.id, prepared[i].changes])) } : null;
}

export function validateGroupPrimary(response, prepared, snapshot, validate, catalog = []) {
  if (Buffer.byteLength(typeof response === 'string' ? response : JSON.stringify(response) ?? '') > 128 * 1024) throw new Error('Grouped primary response too large');
  const value = typeof response === 'string' ? JSON.parse(response) : response;
  if (!value || !Array.isArray(value.reviews) || value.reviews.length !== prepared.fileIds.length || !Array.isArray(value.limitations) || value.limitations.length > 50 || value.limitations.some(s => typeof s !== 'string' || !s.trim() || s.length > 8000)) throw new Error('Invalid grouped primary response');
  const output = new Map();
  for (const row of value.reviews) {
    if (!prepared.fileIds.includes(row?.fileId) || output.has(row.fileId)) throw new Error('Unknown or duplicate grouped primary member');
    const file = snapshot.files.find(f => f.id === row.fileId);
    if (row.findings?.some(finding => finding.interaction !== undefined)) throw new Error('Grouped primary cannot bypass dedicated interaction evidence validation');
    const generated = validate(row, file, prepared.changes.get(row.fileId));
    generated.limitations = [...generated.limitations, ...value.limitations];
    if (prepared.inlineRisk) {
      try { generated.groupRisk = row.risks === undefined ? { status: 'absent', risks: [] } : { status: 'completed', risks: validateRiskPlan({ risks: row.risks }, prepared.fileIds.map(id => ({ fileId: id, edits: prepared.changes.get(id).edits })), catalog) }; }
      catch { generated.groupRisk = { status: 'invalid', risks: [] }; }
    }
    output.set(row.fileId, generated);
  }
  return output;
}
