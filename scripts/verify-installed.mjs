import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
const directory = process.argv[2];
if (!directory) throw new Error('Pass the isolated installation directory');
const require = createRequire(path.resolve(directory, 'package.json'));
const entry = await import(pathToFileURL(require.resolve('@feng0531/dsh-code-review')).href);
assert.equal(typeof entry.apply, 'function');
const config = entry.Config({});
assert.equal(config.autoExcludeNonCode.get(), true);
assert.equal(config.diffExcludeFolderNames.get(), 'Test');
const client = await readFile(require.resolve('@feng0531/dsh-code-review/client'), 'utf8');
assert.match(client, /__ModuleLoader__[.]load/);
assert.ok(client.includes('plugins.row.config'));
const en = require('@feng0531/dsh-code-review/locale/en.json');
const zh = require('@feng0531/dsh-code-review/locale/zh-CN.json');
assert.equal(en.meta.title, 'Code Review');
assert.equal(zh.meta.title, '代码审查');
const child = await import(pathToFileURL(require.resolve('@feng0531/dsh-code-review/child')).href);
assert.equal(child.name, 'dsh-code-review-restricted-child');
assert.equal(typeof child.apply, 'function');
const root = path.dirname(require.resolve('@feng0531/dsh-code-review/package.json'));
const benchmark = await import(pathToFileURL(path.join(root, 'scripts/review-bench-adapter.mjs')).href);
assert.equal(typeof benchmark.runBenchmark, 'function');
const markdown = (await readdir(root, { withFileTypes: true })).filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name);
markdown.push('evaluation/REVIEWBENCH-LOCAL.md');
for (const file of markdown) {
  const source = await readFile(path.join(root, file), 'utf8');
  // Check relative inline link targets in the shipped docs. External URLs and
  // same-page fragments belong to the repository/renderer, not this package.
  for (const [, href] of source.matchAll(/\]\(<?([^>\s)]+)>?(?:\s+"[^"]*")?\)/g)) {
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(href)) continue;
    const target = path.resolve(root, path.dirname(file), decodeURIComponent(href.split(/[?#]/, 1)[0]));
    const relative = path.relative(root, target);
    assert.ok(relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), file + ': link leaves package: ' + href);
    assert.ok(await stat(target).catch(() => null), file + ': missing package link: ' + href);
  }
}
console.log('Installed root, restricted child, locale, benchmark entry and documentation links verified');
