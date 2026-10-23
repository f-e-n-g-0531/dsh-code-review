import { RISK_PLAN_SCHEMA } from './prompts.mjs';

// Describe only transport shape; never invent evidence or fill missing fields.
export const JSON_TRANSPORT_GUIDE = ' JSON strings: use ASCII double quotes; JSON-escape backslashes, quotes and CR/LF, preserving decoded paths/source/snippets exactly. No raw multiline strings, trailing commas or Markdown. Shorten optional prose only; retain required fields/evidence. Never invent or repair source.';
const VERDICT_CONTRACT = '本阶段必须返回 {"verdicts":[{"candidateId":"c1","verdict":"uncertain","reason":"证据不足原因","evidence":[]}]}，candidateId必须来自本次candidates；supported/refuted证据规则仍按原指令。不是findings响应。';
const GROUPS_CONTRACT = '本阶段返回groups数组，每项含fileIds和reason，文件身份必须来自输入，不是findings响应。';
const RISK_CONTRACT = RISK_PLAN_SCHEMA;
const INTERACTION_CONTRACT = '本阶段返回 {"findings":[],"limitations":[]}；发现必须包含原指令全部字段和跨文件interaction.editRefs。无足够跨文件证据时说明limitations，不编造。';
const FINDINGS_CONTRACT = '本阶段最终返回 {"findings":[],"limitations":[]}。每项finding必须含fileId、severity（critical/high/medium/low）、title、evidence、trigger、impact、suggestion和anchor；fileId原样复制file.id，不用文件名替代。行定位写成 anchor:{kind:"line",side:"new",start:1,end:1,snippet:"逐行原文"}（仅为形状示例，不是证据）；start/end用原来源一基行号而非窗口内序号，精确匹配原行；old/new按当前阶段允许侧选择，示例不改变授权；仅当没有retrievalFinalization且仍有检索余量时，需要更多证据可按检索协议先返回requests。';

function stageContract(p, instructions) {
  if (Array.isArray(p.candidates)) return VERDICT_CONTRACT;
  if (/返回\{groups:/.test(instructions)) return GROUPS_CONTRACT;
  if (/仅制定审查计划/.test(instructions)) return instructions.includes(RISK_PLAN_SCHEMA) ? '本阶段严格按上述risks schema返回，禁止requests/findings；身份逐项核对输入。' : RISK_CONTRACT;
  if (p.sourceMode === 'group-primary') return '本阶段返回{reviews:[{fileId,findings:[],limitations:[],risks:可选数组}],limitations:[]}；每项fileId仅来自reviews[].file.id，按文件原始坐标审查，不将分组自动视为交互证据。可按批准检索协议单独返回requests。';
  if (p.sourceMode === 'file-interaction') return INTERACTION_CONTRACT;
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
