import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))
let root: string, home: string, file: string, registry: typeof import('./registry.js')['registry']
const ids = ['aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb']
const header = (id: string) => JSON.stringify({ type: 'session_meta', payload: { id, cwd: root, source: 'cli' } }) + '\n'
const transcript = (index: number) => join(home, 'sessions', `rollout-${ids[index]}.jsonl`)
beforeEach(async () => {
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
  vi.resetModules(); ({ registry } = await import('./registry.js'))
  registry.load()
})
afterEach(() => { vi.restoreAllMocks(); vi.doUnmock('../engines/transcriptBindings.js'); vi.unstubAllEnvs(); vi.resetModules(); rmSync(root, { recursive: true, force: true }) })

it.each(['', '{', 'wrong-id'])('holds a saved unreadable identity (%s), preserves its bytes, and retries without restarting', async text => {
  const before = readFileSync(file, 'utf8')
  writeFileSync(transcript(0), text === 'wrong-id' ? header(ids[1]!) : text)
  registry.load()
  expect(registry.byAgent('fixture-0')).toMatchObject({ sessionId: ids[0], transcriptPath: transcript(0), identityHold: expect.any(String) })
  expect(registry.byAgent('fixture-1')).toMatchObject({ sessionId: ids[1], transcriptPath: transcript(1) })
  expect(registry.byAgent('fixture-1')).not.toHaveProperty('identityHold')
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(() => registry.revalidateBinding('fixture-0')).toThrow()
  expect(registry.byAgent('fixture-0')?.sessionId).toBe(ids[0])
  writeFileSync(transcript(0), header(ids[0]!))
  expect(registry.revalidateBinding('fixture-0')).not.toHaveProperty('identityHold')
  expect(readFileSync(file, 'utf8')).toBe(before)
  rmSync(transcript(0))
  expect(registry.revalidateBinding('fixture-0')).toMatchObject({ sessionId: '', transcriptPath: null })
  expect(registry.bySession(ids[0]!)).toBeUndefined()
  expect(registry.bySession(ids[1]!)).toBeDefined()
})

it('restores every affected staged row when the shared root changes after file verification', async () => {
  const before = readFileSync(file, 'utf8')
  vi.doMock('../engines/transcriptBindings.js', async original => {
    const actual = await original<typeof import('../engines/transcriptBindings.js')>()
    return { ...actual, transcriptRootEvidence: (...args: Parameters<typeof actual.transcriptRootEvidence>) => {
      const proof = actual.transcriptRootEvidence(...args)
      return { ...proof, verify() {
        renameSync(join(home, 'sessions'), join(home, 'previous')); mkdirSync(join(home, 'sessions'))
        proof.verify()
      } }
    } }
  })
  vi.resetModules(); ({ registry } = await import('./registry.js')); registry.load()
  for (const [index, id] of ids.entries()) expect(registry.byAgent(`fixture-${index}`)).toMatchObject({ sessionId: id,
    transcriptPath: transcript(index), identityHold: expect.stringContaining('changed') })
  expect(readFileSync(file, 'utf8')).toBe(before)
})

it('holds only the row whose header changed while its sibling was staged', async () => {
  const before = readFileSync(file, 'utf8')
  vi.doMock('../engines/transcriptBindings.js', async original => {
    const actual = await original<typeof import('../engines/transcriptBindings.js')>()
    return { ...actual, savedTranscriptEvidence: (...args: Parameters<typeof actual.savedTranscriptEvidence>) => {
      const proof = actual.savedTranscriptEvidence(...args)
      if (args[1] === ids[1]) writeFileSync(transcript(0), header(ids[1]!))
      return proof
    } }
  })
  vi.resetModules(); ({ registry } = await import('./registry.js')); registry.load()
  expect(registry.byAgent('fixture-0')).toMatchObject({ sessionId: ids[0], transcriptPath: transcript(0), identityHold: expect.stringContaining('changed') })
  expect(registry.byAgent('fixture-1')).not.toHaveProperty('identityHold')
  expect(readFileSync(file, 'utf8')).toBe(before)
})

it('keeps holds transient and only retries bindings that still exist', () => {
  expect(registry.setIdentityHold('missing', 'pending')).toBe(false)
  expect(registry.revalidateBinding('missing')).toBeNull()
  expect(registry.setIdentityHold('fixture-0', '')).toBe(true)
  expect(registry.byAgent('fixture-0')?.identityHold).toBe('Waiting for conversation identity.')
  expect(registry.setIdentityHold('fixture-0', 'x'.repeat(2000))).toBe(true)
  expect(registry.byAgent('fixture-0')?.identityHold).toHaveLength(1024)
  expect(registry.setIdentityHold('fixture-0', 'x'.repeat(2000))).toBe(false)
  expect(registry.setIdentityHold('fixture-0')).toBe(true)
  registry.unbindSession(ids[0]!)
  expect(registry.revalidateBinding('fixture-0')).toMatchObject({ sessionId: '', transcriptPath: null })
})

it.each(['same', 'absent', 'repaired'] as const)('never overwrites a peer binding while retrying %s evidence', async outcome => {
  const binding = await import('../engines/transcriptBindings.js')
  const peer = new (registry.constructor as new () => typeof registry)()
  peer.load()
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
  expect(peer.register({ engine: 'codex', sessionId: nextId, transcriptPath: nextPath, tmuxPane: '%1', cwd: root })).not.toBeNull()
  const latest = readFileSync(file, 'utf8')
  // A parallel private fixture can change a shared ancestor during enumeration. Require a fresh
  // attempt to reach this exact durable-owner fence; an arbitrary native hold is not success.
  await vi.waitFor(() => expect(() => registry.revalidateBinding(original.agentId)).toThrow('saved binding changed'), { timeout: 3_000, interval: 25 })
  expect(readFileSync(file, 'utf8')).toBe(latest)
  expect(registry.bySession(ids[0]!)).toBe(original)
  expect(original).toMatchObject({ sessionId: ids[0], transcriptPath: transcript(0), identityHold: 'waiting' })
  expect(peer.bySession(nextId)?.transcriptPath).toBe(nextPath)
  // Ordinary reconciliation can refresh the peer's commit because the failed retry changed no facts.
  registry.flush()
  expect(registry.byAgent(original.agentId)).toMatchObject({ sessionId: nextId, transcriptPath: nextPath })
  expect(registry.revalidateBinding(original.agentId)?.sessionId).toBe(nextId)
})

it('commits a conclusive release inside a discovery batch before its callback continues', async () => {
  registry.setIdentityHold('fixture-0', 'waiting')
  rmSync(transcript(0))
  await registry.transaction(async () => {
    const saved = registry.revalidateBinding('fixture-0')!
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
  vi.resetModules(); ({ registry } = await import('./registry.js')); registry.load()
  registry.setIdentityHold('fixture-0', 'waiting')
  const before = readFileSync(file, 'utf8')
  retry = true
  expect(() => registry.revalidateBinding('fixture-0')).toThrow()
  expect(checked).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(registry.bySession(ids[0]!)).toMatchObject({ identityHold: 'waiting', transcriptPath: transcript(0) })
})

it('retains monotonic recovery authority through register and save, and never persists interpretation state', async () => {
  const { transcriptReadIdentity } = await import('../core/transcripts/readIdentity.js')
  const original = registry.byAgent('fixture-0')!, before = transcriptReadIdentity(original)
  registry.setIdentityHold(original.agentId, 'waiting')
  const held = original.evidenceRevision!
  registry.register({ engine: 'codex', sessionId: ids[0]!, transcriptPath: transcript(0), tmuxPane: '%1', cwd: root })
  expect(registry.byAgent(original.agentId)).toMatchObject({ evidenceRevision: held, identityHold: 'waiting' })
  const recovered = registry.revalidateBinding(original.agentId)!
  expect(recovered.evidenceRevision).toBeGreaterThan(held)
  expect(recovered.interpretationHold).toBeTruthy()
  expect(transcriptReadIdentity(recovered)).not.toBe(before)
  registry.flush()
  expect(registry.byAgent(original.agentId)).toBe(recovered)
  expect(recovered.interpretationHold).toBeTruthy()
  const persisted = JSON.parse(readFileSync(file, 'utf8'))[0]
  for (const field of ['identityHold', 'interpretationHold', 'evidenceRevision']) expect(persisted).not.toHaveProperty(field)
  expect(registry.setInterpretationHold('missing', held)).toBe(false)
  expect(registry.setInterpretationHold(original.agentId, held)).toBe(false)
  expect(registry.setInterpretationHold(original.agentId, recovered.evidenceRevision, 'retry reader')).toBe(true)
  expect(recovered.interpretationHold).toBe('retry reader')
  expect(registry.setInterpretationHold(original.agentId, recovered.evidenceRevision)).toBe(true)
  expect(registry.setInterpretationHold(original.agentId, recovered.evidenceRevision)).toBe(false)
  expect(recovered.interpretationHold).toBeUndefined()
})

it.each(['identity', 'interpretation', 'unbound'] as const)('does not transfer the old conversation’s %s obligation to a newly bound session', async hold => {
  const old = registry.byAgent('fixture-0')!
  if (hold === 'unbound') registry.unbindSession(old.sessionId)
  registry.setIdentityHold(old.agentId, 'old header incomplete')
  if (hold === 'interpretation') registry.revalidateBinding(old.agentId)
  const revision = registry.byAgent(old.agentId)!.evidenceRevision
  const id = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee', path = join(home, 'sessions', `rollout-${id}.jsonl`)
  writeFileSync(path, header(id))
  const result = registry.register({ engine: 'codex', sessionId: id, transcriptPath: path, tmuxPane: '%1', cwd: root })!
  expect(result.isNew).toBe(true)
  // The staged commit replaces the binding in place and revokes every old read.
  expect(result.entry).toMatchObject({ sessionId: id, evidenceRevision: revision! + 1 })
  expect(result.entry.identityHold).toBeUndefined(); expect(result.entry.interpretationHold).toBeUndefined()
  const { createBinding } = await import('../core/agents/bind.js')
  const attachSession = vi.fn(async () => true)
  const binding = createBinding({ registry, attachSession, stoppedAgents: { save: vi.fn() },
    mirror: { inheritSummary: vi.fn() }, forgetSession: vi.fn(), clients: { send: vi.fn() },
    announceSession: vi.fn(), syncRecapPool: vi.fn(),
  } as unknown as import('../core/agents/bind.js').BindDeps)
  await binding.handleRegistered(result.entry, { ...result, hookEvent: 'UserPromptSubmit' })
  expect(attachSession).toHaveBeenCalledWith(result.entry, true, false, hold === 'unbound')
})
