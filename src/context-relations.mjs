import { inferCppRelations } from './cpp-relations.mjs';
import { inferImportRelations } from './import-relations.mjs';

// Context entries are already sent with every primary. These annotations add
// explanations only, never reads, group members, or reviewed coverage.
export function inferContextRelations(input, file) {
  if (input.history) {
    const relations=[];
    for (const side of ['old','new']) {
      const contexts=(input.context ?? []).filter(c=>side==='new'||typeof c.oldText==='string').map(c=>({...c,text:side==='old'?c.oldText:c.text}));
      const text=side==='old'?file.left.text:file.right.text;
      // Infer each version independently: never bind an old import to target definitions.
      const one={...file,left:{...file.left,text:''},right:{...file.right,text}};
      const version=side==='old'?input.history.base:input.history.target;
      const scoped={...input,history:undefined,context:contexts};
      relations.push(...inferContextRelations(scoped,one).filter(e=>e.side!=='old').map(e=>({...e,side:e.fromPath===file.path?side:side==='old'?'context-old':'context',contextVersion:version,contextSide:side})));
    }
    return relations.slice(0,2000);
  }
  const paths = new Set(input.files.map(f => f.path));
  const contexts = (input.context ?? []).filter(c => !paths.has(c.path));
  const primary = { ...file, id: 'primary' };
  const entries = contexts.map((c, i) => ({ id: 'context-' + i, path: c.path, eligibility: 'reviewable', left: { text: '' }, right: { text: c.text } }));
  // Other selected paths participate as opaque competitors, not context.
  const competitors = input.files.filter(f => f.id !== file.id).map((f, i) => ({ id: 'selected-' + i, path: f.path, eligibility: 'blocked' }));
  const all = [primary, ...entries, ...competitors];
  if (all.length > 200) return [];
  const byId = new Map(all.map(f => [f.id, f.path]));
  const imports = inferImportRelations(all).filter(e => e.specifier && (e.from === 'primary' || e.to === 'primary')).map(e => ({ fromPath: byId.get(e.from), toPath: byId.get(e.to), side: e.from === 'primary' ? e.side : 'context', line: e.line, specifier: e.specifier, callSites: e.callSites, bindingHints: e.bindingHints, reason: 'relative-import:approved-context' }));
  const cpp = inferCppRelations(all).filter(e => e.from === 'primary' || e.to === 'primary').map(e => ({ fromPath: byId.get(e.from), toPath: byId.get(e.to), side: e.from === 'primary' ? e.side : 'context', line: e.line, specifier: e.specifier, reason: e.reason, contextVersion: 'approved-current-not-historical' }));
  return [...imports, ...cpp].slice(0, 2000);
}
