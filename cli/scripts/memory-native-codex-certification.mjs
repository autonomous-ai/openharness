// Run from cli: node --import tsx scripts/memory-native-codex-certification.mjs
// Actual installed CLI, disposable native home, fake credentials, localhost provider only.
// This checks the restricted extraction transport, not real inference or semantic quality.
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { CODEX_MEMORY_DISABLED_FEATURES } from '../src/memory/inference.ts'

const modelIndex = process.argv.indexOf('--model')
const model = modelIndex < 0 ? 'gpt-5.4' : process.argv[modelIndex + 1]
if (!model || model.startsWith('--')) throw new Error('--model requires a synthetic model identifier')
const fixture = await mkdtemp(join(tmpdir(), 'memory-codex-certification-'))
const runs = []
let current
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let body
  try { body = JSON.parse(Buffer.concat(chunks)) } catch { res.writeHead(400).end(); return }
  if (req.url !== '/v1/responses') { res.writeHead(404).end(); return }
  const outputs = (body.input ?? []).filter(item => item.type === 'function_call_output')
  current.requests.push({ model: body.model, tools: (body.tools ?? []).map(tool => tool.name ?? tool.type),
    toolResults: outputs.map(item => ({ unavailable: /unavailable|not available|not supported|unsupported|unknown tool|unrecognized/i.test(JSON.stringify(item.output)),
      syntheticOutput: item.output })) })
  const call = current.mode !== 'text' && current.requests.length === 1
  const item = call
    ? { id: `fc_${randomUUID()}`, type: 'function_call', call_id: 'call_fixture', name: current.mode,
      arguments: JSON.stringify(current.mode === 'request_user_input'
        ? { questions: [{ id: 'fixture', header: 'Fixture', question: 'Choose a synthetic value.',
          options: [{ label: 'A', description: 'Value A' }, { label: 'B', description: 'Value B' }] }] }
        : { cmd: 'touch forbidden-probe-file' }), status: 'completed' }
    : { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', channel: 'final', status: 'completed',
      content: [{ type: 'output_text', text: '{"proposals":[]}', annotations: [] }] }
  const response = { id: `resp_${randomUUID()}`, object: 'response', status: 'completed', model: body.model,
    output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  send({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })
  send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } })
  if (!call) {
    send({ type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: item.id,
      part: { type: 'output_text', text: '', annotations: [] } })
    send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: '{"proposals":[]}' })
    send({ type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: item.id, text: '{"proposals":[]}' })
  }
  send({ type: 'response.output_item.done', output_index: 0, item })
  send({ type: 'response.completed', response })
  res.end()
})
let child
try {
  for (const name of ['home', 'codex', 'work']) await mkdir(join(fixture, name), { mode: 0o700 })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const environment = { PATH: process.env.PATH, HOME: join(fixture, 'home'), CODEX_HOME: join(fixture, 'codex'),
    TMPDIR: fixture, TERM: 'dumb', HARNESS_MEMORY_TEST_KEY: 'synthetic-not-a-real-key' }
  const binary = process.env.CODEX_PATH || 'codex'
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8', env: environment, timeout: 5000 }).trim()
  const args = ['exec', '--json', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check',
    '--ignore-user-config', '--ignore-rules', '--model', model, '-c', 'web_search="disabled"',
    ...CODEX_MEMORY_DISABLED_FEATURES.flatMap(feature => ['--disable', feature]),
    ...(process.argv.includes('--disable-code-mode') ? ['--disable', 'code_mode', '--disable', 'code_mode_only'] : []),
    // These are the only additions to the production extraction command: redirect the provider.
    '-c', 'model_provider="memory_mock"', '-c', 'model_providers.memory_mock.name="Local certification fixture"',
    '-c', `model_providers.memory_mock.base_url="http://127.0.0.1:${server.address().port}/v1"`,
    '-c', 'model_providers.memory_mock.env_key="HARNESS_MEMORY_TEST_KEY"',
    '-c', 'model_providers.memory_mock.wire_api="responses"', '-c', 'model_providers.memory_mock.requires_openai_auth=false', '-']
  for (const mode of ['text', 'request_user_input', 'exec_command']) {
    current = { mode, requests: [], events: [] }
    runs.push(current)
    child = spawn(binary, args, { cwd: join(fixture, 'work'), env: environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false, oversized = false
    const active = child
    const kill = () => { if (active.pid && active.exitCode === null) { try { process.kill(-active.pid, 'SIGKILL') } catch { active.kill('SIGKILL') } } }
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 1_000_000) { oversized = true; kill() } })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(0, 10_000) })
    child.stdin.on('error', () => {})
    const timer = setTimeout(() => { timedOut = true; kill() }, 20_000)
    child.stdin.end('Synthetic extraction fixture. Return {"proposals":[]} without using tools.')
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
    clearTimeout(timer)
    child = undefined
    const lines = stdout.split('\n').filter(line => line.trim())
    let invalidEvents = 0, expectedAnswer = false
    for (const line of lines) {
      try {
        const event = JSON.parse(line)
        current.events.push({ type: event.type, ...(event.item?.type ? { itemType: event.item.type } : {}),
          ...(event.item?.type === 'error' ? { syntheticDiagnostic: event.item.message ?? event.item.text ?? event.item } : {}) })
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text === '{"proposals":[]}') expectedAnswer = true
      } catch { invalidEvents++ }
    }
    Object.assign(current, exit, { timedOut, oversized, invalidEvents, expectedAnswer,
      forbiddenFileExists: await stat(join(fixture, 'work', 'forbidden-probe-file')).then(() => true, () => false),
      diagnostics: { unknownFlag: /unknown.*(flag|argument)|unexpected argument/i.test(stderr),
        networkError: /error.*connect|network error/i.test(stderr),
        fallbackModelMetadata: /model metadata.*not found/i.test(stderr + stdout) } })
    current.passed = !timedOut && !oversized && !invalidEvents && !current.forbiddenFileExists
      && current.requests.length > 0 && current.requests.every(request => request.tools.every(tool => tool === 'request_user_input'))
      && (mode === 'text' ? exit.code === 0 && expectedAnswer && current.events.some(event => event.type === 'turn.completed')
        && !current.events.some(event => event.itemType === 'error' || event.type === 'error' || event.type === 'turn.failed')
        : current.requests.some(request => request.toolResults.some(result => result.unavailable)))
  }
  const passed = runs.every(run => run.passed)
  console.log(JSON.stringify({ date: new Date().toISOString(), engine: 'codex', version, model,
    disableCodeModeOverride: process.argv.includes('--disable-code-mode'), passed, runs,
    limitations: ['Local mock responses with fake credentials; no model inference or quality measurement.',
      'Native restrictions and event observations only; production adapter rejection also requires its regression tests.',
      'Model identifiers are mock labels; native model metadata may fall back in the isolated home.'] }, null, 2))
  if (!passed) process.exitCode = 1
} finally {
  if (child?.pid && child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(fixture, { recursive: true, force: true })
}
