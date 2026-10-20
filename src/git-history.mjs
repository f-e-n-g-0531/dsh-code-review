import { captureHistoryCallers } from './history-caller-capture.mjs';
import { isSecretPath, assertNonSecretPath } from './secret-path.mjs';
import { captureProjectRules } from './project-rules.mjs';
import { captureHistoryDependencyChain } from './history-dependency-chain.mjs';
import { realpath } from 'node:fs/promises';
import { checked } from './process.mjs';
import { hash, decode, relativePath } from './content.mjs';

const utf8 = b => new TextDecoder('utf-8', { fatal: true }).decode(b);
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REGULAR_BLOB = e => e?.type === 'blob' && ['100644', '100755'].includes(e.mode);

const gitAt = (root, args, options, limit = 1024 * 1024) =>
  checked('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], { ...options, cwd: root, maxBytes: limit });

async function resolveCommit(root, ref, options) {
  if (typeof ref !== 'string' || !ref || ref.length > 256 || ref.startsWith('-') || /[\s\0]/.test(ref)) throw new Error('Invalid revision');
  const oid = utf8(await gitAt(root, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'], options)).trim();
  if (!SHA.test(oid)) throw new Error('Invalid commit object');
  return oid;
}

function parseCommitParents(object) {
  // Commit messages (and identities) need not be UTF-8. Decode only the header
  // losslessly; parent object IDs themselves must still be strictly ASCII hex.
  const end = object.indexOf(Buffer.from('\n\n'));
  if (end < 0) throw new Error('Invalid commit header');
  const lines = object.subarray(0, end).toString('latin1').split('\n');
  if (!/^tree (?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(lines[0]) ||
      lines.some(line => line.includes('\0') || !/^(?:[a-z][a-z0-9-]* | )/.test(line))) {
    throw new Error('Invalid commit header');
  }
  const parents = lines.filter(line => line.startsWith('parent ')).map(line => line.slice(7));
  if (parents.some(oid => !SHA.test(oid))) throw new Error('Invalid commit parent');
  return parents;
}

/** Parse \`git diff-tree --raw -z\` into left/right blob maps plus the sorted path list. */
function parseDiffMeta(raw) {
  if (raw.at(-1) === '') raw.pop();
  if (raw.length % 2) throw new Error('Invalid historical diff metadata');
  const left = new Map(), right = new Map(), names = [];
  for (let i = 0; i < raw.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([\da-f]{40}|[\da-f]{64}) ([\da-f]{40}|[\da-f]{64}) ([AMDT])$/.exec(raw[i]);
    if (!m) throw new Error('Invalid historical diff metadata');
    const name = relativePath(raw[i + 1]);
    if (names.includes(name)) throw new Error('Duplicate historical change');
    names.push(name);
    for (const [map, mode, oid] of [[left, m[1], m[3]], [right, m[2], m[4]]]) {
      if (mode !== '000000') map.set(name, { mode, type: mode === '160000' ? 'commit' : 'blob', oid });
    }
  }
  names.sort();
  return { left, right, names };
}

// Literal, nonrecursive lookups cannot enumerate a supplied directory or wildcard.
async function lookupPaths(root, oid, map, requested, options) {
  if (!oid) return;
  const pending = [...new Set(requested)].filter(p => !map.has(p));
  for (let i = 0; i < pending.length; i++) {
    const paths = pending.slice(i, i + 1);
    paths.forEach(relativePath);
    const records = utf8(await gitAt(root, ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', oid, '--', ...paths], options)).split('\0').filter(Boolean);
    for (const r of records) {
      const m = /^(\d{6}) (blob|commit|tree) ([a-f0-9]+)\t([\s\S]+)$/.exec(r);
      if (!m || !paths.includes(m[4])) throw new Error('Invalid historical path lookup');
      map.set(m[4], { mode: m[1], type: m[2], oid: m[3] });
    }
  }
}

// Object-only capture: no checkout, worktree reads, external diff or fetch.
export async function captureGitHistory(cwd, options = {}) {
  const { commit, baseRevision, targetRevision, selectedPaths, signal, maxFiles = 200, maxFileBytes = 256 * 1024, maxSnapshotBytes = 4 * 1024 * 1024 } = options;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 200 || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 256 * 1024 || !Number.isSafeInteger(maxSnapshotBytes) || maxSnapshotBytes < 1 || maxSnapshotBytes > 4 * 1024 * 1024) throw new Error('Invalid historical capture limits');
  if (selectedPaths !== undefined && (!Array.isArray(selectedPaths) || selectedPaths.some(p => relativePath(p) !== p))) throw new Error('Invalid selected paths');

  const root = await realpath(utf8(await gitAt(cwd, ['rev-parse', '--show-toplevel'], options)).replace(/\r?\n$/, ''));

  // Resolve the two endpoints: commit compares against its sole parent; range uses explicit endpoints.
  let base, target;
  if (commit !== undefined) {
    if (baseRevision !== undefined || targetRevision !== undefined) throw new Error('Commit and range are mutually exclusive');
    target = await resolveCommit(root, commit, options);
    const object = await gitAt(root, ['cat-file', 'commit', target], options);
    const parents = parseCommitParents(object);
    if (parents.length > 1) throw new Error('Merge commit requires explicit revision range');
    base = parents[0] ?? null;
  } else {
    base = await resolveCommit(root, baseRevision, options);
    target = await resolveCommit(root, targetRevision, options);
  }

  // Metadata scales with changed paths, not every tracked file in either tree.
  const raw = utf8(await gitAt(root, ['diff-tree', '--no-abbrev', '--raw', '-z', '-r', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-commit-id', ...(base ? [base, target] : ['--root', target]), '--'], options)).split('\0');
  const { left, right, names } = parseDiffMeta(raw);

  if (names.length > maxFiles) throw new Error('Historical change count limit exceeded');
  if (selectedPaths?.some(p => !names.includes(p))) throw new Error('Selected path is not a historical change');

  const files = [];
  for (const name of names) {
    signal?.throwIfAborted();
    const l = left.get(name), r = right.get(name);
    const item = { id: hash(name), path: name, rawStatus: !l ? 'A' : !r ? 'D' : 'M', eligibility: 'reviewable', properties: [] };
    files.push(item);
    if (isSecretPath(name)) { item.eligibility = 'excluded'; item.reason = 'Credential path excluded'; continue; }
    if (selectedPaths && !selectedPaths.includes(name)) { item.eligibility = 'excluded'; item.reason = 'Not explicitly selected'; continue; }
    try {
      for (const e of [l, r].filter(Boolean)) if (e.type !== 'blob' || !['100644', '100755'].includes(e.mode)) throw new Error('Historical link or submodule excluded');
      const read = async e => decode(e ? await gitAt(root, ['cat-file', 'blob', e.oid], options, maxFileBytes) : Buffer.alloc(0));
      item.left = await read(l);
      item.right = await read(r);
      item.rightExists = !!r;
      if (l && r && item.left.hash === item.right.hash) { item.eligibility = 'excluded'; item.reason = 'Mode-only historical change not analyzed'; }
    } catch (error) {
      signal?.throwIfAborted();
      item.eligibility = 'blocked'; item.reason = error.message;
      delete item.left; delete item.right;
    }
    if (Buffer.byteLength(JSON.stringify(files)) > maxSnapshotBytes) throw new Error('Historical snapshot limit exceeded');
  }

  const rulePaths = options.rulePaths ?? [];
  const contextPaths = options.contextPaths ?? [], oldContextPaths = options.oldContextPaths ?? [], maxContextFiles = options.maxContextFiles ?? 20;
  if (!Array.isArray(oldContextPaths) || oldContextPaths.length > 20 || new Set(oldContextPaths).size !== oldContextPaths.length) throw new Error('Invalid old context paths');
  for (const name of oldContextPaths) { relativePath(name); assertNonSecretPath(name); }
  if (oldContextPaths.length && !base) throw new Error('Old context requires nonempty historical baseline');
  if (!Array.isArray(contextPaths) || !Array.isArray(rulePaths)) throw new Error('Invalid historical context or rule paths');
  if (oldContextPaths.some(p => contextPaths.includes(p) || rulePaths.includes(p))) throw new Error('Old context paths must be separate');
  if (contextPaths.length + oldContextPaths.length > maxContextFiles) throw new Error('Historical context file limit exceeded');
  if (!Array.isArray(contextPaths) || !Number.isSafeInteger(maxContextFiles) || maxContextFiles < 1 || maxContextFiles > 20 || contextPaths.length > maxContextFiles) throw new Error('Historical context file limit exceeded');
  if (options.autoContext !== undefined && typeof options.autoContext !== 'boolean') throw new Error('Invalid autoContext option');
  if (!Array.isArray(rulePaths) || rulePaths.length > 4 || rulePaths.some(p => contextPaths.includes(p))) throw new Error('Rule paths must be separate from context paths');

  await lookupPaths(root, target, right, [...contextPaths, ...rulePaths], options);
  await lookupPaths(root, base, left, [...contextPaths, ...oldContextPaths], options);

  const context = [];
  const readBlob = (oid, limit = maxFileBytes) => gitAt(root, ['cat-file', 'blob', oid], options, limit);

  const captureContext = async name => {
    relativePath(name); assertNonSecretPath(name);
    const changed = files.find(f => f.path === name);
    if (changed) {
      if (changed.eligibility !== 'reviewable' || changed.rightExists === false) throw new Error('Historical context is excluded blocked or deleted');
      return { path: name, ...changed.right };
    }
    const entry = right.get(name);
    if (!REGULAR_BLOB(entry)) throw new Error('Historical context not a target regular blob');
    const content = decode(await readBlob(entry.oid));
    const previous = left.get(name);
    return { path: name, ...content, revision: target, ...(REGULAR_BLOB(previous) ? { oldText: decode(await readBlob(previous.oid)).text, oldRevision: base } : {}) };
  };

  for (const name of [...new Set(contextPaths)].sort()) context.push(await captureContext(name));

  for (const name of [...oldContextPaths].sort()) {
    const changed = files.find(f => f.path === name);
    if (changed) {
      if (changed.eligibility !== 'reviewable' || !left.has(name)) throw new Error('Old context conflicts with excluded blocked or absent old change');
      continue;
    }
    const entry = left.get(name);
    if (!REGULAR_BLOB(entry)) throw new Error('Old context not a baseline regular blob');
    const content = decode(await readBlob(entry.oid));
    context.push({ path: name, oldOnly: true, oldText: content.text, oldHash: hash(content.text), oldBlobOid: entry.oid, oldRevision: base });
  }

  const rules = await captureProjectRules(root, rulePaths, {
    signal, files,
    read: async (_root, name, { maxFileBytes: limit }) => {
      const entry = right.get(name);
      if (!REGULAR_BLOB(entry)) throw new Error('Historical rule not a target regular blob');
      return decode(await readBlob(entry.oid, limit));
    },
  });

  let autoContext;
  if (options.autoContext === true) autoContext = await captureHistoryDependencyChain(root, files, { base, target }, context, options);

  let callerDiscovery;
  if (options.callerScopePaths !== undefined) {
    const callers = await captureHistoryCallers(root, files, { base, target }, options.callerScopePaths, options);
    callerDiscovery = callers.discovery;
    for (const item of callers.context) {
      const matches = callerDiscovery.candidates.filter(c => c.fromPath === item.path);
      const present = context.find(c => c.path === item.path);
      if (present) {
        if ((present.text !== undefined && present.text !== item.text) || (present.oldText !== undefined && present.oldText !== item.oldText)) throw new Error('Historical caller context identity conflict');
        for (const c of matches) {
          const available = c.side === 'old' ? present.oldText !== undefined : present.text !== undefined;
          c.status = available ? 'reused-context' : 'blocked';
          if (!available) c.captureReason = 'Existing context did not approve this version side';
        }
        continue;
      }
      if (context.length >= maxContextFiles) {
        for (const c of matches) { c.status = 'blocked'; c.captureReason = 'Context file limit exceeded'; }
        continue;
      }
      context.push(item);
      callerDiscovery.capturedPaths.push(item.path);
      for (const c of matches) c.status = 'captured';
    }
  }

  const snapshot = { context, ...(callerDiscovery ? { callerDiscovery } : {}), ...(rules.length ? { rules } : {}), ...(autoContext ? { autoContext } : {}), schemaVersion: 1, vcs: 'git', root, baseline: base, history: { mode: commit !== undefined ? 'commit' : 'range', base, target, semantics: 'exact-tree-endpoints; renames represented as add/delete' }, files };
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized) > maxSnapshotBytes) throw new Error('Historical snapshot limit exceeded');
  return { ...snapshot, id: hash(serialized) };
}
