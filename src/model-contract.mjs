import { RISK_PLAN_SCHEMA } from './prompts.mjs';

// Describe only transport shape; never invent evidence or fill missing fields.
export const JSON_TRANSPORT_GUIDE = ' JSON strings: use ASCII double quotes; JSON-escape backslashes, quotes and CR/LF, preserving decoded paths/source/snippets exactly. No raw multiline strings, trailing commas or Markdown. Shorten optional prose only; retain required fields/evidence. Never invent or repair source.';
const VERDICT_CONTRACT = '返回{verdicts:[{candidateId,verdict,reason,evidence,regression:{classification,reason,oldEvidence,newEvidence}}]}。身份来自candidates；evidence必须为数组，每个候选最多8条，supported/refuted至少1条实际读取引用，uncertain允许空数组。选能覆盖旧新入口、触发与关键反证的最小充分集合，不要把全部retrieved台账复制为evidence；不得合并、删改原文或伪造回执以压缩数量。oldEvidence/newEvidence为evidence内不重复零基索引，每组最多8项。不默认 uncertain 或空证据；按原指令选择判定、引用本次receiptId及两侧索引，不编造。不是findings响应。';
const MODEL_COMPARISON_CONTRACT = ' 本次明确启用可选模型跨文件比较形状：regression可替代为{classification,reason,comparison:{kind:"model-assessed-cross-file",roles:{oldEntry,oldDelegate,newEntry,newDelegate可选,callers},relationshipReason}}，不得混入oldEvidence/newEvidence/migrationContractId。每个角色为本候选evidence内1至8个不重复整数索引0..7，不是sourceId、路径或读取请求；证据总数仍最多8条且必须来自本次实际批准读取。角色证据须覆盖相应完整来源或宿主列出的完整文本函数范围；辅助合同、反证及下游行为引用可以不分配角色，但仍须本次精确读取，不能借辅助片段补齐角色。按相同触发条件核对入口、委托与调用方，不用片段猜关系。classification和relationshipReason是模型语义评估，不是hostcontract、宿主证明或独立因果证明，不授予读取权限，不自动进入旧严格introduced支持统计。输入策略仅说明输出形状，宿主仍需独立启用并严格校验，否则拒绝。';
const GROUPS_CONTRACT = '本阶段返回groups数组，每项含fileIds和reason，文件身份必须来自输入，不是findings响应。';
const RISK_CONTRACT = RISK_PLAN_SCHEMA;
const INTERACTION_CONTRACT = '本阶段返回 {"findings":[],"limitations":[]}；发现必须包含原指令全部字段和跨文件interaction.editRefs。无足够跨文件证据时说明limitations，不编造。';
const FINDINGS_CONTRACT = '本阶段最终返回 {"findings":[],"limitations":[]}。每项finding必须含fileId、severity（critical/high/medium/low）、title、evidence、trigger、impact、suggestion和anchor；fileId原样复制file.id，不用文件名替代。行定位写成 anchor:{kind:"line",side:"new",start:1,end:1,snippet:"逐行原文"}（仅为形状示例，不是证据）；start/end用原来源一基行号而非窗口内序号，精确匹配原行；old/new按当前阶段允许侧选择，示例不改变授权；仅当没有retrievalFinalization且仍有检索余量时，需要更多证据可按检索协议先返回requests。';

function stageContract(p, instructions) {
  if (Array.isArray(p.candidates)) return VERDICT_CONTRACT + (p.modelComparisonPolicy && typeof p.modelComparisonPolicy === 'object' && !Array.isArray(p.modelComparisonPolicy) && p.modelComparisonPolicy.enabled === true ? MODEL_COMPARISON_CONTRACT : '') + (Array.isArray(p.migrationContracts) && p.migrationContracts.length ? ' 若明确按宿主migrationContracts跨文件比较，regression仅在原classification/reason/oldEvidence/newEvidence之外附带migrationContractId；必须逐字来自本次宿主contract.id，不允许模型声明新的contract、source授权或角色。缺边证据保留uncertain；未启用时仍按原同主文件规则。' : '');
  if (/返回\{groups:/.test(instructions)) return GROUPS_CONTRACT;
  if (/仅制定审查计划/.test(instructions)) return instructions.includes(RISK_PLAN_SCHEMA) ? '本阶段严格按上述risks schema返回，禁止requests/findings；身份逐项核对输入。' : RISK_CONTRACT;
  if (p.sourceMode === 'group-primary') return '本阶段返回{reviews:[{fileId,findings:[],limitations:[],risks:可选数组}],limitations:[]}；每项fileId仅来自reviews[].file.id，按文件原始坐标审查，不将分组自动视为交互证据。可按批准检索协议单独返回requests。' + (p.groupInteraction ? ' 根结果可附带可选interactions:{groupId,findings:[],limitations:[]}，groupId严格来自groupInteraction.groupId；只有本次实际read覆盖各成员编辑并通过交互校验才替代独立交互阶段。缺失/非法交互不抹主审结果且保留独立阶段；reviews成员不能夹带interaction发现。' : '');
  if (p.sourceMode === 'file-interaction') return INTERACTION_CONTRACT + (instructions.includes('INLINE_INTERACTION_RISKS') ? ' 可同时返回risks数组，风险schema与原指令一致；风险是假设而非已确认发现，不代替交互证据。' : '');
  if (p.file) return FINDINGS_CONTRACT;
  return '';
}

export function modelContract(input, instructions = '') {
  let p;
  try { p = JSON.parse(input); } catch { return ''; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return '';
  const contract = stageContract(p, instructions);
  const guide = contract && !instructions.includes(JSON_TRANSPORT_GUIDE) ? JSON_TRANSPORT_GUIDE : '';
  return contract + guide + (p.retrievalFinalization ? ' 本次检索已受限：只返回当前阶段最终schema，禁止requests；不能将缺证据声称为无问题或完整覆盖。' : '');
}
