import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionCheckpointStore, SessionCheckpointError } from './sessionCheckpoint.js'
import { IdentityReadUnavailable } from '../engines/kit/identityScan.js'
import type { RegisteredSession } from './registry.js'
import type { DatabaseCheckpointProof } from './databaseCheckpoint.js'
import type { ExportReservation } from '../engines/worker/storageProtocol.js'

const disk = vi.hoisted(() => ({ acquire: vi.fn() }))
vi.mock('./checkpointStages.js', () => ({ CheckpointStages: class { acquire = disk.acquire; async prepare() {} } }))
const row = { agentId: 'fixture', sessionId: 'fixture-session', engine: 'hermes', transcriptPath: null, codexHome: null, cwd: null } as RegisteredSession
let root: string, time: number
let proof: DatabaseCheckpointProof
let current: ReturnType<typeof vi.fn<() => boolean>>
let close: ReturnType<typeof vi.fn<() => Promise<void>>>
let handoff: ReturnType<typeof vi.fn>
let stage: { deadline: number; stage: { path: string; key: string }; close: typeof close; handoff: typeof handoff }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'checkpoint-reservation-gate-')); time = 0
  vi.spyOn(performance, 'now').mockImplementation(() => time)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  current = vi.fn(() => true); close = vi.fn(async () => {})
  const lease = { deadline: 30_000, stage: { path: join(root, 'history.tmp'), key: '1:2' }, settled: vi.fn(async () => {}) }
  handoff = vi.fn(() => lease)
  // The old shape is retained in this fixture only so the RED tests reach the old store's caller boundary.
  stage = { deadline: 30_000, stage: lease.stage, close, handoff }
  disk.acquire.mockReset().mockResolvedValue(stage)
  proof = { source: { path: join(root, 'state.db'), database: join(root, 'state.db'), key: '3:4' }, verify: vi.fn(), fresh: () => proof }
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
function store(run: (reservation: ExportReservation) => Promise<never>) {
  return new SessionCheckpointStore(join(root, 'checkpoints'), { exportDatabase: async (_session, _source, reservation) => run(reservation) })
}
const save = (value: SessionCheckpointStore) => value.save(row, { current, databaseProof: proof })
const readFailure = 'Could not read the saved conversation. The session has not been closed.'
const timeoutFailure = 'History saving timed out while waiting for disk. Its existing history is kept; try again.'

it('keeps the exact busy refusal when allocation happens inside the export callback', async () => {
  disk.acquire.mockRejectedValue(Object.assign(new Error('slots full'), { code: 'CHECKPOINT_STAGES_BUSY' }))
  await expect(save(store(async reservation => { await reservation.acquire(42); throw new Error('unexpected') })))
    .rejects.toMatchObject({ message: 'History saving is held by unfinished operations. Stop and restart Harness; if it remains held, contact support. Its existing history is kept.' })
  expect(close).not.toHaveBeenCalled()
})

it('keeps allocation disk failure distinct from a worker export failure', async () => {
  disk.acquire.mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
  await expect(save(store(async reservation => { await reservation.acquire(42); throw new Error('unexpected') })))
    .rejects.toMatchObject({ message: 'Could not back up this conversation to disk. Check free space and try again; its existing history is kept.' })
})

it('checks current session authority before allocating any disk state', async () => {
  await expect(save(store(async reservation => {
    current.mockReturnValue(false)
    await reservation.acquire(42); throw new Error('unexpected')
  }))).rejects.toBeInstanceOf(SessionCheckpointError)
  expect(disk.acquire).not.toHaveBeenCalled()
  expect(handoff).not.toHaveBeenCalled()
})

it('preserves a current source refusal at the allocation boundary', async () => {
  const failure = new IdentityReadUnavailable('fixture source changed')
  await expect(save(store(async reservation => {
    vi.mocked(proof.verify).mockImplementation(() => { throw failure })
    await reservation.acquire(42); throw new Error('unexpected')
  }))).rejects.toBe(failure)
  expect(disk.acquire).not.toHaveBeenCalled()
})

it('rejects an expired gate before allocating any disk state', async () => {
  await expect(save(store(async reservation => {
    time = reservation.deadline
    await reservation.acquire(42); throw new Error('unexpected')
  }))).rejects.toMatchObject({ message: timeoutFailure })
  expect(disk.acquire).not.toHaveBeenCalled()
  expect(console.error).toHaveBeenCalledExactlyOnceWith('[checkpoint] STAGE_OPERATION_TIMEOUT')
})

it('a duplicate acquire cannot contaminate a later ordinary export failure', async () => {
  await expect(save(store(async reservation => {
    await reservation.acquire(42)
    current.mockReturnValue(false)
    await expect(reservation.acquire(43)).rejects.toThrow()
    throw new Error('worker disconnected')
  }))).rejects.toMatchObject({ message: readFailure })
  expect(disk.acquire).toHaveBeenCalledOnce(); expect(handoff).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
})

it('an inactive gate cannot allocate after the store has returned', async () => {
  let captured: ExportReservation | undefined
  await expect(save(store(async reservation => { captured = reservation; throw new Error('worker disconnected') })))
    .rejects.toMatchObject({ message: readFailure })
  await expect(captured!.acquire(42)).rejects.toThrow()
  expect(disk.acquire).not.toHaveBeenCalled()
})

it('reports an outer timeout during allocation even just before the clock deadline and drains the late lease', async () => {
  let finish!: () => void, allocation: Promise<unknown> | undefined
  const held = new Promise<void>(resolve => { finish = resolve })
  disk.acquire.mockImplementation(async (_destination: string, pid: number) => {
    if (pid !== 42) throw new Error('allocation preceded writer attestation')
    await held; return stage
  })
  try {
    await expect(save(store(async reservation => {
      allocation = reservation.acquire(42).catch(error => error)
      time = reservation.deadline - 0.5
      throw new Error('checkpoint unavailable')
    }))).rejects.toMatchObject({ message: timeoutFailure })
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[checkpoint] STAGE_OPERATION_TIMEOUT')
    expect(close).not.toHaveBeenCalled()
  } finally { finish(); await allocation }
  expect(handoff).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce()
})

it('owns an active but expired creation before refusing it and closing it unexposed', async () => {
  disk.acquire.mockImplementation(async (_destination: string, _pid: number, deadline: number) => { time = deadline; return stage })
  await expect(save(store(async reservation => { await reservation.acquire(42); throw new Error('unexpected') })))
    .rejects.toMatchObject({ message: timeoutFailure })
  expect(handoff).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce()
  expect(console.error).toHaveBeenCalledExactlyOnceWith('[checkpoint] STAGE_OPERATION_TIMEOUT')
})
