import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

// Retry transport failures, never malformed metadata or verification failures.
const bodyTransportFailure = error => error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error?.name) || ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET'].includes(error?.code ?? error?.cause?.code);

export async function waitForRegistry(url, integrity, { fetchImpl = fetch, sleep = setTimeout, attempts = 20, delayMs = 15000, expectedBytes } = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 20 || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 15000) throw new Error('Invalid registry retry budget');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try { response = await fetchImpl(url, { signal: AbortSignal.timeout(15000), cache: 'no-store' }); }
    catch (error) { if (attempt === attempts) throw error; await sleep(delayMs); continue; }
    if (response.ok) {
      let published;
      try { published = await response.json(); }
      catch (error) {
        if (!bodyTransportFailure(error) || attempt === attempts) throw error;
        await sleep(delayMs); continue;
      }
      if (published.dist?.integrity !== integrity) throw new Error('npm artifact differs from GitHub release package');
      if (expectedBytes !== undefined) {
        if (!Buffer.isBuffer(expectedBytes) || expectedBytes.length > 4 * 1024 * 1024) throw new Error('Invalid release artifact budget');
        const artifactUrl = new URL(published.dist?.tarball);
        if (artifactUrl.protocol !== 'https:' || artifactUrl.hostname !== 'registry.npmjs.org' || artifactUrl.port || artifactUrl.username || artifactUrl.password) throw new Error('Invalid registry artifact URL');
        let artifact;
        try { artifact = await fetchImpl(artifactUrl.href, { signal: AbortSignal.timeout(15000), cache: 'no-store', redirect: 'error' }); }
        catch (error) { if (attempt === attempts) throw error; await sleep(delayMs); continue; }
        if (!artifact.ok) {
          await artifact.body?.cancel();
          if (![404,429,500,502,503,504].includes(artifact.status) || attempt === attempts) throw new Error('Cannot verify npm artifact: HTTP ' + artifact.status);
          await sleep(delayMs); continue;
        }
        const chunks=[]; let size=0;
        if (!artifact.body) throw new Error('Missing registry artifact body');
        const reader=artifact.body.getReader();
        let transportError;
        try {
          while (true) {
            let part;
            try { part = await reader.read(); } catch (error) { transportError = error; break; }
            if (part.done) break;
            size += part.value.length;
            if (size > expectedBytes.length) { await reader.cancel(); throw new Error('Registry artifact output limit exceeded'); }
            chunks.push(Buffer.from(part.value));
          }
          if (transportError) { try { await reader.cancel(); } catch {} }
        } finally { reader.releaseLock(); }
        if (transportError) {
          if (!bodyTransportFailure(transportError) || attempt === attempts) throw transportError;
          await sleep(delayMs); continue;
        }
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
