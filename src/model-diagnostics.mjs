import { createHash } from 'node:crypto';

// Never persist provider messages, response excerpts, headers, URLs or raw request IDs.
const digest = text => createHash('sha256').update(text).digest('hex');
const own = (value, key) => {
  try { const d = value != null ? Object.getOwnPropertyDescriptor(value, key) : undefined; return d && 'value' in d ? d.value : undefined; }
  catch { return undefined; }
};
const PROVIDER_CODES = new Set(['RATE_LIMIT','CONTEXT_WINDOW_EXCEEDED','QUOTA','ACCOUNT_QUOTA','AUTH','AUTHENTICATION','INVALID_CREDENTIAL','MISSING_CREDENTIAL','PERMISSION','TIMEOUT','NETWORK','SERVER_ERROR','SERVER','SERVICE_UNAVAILABLE','INVALID_ARGS','INVALID_REQUEST','BAD_REQUEST','EMPTY_RESPONSE','UNKNOWN','NO_ADAPTER','ABORTED','CANCELLED']);
export function providerDiagnostic(value) {
  const carried = own(value, 'failure');
  const code = own(carried, 'code') ?? own(value, 'code');
  const status = own(carried, 'status') ?? own(value, 'status');
  const retry = own(carried, 'providerRetryAfterMs') ?? own(value, 'providerRetryAfterMs');
  const requestId = own(carried, 'requestId') ?? own(value, 'requestId');
  return {
    ...(typeof code === 'string' && code.length > 0 && code.length <= 256 ? { providerCode: PROVIDER_CODES.has(code) ? code : 'UNRECOGNIZED', ...(PROVIDER_CODES.has(code) ? {} : { providerCodeHash: digest(code) }) } : {}),
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { providerStatus: status } : {}),
    ...(Number.isFinite(retry) && retry > 0 && retry <= 86400000 ? { providerRetryAfterMs: retry } : {}),
    ...(typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 512 ? { providerRequestIdHash: digest(requestId) } : {}),
  };
}

const SYNTAX_HINTS = {
  'property-name': '对象属性名必须使用双引号，不允许单引号、裸键或尾逗号。',
  colon: '属性名与值之间必须有冒号。',
  separator: '相邻属性或数组元素之间必须有逗号，结束处不可多加逗号。',
  'invalid-escape': 'JSON 字符串中的反斜杠必须合法转义；换行、引号和路径须按 JSON 编码。',
  'control-character': 'JSON 字符串中不能包含裸换行或控制字符，必须正确转义。',
  'unterminated-string': '字符串必须闭合；不要用多行裸文本或截断字符串。',
  'unexpected-end': '只输出一个语法完整且闭合的对象，不省略结尾。',
  'trailing-content': 'JSON 对象结束后不得附加解释、第二个对象或 Markdown。',
  syntax: '逐项检查双引号、转义、冒号、逗号和括号，输出完整严格 JSON。',
};
export function jsonSyntaxDiagnostic(body, error) {
  const message = error instanceof SyntaxError ? error.message : '';
  let category = 'syntax';
  if (/^Expected (?:property name|double-quoted property name)/.test(message)) category = 'property-name';
  else if (/^Expected ':'/.test(message)) category = 'colon';
  else if (/^Expected ','/.test(message)) category = 'separator';
  else if (/^Bad (?:escaped character|Unicode escape)/.test(message)) category = 'invalid-escape';
  else if (/^Bad control character/.test(message)) category = 'control-character';
  else if (/^Unterminated string/.test(message)) category = 'unterminated-string';
  else if (/^Unexpected end of JSON input/.test(message)) category = 'unexpected-end';
  else if (/^Unexpected non-whitespace character after JSON/.test(message)) category = 'trailing-content';
  const match = / at position ([0-9]+)(?: \(line [0-9]+ column [0-9]+\))?$/.exec(message);
  const offset = match ? Number(match[1]) : category === 'unexpected-end' ? body.length : undefined;
  let location = {};
  if (Number.isSafeInteger(offset) && offset >= 0 && offset <= body.length) {
    const before = body.slice(0, offset);
    const lines = before.split(/\r\n|\r|\n/);
    location = { offset, line: lines.length, column: lines.at(-1).length + 1 };
  }
  return { syntaxCategory: category, ...location, offsetUnit: 'utf16-code-unit-in-json-body', responseHash: digest(body) };
}
export function jsonCorrectionHint(diagnostic) {
  const category = diagnostic?.syntaxCategory;
  if (typeof category !== 'string' || !Object.hasOwn(SYNTAX_HINTS, category)) return '';
  const { line, column } = diagnostic;
  const location = Number.isSafeInteger(line) && line > 0 && Number.isSafeInteger(column) && column > 0 ? '，JSON正文第' + line + '行第' + column + '列' : '';
  return ' 本地解析诊断（不含原响应）：' + category + location + '。' + SYNTAX_HINTS[category];
}
