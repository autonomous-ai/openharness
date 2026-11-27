import { releaseRegistryEngine } from '../testing/registryFixtures.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RegisteredSession } from './registry.js'
import { REGISTRY_WRITE_DEADLINE_MS } from './registryPersistence.js'

vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
const deadline = await vi.hoisted(() => import('../testing/registryDeadline.js'))
vi.mock('node:fs/promises', original => deadline.slowSyncFsPromises(original))
vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))

const TASK = 'Fix the parser'
const SESSION = 'agent:main:harness-1'
const runtimes = [{ backend: 'tmux' as const, paneId: '%1' }]
const instances = new Set<typeof import('./registry.js')['registry']>()
let root: string
let lines: string[]
beforeEach(() => {
  // No test here means the write deadline to pass: how fast this machine writes the registry never fails them.
  deadline.holdRegistryDeadline(REGISTRY_WRITE_DEADLINE_MS)
  root = mkdtempSync(join(tmpdir(), 'registry-first-task-'))
  vi.stubEnv('ADAPTER_DATA_DIR', root)
  lines = []
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
  }
})
afterEach(async () => { for (const instance of instances) await instance.flush({ exiting: true }).catch(() => {}); instances.clear(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); rmSync(root, { recursive: true, force: true }) })

async function load() { vi.resetModules(); const mod = await import('./registry.js'); instances.add(mod.registry); mod.registry.load(); return mod }
const disk = (): RegisteredSession[] => JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'))
async function pending() {
  const { registry, strictPersistedRow } = await load()
  const row = (await registry.openPendingAgent({ engine: 'openclaw', cwd: root, runtimes, firstTask: TASK }))!
  expect(row).toBeTruthy()
  return { registry, row, strictPersistedRow }
}
async function bound() {
  const made = await pending()
  expect((await made.registry.register({ engine: 'openclaw', sessionId: SESSION, runtimes, cwd: root }))).toBeTruthy()
  return made
}

it('a first task is saved on the row and read back by the next daemon', async () => {
  const { row } = await pending()
  expect(row.firstTask).toBe(TASK)
  expect(disk()[0].firstTask).toBe(TASK)
  const { registry } = await load()
  expect(registry.byAgent(row.agentId)?.firstTask).toBe(TASK)
  expect(lines.some(line => line.includes(`[agent] ${row.agentId.slice(0, 8)} first task kept`))).toBe(true)
  expect(lines.filter(line => line.includes(TASK))).toEqual([])
})

it('a bind keeps it', async () => {
  const { registry, row } = await pending()
  const bind = (await registry.register({ engine: 'openclaw', sessionId: SESSION, runtimes, cwd: root }))!
  expect(bind.entry.firstTask).toBe(TASK)
  expect(registry.byAgent(row.agentId)?.firstTask).toBe(TASK)
})

// Typed, not yet confirmed: a daemon restarted before OpenClaw's turn confirms it reads it typed and never pastes it again.
it('taking it marks it typed on the file before it is returned, once, and the next daemon reads it so', async () => {
  const { registry, row } = await bound()
  const before = Date.now()
  expect((await registry.takeFirstTask(row.agentId))).toBe(TASK)
  const typed = disk()[0].firstTaskTyped!
  expect(disk()[0]).not.toHaveProperty('firstTask')
  expect(typed.text).toBe(TASK)
  expect(typed.at).toBeGreaterThanOrEqual(before)
  expect(typed.at).toBeLessThanOrEqual(Date.now())
  expect((await registry.takeFirstTask(row.agentId))).toBeNull()
  const next = await load()
  expect(next.registry.byAgent(row.agentId)).not.toHaveProperty('firstTask')
  expect(next.registry.byAgent(row.agentId)?.firstTaskTyped).toEqual({ text: TASK, at: typed.at })
  expect(lines.filter(line => line.includes(`[agent] ${row.agentId.slice(0, 8)} first task typed`))).toHaveLength(1)
  expect(lines.filter(line => line.includes(TASK))).toEqual([])
})

it('untyping puts it back to wait untyped, only while the typed task is that text', async () => {
  const { registry, row } = await bound()
  await registry.takeFirstTask(row.agentId)
  expect(await registry.untypeFirstTask(row.agentId, `${TASK}!`)).toBe(false)
  expect(disk()[0].firstTaskTyped?.text).toBe(TASK)
  expect(await registry.untypeFirstTask(row.agentId, TASK)).toBe(true)
  expect(disk()[0].firstTask).toBe(TASK)
  expect(disk()[0]).not.toHaveProperty('firstTaskTyped')
  expect(await registry.untypeFirstTask(row.agentId, TASK)).toBe(false)
  expect(await registry.untypeFirstTask('gone', TASK)).toBe(false)
  expect((await registry.takeFirstTask(row.agentId))).toBe(TASK)
  expect(disk()[0].firstTaskTyped?.text).toBe(TASK)
})

it('confirming it removes the typed task, once', async () => {
  const { registry, row } = await bound()
  await registry.takeFirstTask(row.agentId)
  expect(await registry.firstTaskTaken(row.agentId)).toBe(true)
  expect(disk()[0]).not.toHaveProperty('firstTaskTyped')
  expect(disk()[0]).not.toHaveProperty('firstTask')
  expect(await registry.firstTaskTaken(row.agentId)).toBe(false)
  expect(await registry.firstTaskTaken('gone')).toBe(false)
  expect((await registry.takeFirstTask(row.agentId))).toBeNull()
})

it('an unbound agent keeps its task', async () => {
  const { registry, row } = await pending()
  expect((await registry.takeFirstTask(row.agentId))).toBeNull()
  expect(registry.byAgent(row.agentId)?.firstTask).toBe(TASK)
  expect((await registry.takeFirstTask('gone'))).toBeNull()
})

// A first task OpenClaw never took fails the launch (core/agents/bind.ts `failFirstTask`): kept on a row with no session
// yet, it was typed into the TUI that bound one later.
it('an unbound agent whose launch failed gives its task up', async () => {
  const { registry, row } = await pending()
  registry.setLaunch(row.agentId, { state: 'failed', error: 'FIRST_TASK_NOT_TAKEN' })
  expect((await registry.takeFirstTask(row.agentId))).toBe(TASK)
  expect(disk()[0]).not.toHaveProperty('firstTask')
  expect(disk()[0]).not.toHaveProperty('firstTaskTyped')
})

it('a bound agent whose launch failed gives its typed task up, never to be typed', async () => {
  const { registry, row } = await bound()
  await registry.takeFirstTask(row.agentId)
  expect(disk()[0].firstTaskTyped?.text).toBe(TASK)
  registry.setLaunch(row.agentId, { state: 'failed', error: 'FIRST_TASK_NOT_TAKEN' })
  expect((await registry.takeFirstTask(row.agentId))).toBeNull()
  expect(disk()[0]).not.toHaveProperty('firstTaskTyped')
  expect(disk()[0]).not.toHaveProperty('firstTask')
})

it('a registry that cannot save keeps the task untyped', async () => {
  const { registry, row } = await bound()
  writeFileSync(join(root, 'registry.json'), '{unreadable', { mode: 0o600 })
  await expect((async () => (await registry.takeFirstTask(row.agentId)))()).rejects.toThrow()
  expect(registry.byAgent(row.agentId)?.firstTask).toBe(TASK)
  expect(registry.byAgent(row.agentId)).not.toHaveProperty('firstTaskTyped')
})

it('a registry that cannot save keeps a typed task typed', async () => {
  const { registry, row } = await bound()
  await registry.takeFirstTask(row.agentId)
  writeFileSync(join(root, 'registry.json'), '{unreadable', { mode: 0o600 })
  await expect(registry.untypeFirstTask(row.agentId, TASK)).rejects.toThrow()
  await expect(registry.firstTaskTaken(row.agentId)).rejects.toThrow()
  expect(registry.byAgent(row.agentId)?.firstTaskTyped?.text).toBe(TASK)
  expect(registry.byAgent(row.agentId)).not.toHaveProperty('firstTask')
})

it('inside a reconcile transaction it is taken only after the commit', async () => {
  const { registry, row } = await bound()
  let taken: Promise<string | null> | undefined
  await registry.transaction(async () => {
    await expect((async () => (await registry.takeFirstTask(row.agentId)))()).rejects.toThrow()
    expect(registry.byAgent(row.agentId)?.firstTask).toBe(TASK)
    taken = registry.afterTransaction(async () => (await registry.takeFirstTask(row.agentId)))
  })
  await expect(taken).resolves.toBe(TASK)
  expect(disk()[0]).not.toHaveProperty('firstTask')
  expect(disk()[0].firstTaskTyped?.text).toBe(TASK)
})

// The input controller's timers and the turn stream call these, and they can fire while a pass holds its transaction open.
it('untyping it inside a reconcile transaction waits for the commit', async () => {
  const { registry, row } = await bound()
  await registry.takeFirstTask(row.agentId)
  let untyped: Promise<boolean | string> | undefined
  await registry.transaction(async () => {
    untyped = registry.untypeFirstTask(row.agentId, TASK).catch((error: Error) => error.message)
    // The pass's own bind, queued behind it on the writer: a save that did not wait would have run by now.
    expect(await registry.register({ engine: 'openclaw', sessionId: SESSION, runtimes, cwd: root })).toBeTruthy()
    expect(registry.byAgent(row.agentId)?.firstTaskTyped?.text).toBe(TASK)
  })
  await expect(untyped).resolves.toBe(true)
  expect(disk()[0].firstTask).toBe(TASK)
  expect(disk()[0]).not.toHaveProperty('firstTaskTyped')
})

it('confirming it inside a reconcile transaction waits for the commit', async () => {
  const { registry, row } = await bound()
  await registry.takeFirstTask(row.agentId)
  let taken: Promise<boolean | string> | undefined
  await registry.transaction(async () => {
    taken = registry.firstTaskTaken(row.agentId).catch((error: Error) => error.message)
    // The pass's own bind, queued behind it on the writer: a save that did not wait would have run by now.
    expect(await registry.register({ engine: 'openclaw', sessionId: SESSION, runtimes, cwd: root })).toBeTruthy()
    expect(registry.byAgent(row.agentId)?.firstTaskTyped?.text).toBe(TASK)
  })
  await expect(taken).resolves.toBe(true)
  expect(disk()[0]).not.toHaveProperty('firstTaskTyped')
})

// A store read is evidence about the mark typed at `at`: a mark typed again since is newer than the read and stays.
it('confirming a typed task by its moment removes only the mark typed then', async () => {
  const { registry, row } = await bound()
  await registry.takeFirstTask(row.agentId)
  const at = registry.byAgent(row.agentId)!.firstTaskTyped!.at
  expect(await registry.firstTaskTaken(row.agentId, at - 1)).toBe(false)
  expect(disk()[0].firstTaskTyped).toEqual({ text: TASK, at })
  expect(await registry.firstTaskTaken(row.agentId, at)).toBe(true)
  expect(disk()[0]).not.toHaveProperty('firstTaskTyped')
})

it('a bind keeps the typed task', async () => {
  const { registry, row } = await bound()
  await registry.takeFirstTask(row.agentId)
  const typed = registry.byAgent(row.agentId)!.firstTaskTyped
  expect(typed?.text).toBe(TASK)
  const bind = (await registry.register({ engine: 'openclaw', sessionId: SESSION, runtimes, cwd: root }))!
  expect(bind.entry.firstTaskTyped).toEqual(typed)
  expect(disk()[0].firstTaskTyped).toEqual(typed)
})

it('the shell an archived agent leaves behind carries no task', async () => {
  const { registry, row } = await bound()
  const archived = registry.byAgent(row.agentId)!
  expect((await releaseRegistryEngine(registry, row.agentId, true))!.firstTask).toBeUndefined()
  expect(archived.firstTask).toBe(TASK)
})

// An engine that exits before its task is typed leaves its pane a terminal (core/agents/newPane.ts, a restore). Kept, the
// task waits for any OpenClaw the person starts in that shell, and one they typed it into themselves gets it twice.
it('an agent whose engine exits to its shell drops the task, and says so', async () => {
  const { registry, row } = await pending()
  expect((await releaseRegistryEngine(registry, row.agentId))!.firstTask).toBeUndefined()
  await registry.flush()
  expect(disk()[0]).not.toHaveProperty('firstTask')
  expect(lines).toContain(`[agent] ${row.agentId.slice(0, 8)} first task dropped · its engine exited before it was typed`)
  expect(lines.filter(line => line.includes(TASK))).toEqual([])
})

it('an agent whose engine exits after its task was typed drops the typed task', async () => {
  const { registry, row } = await bound()
  await registry.takeFirstTask(row.agentId)
  expect(disk()[0].firstTaskTyped?.text).toBe(TASK)
  expect((await releaseRegistryEngine(registry, row.agentId))!.firstTaskTyped).toBeUndefined()
  await registry.flush()
  expect(disk()[0]).not.toHaveProperty('firstTaskTyped')
  expect(lines.filter(line => line.includes('first task dropped'))).toEqual([])
})

it('a saved row keeps only a text task', async () => {
  const { strictPersistedRow } = await pending()
  const row = disk()[0]
  expect(strictPersistedRow({ ...row, firstTask: 42 })!.firstTask).toBeUndefined()
  expect(strictPersistedRow({ ...row, firstTask: '' })!.firstTask).toBeUndefined()
  expect(strictPersistedRow({ ...row, firstTask: 'x' })!.firstTask).toBe('x')
})

const MALFORMED_TYPED: unknown[] = ['x', null, 1, { text: '', at: 1 }, { text: 42, at: 1 }, { text: 'x' }, { text: 'x', at: 0 },
  { text: 'x', at: -1 }, { text: 'x', at: Infinity }, { text: 'x', at: '1' }]

it('a saved row keeps a typed task only as a text and a moment, over an untyped one', async () => {
  const { strictPersistedRow } = await pending()
  const row = disk()[0]
  for (const firstTaskTyped of MALFORMED_TYPED) {
    const read = strictPersistedRow({ ...row, firstTaskTyped })!
    expect(read).not.toHaveProperty('firstTaskTyped')
    expect(read.firstTask).toBe(TASK)
  }
  const read = strictPersistedRow({ ...row, firstTaskTyped: { text: 'x', at: 5, more: true } })!
  expect(read.firstTaskTyped).toEqual({ text: 'x', at: 5 })
  expect(read).not.toHaveProperty('firstTask')
})

it('the next daemon reads a typed task over an untyped one, and drops a malformed one', async () => {
  const { row } = await pending()
  const saved = disk()[0]
  writeFileSync(join(root, 'registry.json'), JSON.stringify([{ ...saved, firstTaskTyped: { text: TASK, at: 5 } }]), { mode: 0o600 })
  const typed = (await load()).registry.byAgent(row.agentId)!
  expect(typed.firstTaskTyped).toEqual({ text: TASK, at: 5 })
  expect(typed).not.toHaveProperty('firstTask')
  for (const firstTaskTyped of MALFORMED_TYPED) {
    writeFileSync(join(root, 'registry.json'), JSON.stringify([{ ...saved, firstTaskTyped }]), { mode: 0o600 })
    const untyped = (await load()).registry.byAgent(row.agentId)!
    expect(untyped).not.toHaveProperty('firstTaskTyped')
    expect(untyped.firstTask).toBe(TASK)
  }
})
