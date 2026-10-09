import { hash, relativePath } from './content.mjs';
import { assertNonSecretPath } from './secret-path.mjs';

export const CONTEXT_SIDE_NOTICE = 'context.text属于批准当前或target侧；oldText/oldRevision与context-old属于baseline旧侧。oldOnly:true表示只捕获旧侧，没有target正文，不证明目标路径不存在。不得互换版本或用旧侧上下文证明新侧行为；没有证据须保留uncertain。';

// Validate approved snapshot data only. This does not authorize any capture.
export function contextSources(item, history) {
 if (!item || relativePath(item.path) !== item.path) throw new Error('Invalid context path');
 assertNonSecretPath(item.path);
 if (item.oldOnly !== undefined && item.oldOnly !== true) throw new Error('Invalid old-only context marker');
 if (item.oldOnly === true) {
  if (!history || !history.base || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(history.base) || item.oldRevision !== history.base || typeof item.oldText !== 'string' || item.text !== undefined || item.revision !== undefined || item.hash !== undefined || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item.oldBlobOid ?? '') || item.oldHash !== hash(item.oldText)) throw new Error('Invalid old-only historical context provenance');
  return [{side:'context-old',text:item.oldText,revision:item.oldRevision,blobOid:item.oldBlobOid,hash:item.oldHash}];
 }
 if (typeof item.text !== 'string') throw new Error('Missing current context text');
 const sources=[{side:'context',text:item.text,...(item.revision ? {revision:item.revision} : {})}];
 if (item.oldText !== undefined) {
  if (!history || !history.base || item.oldRevision !== history.base || item.revision !== history.target || typeof item.oldText !== 'string') throw new Error('Invalid historical context provenance');
  sources.push({side:'context-old',text:item.oldText,revision:item.oldRevision});
 }
 return sources;
}
