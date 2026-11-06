import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFile,symlink,unlink} from 'node:fs/promises';
const host=process.argv[2],root=path.resolve(process.argv[3]),out=process.argv[4];
const rootBinderMode=process.argv.includes('--root-binder');
const manifestPath=path.join(root,'manifest.json');
const guardUrl=pathToFileURL(path.join(path.dirname(root),'evidence.guard.mjs')).href;
const load=name=>import(pathToFileURL(path.join(host,'node_modules/@deepseek-ai',name,'lib/index.js')).href);
const {Context}=await load('cordis');const {LlmAdapter,createUserMessage}=await load('dsh-llm');
const ctx=new Context(),keep=setInterval(()=>{},1000),timer=setTimeout(()=>process.exit(1),45000);
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
const source=path.resolve(root,manifest.entries.find(x=>x.file.endsWith('.cpp'))?.file??manifest.entries[0].file);
const probes=[
 {label:'manifest',name:'read',args:{file_path:manifestPath,limit:2},allow:true},
 {label:'source',name:'read',args:{file_path:source,limit:2},allow:true},
 {label:'glob',name:'glob',args:{path:root,pattern:'**/*.cpp'},allow:true},
 {label:'grep',name:'grep',args:{path:root,pattern:'C3',include:'*.cpp'},allow:true},
 {label:'outside-repo',name:'read',args:{file_path:'G:/dsh-code-review/package.json'},allow:false},
 {label:'outside-report',name:'read',args:{file_path:'G:/dsh-session-analysis/c7199593/attempt03/full-public-result.json'},allow:false},
 {label:'relative',name:'read',args:{file_path:'manifest.json'},allow:false},
 {label:'parent-path',name:'read',args:{file_path:root+'/../evidence.guard.mjs'},allow:false},
 {label:'unsafe-glob',name:'glob',args:{path:root,pattern:'../*'},allow:false},
 {label:'outside-grep',name:'grep',args:{path:'G:/dsh-code-review',pattern:'version'},allow:false},
];
let handle,step=0;const results=[],hookShapes=[],turns=[];ctx.on('session/event',(session,event)=>{if(event.type==='turn/end')turns.push(event.data);});
class Fake extends LlmAdapter{async *stream(options){assert.deepEqual(options.tools.map(x=>x.name).sort(),['glob','grep','read']);
 if(step>0){const tool=options.messages.filter(x=>x.role==='tool').at(-1);assert.ok(tool);const p=probes[step-1];assert.equal(!!tool.isError,!p.allow,p.label);if(!p.allow)assert.match(JSON.stringify(tool),/Outside approved evidence capabilities/);results.push({label:p.label,name:p.name,allowed:!tool.isError});}
 if(step===probes.length){yield{type:'text-delta',text:'offline-complete'};yield{type:'finish',reason:{kind:'stop'}};return;}
 const p=probes[step++];yield{type:'block-end',index:0,block:{type:'tool-call',id:'probe-'+step,name:p.name,arguments:JSON.stringify(p.args)}};yield{type:'finish',reason:{kind:'tool-calls'}};
}}
try{
 for(const name of ['dsh-session','dsh-session-projection','dsh-agent','dsh-system-prompt','dsh-tools','dsh-llm','dsh-agent-loop','dsh-fs-local','dsh-subprocess-local'])await ctx.plugin((await load(name)).default,{}).await();
 ctx.provide('workingDirectory');ctx.set('workingDirectory',{ensure:async()=>root,get:()=>root});
 await ctx.plugin(await load('dsh-tool-fs'),{read:true,write:false,edit:false,readImage:false,applyPatch:false}).await();
 await ctx.plugin(await load('dsh-tool-fs-search'),{sampleOverCapGlobResults:false}).await();
 ctx.llm.registerAdapter(['neutral-offline'],new Fake());
 const {Loader}=await load('cordis-plugin-loader');const loader=new Loader(ctx,{baseUrl:pathToFileURL(path.join(host,'package.json')).href});loader.internal={import:name=>name==='neutral-guard'?import(guardUrl):load(name.replace('@deepseek-ai/',''))};
 await ctx.plugin((await load('dsh-agent-preset-registry')).default,{default:'neutral'}).await();
 await ctx.agentPresets.register({id:'neutral',name:'Neutral guard smoke',plugins:[{name:'@deepseek-ai/dsh-tool-executor-native'},{name:'neutral-guard',config:{root,manifest:manifestPath,manifestSha256:'2eafcf2cfa5543b025879b53d6925cfe2e61a4018230f888eb65e377ea45f591'}}]});
 if(rootBinderMode){
   await ctx.plugin(await import(pathToFileURL(path.join(path.dirname(root),'control-binder.mjs')).href),{presetId:'neutral',root,manifest:manifestPath,manifestSha256:'2eafcf2cfa5543b025879b53d6925cfe2e61a4018230f888eb65e377ea45f591'}).await();
   ctx.tools.register({name:'offline_shell_sentinel',description:'Forbidden inherited capability',parameters:{type:'object',properties:{}},output:{schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok']},render:()=>[]},execute(){throw Error('sentinel executed');}});
 }
 handle=await ctx.agents.create({sessionId:'neutral-smoke',agentOptions:{provider:'neutral-offline',model:'none'},meta:{cwd:root},...(rootBinderMode?{}:{setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,'neutral');}})});
 if(rootBinderMode)assert.equal(ctx.agentPresets.composedPreset(handle.agent.ctx),'neutral');
 handle.agent.ctx.on('tools/pre-execute',(exec,next)=>{hookShapes.push({name:exec.name,hasArguments:typeof exec.arguments==='object'});return next();});
 handle.agent.followup(createUserMessage({content:[{type:'text',text:'Run offline capability probes.'}],source:{kind:'user'}}));await handle.agent.whenIdle();
 assert.equal(results.length,probes.length);assert.ok(hookShapes.every(x=>x.hasArguments));
 const evidence={status:'passed',realProviderCalls:0,actualHostNativeTools:true,guardScopedPreset:true,rootBinderMode,explicitSetupMount:!rootBinderMode,modelVisible:['read','glob','grep'],results,hookShapes,symlink:'not-yet-tested',boundary:'Custom manifest guard, not stock readonly confinement.'};
 await (await import('node:fs/promises')).writeFile(out,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}catch(error){process.exitCode=1;console.error(error);await(await import('node:fs/promises')).writeFile(out,JSON.stringify({status:'failed',message:error.message,results,hookShapes,turns},null,2));}
finally{await handle?.dispose();await ctx.fiber.dispose();clearTimeout(timer);clearInterval(keep);}
