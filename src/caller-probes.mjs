import { checked } from './process.mjs';
import { relativePath, hash } from './content.mjs';

// Metadata only: a directory, conflicted file or symlink is a competitor too.
export async function gitCallerProbes(root, probePaths, options = {}) {
  if (!Array.isArray(probePaths) || probePaths.length > 512 || new Set(probePaths).size !== probePaths.length) throw new Error('Invalid caller probes');
  const chunks = [], existing = [];
  let bytes = 0;
  for (const name of [...probePaths].sort()) {
    relativePath(name);
    const chunk = await checked('git', ['--no-optional-locks','--literal-pathspecs','-c','core.fsmonitor=false','-c','core.untrackedCache=false','ls-files','--stage','-z','--',name], {...options,cwd:root,maxBytes:64*1024});
    bytes += chunk.length;
    if (bytes > 1024*1024) throw new Error('Caller probe metadata limit exceeded');
    const text = new TextDecoder('utf-8',{fatal:true}).decode(chunk);
    if (text && !text.endsWith('\0')) throw new Error('Incomplete caller probe');
    const records=text.split('\0').filter(Boolean);
    for (const record of records) {
      const match=/^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([\s\S]+)$/.exec(record);
      if (!match) throw new Error('Invalid caller probe record');
      relativePath(match[4]);
      if (match[4] !== name && !match[4].startsWith(name+'/')) throw new Error('Caller probe escaped literal path');
    }
    if (records.length) existing.push(name);
    // Include missing probe names in identity, not only returned records.
    chunks.push(Buffer.from(name+'\0'),chunk);
  }
  return {paths:existing,fingerprint:hash(Buffer.concat(chunks)),bytes};
}
