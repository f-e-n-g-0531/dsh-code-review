import { reviewSnapshot } from '../src/review.mjs';
import { inferImportRelations } from '../src/import-relations.mjs';
import { inferContextRelations } from '../src/context-relations.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { directImportBindings as bind, uniqueApprovedDeclarations, namedImportDefinitions, defaultImportDefinition } from '../src/import-bindings.mjs';
import { importedCallSites } from '../src/import-call-sites.mjs';
const target = 'export function run(value) {}';
const lines = ["import { run as execute } from './target.js';", 'execute(1);'];
const resolve = (source, text = target) => bind(source, 1, importedCallSites(source, 1), text);
test('named alias links original import call and direct exported declaration', () => {
 assert.deepEqual(resolve(lines), [{ imported: 'run', local: 'execute', importLine: 1, callLine: 2, declarationLine: 1, declarationKind: 'function', confidence: 'conservative-syntax-only' }]);
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
test('review input keeps a unique definition without a call and drops an ambiguous one', async () => {
 const file = { id: 'a', path: 'a.js', eligibility: 'reviewable', properties: [], left: { text: '' }, right: { text: "import { limit } from './target.js';" } };
 const dep = { id: 'b', path: 'target.js', eligibility: 'reviewable', properties: [], left: { text: '' }, right: { text: 'export const limit = 2;' } };
 const ambiguous = { ...dep, right: { text: 'export const limit = 2;' + String.fromCharCode(10) + 'limit = 3;' } };
 const grouping = { groups: [{ id: 'g', fileIds: ['a', 'b'] }], links: [] };
 let seen = 0;
 await reviewSnapshot({ id: 's', vcs: 'git', context: [], files: [file, dep] }, async request => {
  const payload = JSON.parse(request.input);
  assert.equal(payload.bindingRelations[0].definitionHints[0].declarationKind, 'const');
  assert.equal(payload.bindingRelations[0].bindingHints.length, 0);
  seen++;
  return { findings: [], limitations: [] };
 }, { enableGrouping: true, grouping });
 await reviewSnapshot({ id: 's', vcs: 'git', context: [], files: [file, ambiguous] }, async request => {
  assert.equal(JSON.parse(request.input).bindingRelations.length, 0);
  seen++;
  return { findings: [], limitations: [] };
 }, { enableGrouping: true, grouping });
 assert.equal(seen, 4);
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
test('unique approved const and class declarations bind while duplicates reexports and other files do not', () => {
 const linesOf = text => text.split(String.fromCharCode(10));
 assert.deepEqual(uniqueApprovedDeclarations(linesOf('export const limit = 2;'), 'limit'), [{ number: 1, kind: 'const' }]);
 assert.deepEqual(uniqueApprovedDeclarations(linesOf('export class Gate {}'), 'Gate'), [{ number: 1, kind: 'class' }]);
 assert.equal(resolve(["import { limit as cap } from './target.js';", 'cap();'], 'export const limit = 2;')[0].declarationKind, 'const');
 for (const text of ['export const limit = 2;' + String.fromCharCode(10) + 'export function limit() {}', "export { limit } from './other.js';", 'export const limit = 2;' + String.fromCharCode(10) + 'limit();']) assert.deepEqual(uniqueApprovedDeclarations(linesOf(text), 'limit'), []);
 assert.deepEqual(uniqueApprovedDeclarations(linesOf('export const other = 1;'), 'limit'), []);
});
test('named definition hints stay on the supplied side and omit ambiguous names', () => {
 const line = "import { limit, missing as other } from './target.js';";
 const hints = namedImportDefinitions(line, 'export const limit = 2;');
 assert.deepEqual(hints, [{ imported: 'limit', declarationLine: 1, declarationKind: 'const', confidence: 'approved-unique-syntax-only' }]);
 assert.deepEqual(namedImportDefinitions(line, '/* export const limit = 2; */'), []);
 assert.deepEqual(namedImportDefinitions(line, 'export const limit = 2;' + String.fromCharCode(10) + 'export class limit {}'), []);
 const file = { id: 'a', path: 'a.js', eligibility: 'reviewable', left: { text: line }, right: { text: '' } };
 const old = { id: 'b', path: 'target.js', eligibility: 'reviewable', left: { text: 'export const limit = 1;' }, right: { text: 'export function limit() {}' } };
 const edge = inferImportRelations([file, old]).find(item => item.side === 'old' && item.specifier);
 assert.equal(edge.definitionHints[0].declarationKind, 'const');
 assert.ok(!JSON.stringify(edge.definitionHints).includes('function'));
});
test('named declaration navigation refuses default exports same-line competitors and continued strings', () => {
 const imp = 'import { Gate } from "./target.js";';
 for (const text of ['export default class Gate {}','export class Gate extends Gate {}','export class Gate {} export class Gate {}','"text' + String.fromCharCode(92,10) + 'export class Gate {}' + String.fromCharCode(92,10) + '";']) {
  assert.deepEqual(namedImportDefinitions(imp,text),[]);
 }
 assert.deepEqual(namedImportDefinitions('import { run } from "./target.js";', 'export function run(run) {}'),[]);
 assert.deepEqual(uniqueApprovedDeclarations(['/*','export class Gate {}','*/'],'Gate'),[]);
 assert.deepEqual(namedImportDefinitions('import { Gate, Other as Gate } from "./target.js";', 'export class Gate {}'),[]);
 assert.deepEqual(namedImportDefinitions('import { Gate } from "./target.js";', 'export class GateExtra {}'),[]);
});
test('historical approved context definition hints reach model with separate sides and no target fallback', async () => {
 const imp='import { Gate } from "./target.js";';
 const file={id:'a',path:'a.js',eligibility:'reviewable',properties:[],left:{text:imp},right:{text:imp+'\n// changed'}};
 const input={id:'history-definitions',vcs:'git',history:{base:'before',target:'after'},files:[file],context:[{path:'target.js',oldText:'export const Gate = 1;',text:'// target\nexport class Gate {}'}]};
 const before=structuredClone(input);let sends=0;
 await reviewSnapshot(input,async request=>{const p=JSON.parse(request.input);const old=p.contextRelations.find(r=>r.side==='old'),fresh=p.contextRelations.find(r=>r.side==='new');assert.equal(old.definitionHints[0].declarationKind,'const');assert.equal(old.definitionHints[0].declarationLine,1);assert.equal(fresh.definitionHints[0].declarationKind,'class');assert.equal(fresh.definitionHints[0].declarationLine,2);assert.equal(old.contextVersion,'before');assert.equal(fresh.contextVersion,'after');sends++;return {findings:[],limitations:[]};});
 assert.equal(sends,1);assert.deepEqual(input,before);
 delete input.context[0].oldText;assert.ok(!inferContextRelations(input,file).some(r=>r.side==='old'&&r.definitionHints.length));
});
test('definition hint caps and unsafe sources do not grant reads or binding proof',()=>{
 const names=Array.from({length:21},(_,i)=>'n'+i),text=names.map(n=>'export const '+n+' = 1;').join('\n');
 const hints=namedImportDefinitions('import { '+names.join(',')+' } from "./target.js";',text);assert.equal(hints.length,20);assert.ok(hints.every(h=>h.confidence==='approved-unique-syntax-only'));
 assert.deepEqual(namedImportDefinitions('import { Gate } from "./target.js";', 'export class Gate {}'+' '.repeat(256*1024)),[]);
 assert.deepEqual(namedImportDefinitions('import type { Gate } from "./target.js";', 'export class Gate {}'),[]);
 assert.deepEqual(namedImportDefinitions('import * as Gate from "./target.js";', 'export class Gate {}'),[]);
 assert.deepEqual(namedImportDefinitions('import Gate from "./target.js";', 'export class Gate {}'),[]);
});
test('unique default export binds default imports while ambiguity and reexports refuse', async () => {
 assert.deepEqual(defaultImportDefinition("import Gate from './target.js';", 'export default class Gate {}'), [{ imported: 'default', local: 'Gate', declarationLine: 1, declarationKind: 'default-declaration', confidence: 'approved-default-syntax-only' }]);
 assert.equal(defaultImportDefinition("import App from './target.js';", 'export default function () {}')[0].declarationKind, 'default-declaration');
 assert.equal(defaultImportDefinition("import app from './target.js';", 'export default createApp();')[0].declarationKind, 'default-expression');
 for (const text of ['export default class A {}' + String.fromCharCode(10) + 'export default class B {}', "export { default } from './other.js';", '/* export default class A {} */', 'export default {', 'export default class A {}' + String.fromCharCode(92,10) + 'export default class B {}']) assert.deepEqual(defaultImportDefinition("import Gate from './target.js';", text), []);
 assert.deepEqual(defaultImportDefinition("import { Gate } from './target.js';", 'export default class Gate {}'), []);
 assert.deepEqual(defaultImportDefinition("import * as Gate from './target.js';", 'export default class Gate {}'), []);
 const file = { id: 'a', path: 'a.js', eligibility: 'reviewable', properties: [], left: { text: '' }, right: { text: "import Gate, { run } from './target.js';" } };
 const dep = { id: 'b', path: 'target.js', eligibility: 'reviewable', properties: [], left: { text: '' }, right: { text: 'export default class Gate {}' + String.fromCharCode(10) + 'export function run() {}' } };
 const hints = inferImportRelations([file, dep])[0].definitionHints;
 assert.deepEqual(hints.map(h => [h.imported, h.declarationKind]), [['run', 'function'], ['default', 'default-declaration']]);
 assert.equal(hints[1].declarationLine, 1); assert.equal(hints[0].declarationLine, 2);
 let sends = 0;
 await reviewSnapshot({ id: 's', vcs: 'git', context: [], files: [file, dep] }, async request => { const payload = JSON.parse(request.input); assert.equal(payload.bindingRelations[0].definitionHints[1].local, 'Gate'); sends++; return { findings: [], limitations: [] }; }, { enableGrouping: true, grouping: { groups: [{ id: 'g', fileIds: ['a', 'b'] }], links: [] } });
 assert.equal(sends, 2);
 const old = { ...dep, left: { text: 'export default class Gate {}' }, right: { text: 'export const Gate = 1;' } };
 const oldFile = { ...file, left: { text: "import Gate from './target.js';" }, right: { text: '' } };
 assert.equal(inferImportRelations([oldFile, old]).find(item => item.side === 'old').definitionHints[0].declarationKind, 'default-declaration');
});
test('shadowing assignment escapes ambiguous exports and reexports fail closed', () => {
 for (const extra of ['function outer(execute) {', 'const execute = local;', 'execute = local;', 'consume(execute);']) assert.deepEqual(resolve([...lines, extra]), []);
 for (const text of [target + String.fromCharCode(10) + target, "export { run } from './other.js';", '/* comment */' + target]) assert.deepEqual(resolve(lines, text), []);
});
