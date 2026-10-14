import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentCreationReceipts, creationFingerprint } from './agentCreationReceipt.js'
import { nativeRearmRequest, nativeTurnAdmitted, nativeTurnTarget, type NativeTurnIntent } from './nativeTurnIntent.js'
import type { RegisteredSession } from './registry.js'
import type { StoppedAgentStore } from './stoppedAgents.js'
import type { NativeArchiveStopProof } from './nativeArchive.js'
import type { NativeRearmReplacementProof } from '../engines/kit/nativeRearmProof.js'
import { createNativeRearm, type NativeRearmDeps } from '../core/agents/nativeRearm.js'
import { createNativeRearmRecovery, type NativeRearmRecoveryDeps } from '../core/agents/nativeRearmRecovery.js'

const fault = vi.hoisted(() => ({ registry: '', archive: '', phase: '', fail: '',
  published: undefined as ((phase: string) => void) | undefined, opening: undefined as ((path: string) => void) | undefined, phases: [] as string[], closed: undefined as ((path: string) => void) | undefined }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  const paths = new Map<number, string>()
  return { ...actual, openSync: (...args: Parameters<typeof actual.openSync>) => {
    fault.opening?.(String(args[0]))
    const fd = actual.openSync(...args); paths.set(fd, String(args[0])); return fd
  }, closeSync: (fd: number) => {
    const path = paths.get(fd) ?? ''; paths.delete(fd); actual.closeSync(fd); fault.closed?.(path)
  }, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    actual.renameSync(...args)
    const path = String(args[1])
    if (path !== fault.registry && path !== fault.archive) return
    const raw = JSON.parse(actual.readFileSync(path, 'utf8'))
    fault.phase = path === fault.archive ? raw.version === 2 ? 'transfer' : raw.version === 3 ? raw.nativeReturn.phase === 'returning' ? 'checkpoint' : 'saved' : 'initial'
      : !raw.length ? 'cleanup' : raw.find((row: RegisteredSession) => row.agentId === 'saved-agent')?.nativeRetirement ? 'retirement'
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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-archive-return-'))); data = join(root, 'data'); archive = join(data, 'stopped-agents')
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
  fault.phase = ''; fault.fail = ''; fault.phases = []; fault.published = undefined; fault.opening = undefined; fault.closed = undefined
})
afterEach(() => {
  fault.registry = fault.archive = fault.phase = fault.fail = ''; fault.published = undefined; fault.opening = undefined; fault.closed = undefined
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); rmSync(root, { recursive: true, force: true })
})


function visit() {
  const admitted = commit()
  const intent = control(admitted)
  const cancelled = registry.commitNativeControl(admitted, { ...intent,
    cancel: { ...intent.cancel, request: { ...intent.cancel.request, requestId: 'stop-cancel-request' } } }, () => {})
  fault.phases = []; fault.phase = ''
  return cancelled
}
function stopProof(row: RegisteredSession): NativeArchiveStopProof {
  return { source: { target: nativeTurnTarget(row), controlFingerprint: creationFingerprint(row.nativeControl) },
    verifyStopped: vi.fn(), current: vi.fn() }
}
const checkpoint = (row: RegisteredSession) => registry.checkpointNativeArchive(row, store, () => {})
const retire = (row: RegisteredSession, stopped = stopProof(row)) => registry.retireNativeArchive(row, stopped, store, () => {})
const finish = (row: RegisteredSession) => registry.finishNativeArchiveRetirement(row, store, () => {})
async function restart() {
  const { StoppedAgentStore } = await import('./stoppedAgents.js')
  store = new StoppedAgentStore(archive); registry = new (registry.constructor as new () => typeof registry)(); registry.load()
}

async function reserveMarker(dispatch = true, permissionMode: 'full' | 'ask' | undefined = 'full', omitPermission = false) {
  const receipts = new AgentCreationReceipts(join(root, 'receipts')), request = { ...nativeRearmRequest(saved.nativeControl!)! }
  if (omitPermission) delete request.permissionMode
  else request.permissionMode = permissionMode
  const fingerprint = creationFingerprint({ kind: 'native-rearm', agentId: saved.agentId, operation: 'resume', source: 'saved',
    ...(omitPermission ? {} : { permissionMode }) })
  let marker!: ReturnType<StoppedAgentStore['reserveNativeResume']>
  await receipts.runIntent(saved.nativeControl!.rearm!.requestId, fingerprint, request, { service: 'native', detail: 'Preparing' }, async (_value, owner) => {
    const current = () => { if (!owner.current()) throw Error('original receipt revoked') }
    marker = store.reserveNativeResume(saved, { verify: current, current })
    return dispatch ? async () => {
      receipts.recordNativeRelaunchProcess(marker.link.requestId, { fingerprint, request },
        { boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', pid: 43, birth: '123456' }, fence)
      return { state: 'unconfirmed' }
    } : null
  })
  return { receipts, marker, confirm: () => receipts.confirmNativeRelaunch(marker.link.requestId, { fingerprint, request,
    outcome: { state: 'created', agentId: saved.agentId, resumed: true } }, fence) }
}

it.each(['initial', 'pending', 'transfer', 'admission'])('the recovery controller confirms the original saved Resume at %s publication', async phase => {
  const p = await reserveMarker(), original = structuredClone(saved), reads = vi.fn()
  const observe = ((_row, _request, fence) => {
    reads()
    const native = proof()
    const value = { ...native, verify() { native.verify(); fence.verify() },
      verifyExecution() { fence.current() }, verifyConfirmation() { fence.current() }, current() { fence.current() } }
    return Object.assign(Promise.resolve(value), { settled: Promise.resolve() })
  }) as NativeRearmRecoveryDeps['proof']
  Object.assign(observe, { recover: observe, recoverSaved: observe })
  const recovering = (receipts = p.receipts) => createNativeRearmRecovery({ registry, saved: store, receipts, proof: observe, held: () => {} })
  if (phase === 'initial') {
    expect(await recovering().recover(original)).toMatchObject({ state: 'created', agentId: original.agentId, resumed: true })
    expect(registry.byAgent(original.agentId)?.nativeAllocation?.receipts).toHaveLength(1)
    expect(p.receipts.status(original.nativeControl!.rearm!.requestId).state).toBe('created')
    return
  }
  fault.fail = phase
  expect(await recovering().recover(original)).toMatchObject({ state: 'pending' })
  expect(p.receipts.status(original.nativeControl!.rearm!.requestId).state).toBe('unconfirmed')
  fault.fail = ''
  await restart()
  const receipts = new AgentCreationReceipts(join(root, 'receipts'))
  expect(await recovering(receipts).recover(original)).toMatchObject({ state: 'created', agentId: original.agentId, resumed: true })
  expect(registry.byAgent(original.agentId)).toMatchObject({ active: true, nativeArchive: p.marker.link,
    nativeControl: { rearm: { replacement: { sessionId: original.sessionId } } } })
  expect(store.nativeTransfer(original.agentId)?.link).toEqual(p.marker.link)
  const readCount = reads.mock.calls.length
  expect(await recovering(receipts).recover(original)).toMatchObject({ state: 'created' })
  expect(reads).toHaveBeenCalledTimes(readCount)
})

it('finishes the original confirmed Resume marker after later live Cancel without probing or launching again', async () => {
  const p = await reserveMarker(), live = commit(); p.confirm()
  const intent = control(live)
  const stopped = registry.commitNativeControl(live, { ...intent,
    cancel: { ...intent.cancel, request: { ...intent.cancel.request, requestId: 'later-live-cancel-request' } } }, () => {})
  const authority = { verify: registry.readNativeControl(stopped).verify, current: () => {} }
  const completion = p.receipts.readNativeResumeCleanup(p.marker.link)
  expect(() => store.finishNativeResume(p.marker.link, authority, completion)).not.toThrow()
  expect(existsSync(join(archive, `${saved.agentId}.resume`))).toBe(false)
  expect(p.receipts.status(p.marker.link.requestId)).toMatchObject({ state: 'created', resumed: true })
  expect(registry.byAgent(saved.agentId)?.nativeControl).toEqual(stopped.nativeControl)
})

it.each(['omitted', 'different'])('preserves the marker when a created receipt has %s original permissions', async mode => {
  const p = await reserveMarker(true, 'ask', mode === 'omitted'); commit(); p.confirm()
  const file = join(archive, `${saved.agentId}.resume`), before = readFileSync(file, 'utf8'), archived = readFileSync(fault.archive, 'utf8')
  const completion = p.receipts.readNativeResumeCleanup(p.marker.link)
  expect(completion.kind).toBe('created')
  expect(() => store.finishNativeResume(p.marker.link, fence, completion)).toThrow('account for the original')
  expect(readFileSync(file, 'utf8')).toBe(before); expect(readFileSync(fault.archive, 'utf8')).toBe(archived)
})

it('does not clear an unreadable marker without its saved owner', () => {
  const file = join(archive, `${saved.agentId}.resume`)
  writeFileSync(file, '{', { mode: 0o600 }); rmSync(fault.archive)
  expect(() => store.finishResume(saved.agentId)).toThrow()
  expect(readFileSync(file, 'utf8')).toBe('{')
})

it('cleans a revoked undispatched marker before clearing its original saved reservation', async () => {
  const p = await reserveMarker(false)
  p.receipts.cancelIntent(p.marker.link.requestId)
  const cancelled = store.commitNativeControl(saved, { ...saved.nativeControl!,
    cancel: { ...saved.nativeControl!.cancel, request: { ...saved.nativeControl!.cancel.request, requestId: 'early-cancel-request' } },
    rearm: { ...saved.nativeControl!.rearm!, revoked: true } }, fence)
  const absence = registry.readNativeAbsence(saved.agentId)
  const completion = p.receipts.readNativeResumeCleanup(p.marker.link)
  expect(() => store.finishNativeResume(p.marker.link, { verify: absence.verify, current: () => {} }, completion)).not.toThrow()
  expect(store.get(saved.agentId)?.nativeControl).toEqual(cancelled.nativeControl)
  expect(existsSync(join(archive, `${saved.agentId}.resume`))).toBe(false)
  expect(() => p.marker.verify()).toThrow()
  const cleared = store.commitNativeControl(cancelled, { version: 1, cancel: cancelled.nativeControl!.cancel }, fence)
  expect(cleared.nativeControl?.rearm).toBeUndefined()
})

it('a closed visit accounts for marker cleanup even without a created receipt', async () => {
  const p = await reserveMarker(), stopped = visit(); checkpoint(stopped); finish(retire(stopped))
  expect(p.receipts.status(p.marker.link.requestId)).toEqual({ state: 'unconfirmed' })
  const absence = registry.readNativeAbsence(saved.agentId)
  expect(() => store.finishNativeResume(p.marker.link, { verify: absence.verify, current: () => {} })).not.toThrow()
  expect(existsSync(join(archive, `${saved.agentId}.resume`))).toBe(false)
})

it('cannot clear a native marker using legacy cleanup, generic authority or a matching token', async () => {
  const p = await reserveMarker(false), file = join(archive, `${saved.agentId}.resume`), before = readFileSync(file, 'utf8')
  for (const token of [undefined, p.marker.link.launchToken]) {
    expect(() => store.finishResume(saved.agentId, token, fence)).toThrow('original receipt and archive link')
    expect(readFileSync(file, 'utf8')).toBe(before)
  }
  expect(() => store.finishNativeResume(p.marker.link, fence)).toThrow('account for the original')
})

it('keeps confirmed creation successful when marker cleanup fails and retries metadata only', async () => {
  const p = await reserveMarker(); commit(); p.confirm()
  const completion = p.receipts.readNativeResumeCleanup(p.marker.link)
  const unavailable = { verify: () => { throw Error('live association unavailable') }, current: () => {} }
  expect(() => store.finishNativeResume(p.marker.link, unavailable, completion)).toThrow('live association unavailable')
  expect(existsSync(join(archive, `${saved.agentId}.resume`))).toBe(true)
  expect(p.receipts.status(p.marker.link.requestId)).toMatchObject({ state: 'created' })
  expect(() => store.finishNativeResume(p.marker.link, fence, completion)).not.toThrow()
  expect(() => store.finishNativeResume(p.marker.link, fence, completion)).not.toThrow()
})

it('does not use a prior closed visit to clean another request with the same launch token', async () => {
  const p = await reserveMarker(), row = visit(); checkpoint(row); finish(retire(row))
  const before = readFileSync(join(archive, `${saved.agentId}.resume`), 'utf8')
  expect(() => store.finishNativeResume({ ...p.marker.link, requestId: 'different-resume-request' }, fence)).toThrow()
  expect(readFileSync(join(archive, `${saved.agentId}.resume`), 'utf8')).toBe(before)
})

it('checkpoints before retirement, returns saved ownership, then removes the live route', () => {
  const row = visit(), stopped = stopProof(row), publications: string[] = []
  fault.published = phase => {
    expect(existsSync(join(data, 'registry.json.lock'))).toBe(true)
    expect(existsSync(join(archive, 'registry.json.lock'))).toBe(true)
    publications.push(phase)
    const live = diskRow()
    if (phase !== 'cleanup') expect(live).toBeDefined()
    if (phase === 'checkpoint' || phase === 'retirement') expect(() => store.readNativeControl(store.get(row.agentId)!)).toThrow('live handoff')
    if (phase === 'retirement') expect(stopped.verifyStopped).toHaveBeenCalled()
    if (phase === 'saved' || phase === 'cleanup') expect(store.readNativeControl(store.get(row.agentId)!).intent).toEqual(row.nativeControl)
    if (live) expect(nativeTurnAdmitted(live.nativeControl, { agentId: row.agentId, sessionId: row.sessionId, processKey: 'fixture-boot\0cursor\0' + 43 + '\0precise-birth' })).toBe(false)
  }
  const role = checkpoint(row), retired = retire(row, stopped)
  expect(retired.nativeRetirement).toEqual(role)
  let result!: RegisteredSession
  expect(() => { result = finish(retired) }).not.toThrow()
  expect(publications).toEqual(['checkpoint', 'retirement', 'saved', 'cleanup'])
  expect(role).toMatchObject({ phase: 'returning', sourceTarget: nativeTurnTarget(row) })
  expect(retired).toMatchObject({ nativeRetirement: role, active: false, processIdentity: null, launch: { state: 'held', service: 'native' } })
  expect(registry.byAgent(row.agentId)).toBeUndefined(); expect(rows()).toEqual([])
  expect(result).toMatchObject({ sessionId: row.sessionId, processIdentity: row.processIdentity, nativeControl: row.nativeControl })
  expect(result.nativeArchive).toBeUndefined(); expect(result.nativeRetirement).toBeUndefined()
  expect(store.nativeReturn(row.agentId)).toEqual({ ...role, phase: 'saved' })
})

it('requires a checkpoint and exact stopped-process proof before retirement', () => {
  const row = visit()
  expect(() => retire(row)).toThrow('checkpoint')
  checkpoint(row)
  const stopped = stopProof(row)
  stopped.verifyStopped = () => { throw Error('original allocation remains unknown') }
  expect(() => retire(row, stopped)).toThrow('allocation remains unknown')
  expect(diskRow().nativeRetirement).toBeUndefined()
  expect(store.nativeReturn(row.agentId)?.phase).toBe('returning')
  expect(() => retire(row, stopped)).toThrow('fresh stopped-process evidence')
})

it('rechecks stopped-process evidence after retirement publication', () => {
  const row = visit(); checkpoint(row)
  const stopped = stopProof(row)
  stopped.verifyStopped = () => { if (fault.phase === 'retirement') throw Error('stopped evidence was revoked') }
  expect(() => retire(row, stopped)).toThrow('stopped evidence was revoked')
  expect(registry.byAgent(row.agentId)?.nativeRetirement).toBeUndefined()
  expect(store.nativeReturn(row.agentId)?.phase).toBe('returning')
})

it.each(['target', 'controlFingerprint'] as const)('rejects a stopped proof for another %s', field => {
  const row = visit(); checkpoint(row)
  const stopped = { ...stopProof(row), source: { ...stopProof(row).source, [field]: 'a'.repeat(64) } }
  expect(() => retire(row, stopped)).toThrow('different native visit')
  expect(diskRow().nativeRetirement).toBeUndefined()
})

it('a replacement still admitting hooks cannot be checkpointed as stopped', () => {
  const row = commit()
  expect(() => checkpoint(row)).toThrow('cancelled native archive owner')
  expect(store.nativeReturn(row.agentId)).toBeNull()
})

it.each(['checkpoint', 'retirement', 'saved', 'cleanup'])('recovers the original %s after uncertain durability', phase => {
  const row = visit()
  if (phase !== 'checkpoint') checkpoint(row)
  let retired: RegisteredSession | undefined
  if (phase === 'saved' || phase === 'cleanup') retired = retire(row)
  fault.phase = ''; fault.fail = phase
  expect(() => phase === 'checkpoint' ? checkpoint(row) : phase === 'retirement' ? retire(row) : finish(retired!)).toThrow(`fixture ${phase} sync failed`)
  fault.fail = ''; fault.phase = ''
  if (phase === 'checkpoint') checkpoint(row)
  if (!retired) retired = retire(row)
  const result = finish(retired)
  expect(registry.byAgent(row.agentId)).toBeUndefined()
  expect(store.readNativeControl(result).intent).toEqual(row.nativeControl)
})

it.each(['checkpoint', 'retirement', 'saved', 'cleanup'])('a new daemon recovers a crash after the %s rename', async phase => {
  const row = visit()
  if (phase !== 'checkpoint') checkpoint(row)
  let retired: RegisteredSession | undefined
  if (phase === 'saved' || phase === 'cleanup') retired = retire(row)
  fault.phase = ''; fault.fail = phase
  expect(() => phase === 'checkpoint' ? checkpoint(row) : phase === 'retirement' ? retire(row) : finish(retired!)).toThrow()
  fault.fail = ''; fault.phase = ''; await restart()
  const current = registry.byAgent(row.agentId)
  if (current) {
    if (!current.nativeRetirement) checkpoint(current)
    finish(current.nativeRetirement ? current : retire(current))
  }
  expect(registry.byAgent(row.agentId)).toBeUndefined()
  expect(store.nativeReturn(row.agentId)?.phase).toBe('saved')
  expect(store.readNativeControl(store.get(row.agentId)!).intent).toEqual(row.nativeControl)
})

it('Registry absence cannot return live-owned archive control', async () => {
  const row = visit(); checkpoint(row)
  writeFileSync(fault.registry, '[]', { mode: 0o600 }); await restart()
  expect(() => store.readNativeControl(store.get(row.agentId)!)).toThrow('live handoff')
  expect(() => retire(row)).toThrow('owner changed')
  expect(() => finish({ ...row, nativeRetirement: store.nativeReturn(row.agentId)! })).toThrow()
  expect(store.nativeReturn(row.agentId)?.phase).toBe('returning')
})

it('a newer live Cancel invalidates the checkpoint until it is saved again', () => {
  const row = visit(), reserved = registry.commitNativeControl(row, { ...row.nativeControl!, rearm: { sourceProcess: { processKey: row.nativeControl!.cancel.processKey },
    agentId: row.agentId, requestId: 'next-restart-request', launchToken: 'next-restart-token', source: 'live', operation: 'restart', target: nativeTurnTarget(row),
  } }, () => {})
  const revoked = registry.commitNativeControl(reserved, { ...control(reserved), cancel: { ...control(reserved).cancel,
    request: { ...control(reserved).cancel.request, requestId: 'next-cancel-request' } }, rearm: { ...reserved.nativeControl!.rearm!, revoked: true } }, () => {})
  checkpoint(revoked)
  const newer = registry.commitNativeControl(revoked, { ...revoked.nativeControl!, cancel: { ...revoked.nativeControl!.cancel,
    request: { ...revoked.nativeControl!.cancel.request, requestId: 'newer-cancel-request' } } }, () => {})
  expect(() => retire(revoked)).toThrow('owner changed')
  expect(() => retire(newer)).toThrow('checkpoint')
  checkpoint(newer)
  const result = finish(retire(newer))
  expect(result.nativeControl!.cancel.request.requestId).toBe('newer-cancel-request')
  expect(result.nativeControl!.rearm?.revoked).toBe(true)
})

it('retirement blocks live control; saved edits survive uncertain cleanup without checkpoint replay', () => {
  const row = visit(); checkpoint(row); const retired = retire(row)
  expect(() => registry.commitNativeControl(retired, { ...retired.nativeControl!, rearm: {
    agentId: row.agentId, requestId: 'retired-restart-request', launchToken: 'retired-restart-token', operation: 'restart', source: 'live', target: nativeTurnTarget(retired),
  } }, () => {})).toThrow('transition')
  fault.fail = 'cleanup'; expect(() => finish(retired)).toThrow(); fault.fail = ''; fault.phase = ''
  const prior = store.get(row.agentId)!
  const reserved = store.commitNativeControl(prior, { ...prior.nativeControl!, rearm: { sourceProcess: { processKey: prior.nativeControl!.cancel.processKey },
    agentId: row.agentId, requestId: 'next-resume-request', launchToken: 'next-resume-token', operation: 'resume', source: 'saved', target: nativeTurnTarget(prior),
  } }, fence)
  const cancelled = store.commitNativeControl(reserved, { ...control(reserved), cancel: { ...control(reserved).cancel,
    request: { ...control(reserved).cancel.request, requestId: 'saved-cancel-request' } }, rearm: { ...reserved.nativeControl!.rearm!, revoked: true } }, fence)
  store.patch(row.agentId, { cwd: '/fixture/new-folder' })
  const result = finish(retired)
  expect(result.cwd).toBe('/fixture/new-folder'); expect(result.nativeControl).toEqual(cancelled.nativeControl)
  expect(store.nativeReturn(row.agentId)?.phase).toBe('saved')
})

it.each(['checkpoint', 'retirement', 'saved', 'cleanup'])('rejects an equal-byte substitute for the %s publisher', phase => {
  const row = visit()
  if (phase !== 'checkpoint') checkpoint(row)
  let retired: RegisteredSession | undefined
  if (phase === 'saved' || phase === 'cleanup') retired = retire(row)
  let replaced = false
  fault.published = published => {
    if (published !== phase || replaced) return
    replaced = true
    const file = phase === 'checkpoint' || phase === 'saved' ? fault.archive : fault.registry
    const bytes = readFileSync(file, 'utf8')
    renameSync(file, `${file}.fixture-original`); writeFileSync(file, bytes, { mode: 0o600 })
  }
  expect(() => phase === 'checkpoint' ? checkpoint(row) : phase === 'retirement' ? retire(row) : finish(retired!)).toThrow()
  expect(replaced).toBe(true)
  fault.published = undefined
  expect(() => phase === 'checkpoint' ? checkpoint(row) : phase === 'retirement' ? retire(row) : finish(retired!)).toThrow()
  expect(registry.byAgent(row.agentId)).toBeDefined()
})

it('ordinary mutation cannot reopen or alter a retired route in memory', () => {
  const row = visit(); checkpoint(row); const retired = retire(row), before = structuredClone(retired)
  expect(registry.revalidateBinding(row.agentId)).toBeNull()
  expect(registry.setActive(row.agentId, true)).toBe(false)
  expect(registry.updateRuntimes(row.agentId, [{ backend: 'tmux', paneId: '%9' }])).toBe(false)
  expect(registry.setLaunch(row.agentId, { state: 'ready' })).toBeNull()
  expect(registry.setCwd(row.agentId, '/fixture/another')).toBe(false)
  expect(registry.updateProcessIdentity(row.agentId, row.processIdentity!)).toBe(false)
  expect(registry.clearProcessIdentity(row.agentId)).toBe(false)
  expect(registry.setBypassPermission(row.agentId, false)).toBe(false)
  expect(registry.setPermissionMode(row.agentId, 'plan')).toBe(false)
  expect(registry.setClosePlan(row.agentId, null)).toBeNull()
  expect(registry.register({ engine: 'cursor', sessionId: row.sessionId, tmuxPane: row.tmuxPane, cwd: row.cwd ?? undefined })).toBeNull()
  expect(registry.byAgent(row.agentId)).toEqual(before)
  expect(finish(retired).sessionId).toBe(row.sessionId)
})

it('a cold load keeps the exact retired checkpoint without transcript repair', async () => {
  const row = visit(); checkpoint(row); const retired = retire(row)
  await restart()
  expect(registry.byAgent(row.agentId)).toEqual(retired)
  expect(finish(registry.byAgent(row.agentId)!).sessionId).toBe(row.sessionId)
})

it.each(['same-route', 'same-id', 'other-engine'] as const)('discovery cannot reopen a loaded retirement through %s', async change => {
  const row = visit(); checkpoint(row); const retired = retire(row)
  await restart()
  const before = structuredClone(registry.byAgent(row.agentId)!)
  expect(registry.openProcessAgent({ agentId: row.agentId, engine: change === 'other-engine' ? 'codex' : 'cursor',
    tmuxPane: change === 'same-id' ? '%9' : row.tmuxPane,
    processIdentity: { pid: 99, executable: '<cursor>', startMarker: 'different-start' } })).toBeNull()
  expect(registry.byAgent(row.agentId)).toEqual(before)
  expect(registry.byPaneEngine(row.tmuxPane, 'cursor')).toEqual(before)
  expect(finish(retired).sessionId).toBe(row.sessionId)
})

it.each(['retirement', 'cleanup'])('the final %s guard rechecks ownership after the caller fence', phase => {
  const row = visit(); checkpoint(row)
  const retired = phase === 'cleanup' ? retire(row) : undefined
  let closes = 0, armed = false, changed = false
  fault.closed = path => { if (path === data && fault.phase === phase && ++closes === 2) armed = true }
  const current = () => {
    if (armed && !changed) {
      changed = true
      registry.byAgent(row.agentId)!.cwd = '/fixture/new-owner'
    }
  }
  expect(() => phase === 'retirement' ? registry.retireNativeArchive(row, stopProof(row), store, current)
    : registry.finishNativeArchiveRetirement(retired!, store, current)).toThrow('owner changed')
  expect(changed).toBe(true)
  expect(registry.byAgent(row.agentId)?.cwd).toBe('/fixture/new-owner')
  expect(() => registry.readNativeControl(registry.byAgent(row.agentId)!)).toThrow()
})

it.each(['checkpoint', 'saved'])('retains the %s publisher through its first subsequent inspection', phase => {
  const row = visit()
  let retired: RegisteredSession | undefined
  if (phase === 'saved') { checkpoint(row); retired = retire(row) }
  const target = store as unknown as { inspectReturnSource(input: RegisteredSession): unknown }
  const inspect = target.inspectReturnSource.bind(store)
  let changed = false
  vi.spyOn(target, 'inspectReturnSource').mockImplementation(input => {
    if (fault.phase === phase && !changed) {
      changed = true
      const other = fault.archive + '.fixture-copy'
      writeFileSync(other, readFileSync(fault.archive), { mode: 0o600 }); renameSync(other, fault.archive)
    }
    return inspect(input)
  })
  expect(() => phase === 'checkpoint' ? checkpoint(row) : finish(retired!)).toThrow()
  expect(changed).toBe(true)
  expect(registry.byAgent(row.agentId)).toBeDefined()
})

it('retirement cleanup cannot confirm an uncertain saved Cancel on its behalf', () => {
  const row = visit(); checkpoint(row); const retired = retire(row)
  fault.fail = 'cleanup'; expect(() => finish(retired)).toThrow(); fault.fail = ''; fault.phase = ''
  const prior = store.get(row.agentId)!, next: NativeTurnIntent = { ...prior.nativeControl!, rearm: { sourceProcess: { processKey: prior.nativeControl!.cancel.processKey },
    agentId: row.agentId, requestId: 'next-resume-request', launchToken: 'next-resume-token', operation: 'resume', source: 'saved', target: nativeTurnTarget(prior),
  } }
  fault.fail = 'saved'; expect(() => store.commitNativeControl(prior, next, fence)).toThrow(); fault.fail = ''; fault.phase = ''
  expect(() => finish(retired)).toThrow('original saved native control publication')
  store.commitNativeControl(prior, next, fence)
  expect(finish(retired).nativeControl).toEqual(next)
})

it('returns two successive visits without letting the first visit change the second', () => {
  const first = visit(); checkpoint(first); const retiredFirst = retire(first), finishedFirst = finish(retiredFirst)
  const firstRole = store.nativeReturn(first.agentId)!
  saved = store.commitNativeControl(finishedFirst, { ...finishedFirst.nativeControl!, rearm: { sourceProcess: { processKey: finishedFirst.nativeControl!.cancel.processKey },
    agentId: first.agentId, requestId: 'successor-resume-request', launchToken: 'successor-launch-token',
    operation: 'resume', source: 'saved', permissionMode: 'full', target: nativeTurnTarget(finishedFirst),
  } }, fence)
  const replacement = { ...proof(), pane: '%3', key: 'fixture-boot\0cursor\0' + 48 + '\0successor-birth',
    processIdentity: { pid: 48, executable: '<cursor>', startMarker: 'successor-start', startTicks: 48 } }
  const admitted = commit(replacement)
  expect(admitted.nativeArchive).not.toEqual(firstRole.link)
  expect(store.nativeReturn(first.agentId)).toBeNull()
  const before = readFileSync(fault.registry, 'utf8'), savedBefore = readFileSync(fault.archive, 'utf8')
  expect(() => checkpoint(first)).toThrow('owner changed')
  expect(() => retire(first)).toThrow('owner changed')
  expect(() => finish(retiredFirst)).toThrow('owner changed')
  expect(() => store.withNativeReturn(retiredFirst, archive => archive.complete(firstRole,
    { verifyBefore: () => {}, verifyAfter: () => {}, current: () => {} }))).toThrow('visit changed')
  expect(() => registry.commitNativeControl(retiredFirst, retiredFirst.nativeControl!, () => {})).toThrow('transition')
  expect(readFileSync(fault.registry, 'utf8')).toBe(before)
  expect(readFileSync(fault.archive, 'utf8')).toBe(savedBefore)
  const intent = control(admitted)
  const second = registry.commitNativeControl(admitted, { ...intent, cancel: { ...intent.cancel,
    request: { ...intent.cancel.request, requestId: 'successor-cancel-request' } } }, () => {})
  checkpoint(second)
  const final = finish(retire(second))
  expect(final.nativeControl!.cancel.request.requestId).toBe('successor-cancel-request')
  expect(final.processIdentity).toEqual(replacement.processIdentity)
  expect(store.nativeReturn(first.agentId)?.link).toEqual(admitted.nativeArchive)
  expect(store.readNativeControl(final).intent).toEqual(second.nativeControl)
  expect(rows()).toEqual([])
})

async function pendingCancel() {
  fault.fail = 'pending'; expect(() => commit()).toThrow(); fault.fail = ''; fault.phase = ''
  await restart()
  const pending = structuredClone(registry.byAgent(saved.agentId)!), original = store.get(saved.agentId)!
  const cancelled = store.commitNativeControl(original, { ...original.nativeControl!,
    cancel: { ...original.nativeControl!.cancel, target: nativeTurnTarget(original),
      request: { ...original.nativeControl!.cancel.request, requestId: 'saved-cancel-during-resume' } },
    rearm: { ...original.nativeControl!.rearm!, revoked: true } }, fence)
  fault.phases = []; fault.phase = ''
  return { pending, cancelled }
}
const abortPending = (pending: RegisteredSession, cancelled: RegisteredSession, proof = stopProof(pending)) =>
  registry.retirePendingNativeArchive(pending, cancelled, proof, store, () => {})

it('retires a cancelled pending Resume while the saved store continuously owns control', async () => {
  const { pending, cancelled } = await pendingCancel(), before = readFileSync(fault.archive, 'utf8')
  expect(() => commit()).toThrow()
  fault.published = phase => {
    expect(store.readNativeControl(store.get(saved.agentId)!).intent).toEqual(cancelled.nativeControl)
    if (phase === 'retirement') expect(readFileSync(fault.archive, 'utf8')).toBe(before)
  }
  const retired = abortPending(pending, cancelled)
  expect(retired.nativeRetirement?.pendingAbort).toEqual({ kind: 'untransferred', priorRole: creationFingerprint(null),
    pendingControl: creationFingerprint(pending.nativeControl), requestFingerprint: creationFingerprint(nativeRearmRequest(pending.nativeControl!)) })
  expect(retired.nativeControl).toEqual(cancelled.nativeControl)
  expect(store.nativeTransfer(saved.agentId)).toBeNull(); expect(store.nativeReturn(saved.agentId)).toBeNull()
  let result!: RegisteredSession
  expect(() => { result = finish(retired) }).not.toThrow()
  expect(result).toEqual(cancelled)
  expect(fault.phases).toEqual(['retirement', 'saved', 'cleanup'])
  expect(rows()).toEqual([])
  expect(store.nativeReturn(saved.agentId)).toMatchObject({ phase: 'saved', link: pending.nativeArchive })
  expect(store.nativeReturn(saved.agentId)).not.toHaveProperty('pendingAbort')
})

it.each(['retirement', 'saved', 'cleanup'])('cold-recovers a pending abort after %s confirmation fails', async phase => {
  const { pending, cancelled } = await pendingCancel()
  fault.fail = phase
  let retired: RegisteredSession | undefined
  expect(() => { retired = abortPending(pending, cancelled); finish(retired) }).toThrow()
  fault.fail = ''; fault.phase = ''
  await restart()
  const remaining = registry.byAgent(pending.agentId)
  if (remaining) expect(finish(remaining).nativeControl).toEqual(cancelled.nativeControl)
  expect(store.readNativeControl(store.get(saved.agentId)!).intent).toEqual(cancelled.nativeControl)
  expect(store.nativeReturn(saved.agentId)?.phase).toBe('saved')
  expect(rows()).toEqual([])
})

it('confirms only the original uncertain pending retirement on retry', async () => {
  const { pending, cancelled } = await pendingCancel()
  fault.fail = 'retirement'; expect(() => abortPending(pending, cancelled)).toThrow(); fault.fail = ''; fault.phase = ''
  expect(registry.byAgent(pending.agentId)?.nativeRetirement).toBeUndefined()
  expect(finish(abortPending(pending, cancelled))).toEqual(cancelled)
  expect(rows()).toEqual([])
})

it.each(['old', 'new'])('confirms uncertain pending retirement after newer saved edits using the %s snapshot', async snapshot => {
  const { pending, cancelled } = await pendingCancel()
  fault.fail = 'retirement'; expect(() => abortPending(pending, cancelled)).toThrow(); fault.fail = ''; fault.phase = ''
  const original = diskRow().nativeRetirement
  const newer = store.commitNativeControl(cancelled, { ...cancelled.nativeControl!, cancel: { ...cancelled.nativeControl!.cancel,
    request: { ...cancelled.nativeControl!.cancel.request, requestId: 'newer-saved-cancel-request' } } }, fence)
  store.patch(newer.agentId, { cwd: '/fixture/later-folder' })
  const edited = store.get(newer.agentId)!, before = readFileSync(fault.archive, 'utf8')
  let retired!: RegisteredSession
  expect(() => { retired = abortPending(pending, snapshot === 'old' ? cancelled : edited) }).not.toThrow()
  expect(retired.nativeRetirement).toEqual(original)
  expect(readFileSync(fault.archive, 'utf8')).toBe(before)
  expect(finish(retired)).toEqual(edited)
  expect(rows()).toEqual([])
})

it.each(['pending', 'retirement'])('a stale core cannot reserve saved Resume over a peer-only %s row', async phase => {
  const stale = new (registry.constructor as new () => typeof registry)(); stale.load()
  const { pending, cancelled } = await pendingCancel()
  if (phase === 'retirement') abortPending(pending, cancelled)
  // Allocation accounting can clear the old R before route cleanup finishes.
  // This grants no permission to miss a peer's remaining durable route.
  const ready = store.commitNativeControl(cancelled, { version: 1, cancel: cancelled.nativeControl!.cancel }, fence)
  const prepare = vi.fn<NativeRearmDeps['prepare']>(async () => async guard => { guard.begin() })
  const controller = createNativeRearm({ registry: stale, saved: store, receipts: new AgentCreationReceipts(join(root, 'receipts')),
    prepare, held: () => {} })
  const before = readFileSync(fault.archive, 'utf8')
  expect(await controller.start({ agentId: ready.agentId, creationId: 'next-saved-resume-request', source: 'saved', operation: 'resume' }))
    .toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('durable live handoff') } })
  expect(stale.byAgent(ready.agentId)).toBeUndefined()
  expect(readFileSync(fault.archive, 'utf8')).toBe(before)
  expect(prepare).not.toHaveBeenCalled()
})

it.each(['preparation', 'effect'])('a stale core retains registry absence through saved %s', async phase => {
  const stale = new (registry.constructor as new () => typeof registry)(); stale.load()
  const physical = vi.fn()
  const publish = () => { fault.fail = 'pending'; expect(() => commit()).toThrow(); fault.fail = ''; fault.phase = '' }
  const prepare = vi.fn<NativeRearmDeps['prepare']>(async () => {
    if (phase === 'preparation') publish()
    return async guard => { if (phase === 'effect') publish(); guard.begin(); physical() }
  })
  const controller = createNativeRearm({ registry: stale, saved: store, receipts: new AgentCreationReceipts(join(root, 'receipts')),
    prepare, held: () => {} })
  expect((await controller.start({ agentId: saved.agentId, creationId: saved.nativeControl!.rearm!.requestId,
    source: 'saved', operation: 'resume', permissionMode: 'full' })).state).toBe(phase === 'effect' ? 'failed' : 'pending')
  expect(stale.byAgent(saved.agentId)).toBeUndefined()
  expect(diskRow().nativeArchive).toBeDefined()
  expect(physical).not.toHaveBeenCalled()
})

it.each(['target', 'control', 'unaccounted'])('rejects a pending abort with %s allocation evidence', async change => {
  const { pending, cancelled } = await pendingCancel(), proof = stopProof(pending), before = readFileSync(fault.registry, 'utf8')
  const source = { ...proof.source, ...(change === 'target' ? { target: 'f'.repeat(64) }
    : change === 'control' ? { controlFingerprint: 'f'.repeat(64) } : {}) }
  if (change === 'unaccounted') proof.verifyStopped = () => { throw Error('original allocation remains unknown') }
  expect(() => abortPending(pending, cancelled, { ...proof, source })).toThrow()
  expect(readFileSync(fault.registry, 'utf8')).toBe(before)
  expect(store.readNativeControl(cancelled).intent).toEqual(cancelled.nativeControl)
})

it.each(['revocation', 'request', 'permission', 'saved-control', 'pending-control', 'target'])('binds pending retirement to exact %s state', async change => {
  const { pending, cancelled } = await pendingCancel(), before = readFileSync(fault.registry, 'utf8')
  let current = structuredClone(cancelled)
  if (change === 'revocation') current.nativeControl = { ...current.nativeControl!, rearm: { ...current.nativeControl!.rearm!, revoked: undefined } }
  if (change === 'request') current.nativeControl = { ...current.nativeControl!, rearm: { ...current.nativeControl!.rearm!, requestId: 'different-resume-request' } }
  if (change === 'permission') current.nativeControl = { ...current.nativeControl!, rearm: { ...current.nativeControl!.rearm!, permissionMode: 'ask' } }
  if (change === 'saved-control') current.nativeControl = { ...current.nativeControl!, cancel: { ...current.nativeControl!.cancel,
    request: { ...current.nativeControl!.cancel.request, requestId: 'not-the-saved-cancel' } } }
  if (change === 'pending-control') registry.byAgent(pending.agentId)!.nativeControl = current.nativeControl
  if (change === 'target') registry.byAgent(pending.agentId)!.cwd = '/fixture/successor'
  expect(() => abortPending(pending, current)).toThrow()
  expect(readFileSync(fault.registry, 'utf8')).toBe(before)
})

it('rechecks stopped allocation and local owner after pending retirement publication', async () => {
  const { pending, cancelled } = await pendingCancel(), proof = stopProof(pending)
  proof.verifyStopped = () => { if (fault.phase === 'retirement') throw Error('allocation proof revoked') }
  expect(() => abortPending(pending, cancelled, proof)).toThrow('allocation proof revoked')
  expect(registry.byAgent(pending.agentId)?.nativeRetirement).toBeUndefined()
})

it('finishes an aborted visit without replaying its saved checkpoint over newer edits', async () => {
  const { pending, cancelled } = await pendingCancel(), retired = abortPending(pending, cancelled)
  const newer = store.commitNativeControl(cancelled, { ...cancelled.nativeControl!, cancel: { ...cancelled.nativeControl!.cancel,
    request: { ...cancelled.nativeControl!.cancel.request, requestId: 'newer-saved-cancel-request' } } }, fence)
  store.patch(newer.agentId, { cwd: '/fixture/later-folder' })
  const edited = store.get(newer.agentId)!
  expect(finish(retired)).toEqual(edited)
  expect(store.readNativeControl(edited).intent).toEqual(newer.nativeControl)
})

it('preserves a prior closed visit until the exact next pending abort is closed', async () => {
  const first = visit(); checkpoint(first); const closed = finish(retire(first)), prior = store.nativeReturn(first.agentId)!
  saved = store.commitNativeControl(closed, { ...closed.nativeControl!, rearm: { sourceProcess: { processKey: closed.nativeControl!.cancel.processKey },
    agentId: first.agentId, requestId: 'next-pending-resume-request', launchToken: 'next-pending-launch-token',
    operation: 'resume', source: 'saved', permissionMode: 'full', target: nativeTurnTarget(closed),
  } }, fence)
  const { pending, cancelled } = await pendingCancel(), retired = abortPending(pending, cancelled)
  expect(retired.nativeRetirement?.pendingAbort?.priorRole).toBe(creationFingerprint(prior))
  expect(store.nativeReturn(first.agentId)).toEqual(prior)
  expect(finish(retired)).toEqual(cancelled)
  expect(store.nativeReturn(first.agentId)?.link).toEqual(pending.nativeArchive)
})

it('refuses a successor archive role while finishing a pending retirement', async () => {
  const { pending, cancelled } = await pendingCancel(), retired = abortPending(pending, cancelled)
  const { pendingAbort: _abort, ...role } = retired.nativeRetirement!
  writeFileSync(fault.archive, JSON.stringify({ version: 3, session: cancelled, nativeReturn: { ...role, phase: 'saved',
    link: { ...role.link, requestId: 'successor-resume-request' } } }), { mode: 0o600 })
  const before = readFileSync(fault.archive, 'utf8')
  expect(() => finish(retired)).toThrow('untransferred native archive role changed')
  expect(readFileSync(fault.archive, 'utf8')).toBe(before)
  expect(registry.byAgent(pending.agentId)?.nativeRetirement).toEqual(retired.nativeRetirement)
})

it('does not infer an untransferred abort from a lost normal returning archive', () => {
  const row = visit(); checkpoint(row); const retired = retire(row), snapshot = store.get(row.agentId)!
  writeFileSync(fault.archive, JSON.stringify({ version: 1, session: snapshot }), { mode: 0o600 })
  expect(() => finish(retired)).toThrow('archive visit changed')
  expect(registry.byAgent(row.agentId)?.nativeRetirement?.pendingAbort).toBeUndefined()
  expect(registry.byAgent(row.agentId)).toBeDefined()
})
