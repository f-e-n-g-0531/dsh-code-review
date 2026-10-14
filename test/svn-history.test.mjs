import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {reviewSnapshot} from '../src/review.mjs';
import {checked} from '../src/process.mjs';import {captureSnapshot} from '../src/snapshot.mjs';import {svnHistoryRange,svnHistoryDestination} from '../src/svn-history.mjs';import {xml} from '../src/svn.mjs';import {createReviewService} from '../src/service.mjs';

test('SVN history parameters require explicit numeric endpoints and reject Git or context ambiguity',()=>{
 assert.deepEqual(svnHistoryRange({svnRevision:'2'}),{base:'1',target:'2',mode:'svn-revision'});
 for(const options of [{svnRevision:'HEAD'},{svnRevision:'0'},{svnRevision:'02'},{svnBaseRevision:'2',svnTargetRevision:'1'},{svnRevision:'2',commit:'HEAD'},{svnRevision:'2',svnBaseRevision:'1'}])assert.throws(()=>svnHistoryRange(options));
});
test('SVN historical URL access requires explicit remote opt-in including file UNC hosts',()=>{
 for(const url of ['https://example.test/repo','svn://example.test/repo','file://server/share/repo'])assert.throws(()=>svnHistoryDestination(url,false),/explicit/);
 assert.equal(svnHistoryDestination('https://example.test/repo',true).networkAccess,true);
 assert.equal(svnHistoryDestination('file:///D:/repo',false).networkAccess,false);
 for(const url of ['https://user:pass@example.test/repo','https://example.test/repo?token=x','ftp://example.test/repo'])assert.throws(()=>svnHistoryDestination(url,true),/Unsafe/);
});
test('SVN history copied files and keywords use target objects, not source or expanded working data',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-svn-hist-copy-'));t.after(async()=>{assert.ok(path.basename(dir).startsWith('dsh-svn-hist-copy-'));await rm(dir,{recursive:true,force:true});});
 const repo=path.join(dir,'repo'),root=path.join(dir,'wc');await checked('svnadmin',['create',repo]);await checked('svn',['checkout',pathToFileURL(repo).href,root]);const svn=(...args)=>checked('svn',['--non-interactive',...args],{cwd:root});
 await writeFile(path.join(root,'source.js'),'$Id$\nONE\n');await svn('add','source.js');await svn('propset','svn:keywords','Id','source.js');await svn('commit','-m','base');
 await svn('copy','source.js','copied.js');await writeFile(path.join(root,'copied.js'),'$Id$\nTWO\n');await svn('commit','-m','copied');
 const s=await captureSnapshot(root,{svnRevision:'2'});const copy=s.files.find(f=>f.path==='copied.js');
 assert.equal(copy.eligibility,'reviewable',copy.reason);assert.equal(copy.left.text,'');assert.equal(copy.right.text,'$Id$\nTWO\n');assert.ok(copy.properties.some(p=>p.name==='svn:keywords'&&p.new==='Id'));assert.ok(copy.svnSources.new.url.endsWith('/copied.js'));
 await assert.rejects(captureSnapshot(root,{svnRevision:'2',selectedPaths:['absent.js']}),/not an SVN historical change/);
 const blocked=await captureSnapshot(root,{svnRevision:'2',maxFileBytes:2});assert.equal(blocked.files.find(f=>f.path==='copied.js').eligibility,'blocked');
});
test('SVN historical explicit context and rules read fixed revisions, not dirty local files',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-svn-hist-context-'));t.after(async()=>{assert.ok(path.basename(dir).startsWith('dsh-svn-hist-context-'));await rm(dir,{recursive:true,force:true});});
 const repo=path.join(dir,'repo'),root=path.join(dir,'wc');await checked('svnadmin',['create',repo]);await checked('svn',['checkout',pathToFileURL(repo).href,root]);const svn=(...args)=>checked('svn',['--non-interactive',...args],{cwd:root});
 for(const [name,text]of [['main.js','ONE\n'],['dep.js','DEP\n'],['rules.md','OLD RULE\n']])await writeFile(path.join(root,name),text);
 await svn('add','main.js','dep.js','rules.md');await svn('commit','-m','base');await writeFile(path.join(root,'main.js'),'TWO\n');await writeFile(path.join(root,'rules.md'),'TARGET RULE\n');await svn('commit','-m','target');
 for(const name of ['dep.js','rules.md'])await writeFile(path.join(root,name),'LOCAL SECRET\n');
 const options={svnRevision:'2',selectedPaths:['main.js','rules.md'],contextPaths:['dep.js'],rulePaths:['rules.md']};
 const s=await captureSnapshot(root,options);assert.equal(s.context[0].text,'DEP\n');assert.equal(s.context[0].oldText,'DEP\n');assert.equal(s.context[0].revision,'2');assert.equal(s.context[0].oldRevision,'1');assert.equal(s.rules[0].text,'TARGET RULE\n');assert.ok(!JSON.stringify(s).includes('LOCAL SECRET'));
 assert.equal(s.id,(await captureSnapshot(root,options)).id);
 const report=await reviewSnapshot(s,async request=>{const payload=JSON.parse(request.input);assert.ok(!request.input.includes('LOCAL SECRET'));assert.equal(payload.context[0].revision,'2');assert.equal(payload.context[0].oldRevision,'1');assert.equal(payload.rules[0].text,'TARGET RULE\n');return {findings:[],limitations:[]};},{enableRetrieval:true});assert.equal(report.status,'completed');
 await assert.rejects(captureSnapshot(root,{...options,selectedPaths:['main.js']}),/excluded.*blocked.*deleted/);
 await assert.rejects(captureSnapshot(root,{...options,contextPaths:['.env']}),/Credential/);
 let sends=0;const service=createReviewService({stream:async function*(){sends++;}});try{const p=await service.preview(options,{agent:{session:{header:{cwd:root}},options:{provider:'offline',model:'none'}}});assert.deepEqual(p.contextPaths,['dep.js']);assert.equal(p.rules[0].path,'rules.md');assert.equal(sends,0);}finally{service.dispose();}
});
test('SVN fixed history captures revision content properties and directories without dirty working text or model sends',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-fixed-svn-history-'));t.after(async()=>{assert.ok(path.basename(dir).startsWith('dsh-fixed-svn-history-'));await rm(dir,{recursive:true,force:true});});
 const repo=path.join(dir,'repo'),root=path.join(dir,'wc');await checked('svnadmin',['create',repo]);await checked('svn',['checkout',pathToFileURL(repo).href,root]);const svn=(...args)=>checked('svn',['--non-interactive',...args],{cwd:root});
 await mkdir(path.join(root,'old/sub'),{recursive:true});await writeFile(path.join(root,'old/sub/a.js'),'OLD\n');await writeFile(path.join(root,'main.js'),'ONE\n');await svn('add','old','main.js');await svn('commit','-m','base');await svn('update');
 await svn('delete','old');await mkdir(path.join(root,'new/sub'),{recursive:true});await writeFile(path.join(root,'new/sub/b.js'),'NEW\n');await svn('add','new');await writeFile(path.join(root,'main.js'),'TWO\n');await svn('propset','review:property','changed','main.js');await svn('commit','-m','target');
 await writeFile(path.join(root,'main.js'),'DIRTY SECRET\n');const before=xml(await svn('status','--xml'));
 const s=await captureSnapshot(root,{svnRevision:'2'});
 assert.equal(s.vcs,'svn');assert.equal(s.history.base,'1');assert.equal(s.history.target,'2');assert.equal(s.history.networkAccess,false);assert.equal(s.files.length,7);
 const main=s.files.find(f=>f.path==='main.js');assert.equal(main.left.text,'ONE\n');assert.equal(main.right.text,'TWO\n');assert.deepEqual(main.properties,[{name:'review:property',old:null,new:'changed'}]);
 assert.equal(main.svnSources.old.pegRevision,'1');assert.equal(main.svnSources.new.operativeRevision,'2');assert.equal(main.svnSources.old.repositoryUuid,s.repositoryUuid);
 assert.equal(s.files.find(f=>f.path==='old/sub/a.js').rightExists,false);assert.equal(s.files.find(f=>f.path==='new/sub/b.js').left.text,'');assert.ok(!JSON.stringify(s).includes('DIRTY SECRET'));
 assert.equal(s.id,(await captureSnapshot(root,{svnRevision:'2'})).id);
 const selected=await captureSnapshot(root,{svnBaseRevision:'1',svnTargetRevision:'2',selectedPaths:['old']});assert.equal(selected.files.find(f=>f.path==='old').eligibility,'blocked');
 await assert.rejects(captureSnapshot(root,{svnRevision:'2',autoContext:true}),/not supported/);
 let sends=0;
 const service=createReviewService({stream:async function*(){sends++;yield {type:'text-delta',text:JSON.stringify({findings:[],limitations:[]})};yield {type:'finish',reason:{kind:'stop'}};}},{allowModelSending:true,authorize:async()=>true});try{
  const exec={agent:{session:{header:{cwd:root}},options:{provider:'offline',model:'none'}}};
  const p=await service.preview({svnRevision:'2'},exec);assert.equal(p.history.mode,'svn-revision');assert.equal(p.files.length,7);assert.equal(sends,0);
  await assert.rejects(service.execute({previewId:p.previewId,confirmed:false},exec),/Confirmed/);assert.equal(sends,0);
  const executed=await service.execute({previewId:p.previewId,confirmed:true},exec);assert.equal(executed.report.status,'completed');assert.equal(executed.report.coverage.completed,7);assert.equal(executed.report.outdated,false);assert.ok(sends>=7);
 }finally{service.dispose();}
 let calls=0;const report=await reviewSnapshot(s,async request=>{calls++;assert.ok(!request.input.includes('DIRTY SECRET'));return {findings:[],limitations:[]};},{enableRetrieval:true,enableGrouping:true});assert.equal(report.coverage.completed,7);assert.equal(report.status,'completed');assert.ok(calls>=7);
 assert.deepEqual(xml(await svn('status','--xml')),before);
});
