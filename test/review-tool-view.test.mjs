import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewToolOutput } from '../src/tool-view.mjs';
const render = (data, markdown = 'SUMMARY') => reviewToolOutput.render({}, { json: JSON.stringify(data), markdown })[0].text;

test('preview metadata stays visible to SDK text consumers without source or private artifacts', () => {
  const preview = { previewId: 'approved-id', expiresAt: '2030-01-01', snapshotId: 'snapshot', repositoryRoot: '/repo', vcs: 'git', changeScope: 'worktree', model: { provider: 'provider', model: 'model', reasoningEffort: 'high', secret: 'PRIVATE' }, files: [{ path: 'a.js', hash: 'hash', source: 'SOURCE', content: 'SOURCE' }], plan: { minimumCalls: 3 }, privateArtifacts: { raw: 'PRIVATE' }, arbitrary: 'PRIVATE', businessRequirement: { text: 'PRIVATE' } };
  for (const data of [preview, { jobId: 'job', status: 'completed', resultSummary: preview, result: { raw: 'PRIVATE' } }]) {
    const text = render(data), shown = JSON.parse(text.split(String.fromCharCode(10, 10))[1]);
    assert.equal(shown.previewId, 'approved-id');
    assert.equal(shown.repositoryRoot, '/repo');
    assert.equal(shown.changeScope, 'worktree');
    assert.equal(shown.model.provider, 'provider');
    assert.equal(shown.model.model, 'model');
    assert.equal(shown.model.reasoningEffort, 'high');
    assert.deepEqual(shown.files, [{ path: 'a.js', hash: 'hash' }]);
    assert.equal(shown.plan.minimumCalls, 3);
    assert.ok(!text.includes('PRIVATE'));
    assert.ok(!text.includes('SOURCE'));
  }
});



test('real preview shape retains approval rules requirement context provenance and dispatch identities without bodies', () => {
  const source = { repositoryUuid: 'uuid', url: 'https://example.invalid/repo/a.js', pegRevision: '7364', operativeRevision: '7364', kind: 'file', hash: 'raw-hash', textHash: 'text-hash', text: 'SECRET_BODY', content: 'SECRET_BODY' };
  const preview = { previewId: 'approved', rules: [{ path: 'RULES.md', hash: 'rules-hash', text: 'SECRET_BODY' }], businessRequirement: { text: 'SECRET_BODY', hash: 'requirement-hash', bytes: 123 }, history: { vcs: 'svn', base: '7363', target: '7364', baseUrl: 'https://example.invalid/repo/old', targetUrl: 'https://example.invalid/repo/new', repositoryUuid: 'uuid', pegRevision: '7364' }, contextPaths: ['a.js'], contextSources: [{ path: 'a.js', new: source, old: { ...source, operativeRevision: '7363', pegRevision: '7363' } }], oldContextSources: [{ path: 'old.js', side: 'context-old', contextSide: 'old', contextVersion: '7363', revision: '7363', hash: 'old-hash', svnSource: source, blobOid: 'oid', text: 'SECRET_BODY' }], callerDiscovery: { scopes: ['src'], scanned: [{ path: 'a.js', side: 'new', revision: '7364', hash: 'caller-hash', bytes: 42, svnSource: source }], scannedBytes: 42, probeCount: 2, candidates: [{ fromPath: 'a.js', toPath: 'b.js', side: 'new', status: 'captured', text: 'SECRET_BODY' }], capturedPaths: ['a.js'], incomplete: true }, dispatch: { requested: 'auto', effectiveStrategy: 'whole-scope', childMode: 'host-subagents', eligibleCount: 10, oversizedCount: 0, plannedChildCount: 2, concurrency: 2 }, plan: { minimumCalls: 5, primaryGroups: [{ id: 'group', fileIds: ['f1', 'f2'] }] } };
  for (const data of [preview, { jobId: 'job', status: 'completed', resultSummary: preview }]) {
    const text = render(data), shown = JSON.parse(text.split(String.fromCharCode(10, 10))[1]);
    assert.deepEqual(shown.rules, [{ path: 'RULES.md', hash: 'rules-hash' }]);
    assert.deepEqual(shown.businessRequirement, { hash: 'requirement-hash', bytes: 123, textOmitted: true });
    assert.deepEqual(shown.history, preview.history);
    assert.equal(shown.contextSources[0].new.url, source.url);
    assert.equal(shown.contextSources[0].old.operativeRevision, '7363');
    assert.equal(shown.contextSources[0].new.textHash, 'text-hash');
    assert.equal(shown.oldContextSources[0].side, 'context-old');
    assert.equal(shown.oldContextSources[0].contextSide, 'old');
    assert.equal(shown.oldContextSources[0].contextVersion, '7363');
    assert.equal(shown.oldContextSources[0].hash, 'old-hash');
    assert.equal(shown.oldContextSources[0].svnSource.pegRevision, '7364');
    assert.deepEqual(shown.dispatch, preview.dispatch);
    assert.deepEqual(shown.plan.primaryGroups[0].fileIds, ['f1', 'f2']);
    assert.equal(shown.callerDiscovery.scanned[0].svnSource.url, source.url);
    assert.equal(shown.callerDiscovery.candidates[0].fromPath, 'a.js');
    assert.equal(shown.callerDiscovery.incomplete, true);
    assert.ok(!text.includes('SECRET_BODY'));
  }
});

test('failed terminal output exposes bounded cause and identity but not arbitrary private fields', () => {
  const text = render({ status: 'failed', jobId: 'job', error: 'capacity exceeded ' + 'x'.repeat(4000), result: { raw: 'PRIVATE' }, artifacts: ['PRIVATE'] });
  const shown = JSON.parse(text.split(String.fromCharCode(10, 10))[1]);
  assert.equal(shown.status, 'failed'); assert.equal(shown.jobId, 'job');
  assert.equal(shown.error,undefined); assert.equal(shown.failure.code,'UNKNOWN_REVIEW_FAILURE'); assert.ok(!text.includes('capacity exceeded'));
  assert.ok(!text.includes('PRIVATE'));
});

test('brief and explicit technical reports do not echo raw report JSON', () => {
  for (const markdown of ['BRIEF', 'TECHNICAL EVIDENCE']) {
    assert.equal(render({ status: 'completed', resultSummary: { status: 'partial' }, report: { raw: 'PRIVATE' }, technicalMarkdown: 'PRIVATE', resultPage: { findings: ['PRIVATE'] } }, markdown), markdown);
  }
  assert.equal(render({ status: 'running', error: 'PRIVATE', result: { raw: 'PRIVATE' } }, 'PROGRESS'), 'PROGRESS');
  assert.equal(render({ sourceBearing: true, status: 'failed', error: 'PRIVATE' }, 'PRIVATE NOTICE'), 'PRIVATE NOTICE');
});

test('invalid JSON preserves markdown and empty markdown preserves original JSON fallback', () => {
  assert.deepEqual(reviewToolOutput.render({}, { json: 'invalid-json', markdown: 'ORIGINAL' }), [{ type: 'text', text: 'ORIGINAL' }]);
  assert.deepEqual(reviewToolOutput.render({}, { json: '{}', markdown: '' }), [{ type: 'text', text: '{}' }]);
  assert.equal(render(null, 'ORIGINAL'), 'ORIGINAL');
});
test('automatic-context per-side revisions and truncation remain visible without body text',()=>{const shown=render({previewId:'p',autoContext:{truncated:true,maxDepth:3,candidates:[{path:'a.h',depth:2,status:'captured',sides:[{side:'old',revision:'7363',status:'captured',text:'PRIVATE_OLD'},{side:'new',revision:'7364',status:'blocked',reason:'limit',text:'PRIVATE_NEW'}]}]}});const data=JSON.parse(shown.split(String.fromCharCode(10,10))[1]);assert.equal(data.autoContext.truncated,true);assert.equal(data.autoContext.maxDepth,3);assert.equal(data.autoContext.candidates[0].depth,2);assert.deepEqual(data.autoContext.candidates[0].sides.map(s=>[s.side,s.revision,s.status]),[['old','7363','captured'],['new','7364','blocked']]);assert.ok(!shown.includes('PRIVATE_'));});
