import { realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { checked } from './process.mjs';
import { hash, decode, readLocal, relativePath } from './content.mjs';
import { isSecretPath } from './secret-path.mjs';
import { xml } from './svn.mjs';
import { svnCallerNode } from './svn-caller-node.mjs';

const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const text = b => new TextDecoder('utf-8', { fatal: true }).decode(b);

const INVENTORY_NOTICE = 'Tracked current working files only, including unchanged files. Not a historical diff, not untracked or ignored files, not external/submodule contents. Sparse SVN inventory is observed local scope only.';

async function inventoryGit(root, options) {
  const args = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];
  const actual = text(await checked('git', [...args, 'rev-parse', '--show-toplevel'], { ...options, cwd: root })).replace(/\r?\n$/, '');
  if (await realpath(actual) !== root) throw new Error('Full project requires explicit repository root');
  const index = await checked('git', [...args, 'ls-files', '--stage', '-z'], { ...options, cwd: root, maxBytes: 2 * 1024 * 1024 });
  const records = [];
  for (const row of text(index).split(String.fromCharCode(0)).filter(Boolean)) {
    const m = /^(\d{6}) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(row);
    if (!m) throw new Error('Invalid full-project Git index');
    records.push({ path: relativePath(m[4]), kind: m[1], stage: m[3], indexOid: m[2] });
  }
  return { records, identity: { indexHash: hash(index) } };
}

async function inventorySvn(root, options) {
  const info = xml(await checked('svn', ['--non-interactive', 'info', '--xml', '--', '.@'], { ...options, cwd: root })).info?.entry?.[0];
  if (!info || await realpath(info['wc-info']?.['wcroot-abspath']) !== root) throw new Error('Full project requires SVN working-copy root');
  const status = await checked('svn', ['--non-interactive', 'status', '--xml', '--verbose', '--ignore-externals', '--', '.@'], { ...options, cwd: root, maxBytes: 2 * 1024 * 1024 });
  const records = [];
  for (const e of xml(status).status?.target?.flatMap(t => t.entry ?? []) ?? []) {
    const p = e['@_path'].replaceAll('\\', '/');
    if (p === '.') continue;
    const state = e['wc-status'];
    if (['unversioned', 'ignored'].includes(state?.['@_item'])) continue;
    records.push({ path: relativePath(p), state });
  }
  const identity = {
    repositoryUuid: info.repository?.uuid,
    url: info.url,
    statusHash: hash(JSON.stringify(records.map(r => ({ path: r.path, state: Object.fromEntries(Object.entries(r.state ?? {}).sort()) })).sort((a, b) => a.path.localeCompare(b.path)))),
    depth: info['wc-info']?.depth ?? null,
  };
  return { records, identity };
}

export async function projectInventory(cwd, vcs, options = {}) {
  const root = await realpath(cwd);
  const source = vcs === 'git' ? await inventoryGit(root, options)
    : vcs === 'svn' ? await inventorySvn(root, options)
    : null;
  if (!source) throw new Error('Unsupported project VCS');
  let records = source.records;
  if (records.length > 10000) throw new Error('Full-project inventory exceeds 10000 tracked nodes; select a smaller explicit scope');
  records.sort((a, b) => a.path.localeCompare(b.path));
  const grouped = new Map();
  for (const r of records) { if (grouped.has(r.path)) { grouped.get(r.path).duplicate = true; } else grouped.set(r.path, r); }
  records = [...grouped.values()];
  const inventory = { root, vcs, records, identity: source.identity, notice: INVENTORY_NOTICE };
  return { ...inventory, id: hash(JSON.stringify(canonical(inventory))) };
}

async function bindProjectSource(inventory, record, name, file, options) {
  if (inventory.vcs === 'git') {
    if (record.stage !== '0' || !['100644', '100755'].includes(record.kind) || record.duplicate) throw new Error('Conflicted, linked or submodule Git source excluded');
    file.projectSource = { ...record };
    return;
  }
  const state = record.state;
  if (!['normal', 'modified', 'added'].includes(state?.['@_item']) || !['none', 'normal', 'modified'].includes(state['@_props']) || ['@_switched', '@_file-external', '@_tree-conflicted', '@_copied'].some(k => state[k] === 'true')) throw new Error('Unsafe full SVN project source state');
  const node = await svnCallerNode(inventory.root, name, { ...options, allowProjectCurrent: true });
  file.projectSource = { revision: node.revision, nodeFingerprint: node.fingerprint, repositoryUuid: inventory.identity.repositoryUuid };
}

export async function captureProjectBatch(inventory, paths, options = {}) {
  if (!Array.isArray(paths) || paths.length > 200 || new Set(paths).size !== paths.length) throw new Error('Invalid project batch');
  const files = [];
  let bytes = 0;
  for (const name of paths) {
    const record = inventory.records.find(r => r.path === name);
    if (!record) throw new Error('Project file outside inventory');
    const file = { id: hash(name), path: name, kind: 'file', rawStatus: 'project-current', rightExists: true, eligibility: 'reviewable', properties: [], reviewMode: 'project', contentNotice: 'Full current-file review. Empty left side is a transport sentinel, NOT an actual empty baseline or a newly added file; review existing defects in current source, do not infer introduced regression.' };
    files.push(file);
    if (isSecretPath(name)) { file.eligibility = 'excluded'; file.reason = 'Credential path excluded'; continue; }
    try {
      const stat = await lstat(path.join(inventory.root, name));
      if (stat.isDirectory()) { file.eligibility = 'excluded'; file.reason = 'Directory metadata is inventory only'; continue; }
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Linked or nonregular project source excluded');
      await bindProjectSource(inventory, record, name, file, options);
      file.left = decode(Buffer.alloc(0));
      file.right = await readLocal(inventory.root, name, options);
      bytes += file.right.bytes;
      if (bytes > 4 * 1024 * 1024) throw new Error('Project batch exceeds shared 4MiB source limit');
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error.code === 'PROJECT_CAPTURE_BUDGET' || /exceeds shared/.test(error.message)) throw error;
      file.eligibility = 'blocked'; file.reason = error.message;
      delete file.left; delete file.right;
    }
  }
  const scope = { mode: 'project', inventoryId: inventory.id, totalTrackedNodes: inventory.records.length, batchPaths: paths, untrackedIncluded: false, inventoryComplete: inventory.vcs === 'git', scopeCompleteness: inventory.vcs === 'svn' ? 'observed-working-copy-only' : 'tracked-index-only', notice: inventory.notice };
  const snapshot = { schemaVersion: 1, vcs: inventory.vcs, root: inventory.root, files, context: [], projectScope: scope };
  return { ...snapshot, id: hash(JSON.stringify(snapshot)) };
}
