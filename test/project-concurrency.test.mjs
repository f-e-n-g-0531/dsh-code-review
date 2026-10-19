import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { checked } from '../src/process.mjs';
import { createReviewService } from '../src/service.mjs';
import { recoveryCoverage } from '../src/recovery-coverage.mjs';
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('project service exposes bounded concurrency and streams three approved batches with ordered final coverage',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dsh-project-concurrency-'));
 t.after(async()=>{assert.ok(path.basename(root).startsWith('dsh-project-concurrency-'));await rm(root,{recursive:true,force:true});});
 await checked('git',['init','-q'],{cwd:root});
 for(let i=0;i<25;i++)await writeFile(path.join(root,String(i).padStart(2,'0')+'.js'),'const value='+i+';');
 await checked('git',['add','.'],{cwd:root});
 const gate=defer(),allStarted=defer(),events=[];let calls=0,active=0,peak=0;
 const service=createReviewService({async *stream(req){
  calls++;active++;peak=Math.max(peak,active);
  try {const p=JSON.parse(req.messages[0].content[0].text);assert.match(p.file.path,/^\d{2}\.js$/);if(calls===3)allStarted.resolve();if(calls<=3)await gate.promise;yield {type:'text-delta',text:'{"findings":[],"limitations":[]}'};yield {type:'finish',reason:{kind:'stop'}};}finally{active--;}
 }},{allowModelSending:true,authorize:async()=>true});
 t.after(()=>{gate.resolve();service.dispose();});
 const exec={agent:{session:{header:{cwd:root}},options:{provider:'p',model:'m'}},reviewCheckpoint:async e=>events.push(structuredClone(e))};
 const p=await service.preview({reviewMode:'project'},exec);assert.equal(p.execution.batchConcurrency,3);assert.equal(p.batches,3);
 const running=service.execute({previewId:p.previewId,confirmed:true},exec);
 await allStarted.promise;assert.equal(peak,3);assert.equal(calls,3);await assert.rejects(service.preview({reviewMode:'project'},exec),/busy/);gate.resolve();
 const result=await running;assert.equal(result.report.execution.batchConcurrency,3);assert.equal(result.report.modelCalls,25);assert.equal(result.report.coverage.completed,25);assert.equal(result.report.files.length,25);assert.deepEqual(result.report.files.map(f=>f.path),Array.from({length:25},(_,i)=>String(i).padStart(2,'0')+'.js'));assert.ok(result.report.files.every(f=>f.status==='completed'));assert.equal(recoveryCoverage({checkpoints:events}).files.filter(f=>f.status==='completed').length,25);assert.equal(peak,3);
});
