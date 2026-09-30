// Pure scheduling: edges are hints, never authorization or proof of a dependency.
export function buildReviewGroups(files, edges, { maxFiles = 4 } = {}) {
  if (!Array.isArray(files) || files.length > 200 || !Array.isArray(edges) || edges.length > 2000 || !Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 20) throw new Error('Invalid grouping budget');
  const byId = new Map();
  for (const file of files) {
    if (!file || typeof file.id !== 'string' || !file.id || byId.has(file.id) || !['reviewable', 'blocked', 'excluded'].includes(file.eligibility)) throw new Error('Invalid grouping file');
    byId.set(file.id, file);
  }
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const adjacency = new Map([...byId].filter(([, f]) => f.eligibility === 'reviewable').map(([id]) => [id, new Set()]));
  const reasons = new Map();
  for (const edge of edges) {
    if (!edge || !byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to || typeof edge.reason !== 'string' || !edge.reason || edge.reason.length > 200) throw new Error('Invalid grouping edge');
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    const pair = [edge.from, edge.to].sort(compare), key = JSON.stringify(pair);
    if (!reasons.has(key)) reasons.set(key, { from: pair[0], to: pair[1], reasons: new Set() });
    reasons.get(key).reasons.add(edge.reason);
    adjacency.get(edge.from).add(edge.to); adjacency.get(edge.to).add(edge.from);
  }
  const remaining = new Set([...adjacency.keys()].sort(compare)), groups = [];
  while (remaining.size) {
    const queue = [remaining.values().next().value], members = [];
    while (queue.length && members.length < maxFiles) {
      const id = queue.shift();
      if (!remaining.delete(id)) continue;
      members.push(id);
      for (const next of [...adjacency.get(id)].sort(compare)) if (remaining.has(next) && !queue.includes(next)) queue.push(next);
    }
    groups.push({ id: 'g' + (groups.length + 1), fileIds: members });
  }
  const membership = new Map(groups.flatMap(g => g.fileIds.map(id => [id, g.id])));
  const links = [...reasons.values()].sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to)).map(e => ({ from: e.from, to: e.to, reasons: [...e.reasons].sort(compare), split: membership.get(e.from) !== membership.get(e.to) }));
  return { groups, links };
}
