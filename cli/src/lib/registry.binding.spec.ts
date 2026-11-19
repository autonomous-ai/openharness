import { closeSessionStorageFixture } from '../testing/sessionStorageFixture.js'
import { unbindRegistrySession } from '../testing/registryFixtures.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))
// A registry image flush that outlives every real wait from 250 ms up to the 5 s write deadline, as a loaded
// disk's does: each one still running fires as the sync returns, if not before.
const slowSync = vi.hoisted(() => ({ due: new Map<unknown, () => void>() }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args), sync = handle.sync.bind(handle)
    handle.sync = async () => {
      await sync()
      if (!(String(args[0]).includes('registry.json.') && String(args[0]).endsWith('.tmp'))) return
      for (const [timer, fire] of slowSync.due) { slowSync.due.delete(timer); fire() }
    }
    return handle
  } }
})
const realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout
function slowTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) {
  if (ms === undefined || ms < 250 || ms > 5_000) return realTimeout(callback, ms, ...args)
  const timer = realTimeout(() => { slowSync.due.delete(timer); callback(...args) }, ms)
  slowSync.due.set(timer, () => { realClear(timer); callback(...args) })
  return timer
}
// The registry expires a write after 5 s. No test here means to, so that timer is never scheduled: how fast this
// machine writes the registry never fails these tests.
function ownedTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) {
  return ms === 5_000 ? realTimeout(() => {}, 0) : slowTimeout(callback, ms, ...args)
}
let root: string, home: string, file: string, registry: typeof import('./registry.js')['registry']
const stores = new Set<typeof import('./sessionStorage.js')['sessionStorage']>()
const registries = new Set<typeof import('./registry.js')['registry']>()
async function loadRegistry() {
  vi.resetModules()
  stores.add((await import('./sessionStorage.js')).sessionStorage)
  ;({ registry } = await import('./registry.js'))
  registries.add(registry)
}
const ids = ['aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb']
const header = (id: string) => JSON.stringify({ type: 'session_meta', payload: { id, cwd: root, source: 'cli' } }) + '\n'
const transcript = (index: number) => join(home, 'sessions', `rollout-${ids[index]}.jsonl`)
beforeEach(async () => {
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(ownedTimeout as typeof setTimeout)
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((timer?: Parameters<typeof clearTimeout>[0]) => {
    slowSync.due.delete(timer); realClear(timer)
  }) as typeof clearTimeout)
  root = realpathSync(mkdtempSync(join(tmpdir(), 'registry-binding-'))); home = join(root, 'codex'); file = join(root, 'data', 'registry.json')
  vi.stubEnv('ADAPTER_DATA_DIR', join(root, 'data')); vi.stubEnv('CODEX_HOME', home)
  mkdirSync(join(root, 'data')); mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(join(root, 'data', 'engine-homes.json'), '{}')
  const rows = ids.map((id, index) => {
    writeFileSync(transcript(index), header(id))
    return { launcherId: `fixture-${index}`, engine: 'codex', sessionId: id, transcriptPath: transcript(index), tmuxPane: `%${index + 1}`,
      projectDir: 'fixture', cwd: root, processIdentity: null, registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1 }
  })
  writeFileSync(file, JSON.stringify(rows), { mode: 0o600 })
  await loadRegistry()
  await registry.load()
  await registry.flush()
})
afterEach(async () => {
  await Promise.allSettled([...registries].map(current => current.flush({ exiting: true })))
  registries.clear()
  const closed = await Promise.allSettled([...stores].map(closeSessionStorageFixture))
  stores.clear()
  vi.restoreAllMocks(); slowSync.due.clear(); vi.doUnmock('../engines/transcriptBindings.js'); vi.unstubAllEnvs(); vi.resetModules()
  const failures = closed.filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length) throw new AggregateError(failures, 'binding fixture cleanup failed')
  rmSync(root, { recursive: true, force: true })
})

it.each(['', '{', 'wrong-id'])('holds a saved unreadable identity (%s), preserves its bytes, and retries without restarting', async text => {
  const before = readFileSync(file, 'utf8')
  writeFileSync(transcript(0), text === 'wrong-id' ? header(ids[1]!) : text)
  await registry.load()
  expect(registry.byAgent('fixture-0')).toMatchObject({ sessionId: ids[0], transcriptPath: transcript(0), identityHold: expect.any(String) })
  expect(registry.byAgent('fixture-1')).toMatchObject({ sessionId: ids[1], transcriptPath: transcript(1) })
  expect(registry.byAgent('fixture-1')).not.toHaveProperty('identityHold')
  expect(readFileSync(file, 'utf8')).toBe(before)
  await expect((async () => (await registry.revalidateBinding('fixture-0')))()).rejects.toThrow()
  expect(registry.byAgent('fixture-0')?.sessionId).toBe(ids[0])
  writeFileSync(transcript(0), header(ids[0]!))
  expect((await registry.revalidateBinding('fixture-0'))).not.toHaveProperty('identityHold')
  expect(readFileSync(file, 'utf8')).toBe(before)
  rmSync(transcript(0))
  expect((await registry.revalidateBinding('fixture-0'))).toMatchObject({ sessionId: '', transcriptPath: null })
  expect(registry.bySession(ids[0]!)).toBeUndefined()
  expect(registry.bySession(ids[1]!)).toBeDefined()
})

it('restores every affected staged row when the shared root changes after file verification', async () => {
  const before = readFileSync(file, 'utf8')
  vi.doMock('../engines/transcriptBindings.js', async original => {
    const actual = await original<typeof import('../engines/transcriptBindings.js')>()
    return { ...actual, transcriptRootEvidence: (...args: Parameters<typeof actual.transcriptRootEvidence>) => {
      const proof = actual.transcriptRootEvidence(...args)
      return { ...proof, retain() {
        const verify = proof.retain()
        return () => {
          renameSync(join(home, 'sessions'), join(home, 'previous')); mkdirSync(join(home, 'sessions'))
          verify()
        }
      } }
    } }
  })
  await loadRegistry(); await registry.load()
  for (const [index, id] of ids.entries()) expect(registry.byAgent(`fixture-${index}`)).toMatchObject({ sessionId: id,
    transcriptPath: transcript(index), identityHold: expect.stringContaining('changed') })
  expect(readFileSync(file, 'utf8')).toBe(before)
})

it('rechecks a leaf changed after its private initialization commitment before granting later authority', async () => {
  const before = readFileSync(file, 'utf8')
  vi.doMock('../engines/transcriptBindings.js', async original => {
    const actual = await original<typeof import('../engines/transcriptBindings.js')>()
    return { ...actual, savedTranscriptEvidence: (...args: Parameters<typeof actual.savedTranscriptEvidence>) => {
      const proof = actual.savedTranscriptEvidence(...args)
      if (args[1] === ids[1]) writeFileSync(transcript(0), header(ids[1]!))
      return proof
    } }
  })
  await loadRegistry(); await registry.load()
  expect(registry.byAgent('fixture-0')).toMatchObject({ sessionId: ids[0], transcriptPath: transcript(0) })
  await expect(registry.revalidateBinding('fixture-0')).rejects.toThrow('different conversation')
  expect(registry.byAgent('fixture-1')).not.toHaveProperty('identityHold')
  expect(readFileSync(file, 'utf8')).toBe(before)
})

it('keeps holds transient and only retries bindings that still exist', async () => {
  expect(registry.setIdentityHold('missing', 'pending')).toBe(false)
  expect((await registry.revalidateBinding('missing'))).toBeNull()
  expect(registry.setIdentityHold('fixture-0', '')).toBe(true)
  expect(registry.byAgent('fixture-0')?.identityHold).toBe('Waiting for conversation identity.')
  expect(registry.setIdentityHold('fixture-0', 'x'.repeat(2000))).toBe(true)
  expect(registry.byAgent('fixture-0')?.identityHold).toHaveLength(1024)
  expect(registry.setIdentityHold('fixture-0', 'x'.repeat(2000))).toBe(false)
  expect(registry.setIdentityHold('fixture-0')).toBe(true)
  ;(await unbindRegistrySession(registry, ids[0]!))
  expect((await registry.revalidateBinding('fixture-0'))).toMatchObject({ sessionId: '', transcriptPath: null })
})

it.each(['same', 'absent', 'repaired'] as const)('never overwrites a peer binding while retrying %s evidence', async outcome => {
  const binding = await import('../engines/transcriptBindings.js')
  const peer = new (registry.constructor as new () => typeof registry)()
  await peer.load()
  const original = registry.byAgent('fixture-0')!
  registry.setIdentityHold(original.agentId, 'waiting')
  if (outcome === 'absent') rmSync(transcript(0))
  if (outcome === 'repaired') {
    writeFileSync(transcript(0), JSON.stringify({ type: 'session_meta', payload: {
      id: 'cccccccc-3333-4333-8333-cccccccccccc', cwd: root,
      source: { subagent: { thread_spawn: { parent_thread_id: ids[0] } } },
    } }) + '\n')
    const parent = join(home, 'sessions', `rollout-${ids[0]}-parent.jsonl`)
    writeFileSync(parent, header(ids[0]!))
    await vi.waitFor(() => expect(binding.savedTranscriptEvidence('codex', ids[0]!, transcript(0), home).path).toBe(parent), { timeout: 3_000, interval: 25 })
  }
  const nextId = 'dddddddd-4444-4444-8444-dddddddddddd'
  const nextPath = join(home, 'sessions', `rollout-${nextId}.jsonl`)
  writeFileSync(nextPath, header(nextId))
  expect(await peer.register({ engine: 'codex', sessionId: nextId, transcriptPath: nextPath, tmuxPane: '%1', cwd: root })).not.toBeNull()
  const latest = readFileSync(file, 'utf8')
  // A parallel private fixture can change a shared ancestor during enumeration. Require a fresh
  // attempt to reach this exact durable-owner fence; an arbitrary native hold is not success.
  await vi.waitFor(async () => await expect((async () => (await registry.revalidateBinding(original.agentId)))()).rejects.toThrow('saved binding changed'), { timeout: 3_000, interval: 25 })
  expect(readFileSync(file, 'utf8')).toBe(latest)
  expect(registry.bySession(ids[0]!)).toBe(original)
  expect(original).toMatchObject({ sessionId: ids[0], transcriptPath: transcript(0), identityHold: 'waiting' })
  expect(peer.bySession(nextId)?.transcriptPath).toBe(nextPath)
  // Ordinary reconciliation can refresh the peer's commit because the failed retry changed no facts.
  ;(await registry.flush())
  expect(registry.byAgent(original.agentId)).toMatchObject({ sessionId: nextId, transcriptPath: nextPath })
  expect((await registry.revalidateBinding(original.agentId))?.sessionId).toBe(nextId)
})

it('commits a conclusive release inside a discovery batch before its callback continues', async () => {
  registry.setIdentityHold('fixture-0', 'waiting')
  rmSync(transcript(0))
  await registry.transaction(async () => {
    const saved = (await registry.revalidateBinding('fixture-0'))!
    expect(saved.sessionId).toBe('')
    expect(registry.bySession(ids[0]!)).toBeUndefined()
    expect(JSON.parse(readFileSync(file, 'utf8')).find((row: { agentId: string }) => row.agentId === saved.agentId).sessionId).toBe('')
    await Promise.resolve()
  })
})

it('rechecks native evidence while holding the registry write lock and publishes nothing on a failed fence', async () => {
  let retry = false, checked = false
  vi.doMock('../engines/transcriptBindings.js', async original => {
    const actual = await original<typeof import('../engines/transcriptBindings.js')>()
    return { ...actual, savedTranscriptEvidence: (...args: Parameters<typeof actual.savedTranscriptEvidence>) => {
      const proof = actual.savedTranscriptEvidence(...args)
      return { ...proof, verify() {
        if (retry) {
          checked = true
          expect(existsSync(`${file}.lock`)).toBe(true)
          writeFileSync(transcript(0), header(ids[1]!))
        }
        proof.verify()
      } }
    } }
  })
  await loadRegistry(); await registry.load()
  registry.setIdentityHold('fixture-0', 'waiting')
  const before = readFileSync(file, 'utf8')
  retry = true
  await expect((async () => (await registry.revalidateBinding('fixture-0')))()).rejects.toThrow()
  expect(checked).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(registry.bySession(ids[0]!)).toMatchObject({ identityHold: 'waiting', transcriptPath: transcript(0) })
})

it('retains monotonic recovery authority through register and save, and never persists interpretation state', async () => {
  const { transcriptReadIdentity } = await import('../core/transcripts/readIdentity.js')
  const original = registry.byAgent('fixture-0')!, before = transcriptReadIdentity(original)
  registry.setIdentityHold(original.agentId, 'waiting')
  const held = original.evidenceRevision!
  ;(await registry.register({ engine: 'codex', sessionId: ids[0]!, transcriptPath: transcript(0), tmuxPane: '%1', cwd: root }))
  expect(registry.byAgent(original.agentId)).toMatchObject({ evidenceRevision: held, identityHold: 'waiting' })
  const recovered = (await registry.revalidateBinding(original.agentId))!
  expect(recovered.evidenceRevision).toBeGreaterThan(held)
  expect(recovered.interpretationHold).toBeTruthy()
  expect(transcriptReadIdentity(recovered)).not.toBe(before)
  ;(await registry.flush())
  expect(registry.byAgent(original.agentId)).toEqual(recovered)
  expect(recovered.interpretationHold).toBeTruthy()
  const persisted = JSON.parse(readFileSync(file, 'utf8'))[0]
  for (const field of ['identityHold', 'interpretationHold', 'evidenceRevision']) expect(persisted).not.toHaveProperty(field)
  expect(registry.setInterpretationHold('missing', held)).toBe(false)
  expect(registry.setInterpretationHold(original.agentId, held)).toBe(false)
  expect(registry.setInterpretationHold(original.agentId, recovered.evidenceRevision, 'retry reader')).toBe(true)
  expect(registry.byAgent(original.agentId)?.interpretationHold).toBe('retry reader')
  expect(registry.setInterpretationHold(original.agentId, recovered.evidenceRevision)).toBe(true)
  expect(registry.setInterpretationHold(original.agentId, recovered.evidenceRevision)).toBe(false)
  expect(registry.byAgent(original.agentId)?.interpretationHold).toBeUndefined()
})

it.each(['identity', 'interpretation', 'unbound'] as const)('does not transfer the old conversation’s %s obligation to a newly bound session', async hold => {
  const old = registry.byAgent('fixture-0')!
  if (hold === 'unbound') (await unbindRegistrySession(registry, old.sessionId))
  registry.setIdentityHold(old.agentId, 'old header incomplete')
  if (hold === 'interpretation') (await registry.revalidateBinding(old.agentId))
  const revision = registry.byAgent(old.agentId)!.evidenceRevision
  const id = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee', path = join(home, 'sessions', `rollout-${id}.jsonl`)
  writeFileSync(path, header(id))
  const result = (await registry.register({ engine: 'codex', sessionId: id, transcriptPath: path, tmuxPane: '%1', cwd: root }))!
  expect(result.isNew).toBe(true)
  // The staged commit replaces the binding in place and revokes every old read.
  expect(result.entry).toMatchObject({ sessionId: id, evidenceRevision: revision! + 1 })
  expect(result.entry.identityHold).toBeUndefined(); expect(result.entry.interpretationHold).toBeUndefined()
  const { createBinding } = await import('../core/agents/bind.js')
  const attachSession = vi.fn(async () => true)
  const binding = createBinding({ registry, attachSession, followsLive: () => false, stoppedAgents: { save: vi.fn() },
    mirror: { inheritSummary: vi.fn() }, forgetSession: vi.fn(), clients: { send: vi.fn() },
    announceSession: vi.fn(), syncRecapPool: vi.fn(), captureReader: () => () => false,
  } as unknown as import('../core/agents/bind.js').BindDeps)
  await binding.handleRegistered(result.entry, { ...result, hookEvent: 'UserPromptSubmit' })
  expect(attachSession).toHaveBeenCalledWith(result.entry, true, false, hold === 'unbound')
})
