import { createHash } from 'node:crypto';
import { planIncrementalReview } from './finding-ledger.mjs';

const fail = message => { throw new Error('Incremental review: ' + message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function exact(value, keys) {
  if (!object(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('unknown metadata field');
}
function canonical(value) {
  if (value === undefined) return null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) fail('non-JSON snapshot metadata');
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

// Includes BOTH approved source sides, existence, properties, mappings and source
// provenance. A right-text hash alone would silently miss changed old-side diffs.
export function incrementalFileHash(file) {
  if (!object(file)) fail('invalid snapshot file');
  return digest(Object.fromEntries(Object.entries(file).filter(([key]) => !['id', 'eligibility', 'reason'].includes(key))));
}

// A changed approved context/rule/requirement invalidates automatic safe narrowing.
// Explicit user-selected partial re-review is not a complete dependency check. This is a local policy binding, never defect evidence.
export function incrementalContextHash(snapshot) {
  return digest([snapshot.context ?? [], snapshot.rules ?? [], snapshot.businessRequirement ?? null]);
}

/** Pure primary selection; never creates last-reviewed-right -> current-right diff.
 * previousManifest must be owned host metadata, not model/public request data.
 * Automatic narrowing requires repository-wide complete graph attestation, never inferred
 * from empty dependency lists or partial import/caller navigation. No attestation
 * is available in today's capture path, so automatic production use stays full.
 * An explicit diff-only user scope may omit unchanged primaries, always partial.
 * The caller MUST construct retrieval from retrievalSnapshot (original approved
 * source catalog) and use reviewSnapshot for primary scheduling. Skipped files
 * are unreviewed, not completed; caller MUST enforce plan.requiredReportStatus.
 */
export function buildIncrementalSelection(approvedFreshSnapshot, options) {
  exact(options, ['previousManifest', 'currentManifest', 'dependencyGraph', 'capturePolicyUnchanged', 'explicitDiffOnly']);
  if (options.capturePolicyUnchanged !== undefined && typeof options.capturePolicyUnchanged !== 'boolean') fail('invalid policy binding');
  const snapshot = approvedFreshSnapshot;
  if (!object(snapshot) || typeof snapshot.id !== 'string' || !snapshot.id || !Array.isArray(snapshot.files) || snapshot.files.length > 200 || !Array.isArray(snapshot.context) || snapshot.context.length > 100) fail('invalid approved snapshot');
  const { previousManifest, currentManifest, dependencyGraph } = options;
  // Also validates exact manifest schemas/identities/paths/hash shapes. A graph
  // assertion cannot bypass repository, route, rule or requirement-policy binding.
  const incremental = planIncrementalReview(previousManifest, currentManifest);
  if (currentManifest.snapshotId !== snapshot.id) fail('fresh snapshot identity mismatch');
  const current = new Map(currentManifest.files.map(file => [file.path, file]));
  if (current.size !== snapshot.files.length) fail('manifest inventory mismatch');
  const ids = new Set(), paths = new Set();
  for (const file of snapshot.files) {
    if (!object(file) || typeof file.id !== 'string' || !file.id || ids.has(file.id) || paths.has(file.path) || !['reviewable', 'excluded', 'blocked'].includes(file.eligibility)) fail('invalid snapshot inventory');
    ids.add(file.id); paths.add(file.path);
    if (!current.has(file.path) || current.get(file.path).hash !== incrementalFileHash(file)) fail('manifest source mismatch');
  }
  let graphKnown = false;
  if (dependencyGraph !== undefined) {
    exact(dependencyGraph, ['status', 'repositoryWide', 'previousSnapshotId', 'currentSnapshotId', 'previousContextHash', 'currentContextHash']);
    if (!['complete', 'unknown'].includes(dependencyGraph.status) || typeof dependencyGraph.repositoryWide !== 'boolean') fail('invalid dependency graph metadata');
    if (dependencyGraph.status === 'complete') {
      if (dependencyGraph.previousSnapshotId !== previousManifest.snapshotId || dependencyGraph.currentSnapshotId !== snapshot.id || !hash(dependencyGraph.previousContextHash) || dependencyGraph.currentContextHash !== incrementalContextHash(snapshot)) fail('dependency graph binding mismatch');
      graphKnown = dependencyGraph.repositoryWide === true && dependencyGraph.previousContextHash === dependencyGraph.currentContextHash;
    }
  }
  // Any unknown dependency inventory makes the WHOLE repository graph unknown.
  // A seemingly isolated unchanged file cannot rule out uncaptured reverse users.
  const inventoriesKnown = [previousManifest, currentManifest].every(manifest => manifest.files.every(file => hash(file.hash) && Array.isArray(file.dependencies) && file.dependencies.every(dep => hash(dep.hash) && manifest.files.some(target => target.path === dep.path && target.hash === dep.hash))));
  const safe = options.capturePolicyUnchanged === true && graphKnown && inventoriesKnown ? new Set(incremental.unchangedNavigationPaths) : new Set();
  if (options.explicitDiffOnly !== undefined && typeof options.explicitDiffOnly !== 'boolean') fail('invalid explicit diff-only selection');
  if (options.explicitDiffOnly === true) {
    const old=new Map(previousManifest.files.map(file=>[file.path,file.hash]));
    for(const file of snapshot.files) if(old.get(file.path)===incrementalFileHash(file)) safe.add(file.path);
  }
  const unreviewed = snapshot.files.filter(file => file.eligibility === 'reviewable' && safe.has(file.path));
  const unreviewedPaths = unreviewed.map(file => file.path);
  const skipped = new Set(unreviewedPaths);
  const excludedRecords = unreviewed.map(file => ({ fileId: file.id, path: file.path, status: 'excluded', reason: 'incremental-unchanged-not-reviewed' }));
  const reviewSnapshot = { ...snapshot, files: snapshot.files.map(file => skipped.has(file.path) ? { ...file, eligibility: 'excluded', reason: 'incremental-unchanged-not-reviewed' } : file) };
  const plan = {
    mode: skipped.size ? (options.explicitDiffOnly ? 'explicit-diff-only-subset' : 'incremental-primary-subset') : 'full-fresh-primary',
    primaryPaths: reviewSnapshot.files.filter(file => file.eligibility === 'reviewable').map(file => file.path),
    unreviewedPaths, removedPaths: incremental.removedPaths, excludedRecords,
    requiredReportStatus: skipped.size ? 'partial' : null,
    coverage: false, requiresFreshEvidence: true,
    notice: skipped.size ? 'Unchanged primaries were not reviewed; original approved sources remain retrieval context only. No full coverage, fix verification, new incremental baseline, or prior receipt reuse.' : 'No safe narrowing; fresh primary scope retained. Unknown repository dependencies require full review, not assumed isolation.',
  };
  // Freeze only newly authored metadata. Never freeze caller-owned snapshot/body.
  for (const key of ['primaryPaths', 'unreviewedPaths', 'removedPaths', 'excludedRecords']) Object.freeze(plan[key]);
  for (const row of excludedRecords) Object.freeze(row);
  return Object.freeze({ reviewSnapshot, retrievalSnapshot: snapshot, plan: Object.freeze(plan) });
}
