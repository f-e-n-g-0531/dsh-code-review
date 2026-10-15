import test from 'node:test';import assert from 'node:assert/strict';
import {svnKeywordMapping,svnKeywordConfiguration} from '../src/svn-keyword-mapping.mjs';

// Authored during consolidated implementation; not yet executed or accepted.
test('composite custom keyword formats retain names and reject unsupported escapes',()=>{
 const v=svnKeywordMapping('$Build: 12_alice $','Build=%r_%a');assert.equal(v.text,'$Build$');assert.deepEqual(v.customKeywords,[{name:'Build',format:'%r_%a'}]);
 for(const configuration of ['Id=%r','Build=%Q','Build=%','Build=%r Build=%a','Build=bad$literal'])assert.throws(()=>svnKeywordConfiguration(configuration));
});
test('fixed width contraction retains reserved width and raw evidence hashes',()=>{
 const raw='$Id:: abcdefgh#$';const v=svnKeywordMapping(raw,'Id');assert.equal(v.text,'$Id::          $');assert.equal(v.fixedWidthFields,1);assert.equal(v.lineMapping,'identity');assert.notEqual(v.rawTextHash,v.textHash);
 assert.throws(()=>svnKeywordMapping('$Id::bad$','Id'));assert.throws(()=>svnKeywordMapping('$Id: incomplete','Id'));
});
