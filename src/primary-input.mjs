import { changeMap } from './change-map.mjs';
import { initialInputBudget } from './input-budget.mjs';

// Pure preparation over already captured data. No model calls or new reads.
export function preparePrimaryInput(input, file, { instructions, scope, grouping, maxInputBytes }) {
  const changes = changeMap(file.left.text, file.right.text);
  const base = { snapshotId: input.id, file, changes, context: input.context ?? [], rules: input.rules ?? [] };
  let payload = JSON.stringify(base);
  const measure = value => initialInputBudget({ instructions, input: value }, scope, maxInputBytes);
  const metadata = {};
  const group = grouping?.groups.find(g => g.fileIds.includes(file.id));
  if (group) {
    metadata.groupId = group.id;
    const relatedFiles = input.files.filter(f => f.id !== file.id && f.eligibility === 'reviewable' && group.fileIds.includes(f.id));
    if (relatedFiles.length) {
      const grouped = JSON.stringify({ ...base, relatedFiles, relationNotice: '命名关系仅为提示；只报告主file的问题，不为relatedFiles重复生成发现。' });
      if (measure(grouped).fits) { payload = grouped; metadata.relatedFileIds = relatedFiles.map(f => f.id); }
      else metadata.groupFallback = 'input-budget';
    }
  }
  const budget = measure(payload);
  return { changes, payload, budget, metadata: { ...metadata, initialInputBytes: budget.bytes } };
}
