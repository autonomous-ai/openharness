import type { Server } from 'node:http'
import type { HookServerHandlers } from '../hookServer.js'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// These are ownership and injected-I/O outcomes, independent of host scheduling. Actual
// elapsed-work deadlines are exercised separately in engines/kit/nativeEvidence.spec.ts.
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))

const fault = vi.hoisted(() => ({ file: '', rename: false, directorySync: false, renamed: false,
  afterProof: undefined as (() => void) | undefined, beforeVerify: undefined as (() => void) | undefined }))
vi.mock('fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    if (fault.rename && String(args[1]) === fault.file) throw new Error('fixture registry write failure')
    const result = actual.renameSync(...args)
    if (String(args[1]) === fault.file) fault.renamed = true
    return result
  }, fsyncSync: (fd: number) => {
    if (fault.directorySync && fault.renamed && actual.fstatSync(fd).isDirectory()) throw new Error('fixture directory sync failure')
    return actual.fsyncSync(fd)
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
let server: Server | undefined
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
  fault.rename = false; fault.directorySync = false; fault.renamed = false; fault.afterProof = undefined; fault.beforeVerify = undefined
  root = realpathSync(mkdtempSync(join(tmpdir(), 'registry-admission-')))
  home = join(root, 'codex'); file = join(root, 'data', 'registry.json'); fault.file = file
  mkdirSync(join(home, 'sessions'), { recursive: true }); mkdirSync(join(root, 'data'))
  for (const [key, value] of Object.entries({ HOME: root, ADAPTER_DATA_DIR: join(root, 'data'),
    ADAPTER_RUNTIME_DIR: join(root, 'runtime'), CODEX_HOME: home, CLAUDE_CONFIG_DIR: join(root, 'claude'),
    COMMANDCODE_HOME: join(root, 'commandcode'), GROK_HOME: join(root, 'grok'),
    AGY_HOME: join(root, 'agy'), COPILOT_HOME: join(root, 'copilot') })) vi.stubEnv(key, value)
  writeFileSync(join(root, 'data', 'engine-homes.json'), '{}')
  transcript = join(home, 'sessions', `rollout-${A}.jsonl`); writeFileSync(transcript, header())
  vi.resetModules(); observeNativeProof(); ({ registry } = await import('./registry.js'))
  target = registry.openProcessAgent({ engine: 'terminal', tmuxPane: '%1', cwd: root,
    processIdentity: { pid: 4101, startMarker: 'fixture-start', executable: '<shell>' } })!.entry.agentId
  source = registry.openProcessAgent({ engine: 'codex', tmuxPane: '%2', cwd: root, processIdentity: input(A, transcript, '%2').processIdentity })!.entry.agentId
})
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
  server = undefined
  fault.rename = false; fault.directorySync = false; fault.renamed = false; fault.afterProof = undefined; fault.beforeVerify = undefined
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
    expect(JSON.parse(readFileSync(join(file + '.lock', 'owner.json'), 'utf8')).pid).toBe(process.pid)
    writeFileSync(transcript, header(B))
  }
  expect(() => registry.register(input())).toThrow('header changed')
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
  const former = registry.byAgent(target)!, before = structuredClone(former)
  const entered: string[] = []
  registry.onEnter = engine => {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Array<{ agentId: string; sessionId: string }>
    expect(saved.find(row => row.agentId === target)?.sessionId).toBe(A)
    entered.push(engine)
  }
  const result = registry.register(input())!
  expect(result.entry).not.toBe(former)
  expect(former).toEqual(before)
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


it.each(['terminal', 'active-owner', 'dormant-owner'])('reconciles its own post-rename uncertainty for %s before publishing', kind => {
  if (kind !== 'terminal') {
    expect(registry.register(input(A, transcript, '%2'))).not.toBeNull()
    if (kind === 'dormant-owner') registry.setActive(source, false)
  }
  const before = JSON.stringify(registry.list())
  fault.directorySync = true; fault.renamed = false
  expect(() => registry.register(input())).toThrow('fixture directory sync failure')
  expect(JSON.stringify(registry.list())).toBe(before)
  const written = readFileSync(file, 'utf8')
  expect(JSON.parse(written).find((row: { agentId: string }) => row.agentId === target).sessionId).toBe(A)
  fault.directorySync = false
  const result = registry.register(input())!
  expect(result.entry.sessionId).toBe(A)
  expect(result.entry).toBe(registry.byAgent(target))
  expect(readFileSync(file, 'utf8')).toBe(written)
  if (kind === 'active-owner') expect(registry.byAgent(source)?.sessionId).toBe('')
  if (kind === 'dormant-owner') expect(registry.byAgent(source)).toBeUndefined()
})

it('does not consume post-rename uncertainty as success after a local removal changes ownership', () => {
  fault.directorySync = true; fault.renamed = false
  expect(() => registry.register(input())).toThrow('fixture directory sync failure')
  fault.directorySync = false
  const written = readFileSync(file, 'utf8')
  registry.removeAgent(target)
  expect(registry.register(input())).toBeNull()
  expect(registry.byAgent(target)).toBeUndefined()
  const saved = JSON.parse(readFileSync(file, 'utf8')).find((row: { agentId: string }) => row.agentId === target)
  expect(saved).toBeUndefined()
  expect(readFileSync(file, 'utf8')).not.toBe(written)
})

it.each(['rename', 'changed-proof', 'peer-commit'])('keeps a resumed binding intact when mismatch refusal meets %s', mode => {
  expect(registry.register(input())).not.toBeNull()
  const row = registry.byAgent(target)!
  row.resumeOnly = true; row.lastHookAt = 0; row.launch = { state: 'starting' }; registry.flush()
  const other = join(home, 'sessions', `rollout-${B}.jsonl`); writeFileSync(other, header(B))
  const before = snapshot()
  if (mode === 'rename') fault.rename = true
  if (mode === 'changed-proof') fault.beforeVerify = () => writeFileSync(other, header(A))
  let peerDisk: string | undefined
  if (mode === 'peer-commit') {
    const peer = new (registry.constructor as new () => typeof registry)(); peer.load()
    fault.afterProof = () => { fault.afterProof = undefined; peer.setLaunch(target, { state: 'ready' }); peerDisk = readFileSync(file, 'utf8') }
  }
  expect(() => registry.register(input(B, other))).toThrow()
  expect(JSON.stringify(registry.list())).toBe(before.live)
  expect(readFileSync(file, 'utf8')).toBe(peerDisk ?? before.disk)
})

it('cannot flush an unrelated stale discovery claim over a newer durable peer', async () => {
  const peer = new (registry.constructor as new () => typeof registry)(); peer.load()
  let peerDisk = ''
  await registry.transaction(async () => {
    registry.updateRuntimes(source, [{ backend: 'tmux', paneId: '%3' }], 'tmux\u0000%3')
    const third = peer.openProcessAgent({ engine: 'claude', tmuxPane: '%3', cwd: root,
      processIdentity: { pid: 9103, startMarker: 'fixture-peer', executable: '<claude>' } })!
    peerDisk = readFileSync(file, 'utf8')
    expect(third.entry.agentId).not.toBe(source)
    const live = JSON.stringify(registry.list())
    expect(() => registry.register(input())).toThrow()
    expect(JSON.stringify(registry.list())).toBe(live)
    expect(readFileSync(file, 'utf8')).toBe(peerDisk)
    // Finish the observation without the stale route; it never earns a write through registration.
    registry.updateRuntimes(source, [{ backend: 'tmux', paneId: '%2' }], 'tmux\u0000%2')
  })
  expect(JSON.parse(readFileSync(file, 'utf8')).some((row: { tmuxPane: string; agentId: string }) => row.tmuxPane === '%3' && row.agentId !== source)).toBe(true)
})


it('rolls back only its unpublished image before a different local write and then retries the held admission', () => {
  fault.directorySync = true; fault.renamed = false
  expect(() => registry.register(input())).toThrow('fixture directory sync failure')
  fault.directorySync = false
  registry.setCwd(source, '/fixture/next-folder')
  expect(registry.byAgent(target)?.engine).toBe('terminal')
  expect(registry.byAgent(source)?.cwd).toBe('/fixture/next-folder')
  const result = registry.register(input())!
  expect(result.entry.sessionId).toBe(A)
  expect(registry.byAgent(source)?.cwd).toBe('/fixture/next-folder')
  expect(JSON.parse(readFileSync(file, 'utf8')).find((row: { agentId: string }) => row.agentId === source).cwd).toBe('/fixture/next-folder')
})

it('contains another directory failure while reversing an unpublished binding for removal', () => {
  fault.directorySync = true; fault.renamed = false
  expect(() => registry.register(input())).toThrow('fixture directory sync failure')
  registry.removeAgent(target)
  fault.directorySync = false
  registry.flush()
  expect(registry.register(input())).toBeNull()
  const saved = JSON.parse(readFileSync(file, 'utf8')).find((row: { agentId: string }) => row.agentId === target)
  expect(saved).toBeUndefined()
})

it('reconciles a peer-changed ownership group and allows unrelated strict writes and fresh admission', () => {
  fault.directorySync = true; fault.renamed = false
  expect(() => registry.register(input())).toThrow('fixture directory sync failure')
  fault.directorySync = false
  const peerRows = JSON.parse(readFileSync(file, 'utf8'))
  peerRows.find((row: { agentId: string }) => row.agentId === target).cwd = '/fixture/peer-folder'
  writeFileSync(file, JSON.stringify(peerRows, null, 2))
  const peerDisk = readFileSync(file, 'utf8')
  expect(() => registry.register(input())).toThrow('different durable owner')
  expect(readFileSync(file, 'utf8')).toBe(peerDisk)
  expect(registry.byAgent(target)?.engine).toBe('codex')
  expect(registry.byAgent(target)?.identityHold).toContain('concurrent binding')
  const other = join(home, 'sessions', `rollout-${B}.jsonl`); writeFileSync(other, header(B))
  expect(registry.register(input(B, other, '%2'))?.entry.sessionId).toBe(B)
  expect(registry.byAgent(target)?.cwd).toBe('/fixture/peer-folder')
  expect(registry.register(input())?.entry.sessionId).toBe(A)
  expect(registry.bySession(B)?.agentId).toBe(source)
})

it('confirms an unpublished group while retaining an unrelated peer write', () => {
  fault.directorySync = true; fault.renamed = false
  expect(() => registry.register(input())).toThrow('fixture directory sync failure')
  fault.directorySync = false
  const peerRows = JSON.parse(readFileSync(file, 'utf8'))
  peerRows.find((row: { agentId: string }) => row.agentId === source).cwd = '/fixture/peer-folder'
  writeFileSync(file, JSON.stringify(peerRows, null, 2))
  expect(registry.register(input())?.entry.sessionId).toBe(A)
  expect(registry.byAgent(source)?.cwd).toBe('/fixture/peer-folder')
  expect(JSON.parse(readFileSync(file, 'utf8')).find((row: { agentId: string }) => row.agentId === source).cwd).toBe('/fixture/peer-folder')
})

it('keeps its unconfirmed image independent of mutable input objects', () => {
  const pending = input()
  fault.directorySync = true; fault.renamed = false
  expect(() => registry.register(pending)).toThrow('fixture directory sync failure')
  const written = readFileSync(file, 'utf8')
  pending.processIdentity.startMarker = 'mutated-after-write'
  fault.directorySync = false
  expect(() => registry.register(input())).not.toThrow()
  expect(registry.byAgent(target)?.sessionId).toBe(A)
  expect(readFileSync(file, 'utf8')).toBe(written)
})

it('lets a late hook recover a launch timeout while its live process remains the owner', () => {
  registry.setLaunch(source, { state: 'failed', error: 'START_TIMEOUT' })
  expect(registry.register(input(A, transcript, '%2'))?.entry.sessionId).toBe(A)
})


it('does not acknowledge a Close plan discarded by peer ownership recovery', () => {
  fault.directorySync = true; fault.renamed = false
  expect(() => registry.register(input())).toThrow('fixture directory sync failure')
  fault.directorySync = false
  const peerRows = JSON.parse(readFileSync(file, 'utf8'))
  peerRows.find((row: { agentId: string }) => row.agentId === target).cwd = '/fixture/peer-folder'
  writeFileSync(file, JSON.stringify(peerRows, null, 2))
  const disk = readFileSync(file, 'utf8')
  const plan = { id: 'cccccccc-3333-4333-8333-cccccccccccc', state: 'waiting' as const, identity: 'fixture-binding', requestedAt: Date.now() }
  expect(() => registry.setClosePlan(target, plan)).toThrow('different durable owner')
  expect(registry.byAgent(target)?.closePlan).toBeUndefined()
  expect(readFileSync(file, 'utf8')).toBe(disk)
  expect(registry.setClosePlan(source, plan)?.closePlan).toEqual(plan)
})

it('does not authorize an external dispatch discarded by recovery of a staged batch', () => {
  const external = registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%3' }],
    externalResume: { token: 'cccccccc-3333-4333-8333-cccccccccccc', request: { engine: 'codex', sessionId: B }, takeOver: null, phase: 'waiting' } })!
  registry.setExternalResume(external.agentId, { ...external.externalResume!, phase: 'admitted', session: {
    engine: 'codex', sessionId: B, cwd: root, origin: 'terminal', title: 'fixture', mtime: 1, transcriptPath: null,
  } })
  registry.byAgent(external.agentId)!.cwd = '/fixture/staged-folder'
  fault.directorySync = true; fault.renamed = false
  expect(() => registry.register(input())).toThrow('fixture directory sync failure')
  fault.directorySync = false
  const peerRows = JSON.parse(readFileSync(file, 'utf8'))
  peerRows.find((row: { agentId: string }) => row.agentId === external.agentId).cwd = '/fixture/peer-folder'
  writeFileSync(file, JSON.stringify(peerRows, null, 2))
  const disk = readFileSync(file, 'utf8')
  expect(() => registry.beginExternalDispatch(external.agentId)).toThrow('different durable owner')
  expect(registry.byAgent(external.agentId)?.externalResume?.dispatched).toBeUndefined()
  expect(registry.byAgent(external.agentId)?.launch?.state).toBe('held')
  expect(registry.byAgent(external.agentId)?.cwd).toBe('/fixture/peer-folder')
  expect(readFileSync(file, 'utf8')).toBe(disk)
})


it('reconciles a whole alias-only ownership transfer after an unconfirmed write', () => {
  const alias = 'shared-alias'
  const previous = registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%3' }],
    externalResume: { token: 'cccccccc-3333-4333-8333-cccccccccccc', request: { engine: 'codex', sessionId: B }, takeOver: null, phase: 'waiting' } })!
  registry.setExternalResume(previous.agentId, { ...previous.externalResume!, phase: 'admitted', session: {
    engine: 'codex', sessionId: B, aliases: [alias], cwd: root, origin: 'terminal', title: 'fixture', mtime: 1, transcriptPath: null,
  } })
  fault.directorySync = true; fault.renamed = false
  expect(() => registry.register(input())).toThrow('fixture directory sync failure')
  fault.directorySync = false
  const peerRows = JSON.parse(readFileSync(file, 'utf8'))
  peerRows.find((row: { agentId: string }) => row.agentId === previous.agentId).externalResume.session.aliases = []
  peerRows.find((row: { agentId: string }) => row.agentId === target).externalResume = {
    token: 'dddddddd-4444-4444-8444-dddddddddddd', request: { engine: 'codex', sessionId: A }, takeOver: null, phase: 'admitted',
    session: { engine: 'codex', sessionId: A, aliases: [alias], cwd: root, origin: 'terminal', title: 'fixture', mtime: 1, transcriptPath: transcript },
  }
  writeFileSync(file, JSON.stringify(peerRows, null, 2))
  const disk = readFileSync(file, 'utf8')
  expect(() => registry.register(input())).toThrow('different durable owner')
  expect(readFileSync(file, 'utf8')).toBe(disk)
  expect(registry.externalConflict([alias])?.agentId).toBe(target)
  expect(registry.byAgent(previous.agentId)?.externalResume?.session?.aliases).toEqual([])
  expect(registry.register(input())?.entry.sessionId).toBe(A)
})



async function httpFixture(blocked: (agentId: string) => boolean = () => false, admissionReceiptCapacity = 65_536,
  overrides: Partial<HookServerHandlers> = {}, admissionBytesCapacity?: number) {
  const { startHookServer } = await import('../hookServer.js')
  const { readHookCredential } = await import('./hookAuth.js')
  const prompts: string[] = [], registered = vi.fn(), reasons: Array<string | undefined> = []
  const started = await startHookServer(0, { onRegistered: registered, onSessionEnd: () => {},
    hookAdmissionBlocked: blocked,
    onPromptSubmitted: (_id, text) => prompts.push(text),
    onAdmissionHeld: (_id, reason) => reasons.push(reason),
    ...overrides,
  }, { admissionReceiptCapacity, admissionBytesCapacity })
  server = started.server
  const post = async (override: Record<string, unknown> = {}, order: { id?: string; firedAt?: number } = {}, path = 'session-start') => {
    const response = await fetch(`http://127.0.0.1:${started.port}/api/hook/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        'x-harness-hook-token': readHookCredential(join(root, 'data'))!,
        ...(order.id ? { 'x-harness-hook-delivery-id': order.id } : {}),
        ...(order.firedAt ? { 'x-harness-hook-fired-at': String(order.firedAt) } : {}),
      },
      body: JSON.stringify({ engine: 'codex', sessionId: A, transcriptPath: transcript,
        tmuxPane: '%2', cwd: root, hookEvent: 'UserPromptSubmit', prompt: 'fixture prompt', ...override }),
    })
    return { status: response.status, body: await response.json() }
  }
  return { post, prompts, registered, reasons }
}

it('keeps each prompt through an HTTP registration write failure and credits it only after recovery', async () => {
  const f = await httpFixture()
  const before = readFileSync(file, 'utf8')
  fault.rename = true
  expect(await f.post({ prompt: 'first prompt' })).toEqual({ status: 200, body: { pending: true } })
  expect(await f.post({ prompt: 'second prompt' })).toEqual({ status: 200, body: { pending: true } })
  expect(f.prompts).toEqual([])
  expect(f.registered).not.toHaveBeenCalled()
  expect(registry.byAgent(source)?.sessionId).toBe('')
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(f.reasons.some(reason => reason?.includes('registry write failure'))).toBe(true)
  fault.rename = false
  await vi.waitFor(() => expect(f.prompts).toEqual(['first prompt', 'second prompt']), { timeout: 4_000 })
  expect(f.registered).toHaveBeenCalledTimes(2)
  expect(registry.bySession(A)?.agentId).toBe(source)
})

it('holds a missing announced transcript on the actual HTTP path and retries complete evidence', async () => {
  const f = await httpFixture()
  rmSync(transcript)
  expect(await f.post()).toEqual({ status: 200, body: { pending: true } })
  expect(f.prompts).toEqual([])
  writeFileSync(transcript, header())
  await vi.waitFor(() => expect(f.prompts).toEqual(['fixture prompt']), { timeout: 4_000 })
  expect(registry.bySession(A)?.agentId).toBe(source)
})

it.each(['commandcode', 'grok', 'agy', 'copilot'] as const)('admits the %s SessionStart before its deterministic transcript directories exist', async engine => {
  const agent = registry.openProcessAgent({ engine, tmuxPane: '%3', cwd: root,
    processIdentity: { pid: 5103, startMarker: 'fixture-start', executable: `<${engine}>` } })!.entry
  const f = await httpFixture()
  expect(await f.post({ engine, tmuxPane: '%3', transcriptPath: undefined, hookEvent: 'SessionStart', prompt: undefined }))
    .toEqual({ status: 200, body: { ok: true } })
  expect(registry.byAgent(agent.agentId)?.sessionId).toBe(A)
  expect(registry.byAgent(agent.agentId)?.transcriptPath).toContain(join(root, engine))
  expect(f.registered).toHaveBeenCalledOnce()
  expect(f.prompts).toEqual([])
})

it('rechecks an unwritten derived locator proof under the lock and never grants it to a reported path', () => {
  const agent = registry.openProcessAgent({ engine: 'commandcode', tmuxPane: '%3', cwd: root,
    processIdentity: { pid: 5103, startMarker: 'fixture-start', executable: '<commandcode>' } })!.entry
  const body = { engine: 'commandcode' as const, sessionId: A, tmuxPane: '%3', cwd: root, processIdentity: agent.processIdentity! }
  const before = snapshot()
  expect(() => registry.register({ ...body, transcriptPath: join(root, 'commandcode', 'projects', 'announced.jsonl') })).toThrow('not yet available')
  unchanged(before)
  fault.beforeVerify = () => {
    expect(JSON.parse(readFileSync(join(file + '.lock', 'owner.json'), 'utf8')).pid).toBe(process.pid)
    mkdirSync(join(root, 'commandcode'))
  }
  expect(() => registry.register(body)).toThrow('changed')
  unchanged(before)
  fault.beforeVerify = undefined
  expect(registry.register(body)?.entry.sessionId).toBe(A)
})

it('the actual Stop job blocks hook admission before its first asynchronous step settles', async () => {
  const { createStopAgentService } = await import('./stopAgentService.js')
  const stopJobs = new Map<string, Promise<void>>()
  let fail!: (error: Error) => void
  const never = vi.fn(() => { throw new Error('native mutation is forbidden in this fixture') })
  const stop = createStopAgentService({ registry, stopJobs,
    settlePane: () => new Promise((_resolve, reject) => { fail = reject }),
    restartJobs: { cancel: vi.fn() } as unknown as import('./restartAgent.js').AgentRestartCoordinator,
    stoppedAgents: { save: never } as unknown as import('./stoppedAgents.js').StoppedAgentStore,
    tmuxBackend: { kill: never }, agentReconciler: { suppress: never, holdRoute: never, releaseRoute: never, trigger: never },
    forgetSession: never, markDeleted: never, clearDeleted: never, stopNative: never,
  })
  const f = await httpFixture(id => stopJobs.has(id))
  const stopping = stop(source)
  const refused = expect(stopping).rejects.toThrow('fixture Stop did not proceed')
  expect(await f.post()).toEqual({ status: 200, body: { pending: true } })
  expect(f.prompts).toEqual([])
  expect(registry.byAgent(source)?.sessionId).toBe('')
  expect(f.reasons.some(reason => reason?.includes('Stop'))).toBe(true)
  expect(never).not.toHaveBeenCalled()
  fail(new Error('fixture Stop did not proceed'))
  await refused
})

it('recovers a peer-changed fileless binding only after fresh native source admission', () => {
  registry.removeAgent(target)
  const agent = registry.openProcessAgent({ engine: 'hermes', tmuxPane: '%1', cwd: root,
    processIdentity: { pid: 6101, startMarker: 'fixture-start', executable: '<hermes>' } })!.entry
  const body = { engine: 'hermes' as const, tmuxPane: '%1', sessionId: '20261010_050000_abcdef', cwd: root, processIdentity: agent.processIdentity! }
  fault.directorySync = true; fault.renamed = false
  expect(() => registry.register(body)).toThrow('fixture directory sync failure')
  fault.directorySync = false
  const peerRows = JSON.parse(readFileSync(file, 'utf8'))
  peerRows.find((row: { agentId: string }) => row.agentId === agent.agentId).cwd = '/fixture/peer-folder'
  writeFileSync(file, JSON.stringify(peerRows, null, 2))
  expect(() => registry.register(body)).toThrow('different durable owner')
  expect(registry.register(body)?.entry.identityHold).toContain('concurrent binding')
  const result = registry.register(body, { verifiedNativeSource: true })!
  expect(result.entry.identityHold).toBeUndefined()
  expect(result.entry.interpretationHold).toBeTruthy()
})

it('revokes a stale displaced-owner draft when a peer gave that owner another conversation', () => {
  expect(registry.register(input(A, transcript, '%2'))).not.toBeNull()
  registry.setActive(source, false)
  fault.directorySync = true; fault.renamed = false
  expect(() => registry.register({ ...input(A, transcript, '%2'), title: 'unconfirmed title' })).toThrow('fixture directory sync failure')
  fault.directorySync = false
  const other = join(home, 'sessions', `rollout-${B}.jsonl`); writeFileSync(other, header(B))
  const peerRows = JSON.parse(readFileSync(file, 'utf8'))
  Object.assign(peerRows.find((row: { agentId: string }) => row.agentId === source), { sessionId: B, transcriptPath: other })
  writeFileSync(file, JSON.stringify(peerRows, null, 2))
  const disk = readFileSync(file, 'utf8')
  // This draft's target is outside the recovered group, but its displaced owner is
  // inside it. Returning stale orphan metadata would let binding delete that owner.
  expect(() => registry.register(input())).toThrow('different durable owner')
  expect(registry.byAgent(target)?.engine).toBe('terminal')
  expect(registry.bySession(B)?.agentId).toBe(source)
  expect(readFileSync(file, 'utf8')).toBe(disk)
  expect(registry.register(input())?.orphaned).toBeNull()
  expect(registry.bySession(B)?.agentId).toBe(source)
})


it('does not let a newly healthy prompt bypass its already-held predecessor', async () => {
  const f = await httpFixture()
  fault.rename = true
  expect((await f.post({ prompt: 'first' })).body).toEqual({ pending: true })
  fault.rename = false
  await f.post({ prompt: 'second' })
  await vi.waitFor(() => expect(f.prompts).toEqual(['first', 'second']), { timeout: 4_000 })
})

it('keeps the older hold visible when a competing delegated delivery is refused', async () => {
  const f = await httpFixture(), firedAt = Date.now()
  fault.rename = true
  await f.post({ prompt: 'parent' }, { firedAt })
  const child = join(home, 'sessions', `rollout-${B}.jsonl`); writeFileSync(child, '{\n')
  await f.post({ sessionId: B, transcriptPath: child, prompt: 'child' }, { firedAt: firedAt + 1 })
  writeFileSync(child, header(B, true))
  await vi.waitFor(() => expect(f.reasons.at(-1)).toContain('registry write failure'), { timeout: 3_000 })
  expect(f.prompts).toEqual([])
  fault.rename = false
  await vi.waitFor(() => expect(f.prompts).toEqual(['parent']), { timeout: 3_000 })
  expect(f.reasons.at(-1)).toBeUndefined()
})

it('contains a failed status publisher without losing durable prompt notification', async () => {
  const f = await httpFixture(() => false, 65_536, { onAdmissionHeld: () => { throw Error('fixture status unavailable') } })
  fault.rename = true
  await f.post()
  fault.rename = false
  await vi.waitFor(() => expect(f.prompts).toEqual(['fixture prompt']), { timeout: 3_000 })
  expect(f.registered).toHaveBeenCalledOnce()
})

it('does not let a delayed older ordinary hook replace a newer accepted conversation', async () => {
  registry.register(input(A, transcript, '%2'))
  const f = await httpFixture()
  const other = join(home, 'sessions', `rollout-${B}.jsonl`); writeFileSync(other, header(B))
  const time = Date.now() + 10_000
  expect((await f.post({ sessionId: B, transcriptPath: other, prompt: 'newer' }, { firedAt: time + 1 })).body).toEqual({ ok: true })
  expect((await f.post({ prompt: 'older' }, { firedAt: time })).body).toEqual({ ignored: true, reason: 'stale_hook' })
  expect(registry.byAgent(source)?.sessionId).toBe(B)
  expect(f.prompts).toEqual(['newer'])
})

it('acknowledges a repeated delivery both while held and after acceptance without crediting it twice', async () => {
  const f = await httpFixture()
  const delivery = { id: 'fixture-delivery-0001' }
  fault.rename = true
  expect((await f.post({}, delivery)).body).toEqual({ pending: true })
  expect((await f.post({}, delivery)).body).toEqual({ pending: true })
  expect(await f.post({ prompt: 'conflicting prompt' }, delivery)).toEqual({ status: 409, body: { pending: false, error: 'HOOK_DELIVERY_CONFLICT' } })
  fault.rename = false
  await vi.waitFor(() => expect(f.prompts).toHaveLength(1), { timeout: 4_000 })
  expect((await f.post({}, delivery)).body).toEqual({ ok: true })
  expect(f.prompts).toEqual(['fixture prompt'])
  expect(f.registered).toHaveBeenCalledOnce()
})

it('holds new deliveries at receipt capacity without evicting completed acknowledgements', async () => {
  const f = await httpFixture(() => false, 1)
  const original = { id: 'fixture-delivery-0001' }
  expect((await f.post({}, original)).body).toEqual({ ok: true })
  expect((await f.post({}, { id: 'fixture-delivery-0002' })).status).toBe(429)
  expect((await f.post({}, original)).body).toEqual({ ok: true })
  expect(f.prompts).toHaveLength(1)
})

it('bounds retained native payload bytes without dropping an already-owned prompt', async () => {
  const f = await httpFixture(() => false, 65_536, {}, 100_000)
  fault.rename = true
  const delivery = { id: 'fixture-delivery-0001' }
  const prompt = 'x'.repeat(40_000)
  expect((await f.post({ prompt }, delivery)).body).toEqual({ pending: true })
  expect((await f.post({ prompt }, { id: 'fixture-delivery-0002' })).status).toBe(429)
  fault.rename = false
  await vi.waitFor(() => expect(f.prompts).toEqual([prompt]), { timeout: 3_000 })
  expect((await f.post({ prompt }, delivery)).body).toEqual({ ok: true })
  expect((await f.post({ prompt }, { id: 'fixture-delivery-0002' })).body).toEqual({ ok: true })
})

it('keeps a completed delivery acknowledgement when the same process gains another route', async () => {
  const f = await httpFixture()
  const delivery = { id: 'fixture-delivery-0001' }
  expect((await f.post({}, delivery)).body).toEqual({ ok: true })
  const row = registry.byAgent(source)!
  row.runtimes.push({ backend: 'tmux', paneId: '%3' })
  row.primaryRuntimeKey = 'tmux\u0000%3'
  expect((await f.post({}, delivery)).body).toEqual({ ok: true })
  expect(f.prompts).toEqual(['fixture prompt'])
  expect(f.registered).toHaveBeenCalledOnce()
})

it('refuses an HTTP hook whose matched process changed at the real core resolver continuation', async () => {
  const discovery = await import('./terminalAgentDiscovery.js')
  vi.spyOn(discovery, 'processRows').mockResolvedValue([
    { pid: 6102, parentPid: 5102, startMarker: 'fixture-start', executable: '<hook>', args: '' },
    { pid: 5102, parentPid: 1, startMarker: 'fixture-start', executable: '<codex>', args: '' },
  ])
  const { createEngineHooks } = await import('../core/engines/hooks.js')
  const row = registry.byAgent(source)!
  const hooks = createEngineHooks({ tmuxBackend: {}, syncSession: vi.fn(), registry: { byAgent: registry.byAgent, byRuntimeEngine: () => {
    queueMicrotask(() => { row.processIdentity!.startMarker = 'replacement' })
    return row
  } }, agentReconciler: { triggerHint: vi.fn(async () => true), trigger: vi.fn() } as never })
  const f = await httpFixture(() => false, 65_536, { resolveHookAgent: hooks.resolveHookAgent })
  expect((await f.post({ callerPid: 6102 })).body).toEqual({ ignored: true, reason: 'stale_hook' })
  expect(f.prompts).toEqual([])
  expect(f.registered).not.toHaveBeenCalled()
  expect(row.sessionId).toBe('')
})

it.each(['cursor', 'commandcode'] as const)('retains %s Stop before recovered registration can attach or close a newer turn', async engine => {
  if (engine === 'commandcode') {
    const { commandcodeTranscriptPath } = await import('../engines/commandcode/contract.js')
    const path = commandcodeTranscriptPath(root, A)!
    mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, '{}\n')
  }
  const owner = registry.openProcessAgent({ engine, tmuxPane: '%3', cwd: root,
    processIdentity: { pid: 7103, startMarker: 'fixture-start', executable: '<engine>' } })!.entry
  const onTurnStop = vi.fn(), order: string[] = []
  let retain = false
  const onAdmissionStop = vi.fn((_row, unmatched) => { expect(unmatched).toBe(true); order.push('retain'); return retain })
  const f = await httpFixture(() => false, 65_536, { onTurnStop, onAdmissionStop,
    onRegistered: () => { order.push('attach'); expect(order[order.length - 2]).toBe('retain') } })
  const delivery = { id: 'fixture-stop-delivery-01', firedAt: Date.now() }
  const body = { engine, sessionId: A, transcriptPath: undefined, tmuxPane: '%3', callerPid: 7203,
    hookEvent: engine === 'cursor' ? 'stop' : 'Stop', prompt: undefined, status: 'error' }
  fault.rename = true
  expect((await f.post(body, delivery)).body).toEqual({ pending: true })
  expect((await f.post(body, delivery, 'turn-stop')).body).toEqual({ pending: true })
  expect(onAdmissionStop).not.toHaveBeenCalled()
  fault.rename = false
  await vi.waitFor(() => expect(onAdmissionStop).toHaveBeenCalled(), { timeout: 3_000 })
  expect(order).not.toContain('attach')
  // Native binding is durable now, but a refused completion claim remains pending.
  expect(registry.byAgent(owner.agentId)?.sessionId).toBe(A)
  retain = true
  await vi.waitFor(() => expect(order).toContain('attach'), { timeout: 3_000 })
  expect(onTurnStop).not.toHaveBeenCalled()
  expect((await f.post(body, delivery, 'turn-stop')).body).toEqual({ pending: true })
  expect((await f.post({ ...body, status: 'done' }, delivery, 'turn-stop')).status).toBe(409)
  expect((await f.post({ ...body, transcriptPath: '/fixture/changed' }, delivery, 'turn-stop')).status).toBe(409)
  expect(onTurnStop).not.toHaveBeenCalled()
})

it('claims an immediate already-bound linked Stop once, including concurrent retries', async () => {
  const owner = registry.openProcessAgent({ engine: 'cursor', tmuxPane: '%3', cwd: root,
    processIdentity: { pid: 7103, startMarker: 'fixture-start', executable: '<engine>' } })!.entry
  registry.register({ engine: 'cursor', sessionId: A, tmuxPane: '%3', cwd: root, processIdentity: owner.processIdentity! })
  const onTurnStop = vi.fn()
  const f = await httpFixture(() => false, 65_536, { onTurnStop, onAdmissionStop: (_row, unmatched) => {
    expect(unmatched).toBe(false); return false
  } })
  const delivery = { id: 'fixture-stop-delivery-02', firedAt: Date.now() }
  const body = { engine: 'cursor', sessionId: A, transcriptPath: undefined, tmuxPane: '%3', hookEvent: 'stop', prompt: undefined }
  expect((await f.post(body, delivery)).body).toEqual({ ok: true })
  expect((await Promise.all([f.post(body, delivery, 'turn-stop'), f.post(body, delivery, 'turn-stop')])).map(value => value.body))
    .toEqual([{ ok: true }, { ok: true, duplicate: true }])
  expect((await f.post(body, delivery, 'turn-stop')).body).toEqual({ ok: true, duplicate: true })
  expect(onTurnStop).toHaveBeenCalledExactlyOnceWith({ sessionId: A, status: undefined, transcriptPath: undefined, firedAt: delivery.firedAt })
})

it.each([false, true])('retains an overtaking Stop after process resolution recovers, with onWait: %s', async waiting => {
  const owner = registry.openProcessAgent({ engine: 'cursor', tmuxPane: '%3', cwd: root,
    processIdentity: { pid: 7103, startMarker: 'fixture-start', executable: '<engine>' } })!.entry
  registry.register({ engine: 'cursor', sessionId: A, tmuxPane: '%3', cwd: root, processIdentity: owner.processIdentity! })
  let finish: ((row: typeof owner) => void) | undefined
  const held = vi.fn(() => true), stopped = vi.fn()
  const f = await httpFixture(() => false, 65_536, { onAdmissionStop: held, onTurnStop: stopped,
    resolveHookAgent: async ({ onWait }) => { if (waiting) onWait?.(); return new Promise(resolve => { finish = resolve }) } })
  const delivery = { id: 'fixture-stop-delivery-03', firedAt: Date.now() }
  const body = { engine: 'cursor', sessionId: A, transcriptPath: undefined, tmuxPane: '%3', hookEvent: 'stop', prompt: undefined }
  const registration = f.post(body, delivery)
  if (waiting) expect(await registration).toMatchObject({ status: 202, body: { pending: false, retry: true } })
  await vi.waitFor(() => expect(finish).toBeDefined())
  expect(await f.post(body, delivery, 'turn-stop')).toMatchObject({ status: 202, body: { pending: false, retry: true } })
  finish!(structuredClone(registry.byAgent(owner.agentId)!))
  await registration
  await vi.waitFor(() => expect(held).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agentId: owner.agentId }), true))
  expect(stopped).not.toHaveBeenCalled()
})

it.each([false, true])('keeps a held delivery through route changes and requires its original pane: %s', async removeHint => {
  const f = await httpFixture(), delivery = { id: 'fixture-held-route-01', firedAt: Date.now() }
  fault.rename = true
  expect((await f.post({}, delivery)).body).toEqual({ pending: true })
  fault.rename = false
  registry.updateRuntimes(source, removeHint ? [{ backend: 'tmux', paneId: '%3' }]
    : [{ backend: 'tmux', paneId: '%2' }, { backend: 'tmux', paneId: '%3' }], 'tmux\u0000%3')
  if (removeHint) {
    await vi.waitFor(() => expect(f.reasons.some(reason => reason?.includes('original hook pane'))).toBe(true), { timeout: 3_000 })
    expect(f.prompts).toEqual([])
    registry.updateRuntimes(source, [{ backend: 'tmux', paneId: '%2' }, { backend: 'tmux', paneId: '%3' }], 'tmux\u0000%3')
  }
  expect((await f.post({}, delivery)).body).toEqual({ pending: true })
  await vi.waitFor(() => expect(f.prompts).toEqual(['fixture prompt']), { timeout: 3_000 })
  expect(registry.byAgent(source)?.primaryRuntimeKey).toBe('tmux\u0000%3')
  expect(registry.byAgent(source)?.runtimes).toEqual([{ backend: 'tmux', paneId: '%2' }, { backend: 'tmux', paneId: '%3' }])
  expect((await f.post({}, delivery)).body).toEqual({ ok: true })
  expect(f.registered).toHaveBeenCalledOnce()
})

it('holds a same-owner linked Stop after interpretation recovered, without closing its later turn', async () => {
  const owner = registry.openProcessAgent({ engine: 'cursor', tmuxPane: '%3', cwd: root,
    processIdentity: { pid: 7103, startMarker: 'fixture-start', executable: '<engine>' } })!.entry
  registry.register({ engine: 'cursor', sessionId: A, tmuxPane: '%3', cwd: root, processIdentity: owner.processIdentity! })
  const onTurnStop = vi.fn(), holds: boolean[] = []
  const f = await httpFixture(() => false, 65_536, { onTurnStop, onAdmissionStop: (row, unmatched) => {
    holds.push(unmatched)
    if (unmatched) row.interpretationHold = 'Stop could not be matched to its turn'
    return unmatched
  } })
  const delivery = { id: 'fixture-stop-recovered-01', firedAt: Date.now() }
  const body = { engine: 'cursor', sessionId: A, transcriptPath: undefined, tmuxPane: '%3', hookEvent: 'stop', prompt: undefined }
  expect((await f.post(body, delivery)).body).toEqual({ ok: true })
  const row = registry.byAgent(owner.agentId)!
  row.identityHold = 'native source unavailable'
  row.evidenceRevision = (row.evidenceRevision ?? 0) + 1
  delete row.identityHold
  row.evidenceRevision++
  expect((await f.post(body, delivery, 'turn-stop')).body).toEqual({ pending: true })
  expect(row.interpretationHold).toContain('could not be matched')
  expect(holds).toEqual([false, true])
  expect(onTurnStop).not.toHaveBeenCalled()
  // A later Cancel clears interpretation; a duplicate must not recreate the old obligation.
  delete row.interpretationHold
  expect((await f.post(body, delivery, 'turn-stop')).body).toEqual({ pending: true })
  expect(row.interpretationHold).toBeUndefined()
  expect(holds).toEqual([false, true])
})

it.each(['before-followup', 'during-followup', 'during-registration', 'during-initial-resolution'] as const)('Cancel supersedes original Stop %s without closing a newer turn', async phase => {
  const { createAttach } = await import('../core/transcripts/attach.js')
  const { createSessionNormalizers } = await import('../core/transcripts/normalizers.js')
  const owner = registry.openProcessAgent({ engine: 'cursor', tmuxPane: '%3', cwd: root,
    processIdentity: { pid: 7103, startMarker: 'fixture-start', executable: '<engine>' } })!.entry
  registry.register({ engine: 'cursor', sessionId: A, tmuxPane: '%3', cwd: root, processIdentity: owner.processIdentity! })
  const row = registry.byAgent(owner.agentId)!
  // Only the core's eager cancellation fence is needed. Unexpected attachment
  // or native interpretation would fail this fixture before any external access.
  const attach = createAttach({ normalizers: createSessionNormalizers(), resolve: registry.byAgent } as import('../core/transcripts/attach.js').AttachDeps)
  let laterTurnOpen = false, resolutions = 0
  let finish: (() => void) | undefined
  const onTurnStop = vi.fn(() => { laterTurnOpen = false })
  const onAdmissionStop = vi.fn(() => false)
  const f = await httpFixture(() => false, 65_536, { onTurnStop, onAdmissionStop,
    captureAdmissionStop: attach.captureAdmissionStop,
    resolveHookAgent: async () => {
      resolutions++
      if (phase === 'during-followup' && resolutions === 2 || phase === 'during-initial-resolution' && resolutions === 1) {
        await new Promise<void>(resolve => { finish = resolve })
      }
      return structuredClone(registry.byAgent(row.agentId)!)
    } })
  const delivery = { id: 'fixture-stop-cancelled-01', firedAt: Date.now() }
  const body = { engine: 'cursor', sessionId: A, transcriptPath: undefined, tmuxPane: '%3', hookEvent: 'stop', prompt: undefined }
  if (phase === 'during-registration') fault.rename = true
  const registration = f.post(body, delivery)
  if (phase === 'during-initial-resolution') await vi.waitFor(() => expect(finish).toBeDefined())
  else expect((await registration).body).toEqual(phase === 'during-registration' ? { pending: true } : { ok: true })
  const followup = phase === 'during-followup' ? f.post(body, delivery, 'turn-stop') : undefined
  if (followup) await vi.waitFor(() => expect(finish).toBeDefined())
  attach.beforeCancel(row)
  laterTurnOpen = true
  if (phase === 'during-initial-resolution') {
    // A retry must share the original cancellation witness, even when it could
    // resolve sooner after Cancel than the first request that was already taken.
    expect(await f.post(body, delivery)).toMatchObject({ status: 202, body: { pending: false, retry: true } })
    expect(await f.post({ ...body, title: 'different delivery' }, delivery)).toMatchObject({ status: 409 })
    expect(resolutions).toBe(1)
  }
  fault.rename = false
  finish?.()
  await registration
  if (phase === 'during-registration') await vi.waitFor(() => expect(f.registered).toHaveBeenCalledOnce(), { timeout: 3_000 })
  expect((await (followup ?? f.post(body, delivery, 'turn-stop'))).body).toEqual({ ok: true, duplicate: true })
  expect(onTurnStop).not.toHaveBeenCalled()
  expect(onAdmissionStop).toHaveBeenCalledTimes(phase === 'during-registration' || phase === 'during-initial-resolution' ? 0 : 1)
  expect(laterTurnOpen).toBe(true)
  attach.forget(A)
})

it('rechecks the completion claim after a concurrent duplicate waits across recovery', async () => {
  const owner = registry.openProcessAgent({ engine: 'cursor', tmuxPane: '%3', cwd: root,
    processIdentity: { pid: 7103, startMarker: 'fixture-start', executable: '<engine>' } })!.entry
  registry.register({ engine: 'cursor', sessionId: A, tmuxPane: '%3', cwd: root, processIdentity: owner.processIdentity! })
  const finishes: Array<() => void> = [], onAdmissionStop = vi.fn(() => false)
  let resolutions = 0
  const onTurnStop = vi.fn(() => {
    const row = registry.byAgent(owner.agentId)!
    row.evidenceRevision = (row.evidenceRevision ?? 0) + 1
  })
  const f = await httpFixture(() => false, 65_536, { onTurnStop, onAdmissionStop,
    resolveHookAgent: async () => {
      if (++resolutions > 1) await new Promise<void>(resolve => finishes.push(resolve))
      return structuredClone(registry.byAgent(owner.agentId)!)
    } })
  const delivery = { id: 'fixture-stop-concurrent-01', firedAt: Date.now() }
  const body = { engine: 'cursor', sessionId: A, transcriptPath: undefined, tmuxPane: '%3', hookEvent: 'stop', prompt: undefined }
  expect((await f.post(body, delivery)).body).toEqual({ ok: true })
  const first = f.post(body, delivery, 'turn-stop')
  await vi.waitFor(() => expect(finishes).toHaveLength(1))
  const duplicate = f.post(body, delivery, 'turn-stop')
  await vi.waitFor(() => expect(finishes).toHaveLength(2))
  finishes[0]()
  expect((await first).body).toEqual({ ok: true })
  finishes[1]()
  expect((await duplicate).body).toEqual({ ok: true, duplicate: true })
  expect(onTurnStop).toHaveBeenCalledOnce()
  expect(onAdmissionStop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: A }), false)
})

it.each(['records', 'bytes'] as const)('never lets a linked Stop bypass refused admission at %s capacity', async capacity => {
  const owner = registry.openProcessAgent({ engine: 'cursor', tmuxPane: '%3', cwd: root,
    processIdentity: { pid: 7103, startMarker: 'fixture-start', executable: '<engine>' } })!.entry
  registry.register({ engine: 'cursor', sessionId: A, tmuxPane: '%3', cwd: root, processIdentity: owner.processIdentity! })
  const onTurnStop = vi.fn()
  const f = await httpFixture(() => false, capacity === 'records' ? 0 : 65_536, { onTurnStop }, capacity === 'bytes' ? 0 : undefined)
  const delivery = { id: 'fixture-unowned-stop-01', firedAt: Date.now() }
  const body = { engine: 'cursor', sessionId: A, transcriptPath: undefined, tmuxPane: '%3', hookEvent: 'stop', prompt: undefined }
  expect(await f.post(body, delivery)).toMatchObject({ status: 429, body: { pending: false } })
  expect(await f.post(body, delivery, 'turn-stop')).toMatchObject({ status: 202, body: { pending: false, retry: true } })
  expect(onTurnStop).not.toHaveBeenCalled()
  expect(await f.post(body, {}, 'turn-stop')).toMatchObject({ status: 200, body: { ok: true } })
  expect(onTurnStop).toHaveBeenCalledOnce()
})
