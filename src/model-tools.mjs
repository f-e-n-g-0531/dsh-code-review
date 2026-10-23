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
export function modelResultTools(input, instructions = '') {
  const stage = modelResultStage(input, instructions);
  if (!stage) return [];
  const final = stage === 'findings' ? review : stage === 'risks' ? object({ risks: array(risk) }) :
    stage === 'groups' ? object({ groups: array(object({ fileIds: strings, reason: { type: 'string' } })) }) :
    stage === 'reviews' ? object({ reviews: array(object({ fileId: { type: 'string' }, findings, limitations: strings, risks: array(risk) }, ['fileId', 'findings', 'limitations'])), limitations: strings }) :
    object({ verdicts: array(object({ candidateId: text, verdict: { enum: ['supported', 'refuted', 'uncertain'] }, reason: text, evidence: array({ type: 'object' }), regression: { type: 'object' } }, ['candidateId', 'verdict', 'reason', 'evidence'])) });
  let p; try { p = JSON.parse(input); } catch { return []; }
  const parameters = p.retrievalFinalization || stage === 'risks' || stage === 'groups' ? final : { type: 'object', oneOf: [final, requests] };
  return [{ name: RESULT_TOOL_NAME, description: 'Submit only the current approved review stage result or approved retrieval requests as JSON data. Does not execute actions.', parameters }];
}
// Additional wire bytes beyond the ordinary text contract/input. No token estimate.
export function nativeResultWireBytes(input, instructions = '') {
  const tools = modelResultTools(input, instructions);
  return tools.length ? Buffer.byteLength(JSON.stringify(tools)) + Buffer.byteLength(NATIVE_RESULT_INSTRUCTIONS) : 0;
}
export function validateNativeResult(text, input, instructions) {
  const value = JSON.parse(text), stage = modelResultStage(input, instructions);
  const p = JSON.parse(input);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.hasOwn(value, 'requests')) return !p.retrievalFinalization && !['risks', 'groups'].includes(stage) && Object.keys(value).length === 1 && Array.isArray(value.requests);
  const allowed = stage === 'findings' ? ['findings', 'limitations', 'risks'] : stage === 'reviews' ? ['reviews', 'limitations'] : [stage];
  const required = stage === 'findings' ? ['findings', 'limitations'] : stage === 'reviews' ? ['reviews', 'limitations'] : [stage];
  return !!stage && Object.keys(value).every(k => allowed.includes(k)) && required.every(k => Array.isArray(value[k]));
}
