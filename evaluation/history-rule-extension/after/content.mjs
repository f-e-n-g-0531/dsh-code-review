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
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 16 * 1024 * 1024) throw new Error('Invalid file size limit');
  signal?.throwIfAborted();
  const canonicalRoot = await realpath(root);
  const filename = path.resolve(canonicalRoot, ...name.split('/'));
  let cursor = canonicalRoot;
  for (const part of name.split('/')) {
    cursor = path.join(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error('Symbolic links and junctions are excluded');
    if (cursor === filename && !stat.isFile()) throw new Error('Not a regular file');
  }
  const canonical = await realpath(filename);
  const rel = path.relative(canonicalRoot, canonical);
  if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) throw new Error('Path escapes repository');
  const handle = await open(filename, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Not a regular file');
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
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || canonical !== await realpath(filename)) throw new Error('File changed during capture');
    return decode(buffer.subarray(0, length));
  } finally { await handle.close(); }
}
