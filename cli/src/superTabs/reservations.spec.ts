import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fakeCore } from '../testing/fakeCore.js'
import { builtinSqlite } from '../lib/sqliteBuiltin.js'
import type { CreationObservation } from '../lib/creationObservation.js'
import type { MachineResources } from '../lib/machineResources.js'
import { CapacityReservations } from './reservations.js'

const books: CapacityReservations[] = [], folders: string[] = []
afterEach(() => { for (const book of books.splice(0)) book.stop(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })
const id = (n: number) => `fixture-creation-${n}`
const input = (n = 1, memory = 60, disk = 60) => ({ creationId: id(n), cwd: '/fixture/repo', requirements: { memoryBytes: memory, diskBytes: disk, maxCpuPercent: 80 } })
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'super-tab-capacity-')); folders.push(directory)
  const native = new Map<string, CreationObservation | null>(), stopped = new Set<string>(), gone = new Set<string>()
  const core = fakeCore({ dataDir: directory, agents: {
    creationStatus: vi.fn(async key => native.has(key) ? native.get(key)! : { creationId: key, state: 'missing' as const }),
    stopped: vi.fn(async key => stopped.has(key)),
    gone: vi.fn(async key => gone.has(key)),
  } })
  const resources: MachineResources = { cpuPercent: 20, memoryTotalBytes: 150, memoryUsedBytes: 50 }
  // The live agents' start times (registeredAt) and their measured memory, by harness id.
  const live = new Map<string, number>(), measured = new Map<string, number>()
  const clock = { now: Date.UTC(2026, 9, 28, 4) }
  vi.mocked(core.agents.byAgent).mockImplementation(key => live.has(key) ? { agentId: key, registeredAt: live.get(key)! } as never : undefined)
  const deps = { resources: vi.fn(async () => resources),
    disk: vi.fn(async (cwd: string) => ({ freeBytes: 100, volume: cwd === '/second-volume' ? 'second' : 'first', path: cwd })),
    sqlite: () => builtinSqlite() as never, now: () => clock.now, agentMemory: vi.fn(async () => new Map(measured)) }
  const open = () => { const book = new CapacityReservations(core, 'machine-1', deps); books.push(book); return book }
  /** The start reserved as `n` launched as harness `agent-n` at this moment. */
  const launch = (n: number) => { native.set(id(n), { creationId: id(n), state: 'created', agentId: `agent-${n}` }); live.set(`agent-${n}`, clock.now) }
  return { directory, file: join(directory, 'super-tabs/capacity.sqlite'), core, native, stopped, gone, resources, deps, open, live, measured, clock, launch }
}
const GiB = 1024 ** 3, MINUTE = 60_000
const free = (f: ReturnType<typeof setup>, bytes: number) => { f.resources.memoryTotalBytes = 32 * GiB; f.resources.memoryUsedBytes = 32 * GiB - Math.round(bytes) }
const agentInput = (n: number) => input(n, 2 * GiB, 0)

// Ken's MacBook Pro, 2026-10-28: 7.85 GiB free of 32 and three settled builders using about 0.4 GiB together, yet a start was
// refused with 1.85 GiB "left". Free memory (vm_stat) already counts what a running agent uses, so its 2 GiB was taken twice.
it("counts a start's memory only during its start window, so settled agents do not block more starts", async () => {
  const f = setup(), book = f.open()
  free(f, 30 * GiB)
  for (const n of [1, 2, 3]) { expect(await book.reserve(agentInput(n))).toMatchObject({ ok: true }); f.launch(n); f.measured.set(`agent-${n}`, 0.13 * GiB) }
  f.clock.now += 5 * MINUTE
  free(f, 7.85 * GiB)
  for (const n of [4, 5, 6]) { expect(await book.reserve(agentInput(n))).toMatchObject({ ok: true }); f.launch(n) }
  expect(await book.reserve(agentInput(7))).toMatchObject({ error: 'CAPACITY_UNAVAILABLE',
    detail: 'Not enough free memory: 1.8 GiB free, 2 GiB needed. 6 GiB more is set aside for agents still starting.' })
  // The first of the three new agents settles: its own use is in free memory now, and its window no longer holds.
  f.clock.now += 5 * MINUTE - 1
  expect(await book.reserve(agentInput(7))).toMatchObject({ error: 'CAPACITY_UNAVAILABLE' })
  f.clock.now += 1
  expect(await book.reserve(agentInput(7))).toMatchObject({ ok: true })
})

it('ends a start window early once the agent measures its whole reservation', async () => {
  const f = setup(), book = f.open()
  free(f, 3 * GiB)
  expect(await book.reserve(agentInput(1))).toMatchObject({ ok: true })
  f.launch(1)
  f.measured.set('agent-1', 2 * GiB - 1)
  expect(await book.reserve(agentInput(2))).toMatchObject({ error: 'CAPACITY_UNAVAILABLE' })
  f.measured.set('agent-1', 2 * GiB)
  expect(await book.reserve(agentInput(2))).toMatchObject({ ok: true })
})

it('keeps holding a start that has not launched, and times a launched agent the core no longer lists from its reservation', async () => {
  const f = setup(), book = f.open()
  free(f, 3 * GiB)
  expect(await book.reserve(agentInput(1))).toMatchObject({ ok: true })
  f.clock.now += 60 * MINUTE
  expect(await book.reserve(agentInput(2))).toMatchObject({ error: 'CAPACITY_UNAVAILABLE' })
  // Launched, but not in the core's live list (a reconnect in between): its window ran from the reservation and is over.
  f.native.set(id(1), { creationId: id(1), state: 'created', agentId: 'agent-1' })
  expect(await book.reserve(agentInput(2))).toMatchObject({ ok: true })
})

it('holds every launched start in its window when its memory cannot be measured', async () => {
  const f = setup(), book = f.open()
  free(f, 3 * GiB)
  expect(await book.reserve(agentInput(1))).toMatchObject({ ok: true })
  f.launch(1)
  f.deps.agentMemory.mockRejectedValue(new Error('ps failed'))
  expect(await book.reserve(agentInput(2))).toMatchObject({ error: 'CAPACITY_UNAVAILABLE' })
  f.clock.now += 5 * MINUTE
  expect(await book.reserve(agentInput(2))).toMatchObject({ ok: true })
})

it('still refuses a truly full machine with no other start pending, and says how much memory is free', async () => {
  const f = setup(), book = f.open()
  free(f, 1.5 * GiB)
  expect(await book.reserve(agentInput(1))).toMatchObject({ error: 'CAPACITY_UNAVAILABLE', detail: 'Not enough free memory: 1.5 GiB free, 2 GiB needed.' })
  free(f, 20 * GiB); f.resources.memoryPressure = 'critical'
  expect(await book.reserve(agentInput(1))).toMatchObject({ error: 'CAPACITY_UNAVAILABLE', detail: expect.stringContaining('critical memory pressure') })
})

it('serializes simultaneous starts across books and accounts for their declared budgets', async () => {
  const f = setup(), a = f.open(), b = f.open()
  const answers = await Promise.all([a.reserve(input(1)), b.reserve(input(2))])
  expect(answers.filter(r => r.ok)).toHaveLength(1)
  expect(answers.filter(r => r.error)).toEqual([expect.objectContaining({ error: 'CAPACITY_UNAVAILABLE', detail: expect.stringContaining('memory') })])
  expect(statSync(f.file).mode & 0o777).toBe(0o600)
  expect(statSync(join(f.directory, 'super-tabs')).mode & 0o777).toBe(0o700)
})

it('recovers an interrupted reservation reply after restart without reserving twice', async () => {
  const f = setup(), first = f.open()
  expect(await first.reserve(input())).toMatchObject({ ok: true, reservationId: id(1) })
  first.stop()
  const second = f.open()
  expect(await second.reserve(input())).toMatchObject({ ok: true })
  expect(await second.reserve(input(2, 40, 40))).toMatchObject({ ok: true })
  expect(await second.reserve(input(3, 1, 1))).toMatchObject({ error: 'CAPACITY_UNAVAILABLE' })
  expect(await second.reserve(input(1, 30, 60))).toMatchObject({ error: 'CAPACITY_RECEIPT_CONFLICT' })
})

it.each(['missing', 'pending', 'unconfirmed', null] as const)('retains %s launches with no expiry or inferred stop', async state => {
  const f = setup(), book = f.open()
  await book.reserve(input())
  f.native.set(id(1), state ? { creationId: id(1), state } : null)
  expect(await book.reserve(input(2))).toMatchObject({ error: 'CAPACITY_UNAVAILABLE' })
  expect(await book.observe(id(1))).toMatchObject({ ok: true, released: false, harnessId: null })
})

it.each(['failed', 'cancelled'] as const)('releases only the exact durable %s receipt and prevents its reuse', async state => {
  const f = setup(), book = f.open()
  await book.reserve(input())
  f.native.set(id(1), { creationId: id(1), state })
  expect(await book.reserve(input(2))).toMatchObject({ ok: true })
  expect(await book.reserve(input())).toMatchObject({ error: 'START_FINISHED' })
  f.native.set(id(1), null)
  expect(await book.observe(id(1))).toMatchObject({ ok: true, released: true })
})

it('retains a learned harness identity after its native window disappears and requires a confirmed stop', async () => {
  const f = setup(), book = f.open()
  await book.reserve(input())
  f.native.set(id(1), { creationId: id(1), state: 'created', agentId: 'native' })
  expect(await book.observe(id(1))).toMatchObject({ harnessId: 'native', released: false })
  book.stop()
  f.native.set(id(1), null)
  const restarted = f.open()
  expect(await restarted.reserve(input(2))).toMatchObject({ error: 'CAPACITY_UNAVAILABLE' })
  f.stopped.add('native')
  expect(await restarted.reserve(input(2))).toMatchObject({ ok: true })
  expect(await restarted.observe(id(1))).toMatchObject({ harnessId: 'native', released: true })
})

// The review of #1635: the backend's closeSession row names only the harness, so the host finds the Swarm's own start of
// it here, the receipt every start confirmed against the core before it reported success.
it('names the start that created a harness, even after it stopped, and none for a harness it never started', async () => {
  const f = setup(), book = f.open()
  await book.reserve(input())
  expect(book.creationOf('native')).toBeNull()
  f.native.set(id(1), { creationId: id(1), state: 'created', agentId: 'native' })
  f.stopped.add('native')
  expect(await book.observe(id(1))).toMatchObject({ harnessId: 'native', released: true })
  expect(book.creationOf('native')).toBe(id(1))
  expect(book.creationOf('another')).toBeNull()
})

it('recovers a harness that started and stopped before the service observed its creation', async () => {
  const f = setup(), book = f.open()
  await book.reserve(input())
  f.native.set(id(1), { creationId: id(1), state: 'created', agentId: 'already-closed' })
  f.stopped.add('already-closed')
  expect(await book.observe(id(1))).toMatchObject({ harnessId: 'already-closed', released: true })
  expect(await book.reserve(input(2))).toMatchObject({ ok: true })
})

it('releases the memory of an agent the person closed by hand, on the next reserve, and keeps a running one', async () => {
  const f = setup(), book = f.open()
  await book.reserve(input(1, 100))
  f.native.set(id(1), { creationId: id(1), state: 'created', agentId: 'closed-by-hand' })
  expect(await book.reserve(input(2, 100))).toMatchObject({ error: 'CAPACITY_UNAVAILABLE', detail: expect.stringContaining('memory') })
  f.gone.add('closed-by-hand')
  expect(await book.reserve(input(2, 100))).toMatchObject({ ok: true })
  expect(await book.observe(id(1))).toMatchObject({ harnessId: 'closed-by-hand', released: true })
  f.native.set(id(2), { creationId: id(2), state: 'pending' })
  f.gone.add('never-asked')
  expect(await book.reserve(input(3, 100))).toMatchObject({ error: 'CAPACITY_UNAVAILABLE' })
})

it('frees the disk of an agent the person closed by hand together with its memory', async () => {
  const f = setup(), book = f.open()
  await book.reserve(input(1, 0, 60))
  f.native.set(id(1), { creationId: id(1), state: 'created', agentId: 'closed-by-hand' })
  expect(await book.reserve(input(2, 0, 60))).toMatchObject({ error: 'CAPACITY_UNAVAILABLE', detail: expect.stringContaining('disk') })
  f.gone.add('closed-by-hand')
  expect(await book.reserve(input(2, 0, 60))).toMatchObject({ ok: true })
})

it('does not release on a gone answer that fails or that an older core cannot give', async () => {
  const f = setup(), book = f.open()
  await book.reserve(input(1, 100))
  f.native.set(id(1), { creationId: id(1), state: 'created', agentId: 'native' })
  vi.mocked(f.core.agents.gone!).mockRejectedValueOnce(new Error('offline'))
  expect(await book.reserve(input(2, 100))).toMatchObject({ error: 'CAPACITY_UNAVAILABLE' })
  delete (f.core.agents as { gone?: unknown }).gone
  expect(await book.reserve(input(2, 100))).toMatchObject({ error: 'CAPACITY_UNAVAILABLE' })
})

it('reserves disk on its destination volume and keeps separate volumes independent', async () => {
  const f = setup(), book = f.open()
  await book.reserve(input(1, 0, 60))
  expect(await book.reserve(input(2, 0, 60))).toMatchObject({ error: 'CAPACITY_UNAVAILABLE', detail: expect.stringContaining('disk') })
  expect(await book.reserve({ ...input(3, 0, 60), cwd: '/second-volume', worktree: true })).toMatchObject({ ok: true })
  expect(f.deps.disk).toHaveBeenLastCalledWith('/second-volume', true)
})

// Diego's Mac, 2026-10-28: free disk is measured, so it already counts each running agent's worktree; holding its 10 GiB
// past launch counted that space twice. 15 settled agents held 150 GiB on a disk with 140 GiB free and every start was refused.
const diskInput = (n: number) => input(n, 0, 10 * GiB)
const freeDisk = (f: ReturnType<typeof setup>, bytes: number) => f.deps.disk.mockResolvedValue({ freeBytes: bytes, volume: 'first', path: '/fixture/repo' })

it('counts a start\'s disk only during its start window, so settled agents do not block more starts', async () => {
  const f = setup(), book = f.open()
  freeDisk(f, 1000 * GiB)
  for (let n = 1; n <= 15; n++) { expect(await book.reserve(diskInput(n))).toMatchObject({ ok: true }); f.launch(n) }
  f.clock.now += 5 * MINUTE
  freeDisk(f, 15 * GiB)
  expect(await book.reserve(diskInput(16))).toMatchObject({ ok: true })
})

it('keeps holding disk for a start inside its window and for one that has not launched', async () => {
  const f = setup(), book = f.open()
  freeDisk(f, 15 * GiB)
  expect(await book.reserve(diskInput(1))).toMatchObject({ ok: true })
  f.clock.now += 60 * MINUTE
  expect(await book.reserve(diskInput(2))).toMatchObject({ error: 'CAPACITY_UNAVAILABLE', detail: expect.stringContaining('disk') })
  f.launch(1)
  f.clock.now += 5 * MINUTE - 1
  expect(await book.reserve(diskInput(2))).toMatchObject({ error: 'CAPACITY_UNAVAILABLE', detail: expect.stringContaining('disk') })
  f.clock.now += 1
  expect(await book.reserve(diskInput(2))).toMatchObject({ ok: true })
})

it('lets only one of two simultaneous starts take the last free disk', async () => {
  const f = setup(), a = f.open(), b = f.open()
  freeDisk(f, 15 * GiB)
  const answers = await Promise.all([a.reserve(diskInput(1)), b.reserve(diskInput(2))])
  expect(answers.filter(r => r.ok)).toHaveLength(1)
  expect(answers.filter(r => r.error)).toEqual([expect.objectContaining({ error: 'CAPACITY_UNAVAILABLE', detail: expect.stringContaining('disk') })])
})

it('refuses to reuse a reservation when an unmount moves the same path to a different volume', async () => {
  const f = setup(), book = f.open()
  await book.reserve(input())
  f.deps.disk.mockResolvedValueOnce({ freeBytes: 100, volume: 'replacement', path: '/fixture/repo' })
  expect(await book.reserve(input())).toMatchObject({ error: 'CAPACITY_UNAVAILABLE', detail: expect.stringContaining('filesystem changed') })
  expect(await book.reserve(input(2))).toMatchObject({ error: 'CAPACITY_UNAVAILABLE' })
})

it('refuses unknown native/disk/memory readings and critical or excessive load', async () => {
  const f = setup(), book = f.open()
  f.native.set(id(1), null)
  expect(await book.reserve(input())).toMatchObject({ error: 'CAPACITY_UNAVAILABLE' })
  f.native.delete(id(1)); f.deps.disk.mockRejectedValueOnce(new Error('unmounted'))
  expect(await book.reserve(input())).toMatchObject({ error: 'CAPACITY_UNAVAILABLE' })
  f.resources.memoryUsedBytes = null
  expect(await book.reserve(input())).toMatchObject({ error: 'CAPACITY_UNAVAILABLE' })
  f.resources.memoryUsedBytes = 50; f.resources.memoryPressure = 'critical'
  expect(await book.reserve(input())).toMatchObject({ error: 'CAPACITY_UNAVAILABLE' })
  f.resources.memoryPressure = null; f.resources.cpuPercent = 99
  expect(await book.reserve(input())).toMatchObject({ error: 'CAPACITY_UNAVAILABLE' })
  f.resources.cpuPercent = null
  expect(await book.reserve(input())).toMatchObject({ error: 'CAPACITY_UNAVAILABLE' })
  f.resources.cpuPercent = 20
  expect(await book.reserve(input())).toMatchObject({ ok: true })
})

it('does not trust a receipt for another creation or a changed native identity', async () => {
  const f = setup(), book = f.open()
  f.native.set(id(1), { creationId: id(2), state: 'missing' })
  expect(await book.reserve(input())).toMatchObject({ error: 'CAPACITY_UNAVAILABLE' })
  f.native.delete(id(1)); await book.reserve(input())
  f.native.set(id(1), { creationId: id(1), state: 'created', agentId: 'native' })
  await book.observe(id(1))
  f.native.set(id(1), { creationId: id(1), state: 'created', agentId: 'other-native' })
  await expect(book.observe(id(1))).rejects.toThrow('identity changed')
})

it.each([{ creationId: 'short' }, { cwd: 'relative' }, { worktree: 'yes' },
  { requirements: { memoryBytes: -1 } }, { requirements: { diskBytes: Infinity } },
  { requirements: { memoryBytes: Number.MAX_SAFE_INTEGER + 1 } }, { requirements: { maxCpuPercent: 101 } },
])('rejects malformed admission without probing the host: %j', async value => {
  const f = setup(), book = f.open()
  expect(await book.reserve({ ...input(), ...value })).toMatchObject({ error: 'INVALID_REQUEST' })
  expect(f.deps.resources).not.toHaveBeenCalled()
})

it('cancels an in-flight admission on disconnect or request cancellation', async () => {
  const f = setup(), book = f.open(), controller = new AbortController()
  let finish!: () => void
  f.deps.resources.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve }); return f.resources })
  const pending = book.reserve(input(), controller.signal)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  controller.abort(); finish()
  await expect(pending).rejects.toThrow('disconnected')
  expect(await book.observe(id(1))).toMatchObject({ error: 'CAPACITY_RECEIPT_MISSING' })
  f.deps.resources.mockImplementationOnce(async () => { book.stop(); return f.resources })
  await expect(book.reserve(input())).rejects.toThrow('disconnected')
  expect(await f.open().observe(id(1))).toMatchObject({ error: 'CAPACITY_RECEIPT_MISSING' })
})

it('does not write an old host admission after its machine identity changes', async () => {
  const f = setup(), book = f.open()
  f.deps.resources.mockImplementationOnce(async () => { f.core.daemon.machineId = () => 'another-machine'; return f.resources })
  await expect(book.reserve(input())).rejects.toThrow('disconnected')
  expect(() => new CapacityReservations(f.core, '', f.deps)).toThrow('no confirmed machine identity')
})

it('refuses a replaced, lost, corrupt or unsupported ledger without silently discarding reservations', async () => {
  const f = setup(), book = f.open()
  await book.reserve(input())
  const saved = readFileSync(f.file)
  rmSync(f.file); writeFileSync(f.file, saved, { mode: 0o600 })
  await expect(book.reserve(input(2))).rejects.toThrow('changed on disk')
  book.stop(); rmSync(f.file)
  expect(() => f.open()).toThrow('missing')
  writeFileSync(f.file, 'corrupted', { mode: 0o600 })
  expect(() => f.open()).toThrow()
  rmSync(f.file)
  const target = join(f.directory, 'elsewhere'); writeFileSync(target, saved, { mode: 0o600 }); symlinkSync(target, f.file)
  expect(() => f.open()).toThrow()
  expect(() => new CapacityReservations(f.core, 'machine-1', { ...f.deps, sqlite: () => null })).toThrow('Update the Harness CLI runtime')
})

it('serializes real concurrent processes using one disk ledger', async () => {
  const f = setup(); f.open().stop()
  const script = `
    import { CapacityReservations } from './src/superTabs/reservations.ts';
    import { builtinSqlite } from './src/lib/sqliteBuiltin.ts';
    const core = { dataDir: process.argv[1], daemon: { machineId: () => 'machine-1' }, agents: {
      creationStatus: async creationId => ({ creationId, state: 'missing' }), stopped: async () => false
    } };
    const book = new CapacityReservations(core, 'machine-1', {
      resources: async () => { await new Promise(r => setTimeout(r, 150)); return { cpuPercent: 0, memoryTotalBytes: 100, memoryUsedBytes: 0 } },
      disk: async () => ({ freeBytes: 100, volume: 'volume', path: '/repo' }), sqlite: builtinSqlite
    });
    try { console.log(JSON.stringify(await book.reserve({ creationId: process.argv[2], cwd: '/repo', requirements: { memoryBytes: 70, diskBytes: 70 } }))); }
    finally { book.stop(); }
  `
  const run = promisify(execFile)
  const answers = await Promise.all([1, 2].map(async n => {
    const result = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, f.directory, id(n)], { timeout: 15_000 })
    return JSON.parse(result.stdout.trim())
  }))
  expect(answers.filter(r => r.ok)).toHaveLength(1)
  expect(answers.filter(r => r.error)).toEqual([expect.objectContaining({ error: 'CAPACITY_UNAVAILABLE' })])
}, 20_000)
