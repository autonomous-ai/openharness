import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registry, type RegisteredSession } from './registry.js'
import { removeRegistryAgent } from '../testing/registryFixtures.js'
import { restoreAgents, type RestoreAgentsDeps } from './restoreAgents.js'

const runtime = { backend: 'tmux' as const, paneId: '%70' }
const before = { pid: 7001, startMarker: 'before', executable: '/fixture/codex' }
const engine = { pid: 7002, startMarker: 'restored', executable: '/fixture/codex' }
const fresh = { pid: 7003, startMarker: 'fresh', executable: '/fixture/codex' }
const token = '11111111-1111-1111-1111-111111111111'
const id = '33333333-3333-4333-8333-333333333333'
let directory = '', home = '', transcript = ''

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  directory = mkdtempSync(join(tmpdir(), 'restore-settle-'))
  home = join(directory, 'codex'); transcript = join(home, 'sessions', `rollout-${id}.jsonl`)
  mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id, cwd: directory, source: 'cli' } }) + '\n')
})
afterEach(async () => {
  vi.useRealTimers()
  for (const entry of registry.list()) await removeRegistryAgent(registry, entry.agentId)
  await registry.flush()
  rmSync(directory, { recursive: true, force: true })
})

const gate = () => { let open!: () => void; const reached = new Promise<void>(resolve => { open = resolve }); return { reached, open } }
/** The engine's own hook, as the hook server commits it. */
const hook = (process = engine) => registry.register({ engine: 'codex', sessionId: id, transcriptPath: transcript, codexHome: home,
  cwd: directory, runtimes: [runtime], processIdentity: process }, { verifiedNativeSource: true })

/** A pane whose launch an earlier daemon dispatched: restore watches it for its engine. */
async function starting(bound: boolean): Promise<RegisteredSession> {
  const row = (await registry.openPendingAgent({ engine: 'codex', runtimes: [runtime], cwd: directory, codexHome: home, nativeToken: token }))!
  if (bound) {
    registry.updateProcessIdentity(row.agentId, before)
    expect(await hook(before)).not.toBeNull()
    registry.clearProcessIdentity(row.agentId)
    registry.setLaunch(row.agentId, { state: 'starting', nativeToken: token })
  }
  await registry.flush()
  return registry.byAgent(row.agentId)!
}

/** Only the settle window's own sleep moves the clock, and only once the test opens it. */
function watch(over: Partial<RestoreAgentsDeps> = {}) {
  const settling = gate(), settle = gate(), finished = gate()
  const deps = {
    registry, livePane: async () => true, liveProcess: async () => null, waitingPane: async () => false,
    buildLaunch: async () => ({ argv: ['fixture-engine'] }), createPane: async () => ({ ok: true, runtime }),
    respawn: async () => ({ ok: true }), probeProcess: async () => engine, paneState: async () => ({ dead: false, engineExit: null }),
    clearRemainOnExit: vi.fn(async () => {}), holdRoute: () => finished.open, releaseRoute: finished.open, triggerHint: async () => {},
    log: vi.fn(), settleMs: 10_000,
    sleep: async (ms: number) => { settling.open(); await settle.reached; vi.setSystemTime(Date.now() + ms) },
    ...over,
  } as RestoreAgentsDeps
  return { deps, settling: settling.reached, settle: settle.open, finished: finished.reached }
}

it('records the probed engine before the settle window, and keeps the terminal held through it', async () => {
  const row = await starting(true)
  const w = watch()
  await restoreAgents(w.deps)
  await w.settling
  expect(registry.byAgent(row.agentId)).toMatchObject({ processIdentity: engine, launch: { state: 'ready' } })
  expect(w.deps.clearRemainOnExit).not.toHaveBeenCalled()
  let released = false
  void w.finished.then(() => { released = true })
  await Promise.resolve()
  expect(released).toBe(false)
  w.settle(); await w.finished
  expect(w.deps.clearRemainOnExit).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(w.deps.log).toHaveBeenCalledWith(expect.stringContaining('engine up')))
})

it('the restored engine registering its own conversation in the settle window does not end the watch', async () => {
  const row = await starting(true)
  const w = watch()
  await restoreAgents(w.deps)
  await w.settling
  expect(await hook()).not.toBeNull()
  expect(registry.byAgent(row.agentId)?.launch).toBeUndefined()
  w.settle(); await w.finished
  expect(w.deps.clearRemainOnExit).toHaveBeenCalledOnce()
})

it('a reopened conversation, bound but never stamped, keeps its watch when its hook stamps it in the settle window', async () => {
  const bound = await starting(true)
  const saved = structuredClone(bound)
  await removeRegistryAgent(registry, bound.agentId)
  expect(await registry.resumePendingAgent(saved, [runtime], token)).toMatchObject({ sessionId: id, boundAt: null })
  const w = watch()
  await restoreAgents(w.deps)
  await w.settling
  expect(await hook()).not.toBeNull()
  expect(registry.byAgent(bound.agentId)?.boundAt).not.toBeNull()
  w.settle(); await w.finished
  expect(w.deps.clearRemainOnExit).toHaveBeenCalledOnce()
})

it('a fresh engine whose first hook binds in the settle window is accepted', async () => {
  const row = await starting(false)
  const w = watch()
  await restoreAgents(w.deps)
  await w.settling
  expect(await hook()).not.toBeNull()
  w.settle(); await w.finished
  expect(w.deps.clearRemainOnExit).toHaveBeenCalledOnce()
  expect(registry.byAgent(row.agentId)).toMatchObject({ sessionId: id, processIdentity: engine })
})

it('an engine that dies in the settle window is forgotten, and the fresh launch is recorded in its place', async () => {
  const row = await starting(true)
  let died = false, respawned = false
  const w = watch({
    probeProcess: async () => respawned ? fresh : died ? null : engine,
    paneState: async () => { if (respawned) return { dead: false, engineExit: null }; died = true; return { dead: true, engineExit: 1 } },
    respawn: async (_runtime, _launch, control) => { await control?.onDispatch?.(); respawned = true; return { ok: true } },
  })
  await restoreAgents(w.deps)
  await w.settling
  expect(registry.byAgent(row.agentId)?.processIdentity).toEqual(engine)
  w.settle(); await w.finished
  expect(registry.byAgent(row.agentId)).toMatchObject({ sessionId: '', processIdentity: fresh, launch: { state: 'ready' } })
  expect(w.deps.clearRemainOnExit).toHaveBeenCalledOnce()
})

it('an engine that dies in the settle window leaves its row starting again while the fresh launch starts', async () => {
  const row = await starting(true)
  let died = false, respawned = false
  const seen: unknown[] = []
  const w = watch({
    probeProcess: async () => respawned ? fresh : died ? null : engine,
    paneState: async () => { if (respawned) return { dead: false, engineExit: null }; died = true; return { dead: true, engineExit: 1 } },
    respawn: async (_runtime, _launch, control) => {
      seen.push(structuredClone(registry.byAgent(row.agentId)?.launch))
      await control?.onDispatch?.(); respawned = true; return { ok: true }
    },
  })
  await restoreAgents(w.deps)
  await w.settling
  w.settle(); await w.finished
  // Not the dead engine's `ready`: the desk read a fresh launch with no engine and no conversation as up.
  expect(seen).toEqual([{ state: 'starting' }])
})

it('another conversation taking the row in the settle window ends the watch with the terminal still held', async () => {
  const row = await starting(true)
  const w = watch()
  await restoreAgents(w.deps)
  await w.settling
  registry.byAgent(row.agentId)!.sessionId = 'replacement-conversation'
  w.settle(); await w.finished
  expect(w.deps.clearRemainOnExit).not.toHaveBeenCalled()
  expect(registry.byAgent(row.agentId)?.sessionId).toBe('replacement-conversation')
})
