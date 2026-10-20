import { hash } from './content.mjs';
import { keywordConfigurationTokens } from './svn-keyword-config.mjs';

// Each standard property spelling enables its complete native SVN alias group.
const STANDARD_GROUPS = [
  ['Date', 'LastChangedDate'], ['Revision', 'Rev', 'LastChangedRevision'],
  ['Author', 'LastChangedBy'], ['HeadURL', 'URL'], ['Id'], ['Header'],
];
const STANDARD = new Map(STANDARD_GROUPS.flatMap(group => group.map(name => [name, group])));
const CUSTOM_DEFINITION = /^([A-Za-z][A-Za-z0-9]*)=(.+)$/;
const ALLOWED_FORMAT_FLAGS = 'radDuRPb_HI%';
const ALLOWED_LITERAL = /[A-Za-z0-9_.:/ ()-]/;
const EXPANSION = /\$([A-Za-z][A-Za-z0-9]*)(:{1,2})([^\r\n$]*)\$/g;
const CONTRACTED_FIXED = /\$([A-Za-z][A-Za-z0-9]*)::( +)\$/g;

function parseCustomFormat(format) {
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c === '%') {
      if (!ALLOWED_FORMAT_FLAGS.includes(format[++i] ?? '') || i >= format.length) throw new Error('Unsupported SVN custom keyword format');
    } else if (!ALLOWED_LITERAL.test(c)) {
      throw new Error('Unsupported SVN custom keyword literal');
    }
  }
}

// Parse bounded quoted and unquoted SVN formats. Expansion is verified by SVN BASE,
// never reimplemented here; raw source remains the only evidence.
export function svnKeywordConfiguration(configuration) {
  if (typeof configuration !== 'string' || Buffer.byteLength(configuration) > 4096) throw new Error('Invalid SVN keyword configuration');
  const enabled = new Set(), configured = new Set(), custom = [];
  for (const token of keywordConfigurationTokens(configuration)) {
    if (STANDARD.has(token)) {
      if (configured.has(token)) throw new Error('Duplicate SVN keyword configuration');
      configured.add(token);
      for (const alias of STANDARD.get(token)) enabled.add(alias);
      continue;
    }
    const match = CUSTOM_DEFINITION.exec(token);
    if (!match || STANDARD.has(match[1]) || enabled.has(match[1])) throw new Error('Unsupported SVN custom keyword configuration');
    parseCustomFormat(match[2]);
    enabled.add(match[1]);
    custom.push({ name: match[1], format: match[2] });
  }
  return { enabled, custom };
}

export function svnKeywordMapping(text, configuration) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024) throw new Error('Invalid SVN keyword mapping input');
  const { enabled, custom } = svnKeywordConfiguration(configuration);
  let replacements = 0, fixedWidth = 0;
  const normalized = text.replace(EXPANSION, (literal, name, separator, value) => {
    if (!enabled.has(name)) return literal;
    if (separator === '::') {
      // SVN reserves the complete field width, including the initial space and
      // final space (or # truncation marker); retain UTF-8 byte width, not UTF-16 length.
      if (value.length < 2 || value[0] !== ' ' || ![' ', '#'].includes(value.at(-1))) throw new Error('Ambiguous SVN fixed-width keyword expansion');
      fixedWidth++;
      if (/[^ ]/.test(value)) replacements++;
      return '$' + name + '::' + ' '.repeat(Buffer.byteLength(value, 'utf8')) + '$';
    }
    if (!/^ .+ $/.test(value)) throw new Error('Ambiguous SVN keyword expansion');
    replacements++;
    return '$' + name + '$';
  });
  // Fixed fields intentionally retain :: after contraction. Any other colon
  // occurrence must be a complete recognized field, not silently partial data.
  const residual = normalized.replace(CONTRACTED_FIXED, (literal, name) => enabled.has(name) ? '' : literal);
  for (const name of enabled) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('\\$' + escaped + ':').test(residual)) throw new Error('Incomplete SVN keyword expansion mapping');
  }
  if (text.split('\n').length !== normalized.split('\n').length) throw new Error('SVN keyword mapping changed line identity');
  return {
    text: normalized, rawTextHash: hash(text), textHash: hash(normalized), replacements,
    ...(fixedWidth ? { fixedWidthFields: fixedWidth } : {}),
    ...(custom.length ? { customKeywords: custom } : {}),
    lineMapping: 'identity', status: 'candidate-only',
    notice: 'Line-preserving keyword view only; fixed-field width retained. BASE contraction must be independently verified against svn cat --ignore-keywords. Raw source and original line numbers remain evidence, not behavioral equivalence.',
  };
}
