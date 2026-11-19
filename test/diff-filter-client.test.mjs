import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

const materialize = async () => {
  const { outputFiles } = await build({ entryPoints:['src/client.jsx'], bundle:true, write:false, format:'cjs', external:['react'] });
  let draft, intent, props, operation;
  const react = {
    createElement: (type, props, ...children) => ({type,props,children}),
    useState: initial => {
      const index = intent++;
      return index===0 ? [draft, value => { draft = typeof value==='function' ? value(draft) : value; }] : [initial, () => {}];
    },
  };
  const module = {exports:{}};
  vm.runInNewContext(outputFiles[0].text, {module, exports:module.exports, require:key=>{ assert.equal(key,'react'); return react; }});
  let render;
  module.exports.apply({slots:{
    inject(name, run) { assert.equal(name,'plugins.row.config'); return run(); },
    register(spec, view) { assert.equal(spec.key,'@feng0531/dsh-code-review#dsh-code-review'); render=view; },
  }});
  assert.match(render({view:'summary'}),/资源和文件夹/);
  props = {view:'page',form:{ state:{status:'ready',writable:true,revision:7}, async mutate(ops, revision) { operation = {ops,revision}; return true; } }};
  const page = () => { intent=0; const component=render(props); return component.type(component.props); };
  return {page, operation:()=>operation};
};
function search(node, test) {
  if (!node || typeof node !== 'object') return undefined;
  if (test(node)) return node;
  return node.children?.map(child=>search(child,test)).find(Boolean);
}

test('client presents defaults and saves only edited fields through revisioned host form', async () => {
  const {page,operation} = await materialize();
  const checkbox = search(page(),node=>node.type==='input');
  assert.equal(checkbox.props.checked,true);
  assert.equal(search(page(),node=>node.type==='textarea'&&node.props.rows===2).props.value,'Test');
  checkbox.props.onChange({target:{checked:false}});
  await page().props.onSubmit({preventDefault(){}});
  assert.deepEqual(JSON.parse(JSON.stringify(operation())),{ops:[{op:'set',path:['autoExcludeNonCode'],value:false}],revision:7});
});
