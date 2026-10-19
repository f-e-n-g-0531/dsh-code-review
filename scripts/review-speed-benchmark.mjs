// Offline scheduler benchmark: identical approved mock snapshots, simulated provider latency.
// Not a real-provider throughput or review-quality benchmark. No repository mutation or network.
import { performance } from 'node:perf_hooks';
import { reviewProjectBatches } from '../src/project-execution.mjs';
const batches = Array.from({length:12},(_,i)=>({id:'b'+i,vcs:'git',projectScope:{mode:'project'},context:[],files:[{id:'f'+i,path:i+'.js',reviewMode:'project',eligibility:'reviewable',properties:[],left:{text:''},right:{text:'const value = '+i+';'}}]}));
async function measure(concurrency) {
 let calls=0,active=0,peak=0;
 const start=performance.now();
 const results=await reviewProjectBatches(batches,async request=>{
  calls++;active++;peak=Math.max(peak,active);
  try {await new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(request.signal.reason);};const timer=setTimeout(()=>{request.signal.removeEventListener('abort',abort);resolve();},40);request.signal.addEventListener('abort',abort,{once:true});});return {findings:[],limitations:[]};}
  finally {active--;}
 },{concurrency,remainingCalls:()=>100-calls});
 return {concurrency,elapsedMs:Math.round(performance.now()-start),modelCalls:calls,peakInFlight:peak,completed:results.reduce((n,r)=>n+r.coverage.completed,0),paths:results.flatMap(r=>r.files.map(f=>f.path))};
}
const serial=await measure(1),parallel=await measure(3);
if(JSON.stringify(serial.paths)!==JSON.stringify(parallel.paths)||serial.completed!==parallel.completed||serial.modelCalls!==parallel.modelCalls)throw new Error('Benchmark work or output order differs');
console.log(JSON.stringify({mock:true,network:false,simulatedModelLatencyMs:40,batches:12,serial,parallel,speedup:Number((serial.elapsedMs/parallel.elapsedMs).toFixed(2)),notice:'Offline latency simulation only; real speed depends on provider concurrency, rate limits and batch balance. Same model-call count, no token-cost reduction promised.'},null,2));
