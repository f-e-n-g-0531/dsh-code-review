import { checked } from './process.mjs';
import { relativePath, hash } from './content.mjs';
import { assertNonSecretPath } from './secret-path.mjs';

export function validateCallerScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 4) throw new Error('Invalid caller scopes');
  for (const scope of scopes) {
    relativePath(scope); assertNonSecretPath(scope);
    if (/[?*\[\]]/.test(scope)) throw new Error('Caller scope must be literal');
  }
  const sorted = [...scopes].sort();
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
    if (sorted[j] === sorted[i] || sorted[j].startsWith(sorted[i] + '/')) throw new Error('Overlapping caller scopes');
  }
  return sorted;
}

// Explicit discovery scopes, never an implicit repository-wide index.
export async function gitCallerIndex(root, scopes, options = {}) {
  const approved = validateCallerScopes(scopes);
  const chunks = [], entries = new Map();
  let bytes = 0, records = 0;
  for (const scope of approved) {
    const chunk = await checked('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'ls-files', '--stage', '-z', '--', scope], { ...options, cwd: root, maxBytes: 64 * 1024 });
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error('Caller index byte limit exceeded');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(chunk);
    if (text && !text.endsWith('\0')) throw new Error('Incomplete caller index');
    for (const record of text.split('\0').filter(Boolean)) {
      if (++records > 256) throw new Error('Caller index path limit exceeded');
      const match = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([\s\S]+)$/.exec(record);
      if (!match) throw new Error('Invalid caller index record');
      const name = relativePath(match[4]);
      if (!name.startsWith(scope + '/')) throw new Error('Caller scope is not a directory or index escaped scope');
      const regular = match[3] === '0' && ['100644', '100755'].includes(match[1]);
      entries.set(name, entries.has(name) ? false : regular);
    }
    chunks.push(chunk);
  }
  return { scopes: approved, paths: [...entries].filter(([, valid]) => valid).map(([name]) => name).sort(), fingerprint: hash(Buffer.concat(chunks)), records, bytes };
}
