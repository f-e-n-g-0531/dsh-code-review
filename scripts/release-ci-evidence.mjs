export function verifyReleaseCiEvidence(run,jobs,expected){
 const {repository,sha,tag,workflowId}=expected;
 if(!/^[0-9a-f]{40}$/.test(sha??'')||!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag??'')||!Number.isSafeInteger(workflowId))throw new Error('Invalid release CI expectation');
 if(run.repository?.full_name!==repository||run.head_repository?.full_name!==repository||run.head_sha!==sha||run.head_branch!==tag||run.workflow_id!==workflowId||run.path!=='.github/workflows/ci.yml'||run.event!=='push'||run.status!=='completed'||run.conclusion!=='success'||!Number.isSafeInteger(run.run_attempt)||run.run_attempt<1)throw new Error('Release CI run identity or result mismatch');
 const names=['test (22, ubuntu-latest)','test (24, ubuntu-latest)','test (22, windows-latest)','test (24, windows-latest)'];
 const successfulStep=(job,name)=>{
  const matches=job.steps?.filter(step=>step.name===name);
  return matches?.length===1&&matches[0].status==='completed'&&matches[0].conclusion==='success';
 };
 for(const name of names){
  const matches=jobs.filter(j=>j.name===name);
  if(matches.length!==1)throw new Error('Release CI matrix job missing or duplicate');
  const j=matches[0];
  if(j.run_id!==run.id||j.run_attempt!==run.run_attempt||j.head_sha!==sha||j.status!=='completed'||j.conclusion!=='success'||!successfulStep(j,'Run npm test'))throw new Error('Release CI matrix job is not successful for current attempt');
  if(name==='test (24, ubuntu-latest)'&&!successfulStep(j,'Verify frozen-tag package install'))throw new Error('Release CI frozen-tag package install is not successful for current attempt');
 }
 return {runId:run.id,attempt:run.run_attempt,sha,tag,jobs:names};
}
