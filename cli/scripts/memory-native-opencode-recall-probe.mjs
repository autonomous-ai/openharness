// Native hook research: OpenCode 1.18.34, disposable HOME/database and localhost model only.
// This records the outgoing request and native storage; it does not grade semantic memory use.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'

const directory = await realpath(await mkdtemp(join(tmpdir(), 'memory-opencode-recall-')))
const workspace = join(directory, 'work'), database = join(directory, 'native.db')
const marker = 'harness-memory-transport-619f9e'
const correctedMarker = 'harness-memory-corrected-883bb0'
const derivedMarker = 'harness-derived-action-not-source-e723ab'
const requests = [], observations = []
const owner = 'synthetic-owner', access = { profileId: owner, projectIds: [], includeProfile: true }
let native, nativeUrl, stdout = '', stderr = '', allowedSession, phase = 'on', runtime, store, requestAgent
let report
let lastNativeRoute = null
let overflowSent = false
let errorSent = false
const server = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks))
  if (request.url === '/fixture/observe') {
    observations.push(body)
    if (body.hook === 'chat.params') requestAgent = body.agent
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return
  }
  if (request.url?.startsWith('/api/hook/')) {
    // The HTTP shim supplies the fixture's known process/session binding; production hook-server
    // authentication/ancestry is covered separately, not claimed by this transport probe.
    assert.equal(body.callerPid, native.pid)
    assert.equal(request.headers['x-harness-hook-token'], 'synthetic-hook-token')
    if (body.sessionId !== allowedSession) { response.writeHead(403).end(); return }
    if (phase === 'unavailable') { response.writeHead(503).end(); return }
    let result
    if (request.url.endsWith('/memory-emitted')) {
      result = { recorded: await runtime.promptRecallEmitted('fixture-agent', body.memoryReceiptId) }
    } else {
      const prepared = await runtime.preparePromptRecall('fixture-agent', { query: body.prompt },
        { engine: body.engine, cliVersion: body.cliVersion })
      result = { additionalContext: prepared.packet.text, memoryReceiptId: prepared.receipt?.id }
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result)); return
  }
  const matching = (body.messages ?? []).filter(message => JSON.stringify(message).includes(marker))
  requests.push({ phase, agent: requestAgent, model: body.model, roles: matching.map(message => message.role),
    markers: JSON.stringify(body).split(marker).length - 1,
    correctedMarkers: JSON.stringify(body).split(correctedMarker).length - 1,
    sourceContext: JSON.stringify(body).includes('coding_memory_sources'),
    derivedSummaryReceived: JSON.stringify(body).includes(derivedMarker),
    hasCurrentRequest: JSON.stringify(body).includes('Synthetic parser review') })
  if (phase === 'overflow-replay' && !errorSent) {
    errorSent = true
    response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: {
      message: "This model's maximum context length is 128000 tokens. However, you requested 129000 tokens.",
      type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded',
    } })); return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const overflow = phase === 'auto-prime' && !overflowSent
  if (overflow) overflowSent = true
  const base = { id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 1, model: body.model }
  for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'Ready.' }, null], [{}, 'stop']]) {
    response.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }],
      ...(finish_reason ? { usage: { prompt_tokens: overflow ? 127000 : 100, completion_tokens: 2, total_tokens: overflow ? 127002 : 102 } } : {}) }) + '\n\n')
  }
  response.end('data: [DONE]\n\n')
})

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  for (const name of ['home', 'config', 'data', 'cache', 'state', 'work']) await mkdir(join(directory, name), { mode: 0o700 })
  execFileSync('git', ['init', '-q', workspace])
  const url = `http://127.0.0.1:${server.address().port}`
  const cli = dirname(dirname(fileURLToPath(import.meta.url))), bundle = join(directory, 'probe.mjs')
  await build({ stdin: { contents: [
    `export { opencodeRecallPluginSource } from ${JSON.stringify(join(cli, 'src/lib/opencodeRecallPlugin.ts'))};`,
    `export { opencodeMemoryPluginSource } from ${JSON.stringify(join(cli, 'src/lib/opencodeMemoryPlugin.ts'))};`,
    `export { CodingMemoryStore } from ${JSON.stringify(join(cli, 'src/memory/store.ts'))};`,
    `export { CodingMemoryRuntime } from ${JSON.stringify(join(cli, 'src/memory/runtime.ts'))};`,
    `export { QUEUE_OPERATIONS } from ${JSON.stringify(join(cli, 'src/memory/operations.ts'))};`,
  ].join('\n'), resolveDir: cli }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    banner: { js: "import { createRequire as createFixtureRequire } from 'node:module'; const require = createFixtureRequire(import.meta.url);" } })
  const { opencodeRecallPluginSource, opencodeMemoryPluginSource, CodingMemoryStore, CodingMemoryRuntime, QUEUE_OPERATIONS } = await import(pathToFileURL(bundle).href)
  runtime = new CodingMemoryRuntime({ directory: join(directory, 'memory'),
    context: () => ({ experimental: true, watching: true, profileId: owner }),
    sessions: () => allowedSession ? [{ agentId: 'fixture-agent', engine: 'opencode', sessionId: allowedSession,
      workspace, transcriptPath: database, scope: 'profile', busy: false, coding: true }] : [],
    inference: { target: async () => ({ state: 'waiting' }), run: async () => { throw new Error('No model extraction in transport probe') } },
    create: profileId => {
      const opened = CodingMemoryStore.open({ directory: join(directory, 'memory'), profileId })
      assert.ok(opened.ok); store = opened.store
      return { request: async (operation, args) => (QUEUE_OPERATIONS.includes(operation) ? store.learning : store)[operation](...args),
        close: async () => store.close() }
    },
  })
  const plugin = join(directory, 'recall.mjs')
  await writeFile(plugin, `const hookToken = () => 'synthetic-hook-token';
  export const Fixture = async ({client}) => {
    ${opencodeMemoryPluginSource(server.address().port)}
    ${opencodeRecallPluginSource(server.address().port)}
    const post = async (route, body) => {
      const response = await fetch(${JSON.stringify(url)} + route, { method: 'POST', signal: AbortSignal.timeout(400),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return response.ok ? response.json() : null
    }
    return {
      'chat.message': async (input, output) => {
        await memoryMessage(input, output)
        await recallMessage(input, output)
        await post('/fixture/observe', { hook: 'chat.message', input, message: output.message,
          parts: output.parts.map(part => ({ ...part, text: part.text ? '[synthetic prompt]' : undefined })) })
      },
      'experimental.session.compacting': async (input) => {
        await recallCompacting(input)
        await post('/fixture/observe', { hook: 'compacting', input })
      },
      'experimental.compaction.autocontinue': async (input) => {
        await recallAutoContinue(input)
        await post('/fixture/observe', { hook: 'autocontinue', input: { sessionID: input.sessionID,
          agent: input.agent, message: input.message, overflow: input.overflow } })
      },
      'chat.params': async (input) => { await post('/fixture/observe', { hook: 'chat.params', agent: input.agent, sessionID: input.sessionID }) },
      'experimental.chat.messages.transform': async (_input, output) => {
        try {
          await post('/fixture/observe', { hook: 'messages.transform', messages: output.messages.map(item => ({
            info: item.info, parts: item.parts.map(part => ({ id: part.id, type: part.type, synthetic: part.synthetic,
              metadata: part.metadata, auto: part.auto, overflow: part.overflow })) })) })
          await recallTransform(_input, output)
        } catch { /* Optional recall cannot fail the native request. */ }
      },
    }
  }`, { mode: 0o600 })
  const config = { autoupdate: false, share: 'disabled', snapshot: false, permission: { '*': 'deny' },
    plugin: [pathToFileURL(plugin).href], mcp: {}, instructions: [], enabled_providers: ['fixture'],
    model: 'fixture/model', small_model: 'fixture/model', compaction: { auto: true, prune: false },
    agent: { memory_fixture: { mode: 'primary', description: 'Synthetic recall fixture',
      prompt: 'Answer briefly without tools.', permission: { '*': 'deny' }, steps: 1 } },
    provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { apiKey: 'synthetic', baseURL: url + '/v1' },
      models: { model: { name: 'Synthetic', limit: { context: 128000, output: 4096 } } } } } }
  native = spawn(process.env.OPENCODE_PATH || 'opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, TMUX_PANE: '%424242',
      HOME: join(directory, 'home'), TMPDIR: directory, XDG_CONFIG_HOME: join(directory, 'config'),
      XDG_DATA_HOME: join(directory, 'data'), XDG_CACHE_HOME: join(directory, 'cache'), XDG_STATE_HOME: join(directory, 'state'),
      OPENCODE_DB: database, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_AUTH_CONTENT: '{}',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
      // This plain-JS fixture imports no SDK packages. Fail native background npm installs
      // immediately offline instead of waiting for registry retries before loading our plugin.
      npm_config_offline: 'true',
      TERM: 'dumb' },
  })
  native.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-5000); nativeUrl = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] })
  native.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-5000) })
  const deadline = Date.now() + 10000
  while (!nativeUrl && native.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(nativeUrl, `Native server did not start: ${stderr}`)
  const call = async (route, body) => {
    lastNativeRoute = route
    const response = await fetch(nativeUrl + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-opencode-directory': workspace },
      signal: AbortSignal.timeout(25000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.ok(response.ok, `${route}: ${response.status}`)
    return response.json()
  }
  assert.equal((await call('/global/health')).version, '1.18.34')
  allowedSession = (await call('/session', { title: 'Synthetic recall source' })).id
  await runtime.tick()
  const claim = `For parser reviews, start with a small failing example. ${marker}`
  store.ingest({ id: 'synthetic-claude-source', profileId: owner, projectId: null, engine: 'claude', sessionId: 'synthetic-claude',
    nativeEventId: 'synthetic-statement', role: 'user', eligibility: 'coding', observedAt: Date.now(),
    rootIds: ['synthetic-claude-source'], text: claim })
  const draft = { kind: 'working_preference', facet: 'debugging', assertionType: 'stated_preference', scope: { profileId: owner },
    claim, rationale: null, futureAction: `For parser reviews, start with a small failing example. ${derivedMarker}`, applicability: {}, exceptions: [], retrievalCues: ['parser', 'review'],
    evidenceClass: 'user_stated', evidence: [{ sourceEventId: 'synthetic-claude-source', quote: claim,
      paths: ['/claim', '/futureAction', '/applicability'] }], conflictKey: 'parser-review',
    validity: { validFrom: null, validUntil: null, recheckWhen: [] } }
  const record = store.propose(draft, access).record
  await runtime.configure({ learn: false, recall: true })
  const send = id => call(`/session/${id}/message`, { agent: 'memory_fixture', model: { providerID: 'fixture', modelID: 'model' },
    parts: [{ type: 'text', text: 'Synthetic parser review. Respond briefly without tools.' }] })
  await send(allowedSession)
  assert.ok(requests.some(request => request.phase === 'on' && request.markers === 1 && request.roles[0] === 'user' && request.hasCurrentRequest))
  assert.ok(requests.some(request => request.phase === 'on' && request.sourceContext))
  assert.ok(requests.every(request => !request.derivedSummaryReceived))
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const persisted = db.prepare('SELECT COUNT(*) AS n FROM part WHERE instr(data,?)>0').get(marker).n
    assert.equal(persisted, 0, 'Ephemeral recall must not become native user evidence')
    phase = 'off'; await runtime.configure({ learn: false, recall: false }); await send(allowedSession)
    await runtime.configure({ learn: false, recall: true })
    phase = 'source-private'; store.setSessionIncluded('claude', 'synthetic-claude', false); await send(allowedSession)
    store.setSessionIncluded('claude', 'synthetic-claude', true)
    phase = 'unavailable'; await send(allowedSession)
    phase = 'other-session'; await send((await call('/session', { title: 'Unrelated synthetic session' })).id)
    for (const name of ['off', 'source-private', 'unavailable', 'other-session']) {
      const sent = requests.filter(request => request.phase === name && request.hasCurrentRequest)
      assert.ok(sent.length > 0); assert.ok(sent.every(request => request.markers === 0))
    }
    phase = 'compaction'
    await call(`/session/${allowedSession}/summarize`, { providerID: 'fixture', modelID: 'model' })
    assert.ok(requests.filter(request => request.phase === 'compaction').every(request => request.markers === 0))
    phase = 'auto-prime'; await send(allowedSession)
    phase = 'auto-compact'; await send(allowedSession)
    const automatic = requests.filter(request => request.phase === 'auto-prime')
    assert.equal(automatic.filter(request => request.agent === 'compaction').length, 1)
    assert.ok(automatic.filter(request => request.agent === 'compaction').every(request => request.markers === 0))
    assert.equal(automatic.filter(request => request.agent === 'memory_fixture' && request.markers === 1).length, 2)
    phase = 'overflow-replay'; await send(allowedSession)
    const replay = requests.filter(request => request.phase === 'overflow-replay')
    assert.equal(replay.filter(request => request.agent === 'compaction').length, 1)
    assert.ok(replay.filter(request => request.agent === 'compaction').every(request => request.markers === 0))
    assert.equal(replay.filter(request => request.agent === 'memory_fixture' && request.markers === 1 && request.hasCurrentRequest).length, 2)
    const { evidence: _evidence, evidenceClass: _class, ...correction } = draft
    const corrected = store.correctFromUser(record.id, record.revision, { ...correction,
      claim: `For parser reviews, first confirm the failing example. ${correctedMarker}`,
      futureAction: 'For parser reviews, first confirm the failing example.' }, access)
    phase = 'corrected'; await send(allowedSession)
    assert.ok(requests.filter(request => request.phase === 'corrected').every(request => request.markers === 0 && request.correctedMarkers === 1))
    store.forget(record.id, corrected.revision, access)
    phase = 'forgotten'; await send(allowedSession)
    assert.ok(requests.filter(request => request.phase === 'forgotten').every(request => request.markers === 0 && request.correctedMarkers === 0))
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM part WHERE instr(data,?)>0').get(marker).n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM part WHERE instr(data,?)>0').get(correctedMarker).n, 0)
    assert.ok(requests.every(request => !request.derivedSummaryReceived))
    report = { version: '1.18.34', requests, result: { nativeModelRequestReceivedContext: true,
      sourceContextFormat: 'coding_memory_sources', generatedActionReceived: false,
      persistedMemoryParts: persisted, offReceivedContext: false, unavailableBlockedPrompt: false,
      otherSessionReceivedContext: false, compactionReceivedContext: false, automaticContinuationReceivedContext: true,
      correctedReceivedLatestRevision: true, forgottenReceivedContext: false, sourcePrivacyRespected: true,
      overflowReplayReceivedContext: true,
      sourceEngine: 'claude', receivingEngine: 'opencode', learnOffRecallOn: true },
      limitations: ['Synthetic seeded Claude evidence/proposal; no real model extraction or semantic usefulness measurement.',
        'Production plugin and shared runtime/store; fixture HTTP/process binding, not production ancestry resolution.',
        'No interactive TUI or provider matrix certification.'] }
    console.log(JSON.stringify(report, null, 2))
  } finally { db.close() }
} catch (error) {
  const logs = []
  const directoryPath = join(directory, 'data', 'opencode', 'log')
  for (const entry of (await readdir(directoryPath, { withFileTypes: true }).catch(() => [])).slice(-4)) {
    if (!entry.isFile() || !entry.name.endsWith('.log')) continue
    const text = await readFile(join(directoryPath, entry.name), 'utf8').catch(() => '')
    logs.push({ name: entry.name, text: text.slice(-12_000) })
  }
  report = { status: 'failed', phase, lastNativeRoute, requests,
    error: { name: error?.name, message: error?.message }, nativeDiagnostics: { stdout, stderr, logs } }
  console.error(JSON.stringify(report, null, 2).replaceAll(directory, '/fixture'))
  throw error
} finally {
  if (process.env.MEMORY_RECALL_RECORDING) await writeFile(process.env.MEMORY_RECALL_RECORDING,
    JSON.stringify({ ...report, requests, observations }, null, 2).replaceAll(directory, '/fixture') + '\n', { mode: 0o600 })
  if (native?.exitCode === null && native?.signalCode === null) {
    try { process.kill(-native.pid, 'SIGKILL') } catch { native.kill('SIGKILL') }
    await new Promise(resolve => native.once('close', resolve))
  }
  await runtime?.close()
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
