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
test('shadowing assignment escapes ambiguous exports and reexports fail closed', () => {
 for (const extra of ['function outer(execute) {', 'const execute = local;', 'execute = local;', 'consume(execute);']) assert.deepEqual(resolve([...lines, extra]), []);
 for (const text of [target + String.fromCharCode(10) + target, "export { run } from './other.js';", '/* comment */' + target]) assert.deepEqual(resolve(lines, text), []);
});
