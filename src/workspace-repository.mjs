import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { relativePath } from './content.mjs';
export async function resolveWorkspaceRepository(cwd, repositoryPath) {
  if (repositoryPath === undefined) return cwd;
  relativePath(repositoryPath);
  const root = await realpath(cwd);
  let current = root;
  for (const part of repositoryPath.split('/')) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Repository path must be a real workspace directory');
    const actual = await realpath(current);
    const relative = path.relative(root, actual);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative) || actual !== current) throw new Error('Repository path escapes workspace or traverses a link');
  }
  // Require an explicit root: never silently select a parent repository.
  const markers = [];
  for (const type of ['git', 'svn']) {
    try { const stat = await lstat(path.join(current, '.' + type)); if (stat.isSymbolicLink()) throw new Error('Linked repository marker'); markers.push(type); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (markers.length !== 1) throw new Error('Selected workspace directory is not an unambiguous Git/SVN repository root');
  return current;
}
