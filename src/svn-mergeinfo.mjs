import { hash } from './content.mjs';

export function snapshotMergeSources(files) {
  return files
    .filter(file => file.eligibility === 'reviewable')
    .flatMap(file => file.properties
      .filter(prop => prop.name === 'svn:mergeinfo')
      .map(prop => ({ path: file.path, old: mergeinfoNavigation(prop.old), new: mergeinfoNavigation(prop.new) })));
}

const CONTROL_OR_BACKSLASH = /[\x00-\x1f\\]/;
const RANGE = /^([1-9][0-9]*)(?:-([1-9][0-9]*))?(\*)?$/;

// Navigation over an already approved property. Never expands revisions or reads URLs.
export function mergeinfoNavigation(text) {
  if (text === null || text === '') return { status: 'parsed', sources: [], hash: hash(text ?? '') };
  if (typeof text !== 'string') return { status: 'invalid', reason: 'Mergeinfo property is not text', sources: [] };
  if (Buffer.byteLength(text) > 16 * 1024) return { status: 'limited', reason: 'Mergeinfo navigation byte limit exceeded', sources: [], hash: hash(text) };
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > 100) return { status: 'limited', reason: 'Mergeinfo navigation source limit exceeded', sources: [], hash: hash(text) };

  const sources = [], seen = new Set();
  let rangeCount = 0;
  for (const line of lines) {
    const delimiter = line.lastIndexOf(':');
    const sourcePath = line.slice(0, delimiter), list = line.slice(delimiter + 1);
    if (delimiter < 1 || !sourcePath.startsWith('/') || CONTROL_OR_BACKSLASH.test(sourcePath) || sourcePath.length > 1024 || (sourcePath !== '/' && sourcePath.slice(1).split('/').some(part => !part || part === '.' || part === '..')) || seen.has(sourcePath)) {
      return { status: 'invalid', reason: 'Mergeinfo navigation path or duplicate source invalid', sources: [], hash: hash(text) };
    }
    seen.add(sourcePath);
    const ranges = [];
    for (const token of list.split(',')) {
      if (++rangeCount > 500) return { status: 'limited', reason: 'Mergeinfo navigation range limit exceeded', sources: [], hash: hash(text) };
      const match = RANGE.exec(token);
      if (!match) return { status: 'invalid', reason: 'Mergeinfo navigation revision range invalid', sources: [], hash: hash(text) };
      const start = Number(match[1]), end = Number(match[2] ?? match[1]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return { status: 'invalid', reason: 'Mergeinfo navigation revision range invalid', sources: [], hash: hash(text) };
      ranges.push({ start: String(start), end: String(end), inheritable: !match[3] });
    }
    sources.push({ sourcePath, ranges });
  }
  return { status: 'parsed', sources, hash: hash(text), notice: 'Explicit mergeinfo navigation only; not effective inherited mergeinfo, change attribution, permission to read a source or evidence that listed revisions were reviewed.' };
}
