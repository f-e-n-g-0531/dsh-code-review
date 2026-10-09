import {reviewSnapshot,markdownReport} from '../src/review.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewGroups } from '../src/review-groups.mjs';
test('five-file dependency chain preserves primary denominator and discloses unsynthesized split',async()=>{
 const selected=['a','b','c','d','e'].map((id,i)=>({id,path:id+'.js',eligibility:'reviewable',properties:[],left:{text:''},right:{text:(i<4?"import './"+['b','c','d','e'][i]+".js';\n":'')+'changed();'}}));
 const r=await reviewSnapshot({id:'s',vcs:'git',context:[],files:selected},()=>({findings:[],limitations:[]}),{enableGrouping:true,enableRetrieval:true});
 assert.equal(r.coverage.completed,5);assert.equal(r.status,'partial');assert.ok(r.grouping.links.some(l=>l.split));assert.ok(r.limitations.some(l=>l.text.includes('跨组关系未综合覆盖')));assert.match(markdownReport(r),/跨组关系未综合覆盖/);assert.equal(r.interactions.length,1);assert.equal(r.modelCalls,6);
});
const files = ['a', 'b', 'c', 'd'].map(id => ({ id, eligibility: 'reviewable' }));
const edges = [{ from: 'a', to: 'b', reason: 'implementation-test' }, { from: 'b', to: 'c', reason: 'import' }];
test('groups are deterministic bounded and cover each eligible file once', () => {
  const result = buildReviewGroups(files, edges, { maxFiles: 2 });
  assert.deepEqual(result, buildReviewGroups([...files].reverse(), [...edges].reverse(), { maxFiles: 2 }));
  assert.deepEqual(result.groups.map(g => g.fileIds), [['a', 'b'], ['c'], ['d']]);
  assert.equal(result.links[1].split, true);
  assert.deepEqual(result.groups.flatMap(g => g.fileIds).sort(), ['a', 'b', 'c', 'd']);
});
test('excluded files cannot enter groups through relation hints', () => {
  const result = buildReviewGroups([...files, { id: 'secret', eligibility: 'excluded' }], [...edges, { from: 'a', to: 'secret', reason: 'import' }]);
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.throws(() => buildReviewGroups(files, [{ from: 'a', to: 'unknown', reason: 'import' }]));
  assert.throws(() => buildReviewGroups([...files, files[0]], []));
});
test('cyclic and duplicate hints remain bounded and preserve singleton fallback', () => {
  const result = buildReviewGroups(files, [...edges, edges[0], { from: 'c', to: 'a', reason: 'cycle' }], { maxFiles: 1 });
  assert.equal(result.groups.length, 4); assert.equal(result.links.length, 3);
  assert.ok(result.links.every(e => e.split));
});
