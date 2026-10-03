// Manual native transport check: node cli/scripts/memory-native-opencode-inference-probe.mjs
// Disposable storage, synthetic credentials and localhost responses only. No real inference.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const fixture = await mkdtemp(join(tmpdir(), 'native-opencode-memory-'))
const forbidden = join(fixture, 'forbidden-tool-action')
const runs = []
let current
const server = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  let body
  try { body = JSON.parse(Buffer.concat(chunks)) }
  catch { response.writeHead(400).end(); return }
  current.requests.push({ route: request.url, model: body.model,
    tools: (body.tools ?? []).map(tool => tool.function?.name ?? tool.name ?? tool.type),
    selectedCredential: request.headers.authorization === 'Bearer synthetic-memory-account',
  })
  if (current.mode === 'provider_restricted') {
    response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: {
      type: 'FreeTierError', message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
    } }))
    return
  }
  const forced = current.mode !== 'text' && current.requests.length === 1
  const tool = { index: 0, id: 'call_fixture', type: 'function', function: { name: current.mode,
    arguments: JSON.stringify(current.mode === 'bash'
      ? { command: `touch '${forbidden.replaceAll("'", "'\\''")}'`, description: 'Synthetic forbidden action' }
      : { questions: [{ question: 'Synthetic choice?', header: 'Fixture', options: [{ label: 'A', description: 'A' }] }] }),
  } }
  const base = { id: 'chatcmpl_fixture', created: 1, model: body.model }
  if (!body.stream) {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...base,
      object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '{"proposals":[]}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }))
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (delta, finish_reason = null) => response.write('data: ' + JSON.stringify({ ...base,
    object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }],
  }) + '\n\n')
  send({ role: 'assistant', ...(forced ? { tool_calls: [tool] } : { content: '{"proposals":[]}' }) })
  send({}, forced ? 'tool_calls' : 'stop')
  response.end('data: [DONE]\n\n')
})

try {
  const bundle = join(fixture, 'inference.mjs')
  await build({ entryPoints: [fileURLToPath(new URL('../src/memory/opencodeInference.ts', import.meta.url))],
    outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  })
  const { runOpenCodeMemoryInference, openCodeSnapshotIdentity, opencodeMemoryCapability } = await import(pathToFileURL(bundle).href)
  const capability = await opencodeMemoryCapability()
  assert.equal(capability.supported, true, 'Installed OpenCode version must match the adapter')
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const snapshot = { model: 'memory-fixture/memory-model', auth: { type: 'api', key: 'synthetic-memory-account' },
    provider: { npm: '@ai-sdk/openai-compatible', name: 'Memory fixture',
      options: { baseURL: `http://127.0.0.1:${server.address().port}/v1` },
      models: { 'memory-model': { name: 'Memory fixture', limit: { context: 128_000, output: 4096 } } },
    },
  }
  for (const mode of ['text', 'bash', 'question', 'provider_restricted']) {
    current = { mode, requests: [], snapshotReads: 0 }
    runs.push(current)
    try {
      current.result = await runOpenCodeMemoryInference({ cwd: fixture, model: snapshot.model,
        prompt: 'Synthetic extraction fixture. Return {"proposals":[]} without tools.', timeoutMs: 20_000,
        expectedSnapshot: openCodeSnapshotIdentity(snapshot), readSnapshot: async () => { current.snapshotReads++; return snapshot },
      })
    } catch (error) { current.error = error.message }
    current.forbiddenFileExists = await stat(forbidden).then(() => true, () => false)
    current.privateStorageRemoved = !(await readdir(fixture)).some(name => name.startsWith('opencode-memory-'))
    assert.equal(current.forbiddenFileExists, false, 'A forbidden tool must not execute')
    assert.equal(current.privateStorageRemoved, true, 'Disposable session storage must be removed')
    assert.ok(current.requests.length > 0, 'The installed native CLI must reach the mock')
    for (const request of current.requests) {
      assert.deepEqual(request.tools, [])
      assert.equal(request.selectedCredential, true)
      assert.equal(request.model, 'memory-model')
      assert.equal(request.route, '/v1/chat/completions')
    }
    if (mode === 'text') {
      assert.deepEqual(current.result, { text: '{"proposals":[]}' })
      assert.equal(current.snapshotReads, 3)
    } else if (mode === 'provider_restricted') {
      assert.equal(current.error, 'inference_provider_restricted')
      assert.equal(current.requests.length, 1, 'The non-retryable refusal must not be retried by native OpenCode')
    } else assert.equal(current.error, 'inference_tool_or_error')
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), capability, runs,
    limitations: ['Synthetic localhost responses; no personal conversations or real model inference.',
      'Native transport only. This probe does not exercise production account/config observation or companion wiring.',
      'No claim about extraction quality, OAuth, automatic compaction or task benefit.'],
  }, null, 2))
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(fixture, { recursive: true, force: true })
}
