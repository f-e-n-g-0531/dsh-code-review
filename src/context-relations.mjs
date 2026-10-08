import { inferImportRelations } from './import-relations.mjs';

// Context entries are already sent with every primary. These annotations add
// explanations only, never reads, group members, or reviewed coverage.
export function inferContextRelations(input, file) {
  const paths = new Set(input.files.map(f => f.path));
  const contexts = (input.context ?? []).filter(c => !paths.has(c.path));
  const primary = { ...file, id: 'primary' };
  const entries = contexts.map((c, i) => ({ id: 'context-' + i, path: c.path, eligibility: 'reviewable', left: { text: '' }, right: { text: c.text } }));
  // Other selected paths participate as opaque competitors, not context.
  const competitors = input.files.filter(f => f.id !== file.id).map((f, i) => ({ id: 'selected-' + i, path: f.path, eligibility: 'blocked' }));
  const all = [primary, ...entries, ...competitors];
  if (all.length > 200) return [];
  const byId = new Map(all.map(f => [f.id, f.path]));
  return inferImportRelations(all).filter(e => e.specifier && (e.from === 'primary' || e.to === 'primary')).map(e => ({ fromPath: byId.get(e.from), toPath: byId.get(e.to), side: e.from === 'primary' ? e.side : 'context', line: e.line, specifier: e.specifier, callSites: e.callSites, reason: 'relative-import:approved-context' }));
}
