import { hash, relativePath } from './content.mjs';
import { mergeinfoNavigation } from './svn-mergeinfo.mjs';

const NOTICE = 'Effective property navigation within the evidenced ancestor boundary only; not merge attribution, reviewed revision coverage, permission to read branch bodies, or proof of merge execution.';

// records are nearest-first and complete from target to the declared boundary.
// present:false is proven absence; missing records must never mean absent.
export function effectiveMergeinfo(target, records, { boundary = '.', complete = false } = {}) {
  if (target !== '.') relativePath(target);
  if (boundary !== '.') relativePath(boundary);
  if (boundary !== '.' && target !== boundary && !target.startsWith(boundary + '/')) throw new Error('Mergeinfo boundary is not an ancestor');

  const unknown = reason => ({ status: 'unknown', reason, sources: [], notice: NOTICE });
  if (!Array.isArray(records) || records.length > 33) return unknown('Ancestor evidence missing or depth limit exceeded');

  let cursor = target;
  const evidence = [];
  for (const record of records) {
    if (!record || record.path !== cursor || typeof record.present !== 'boolean' || typeof record.identity !== 'string' || !record.identity) return unknown('Incomplete or unordered ancestor provenance');
    if (record.present && typeof record.value !== 'string') return unknown('Mergeinfo value is not captured text');
    evidence.push({ path: cursor, identity: record.identity, present: record.present, ...(record.present ? { propertyHash: hash(record.value) } : {}) });

    if (record.present) {
      const parsed = mergeinfoNavigation(record.value);
      if (parsed.status !== 'parsed') return { ...parsed, evidence, notice: NOTICE };
      const inherited = cursor !== target;
      const suffix = cursor === '.' ? (target === '.' ? '' : target) : target.slice(cursor.length + 1);
      const sources = parsed.sources
        .map(source => ({
          sourcePath: inherited ? (source.sourcePath === '/' ? '' : source.sourcePath) + '/' + suffix : source.sourcePath,
          ranges: source.ranges.filter(range => !inherited || range.inheritable),
        }))
        .filter(source => source.ranges.length);
      if (sources.some(s => s.sourcePath.length > 1024)) return { status: 'limited', reason: 'Inherited mergeinfo source path limit exceeded', sources: [], evidence, notice: NOTICE };
      return { status: 'parsed', origin: cursor, inherited, explicitEmpty: record.value === '', sources, evidence, hash: hash(JSON.stringify(evidence)), notice: NOTICE };
    }

    if (cursor === boundary) {
      if (!complete) return { ...unknown('Ancestor boundary does not prove repository-wide absence'), evidence, hash: hash(JSON.stringify(evidence)) };
      return { status: 'parsed', origin: null, inherited: false, sources: [], evidence, hash: hash(JSON.stringify(evidence)), notice: NOTICE };
    }
    if (cursor === '.') return unknown('Declared ancestor boundary was not reached');
    cursor = cursor.includes('/') ? cursor.slice(0, cursor.lastIndexOf('/')) : '.';
  }
  return unknown('Ancestor evidence ended before nearest explicit property or boundary');
}

// Injected reader must freeze UUID/URL/peg/operative revision and charge its
// existing command/metadata budget. This helper never reads branch bodies.
export async function captureEffectiveMergeinfo(target, { read, signal, boundary = '.', complete = false } = {}) {
  if (typeof read !== 'function') throw new Error('Fixed ancestor property reader required');
  if (target !== '.') relativePath(target);
  if (boundary !== '.') relativePath(boundary);
  if (boundary !== '.' && target !== boundary && !target.startsWith(boundary + '/')) throw new Error('Mergeinfo boundary is not an ancestor');
  const records = [];
  let cursor = target;
  for (let depth = 0; depth < 33; depth++) {
    signal?.throwIfAborted();
    const record = await read(cursor);
    signal?.throwIfAborted();
    if (record?.path !== cursor) throw new Error('Mergeinfo ancestor reader identity mismatch');
    records.push(record);
    if (record.present || cursor === boundary) return effectiveMergeinfo(target, records, { boundary, complete });
    if (cursor === '.') throw new Error('Mergeinfo ancestor boundary not reached');
    cursor = cursor.includes('/') ? cursor.slice(0, cursor.lastIndexOf('/')) : '.';
  }
  return { status: 'limited', reason: 'Mergeinfo ancestor depth limit exceeded', sources: [], notice: NOTICE };
}
