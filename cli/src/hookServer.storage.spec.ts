/** Production storage wiring on private roots and ports. Only kernel identity is
 * injected; catalog, staging, journal, HTTP and asynchronous disk flushes are real. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const writer = vi.hoisted(() => ({ unavailable: false, opens: 0, closes: 0,
  opening: undefined as Promise<void> | undefined, release: undefined as (() => void) | undefined }))
vi.mock('./engines/kit/nativeHookWriter.js', async original => {
  const { fixtureNativeHookWriter } = await import('./testing/nativeHookWriterFixture.js')
  return { ...await original<object>(), nativeHookWriterDead: async () => false,
    captureNativeHookWriter: async (root: string) => {
      writer.opens++
      await writer.opening
      if (writer.unavailable) throw Error('fixture writer evidence unavailable')
      const proof = await fixtureNativeHookWriter(root)
      return { ...proof, closeWriter() { writer.closes++; proof.closeWriter() } }
    },
  }
})
vi.mock('./lib/bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./lib/processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
let root: string, server: Server | undefined
let registry: typeof import('./lib/registry.js')['registry'], agentId: string
const storageRoot = () => join(root, 'data', 'native-hook-deliveries')
const histories = () => readdirSync(storageRoot()).filter(name => /^\.native-hook-effects-\d{3}\.history$/.test(name))
const records = () => histories().flatMap(name => readdirSync(join(storageRoot(), name)).sort()
  .map(file => JSON.parse(readFileSync(join(storageRoot(), name, file), 'utf8'))))
const waitFor = (read: () => unknown) => vi.waitFor(read, { timeout: 12_000, interval: 25 })
const pauseOpening = () => { writer.opening = new Promise<void>(done => { writer.release = done }) }
beforeEach(async () => {
  writer.unavailable = false; writer.opens = 0; writer.closes = 0; writer.opening = undefined; writer.release = undefined
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hook-storage-http-')))
  for (const [name, value] of Object.entries({ HOME: join(root, 'home'), ADAPTER_DATA_DIR: join(root, 'data'),
    ADAPTER_RUNTIME_DIR: join(root, 'runtime'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude') })) {
    mkdirSync(value, { recursive: true, mode: 0o700 }); vi.stubEnv(name, value)
  }
  mkdirSync(join(root, 'codex', 'sessions'), { mode: 0o700 })
  writeFileSync(join(root, 'codex', 'sessions', `rollout-${A}.jsonl`), JSON.stringify({ type: 'session_meta',
    payload: { id: A, cwd: root, source: 'cli' } }) + '\n')
  writeFileSync(join(root, 'data', 'engine-homes.json'), '{}')
  vi.resetModules()
  ;({ registry } = await import('./lib/registry.js'))
  agentId = registry.openProcessAgent({ engine: 'codex', tmuxPane: '%1', cwd: root,
    processIdentity: { pid: 5100, startMarker: 'fixture-start', executable: '<codex>' } })!.entry.agentId
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  writer.release?.()
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
  server = undefined
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules()
  rmSync(root, { recursive: true, force: true })
})

async function fixture(overrides: Partial<import('./hookServer.js').HookServerHandlers> = {}) {
  const { startHookServer } = await import('./hookServer.js')
  const { readHookCredential } = await import('./lib/hookAuth.js')
  const registered = vi.fn(), prompts: string[] = [], reasons: Array<string | undefined> = []
  const started = await startHookServer(0, { onRegistered: registered, onSessionEnd() {},
    resolveHookAgent: async () => registry.byAgent(agentId) ?? null,
    onPromptSubmitted: (_id, prompt) => { prompts.push(prompt) },
    onAdmissionHeld: (_id, reason) => { reasons.push(reason) }, onStatus: () => ({ ready: true }), ...overrides,
  }, { deferNativeRecovery: true })
  server = started.server
  const post = async (id: string, firedAt = 1_000, extra: Record<string, unknown> = {}) => {
    const response = await fetch(`http://127.0.0.1:${started.port}/api/hook/session-start`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        'x-harness-hook-token': readHookCredential(join(root, 'data'))!, 'x-harness-hook-delivery-id': id,
        'x-harness-hook-fired-at': String(firedAt) },
      body: JSON.stringify({ engine: 'codex', sessionId: A, tmuxPane: '%1', cwd: root,
        transcriptPath: join(root, 'codex', 'sessions', `rollout-${A}.jsonl`), hookEvent: 'SessionStart', ...extra }),
    })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const settle = async (id: string, firedAt = 1_000, extra: Record<string, unknown> = {}) => {
    const deadline = performance.now() + 20_000
    for (;;) {
      const result = await post(id, firedAt, extra)
      if (result.status === 200 && result.body.ok) return result
      if (result.status === 200) {
        expect(result.body).toEqual({ pending: true })
        // An owned pending response must already have its exact durable intake.
        expect(records().some(record => record.event.kind === 'intake' && record.event.intake.id === id)).toBe(true)
      } else expect(result).toMatchObject({ status: 202, body: { pending: false, retry: true, detail: expect.any(String) } })
      if (performance.now() >= deadline) throw Error(`private delivery did not settle: ${JSON.stringify(result)}`)
      await new Promise<void>(done => setTimeout(done, 100))
    }
  }
  return { post, settle, prompts, registered, reasons,
    status: async () => (await fetch(`http://127.0.0.1:${started.port}/api/status`)).json() }
}

it('serves readiness while writer opening waits and uses the fixed catalog when it resumes', async () => {
  pauseOpening()
  const f = await fixture()
  expect(writer.opens).toBe(0)
  expect(await f.status()).toEqual({ ready: true })
  const pending = f.post('fixture-opening-delivery')
  await waitFor(() => expect(writer.opens).toBe(1))
  expect(await f.status()).toEqual({ ready: true })
  expect(registry.byAgent(agentId)!.sessionId).toBe('')
  expect(readdirSync(storageRoot())).toEqual([])
  writer.release!()
  expect(await pending).toMatchObject({ status: 200 })
  await f.settle('fixture-opening-delivery')
  expect(histories()).toHaveLength(1)
  expect(readdirSync(storageRoot())).toContain('.native-hook-catalog')
  expect(readdirSync(storageRoot()).some(name => /^\.native-hook-stage-\d$/.test(name))).toBe(true)
  expect(readdirSync(storageRoot()).some(name => /^[a-f0-9]{64}$/.test(name))).toBe(false)
  expect(f.registered).toHaveBeenCalledOnce()
}, 30_000)

it('holds unavailable opening without intake or binding and retries the same delivery after recovery', async () => {
  writer.unavailable = true
  const f = await fixture(), id = 'fixture-unavailable-opening'
  expect(await f.post(id)).toMatchObject({ status: 202, body: { pending: false, retry: true, detail: expect.stringContaining('writer evidence unavailable') } })
  expect(f.reasons.at(-1)).toContain('writer evidence unavailable')
  expect(registry.byAgent(agentId)!.sessionId).toBe('')
  expect(readdirSync(storageRoot())).toEqual([])
  writer.unavailable = false
  await f.settle(id)
  expect(writer.opens).toBe(2)
  expect(f.registered).toHaveBeenCalledOnce()
  expect(records().filter(record => record.event.kind === 'intake')).toHaveLength(1)
}, 30_000)

it('refuses an original process replaced while storage is opening before allocating or binding', async () => {
  pauseOpening()
  let birth = '1234'
  const capture = () => {
    const process = registry.byAgent(agentId)!.processIdentity!
    return { key: `fixture-boot\u0000codex\u0000${process.pid}\u0000${birth}`, evidence: JSON.stringify([process, birth]) }
  }
  const f = await fixture({
    captureNativeHookCaller: async () => {
      const original = capture()
      return { owner: () => original }
    },
    readNativeHookOwner: async (_row, expected) => {
      const original = capture()
      if (expected && (expected.key !== original.key || 'evidence' in expected && expected.evidence !== original.evidence)) {
        throw Error('fixture precise native owner changed')
      }
      // Production verify checks its retained read budget; it does not reread
      // kernel birth. The server must fence the asynchronous opening itself.
      return { ...original, verify() {} }
    },
  }), pending = f.post('fixture-owner-changed-during-open')
  await waitFor(() => expect(writer.opens).toBe(1))
  birth = '5678'
  registry.updateProcessIdentity(agentId, { pid: 5101, startMarker: 'fixture-replacement', executable: '<codex>' })
  writer.release!()
  expect(await pending).toMatchObject({ status: 202, body: { pending: false, retry: true,
    detail: expect.stringContaining('original native process changed while opening storage') } })
  expect(registry.byAgent(agentId)!.sessionId).toBe('')
  expect(readdirSync(storageRoot())).toEqual([])
  expect(f.registered).not.toHaveBeenCalled()
  await f.settle('fixture-replacement-delivery')
  expect(f.registered).toHaveBeenCalledOnce()
  expect(records().filter(record => record.event.kind === 'intake').map(record => record.event.intake.id))
    .toEqual(['fixture-replacement-delivery'])
}, 30_000)

it('retains a pending opener until close completes without allocating for the closed server', async () => {
  pauseOpening()
  const f = await fixture(), pending = f.post('fixture-close-during-open')
  await waitFor(() => expect(writer.opens).toBe(1))
  let finished = false
  const closing = new Promise<void>((resolve, reject) => server!.close(error => {
    finished = true; error ? reject(error) : resolve()
  }))
  await new Promise<void>(done => setImmediate(done))
  expect(finished).toBe(false); expect(writer.closes).toBe(0)
  writer.release!()
  expect(await pending).toMatchObject({ status: 202, body: { pending: false, retry: true } })
  await closing; server = undefined
  expect(writer.closes).toBe(1)
  expect(readdirSync(storageRoot())).toEqual([])
  expect(f.registered).not.toHaveBeenCalled()
}, 15_000)

it('settles sequential deliveries through contention and restores exact receipts in a fresh server', async () => {
  const f = await fixture(), first = 'fixture-registration-first', second = 'fixture-prompt-successor'
  expect(await f.post(first)).toMatchObject({ status: 200 })
  await waitFor(() => expect(registry.byAgent(agentId)!.sessionId).toBe(A))
  // The first result may still be flushing. A retry keeps this exact ID/body/time.
  await f.settle(second, 1_001, { hookEvent: 'UserPromptSubmit', prompt: 'one durable prompt' })
  expect(f.prompts).toEqual(['one durable prompt'])
  await f.settle(first)
  const original = histories(), retained = records().map(record => record.event)
  await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
  server = undefined
  const fresh = await fixture()
  await fresh.settle(second, 1_001, { hookEvent: 'UserPromptSubmit', prompt: 'one durable prompt' })
  expect(fresh.prompts).toEqual([]); expect(fresh.registered).not.toHaveBeenCalled()
  expect(histories()).toEqual(original)
  expect(records().map(record => record.event)).toEqual(retained)
  unlinkSync(join(storageRoot(), original[0] + '.bootstrap'))
  expect(await fresh.post(second, 1_001, { hookEvent: 'UserPromptSubmit', prompt: 'one durable prompt' }))
    .toMatchObject({ status: 202, body: { pending: false, retry: true } })
  expect(fresh.registered).not.toHaveBeenCalled()
}, 45_000)

it('holds fresh intake at actual byte capacity while completing and confirming its retained delivery', async () => {
  const f = await fixture(), id = 'fixture-large-retained'
  const extra = { hookEvent: 'UserPromptSubmit', prompt: 'x'.repeat(126 * 1024), input: 'y'.repeat(126 * 1024) }
  await f.settle(id, 1_000, extra)
  const rejected = await f.post('fixture-new-over-capacity', 1_001, extra)
  expect(rejected).toMatchObject({ status: 202, body: { pending: false, retry: true, detail: expect.stringContaining('byte capacity') } })
  expect(records().filter(record => record.event.kind === 'intake')).toHaveLength(1)
  await f.settle(id, 1_000, extra)
  expect(f.prompts).toEqual([extra.prompt])
  expect(f.registered).toHaveBeenCalledOnce()
}, 40_000)
