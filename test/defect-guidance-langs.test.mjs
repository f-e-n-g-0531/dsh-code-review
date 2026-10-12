import test from 'node:test';import assert from 'node:assert/strict';
import {defectGuidance} from '../src/defect-guidance.mjs';import {reviewSnapshot} from '../src/review.mjs';
const N=String.fromCharCode(10);
const cases=[['a.vh','hdl'],['a.sv','hdl'],['a.vhdl','hdl'],['a.rego','rego'],['a.jsonnet','jsonnet'],['a.libsonnet','jsonnet'],['a.nix','nix'],['a.zig','zig'],['a.r','rlang'],['a.R','rlang'],['a.elm','elm'],['a.hs','haskell'],['a.lhs','haskell'],['a.jl','julia'],['a.nim','nim'],['a.ml','ocaml'],['a.po','po']];
test('remaining unambiguous languages map to precise immutable evidence-gated checklists',()=>{
 for(const [path,lang] of cases){const g=defectGuidance(path);assert.equal(g.language,lang,path);assert.ok(g.checks.length>=4,path);assert.match(g.checks.join(' '),/Check|Do not report/);assert.match(g.notice,/not evidence/);const before=g.checks.length;g.checks.push('MUTATED');assert.equal(defectGuidance(path).checks.length,before);}
});
test('overloaded extensions drop or require content to avoid wrong guidance',()=>{
 for(const [path,src] of [['prover.v','Coq proof source'],['deck.pot',''],['optimizer.sol','# CPLEX solution'],['script.fs',': word . ;']])assert.equal(defectGuidance(path,src).language,'generic',path);
 assert.equal(defectGuidance('a.sol','pragma solidity ^0.8; contract A {}').language,'solidity');
 assert.equal(defectGuidance('a.fs','module A'+N+'let x = 1').language,'fsharp');
 assert.equal(defectGuidance('a.fsx','open System').language,'fsharp');
 assert.equal(defectGuidance('a.sol.backup').language,'generic');assert.equal(defectGuidance('a.rst').language,'generic');
});
test('nix keeps infrastructure purpose and jsx tsx add react without losing javascript',()=>{
 const nix=defectGuidance('flake.nix');assert.equal(nix.language,'nix');assert.equal(nix.fileType,'infrastructure');assert.equal(nix.checks.length,6);
 const jsx=defectGuidance('a.jsx');assert.equal(jsx.language,'javascript');assert.ok(jsx.checks.some(c=>c.includes('effect cleanup')));
 const js=defectGuidance('a.js');assert.equal(js.language,'javascript');assert.ok(!js.checks.some(c=>c.includes('effect cleanup')));
});
test('xml mapper signature scans a bounded header across the declaration lead',()=>{
 const lead=['<?xml version="1.0"?>','<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN">','<mapper namespace="a.b">','<select id="q"/>'].join(N);
 assert.equal(defectGuidance('m.xml',lead).language,'mybatis');
 assert.equal(defectGuidance('m.xml','<mapper namespace="a.b">'+N+'<select id="q"/>').language,'mybatis');
 assert.equal(defectGuidance('m.xml','<?xml version="1.0"?>'+N+'<settings/>').language,'configuration');
 assert.equal(defectGuidance('data.xml','').language,'configuration');
});
test('new guidance reaches primary pipeline without extra calls',async()=>{
 for(const [path,src,lang] of [['a.vhdl','','hdl'],['a.rego','','rego'],['a.nix','','nix'],['a.jsx','','javascript'],['a.sol','pragma solidity ^0.8; contract A {}','solidity']]){let calls=0;const r=await reviewSnapshot({id:'s',vcs:'git',files:[{id:'f',path,eligibility:'reviewable',properties:[],left:{text:'old'},right:{text:src||'new'}}],context:[]},async request=>{calls++;assert.equal(JSON.parse(request.input).defectGuidance.language,lang);return {findings:[],limitations:[]};});assert.equal(calls,1);assert.equal(r.status,'completed');}
});
