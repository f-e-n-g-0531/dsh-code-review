import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import path from 'node:path';
const docs=['README.md','CHANGELOG.md','RELEASE-NOTES.md','DEVELOPMENT.md','CORE-ALIGNMENT-TASKS.md','CORE-SOURCE-INVENTORY.md','evaluation/README.md','evaluation/PILOT-GATE.md','evaluation/PILOT-RESULTS.md','evaluation/lifecycle/README.md','evaluation/stale-result/README.md','evaluation/history-rule-extension/README.md'];
test('documentation links resolve and release notes are included in package',async()=>{
 for(const file of docs){const text=await readFile(file,'utf8');assert.ok(text.startsWith('# '),file);assert.ok([...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].length>0||file.includes('/lifecycle/')||file.includes('/stale-result/'),file);for(const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)){const target=match[1].split('#')[0];if(!target||/^[a-z]+:/i.test(target))continue;await access(path.resolve(path.dirname(file),target));}}
 const pkg=JSON.parse(await readFile('package.json','utf8')),notes=await readFile('RELEASE-NOTES.md','utf8');assert.ok(notes.startsWith('# v'+pkg.version+' '));for(const file of docs.filter(f=>!f.startsWith('evaluation/')))assert.ok(pkg.files.includes(file),file);
 assert.ok((await readFile('.github/workflows/ci.yml','utf8')).includes('--notes-file RELEASE-NOTES.md'));
});
