import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentCreationReceipts, creationFingerprint, type CreationConfirmationFence } from '../../lib/agentCreationReceipt.js'
import { nativeRearmRequest, nativeTurnTarget } from '../../lib/nativeTurnIntent.js'
import type { NativeArchiveTransfer } from '../../lib/nativeArchive.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import { appendNativeAllocation } from '../../lib/nativeAllocation.js'
import { createNativeRearmProof, type NativeRearmReplacementProof } from '../../engines/kit/nativeRearmProof.js'
import { createNativeRearmRecovery, type NativeRearmRecoveryDeps } from './nativeRearmRecovery.js'

const roots: string[] = []
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

async function fixture(count = 1, permissionMode?: 'full', placement: 'live' | 'saved' = 'live') {
  const root = mkdtempSync(join(tmpdir(), 'native-rearm-recovery-')); roots.push(root)
  const receipts = new AgentCreationReceipts(join(root, 'receipts'))
  const rows = new Map<string, RegisteredSession>(), savedRows = new Map<string, RegisteredSession>()
  const transfers = new Map<string, NativeArchiveTransfer>(), archiveEpochs = new Map<string, number>()
  const physical = vi.fn(), held = vi.fn(), events: string[] = []
  for (let n = 0; n < count; n++) {
    const row = { schemaVersion: 3, agentId: `agent-${n}`, engine: 'cursor', sessionId: `conversation-${n}`, registeredAt: 1, boundAt: 2,
      active: placement === 'live', cwd: '/fixture/project', transcriptPath: null, tmuxPane: `%${n + 1}`,
      primaryRuntimeKey: terminalRouteKey({ backend: 'tmux', paneId: `%${n + 1}` }),
      runtimes: [{ backend: 'tmux', paneId: `%${n + 1}` }], permissionMode: 'ask',
      processIdentity: { pid: 42 + n, executable: '<cursor>', startMarker: 'previous-birth' } } as RegisteredSession
    const target = nativeTurnTarget(row)
    row.nativeControl = { version: 1, cancel: { processKey: null, target, request: {
      requestId: `original-cancel-${n}`, nonce: 'original-cancel-nonce', agentId: row.agentId, conversationId: row.sessionId,
      frontier: { index: -1, digest: null },
    } }, rearm: { requestId: `original-native-rearm-${n}`, agentId: row.agentId, target, operation: 'resume', source: placement,
      launchToken: `original-native-token-${n}`, ...(permissionMode ? { permissionMode } : {}) } }
    ;(placement === 'live' ? rows : savedRows).set(row.agentId, row)
    const request = nativeRearmRequest(row.nativeControl)!, fingerprint = creationFingerprint({ kind: 'native-rearm',
      agentId: row.agentId, operation: 'resume', source: placement, ...(permissionMode ? { permissionMode } : {}) })
    await receipts.runIntent(row.nativeControl.rearm!.requestId, fingerprint, request, { service: 'native', detail: 'Preparing' }, async () => async () => {
      physical()
      receipts.recordNativeRelaunchProcess(row.nativeControl!.rearm!.requestId, { fingerprint, request },
        { boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', pid: 100 + n, birth: '123456' }, { verify() {}, current() {} })
      return { state: 'unconfirmed' }
    })
  }
  const row = (n = 0) => (rows.get(`agent-${n}`) ?? savedRows.get(`agent-${n}`))!
  const retained = (input: RegisteredSession) => {
    const expected = structuredClone(input)
    const verify = () => {
      const current = placement === 'saved' && !expected.nativeArchive ? savedRows.get(expected.agentId) : rows.get(expected.agentId)
      if (!current || nativeTurnTarget(current) !== nativeTurnTarget(expected)
        || creationFingerprint(current.nativeControl ?? null) !== creationFingerprint(expected.nativeControl ?? null)) throw Error('Original row changed')
    }
    verify()
    return { intent: expected.nativeControl, verify, verifyDirectory: () => {} }
  }
  const evidence = (input: RegisteredSession, fence: CreationConfirmationFence): NativeRearmReplacementProof => {
    const n = Number(input.agentId.slice(6)), witness = receipts.readNativeRelaunchProcess(input.nativeControl!.rearm!.requestId, {
      fingerprint: creationFingerprint({ kind: 'native-rearm', agentId: input.agentId, operation: 'resume', source: placement,
        ...(permissionMode ? { permissionMode } : {}) }), request: nativeRearmRequest(input.nativeControl!)!,
    })
    const current = () => { events.push('native-current'); fence.current() }
    return { key: `original-boot\0cursor\0${100 + n}\0original-birth`, evidence: 'native-image', pane: placement === 'saved' && !input.nativeArchive ? `%${100 + n}` : input.tmuxPane,
      source: { target: nativeTurnTarget(input), controlFingerprint: creationFingerprint(input.nativeControl), requestFingerprint: 'fixture' },
      processIdentity: { pid: 100 + n, executable: '<cursor>', startMarker: 'original-birth' }, current,
      verify() { events.push('native-source'); witness.verify(); fence.verify(); current() },
      verifyExecution() { events.push('native-exec'); witness.verify(); current() },
      verifyConfirmation() { events.push('native-confirm'); witness.verifyConfirmation(); current() },
    }
  }
  type Read = (...args: Parameters<NativeRearmRecoveryDeps['proof']>) => Promise<NativeRearmReplacementProof>
  const bound = vi.fn<Read>(
    async (row, _receipt, fence) => evidence(row, fence))
  const unbound = vi.fn<Read>(async (row, _receipt, fence) => evidence(row, fence))
  const track = (read: Read) => (...args: Parameters<Read>) => {
    const promise = read(...args)
    return Object.assign(promise, { settled: promise.then(() => {}, () => {}) })
  }
  const savedProof = vi.fn(track(unbound))
  const proof = Object.assign(track(bound), { recover: track(unbound), recoverSaved: savedProof })
  const commit = vi.fn<NativeRearmRecoveryDeps['registry']['commitNativeReplacement']>((input, native, current) => {
    retained(input).verify(); native.verify(); current()
    events.push('commit')
    const link = { version: 1 as const, agentId: input.agentId, requestId: input.nativeControl!.rearm!.requestId,
      launchToken: input.nativeControl!.rearm!.launchToken, target: input.nativeControl!.rearm!.target }
    const route = { nativeArchive: link, runtimes: [{ backend: 'tmux' as const, paneId: native.pane }],
      primaryRuntimeKey: `tmux\0${native.pane}`, tmuxPane: native.pane }
    const result: RegisteredSession = { ...structuredClone(input), ...(placement === 'saved' ? route : {}), processIdentity: { ...native.processIdentity }, active: true, launch: { state: 'ready' },
      schemaVersion: 4, nativeAllocation: appendNativeAllocation(input.nativeAllocation, {
        fingerprint: creationFingerprint({ kind: 'native-rearm', agentId: input.agentId, operation: 'resume', source: placement,
          ...(permissionMode ? { permissionMode } : {}) }), request: nativeRearmRequest(input.nativeControl!)!,
      }),
      ...(permissionMode ? { permissionMode, bypassPermission: true } : {}),
      nativeControl: { ...input.nativeControl!, rearm: { ...input.nativeControl!.rearm!,
        replacement: { processKey: native.key, sessionId: input.sessionId } } },
    }
    rows.set(input.agentId, result)
    if (placement === 'saved') {
      transfers.set(input.agentId, { version: 1, link, pendingTarget: nativeTurnTarget({ ...input, ...route, active: false, processIdentity: null }),
        processKey: native.key, pane: native.pane })
      archiveEpochs.set(input.agentId, (archiveEpochs.get(input.agentId) ?? 0) + 1)
      native.verifyExecution(); current()
    }
    return result
  })
  const confirmOriginal = receipts.confirmNativeRelaunch.bind(receipts)
  const read = vi.fn(retained), source = vi.fn(retained), confirm = vi.spyOn(receipts, 'confirmNativeRelaunch')
  const savedSource = vi.fn<NativeRearmRecoveryDeps['saved']['readNativeResumeSource']>(input => {
    if (input.active || input.nativeArchive) throw Error('Not an original saved source')
    const proof = retained(input), epoch = archiveEpochs.get(input.agentId) ?? 0
    return { transfer: transfers.get(input.agentId), verifyDirectory() {}, verify() {
      proof.verify(); if ((archiveEpochs.get(input.agentId) ?? 0) !== epoch) throw Error('Original saved leaf consumed')
    } }
  })
  const commitSaved = vi.fn<NativeRearmRecoveryDeps['registry']['commitNativeSavedReplacement']>((input, proof, _saved, current) => commit(input, proof, current))
  const absent = vi.fn((id: string) => {
    const verify = () => { if (rows.has(id)) throw Error('A live route exists') }; verify(); return { verify }
  })
  const deps: NativeRearmRecoveryDeps = { registry: { byAgent: id => rows.get(id), readNativeAbsence: absent, readNativeControl: read,
    readNativeReplacementSource: source, commitNativeReplacement: commit, commitNativeSavedReplacement: commitSaved },
    saved: { get: id => savedRows.get(id) ?? null, readNativeResumeSource: savedSource, withNativeResume() { throw Error('Only the real Registry uses the archive transaction') } },
    receipts, proof, held }
  const controller = createNativeRearmRecovery(deps)
  return { rows, savedRows, transfers, archiveEpochs, row, deps, controller, physical, held, events, evidence, unbound, bound, savedProof, commit, commitSaved, read, source, savedSource, absent, confirm, confirmOriginal, receipts }
}

it.each([undefined, 'full'] as const)('confirms the original dispatch and recovers its confirmed image without launching again (%s)', async permission => {
  const p = await fixture(1, permission), original = structuredClone(p.row()), input = structuredClone(original)
  expect(await p.controller.recover(input)).toEqual({ state: 'created', agentId: original.agentId, resumed: true })
  expect(p.source).toHaveBeenCalledOnce(); expect(p.unbound).toHaveBeenCalledOnce()
  expect(p.row().processIdentity?.pid).toBe(100)
  expect(p.row().permissionMode).toBe(permission ?? 'ask')
  expect(p.row().nativeControl?.cancel).toEqual(original.nativeControl!.cancel)
  expect(p.row().nativeControl?.rearm).toMatchObject(original.nativeControl!.rearm!)
  expect(input).toEqual(original)
  expect(p.events.indexOf('native-source')).toBeLessThan(p.events.indexOf('commit'))
  expect(p.events.lastIndexOf('native-exec')).toBeGreaterThan(p.events.indexOf('commit'))
  expect(await createNativeRearmRecovery(p.deps).recover(p.row())).toEqual({ state: 'created', agentId: original.agentId, resumed: true })
  expect(p.bound).not.toHaveBeenCalled(); expect(p.commit).toHaveBeenCalledOnce(); expect(p.physical).toHaveBeenCalledOnce()
  expect(p.receipts.status(original.nativeControl!.rearm!.requestId).state).toBe('created')
})

it('recovers a crash between durable replacement and creation confirmation without another commit', async () => {
  const p = await fixture()
  p.confirm.mockImplementationOnce(() => { throw Error('Confirmation unavailable') })
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('Confirmation unavailable') } })
  expect(p.row().nativeControl?.rearm?.replacement).toBeDefined()
  expect(await createNativeRearmRecovery(p.deps).recover(p.row())).toMatchObject({ state: 'created', resumed: true })
  expect(p.commit).toHaveBeenCalledOnce(); expect(p.physical).toHaveBeenCalledOnce()
})

it.each([undefined, 'full'] as const)('recovers a saved Resume across the consumed archive leaf (%s)', async permission => {
  const p = await fixture(1, permission, 'saved'), original = structuredClone(p.row())
  expect(await p.controller.recover(original)).toEqual({ state: 'created', agentId: 'agent-0', resumed: true })
  expect(p.commitSaved).toHaveBeenCalledOnce(); expect(p.source).not.toHaveBeenCalled()
  expect(p.savedProof).toHaveBeenCalledOnce()
  expect(p.row().tmuxPane).toBe('%100'); expect(original.tmuxPane).toBe('%1')
  expect(p.row().nativeArchive).toMatchObject({ requestId: original.nativeControl!.rearm!.requestId })
  expect(p.savedSource).toHaveBeenCalledTimes(2)
  expect(p.physical).toHaveBeenCalledOnce()
  p.rows.clear(); p.savedRows.clear()
  expect(await createNativeRearmRecovery(p.deps).recover(original)).toEqual({ state: 'created', agentId: 'agent-0', resumed: true })
  expect(p.unbound).toHaveBeenCalledOnce(); expect(p.bound).not.toHaveBeenCalled(); expect(p.savedSource).toHaveBeenCalledTimes(2)
})

it('confirms an admitted saved replacement after a core crash without reusing the old admission leaf', async () => {
  const p = await fixture(1, 'full', 'saved')
  p.confirm.mockImplementationOnce(() => { throw Error('Confirmation unavailable') })
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending' })
  expect(p.transfers.size).toBe(1); expect(p.row().nativeControl!.rearm!.replacement).toBeDefined()
  expect(await createNativeRearmRecovery(p.deps).recover(p.row())).toMatchObject({ state: 'created' })
  expect(p.bound).toHaveBeenCalledOnce(); expect(p.commitSaved).toHaveBeenCalledOnce(); expect(p.physical).toHaveBeenCalledOnce()
})

it('does not treat a pending live route as the original saved source', async () => {
  const p = await fixture(1, undefined, 'saved'), original = p.row(), rearm = original.nativeControl!.rearm!
  const pending = { ...original, nativeArchive: { version: 1 as const, agentId: original.agentId, requestId: rearm.requestId,
    launchToken: rearm.launchToken, target: rearm.target } }
  p.rows.set(original.agentId, pending)
  expect(await p.controller.recover(pending)).toMatchObject({ state: 'pending' })
  expect(p.unbound).not.toHaveBeenCalled(); expect(p.bound).not.toHaveBeenCalled(); expect(p.confirm).not.toHaveBeenCalled()
  expect(await p.controller.recover(original)).toMatchObject({ state: 'created' })
  expect(p.commitSaved).toHaveBeenCalledOnce()
})

it.each(['agent', 'session', 'process', 'target', 'request', 'link', 'permissions'])('rejects a %s changed by the replacement publisher before adopting its return', async changed => {
  const p = await fixture(1, 'full', 'saved'), publish = p.commit.getMockImplementation()!
  p.commit.mockImplementationOnce((...args) => {
    const row = publish(...args)
    if (changed === 'agent') row.agentId = 'successor-agent'
    if (changed === 'session') row.sessionId = 'successor-session'
    if (changed === 'process') row.processIdentity = { ...row.processIdentity!, pid: 101 }
    if (changed === 'target') row.cwd = '/fixture/successor'
    if (changed === 'request') row.nativeControl = { ...row.nativeControl!, rearm: { ...row.nativeControl!.rearm!, requestId: 'successor-native-request' } }
    if (changed === 'link') row.nativeArchive = { ...row.nativeArchive!, requestId: 'successor-native-request' }
    if (changed === 'permissions') row.permissionMode = 'ask'
    return row
  })
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('different owner') } })
  expect(p.confirm).not.toHaveBeenCalled(); expect(p.held).not.toHaveBeenCalled()
})

it.each(['missing-source', 'missing-control', 'request', 'missing-transfer', 'link', 'process', 'pane', 'pending-target', 'live-link'])('holds a saved replacement whose retained %s changed', async changed => {
  const p = await fixture(1, 'full', 'saved')
  p.confirm.mockImplementationOnce(() => { throw Error('Confirmation unavailable') })
  await p.controller.recover(p.row())
  const original = p.savedRows.get('agent-0')!, transfer = p.transfers.get('agent-0')!
  if (changed === 'missing-source') p.savedRows.clear()
  if (changed === 'missing-control') delete original.nativeControl
  if (changed === 'request') original.nativeControl = { ...original.nativeControl!, rearm: { ...original.nativeControl!.rearm!, permissionMode: 'ask' } }
  if (changed === 'missing-transfer') p.transfers.clear()
  if (changed === 'link') p.transfers.set('agent-0', { ...transfer, link: { ...transfer.link, requestId: 'different-original-request' } })
  if (changed === 'process') p.transfers.set('agent-0', { ...transfer, processKey: 'different-process' })
  if (changed === 'pane') p.transfers.set('agent-0', { ...transfer, pane: '%999' })
  if (changed === 'pending-target') p.transfers.set('agent-0', { ...transfer, pendingTarget: 'f'.repeat(64) })
  if (changed === 'live-link') p.row().nativeArchive = { ...p.row().nativeArchive!, requestId: 'different-original-request' }
  expect(await createNativeRearmRecovery(p.deps).recover(p.row())).toMatchObject({ state: 'pending' })
  expect(p.confirm).toHaveBeenCalledOnce(); expect(p.physical).toHaveBeenCalledOnce()
})

it.each(['before', 'after'])('retains the transferred archive %s receipt publication', async phase => {
  const p = await fixture(1, undefined, 'saved'), confirm = p.confirmOriginal
  p.confirm.mockImplementationOnce((...args) => {
    if (phase === 'before') { p.archiveEpochs.set('agent-0', 2); return confirm(...args) }
    const status = confirm(...args); p.archiveEpochs.set('agent-0', 2); return status
  })
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending' })
  expect(p.receipts.status('original-native-rearm-0').state).toBe(phase === 'before' ? 'unconfirmed' : 'created')
  if (phase === 'after') {
    p.rows.clear(); p.savedRows.clear()
    const original = p.commitSaved.mock.calls[0][0]
    expect(await p.controller.recover(original)).toMatchObject({ state: 'created' })
    expect(p.unbound).toHaveBeenCalledOnce()
  }
})

it.each(['failure', 'throwing-status', 'non-error', 'final-proof'])('keeps unavailable confirmed receipt %s held without another engine probe', async mode => {
  const p = await fixture(); await p.controller.recover(p.row())
  if (mode === 'throwing-status') vi.spyOn(p.receipts, 'status').mockImplementationOnce(() => { throw Error('Receipt unavailable') })
  else if (mode === 'final-proof') vi.spyOn(p.receipts, 'readNativeRelaunchCompletion').mockReturnValueOnce({
    outcome: { state: 'created', agentId: 'agent-0', resumed: true }, verify() { throw Error('Receipt unavailable') },
  })
  else vi.spyOn(p.receipts, 'readNativeRelaunchCompletion').mockImplementationOnce(() => { throw mode === 'non-error' ? 'Receipt unavailable' : Error('Receipt unavailable') })
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('Receipt unavailable') } })
  expect(p.unbound).toHaveBeenCalledOnce(); expect(p.bound).not.toHaveBeenCalled(); expect(p.physical).toHaveBeenCalledOnce()
})

it('never publishes a saved hold over a newly discovered live successor', async () => {
  const p = await fixture(1, undefined, 'saved')
  p.unbound.mockRejectedValueOnce(Error('Native unavailable'))
  p.absent.mockImplementationOnce(() => ({ verify() { p.rows.set('agent-0', { ...p.row(), active: true }) } }))
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('Native unavailable') } })
  expect(p.held).not.toHaveBeenCalled(); expect(p.confirm).not.toHaveBeenCalled()
})

it('cannot let saved hold verification outlive Cancel or shutdown', async () => {
  const p = await fixture(1, undefined, 'saved')
  p.unbound.mockRejectedValueOnce(Error('Native unavailable'))
  p.absent.mockImplementationOnce(() => ({ verify() { p.controller.close() } }))
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending' })
  expect(p.held).not.toHaveBeenCalled()
})

it.each(['control', 'target', 'leaf'])('retains the saved %s after the final Registry absence proof before publishing a hold', async changed => {
  const p = await fixture(1, undefined, 'saved')
  p.unbound.mockRejectedValueOnce(Error('Native unavailable'))
  p.absent.mockImplementationOnce(() => ({ verify() {
    if (changed === 'control') p.row().nativeControl = { ...p.row().nativeControl!, rearm: { ...p.row().nativeControl!.rearm!, revoked: true } }
    if (changed === 'target') p.row().cwd = '/fixture/successor'
    if (changed === 'leaf') p.archiveEpochs.set('agent-0', 1)
  } }))
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending' })
  expect(p.held).not.toHaveBeenCalled(); expect(p.confirm).not.toHaveBeenCalled()
})

it.each(['control', 'target', 'missing'])('checks the current saved %s after retained hold evidence', async changed => {
  const p = await fixture(1, undefined, 'saved'), successor = structuredClone(p.row())
  p.unbound.mockRejectedValueOnce(Error('Native unavailable'))
  if (changed === 'control') successor.nativeControl = { ...successor.nativeControl!, rearm: { ...successor.nativeControl!.rearm!, revoked: true } }
  if (changed === 'target') successor.cwd = '/fixture/successor'
  vi.spyOn(p.deps.saved, 'get').mockReturnValueOnce(changed === 'missing' ? null : successor)
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending' })
  expect(p.held).not.toHaveBeenCalled()
})

it.each(['pending', 'created'] as const)('does not begin recovery after %s receipt preflight consumes the original deadline', async state => {
  const p = await fixture(), now = vi.spyOn(performance, 'now').mockReturnValue(100)
  vi.spyOn(p.receipts, 'status').mockImplementationOnce(() => { now.mockReturnValue(5100); return state === 'pending'
    ? { state, held: { service: 'native', detail: 'Waiting' } } : { state, agentId: 'agent-0', resumed: true } })
  const completed = vi.spyOn(p.receipts, 'readNativeRelaunchCompletion')
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('deadline') } })
  expect(completed).not.toHaveBeenCalled(); expect(p.unbound).not.toHaveBeenCalled(); expect(p.commit).not.toHaveBeenCalled()
})

it('retains the original deadline through completed receipt verification', async () => {
  const p = await fixture(), now = vi.spyOn(performance, 'now').mockReturnValue(100)
  vi.spyOn(p.receipts, 'status').mockReturnValueOnce({ state: 'created', agentId: 'agent-0', resumed: true })
  vi.spyOn(p.receipts, 'readNativeRelaunchCompletion').mockReturnValueOnce({
    outcome: { state: 'created', agentId: 'agent-0', resumed: true }, verify() { now.mockReturnValue(5100) },
  })
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('deadline') } })
  expect(p.unbound).not.toHaveBeenCalled()
})

it('arms the reply timer only for the remaining original deadline', async () => {
  const p = await fixture(), wait = deferred<void>()
  vi.useFakeTimers(); const now = vi.spyOn(performance, 'now').mockReturnValue(100)
  vi.spyOn(p.receipts, 'status').mockImplementationOnce(() => { now.mockReturnValue(3100); return { state: 'unconfirmed' } })
  p.unbound.mockImplementationOnce(async () => { await wait.promise; throw Error('Native unavailable') })
  let answer: unknown
  const pending = p.controller.recover(p.row()).then(value => { answer = value })
  await vi.advanceTimersByTimeAsync(1999); expect(answer).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(answer).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('deadline') } })
  wait.resolve(); await pending; await flush()
  expect(p.commit).not.toHaveBeenCalled()
})

it('returns a completed original launch while four unrelated actual reads remain occupied', async () => {
  const p = await fixture(5), waits = Array.from({ length: 4 }, () => deferred<void>())
  expect(await p.controller.recover(p.row(4))).toMatchObject({ state: 'created' }); await flush()
  p.unbound.mockImplementation(async row => { await waits[Number(row.agentId.slice(6))].promise; throw Error('Read unavailable') })
  const pending = [0, 1, 2, 3].map(n => p.controller.recover(p.row(n)))
  try {
    expect(await p.controller.recover(p.row(4))).toMatchObject({ state: 'created', agentId: 'agent-4' })
    expect(p.unbound).toHaveBeenCalledTimes(5); expect(p.bound).not.toHaveBeenCalled()
  } finally { p.controller.close(); waits.forEach(wait => wait.resolve()); await Promise.all(pending) }
})

it.each(['absent', 'non-cursor', 'unbound', 'no-rearm', 'incomplete', 'saved', 'revoked'])('holds %s reservations without native reads', async kind => {
  const p = await fixture(), row = p.row()
  if (kind === 'absent') delete row.nativeControl
  if (kind === 'non-cursor') row.engine = 'codex'
  if (kind === 'unbound') row.sessionId = ''
  if (kind === 'no-rearm') delete (row.nativeControl as { rearm?: unknown }).rearm
  if (kind === 'incomplete') delete (row.nativeControl!.rearm as { source?: unknown }).source
  if (kind === 'saved') row.nativeControl = { ...row.nativeControl!, rearm: { ...row.nativeControl!.rearm!, source: 'saved' } }
  if (kind === 'revoked') row.nativeControl = { ...row.nativeControl!, rearm: { ...row.nativeControl!.rearm!, revoked: true } }
  expect(await p.controller.recover(row)).toMatchObject({ state: 'pending' })
  expect(p.unbound).not.toHaveBeenCalled(); expect(p.confirm).not.toHaveBeenCalled()
})

it.each(['cancel', 'target', 'removed', 'revoke', 'close', 'deadline'])('revokes a delayed proof after %s', async kind => {
  const p = await fixture(), wait = deferred<void>(), now = vi.spyOn(performance, 'now').mockReturnValue(100)
  p.unbound.mockImplementationOnce(async (row, _receipt, fence) => { const proof = p.evidence(row, fence); await wait.promise; return proof })
  const pending = p.controller.recover(p.row())
  if (kind === 'cancel') p.row().nativeControl = { ...p.row().nativeControl!, rearm: { ...p.row().nativeControl!.rearm!, revoked: true } }
  if (kind === 'target') p.row().tmuxPane = '%99'
  if (kind === 'removed') p.rows.clear()
  if (kind === 'revoke') { p.controller.revoke('missing'); p.controller.revoke('agent-0') }
  if (kind === 'close') p.controller.close()
  if (kind === 'deadline') now.mockReturnValue(5100)
  wait.resolve()
  expect(await pending).toMatchObject({ state: 'pending' })
  expect(p.commit).not.toHaveBeenCalled(); expect(p.confirm).not.toHaveBeenCalled()
  if (['cancel', 'target', 'removed', 'revoke', 'close'].includes(kind)) expect(p.held).not.toHaveBeenCalled()
})

it('checks the original owner after source verification and before native inspection', async () => {
  const p = await fixture()
  p.source.mockImplementationOnce(input => { p.row().active = false; return { intent: input.nativeControl, verify() {}, verifyDirectory() {} } })
  p.unbound.mockImplementationOnce(async (row, _request, fence) => { fence.verify(); return p.evidence(row, fence) })
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending' })
  expect(p.commit).not.toHaveBeenCalled()
})

it.each(['native-source', 'native-exec', 'native-confirm', 'published', 'receipt-current', 'post-receipt'])('retains %s evidence through confirmation', async kind => {
  const p = await fixture()
  p.unbound.mockImplementationOnce(async (row, _request, fence) => {
    const native = p.evidence(row, fence)
    if (kind === 'native-source') return { ...native, verify() { throw Error('Original native source changed') } }
    if (kind === 'native-exec') return { ...native, verifyExecution() { throw Error('Original exec changed') } }
    if (kind === 'native-confirm') return { ...native, verifyConfirmation() { throw Error('Original confirming witness changed') } }
    if (kind === 'receipt-current') {
      const current = native.current
      return { ...native, current() { current(); p.controller.revoke('agent-0') } }
    }
    return native
  })
  if (kind === 'published') p.read.mockImplementationOnce(input => ({ intent: input.nativeControl, verify() { throw Error('Published image changed') }, verifyDirectory() {} }))
  if (kind === 'post-receipt') {
    const confirm = p.confirmOriginal
    p.confirm.mockImplementationOnce((...args) => { const answer = confirm(...args); p.row().active = false; return answer })
  }
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending' })
  if (kind === 'native-source') expect(p.commit).not.toHaveBeenCalled()
  if (['native-source', 'native-exec', 'published'].includes(kind)) expect(p.confirm).not.toHaveBeenCalled()
})

it('returns a held reason for non-Error native failures', async () => {
  const p = await fixture(); p.unbound.mockRejectedValueOnce('Native evidence unavailable')
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('Native evidence unavailable') } })
})

it.each(['live', 'saved'] as const)('keeps all four actual %s read slots after bounded replies, and releases only a settled original read', async placement => {
  const p = await fixture(5, undefined, placement), waits = Array.from({ length: 4 }, () => deferred<void>())
  vi.useFakeTimers()
  p.unbound.mockImplementation(async (row, _request, fence) => {
    const native = p.evidence(row, fence), n = Number(row.agentId.slice(6))
    if (n < waits.length) await waits[n].promise
    return native
  })
  const input = structuredClone(p.row()), pending = [p.controller.recover(input), ...[1, 2, 3].map(n => p.controller.recover(p.row(n)))]
  input.agentId = 'changed-by-caller'
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('occupied') } })
  expect(await p.controller.recover(p.row(4))).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('occupied') } })
  await vi.advanceTimersByTimeAsync(5000)
  expect((await Promise.all(pending)).map(status => status.state)).toEqual(['pending', 'pending', 'pending', 'pending'])
  expect(await p.controller.recover(p.row(4))).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('occupied') } })
  const publishedHolds = p.held.mock.calls.length
  waits[0].resolve(); await flush()
  expect(p.held.mock.calls.length).toBe(publishedHolds)
  expect(await p.controller.recover(p.row(4))).toMatchObject({ state: 'created' })
  expect(p.unbound).toHaveBeenCalledTimes(5); expect(p.commit).toHaveBeenCalledOnce()
  p.controller.close()
  waits.slice(1).forEach(wait => wait.resolve()); await flush()
  expect(p.commit).toHaveBeenCalledOnce()
})

it('does not admit new recovery or publish holds after shutdown', async () => {
  const p = await fixture(); p.controller.close()
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending' })
  expect(p.held).not.toHaveBeenCalled(); expect(p.unbound).not.toHaveBeenCalled()
})

it('retains four real reader observations after their own earlier reply deadline', async () => {
  const p = await fixture(5), waits = Array.from({ length: 5 }, () => deferred<void>())
  const probe = vi.fn(async () => { const n = probe.mock.calls.length - 1; await waits[n].promise; throw Error('Expired native read') })
  const inspect = vi.fn(async () => { throw Error('No native process may be inspected after the expired probe') })
  const proof = createNativeRearmProof({ receipts: p.receipts, owner: 'a'.repeat(16),
    boot: async () => 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    pane: async () => ({ rootPid: 10, command: 'original-command' }), probe, inspect })
  const controller = createNativeRearmRecovery({ ...p.deps, proof })
  vi.useFakeTimers()
  const pending = [0, 1, 2, 3].map(n => controller.recover(p.row(n)))
  try {
    await flush(); expect(probe).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(3001)
    expect((await Promise.all(pending)).every(status => status.state === 'pending')).toBe(true)
    const refused = controller.recover(p.row(4)); pending.push(refused); await flush()
    expect(probe).toHaveBeenCalledTimes(4)
    expect(await refused).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('occupied') } })
    waits[0].resolve(); await flush()
    const fifth = controller.recover(p.row(4)); pending.push(fifth); await flush()
    expect(probe).toHaveBeenCalledTimes(5)
    controller.close()
    waits.slice(1).forEach(wait => wait.resolve()); await flush()
    expect(await fifth).toMatchObject({ state: 'pending' })
    expect(inspect).not.toHaveBeenCalled(); expect(p.commit).not.toHaveBeenCalled()
  } finally {
    controller.close(); waits.forEach(wait => wait.resolve())
    await vi.runOnlyPendingTimersAsync(); await Promise.all(pending)
  }
})

it('does not let a revoked read publish a hold when its reply timer expires', async () => {
  const p = await fixture(), wait = deferred<void>()
  p.unbound.mockImplementationOnce(async (row, _receipt, fence) => { const proof = p.evidence(row, fence); await wait.promise; return proof })
  vi.useFakeTimers()
  const pending = p.controller.recover(p.row())
  p.controller.revoke('agent-0')
  await vi.advanceTimersByTimeAsync(5000)
  expect(await pending).toMatchObject({ state: 'pending' })
  expect(p.held).not.toHaveBeenCalled()
  wait.resolve(); await flush()
  expect(p.held).not.toHaveBeenCalled(); expect(p.commit).not.toHaveBeenCalled()
})

it('requires the exact confirmation publisher to retain its final proof', async () => {
  const p = await fixture()
  p.confirm.mockReturnValueOnce({ state: 'created', agentId: 'agent-0', resumed: true })
  expect(await p.controller.recover(p.row())).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('confirmation proof is unavailable') } })
})

it.each(['native-failure', 'timeout'])('settles %s even when the held notification throws', async kind => {
  const p = await fixture(), wait = deferred<void>()
  p.held.mockImplementation(() => { throw Error('Presentation failed') })
  p.unbound.mockImplementationOnce(async () => { if (kind === 'timeout') await wait.promise; throw Error('Read failed') })
  vi.useFakeTimers()
  const pending = p.controller.recover(p.row())
  if (kind === 'timeout') await vi.advanceTimersByTimeAsync(5000)
  expect(await pending).toMatchObject({ state: 'pending', held: { service: 'native' } })
  expect(p.held).toHaveBeenCalledOnce()
  wait.resolve(); await flush()
  expect(p.commit).not.toHaveBeenCalled(); expect(p.confirm).not.toHaveBeenCalled()
})
