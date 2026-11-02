import { createHash } from 'node:crypto';
import { validateInteractionFindings } from './interaction-findings.mjs';
import { validateSynthesisReads } from './synthesis-evidence.mjs';

export const GROUP_INTERACTION_INSTRUCTIONS = ' GROUP_INTERACTIONS: 本次精确完整组主审可在根结果附带可选 interactions:{groupId:"原groupId",findings:[],limitations:[]}。不要放在reviews成员内。只有在本次生成通过批准read实际读取组内所有精确编辑至少一侧后才可声明交互结果；完整正文、历史audit、风险或search不是该read证据。交互finding必须包含普通finding字段、主文件精确anchor/attribution以及跨至少两个不同成员的interaction.editRefs:[{fileId,editId}]。缺少或无法满足证据时可省略interactions，宿主保留独立交互阶段；不能以空数组伪造已检查。本开关覆盖前述“专门交互阶段仍独立校验”的传输安排：宿主仅在本channel全部验收成功后省去匹配的专门交互生成，缺失或失败仍独立执行；候选复核绝不省略。风险不是证据，分组不证明因果，独立候选复核仍需执行。';

// Call independently AFTER validateGroupPrimary. Optional channel failure never
// discards accepted primary findings, grants evidence, or triggers hidden retries.
export function validateGroupInteraction(response, prepared, snapshot, reads = [], catalog = []) {
  const groupId = prepared?.groupId;
  const fallback = reason => ({ status: 'fallback', groupId, reason, findings: [], limitations: [] });
  if (prepared?.groupInteraction !== true) return { status: 'disabled', groupId, findings: [], limitations: [] };
  try {
    const serialized = typeof response === 'string' ? response : JSON.stringify(response);
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 128 * 1024) return fallback('invalid-channel');
    const value = typeof response === 'string' ? JSON.parse(response) : response;
    if (!value || !Object.hasOwn(value, 'interactions')) return fallback('missing-channel');
    const channel = value.interactions;
    if (!channel || Array.isArray(channel) || Object.keys(channel).sort().join(',') !== 'findings,groupId,limitations' || channel.groupId !== groupId) return fallback('invalid-channel');
    const ids = prepared.fileIds;
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > 4 || new Set(ids).size !== ids.length || !Array.isArray(value.reviews) || value.reviews.length !== ids.length || new Set(value.reviews.map(row => row?.fileId)).size !== ids.length || value.reviews.some(row => !ids.includes(row?.fileId) || row.findings?.some(finding => finding?.interaction !== undefined))) return fallback('invalid-members');
    const original = JSON.parse(prepared.payload);
    if (original.snapshotId !== snapshot.id || original.sourceMode !== 'group-primary' || original.groupInteraction?.groupId !== groupId || !Array.isArray(original.groupInteraction.fileIds) || original.groupInteraction.fileIds.length !== ids.length || original.groupInteraction.fileIds.some((id, index) => id !== ids[index]) || !Array.isArray(original.reviews) || original.reviews.length !== ids.length || ids.some(id => { const captured = original.reviews.find(row => row.fileId === id)?.file; const current = snapshot.files.find(file => file.id === id); return !captured || !current || captured.path !== current.path || captured.left?.text !== current.left?.text || captured.right?.text !== current.right?.text; })) return fallback('stale-preparation');
    if (!Array.isArray(reads) || !Array.isArray(catalog) || new Set(catalog.map(source => source.id)).size !== catalog.length) return fallback('invalid-evidence');
    // Only successful current-generation source/hash identities participate.
    const audit = reads.filter(read => {
      const source = catalog.find(source => source.id === read?.sourceId);
      const file = snapshot.files.find(file => file.id === source?.fileId && file.path === source.path);
      const text = source?.side === 'old' ? file?.left?.text : source?.side === 'new' ? file?.right?.text : undefined;
      return typeof text === 'string' && read.kind === 'read' && read.snapshotId === snapshot.id && read.omitted !== true && read.hash === createHash('sha256').update(text).digest('hex') && (source.hash === undefined || source.hash === read.hash);
    });
    // Replacing an entire dedicated interaction requires current-generation
    // evidence for EVERY member/edit, not just a selected subset of findings.
    for (const id of ids) {
      const changes = prepared.changes?.get(id);
      if (changes?.precision !== 'exact' || changes.status !== 'changed' || !changes.edits.length) return fallback('inexact-members');
      validateSynthesisReads([{ attribution: { editIds: changes.edits.map(edit => edit.id) } }], changes, audit, catalog, id, snapshot.id);
    }
    const validated = validateInteractionFindings(channel, snapshot, { id: groupId, fileIds: ids }, audit, catalog);
    const seen = new Set();
    for (const finding of validated.findings) {
      const key = JSON.stringify([finding.fileId, finding.anchor, finding.interaction.editRefs.map(ref => [ref.fileId, ref.editId]).sort()]);
      if (seen.has(key)) return fallback('duplicate-findings');
      seen.add(key);
    }
    return { status: 'accepted', groupId, findings: validated.findings, limitations: validated.limitations };
  } catch { return fallback('invalid-evidence-or-findings'); }
}
