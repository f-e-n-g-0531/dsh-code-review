import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
test('exported locale metadata supplies friendly titles without changing package identity', async () => {
  const en = (await import('@feng0531/dsh-code-review/locale/en.json', { with: { type: 'json' } })).default;
  const zh = (await import('@feng0531/dsh-code-review/locale/zh-CN.json', { with: { type: 'json' } })).default;
  assert.equal(en.meta.title, 'Code Review'); assert.equal(zh.meta.title, '代码审查');
  const p = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(p.name, '@feng0531/dsh-code-review'); assert.ok(p.files.includes('locale/'));
});
