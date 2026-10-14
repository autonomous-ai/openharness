/** Execute the emitted standalone artifact in a disposable home. Its HTTP peer
 * is a private receipt fixture; no daemon, real tmux or engine is contacted. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildNativeHook } from '../scripts/lib/nativeHookBundle.mjs'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { nativeHookAcknowledgement } from './engines/kit/nativeHookClientProtocol.js'
import { prepareNativeHookArtifact } from './engines/kit/nativeHookArtifact.js'
import { pathToFileURL } from 'node:url'

let root: string, artifact: string, inputs: string[]
let server: ReturnType<typeof createServer> | undefined
const nativeArtifact = process.env.HARNESS_PROCESS_IMAGES_ARTIFACT
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-hook-artifact-')))
  for (const name of ['home', 'data', 'tmux', 'bin', 'package', 'routes']) mkdirSync(join(root, name), { mode: 0o700 })
  writeFileSync(join(root, 'bin', 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  writeFileSync(join(root, 'data', 'hook-credential'), 't'.repeat(43), { mode: 0o600 })
  artifact = join(root, 'package', 'notify.mjs')
  const built = await buildNativeHook({ outDir: join(root, 'package'), version: 'fixture',
    processImages: nativeArtifact ? readFileSync(nativeArtifact, 'utf8') : undefined })
  inputs = Object.keys(built.metafile!.inputs)
})
afterEach(async () => {
  if (server) await new Promise<void>(done => server!.close(() => done()))
  server = undefined
  rmSync(root, { recursive: true, force: true })
})
async function run(input: Record<string, unknown>, port: number, keepOpen = false,
  options: { preload?: string; deadlineMs?: number; rawInput?: Buffer; afterSpawn?(): Promise<void> } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, 'home'), ADAPTER_DATA_DIR: join(root, 'data'),
    ADAPTER_RUNTIME_DIR: join(root, 'runtime'), CLAUDE_CONFIG_DIR: join(root, 'home', 'claude'), CODEX_HOME: join(root, 'home', 'codex'),
    CURSOR_HOME: join(root, 'home', 'cursor'), TMUX_TMPDIR: join(root, 'tmux'), PATH: `${join(root, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HARNESS_HOOK_ROUTES_DIR: join(root, 'routes'),
    TZ: 'UTC', TMPDIR: '/tmp', HARNESS_HOOK_DEADLINE_MS: String(options.deadlineMs ?? 15000) }
  delete env.TMUX; delete env.TMUX_PANE; delete env.NODE_OPTIONS
  // The fake pane has only the shim above; it cannot select an owner's server.
  env.TMUX_PANE = '%1'
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [...(options.preload ? ['--import', options.preload] : []),
      artifact, '--port', String(port), '--data-dir', join(root, 'data'), '--engine', 'cursor'],
      { cwd: join(root, 'package'), env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 20000)
    child.on('error', reject)
    child.on('close', code => { clearTimeout(timer); resolve({ stdout, stderr, code }) })
    child.stdin.on('error', () => {})
    if (keepOpen) child.stdin.write(options.rawInput ?? JSON.stringify(input))
    else child.stdin.end(options.rawInput ?? JSON.stringify(input))
    if (options.afterSpawn) void options.afterSpawn().catch(error => { child.kill('SIGKILL'); reject(error) })
  })
}
async function listen(reply: (body: string, id: string, firedAt: number) => unknown) {
  const requests: Array<{ path?: string; body: string; id: string; firedAt: number }> = []
  server = createServer((req, res) => {
    // Local port discovery is unrelated to this client. Every authenticated
    // request still counts, including a mistaken legacy or otherwise wrong path.
    if (req.headers['x-harness-hook-token'] !== 't'.repeat(43)) { req.resume(); res.writeHead(403); res.end(); return }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const id = String(req.headers['x-harness-hook-delivery-id']), firedAt = Number(req.headers['x-harness-hook-fired-at'])
      requests.push({ path: req.url, body, id, firedAt })
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply(body, id, firedAt)))
    })
  })
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done))
  return { requests, port: (server.address() as { port: number }).port }
}
const stop = () => ({ hook_event_name: 'stop', conversation_id: 'fixture-conversation', generation_id: 'fixture-generation', status: 'completed' })

it('emits only builtins and no daemon configuration or lazy session control', () => {
  expect(inputs).toContain('hook/notify.mjs')
  expect(inputs).toContain('src/engines/kit/nativeHookClient.ts')
  expect(inputs).not.toContain('src/config/env.ts')
  expect(inputs).not.toContain('src/lib/registry.ts')
  expect(inputs.every(path => !path.startsWith('node_modules/') && !path.startsWith('src/services/') && !path.startsWith('src/core/'))).toBe(true)
  expect(readFileSync(artifact, 'utf8')).not.toMatch(/\bimport\s*\(/)
  const entry = pathToFileURL(join(root, 'package/cli.js')).href
  expect(prepareNativeHookArtifact(entry, '', 'linux').path).toBe(artifact)
  expect(prepareNativeHookArtifact(entry, '', 'linux', true).path).toBe(artifact)
  if (nativeArtifact) expect(prepareNativeHookArtifact(entry, '', 'darwin').path).toBe(artifact)
  else expect(() => prepareNativeHookArtifact(entry, '', 'darwin')).toThrow(/pinned macOS process helper/)
})

it('holds an unsupported generation visibly and produces exactly one no-op response', async () => {
  const peer = await listen(() => ({ ok: true }))
  const result = await run({ ...stop(), generation_id: undefined }, peer.port)
  expect(result).toMatchObject({ stdout: '{}\n', code: 0 })
  expect(result.stderr).toContain('no supported generation ID')
  expect(peer.requests).toHaveLength(0)
  expect(readdirSync(join(root, 'data'))).toEqual(['hook-credential'])
})

it.each(['unfinished', 'oversized'])('closes %s input without reading a valid prefix as a complete event', async failure => {
  const peer = await listen(() => ({ ok: true })), started = performance.now()
  const event = failure === 'oversized' ? { ...stop(), text: 'x'.repeat(256 * 1024) } : stop()
  const result = await run(event, peer.port, true)
  expect(result).toMatchObject({ stdout: '{}\n', code: 0 })
  expect(result.stderr).toContain(failure === 'oversized' ? 'complete-input limit' : 'input did not finish')
  expect(performance.now() - started).toBeLessThan(5000)
  expect(peer.requests).toHaveLength(0)
}, 8000)

it('refuses malformed UTF-8 before it can change a native identity', async () => {
  const peer = await listen(() => ({ ok: true }))
  const result = await run({}, peer.port, false, { rawInput: Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]) })
  expect(result).toMatchObject({ stdout: '{}\n', code: 0 })
  expect(result.stderr).toContain('not complete UTF-8')
  expect(peer.requests).toHaveLength(0)
})

it.skipIf(process.platform === 'darwin' && !nativeArtifact)('retains a real native delivery at the shipped deadline without source or node_modules', async () => {
  const peer = await listen((body, id, firedAt) => nativeHookAcknowledgement({ id, firedAt },
    { name: 'registration', path: '/api/hook/session-start', body }, 'owned'))
  writeFileSync(join(root, 'data', 'cursor-pending-tasks.json'), '["successor-task"]', { mode: 0o600 })
  const result = await run(stop(), peer.port, false, { deadlineMs: 4500 })
  expect(result, result.stderr).toEqual({ stdout: '{}\n', stderr: '', code: 0 })
  expect(peer.requests).toHaveLength(1)
  expect(peer.requests[0].path).toBe('/api/native-hook/v1/session-start')
  expect(JSON.parse(peer.requests[0].body)).toMatchObject({ generationId: 'fixture-generation', status: 'completed',
    nativeOrigin: { version: 1, callerPid: process.pid } })
  expect(readFileSync(join(root, 'data', 'cursor-pending-tasks.json'), 'utf8')).toBe('["successor-task"]')
  const directory = join(root, 'data', 'native-hook-deliveries')
  const records = readdirSync(directory).filter(name => /^\.native-hook-outbox-\d{3}\.history$/.test(name))
    .flatMap(name => readdirSync(join(directory, name)).map(file => JSON.parse(readFileSync(join(directory, name, file), 'utf8'))))
  expect(records.some(record => record.event.kind === 'intake')).toBe(true)
  expect(records.some(record => record.event.kind === 'ack')).toBe(true)
}, 25000)

it.skipIf(process.platform === 'darwin' && !nativeArtifact)('keeps the entry runtime when the Registry owner changes during routing', async () => {
  const peer = await listen((body, id, firedAt) => nativeHookAcknowledgement({ id, firedAt },
    { name: 'registration', path: '/api/hook/session-start', body }, 'owned'))
  const path = join(root, 'data', 'registry.json'), marker = join(root, 'routing-started')
  const row = { schemaVersion: 2, agentId: 'original-agent', engine: 'cursor', active: true,
    processIdentity: { pid: process.pid, startMarker: 'fixture', executable: '<engine>' },
    runtimes: [{ backend: 'tmux', paneId: '%1' }], primaryRuntimeKey: 'tmux:%1' }
  writeFileSync(path, JSON.stringify([row]), { mode: 0o600 })
  writeFileSync(join(root, 'bin', 'tmux'), `#!/bin/sh\nprintf started > '${marker}'\nsleep 0.5\nexit 1\n`, { mode: 0o700 })
  const result = await run(stop(), peer.port, false, { deadlineMs: 4500, afterSpawn: async () => {
    for (let count = 0; count < 100; count++) {
      try { if (readFileSync(marker, 'utf8') === 'started') {
        writeFileSync(path, JSON.stringify([{ ...row, agentId: 'successor-agent' }]))
        return
      } } catch { /* The isolated shim has not entered routing yet. */ }
      await new Promise(done => setTimeout(done, 20))
    }
    throw Error('fixture routing did not start')
  } })
  expect(result, result.stderr).toEqual({ stdout: '{}\n', stderr: '', code: 0 })
  expect(peer.requests).toHaveLength(1)
  expect(JSON.parse(peer.requests[0].body).nativeOrigin.runtime.agentId).toBe('original-agent')
}, 25000)

it.skipIf(process.platform === 'darwin' && !nativeArtifact)('retains unowned bytes through an old-core reply and never sends the old mutation route', async () => {
  const peer = await listen(() => ({ ok: true }))
  const result = await run(stop(), peer.port)
  expect(result).toMatchObject({ stdout: '{}\n', code: 0 })
  expect(result.stderr).toContain('waiting for confirmed core ownership')
  expect(peer.requests.length).toBeGreaterThan(0)
  expect(new Set(peer.requests.map(request => JSON.stringify(request))).size).toBe(1)
  expect(peer.requests.every(request => request.path === '/api/native-hook/v1/session-start')).toBe(true)
  expect(() => readFileSync(join(root, 'data', 'registry.json'))).toThrow()
}, 25000)

it.skipIf(process.platform === 'darwin' && !nativeArtifact)('drops the original runtime when routing selects a different data directory', async () => {
  const peer = await listen((body, id, firedAt) => nativeHookAcknowledgement({ id, firedAt },
    { name: 'registration', path: '/api/hook/session-start', body }, 'owned'))
  const routedData = join(root, 'routed-data')
  mkdirSync(routedData, { mode: 0o700 })
  writeFileSync(join(routedData, 'hook-credential'), 't'.repeat(43), { mode: 0o600 })
  const owner = createHash('sha256').update(realpathSync(routedData)).digest('hex').slice(0, 16)
  writeFileSync(join(root, 'routes', `${owner}.json`), JSON.stringify({ dataDir: routedData, port: peer.port }), { mode: 0o600 })
  const row = { schemaVersion: 2, agentId: 'original-agent', engine: 'cursor', active: true,
    processIdentity: { pid: process.pid, startMarker: 'fixture', executable: '<engine>' },
    runtimes: [{ backend: 'tmux', paneId: '%1' }], primaryRuntimeKey: 'tmux:%1' }
  writeFileSync(join(root, 'data', 'registry.json'), JSON.stringify([row]), { mode: 0o600 })
  writeFileSync(join(routedData, 'registry.json'), JSON.stringify([{ ...row, agentId: 'different-agent' }]), { mode: 0o600 })
  writeFileSync(join(root, 'bin', 'tmux'), `#!/bin/sh\nif [ "$1" = "-V" ]; then printf 'tmux 3.7c\\n'; else printf '42|fixture|${owner}\\n'; fi\n`, { mode: 0o700 })
  const result = await run(stop(), peer.port, false, { deadlineMs: 4500 })
  expect(result, result.stderr).toEqual({ stdout: '{}\n', stderr: '', code: 0 })
  expect(peer.requests).toHaveLength(1)
  expect(JSON.parse(peer.requests[0].body).nativeOrigin.runtime).toBeUndefined()
  expect(readdirSync(join(root, 'data'))).not.toContain('native-hook-deliveries')
  expect(readdirSync(routedData)).toContain('native-hook-deliveries')
  expect(JSON.parse(readFileSync(join(root, 'data', 'registry.json'), 'utf8'))).toEqual([row])
}, 25000)

it.skipIf(process.platform === 'darwin' && !nativeArtifact)('keeps actual fsync cleanup alive after its bounded delivery reply expires', async () => {
  const peer = await listen(() => ({ ok: true })), preload = join(root, 'delay-flush.mjs'), marker = join(root, 'flush-state')
  writeFileSync(marker, 'not started')
  writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.fsync; let first = true;
fs.fsync = (fd, done) => { if (!first) return original(fd, done); first = false;
  fs.writeFileSync(${JSON.stringify(marker)}, 'in flight');
  setTimeout(() => original(fd, error => { fs.writeFileSync(${JSON.stringify(marker)}, 'settled'); done(error) }), 5500);
}; syncBuiltinESMExports();`)
  const result = await run(stop(), peer.port, false, { preload, deadlineMs: 4500 })
  expect(result).toMatchObject({ stdout: '{}\n', code: 0 })
  expect(result.stderr).toContain('deadline')
  expect(readFileSync(marker, 'utf8')).toBe('settled')
  expect(peer.requests).toHaveLength(0)
}, 25000)
