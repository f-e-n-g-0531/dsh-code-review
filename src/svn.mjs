import { isSecretPath } from './secret-path.mjs';
import { realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { checked } from './process.mjs';
import { hash, decode, readLocal, relativePath } from './content.mjs';
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, trimValues: false, isArray: name => ['entry', 'target', 'property'].includes(name) });
export function xml(bytes) {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(source) || XMLValidator.validate(source) !== true) throw new Error('Unsafe or invalid SVN XML');
  return parser.parse(source);
}
const svn = (cwd, args, options) => checked('svn', ['--non-interactive', ...args], { ...options, cwd });
const target = name => name + '@';
async function properties(root, name, baseline, options) {
  const data = xml(await svn(root, ['proplist', '--xml', '--verbose', ...(baseline ? ['-r', 'BASE'] : []), '--', target(name)], options));
  const result = Object.create(null);
  for (const prop of data.properties?.target?.[0]?.property ?? []) {
    if (prop['@_encoding']) throw new Error('Encoded property is not supported');
    result[prop['@_name']] = prop['#text'] ?? '';
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
export async function captureSvn(cwd, options = {}) {
  const { signal, selectedPaths, maxFiles = 200, maxFileBytes = 256 * 1024 } = options;
  if (selectedPaths) for (const name of selectedPaths) if (name !== '.') relativePath(name);
  const info = xml(await svn(cwd, ['info', '--xml', '--', '.@'], options)).info.entry[0];
  const root = await realpath(info['wc-info']['wcroot-abspath']);
  const statusArgs = ['status', '--xml', '--ignore-externals', '--', '.@'];
  const before = await svn(root, statusArgs, options);
  const entries = xml(before).status.target.flatMap(t => t.entry ?? []);
  if (entries.length > maxFiles) throw new Error('Change count limit exceeded');
  const known = new Set(entries.map(e => e['@_path'].replaceAll('\\', '/')));
  if (selectedPaths?.some(p => !known.has(p))) throw new Error('Selected path is not a current change');
  const files = [];
  for (const entry of entries) {
    signal?.throwIfAborted();
    const name = entry['@_path'].replaceAll('\\', '/');
    const state = entry['wc-status'], status = state['@_item'];
    const item = { id: hash(name), path: name, rawStatus: status, baseRevision: state['@_revision'], eligibility: 'reviewable', properties: [] };
    files.push(item);
    if (isSecretPath(name)) { item.eligibility='excluded'; item.reason='Credential path excluded'; continue; }
    if ((selectedPaths && !selectedPaths.includes(name)) || (status === 'unversioned' && !selectedPaths?.includes(name))) {
      item.eligibility = 'excluded'; item.reason = 'Not explicitly selected'; continue;
    }
    try {
      if (name !== '.') relativePath(name);
      if (!['modified', 'added', 'deleted', 'normal', 'unversioned'].includes(status) || state['@_props'] === 'conflicted' || state['@_tree-conflicted'] === 'true') throw new Error('Unsupported or conflicted SVN state: ' + status);
      if (state['@_copied'] === 'true' || state['@_switched'] === 'true' || state['@_file-external'] === 'true') throw new Error('Copy, switched or external node requires explicit historical support');
      const hasBase = !['added', 'unversioned'].includes(status);
      let kind;
      if (status === 'unversioned') kind = (await lstat(path.join(root, name))).isDirectory() ? 'dir' : 'file';
      else {
        const node = xml(await svn(root, ['info', '--xml', '--', target(name)], options)).info.entry[0];
        kind = node['@_kind'];
        if (node['wc-info']?.['copy-from-url']) throw new Error('Copied node baseline is not supported');
      }
      item.kind = kind;
      item.rightExists = status !== 'deleted';
      const leftProps = hasBase ? await properties(root, name, true, options) : {};
      const rightProps = status === 'deleted' || status === 'unversioned' ? {} : await properties(root, name, false, options);
      if ('svn:special' in leftProps || 'svn:special' in rightProps) throw new Error('SVN special nodes are excluded');
      if (leftProps['svn:keywords'] || rightProps['svn:keywords']) throw new Error('SVN keyword expansion requires a verified text mapping; currently blocked');
      item.textNotice = 'Text preserves SVN cat output and working bytes. CRLF/LF differences alone are not code defects.';
      for (const key of [...new Set([...Object.keys(leftProps), ...Object.keys(rightProps)])].sort()) {
        if (leftProps[key] !== rightProps[key]) item.properties.push({ name: key, old: leftProps[key] ?? null, new: rightProps[key] ?? null });
      }
      item.propertyIdentity = hash(JSON.stringify([leftProps, rightProps]));
      if (kind === 'dir') {
        if (status === 'unversioned' || status === 'deleted' || status === 'added') throw new Error('Directory structural changes require descendant coverage');
        item.left = decode(Buffer.alloc(0)); item.right = decode(Buffer.alloc(0));
      } else {
        item.left = decode(hasBase ? await svn(root, ['cat', '-r', 'BASE', '--', target(name)], { ...options, maxBytes: maxFileBytes }) : Buffer.alloc(0));
        item.right = status === 'deleted' ? decode(Buffer.alloc(0)) : await readLocal(root, name, options);
      }
    } catch (error) {
      signal?.throwIfAborted(); item.eligibility = 'blocked'; item.reason = error.message;
      delete item.left; delete item.right;
    }
  }
  const after = await svn(root, statusArgs, options);
  if (!isDeepStrictEqual(xml(after), xml(before))) throw new Error('Working copy changed during capture');
  for (const item of files.filter(f => f.eligibility === 'reviewable')) {
    if (item.kind === 'file' && item.rawStatus !== 'deleted' && (await readLocal(root, item.path, options)).hash !== item.right.hash) throw new Error('Content changed during capture');
    const left = !['added', 'unversioned'].includes(item.rawStatus) ? await properties(root, item.path, true, options) : {};
    const right = ['deleted', 'unversioned'].includes(item.rawStatus) ? {} : await properties(root, item.path, false, options);
    if (hash(JSON.stringify([left, right])) !== item.propertyIdentity) throw new Error('Properties changed during capture');
  }
  const snapshot = { schemaVersion: 1, vcs: 'svn', root, repositoryUuid: info.repository.uuid, files };
  return { ...snapshot, id: hash(JSON.stringify(snapshot)) };
}
