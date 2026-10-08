import test from 'node:test';
import assert from 'node:assert/strict';
import { inferCppRelations as infer } from '../src/cpp-relations.mjs';
import { inferFileRelations } from '../src/file-relations.mjs';
import { buildReviewGroups } from '../src/review-groups.mjs';
const f=(id,path,text='')=>({id,path,eligibility:'reviewable',left:{text:''},right:{text}});
test('approved C++ literal include and unique header implementation names form bounded groups',()=>{
 const files=[f('a','src/Skin.cpp','#include "Skin.h"'),f('b','src/Skin.h'),f('c','src/Thread.cpp','#include "Skin.h"')];
 const before=structuredClone(files),edges=infer(files);
 assert.ok(edges.some(e=>e.reason==='cpp-header-implementation-name'));assert.ok(edges.some(e=>e.from==='c'&&e.to==='b'&&e.line===1));
 assert.equal(buildReviewGroups(files,inferFileRelations(files)).groups[0].fileIds.length,3);assert.deepEqual(files,before);
});
test('macro conditional system escaping excluded and ambiguous targets never resolve',()=>{
 for(const text of ['#include <Skin.h>','#include HEADER','#ifdef X'+String.fromCharCode(10)+'#include "Skin.h"','#include "../../Skin.h"','/*'+String.fromCharCode(10)+'#include "Skin.h"'])assert.deepEqual(infer([f('a','src/Other.cpp',text),f('b','src/Skin.h')]),[]);
 assert.deepEqual(infer([f('a','src/Skin.cpp'),f('b','src/Skin.h'),f('c','src/Skin.hpp')]),[]);
 assert.deepEqual(infer([f('a','src/Other.cpp','#include "Skin.h"'),{...f('b','src/Skin.h'),eligibility:'excluded'}]),[]);
 assert.throws(()=>infer([f('a','../unsafe.cpp')]));
});
