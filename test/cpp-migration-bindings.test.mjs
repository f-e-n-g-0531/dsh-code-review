import test from 'node:test';
import assert from 'node:assert/strict';
import { cppMigrationBindings } from '../src/cpp-migration-bindings.mjs';

export function classEntries(pointer = false) {
  const receiver = pointer ? 'Engine* engine' : 'Engine& engine', operator = pointer ? '->' : '.';
  const header = (name, method) => '#ifndef ' + name.toUpperCase() + '_H\n#define ' + name.toUpperCase() + '_H\nclass ' + name + ' {\npublic:\n  void ' + method + ';\n};\n#endif\n';
  return [
    ['eh', 'Engine.h', header('Engine', 'Mutate(int value)')],
    ['ph', 'Preloader.h', header('Preloader', 'Load(' + receiver + ', int value)')],
    ['ch', 'Caller.h', header('Caller', 'Run(' + receiver + ', int value)')],
    ['a', 'Engine.cpp', '#include "Engine.h"\nvoid Engine::Mutate(int value) {\n  value++;\n}\n'],
    ['b', 'Preloader.cpp', '#include "Preloader.h"\n#include "Engine.h"\nvoid Preloader::Load(' + receiver + ', int value) {\n  engine' + operator + 'Mutate(value);\n}\n'],
    ['c', 'Caller.cpp', '#include "Caller.h"\n#include "Engine.h"\nvoid Caller::Run(' + receiver + ', int value) {\n  engine' + operator + 'Mutate(value);\n}\n'],
  ].map(([id, path, text], i) => ({ id, path, text, eligibility: 'reviewable', source: { id: 's' + i, side: 'new' } }));
}
for (const pointer of [false, true]) test('unique included class declaration out-of-line definition and explicit receiver bind syntactically: ' + pointer, () => {
  const entries = classEntries(pointer), before = structuredClone(entries), output = cppMigrationBindings(entries);
  assert.deepEqual(entries, before); assert.equal(output.definitions.length, 3); assert.equal(output.bindings.length, 2);
  const binding = output.bindings.find(b => b.from === 'b'); assert.equal(binding.to, 'a'); assert.equal(binding.symbol, 'Engine::Mutate');
  assert.equal(binding.callLine, 4); assert.equal(binding.importLine, 2);
  assert.ok(binding.navigationBindings.some(n => n.sourceId === 's0' && n.line === 5));
  assert.ok(binding.navigationBindings.some(n => n.receiverKind === (pointer ? 'pointer-parameter' : 'reference-parameter')));
  assert.ok(binding.navigationBindings.every(n => n.confidence.endsWith('syntax-only')));
});

test('missing header literal include definition and wrong signature never bind by basename or method name', () => {
  for (const edit of [
    e => { e.splice(0, 1); }, e => { e.find(x => x.id === 'a').text = '#include "Other.h"\nvoid Engine::Mutate(int value) {\n value++;\n}\n'; },
    e => { e.find(x => x.id === 'b').text = e.find(x => x.id === 'b').text.replace('#include "Engine.h"', ''); },
    e => { e.find(x => x.id === 'a').text = e.find(x => x.id === 'a').text.replace('int value', 'bool value'); },
    e => { e.find(x => x.id === 'eh').eligibility = 'excluded'; },
  ]) { const entries = classEntries(); edit(entries); assert.ok(!cppMigrationBindings(entries).bindings.some(b => b.from === 'b')); }
});

test('overloads duplicate classes definitions inheritance virtual templates macros and comments fail closed', () => {
  for (const edit of [
    e => { e[0].text = e[0].text.replace('  void Mutate(int value);', '  void Mutate(int value);\n  void Mutate(bool value);'); },
    e => { e.push({ ...e[0], id: 'dup', path: 'Other.h' }); },
    e => { e.push({ ...e.find(x => x.id === 'a'), id: 'dup', path: 'Other.cpp' }); },
    e => { e.push({ ...e.find(x => x.id === 'a'), id: 'dup', path: 'Other.cpp', text: '#include "Engine.h"\nvoid Engine::Mutate(bool value) {\n  const char* text = "unsupported";\n}\n' }); },
    e => { e[0].text = e[0].text.replace('public:', 'private:'); },
    e => { e[0].text = e[0].text.replace('class Engine {', 'class Engine : public Base {'); },
    e => { e[0].text = e[0].text.replace('void Mutate', 'virtual void Mutate'); },
    e => { e[0].text = 'template<class T>\n' + e[0].text; },
    e => { e[0].text = e[0].text.replace('#define ENGINE_H', '#define ENGINE_H\n#define Mutate Other'); },
    e => { e[0].text = '/* misleading class */\n' + e[0].text; },
  ]) { const entries = classEntries(); edit(entries); assert.ok(!cppMigrationBindings(entries).bindings.some(b => b.from === 'b')); }
});

test('receiver aliases mutation escape and shadowing reject; member name alone never establishes type', () => {
  for (const body of ['auto engine = other;\n  engine.Mutate(value);', 'escape(engine);\n  engine.Mutate(value);',
    'engine = other;\n  engine.Mutate(value);', 'other.Mutate(value);', '// engine.Mutate(value);', 'engine.Mutate(compute());', 'engine.Mutate(engine);']) {
    const e = classEntries(), entry = e.find(x => x.id === 'b'); entry.text = entry.text.replace('engine.Mutate(value);', body);
    assert.ok(!cppMigrationBindings(e).bindings.some(b => b.from === 'b'));
  }
});

test('binding limits and invalid inputs are bounded and explicit', () => {
  const result = cppMigrationBindings(classEntries(), { maxBindings: 1 }); assert.equal(result.bindings.length, 1); assert.ok(result.limitations.length);
  assert.throws(() => cppMigrationBindings(classEntries(), { maxBindings: 0 }));
  const e = classEntries(); e.push(e[0]); assert.throws(() => cppMigrationBindings(e));
});
