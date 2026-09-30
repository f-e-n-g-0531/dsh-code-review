import { setTimeout } from 'node:timers/promises';

export async function waitForRegistry(url, integrity, { fetchImpl = fetch, sleep = setTimeout, attempts = 20, delayMs = 15000 } = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 20 || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 15000) throw new Error('Invalid registry retry budget');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
    if (response.ok) {
      const published = await response.json();
      if (published.dist?.integrity !== integrity) throw new Error('npm artifact differs from GitHub release package');
      return;
    }
    await response.body?.cancel();
    if (![404, 429, 500, 502, 503, 504].includes(response.status) || attempt === attempts) throw new Error('Cannot verify npm version: HTTP ' + response.status);
    await sleep(delayMs);
  }
}
