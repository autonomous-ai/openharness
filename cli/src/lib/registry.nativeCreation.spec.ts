import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nativeCreateFingerprint, type NativeCreateRequest } from './nativeCreateRequest.js'
import { nativeCreationMetadata, parseNativePendingCreation } from './nativePendingCreation.js'
import { nativeTurnTarget, type NativeTurnIntent } from './nativeTurnIntent.js'
import type { RegisteredSession } from './registry.js'

const fault = vi.hoisted(() => ({ file: '', rename: false, directory: false, renamed: false,
  published: undefined as (() => void) | undefined, synced: undefined as (() => void) | undefined }))
vi.mock('fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    if (String(args[1]) === fault.file && fault.rename) throw Error('fixture rename failure')
    actual.renameSync(...args)
    if (String(args[1]) === fault.file) { fault.renamed = true; fault.published?.() }
  }, fsyncSync: (fd: number) => {
    if (fault.directory && fault.renamed && actual.fstatSync(fd).isDirectory()) throw Error('fixture directory sync failure')
    actual.fsyncSync(fd)
    if (fault.renamed && actual.fstatSync(fd).isDirectory()) fault.synced?.()
  } }
})
vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('No host process belongs to this Registry fixture') }
  return { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
vi.mock('./bootId.js', () => ({ currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))
let root: string, data: string, file: string
let registry: typeof import('./registry.js')['registry'], strict: typeof import('./registry.js')['strictPersistedRow']
const request = (): NativeCreateRequest => ({ kind: 'native-create-v2', agentId: 'original-agent',
  creationId: 'original-create-request', launchToken: 'original-launch-token', label: 'harness-cursor-original', local: true,
  input: { engine: 'cursor', cwd: '/fixture/project', prompt: 'Original task', permissionMode: 'ask' }, selection: null })
const receipt = () => { const input = request(); return { fingerprint: nativeCreateFingerprint(input), request: input } }
const reserve = () => registry.reserveNativeCreation(receipt(), () => {})
const prepare = (row: RegisteredSession) => registry.commitNativeCreationPreparation(row, { cwd: '/fixture/project',
  permissionMode: 'ask', grid: null, gridLaunch: null, gridWebSearch: null, scmLaunch: null }, () => {})
const placement = () => ({ pane: '%7', rootPid: 10, token: request().launchToken, owner: 'a'.repeat(16),
  root: { boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', namespace: 'linux:4:5', pid: 10, birth: '1000' },
  endpoint: { binary: '/fixture/tmux', socket: '/fixture/socket',
    server: { boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', namespace: 'linux:4:5', pid: 9, birth: '900' } } })
const associate = (row: RegisteredSession) => registry.associateNativeCreation(row, { placement: placement(), verify: () => {}, current: () => {} })
const cancel = (row: RegisteredSession): NativeTurnIntent => ({ version: 1, cancel: { processKey: null, target: nativeTurnTarget(row),
  request: { requestId: 'original-cancel-request', nonce: 'original-cancel-nonce', agentId: row.agentId, conversationId: '',
    frontier: { index: -1, digest: null } } } })
const bytes = () => readFileSync(file, 'utf8')
const cold = async () => { vi.resetModules(); return (await import('./registry.js')).registry }
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'registry-native-creation-')))
  data = join(root, 'data'); file = join(data, 'registry.json')
  mkdirSync(data, { mode: 0o700 }); writeFileSync(join(data, 'engine-homes.json'), '{}', { mode: 0o600 })
  for (const [key, value] of Object.entries({ HOME: root, ADAPTER_DATA_DIR: data, ADAPTER_RUNTIME_DIR: join(root, 'runtime'),
    CURSOR_HOME: join(root, 'cursor'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude') })) vi.stubEnv(key, value)
  fault.file = file; fault.rename = fault.directory = fault.renamed = false; fault.published = fault.synced = undefined
  vi.resetModules(); ({ registry, strictPersistedRow: strict } = await import('./registry.js'))
  registry.load()
})
afterEach(() => { fault.rename = fault.directory = false; fault.published = fault.synced = undefined
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); rmSync(root, { recursive: true, force: true }) })

it('durably reserves the original first identity without inventing a pane or admitting a process', async () => {
  const source = receipt()
  fault.published = () => expect(registry.byAgent(source.request.agentId)).toBeUndefined()
  let row!: RegisteredSession
  expect(() => { row = registry.reserveNativeCreation(source, () => {}) }).not.toThrow()
  expect(row).toMatchObject({ schemaVersion: 6, active: false, sessionId: '', boundAt: null, processIdentity: null,
    runtimes: [], primaryRuntimeKey: '', nativeCreation: { receipt: source, prepared: false, revoked: false } })
  expect(row.nativeControl).toBeUndefined(); expect(row.nativeAllocation).toBeUndefined()
  ;(source.request.input as Record<string, unknown>).nested = { changed: true }
  expect(row.nativeCreation!.receipt).toEqual(receipt())
  expect(Object.isFrozen(row.nativeCreation!.receipt.request.input)).toBe(true)
  fault.published = undefined
  const restored = await cold(); restored.load()
  expect(restored.byAgent(row.agentId)?.nativeCreation).toEqual(row.nativeCreation)
  expect(restored.byAgent(row.agentId)?.runtimes).toEqual([])
  expect(() => restored.readNativeControl(restored.byAgent(row.agentId)!).verify()).not.toThrow()
  const before = bytes()
  expect(() => restored.reserveNativeCreation(receipt(), () => {})).toThrow('already has')
  expect(bytes()).toBe(before)
})

it('requires the original live claim and complete immutable request before reservation', () => {
  expect(() => registry.reserveNativeCreation(receipt(), () => { throw Error('claim lost') })).toThrow('claim lost')
  expect(() => registry.reserveNativeCreation({ ...receipt(), fingerprint: 'f'.repeat(64) }, () => {})).toThrow('invalid')
  expect(registry.byAgent(request().agentId)).toBeUndefined()
  expect(existsSync(file)).toBe(false)
})

it.each(['rename', 'directory'] as const)('keeps an uncertain %s reservation out of live memory', async failure => {
  fault[failure] = true
  expect(() => reserve()).toThrow()
  expect(registry.byAgent(request().agentId)).toBeUndefined()
  fault[failure] = false
  if (failure === 'rename') { expect(existsSync(file)).toBe(false); return }
  const restored = await cold(); restored.load()
  const row = restored.byAgent(request().agentId)!
  expect(row).toBeDefined()
  expect(row.nativeCreation?.prepared).toBe(false)
  expect(() => restored.readNativeControl(row).verify()).not.toThrow()
})

it('fills resolved choices only once and retains them across restart and observation', async () => {
  const reserved = reserve()
  let row!: RegisteredSession
  expect(() => { row = prepare(reserved) }).not.toThrow()
  const before = bytes()
  expect(row.nativeCreation?.prepared).toBe(true)
  expect(row.nativeCreation?.metadata).toBe(nativeCreationMetadata(row))
  expect(() => prepare(row)).toThrow('cannot be replaced')
  expect(() => prepare(reserved)).toThrow('changed')
  expect(registry.setCwd(row.agentId, '/different/project')).toBe(false)
  expect(registry.setPermissionMode(row.agentId, 'full')).toBe(false)
  expect(registry.setGridLaunch(row.agentId, null)).toBe(false)
  expect(bytes()).toBe(before)
  const restored = await cold(); restored.load()
  expect(restored.byAgent(row.agentId)?.nativeCreation).toEqual(row.nativeCreation)
  expect(restored.byAgent(row.agentId)?.cwd).toBe('/fixture/project')
})

it.each(['agentId', 'engine', 'registeredAt', 'sessionId', 'nativeCreation'])('refuses %s in the preparation metadata', key => {
  const row = reserve(), before = bytes()
  expect(() => registry.commitNativeCreationPreparation(row, { [key]: 'replacement' } as any, () => {})).toThrow()
  expect(bytes()).toBe(before)
})

it('retains the exact pane server/root/token while generic discovery and hooks cannot admit it', async () => {
  const ready = prepare(reserve())
  let row!: RegisteredSession
  expect(() => { row = associate(ready) }).not.toThrow()
  const before = bytes()
  expect(row.nativeCreation?.placement).toEqual(placement())
  expect(row.runtimes).toEqual([{ backend: 'tmux', paneId: '%7' }])
  expect(() => associate(row)).toThrow('unavailable')
  const processIdentity = { pid: 42, startMarker: 'fixture-engine-start', executable: '<cursor>' }
  for (const engine of ['cursor', 'codex'] as const) {
    expect(registry.openProcessAgent({ engine, tmuxPane: '%7', processIdentity })).toBeNull()
    expect(registry.register({ engine, tmuxPane: '%7', processIdentity, sessionId: 'early-session' })).toBeNull()
  }
  expect(registry.updateProcessIdentity(row.agentId, processIdentity)).toBe(false)
  expect(registry.updateRuntimes(row.agentId, [{ backend: 'tmux', paneId: '%8' }])).toBe(false)
  expect(registry.setLaunch(row.agentId, { state: 'ready' })).toBeNull()
  expect(registry.setActive(row.agentId, true)).toBe(false)
  expect(() => registry.removeAgent(row.agentId)).toThrow('physical accounting')
  expect(() => registry.releaseEngine(row.agentId)).toThrow('physical accounting')
  expect(bytes()).toBe(before)
  const restored = await cold(); restored.load()
  expect(restored.byAgent(row.agentId)?.nativeCreation).toEqual(row.nativeCreation)
  expect(restored.byAgent(row.agentId)?.active).toBe(false)
})

it('fences placement publication and rejects another request token or incomplete server ownership', () => {
  const row = prepare(reserve()), before = bytes()
  expect(() => registry.associateNativeCreation(row, { placement: { ...placement(), token: 'foreign-launch-token' }, verify: () => {}, current: () => {} })).toThrow()
  expect(() => registry.associateNativeCreation(row, { placement: { ...placement(), rootPid: 11 }, verify: () => {}, current: () => {} })).toThrow()
  expect(() => registry.associateNativeCreation(row, { placement: placement(), verify: () => { throw Error('pane changed') }, current: () => {} })).toThrow('pane changed')
  expect(bytes()).toBe(before)
})

it.each(['reserved', 'prepared', 'associated'])('keeps Cancel sticky on a %s initial allocation', async phase => {
  let row = reserve()
  if (phase !== 'reserved') row = prepare(row)
  if (phase === 'associated') row = associate(row)
  const prior = row.nativeCreation!, cancelled = registry.commitNativeControl(row, cancel(row), () => {})
  expect(cancelled.schemaVersion).toBe(6)
  expect(cancelled.nativeCreation).toEqual({ ...prior, revoked: true })
  expect(cancelled.nativeControl?.cancel.processKey).toBeNull()
  expect(strict({ ...cancelled, nativeControl: undefined })).toBeNull()
  expect(strict({ ...cancelled, nativeCreation: { ...cancelled.nativeCreation, revoked: false } })).toBeNull()
  expect(() => prepare(cancelled)).toThrow()
  expect(() => associate(cancelled)).toThrow()
  expect(() => registry.commitNativeControl(cancelled, { ...cancelled.nativeControl!, rearm: {
    agentId: row.agentId, requestId: 'another-request-id', launchToken: 'another-launch-token', target: nativeTurnTarget(cancelled),
    operation: 'resume', source: 'live', sourceProcess: { processKey: null } } }, () => {})).toThrow('invalid')
  const restored = await cold(); restored.load()
  expect(restored.byAgent(row.agentId)?.nativeCreation?.revoked).toBe(true)
  expect(restored.byAgent(row.agentId)?.nativeControl).toEqual(cancelled.nativeControl)
})

it('revokes already-awaiting preparation before it can publish its metadata', () => {
  const row = reserve()
  expect(() => registry.commitNativeCreationPreparation(row, { cwd: '/fixture/project' }, () => {
    registry.commitNativeControl(row, cancel(row), () => {})
  })).toThrow('changed')
  expect(registry.byAgent(row.agentId)?.nativeCreation?.prepared).toBe(false)
  expect(registry.byAgent(row.agentId)?.nativeCreation?.revoked).toBe(true)
})

it('refuses pending creation archives instead of losing their live allocation evidence', async () => {
  const row = prepare(reserve()), { StoppedAgentStore } = await import('./stoppedAgents.js')
  const store = new StoppedAgentStore(join(root, 'saved'))
  expect(() => store.save(row)).toThrow('pending native creation')
  expect(store.get(row.agentId)).toBeNull()
  mkdirSync(join(root, 'saved'), { recursive: true, mode: 0o700 })
  writeFileSync(join(root, 'saved', `${row.agentId}.json`), JSON.stringify({ version: 1, session: row }), { mode: 0o600 })
  expect(() => store.get(row.agentId)).toThrow()
})

it.each(['missing', 'version', 'fingerprint', 'request', 'revoked', 'prepared', 'metadata', 'extra', 'placement'])('rejects %s pending authority before accepting the file', change => {
  const row = associate(prepare(reserve())), bad: any = structuredClone(row)
  if (change === 'missing') delete bad.nativeCreation
  if (change === 'version') bad.nativeCreation.version = 2
  if (change === 'fingerprint') bad.nativeCreation.receipt.fingerprint = 'b'.repeat(64)
  if (change === 'request') bad.nativeCreation.receipt.request.agentId = 'another-agent'
  if (change === 'revoked') bad.nativeCreation.revoked = 'false'
  if (change === 'prepared') bad.nativeCreation.prepared = 1
  if (change === 'metadata') bad.cwd = '/changed/project'
  if (change === 'extra') bad.nativeCreation.extra = true
  if (change === 'placement') bad.runtimes = [{ backend: 'tmux', paneId: '%8' }]
  expect(strict(bad)).toBeNull()
  writeFileSync(file, JSON.stringify([bad]), { mode: 0o600 })
  const before = bytes(); registry.load(); registry.flush()
  expect(registry.list()).toEqual([])
  expect(bytes()).toBe(before)
})

it('accepts zero routes only for a complete inactive and unbound pending launch', () => {
  const row = reserve()
  for (const patch of [{ schemaVersion: 2, nativeCreation: undefined }, { active: true }, { sessionId: 'unexpected' },
    { boundAt: 1 }, { processIdentity: { pid: 42, executable: '<cursor>', startMarker: 'start' } },
    { transcriptPath: '/fixture/transcript' }, { launch: { state: 'ready' } }, { launch: { state: 'held', service: 'models', detail: 'wait' } },
    { nativeAllocation: { version: 2, receipts: [receipt()] } }, { resumeOnly: true }, { engine: 'codex' },
    { primaryRuntimeKey: 'tmux\0%7' }, { tmuxPane: '%7' }]) expect(strict({ ...row, ...patch })).toBeNull()
  expect(parseNativePendingCreation({ ...row.nativeCreation, placement: placement() })).toBeNull()
})


it('confirms the same uncertain reservation in this instance with its original time and choices', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_700_000_000_000)
  fault.directory = true
  expect(() => reserve()).toThrow('directory sync')
  const written = JSON.parse(bytes())[0] as RegisteredSession
  expect(registry.byAgent(written.agentId)).toBeUndefined()
  fault.directory = false; vi.setSystemTime(1_800_000_000_000)
  const wrong = receipt(); (wrong.request as { label: string }).label = 'harness-cursor-foreign'
  expect(() => registry.reserveNativeCreation(wrong, () => {})).toThrow('changed')
  expect(() => registry.reserveNativeCreation(receipt(), () => { throw Error('claim expired') })).toThrow('claim expired')
  expect(registry.byAgent(written.agentId)).toBeUndefined()
  let restored: RegisteredSession | undefined
  expect(() => { restored = reserve() }).not.toThrow()
  expect(restored!.registeredAt).toBe(written.registeredAt)
  expect(restored!.defaultName).toBe(written.defaultName)
  expect(restored!.nativeCreation).toEqual(written.nativeCreation)
})

it.each(['reserve', 'prepare', 'associate', 'cancel'] as const)('does not acknowledge %s after its publisher is replaced with equal bytes', phase => {
  const row = phase === 'reserve' ? undefined : phase === 'associate' ? prepare(reserve()) : reserve()
  const before = row && structuredClone(row)
  fault.renamed = false
  fault.published = () => {
    fault.published = undefined
    const substitute = `${file}.substitute`
    writeFileSync(substitute, bytes(), { mode: 0o600 }); renameSync(substitute, file)
  }
  const run = () => phase === 'reserve' ? reserve() : phase === 'prepare' ? prepare(row!)
    : phase === 'associate' ? associate(row!) : registry.commitNativeControl(row!, cancel(row!), () => {})
  expect(run).toThrow('published registry image changed')
  expect(registry.byAgent(request().agentId)).toEqual(before)
  // The same bytes at a different inode cannot confirm this publisher later.
  expect(run).toThrow('published registry image changed')
})

it.each(['reserve', 'prepare', 'associate', 'cancel'] as const)('does not acknowledge %s when its authority expires during directory sync', phase => {
  const row = phase === 'reserve' ? undefined : phase === 'associate' ? prepare(reserve()) : reserve()
  const before = row && structuredClone(row)
  let current = true
  const fence = () => { if (!current) throw Error('original claim expired during sync') }
  fault.renamed = false; fault.synced = () => { current = false }
  const run = () => phase === 'reserve' ? registry.reserveNativeCreation(receipt(), fence)
    : phase === 'prepare' ? registry.commitNativeCreationPreparation(row!, { cwd: '/fixture/project' }, fence)
      : phase === 'associate' ? registry.associateNativeCreation(row!, { placement: placement(), verify: () => {}, current: fence })
        : registry.commitNativeControl(row!, cancel(row!), fence)
  expect(run).toThrow('original claim expired during sync')
  expect(registry.byAgent(request().agentId)).toEqual(before)
})

it('retains the original placement callbacks when the caller replaces them during verification', () => {
  const row = prepare(reserve()), before = bytes()
  const proof = { placement: placement(), verify: () => {}, current: (): void => { throw Error('original placement revoked') } }
  proof.verify = () => { proof.current = () => {} }
  expect(() => registry.associateNativeCreation(row, proof)).toThrow('original placement revoked')
  expect(bytes()).toBe(before)
})

it('does not replace an uncertain prepared image with another set of resolved choices', () => {
  const row = reserve()
  fault.directory = true; fault.renamed = false
  expect(() => prepare(row)).toThrow('directory sync')
  const before = bytes()
  fault.directory = false
  expect(() => registry.commitNativeCreationPreparation(row, { cwd: '/different/project' }, () => {})).toThrow('still needs durable confirmation')
  expect(bytes()).toBe(before)
  expect(() => prepare(row)).not.toThrow()
  expect(registry.byAgent(row.agentId)?.cwd).toBe('/fixture/project')
})


it.each(['reserve', 'prepare', 'associate', 'cancel'] as const)('checks %s authority after its final committed readback', phase => {
  const row = phase === 'reserve' ? undefined : phase === 'associate' ? prepare(reserve()) : reserve()
  let current = true
  const fence = () => { if (!current) throw Error('original authority expired after final readback') }
  const read = registry.readNativeControl.bind(registry)
  vi.spyOn(registry, 'readNativeControl').mockImplementation(input => {
    const proof = read(input)
    return { ...proof, verify: () => { proof.verify(); current = false } }
  })
  const run = () => phase === 'reserve' ? registry.reserveNativeCreation(receipt(), fence)
    : phase === 'prepare' ? registry.commitNativeCreationPreparation(row!, { cwd: '/fixture/project' }, fence)
      : phase === 'associate' ? registry.associateNativeCreation(row!, { placement: placement(), verify: () => {}, current: fence })
        : registry.commitNativeControl(row!, cancel(row!), fence)
  expect(run).toThrow('original authority expired after final readback')
})

it('checks the exact committed owner after the final external fence', () => {
  const row = reserve()
  expect(() => registry.commitNativeCreationPreparation(row, { cwd: '/fixture/project' }, () => {
    const latest = registry.byAgent(row.agentId)!
    if (latest.nativeCreation?.prepared) registry.commitNativeControl(latest, cancel(latest), () => {})
  })).toThrow('committed native creation owner changed')
  expect(registry.byAgent(row.agentId)?.nativeCreation?.revoked).toBe(true)
})
