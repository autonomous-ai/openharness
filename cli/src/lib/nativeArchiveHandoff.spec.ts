import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { creationFingerprint } from './agentCreationReceipt.js'
import { nativeRearmRequest, nativeTurnAdmitted, nativeTurnTarget, type NativeTurnIntent } from './nativeTurnIntent.js'
import type { RegisteredSession } from './registry.js'
import type { StoppedAgentStore } from './stoppedAgents.js'
import type { NativeRearmReplacementProof } from '../engines/kit/nativeRearmProof.js'

const fault = vi.hoisted(() => ({ registry: '', archive: '', phase: '', fail: '',
  published: undefined as ((phase: string) => void) | undefined, phases: [] as string[], closed: undefined as ((path: string) => void) | undefined }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  const paths = new Map<number, string>()
  return { ...actual, openSync: (...args: Parameters<typeof actual.openSync>) => {
    const fd = actual.openSync(...args); paths.set(fd, String(args[0])); return fd
  }, closeSync: (fd: number) => {
    const path = paths.get(fd) ?? ''; paths.delete(fd); actual.closeSync(fd); fault.closed?.(path)
  }, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    actual.renameSync(...args)
    const path = String(args[1])
    if (path !== fault.registry && path !== fault.archive) return
    const raw = JSON.parse(actual.readFileSync(path, 'utf8'))
    fault.phase = path === fault.archive ? raw.version === 2 ? 'transfer' : 'saved'
      : raw.find((row: RegisteredSession) => row.agentId === 'saved-agent')?.nativeControl?.rearm?.replacement ? 'admission' : 'pending'
    fault.phases.push(fault.phase); fault.published?.(fault.phase)
  }, fsyncSync: (fd: number) => {
    if (fault.fail && fault.phase === fault.fail && actual.fstatSync(fd).isDirectory()) throw Error(`fixture ${fault.fail} sync failed`)
    actual.fsyncSync(fd)
  } }
})
vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))

let root: string, data: string, archive: string, saved: RegisteredSession
let registry: typeof import('./registry.js')['registry'], store: StoppedAgentStore
const control = (row: RegisteredSession): NativeTurnIntent => ({ version: 1, cancel: { processKey: null, target: nativeTurnTarget(row),
  request: { requestId: 'original-cancel-request', nonce: 'original-cancel-nonce', agentId: row.agentId,
    conversationId: row.sessionId, frontier: { index: -1, digest: null } } } })
const rows = (): RegisteredSession[] => JSON.parse(readFileSync(fault.registry, 'utf8'))
const diskRow = () => rows().find(row => row.agentId === saved.agentId)!
const fence = { verify: () => {}, current: () => {} }
function proof(): NativeRearmReplacementProof {
  const source = store.readNativeResumeSource(saved), rearm = saved.nativeControl!.rearm!
  const request = { fingerprint: creationFingerprint({ kind: 'native-rearm', agentId: saved.agentId,
    operation: 'resume', source: 'saved', permissionMode: 'full' }), request: nativeRearmRequest(saved.nativeControl!)! }
  return { key: 'fixture-boot\0cursor\0' + 43 + '\0precise-birth', evidence: 'original-exec', pane: '%2',
    processIdentity: { pid: 43, executable: '<cursor>', startMarker: 'replacement-start', startTicks: 43 },
    verify: vi.fn(source.verify), verifyExecution: vi.fn(), verifyConfirmation: vi.fn(), current: vi.fn(),
    source: { target: rearm.target, controlFingerprint: creationFingerprint(saved.nativeControl), requestFingerprint: creationFingerprint(request) } }
}
const commit = (replacement = proof()) => registry.commitNativeSavedReplacement(saved, replacement, store, () => {})
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-archive-handoff-'))); data = join(root, 'data'); archive = join(data, 'stopped-agents')
  mkdirSync(data, { mode: 0o700 }); writeFileSync(join(data, 'registry.json'), '[]', { mode: 0o600 })
  writeFileSync(join(data, 'engine-homes.json'), '{}', { mode: 0o600 })
  for (const [key, value] of Object.entries({ HOME: root, ADAPTER_DATA_DIR: data, ADAPTER_RUNTIME_DIR: join(root, 'runtime'),
    CURSOR_HOME: join(root, 'cursor'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude') })) vi.stubEnv(key, value)
  vi.resetModules(); ({ registry } = await import('./registry.js'))
  const { StoppedAgentStore } = await import('./stoppedAgents.js'); store = new StoppedAgentStore(archive); registry.load()
  const original: RegisteredSession = { schemaVersion: 2, agentId: 'saved-agent', engine: 'cursor', sessionId: 'saved-session',
    cwd: '/fixture/project', projectDir: '/fixture/project', transcriptPath: null, tmuxPane: '%1', runtimes: [{ backend: 'tmux', paneId: '%1' }],
    primaryRuntimeKey: 'tmux\0%1', registeredAt: 1, boundAt: 2, lastHookAt: 2, lastTranscriptAt: 2, touchedAt: 2, active: false,
    source: 'hook', defaultName: 'Fixture', title: null, model: null, cliVersion: null, processIdentity: { pid: 42, executable: '<cursor>', startMarker: 'prior-start' } }
  store.save({ ...original, schemaVersion: 3, nativeControl: control(original) })
  const cancelled = store.get(original.agentId)!
  saved = store.commitNativeControl(cancelled, { ...cancelled.nativeControl!, rearm: { agentId: cancelled.agentId, sourceProcess: { processKey: cancelled.nativeControl!.cancel.processKey },
    requestId: 'original-resume-request', launchToken: 'original-launch-token', operation: 'resume', source: 'saved',
    permissionMode: 'full', target: nativeTurnTarget(cancelled) } }, fence)
  fault.registry = join(data, 'registry.json'); fault.archive = join(archive, `${saved.agentId}.json`)
  fault.phase = ''; fault.fail = ''; fault.phases = []; fault.published = undefined; fault.closed = undefined
})
afterEach(() => {
  fault.registry = fault.archive = fault.phase = fault.fail = ''; fault.published = undefined; fault.closed = undefined
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); rmSync(root, { recursive: true, force: true })
})

it('moves saved ownership before admitting the original process and permissions under both locks', () => {
  const replacement = proof(), publications: Array<{ phase: string; admitted: boolean }> = []
  fault.published = phase => {
    expect(existsSync(join(data, 'registry.json.lock'))).toBe(true)
    expect(existsSync(join(archive, 'registry.json.lock'))).toBe(true)
    const row = diskRow()
    publications.push({ phase, admitted: nativeTurnAdmitted(row.nativeControl, {
      agentId: saved.agentId, sessionId: saved.sessionId, processKey: replacement.key }) })
    if (phase === 'admission') expect(JSON.parse(readFileSync(fault.archive, 'utf8')).version).toBe(2)
    if (phase === 'pending') expect(row).toMatchObject({ active: false, processIdentity: null, launch: { state: 'held' } })
  }
  const admitted = commit(replacement)
  expect(publications).toEqual([{ phase: 'pending', admitted: false }, { phase: 'transfer', admitted: false }, { phase: 'admission', admitted: true }])
  expect(admitted).toMatchObject({ active: true, launch: { state: 'ready' }, permissionMode: 'full', bypassPermission: true,
    processIdentity: replacement.processIdentity, nativeArchive: { requestId: saved.nativeControl!.rearm!.requestId } })
  expect(store.get(saved.agentId)).toEqual(saved)
  expect(() => store.readNativeControl(saved)).toThrow('live handoff')
  expect(replacement.verifyExecution).toHaveBeenCalled()
  expect(registry.readNativeControl(admitted).intent?.rearm?.replacement?.processKey).toBe(replacement.key)
})

it.each(['pending', 'transfer', 'admission'])('recovers the original handoff after uncertain %s durability', phase => {
  fault.fail = phase
  expect(() => commit()).toThrow(`fixture ${phase} sync failed`)
  expect(registry.byAgent(saved.agentId)?.nativeControl?.rearm?.replacement).toBeUndefined()
  const written = diskRow()
  expect(!!written.nativeControl?.rearm?.replacement).toBe(phase === 'admission')
  fault.fail = ''
  const admitted = commit()
  expect(admitted.nativeControl?.rearm?.replacement?.processKey).toBe(proof().key)
  expect(admitted.permissionMode).toBe('full')
})

it.each(['pending', 'transfer', 'admission'])('a new daemon reconciles a crash after the %s rename', async phase => {
  fault.fail = phase; expect(() => commit()).toThrow()
  fault.fail = ''
  const { StoppedAgentStore } = await import('./stoppedAgents.js')
  store = new StoppedAgentStore(archive); registry = new (registry.constructor as new () => typeof registry)(); registry.load()
  const admitted = commit()
  expect(nativeTurnAdmitted(admitted.nativeControl, { agentId: saved.agentId, sessionId: saved.sessionId, processKey: proof().key })).toBe(true)
  expect(store.nativeTransfer(saved.agentId)?.pendingTarget).toBeDefined()
})

it('confirms an admitted retry without another Registry publication', () => {
  commit(); fault.phases = []
  const admitted = commit()
  expect(admitted.nativeControl?.rearm?.replacement).toBeDefined()
  expect(fault.phases).toEqual([])
})

it('a saved Cancel after pending-route publication prevents ownership transfer and admission', () => {
  const replacement = proof(), original = store.withNativeResume.bind(store)
  let calls = 0
  vi.spyOn(store, 'withNativeResume').mockImplementation((row, apply) => {
    if (++calls === 2) store.commitNativeControl(saved, { ...saved.nativeControl!, rearm: { ...saved.nativeControl!.rearm!, revoked: true },
      cancel: { ...control(saved).cancel, request: { ...control(saved).cancel.request, requestId: 'newer-cancel-request' } } }, fence)
    return original(row, apply)
  })
  expect(() => commit(replacement)).toThrow()
  expect(store.nativeTransfer(saved.agentId)).toBeNull()
  expect(store.get(saved.agentId)?.nativeControl?.rearm?.revoked).toBe(true)
  expect(diskRow().nativeControl?.rearm?.replacement).toBeUndefined()
})

it('a live Cancel after archive transfer prevents original admission', () => {
  fault.fail = 'transfer'; expect(() => commit()).toThrow(); fault.fail = ''
  const peer = new (registry.constructor as new () => typeof registry)(); peer.load()
  const pending = peer.byAgent(saved.agentId)!
  peer.commitNativeControl(pending, { ...pending.nativeControl!, rearm: { ...pending.nativeControl!.rearm!, revoked: true },
    cancel: { ...control(pending).cancel, request: { ...control(pending).cancel.request, requestId: 'newer-cancel-request' } } }, () => {})
  const before = readFileSync(fault.registry, 'utf8')
  expect(() => commit()).toThrow()
  expect(readFileSync(fault.registry, 'utf8')).toBe(before)
  expect(diskRow().nativeControl?.rearm?.revoked).toBe(true)
})

it('never recreates a transferred destination from Registry absence', () => {
  fault.fail = 'transfer'; expect(() => commit()).toThrow(); fault.fail = ''
  writeFileSync(fault.registry, '[]', { mode: 0o600 }); registry.load()
  expect(() => commit()).toThrow('destination is missing')
  expect(rows()).toEqual([])
  expect(() => store.readNativeControl(saved)).toThrow('original native transfer publication')
})

it('retains peer archive admission during an unrelated stale Registry update', () => {
  const otherInput = { agentId: 'unrelated-agent', engine: 'cursor' as const, tmuxPane: '%3', cwd: '/fixture/other',
    processIdentity: { pid: 44, executable: '<cursor>', startMarker: 'unrelated-start' } }
  registry.openProcessAgent(otherInput); registry.register({ ...otherInput, sessionId: 'unrelated-session' })
  const stale = new (registry.constructor as new () => typeof registry)(); stale.load()
  commit()
  expect(stale.setCwd('unrelated-agent', '/fixture/updated')).toBe(true)
  expect(rows().find(row => row.agentId === 'unrelated-agent')?.cwd).toBe('/fixture/updated')
  expect(diskRow().nativeArchive).toEqual(registry.byAgent(saved.agentId)?.nativeArchive)
  expect(stale.byAgent(saved.agentId)?.nativeArchive).toEqual(diskRow().nativeArchive)
})

it('rejects equal bytes in another inode after an uncertain archive publication', () => {
  fault.fail = 'transfer'; expect(() => commit()).toThrow(); fault.fail = ''
  const substitute = fault.archive + '.fixture-substitute'
  writeFileSync(substitute, readFileSync(fault.archive), { mode: 0o600 }); renameSync(substitute, fault.archive)
  expect(() => store.readNativeResumeSource(saved)).toThrow('published registry image changed')
  expect(diskRow().nativeControl?.rearm?.replacement).toBeUndefined()
})

function substitute(file: string) {
  const other = file + '.fixture-substitute'
  writeFileSync(other, readFileSync(file), { mode: 0o600 }); renameSync(other, file)
}

it('retains the confirmed archive publisher across its first subsequent inspection', () => {
  const target = store as unknown as { inspectResumeSource: StoppedAgentStore['readNativeResumeSource'] }
  const inspect = target.inspectResumeSource.bind(store)
  let replaced = false
  vi.spyOn(target, 'inspectResumeSource').mockImplementation(input => {
    if (!replaced && fault.phase === 'transfer') { replaced = true; substitute(fault.archive) }
    return inspect(input)
  })
  expect(() => commit()).toThrow('published registry image changed')
  expect(replaced).toBe(true)
  expect(diskRow().nativeControl?.rearm?.replacement).toBeUndefined()
})

it('retains the pending publisher through entry notifications into phase two', () => {
  registry.onEnter = () => { if (fault.phase === 'pending') substitute(fault.registry) }
  expect(() => commit()).toThrow('published registry image changed')
  expect(store.nativeTransfer(saved.agentId)).toBeNull()
  expect(diskRow().nativeControl?.rearm?.replacement).toBeUndefined()
})

it('refuses an equal-byte pending substitute during its sticky uncertain retry', () => {
  fault.fail = 'pending'; expect(() => commit()).toThrow(); fault.fail = ''
  substitute(fault.registry)
  expect(() => commit()).toThrow('published registry image changed')
  expect(store.nativeTransfer(saved.agentId)).toBeNull()
  expect(registry.byAgent(saved.agentId)).toBeUndefined()
})

it.each(['read', 'control', 'save', 'patch', 'begin', 'finish', 'remove', 'supersede'])('uncertain transfer blocks %s even if valid old saved bytes return', operation => {
  const before = readFileSync(fault.archive, 'utf8')
  fault.fail = 'transfer'; expect(() => commit()).toThrow(); fault.fail = ''
  writeFileSync(fault.archive, before, { mode: 0o600 })
  const run = () => {
    if (operation === 'read') return store.readNativeControl(saved)
    if (operation === 'control') return store.commitNativeControl(saved, saved.nativeControl!, fence)
    if (operation === 'save') return store.save(saved)
    if (operation === 'patch') return store.patch(saved.agentId, { cwd: '/fixture/changed' })
    if (operation === 'begin') return store.beginResume(saved.agentId)
    if (operation === 'finish') return store.finishResume(saved.agentId, undefined, fence)
    if (operation === 'supersede') return store.supersede(saved.agentId)
    return store.remove(saved.agentId)
  }
  expect(run).toThrow('original native transfer publication')
  expect(readFileSync(fault.archive, 'utf8')).toBe(before)
})

it.each(['cancel', 'rebind', 'process'])('a final admission guard cannot overwrite a local %s', change => {
  const replacement = proof()
  let closes = 0, armed = false, changed = false
  fault.closed = path => { if (path === data && fault.phase === 'admission' && ++closes === 2) armed = true }
  replacement.current = vi.fn(() => {
    if (!armed || changed) return
    changed = true
    const live = registry.byAgent(saved.agentId)!
    if (change === 'cancel') live.nativeControl = { ...live.nativeControl!, rearm: { ...live.nativeControl!.rearm!, revoked: true } }
    if (change === 'rebind') live.sessionId = 'different-session'
    if (change === 'process') live.processIdentity = { pid: 99, executable: '<cursor>', startMarker: 'different-process' }
  })
  expect(() => commit(replacement)).toThrow('changed before admission')
  expect(changed).toBe(true)
  expect(registry.byAgent(saved.agentId)?.nativeControl?.rearm?.replacement).toBeUndefined()
  expect(() => registry.readNativeControl(registry.byAgent(saved.agentId)!)).toThrow()
})

it('checks absent ownership after the final pending-publication guard', () => {
  const replacement = proof(), foreign = { ...saved, tmuxPane: '%9', runtimes: [{ backend: 'tmux' as const, paneId: '%9' }], primaryRuntimeKey: 'tmux\0%9' }
  let closes = 0, armed = false, changed = false
  fault.closed = path => { if (path === data && fault.phase === 'pending' && ++closes === 2) armed = true }
  replacement.current = vi.fn(() => {
    if (!armed || changed) return
    changed = true
    ;(registry as unknown as { index(row: RegisteredSession): void }).index(foreign)
  })
  expect(() => commit(replacement)).toThrow('another live owner')
  expect(changed).toBe(true); expect(registry.byAgent(saved.agentId)).toEqual(foreign)
  expect(store.nativeTransfer(saved.agentId)).toBeNull()
})

it.each(['request', 'target', 'control', 'pane', 'process'])('rejects a mismatched %s proof before creating a live destination', change => {
  const replacement = proof()
  if (change === 'request') (replacement.source as { requestFingerprint: string }).requestFingerprint = 'a'.repeat(64)
  if (change === 'target') (replacement.source as { target: string }).target = 'a'.repeat(64)
  if (change === 'control') (replacement.source as { controlFingerprint: string }).controlFingerprint = 'a'.repeat(64)
  if (change === 'pane') (replacement as { pane: string }).pane = 'unsafe'
  if (change === 'process') (replacement.processIdentity as { pid: number }).pid = 99
  expect(() => commit(replacement)).toThrow()
  expect(rows()).toEqual([]); expect(store.nativeTransfer(saved.agentId)).toBeNull()
})
