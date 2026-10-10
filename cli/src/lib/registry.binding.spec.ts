import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
