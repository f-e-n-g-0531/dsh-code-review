import { inferContextRelations } from './context-relations.mjs';
import { planWindowBatches } from './window-batches.mjs';
import { changeWindows } from './change-windows.mjs';
import { changeMap } from './change-map.mjs';
import { initialInputBudget } from './input-budget.mjs';

// Pure preparation over already captured data. No model calls or new reads.
export function preparePrimaryInput(input, file, { instructions, scope, grouping, maxInputBytes }) {
  const changes = changeMap(file.left.text, file.right.text);
  const base = { snapshotId: input.id, file, changes, context: input.context ?? [], rules: input.rules ?? [] };
  const contextRelations = inferContextRelations(input, file);
  if (contextRelations.length) {
    base.contextRelations = contextRelations;
    base.contextRelationNotice = '导入与调用位置仅为语法线索；可能被同名局部变量遮蔽，不证明绑定、可达性或因果。';
  }
  let payload = JSON.stringify(base);
  const measure = value => initialInputBudget({ instructions, input: value }, scope, maxInputBytes);
  const metadata = {};
  let batches;
  const group = grouping?.groups.find(g => g.fileIds.includes(file.id));
  if (group) {
    metadata.groupId = group.id;
    const relatedFiles = input.files.filter(f => f.id !== file.id && f.eligibility === 'reviewable' && group.fileIds.includes(f.id));
    if (relatedFiles.length) {
      const relations = grouping.links.filter(link => !link.split && group.fileIds.includes(link.from) && group.fileIds.includes(link.to));
      const grouped = JSON.stringify({ ...base, relatedFiles, relations, relationNotice: '命名和相对导入关系仅为源码线索，可能被同名局部变量遮蔽，不证明绑定、调用可达或因果；只报告主file的问题，不为relatedFiles重复生成发现。' });
      if (measure(grouped).fits) { payload = grouped; metadata.relatedFileIds = relatedFiles.map(f => f.id); }
      else metadata.groupFallback = 'input-budget';
    }
  }
  if (!measure(payload).fits && scope) {
    const windows = changeWindows(file, changes);
    if (windows) {
      const compactFile = { ...file, left: { ...file.left, text: undefined }, right: { ...file.right, text: undefined } };
      const compact = JSON.stringify({ ...base, file: compactFile, windows, sourceMode: 'change-windows', windowNotice: '仅提供全部精确hunk窗口，start/count为原始源码行号，不得重编号。完整源码未随初始输入发送，可在catalog批准范围内检索；缺少上下文时说明限制。' });
      if (!measure(compact).fits) {
        const envelope = JSON.parse(compact);
        const plan = planWindowBatches(windows, subset => JSON.stringify({ ...envelope, windows: subset, windowNotice: '本批仅审查windows包含的编辑，其他hunk另批；行号为原始行号，跨片段上下文不足说明限制。' }), measure);
        metadata.windowBlocked = plan.blocked;
        if (!plan.blocked.length && plan.batches.length) {
          batches = plan.batches;
          payload = batches[0].payload;
          metadata.sourceMode = 'change-windows';
          metadata.windowIds = windows.map(w => w.id);
          metadata.batchCount = batches.length;
        }
      }
      if (measure(compact).fits) {
        payload = compact;
        metadata.sourceMode = 'change-windows';
        metadata.windowIds = windows.map(w => w.id);
        metadata.windowEditIds = [...new Set(windows.flatMap(w => w.editIds))];
      }
    }
  }
  const budget = measure(payload);
  return { changes, payload, batches, budget, metadata: { ...metadata, initialInputBytes: budget.bytes } };
}
