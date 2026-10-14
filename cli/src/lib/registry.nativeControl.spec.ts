import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nativeRearmRequest, nativeTurnAdmitted, nativeTurnProcess, nativeTurnTarget, type NativeTurnIntent } from './nativeTurnIntent.js'
import { creationFingerprint } from './agentCreationReceipt.js'
import { appendNativeAllocation } from './nativeAllocation.js'
import { nativeCreateFingerprint, parseNativeCreateRequest } from './nativeCreateRequest.js'
import { StoppedAgentStore } from './stoppedAgents.js'
import { createKeepAbandonedConversation } from './keepAbandonedConversation.js'
import type { RegisteredSession } from './registry.js'
import type { NativeRearmReplacementProof } from '../engines/kit/nativeRearmProof.js'
import type { NativeArchiveLink } from './nativeArchive.js'

const fault = vi.hoisted(() => ({ file: '', rename: false, directory: false, renamed: false, inspect: undefined as (() => void) | undefined,
  opening: undefined as ((path: string) => void) | undefined, opened: undefined as ((path: string) => void) | undefined,
  synced: undefined as ((directory: boolean) => void) | undefined, closed: undefined as ((path: string) => void) | undefined,
  published: undefined as (() => void) | undefined, now: 0, stats: 0 }))
vi.mock('fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  const paths = new Map<number, string>()
  return { ...actual, openSync: (...args: Parameters<typeof actual.openSync>) => {
    fault.opening?.(String(args[0]))
    const fd = actual.openSync(...args)
    paths.set(fd, String(args[0]))
    fault.opened?.(String(args[0]))
    return fd
  }, closeSync: (fd: number) => {
    const path = paths.get(fd) ?? ''
    actual.closeSync(fd); paths.delete(fd)
    fault.closed?.(path)
  }, lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
    fault.stats++
    const result = actual.lstatSync(...args)
    if (String(args[0]) === fault.file) fault.inspect?.()
    return result
  }, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    if (String(args[1]) === fault.file && fault.rename) throw Error('fixture rename failed')
    const result = actual.renameSync(...args)
    if (String(args[1]) === fault.file) { fault.renamed = true; fault.published?.() }
    return result
  }, fsyncSync: (fd: number) => {
    if (fault.directory && fault.renamed && actual.fstatSync(fd).isDirectory()) throw Error('fixture directory sync failed')
    actual.fsyncSync(fd)
    fault.synced?.(actual.fstatSync(fd).isDirectory())
  } }
})
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => fault.now } }))
vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))

let root: string, data: string, file: string, row: RegisteredSession, registry: typeof import('./registry.js')['registry']
const input = () => ({ agentId: 'original-agent', engine: 'cursor' as const, tmuxPane: '%1', cwd: root,
  processIdentity: { pid: 42, startMarker: 'fixture-start', executable: '<cursor>' } })
const rows = () => JSON.parse(readFileSync(file, 'utf8')) as RegisteredSession[]
const cancellation = (): NativeTurnIntent => ({ version: 1, cancel: { processKey: 'boot\0cursor\0birth', target: nativeTurnTarget(row),
  request: { requestId: 'original-cancel-request', nonce: 'original-cancel-nonce', agentId: row.agentId, conversationId: row.sessionId, frontier: { index: -1, digest: null } } } })
const commit = () => registry.commitNativeControl(row, cancellation(), () => {})
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'registry-native-control-'))); data = join(root, 'data'); file = join(data, 'registry.json')
  fault.file = file; fault.rename = false; fault.directory = false; fault.renamed = false; fault.now = 0
  mkdirSync(data, { mode: 0o700 }); writeFileSync(join(data, 'engine-homes.json'), '{}', { mode: 0o600 })
  for (const [key, value] of Object.entries({ HOME: root, ADAPTER_DATA_DIR: data, ADAPTER_RUNTIME_DIR: join(root, 'runtime'),
    CURSOR_HOME: join(root, 'cursor'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude') })) vi.stubEnv(key, value)
  vi.resetModules(); ({ registry } = await import('./registry.js'))
  registry.load()
  registry.openProcessAgent(input())
  row = registry.register({ ...input(), sessionId: 'original-session' })!.entry
})
afterEach(() => { fault.rename = false; fault.directory = false; fault.inspect = undefined; fault.opening = fault.opened = undefined; fault.synced = undefined
  fault.closed = fault.published = undefined
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); rmSync(root, { recursive: true, force: true }) })

function archivedVisit() {
  const saved = commit()
  const link: NativeArchiveLink = { version: 1, agentId: saved.agentId, requestId: 'original-resume-request',
    launchToken: 'original-launch-token', target: 'a'.repeat(64) }
  writeFileSync(file, JSON.stringify([{ ...saved, nativeArchive: link }]), { mode: 0o600 })
  registry.load()
  return { saved: registry.byAgent(saved.agentId)!, link }
}

it.each(['missing', 'malformed', 'root', 'unknown-row', 'permissions'])('does not grant saved dispatch from %s registry evidence', change => {
  if (change === 'missing') rmSync(file)
  if (change === 'malformed') writeFileSync(file, '{', { mode: 0o600 })
  if (change === 'root') writeFileSync(file, '{}', { mode: 0o600 })
  if (change === 'unknown-row') writeFileSync(file, '[{"schemaVersion":99}]', { mode: 0o600 })
  if (change === 'permissions') chmodSync(file, 0o644)
  expect(() => registry.readNativeAbsence('absent-agent')).toThrow()
})

it('pins the exact confirmed registry absence instead of adopting an equal replacement file', () => {
  const proof = registry.readNativeAbsence('absent-agent')
  proof.verify()
  const replacement = `${file}.replacement`
  writeFileSync(replacement, readFileSync(file), { mode: 0o600 }); renameSync(replacement, file)
  expect(() => proof.verify()).toThrow()
  expect(() => registry.readNativeAbsence('absent-agent').verify()).not.toThrow()
})

it('requires durable confirmation of registry absence and refuses a local owner', () => {
  expect(() => registry.readNativeAbsence(row.agentId)).toThrow('live handoff')
  fault.directory = true; fault.renamed = true
  expect(() => registry.readNativeAbsence('absent-agent')).toThrow('directory sync')
})

it('retains the original archive epoch through load, registration and a later native reservation', () => {
  const { saved, link } = archivedVisit(), without = { ...saved }; delete without.nativeArchive
  expect(nativeTurnTarget(saved)).not.toBe(nativeTurnTarget(without))
  const registered = registry.register({ ...input(), sessionId: saved.sessionId })!.entry
  expect(registered.nativeArchive).toEqual(link)
  const reserved = registry.commitNativeControl(registered, { ...registered.nativeControl!, rearm: {
    requestId: 'later-live-restart-request', launchToken: 'later-live-restart-token', source: 'live', operation: 'restart',
    agentId: saved.agentId, target: nativeTurnTarget(registered), sourceProcess: { processKey: registered.nativeControl!.cancel.processKey },
  } }, () => {})
  expect(reserved.nativeArchive).toEqual(link)
  expect(rows()[0].nativeArchive).toEqual(link)
  registry.load()
  expect(registry.byAgent(saved.agentId)?.nativeArchive).toEqual(link)
})

it.each(['remove', 'remove-agent', 'unbind', 'shell', 'separate-shell'])('ordinary %s cannot retire an archive-owned visit', operation => {
  const { saved } = archivedVisit(), before = readFileSync(file, 'utf8')
  const run = () => {
    if (operation === 'remove') return registry.remove(saved.sessionId)
    if (operation === 'remove-agent') return registry.removeAgent(saved.agentId)
    if (operation === 'unbind') return registry.unbindSession(saved.sessionId)
    return registry.releaseEngine(saved.agentId, operation === 'separate-shell')
  }
  expect(run).toThrow('native archive')
  expect(registry.byAgent(saved.agentId)).toEqual(saved)
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(registry.resumePendingAgent(saved, [{ backend: 'tmux', paneId: '%2' }])).toBeNull()
})

it.each(['add', 'remove', 'replace'])('ordinary writes cannot %s archive lineage', change => {
  const { saved, link } = archivedVisit()
  if (change === 'add') {
    const plain = { ...saved }; delete plain.nativeArchive
    writeFileSync(file, JSON.stringify([plain]), { mode: 0o600 }); registry.load()
  }
  const before = readFileSync(file, 'utf8'), current = registry.byAgent(saved.agentId)!
  if (change === 'remove') delete current.nativeArchive
  else current.nativeArchive = { ...link, ...(change === 'replace' ? { launchToken: 'different-visit-token' } : {}) }
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  registry.flush()
  expect(error).toHaveBeenCalled()
  expect(readFileSync(file, 'utf8')).toBe(before)
})

it.each(['malformed', 'agent', 'engine', 'no-control'])('holds malformed %s archive ownership after load', change => {
  const { saved, link } = archivedVisit(), candidate = { ...saved, nativeArchive: { ...link } }
  if (change === 'malformed') candidate.nativeArchive.launchToken = 'short'
  if (change === 'agent') candidate.nativeArchive.agentId = 'another-agent'
  if (change === 'engine') candidate.engine = 'codex'
  if (change === 'no-control') { delete candidate.nativeControl; candidate.schemaVersion = 2 }
  writeFileSync(file, JSON.stringify([candidate]), { mode: 0o600 })
  const before = readFileSync(file, 'utf8')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  registry.load(); registry.flush()
  expect(registry.byAgent(saved.agentId)).toBeUndefined()
  expect(readFileSync(file, 'utf8')).toBe(before)
})

it('commits the original cancellation inside a discovery batch before granting any durable proof', async () => {
  const proposed = cancellation()
  let fenced = false
  await registry.transaction(async () => {
    const saved = registry.commitNativeControl(row, proposed, () => { fenced ||= existsSync(`${file}.lock`) })
    expect(fenced).toBe(true)
    expect(rows()[0]).toMatchObject({ schemaVersion: 3, nativeControl: proposed })
    expect(registry.readNativeControl(saved).intent).toEqual(proposed)
    await Promise.resolve()
  })
  expect(row.nativeControl).toBeUndefined()
  expect(registry.byAgent(row.agentId)?.nativeControl).toEqual(proposed)
  expect(proposed.cancel).not.toBe(registry.byAgent(row.agentId)?.nativeControl?.cancel)
})

it('continues the exact Cancel after a real commit publishes but its final proof read fails', async () => {
  const { createNativeCancel } = await import('../core/turns/nativeCancel.js')
  const read = registry.readNativeControl.bind(registry)
  vi.spyOn(registry, 'readNativeControl').mockImplementationOnce(() => { throw Error('one-shot confirmation read failure') })
    .mockImplementation(read)
  const publish = vi.spyOn(registry, 'commitNativeControl')
  const journal = vi.fn(async () => ({ recorded: false as const, source: {
    owner: { agentId: row.agentId, sessionId: row.sessionId, processKey: 'original-process' }, facts: [], verify: () => {},
  } }))
  let clock = 0
  const controller = createNativeCancel({ registry, capture: () => ({ owner: {
    agentId: row.agentId, sessionId: row.sessionId, processKey: 'original-process',
  }, frontier: { index: -1, digest: null } }), revoke: () => {}, revokeRearm: () => {}, journal,
  writer: { revoke: () => {}, interrupt: async () => { throw Error('no interrupt capability was returned') } },
  interrupt: async () => { throw Error('must not signal') }, held: () => {}, now: () => clock,
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const answer = controller.cancel(row), saved = rows()[0].nativeControl
    expect(saved).toBeDefined(); expect(journal).not.toHaveBeenCalled()
    clock = 1000
    await vi.advanceTimersByTimeAsync(1000)
    await expect(answer).resolves.toBe(false)
    expect(publish).toHaveBeenCalledOnce(); expect(journal).toHaveBeenCalledOnce()
    expect(rows()[0].nativeControl).toEqual(saved)
  } finally { controller.close(); vi.useRealTimers() }
})

it.each([false, true])('cold Cancel retains the old engine independently of an unwitnessed Restart (claimed=%s)', async claimed => {
  const { createNativeRearm } = await import('../core/agents/nativeRearm.js')
  const { createNativeCancel } = await import('../core/turns/nativeCancel.js')
  const { AgentCreationReceipts } = await import('./agentCreationReceipt.js')
  const processKey = 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa\0cursor\0' + '42\0' + '12345'
  const sourceProcess = { processKey, namespace: 'linux:4:5' }
  const prior = cancellation()
  registry.commitNativeControl(row, { ...prior, cancel: { ...prior.cancel, ...sourceProcess } }, () => {})
  const directory = join(data, 'agent-creations'), receipts = new AgentCreationReceipts(directory)
  const creationId = 'unwitnessed-native-restart', input = { creationId, agentId: row.agentId, operation: 'restart' as const, source: 'live' as const }
  const prepare = vi.fn(async () => claimed ? async (guard: { begin(): void }) => { guard.begin() } : null)
  const rearm = createNativeRearm({ registry, saved: new StoppedAgentStore(join(data, 'stopped-agents')), receipts, prepare, held() {} })
  const journal = vi.fn(async () => { throw Error('Pending Restart has no new interrupt owner') })
  const cancel = createNativeCancel({ registry, capture: () => undefined, revoke() {}, revokeRearm: id => rearm.revoke(id), journal,
    writer: { revoke() {}, interrupt: async () => { throw Error('Must not interrupt') } },
    interrupt: async () => { throw Error('Must not signal') }, held() {} })
  try {
    expect((await rearm.start(input)).state).toBe(claimed ? 'unconfirmed' : 'pending')
    const reserved = registry.byAgent(row.agentId)!, request = nativeRearmRequest(reserved.nativeControl!)!
    expect(request.sourceProcess).toEqual(sourceProcess)
    await expect(cancel.cancel(reserved)).resolves.toBe(false)
    const cold = new (registry.constructor as new () => typeof registry)(); cold.load()
    const control = cold.byAgent(row.agentId)!.nativeControl!
    expect(control.cancel.processKey).toBeNull(); expect(control.cancel).not.toHaveProperty('namespace')
    expect(control.rearm).toMatchObject({ revoked: true, sourceProcess })
    expect(nativeRearmRequest(control)).toEqual(request)
    expect(nativeTurnProcess(control.rearm!.sourceProcess!)).toEqual({ boot: processKey.split('\0')[0], namespace: 'linux:4:5', pid: 42, birth: '12345' })
    const retained = JSON.parse(readFileSync(join(directory, `${creationId}.json`), 'utf8'))
    expect(retained.request).toEqual(request)
    const coldReceipts = new AgentCreationReceipts(directory)
    expect(coldReceipts.status(creationId).state).toBe(claimed ? 'unconfirmed' : 'cancelled')
    expect(existsSync(join(directory, `${creationId}.json.process`))).toBe(false)
    expect(() => coldReceipts.readNativeRelaunchProcess(creationId, { fingerprint: retained.fingerprint, request })).toThrow()
    expect(journal).not.toHaveBeenCalled(); expect(prepare).toHaveBeenCalledOnce()
  } finally { cancel.close(); rearm.close() }
})

it.each([false, true])('keeps cancellation across registration, load and an automatic process identity change (scoped=%s)', scoped => {
  const control = cancellation()
  const saved = registry.commitNativeControl(row, scoped ? { ...control, cancel: { ...control.cancel,
    processKey: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa\0cursor\0' + '42\0' + '12345', namespace: 'linux:4:5' } } : control, () => {})
  const expected = saved.nativeControl
  registry.register({ ...input(), sessionId: row.sessionId, title: 'A later observation' })
  registry.load()
  expect(registry.byAgent(row.agentId)?.nativeControl).toEqual(expected)
  registry.updateProcessIdentity(row.agentId, { ...input().processIdentity, pid: 43 })
  const current = registry.byAgent(row.agentId)!
  expect(registry.readNativeControl(current).intent).toEqual(expected)
  expect(nativeTurnAdmitted(current.nativeControl, { agentId: row.agentId, sessionId: row.sessionId, processKey: 'replacement' })).toBe(false)
})

it.each([false, true])('preserves the original association in stopped storage and an abandoned-conversation clone (scoped=%s)', scoped => {
  const control = cancellation()
  const saved = registry.commitNativeControl(row, scoped ? { ...control, cancel: { ...control.cancel,
    processKey: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa\0cursor\0' + '42\0' + '12345', namespace: 'linux:4:5' } } : control, () => {})
  const store = new StoppedAgentStore(join(data, 'stopped-agents'))
  store.save(saved)
  expect(store.get(row.agentId)?.nativeControl).toEqual(saved.nativeControl)
  const publish = vi.fn(async () => {})
  createKeepAbandonedConversation({ stoppedAgents: store, publishStoppedAgent: publish })(saved)
  const archived = store.list().find(candidate => candidate.agentId !== row.agentId)!
  expect(archived.schemaVersion).toBe(3)
  expect(archived.nativeControl).toEqual(saved.nativeControl)
  expect(archived.nativeControl!.cancel.request.agentId).toBe(row.agentId)
  expect(nativeTurnAdmitted(archived.nativeControl, { agentId: archived.agentId, sessionId: archived.sessionId, processKey: 'new' })).toBe(false)
})

it('does not turn a new process in the pane into an uncancelled replacement agent', () => {
  const saved = commit(), bytes = readFileSync(file, 'utf8')
  expect(registry.openProcessAgent({ ...input(), agentId: 'automatic-successor', processIdentity: { ...input().processIdentity, pid: 43 } })).toBeNull()
  expect(registry.byAgent(row.agentId)).toBe(saved)
  expect(registry.byAgent('automatic-successor')).toBeUndefined()
  expect(readFileSync(file, 'utf8')).toBe(bytes)
})

it('refuses another agent stealing the cancelled conversation', () => {
  commit()
  const other = { ...input(), agentId: 'other', tmuxPane: '%2', processIdentity: { ...input().processIdentity, pid: 44 } }
  registry.openProcessAgent(other)
  const bytes = readFileSync(file, 'utf8')
  expect(() => registry.register({ ...other, sessionId: row.sessionId })).toThrow('native cancellation')
  expect(readFileSync(file, 'utf8')).toBe(bytes)
})

it('holds a peer ownership collision at merge instead of evicting the cancelled row', async () => {
  const peer = new (registry.constructor as new () => typeof registry)()
  peer.load()
  commit()
  const bytes = readFileSync(file, 'utf8')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  peer.openProcessAgent({ ...input(), agentId: 'automatic-successor', processIdentity: { ...input().processIdentity, pid: 43 } })
  expect(readFileSync(file, 'utf8')).toBe(bytes)
  expect(console.error).toHaveBeenCalled()
})

it('does not let a stale peer remove a row after its durable cancellation changed', () => {
  const peer = new (registry.constructor as new () => typeof registry)()
  peer.load(); commit()
  const bytes = readFileSync(file, 'utf8')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  peer.removeAgent(row.agentId)
  expect(readFileSync(file, 'utf8')).toBe(bytes)
  expect(console.error).toHaveBeenCalled()
  // A fresh view can remove the exact row that its archive preserves.
  peer.load(); peer.removeAgent(row.agentId)
  expect(rows()).toEqual([])
})

it.each(['rename', 'fence'] as const)('publishes no control when %s fails before the write', failure => {
  const before = readFileSync(file, 'utf8')
  fault.rename = failure === 'rename'
  expect(() => registry.commitNativeControl(row, cancellation(), () => { if (failure === 'fence') throw Error('native evidence changed') })).toThrow()
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(registry.byAgent(row.agentId)?.nativeControl).toBeUndefined()
})

it('never rolls an uncertain Cancel back during an unrelated save, then confirms only the original request', () => {
  const proposed = cancellation()
  fault.directory = true; fault.renamed = false
  expect(() => registry.commitNativeControl(row, proposed, () => {})).toThrow('directory sync')
  expect(registry.byAgent(row.agentId)?.nativeControl).toBeUndefined()
  expect(rows()[0].nativeControl).toEqual(proposed)
  expect(() => registry.readNativeControl(row)).toThrow('durable registry confirmation')
  const written = readFileSync(file, 'utf8')
  fault.directory = false
  vi.spyOn(console, 'error').mockImplementation(() => {})
  registry.flush()
  registry.markOpened(row.agentId); registry.touchTranscript(row.sessionId, Date.now() + 10)
  expect(readFileSync(file, 'utf8')).toBe(written)
  expect(console.error).toHaveBeenCalled()
  expect(() => registry.commitNativeControl(row, { ...proposed, cancel: { ...proposed.cancel, request: { ...proposed.cancel.request, nonce: 'different-cancel-nonce' } } }, () => {})).toThrow('still needs durable confirmation')
  const saved = registry.commitNativeControl(row, proposed, () => {})
  expect(registry.readNativeControl(saved).intent).toEqual(proposed)
  expect(readFileSync(file, 'utf8')).toBe(written)
})

it('rechecks the captured owner after the external commit fence returns inside the lock', () => {
  const before = readFileSync(file, 'utf8')
  expect(() => registry.commitNativeControl(row, cancellation(), () => {
    if (existsSync(`${file}.lock`)) row.sessionId = 'replacement'
  })).toThrow('original native control owner changed')
  expect(readFileSync(file, 'utf8')).toBe(before)
})

it('refuses a direct confirmed replacement without its original durable reservation', () => {
  const next = { ...cancellation(), rearm: { requestId: 'original-rearm-request', agentId: row.agentId,
    operation: 'restart' as const, target: nativeTurnTarget(row), launchToken: 'original-launch-token',
    replacement: { processKey: 'replacement', sessionId: row.sessionId } } }
  const before = readFileSync(file, 'utf8')
  expect(() => registry.commitNativeControl(row, next, () => {})).toThrow('transition is invalid')
  expect(readFileSync(file, 'utf8')).toBe(before)
})

function liveReservation(mode?: 'full') {
  const cancelled = commit()
  return registry.commitNativeControl(cancelled, { ...cancelled.nativeControl!, rearm: {
    requestId: 'original-rearm-request', agentId: row.agentId, operation: mode ? 'resume' : 'restart', source: 'live',
    target: nativeTurnTarget(cancelled), launchToken: 'original-launch-token', sourceProcess: { processKey: cancelled.nativeControl!.cancel.processKey }, ...(mode ? { permissionMode: mode } : {}),
  } }, () => {})
}
function replacementRequest(reserved: RegisteredSession) {
  const rearm = reserved.nativeControl!.rearm!
  const request = nativeRearmRequest(reserved.nativeControl!)!
  const fingerprint = creationFingerprint({ kind: 'native-rearm', agentId: rearm.agentId, operation: rearm.operation,
    source: rearm.source, ...(rearm.permissionMode === undefined ? {} : { permissionMode: rearm.permissionMode }) })
  return { fingerprint, request }
}
function replacementProof(reserved = registry.byAgent(row.agentId)!): NativeRearmReplacementProof {
  return { key: `fixture-boot\0cursor\0${43}\0precise-birth`, evidence: 'original-exec', pane: '%1',
    processIdentity: { pid: 43, executable: '<cursor>', startMarker: 'replacement-start', startTicks: 43 }, verify: vi.fn(),
    verifyExecution: vi.fn(), verifyConfirmation: vi.fn(), current: vi.fn(), source: { target: nativeTurnTarget(reserved),
      controlFingerprint: creationFingerprint(reserved.nativeControl), requestFingerprint: creationFingerprint(replacementRequest(reserved)) } }
}

function allocationVisit() {
  const reserved = liveReservation()
  return { reserved, admitted: registry.commitNativeReplacement(reserved, replacementProof(reserved), () => {}) }
}

function initialAllocationVisit() {
  const request = parseNativeCreateRequest({ kind: 'native-create-v2', creationId: 'initial-creation-request', agentId: row.agentId,
    launchToken: 'initial-launch-token', label: 'harness-cursor-first', local: true,
    input: { engine: 'cursor', cwd: root }, selection: null })!
  const receipt = { request, fingerprint: nativeCreateFingerprint(request) }
  const admitted: RegisteredSession = { ...row, schemaVersion: 5, nativeAllocation: appendNativeAllocation(undefined, receipt) }
  writeFileSync(file, JSON.stringify([admitted]), { mode: 0o600 })
  registry.load()
  expect(registry.byAgent(row.agentId)).toBeDefined()
  return { admitted: registry.byAgent(row.agentId)!, receipt }
}

it('continues migrating cold legacy rows to schema two beside initial allocation support', () => {
  const legacy: Partial<RegisteredSession> = { ...row }
  delete legacy.schemaVersion
  writeFileSync(file, JSON.stringify([legacy]), { mode: 0o600 })
  registry.load()
  expect(registry.byAgent(row.agentId)).toBeDefined()
  expect(registry.byAgent(row.agentId)?.schemaVersion).toBe(2)
  expect(registry.byAgent(row.agentId)?.sessionId).toBe(row.sessionId)
  expect(rows()[0].schemaVersion).toBe(2)
})

it('retains initial schema five through observation, binding and its first durable Cancel', () => {
  const { admitted, receipt } = initialAllocationVisit()
  expect(admitted.schemaVersion).toBe(5)
  expect(admitted.nativeAllocation).toEqual({ version: 2, receipts: [receipt] })
  expect(admitted.nativeControl).toBeUndefined()
  const opened = registry.openProcessAgent(input())
  expect(opened?.entry.schemaVersion).toBe(5)
  expect(() => registry.register({ ...input(), sessionId: admitted.sessionId })).not.toThrow()
  expect(registry.byAgent(admitted.agentId)?.schemaVersion).toBe(5)
  expect(registry.byAgent(admitted.agentId)?.nativeAllocation).toEqual(admitted.nativeAllocation)
  const owner = registry.byAgent(admitted.agentId)!
  const cancelled = registry.commitNativeControl(owner, { version: 1, cancel: { ...cancellation().cancel,
    processKey: null, target: nativeTurnTarget(owner) } }, () => {})
  expect(cancelled.schemaVersion).toBe(4)
  expect(cancelled.nativeAllocation).toEqual(admitted.nativeAllocation)
  expect(cancelled.nativeControl?.cancel.processKey).toBeNull()
  registry.load()
  const cold = registry.byAgent(admitted.agentId)
  expect(cold).toBeDefined(); expect(cold?.schemaVersion).toBe(4)
  expect(cold?.nativeControl).toEqual(cancelled.nativeControl)
  expect(cold?.nativeAllocation).toEqual(admitted.nativeAllocation)
})

it('never reinterprets a lost Cancel as initial admission', () => {
  const { admitted } = initialAllocationVisit()
  const cancelled = registry.commitNativeControl(admitted, { version: 1, cancel: { ...cancellation().cancel,
    processKey: null, target: nativeTurnTarget(admitted) } }, () => {})
  delete cancelled.nativeControl
  writeFileSync(file, JSON.stringify([cancelled]), { mode: 0o600 })
  const before = readFileSync(file, 'utf8')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  registry.load(); registry.flush()
  expect(registry.list()).toEqual([]); expect(readFileSync(file, 'utf8')).toBe(before)
})

it('stale initial-schema edits preserve a peer Cancel and the original creation', async () => {
  const { admitted } = initialAllocationVisit(), previous = structuredClone(admitted)
  const cancelled = registry.commitNativeControl(admitted, { version: 1, cancel: { ...cancellation().cancel,
    processKey: null, target: nativeTurnTarget(admitted) } }, () => {})
  const { mergedForSave } = await import('./registry.js')
  const value = (input: object) => input as Record<string, unknown>
  const merged = mergedForSave(new Map([[row.agentId, value(cancelled)]]),
    new Map([[row.agentId, value({ ...previous, title: 'Renamed' })]]),
    new Map([[row.agentId, JSON.stringify(previous)]]), new Map()).get(row.agentId)
  expect(merged?.schemaVersion).toBe(4); expect(merged?.nativeControl).toEqual(cancelled.nativeControl)
  expect(merged?.nativeAllocation).toEqual(previous.nativeAllocation); expect(merged?.title).toBe('Renamed')
})

it('keeps initial allocation ownership across saved edits and first saved Cancel', () => {
  const { admitted } = initialAllocationVisit(), directory = join(root, 'first-saved')
  mkdirSync(directory, { mode: 0o700 })
  writeFileSync(join(directory, `${admitted.agentId}.json`), JSON.stringify({ version: 1, session: { ...admitted, active: false } }), { mode: 0o600 })
  const store = new StoppedAgentStore(directory), saved = store.get(admitted.agentId)!
  expect(saved?.schemaVersion).toBe(5)
  expect(() => store.save({ ...saved, title: 'Renamed' })).not.toThrow()
  const edited = store.get(admitted.agentId)!
  expect(edited?.schemaVersion).toBe(5); expect(edited?.nativeAllocation).toEqual(admitted.nativeAllocation)
  const cancelled = store.commitNativeControl(edited, { version: 1, cancel: { ...cancellation().cancel,
    processKey: null, target: nativeTurnTarget(edited) } }, { verify: () => {}, current: () => {} })
  expect(cancelled.schemaVersion).toBe(4); expect(cancelled.nativeAllocation).toEqual(admitted.nativeAllocation)
  expect(new StoppedAgentStore(directory).get(admitted.agentId)?.nativeControl).toEqual(cancelled.nativeControl)
})

it.each(['control', 'missing', 'legacy', 'later-rearm', 'foreign-agent', 'other-engine', 'retired-runtime'])
  ('refuses initial schema five with %s corruption without changing any saved bytes', change => {
    const { admitted } = initialAllocationVisit(), candidate = structuredClone(admitted)
    if (change === 'control') candidate.nativeControl = cancellation()
    if (change === 'missing') delete candidate.nativeAllocation
    if (change === 'legacy') candidate.nativeAllocation = { ...candidate.nativeAllocation!, version: 1 }
    if (change === 'foreign-agent') candidate.agentId = 'foreign-agent'
    if (change === 'other-engine') candidate.engine = 'codex'
    if (change === 'retired-runtime') Object.assign(candidate, { runtimes: [{ backend: 'herdr', paneId: 'old' }], primaryRuntimeKey: 'herdr\0old', tmuxPane: undefined })
    if (change === 'later-rearm') {
      const choice = { kind: 'native-rearm', agentId: candidate.agentId, operation: 'restart', source: 'live' }
      candidate.nativeAllocation = appendNativeAllocation(candidate.nativeAllocation, { fingerprint: creationFingerprint(choice),
        request: { ...choice, creationId: 'second-creation-request', launchToken: 'second-launch-token', target: 'b'.repeat(64), sourceProcess: { processKey: null } } })
    }
    writeFileSync(file, JSON.stringify([candidate]), { mode: 0o600 })
    const before = readFileSync(file, 'utf8')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    registry.load(); registry.flush()
    expect(registry.list()).toEqual([]); expect(readFileSync(file, 'utf8')).toBe(before)
  })

it('generic control cannot admit a replacement without retaining its proven allocation', () => {
  const reserved = liveReservation(), before = readFileSync(file, 'utf8')
  const next = { ...reserved.nativeControl!, rearm: { ...reserved.nativeControl!.rearm!,
    replacement: { processKey: replacementProof(reserved).key, sessionId: reserved.sessionId } } }
  expect(() => registry.commitNativeControl(reserved, next, () => {})).toThrow('proven allocation')
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(registry.byAgent(reserved.agentId)).toEqual(reserved)
  const admitted = registry.commitNativeReplacement(reserved, replacementProof(reserved), () => {})
  expect(registry.commitNativeControl(admitted, admitted.nativeControl!, () => {}).nativeAllocation).toEqual(admitted.nativeAllocation)
})

it('rejects a fresh reservation ID which reuses a retained pane token before publication', () => {
  const { admitted } = allocationVisit(), cancelled = laterAllocationCancel(admitted), before = readFileSync(file, 'utf8')
  expect(() => registry.commitNativeControl(cancelled, { ...cancelled.nativeControl!, rearm: {
    requestId: 'different-original-request', agentId: cancelled.agentId, operation: 'restart', source: 'live',
    target: nativeTurnTarget(cancelled), launchToken: admitted.nativeAllocation!.receipts[0].request.launchToken as string,
    sourceProcess: { processKey: cancelled.nativeControl!.cancel.processKey },
  } }, () => {})).toThrow('transition')
  expect(readFileSync(file, 'utf8')).toBe(before)
})

it('invalidates retained live evidence when the permanent allocation reference changes', () => {
  const { admitted } = allocationVisit(), proof = registry.readNativeControl(admitted)
  const first = admitted.nativeAllocation!.receipts[0]
  admitted.nativeAllocation = { version: 1, receipts: [{ ...first, request: { ...first.request, target: 'f'.repeat(64) } }] }
  expect(proof.verify).toThrow('changed')
})
function laterAllocationCancel(admitted: RegisteredSession, n = 1) {
  return registry.commitNativeControl(admitted, { version: 1, cancel: {
    processKey: admitted.nativeControl!.rearm!.replacement!.processKey, target: nativeTurnTarget(admitted),
    request: { ...admitted.nativeControl!.cancel.request, requestId: `later-cancel-request-${n}`, nonce: `later-cancel-nonce-${n}` },
  } }, () => {})
}

it('retains the exact original allocation through Cancel, registration and a cold reload', () => {
  const { admitted, reserved } = allocationVisit(), original = replacementRequest(reserved)
  expect(admitted.schemaVersion).toBe(4)
  expect(admitted.nativeAllocation).toEqual({ version: 1, receipts: [original] })
  expect(original.request.target).toBe(nativeTurnTarget(reserved))
  expect(nativeTurnTarget(admitted)).not.toBe(original.request.target)
  const cancelled = laterAllocationCancel(admitted)
  expect(cancelled.nativeControl!.rearm).toBeUndefined()
  expect(cancelled.nativeAllocation).toEqual(admitted.nativeAllocation)
  expect(() => registry.register({ ...input(), processIdentity: admitted.processIdentity!, sessionId: admitted.sessionId })).not.toThrow()
  const registered = registry.byAgent(admitted.agentId)!
  expect(registered.schemaVersion).toBe(4); expect(registered.nativeAllocation).toEqual(admitted.nativeAllocation)
  registry.load()
  const recovered = registry.byAgent(admitted.agentId)!
  expect(recovered).toBeDefined()
  expect(recovered.schemaVersion).toBe(4); expect(recovered.nativeAllocation).toEqual(admitted.nativeAllocation)
  expect(recovered.nativeControl).toEqual(cancelled.nativeControl)
  expect(registry.readNativeControl(recovered).verify).not.toThrow()
})

it('retains all prior allocations, reserves before launch and holds a fifth reservation without writes', () => {
  let { admitted } = allocationVisit()
  const requests = [...admitted.nativeAllocation!.receipts]
  for (let n = 1; n < 4; n++) {
    const cancelled = laterAllocationCancel(admitted, n)
    const reserved = registry.commitNativeControl(cancelled, { ...cancelled.nativeControl!, rearm: {
      requestId: `later-rearm-request-${n}`, agentId: cancelled.agentId, operation: 'restart', source: 'live',
      target: nativeTurnTarget(cancelled), launchToken: `later-launch-token-${n}`,
      sourceProcess: { processKey: cancelled.nativeControl!.cancel.processKey },
    } }, () => {})
    expect(reserved.nativeAllocation!.receipts).toEqual(requests)
    const proof = replacementProof(reserved), pid = 43 + n
    admitted = registry.commitNativeReplacement(reserved, { ...proof, key: `fixture-boot\0cursor\0${pid}\0precise-birth`,
      processIdentity: { ...proof.processIdentity, pid } }, () => {})
    requests.push(replacementRequest(reserved))
    expect(admitted.nativeAllocation!.receipts).toEqual(requests)
  }
  const cancelled = laterAllocationCancel(admitted, 5), before = readFileSync(file, 'utf8')
  expect(() => registry.commitNativeControl(cancelled, { ...cancelled.nativeControl!, rearm: {
    requestId: 'fifth-rearm-request', agentId: cancelled.agentId, operation: 'restart', source: 'live',
    target: nativeTurnTarget(cancelled), launchToken: 'fifth-launch-token',
    sourceProcess: { processKey: cancelled.nativeControl!.cancel.processKey },
  } }, () => {})).toThrow('transition')
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(registry.byAgent(cancelled.agentId)?.nativeAllocation!.receipts).toEqual(requests)
})

it.each(['remove', 'remove-agent', 'unbind', 'shell', 'separate-shell', 'resume', 'discover', 'register'])
  ('ordinary %s cannot replace or forget an unaccounted allocation', operation => {
    const { admitted } = allocationVisit(), before = readFileSync(file, 'utf8'), original = structuredClone(admitted)
    const next = { pid: 44, executable: '<cursor>', startMarker: 'next-engine' }
    if (operation === 'resume') expect(registry.resumePendingAgent({ ...admitted, agentId: 'different-agent' }, [{ backend: 'tmux', paneId: '%2' }])).toBeNull()
    else if (operation === 'discover') expect(registry.openProcessAgent({ ...input(), processIdentity: next })).toBeNull()
    else expect(() => {
      if (operation === 'remove') return registry.remove(admitted.sessionId)
      if (operation === 'remove-agent') return registry.removeAgent(admitted.agentId)
      if (operation === 'unbind') return registry.unbindSession(admitted.sessionId)
      if (operation === 'register') return registry.register({ ...input(), processIdentity: next, sessionId: admitted.sessionId })
      return registry.releaseEngine(admitted.agentId, operation === 'separate-shell')
    }).toThrow('native allocation')
    expect(readFileSync(file, 'utf8')).toBe(before); expect(registry.byAgent(admitted.agentId)).toEqual(original)
  })

it.each(['drop', 'replace', 'append'])('ordinary flush cannot %s original allocation references', change => {
  const { admitted } = allocationVisit(), before = readFileSync(file, 'utf8')
  const live = registry.byAgent(admitted.agentId)!
  if (change === 'drop') { delete live.nativeAllocation; live.schemaVersion = 3 }
  else {
    const original = live.nativeAllocation!.receipts[0]
    const changed = { ...original, request: { ...original.request, creationId: 'another-creation-request', launchToken: 'another-launch-token' } }
    live.nativeAllocation = { version: 1, receipts: change === 'append' ? [original, changed] : [changed] }
  }
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  registry.flush()
  expect(error).toHaveBeenCalled(); expect(readFileSync(file, 'utf8')).toBe(before)
})

it.each(['missing', 'missing-control', 'schema2', 'schema3', 'foreign-agent', 'invalid', 'retired-runtime'])
  ('blocks all writes when a saved allocation has %s corruption', change => {
    const { admitted } = allocationVisit(), candidate = structuredClone(admitted)
    if (change === 'missing') delete candidate.nativeAllocation
    if (change === 'missing-control') delete candidate.nativeControl
    if (change === 'schema2') candidate.schemaVersion = 2
    if (change === 'schema3') candidate.schemaVersion = 3
    if (change === 'foreign-agent') candidate.agentId = 'foreign-agent'
    if (change === 'invalid') candidate.nativeAllocation = { version: 1, receipts: [] }
    if (change === 'retired-runtime') Object.assign(candidate, { runtimes: [{ backend: 'herdr', paneId: 'old' }], primaryRuntimeKey: 'herdr\0old', tmuxPane: undefined })
    writeFileSync(file, JSON.stringify([candidate]), { mode: 0o600 })
    const before = readFileSync(file, 'utf8')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    registry.load(); registry.flush()
    expect(registry.list()).toEqual([]); expect(readFileSync(file, 'utf8')).toBe(before)
  })

async function recoveryFixture(reserved: RegisteredSession) {
  const { AgentCreationReceipts } = await import('./agentCreationReceipt.js')
  const { createNativeRearmProof } = await import('../engines/kit/nativeRearmProof.js')
  const { controlIdentity } = await import('./nativeProcessControl.js')
  const receipts = new AgentCreationReceipts(join(data, 'agent-creations')), request = replacementRequest(reserved)
  const id = reserved.nativeControl!.rearm!.requestId
  const dispatch = vi.fn(async () => ({ state: 'unconfirmed' as const }))
  await receipts.runIntent(id, request.fingerprint, request.request, { service: 'native', detail: 'fixture' }, async () => dispatch)
  const boot = 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', birth = '4300'
  receipts.recordNativeRelaunchProcess(id, request, { boot, pid: 43, birth }, { verify: () => {}, current: () => {} })
  const engine = { pid: 43, parentPid: 10, birth, command: 'cursor-agent', imagePath: '/fixture/cursor-agent', fds: [] }
  const shell = { pid: 10, parentPid: 2, birth: '1000', command: 'bash', imagePath: '/bin/bash', fds: [] }
  const probe = vi.fn(async () => ({ parent: 0, children: [], rows: new Map([[10, shell], [43, engine]]) }))
  const reader = createNativeRearmProof({ receipts, owner: 'a'.repeat(16), boot: async () => boot,
    pane: async () => ({ rootPid: 10, command: 'original-command' }), probe,
    inspect: async () => ({ parent: { pid: 43, parentPid: 10, nativeBirth: birth, executable: 'cursor-agent',
      startMarker: 'replacement-start', imagePath: engine.imagePath, args: 'cursor-agent',
      evidence: controlIdentity(engine), controlIdentity: controlIdentity(engine) },
    children: [], verify: async () => {}, verifyDescriptors: async () => {} }),
  })
  let revoked = false
  const target = nativeTurnTarget(reserved), control = creationFingerprint(reserved.nativeControl)
  const current = () => {
    const value = registry.byAgent(reserved.agentId)
    if (revoked || !value || nativeTurnTarget(value) !== target || creationFingerprint(value.nativeControl) !== control) {
      throw Error('original recovery owner revoked')
    }
  }
  const fresh = () => reader.recover(reserved, request, { verify: registry.readNativeReplacementSource(reserved).verify, current }, '%1')
  return { fresh, dispatch, probe, revoke: () => { revoked = true }, receipts, request, reader }
}

it('confirms live recovery on its first call with the real Registry and original receipt', async () => {
  const reserved = liveReservation('full'), p = await recoveryFixture(reserved)
  const { createNativeRearmRecovery } = await import('../core/agents/nativeRearmRecovery.js')
  const held = vi.fn(), controller = createNativeRearmRecovery({ registry, saved: new StoppedAgentStore(join(data, 'stopped-agents')),
    receipts: p.receipts, proof: p.reader, held })
  expect(await controller.recover(reserved)).toMatchObject({ state: 'created', agentId: reserved.agentId, resumed: true })
  expect(registry.byAgent(reserved.agentId)?.nativeAllocation?.receipts).toEqual([p.request])
  expect(held).not.toHaveBeenCalled(); expect(p.dispatch).toHaveBeenCalledOnce()
  expect(await controller.recover(reserved)).toMatchObject({ state: 'created' })
  expect(p.dispatch).toHaveBeenCalledOnce()
})

it('reproves the original real receipt after uncertain sync without redispatch or provisional binding', async () => {
  const reserved = liveReservation('full'), original = structuredClone(reserved), p = await recoveryFixture(reserved)
  const proof = await p.fresh()
  fault.directory = true; fault.renamed = false
  expect(() => registry.commitNativeReplacement(reserved, proof, () => {})).toThrow('directory sync')
  const written = readFileSync(file, 'utf8')
  expect(registry.byAgent(row.agentId)).toEqual(original)
  expect(() => registry.readNativeControl(reserved)).toThrow('durable registry confirmation')
  fault.directory = false
  expect(proof.verify).toThrow()
  expect(() => registry.readNativeReplacementSource(reserved)).not.toThrow()
  const retrySource = registry.readNativeReplacementSource(reserved), retry = await p.fresh()
  expect(p.probe).toHaveBeenCalledTimes(4)
  const committed = registry.commitNativeReplacement(reserved, retry, () => {})
  expect(committed.processIdentity).toEqual(retry.processIdentity)
  expect(committed.permissionMode).toBe('full')
  expect(readFileSync(file, 'utf8')).toBe(written)
  expect(retrySource.verify).toThrow()
  expect(p.dispatch).toHaveBeenCalledOnce()
  expect(registry.readNativeControl(committed).intent?.rearm?.replacement?.processKey).toBe(proof.key)
})

it('keeps retry proof work constant through repeated uncertain writes and then recovers', async () => {
  const reserved = liveReservation(), p = await recoveryFixture(reserved)
  let cost: number | undefined
  for (let attempt = 0; attempt < 8; attempt++) {
    const proof = await p.fresh()
    fault.directory = true; fault.renamed = false
    expect(() => registry.commitNativeReplacement(reserved, proof, () => {})).toThrow('directory sync')
    fault.directory = false
    const source = registry.readNativeReplacementSource(reserved), before = fault.stats
    source.verifyDirectory()
    const reads = fault.stats - before
    expect(reads).toBeGreaterThan(0)
    cost ??= reads
    expect(reads).toBe(cost)
    expect(registry.byAgent(row.agentId)?.processIdentity?.pid).toBe(42)
  }
  const proof = await p.fresh()
  expect(registry.commitNativeReplacement(reserved, proof, () => {}).processIdentity?.pid).toBe(43)
  expect(p.dispatch).toHaveBeenCalledOnce()
})

it.each(['target', 'controlFingerprint', 'requestFingerprint'] as const)('requires the proof to retain its exact %s binding', field => {
  const reserved = liveReservation(), proof = replacementProof(reserved), before = readFileSync(file, 'utf8')
  const mismatched = { ...proof, source: { ...proof.source, [field]: '0'.repeat(64) } }
  expect(() => registry.commitNativeReplacement(reserved, mismatched, () => {})).toThrow('different replacement reservation')
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(proof.verify).not.toHaveBeenCalled()
})

it.each(['staging', 'staging-deadline', 'confirmation', 'confirmation-deadline', 'substitute', 'receipt'] as const)(
  'holds a real replacement revoked during %s before publishing live admission', async change => {
    const reserved = liveReservation(), original = structuredClone(reserved), p = await recoveryFixture(reserved)
    const proof = await p.fresh(), before = readFileSync(file, 'utf8')
    let staging = false, changed = false
    fault.renamed = false
    fault.opened = path => { if (path.startsWith(file + '.') && path.endsWith('.tmp')) staging = true }
    fault.synced = directory => {
      if (changed || (change.startsWith('staging') ? !staging || directory : !fault.renamed || !directory)) return
      changed = true
      if (change.endsWith('deadline')) fault.now = 4000
      else if (change === 'substitute') {
        const substitute = file + '.fixture-substitute'
        writeFileSync(substitute, readFileSync(file), { mode: 0o600 }); renameSync(substitute, file)
      } else if (change === 'receipt') {
        const witness = join(data, 'agent-creations', `${reserved.nativeControl!.rearm!.requestId}.json.process`)
        writeFileSync(witness, '{}', { mode: 0o600 })
      } else p.revoke()
    }
    expect(() => registry.commitNativeReplacement(reserved, proof, () => {})).toThrow()
    expect(changed).toBe(true)
    expect(registry.byAgent(row.agentId)).toEqual(original)
    if (change.startsWith('staging')) expect(readFileSync(file, 'utf8')).toBe(before)
    else expect(() => registry.readNativeControl(reserved)).toThrow('durable registry confirmation')
    expect(p.dispatch).toHaveBeenCalledOnce()
  },
)

it('refuses a real proof for another reservation on the same pane before consulting its callbacks', async () => {
  const first = liveReservation(), p = await recoveryFixture(first), oldProof = await p.fresh()
  const second = structuredClone(first)
  second.nativeControl = { ...second.nativeControl!, rearm: { ...second.nativeControl!.rearm!,
    requestId: 'second-rearm-request', launchToken: 'second-launch-token' } }
  writeFileSync(file, JSON.stringify([second]), { mode: 0o600 }); registry.load()
  const next = registry.byAgent(row.agentId)!, q = await recoveryFixture(next), newProof = await q.fresh()
  const before = readFileSync(file, 'utf8')
  expect(() => registry.commitNativeReplacement(next, oldProof, () => {})).toThrow('different replacement reservation')
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(registry.commitNativeReplacement(next, newProof, () => {}).processIdentity?.pid).toBe(43)
})

it('retains the uncertain image when closing the renamed writer reports failure after consuming its descriptor', async () => {
  const reserved = liveReservation(), original = structuredClone(reserved), p = await recoveryFixture(reserved), proof = await p.fresh()
  fault.renamed = false
  fault.closed = path => { if (fault.renamed && path.startsWith(file + '.') && path.endsWith('.tmp')) throw Error('writer close failed') }
  expect(() => registry.commitNativeReplacement(reserved, proof, () => {})).toThrow('writer close failed')
  expect(registry.byAgent(row.agentId)).toEqual(original)
  expect(() => registry.readNativeControl(reserved)).toThrow('durable registry confirmation')
  fault.closed = undefined
  const retry = await p.fresh()
  expect(registry.commitNativeReplacement(reserved, retry, () => {}).processIdentity?.pid).toBe(43)
  expect(p.dispatch).toHaveBeenCalledOnce()
})

it('refuses rewritten bytes in the actual writer inode before its published stamp is captured', async () => {
  const reserved = liveReservation(), original = structuredClone(reserved), p = await recoveryFixture(reserved), proof = await p.fresh()
  fault.published = () => {
    fault.published = undefined
    const changed = rows(); changed[0].processIdentity!.pid = 44
    writeFileSync(file, JSON.stringify(changed, null, 2), { mode: 0o600 })
  }
  expect(() => registry.commitNativeReplacement(reserved, proof, () => {})).toThrow('replacement bytes changed')
  expect(registry.byAgent(row.agentId)).toEqual(original)
  expect(() => registry.readNativeControl(reserved)).toThrow('durable registry confirmation')
  expect(() => registry.readNativeReplacementSource(reserved)).toThrow('unconfirmed replacement image changed')
})

it.each(['reload', 'peer-cancel', 'equal-bytes', 'parent', 'different-image'] as const)(
  'revokes original uncertain recovery on %s', async change => {
    const reserved = liveReservation(), p = await recoveryFixture(reserved), proof = await p.fresh()
    fault.directory = true; fault.renamed = false
    expect(() => registry.commitNativeReplacement(reserved, proof, () => {})).toThrow()
    fault.directory = false
    const source = registry.readNativeReplacementSource(reserved)
    if (change === 'reload') registry.load()
    if (change === 'peer-cancel') {
      const peer = new (registry.constructor as new () => typeof registry)(); peer.load()
      const current = peer.byAgent(row.agentId)!
      peer.commitNativeControl(current, { version: 1, cancel: { ...current.nativeControl!.cancel,
        processKey: proof.key, target: nativeTurnTarget(current),
        request: { ...current.nativeControl!.cancel.request, requestId: 'later-cancel-request' } } }, () => {})
    }
    if (change === 'equal-bytes' || change === 'different-image') {
      const image = readFileSync(file, 'utf8'), substitute = file + '.fixture-substitute'
      writeFileSync(substitute, change === 'equal-bytes' ? image : image.replace('original-agent', 'other-agent'), { mode: 0o600 })
      renameSync(substitute, file)
    }
    if (change === 'parent') { renameSync(data, data + '-original'); mkdirSync(data, { mode: 0o700 })
      writeFileSync(file, readFileSync(join(data + '-original', 'registry.json')), { mode: 0o600 }) }
    expect(source.verify).toThrow()
    expect(() => registry.readNativeReplacementSource(reserved)).toThrow()
  },
)

it.each([undefined, 'full'] as const)('publishes the proven live process and %s permissions with admission in one image', mode => {
  const reserved = liveReservation(mode), old = structuredClone(reserved), proof = replacementProof()
  let locked = false
  const changed = registry.commitNativeReplacement(reserved, proof, () => { locked ||= existsSync(`${file}.lock`) })
  expect(locked).toBe(true); expect(proof.verify).toHaveBeenCalled()
  expect(changed).toMatchObject({ processIdentity: proof.processIdentity, active: true, launch: { state: 'ready' },
    nativeControl: { ...reserved.nativeControl, rearm: { ...reserved.nativeControl!.rearm,
      replacement: { processKey: proof.key, sessionId: old.sessionId } } } })
  expect(changed.permissionMode).toBe(mode ?? old.permissionMode)
  expect(changed.bypassPermission === true).toBe(mode === 'full' || old.bypassPermission === true)
  expect(reserved).toEqual(old)
  expect(rows()[0]).toMatchObject({ processIdentity: proof.processIdentity, nativeControl: changed.nativeControl })
  expect(nativeTurnAdmitted(registry.readNativeControl(changed).intent,
    { agentId: row.agentId, sessionId: row.sessionId, processKey: proof.key })).toBe(true)
})

it('keeps an uncertain replacement as one indivisible image and confirms only that original image', () => {
  const reserved = liveReservation('full'), original = structuredClone(reserved), proof = replacementProof()
  fault.directory = true; fault.renamed = false
  expect(() => registry.commitNativeReplacement(reserved, proof, () => {})).toThrow('directory sync')
  expect(registry.byAgent(row.agentId)).toEqual(original)
  expect(rows()[0]).toMatchObject({ processIdentity: proof.processIdentity, permissionMode: 'full',
    nativeControl: { rearm: { replacement: { processKey: proof.key, sessionId: row.sessionId } } } })
  const written = readFileSync(file, 'utf8')
  fault.directory = false
  vi.spyOn(console, 'error').mockImplementation(() => {})
  registry.flush()
  expect(readFileSync(file, 'utf8')).toBe(written)
  const different = { ...proof, processIdentity: { ...proof.processIdentity, pid: 44 }, key: `fixture-boot\0cursor\0${44}\0precise-birth` }
  expect(() => registry.commitNativeReplacement(reserved, different, () => {})).toThrow('still needs durable confirmation')
  expect(() => registry.commitNativeReplacement(reserved, proof, () => {})).toThrow('fresh native evidence')
  const confirmed = registry.commitNativeReplacement(reserved, replacementProof(reserved), () => {})
  expect(confirmed.processIdentity).toEqual(proof.processIdentity)
  expect(readFileSync(file, 'utf8')).toBe(written)
})

it('does not overwrite a peer Cancel while publishing the replacement', () => {
  const reserved = liveReservation(), peer = new (registry.constructor as new () => typeof registry)()
  peer.load()
  const current = peer.byAgent(row.agentId)!, control = current.nativeControl!
  const cancelled = peer.commitNativeControl(current, { ...control,
    cancel: { ...control.cancel, processKey: null, target: nativeTurnTarget(current),
      request: { ...control.cancel.request, requestId: 'later-cancel-request' } },
    rearm: { ...control.rearm!, revoked: true },
  }, () => {})
  const before = readFileSync(file, 'utf8')
  expect(() => registry.commitNativeReplacement(reserved, replacementProof(), () => {})).toThrow('original durable native control owner changed')
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(rows()[0].nativeControl).toEqual(cancelled.nativeControl)
})

it.each(['local', 'native', 'rename'])('refuses %s revocation before any replacement publication', kind => {
  const reserved = liveReservation(), proof = replacementProof(), before = readFileSync(file, 'utf8')
  if (kind === 'native') proof.verify = () => { throw Error('replacement changed') }
  if (kind === 'rename') fault.rename = true
  expect(() => registry.commitNativeReplacement(reserved, proof, () => {
    // The retained proof cannot be replaced by a callback during publication.
    proof.verify = () => {}
    if (kind === 'local' && existsSync(`${file}.lock`)) reserved.sessionId = 'successor-session'
  })).toThrow()
  expect(readFileSync(file, 'utf8')).toBe(before)
})

it.each(['missing', 'saved', 'revoked', 'target', 'pane', 'pid', 'key', 'mode', 'confirmed'])('refuses %s replacement metadata without changing the original row', kind => {
  const reserved = liveReservation(), original = structuredClone(reserved)
  let proof = replacementProof()
  if (kind === 'missing') delete reserved.nativeControl
  if (kind === 'saved') reserved.nativeControl = { ...reserved.nativeControl!, rearm: { ...reserved.nativeControl!.rearm!, source: 'saved' } }
  if (kind === 'revoked') reserved.nativeControl = { ...reserved.nativeControl!, rearm: { ...reserved.nativeControl!.rearm!, revoked: true } }
  if (kind === 'target') reserved.permissionMode = 'full'
  if (kind === 'pane') proof = { ...proof, pane: '%2' }
  if (kind === 'pid') proof = { ...proof, processIdentity: { ...proof.processIdentity, pid: 44 } }
  if (kind === 'key') proof.key = 'unproven-process'
  if (kind === 'mode') reserved.nativeControl = { ...reserved.nativeControl!, rearm: { ...reserved.nativeControl!.rearm!, permissionMode: 'full' } }
  if (kind === 'confirmed') reserved.nativeControl = { ...reserved.nativeControl!, rearm: { ...reserved.nativeControl!.rearm!,
    replacement: { processKey: proof.key, sessionId: row.sessionId } } }
  const before = readFileSync(file, 'utf8')
  expect(() => registry.commitNativeReplacement(reserved, proof, () => {})).toThrow('reservation is unavailable')
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(rows()[0].nativeControl).toEqual(original.nativeControl)
})

it('requires a recovered enabling image to confirm file and directory durability before admission', () => {
  const reserved = liveReservation(), replacement = replacementProof(reserved)
  fault.directory = true; fault.renamed = false
  expect(() => registry.commitNativeReplacement(reserved, replacement, () => {})).toThrow('directory sync')
  const peer = new (registry.constructor as new () => typeof registry)()
  peer.load()
  expect(() => peer.readNativeControl(peer.byAgent(row.agentId)!)).toThrow('directory sync')
  fault.directory = false
  const proof = peer.readNativeControl(peer.byAgent(row.agentId)!)
  expect(nativeTurnAdmitted(proof.intent, { agentId: row.agentId, sessionId: row.sessionId, processKey: replacement.key })).toBe(true)
  proof.verify()
})

it.each(['file', 'directory'] as const)('never syncs a substitute %s descriptor after a temporary route change', kind => {
  const { admitted: ready } = allocationVisit()
  const path = kind === 'file' ? file : data, bytes = readFileSync(file)
  let reads = 0, swapped = false
  fault.opening = candidate => {
    if (candidate !== path || (kind === 'file' && ++reads !== 2)) return
    fault.opening = undefined
    renameSync(path, path + '.original')
    if (kind === 'directory') mkdirSync(data, { mode: 0o700 })
    writeFileSync(file, bytes, { mode: 0o600 }); swapped = true
  }
  fault.opened = candidate => {
    if (candidate !== path || !swapped) return
    fault.opened = undefined
    renameSync(path, path + '.substitute'); renameSync(path + '.original', path)
  }
  expect(() => registry.readNativeControl(ready)).toThrow('changed before durability confirmation')
  expect(swapped).toBe(true)
  expect(readFileSync(file)).toEqual(bytes)
})

it('does not adopt a peer change as confirmation of an uncertain control write', () => {
  fault.directory = true; fault.renamed = false
  expect(commit).toThrow('directory sync')
  fault.directory = false
  const peer = rows(); peer[0].nativeControl = { ...cancellation(), cancel: { ...cancellation().cancel, request: { ...cancellation().cancel.request, nonce: 'peer-cancel-nonce' } } }
  writeFileSync(file, JSON.stringify(peer))
  const bytes = readFileSync(file, 'utf8')
  expect(commit).toThrow('still needs durable confirmation')
  expect(readFileSync(file, 'utf8')).toBe(bytes)
  expect(registry.byAgent(row.agentId)?.nativeControl).toBeUndefined()
})

it.each(['file', 'binding', 'control', 'missing'] as const)('revokes the original durable proof after %s changes', change => {
  const saved = commit(), proof = registry.readNativeControl(saved)
  if (change === 'file') { const bytes = readFileSync(file); renameSync(file, file + '.old'); writeFileSync(file, bytes, { mode: 0o600 }) }
  if (change === 'binding') saved.sessionId = 'replacement'
  if (change === 'control') saved.nativeControl = { ...cancellation(), cancel: { ...cancellation().cancel, processKey: 'replacement' } }
  if (change === 'missing') registry.removeAgent(saved.agentId)
  expect(proof.verify).toThrow()
})

it('checks the retained file after all private-state inspection at the final dispatch boundary', () => {
  const saved = commit(), proof = registry.readNativeControl(saved)
  const uid = process.getuid!()
  let checks = 0
  // Replace after the file's owner check has read its metadata. Earlier route
  // reads must not accidentally catch a fault intended for the last boundary.
  vi.spyOn(process, 'getuid').mockImplementation(() => {
    if (++checks === 2) {
      const bytes = readFileSync(file); renameSync(file, file + '.replaced'); writeFileSync(file, bytes, { mode: 0o600 })
    }
    return uid
  })
  expect(proof.verify).toThrow()
})

it.each(['row', 'binding', 'control', 'shape', 'oversized', 'file-mode', 'directory-mode'] as const)('holds unavailable or changed durable %s without modifying its bytes', change => {
  const saved = commit(), values = rows()
  if (change === 'row') values.splice(0)
  if (change === 'binding') values[0].sessionId = 'peer'
  if (change === 'control') values[0].nativeControl = { ...cancellation(), cancel: { ...cancellation().cancel, processKey: 'peer' } }
  if (change === 'shape') (values[0] as unknown as { nativeControl: unknown }).nativeControl = { version: 99 }
  writeFileSync(file, change === 'oversized' ? ' '.repeat(1024 * 1024 + 1) : JSON.stringify(values))
  if (change === 'file-mode') chmodSync(file, 0o666)
  if (change === 'directory-mode') chmodSync(data, 0o777)
  const bytes = readFileSync(file, 'utf8')
  expect(() => registry.readNativeControl(saved)).toThrow()
  expect(readFileSync(file, 'utf8')).toBe(bytes)
})

it.each([undefined, null, { version: 9 }, { version: 1, cancel: {}, rearm: {} }])('never normalizes malformed saved control to absence %#', nativeControl => {
  const values = rows(); Object.assign(values[0], { schemaVersion: 3, nativeControl })
  writeFileSync(file, JSON.stringify(values))
  const bytes = readFileSync(file, 'utf8')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  registry.load(); registry.flush()
  expect(registry.byAgent(row.agentId)).toBeUndefined()
  registry.openProcessAgent(input())
  expect(readFileSync(file, 'utf8')).toBe(bytes)
})

it.each(['neighbour', 'truncated'] as const)('preserves control-bearing bytes when %s data is corrupt', change => {
  commit()
  const values = rows()
  const bytes = change === 'neighbour' ? JSON.stringify([...values, { schemaVersion: 2, agentId: 'malformed-neighbour' }])
    : JSON.stringify(values).slice(0, -1)
  writeFileSync(file, bytes)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  registry.load(); registry.openProcessAgent(input()); registry.flush()
  expect(readFileSync(file, 'utf8')).toBe(bytes)
})

it.each(['[', '', '{"incomplete":'])('a fresh daemon never replaces truncated state that lost its control marker: %j', bytes => {
  commit(); writeFileSync(file, bytes)
  const peer = new (registry.constructor as new () => typeof registry)()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  peer.load()
  expect(peer.openProcessAgent(input())).toBeNull()
  peer.flush()
  expect(readFileSync(file, 'utf8')).toBe(bytes)
})
