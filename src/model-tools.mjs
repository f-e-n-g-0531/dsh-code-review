import { buildModelComparisonSchema } from './model-comparison-schema.mjs';
import { trustedReceiptIds } from './verification-receipt-policy.mjs';
// Installed dsh-llm ToolSchema: {name,description,parameters}; tool arguments are
// strings, not parsed objects. This declares a data result, never an executable tool.
export const RESULT_TOOL_NAME = 'submit_review_result';
export const NATIVE_RESULT_INSTRUCTIONS = ' Prefer submit_review_result to submit the current stage JSON as tool arguments (data only, no execution). If tools are unavailable, return the same JSON as text in this response. Never submit multiple results or mix a result with prose.';
const strings = { type: 'array', items: { type: 'string' } };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const array = items => ({ type: 'array', items });
const text = { type: 'string' };
const anchor = { oneOf: [object({ kind: { const: 'line' }, side: { enum: ['old', 'new'] }, start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 }, snippet: text }), object({ kind: { const: 'property' }, name: text }), object({ kind: { const: 'file' } })] };
const finding = { type: 'object', properties: { fileId: text, severity: { enum: ['critical', 'high', 'medium', 'low'] }, title: text,
  evidence: text, trigger: text, impact: text, suggestion: text, anchor,
  attribution: { type: 'object' }, interaction: { type: 'object' } },
  required: ['fileId', 'severity', 'title', 'evidence', 'trigger', 'impact', 'suggestion', 'anchor'] };
const findings = array(finding); // Existing validators still enforce exact evidence and identities.
const risk = object({ id: { type: 'string' }, fileIds: strings,
  editRefs: array(object({ fileId: { type: 'string' }, editId: { type: 'string' } })),
  question: { type: 'string' }, trigger: { type: 'string' }, impact: { type: 'string' }, checks: strings, sourceIds: strings });
const review = object({ findings, limitations: strings, risks: array(risk) }, ['findings', 'limitations']);
const requests = object({ requests: { type: 'array', minItems: 1, maxItems: 8, items: { oneOf: [
  object({ kind: { const: 'read' }, id: { type: 'string' }, start: { type: 'integer', minimum: 1 }, count: { type: 'integer', minimum: 1, maximum: 200 } }),
  object({ kind: { const: 'search' }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, sourceIds: strings }, ['kind', 'query']),
  object({ kind: { const: 'find' }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['kind', 'query']),
] } } });
export function modelResultStage(input, instructions = '') {
  let p; try { p = JSON.parse(input); } catch { return undefined; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return undefined;
  if (Array.isArray(p.candidates)) return 'verdicts';
  if (/返回\{groups:/.test(instructions)) return 'groups';
  if (/仅制定审查计划/.test(instructions)) return 'risks';
  if (p.sourceMode === 'group-primary') return 'reviews';
  if (p.file || p.sourceMode === 'file-interaction') return 'findings';
  return undefined;
}
export function modelResultTools(input, instructions = '', receiptProof) {
  const stage = modelResultStage(input, instructions);
  if (!stage) return [];
  let p; try { p = JSON.parse(input); } catch { return []; }
  const migrationIds = Array.isArray(p.migrationContracts) ? p.migrationContracts.map(contract => contract?.id).filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200).slice(0, 128) : [];
  const regression = migrationIds.length ? object({ classification: { enum: ['introduced', 'preexisting', 'uncertain'] }, reason: text, oldEvidence: array({ type: 'integer', minimum: 0 }), newEvidence: array({ type: 'integer', minimum: 0 }), migrationContractId: { type: 'string', maxLength: 200, enum: [...new Set(migrationIds)] } }, ['classification', 'reason', 'oldEvidence', 'newEvidence']) : object({ classification: { enum: ['introduced', 'preexisting', 'uncertain'] }, reason: text, oldEvidence: array({ type: 'integer', minimum: 0 }), newEvidence: array({ type: 'integer', minimum: 0 }) });
  const issued = trustedReceiptIds(receiptProof);
  const final = stage === 'findings' ? review : stage === 'risks' ? object({ risks: array(risk) }) :
    stage === 'groups' ? object({ groups: array(object({ fileIds: strings, reason: { type: 'string' } })) }) :
    stage === 'reviews' ? object({ reviews: array(object({ fileId: { type: 'string' }, findings, limitations: strings, risks: array(risk) }, ['fileId', 'findings', 'limitations'])), limitations: strings, ...(p.groupInteraction ? { interactions: object({ groupId: { const: p.groupInteraction.groupId }, findings, limitations: strings }) } : {}) }, ['reviews', 'limitations']) :
    object({ verdicts: array(object({ candidateId: text, verdict: { enum: ['supported', 'refuted', 'uncertain'] }, reason: text, evidence: array({ oneOf: [{ ...object({ receiptId: {type:'string',description:'Copy exactly one receiptId actually returned by a read in this verification invocation. This object contains ONLY receiptId; never add sourceId, text, range or other fields. Unknown or earlier-review IDs are rejected.'} }), description:'Receipt-only reference. Exactly one key: receiptId. Mutually exclusive with the complete six-field reference. Do not invent or repair an ID.' }, { ...object({ snapshotId: text, sourceId: text, hash: text, start: { type: 'integer', minimum: 1 }, count: { type: 'integer', minimum: 1, maximum: 200 }, text }), description:'Complete reference: copy exactly snapshotId, sourceId, hash, start, count, text from one actual read result. Do not include receiptId or endOfSource; never combine this form with a receipt-only reference.' }] }), regression }, ['candidateId', 'verdict', 'reason', 'evidence'])) });
  if(stage==='verdicts'){
    const evidence=final.properties.verdicts.items.properties.evidence;
    evidence.maxItems=8;
    evidence.description='At most eight evidence references per candidate. Supported/refuted require at least one actual approved read; uncertain may use an empty array. Select the minimal sufficient old/new/public-gate/counterevidence set, not every retrieved fragment. Never invent, merge, truncate or renumber evidence bodies.';
    for(const field of ['oldEvidence','newEvidence']){regression.properties[field].maxItems=8;regression.properties[field].description='At most eight distinct zero-based indices into this candidate evidence array; duplicates are rejected by the host.';}
    if (p.modelComparisonPolicy && typeof p.modelComparisonPolicy === 'object' && !Array.isArray(p.modelComparisonPolicy) && p.modelComparisonPolicy.enabled === true) {
      final.properties.verdicts.items.properties.regression = { oneOf: [regression, buildModelComparisonSchema()] };
    }
  }
  if (stage === 'verdicts' && issued !== undefined) {
    const branches = final.properties.verdicts.items.properties.evidence.items.oneOf;
    if (issued.length) branches[0].properties.receiptId.enum = issued;
    else branches.shift(); // Never emit invalid enum:[] or an unrestricted fallback.
  }
  const parameters = p.retrievalFinalization || stage === 'risks' || stage === 'groups' ? final : { type: 'object', oneOf: [final, requests] };
  return [{ name: RESULT_TOOL_NAME, description: 'Submit only the current approved review stage result or approved retrieval requests as JSON data. Does not execute actions.', parameters }];
}
// Additional wire bytes beyond the ordinary text contract/input. No token estimate.
export function nativeResultWireBytes(input, instructions = '', receiptProof) {
  const tools = modelResultTools(input, instructions, receiptProof);
  return tools.length ? Buffer.byteLength(JSON.stringify(tools)) + Buffer.byteLength(NATIVE_RESULT_INSTRUCTIONS) : 0;
}
export function validateNativeResult(text, input, instructions) {
  const value = JSON.parse(text), stage = modelResultStage(input, instructions);
  const p = JSON.parse(input);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.hasOwn(value, 'requests')) return !p.retrievalFinalization && !['risks', 'groups'].includes(stage) && Object.keys(value).length === 1 && Array.isArray(value.requests);
  const allowed = stage === 'findings' ? ['findings', 'limitations', 'risks'] : stage === 'reviews' ? ['reviews', 'limitations', ...(p.groupInteraction ? ['interactions'] : [])] : [stage];
  const required = stage === 'findings' ? ['findings', 'limitations'] : stage === 'reviews' ? ['reviews', 'limitations'] : [stage];
  return !!stage && Object.keys(value).every(k => allowed.includes(k)) && required.every(k => Array.isArray(value[k]));
}
