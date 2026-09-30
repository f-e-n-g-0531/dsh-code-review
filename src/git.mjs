import { realpath } from 'node:fs/promises';
import { run, checked } from './process.mjs';
import { hash, decode, readLocal, relativePath } from './content.mjs';

const flags = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];
const git = (cwd, args, options) => checked('git', [...flags, ...args], { ...options, cwd });
const text = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

export async function captureGit(cwd, options = {}) {
  const { signal, selectedPaths, maxFiles = 200, maxFileBytes = 256 * 1024 } = options;
  if (selectedPaths) for (const name of selectedPaths) relativePath(name);
  const root = await realpath(text(await git(cwd, ['rev-parse', '--show-toplevel'], options)).trim());
  const statusArgs = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'];
  const before = await git(root, statusArgs, options);
  const headResult = await run('git', [...flags, 'rev-parse', '--verify', 'HEAD'], { ...options, cwd: root });
  // Only a genuinely unborn branch may use an empty baseline.
  let head = headResult.code === 0 ? text(headResult.stdout).trim() : null;
  if (!head) {
    const branch = text(await git(root, ['symbolic-ref', 'HEAD'], options)).trim();
    const ref = await run('git', [...flags, 'show-ref', '--verify', '--quiet', branch], { ...options, cwd: root });
    if (ref.code !== 1) throw new Error('Cannot resolve Git HEAD');
  }
  const base = new Map();
  if (head) {
    const tree = text(await git(root, ['ls-tree', '-rz', '--full-tree', head], options));
    for (const record of tree.split('\0').filter(Boolean)) {
      const tab = record.indexOf('\t');
      const [mode, type, oid] = record.slice(0, tab).split(' ');
      base.set(record.slice(tab + 1), { mode, type, oid });
    }
  }
  const records = text(before).split('\0');
  const changes = [];
  for (let i = 0; i < records.length; i++) {
    if (!records[i]) continue;
    const rawStatus = records[i].slice(0, 2), name = records[i].slice(3);
    let oldPath;
    if (/[RC]/.test(rawStatus)) oldPath = records[++i];
    changes.push({ path: name, ...(oldPath ? { oldPath } : {}), rawStatus });
  }
  if (changes.length > maxFiles) throw new Error('Change count limit exceeded; narrow repository scope');
  const known = new Set(changes.map(c => c.path));
  if (selectedPaths?.some(p => !known.has(p))) throw new Error('Selected path is not a current change');
  const files = [];
  for (const change of changes) {
    signal?.throwIfAborted();
    const item = { ...change, id: hash(change.path), eligibility: 'reviewable', properties: [] };
    files.push(item);
    if ((selectedPaths && !selectedPaths.includes(change.path)) || (change.rawStatus === '??' && !selectedPaths?.includes(change.path))) {
      item.eligibility = 'excluded'; item.reason = 'Not explicitly selected'; continue;
    }
    try {
      relativePath(change.path);
      if (change.oldPath) relativePath(change.oldPath);
      if (/U/.test(change.rawStatus) || ['AA', 'DD'].includes(change.rawStatus)) throw new Error('Unresolved conflict');
      const previous = base.get(change.oldPath ?? change.path);
      if (previous && (previous.type !== 'blob' || previous.mode === '120000')) throw new Error('Submodule or symbolic link baseline');
      const left = previous ? await git(root, ['cat-file', 'blob', previous.oid], { ...options, maxBytes: maxFileBytes }) : Buffer.alloc(0);
      item.left = decode(left);
      try { item.right = await readLocal(root, change.path, options); item.rightExists = true; }
      catch (error) {
        if (error.code === 'ENOENT' && change.rawStatus.includes('D')) { item.right = decode(Buffer.alloc(0)); item.rightExists = false; }
        else throw error;
      }
      if (previous && item.rightExists && item.left.hash === item.right.hash && !change.oldPath) { item.eligibility = 'excluded'; item.reason = 'No net content change (mode-only changes not analyzed)'; }
    } catch (error) {
      signal?.throwIfAborted();
      item.eligibility = 'blocked'; item.reason = error.message;
      delete item.left; delete item.right;
    }
  }
  if (!(await git(root, statusArgs, options)).equals(before)) throw new Error('Repository changed during capture');
  const finalHead = await run('git', [...flags, 'rev-parse', '--verify', 'HEAD'], { ...options, cwd: root });
  if ((finalHead.code === 0 ? text(finalHead.stdout).trim() : null) !== head) throw new Error('HEAD changed during capture');
  for (const file of files.filter(f => f.right)) {
    if (file.rightExists) {
      if ((await readLocal(root, file.path, options)).hash !== file.right.hash) throw new Error('Content changed during capture');
    } else {
      try { await readLocal(root, file.path, options); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new Error('Deleted path reappeared during capture');
    }
  }
  const snapshot = { schemaVersion: 1, vcs: 'git', root, baseline: head, files };
  return { ...snapshot, id: hash(JSON.stringify(snapshot)) };
}
