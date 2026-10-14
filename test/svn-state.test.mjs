import test from 'node:test';import assert from 'node:assert/strict';
import {svnStateIssue} from '../src/svn-state.mjs';

test('SVN blocked state classification is precise and does not turn missing into deletion',()=>{
 const cases=[['missing','SVN_MISSING_NODE'],['obstructed','SVN_OBSTRUCTED_NODE'],['incomplete','SVN_INCOMPLETE_NODE'],['replaced','SVN_REPLACEMENT'],['conflicted','SVN_TEXT_CONFLICT'],['external','SVN_EXTERNAL_NODE'],['unknown','SVN_UNSUPPORTED_STATE']];
 for(const [item,code]of cases)assert.equal(svnStateIssue({'@_item':item})?.code,code);
 assert.equal(svnStateIssue({'@_item':'replaced','@_copied':'true'}).code,'SVN_COPIED_REPLACEMENT');
 assert.equal(svnStateIssue({'@_item':'modified','@_props':'conflicted'}).code,'SVN_PROPERTY_CONFLICT');
 assert.equal(svnStateIssue({'@_item':'modified','@_tree-conflicted':'true'}).code,'SVN_TREE_CONFLICT');
 assert.equal(svnStateIssue({'@_item':'normal','@_switched':'true'}).code,'SVN_SWITCHED_NODE');
 assert.equal(svnStateIssue({'@_item':'normal','@_file-external':'true'}).code,'SVN_EXTERNAL_NODE');
 for(const item of ['normal','modified','added','deleted','unversioned'])assert.equal(svnStateIssue({'@_item':item}),null);
 assert.equal(svnStateIssue({'@_item':'added','@_copied':'true'}),null);
});
