import {captureSvnDependencyChain} from './svn-dependency-chain.mjs';
import {captureDependencyChain} from './dependency-chain.mjs';
import {captureSvnCallers} from './svn-caller-capture.mjs';
import { captureCallers } from './caller-capture.mjs';
import { validateCallerScopes } from './caller-index.mjs';
import { bindBusinessRequirement, validateBusinessRequirement } from './business-requirement.mjs';
import { gitContextIndex, svnContextIndex } from './tracked-context.mjs';
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
  if (options.oldContextPaths !== undefined && (!Array.isArray(options.oldContextPaths) || options.oldContextPaths.length > 20 || new Set(options.oldContextPaths).size !== options.oldContextPaths.length)) throw new Error('Invalid old context paths');
  for (const name of options.oldContextPaths ?? []) relativePath(name);
  const type = await detectVcs(cwd);
  if (options.oldContextPaths !== undefined && (type !== 'git' || !['commit','baseRevision','targetRevision'].some(k => options[k] !== undefined))) throw new Error('Old context requires Git historical review');
  if (['commit','baseRevision','targetRevision'].some(k => options[k] !== undefined)) {
    if (type !== 'git') throw new Error('Git revision review is unsupported on SVN');
    return bindBusinessRequirement(await captureGitHistory(cwd, options),options.businessRequirement);
  }
  const capture = type === 'git' ? captureGit : captureSvn;
  const snapshot = await capture(cwd, options);
  if (!Array.isArray(rulePaths) || rulePaths.some(name => contextPaths.includes(name))) throw new Error('Rule paths must be separate from context paths');
  const rules = await captureProjectRules(snapshot.root, rulePaths, { signal: options.signal, files: snapshot.files });
  const context = [];
  let autoContext, index, verifyDependencies, explicitSeeds = [], indexOptions = options;
  if (options.autoContext === true && type==='git') {
    const chain=await captureDependencyChain(snapshot.root,snapshot.files,options);
    explicitSeeds=chain.explicitSeeds;context.push(...chain.context);autoContext=chain.autoContext;index=chain.index;indexOptions=chain.indexOptions;
  } else if (options.autoContext === true) {
    const chain=await captureSvnDependencyChain(snapshot.root,snapshot.files,options);
    explicitSeeds=chain.explicitSeeds;context.push(...chain.context);autoContext=chain.autoContext;indexOptions=chain.indexOptions;verifyDependencies=chain.verify;
  }
  for (const name of [...new Set(contextPaths)].sort()) {
    const changed = snapshot.files.find(f => f.path === name);
    if (changed) {
      if (changed.eligibility !== 'reviewable') throw new Error('Context path is an excluded or blocked change');
      if (changed.rightExists === false) throw new Error('Deleted path cannot be working context');
      context.push({ path: name, ...changed.right });
    } else {
      const item={path:name,...await readLocal(snapshot.root,name,indexOptions)};
      const seed=explicitSeeds.find(c=>c.path===name);
      if(seed&&seed.hash!==item.hash)throw new Error('Explicit dependency seed changed during capture');
      context.push(item);
    }
  }
  let callerDiscovery, verifyCallers;
  if (options.callerScopePaths !== undefined) {
    const callers = await (type==='git'?captureCallers:captureSvnCallers)(snapshot.root, snapshot.files, options.callerScopePaths, options);
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
  if ((await capture(cwd, indexOptions)).id !== snapshot.id) throw new Error('Snapshot changed while collecting context');
  for (const item of context) if ((await readLocal(snapshot.root, item.path, indexOptions)).hash !== item.hash) throw new Error('Context changed during capture');
  if (index && (await (type === 'git' ? gitContextIndex : svnContextIndex)(snapshot.root, indexOptions)).fingerprint !== index.fingerprint) throw new Error('Tracked context index changed during capture');
  const verifiedRules = await captureProjectRules(snapshot.root, rulePaths, { signal: options.signal, files: snapshot.files });
  if (JSON.stringify(verifiedRules) !== JSON.stringify(rules)) throw new Error('Rules changed during capture');
  if (verifyDependencies) await verifyDependencies();
  if (verifyCallers) await verifyCallers();
  const result = { ...snapshot, context, ...(callerDiscovery ? {callerDiscovery} : {}), ...(autoContext ? { autoContext } : {}), ...(rules.length ? { rules } : {}) };
  delete result.id;
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized) > maxSnapshotBytes) throw new Error('Snapshot size limit exceeded');
  return bindBusinessRequirement({ ...result, id: hash(serialized) },options.businessRequirement);
}
