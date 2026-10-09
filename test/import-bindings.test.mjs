import { reviewSnapshot } from '../src/review.mjs';
import { inferImportRelations } from '../src/import-relations.mjs';
import { inferContextRelations } from '../src/context-relations.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { directImportBindings as bind } from '../src/import-bindings.mjs';
import { importedCallSites } from '../src/import-call-sites.mjs';
const target = 'export function run(value) {}';
const lines = ["import { run as execute } from './target.js';", 'execute(1);'];
const resolve = (source, text = target) => bind(source, 1, importedCallSites(source, 1), text);
test('named alias links original import call and direct exported declaration', () => {
 assert.deepEqual(resolve(lines), [{ imported: 'run', local: 'execute', importLine: 1, callLine: 2, declarationLine: 1, confidence: 'conservative-syntax-only' }]);
});
test('binding hints reach approved selected and explicit context relations only', () => {
 const file = { id: 'a', path: 'a.js', eligibility: 'reviewable', left: { text: '' }, right: { text: lines.join(String.fromCharCode(10)) } };
 const dep = { id: 'b', path: 'target.js', eligibility: 'reviewable', left: { text: '' }, right: { text: target } };
 const edge = inferImportRelations([file, dep]).find(e => e.specifier);
 assert.equal(edge.bindingHints[0].declarationLine, 1);
 const context = inferContextRelations({ files: [file], context: [{ path: 'target.js', text: target }] }, file);
 assert.equal(context[0].bindingHints[0].local, 'execute');
 assert.deepEqual(inferImportRelations([file, { ...dep, eligibility: 'excluded' }]), []);
});
test('actual primary inputs preserve binding locations and target mutation rejects', async () => {
 const file = { id: 'a', path: 'a.js', eligibility: 'reviewable', properties: [], left: { text: '' }, right: { text: lines.join(String.fromCharCode(10)) } };
 const dep = { id: 'b', path: 'target.js', eligibility: 'reviewable', properties: [], left: { text: '' }, right: { text: target } };
 let seen = 0;
 const report = await reviewSnapshot({ id: 's', vcs: 'git', context: [], files: [file, dep] }, async r => {
  const p = JSON.parse(r.input); assert.equal(p.bindingRelations[0].bindingHints[0].callLine, 2);
  assert.equal(p.bindingRelations[0].bindingHints[0].declarationLine, 1); seen++;
  return { findings: [], limitations: [] };
 }, { enableGrouping: true });
 assert.equal(seen, 2); assert.equal(report.status, 'completed');
 assert.deepEqual(resolve(lines, target + String.fromCharCode(10) + 'run = other;'), []);
 assert.deepEqual(resolve(lines, target + String.fromCharCode(10) + 'const run = replacement;'), []);
});
test('same-line alias mutation escape and nested alias calls do not assert binding', () => {
 for (const call of ['execute(execute = other);','execute(execute);','execute(execute());','execute({ execute });','execute(() => execute);']) {
  assert.equal(importedCallSites([lines[0],call],1).length,1);
  assert.deepEqual(resolve([lines[0],call]), []);
 }
 assert.equal(resolve([lines[0],'execute(next);']).length,1);
});
test('shadowing assignment escapes ambiguous exports and reexports fail closed', () => {
 for (const extra of ['function outer(execute) {', 'const execute = local;', 'execute = local;', 'consume(execute);']) assert.deepEqual(resolve([...lines, extra]), []);
 for (const text of [target + String.fromCharCode(10) + target, "export { run } from './other.js';", '/* comment */' + target]) assert.deepEqual(resolve(lines, text), []);
});
