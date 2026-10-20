import { isSecretPath } from './secret-path.mjs';
import { realpath } from 'node:fs/promises';
import { run, checked } from './process.mjs';
import { hash, decode, readLocal, relativePath } from './content.mjs';
import { changeScope } from './git-change-scope.mjs';

const flags = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];
const STATUS_ARGS = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'];
const git = (cwd, args, options) => checked('git', [...flags, ...args], { ...options, cwd });
const text = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

async function resolveRoot(cwd, options) {
  const top = text(await git(cwd, ['rev-parse', '--show-toplevel'], options)).replace(/\r?\n$/, '');
  return realpath(top);
}

/** HEAD commit sha, or null only for a genuinely unborn branch. */
async function resolveHead(root, options) {
  const headResult = await run('git', [...flags, 'rev-parse', '--verify', 'HEAD'], { ...options, cwd: root });
  const head = headResult.code === 0 ? text(headResult.stdout).trim() : null;
  if (head) return head;
  const branch = text(await git(root, ['symbolic-ref', 'HEAD'], options)).trim();
  const ref = await run('git', [...flags, 'show-ref', '--verify', '--quiet', branch], { ...options, cwd: root });
  if (ref.code !== 1) throw new Error('Cannot resolve Git HEAD');
  return null;
}

function parseChanges(bytes) {
  const records = text(bytes).split('\0');
  const changes = [];
  for (let i = 0; i < records.length; i++) {
    if (!records[i]) continue;
    const rawStatus = records[i].slice(0, 2);
    const name = records[i].slice(3);
    let oldPath;
    if (/[RC]/.test(rawStatus)) oldPath = records[++i];
    changes.push({ path: name, ...(oldPath ? { oldPath } : {}), rawStatus });
  }
  return changes;
}

/** Keep only the entries the requested comparison actually observes. */
function changesInScope(changes, scope) {
  // Porcelain reports a staged deletion and its untracked recreation separately.
  // Worktree compares HEAD to the current file once, retaining the tracked entry
  // (and its baseline/selection authority), not a second untracked identity.
  if (scope === 'worktree') {
    const tracked = new Set(changes.filter(change => change.rawStatus !== '??').map(change => change.path));
    return changes.filter(change => change.rawStatus !== '??' || !tracked.has(change.path));
  }
  if (scope === 'staged') return changes.filter(change => change.rawStatus[0] !== ' ' && change.rawStatus[0] !== '?');
  return changes.filter(change => change.rawStatus[1] !== ' ' || change.rawStatus === '??');
}

/** Report only the status column this scope observes so identity follows the compared sides. */
function scopeStatus(rawStatus, scope) {
  if (scope === 'worktree') return rawStatus;
  if (scope === 'staged') return rawStatus[0] + ' ';
  return rawStatus === '??' ? '??' : ' ' + rawStatus[1];
}

/**
 * Serialize one change for the snapshot. An unstaged entry compares index to worktree, so a
 * staged rename's old path is not a side of that comparison and must not reach the model.
 */
function scopeEntry(change, scope) {
  const oldPath = scope === 'unstaged' ? undefined : change.oldPath;
  return { path: change.path, ...(oldPath ? { oldPath } : {}), rawStatus: scopeStatus(change.rawStatus, scope) };
}

/** Resolve only reviewable changed baselines; never enumerate the whole HEAD tree. */
async function resolveBaselines(root, head, changes, selectedPaths, options, signal) {
  const base = new Map();
  const requested = [...new Set(changes
    .filter(change =>
      !isSecretPath(change.path) &&
      !isSecretPath(change.oldPath) &&
      (!selectedPaths || selectedPaths.includes(change.path)) &&
      (change.rawStatus !== '??' || selectedPaths?.includes(change.path)))
    .map(change => relativePath(change.oldPath ?? change.path)))];
  for (const name of requested) {
    signal?.throwIfAborted();
    const records = text(await git(root, ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', head, '--', name], options)).split('\0').filter(Boolean);
    for (const record of records) {
      const m = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(record);
      if (!m || m[4] !== name || base.has(name)) throw new Error('Invalid changed baseline lookup');
      base.set(name, { mode: m[1], type: m[2], oid: m[3] });
    }
  }
  return base;
}

/**
 * Resolve index entries for the selected paths only. Stage entries above zero mean an
 * unresolved conflict; callers block those files instead of reading a partial side.
 */
async function resolveIndexEntries(root, names, options) {
  const entries = new Map();
  for (let i = 0; i < names.length; i += 64) {
    const chunk = names.slice(i, i + 64);
    const records = text(await git(root, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...chunk], options)).split('\0');
    for (const record of records) {
      if (!record) continue;
      const m = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([\s\S]+)$/.exec(record);
      if (!m || !chunk.includes(m[4])) throw new Error('Invalid index entry lookup');
      if (entries.has(m[4])) entries.set(m[4], { conflict: true });
      else entries.set(m[4], { mode: m[1], oid: m[2], stage: m[3] });
    }
  }
  return entries;
}

/** Stable identity of the index entries a capture depends on; mode and content changes are caught even when status text is unchanged. */
function indexIdentity(entries, names) {
  return names.map(name => {
    const entry = entries.get(name);
    return name + '\0' + (entry ? (entry.conflict ? 'conflict' : entry.mode + ':' + entry.oid) : '');
  }).join('\n');
}

function assertReviewableIndexEntry(entry) {
  if (!entry) throw new Error('Missing index baseline');
  if (entry.conflict || entry.stage !== '0') throw new Error('Unresolved conflict');
  if (entry.mode === '120000' || entry.mode === '160000') throw new Error('Submodule or symbolic link baseline');
}

async function readIndexBlob(root, entry, options, maxFileBytes) {
  let bytes;
  try {
    bytes = await git(root, ['cat-file', 'blob', entry.oid], { ...options, maxBytes: maxFileBytes });
  } catch (error) {
    if (/output limit exceeded/i.test(error.message)) throw new Error('File size limit exceeded');
    throw error;
  }
  return decode(bytes);
}

/** A staged deletion has no index entry; every other staged path reads its index blob. */
async function readStagedRight(root, entry, options, maxFileBytes) {
  if (!entry) return { right: decode(Buffer.alloc(0)), rightExists: false };
  assertReviewableIndexEntry(entry);
  return { right: await readIndexBlob(root, entry, options, maxFileBytes), rightExists: true };
}

/** Unstaged left side is the index entry; untracked files have no index baseline. */
async function readUnstagedLeft(root, change, entries, options, maxFileBytes) {
  if (change.rawStatus === '??') return decode(Buffer.alloc(0));
  const entry = entries.get(change.path);
  assertReviewableIndexEntry(entry);
  return readIndexBlob(root, entry, options, maxFileBytes);
}

/** Worktree and staged captures read the same HEAD baseline; unstaged uses the index instead. */
async function readHeadLeft(root, change, baselines, options, maxFileBytes) {
  const previous = baselines.get(change.oldPath ?? change.path);
  if (previous && (previous.type !== 'blob' || previous.mode === '120000')) throw new Error('Submodule or symbolic link baseline');
  return previous ? decode(await git(root, ['cat-file', 'blob', previous.oid], { ...options, maxBytes: maxFileBytes })) : decode(Buffer.alloc(0));
}

async function readWorktreeRight(root, change, options) {
  try {
    return { right: await readLocal(root, change.path, options), rightExists: true };
  } catch (error) {
    if (error.code === 'ENOENT' && change.rawStatus.includes('D')) return { right: decode(Buffer.alloc(0)), rightExists: false };
    throw error;
  }
}

export async function captureGit(cwd, options = {}) {
  const { signal, selectedPaths, maxFiles = 200, maxFileBytes = 256 * 1024 } = options;
  const scope = changeScope(options.changeScope);
  if (selectedPaths) for (const name of selectedPaths) relativePath(name);
  const root = await resolveRoot(cwd, options);
  const before = await git(root, STATUS_ARGS, options);
  const head = await resolveHead(root, options);
  const changes = changesInScope(parseChanges(before), scope);
  const counted = changes.filter(change => change.rawStatus !== '??' || selectedPaths?.includes(change.path));
  if (counted.length > maxFiles) throw new Error('Change count limit exceeded; narrow repository scope');
  const known = new Set(changes.map(c => c.path));
  if (selectedPaths?.some(p => !known.has(p))) throw new Error('Selected path is not a current change in the selected scope');
  const projectedBefore = scope === 'worktree' ? null : JSON.stringify(changes.map(change => scopeEntry(change, scope)));
  const baselines = scope !== 'unstaged' && head ? await resolveBaselines(root, head, changes, selectedPaths, options, signal) : new Map();
  const indexNames = scope === 'worktree' ? [] : [...new Set(changes.filter(change => change.rawStatus !== '??').map(change => change.path))];
  const indexEntries = scope === 'worktree' ? new Map() : await resolveIndexEntries(root, indexNames, options);
  const indexBefore = indexIdentity(indexEntries, indexNames);

  const files = [];
  for (const change of changes) {
    signal?.throwIfAborted();
    const item = { ...scopeEntry(change, scope), id: hash(change.path), eligibility: 'reviewable', properties: [] };
    files.push(item);
    if (isSecretPath(change.path) || isSecretPath(change.oldPath)) { item.eligibility = 'excluded'; item.reason = 'Credential path excluded'; continue; }
    if ((selectedPaths && !selectedPaths.includes(change.path)) || (change.rawStatus === '??' && !selectedPaths?.includes(change.path))) {
      item.eligibility = 'excluded'; item.reason = 'Not explicitly selected'; continue;
    }
    try {
      relativePath(change.path);
      if (change.oldPath) relativePath(change.oldPath);
      if (/U/.test(change.rawStatus) || ['AA', 'DD'].includes(change.rawStatus)) throw new Error('Unresolved conflict');
      const baselineExists = scope === 'unstaged' ? change.rawStatus !== '??' : baselines.has(change.oldPath ?? change.path);
      item.left = scope === 'unstaged' ? await readUnstagedLeft(root, change, indexEntries, options, maxFileBytes) : await readHeadLeft(root, change, baselines, options, maxFileBytes);
      const right = scope === 'staged'
        ? await readStagedRight(root, change.rawStatus[0] === 'D' ? undefined : indexEntries.get(change.path), options, maxFileBytes)
        : await readWorktreeRight(root, change, options);
      item.right = right.right;
      item.rightExists = right.rightExists;
      if (baselineExists && item.rightExists && item.left.hash === item.right.hash && !item.oldPath) {
        item.eligibility = 'excluded'; item.reason = 'No net content change (mode-only changes not analyzed)';
      }
    } catch (error) {
      signal?.throwIfAborted();
      item.eligibility = 'blocked'; item.reason = error.message;
      delete item.left; delete item.right;
    }
  }

  const after = await git(root, STATUS_ARGS, options);
  const scopeUnchanged = scope === 'worktree'
    ? after.equals(before)
    : JSON.stringify(changesInScope(parseChanges(after), scope).map(change => scopeEntry(change, scope))) === projectedBefore;
  if (!scopeUnchanged) throw new Error('Repository changed during capture');
  const finalHead = await run('git', [...flags, 'rev-parse', '--verify', 'HEAD'], { ...options, cwd: root });
  if ((finalHead.code === 0 ? text(finalHead.stdout).trim() : null) !== head) throw new Error('HEAD changed during capture');
  if (scope !== 'worktree') {
    const entriesAfter = await resolveIndexEntries(root, indexNames, options);
    if (indexIdentity(entriesAfter, indexNames) !== indexBefore) throw new Error('Index changed during capture');
  }
  if (scope !== 'staged') {
    for (const file of files.filter(f => f.right)) {
      if (file.rightExists) {
        if ((await readLocal(root, file.path, options)).hash !== file.right.hash) throw new Error('Content changed during capture');
      } else {
        try { await readLocal(root, file.path, options); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        throw new Error('Deleted path reappeared during capture');
      }
    }
  }
  const snapshot = { schemaVersion: 1, vcs: 'git', root, baseline: head, ...(scope === 'worktree' ? {} : { changeScope: scope }), files };
  return { ...snapshot, id: hash(JSON.stringify(snapshot)) };
}
