import { jsonSyntaxDiagnostic } from './model-diagnostics.mjs';

// Accept one complete JSON value, optionally inside one exact Markdown fence.
// This parser never repairs bytes or invokes a model; orchestration owns corrections.
// Accept only an unchanged leading JSON container followed by unmistakable prose.
function balancedPrefix(text) {
  if (!['{', '['].includes(text[0])) return undefined;
  const stack = []; let quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (escaped) escaped = false; else if (c === String.fromCharCode(92)) escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') {
      if (stack.pop() !== (c === '}' ? '{' : '[')) return undefined;
      if (!stack.length) {
        const body = text.slice(0, i + 1), tail = text.slice(i + 1).trim();
        if (!tail || /[{}\[\]\x60]/u.test(tail) || /^(?:true|false|null|-?\d|[,:;"'])/u.test(tail)) return undefined;
        if (!/^[\p{L}]/u.test(tail)) return undefined;
        try { JSON.parse(body); return body; } catch { return undefined; }
      }
    }
  }
  return undefined;
}
export function modelJson(text, { allowTrailingProse = false } = {}) {
  const bytes = Buffer.byteLength(text);
  const trimmed = text.trim();
  const fence = /^```(?:json)?\r?\n([\s\S]*)\r?\n```$/.exec(trimmed);
  const body = fence ? fence[1] : trimmed;
  try {
    JSON.parse(body);
  } catch (parseError) {
    if (allowTrailingProse && !fence) { const prefix = balancedPrefix(trimmed); if (prefix !== undefined) return prefix; }
    const envelope = fence ? 'json-fence' : 'plain';
    const shape = !trimmed ? 'empty' : trimmed.startsWith('```') && !fence ? 'non-exact-fence' : /^[{\[]/.test(body) ? 'json-like-invalid' : 'non-json-leading';
    const error = new Error('Model response is not complete JSON (bytes=' + bytes + ', envelope=' + envelope + ', shape=' + shape + '); no repair or retry performed by JSON parser');
    error.code = 'MODEL_INVALID_JSON';
    error.diagnostic = { jsonBytes: bytes, envelope, shape, ...jsonSyntaxDiagnostic(body, parseError) };
    throw error;
  }
  return body;
}
