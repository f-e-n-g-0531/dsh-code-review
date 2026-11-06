// Offline acceptance of one official public job. No model, credentials or artifact reads.
import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const FILE_STATES = ['completed','excluded','blocked','failed','cancelled','pending','running','interrupted'];
const TERMINAL = ['completed','failed','cancelled','interrupted'];
const count = n => Number.isSafeInteger(n) && n >= 0;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.trim().length > 0;
const list = v => Array.isArray(v) ? v : [];
const invalidCodes = new Set(['RETRIEVAL_PROTOCOL_ERROR','UNSUPPORTED_RETRIEVAL_OPERATION','RETRIEVAL_INVALID_OPERATION']);
function requireValue(ok, message) { if (!ok) throw new TypeError(message); }
function validateExpected(e) {
  const fields = ['sessionId','cwd','provider','model','repositoryUuid','url','baseRevision','targetRevision','eligibleCount','totalCount','expectedBlockedPaths'];
  requireValue(object(e) && Object.keys(e).every(k => fields.includes(k)), 'Invalid expected contract');
  requireValue(fields.slice(0,8).every(k => text(e[k])), 'Expected fixed identity required');
  requireValue(count(e.eligibleCount) && count(e.totalCount) && e.eligibleCount > 0, 'Expected scope counts required');
  requireValue(Array.isArray(e.expectedBlockedPaths) && e.expectedBlockedPaths.every(text) && new Set(e.expectedBlockedPaths).size === e.expectedBlockedPaths.length && e.totalCount === e.eligibleCount + e.expectedBlockedPaths.length, 'Invalid expected blocked scope');
}


// Only exact trees with completed descendant leaves may retire a capacity parent.
// No failed/pending leaf or unrelated typed error can be hidden by supersession.
function capacityGraph(batches, eligible, fail) {
  const byId = new Map(), parents = new Set(), leaves = [], recovered = new Set();
  const before = [];
  const error = (code, batchId) => { before.push(code); fail(code,{batchId}); };
  const parentState = b => ['capacity-superseded','split-before-send'].includes(b?.status);
  for (const b of batches) {
    if (!object(b) || !text(b.id) || byId.has(b.id) || !Array.isArray(b.fileIds) || !b.fileIds.length || b.fileIds.some(id=>!text(id)) || new Set(b.fileIds).size!==b.fileIds.length) { error('INVALID_BATCH',b?.id); continue; }
    byId.set(b.id,b);
  }
  for (const b of byId.values()) {
    if (parentState(b)) {
      parents.add(b.id);
      const children = b.childBatchIds;
      if (!Array.isArray(children) || children.length!==2 || children.some(id=>!text(id)) || new Set(children).size!==2) { error('CAPACITY_CHILDREN_INVALID',b.id); continue; }
      const members=[];
      for(const id of children) {
        const child=byId.get(id);
        if(!child || child.parentBatchId!==b.id) { error('CAPACITY_CHILD_MISSING_OR_REUSED',b.id); continue; }
        if(!child.fileIds.length || child.fileIds.length>=b.fileIds.length || child.fileIds.some(id=>!b.fileIds.includes(id))) error('CAPACITY_CHILD_NOT_PROPER_SUBSET',child.id);
        members.push(...child.fileIds);
      }
      if(members.length!==b.fileIds.length || new Set(members).size!==members.length || b.fileIds.some(id=>!members.includes(id))) error('CAPACITY_MEMBER_UNION_MISMATCH',b.id);
    } else {
      if(b.childBatchIds!==undefined) error('UNEXPECTED_BATCH_CHILDREN',b.id);
      leaves.push(b);
    }
    if(b.parentBatchId!==undefined) {
      const p=byId.get(b.parentBatchId);
      if(!text(b.parentBatchId)||!p||!parentState(p)||!list(p.childBatchIds).includes(b.id)) error('CAPACITY_ORPHAN_BATCH',b.id);
    }
  }
  const visiting=new Set(),done=new Set();
  function complete(id) {
    if(visiting.has(id)){error('CAPACITY_GRAPH_CYCLE',id);return false;}
    if(done.has(id))return recovered.has(id)||byId.get(id)?.status==='completed';
    visiting.add(id);const b=byId.get(id);let ok=!!b;
    if(b&&parentState(b)) { const children=list(b.childBatchIds);ok=children.length===2;for(const child of children)if(!complete(child))ok=false;if(ok)recovered.add(id); }
    else ok=b?.status==='completed';
    visiting.delete(id);done.add(id);return ok;
  }
  for(const id of byId.keys())complete(id);
  const original= [...byId.values()].filter(b=>b.parentBatchId===undefined).flatMap(b=>b.fileIds);
  const terminal=leaves.flatMap(b=>b.fileIds), expected=new Set(eligible.map(f=>f.fileId));
  for(const [kind,members] of [['ROOT',original],['LEAF',terminal]]) if(members.length!==expected.size||new Set(members).size!==members.length||members.some(id=>!expected.has(id))) error('BATCH_'+kind+'_MEMBER_MISMATCH');
  // A broken edge anywhere invalidates all attempted historical waivers.
  if(before.length)recovered.clear();
  for(const b of byId.values())if(!recovered.has(b.id)&&b.status!=='completed')fail('BATCH_INCOMPLETE',{batchId:b.id});
  return {leaves,recovered,parents,valid:before.length===0};
}

/** Engineering-only acceptance. Unknown telemetry is never inferred from prose.
 * A partial report may pass primary engineering gates (e.g. cross-batch coverage),
 * but never gets an overall review/quality pass. This is one run, no retry selector.
 */
export function evaluateReviewAcceptance(job, expected) {
  validateExpected(expected);
  const issues = [], unknowns = [];
  const fail = (code, details = {}) => issues.push({ code, ...details });
  const owner = job?.owner;
  for (const k of ['sessionId','cwd','provider','model']) if (owner?.[k] !== expected[k]) fail('OWNER_IDENTITY_MISMATCH', { field:k });
  if (!object(job) || !text(job.jobId)) fail('INVALID_JOB');
  const terminal = TERMINAL.includes(job?.status);
  if (!terminal) fail('JOB_NOT_TERMINAL');
  else if (job.status !== 'completed') fail('JOB_UNSUCCESSFUL', { status:job.status });
  const r = job?.result?.report;
  if (!object(r)) fail('REPORT_UNAVAILABLE');
  else {
    for (const [field, actual, fixed] of [['provider',r.model?.provider,expected.provider],['model',r.model?.model,expected.model],['repositoryUuid',r.history?.repositoryUuid,expected.repositoryUuid],['url',r.history?.url,expected.url],['baseRevision',r.history?.base,expected.baseRevision],['targetRevision',r.history?.target,expected.targetRevision]]) if (actual !== fixed) fail('REPORT_IDENTITY_MISMATCH', { field });
    if (!text(r.snapshotId)) fail('SNAPSHOT_ID_UNAVAILABLE');
    if (!['completed','partial',...TERMINAL.filter(s => s !== 'completed')].includes(r.status)) fail('INVALID_REPORT_STATUS');
    else if (!['completed','partial'].includes(r.status)) fail('REPORT_UNSUCCESSFUL', { status:r.status });
    if (r.outdated === true) fail('REPORT_OUTDATED');
    else if (r.outdated !== undefined && r.outdated !== false) fail('INVALID_OUTDATED');
  }
  const files = list(r?.files), findings = list(r?.findings), batches = list(r?.orchestration?.batches);
  if (r && (!Array.isArray(r.files) || !Array.isArray(r.findings))) fail('REPORT_ARRAYS_UNAVAILABLE');
  const coverage = Object.fromEntries(FILE_STATES.map(s => [s,0]));
  coverage.total = files.length;
  const ids = new Set(), paths = new Set();
  for (const f of files) {
    if (!object(f) || !text(f.fileId) || !text(f.path) || !FILE_STATES.includes(f.status)) { fail('INVALID_FILE'); continue; }
    if (ids.has(f.fileId) || paths.has(f.path)) fail('DUPLICATE_FILE');
    ids.add(f.fileId); paths.add(f.path); coverage[f.status]++;
  }
  if (coverage.total !== expected.totalCount) fail('SCOPE_TOTAL_MISMATCH');
  if (!object(r?.coverage)) fail('COVERAGE_UNAVAILABLE');
  else {
    if (r.coverage.total !== files.length || Object.entries(coverage).some(([key,value]) => key !== 'total' && value > 0 && r.coverage[key] !== value)) fail('COVERAGE_INCOMPLETE');
    for (const [key,value] of Object.entries(r.coverage)) {
      if (!Object.hasOwn(coverage,key) || !count(value) || value !== coverage[key]) fail('COVERAGE_MISMATCH', { field:key });
    }
  }
  if (r?.totalFiles !== undefined && r.totalFiles !== files.length) fail('FILE_PAGE_INCOMPLETE');
  if (r?.totalFindings !== undefined && r.totalFindings !== findings.length) fail('FINDING_PAGE_INCOMPLETE');
  for (const f of findings) if (!object(f) || !ids.has(f.fileId)) fail('FINDING_MEMBER_MISMATCH');
  const expectedBlocks = new Set(expected.expectedBlockedPaths);
  const blocked = files.filter(f => f?.status === 'blocked');
  if (blocked.length !== expectedBlocks.size || blocked.some(f => !expectedBlocks.has(f.path)) || expected.expectedBlockedPaths.some(p => !blocked.some(f => f.path === p))) fail('BLOCKED_SCOPE_MISMATCH');
  const eligible = files.filter(f => !expectedBlocks.has(f?.path));
  if (eligible.length !== expected.eligibleCount) fail('ELIGIBLE_COUNT_MISMATCH');
  const unfinished = eligible.filter(f => f?.status !== 'completed' || f.primaryStatus && f.primaryStatus !== 'completed');
  if (unfinished.length) fail('ELIGIBLE_PRIMARY_INCOMPLETE', { count:unfinished.length });
  const graph = r?.orchestration?.strategy === 'whole-scope' || batches.length ? capacityGraph(batches,eligible,fail) : {leaves:[],recovered:new Set(),parents:new Set(),valid:true};
  const terminalBatches = graph.leaves;
  const historicalCapacity = batches.filter(b=>graph.recovered.has(b?.id));
  for(const v of list(r?.orchestration?.verifications)) if(v?.status!=='completed') fail('VERIFICATION_STAGE_INCOMPLETE');
  for(const f of findings) if(f?.verification?.status!=='completed') fail('FINDING_VERIFICATION_INCOMPLETE');
  const typedRecords = [...files,...batches,...list(r?.orchestration?.verifications),...list(r?.limitations)];
  const codes = {};
  let invalidKnown = 0;
  const historicalCodes = {};
  for (const item of typedRecords) {
    const recovered = historicalCapacity.includes(item);
    const allowed = code => recovered && (item.status === 'capacity-superseded' ? code === 'CHILD_FOLLOWUP_CAPACITY' : code === 'WHOLE_SCOPE_INPUT_BUDGET');
    for (const code of [item?.failureCode,item?.code,...list(item?.retrievalLimits).map(x => x?.code)].filter(text)) {
      const target = allowed(code) ? historicalCodes : codes;
      target[code] = (target[code] ?? 0) + 1;
      if (invalidCodes.has(code)) invalidKnown++;
    }
    if (item?.failureCode && !text(item.failureCode)) fail('INVALID_FAILURE_CODE');
    if (item?.failureCode && !allowed(item.failureCode)) fail('TYPED_STAGE_FAILURE', { failureCode:item.failureCode });
    if (item?.retrievalLimited === true && !(recovered && list(item.retrievalLimits).length > 0 && item.retrievalLimits.every(l=>allowed(l?.code)))) fail('RETRIEVAL_LIMITED');
    if (list(item?.retrievalLimits).some(l=>!allowed(l?.code))) fail('TYPED_RETRIEVAL_LIMIT');
    for (const field of ['requiredBytes','approvedCap']) if (item?.[field] !== undefined && !count(item[field])) fail('INVALID_BUDGET_VALUE', { field });
    if (count(item?.requiredBytes) && count(item?.approvedCap) && item.requiredBytes > item.approvedCap && !recovered) fail('TYPED_INPUT_CAPACITY_EXCEEDED');
  }
  // This explicitly scoped counter, if supplied, can establish a zero. Its absence
  // cannot be replaced by string searching limitations or model-written prose.
  const invalidCounter = r?.diagnostics?.retrievalInvalidReport;
  if (invalidCounter !== undefined && !count(invalidCounter)) fail('INVALID_RETRIEVAL_COUNTER');
  if (invalidKnown || count(invalidCounter) && invalidCounter > 0) fail('RETRIEVAL_PROTOCOL_INVALID');
  const telemetry = r?.diagnostics?.retrievalProtocolTelemetry;
  const completeTelemetry = object(telemetry) && telemetry.scope === 'all-child-tool-generations' && telemetry.complete === true && count(telemetry.invalidRequests);
  if (completeTelemetry && telemetry.invalidRequests > 0) fail('RETRIEVAL_PROTOCOL_INVALID');
  const retrievalInvalidReport = invalidKnown || count(invalidCounter) && invalidCounter > 0 || completeTelemetry && telemetry.invalidRequests > 0 ? 'invalid' : completeTelemetry && telemetry.invalidRequests === 0 ? 'none-reported' : 'unknown';
  if (retrievalInvalidReport === 'unknown') unknowns.push('RETRIEVAL_INVALID_REPORT_UNAVAILABLE');
  const reportedCalls = r?.modelCalls;
  if (reportedCalls !== undefined && !count(reportedCalls)) fail('INVALID_MODEL_CALL_COUNT');
  const receipts = list(job?.checkpoints).filter(c => c?.stage === 'host-child-complete');
  const receiptCalls = receipts.reduce((n,c) => n + (count(c.modelCalls) ? c.modelCalls : 0),0);
  const parentCalls = list(job?.checkpoints).filter(c => c?.stage === 'model-end').length;
  const started = list(r?.orchestration?.childrenStarted);
  if (started.some(c => !text(c?.childId)) || new Set(started.map(c => c.childId)).size !== started.length) fail('INVALID_CHILD_START_RECORDS');
  const allChildren = new Set([...started.map(c => c.childId),...batches.map(b => b?.childId).filter(text)]);
  const failureCodes = {};
  for (const f of files) if (text(f?.failureCode)) failureCodes[f.failureCode] = (failureCodes[f.failureCode] ?? 0) + 1;
  const knownFailure = issues.length > 0;
  const result = !terminal ? 'incomplete' : knownFailure ? 'failed' : unknowns.length ? 'incomplete' : 'passed';
  return { schemaVersion:1, kind:'single-run-engineering-acceptance', jobId:job?.jobId ?? null,
    engineeringResult:result, jobStatus:job?.status ?? null, reportStatus:r?.status ?? null,
    issues, unknowns, coverage, eligible:{ expected:expected.eligibleCount, loaded:eligible.length, completed:eligible.length-unfinished.length, unfinished:unfinished.length },
    fileFailureCodes:failureCodes, typedCodeOccurrences:codes, retrievalInvalidReport,
    capacityRecovery:{ graphValid:graph.valid,currentLeafCount:graph.leaves.length,historicalParentCount:graph.parents.size,recoveredParentCount:graph.recovered.size,historicalCodeOccurrences:historicalCodes,parents:batches.filter(b=>graph.parents.has(b?.id)).map(b=>({id:b.id,recovered:graph.recovered.has(b.id),status:b.status,fileIds:[...b.fileIds],childBatchIds:[...list(b.childBatchIds)],failureCode:b.failureCode??null,retrievalLimited:b.retrievalLimited??false,retrievalLimits:structuredClone(list(b.retrievalLimits)),retrievalAudit:structuredClone(list(b.retrievalAudit)),requiredBytes:b.requiredBytes??null,approvedCap:b.approvedCap??null})) },
    batches:terminalBatches.map(b => ({ id:b?.id ?? null, status:b?.status ?? null, members:list(b?.fileIds).length, failureCode:b?.failureCode ?? null, requiredBytes:b?.requiredBytes ?? null, approvedCap:b?.approvedCap ?? null })),
    operations:{ reportedModelCalls:count(reportedCalls)?reportedCalls:null, childrenStarted:allChildren.size,
      childStartEvidence:started.length ? 'report.orchestration.childrenStarted' : batches.length ? 'report.orchestration.batches.childId (creation receipts unavailable)' : 'unavailable',
      completedChildReceiptCalls:receiptCalls, parentModelEndRecords:parentCalls,
      completionReceiptCallDifference:count(reportedCalls)?reportedCalls-receiptCalls-parentCalls:null,
      callEvidenceNotice:'Completion receipts omit failed-child invocations; difference is not inferred as zero or assigned to a child.',
      executionWallMs:count(r?.diagnostics?.executionWallMs)?r.diagnostics.executionWallMs:null },
    quality:{ adjudication:'unadjudicated', qualityPassed:null, precision:null, recall:null, truePositive:null, falsePositive:null, harmfulFindingRate:null },
    overallReviewPassed:false, notice:'One run only. Keep every attempted failure; engineering completion is not defect-quality approval. No prose-based status or budget inference.' };
}

function forbiddenArtifacts(p) { return p.split(/[\\/]/).some(part => part.toLowerCase() === 'artifacts'); }
/** Copies one public job without fetching any referenced artifact or starting a model.
 * A new output directory is mandatory: existing evidence is never overwritten.
 */
export async function collectReviewAcceptance(config) {
  requireValue(object(config) && Object.keys(config).every(k => ['jobFile','outputDir','expected'].includes(k)) && text(config.jobFile) && text(config.outputDir), 'Invalid collector config');
  validateExpected(config.expected);
  requireValue(!forbiddenArtifacts(config.jobFile), 'Private artifacts path refused');
  const source = await realpath(config.jobFile);
  requireValue(!forbiddenArtifacts(source), 'Resolved private artifacts path refused');
  requireValue((await stat(source)).isFile(), 'Public job must be a regular file');
  const raw = await readFile(source,'utf8'), job = JSON.parse(raw);
  const evaluation = evaluateReviewAcceptance(job,config.expected);
  const outputDir = path.resolve(config.outputDir);
  requireValue(!forbiddenArtifacts(outputDir), 'Artifacts output path refused');
  // mkdir without recursive/wx files rejects collisions and symlink destinations.
  await mkdir(outputDir);
  const write = (name,body) => writeFile(path.join(outputDir,name),body,{encoding:'utf8',flag:'wx'});
  await write('full-public-result.json',raw);
  if (object(job.result?.report)) await write('report.json',JSON.stringify(job.result.report,null,2)+'\n');
  if (typeof job.result?.markdown === 'string') await write('brief.md',job.result.markdown);
  if (typeof job.result?.technicalMarkdown === 'string') await write('technical.md',job.result.technicalMarkdown);
  const final = { ...evaluation, provenance:{ jobSha256:createHash('sha256').update(raw).digest('hex'), sourceJob:source, copyPolicy:'Exact public job bytes; no referenced artifacts accessed', reportAvailable:object(job.result?.report), briefAvailable:typeof job.result?.markdown==='string', technicalAvailable:typeof job.result?.technicalMarkdown==='string' } };
  await write('engineering-result.json',JSON.stringify(final,null,2)+'\n');
  const summary = ['# Engineering acceptance: '+final.engineeringResult,'',
    'Job: '+final.jobStatus+'; report: '+final.reportStatus+'. Driver completion is not product acceptance.',
    'Eligible primary completion: '+final.eligible.completed+'/'+final.eligible.expected+'.',
    'Coverage: '+JSON.stringify(final.coverage),
    'Typed file failures: '+JSON.stringify(final.fileFailureCodes),
    'Retrieval invalid telemetry: '+final.retrievalInvalidReport+'.',
    'Reported model calls: '+final.operations.reportedModelCalls+'; children started: '+final.operations.childrenStarted+'.',
    'Issues: '+[...new Set(final.issues.map(i=>i.code))].join(', '),
    'Unknowns: '+final.unknowns.join(', '),
    'Quality unknown: no expert gold; supported finding counts are not TP. No overall review approval.',''];
  await write('engineering-summary.md',summary.join('\n'));
  return final;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    requireValue(process.argv.length === 4 && process.argv[2] === '--config', 'Usage: node scripts/collect-review-acceptance.mjs --config external-config.json');
    const config = JSON.parse(await readFile(process.argv[3],'utf8'));
    const result = await collectReviewAcceptance(config);
    console.log(JSON.stringify({engineeringResult:result.engineeringResult,coverage:result.coverage,quality:result.quality}));
    process.exitCode = result.engineeringResult === 'passed' ? 0 : 1;
  } catch { console.error('Acceptance collection refused or failed; no retry/model invocation performed.'); process.exitCode = 2; }
}
