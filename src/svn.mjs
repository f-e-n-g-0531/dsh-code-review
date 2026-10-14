import { isSecretPath } from './secret-path.mjs';
import { svnStateIssue } from './svn-state.mjs';
import { snapshotMergeSources } from './svn-mergeinfo.mjs';
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
// Default status hides deleted and copied directory descendants. Expand only
// explicit structural roots under the shared metadata and change-count caps.
async function structuralEntries(root, entries, options, limit) {
  const byPath = new Map(entries.map(entry => [entry['@_path'].replaceAll('\\', '/'), entry]));
  const roots = entries.filter(entry => entry['wc-status']?.['@_item'] === 'deleted' || (entry['wc-status']?.['@_item'] === 'added' && entry['wc-status']?.['@_copied'] === 'true')).map(entry => entry['@_path'].replaceAll('\\', '/')).sort();
  const visited = [];
  let bytes = 0;
  for (const name of roots) {
    relativePath(name);
    if (visited.some(parent => name.startsWith(parent + '/'))) continue;
    visited.push(name);
    const data = await svn(root, ['status', '--xml', '--verbose', '--ignore-externals', '--depth', 'infinity', '--', target(name)], { ...options, maxBytes: Math.min(options.maxBytes ?? 1024 * 1024, 1024 * 1024) });
    bytes += data.length;
    if (bytes > 1024 * 1024) throw new Error('SVN deleted descendant metadata limit exceeded');
    for (const entry of xml(data).status?.target?.flatMap(t => t.entry ?? []) ?? []) {
      const child = entry['@_path'].replaceAll('\\', '/');
      relativePath(child);
      if (child !== name && !child.startsWith(name + '/')) throw new Error('SVN deleted descendant escaped scope');
      const parentState = byPath.get(name)['wc-status'];
      if (parentState['@_item'] === 'deleted' && entry['wc-status']?.['@_item'] !== 'deleted') throw new Error('Unexpected SVN deleted descendant state');
      const item = structuredClone(entry);
      if (parentState['@_item'] === 'added' && child !== name && item['wc-status']?.['@_copied'] === 'true') item.copyRoot = name;
      if (!byPath.has(child) || item.copyRoot) byPath.set(child, item);
      if (byPath.size > limit) throw new Error('Change count limit exceeded');
    }
  }
  return [...byPath.values()].sort((a,b) => a['@_path'] < b['@_path'] ? -1 : a['@_path'] > b['@_path'] ? 1 : 0);
}
export async function captureSvn(cwd, options = {}) {
  const { signal, selectedPaths, maxFiles = 200, maxFileBytes = 256 * 1024 } = options;
  if (selectedPaths) for (const name of selectedPaths) if (name !== '.') relativePath(name);
  const info = xml(await svn(cwd, ['info', '--xml', '--', '.@'], options)).info.entry[0];
  const root = await realpath(info['wc-info']['wcroot-abspath']);
  const statusArgs = ['status', '--xml', '--ignore-externals', '--', '.@'];
  const before = await svn(root, statusArgs, options);
  const originalEntries = xml(before).status.target.flatMap(t => t.entry ?? []);
  if (originalEntries.length > maxFiles) throw new Error('Change count limit exceeded');
  const entries = await structuralEntries(root, originalEntries, options, maxFiles);
  const known = new Set(entries.map(e => e['@_path'].replaceAll('\\', '/')));
  if (selectedPaths?.some(p => !known.has(p))) throw new Error('Selected path is not a current change');
  const files = [];
  for (const entry of entries) {
    signal?.throwIfAborted();
    const name = entry['@_path'].replaceAll('\\', '/');
    const state = entry['wc-status'], status = state['@_item'];
    const item = { id: hash(name), path: name, ...(name === '.' ? {kind: 'dir'} : {}), rawStatus: status, baseRevision: state['@_revision'], eligibility: 'reviewable', properties: [] };
    files.push(item);
    if (isSecretPath(name)) { item.eligibility='excluded'; item.reason='Credential path excluded'; continue; }
    if ((selectedPaths && !selectedPaths.includes(name)) || (status === 'unversioned' && !selectedPaths?.includes(name))) {
      item.eligibility = 'excluded'; item.reason = 'Not explicitly selected'; continue;
    }
    try {
      if (name !== '.') relativePath(name);
      const copiedDescendant = !!entry.copyRoot && ['normal', 'modified', 'added'].includes(status) && state['@_copied'] === 'true';
      const issue = svnStateIssue(copiedDescendant ? {...state, '@_item':'added'} : state);
      if (issue) { item.blockCode = issue.code; throw new Error(issue.reason); }
      const hasBase = !copiedDescendant && !['added', 'unversioned'].includes(status);
      let kind;
      if (status === 'unversioned') kind = (await lstat(path.join(root, name))).isDirectory() ? 'dir' : 'file';
      else {
        const node = xml(await svn(root, ['info', '--xml', '--', target(name)], options)).info.entry[0];
        kind = node['@_kind'];
        if (state['@_copied'] === 'true' || node['wc-info']?.['copy-from-url']) {
          let source = node['wc-info']?.['copy-from-url'], revision = node['wc-info']?.['copy-from-rev'];
          if (!source && copiedDescendant) {
            const parent = files.find(file => file.path === entry.copyRoot);
            if (!parent?.copySource || parent.eligibility !== 'reviewable') throw new Error('Copied ancestor identity unavailable');
            source = parent.copySource.url.replace(/\/$/,'') + '/' + name.slice(entry.copyRoot.length+1).split('/').map(encodeURIComponent).join('/');
            revision = parent.copySource.revision;
            item.copyAncestor = entry.copyRoot;
          }
          if ((!copiedDescendant && status !== 'added') || !['file','dir'].includes(kind) || typeof source !== 'string' || !source || !/^[0-9]+$/.test(String(revision)) || node.repository?.uuid !== info.repository.uuid || node.repository?.root !== info.repository.root) throw new Error('Copied node requires a same-repository added target with fixed copy source');
          if (isSecretPath(decodeURIComponent(new URL(source).pathname))) throw new Error('Credential copy source excluded');
          item.copySource = { url: source, revision: String(revision), repositoryUuid: node.repository.uuid };
          item.copyNotice = 'Target addition is reviewed against an empty target baseline; copy source is provenance only, not an approved source body or verified rename.';
          item.copyNodeIdentity = hash(JSON.stringify([node.url, node['@_kind'], node['@_revision'], node['wc-info']?.schedule, node['wc-info']?.['wcroot-abspath'], node['wc-info']?.['copy-from-url'] ?? null, node['wc-info']?.['copy-from-rev'] ?? null, node.repository]));
        }
      }
      item.kind = kind;
      if (copiedDescendant) item.targetAddition = true;
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
        if (status === 'unversioned') throw new Error('Unversioned directory requires explicit descendant tracking');
        if (status === 'deleted' || status === 'added' || copiedDescendant) {
          const descendants = entries.filter(entry => entry['@_path'].replaceAll('\\', '/').startsWith(name + '/')).map(entry => entry['@_path'].replaceAll('\\', '/'));
          if (selectedPaths && descendants.some(child => !selectedPaths.includes(child))) throw new Error('Directory descendants are not all explicitly selected');
          item.structuralDescendants = descendants;
          item.structuralNotice = 'Directory node coverage is separate from each descendant; no implicit descendant approval.';
        }
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
  if (!isDeepStrictEqual(await structuralEntries(root, xml(after).status.target.flatMap(t => t.entry ?? []), options, maxFiles), entries)) throw new Error('Deleted descendants changed during capture');
  // A directory must not look complete when any descendant was blocked/excluded.
  for (const item of files.filter(f => f.structuralDescendants).sort((a,b) => b.path.length - a.path.length)) {
    if (item.structuralDescendants.some(name => files.find(f => f.path === name)?.eligibility !== 'reviewable')) {
      item.eligibility = 'blocked'; item.reason = 'Directory descendant coverage incomplete';
      delete item.left; delete item.right;
    }
  }
  for (const item of files.filter(f => f.eligibility === 'reviewable')) {
    if (item.copySource) {
      const node = xml(await svn(root, ['info', '--xml', '--', target(item.path)], options)).info.entry[0];
      const identity = hash(JSON.stringify([node.url, node['@_kind'], node['@_revision'], node['wc-info']?.schedule, node['wc-info']?.['wcroot-abspath'], node['wc-info']?.['copy-from-url'] ?? null, node['wc-info']?.['copy-from-rev'] ?? null, node.repository]));
      if (identity !== item.copyNodeIdentity) throw new Error('Copy source identity changed during capture');
    }
    if (item.kind === 'file' && item.rawStatus !== 'deleted' && (await readLocal(root, item.path, options)).hash !== item.right.hash) throw new Error('Content changed during capture');
    const left = !item.targetAddition && !['added', 'unversioned'].includes(item.rawStatus) ? await properties(root, item.path, true, options) : {};
    const right = ['deleted', 'unversioned'].includes(item.rawStatus) ? {} : await properties(root, item.path, false, options);
    if (hash(JSON.stringify([left, right])) !== item.propertyIdentity) throw new Error('Properties changed during capture');
  }
  const mergeSources = snapshotMergeSources(files);
  const snapshot = { schemaVersion: 1, vcs: 'svn', root, repositoryUuid: info.repository.uuid, ...(mergeSources.length ? {mergeSources} : {}), files };
  return { ...snapshot, id: hash(JSON.stringify(snapshot)) };
}
