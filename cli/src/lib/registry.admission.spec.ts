import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({ file: '', rename: false,
  afterProof: undefined as (() => void) | undefined, beforeVerify: undefined as (() => void) | undefined }))
vi.mock('fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    if (fault.rename && String(args[1]) === fault.file) throw new Error('fixture registry write failure')
    return actual.renameSync(...args)
  } }
})
vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))
function observeNativeProof(): void { vi.doMock('../engines/transcriptBindings.js', async original => {
  const actual = await original<typeof import('../engines/transcriptBindings.js')>()
  return { ...actual, transcriptEvidence: (...args: Parameters<typeof actual.transcriptEvidence>) => {
    const proof = actual.transcriptEvidence(...args)
    fault.afterProof?.()
    return { ...proof, verify: (...selected: Parameters<typeof proof.verify>) => { fault.beforeVerify?.(); proof.verify(...selected) } }
  } }
}) }
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
let root: string, home: string, file: string, transcript: string
let registry: typeof import('./registry.js')['registry'], target: string, source: string
const header = (id = A, delegated = false) => JSON.stringify({ type: 'session_meta', payload: {
  id, cwd: root, source: delegated ? { subagent: { thread_spawn: { parent_thread_id: B, depth: 1 } } } : 'cli',
} }) + '\n'
const input = (id = A, path = transcript, pane = '%1') => ({ engine: 'codex' as const, sessionId: id,
  transcriptPath: path, tmuxPane: pane, cwd: root,
  processIdentity: { pid: pane === '%1' ? 5101 : 5102, startMarker: 'fixture-start', executable: '<codex>' } })
const snapshot = () => ({ live: JSON.stringify(registry.list()), disk: readFileSync(file, 'utf8') })
const unchanged = (before: ReturnType<typeof snapshot>) => {
  expect(JSON.stringify(registry.list())).toBe(before.live)
  expect(readFileSync(file, 'utf8')).toBe(before.disk)
}
beforeEach(async () => {
  fault.rename = false; fault.afterProof = undefined; fault.beforeVerify = undefined
  root = realpathSync(mkdtempSync(join(tmpdir(), 'registry-admission-')))
  home = join(root, 'codex'); file = join(root, 'data', 'registry.json'); fault.file = file
  mkdirSync(join(home, 'sessions'), { recursive: true }); mkdirSync(join(root, 'data'))
  for (const [key, value] of Object.entries({ HOME: root, ADAPTER_DATA_DIR: join(root, 'data'),
    ADAPTER_RUNTIME_DIR: join(root, 'runtime'), CODEX_HOME: home, CLAUDE_CONFIG_DIR: join(root, 'claude') })) vi.stubEnv(key, value)
  writeFileSync(join(root, 'data', 'engine-homes.json'), '{}')
  transcript = join(home, 'sessions', `rollout-${A}.jsonl`); writeFileSync(transcript, header())
  vi.resetModules(); observeNativeProof(); ({ registry } = await import('./registry.js'))
  target = registry.openProcessAgent({ engine: 'terminal', tmuxPane: '%1', cwd: root,
    processIdentity: { pid: 4101, startMarker: 'fixture-start', executable: '<shell>' } })!.entry.agentId
  source = registry.openProcessAgent({ engine: 'codex', tmuxPane: '%2', cwd: root, processIdentity: input(A, transcript, '%2').processIdentity })!.entry.agentId
})
afterEach(() => {
  fault.rename = false; fault.afterProof = undefined; fault.beforeVerify = undefined
  vi.restoreAllMocks(); vi.doUnmock('../engines/transcriptBindings.js'); vi.unstubAllEnvs(); vi.resetModules(); rmSync(root, { recursive: true, force: true })
})

it.each(['', '{', '{"type":"session_meta"}\n'])('holds incomplete native evidence without promoting the terminal: %s', text => {
  writeFileSync(transcript, text)
  const before = snapshot()
  expect(() => registry.register(input())).toThrow()
  unchanged(before)
  expect(registry.byRuntimeTerminal({ backend: 'tmux', paneId: '%1' })?.agentId).toBe(target)
})
it.each(['different-id', 'delegated'])('refuses confirmed %s without changing the terminal or its durable row', kind => {
  writeFileSync(transcript, header(kind === 'different-id' ? B : A, kind === 'delegated'))
  const before = snapshot()
  expect(registry.register(input())).toBeNull()
  unchanged(before)
})
it.each(['terminal', 'active-owner', 'dormant-owner'])('keeps every live and durable owner when the %s commit fails', kind => {
  if (kind !== 'terminal') {
    expect(registry.register(input(A, transcript, '%2'))).not.toBeNull()
    if (kind === 'dormant-owner') registry.setActive(source, false)
  }
  const before = snapshot(); fault.rename = true
  expect(() => registry.register(input())).toThrow('fixture registry write failure')
  unchanged(before)
  expect(registry.byAgent(target)?.engine).toBe('terminal')
  if (kind !== 'terminal') expect(registry.bySession(A)?.agentId).toBe(source)
})
it('rechecks the native header under the write lock before publishing any registration', () => {
  const before = snapshot()
  let checked = false
  fault.beforeVerify = () => {
    checked = true
    expect(readFileSync(file + '.lock', 'utf8')).toBeTruthy()
    writeFileSync(transcript, header(B))
  }
  expect(() => registry.register(input())).toThrow()
  expect(checked).toBe(true)
  unchanged(before)
})
it('never overwrites a different durable admission that arrived during inspection', () => {
  const peer = new (registry.constructor as new () => typeof registry)(); peer.load()
  const other = join(home, 'sessions', `rollout-${B}.jsonl`); writeFileSync(other, header(B))
  const before = JSON.stringify(registry.list())
  let committed = ''
  fault.afterProof = () => {
    fault.afterProof = undefined
    expect(peer.register(input(B, other))).not.toBeNull()
    committed = readFileSync(file, 'utf8')
  }
  expect(() => registry.register(input())).toThrow('saved binding changed')
  expect(JSON.stringify(registry.list())).toBe(before)
  expect(readFileSync(file, 'utf8')).toBe(committed)
  expect(peer.bySession(B)?.agentId).toBe(target)
})
it('returns the committed live row and publishes only after the registry write', () => {
  const entered: string[] = []
  registry.onEnter = engine => {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Array<{ agentId: string; sessionId: string }>
    expect(saved.find(row => row.agentId === target)?.sessionId).toBe(A)
    entered.push(engine)
  }
  const result = registry.register(input())!
  expect(result.entry).toBe(registry.byAgent(target))
  expect(result.entry.sessionId).toBe(A)
  expect(registry.bySession(A)).toBe(result.entry)
  expect(entered).toContain('codex')
})


it('publishes all displaced owners before optional entry notification and contains its failure', () => {
  expect(registry.register(input(A, transcript, '%2'))).not.toBeNull()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const observations: string[] = []
  registry.onEnter = engine => {
    expect(registry.bySession(A)?.agentId).toBe(target)
    expect(registry.byAgent(source)?.sessionId).toBe('')
    expect(registry.byAgent(target)?.engine).toBe('codex')
    observations.push(engine)
    throw new Error('optional engine startup unavailable')
  }
  const result = registry.register(input())!
  expect(result.entry).toBe(registry.byAgent(target))
  expect(observations.length).toBe(2)
  expect(warning).toHaveBeenCalledTimes(2)
  const rows = JSON.parse(readFileSync(file, 'utf8')) as Array<{ agentId: string; sessionId: string }>
  expect(rows.find(row => row.agentId === target)?.sessionId).toBe(A)
  expect(rows.find(row => row.agentId === source)?.sessionId).toBe('')
})
