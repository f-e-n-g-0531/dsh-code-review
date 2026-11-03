import test from 'node:test';
import assert from 'node:assert/strict';
import { readabilityMarkdown, limitationDetailsMarkdown } from '../src/report-readability.mjs';
const main = report => readabilityMarkdown(report).join('\n');
const appendix = report => limitationDetailsMarkdown(report).join('\n');

test('same text aggregates counts while preserving paths stages and full original records', () => {
  const report = {files:[{fileId:'a',path:'src/a.cpp',status:'completed'},{fileId:'b',path:'src/b.cpp',status:'completed'}],limitations:[{text:'same',fileId:'a',stage:'primary',extra:{retained:true}},{text:'same',fileId:'b',stage:'verification'},{text:'same',fileId:'<unknown>',stage:'future'}]};
  const text=appendix(report);
  assert.match(text,/限制（3 条记录）/); assert.match(text,/src\/a/); assert.match(text,/src\/b/);
  assert.match(text,/未知文件身份：&lt;unknown&gt;/); assert.match(text,/阶段：主审/); assert.match(text,/阶段：独立复核/);
  assert.match(text,/retained/); assert.match(text,/非缺陷数/); assert.equal((text.match(/<pre>/g)??[]).length,2);
  assert.match(main(report),/不表示全部查完/);
});

test('all incomplete file states and downstream stages are detected independently', () => {
  const cases=[...['pending','blocked','failed','cancelled'].map(status=>({status})),{stageFailures:[{phase:'window-synthesis',code:'MODEL_TIMEOUT'}]},{retrievalLimited:true},{windowCoverage:{pending:['w']}},{synthesisStatus:'failed'},{verificationStatus:'pending'},{reviewPasses:[{status:'completed'},{status:'pending'}]}];
  const files=cases.map((extra,i)=>({fileId:'f'+i,path:'path'+i,status:'completed',...extra}));
  files.push({fileId:'verify',path:'candidate',status:'completed'},{path:'excluded',status:'excluded'},{path:'done',status:'completed'});
  const report={files,findings:[{fileId:'verify',verification:{status:'pending'}}]};
  assert.match(main(report),/未完成条目：11 条记录/);
  const text=appendix(report); for(let i=0;i<10;i++) assert.ok(text.includes('path'+i));
  assert.match(text,/candidate/); assert.doesNotMatch(text,/excluded|"done"/);
});

test('round calls bytes input unsupported and unknown reasons remain distinct', () => {
  for(const [code,label] of [['RETRIEVAL_ROUND_BUDGET_EXCEEDED','单阶段检索轮数达到上限'],['READER_CALL_BUDGET_EXCEEDED','阶段分配或共享读取调用次数不足'],['READER_OUTPUT_BUDGET_EXCEEDED','阶段分配或共享读取输出字节预算不足'],['input-budget','阶段输入预算不足'],['unsupported','当前不支持'],['new-reason','未知／其他原因']]) assert.ok(main({files:[{path:'a',status:'pending',failureCode:code}]}).includes(label));
  assert.match(main({files:[{status:'pending'}]}),/原因未记录/);
});

test('interactions group by reason and map paths without dumping group IDs', () => {
  const report={files:[{fileId:'a',path:'a.cpp',status:'completed'}],interactions:[{groupId:'RAW_GROUP_1',fileIds:['a'],status:'pending',reason:'dependency-incomplete'},{groupId:'RAW_GROUP_2',fileIds:['missing'],status:'blocked',reason:'dependency-incomplete'},{groupId:'DONE',status:'completed'}]};
  const text=main(report); assert.match(text,/依赖的主审或前置阶段未完成：2 条/); assert.ok(text.includes('a\\.cpp')); assert.match(text,/missing/);
  assert.doesNotMatch(text,/RAW_GROUP|阶段输入预算不足|DONE/); assert.match(appendix(report),/RAW_GROUP_1/);
});

test('bounded body states remainder while appendix retains every full path', () => {
  const files=Array.from({length:20},(_,i)=>({fileId:'id'+i,path:'file-'+i,status:'pending',reason:'same'})),report={files};
  assert.match(main(report),/另有 16 个路径／身份/); assert.ok(!main(report).includes('file\\-19'));
  for(const file of files) assert.ok(appendix(report).includes(JSON.stringify(file.path)));
  assert.match(main(report),/全部路径、身份、阶段及原始记录见本报告限制附录/);
});

test('HTML Markdown and controls cannot break out of JSON details', () => {
  const hostile='</pre></details><script>x</script>[x](javascript:bad)'+String.fromCharCode(96)+'~~~\n# title';
  const report={files:[{fileId:'f',path:hostile,status:'pending',reason:hostile}],limitations:[{text:hostile,fileId:'f',unknown:hostile}]};
  for(const text of [main(report),appendix(report)]) { assert.doesNotMatch(text,/<script>|<\/pre><\/details>/); assert.ok(text.includes('&lt;script&gt;')); assert.ok(text.includes('\\[x\\]\\(javascript:bad\\)')); assert.ok(text.includes('\\'+String.fromCharCode(96))); }
});

test('deterministic nonmutating render retains unknown and legacy JSON records', () => {
  const report={files:[],limitations:[null,'legacy',{unknown:{id:'x'}},{text:'',fileIds:['unknown'],stage:'future'}]},before=structuredClone(report);
  assert.deepEqual(readabilityMarkdown(report),readabilityMarkdown(report)); const text=appendix(report); assert.deepEqual(report,before);
  assert.equal((text.match(/<pre>/g)??[]).length,6); assert.match(text,/legacy/); assert.match(text,/unknown/);
  assert.deepEqual(readabilityMarkdown(),readabilityMarkdown({}));
});

test('local reader allocation failures do not claim shared exhaustion', () => {
  for (const code of ['READER_CALL_BUDGET_EXCEEDED', 'READER_OUTPUT_BUDGET_EXCEEDED']) {
    const report = { readerBudget: { remainingCalls: 50, remainingBytes: 9000 }, files: [{ path: 'dir/', status: 'pending', failureCode: code }] };
    assert.match(main(report), /阶段分配或共享/);
    assert.doesNotMatch(main(report), /共享.*达到上限|共享.*耗尽/);
    assert.match(main(report), /未完成条目/);
  }
});

test('pending retrieval evidence replaces missing cause and deduplicates body path reason', () => {
  for (const failureCode of [undefined, 'RETRIEVAL_ROUND_BUDGET_EXCEEDED']) {
    const report = {files:[{path:'dir/',status:'pending',failureCode,retrievalLimited:true,groupRetrievalLimits:[{code:'RETRIEVAL_ROUND_BUDGET_EXCEEDED',stage:'primary'}]}]};
    const text=main(report);
    assert.doesNotMatch(text,/原因未记录/);
    assert.equal((text.match(/单阶段检索轮数达到上限/g)??[]).length,1);
    assert.equal((text.match(/dir\//g)??[]).length,1);
  }
});

test('unknown long causes stay out of body and partial status cannot imply completion', () => {
  const long='UNKNOWN_ORIGINAL_'+'z'.repeat(4000);
  const report={files:[{path:'p',status:'pending',reason:long}]};
  assert.doesNotMatch(main(report),/UNKNOWN_ORIGINAL_/);
  assert.ok(appendix(report).includes(long));
  for(const extra of [{partial:true},{limitations:['restricted']}]) {
    assert.match(main({files:[],...extra}),/不表示全部查完/);
    assert.doesNotMatch(main({files:[],...extra}),/未记录未完成条目/);
  }
});

test('appendix stores shared long text once and packs scope duplicates losslessly', () => {
  const text='UNIQUE_LIMIT_'+ 'q'.repeat(4000);
  const first={text,path:'p',stage:'primary',extra:{keep:'<safe>'}};
  const report={limitations:[first,{...first},{text,path:'other',stage:'verification',extra:17}],files:[{path:'p',status:'pending',reason:'mystery',source:'HUGE_SOURCE_TOKEN',candidates:[{source:'HUGE_CANDIDATE_TOKEN'}]}]};
  const rendered=appendix(report);
  assert.equal(rendered.split(text).length-1,1);
  assert.match(rendered,/重复次数：2/);
  assert.match(rendered,/&lt;safe&gt;/);
  assert.match(rendered,/positions/);
  assert.match(rendered,/other/);
  assert.doesNotMatch(rendered,/HUGE_SOURCE_TOKEN|HUGE_CANDIDATE_TOKEN/);
  assert.doesNotMatch(rendered,/<details open/);
  assert.deepEqual(report.limitations[0],first);
});

test('shared-text packing reconstructs record differences and duplicate positions', () => {
  const records=[{text:'shared',path:'p',extra:1},'shared',{text:'shared',path:'p',extra:1},{text:'shared',path:'q',extra:2}];
  const rendered=appendix({limitations:records});
  const pre=[...rendered.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map(match=>JSON.parse(match[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')));
  const restored=[];
  for (const {record,positions} of pre[1]) for(const position of positions) restored[position]=record.type==='string'?pre[0]:record.type==='object-with-shared-text'?{...record.fields,text:pre[0]}:record.value;
  assert.deepEqual(restored,records);
  const missingText=appendix({limitations:[{text:null,extra:1},{extra:2}]});
  assert.match(missingText,/&quot;|"text": null/);
});
