import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, lstat, realpath, rename, unlink, chmod } from 'node:fs/promises';
import path from 'node:path';

const queues = new Map();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const STATUSES = new Set(['completed', 'failed', 'cancelled', 'incomplete', 'validated-draft', 'rejected']);
const fail = code => Object.assign(new Error(code), { code });
const within = (base, name) => { const r = path.relative(base, name); return r === '' || (!path.isAbsolute(r) && r !== '..' && !r.startsWith('..' + path.sep)); };
function ownerIdentity(owner) {
  if (!owner || !['sessionId', 'cwd', 'provider', 'model'].every(key => typeof owner[key] === 'string' && owner[key].length > 0 && owner[key].length <= 4096) || !path.isAbsolute(owner.cwd) || !(owner.reasoningEffort == null || typeof owner.reasoningEffort === 'string' && owner.reasoningEffort.length <= 256)) throw fail('INVALID_REVIEW_ARTIFACT_OWNER');
  return { sessionId: owner.sessionId, cwd: owner.cwd, provider: owner.provider, model: owner.model, reasoningEffort: owner.reasoningEffort ?? null };
}
function snapshot(value, depth = 0) {
  if (depth > 64) throw fail('INVALID_REVIEW_ARTIFACT');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) throw fail('INVALID_REVIEW_ARTIFACT');
  const result = Array.isArray(value) ? [] : Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!descriptor.enumerable) continue;
    if (!('value' in descriptor) || descriptor.value === undefined) throw fail('INVALID_REVIEW_ARTIFACT');
    Object.defineProperty(result, key, { value: snapshot(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true });
  }
  return result;
}
async function projectedRealpath(name) {
  let current = path.resolve(name); const suffix = [];
  for (;;) {
    try { return path.join(await realpath(current), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { if ((await lstat(current)).isSymbolicLink()) throw fail('UNSAFE_REVIEW_ARTIFACT'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const parent = path.dirname(current); if (parent === current) throw error;
      suffix.unshift(path.basename(current)); current = parent;
    }
  }
}

// Artifacts are untrusted private evidence, never approved source or confirmed findings.
export function createReviewArtifacts({ directory, maxArtifactBytes = 1048576, maxJobBytes = 8388608, maxArtifacts = 64 } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw fail('INVALID_REVIEW_ARTIFACT_DIRECTORY');
  if (![maxArtifactBytes, maxJobBytes, maxArtifacts].every(n => Number.isSafeInteger(n) && n > 0) || maxArtifactBytes > 16777216 || maxJobBytes > 268435456 || maxArtifacts > 10000) throw fail('INVALID_REVIEW_ARTIFACT_LIMIT');
  let canonical;
  async function safeDirectory(owner) {
    const [workspace, resolved] = await Promise.all([projectedRealpath(owner.cwd), projectedRealpath(directory)]);
    if (within(workspace, resolved) || canonical !== undefined && canonical !== resolved) throw fail('UNSAFE_REVIEW_ARTIFACT');
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== resolved) throw fail('UNSAFE_REVIEW_ARTIFACT');
    await chmod(resolved, 0o700); canonical ??= resolved;
    return resolved;
  }
  async function load(filename, jobId, owner) {
    let handle;
    try {
      const stat = await lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxJobBytes + maxArtifacts * 1024 + 65536) throw fail('UNSAFE_REVIEW_ARTIFACT');
      handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const actual = await handle.stat();
      if (!actual.isFile() || stat.ino !== actual.ino || stat.dev !== actual.dev) throw fail('UNSAFE_REVIEW_ARTIFACT');
      const record = JSON.parse(await handle.readFile('utf8'));
      if (record.jobId !== jobId || JSON.stringify(record.owner) !== JSON.stringify(owner)) throw fail('FOREIGN_REVIEW_ARTIFACT');
      if (!Array.isArray(record.artifacts) || record.artifacts.length > maxArtifacts || !Number.isSafeInteger(record.retainedBytes) || record.retainedBytes < 0 || record.retainedBytes > maxJobBytes) throw fail('UNSAFE_REVIEW_ARTIFACT');
      return record;
    } catch (error) { if (error.code === 'ENOENT') return { jobId, owner, retainedBytes: 0, artifacts: [] }; throw error; }
    finally { await handle?.close(); }
  }
  async function transaction(jobId, owner, work) {
    if (typeof jobId !== 'string' || !UUID.test(jobId)) throw fail('INVALID_REVIEW_ARTIFACT_JOB');
    try {
      const root = await safeDirectory(owner), filename = path.join(root, jobId + '.json');
      const previous = queues.get(filename) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(async () => {
        await safeDirectory(owner);
        const record = await load(filename, jobId, owner);
        return work(record, filename);
      });
      queues.set(filename, next);
      try { return await next; } finally { if (queues.get(filename) === next) queues.delete(filename); }
    } catch (error) {
      if (['INVALID_REVIEW_ARTIFACT_JOB', 'UNSAFE_REVIEW_ARTIFACT', 'FOREIGN_REVIEW_ARTIFACT'].includes(error.code)) throw fail(error.code);
      throw fail('ARTIFACT_STORE_FAILED');
    }
  }
  return {
    async record(jobId, owner, artifact) {
      const who = ownerIdentity(owner), value = snapshot(artifact);
      if (!value || Array.isArray(value) || typeof value !== 'object') throw fail('INVALID_REVIEW_ARTIFACT');
      const serialized = JSON.stringify(value), bytes = Buffer.byteLength(serialized);
      const summary = { artifactId: randomUUID(), hash: createHash('sha256').update(serialized).digest('hex'), bytes, status: STATUSES.has(value.status) ? value.status : 'unclassified', omitted: false, recorded: true };
      return transaction(jobId, who, async (record, filename) => {
        if (bytes > maxArtifactBytes || record.retainedBytes + bytes > maxJobBytes || record.artifacts.length >= maxArtifacts) {
          summary.omitted = true; summary.diagnostic = 'REVIEW_ARTIFACT_LIMIT_EXCEEDED';
          if (record.artifacts.length >= maxArtifacts) return { ...summary, recorded: false };
        }
        record.artifacts.push({ ...summary, ...(summary.omitted ? {} : { artifact: value }) });
        if (!summary.omitted) record.retainedBytes += bytes;
        const tmp = path.join(canonical, jobId + '.' + randomUUID() + '.tmp'); let handle;
        try {
          handle = await open(tmp, 'wx', 0o600); await handle.writeFile(JSON.stringify(record)); await handle.sync(); await handle.close(); handle = undefined;
          await safeDirectory(who);
          try { const stat = await lstat(filename); if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw fail('UNSAFE_REVIEW_ARTIFACT'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          await rename(tmp, filename);
        } finally { await handle?.close(); await unlink(tmp).catch(() => {}); }
        return { ...summary };
      });
    },
    async read(jobId, owner, { offset = 0, limit = 20 } = {}) {
      const who = ownerIdentity(owner);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('INVALID_REVIEW_ARTIFACT_PAGE');
      return transaction(jobId, who, async record => ({ jobId, totalArtifacts: record.artifacts.length, offset, limit, artifacts: record.artifacts.slice(offset, offset + limit) }));
    },
  };
}
