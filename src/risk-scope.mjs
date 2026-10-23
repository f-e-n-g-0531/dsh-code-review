import { hash } from './content.mjs';
import { initialInputBudget } from './input-budget.mjs';
import { CONTEXT_SIDE_NOTICE } from './context-identity.mjs';
import { REQUIREMENT_NOTICE } from './business-requirement.mjs';
import { changeScopeNotice } from './git-change-scope.mjs';

const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));

// Pure preparation of approved data; no reader calls, grants or persistent cache.
export function canonicalRiskInput(input, file, prepared, { instructions, scope, maxInputBytes }) {
  let payload = prepared.payload;
  if ((prepared.batches?.length ?? 1) > 1) {
    if (!scope) return { cacheable: false };
    const original = JSON.parse(prepared.payload);
    // Rebuild from the complete change map, never a first-window edit subset.
    const changes = prepared.changes;
    if (!changes || !Array.isArray(changes.edits)) return { cacheable: false };
    const identity = side => ({
      ...pick(side, ['hash', 'bytes', 'encoding']),
      hash: side?.hash ?? hash(side.text),
    });
    const compactFile = {
      ...pick(file, ['id', 'path', 'oldPath', 'rawStatus', 'reviewMode', 'kind', 'properties', 'contentNotice']),
      // Some adapters do not record baseline existence. Unknown is not absent.
      leftExists: typeof file.leftExists === 'boolean' ? file.leftExists : null,
      rightExists: typeof file.rightExists === 'boolean' ? file.rightExists : null,
      left: identity(file.left), right: identity(file.right),
    };
    payload = JSON.stringify({
      snapshotId: input.id,
      ...(input.vcs ? { vcs: input.vcs } : {}),
      sourceMode: 'risk-all-edits',
      ...(original.defectGuidance ? { defectGuidance: original.defectGuidance } : {}),
      file: compactFile,
      changes: { ...pick(changes, ['status', 'precision', 'reason']), edits: changes.edits },
      ...(input.history ? { history: input.history, contextSideNotice: CONTEXT_SIDE_NOTICE } : {}),
      ...(input.projectScope ? { projectScope: input.projectScope, reviewNotice: 'Current source audit; the empty left side is a transport sentinel, not a historical baseline.' } : {}),
      ...(input.changeScope ? { changeScope: input.changeScope, changeScopeNotice: changeScopeNotice(input.changeScope) } : {}),
      ...(input.businessRequirement !== undefined ? { businessRequirement: input.businessRequirement, requirementNotice: REQUIREMENT_NOTICE } : {}),
      rules: input.rules ?? [],
      catalog: scope?.catalog() ?? [],
      notice: 'One planning scope for every listed edit in this approved file, including edits in later windows. Metadata and source hashes are navigation, not source evidence. Planning only names questions and sourceIds for later primary-stage reads; it must not request bodies or claim source evidence. Risks remain unverified hypotheses and do not grant reads or prove coverage. Unknown existence is null; never infer absence from an empty source.',
    });
  }
  return initialInputBudget({ instructions, input: payload }, scope, maxInputBytes).fits
    ? { payload, cacheable: true }
    : { cacheable: false };
}
