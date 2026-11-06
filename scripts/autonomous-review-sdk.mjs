import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync,appendFileSync,mkdirSync,realpathSync,statSync} from 'node:fs';
import {resolve,isAbsolute,join,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const NL=String.fromCharCode(10),sha=b=>createHash('sha256').update(b).digest('hex');
export function redact(v){
 if(typeof v==='string')return v.replace(/Bearer +[^ ,;]+/gi,'Bearer <redacted>').replace(/(api.?key|token|password|secret|authorization)([ :=]+)[^ ,;]+/gi,'$1$2<redacted>');
 if(Array.isArray(v))return v.map(redact);
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,/^(apiKey|api_key|token|accessToken|access_token|refreshToken|refresh_token|password|secret|authorization)$/i.test(k)?'<redacted>':redact(x)]));
 return v;
}
export function validateConfig(c){
 if(!c||typeof c!=='object'||Array.isArray(c))throw Error('Invalid config');
 const fields=['executable','sdkEntry','profile','profileDir','overlay','cwd','route','sessionId','promptFile','outputDir','candidatePath','candidateSha256','timeoutMs'];
 if(Object.keys(c).some(k=>!fields.includes(k)))throw Error('Unknown config field');
 for(const k of ['executable','sdkEntry','profileDir','overlay','cwd','promptFile','outputDir','candidatePath'])if(typeof c[k]!=='string'||!isAbsolute(c[k]))throw Error('Absolute path required: '+k);
 if(!/^[a-z0-9][a-z0-9-]{5,100}$/.test(c.profile??'')||['desktop','default','sdk','headless','sdk-minimal','web','tui'].includes(c.profile)||basename(c.profileDir).toLowerCase()!==c.profile)throw Error('Unique isolated profile required');
 if(!/^[a-zA-Z0-9-]{8,160}$/.test(c.sessionId??''))throw Error('Unique session required');
 if(!c.route||Object.keys(c.route).some(k=>!['provider','model','reasoningEffort','maxTokens'].includes(k))||['provider','model'].some(k=>typeof c.route[k]!=='string'||!c.route[k]))throw Error('Exact route required');
 if(c.route.reasoningEffort!==undefined&&(typeof c.route.reasoningEffort!=='string'||!c.route.reasoningEffort))throw Error('Invalid reasoning');
 if(c.route.maxTokens!==undefined&&(!Number.isSafeInteger(c.route.maxTokens)||c.route.maxTokens<1))throw Error('Invalid maxTokens');
 if(!/^[a-f0-9]{64}$/i.test(c.candidateSha256??''))throw Error('Candidate SHA256 required');
 if(c.timeoutMs!==undefined&&(!Number.isSafeInteger(c.timeoutMs)||c.timeoutMs<100||c.timeoutMs>86400000))throw Error('Invalid deadline');
 return structuredClone(c);
}
export function acquireAttempt(c,bytes){
 const canonical=realpathSync(c.profileDir);
 if(!statSync(canonical).isDirectory()||['desktop','default','sdk','headless','sdk-minimal','web','tui'].includes(basename(canonical).toLowerCase()))throw Error('Existing isolated profile directory required');
 const globalDir=join(canonical,'data','dsh-code-review','sdk-attempts');
 mkdirSync(globalDir,{recursive:true});
 const identity={sessionId:c.sessionId,profile:c.profile,candidateSha256:c.candidateSha256,configSha256:sha(bytes),pid:process.pid};
 writeFileSync(join(globalDir,sha(c.sessionId)+'.lock'),JSON.stringify(identity),{flag:'wx',flush:true});
 mkdirSync(c.outputDir,{recursive:true});
 writeFileSync(join(c.outputDir,'attempt.lock'),JSON.stringify(identity),{flag:'wx',flush:true});
 return()=>writeFileSync(join(c.outputDir,'send-intent.json'),JSON.stringify(identity),{flag:'wx',flush:true});
}
export async function sequence(c,prompt,rpc,intent){
 let initialized=false,firstError;
 try{await rpc('initialize',{cwd:c.cwd,...c.route,approvalRequests:false});initialized=true;intent();const receipt=await rpc('session/prompt',{sessionId:c.sessionId,contentBlocks:[{type:'text',text:prompt}]});await rpc('session/wait',{sessionId:c.sessionId});return receipt;}
 catch(error){firstError=error;throw error;}
 finally{if(initialized)try{await rpc('shutdown',{});}catch(error){if(!firstError)throw error;}}
}
export async function runDriver(configPath){
 if(!isAbsolute(configPath??''))throw Error('Absolute config path required');
 const bytes=readFileSync(configPath),c=validateConfig(JSON.parse(bytes)),prompt=readFileSync(c.promptFile,'utf8');
 if(!prompt.trim())throw Error('Empty prompt');
 if(sha(readFileSync(c.candidatePath)).toLowerCase()!==c.candidateSha256.toLowerCase())throw Error('Candidate hash mismatch');
 const intent=acquireAttempt(c,bytes); // Never removed, even when PID dies or spawn fails.
 const record=(kind,data)=>appendFileSync(join(c.outputDir,'rpc.jsonl'),JSON.stringify(redact({time:new Date().toISOString(),kind,...data}))+NL);
 const meta=(kind,data={})=>{const row=redact({time:new Date().toISOString(),kind,...data});appendFileSync(join(c.outputDir,'metadata.jsonl'),JSON.stringify(row)+NL);console.log(JSON.stringify(row));};
 const code='process.argv.splice(1,0,"dsh");import('+JSON.stringify(pathToFileURL(c.sdkEntry).href)+').then(m=>m.runCli())';
 const child=spawn(c.executable,['-e',code,'--','--profile',c.profile,'--patch',c.overlay],{cwd:c.cwd,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DSH_PROFILE_DIR:c.profileDir},stdio:['pipe','pipe','pipe']});
 let id=0,ended=false;const pending=new Map();
 const rejectAll=e=>{for(const p of pending.values())p.reject(e);pending.clear();};
 let finishExit;const exit=new Promise(r=>{finishExit=r;});
 child.on('error',e=>{ended=true;rejectAll(e);finishExit();meta('spawn-error',{message:e.message});});
 child.on('exit',(code,signal)=>{ended=true;rejectAll(Error('SDK exited before RPC completed'));finishExit();meta('sdk-exit',{code,signal});});
 const rpc=(method,params)=>new Promise((yes,no)=>{if(ended)return no(Error('SDK not running'));const n=++id;pending.set(n,{resolve:yes,reject:no});record('request',{id:n,method,params});meta('rpc-request',{id:n,method});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+NL,e=>{if(e){pending.delete(n);no(e);}});});
 createInterface({input:child.stdout}).on('line',line=>{let f;try{f=JSON.parse(line);}catch{meta('non-rpc-stdout',{bytes:Buffer.byteLength(line)});return;}record('received',{frame:f});if(f.id!=null&&f.method){child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:f.id,error:{code:-32601,message:'Interactive requests disabled'}})+NL);return;}if(f.id!=null){const p=pending.get(f.id);pending.delete(f.id);if(p){meta('rpc-response',{id:f.id,errorCode:f.error?.code});f.error?p.reject(Error('SDK RPC error '+f.error.code)):p.resolve(f.result);}}});
 child.stdout.on('end',()=>rejectAll(Error('SDK stdout closed')));
 child.stdin.on('error',rejectAll);
 createInterface({input:child.stderr}).on('line',line=>record('stderr',{text:/key|token|password|secret|authorization|bearer/i.test(line)?'<sensitive diagnostic omitted>':line}));
 const stop=()=>{rejectAll(Error('Driver interrupted'));child.kill();};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const timer=setTimeout(()=>{meta('deadline');rejectAll(Error('Driver deadline exceeded'));child.kill();},c.timeoutMs??3600000);
 meta('started',{profile:c.profile,sessionId:c.sessionId,candidateSha256:c.candidateSha256,pid:child.pid});
 try{const receipt=await sequence(c,prompt,rpc,intent);meta('completed',{messageId:receipt?.messageId});return receipt;}
 catch(e){meta('failed',{message:e.message});throw e;}
 finally{child.stdin.end();const killer=setTimeout(()=>child.kill(),5000);await exit;clearTimeout(killer);clearTimeout(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)runDriver(process.argv[2]).catch(e=>{console.error(JSON.stringify({kind:'driver-failed',message:redact(e.message)}));process.exitCode=1;});
