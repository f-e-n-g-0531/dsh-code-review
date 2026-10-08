import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

export async function waitForRegistry(url, integrity, { fetchImpl = fetch, sleep = setTimeout, attempts = 20, delayMs = 15000, expectedBytes } = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 20 || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 15000) throw new Error('Invalid registry retry budget');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
    if (response.ok) {
      const published = await response.json();
      if (published.dist?.integrity !== integrity) throw new Error('npm artifact differs from GitHub release package');
      if (expectedBytes !== undefined) {
        if (!Buffer.isBuffer(expectedBytes) || expectedBytes.length > 4 * 1024 * 1024) throw new Error('Invalid release artifact budget');
        const artifactUrl = new URL(published.dist?.tarball);
        if (artifactUrl.protocol !== 'https:' || artifactUrl.hostname !== 'registry.npmjs.org' || artifactUrl.port || artifactUrl.username || artifactUrl.password) throw new Error('Invalid registry artifact URL');
        const artifact = await fetchImpl(artifactUrl.href, { signal: AbortSignal.timeout(15000), cache: 'no-store', redirect: 'error' });
        if (!artifact.ok) {
          await artifact.body?.cancel();
          if (![404,429,500,502,503,504].includes(artifact.status) || attempt === attempts) throw new Error('Cannot verify npm artifact: HTTP ' + artifact.status);
          await sleep(delayMs); continue;
        }
        const chunks=[]; let size=0;
        if (!artifact.body) throw new Error('Missing registry artifact body');
        const reader=artifact.body.getReader();
        try { while(true) { const part=await reader.read(); if(part.done)break; size+=part.value.length; if(size>expectedBytes.length){await reader.cancel();throw new Error('Registry artifact output limit exceeded');}chunks.push(Buffer.from(part.value)); } } finally { reader.releaseLock(); }
        const bytes=Buffer.concat(chunks);
        if (!bytes.equals(expectedBytes) || 'sha512-'+createHash('sha512').update(bytes).digest('base64') !== integrity) throw new Error('npm artifact bytes differ from release package');
      }
      return;
    }
    await response.body?.cancel();
    if (![404, 429, 500, 502, 503, 504].includes(response.status) || attempt === attempts) throw new Error('Cannot verify npm version: HTTP ' + response.status);
    await sleep(delayMs);
  }
}
