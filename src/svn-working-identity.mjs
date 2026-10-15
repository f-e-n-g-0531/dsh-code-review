import {hash} from './content.mjs';
export function svnWorkingIdentity(node,rootInfo,name){
 const expected=name==='.'?rootInfo.url:rootInfo.url.replace(/\/$/,'')+'/'+name.split('/').map(encodeURIComponent).join('/');
 const sameUrl=(a,b)=>{try{const x=new URL(a),y=new URL(b);return x.protocol===y.protocol&&x.host===y.host&&x.username===y.username&&x.password===y.password&&decodeURIComponent(x.pathname)===decodeURIComponent(y.pathname)&&x.search===y.search&&x.hash===y.hash;}catch{return false;}};
 if(!sameUrl(node?.url,expected))throw Object.assign(new Error('SVN node URL differs from selected working-copy path; switched ancestors are unsupported'),{code:'SVN_SWITCHED_ANCESTOR'});
 if(!rootInfo.repository?.uuid||node.repository?.uuid!==rootInfo.repository.uuid||node.repository?.root!==rootInfo.repository.root||node['wc-info']?.['wcroot-abspath']!==rootInfo['wc-info']?.['wcroot-abspath'])throw Object.assign(new Error('SVN node repository or working-copy identity mismatch'),{code:'SVN_NODE_IDENTITY'});
 const source={url:node.url,repositoryUuid:node.repository.uuid,repositoryRoot:node.repository.root,revision:String(node['@_revision']),kind:node['@_kind'],schedule:node['wc-info']?.schedule,copyFromUrl:node['wc-info']?.['copy-from-url']??null,copyFromRevision:node['wc-info']?.['copy-from-rev']??null};
 return {source,fingerprint:hash(JSON.stringify(source))};
}
