import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionCheckpointStore } from './sessionCheckpoint.js'
import { readProcessEvidence } from './processEvidence.js'
import { readDescriptorEvidence } from '../engines/kit/nativeDescriptors.js'
import type { RegisteredSession } from './registry.js'

vi.mock('./processEvidence.js', () => ({ readProcessEvidence: vi.fn() }))
vi.mock('../engines/kit/nativeDescriptors.js', async original => ({ ...await original<object>(), readDescriptorEvidence: vi.fn() }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) }
})
let root: string, state: string, held: string, directory: string
let joined: () => void, duringExport: () => void
let store: SessionCheckpointStore, session: RegisteredSession
let dispatched: ReturnType<typeof vi.fn<(source: unknown) => void>>
function files(folder: string) {
  mkdirSync(join(folder, 'state'), { recursive: true })
  mkdirSync(join(folder, 'agents', 'main', 'agent'), { recursive: true })
  writeFileSync(join(folder, 'state', 'openclaw.sqlite'), 'held state', { mode: 0o600 })
  writeFileSync(join(folder, 'agents', 'main', 'agent', 'openclaw-agent.sqlite'), 'conversation rows', { mode: 0o600 })
}
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(lstatSync).mockReset().mockImplementation(actual.lstatSync)
  root = realpathSync(mkdtempSync(join(tmpdir(), 'openclaw-checkpoint-'))); state = join(root, 'state-home'); files(state)
  held = join(state, 'state', 'openclaw.sqlite'); directory = join(root, 'checkpoints')
  joined = () => {}; duringExport = () => {}
  const expected = { pid: 42, executable: 'openclaw', startMarker: '2026-11-16T00:00:00.000Z' }
  session = { agentId: 'fixture', engine: 'openclaw', sessionId: 'agent:main:conversation', processIdentity: expected } as RegisteredSession
  const info = lstatSync(held, { bigint: true })
  vi.mocked(readProcessEvidence).mockReset().mockResolvedValue({ parent: expected, children: [], verify: vi.fn(),
    verifyDescriptors: async () => { joined() } } as never)
  vi.mocked(readDescriptorEvidence).mockReset().mockResolvedValue({ descriptors:
    [{ fd: '3', path: held, kind: 'REG', device: info.dev, inode: info.ino }], verify: async () => {} })
  dispatched = vi.fn()
  store = new SessionCheckpointStore(directory, { exportDatabase: async (_s, stage, ownership, source) => {
    dispatched(source)
    const content = readFileSync(source.path)
    await ownership.writer(process.pid)
    writeFileSync(stage.path, content)
    duringExport()
    await ownership.settled()
    return { bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') }
  } })
})
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

it('refuses replacement between the final descriptor lookup and config/database capture', async () => {
  joined = () => { renameSync(state, state + '.old'); files(state) }
  await expect(store.save(session)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(dispatched).not.toHaveBeenCalled()
})

it('requires the held descriptor and the selected state pathname to name the same inode', async () => {
  const evidence = await readDescriptorEvidence(42, {} as never)
  evidence.descriptors[0].inode = evidence.descriptors[0].inode! + 1n
  await expect(store.save(session)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(dispatched).not.toHaveBeenCalled()
})

it('retains the held state-file identity through export publication', async () => {
  duringExport = () => { renameSync(held, held + '.old'); writeFileSync(held, 'different held state', { mode: 0o600 }) }
  await expect(store.save(session)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(readdirSync(directory).filter(name => name.endsWith('.json'))).toEqual([])
})

it('retains the device as well as inode for an operation that cannot cross reboot', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  let replaced = false
  vi.mocked(lstatSync).mockImplementation((path, options) => {
    const info = actual.lstatSync(path, options as never)
    if (!replaced || String(path) !== held) return info
    return Object.create(info, { dev: { value: options?.bigint ? BigInt(info.dev) + 1n : Number(info.dev) + 1 } })
  })
  duringExport = () => { replaced = true }
  await expect(store.save(session)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(readdirSync(directory).filter(name => name.endsWith('.json'))).toEqual([])
})
