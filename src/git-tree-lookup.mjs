import { relativePath } from './content.mjs';

const utf8 = new TextDecoder('utf-8', { fatal: true });
const MAX_PATHS = 64;
const MAX_ARG_BYTES = 8 * 1024;

// A directory pathspec can emit descendants when another pathspec descends
// into it, even without -r. Submit only prefix-free batches and require each
// returned record to be an exact requested path, never a directory expansion.
export async function lookupGitTreePaths(oid, map, requested, read, { signal, maxBytes, errorMessage }) {
  let paths = [], argBytes = 0, outputBytes = 0;
  const flush = async () => {
    if (!paths.length) return;
    signal?.throwIfAborted();
    const requestedPaths = new Set(paths);
    const records = utf8.decode(await read(['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', oid, '--', ...paths])).split('\0');
    for (const record of records) {
      if (!record) continue;
      const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(record);
      if (!match || !requestedPaths.has(match[4]) || map.has(match[4])) throw new Error(errorMessage);
      map.set(match[4], { mode: match[1], type: match[2], oid: match[3] });
    }
    paths = [];
    argBytes = outputBytes = 0;
  };
  for (const name of new Set(requested)) {
    if (map.has(name)) continue;
    relativePath(name);
    const bytes = Buffer.byteLength(name);
    const argSize = 2 * bytes + 4; // Reserve space for platform argument quoting.
    const outputSize = bytes + 80; // Maximum raw mode/type/OID/delimiters plus path.
    if (paths.length >= MAX_PATHS || argBytes + argSize > MAX_ARG_BYTES || outputBytes + outputSize > maxBytes ||
        paths.some(other => name.startsWith(other + '/') || other.startsWith(name + '/'))) await flush();
    paths.push(name);
    argBytes += argSize;
    outputBytes += outputSize;
  }
  await flush();
}
