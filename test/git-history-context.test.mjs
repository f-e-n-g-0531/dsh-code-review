import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {checked} from '../src/process.mjs';import {captureSnapshot} from '../src/snapshot.mjs';
test('historical context only reads target blobs; auto/explicit dedup and excluded changes fail closed',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dsh-history-context-'));t.after(async()=>{assert.ok(path.basename(root).startsWith('dsh-history-context-'));await rm(root,{recursive:true,force:true});});
 const git=(...args)=>checked('git',args,{cwd:root});await git('init');await git('config','user.name','test');await git('config','user.email','test@example.com');
 for(const [p,v] of [['a.ts','old'],['dep.ts','TARGET'],['b.ts','old'],['rules.md','TARGET RULE']])await writeFile(path.join(root,p),v);await git('add','.');await git('commit','-m','base');
 await writeFile(path.join(root,'a.ts'),'import x from "./dep";\nimport y from "./b";');await writeFile(path.join(root,'b.ts'),'changed');await git('commit','-am','target');const commit=(await git('rev-parse','HEAD')).toString().trim();
 await writeFile(path.join(root,'dep.ts'),'WORKTREE SECRET');const before=await git('status','--porcelain');
 await writeFile(path.join(root,'rules.md'),'WORKTREE RULE SECRET');
 const options={commit,autoContext:true,selectedPaths:['a.ts']};const s=await captureSnapshot(root,options);assert.deepEqual(s.autoContext.capturedPaths,['dep.ts']);assert.equal(s.context[0].text,'TARGET');assert.ok(!JSON.stringify(s).includes('WORKTREE SECRET'));assert.equal(s.id,(await captureSnapshot(root,options)).id);
 const explicit=await captureSnapshot(root,{...options,contextPaths:['dep.ts']});assert.equal(explicit.context.length,1);assert.deepEqual(explicit.autoContext.capturedPaths,[]);
 await assert.rejects(captureSnapshot(root,{...options,contextPaths:['b.ts']}),/excluded/);await assert.rejects(captureSnapshot(root,{...options,contextPaths:['absent']}),/regular blob/);await assert.rejects(captureSnapshot(root,{...options,maxSnapshotBytes:10}),/limit/);const rules=await captureSnapshot(root,{...options,rulePaths:['rules.md']});assert.equal(rules.rules[0].text,'TARGET RULE');assert.notEqual(rules.id,s.id);assert.ok(!JSON.stringify(rules).includes('WORKTREE RULE SECRET'));await assert.rejects(captureSnapshot(root,{...options,rulePaths:['rules.md'],contextPaths:['rules.md']}),/separate/);await assert.rejects(captureSnapshot(root,{...options,rulePaths:['rules.md','rules.md']}),/Duplicate/);await assert.rejects(captureSnapshot(root,{...options,rulePaths:['b.ts']}),/Markdown/);await writeFile(path.join(root,'rules.md'),'TARGET RULE');assert.deepEqual(await git('status','--porcelain'),before);
});
