import test from 'node:test';import assert from 'node:assert/strict';
import {decode} from '../src/content.mjs';import {svnSpecialData} from '../src/svn-special.mjs';
// Deferred acceptance cases: authored but not executed during implementation.
test('SVN link records are data only and never authorize following a target',()=>{
 const content=decode(Buffer.from('link ../../outside/secret'));const value=svnSpecialData(content,{'svn:special':'*'},'file');assert.equal(value.target,'../../outside/secret');assert.equal(value.followed,false);assert.equal(value.recordHash,content.hash);
 assert.equal(svnSpecialData(content,{},'file'),null);
 for(const [text,props,kind]of [['not a link',{'svn:special':'*'},'file'],['link ',{'svn:special':'*'},'file'],['link a',{'svn:special':'other'},'file'],['link a',{'svn:special':'*','svn:keywords':'Id'},'file'],['link a',{'svn:special':'*'},'dir']])assert.throws(()=>svnSpecialData(decode(Buffer.from(text)),props,kind));
});
