import { CONTEXT_SIDE_NOTICE } from './context-identity.mjs';
import { approvedCallerBindings } from './caller-binding-input.mjs';
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
  const base = { ...(input.history ? {contextSideNotice:CONTEXT_SIDE_NOTICE} : {}), ...(input.businessRequirement!==undefined?{businessRequirement:input.businessRequirement,requirementNotice:REQUIREMENT_NOTICE}:{}), defectGuidance: defectGuidance(file.path, file.rightExists === false ? file.left.text : file.right.text), snapshotId: input.id, file, changes, context: input.context ?? [], rules: input.rules ?? [] };
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
  if (input.callerDiscovery) {
    const callerBindings = approvedCallerBindings(input, file);
    if (callerBindings.length) { base.callerBindings = callerBindings; base.callerBindingNotice = '调用方文件的导入行、调用行与目标声明行仅为语法位置线索，来源限于已批准上下文；历史side/revision要求调用方与目标声明同版本，缺侧不回退。仅导航，窗口中的原文须按相应版本catalog读取；不证明执行可达、动态分派、重载选择或完整调用覆盖，也不代表全部调用方。'; }
  }
  let payload = JSON.stringify(base);
  const measure = value => initialInputBudget({ instructions, input: value }, scope, maxInputBytes);
  const metadata = {};
  // Optional navigation must not block source review or force extra windows.
  if (base.callerBindings?.length && !measure(payload).fits) {
    metadata.callerBindingFallback = 'input-budget';
    metadata.omittedCallerBindingCount = base.callerBindings.reduce((count,c)=>count+c.bindings.length,0);
    delete base.callerBindings; delete base.callerBindingNotice;
    payload = JSON.stringify(base);
  }
  let batches, synthesis;
  const group = grouping?.groups.find(g => g.fileIds.includes(file.id));
  if (group) {
    metadata.groupId = group.id;
    const relatedFiles = input.files.filter(f => f.id !== file.id && f.eligibility === 'reviewable' && group.fileIds.includes(f.id));
    if (relatedFiles.length) {
      const relations = grouping.links.filter(link => !link.split && group.fileIds.includes(link.from) && group.fileIds.includes(link.to));
      const bindingRelations = inferImportRelations(input.files).filter(edge => (edge.bindingHints?.length || edge.definitionHints?.length) && (edge.from === file.id || edge.to === file.id) && group.fileIds.includes(edge.from) && group.fileIds.includes(edge.to)).map(({ from, to, side, bindingHints, definitionHints }) => ({ from, to, side, bindingHints, ...(definitionHints?.length ? { definitionHints } : {}) }));
      const grouped = JSON.stringify({ ...base, relatedFiles, relations, bindingRelations, relationNotice: '命名和相对导入关系仅为源码线索，可能被同名局部变量遮蔽，不证明绑定、调用可达或因果；只报告主file的问题，不为relatedFiles重复生成发现。' });
      if (measure(grouped).fits) { payload = grouped; metadata.relatedFileIds = relatedFiles.map(f => f.id); }
      else metadata.groupFallback = 'input-budget';
    }
  }
  if (!measure(payload).fits && scope) {
    const windows = changeWindows(file, changes);
    if (windows) {
      const compactFile = { ...file, left: { ...file.left, text: undefined }, right: { ...file.right, text: undefined } };
      const contextCatalog = scope.catalog().filter(source => ['context', 'context-old'].includes(source.side));
      if (contextCatalog.length) metadata.contextMode = 'approved-retrieval';
      const windowBase = { ...base };
      if (base.cppCallSites?.length) {
        windowBase.cppCallSites = base.cppCallSites.map(({line,expression,side})=>({line,expression,side}));
        windowBase.cppCallNotice = '最多40条旧/新侧零参语法导航；统一confidence=syntax-only-unresolved，可能为宏/重载/动态分派，无绑定、可达性或顺序保证，不是证据或完整覆盖。原文仍须按批准catalog读取。';
      }
      const compact = JSON.stringify({ ...windowBase, context: [], contextCatalog, contextMode: 'approved-retrieval', contextNotice: '上下文全文仍在同一批准快照，仅目录进入窗口初始输入；必须按sourceId和版本侧read原文，不把目录视为证据或完整覆盖。', file: compactFile, windows, sourceMode: 'change-windows', windowNotice: '仅提供全部精确hunk窗口，start/count为原始源码行号，不得重编号。完整源码未随初始输入发送，可在catalog批准范围内检索；缺少上下文时说明限制。' });
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
