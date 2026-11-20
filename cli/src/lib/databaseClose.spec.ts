import { removeRegistryAgent } from '../testing/registryFixtures.js'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { SessionCheckpointStore } from './sessionCheckpoint.js'
import { createStopAgentService, type StopAgentServiceDeps } from './stopAgentService.js'
import { registry, type RegisteredSession } from './registry.js'
import { stoppedAgents } from './stoppedAgents.js'
import { AgentRestartCoordinator } from './restartAgent.js'
import { terminateDeletedAgent } from './deleteAgentFallback.js'
import { setAgentSignaller, type AgentSignal } from './processSignals.js'
import type { ExportSource, StorageEngine } from '../engines/worker/storageProtocol.js'
import { openclawSessionDb, openclawStateDir } from './openclawStore.js'
import { nativeHeldFiles, nativeOpenFiles } from './nativeConversation.js'
import { observeNativeFiles } from '../engines/kit/nativeFileObservation.js'
import { IdentityReadUnavailable } from '../engines/kit/identityScan.js'
import { databaseCheckpointEvidence } from './databaseCheckpoint.js'

vi.mock('./captureResumeIdentity.js', () => ({ captureResumeIdentity: vi.fn(async session => session) }))
vi.mock('./deleteAgentFallback.js', () => ({ checkPidRuntime: vi.fn(), terminateDeletedAgent: vi.fn() }))
vi.mock('./nativeConversation.js', async original => ({ ...await original<object>(), nativeOpenFiles: vi.fn(), nativeHeldFiles: vi.fn() }))

let root: string
let directory: string
let row: RegisteredSession
let database: string
let record: string
let store: SessionCheckpointStore
let duringExport: (() => void) | undefined
let exportedSource: ExportSource | undefined
let exportCount: number
let savedGeneration: { verify(): void } | undefined
let deps: StopAgentServiceDeps
let signalled: ReturnType<typeof vi.fn<(pid: number, signal: AgentSignal) => void>>
const oldEnv = { OPENCODE_DATA_DIR: env.OPENCODE_DATA_DIR, KILO_DATA_DIR: env.KILO_DATA_DIR,
  HERMES_HOME: env.HERMES_HOME, DEVIN_HOME: env.DEVIN_HOME, OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR }

function source(engine: StorageEngine): void {
  const paths = { opencode: join(root, 'opencode.db'), kilo: join(root, 'kilo.db'), hermes: join(root, 'state.db'),
    devin: join(root, 'sessions.db'), openclaw: join(root, 'agents', 'main', 'agent', 'openclaw-agent.sqlite') }
  Object.assign(row, { engine, sessionId: engine === 'openclaw' ? 'agent:main:conversation' : '20261116_120000_abcdef',
    hermesHome: root, openclawStateDir: root })
  database = paths[engine]
  mkdirSync(dirname(database), { recursive: true })
  writeFileSync(database, 'original rows', { mode: 0o600 })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'database-close-'))
  directory = join(root, 'checkpoints')
  for (const key of Object.keys(oldEnv) as (keyof typeof oldEnv)[]) env[key] = root
  row = (await registry.openPendingAgent({ engine: 'hermes', cwd: root, runtimes: [{ backend: 'tmux', paneId: '%44' }] }))!
  row = registry.byAgent(row.agentId)!
  Object.assign(row, { processIdentity: { pid: 77, executable: 'hermes', startMarker: new Date(Date.now() - 1_000).toISOString() } })
  source('hermes')
  record = join(root, 'terminal-sessions', 'tty-dev-ttys044')
  mkdirSync(dirname(record))
  writeFileSync(record, JSON.stringify({ session_id: row.sessionId, ts: Date.now() / 1_000 }), { mode: 0o600 })
  duringExport = undefined
  exportedSource = undefined
  exportCount = 0
  savedGeneration = undefined
  vi.mocked(nativeOpenFiles).mockReset()
  vi.mocked(nativeHeldFiles).mockReset()
  store = new SessionCheckpointStore(directory, { exportDatabase: async (_s, source, reservation, reuse) => {
    if (reuse) {
      let unchanged = false
      try { savedGeneration?.verify(); unchanged = !!savedGeneration && readFileSync(database).equals(readFileSync(reuse.checkpoint.path)) } catch { /* Changed generation needs a fresh export. */ }
      if (unchanged && reuse.current()) return { unchanged: true }
    }
    exportCount++
    savedGeneration = observeNativeFiles(['', '-wal', '-journal'].map(suffix => ({ path: source.path + suffix, missingOkay: suffix !== '' })))
    const ownership = await reservation.acquire(process.pid), { stage } = ownership
    exportedSource = source
    const bytes = readFileSync(database)
    writeFileSync(stage.path, bytes)
    duringExport?.()
    await ownership.settled()
    return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  } })
  deps = { registry, stoppedAgents, restartJobs: new AgentRestartCoordinator(), stopJobs: new Map(),
    backendFor: () => ({ kill: vi.fn(async () => ({ state: 'succeeded' as const, dispatch: 'executed' as const })) }),
    agentReconciler: { suppress: vi.fn(), holdRoute: vi.fn(), releaseRoute: vi.fn(), nudge: vi.fn() },
    forgetSession: vi.fn(async id => { await removeRegistryAgent(registry, id) }), markDeleted: vi.fn(), clearDeleted: vi.fn(),
    stopNative: vi.fn(async () => {}),
  }
  // The real terminal backend supplies this same tty for the captured runtime.
  Object.assign(deps, { paneInfo: vi.fn(async () => ({ tty: '/dev/ttys044' })) })
  signalled = vi.fn()
  setAgentSignaller(signalled)
  vi.mocked(terminateDeletedAgent).mockReset().mockImplementation(async (_s, controls) => {
    controls.kill(77, 'SIGTERM')
    return 'terminated'
  })
})
afterEach(async () => {
  setAgentSignaller(null)
  vi.restoreAllMocks()
  Object.assign(env, oldEnv)
  for (const entry of registry.list()) await removeRegistryAgent(registry, entry.agentId)
  await rm(root, { recursive: true, force: true })
})

const stop = () => createStopAgentService(deps)(row.agentId, {
  checkpoint: async (s, phase, databaseProof) => store.save(s, { databaseProof, afterExit: phase === 'after' }),
})
const manifests = () => readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))

it.each(['opencode', 'kilo', 'hermes', 'devin', 'openclaw'] as const)(
  'keeps its completed %s checkpoint when confirmed exit leaves the native generation unchanged', async engine => {
  source(engine)
  await stop()
  expect(deps.forgetSession).toHaveBeenCalledOnce()
  expect(exportCount).toBe(1)
  const manifest = JSON.parse(readFileSync(join(directory, manifests()[0]), 'utf8'))
  expect(readFileSync(join(directory, manifest.file), 'utf8')).toBe('original rows')
})

it.each(['', '-wal', '-journal'])('exports again when exit changes native source%s', async suffix => {
  if (suffix) writeFileSync(database + suffix, 'original sidecar', { mode: 0o600 })
  signalled.mockImplementationOnce(() => writeFileSync(database + suffix, 'final flushed rows'))
  await stop()
  expect(exportCount).toBe(2)
  const manifest = JSON.parse(readFileSync(join(directory, manifests()[0]), 'utf8'))
  expect(readFileSync(join(directory, manifest.file), 'utf8')).toBe(suffix ? 'original rows' : 'final flushed rows')
})

it.each(['-wal', '-journal'])('exports again when exit creates previously absent %s', async suffix => {
  signalled.mockImplementationOnce(() => writeFileSync(database + suffix, 'exit flush', { mode: 0o600 }))
  await stop()
  expect(exportCount).toBe(2)
})

it.each(['-wal', '-journal'])('exports again when exit removes previously present %s', async suffix => {
  writeFileSync(database + suffix, 'before exit', { mode: 0o600 })
  signalled.mockImplementationOnce(() => rmSync(database + suffix))
  await stop()
  expect(exportCount).toBe(2)
})

it.each(['opencode', 'kilo', 'hermes', 'devin', 'openclaw'] as const)('refuses %s publication when its native store changes during export', async engine => {
  source(engine)
  duringExport = () => writeFileSync(database, 'switched conversation')
  await expect(store.save(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(manifests()).toEqual([])
  expect(readFileSync(database, 'utf8')).toBe('switched conversation')
})

it('retains the Hermes native terminal claim while registry rebinding is held', async () => {
  duringExport = () => writeFileSync(record, JSON.stringify({ session_id: '20261116_120001_abcdef', ts: Date.now() / 1_000 }))
  await expect(stop()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(signalled).not.toHaveBeenCalled()
  expect(deps.forgetSession).not.toHaveBeenCalled()
  expect(manifests()).toEqual([])
})

it('checks again after the final native wait before the actual signal', async () => {
  vi.mocked(terminateDeletedAgent).mockImplementation(async (_s, controls) => {
    writeFileSync(record, JSON.stringify({ session_id: '20261116_120001_abcdef', ts: Date.now() / 1_000 }))
    controls.kill(77, 'SIGTERM')
    return 'terminated'
  })
  await expect(stop()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(signalled).not.toHaveBeenCalled()
  expect(deps.forgetSession).not.toHaveBeenCalled()
})

it('keeps the pre-effect generation after a denied signal', async () => {
  source('opencode')
  signalled.mockImplementationOnce(() => { writeFileSync(database, 'sibling write'); throw new Error('EPERM') })
  vi.mocked(terminateDeletedAgent).mockImplementation(async (_s, controls) => {
    try { controls.kill(77, 'SIGTERM') } catch { /* The real termination helper catches a denied signal too. */ }
    controls.kill(77, 'SIGKILL')
    return 'terminated'
  })
  await expect(stop()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(signalled).toHaveBeenCalledTimes(1)
  expect(deps.forgetSession).not.toHaveBeenCalled()
})

it('saves expected exit flushes and tolerates native-record removal after confirmed exit', async () => {
  signalled.mockImplementationOnce(() => { writeFileSync(database, 'final flushed rows'); rmSync(record) })
  await stop()
  expect(deps.forgetSession).toHaveBeenCalledOnce()
  const manifest = JSON.parse(readFileSync(join(directory, manifests()[0]), 'utf8'))
  expect(readFileSync(join(directory, manifest.file), 'utf8')).toBe('final flushed rows')
})

it.each(['opencode', 'kilo', 'hermes', 'devin', 'openclaw'] as const)('keeps both conversations when a shared %s WAL writer advances', async engine => {
  source(engine)
  writeFileSync(database + '-wal', 'both conversations')
  duringExport = () => writeFileSync(database + '-wal', 'both conversations plus sibling message')
  await expect(store.save(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(readFileSync(database, 'utf8')).toBe('original rows')
  expect(readFileSync(database + '-wal', 'utf8')).toContain('sibling message')
  expect(manifests()).toEqual([])
})

it.each(['-wal', '-journal'])('retains absence when %s appears during export', async suffix => {
  duringExport = () => writeFileSync(database + suffix, 'new transaction')
  await expect(store.save(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(manifests()).toEqual([])
})

it.each(['', '-wal', '-journal'])('refuses a replaced source%s even when its bytes match', async suffix => {
  writeFileSync(database + suffix, 'same bytes')
  duringExport = () => { renameSync(database + suffix, database + suffix + '.old'); writeFileSync(database + suffix, 'same bytes') }
  await expect(store.save(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(manifests()).toEqual([])
})

it('exports the selected canonical source while preserving its declared alias in legacy metadata', async () => {
  const alias = join(root, 'profile-alias')
  symlinkSync(root, alias)
  row.hermesHome = alias
  await store.save(row)
  expect(exportedSource).toMatchObject({ path: realpathSync(database), database: join(alias, 'state.db') })
})

it('refuses a retargeted profile alias at publication', async () => {
  const alias = join(root, 'profile-alias'), other = join(root, 'other')
  mkdirSync(other); writeFileSync(join(other, 'state.db'), 'other conversation'); symlinkSync(root, alias)
  row.hermesHome = alias
  duringExport = () => { rmSync(alias); symlinkSync(other, alias) }
  await expect(store.save(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(exportedSource?.path).toBe(realpathSync(database))
  expect(manifests()).toEqual([])
})

it.each(['changed', 'replaced', 'appeared'] as const)('retains OpenClaw config selection when its config is %s', async how => {
  source('openclaw')
  const config = join(root, 'openclaw.json'), selected = join(root, 'selected')
  if (how !== 'appeared') {
    mkdirSync(selected); writeFileSync(join(selected, 'openclaw-agent.sqlite'), 'original rows')
    writeFileSync(config, JSON.stringify({ agents: { entries: { main: { agentDir: './selected' } } } }))
  }
  duringExport = () => {
    if (how === 'replaced') renameSync(config, config + '.old')
    writeFileSync(config, JSON.stringify({ agents: { entries: { main: { agentDir: './another' } } } }))
  }
  await expect(store.save(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(exportedSource?.path).toBe(realpathSync(how === 'appeared' ? database : join(selected, 'openclaw-agent.sqlite')))
  expect(manifests()).toEqual([])
})

it.each(['malformed', 'oversized', 'directory'] as const)('holds an %s OpenClaw location config without dispatch', async how => {
  source('openclaw')
  const config = join(root, 'openclaw.json')
  if (how === 'directory') mkdirSync(config)
  else writeFileSync(config, how === 'malformed' ? '{partial' : ' '.repeat((1 << 20) + 1))
  await expect(store.save(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(exportedSource).toBeUndefined()
  expect(manifests()).toEqual([])
})

it('keeps generation proof across the no-op native Stop of a database engine', async () => {
  deps.stopNative = vi.fn(async () => { writeFileSync(database, 'new conversation') })
  await expect(stop()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(signalled).not.toHaveBeenCalled()
})

it('keeps older Hermes without records working but refuses a newly appearing record', async () => {
  rmSync(record)
  await stop()
  expect(deps.forgetSession).toHaveBeenCalledOnce()
})

it('retains negative Hermes record evidence until the first signal', async () => {
  rmSync(record)
  duringExport = () => writeFileSync(record, JSON.stringify({ session_id: row.sessionId, ts: Date.now() / 1_000 }))
  await expect(stop()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(signalled).not.toHaveBeenCalled()
})

it.each(['mismatching', 'malformed', 'stale', 'oversized'] as const)('holds a present %s Hermes terminal claim', async how => {
  writeFileSync(record, how === 'malformed' ? '{partial' : how === 'oversized' ? ' '.repeat(4_097)
    : JSON.stringify({ session_id: how === 'mismatching' ? '20261116_120001_abcdef' : row.sessionId,
      ts: how === 'stale' ? 1 : Date.now() / 1_000 }))
  await expect(stop()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(exportedSource).toBeUndefined()
  expect(signalled).not.toHaveBeenCalled()
})

it('holds an unknown PTY terminal name instead of treating its unread live record as absent', async () => {
  row.runtimes = [{ backend: 'ptyhost', instance: 'host', paneId: 'pane' }]
  deps.paneInfo = undefined
  writeFileSync(record, JSON.stringify({ session_id: '20261116_120001_abcdef', ts: Date.now() / 1_000 }))
  await expect(stop()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(signalled).not.toHaveBeenCalled()
  expect(exportedSource).toBeUndefined()
})

it.each(['no runtime', 'failed lookup'] as const)('holds Hermes before saving when terminal naming has %s', async why => {
  if (why === 'no runtime') row.runtimes = []
  else deps.paneInfo = vi.fn(async () => { throw new Error('terminal unavailable') })
  await expect(stop()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(signalled).not.toHaveBeenCalled()
  expect(await stoppedAgents.get(row.agentId)).toBeNull()
  expect(deps.forgetSession).not.toHaveBeenCalled()
})

it.each(['cancel', 'rebind'] as const)('holds Close before saving when %s arrives during terminal naming', async change => {
  let current = true
  deps.paneInfo = vi.fn(async () => {
    if (change === 'cancel') current = false
    else row.sessionId = '20261116_120001_abcdef'
    return { tty: '/dev/ttys044', command: 'hermes', path: root, pid: 77 }
  })
  await expect(createStopAgentService(deps)(row.agentId, { current: () => current,
    checkpoint: async (s, phase, databaseProof) => store.save(s, { databaseProof, afterExit: phase === 'after' }),
  })).rejects.toMatchObject({ code: 'STOP_UNCONFIRMED' })
  expect(signalled).not.toHaveBeenCalled()
  expect(await stoppedAgents.get(row.agentId)).toBeNull()
  expect(deps.forgetSession).not.toHaveBeenCalled()
})

it('keeps known TUI absence working on its captured PTY and default Hermes home', async () => {
  row.runtimes = [{ backend: 'ptyhost', instance: 'owned', paneId: 'terminal' }]
  row.primaryRuntimeKey = ''
  row.hermesHome = null
  rmSync(record)
  deps.paneInfo = vi.fn(async () => ({ tty: '', command: 'hermes', path: root, pid: 77 }))
  await stop()
  expect(deps.paneInfo).toHaveBeenCalledWith(row.runtimes[0])
  expect(signalled).toHaveBeenCalledOnce()
  expect(deps.forgetSession).toHaveBeenCalledOnce()
  expect(manifests()).toHaveLength(1)
})

it('does not retire a denied engine signal generation when a child signal succeeds', async () => {
  source('opencode')
  signalled.mockImplementationOnce(() => { throw new Error('EPERM') })
  vi.mocked(terminateDeletedAgent).mockImplementation(async (_s, controls) => {
    try { controls.kill(77, 'SIGTERM') } catch { /* A denied engine signal does not imply its descendants are gone. */ }
    controls.kill(78, 'SIGTERM')
    writeFileSync(database, 'new live conversation after the child left')
    controls.kill(77, 'SIGKILL')
    return 'terminated'
  })
  await expect(stop()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(signalled).toHaveBeenCalledTimes(2)
  expect(deps.forgetSession).not.toHaveBeenCalled()
})

it('retains the original terminal home route during escalation after a successful engine signal', async () => {
  const alias = join(root, 'profile-alias'), other = join(root, 'other')
  symlinkSync(root, alias)
  row.hermesHome = alias
  mkdirSync(join(other, 'terminal-sessions'), { recursive: true })
  writeFileSync(join(other, 'terminal-sessions', 'tty-dev-ttys044'), JSON.stringify({ session_id: row.sessionId, ts: Date.now() / 1_000 }))
  signalled.mockImplementationOnce(() => {
    rmSync(alias); symlinkSync(other, alias)
    writeFileSync(record, JSON.stringify({ session_id: '20261116_120001_abcdef', ts: Date.now() / 1_000 }))
  })
  vi.mocked(terminateDeletedAgent).mockImplementation(async (_s, controls) => {
    controls.kill(77, 'SIGTERM')
    controls.kill(77, 'SIGKILL')
    return 'terminated'
  })
  await expect(stop()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(signalled).toHaveBeenCalledTimes(1)
  expect(deps.forgetSession).not.toHaveBeenCalled()
})

it('selects the current OpenClaw held store rather than a populated PID-only cache', async () => {
  source('openclaw')
  row.openclawStateDir = null
  row.processIdentity!.pid = 84_101
  const stale = join(root, 'stale'), fresh = join(root, 'fresh')
  for (const state of [stale, fresh]) {
    mkdirSync(join(state, 'agents', 'main', 'agent'), { recursive: true })
    writeFileSync(join(state, 'agents', 'main', 'agent', 'openclaw-agent.sqlite'), 'original rows')
  }
  await openclawStateDir(84_101, async () => [join(stale, 'state', 'openclaw.sqlite')])
  vi.mocked(nativeHeldFiles).mockResolvedValue({ paths: [join(fresh, 'state', 'openclaw.sqlite')], verify: vi.fn() })
  await store.save(row)
  expect(exportedSource?.path).toBe(realpathSync(join(fresh, 'agents', 'main', 'agent', 'openclaw-agent.sqlite')))
  expect(nativeHeldFiles).toHaveBeenCalledWith(row.processIdentity, expect.any(Function))
  expect(await openclawSessionDb(row.sessionId, { pid: 84_101 })).toBe(join(stale, 'agents', 'main', 'agent', 'openclaw-agent.sqlite'))
  expect(nativeHeldFiles).toHaveBeenCalledOnce()
})

it.each(['cached', 'uncached'] as const)('holds a failed current OpenClaw descriptor read with an %s optional lookup', async cached => {
  source('openclaw')
  row.openclawStateDir = null
  row.processIdentity!.pid = cached === 'cached' ? 84_102 : 84_103
  if (cached === 'cached') await openclawStateDir(84_102, async () => [join(root, 'state', 'openclaw.sqlite')])
  vi.mocked(nativeHeldFiles).mockRejectedValue(new IdentityReadUnavailable('the descriptor read is incomplete'))
  await expect(store.save(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(exportedSource).toBeUndefined()
})

it('does not infer a POSIX default store from a missing current process identity', async () => {
  source('openclaw')
  row.openclawStateDir = null
  row.processIdentity = null
  await expect(store.save(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(exportedSource).toBeUndefined()
})

it('permits the documented default only after a verified empty current descriptor read', async () => {
  source('openclaw'); row.openclawStateDir = null
  vi.mocked(nativeHeldFiles).mockResolvedValue({ paths: [], verify: vi.fn() })
  await store.save(row)
  expect(exportedSource?.path).toBe(realpathSync(database))
  expect(nativeHeldFiles).toHaveBeenCalledWith(row.processIdentity, expect.any(Function))
})

it('keeps optional OpenClaw readers on their existing failed-probe default rule', async () => {
  source('openclaw')
  vi.mocked(nativeOpenFiles).mockRejectedValue(new IdentityReadUnavailable('the descriptor read is incomplete'))
  expect(await openclawSessionDb(row.sessionId, { pid: 84_104 })).toBe(database)
})

it.each(['cancel', 'rebind'] as const)('rejects an OpenClaw location arriving after %s', async change => {
  source('openclaw'); row.openclawStateDir = null
  let current = true
  vi.mocked(nativeHeldFiles).mockImplementation(async () => {
    if (change === 'cancel') current = false
    else row.sessionId = 'agent:main:replacement'
    return { paths: [join(root, 'state', 'openclaw.sqlite')], verify: vi.fn() }
  })
  await expect(createStopAgentService(deps)(row.agentId, { current: () => current,
    checkpoint: async (s, phase, databaseProof) => store.save(s, { databaseProof, afterExit: phase === 'after' }),
  })).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(exportedSource).toBeUndefined()
  expect(signalled).not.toHaveBeenCalled()
})

it.each(['ambiguous', 'deleted'] as const)('holds an %s OpenClaw held-state claim', async how => {
  source('openclaw'); row.openclawStateDir = null
  vi.mocked(nativeHeldFiles).mockResolvedValue({ paths: how === 'deleted' ? [join(root, 'state', 'openclaw.sqlite') + ' (deleted)']
    : [join(root, 'state', 'openclaw.sqlite'), join(root, 'other', 'state', 'openclaw.sqlite')], verify: vi.fn() })
  await expect(store.save(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(exportedSource).toBeUndefined()
})

it('retains the documented Windows default without claiming native descriptor evidence', async () => {
  source('openclaw'); row.openclawStateDir = null; row.processIdentity = null
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  try {
    const proof = await databaseCheckpointEvidence(row)
    proof!.verify()
    expect(proof?.source?.path).toBe(realpathSync(database))
    expect(nativeOpenFiles).not.toHaveBeenCalled()
    expect(nativeHeldFiles).not.toHaveBeenCalled()
  } finally { Object.defineProperty(process, 'platform', platform) }
})

it('revokes an absent OpenClaw store proof as soon as its database appears', async () => {
  source('openclaw')
  rmSync(database)
  const proof = await databaseCheckpointEvidence(row)
  expect(proof?.source).toBeNull()
  proof!.verify()
  proof!.fresh().verify()
  writeFileSync(database, 'new native history')
  expect(() => proof!.verify()).toThrow(IdentityReadUnavailable)
  expect(() => proof!.fresh()).toThrow(IdentityReadUnavailable)
})
