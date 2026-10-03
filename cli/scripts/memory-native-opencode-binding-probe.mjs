// Manual integration check: node cli/scripts/memory-native-opencode-binding-probe.mjs
// A live disposable OpenCode server observes foreground selection, then the actual companion
// intelligence extracts with that binding. All credentials and model responses are synthetic.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const fixture = await mkdtemp(join(tmpdir(), 'native-opencode-binding-'))
const cli = dirname(dirname(fileURLToPath(import.meta.url)))
const requests = [], hooks = []
const keySource = process.env.HARNESS_MEMORY_NATIVE_KEY_SOURCE === 'auth' ? 'auth' : 'config'
let native, nativeUrl, stdout = '', stderr = '', phase = 'startup', sessionId, enabled = false, binding
const processKey = () => native && `${native.pid}:disposable-opencode-server`
const alive = () => native?.exitCode === null && native?.signalCode === null
const actor = () => ({ agentId: 'synthetic-companion', sessionId, processKey: processKey() })
const owner = () => enabled && alive() && sessionId ? { ...actor(), ownerKey: 'synthetic-owner', model: null } : null
const model = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  let body
  try { body = JSON.parse(Buffer.concat(chunks)) }
  catch { response.writeHead(400).end(); return }
  if (request.url === '/api/hook/opencode-memory-runtime') {
    assert.equal(body.callerPid, native.pid)
    assert.equal(body.sessionId, sessionId)
    assert.equal(body.tmuxPane, '%424242')
    assert.equal(request.headers['x-harness-hook-token'], 'synthetic-hook-token')
    hooks.push({ phase, kind: body.input.kind, nativeVersion: body.input.nativeVersion,
      model: body.input.snapshot?.model, variant: body.input.snapshot?.variant,
      selectedCredential: body.input.snapshot ? body.input.snapshot.auth?.key === 'synthetic-selected-account' : undefined })
    const result = binding.receive(actor(), body.input)
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
    return
  }
  requests.push({ phase, route: request.url, model: body.model, reasoningEffort: body.reasoning_effort,
    tools: (body.tools ?? []).map(tool => tool.function?.name ?? tool.name),
    selectedCredential: request.headers.authorization === 'Bearer synthetic-selected-account' })
  const base = { id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 1, model: body.model }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const [delta, finish_reason] of [[{ role: 'assistant', content: '{"proposals":[]}' }, null], [{}, 'stop']]) {
    response.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
  }
  response.end('data: [DONE]\n\n')
})

try {
  await new Promise((resolve, reject) => { model.once('error', reject); model.listen(0, '127.0.0.1', resolve) })
  for (const name of ['home', 'config', 'data', 'cache', 'state', 'work', 'reasoning']) await mkdir(join(fixture, name), { mode: 0o700 })
  const bundle = join(fixture, 'probe.mjs')
  await build({ stdin: { contents: [
    `export { opencodeMemoryPluginSource } from ${JSON.stringify(join(cli, 'src/lib/opencodeMemoryPlugin.ts'))};`,
    `export { OpenCodeMemoryBinding } from ${JSON.stringify(join(cli, 'src/memory/opencodeBinding.ts'))};`,
    `export { CompanionIntelligence } from ${JSON.stringify(join(cli, 'src/pair/intelligence.ts'))};`,
  ].join('\n'), resolveDir: cli }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  })
  const { opencodeMemoryPluginSource, OpenCodeMemoryBinding, CompanionIntelligence } = await import(pathToFileURL(bundle).href)
  binding = new OpenCodeMemoryBinding({ current: owner })
  const plugin = join(fixture, 'plugin.mjs')
  await writeFile(plugin, `const hookToken = () => 'synthetic-hook-token';
    export const Fixture = async ({client}) => { ${opencodeMemoryPluginSource(model.address().port)}; return { 'chat.message': memoryMessage, 'chat.params': memoryParams } }`, { mode: 0o600 })
  const selectedModel = 'memory-fixture/alias'
  const config = { autoupdate: false, share: 'disabled', snapshot: false, permission: { '*': 'deny' },
    plugin: [pathToFileURL(plugin).href], mcp: {}, instructions: [], enabled_providers: ['memory-fixture'],
    model: selectedModel, small_model: selectedModel,
    agent: { memory_fixture: { mode: 'primary', description: 'Synthetic foreground agent',
      prompt: 'Return only the requested JSON without tools.', permission: { '*': 'deny' }, steps: 1 } },
    provider: { 'memory-fixture': { name: 'Synthetic selected provider', npm: '@ai-sdk/openai-compatible',
      options: { ...(keySource === 'config' ? { apiKey: 'synthetic-selected-account' } : {}),
        baseURL: `http://127.0.0.1:${model.address().port}/v1` },
      models: { alias: { id: 'provider-native-id', name: 'Synthetic model alias', reasoning: true,
        limit: { context: 128000, output: 4096 }, variants: { high: { reasoningEffort: 'high' } } } } } },
  }
  const environment = { PATH: process.env.PATH, HOME: join(fixture, 'home'), TMPDIR: fixture, TMUX_PANE: '%424242',
    XDG_CONFIG_HOME: join(fixture, 'config'), XDG_DATA_HOME: join(fixture, 'data'), XDG_CACHE_HOME: join(fixture, 'cache'),
    XDG_STATE_HOME: join(fixture, 'state'), OPENCODE_DB: join(fixture, 'foreground.db'), OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_AUTH_CONTENT: JSON.stringify({ 'memory-fixture': { type: 'api', key: keySource === 'auth' ? 'synthetic-selected-account' : 'synthetic-unselected-login' } }),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOCOMPACT: '1', TERM: 'dumb' }
  native = spawn(process.env.OPENCODE_PATH || 'opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: join(fixture, 'work'), env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  native.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-5000); nativeUrl = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] })
  native.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-5000) })
  const waitUntil = Date.now() + 10000
  while (!nativeUrl && alive() && Date.now() < waitUntil) await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(nativeUrl && alive(), `Disposable native server did not start: ${stderr}`)
  const call = async (route, body) => {
    const response = await fetch(nativeUrl + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-opencode-directory': join(fixture, 'work') },
      signal: AbortSignal.timeout(25000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.ok(response.ok, `Native fixture route failed (${response.status})`)
    return response.json()
  }
  const health = await call('/global/health')
  assert.equal(health.version, '1.18.34')
  sessionId = (await call('/session', { title: 'Synthetic companion fixture' })).id
  assert.ok(sessionId)
  const prompt = () => call(`/session/${sessionId}/message`, { agent: 'memory_fixture',
    model: { providerID: 'memory-fixture', modelID: 'alias' }, variant: 'high',
    parts: [{ type: 'text', text: 'Synthetic foreground request. Return {"proposals":[]} without tools.' }] })
  phase = 'off'; await prompt()
  assert.equal(binding.read(actor()), null)
  assert.ok(hooks.some(hook => hook.phase === 'off' && hook.kind === 'probe'))
  assert.equal(hooks.some(hook => hook.phase === 'off' && hook.kind === 'observe'), false)
  enabled = true; phase = 'foreground'; await prompt()
  const snapshot = binding.read(actor())
  assert.equal(snapshot?.model, selectedModel)
  assert.equal(snapshot?.auth.key, 'synthetic-selected-account')
  assert.equal(snapshot?.variant, 'high')
  phase = 'compaction'
  const observedBeforeCompaction = binding.identity(actor()), hooksBeforeCompaction = hooks.length
  await call(`/session/${sessionId}/summarize`, { providerID: 'memory-fixture', modelID: 'alias' })
  assert.equal(binding.identity(actor()), observedBeforeCompaction, 'Internal compaction cannot replace the user selection')
  assert.equal(hooks.length, hooksBeforeCompaction, 'Internal compaction must not request a new selection grant')
  assert.ok(alive())
  const intelligence = new CompanionIntelligence({ enabled: () => enabled, current: () => ({ ...actor(),
    engine: 'opencode', stopped: !alive(), profile: null, nativeProcessKey: processKey(),
    accountKey: binding.identity(actor()), customProvider: true }),
    directory: join(fixture, 'reasoning'), stateFile: join(fixture, 'profile.json'),
    openCodeSnapshot: () => binding.read(actor()),
  })
  phase = 'extraction'
  const target = await intelligence.extractionStatus()
  assert.equal(target.state, 'ready')
  const text = await intelligence.extract('Synthetic historical coding evidence. Return {"proposals":[]} without tools.', {
    timeoutMs: 20000, signal: new AbortController().signal, contextKey: target.contextKey,
  })
  assert.equal(text, '{"proposals":[]}')
  assert.ok(alive(), 'The selected foreground process must remain alive during extraction')
  assert.equal((await readFile(join(fixture, 'profile.json'), 'utf8')).includes('synthetic-selected-account'), false)
  assert.deepEqual(await readdir(join(fixture, 'reasoning')), [])
  for (const request of requests) {
    assert.equal(request.model, 'provider-native-id'); assert.equal(request.selectedCredential, true)
    if (request.phase !== 'compaction') assert.equal(request.reasoningEffort, 'high')
    assert.deepEqual(request.tools, [])
  }
  enabled = false; binding.clear()
  const before = requests.length
  assert.equal(await intelligence.extract('Must not run while off.', { timeoutMs: 20000,
    signal: new AbortController().signal, contextKey: target.contextKey }), null)
  assert.equal(requests.length, before)
  console.log(JSON.stringify({ at: new Date().toISOString(), version: health.version, keySource, requests, hooks,
    result: { observedSelection: true, selectedProcessAliveDuringExtraction: true, inheritedAccountModelVariant: true,
      manualCompactionPreservedSelection: true,
      offSentCredentials: false, offLaunchedExtraction: false, credentialsPersistedInProfile: false, privateStorageRemoved: true },
    limitations: ['Synthetic localhost responses; no personal conversations or semantic-quality measurement.',
      'Consent and process ownership are fixture inputs; the actual hook-server authorization is covered separately.',
      'No OAuth, OpenCode 2.x, automatic compaction, capture or recall certification.'],
  }, null, 2))
} finally {
  if (alive()) {
    try { process.kill(-native.pid, 'SIGKILL') } catch { native.kill('SIGKILL') }
    await new Promise(resolve => native.once('close', resolve))
  }
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve))
  await rm(fixture, { recursive: true, force: true })
}
