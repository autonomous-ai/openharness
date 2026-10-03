// Offline research diagnostic. Not imported by the app or memory learner.
// Run inside an OS sandbox that denies external networking and all writes except
// a fresh, private output directory. See README.md for the recorded invocation.
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [modelPath, serverPath, outputPath] = process.argv.slice(2);
assert.ok(modelPath && serverPath && outputPath, 'model, llama-server and fresh output directory required');
const output = resolve(outputPath);
const sha = value => createHash('sha256').update(value).digest('hex');
const planBytes = await readFile(join(here, 'plan.json'));
const plan = JSON.parse(planBytes);
const suiteBytes = await readFile(resolve(here, plan.corpus));
const suite = JSON.parse(suiteBytes);
assert.equal(sha(suiteBytes), plan.corpusSha256);
assert.equal(suite.cases.length, plan.expectedCases);
const sourcePrompt = await readFile(join(here, 'source-prompt.txt'), 'utf8');
const reviewPrompt = await readFile(join(here, 'review-prompt.txt'), 'utf8');
await mkdir(output, { mode: 0o700 }); // Refuse to overwrite an earlier run.
for (const name of ['tmp', 'cache']) await mkdir(join(output, name), { mode: 0o700 });
const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', TMPDIR: join(output, 'tmp'),
  XDG_CACHE_HOME: join(output, 'cache'), HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' };
const report = {
  schemaVersion: 1, experiment: plan.experiment, status: 'running', startedAt: new Date().toISOString(),
  suiteSha256: sha(suiteBytes), planSha256: sha(planBytes),
  runnerSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  sourcePromptSha256: sha(sourcePrompt), reviewPromptSha256: sha(reviewPrompt),
  limits: plan, networkGuard: null, inferenceCalls: 0, sourceInterpretations: [], cases: [],
};
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const exactKeys = (value, keys) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
const boundedText = (value, max) => assert.ok(typeof value === 'string' && value.length > 0 && value.length <= max);
const sourcesOf = input => input.episodes.flatMap(episode => episode.sources);
const quoteCheck = (value, sources) => {
  boundedText(value.sourceId, 200); boundedText(value.quote, 4000);
  assert.ok(sources.some(source => source.id === value.sourceId && source.text.includes(value.quote)), 'quote mismatch');
};
function validateInterpretation(value, input) {
  exactKeys(value, ['statements', 'qualifications', 'unknowns']);
  const sources = sourcesOf(input);
  for (const [key, limit, fields] of [['statements', 12, ['sourceId', 'quote', 'kind', 'meaning']],
    ['qualifications', 8, ['sourceId', 'quote', 'meaning']]]) {
    assert.ok(Array.isArray(value[key]) && value[key].length <= limit);
    for (const item of value[key]) {
      exactKeys(item, fields); quoteCheck(item, sources); boundedText(item.meaning, 300);
      if (key === 'statements') assert.ok(['request', 'decision', 'preference', 'reported_state',
        'verified_outcome', 'proposal', 'question', 'unresolved'].includes(item.kind));
    }
  }
  assert.ok(Array.isArray(value.unknowns) && value.unknowns.length <= 8);
  value.unknowns.forEach(value => boundedText(value, 250));
  return value;
}
const materialFields = ['kind', 'assertionType', 'scope', 'claim', 'rationale', 'futureAction',
  'applicability', 'exceptions', 'evidenceClass', 'validity'];
function validateReview(value, input, requiredPaths) {
  exactKeys(value, ['checks']);
  assert.ok(Array.isArray(value.checks) && value.checks.length >= requiredPaths.length && value.checks.length <= 24);
  for (const check of value.checks) {
    exactKeys(check, ['path', 'assertion', 'verdict', 'evidence', 'issue']);
    assert.ok(requiredPaths.includes(check.path)); boundedText(check.assertion, 250);
    assert.ok(['supported', 'unsupported', 'unclear'].includes(check.verdict));
    assert.ok(Array.isArray(check.evidence) && check.evidence.length <= 3);
    for (const evidence of check.evidence) {
      exactKeys(evidence, ['sourceId', 'quote']); quoteCheck(evidence, sourcesOf(input));
    }
    if (check.verdict === 'supported') assert.equal(check.issue, null);
    else boundedText(check.issue, 300);
  }
  assert.deepEqual([...new Set(value.checks.map(check => check.path))].sort(), [...requiredPaths].sort());
  const verdict = value.checks.some(check => check.verdict === 'unsupported') ? 'unsupported'
    : value.checks.some(check => check.verdict === 'unclear') ? 'unclear' : 'supported';
  return { ...value, verdict };
}

// Expected verdicts, provenance labels and candidates never enter stage one.
const sourceInputs = new Map();
const sourceKeyFor = new Map();
for (const scenario of suite.cases) {
  const input = { authorizedScope: scenario.input.authorizedScope, episodes: scenario.input.episodes };
  const key = sha(JSON.stringify(input));
  sourceInputs.set(key, input); sourceKeyFor.set(scenario.id, key);
}
assert.equal(new Set(suite.cases.map(item => item.id)).size, suite.cases.length);
assert.ok(sourceInputs.size + suite.cases.length <= plan.maxCalls);
report.uniqueSourceInputs = sourceInputs.size;
let child, closed, stderr = '', timer;
const controller = new AbortController();
const kill = signal => { if (child?.pid) { try { process.kill(-child.pid, signal); } catch {} } };
process.once('SIGTERM', () => controller.abort('terminated'));
process.once('SIGINT', () => controller.abort('interrupted'));
try {
  await save();
  report.networkGuard = JSON.parse(execFileSync('/opt/homebrew/bin/python3', ['-c',
    'import socket,json; s=socket.socket(); s.settimeout(1); print(json.dumps({"nonLoopbackConnectError":s.connect_ex(("1.1.1.1",443))})); s.close()'],
  { env, encoding: 'utf8' }));
  assert.equal(report.networkGuard.nonLoopbackConnectError, 1, 'OS sandbox must deny external network');
  const weights = createHash('sha256');
  for await (const chunk of createReadStream(modelPath)) weights.update(chunk);
  report.model = { name: plan.model, weightSha256: weights.digest('hex') };
  assert.equal(report.model.weightSha256, plan.weightSha256);
  const versionProbe = spawnSync(serverPath, ['--version'], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(versionProbe.status, 0, 'runtime version probe failed');
  report.runtimeVersion = [versionProbe.stdout, versionProbe.stderr].filter(Boolean).join('\n').trim();
  assert.match(report.runtimeVersion, /9870.*2d973636e/);
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`, apiKey = randomBytes(32).toString('hex');
  child = spawn(serverPath, ['--model', modelPath, '--alias', 'memory-reference', '--host', '127.0.0.1',
    '--port', String(port), '--api-key', apiKey, '--ctx-size', String(plan.contextTokens), '--parallel', '1',
    '--n-gpu-layers', '99', '--offline', '--no-webui', '--no-slots', '--no-cache-prompt', '--cache-ram', '0',
    '--chat-template-kwargs', JSON.stringify({ enable_thinking: false })],
  { env, cwd: output, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
  closed = new Promise(resolve => {
    child.once('error', error => { report.workerError = error.code; resolve(); });
    child.once('close', (code, signal) => { report.workerExit = { code, signal }; resolve(); });
  });
  const request = async (path, body, signal) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: signal ?? AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`local_http_${response.status}`);
    return response.json();
  };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !controller.signal.aborted) {
    if (child.exitCode !== null || child.signalCode !== null || report.workerError) throw new Error('worker_stopped');
    try { report.health = await request('/health'); break; } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.equal(report.health?.status, 'ok');
  timer = setTimeout(() => controller.abort('experiment_deadline'), plan.totalDeadlineMs);
  const infer = async (prompt, maxTokens) => {
    controller.signal.throwIfAborted(); assert.ok(report.inferenceCalls < plan.maxCalls);
    assert.ok(Buffer.byteLength(prompt) < 48_000);
    report.inferenceCalls++; const started = Date.now();
    const response = await request('/v1/chat/completions', { model: 'memory-reference',
      messages: [{ role: 'user', content: prompt }], stream: false, seed: plan.seed,
      temperature: plan.temperature, max_tokens: maxTokens, chat_template_kwargs: { enable_thinking: false } },
    AbortSignal.any([controller.signal, AbortSignal.timeout(plan.callDeadlineMs)]));
    const choice = response.choices[0], message = choice.message;
    assert.equal(message.role, 'assistant'); assert.equal(message.tool_calls?.length ?? 0, 0);
    return { durationMs: Date.now() - started, promptSha256: sha(prompt),
      answer: { text: message.content, finishReason: choice.finish_reason, model: response.model, usage: response.usage } };
  };
  const interpretations = new Map();
  console.log(JSON.stringify({ stage: 'ready', uniqueSources: sourceInputs.size, cases: suite.cases.length }));
  for (const [key, input] of sourceInputs) {
    const result = { key, ...await infer(sourcePrompt + JSON.stringify(input), plan.sourceOutputTokens) };
    try {
      assert.equal(result.answer.finishReason, 'stop');
      result.interpretation = validateInterpretation(JSON.parse(result.answer.text), input);
      interpretations.set(key, result.interpretation);
    } catch (error) { result.error = `invalid_source_interpretation: ${error.message}`; }
    report.sourceInterpretations.push(result); await save();
    console.log(JSON.stringify({ stage: 'source', key, durationMs: result.durationMs, error: result.error }));
  }
  report.sourceStageCompletedAt = new Date().toISOString(); await save();
  for (const scenario of suite.cases) {
    const sourceKey = sourceKeyFor.get(scenario.id);
    if (!interpretations.has(sourceKey)) {
      report.cases.push({ id: scenario.id, sourceKey, error: 'source_interpretation_unavailable' });
      await save(); continue;
    }
    const requiredPaths = materialFields.filter(field => Object.hasOwn(scenario.input.candidate, field)).map(field => `/${field}`);
    const input = { ...scenario.input, sourceInterpretation: interpretations.get(sourceKey), requiredPaths };
    const result = { id: scenario.id, sourceKey, requiredPaths,
      ...await infer(reviewPrompt + JSON.stringify(input), plan.reviewOutputTokens) };
    try {
      assert.equal(result.answer.finishReason, 'stop');
      result.review = validateReview(JSON.parse(result.answer.text), scenario.input, requiredPaths);
    } catch (error) { result.error = `invalid_proposal_review: ${error.message}`; }
    report.cases.push(result); await save();
    console.log(JSON.stringify({ stage: 'case', id: result.id, verdict: result.review?.verdict,
      durationMs: result.durationMs, error: result.error }));
  }
  for (const [file, expected] of [[resolve(here, plan.corpus), report.suiteSha256], [join(here, 'plan.json'), report.planSha256],
    [join(here, 'source-prompt.txt'), report.sourcePromptSha256], [join(here, 'review-prompt.txt'), report.reviewPromptSha256],
    [fileURLToPath(import.meta.url), report.runnerSha256]]) assert.equal(sha(await readFile(file)), expected);
  report.status = 'completed';
} catch (error) {
  report.status = 'stopped'; report.error = `${error.name}: ${error.message}`; process.exitCode = 1;
} finally {
  clearTimeout(timer);
  if (child) { kill('SIGTERM'); const stop = setTimeout(() => kill('SIGKILL'), 3000); await closed; clearTimeout(stop); }
  if (report.error) report.diagnosticStderr = stderr;
  report.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ stage: 'finished', status: report.status, calls: report.inferenceCalls,
    validReviews: report.cases.filter(item => item.review).length, workerExit: report.workerExit, error: report.error }));
}
