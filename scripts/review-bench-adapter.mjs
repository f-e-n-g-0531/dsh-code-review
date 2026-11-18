// Local-only benchmark entrypoint; does not load or change DSH host settings.
import { checked } from '../src/process.mjs';
import { captureSnapshot } from '../src/snapshot.mjs';
import { reviewSnapshot } from '../src/review.mjs';
import { modelJson } from '../src/model-json.mjs';
import { singleModelCandidate } from '../src/report-summary.mjs';
import { link, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_OUTPUT_TOKENS = 4096;
const RUN_TIMEOUT_MS = 14 * 60 * 1000;

function reviewBudget(executionStrategy) {
  if (!['staged', 'single-pass'].includes(executionStrategy)) throw new Error('Invalid benchmark execution strategy');
  return { executionStrategy, reviewRounds: 1, maxCalls: executionStrategy === 'single-pass' ? 1 : 100,
    maxInputBytes: 96 * 1024, timeoutMs: 120_000,
    enableRetrieval: false, enableVerification: false, enableBusinessGrouping: false };
}

function json(value) { return JSON.stringify(value, null, 2) + '\n'; }

async function requireFreshOutputs(paths) {
  for (const file of paths) {
    try { await lstat(file); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw Object.assign(new Error('Benchmark output already exists; choose a new RB_OUT'), { code: 'EEXIST' });
  }
}

// Publish only complete JSON and never replace an existing destination.
async function publishJson(claim, name, target, value) {
  const staged = path.join(claim, name);
  await writeFile(staged, json(value), { flag: 'wx', mode: 0o600 });
  try { await link(staged, target); }
  finally { await unlink(staged); }
}

export function benchmarkConfig(env) {
  const base = env.RB_BASE, head = env.RB_HEAD;
  if (![base, head].every(value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value))) throw new Error('RB_BASE/RB_HEAD must be full lowercase Git SHAs');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.RB_NWO ?? '') || env.RB_NWO.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid RB_NWO');
  if (!/^[1-9][0-9]*$/.test(env.RB_PR_NUMBER ?? '') || !Number.isSafeInteger(Number(env.RB_PR_NUMBER))) throw new Error('Invalid RB_PR_NUMBER');
  if (!env.RB_REPO_DIR || !env.RB_OUT) throw new Error('Set RB_REPO_DIR and RB_OUT for local evaluation');
  const out = path.resolve(env.RB_OUT);
  if (/\.(?:claim|report\.json|smoke\.json)$/i.test(out)) throw new Error('RB_OUT uses a reserved adapter suffix');
  const profile = env.RB_PROFILE ?? 'staged-direct';
  if (!['staged-direct', 'single-pass-direct'].includes(profile)) throw new Error('Invalid RB_PROFILE');
  const executionStrategy = profile === 'single-pass-direct' ? 'single-pass' : 'staged';
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
    repo: path.resolve(env.RB_REPO_DIR), out, base, head,
    nwo: env.RB_NWO, prNumber: Number(env.RB_PR_NUMBER),
    agent: env.RB_AGENT || 'dsh-code-review', profile, executionStrategy, mock, endpoint,
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
      if (size > MAX_RESPONSE_BYTES) throw new Error('Model response exceeds byte limit');
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
    await request.beforeSend?.();
    const response = await fetchImpl(config.endpoint, {
      method: 'POST', redirect: 'error', signal: request.signal,
      headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {}) },
      body: JSON.stringify({ model: config.model, messages: [
        { role: 'system', content: request.instructions },
        { role: 'user', content: request.input },
      ], temperature: 0, max_tokens: MAX_OUTPUT_TOKENS }),
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
    const singlePass = report.execution?.executionStrategy === 'single-pass';
    if (singlePass ? !singleModelCandidate(finding, report) : finding.verification && (finding.verification.status !== 'completed' || finding.verification.verdict !== 'supported')) throw new Error('Finding requires explicit adjudication; see saved report');
    const message = [finding.title, finding.evidence, finding.trigger, finding.impact, finding.suggestion].filter(value => typeof value === 'string' && value.trim()).join(' ');
    if (!message) throw new Error('Empty finding message');
    const mapped = { file, start_line: anchor.start, end_line: anchor.end, message, producer: agent };
    const identity = JSON.stringify(mapped);
    if (!seen.has(identity)) { seen.add(identity); findings.push(mapped); }
  }
  if (findings.length > 200) throw new Error('Benchmark finding limit exceeded; no clipping performed');
  return findings;
}

function benchmarkMock(request) {
  if (request.sourceMode !== 'single-pass') return { findings: [], limitations: [] };
  const completion = { status: 'completed', gaps: [] };
  return {
    reviews: JSON.parse(request.input).reviews.map(({ fileId }) => ({ fileId, findings: [], limitations: [], completion, assuranceNotes: [] })),
    limitations: [], completion, assuranceNotes: [],
  };
}

export function reviewBenchmarkSnapshot(snapshot, executor, executionStrategy, signal) {
  return reviewSnapshot(snapshot, executor, { ...reviewBudget(executionStrategy), signal });
}

export async function runBenchmark(env = process.env, fetchImpl = fetch) {
  const config = benchmarkConfig(env);
  const budget = reviewBudget(config.executionStrategy);
  const signal = AbortSignal.timeout(RUN_TIMEOUT_MS), started = Date.now();
  const reportPath = config.out + '.report.json', smokePath = config.out + '.smoke.json';
  const outputs = [config.out, reportPath, smokePath];
  const claim = config.out + '.claim';
  await requireFreshOutputs(outputs); // Legacy outputs can predate the claim protocol.
  await mkdir(claim, { mode: 0o700 }); // The atomic same-output admission gate for both profiles and modes.
  await requireFreshOutputs(outputs);

  const bases = (await checked('git', ['merge-base', '--all', config.base, config.head], { cwd: config.repo, signal })).toString('utf8').trim().split(/\r?\n/);
  if (bases.length !== 1 || !/^[0-9a-f]{40}$/.test(bases[0])) throw new Error('Expected a unique merge base; no arbitrary base selected');
  const mergeBase = bases[0];
  const snapshot = await captureSnapshot(config.repo, { baseRevision: mergeBase, targetRevision: config.head, signal });
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const { executionStrategy, ...reviewLimits } = budget;
  const metadata = {
    schemaVersion: 1, base: config.base, head: config.head, mergeBase, version,
    profile: config.profile, executionStrategy, mock: config.mock, model: config.mock ? null : config.model,
    budget: { ...reviewLimits, runTimeoutMs: RUN_TIMEOUT_MS,
      maxOutputTokensPerCall: config.mock ? null : MAX_OUTPUT_TOKENS,
      maxResponseBytesPerCall: config.mock ? null : MAX_RESPONSE_BYTES },
  };
  await writeFile(path.join(claim, 'run.json'), json(metadata), { flag: 'wx', mode: 0o600 });
  await requireFreshOutputs(outputs);
  signal.throwIfAborted();
  const executor = config.mock ? benchmarkMock : benchmarkExecutor(config, fetchImpl);
  console.log('profile=' + config.profile + ' mock=' + config.mock + ' model=' + (metadata.model ?? 'none'));
  const report = await reviewSnapshot(snapshot, executor, { ...budget, signal });
  await publishJson(claim, 'report.json', reportPath, { ...metadata, report });
  signal.throwIfAborted();
  const findings = benchmarkFindings(snapshot, report, config.agent);
  const output = {
    pr: { repo: 'https://github.com/' + config.nwo, pr_number: config.prNumber, base: config.base, head: config.head },
    agent: config.agent, findings, usage: { time_in_ms: Date.now() - started },
  };
  // Smoke output is intentionally not a scoreable candidate file.
  await publishJson(claim, config.mock ? 'result.smoke.json' : 'result.json', config.mock ? smokePath : config.out, output);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runBenchmark().catch(error => {
    console.error(error?.code === 'EEXIST' ? 'Benchmark output already exists; choose a new RB_OUT.' : 'Benchmark adapter failed; no successful result implied. Check configuration and any saved report.');
    process.exitCode = 1;
  });
}
