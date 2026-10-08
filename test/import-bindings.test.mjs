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
test('shadowing assignment escapes ambiguous exports and reexports fail closed', () => {
 for (const extra of ['function outer(execute) {', 'const execute = local;', 'execute = local;', 'consume(execute);']) assert.deepEqual(resolve([...lines, extra]), []);
 for (const text of [target + String.fromCharCode(10) + target, "export { run } from './other.js';", '/* comment */' + target]) assert.deepEqual(resolve(lines, text), []);
});
