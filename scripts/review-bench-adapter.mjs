// Local-only benchmark entrypoint; does not load or change DSH host settings.
import { checked } from '../src/process.mjs';
import { captureSnapshot } from '../src/snapshot.mjs';
import { reviewSnapshot } from '../src/review.mjs';
import { modelJson } from '../src/model-json.mjs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RESPONSE_BYTES = 1024 * 1024;

export function benchmarkConfig(env) {
  const base = env.RB_BASE, head = env.RB_HEAD;
  if (![base, head].every(value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value))) throw new Error('RB_BASE/RB_HEAD must be full lowercase Git SHAs');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.RB_NWO ?? '') || env.RB_NWO.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid RB_NWO');
  if (!/^[1-9][0-9]*$/.test(env.RB_PR_NUMBER ?? '') || !Number.isSafeInteger(Number(env.RB_PR_NUMBER))) throw new Error('Invalid RB_PR_NUMBER');
  if (!env.RB_REPO_DIR || !env.RB_OUT) throw new Error('Set RB_REPO_DIR and RB_OUT for local evaluation');
  const mock = env.RB_MOCK === '1';
  if (env.RB_MOCK !== undefined && !['0', '1'].includes(env.RB_MOCK)) throw new Error('Invalid RB_MOCK');
  if (!mock && (!env.RB_CONFIG_MODEL || !env.RB_MODEL_BASE_URL)) throw new Error('Set an explicit RB_CONFIG_MODEL and RB_MODEL_BASE_URL');
  let endpoint;
  if (!mock) {
    const url = new URL(env.RB_MODEL_BASE_URL);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Invalid model endpoint; use HTTPS or local HTTP without URL credentials');
    endpoint = url.href.replace(/\/+$/, '') + '/chat/completions';
  }
  return {
    repo: path.resolve(env.RB_REPO_DIR), out: path.resolve(env.RB_OUT), base, head,
    nwo: env.RB_NWO, prNumber: Number(env.RB_PR_NUMBER),
    agent: env.RB_AGENT || 'dsh-code-review', mock, endpoint,
    model: env.RB_CONFIG_MODEL,
    apiKey: env.RB_CONFIG_API_KEY || env.OPENAI_API_KEY || env.DEEPSEEK_API_KEY || '',
  };
}

async function responseJson(response) {
  if (!response.body) throw new Error('Model response has no body');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_BYTES) throw new Error('Model response exceeds byte limit');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function benchmarkExecutor(config, fetchImpl = fetch) {
  return async request => {
    const response = await fetchImpl(config.endpoint, {
      method: 'POST', redirect: 'error', signal: request.signal,
      headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {}) },
      body: JSON.stringify({ model: config.model, messages: [
        { role: 'system', content: request.instructions },
        { role: 'user', content: request.input },
      ], temperature: 0, max_tokens: 4096 }),
    });
    // Error bodies can contain credentials or source; never echo them.
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Model HTTP status ' + response.status);
    }
    const data = await responseJson(response);
    if (data?.choices?.length !== 1 || data.choices[0]?.finish_reason !== 'stop') throw new Error('Model response incomplete or ambiguous');
    const content = data.choices[0]?.message?.content;
    if (typeof content !== 'string' || !content) throw new Error('Model returned no text');
    return JSON.parse(modelJson(content));
  };
}

export function benchmarkFindings(snapshot, report, agent) {
  if (report.status !== 'completed' || !report.files?.length || report.files.some(file => file.status !== 'completed')) throw new Error('Benchmark review incomplete; see saved report');
  const paths = new Map(snapshot.files.map(file => [file.id, file.path]));
  const seen = new Set(), findings = [];
  for (const finding of report.findings) {
    const anchor = finding.anchor, file = paths.get(finding.fileId);
    if (!file || file.startsWith('/') || file.includes('\\') || file.split('/').some(part => ['', '.', '..'].includes(part))) throw new Error('Unrepresentable finding path');
    // Do not invent target coordinates or silently remove a valid old-side issue.
    if (anchor?.kind !== 'line' || anchor.side !== 'new' || !Number.isSafeInteger(anchor.start) || !Number.isSafeInteger(anchor.end) || anchor.start < 1 || anchor.end < anchor.start) throw new Error('Finding has no valid head-side line range; see saved report');
    if (finding.verification && (finding.verification.status !== 'completed' || finding.verification.verdict !== 'supported')) throw new Error('Finding requires explicit adjudication; see saved report');
    const message = [finding.title, finding.evidence, finding.trigger, finding.impact, finding.suggestion].filter(value => typeof value === 'string' && value.trim()).join(' ');
    if (!message) throw new Error('Empty finding message');
    const mapped = { file, start_line: anchor.start, end_line: anchor.end, message, producer: agent };
    const identity = JSON.stringify(mapped);
    if (!seen.has(identity)) { seen.add(identity); findings.push(mapped); }
  }
  if (findings.length > 200) throw new Error('Benchmark finding limit exceeded; no clipping performed');
  return findings;
}

export async function runBenchmark(env = process.env) {
  const config = benchmarkConfig(env);
  const signal = AbortSignal.timeout(14 * 60 * 1000), started = Date.now();
  const bases = (await checked('git', ['merge-base', '--all', config.base, config.head], { cwd: config.repo, signal })).toString('utf8').trim().split(/\r?\n/);
  if (bases.length !== 1 || !/^[0-9a-f]{40}$/.test(bases[0])) throw new Error('Expected a unique merge base; no arbitrary base selected');
  const snapshot = await captureSnapshot(config.repo, { baseRevision: bases[0], targetRevision: config.head, signal });
  const executor = config.mock ? async () => ({ findings: [], limitations: [] }) : benchmarkExecutor(config);
  console.log('profile=single-pass-direct mock=' + config.mock + ' model=' + (config.model || 'none'));
  const report = await reviewSnapshot(snapshot, executor, { signal, reviewRounds: 1, maxCalls: 100, timeoutMs: 120_000 });
  signal.throwIfAborted();
  // Each run owns fresh output paths; never mix attempts or overwrite prior results.
  await writeFile(config.out + '.report.json', JSON.stringify({ mock: config.mock, profile: 'single-pass-direct', mergeBase: bases[0], report }, null, 2) + '\n', { flag: 'wx' });
  const findings = benchmarkFindings(snapshot, report, config.agent);
  const output = {
    pr: { repo: 'https://github.com/' + config.nwo, pr_number: config.prNumber, base: config.base, head: config.head },
    agent: config.agent, findings, usage: { time_in_ms: Date.now() - started },
  };
  // Smoke output is intentionally not a scoreable candidate file.
  await writeFile(config.mock ? config.out + '.smoke.json' : config.out, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runBenchmark().catch(() => {
    console.error('Benchmark adapter failed; no successful result implied. Check configuration and any saved report.');
    process.exitCode = 1;
  });
}
