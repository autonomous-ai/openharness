import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { REGISTRY_WRITE_DEADLINE_MS } from './registryPersistence.js'

const preparation = vi.hoisted(() => ({ wait: undefined as undefined | (() => Promise<void>) }))
const deadline = await vi.hoisted(() => import('../testing/registryDeadline.js'))
vi.mock('node:fs/promises', original => deadline.slowSyncFsPromises(original, { afterSync: async () => { await preparation.wait?.() } }))
// The write deadline is a test's to expire, never the host's clock.
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
// Loads the module graph once, before any hook's time limit: cold, it takes seconds on a loaded machine. Each test
// still imports fresh modules (vi.resetModules), now from the warm transform cache.
await import('./registry.js'); await import('../hookServer.js')
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
let root: string, server: Server | undefined, release: (() => void) | undefined
let registry: typeof import('./registry.js')['registry'], source: string
let started: Awaited<ReturnType<typeof import('../hookServer.js')['startHookServer']>>
let prompts: string[], registered: ReturnType<typeof vi.fn<() => void>>
const stopJobs = new Map<string, Promise<void>>()
let timers: ReturnType<typeof deadline.holdRegistryDeadline>
const file = () => join(root, 'registry.json')
const disk = () => JSON.parse(readFileSync(file(), 'utf8'))
beforeEach(async () => {
  // The 250 ms reply grace and the 5 s write deadline fire only when a test fires them, so how fast
  // this machine writes the registry never changes the replies these tests pin.
  timers = deadline.holdRegistryDeadline(REGISTRY_WRITE_DEADLINE_MS, { hold: [250] })
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'registry-hook-persistence-'))
  vi.stubEnv('ADAPTER_DATA_DIR', root)
  vi.stubEnv('CLAUDE_PROJECTS_DIR', root)
  ;({ registry } = await import('./registry.js'))
  source = (await registry.openProcessAgent({ engine: 'claude', tmuxPane: '%1', cwd: root,
    processIdentity: { pid: 5101, startMarker: 'fixture-start', executable: '<claude>' } }))!.entry.agentId
  writeFileSync(join(root, 'conversation.jsonl'), '{}\n')
  await registry.flush()
  prompts = []; registered = vi.fn(); stopJobs.clear()
  const { startHookServer } = await import('../hookServer.js')
  started = await startHookServer(0, { onRegistered: registered, onSessionEnd: () => {},
    hookAdmissionBlocked: id => stopJobs.has(id), onPromptSubmitted: (_id, prompt) => { prompts.push(prompt) },
  }, { peerAccount: async () => true })
  server = started.server
})
afterEach(async () => {
  preparation.wait = undefined
  release?.(); release = undefined
  if (server) await new Promise<void>(done => server!.close(() => done()))
  server = undefined
  await registry.flush().catch(() => {})
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})
async function post(id = 'fixture-delivery-0001') {
  const { readHookCredential } = await import('./hookAuth.js')
  const response = await fetch(`http://127.0.0.1:${started.port}/api/hook/session-start`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-harness-hook-token': readHookCredential(root)!,
      'x-harness-hook-delivery-id': id },
    body: JSON.stringify({ engine: 'claude', sessionId: 'conversation', transcriptPath: join(root, 'conversation.jsonl'),
      tmuxPane: '%1', cwd: root, hookEvent: 'UserPromptSubmit', prompt: id }),
  })
  return response.json()
}
function hold() {
  const entered = deferred(), held = deferred()
  release = held.resolve
  preparation.wait = async () => { preparation.wait = undefined; entered.resolve(); await held.promise }
  return { entered: entered.promise, release: held.resolve }
}

it('answers ordinary durable commit success only after publication and credits its prompt once', async () => {
  const held = hold(), response = post()
  await held.entered
  expect(disk()[0].sessionId).toBe('')
  expect(prompts).toEqual([]); expect(registered).not.toHaveBeenCalled()
  held.release()
  expect(await response).toEqual({ ok: true })
  expect(disk()[0].sessionId).toBe('conversation')
  expect(prompts).toEqual(['fixture-delivery-0001'])
  expect(await post()).toEqual({ ok: true })
  expect(prompts).toHaveLength(1)
})

it('answers a queued hook pending while its predecessor retains the write', async () => {
  const held = hold(), first = post()
  await held.entered
  expect(await post('fixture-delivery-0002')).toEqual({ pending: true })
  expect(prompts).toEqual([])
  held.release()
  expect(await first).toEqual({ ok: true })
  await vi.waitFor(() => expect(prompts).toEqual(['fixture-delivery-0001', 'fixture-delivery-0002']))
})

it('answers a slow commit pending at the reply grace without granting durability', async () => {
  const held = hold(), response = post()
  await held.entered
  timers.fire(250)
  expect(await response).toEqual({ pending: true })
  expect(disk()[0].sessionId).toBe(''); expect(prompts).toEqual([])
  held.release()
  await vi.waitFor(() => expect(prompts).toEqual(['fixture-delivery-0001']))
})

it('answers an expired commit pending and revokes publication even when I/O later settles', async () => {
  const held = hold(), response = post()
  await held.entered
  timers.expire()
  expect(await response).toEqual({ pending: true })
  expect(disk()[0].sessionId).toBe(''); expect(prompts).toEqual([])
  held.release()
  await registry.flush()
  expect(disk()[0].sessionId).toBe(''); expect(prompts).toEqual([])
})

it('keeps a hook pending when Stop begins while its durable commit is held', async () => {
  const { createStopAgentService } = await import('./stopAgentService.js')
  let fail!: (error: Error) => void
  const never = vi.fn(() => { throw new Error('native mutation is forbidden in this fixture') })
  const stop = createStopAgentService({ registry, stopJobs,
    settlePane: () => new Promise((_resolve, reject) => { fail = reject }),
    restartJobs: { cancel: vi.fn() } as unknown as import('./restartAgent.js').AgentRestartCoordinator,
    stoppedAgents: { save: never } as unknown as import('./stoppedAgents.js').StoppedAgentStore,
    backendFor: () => ({ kill: never }), agentReconciler: { suppress: never, holdRoute: never, releaseRoute: never, nudge: never },
    forgetSession: never, markDeleted: never, clearDeleted: never, stopNative: never,
  })
  const held = hold(), response = post()
  await held.entered
  const stopping = stop(source), stopped = expect(stopping).rejects.toThrow('fixture Stop held')
  held.release()
  expect(await response).toEqual({ pending: true })
  expect(disk()[0].sessionId).toBe(''); expect(prompts).toEqual([])
  expect(never).not.toHaveBeenCalled()
  fail(new Error('fixture Stop held')); await stopped
})
