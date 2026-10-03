import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from '/Users/ab/harnesses/worktrees/autonomous-harness/amber-maple/cli/node_modules/esbuild/lib/main.js'

const root = dirname(fileURLToPath(import.meta.url))
const repo = '/Users/ab/harnesses/worktrees/autonomous-harness/amber-maple'
const model = '/Users/ab/.grid/models/Qwen3.8-27B-Q4_0.gguf'
const hash = value => createHash('sha256').update(value).digest('hex')
const planText = await readFile(join(root, 'plan.json'), 'utf8'), plan = JSON.parse(planText)
const suiteText = await readFile(join(repo, plan.suite), 'utf8'), suite = JSON.parse(suiteText)
assert.equal(hash(suiteText), plan.suite_sha256)
assert.equal(suite.cases.length, 8)
const environment = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: join(root, 'home'),
  TMPDIR: join(root, 'tmp'), SQLITE_TMPDIR: join(root, 'tmp'), XDG_CACHE_HOME: join(root, 'cache'),
  HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' }
const guard = JSON.parse(execFileSync('/usr/bin/python3', ['-c',
  'import socket,json; s=socket.socket(); s.settimeout(1); print(json.dumps({"nonLoopbackConnectError":s.connect_ex(("1.1.1.1",443))})); s.close()'],
{ env: environment, encoding: 'utf8' }))
assert.equal(guard.nonLoopbackConnectError, 1)
const weights = createHash('sha256')
for await (const part of createReadStream(model)) weights.update(part)
const weightSha256 = weights.digest('hex')
assert.equal(weightSha256, 'ede16c7b36e578ca87a8c70e011e4b4633a32c831c0ce76d0f474582384e671d')
const sourceFiles = ['learner.ts', 'extractionEvidence.ts', 'inferenceStatus.ts', 'evaluation.ts',
  'evaluationContext.ts', 'evaluationReview.ts', 'store.ts', 'admission.ts', 'types.ts', 'queue.ts', 'context.ts', 'recallSources.ts']
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
  [file, hash(await readFile(join(repo, 'cli/src/memory', file)))])))
const bundle = join(root, 'core.mjs')
await build({ stdin: { contents: [
  `export { evaluateExtractionCase } from '${repo}/cli/src/memory/evaluation.ts';`,
  `export { EXTRACTION_PROMPT_VERSION } from '${repo}/cli/src/memory/learner.ts';`,
  `export { MEMORY_CONTEXT_VERSION } from '${repo}/cli/src/memory/context.ts';`,
].join('\n'), resolveDir: join(repo, 'cli') }, outfile: bundle, bundle: true, platform: 'node',
  format: 'esm', target: 'node22', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } })
const { evaluateExtractionCase, EXTRACTION_PROMPT_VERSION, MEMORY_CONTEXT_VERSION } = await import(pathToFileURL(bundle))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let calls = 0
for (const arm of plan.arms) {
  const output = join(root, 'reports', `${arm.id}.json`)
  const report = { schemaVersion: 1, suite: suite.suite, suiteSha256: hash(suiteText),
    promptVersion: EXTRACTION_PROMPT_VERSION, contextVersion: MEMORY_CONTEXT_VERSION, sourceHashes,
    runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))), planSha256: hash(planText),
    startedAt: new Date().toISOString(), status: 'running', selected: { engine: 'local-reference-llama',
      model: 'Qwen3.8-27B-Q4_0', weightSha256, selectionSource: 'Offline diagnostic reference, not selected companion' },
    limits: { ...plan, arm, maxCalls: 8 }, networkGuard: guard,
    limitations: ['Synthetic development cases already inspected during earlier experiments; not held-out or independently judged.',
      'No private transcripts, real provider calls, native delivery, production writes or model/agent preference changes.',
      'An exact source excerpt does not establish that the stored interpretation is supported.',
      'Only this reference model and bounded reasoning budget are tested; no claim of another model/framework quality.'],
    cases: [], inferenceCalls: 0 }
  const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  await save()
  let child, stderr = '', closedResolve
  const closed = new Promise(resolve => { closedResolve = resolve })
  const kill = signal => { if (child?.pid) { try { process.kill(-child.pid, signal) } catch {} } }
  try {
    const reservation = createServer()
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
    const port = reservation.address().port
    await new Promise(resolve => reservation.close(resolve))
    const base = `http://127.0.0.1:${port}`, apiKey = randomBytes(32).toString('hex')
    child = spawn('/opt/homebrew/bin/llama-server', ['--model', model, '--alias', 'memory-reference',
      '--host', '127.0.0.1', '--port', String(port), '--api-key', apiKey, '--ctx-size', '16384', '--parallel', '1',
      '--n-gpu-layers', '99', '--offline', '--no-webui', '--no-slots', '--no-cache-prompt', '--cache-ram', '0',
      '--reasoning-format', 'deepseek', '--reasoning-budget', String(arm.reasoning_tokens),
      '--chat-template-kwargs', JSON.stringify({ enable_thinking: arm.thinking })],
    { cwd: root, env: environment, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000) })
    child.on('error', error => { report.workerError = error.code; closedResolve() })
    child.on('close', (code, signal) => { report.workerExit = { code, signal }; closedResolve() })
    const request = async (path, body, signal) => {
      const response = await fetch(base + path, { method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: signal ?? AbortSignal.timeout(2000) })
      if (!response.ok) throw new Error(`local_http_${response.status}`)
      return response.json()
    }
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('local_server_stopped')
      try { report.runtime = { health: await request('/health'), version: '9870 (2d973636e)' }; break }
      catch { await sleep(200) }
    }
    assert.equal(report.runtime?.health?.status, 'ok')
    await save()
    console.log(JSON.stringify({ stage: 'ready', arm: arm.id, output, networkGuard: guard }))
    for (const scenario of suite.cases) {
      let answer = null, promptSha256 = null
      const started = Date.now()
      const result = await evaluateExtractionCase({ fixture: scenario,
        directory: join(root, 'stores', arm.id, scenario.id), engine: 'local-reference-llama',
        inference: { target: async () => ({ state: 'ready', key: `offline-reasoning-fidelity-${arm.id}` }),
          run: async (prompt, options) => {
            assert.ok(calls < plan.max_calls && report.inferenceCalls < 8)
            calls++; report.inferenceCalls++; promptSha256 = hash(prompt)
            const response = await request('/v1/chat/completions', { model: 'memory-reference',
              messages: [{ role: 'user', content: prompt }], stream: false, seed: plan.seed,
              temperature: plan.temperature, max_tokens: plan.max_output_tokens,
              chat_template_kwargs: { enable_thinking: arm.thinking } }, options.signal)
            const choice = response.choices[0], message = choice.message
            assert.equal(message.role, 'assistant'); assert.equal(message.tool_calls?.length ?? 0, 0)
            answer = { text: message.content, metrics: { finishReason: choice.finish_reason,
              usage: response.usage, timings: response.timings, reasoningCharacters: message.reasoning_content?.length ?? 0 } }
            return answer.text
          } } })
      report.cases.push({ ...result, promptSha256, answer, elapsedMs: Date.now() - started })
      await save()
      console.log(JSON.stringify({ stage: 'case', arm: arm.id, id: scenario.id, outcome: result.outcome,
        failedChecks: result.checks.filter(row => row.passed === false).map(row => row.name),
        elapsedMs: Date.now() - started, outputTokens: answer?.metrics.usage?.completion_tokens,
        reasoningCharacters: answer?.metrics.reasoningCharacters }))
      if (result.outcome.reason === 'inference_timeout' || child.exitCode !== null || child.signalCode !== null
        || ['waiting_for_model', 'budget_deferred', 'stale'].includes(result.outcome.state)) break
    }
    report.status = report.cases.length === suite.cases.length ? 'completed' : 'stopped'
  } catch (error) {
    report.status = 'stopped'; report.error = `${error.name}: ${error.message}`; process.exitCode = 1
  } finally {
    if (child) { kill('SIGTERM'); const timer = setTimeout(() => kill('SIGKILL'), 3000); await closed; clearTimeout(timer); kill('SIGKILL') }
    report.completedCases = report.cases.filter(row => row.checks.some(check => check.name === 'completed_extraction' && check.passed === true)).length
    if (report.error || report.completedCases < suite.cases.length) report.diagnosticStderr = stderr
    report.finishedAt = new Date().toISOString(); await save()
    console.log(JSON.stringify({ stage: 'finished', arm: arm.id, output, status: report.status,
      completedCases: report.completedCases, inferenceCalls: report.inferenceCalls, error: report.error, workerExit: report.workerExit }))
  }
  if (report.error || report.cases.some(row => row.outcome.reason === 'inference_timeout')) break
}
