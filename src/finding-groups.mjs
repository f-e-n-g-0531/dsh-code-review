// Presentation only. Never removes findings or promotes model causality to fact.
export function groupDuplicateFindings(findings) {
  const buckets = new Map();
  for (let index = 0; index < findings.length; index++) {
    const f = findings[index], a = f.attribution, v = f.verification;
    // Cross-file candidates carry distinct qualified causal references; never collapse them.
    if (f.interaction) continue;
    if (a?.status !== 'references-validated' || v?.status !== 'completed' || v.verdict !== 'supported' || !v.evidence?.length || v.evidence.some(e => e.status !== 'references-validated')) continue;
    // Require the entire exact evidence set, not mere overlap/transitive similarity.
    const evidence = v.evidence.map(e => JSON.stringify([e.snapshotId, e.sourceId, e.hash, e.start, e.count, e.text])).sort();
    const regression = v.regression;
    if (regression && ['uncertain', 'unassessed'].includes(regression.classification)) continue;
    const comparison = regression ? [regression.classification, regression.reason, regression.oldEvidence, regression.newEvidence] : null;
    const key = JSON.stringify([comparison, f.severity, f.title, f.evidence, f.suggestion, f.trigger, f.impact, a.beforeBehavior, a.afterBehavior, a.reason, v.reason, evidence]);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(index);
  }
  return [...buckets.values()].filter(indices => indices.length > 1).map((indices, i) => ({ id: 'd' + (i + 1), findingIndices: indices, reason: 'exact-supported-evidence-and-explanation', causality: 'unverified' }));
}
