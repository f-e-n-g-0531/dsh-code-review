// Run with installed Electron ELECTRON_RUN_AS_NODE=1; never mounts into the live host.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { createHostReviewChildren } from '../src/host-review-children.mjs';
import { attachReviewChildMiddleware } from '../src/review-child-broker.mjs';
import { registerSnapshotTool } from '../src/review-child-plugin.mjs';
const host = process.argv[2];
if (!host || !process.versions.electron) throw new Error('Use installed Electron in RUN_AS_NODE mode and pass its ASAR dsh directory');
const load = name => import(pathToFileURL(path.join(host, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { Context } = await load('cordis');
const { LlmAdapter } = await load('dsh-llm');
const ctx = new Context();
const keepAlive = setInterval(() => {}, 1000);
const timeout = setTimeout(() => { console.error('Offline child smoke timed out'); process.exit(1); }, 45000);
const groupMode = process.argv.includes('--group');
const finalResult = groupMode ? {reviews:[{fileId:'file-1',findings:[],limitations:[]}],limitations:[]} : {findings:[],limitations:[]};
const calls = new Map(), observations = [], active = new Set(), hostEvents = [];
ctx.on('session/event',(session,event)=>{if(['turn/end','error','llm/error'].includes(event.type))hostEvents.push({id:session.id,event});});
let overlap = false, release;
const barrier = new Promise(resolve => { release = resolve; });
class OfflineAdapter extends LlmAdapter {
  async *stream(options) {
    assert.equal(options.provider, 'offline-child-smoke');
    assert.equal(options.model, 'none');
    const names = options.tools.map(t => t.name).sort();
    assert.deepEqual(names, ['review_snapshot', 'structured_output']);
    const id = options.sessionId, n = (calls.get(id) ?? 0) + 1;
    calls.set(id, n); assert.ok(n <= 2);
    observations.push({ childId: id, call: n, tools: names, messages: options.messages.length });
    if (n === 1) {
      active.add(id); if (active.size === 2) { overlap = true; release(); }
      await barrier;
    } else {
      assert.match(JSON.stringify(options.messages), /OFFLINE_APPROVED_SNAPSHOT/);
    }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'offline-' + id + '-' + n,
      name: n === 1 ? 'review_snapshot' : 'structured_output',
      arguments: JSON.stringify(n === 1 ? { requests: [{kind:'read',id:'source-1',start:1,count:1}] } : finalResult) } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}
let parentHandle, transport;
try {
  // All registries, loop, Inbox, schema validation, native dispatch and settlement are installed host implementations.
  for (const [name, config] of [
    ['dsh-session', {}], ['dsh-session-projection', {}], ['dsh-agent', {}],
    ['dsh-system-prompt', {includeRuntimeContext:false}], ['dsh-tools', {}],
    ['dsh-llm', {}], ['dsh-agent-loop', {}],
  ]) await ctx.plugin((await load(name)).default, config).await();
  // Offline cwd seam only; real Session header still records the exact cwd.
  ctx.provide('workingDirectory'); ctx.set('workingDirectory', {get:session=>session.header.cwd ?? process.cwd(),set:async()=>{}});
  const { Loader } = await load('cordis-plugin-loader');
  const loader = new Loader(ctx, {baseUrl:pathToFileURL(path.join(host,'package.json')).href});
  // Isolated resolver: only the tested repo child export and installed ASAR packages.
  // No installed package, profile, or live runtime is modified.
  const manifest = JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(typeof manifest.exports['./child'],'string');
  loader.internal = { import: async name => name === '@feng0531/dsh-code-review/child'
    ? import(new URL('../'+manifest.exports['./child'],import.meta.url).href) : load(name.replace('@deepseek-ai/','')) };
  await ctx.plugin((await load('dsh-agent-preset-registry')).default, {default:'offline-empty'}).await();
  await ctx.plugin((await load('dsh-subagent')).default, {maxDepth:1,maxActiveSubagents:2}).await();
  await ctx.plugin(await load('dsh-subagent-spawn-in-process'), {}).await();
  await ctx.fiber.await();
  ctx.llm.registerAdapter(['offline-child-smoke'], new OfflineAdapter());
  // Deliberately inherited dangerous capability: must never reach a restricted child.
  ctx.tools.register({name:'offline_forbidden_shell',description:'Forbidden sentinel',parameters:{type:'object',properties:{},additionalProperties:false},
    output:{schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},render:()=>[]},
    execute(){throw new Error('Forbidden inherited tool executed');}});
  registerSnapshotTool(ctx);
  attachReviewChildMiddleware(ctx);
  await ctx.agentPresets.register({id:'offline-empty',name:'Offline parent',plugins:[{name:'@deepseek-ai/dsh-tool-executor-native'}]});
  parentHandle = await ctx.agents.create('offline-parent', {provider:'offline-child-smoke',model:'none'}, {cwd:process.cwd()});
  const parent = parentHandle.agent;
  assert.equal(ctx.agents.get(parent.id), parent);
  await assert.rejects(ctx.tools.get('review_snapshot').execute({requests:[]},{agent:parent,signal:new AbortController().signal}), /ownership|reservation|session|binding|match/i);
  transport = createHostReviewChildren(ctx); assert.equal(transport.capability(),true);
  const signal = new AbortController().signal;
  let reservations = 0, reads = 0;
  const scope = () => ({
    catalog:()=>[{id:'source-1'}], budget:()=>({remainingCalls:4}), preflight:()=>{}, transaction:fn=>fn(),
    read:() => { reads++; return {snapshotId:'offline-snapshot',sourceId:'source-1',hash:'offline',start:1,count:1,text:'OFFLINE_APPROVED_SNAPSHOT'}; },
  });
  const children = await Promise.all([0,1].map(()=>transport.create({parent,route:{provider:'offline-child-smoke',model:'none'},cwd:process.cwd(),signal})));
  try {
    const results = await Promise.all(children.map(child=>child.runPrimary({
      request:{instructions:'Offline lifecycle test only.',input:JSON.stringify({snapshotId:'offline-snapshot',...(groupMode?{sourceMode:'group-primary',files:[{id:'file-1'}]}:{file:{id:'file-1'}})})},
      scope:scope(), maxRounds:2,maxInputBytes:1000000,reserveModelCall:()=>{reservations++;},
    })));
    assert.deepEqual(results,[finalResult,finalResult]);
    assert.equal(overlap,true);assert.equal(reads,2);assert.equal(reservations,4);
    assert.equal(calls.size,2);assert.ok([...calls.values()].every(n=>n===2));
  } finally { await Promise.all(children.map(child=>child.dispose())); }
  for(const child of children) assert.equal(ctx.agents.get(child.childId),undefined);
  const evidence = {status:'passed',realProviderCalls:0,realHostLoop:true,realNativeExecutor:true,realPresetRegistry:true,isolatedResolver:true,offlineCwdSeam:true,groupMode,overlap,reads,reservations,observations};
  if(process.argv[3]) await writeFile(process.argv[3],JSON.stringify(evidence,null,2)+String.fromCharCode(10));
  console.log(JSON.stringify(evidence,null,2));
} catch (error) {
  process.exitCode = 1;
  const evidence = {status:'failed',code:error.code,message:error.message,observations,hostEvents};
  if(process.argv[3]) await writeFile(process.argv[3],JSON.stringify(evidence,null,2)+String.fromCharCode(10));
  console.error(error);
} finally {
  try { await transport?.dispose(); await parentHandle?.dispose(); await ctx.fiber.dispose(); }
  finally { clearTimeout(timeout);clearInterval(keepAlive); }
}
