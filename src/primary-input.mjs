import { REQUIREMENT_NOTICE } from './business-requirement.mjs';
import { defectGuidance } from './defect-guidance.mjs';
import { cppCallSites } from './cpp-call-sites.mjs';
import { inferCsharpContext } from './csharp-context.mjs';
import { inferImportRelations } from './import-relations.mjs';
import { inferContextRelations } from './context-relations.mjs';
import { prepareWindowSynthesis } from './window-synthesis.mjs';
import { planWindowBatches } from './window-batches.mjs';
import { changeWindows } from './change-windows.mjs';
import { changeMap } from './change-map.mjs';
import { initialInputBudget } from './input-budget.mjs';

// Pure preparation over already captured data. No model calls or new reads.
export function preparePrimaryInput(input, file, { instructions, scope, grouping, maxInputBytes }) {
  const changes = changeMap(file.left.text, file.right.text);
  const base = { ...(input.businessRequirement!==undefined?{businessRequirement:input.businessRequirement,requirementNotice:REQUIREMENT_NOTICE}:{}), defectGuidance: defectGuidance(file.path, file.rightExists === false ? file.left.text : file.right.text), snapshotId: input.id, file, changes, context: input.context ?? [], rules: input.rules ?? [] };
  const contextRelations = inferContextRelations(input, file);
  if (contextRelations.length) {
    base.contextRelations = contextRelations;
    base.contextRelationNotice = '导入/include/命名与调用位置仅为语法线索；可能被宏、构建搜索路径或同名局部变量影响，不证明绑定、可达性或因果。context.text为批准当前/目标侧文本；仅明确oldText/oldRevision字段是历史旧侧，禁止互换。';
  }
  if (/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(file.path)) {
    const calls = ['old','new'].flatMap(side => cppCallSites((side === 'old' ? file.left : file.right).text).map(site => ({ ...site, side })));
    if (calls.length) { base.cppCallSites = calls; base.cppCallNotice = '最多20条零参语法位置/侧，仅导航子集；不表示全部调用覆盖，不证明宏展开、重载选择、动态分派或执行顺序。其他源码须在批准范围内读取。'; }
  }
  const csharpHints = inferCsharpContext(input, file);
  if (csharpHints.length) { base.csharpContextHints = csharpHints; base.csharpContextNotice = '仅批准context的C#静态类型/方法语法位置；历史输入按contextSide/contextVersion区分正文，无旧正文不回退目标侧。不证明语义绑定或执行可达。歧义不推定，线索不增加审查覆盖。'; }
  let payload = JSON.stringify(base);
  const measure = value => initialInputBudget({ instructions, input: value }, scope, maxInputBytes);
  const metadata = {};
  let batches, synthesis;
  const group = grouping?.groups.find(g => g.fileIds.includes(file.id));
  if (group) {
    metadata.groupId = group.id;
    const relatedFiles = input.files.filter(f => f.id !== file.id && f.eligibility === 'reviewable' && group.fileIds.includes(f.id));
    if (relatedFiles.length) {
      const relations = grouping.links.filter(link => !link.split && group.fileIds.includes(link.from) && group.fileIds.includes(link.to));
      const bindingRelations = inferImportRelations(input.files).filter(edge => edge.bindingHints?.length && (edge.from === file.id || edge.to === file.id) && group.fileIds.includes(edge.from) && group.fileIds.includes(edge.to)).map(({ from, to, side, bindingHints }) => ({ from, to, side, bindingHints }));
      const grouped = JSON.stringify({ ...base, relatedFiles, relations, bindingRelations, relationNotice: '命名和相对导入关系仅为源码线索，可能被同名局部变量遮蔽，不证明绑定、调用可达或因果；只报告主file的问题，不为relatedFiles重复生成发现。' });
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
  if (batches?.length > 1) {
    synthesis = prepareWindowSynthesis(batches.map(batch => batch.payload), measure);
    metadata.synthesisStatus = synthesis.budget.fits ? 'ready' : 'input-blocked';
    metadata.synthesisInputBytes = synthesis.budget.bytes;
  }
  const budget = measure(payload);
  return { changes, payload, batches, synthesis, budget, metadata: { ...metadata, initialInputBytes: budget.bytes } };
}
