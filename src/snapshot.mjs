import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { captureGit } from './git.mjs';
import { captureProjectRules } from './project-rules.mjs';
import { captureSvn } from './svn.mjs';
import { readLocal, relativePath, hash } from './content.mjs';

export async function detectVcs(cwd) {
  let current = await realpath(cwd);
  for (;;) {
    const found = [];
    for (const type of ['git', 'svn']) {
      try { await lstat(path.join(current, '.' + type)); found.push(type); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (found.length > 1) throw new Error('Ambiguous VCS root');
    if (found.length) return found[0];
    const parent = path.dirname(current);
    if (parent === current) throw new Error('No Git or SVN working copy found');
    current = parent;
  }
}
export async function captureSnapshot(cwd, options = {}) {
  const { rulePaths = [], contextPaths = [], maxContextFiles = 20, maxSnapshotBytes = 4 * 1024 * 1024 } = options;
  for (const value of [maxContextFiles, maxSnapshotBytes]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid snapshot limit');
  if (!Array.isArray(contextPaths) || contextPaths.length > maxContextFiles) throw new Error('Context file limit exceeded');
  for (const name of contextPaths) relativePath(name);
  const type = await detectVcs(cwd);
  const capture = type === 'git' ? captureGit : captureSvn;
  const snapshot = await capture(cwd, options);
  if (!Array.isArray(rulePaths) || rulePaths.some(name => contextPaths.includes(name))) throw new Error('Rule paths must be separate from context paths');
  const rules = await captureProjectRules(snapshot.root, rulePaths, { signal: options.signal, files: snapshot.files });
  const context = [];
  for (const name of [...new Set(contextPaths)].sort()) {
    const changed = snapshot.files.find(f => f.path === name);
    if (changed) {
      if (changed.eligibility !== 'reviewable') throw new Error('Context path is an excluded or blocked change');
      if (changed.rightExists === false) throw new Error('Deleted path cannot be working context');
      context.push({ path: name, ...changed.right });
    } else context.push({ path: name, ...await readLocal(snapshot.root, name, options) });
  }
  // Re-capture verifies both selected sides while collecting explicit context.
  if ((await capture(cwd, options)).id !== snapshot.id) throw new Error('Snapshot changed while collecting context');
  for (const item of context) if ((await readLocal(snapshot.root, item.path, options)).hash !== item.hash) throw new Error('Context changed during capture');
  const verifiedRules = await captureProjectRules(snapshot.root, rulePaths, { signal: options.signal, files: snapshot.files });
  if (JSON.stringify(verifiedRules) !== JSON.stringify(rules)) throw new Error('Rules changed during capture');
  const result = { ...snapshot, context, ...(rules.length ? { rules } : {}) };
  delete result.id;
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized) > maxSnapshotBytes) throw new Error('Snapshot size limit exceeded');
  return { ...result, id: hash(serialized) };
}
