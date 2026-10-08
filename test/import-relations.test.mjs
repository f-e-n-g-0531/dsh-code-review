import test from 'node:test';
import assert from 'node:assert/strict';
import { inferImportRelations } from '../src/import-relations.mjs';
const file = (id, name, text = '', eligibility = 'reviewable') => ({ id, path: name, eligibility, left: { text: '' }, right: { text } });
test('relative imports preserve source side, direction and original line', () => {
  const a = file('a', 'src/a.ts', ['// comment', "import { guard } from './guard';", "export { run } from '../run.mjs';"].join(String.fromCharCode(10)));
  a.left.text = "import './old.js';";
  const result = inferImportRelations([a, file('g', 'src/guard.ts'), file('r', 'run.mjs'), file('o', 'src/old.js')]);
  assert.equal(result.length, 3);
  assert.ok(result.some(e => e.from === 'a' && e.to === 'g' && e.line === 2 && e.side === 'new'));
  assert.ok(result.some(e => e.to === 'o' && e.side === 'old'));
});
test('ambiguous, unauthorized, escaping and package imports create no edge', () => {
  for (const text of ["import './dep';", "import '../outside.js';", "import 'dep';", "import('./dep.ts');"]) {
    const files = [file('a', 'a.ts', text), file('b', 'dep.ts'), file('c', 'dep.js', '', 'excluded')];
    assert.deepEqual(inferImportRelations(files), []);
  }
  assert.deepEqual(inferImportRelations([file('a', 'a.ts', "import './dep.js';"), file('b', 'dep.js', '', 'blocked')]), []);
});
test('comments templates and strings do not pretend to be imports', () => {
  for (const text of ["// import './dep.js';", "/* comment" + String.fromCharCode(10) + "import './dep.js';", String.fromCharCode(96) + String.fromCharCode(10) + "import './dep.js';", "const x = \"import './dep.js';\";"]) {
    assert.deepEqual(inferImportRelations([file('a', 'a.js', text), file('b', 'dep.js')]), []);
  }
});
test('malformed quotes and continued string contents never form import edges', () => {
  const nl = String.fromCharCode(10), slash = String.fromCharCode(92);
  for (const text of ["import './dep.js\";", '"continued' + slash + nl + "import './dep.js';" + slash + nl + '";']) {
    assert.deepEqual(inferImportRelations([file('a', 'a.js', text), file('b', 'dep.js')]), []);
  }
});
test('old-side resolution refuses renamed targets and input order does not matter', () => {
  const a = file('a', 'a.js'); a.left.text = "import './dep.js';";
  const target = file('b', 'moved.js'); target.oldPath = 'dep.js';
  const replacement = file('c', 'dep.js');
  const files = [a, target, replacement];
  assert.deepEqual(inferImportRelations(files), []);
  assert.deepEqual(inferImportRelations(files), inferImportRelations([...files].reverse()));
});
test('exact and directory targets resolve only within supplied approved entries', () => {
  assert.equal(inferImportRelations([file('a', 'a.js', "import './dep';"), file('b', 'dep/index.js')])[0].to, 'b');
  assert.throws(() => inferImportRelations([file('a', '../a.js')]), /Invalid/);
  assert.throws(() => inferImportRelations([file('a', 'a.js'), file('a', 'b.js')]), /Invalid/);
});
