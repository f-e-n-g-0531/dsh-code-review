import test from 'node:test';
import assert from 'node:assert/strict';
import { instanceMethodBindings } from '../src/class-bindings.mjs';
import { inferImportRelations } from '../src/import-relations.mjs';

const target = member => ['export class A {', '  ' + member + '() {}', '}'].join('\n');
const caller = (declaration, member = 'run', imported = 'A') => [
  "import { " + imported + " } from './dep';", declaration, 'x.' + member + '();',
];
const hints = (declaration, member = 'run', text = target(member), imported = 'A') =>
  instanceMethodBindings(caller(declaration, member, imported), 1, text);

for (const member of ['run', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf']) {
  test('ordinary method name survives prototype-independent counts: ' + member, () => {
    const found = hints('const x = new A();', member);
    assert.equal(found.length, 1);
    assert.equal(found[0].member, member);
    assert.equal(found[0].methodLine, 2);
    assert.equal(found[0].newLine, 2);
    assert.equal(found[0].callLine, 3);
    const duplicate = ['export class A {', '  ' + member + '() {}', '  ' + member + '() {}', '}'].join('\n');
    assert.deepEqual(hints('const x = new A();', member, duplicate), []);
    assert.deepEqual(hints('const x = new A();', member, target('static ' + member)), []);
    assert.deepEqual(hints('const x = new A();', member, target('get ' + member)), []);
  });
}

test('whole constructor declarations with inert arguments retain bindings and alias identity', () => {
  for (const declaration of [
    'const x = new A();', 'let x = new A( )', 'var x = new A(1, -2.5e+3, true, false, null,);',
    "const x = new A(\"text\", 'other');",
    'const x = new A("https://example.test/);", "A.prototype.run = replacement");',
    String.raw`const x = new A("escaped \" quote", 'single \' quote');`,
  ]) assert.equal(hints(declaration).length, 1, declaration);
  const alias = hints('const x = new Alias();', 'run', target('run'), 'A as Alias');
  assert.equal(alias.length, 1);
  assert.equal(alias[0].imported, 'A');
  assert.equal(alias[0].local, 'Alias');
});

test('constructor-line suffixes and executable arguments are not exempt from mutation checks', () => {
  for (const declaration of [
    'const x = new A(); A.prototype.run = replacement;',
    'const x = new A(); Object.assign(A.prototype, replacement);',
    'const x = new A(); mutate();',
    'const x = new A(), extra = mutate();',
    'const x = new A(A.prototype.run = replacement);',
    'const x = new A((A.prototype.run = replacement, 1));',
    'const x = new A(replacement());',
    'const x = new A(options);',
    'const x = new A(...options);',
    'const x = new A({ get value() { return replacement(); } });',
    'const x = new A().other;',
    'const x = new A("//"); A.prototype.run = replacement;',
    'const x = new A("quoted );"); A.prototype.run = replacement;',
    'const x = new Alias(); Alias.prototype.run = replacement;',
  ]) assert.deepEqual(hints(declaration, 'run', target('run'), declaration.includes('Alias') ? 'A as Alias' : 'A'), [], declaration);
});

test('strings and comments cannot certify an incomplete or imaginary construction', () => {
  for (const declaration of [
    '// const x = new A();',
    '"const x = new A();";',
    'const note = "const x = new A();";',
    '/* const x = new A(); */',
    'const x = new A( // );',
    'const x = new A("unfinished );',
    'const x = new A(); // extra statements deliberately remain unsupported',
    'const x = new A(/* comment */);',
  ]) assert.deepEqual(hints(declaration), [], declaration);
});

test('import relation consumers retain inherited names but never certify mutated construction lines', () => {
  const relations = (declaration, member) => inferImportRelations([
    { id: 'main', path: 'main.js', eligibility: 'reviewable', properties: [], left: { text: '' }, right: { text: caller(declaration, member).join('\n') } },
    { id: 'dep', path: 'dep.js', eligibility: 'reviewable', properties: [], left: { text: '' }, right: { text: target(member) } },
  ]).flatMap(edge => edge.bindingHints ?? []).filter(hint => hint.declarationKind === 'instance-method');
  assert.equal(relations('const x = new A();', 'toString').length, 1);
  assert.deepEqual(relations('const x = new A(); A.prototype.run = replacement;', 'run'), []);
});
