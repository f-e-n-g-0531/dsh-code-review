import {verifyReleaseCiEvidence} from './release-ci-evidence.mjs';
const repository=process.env.GITHUB_REPOSITORY,sha=process.env.GITHUB_SHA,ref=process.env.GITHUB_REF,id=process.env.RELEASE_CI_RUN_ID,token=process.env.GITHUB_TOKEN;
if(!repository||!ref?.startsWith('refs/tags/')||!token||!/^[1-9][0-9]*$/.test(id??''))throw new Error('A successful frozen-tag CI run id and GitHub token are required');
const base='https://api.github.com/repos/'+repository;
async function get(path){const r=await fetch(base+path,{headers:{Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error('Release CI evidence HTTP '+r.status);return r.json();}
const workflow=await get('/actions/workflows/ci.yml'),run=await get('/actions/runs/'+id);
const page=await get('/actions/runs/'+id+'/attempts/'+run.run_attempt+'/jobs?per_page=100');if(page.total_count>100||!Array.isArray(page.jobs)||page.jobs.length!==page.total_count)throw new Error('Incomplete release CI job evidence');
const evidence=verifyReleaseCiEvidence(run,page.jobs,{repository,sha,tag:ref.slice(10),workflowId:workflow.id});
// Re-read after jobs to reject an attempt changed or restarted while checking.
const after=await get('/actions/runs/'+id);verifyReleaseCiEvidence(after,page.jobs,{repository,sha,tag:ref.slice(10),workflowId:workflow.id});
console.log('Verified frozen-tag CI evidence',JSON.stringify(evidence));
