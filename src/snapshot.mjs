import { captureCallers } from './caller-capture.mjs';
import { validateCallerScopes } from './caller-index.mjs';
import { bindBusinessRequirement, validateBusinessRequirement } from './business-requirement.mjs';
import { gitContextIndex, svnContextIndex } from './tracked-context.mjs';
import { contextCandidates } from './context-candidates.mjs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { captureGitHistory } from './git-history.mjs';
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
  validateBusinessRequirement(options.businessRequirement);
  const { rulePaths = [], contextPaths = [], maxContextFiles = 20, maxSnapshotBytes = 4 * 1024 * 1024 } = options;
  for (const value of [maxContextFiles, maxSnapshotBytes]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid snapshot limit');
  if (!Array.isArray(contextPaths) || contextPaths.length > maxContextFiles) throw new Error('Context file limit exceeded');
  for (const name of contextPaths) relativePath(name);
  if (options.autoContext !== undefined && typeof options.autoContext !== 'boolean') throw new Error('Invalid autoContext option');
  if (options.callerScopePaths !== undefined) validateCallerScopes(options.callerScopePaths);
  const type = await detectVcs(cwd);
  if (options.callerScopePaths !== undefined && (type !== 'git' || ['commit','baseRevision','targetRevision'].some(k => options[k] !== undefined))) throw new Error('Caller discovery currently requires Git working review');
  if (['commit','baseRevision','targetRevision'].some(k => options[k] !== undefined)) {
    if (type !== 'git') throw new Error('Git revision review is unsupported on SVN');
    return bindBusinessRequirement(await captureGitHistory(cwd, options),options.businessRequirement);
  }
  const capture = type === 'git' ? captureGit : captureSvn;
  const snapshot = await capture(cwd, options);
  if (!Array.isArray(rulePaths) || rulePaths.some(name => contextPaths.includes(name))) throw new Error('Rule paths must be separate from context paths');
  const rules = await captureProjectRules(snapshot.root, rulePaths, { signal: options.signal, files: snapshot.files });
  const context = [];
  let autoContext, index, indexOptions = options;
  if (options.autoContext === true) {
    if(type==='git'){const probes=new Set();contextCandidates(snapshot.files,[],{onProbe:paths=>{for(const p of paths)probes.add(p);if(probes.size>512)throw new Error('Git context lookup limit exceeded');}});indexOptions={...options,probePaths:[...probes]};}
    index = await (type === 'git' ? gitContextIndex : svnContextIndex)(snapshot.root, indexOptions);
    const plan = contextCandidates(snapshot.files, index.paths);
    autoContext = { ...plan, candidates: plan.candidates.filter(c => !contextPaths.includes(c.path) && !rulePaths.includes(c.path)), capturedPaths: [] };
    for (const candidate of autoContext.candidates) {
      if (context.length + new Set(contextPaths).size >= maxContextFiles) { candidate.status = 'blocked'; candidate.reason = 'Context file limit exceeded'; continue; }
      try {
        context.push({ path: candidate.path, ...await readLocal(snapshot.root, candidate.path, options) });
        candidate.status = 'captured'; autoContext.capturedPaths.push(candidate.path);
      } catch (error) { options.signal?.throwIfAborted(); candidate.status = 'blocked'; candidate.reason = error.message; }
    }
  }
  for (const name of [...new Set(contextPaths)].sort()) {
    const changed = snapshot.files.find(f => f.path === name);
    if (changed) {
      if (changed.eligibility !== 'reviewable') throw new Error('Context path is an excluded or blocked change');
      if (changed.rightExists === false) throw new Error('Deleted path cannot be working context');
      context.push({ path: name, ...changed.right });
    } else context.push({ path: name, ...await readLocal(snapshot.root, name, options) });
  }
  let callerDiscovery, verifyCallers;
  if (options.callerScopePaths !== undefined) {
    const callers = await captureCallers(snapshot.root, snapshot.files, options.callerScopePaths, options);
    verifyCallers = callers.verify;
    callerDiscovery = { ...callers.discovery, capturedPaths: [] };
    for (const item of callers.context) {
      const present = context.find(c => c.path === item.path);
      const matches = callerDiscovery.candidates.filter(c => c.fromPath === item.path);
      if (present && present.hash !== item.hash) throw new Error('Caller context changed during capture');
      if (!present && context.length >= Math.min(maxContextFiles,20)) {
        for (const candidate of matches) { candidate.status='blocked'; candidate.captureReason='Context file limit exceeded'; }
        continue;
      }
      if (!present) context.push(item);
      callerDiscovery.capturedPaths.push(item.path);
      for (const candidate of matches) candidate.status='captured';
    }
  }
  // Re-capture verifies both selected sides while collecting explicit context.
  if ((await capture(cwd, options)).id !== snapshot.id) throw new Error('Snapshot changed while collecting context');
  for (const item of context) if ((await readLocal(snapshot.root, item.path, options)).hash !== item.hash) throw new Error('Context changed during capture');
  if (index && (await (type === 'git' ? gitContextIndex : svnContextIndex)(snapshot.root, indexOptions)).fingerprint !== index.fingerprint) throw new Error('Tracked context index changed during capture');
  const verifiedRules = await captureProjectRules(snapshot.root, rulePaths, { signal: options.signal, files: snapshot.files });
  if (JSON.stringify(verifiedRules) !== JSON.stringify(rules)) throw new Error('Rules changed during capture');
  if (verifyCallers) await verifyCallers();
  const result = { ...snapshot, context, ...(callerDiscovery ? {callerDiscovery} : {}), ...(autoContext ? { autoContext } : {}), ...(rules.length ? { rules } : {}) };
  delete result.id;
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized) > maxSnapshotBytes) throw new Error('Snapshot size limit exceeded');
  return bindBusinessRequirement({ ...result, id: hash(serialized) },options.businessRequirement);
}
