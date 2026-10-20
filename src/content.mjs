import { assertNonSecretPath } from './secret-path.mjs';
import path from 'node:path';
import { lstat, realpath, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export function relativePath(value) {
  if (typeof value !== 'string' || !value || /[\\:\0]/.test(value) || path.posix.isAbsolute(value) || value.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git' || p.toLowerCase() === '.svn')) throw new Error('Unsafe repository path');
  return value;
}
export function decode(bytes) {
  let encoding = 'utf-8', body = bytes;
  if (bytes[0] === 255 && bytes[1] === 254) { encoding = 'utf-16le'; body = bytes.subarray(2); }
  else if (bytes[0] === 254 && bytes[1] === 255) { encoding = 'utf-16be'; body = bytes.subarray(2); }
  const text = new TextDecoder(encoding, { fatal: true }).decode(body);
  if (/[\x00-\x08\x0e-\x1f]/.test(text)) throw new Error('Binary content');
  return { text, hash: hash(bytes), encoding, bytes: bytes.length };
}

export async function readLocal(root, name, { maxFileBytes = 256 * 1024, signal } = {}) {
  relativePath(name);
  assertNonSecretPath(name);
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 16 * 1024 * 1024) throw new Error('Invalid file size limit');
  signal?.throwIfAborted();
  const canonicalRoot = await realpath(root);
  const filename = path.resolve(canonicalRoot, ...name.split('/'));
  let cursor = canonicalRoot;
  const ancestors = [];
  let expected;
  for (const part of name.split('/')) {
    cursor = path.join(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error('Symbolic links and junctions are excluded');
    if (cursor === filename) {
      if (!stat.isFile()) throw new Error('Not a regular file');
      expected = stat;
    } else {
      if (!stat.isDirectory()) throw new Error('Not a directory');
      ancestors.push({ path: cursor, stat });
    }
  }
  const canonical = await realpath(filename);
  const rel = path.relative(canonicalRoot, canonical);
  if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) throw new Error('Path escapes repository');
  const opened = await lstat(filename);
  if (opened.isSymbolicLink() || !opened.isFile()) throw new Error(opened.isSymbolicLink() ? 'Symbolic links and junctions are excluded' : 'Not a regular file');
  const handle = await open(canonical, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino || before.dev !== opened.dev || before.ino !== opened.ino) throw new Error('File changed during capture');
    if (before.size > maxFileBytes) throw new Error('File size limit exceeded');
    const buffer = Buffer.alloc(maxFileBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxFileBytes) throw new Error('File size limit exceeded');
    for (const ancestor of ancestors) {
      const now = await lstat(ancestor.path);
      if (now.isSymbolicLink() || !now.isDirectory() || now.dev !== ancestor.stat.dev || now.ino !== ancestor.stat.ino || now.ctimeMs !== ancestor.stat.ctimeMs) throw new Error('Ancestor changed during capture');
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino || canonical !== await realpath(filename)) throw new Error('File changed during capture');
    return decode(buffer.subarray(0, length));
  } finally { await handle.close(); }
}
