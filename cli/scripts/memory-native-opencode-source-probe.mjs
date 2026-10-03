// Real OpenCode 1.18.34, disposable HOME/database, synthetic localhost model only.
// Run: node cli/scripts/memory-native-opencode-source-probe.mjs
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'

const directory = await realpath(await mkdtemp(join(tmpdir(), 'memory-opencode-source-')))
const database = join(directory, 'native.db'), workspace = join(directory, 'work')
const cli = dirname(dirname(fileURLToPath(import.meta.url)))
const consentAt = Date.now()
let native, nativeUrl, stderr = '', stdout = '', phase = 'turn', requestedTool = false
let sentOverflow = false, originMetadataForwarded = false
const markOrigins = process.env.MEMORY_SOURCE_ORIGINS !== '0'
let store
let closeSources = () => {}
const model = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks))
  originMetadataForwarded ||= JSON.stringify(body).includes('harness_submission')
  if (phase === 'overflow' && !sentOverflow) {
    sentOverflow = true
    response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: {
      message: "This model's maximum context length is 128000 tokens. However, you requested 129000 tokens.",
      type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded',
    } })); return
  }
  const tools = (body.tools ?? []).map(tool => tool.function?.name)
  const read = phase === 'turn' && tools.includes('read') && !requestedTool
  if (read) requestedTool = true
  const base = { id: 'chatcmpl_source', object: 'chat.completion.chunk', created: 1, model: body.model }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const delta = read ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_source', type: 'function',
    function: { name: 'read', arguments: JSON.stringify({ filePath: join(workspace, 'fixture.txt') }) } }] }
    : { role: 'assistant', content: phase === 'compaction' ? 'Synthetic context summary.' : 'I will keep the viewer on the left.' }
  response.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
  response.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: read ? 'tool_calls' : 'stop' }] }) + '\n\n')
  response.end('data: [DONE]\n\n')
})

try {
  await new Promise((resolve, reject) => { model.once('error', reject); model.listen(0, '127.0.0.1', resolve) })
  for (const name of ['home', 'config', 'data', 'cache', 'state', 'work']) await mkdir(join(directory, name), { mode: 0o700 })
  execFileSync('git', ['init', '-q', workspace])
  await writeFile(join(workspace, 'fixture.txt'), 'Synthetic fixture data.\n')
  const bundle = join(directory, 'capture.mjs')
  await build({ stdin: { contents: [
    `export { NativeMemoryCapture } from ${JSON.stringify(join(cli, 'src/memory/capture.ts'))};`,
    `export { CodingMemoryStore } from ${JSON.stringify(join(cli, 'src/memory/store.ts'))};`,
    `export { QUEUE_OPERATIONS } from ${JSON.stringify(join(cli, 'src/memory/operations.ts'))};`,
    `export { closeSqliteHandles } from ${JSON.stringify(join(cli, 'src/lib/sqliteRead.ts'))};`,
    `export { opencodeMemoryPluginSource } from ${JSON.stringify(join(cli, 'src/lib/opencodeMemoryPlugin.ts'))};`,
  ].join('\n'), resolveDir: cli }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } })
  const { NativeMemoryCapture, CodingMemoryStore, QUEUE_OPERATIONS, closeSqliteHandles, opencodeMemoryPluginSource } = await import(pathToFileURL(bundle).href)
  closeSources = closeSqliteHandles
  const opened = CodingMemoryStore.open({ directory: join(directory, 'memory'), profileId: 'fixture', now: () => consentAt })
  assert.ok(opened.ok); store = opened.store
  store.registerProject('project'); store.setControls({ learn: true, recall: true })
  const capture = new NativeMemoryCapture({ async request(operation, args) {
    const receiver = QUEUE_OPERATIONS.includes(operation) ? store.learning : store
    return receiver[operation](...args)
  } })
  const captureSession = id => capture.poll({ profileId: 'fixture', projectId: 'project', engine: 'opencode',
    sessionId: id, transcriptPath: database, workspace, busy: false })
  const drain = () => {
    const target = { state: 'ready', key: 'synthetic' }, claim = store.learning.claim(target)
    assert.equal(claim.state, 'claimed')
    store.learning.finish(claim.lease, [], target)
    return claim.lease
  }
  const plugin = join(directory, 'origin.mjs')
  await writeFile(plugin, `const hookToken = () => ''; export const Fixture = async ({client}) => {
    ${opencodeMemoryPluginSource(1)}; return { 'chat.message': memoryMessage } }`, { mode: 0o600 })
  const config = { autoupdate: false, share: 'disabled', snapshot: false,
    plugin: markOrigins ? [pathToFileURL(plugin).href] : [], mcp: {}, instructions: [],
    compaction: { auto: true, prune: false },
    permission: { '*': 'deny', read: { '*': 'deny', 'fixture.txt': 'allow', [join(workspace, 'fixture.txt')]: 'allow' } },
    enabled_providers: ['fixture'], model: 'fixture/model', small_model: 'fixture/model',
    agent: { source_fixture: { mode: 'primary', description: 'Native source fixture',
      prompt: 'Use read once, then answer briefly.', steps: 3 } },
    provider: { fixture: { npm: '@ai-sdk/openai-compatible',
      options: { apiKey: 'synthetic', baseURL: `http://127.0.0.1:${model.address().port}/v1` },
      models: { model: { name: 'Synthetic', limit: { context: 128000, output: 4096 } } } } } }
  native = spawn(process.env.OPENCODE_PATH || 'opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH,
      HOME: join(directory, 'home'), TMPDIR: directory, XDG_CONFIG_HOME: join(directory, 'config'),
      XDG_DATA_HOME: join(directory, 'data'), XDG_CACHE_HOME: join(directory, 'cache'), XDG_STATE_HOME: join(directory, 'state'),
      OPENCODE_DB: database, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_AUTH_CONTENT: '{}',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
      TERM: 'dumb' },
  })
  native.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-5000); nativeUrl = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] })
  native.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-5000) })
  const deadline = Date.now() + 10000
  while (!nativeUrl && native.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(nativeUrl, `Native server did not start: ${stderr}`)
  const call = async (path, body) => {
    const response = await fetch(nativeUrl + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-opencode-directory': workspace },
      signal: AbortSignal.timeout(25000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.ok(response.ok, `${path}: ${response.status} ${response.ok ? '' : await response.text()}`)
    return response.json()
  }
  assert.equal((await call('/global/health')).version, '1.18.34')
  const session = await call('/session', { title: 'Synthetic memory source' })
  const send = (id, text) => call(`/session/${id}/message`, { agent: 'source_fixture',
    model: { providerID: 'fixture', modelID: 'model' }, parts: [{ type: 'text', text }] })
  await send(session.id, 'Keep the viewer on the left.\n\n> A quote: put the viewer on the right.\n\nRead fixture.txt once.')
  const db = new DatabaseSync(database, { readOnly: true })
  const snapshot = id => ({
    sessions: db.prepare('SELECT id,parent_id,directory,version,revert,time_created,time_updated FROM session WHERE id=?').all(id),
    messages: db.prepare('SELECT * FROM message WHERE session_id=? ORDER BY time_created,id').all(id),
    parts: db.prepare('SELECT * FROM part WHERE session_id=? ORDER BY time_created,id').all(id),
  })
  try {
    const turn = snapshot(session.id)
    const tool = turn.parts.map(row => JSON.parse(row.data)).find(part => part.type === 'tool')
    assert.equal(tool.tool, 'read'); assert.equal(tool.state.status, 'completed', JSON.stringify(tool.state))
    assert.match(tool.state.output, /Synthetic fixture data/)
    assert.equal((await captureSession(session.id)).sources, 6)
    assert.deepEqual(drain().sources.map(row => row.role), ['user', 'reference', 'user', 'assistant', 'tool', 'assistant'])
    assert.equal((await captureSession(session.id)).sources, 0)
    phase = 'overflow'
    const retriedPrompt = 'When changing parser code, keep a regression test for the original failure.'
    await send(session.id, retriedPrompt)
    const overflow = snapshot(session.id)
    const overflowCapture = await captureSession(session.id), overflowSources = []
    for (;;) {
      const target = { state: 'ready', key: 'synthetic' }, claimed = store.learning.claim(target)
      if (claimed.state !== 'claimed') break
      overflowSources.push(...claimed.lease.sources)
      store.learning.finish(claimed.lease, [], target)
    }
    const replayedUserEvidence = overflowSources.filter(source => source.role === 'user' && source.text === retriedPrompt).length
    phase = 'after-overflow'
    const fork = await call(`/session/${session.id}/fork`, {})
    const copied = snapshot(fork.id)
    assert.ok(copied.messages.length > 0)
    assert.ok(copied.messages.every(row => JSON.parse(row.data).time.created < copied.sessions[0].time_created))
    assert.equal((await captureSession(fork.id)).sources, 0)
    await send(fork.id, 'This is a fresh instruction in the fork.')
    const forkWithNewTurn = snapshot(fork.id)
    assert.equal((await captureSession(fork.id)).sources, 2)
    assert.equal(drain().sources[0].text, 'This is a fresh instruction in the fork.')
    phase = 'compaction'
    await call(`/session/${session.id}/summarize`, { providerID: 'fixture', modelID: 'model' })
    const compaction = snapshot(session.id)
    assert.ok(compaction.parts.some(row => JSON.parse(row.data).type === 'compaction'))
    assert.ok(compaction.messages.some(row => JSON.parse(row.data).summary === true))
    assert.equal((await captureSession(session.id)).sources, 0)
    const user = forkWithNewTurn.messages.filter(row => JSON.parse(row.data).role === 'user').at(-1)
    await call(`/session/${fork.id}/revert`, { messageID: user.id })
    const reverted = snapshot(fork.id)
    assert.equal(JSON.parse(reverted.sessions[0].revert).messageID, user.id)
    assert.equal((await captureSession(fork.id)).reason, 'native_session_reverted')
    const recording = { version: '1.18.34', synthetic: true, markOrigins, originMetadataForwarded,
      schema: db.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name IN ('session','message','part') AND sql IS NOT NULL ORDER BY name").all(),
      turn, overflow, overflowCapture, overflowSources, replayedUserEvidence, copied, forkWithNewTurn, compaction, reverted }
    // Recording contains only fixture text; replace the disposable absolute path before storing it.
    const sanitized = JSON.stringify(recording, null, 2).replaceAll(directory, '/fixture') + '\n'
    const destination = process.env.MEMORY_SOURCE_RECORDING
    if (destination) await writeFile(destination, sanitized, { mode: 0o600 })
    console.log(JSON.stringify({ version: '1.18.34', nativeTool: tool.tool, nativeToolStatus: tool.state.status,
      copiedForkKeepsOriginalTimestamps: true, compactionRecorded: true, revertRecorded: true,
      nativeCaptureVerified: true, repeatedPollDuplicateSources: 0, copiedForkSources: 0, compactionSources: 0,
      replayedUserEvidence, markOrigins, originMetadataForwarded,
      recording: destination ?? null, limitations: ['Synthetic model responses; no personal memory-quality measurement.'] }, null, 2))
    assert.equal(replayedUserEvidence, 1, 'Native replay is not an independent statement by the user')
    assert.equal(originMetadataForwarded, false, 'Source bookkeeping is not model context')
  } finally { db.close() }
} finally {
  if (native?.exitCode === null && native?.signalCode === null) {
    try { process.kill(-native.pid, 'SIGKILL') } catch { native.kill('SIGKILL') }
    await new Promise(resolve => native.once('close', resolve))
  }
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve))
  store?.close()
  closeSources()
  await rm(directory, { recursive: true, force: true })
}
