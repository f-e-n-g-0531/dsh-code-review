import {readFile,readdir,lstat,realpath,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {runDriver as officialRunDriver,validateConfig} from './autonomous-review-sdk.mjs';
import {collectReviewAcceptance,evaluateReviewAcceptance} from './collect-review-acceptance.mjs';
const fail=code=>Object.assign(new Error(code),{code});
const sha=b=>createHash('sha256').update(b).digest('hex');
const forbidden=p=>p.split(/[\\/]/).some(x=>x.toLowerCase()==='artifacts');
const sameOwner=(owner,e)=>['sessionId','cwd','provider','model'].every(k=>owner?.[k]===e[k]);
export async function runReviewRegression(config,{runDriver=officialRunDriver,collect=collectReviewAcceptance}={}){
 if(!config||Object.keys(config).some(k=>!['driverConfig','acceptanceOutputDir','expected'].includes(k))||!path.isAbsolute(config.driverConfig??'')||!path.isAbsolute(config.acceptanceOutputDir??'')||forbidden(config.acceptanceOutputDir))throw fail('INVALID_REGRESSION_CONFIG');
 try{await lstat(config.acceptanceOutputDir);throw fail('ACCEPTANCE_OUTPUT_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}
 evaluateReviewAcceptance({},config.expected); // Validate the collector's exact fixed identity contract before dispatch.
 const driverBytes=await readFile(config.driverConfig),driver=validateConfig(JSON.parse(driverBytes));
 if(driver.sessionId!==config.expected.sessionId||driver.cwd!==config.expected.cwd||driver.route.provider!==config.expected.provider||driver.route.model!==config.expected.model)throw fail('DRIVER_IDENTITY_MISMATCH');
 if(sha(await readFile(driver.candidatePath)).toLowerCase()!==driver.candidateSha256.toLowerCase())throw fail('CANDIDATE_HASH_MISMATCH');
 // Never invoke another model or another driver after a failure.
 let driverCompleted=false,driverFailure;
 try{if(!driverBytes.equals(await readFile(config.driverConfig)))throw fail('DRIVER_CONFIG_CHANGED');await runDriver(config.driverConfig);driverCompleted=true;}catch(error){driverFailure={code:typeof error?.code==='string'?error.code:'DRIVER_FAILED'};}
 const directory=path.join(driver.profileDir,'data','dsh-code-review','jobs'),reports=[],previews=[];
 let scanFailure;
 try{
  const state=await lstat(directory);if(state.isSymbolicLink()||!state.isDirectory()||path.resolve(await realpath(directory))!==path.resolve(directory))throw fail('UNSAFE_JOB_DIRECTORY');
  const entries=await readdir(directory,{withFileTypes:true});if(entries.length>10000)throw fail('JOB_SCAN_LIMIT');
  for(const entry of entries){
   if(!entry.name.endsWith('.json'))continue;
   const filename=path.join(directory,entry.name),s=await lstat(filename);
   if(s.isSymbolicLink()||!s.isFile())continue;
   if(s.size>64*1024*1024)throw fail('PUBLIC_JOB_SIZE_LIMIT');
   let job;try{job=JSON.parse(await readFile(filename,'utf8'));}catch{throw fail('INVALID_PUBLIC_JOB');}
   if(!sameOwner(job.owner,config.expected))continue;
   if(job.result?.report&&typeof job.result.report==='object'&&!Array.isArray(job.result.report))reports.push({filename,job});else previews.push({jobId:job.jobId,status:job.status,hasError:typeof job.error==='string'});
  }
 }catch(error){if(error.code!=='ENOENT')scanFailure=error.code??'JOB_SCAN_FAILED';}
 let result;
 if(!scanFailure&&reports.length===1){
  const acceptance=await collect({jobFile:reports[0].filename,outputDir:config.acceptanceOutputDir,expected:config.expected});
  result={driverCompleted,driverFailure,jobId:reports[0].job.jobId,reportAvailable:true,engineeringResult:acceptance.engineeringResult,passed:driverCompleted&&acceptance.engineeringResult==='passed',qualityPassed:null};
  await writeFile(path.join(config.acceptanceOutputDir,'regression-result.json'),JSON.stringify(result,null,2),{flag:'wx'});
 }else{
  result={driverCompleted,driverFailure,reportAvailable:false,engineeringResult:'failed',passed:false,qualityPassed:null,reason:scanFailure??(reports.length>1?'AMBIGUOUS_EXECUTE_REPORTS':previews.length?'PREVIEW_ONLY_NO_EXECUTE_REPORT':'NO_OWNED_EXECUTE_REPORT'),matchingReportCount:reports.length,previewJobs:previews};
  await mkdir(config.acceptanceOutputDir);await writeFile(path.join(config.acceptanceOutputDir,'regression-result.json'),JSON.stringify(result,null,2),{flag:'wx'});
 }
 return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{if(process.argv.length!==4||process.argv[2]!=='--config')throw fail('USAGE');const result=await runReviewRegression(JSON.parse(await readFile(process.argv[3],'utf8')));console.log(JSON.stringify(result));process.exitCode=result.passed?0:1;}
 catch{console.error('Regression refused or failed; no automatic retry performed.');process.exitCode=2;}
}
