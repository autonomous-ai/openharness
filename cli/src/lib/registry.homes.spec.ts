import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({ beforeVerify: undefined as (() => void) | undefined, captures: 0 }))
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
function observeHomeReads(): void { vi.doMock('./engineHomes.js', async original => {
  const actual = await original<typeof import('./engineHomes.js')>()
  return { ...actual, engineHomeSnapshot: () => {
    fault.captures++
    const snapshot = actual.engineHomeSnapshot()
    return { ...snapshot, verify: () => { fault.beforeVerify?.(); snapshot.verify() } }
  } }
}) }
vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))
let root: string | undefined
afterEach(() => { fault.beforeVerify = undefined; fault.captures = 0; vi.doUnmock('./engineHomes.js'); vi.unstubAllEnvs(); vi.resetModules(); if (root) rmSync(root, { recursive: true, force: true }) })

it('repairs a child-overwritten parent from an adopted Codex home before the login shell is read', async () => {
  // Found by QA on a quiet machine: restart searched only the default home and discarded this parent binding.
  root = mkdtempSync(join(tmpdir(), 'registry-homes-'))
  vi.stubEnv('ADAPTER_DATA_DIR', root)
  vi.stubEnv('CODEX_HOME', join(root, 'daemon-codex'))
  const moved = join(root, 'moved-codex')
  const sessions = join(moved, 'sessions', '2026', '10', '06')
  mkdirSync(sessions, { recursive: true })
  const parentId = '019f7f1b-195d-70f2-861b-de5d54a3e141'
  const childId = '019f8dae-e5f4-7c11-90d1-600854063b2c'
  const parent = join(sessions, `rollout-${parentId}.jsonl`), child = join(sessions, `rollout-${childId}.jsonl`)
  writeFileSync(parent, JSON.stringify({ type: 'session_meta', payload: { id: parentId, cwd: root, source: 'cli' } }) + '\n')
  writeFileSync(child, JSON.stringify({ type: 'session_meta', payload: { id: childId,
    source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } },
  } }) + '\n')
  writeFileSync(join(root, 'engine-homes.json'), JSON.stringify({ claude: [], codex: [moved] }))
  writeFileSync(join(root, 'registry.json'), JSON.stringify([{
    launcherId: 'agent', sessionId: parentId, engine: 'codex', transcriptPath: child,
    projectDir: 'project', cwd: root, tmuxPane: '%8', processIdentity: null,
    registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
  }]), { mode: 0o600 })
  vi.resetModules()
  const { registry } = await import('./registry.js')
  registry.load()
  expect(registry.get(parentId)?.transcriptPath).toBe(parent)
  expect(JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'))[0].transcriptPath).toBe(parent)
})


it.each(['unbind', 'release', 'separate-shell'] as const)('clears a hold with its binding while retaining a sibling hold: %s', async operation => {
  root = mkdtempSync(join(tmpdir(), 'registry-home-release-'))
  vi.stubEnv('ADAPTER_DATA_DIR', root)
  vi.stubEnv('CODEX_HOME', join(root, 'own-codex'))
  const rows = [0, 1].map(index => ({ launcherId: `fixture-${index}`, engine: 'codex', sessionId: `session-${index}`,
    transcriptPath: join(root!, 'moved-codex', 'sessions', `rollout-${index}.jsonl`), tmuxPane: `%${index + 1}`,
    projectDir: 'fixture', cwd: root, processIdentity: null, registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1 }))
  writeFileSync(join(root, 'engine-homes.json'), '{', { mode: 0o600 })
  writeFileSync(join(root, 'registry.json'), JSON.stringify(rows), { mode: 0o600 })
  vi.resetModules()
  const { registry } = await import('./registry.js')
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    registry.load()
    expect(registry.byAgent('fixture-0')?.identityHold).toBeTruthy()
    const released = operation === 'unbind'
      ? (expect(registry.unbindSession('session-0')).toBe(true), registry.byAgent('fixture-0'))
      : registry.releaseEngine('fixture-0', operation === 'separate-shell')
    expect(released).toMatchObject({ sessionId: '', transcriptPath: null })
    expect(released).not.toHaveProperty('identityHold')
    expect(registry.byAgent(released!.agentId)).not.toHaveProperty('identityHold')
    expect(registry.byAgent('fixture-1')?.identityHold).toBeTruthy()
    if (operation === 'separate-shell') {
      expect(released!.agentId).not.toBe('fixture-0')
      expect(registry.byAgent('fixture-0')).toBeUndefined()
    }
    const saved = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'))
    expect(saved.some((row: any) => Object.hasOwn(row, 'identityHold'))).toBe(false)
  } finally { log.mockRestore() }
})

it.each(['healthy', 'unreadable', 'changed-at-commit'] as const)('stages a registry-sized home batch without losing bindings: %s', async condition => {
  root = mkdtempSync(join(tmpdir(), 'registry-home-batch-'))
  vi.stubEnv('ADAPTER_DATA_DIR', root)
  vi.stubEnv('CODEX_HOME', join(root, 'own-codex'))
  const moved = join(root, 'moved-codex'), sessions = join(moved, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const rows = Array.from({ length: 200 }, (_, index) => {
    const id = `aaaaaaaa-1111-4222-8333-${String(index).padStart(12, '0')}`
    const transcriptPath = join(sessions, `rollout-${id}.jsonl`)
    writeFileSync(transcriptPath, JSON.stringify({ type: 'session_meta', payload: { id, cwd: root, source: 'cli' } }) + '\n')
    return { launcherId: `fixture-${index}`, engine: 'codex', sessionId: id, transcriptPath, tmuxPane: `%${index + 1}`,
      projectDir: 'fixture', cwd: root, processIdentity: null, registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1 }
  })
  const file = join(root, 'engine-homes.json')
  writeFileSync(file, condition === 'unreadable' ? '{' : JSON.stringify({ codex: condition === 'changed-at-commit' ? [] : [moved] }), { mode: 0o600 })
  writeFileSync(join(root, 'registry.json'), JSON.stringify(rows), { mode: 0o600 })
  if (condition === 'changed-at-commit') fault.beforeVerify = () => writeFileSync(file, JSON.stringify({ codex: [moved] }))
  vi.resetModules()
  observeHomeReads()
  const { registry } = await import('./registry.js')
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  registry.load()
  log.mockRestore()
  expect(fault.captures).toBe(1)
  expect(registry.list()).toHaveLength(200)
  for (const row of rows) {
    expect(registry.get(row.sessionId)).toMatchObject({ sessionId: row.sessionId, transcriptPath: row.transcriptPath })
    expect(Boolean(registry.get(row.sessionId)?.identityHold)).toBe(condition !== 'healthy')
  }
  const saved = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'))
  expect(saved.map((row: any) => row.sessionId).sort()).toEqual(rows.map(row => row.sessionId).sort())
  expect(saved.some((row: any) => row.identityHold)).toBe(false)
  fault.beforeVerify = undefined
  writeFileSync(file, JSON.stringify({ codex: [moved] }))
  registry.load()
  expect(registry.list().every(row => row.sessionId && !row.identityHold)).toBe(true)
})
