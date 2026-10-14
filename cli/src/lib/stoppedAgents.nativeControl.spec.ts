import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nativeTurnTarget, type NativeTurnIntent } from './nativeTurnIntent.js'
import type { RegisteredSession } from './registry.js'
import { creationFingerprint } from './agentCreationReceipt.js'
import { appendNativeAllocation } from './nativeAllocation.js'

const fault = vi.hoisted(() => ({ file: '', renamed: false, failDirectory: false, beforeRename: undefined as (() => void) | undefined, inspected: undefined as ((path: string) => void) | undefined, synced: undefined as (() => void) | undefined, fileSynced: undefined as (() => void) | undefined }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
    const result = actual.lstatSync(...args); fault.inspected?.(String(args[0])); return result
  }, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    if (String(args[1]) === fault.file) fault.beforeRename?.()
    const value = actual.renameSync(...args)
    if (String(args[1]) === fault.file) fault.renamed = true
    return value
  }, fsyncSync: (fd: number) => {
    if (fault.failDirectory && fault.renamed && actual.fstatSync(fd).isDirectory()) throw Error('fixture directory sync failed')
    actual.fsyncSync(fd)
    if (fault.renamed && actual.fstatSync(fd).isDirectory()) fault.synced?.()
    if (fault.renamed && actual.fstatSync(fd).isFile()) fault.fileSynced?.()
  } }
})
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))
let root: string, directory: string, file: string, row: RegisteredSession
let store: import('./stoppedAgents.js').StoppedAgentStore
const cancel = (): NativeTurnIntent => ({ version: 1, cancel: { processKey: null, target: nativeTurnTarget(row), request: {
  requestId: 'original-cancel-request', nonce: 'original-cancel-nonce', agentId: row.agentId, conversationId: row.sessionId,
  frontier: { index: -1, digest: null },
} } })
const reservation = (saved: RegisteredSession, id = 'original-rearm-request'): NativeTurnIntent => ({ ...saved.nativeControl!, rearm: {
  requestId: id, agentId: saved.agentId, operation: 'resume', target: nativeTurnTarget(saved), launchToken: 'original-launch-token',
  sourceProcess: { processKey: saved.nativeControl!.cancel.processKey },
} })
const fence = (verify = () => {}, current = () => {}) => ({ verify, current })
const commit = (input: RegisteredSession, next: NativeTurnIntent, verify: () => void) => store.commitNativeControl(input, next, fence(verify))
const bytes = () => readFileSync(file, 'utf8')
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stopped-native-control-')))
  directory = join(root, 'stopped-agents'); file = join(directory, 'agent.json')
  vi.stubEnv('ADAPTER_DATA_DIR', root); vi.resetModules()
  const { StoppedAgentStore } = await import('./stoppedAgents.js')
  store = new StoppedAgentStore(directory)
  row = { schemaVersion: 2, agentId: 'agent', engine: 'cursor', sessionId: 'session', cwd: '/fixture/project', projectDir: '/fixture/project', transcriptPath: null,
    tmuxPane: '%1', runtimes: [{ backend: 'tmux', paneId: '%1' }], primaryRuntimeKey: 'tmux\0%1', registeredAt: 1, boundAt: 2,
    lastHookAt: 2, touchedAt: 2, active: false, source: 'hook', defaultName: 'Fixture', title: null, model: null, cliVersion: null,
    processIdentity: { pid: 42, executable: '<cursor>', startMarker: 'fixture-start' } } as RegisteredSession
  store.save({ ...row, schemaVersion: 3, nativeControl: cancel() })
  row = store.get(row.agentId)!
  fault.file = file; fault.renamed = false; fault.failDirectory = false; fault.beforeRename = undefined; fault.inspected = undefined; fault.synced = undefined; fault.fileSynced = undefined
})
afterEach(() => { fault.file = ''; fault.failDirectory = false; fault.beforeRename = undefined; fault.inspected = undefined; fault.synced = undefined; fault.fileSynced = undefined
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); rmSync(root, { recursive: true, force: true }) })

function savedAllocation() {
  const choice = { kind: 'native-rearm', agentId: row.agentId, source: 'live', operation: 'restart' }
  const nativeAllocation = appendNativeAllocation(undefined, { fingerprint: creationFingerprint(choice), request: {
    ...choice, creationId: 'earlier-creation-request', launchToken: 'earlier-launch-token', target: 'a'.repeat(64), sourceProcess: { processKey: null },
  } })
  const saved: RegisteredSession = { ...row, schemaVersion: 4, nativeAllocation }
  writeFileSync(file, JSON.stringify({ version: 1, session: saved }), { mode: 0o600 })
  return store.get(row.agentId)!
}

it('generic saved control cannot introduce replacement admission or lose its original request', () => {
  const reserved = commit(row, reservation(row), () => {}), before = bytes()
  const next = { ...reserved.nativeControl!, rearm: { ...reserved.nativeControl!.rearm!,
    replacement: { processKey: 'unproven-native-process', sessionId: reserved.sessionId } } }
  expect(() => store.commitNativeControl(reserved, next, fence())).toThrow('proven allocation')
  expect(bytes()).toBe(before); expect(store.get(reserved.agentId)).toEqual(reserved)
})

it('preserves permanent allocation references through saved edits, control publication and a cold reader', async () => {
  const saved = savedAllocation(), original = saved.nativeAllocation
  store.save(saved); store.patch(saved.agentId, { cwd: '/fixture/edited' })
  const current = store.get(saved.agentId)!, next = reservation(current)
  const reserved = store.commitNativeControl(current, next, fence())
  expect(reserved.schemaVersion).toBe(4); expect(reserved.nativeAllocation).toEqual(original)
  const { StoppedAgentStore } = await import('./stoppedAgents.js')
  const recovered = new StoppedAgentStore(directory).get(row.agentId)!
  expect(recovered.nativeAllocation).toEqual(original); expect(recovered.schemaVersion).toBe(4)
  expect(recovered.nativeControl).toEqual(next)
})

it.each(['drop', 'replace', 'append', 'remove', 'supersede', 'begin'])('ordinary saved %s cannot forget or add allocation authority', change => {
  const saved = savedAllocation(), before = bytes()
  expect(() => {
    if (change === 'remove') return store.remove(saved.agentId)
    if (change === 'supersede') return store.supersede(saved.agentId)
    if (change === 'begin') return store.beginResume(saved.agentId)
    const candidate = structuredClone(saved), first = candidate.nativeAllocation!.receipts[0]
    if (change === 'drop') { delete candidate.nativeAllocation; candidate.schemaVersion = 3 }
    else {
      const changed = { ...first, request: { ...first.request, creationId: 'other-creation-request', launchToken: 'other-launch-token' } }
      candidate.nativeAllocation = { version: 1, receipts: change === 'append' ? [first, changed] : [changed] }
    }
    return store.save(candidate)
  }).toThrow()
  expect(bytes()).toBe(before)
})

it('reserves under the saved-store lock and grants only a fresh exact durable proof', () => {
  const next = reservation(row), saved = commit(row, next, () => {
    expect(existsSync(join(directory, 'registry.json.lock'))).toBe(true)
  })
  expect(saved.nativeControl).toEqual(next)
  const proof = store.readNativeControl(saved)
  proof.verify()
  store.patch(row.agentId, { cwd: '/fixture/changed' })
  expect(() => proof.verify()).toThrow()
  expect(store.get(row.agentId)!.nativeControl).toEqual(next)
})

function transferredArchive() {
  const reserved = store.commitNativeControl(row, { ...reservation(row), rearm: { ...reservation(row).rearm!, source: 'saved' } }, fence())
  const token = store.beginResume(row.agentId)!
  const link = { version: 1 as const, agentId: row.agentId, requestId: reserved.nativeControl!.rearm!.requestId,
    launchToken: reserved.nativeControl!.rearm!.launchToken, target: nativeTurnTarget(reserved) }
  const transfer = { version: 1, link, pendingTarget: 'a'.repeat(64), processKey: 'boot\0cursor\0replacement\0birth', pane: '%2' }
  writeFileSync(file, JSON.stringify({ version: 2, session: reserved, nativeTransfer: transfer }), { mode: 0o600 })
  return { reserved, transfer, token }
}

it('keeps transferred history readable without restoring saved control after Registry absence', async () => {
  const { reserved, transfer } = transferredArchive()
  const { StoppedAgentStore } = await import('./stoppedAgents.js'), recovered = new StoppedAgentStore(directory)
  for (const saved of [store, recovered]) {
    expect(saved.get(row.agentId)).toEqual(reserved)
    expect(saved.list()).toEqual([reserved])
    expect(saved.nativeTransfer(row.agentId)).toEqual(transfer)
    expect(Object.isFrozen(saved.nativeTransfer(row.agentId)?.link)).toBe(true)
    expect(() => saved.readNativeControl(reserved)).toThrow('live handoff')
  }
  expect(store.nativeTransfer('missing')).toBeNull()
})

it.each(['save', 'patch', 'control', 'begin', 'finish', 'remove', 'supersede'])('a generic %s cannot erase a transferred archive role', operation => {
  const { reserved, token } = transferredArchive(), before = bytes()
  const run = () => {
    if (operation === 'save') return store.save(reserved)
    if (operation === 'patch') return store.patch(row.agentId, { cwd: '/fixture/changed' })
    if (operation === 'control') return store.commitNativeControl(reserved, { ...reserved.nativeControl!,
      rearm: { ...reserved.nativeControl!.rearm!, revoked: true }, cancel: { ...reserved.nativeControl!.cancel,
        request: { ...reserved.nativeControl!.cancel.request, requestId: 'later-cancel-request' } } }, fence())
    if (operation === 'begin') return store.beginResume(row.agentId)
    if (operation === 'finish') return store.finishResume(row.agentId, token, fence())
    if (operation === 'supersede') return store.supersede(row.agentId)
    return store.remove(row.agentId)
  }
  expect(run).toThrow(); expect(bytes()).toBe(before)
  expect(existsSync(join(directory, `${row.agentId}.resume`))).toBe(true)
})

it.each(['legacy-version', 'future-version', 'unknown-field', 'missing-role', 'agent', 'target', 'request', 'token', 'active', 'link', 'revoked', 'replacement'])('holds a transferred archive with %s corruption', kind => {
  const { transfer } = transferredArchive(), raw = JSON.parse(bytes())
  if (kind === 'legacy-version') raw.version = 1
  if (kind === 'future-version') raw.version = 3
  if (kind === 'unknown-field') raw.extra = true
  if (kind === 'missing-role') delete raw.nativeTransfer
  if (kind === 'agent') raw.nativeTransfer.link.agentId = 'another-agent'
  if (kind === 'target') raw.nativeTransfer.link.target = 'b'.repeat(64)
  if (kind === 'request') raw.nativeTransfer.link.requestId = 'different-resume-request'
  if (kind === 'token') raw.nativeTransfer.link.launchToken = 'different-launch-token'
  if (kind === 'active') raw.session.active = true
  if (kind === 'link') raw.session.nativeArchive = transfer.link
  if (kind === 'revoked') raw.session.nativeControl.rearm.revoked = true
  if (kind === 'replacement') raw.session.nativeControl.rearm.replacement = { processKey: transfer.processKey, sessionId: row.sessionId }
  writeFileSync(file, JSON.stringify(raw), { mode: 0o600 })
  const before = bytes()
  expect(() => store.get(row.agentId)).toThrow('Could not read')
  expect(() => store.nativeTransfer(row.agentId)).toThrow('Could not read')
  expect(() => store.save(row)).toThrow()
  expect(() => store.readNativeControl(raw.session)).toThrow()
  expect(() => store.commitNativeControl(raw.session, { ...raw.session.nativeControl,
    rearm: { ...raw.session.nativeControl.rearm, revoked: true }, cancel: { ...raw.session.nativeControl.cancel,
      request: { ...raw.session.nativeControl.cancel.request, requestId: 'another-cancel-request' } } }, fence())).toThrow()
  expect(bytes()).toBe(before)
})

it('preserves a pending launch when a later archive snapshot or repair is stale', () => {
  const next = reservation(row), saved = commit(row, next, () => {})
  const before = bytes()
  expect(() => store.save(row)).toThrow('original saved native cancellation')
  expect(bytes()).toBe(before)
  store.save({ ...saved, title: 'Updated title' })
  expect(store.get(row.agentId)).toMatchObject({ title: 'Updated title', nativeControl: next })
})

it('a legacy envelope cannot grant saved authority to a live archive-linked session', () => {
  const { reserved, transfer } = transferredArchive()
  const linked = { ...reserved, nativeArchive: transfer.link }
  writeFileSync(file, JSON.stringify({ version: 1, session: linked }), { mode: 0o600 })
  const before = bytes()
  expect(() => store.get(row.agentId)).toThrow('Could not read')
  expect(() => store.readNativeControl(linked)).toThrow('Invalid saved state')
  expect(() => store.commitNativeControl(linked, linked.nativeControl!, fence())).toThrow('Invalid saved state')
  expect(() => store.save(reserved)).toThrow('Could not read')
  expect(bytes()).toBe(before)
})

it('a stale independent store cannot replace a newer reservation', async () => {
  const { StoppedAgentStore } = await import('./stoppedAgents.js'), peer = new StoppedAgentStore(directory)
  const stale = peer.get(row.agentId)!
  commit(row, reservation(row), () => {})
  const before = bytes()
  expect(() => peer.commitNativeControl(stale, reservation(stale, 'a-different-request'), fence())).toThrow('owner changed')
  expect(() => peer.save(stale)).toThrow('original saved native cancellation')
  expect(bytes()).toBe(before)
})

it('an uncertain publication cannot roll back, renew its token or escape through ordinary writes', () => {
  const next = reservation(row)
  fault.failDirectory = true
  expect(() => commit(row, next, () => {})).toThrow('directory sync')
  const published = bytes()
  expect(JSON.parse(published).session.nativeControl).toEqual(next)
  fault.failDirectory = false
  expect(() => store.save(row)).toThrow('original saved native control publication')
  expect(() => store.patch(row.agentId, { cwd: '/fixture/changed' })).toThrow('original saved native control publication')
  expect(() => store.readNativeControl(store.get(row.agentId)!)).toThrow('original saved native control publication')
  expect(() => commit(row, { ...next, rearm: { ...next.rearm!, launchToken: 'replacement-launch-token' } }, () => {}))
    .toThrow('exact original saved native control publication')
  expect(bytes()).toBe(published)
  const resumed = commit(row, next, () => {})
  expect(bytes()).toBe(published)
  expect(store.readNativeControl(resumed).intent).toEqual(next)
})

it('does not overwrite a peer image while confirming an uncertain publication', () => {
  const next = reservation(row)
  fault.failDirectory = true
  expect(() => commit(row, next, () => {})).toThrow()
  fault.failDirectory = false
  const peer = JSON.parse(bytes()); peer.session.title = 'A newer peer title'
  writeFileSync(file, JSON.stringify(peer), { mode: 0o600 })
  const before = bytes()
  expect(() => commit(row, next, () => {})).toThrow('exact original saved native control publication')
  expect(bytes()).toBe(before)
})

it('confirms the exact prior request after another store observes rename before sync', async () => {
  const next = reservation(row)
  fault.failDirectory = true
  expect(() => commit(row, next, () => {})).toThrow()
  fault.failDirectory = false
  const { StoppedAgentStore } = await import('./stoppedAgents.js'), peer = new StoppedAgentStore(directory)
  const recovered = peer.commitNativeControl(row, next, fence())
  expect(peer.readNativeControl(recovered).intent).toEqual(next)
})

it('a failed external fence leaves the original bytes intact and can retry only its frozen request', () => {
  const next = reservation(row), before = bytes()
  expect(() => commit(row, next, () => { throw Error('receipt revoked') })).toThrow('receipt revoked')
  expect(bytes()).toBe(before)
  const saved = commit(row, next, () => {})
  expect(saved.nativeControl).toEqual(next)
})

it('checks the original saved image again after the final external fence', () => {
  const next = reservation(row)
  let calls = 0
  expect(() => commit(row, next, () => {
    if (++calls !== 2) return
    writeFileSync(file, bytes().replace('Fixture', 'Changed'), { mode: 0o600 })
  })).toThrow()
  expect(store.get(row.agentId)!.nativeControl).toEqual(row.nativeControl)
})

it('never clears a native resume reservation by age or without exact handoff authority', () => {
  const token = store.beginResume(row.agentId)!
  expect(token).toBeTruthy()
  expect(() => store.finishResume(row.agentId)).toThrow('exact native resume handoff')
  expect(() => store.finishResume(row.agentId, token)).toThrow('exact native resume handoff')
  expect(() => store.finishResume(row.agentId, token, fence(() => { throw Error('handoff unavailable') }))).toThrow('handoff unavailable')
  expect(store.beginResume(row.agentId)).toBeNull()
  store.finishResume(row.agentId, 'different-token', fence())
  expect(store.beginResume(row.agentId)).toBeNull()
  store.finishResume(row.agentId, token, fence())
  expect(store.resumeReservedAt(row.agentId)).toBeNull()
})

it('will not automatically supersede an archive that retains native cancellation', () => {
  const before = bytes()
  expect(() => store.supersede(row.agentId)).toThrow('cannot be superseded automatically')
  expect(bytes()).toBe(before)
})

it('Stop can finish a cancelled archive that never reserved a resume', () => {
  const before = bytes()
  expect(() => store.finishResume(row.agentId)).not.toThrow()
  expect(bytes()).toBe(before)
  expect(store.resumeReservedAt(row.agentId)).toBeNull()
})

it('a missing receipt proof is not mistaken for a missing resume marker', () => {
  const token = store.beginResume(row.agentId)!, marker = readFileSync(join(directory, `${row.agentId}.resume`), 'utf8')
  expect(() => store.finishResume(row.agentId, token, fence(() => {
    throw Object.assign(Error('original receipt unavailable'), { code: 'ENOENT' })
  }))).toThrow('original receipt unavailable')
  expect(readFileSync(join(directory, `${row.agentId}.resume`), 'utf8')).toBe(marker)
})

it('an older live archive cannot undo a newer Cancel that revoked its pending rearm', () => {
  const reserved = commit(row, reservation(row), () => {})
  const revoked: NativeTurnIntent = { ...reserved.nativeControl!, cancel: {
    ...cancel().cancel, request: { ...cancel().cancel.request, requestId: 'another-cancel-request' },
  }, rearm: { ...reserved.nativeControl!.rearm!, revoked: true } }
  commit(reserved, revoked, () => {})
  const before = bytes()
  expect(() => store.save(reserved)).toThrow('original saved native cancellation')
  expect(() => store.save({ ...reserved, nativeControl: undefined })).toThrow('original saved native cancellation')
  expect(bytes()).toBe(before)
})

it('checks local revocation after the last file proof before rename', () => {
  const before = bytes()
  let revoked = false, calls = 0
  expect(() => store.commitNativeControl(row, reservation(row), fence(() => {
    if (++calls === 2) fault.inspected = path => { if (path === file) revoked = true }
  }, () => { if (revoked) throw Error('local owner revoked') }))).toThrow('local owner revoked')
  expect(bytes()).toBe(before)
  expect(fault.renamed).toBe(false)
})

it('checks local revocation after the last file proof before removing a resume marker', () => {
  const token = store.beginResume(row.agentId)!
  let revoked = false
  expect(() => store.finishResume(row.agentId, token, fence(() => {
    fault.inspected = path => { if (path.endsWith('.resume')) revoked = true }
  }, () => { if (revoked) throw Error('local owner revoked') }))).toThrow('local owner revoked')
  expect(store.beginResume(row.agentId)).toBeNull()
})

it('retains the original parent through publication and durability readback', () => {
  const next = reservation(row)
  fault.synced = () => {
    fault.synced = undefined
    const previous = `${directory}-previous`
    renameSync(directory, previous); mkdirSync(directory, { mode: 0o700 })
    writeFileSync(file, readFileSync(join(previous, 'agent.json')), { mode: 0o600 })
  }
  expect(() => commit(row, next, () => {})).toThrow('directory changed')
  expect(() => store.readNativeControl(store.get(row.agentId)!)).toThrow('original saved native control publication')
  expect(() => commit(row, next, () => {})).toThrow('directory changed')
})

it('retains the original ancestor route when the same archive directory is reparented during sync', () => {
  const next = reservation(row), previous = `${root}-previous`
  fault.synced = () => {
    fault.synced = undefined
    renameSync(root, previous); mkdirSync(root, { mode: 0o700 })
    renameSync(join(previous, 'stopped-agents'), directory)
  }
  try {
    expect(() => commit(row, next, () => {})).toThrow()
    expect(() => commit(row, next, () => {})).toThrow()
    expect(() => store.readNativeControl(store.get(row.agentId)!)).toThrow('original saved native control publication')
  } finally { rmSync(previous, { recursive: true, force: true }) }
})

it('does not confirm a file changed while its descriptor is being synced', () => {
  fault.fileSynced = () => {
    fault.fileSynced = undefined
    writeFileSync(file, bytes() + ' ', { mode: 0o600 })
  }
  expect(() => commit(row, reservation(row), () => {})).toThrow('changed during durability confirmation')
  expect(() => store.readNativeControl(store.get(row.agentId)!)).toThrow('original saved native control publication')
})

it.each(['truncated', 'unknown-version', 'invalid-control', 'different-agent'] as const)('preserves %s data instead of treating control as absent', kind => {
  const value = JSON.parse(bytes())
  if (kind === 'unknown-version') value.version = 2
  if (kind === 'invalid-control') value.session.nativeControl = {}
  if (kind === 'different-agent') value.session.agentId = 'other'
  writeFileSync(file, kind === 'truncated' ? '{' : JSON.stringify(value), { mode: 0o600 })
  const before = bytes()
  expect(() => store.get(row.agentId)).toThrow('Could not read')
  expect(() => store.save({ ...row, schemaVersion: 2, nativeControl: undefined })).toThrow('Could not read')
  expect(bytes()).toBe(before)
})

it('refuses malformed transitions, changed owners and public control files', () => {
  expect(() => commit(row, {} as NativeTurnIntent, () => {})).toThrow('Invalid saved native control transition')
  expect(() => store.readNativeControl({ ...row, agentId: '../invalid' })).toThrow('Invalid stopped harness identity')
  expect(() => store.readNativeControl({ ...row, sessionId: 'changed' })).toThrow('owner changed')
  expect(() => store.readNativeControl({ ...row, nativeControl: undefined })).toThrow('owner changed')
  chmodSync(file, 0o644)
  expect(() => store.readNativeControl(row)).toThrow('private saved state')
})

it('a fresh proof rejects a replacement parent directory even if the file bytes match', () => {
  const proof = store.readNativeControl(row)
  const previous = `${directory}-previous`
  renameSync(directory, previous); mkdirSync(directory, { mode: 0o700 })
  writeFileSync(file, readFileSync(join(previous, 'agent.json')), { mode: 0o600 })
  expect(() => proof.verify()).toThrow('directory changed')
})
