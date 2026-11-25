import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentLaunch, RegisteredSession } from './registry.js'
import { REGISTRY_WRITE_DEADLINE_MS } from './registryPersistence.js'

vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
const deadline = await vi.hoisted(() => import('../testing/registryDeadline.js'))
vi.mock('node:fs/promises', original => deadline.slowSyncFsPromises(original))
vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))

const CREATION = 'create-0123456789abcdef'
const TOKEN = '0f8e6a52-2c39-4c4e-9d0b-6a1d6f3c2b10'
const runtimes = [{ backend: 'tmux' as const, paneId: '%1' }]
const instances = new Set<typeof import('./registry.js')['registry']>()
let root: string
beforeEach(() => {
  // No test here means the write deadline to pass: how fast this machine writes the registry never fails them.
  deadline.holdRegistryDeadline(REGISTRY_WRITE_DEADLINE_MS)
  root = mkdtempSync(join(tmpdir(), 'registry-first-launch-'))
  vi.stubEnv('ADAPTER_DATA_DIR', root)
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {})
})
afterEach(async () => { for (const instance of instances) await instance.flush({ exiting: true }).catch(() => {}); instances.clear(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); rmSync(root, { recursive: true, force: true }) })

async function load() { vi.resetModules(); const mod = await import('./registry.js'); instances.add(mod.registry); mod.registry.load(); return mod }
const disk = (): RegisteredSession[] => JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'))
/** A launch the guard held, as its watchers write it. */
const guard = (launch: Partial<Extract<AgentLaunch, { state: 'held' }>>): AgentLaunch =>
  ({ state: 'held', service: 'native', detail: 'Starting again.', nativeToken: TOKEN, startsAgain: true, ...launch }) as AgentLaunch
const { startsAgain: _proof, ...unproved } = guard({}) as Extract<AgentLaunch, { state: 'held' }>
const { nativeToken: _token, ...untokened } = guard({}) as Extract<AgentLaunch, { state: 'held' }>

it('keeps the creation id a pending agent was opened with, across a save and a load', async () => {
  const { registry } = await load()
  const row = (await registry.openPendingAgent({ engine: 'codex', cwd: root, runtimes, creationId: CREATION }))!
  expect(row.creationId).toBe(CREATION)
  expect(registry.byAgent(row.agentId)?.creationId).toBe(CREATION)
  expect(disk()[0].creationId).toBe(CREATION)
  const next = await load()
  expect(next.registry.byAgent(row.agentId)?.creationId).toBe(CREATION)
})

it.each([42, '', 'short', 'has/slash-xxxxxxxxxxxx'])('drops a saved creation id that is not one: %j', async saved => {
  const { registry } = await load()
  const row = (await registry.openPendingAgent({ engine: 'codex', cwd: root, runtimes, creationId: CREATION }))!
  await registry.flush()
  writeFileSync(join(root, 'registry.json'), JSON.stringify([{ ...disk()[0], creationId: saved }]), { mode: 0o600 })
  const next = await load()
  expect(next.registry.byAgent(row.agentId)).toBeTruthy()
  expect(next.registry.byAgent(row.agentId)).not.toHaveProperty('creationId')
  expect(next.strictPersistedRow({ ...disk()[0], creationId: saved })).not.toHaveProperty('creationId')
  expect(next.strictPersistedRow({ ...disk()[0], creationId: CREATION })?.creationId).toBe(CREATION)
  // Nor is one written that is not one, or when none is given.
  const given = (await next.registry.openPendingAgent({ engine: 'codex', cwd: root, runtimes: [{ backend: 'tmux', paneId: '%2' }],
    creationId: saved as string }))!
  const none = (await next.registry.openPendingAgent({ engine: 'codex', cwd: root, runtimes: [{ backend: 'tmux', paneId: '%3' }] }))!
  for (const opened of [given, none]) {
    expect(opened).not.toHaveProperty('creationId')
    expect(disk().find(entry => entry.agentId === opened.agentId)).not.toHaveProperty('creationId')
  }
})

it('keeps startsAgain on a held launch, and only there', async () => {
  const { registry } = await load()
  const row = (await registry.openPendingAgent({ engine: 'codex', cwd: root, runtimes, nativeToken: TOKEN }))!
  const held = guard({})
  expect(registry.setLaunch(row.agentId, held)?.launch).toEqual(held)
  await registry.flush()
  expect(disk()[0].launch).toEqual(held)
  const next = await load()
  expect(next.registry.byAgent(row.agentId)?.launch).toEqual(held)
  expect(next.registry.setLaunch(row.agentId, { ...held, startsAgain: 'yes' } as unknown as AgentLaunch)?.launch).toEqual(unproved)
  expect(next.registry.setLaunch(row.agentId, { state: 'starting', nativeToken: TOKEN, startsAgain: true } as unknown as AgentLaunch)?.launch)
    .toEqual({ state: 'starting', nativeToken: TOKEN })
  expect(next.registry.setLaunch(row.agentId, { state: 'failed', error: 'ENGINE_DID_NOT_START', startsAgain: true } as unknown as AgentLaunch)?.launch)
    .toEqual({ state: 'failed', error: 'ENGINE_DID_NOT_START' })
  next.registry.setLaunch(row.agentId, held)
  const dispatched = randomUUID()
  expect((await next.registry.beginNativeDispatch(row.agentId, dispatched))?.launch).toEqual({ state: 'starting', nativeToken: dispatched })
  expect(disk()[0].launch).toEqual({ state: 'starting', nativeToken: dispatched })
})

it.each<{ name: string; row: Pick<RegisteredSession, 'launch' | 'sessionId'> | undefined; guardHeld: boolean; firstLaunch: boolean }>([
  { name: 'a first launch the guard held', row: { launch: guard({}), sessionId: '' }, guardHeld: true, firstLaunch: true },
  { name: 'a conversation the guard held', row: { launch: guard({}), sessionId: 'session-1' }, guardHeld: true, firstLaunch: false },
  { name: 'a first launch held again for models', row: { launch: guard({ service: 'models' }), sessionId: '' }, guardHeld: true, firstLaunch: true },
  { name: 'a conversation held again for the Store', row: { launch: guard({ service: 'store' }), sessionId: 'session-1' }, guardHeld: true, firstLaunch: false },
  { name: 'a held launch with no startsAgain', row: { launch: unproved, sessionId: '' }, guardHeld: false, firstLaunch: false },
  { name: 'a held launch with no token', row: { launch: untokened, sessionId: '' }, guardHeld: false, firstLaunch: false },
  { name: 'a launch starting', row: { launch: { state: 'starting', nativeToken: TOKEN, startsAgain: true } as unknown as AgentLaunch, sessionId: '' },
    guardHeld: false, firstLaunch: false },
  { name: 'a failed launch', row: { launch: { state: 'failed', error: 'ENGINE_DID_NOT_START' }, sessionId: '' }, guardHeld: false, firstLaunch: false },
  { name: 'a row with no launch', row: { sessionId: '' }, guardHeld: false, firstLaunch: false },
  { name: 'no row', row: undefined, guardHeld: false, firstLaunch: false },
])('guardHeld and heldFirstLaunch: $name', async ({ row, guardHeld, firstLaunch }) => {
  const registry = await import('./registry.js')
  expect(registry.guardHeld(row)).toBe(guardHeld)
  expect(registry.heldFirstLaunch(row)).toBe(firstLaunch)
})

// A creation id names a first launch only: once a launch of the row is confirmed its first task was delivered, and a
// later launch with no conversation the guard holds (the fresh fallback, a restore of a row that never bound one) is not one.
const engineProcess = { pid: 4242, startMarker: 'fixture-start', executable: '/fixture/codex' }
type Registry = typeof import('./registry.js')['registry']
type Publication = { name: string; engine: 'codex' | 'terminal' | 'openclaw'; publish: (registry: Registry, agentId: string) => Promise<unknown>; heldAgain?: true }
const publications: Publication[] = [
  { name: 'a launch confirmed ready with its process', engine: 'codex', heldAgain: true,
    publish: async (registry, agentId) => expect((await registry.confirmLaunch(agentId, { processIdentity: engineProcess })).state).toBe('confirmed') },
  { name: 'a terminal confirmed ready, with no process', engine: 'terminal', heldAgain: true,
    publish: async (registry, agentId) => expect((await registry.confirmLaunch(agentId, { processIdentity: null })).state).toBe('confirmed') },
  { name: 'a launch discovery found running', engine: 'codex', heldAgain: true,
    publish: async (registry, agentId) => expect((await registry.openProcessAgent({ engine: 'codex', runtimes, cwd: root, processIdentity: engineProcess }))?.entry.agentId).toBe(agentId) },
  { name: 'an engine exit that leaves a shell', engine: 'codex',
    publish: async (registry, agentId) => expect((await registry.confirmEngineExit(agentId, 'shell')).state).toBe('confirmed') },
  { name: 'a hook binding a session', engine: 'openclaw',
    publish: async (registry, agentId) => expect((await registry.register({ engine: 'openclaw', sessionId: 'agent:main:harness-1', runtimes, cwd: root }))?.entry.agentId).toBe(agentId) },
]

it('keeps the creation id through every launch that is not confirmed', async () => {
  const { registry } = await load()
  const row = (await registry.openPendingAgent({ engine: 'codex', cwd: root, runtimes, nativeToken: TOKEN, creationId: CREATION }))!
  for (const launch of [{ state: 'starting', nativeToken: TOKEN }, guard({}), { state: 'failed', error: 'ENGINE_DID_NOT_START' }, guard({})] as AgentLaunch[]) {
    expect(registry.setLaunch(row.agentId, launch)?.creationId).toBe(CREATION)
  }
  expect((await registry.beginNativeDispatch(row.agentId, randomUUID()))?.creationId).toBe(CREATION)
  expect(disk()[0].creationId).toBe(CREATION)
  expect((await load()).registry.byAgent(row.agentId)?.creationId).toBe(CREATION)
})

it.each(publications)('drops the creation id, durably, at $name', async ({ engine, publish, heldAgain }) => {
  const { registry } = await load()
  const row = (await registry.openPendingAgent({ engine, cwd: root, runtimes, nativeToken: TOKEN, creationId: CREATION }))!
  await publish(registry, row.agentId)
  expect(registry.byAgent(row.agentId)).not.toHaveProperty('creationId')
  await registry.flush()
  expect(disk()[0]).not.toHaveProperty('creationId')
  const next = await load()
  expect(next.registry.byAgent(row.agentId)).not.toHaveProperty('creationId')
  if (!heldAgain) return
  // Held again by the guard with no conversation, it names no receipt a first task could be read from again.
  const held = next.registry.setLaunch(row.agentId, guard({}))!
  expect(held.sessionId).toBe('')
  expect(held).not.toHaveProperty('creationId')
})

it.each(publications)('leaves a row with no creation id as it was, at $name', async ({ engine, publish }) => {
  const { registry } = await load()
  const row = (await registry.openPendingAgent({ engine, cwd: root, runtimes, nativeToken: TOKEN }))!
  await publish(registry, row.agentId)
  expect(registry.byAgent(row.agentId)).not.toHaveProperty('creationId')
  // The bind's row carries no launch: its engine reports in.
  expect(registry.byAgent(row.agentId)?.launch).toEqual(engine === 'openclaw' ? undefined : { state: 'ready' })
  await registry.flush()
  expect(disk()[0]).not.toHaveProperty('creationId')
})
