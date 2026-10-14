import type { Server } from 'node:http'
import type { HookServerHandlers } from '../hookServer.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// These are ownership and injected-I/O outcomes, independent of host scheduling. Actual
// elapsed-work deadlines are exercised separately in engines/kit/nativeEvidence.spec.ts.
const clock = vi.hoisted(() => ({ now: 0 }))
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => clock.now } }))

const fault = vi.hoisted(() => ({ file: '', rename: false, directorySync: false, renamed: false, nativeSync: false,
  nativeWritten: new Map<number, string>(), beforeNativeSync: undefined as ((text?: string) => void) | undefined,
  afterNativeLink: undefined as ((file: string) => void) | undefined,
  afterProof: undefined as (() => void) | undefined, beforeVerify: undefined as (() => void) | undefined }))
vi.mock('fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, fsync: (_fd: number, done: (error: Error | null) => void) => {
    fault.beforeNativeSync?.(fault.nativeWritten.get(_fd))
    queueMicrotask(() => done(fault.nativeSync ? Error('fixture native confirmation unavailable') : null))
  }, writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
    const result = actual.writeFileSync(...args)
    if (typeof args[0] === 'number') fault.nativeWritten.set(args[0], String(args[1]))
    return result
  }, closeSync: (fd: number) => { fault.nativeWritten.delete(fd); return actual.closeSync(fd) },
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      const result = actual.linkSync(...args); fault.afterNativeLink?.(String(args[1])); return result
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
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
    return { ...proof, verify: (...selected: Parameters<typeof proof.verify>) => { fault.beforeVerify?.(); proof.verify(...selected) },
      retain: (...selected: Parameters<typeof proof.retain>) => {
        const retained = proof.retain(...selected)
        return () => { fault.beforeVerify?.(); retained() }
      } }
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
  clock.now = 0
  fault.nativeSync = false
  fault.beforeNativeSync = undefined
  fault.afterNativeLink = undefined
  fault.nativeWritten.clear()
  fault.rename = false; fault.directorySync = false; fault.renamed = false; fault.afterProof = undefined; fault.beforeVerify = undefined
  root = realpathSync(mkdtempSync(join(tmpdir(), 'registry-admission-')))
  home = join(root, 'codex'); file = join(root, 'data', 'registry.json'); fault.file = file
  mkdirSync(join(home, 'sessions'), { recursive: true }); mkdirSync(join(root, 'data'))
  for (const [key, value] of Object.entries({ HOME: root, ADAPTER_DATA_DIR: join(root, 'data'),
    ADAPTER_RUNTIME_DIR: join(root, 'runtime'), CODEX_HOME: home, CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CLAUDE_PROJECTS_DIR: join(root, 'claude', 'projects'),
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
  fault.nativeSync = false
  fault.beforeNativeSync = undefined
  fault.afterNativeLink = undefined
  fault.nativeWritten.clear()
  fault.rename = false; fault.directorySync = false; fault.renamed = false; fault.afterProof = undefined; fault.beforeVerify = undefined
  vi.restoreAllMocks(); vi.doUnmock('../engines/transcriptBindings.js'); vi.doUnmock('../engines/kit/nativeHookJournal.js')
  vi.doUnmock('../core/engines/pendingAdmission.js')
  vi.unstubAllEnvs(); vi.resetModules(); rmSync(root, { recursive: true, force: true })
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
it('prepares a registration without publication before its durable hook claim is available', async () => {
  const before = snapshot()
  const staged = registry.prepareRegistration(input())!
  unchanged(before)
  await Promise.resolve()
  const fence = vi.fn(() => {
    expect(JSON.parse(readFileSync(join(file + '.lock', 'owner.json'), 'utf8')).pid).toBe(process.pid)
    unchanged(before)
  })
  expect(staged.commit(fence)?.entry.sessionId).toBe(A)
  expect(fence).toHaveBeenCalledOnce()
  expect(registry.bySession(A)?.agentId).toBe(target)
})
it('keeps a prepared registration unchanged when its asynchronous claim loses authority', async () => {
  const before = snapshot(), staged = registry.prepareRegistration(input())!
  await Promise.resolve()
  expect(() => staged.commit(() => { throw Error('fixture claim revoked') })).toThrow('fixture claim revoked')
  unchanged(before)
})
it('does not publish a prepared registration over a changed live owner', async () => {
  const staged = registry.prepareRegistration(input())!
  await Promise.resolve()
  registry.byAgent(target)!.title = 'A newer live observation'
  const before = snapshot()
  expect(() => staged.commit()).toThrow('prepared registration owner changed')
  unchanged(before)
})
it('rechecks prepared native evidence after an asynchronous claim boundary', async () => {
  const before = snapshot(), staged = registry.prepareRegistration(input())!
  await Promise.resolve()
  writeFileSync(transcript, header(B))
  expect(() => staged.commit()).toThrow('header changed')
  unchanged(before)
})
it('captures prepared registration inputs before the asynchronous claim boundary', async () => {
  const body = { ...input(), runtimes: [{ backend: 'tmux' as const, paneId: '%1' }] }
  const options = { verifiedNativeSource: false }
  const staged = registry.prepareRegistration(body, options)!
  await Promise.resolve()
  body.processIdentity.pid = 9999
  body.runtimes[0]!.paneId = '%99'
  body.cwd = '/fixture/changed'
  options.verifiedNativeSource = true
  const saved = staged.commit()!.entry
  expect(saved.processIdentity?.pid).toBe(5101)
  expect(saved.runtimes).toEqual([{ backend: 'tmux', paneId: '%1' }])
  expect(saved.cwd).toBe(root)
})
it.each([false, true])('verifies prepared registration facts under a fresh budget after a long disk wait (replaced=%s)', async replaced => {
  const before = snapshot(), staged = registry.prepareRegistration(input())!
  await Promise.resolve()
  clock.now = 10_000
  if (replaced) {
    // Keep the former inode allocated: unlink/recreate may immediately reuse it
    // on Linux, so that operation alone does not establish a distinct file.
    const prior = statSync(transcript, { bigint: true })
    renameSync(transcript, transcript + '.fixture-prior'); writeFileSync(transcript, header())
    const next = statSync(transcript, { bigint: true })
    expect(`${next.dev}:${next.ino}`).not.toBe(`${prior.dev}:${prior.ino}`)
    expect(() => staged.commit()).toThrow('changed')
    unchanged(before)
  } else expect(staged.commit()?.entry.sessionId).toBe(A)
})
it.each([false, true])('retains the complete bounded home pool across a disk wait (changed root=%s)', async changed => {
  const homes = Array.from({ length: 63 }, (_, index) => join(root, 'profiles', String(index), 'config', 'native', 'codex'))
  for (const directory of homes) mkdirSync(join(directory, 'sessions'), { recursive: true })
  writeFileSync(join(root, 'data', 'engine-homes.json'), JSON.stringify({ codex: homes }))
  const before = snapshot(), staged = registry.prepareRegistration(input())!
  await Promise.resolve()
  clock.now = 10_000
  if (changed) {
    const directory = join(homes.at(-1)!, 'sessions')
    renameSync(directory, `${directory}.old`); mkdirSync(directory)
    expect(() => staged.commit()).toThrow('changed')
    unchanged(before)
  } else expect(staged.commit()?.entry.sessionId).toBe(A)
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
  overrides: Partial<HookServerHandlers> = {}, admissionBytesCapacity?: number, deferNativeRecovery = false) {
  const { startHookServer } = await import('../hookServer.js')
  const { readHookCredential } = await import('./hookAuth.js')
  const prompts: string[] = [], registered = vi.fn<HookServerHandlers['onRegistered']>(), reasons: Array<string | undefined> = []
  const started = await startHookServer(0, { onRegistered: registered, onSessionEnd: () => {},
    hookAdmissionBlocked: blocked,
    onPromptSubmitted: (_id, text) => prompts.push(text),
    onAdmissionHeld: (_id, reason) => reasons.push(reason),
    ...overrides,
  }, { admissionReceiptCapacity, admissionBytesCapacity, deferNativeRecovery })
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
  return { post, prompts, registered, reasons, startRecovery: started.startRecovery, stopRecovery: started.stopRecovery,
    drainAndStopRecovery: started.drainAndStopRecovery, recoveryReady: started.recoveryReady, transcriptReady: started.transcriptReady }
}

it.each(['queued successor', 'changed binding'])('recovers an undelivered claim with a %s without replay or stale rebinding', async change => {
  const f = await httpFixture(undefined, undefined, {}, undefined, true)
  let interrupted = false
  fault.afterNativeLink = path => {
    if (!interrupted && path.includes('.witnesses/') && JSON.parse(readFileSync(path, 'utf8')).event?.kind === 'claim') {
      interrupted = true; fault.nativeSync = true
    }
  }
  const firedAt = Date.now()
  expect((await f.post({}, { id: 'fixture-undelivered-first', firedAt })).body).toEqual({ pending: true })
  await vi.waitFor(() => expect(f.reasons.some(reason => reason?.includes('fixture native confirmation unavailable'))).toBe(true))
  expect(interrupted).toBe(true)
  expect(f.registered).not.toHaveBeenCalled()
  expect(f.prompts).toEqual([])
  const successor = join(home, 'sessions', `rollout-${B}.jsonl`)
  writeFileSync(successor, header(B))
  fault.nativeSync = false
  if (change === 'changed binding') expect(registry.register(input(B, successor, '%2'))?.entry.sessionId).toBe(B)
  else {
    const next = await f.post({ sessionId: B, transcriptPath: successor, prompt: 'successor prompt' },
      { id: 'fixture-undelivered-next', firedAt: firedAt + 1 })
    expect(next.status).toBe(200)
    expect([{ pending: true }, { ok: true }]).toContainEqual(next.body)
  }
  f.startRecovery()
  if (change === 'queued successor') {
    await vi.waitFor(() => expect(f.prompts).toEqual(['fixture prompt', 'successor prompt']), { timeout: 5000 })
    expect(f.registered.mock.calls.map(([row]) => row.sessionId)).toEqual([A, B])
  } else {
    await vi.waitFor(async () => expect((await f.post({}, { id: 'fixture-undelivered-first', firedAt })).body)
      .toEqual({ ignored: true, reason: 'stale_hook' }), { timeout: 5000 })
    expect(f.registered).not.toHaveBeenCalled()
    expect(f.prompts).toEqual([])
  }
  expect(registry.byAgent(source)?.sessionId).toBe(B)
}, 10_000)

it.each(['accepted', 'rejected'] as const)('does not publish a %s admission whose claim finishes after graceful shutdown starts', async decision => {
  let release!: () => void
  const gate = new Promise<void>(done => { release = done }), finishing = vi.fn(), claimed = vi.fn()
  vi.doMock('../engines/kit/nativeHookJournal.js', async original => {
    const actual = await original<typeof import('../engines/kit/nativeHookJournal.js')>()
    return { ...actual, createNativeHookJournal: (options: Parameters<typeof actual.createNativeHookJournal>[0]) => {
      const journal = actual.createNativeHookJournal(options)
      return { ...journal, claim: async (...args: Parameters<typeof journal.claim>) => {
        const claim = await journal.claim(...args)
        claimed(); await gate
        return { ...claim, finish: async (value: Parameters<typeof claim.finish>[0]) => { finishing(); await claim.finish(value) } }
      } }
    } }
  })
  if (decision === 'rejected') writeFileSync(transcript, header(A, true))
  const ready = vi.fn(), f = await httpFixture(undefined, undefined, { onNativeRecoveryReady: ready })
  expect((await f.post({}, { id: 'fixture-claim-during-shutdown' })).body).toEqual({ pending: true })
  expect(claimed).toHaveBeenCalledOnce()
  ready.mockClear()
  await f.drainAndStopRecovery()
  release()
  await new Promise(resolve => setTimeout(resolve, 25))
  expect(finishing).not.toHaveBeenCalled()
  expect(f.registered).not.toHaveBeenCalled()
  expect(f.prompts).toEqual([])
  expect(ready).not.toHaveBeenCalled()
})

async function interruptedPrompt(over: Record<string, unknown> = {}, prefix = true) {
  registry.register(input(A, transcript, '%2'))
  const readNativeHookOwner: NonNullable<HookServerHandlers['readNativeHookOwner']> = async row => ({
    key: `fixture-observation-${row.processIdentity!.pid}`, evidence: 'fixture-original-image', verify() {},
  })
  const first = await httpFixture(undefined, undefined, { readNativeHookOwner }, undefined, true)
  if (prefix) {
    const earlier = { id: 'fixture-cold-observation-binding', firedAt: Date.now() }
    await first.post({ hookEvent: 'SessionStart' }, earlier)
    await vi.waitFor(async () => expect((await first.post({ hookEvent: 'SessionStart' }, earlier)).body).toMatchObject({ ok: true }))
    expect(first.registered).toHaveBeenCalledOnce()
    first.registered.mockClear(); first.prompts.length = 0
  }
  let interrupted = false
  fault.afterNativeLink = path => {
    if (!interrupted && path.includes('.witnesses/') && JSON.parse(readFileSync(path, 'utf8')).event?.kind === 'claim') {
      interrupted = true; fault.nativeSync = true
    }
  }
  const order = { id: 'fixture-cold-observation-prompt', firedAt: Date.now() + 1 }
  await first.post(over, order)
  await vi.waitFor(() => expect(first.reasons.some(reason => reason?.includes('fixture native confirmation unavailable'))).toBe(true))
  expect(interrupted).toBe(true)
  expect(first.registered).not.toHaveBeenCalled()
  expect(first.prompts).toEqual([])
  expect(registry.bySession(A)?.agentId).toBe(source)
  first.stopRecovery()
  await new Promise<void>(resolve => server!.close(() => resolve()))
  fault.nativeSync = false; fault.afterNativeLink = undefined
  vi.resetModules(); observeNativeProof(); ({ registry } = await import('./registry.js')); registry.load()
  const row = registry.byAgent(source)!
  expect(row.sessionId).toBe(A)
  expect(row.transcriptPath).toBe(transcript)
  expect(row.identityHold).toBeUndefined()
  const directory = join(root, 'data', 'native-hook-deliveries')
  const history = join(directory, readdirSync(directory).find(name => /^[a-f0-9]{64}$/.test(name))!)
  const journal = () => readdirSync(history + '.witnesses').filter(name => /^\d{8}\.json$/.test(name)).sort()
    .map(name => readFileSync(join(history + '.witnesses', name), 'utf8'))
  return { readNativeHookOwner, row, order, journal }
}

it('observes an existing transcript after a cold uncertain prompt without recovering its effect authority', async () => {
  const { readNativeHookOwner, row, order, journal } = await interruptedPrompt()
  const attached = vi.fn(), promptHook = vi.fn()
  const recovered = await httpFixture(undefined, undefined, { readNativeHookOwner, onNativeTranscriptReady: attached,
    onPromptHook: promptHook }, undefined, true)
  const before = journal()
  expect(JSON.parse(before.at(-1)!).event).toMatchObject({ kind: 'claim', id: order.id })
  expect(recovered.transcriptReady(row)).toBe(false)
  recovered.startRecovery()
  await vi.waitFor(() => expect(recovered.transcriptReady(row)).toBe(true), { timeout: 4_000 })
  expect(attached).toHaveBeenCalledExactlyOnceWith(row)
  expect(recovered.recoveryReady(row)).toBe(false)
  expect(recovered.reasons.at(-1)).toContain('interrupted by the previous core')
  expect(recovered.registered).not.toHaveBeenCalled()
  expect(recovered.prompts).toEqual([])
  expect(promptHook).not.toHaveBeenCalled()
  expect((await recovered.post({}, order)).body).toMatchObject({ pending: true })
  expect(recovered.recoveryReady(row)).toBe(false)
  expect(journal()).toEqual(before)
  recovered.stopRecovery()
  expect(recovered.transcriptReady(row)).toBe(false)
}, 10_000)

it('tails later native turns after a cold uncertain prompt while automatic Close stays held', async () => {
  const { readNativeHookOwner, row, journal } = await interruptedPrompt()
  const { createAttach } = await import('../core/transcripts/attach.js')
  const { createSessionNormalizers } = await import('../core/transcripts/normalizers.js')
  const { createAgentClosing } = await import('../core/agents/close.js')
  const { createIngest } = await import('../core/transcripts/ingest.js')
  const { liveFor } = await import('../engines/live.js')
  const { Watcher } = await import('../watcher/watcher.js')
  const normalizers = createSessionNormalizers(), watcher = new Watcher(), emit = vi.fn(), stop = vi.fn()
  let f: Awaited<ReturnType<typeof httpFixture>> | undefined
  const attach = createAttach({ liveFor, resolve: id => registry.byAgent(id), normalizers, watcher,
    nativeRecoveryReady: entry => f?.transcriptReady(entry) ?? false,
    terminalGone: async () => false, announceSession: vi.fn(), setInterpretationHold: () => false,
    cursorDiscovery: { add: async () => {} }, device: () => undefined,
    runtimeProfiles: { beginHydrate: () => ({ ingest: () => false, commit: () => false }),
      transcriptFields: () => [], ingestConfig: async () => false, capturePane: async () => null,
    } as unknown as import('../core/transcripts/attach.js').AttachDeps['runtimeProfiles'],
    captureTerminal: async () => null, emit, announceTurnAborted: vi.fn(),
    questionWatcher: { start: vi.fn() }, terminalLabel: () => '<private-pane>',
    dbs: { opencode: '', kilo: '', devin: '' }, devinHome: '', hermesDb: async () => '', concurrency: 1,
  })
  createIngest({ liveFor, has: id => !!registry.bySession(id), bySession: id => registry.bySession(id),
    normalizers, tokenUsage: { changed: vi.fn() }, device: () => undefined, runtimeProfiles: { ingest: vi.fn() },
    announceTurnAborted: vi.fn(), emit, attachSession: attach.attachSession,
  }).wireWatcher(watcher)
  const closing = createAgentClosing({ registry, watcher, nativeRecoveryReady: entry => f!.recoveryReady(entry),
    cleanupTabs: { refresh: async () => {}, isHidden: () => true, assertHidden: async () => {} },
    captureTerminal: async () => null, readScreen: async () => null,
    sessionTurnState: id => normalizers.sessionTurnState(id), openQuestions: { has: () => false },
    terminals: { captureRetained: vi.fn() }, sessionCheckpoints: { save: vi.fn() },
    stopAgent: stop, announceSession: vi.fn(), engineReady: async () => {},
  }).closeAgentService
  const before = journal()
  try {
    f = await httpFixture(undefined, undefined, { readNativeHookOwner,
      onNativeTranscriptReady: async entry => { await attach.attachSession(entry) },
      onAdmissionHeld: (id, reason) => { registry.byAgent(id)!.admissionHold = reason },
    }, undefined, true)
    await attach.attachSession(row)
    expect(normalizers.liveParsers.has(A)).toBe(false)
    f.startRecovery()
    await vi.waitFor(() => expect(normalizers.liveParsers.has(A)).toBe(true))
    const append = (payload: Record<string, unknown>) => writeFileSync(transcript,
      readFileSync(transcript, 'utf8') + JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload }) + '\n')
    append({ type: 'task_started', turn_id: 'fixture-later-native-turn' })
    append({ type: 'user_message', message: 'a later native prompt' })
    await watcher.pollSession(A)
    expect(normalizers.sessionTurnState(A)).toBe(true)
    append({ type: 'task_complete', turn_id: 'fixture-later-native-turn', last_agent_message: 'later native answer' })
    await watcher.pollSession(A)
    expect(normalizers.sessionTurnState(A)).toBe(false)
    expect(emit.mock.calls.flatMap(([, events]) => events).map(event => event.type)).toContain('turn_ended')
    expect(row.admissionHold).toContain('interrupted by the previous core')
    expect(await closing.request({ agentId: row.agentId, sessionId: A,
      createdAt: new Date(row.registeredAt).toISOString(), mode: 'idle' })).toMatchObject({ error: 'SESSION_NOT_IDLE', activity: 'unknown' })
    expect(stop).not.toHaveBeenCalled()
    expect(f.registered).not.toHaveBeenCalled()
    expect(f.prompts).toEqual([])
    expect(journal()).toEqual(before)
  } finally { closing.dispose(); f?.stopRecovery(); attach.forget(A); await watcher.stop() }
})

it.each(['first binding', 'SessionStart', 'Stop', 'other conversation', 'other path', 'binding held'])(
  'keeps transcript observation held for an uncertain %s', async kind => {
    const over = kind === 'SessionStart' || kind === 'Stop' ? { hookEvent: kind }
      : kind === 'other conversation' ? { sessionId: B, transcriptPath: join(home, 'sessions', 'other.jsonl') }
      : kind === 'other path' ? { transcriptPath: join(home, 'sessions', 'other.jsonl') } : {}
    // These sources remain complete evidence. Their relation to the stored binding is what differs.
    if (kind === 'other conversation') writeFileSync(join(home, 'sessions', 'other.jsonl'), header(B))
    if (kind === 'other path') writeFileSync(join(home, 'sessions', 'other.jsonl'), header())
    const { readNativeHookOwner, row } = await interruptedPrompt(over, kind !== 'first binding')
    if (kind === 'binding held') registry.setIdentityHold(row.agentId, 'fixture binding unavailable')
    const attached = vi.fn()
    const recovered = await httpFixture(undefined, undefined, { readNativeHookOwner, onNativeTranscriptReady: attached }, undefined, true)
    expect(recovered.transcriptReady(row)).toBe(false)
    recovered.startRecovery()
    await vi.waitFor(() => expect(recovered.reasons.at(-1)).toContain('interrupted by the previous core'))
    expect(recovered.transcriptReady(row)).toBe(false)
    expect(recovered.recoveryReady(row)).toBe(false)
    expect(attached).not.toHaveBeenCalled()
    expect(recovered.registered).not.toHaveBeenCalled()
  })

it.each(['native proof', 'journal confirmation', 'binding during proof'])(
  'refuses cold transcript observation when %s is unavailable or changes', async kind => {
    const fixture = await interruptedPrompt()
    const attached = vi.fn()
    const readNativeHookOwner: NonNullable<HookServerHandlers['readNativeHookOwner']> = async (row, expected) => {
      if (kind === 'native proof') throw Error('fixture observation native unavailable')
      if (kind === 'binding during proof' && expected) registry.byAgent(source)!.cwd = '/fixture/changed-during-proof'
      return fixture.readNativeHookOwner(row, expected)
    }
    if (kind === 'journal confirmation') fault.nativeSync = true
    const recovered = await httpFixture(undefined, undefined, { readNativeHookOwner, onNativeTranscriptReady: attached }, undefined, true)
    expect(recovered.transcriptReady(fixture.row)).toBe(false)
    recovered.startRecovery()
    await vi.waitFor(() => expect(recovered.reasons.some(Boolean)).toBe(true))
    expect(recovered.transcriptReady(fixture.row)).toBe(false)
    recovered.stopRecovery()
    expect(attached).not.toHaveBeenCalled()
    expect(recovered.registered).not.toHaveBeenCalled()
    expect(recovered.recoveryReady(fixture.row)).toBe(false)
  })

it.each(['frontier', 'binding', 'native proof', 'quiescence', 'final binding'])(
  'revokes an uncertain-prompt transcript grant after %s changes', async kind => {
    const { readNativeHookOwner, row } = await interruptedPrompt()
    let nativeAvailable = true, changeBinding = false
    const recovered = await httpFixture(() => {
      if (changeBinding) registry.byAgent(source)!.cwd = '/fixture/final-binding-change'
      return false
    }, undefined, { readNativeHookOwner: async (...args) => ({
      ...await readNativeHookOwner(...args), verify: () => { if (!nativeAvailable) throw Error('fixture native proof expired') },
    }) }, undefined, true)
    recovered.startRecovery()
    await vi.waitFor(() => expect(recovered.transcriptReady(row)).toBe(true))
    if (kind === 'frontier') {
      const { fixtureNativeHookAdmissionStorage } = await import('../testing/nativeHookAdmissionStorageFixture.js')
      const other = await fixtureNativeHookAdmissionStorage(join(root, 'data', 'native-hook-deliveries'))
      const native = await readNativeHookOwner(row)
      try {
        const writer = await other.effects(native.key)
        await writer.retain({ id: 'fixture-cold-observation-other-event', fingerprint: 'b'.repeat(64),
          agentId: row.agentId, conversationId: A, firedAt: Date.now() + 2, owner: { key: native.key, evidence: native.evidence },
          payload: { engine: 'codex', sessionId: A, transcriptPath: transcript, hookEvent: 'SessionStart' },
        })
      } finally { await other.close() }
    } else if (kind === 'binding') registry.byAgent(source)!.cwd = '/fixture/changed-binding'
    else if (kind === 'native proof') nativeAvailable = false
    else if (kind === 'final binding') changeBinding = true
    else void recovered.drainAndStopRecovery()
    expect(recovered.transcriptReady(row)).toBe(false)
    expect(recovered.recoveryReady(row)).toBe(false)
    expect(recovered.registered).not.toHaveBeenCalled()
    expect(recovered.prompts).toEqual([])
  })

it('rejects transcript permission when full frontier verification exhausts the original native proof', async () => {
  const fixture = await interruptedPrompt()
  let advance = false
  vi.doMock('../engines/kit/nativeHookJournal.js', async original => {
    const actual = await original<typeof import('../engines/kit/nativeHookJournal.js')>()
    return { ...actual, createNativeHookJournal: (options: Parameters<typeof actual.createNativeHookJournal>[0]) => {
      const journal = actual.createNativeHookJournal(options)
      return { ...journal, snapshot: async () => {
        const snapshot = await journal.snapshot()
        return { ...snapshot, verify: () => { snapshot.verify(); if (advance) clock.now += 1 } }
      } }
    } }
  })
  const recovered = await httpFixture(undefined, undefined, { readNativeHookOwner: async (...args) => {
    const native = await fixture.readNativeHookOwner(...args), began = clock.now
    return { ...native, verify: () => { if (clock.now !== began) throw Error('fixture native proof deadline') } }
  } }, undefined, true)
  recovered.startRecovery()
  await vi.waitFor(() => expect(recovered.transcriptReady(fixture.row)).toBe(true))
  advance = true
  expect(recovered.transcriptReady(fixture.row)).toBe(false)
  expect(recovered.recoveryReady(fixture.row)).toBe(false)
})

it('finishes only an already-dispatched terminal receipt during graceful shutdown and recovers without redispatch', async () => {
  let release!: () => void
  const gate = new Promise<void>(done => { release = done })
  vi.doMock('../engines/kit/nativeHookJournal.js', async original => {
    const actual = await original<typeof import('../engines/kit/nativeHookJournal.js')>()
    return { ...actual, createNativeHookJournal: (options: Parameters<typeof actual.createNativeHookJournal>[0]) => {
      const journal = actual.createNativeHookJournal(options)
      return { ...journal, claim: async (...args: Parameters<typeof journal.claim>) => {
        const claim = await journal.claim(...args)
        return { ...claim, finish: async (value: Parameters<typeof claim.finish>[0]) => { await gate; await claim.finish(value) } }
      } }
    } }
  })
  const ready = vi.fn(), order = { id: 'fixture-graceful-terminal-receipt' }
  const f = await httpFixture(undefined, undefined, { onNativeRecoveryReady: ready })
  expect((await f.post({}, order)).body).toEqual({ pending: true })
  expect(f.registered).toHaveBeenCalledOnce()
  ready.mockClear()
  let done = false
  const draining = f.drainAndStopRecovery()
  expect(f.drainAndStopRecovery()).toBe(draining)
  void draining.then(() => { done = true })
  await new Promise(resolve => setTimeout(resolve, 25))
  expect(done).toBe(false)
  expect(f.recoveryReady(registry.byAgent(source)!)).toBe(false)
  expect(await f.post({}, { id: 'fixture-during-graceful-drain' })).toMatchObject({ status: 202, body: { pending: false, retry: true } })
  release(); await draining
  expect(ready).not.toHaveBeenCalled()
  expect(f.registered).toHaveBeenCalledOnce()
  await new Promise<void>(resolve => server!.close(() => resolve()))
  const recovered = await httpFixture()
  expect(await recovered.post({}, order)).toEqual({ status: 200, body: { ok: true } })
  expect(recovered.registered).not.toHaveBeenCalled()
  expect(recovered.prompts).toEqual([])
})

it.each(['deadline', 'immediate stop', 'write rejection'] as const)('bounds terminal receipt draining after %s without inventing an outcome', async mode => {
  let release!: () => void, fail!: (error: Error) => void
  const gate = new Promise<void>((done, reject) => { release = done; fail = reject })
  vi.doMock('../engines/kit/nativeHookJournal.js', async original => {
    const actual = await original<typeof import('../engines/kit/nativeHookJournal.js')>()
    return { ...actual, createNativeHookJournal: (options: Parameters<typeof actual.createNativeHookJournal>[0]) => {
      const journal = actual.createNativeHookJournal(options)
      return { ...journal, claim: async (...args: Parameters<typeof journal.claim>) => {
        const claim = await journal.claim(...args)
        return { ...claim, finish: async (value: Parameters<typeof claim.finish>[0]) => { await gate; await claim.finish(value) } }
      } }
    } }
  })
  const f = await httpFixture(), order = { id: 'fixture-bounded-terminal-drain' }
  expect((await f.post({}, order)).body).toEqual({ pending: true })
  expect(f.registered).toHaveBeenCalledOnce()
  vi.useFakeTimers()
  try {
    let done = false
    const draining = f.drainAndStopRecovery()
    void draining.then(() => { done = true })
    await vi.advanceTimersByTimeAsync(600)
    expect(done).toBe(false)
    expect(f.drainAndStopRecovery()).toBe(draining)
    if (mode === 'immediate stop') f.stopRecovery()
    else if (mode === 'write rejection') fail(Error('fixture result unavailable'))
    else await vi.advanceTimersByTimeAsync(400)
    await draining
    expect(done).toBe(true)
  } finally { vi.useRealTimers(); release() }
  await new Promise<void>(resolve => server!.close(() => resolve()))
  const recovered = await httpFixture()
  expect((await recovered.post({}, order)).body).toEqual({ pending: true })
  expect(recovered.recoveryReady(registry.byAgent(source)!)).toBe(false)
  expect(recovered.registered).not.toHaveBeenCalled()
})

async function afterTerminal(run: (journal: ReturnType<typeof import('../engines/kit/nativeHookJournal.js')['createNativeHookJournal']>) => Promise<void>) {
  vi.doMock('../engines/kit/nativeHookJournal.js', async original => {
    const actual = await original<typeof import('../engines/kit/nativeHookJournal.js')>()
    let once = false
    return { ...actual, createNativeHookJournal: (options: Parameters<typeof actual.createNativeHookJournal>[0]) => {
      const journal = actual.createNativeHookJournal(options)
      return { ...journal, claim: async (...args: Parameters<typeof journal.claim>) => {
        const claim = await journal.claim(...args)
        return { ...claim, finish: async (value: Parameters<typeof claim.finish>[0]) => {
          await claim.finish(value)
          if (!once) { once = true; await run(actual.createNativeHookJournal(options)) }
        } }
      } }
    } }
  })
}

it('keeps attachment held for an intake appended while the preceding result completes', async () => {
  await afterTerminal(async peer => {
    await peer.retain({ id: 'fixture-concurrent-intake', fingerprint: 'b'.repeat(64), agentId: source,
      conversationId: B, firedAt: Date.now() + 1000, payload: { engine: 'codex', sessionId: B,
        transcriptPath: join(home, 'sessions', 'not-written.jsonl'), tmuxPane: '%2', cwd: root, hookEvent: 'UserPromptSubmit' } })
  })
  const f = await httpFixture()
  expect(await f.post({}, { id: 'fixture-before-concurrent-intake' })).toEqual({ status: 200, body: { ok: true } })
  expect(f.recoveryReady(registry.byAgent(source)!)).toBe(false)
  expect(f.prompts).toEqual(['fixture prompt'])
  expect(f.registered).toHaveBeenCalledOnce()
})

it('keeps a terminal acknowledgement when refreshing attachment recovery fails and retries without the completed effect', async () => {
  await afterTerminal(async () => { fault.nativeSync = true })
  const ready = vi.fn()
  const f = await httpFixture(undefined, undefined, { onNativeRecoveryReady: ready })
  const order = { id: 'fixture-complete-before-refresh', firedAt: Date.now() }
  expect(await f.post({}, order)).toEqual({ status: 200, body: { ok: true } })
  expect(f.recoveryReady(registry.byAgent(source)!)).toBe(false)
  expect(f.reasons.at(-1)).toContain('Waiting for native hook recovery')
  ready.mockClear(); fault.nativeSync = false
  await vi.waitFor(() => expect(ready).toHaveBeenCalledWith(expect.objectContaining({ agentId: source })), { timeout: 2_000 })
  expect(f.reasons.at(-1)).toBeUndefined()
  expect(await f.post({}, order)).toEqual({ status: 200, body: { ok: true } })
  expect(f.prompts).toEqual(['fixture prompt'])
  expect(f.registered).toHaveBeenCalledOnce()
  expect(await f.post({ prompt: 'successor' }, { id: 'fixture-successor-after-refresh', firedAt: order.firedAt + 1 }))
    .toEqual({ status: 200, body: { ok: true } })
  expect(f.prompts).toEqual(['fixture prompt', 'successor'])
})

it('wakes a healthy recovered attachment while an earlier process has unreadable ownership', async () => {
  const other = registry.openProcessAgent({ engine: 'codex', tmuxPane: '%3', cwd: root,
    processIdentity: { pid: 5103, startMarker: 'fixture-other', executable: '<codex>' } })!.entry
  const ready = vi.fn()
  const f = await httpFixture(undefined, undefined, {
    readNativeHookOwner: async row => {
      if (row.agentId === source) throw Error('fixture process A unavailable')
      return { key: `fixture-${row.processIdentity!.pid}`, evidence: 'fixture-image', verify() {} }
    }, onNativeRecoveryReady: ready,
  }, undefined, true)
  expect(f.recoveryReady(registry.byAgent(source)!)).toBe(false)
  expect(f.recoveryReady(other)).toBe(false)
  f.startRecovery()
  await vi.waitFor(() => expect(ready).toHaveBeenCalledWith(expect.objectContaining({ agentId: other.agentId })), { timeout: 2_000 })
  expect(f.recoveryReady(other)).toBe(true)
  expect(f.recoveryReady(registry.byAgent(source)!)).toBe(false)
  expect(ready).toHaveBeenCalledOnce()
})

it.each(['confirmation', 'native-probe'])('retries a recovered attachment after a transient %s failure without another hook', async failure => {
  let unavailable = false
  const ready = vi.fn(), held = new Map<string, string | undefined>()
  const f = await httpFixture(undefined, undefined, {
    readNativeHookOwner: async row => {
      if (unavailable) throw Error('fixture native probe unavailable')
      return { key: `fixture-${row.processIdentity!.pid}`, evidence: 'fixture-image', verify() {} }
    }, onNativeRecoveryReady: ready, onAdmissionHeld: (id, reason) => { held.set(id, reason) },
  }, undefined, true)
  expect(await f.post({}, { id: 'fixture-recovery-transient', firedAt: Date.now() })).toEqual({ status: 200, body: { ok: true } })
  expect(f.recoveryReady(registry.byAgent(source)!)).toBe(false)
  f.startRecovery()
  await vi.waitFor(() => expect(f.recoveryReady(registry.byAgent(source)!)).toBe(true))
  if (failure === 'confirmation') fault.nativeSync = true
  else unavailable = true
  expect(await f.post({}, {}, 'turn-stop')).toMatchObject({ status: 202, body: { pending: false, retry: true } })
  expect(f.recoveryReady(registry.byAgent(source)!)).toBe(false)
  expect(held.get(source)).toContain('Waiting for native hook recovery')
  ready.mockClear()
  fault.nativeSync = false; unavailable = false
  await vi.waitFor(() => expect(ready).toHaveBeenCalledWith(expect.objectContaining({ agentId: source })), { timeout: 2_000 })
  expect(f.recoveryReady(registry.byAgent(source)!)).toBe(true)
  expect(held.get(source)).toBeUndefined()
  expect(f.prompts).toEqual(['fixture prompt'])
})

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

it('recovers an owned pending native delivery after the hook server restarts', async () => {
  const order = { id: 'fixture-restart-pending', firedAt: Date.now() }
  const before = await httpFixture()
  rmSync(transcript)
  expect(await before.post({}, order)).toEqual({ status: 200, body: { pending: true } })
  expect(before.prompts).toEqual([])
  await new Promise<void>(resolve => server!.close(() => resolve()))
  server = undefined
  const recovered = await httpFixture()
  expect(recovered.prompts).toEqual([])
  writeFileSync(transcript, header())
  await vi.waitFor(() => expect(recovered.prompts).toEqual(['fixture prompt']), { timeout: 4_000 })
  expect(registry.bySession(A)?.agentId).toBe(source)
  expect(await recovered.post({}, order)).toEqual({ status: 200, body: { ok: true } })
  expect(recovered.prompts).toEqual(['fixture prompt'])
  expect(recovered.registered).toHaveBeenCalledOnce()
})

it('keeps completed native delivery acknowledgements across a hook server restart', async () => {
  const order = { id: 'fixture-restart-complete', firedAt: Date.now() }
  const before = await httpFixture()
  expect(await before.post({}, order)).toEqual({ status: 200, body: { ok: true } })
  expect(before.prompts).toEqual(['fixture prompt'])
  await new Promise<void>(resolve => server!.close(() => resolve()))
  server = undefined
  const recovered = await httpFixture()
  expect(await recovered.post({}, order)).toEqual({ status: 200, body: { ok: true } })
  expect(recovered.prompts).toEqual([])
  expect(recovered.registered).not.toHaveBeenCalled()
})

it('keeps immutable native delivery payload conflicts across a hook server restart', async () => {
  const order = { id: 'fixture-restart-conflict', firedAt: Date.now() }
  const before = await httpFixture()
  expect(await before.post({}, order)).toEqual({ status: 200, body: { ok: true } })
  await new Promise<void>(resolve => server!.close(() => resolve()))
  server = undefined
  const recovered = await httpFixture()
  expect(await recovered.post({ prompt: 'rewritten delivery' }, order)).toEqual({
    status: 409, body: { pending: false, error: 'HOOK_DELIVERY_CONFLICT' },
  })
  expect(recovered.prompts).toEqual([])
  expect(recovered.registered).not.toHaveBeenCalled()
})

it('restores accepted native prompt time before a delayed Stop after restart', async () => {
  const firedAt = Date.now(), order = { id: 'fixture-restart-prompt-time', firedAt }
  const before = await httpFixture()
  expect(await before.post({}, order)).toEqual({ status: 200, body: { ok: true } })
  await new Promise<void>(resolve => server!.close(() => resolve()))
  server = undefined
  const events: unknown[] = []
  const recovered = await httpFixture(undefined, undefined, {
    onPromptHook: (id, at) => { events.push(['prompt', id, at]) },
    onTurnStop: body => { events.push(['stop', body.sessionId, body.firedAt]) },
  }, undefined, true)
  expect(await recovered.post({}, { firedAt: firedAt - 1 }, 'turn-stop')).toEqual({ status: 200, body: { ok: true } })
  expect(events).toEqual([['prompt', A, firedAt], ['stop', A, firedAt - 1]])
})

it('does not credit a visible prompt result or apply Stop when its durability cannot be confirmed', async () => {
  const before = await httpFixture()
  expect(await before.post({}, { id: 'fixture-restart-unconfirmed', firedAt: Date.now() })).toEqual({ status: 200, body: { ok: true } })
  await new Promise<void>(resolve => server!.close(() => resolve()))
  server = undefined
  fault.nativeSync = true
  const prompt = vi.fn(), stop = vi.fn()
  const recovered = await httpFixture(undefined, undefined, { onPromptHook: prompt, onTurnStop: stop }, undefined, true)
  const response = await recovered.post({}, {}, 'turn-stop')
  expect(response.status).toBe(202)
  expect(response.body).toMatchObject({ pending: false, retry: true })
  expect(prompt).not.toHaveBeenCalled()
  expect(stop).not.toHaveBeenCalled()
})

it('revokes a bound hook before waiting for the HTTP server to close', async () => {
  registry.register(input(A, transcript, '%2'))
  let resolved!: (row: ReturnType<typeof registry.byAgent>) => void
  const stop = vi.fn()
  const f = await httpFixture(undefined, undefined, {
    resolveHookAgent: () => new Promise(resolve => { resolved = row => resolve(row ?? null) }), onTurnStop: stop,
  })
  const response = f.post({}, {}, 'turn-stop')
  await vi.waitFor(() => expect(resolved).toBeTypeOf('function'))
  const closing = new Promise<void>(resolve => server!.close(() => resolve()))
  resolved(registry.byAgent(source))
  expect((await response).status).toBe(403)
  expect(stop).not.toHaveBeenCalled()
  await closing; server = undefined
})

it('reproves the engine after claim confirmation even while its saved registry row is unchanged', async () => {
  const { IdentityReadUnavailable } = await import('../engines/kit/identityScan.js')
  let generation = 'original', claimWritten = false
  const prove = vi.fn(async (_row: unknown, expected?: { key: string }) => {
    const proof = { key: `fixture-boot:codex:5102:${generation}`, evidence: generation, verify: () => {} }
    if (expected && expected.key !== proof.key) throw new IdentityReadUnavailable('the native generation changed during disk confirmation')
    return proof
  })
  const f = await httpFixture(undefined, undefined, { readNativeHookOwner: prove }, undefined, true)
  const before = snapshot()
  fault.beforeNativeSync = text => {
    if (text?.includes('"kind":"claim"')) { claimWritten = true; generation = 'replacement' }
  }
  expect(await f.post({}, { id: 'fixture-native-generation', firedAt: Date.now() })).toEqual({ status: 200, body: { pending: true } })
  expect(claimWritten).toBe(true)
  expect(f.reasons.at(-1)).toContain('generation changed')
  expect(f.prompts).toEqual([])
  expect(f.registered).not.toHaveBeenCalled()
  unchanged(before)
})

it('never replaces the original caller proof with a same-second successor selected after resolution waits', async () => {
  const { IdentityReadUnavailable } = await import('../engines/kit/identityScan.js')
  let generation = 'original'
  const proof = () => ({ key: `fixture-boot:codex:5102:${generation}`, evidence: generation, verify() {} })
  const captured = proof(), captures = vi.fn(async () => ({ owner: () => captured }))
  const f = await httpFixture(undefined, undefined, {
    captureNativeHookCaller: captures,
    resolveHookAgent: async () => { generation = 'replacement'; return structuredClone(registry.byAgent(source)!) },
    readNativeHookOwner: async (_row, expected) => {
      if (expected && expected.key !== proof().key) throw new IdentityReadUnavailable('the original caller engine was replaced')
      return proof()
    },
  }, undefined, true)
  const before = snapshot()
  expect(await f.post({ callerPid: 6102 }, { id: 'fixture-original-native-caller', firedAt: Date.now() }))
    .toMatchObject({ status: 202, body: { pending: false, retry: true, detail: expect.stringContaining('original caller engine was replaced') } })
  expect(captures).toHaveBeenCalledOnce()
  expect(f.prompts).toEqual([])
  expect(f.registered).not.toHaveBeenCalled()
  unchanged(before)
})

it('admits a retained client origin after its hook exits and conflicts if the same delivery changes origin', async () => {
  const boot = 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', birth = '123456', digest = 'a'.repeat(64)
  const original = { version: 1, boot, callerPid: 6102, ancestry: [
    { pid: 6102, parentPid: 5102, birth: '123457', identityV1: 'b'.repeat(64) },
    { pid: 5102, parentPid: 1, birth, identityV1: digest },
  ] }
  const proof = { key: `${boot}\u0000codex\u00005102\u0000${birth}`, evidence: 'fixture-complete-native-evidence', verify() {} }
  const liveCapture = vi.fn(async () => { throw Error('An exited hook cannot provide fresh ancestry') })
  const expectedOrigins: unknown[] = []
  const f = await httpFixture(undefined, undefined, {
    captureNativeHookCaller: liveCapture,
    resolveHookAgent: async query => {
      const candidate = structuredClone(registry.byAgent(source)!)
      expectedOrigins.push(query.nativeCaller!.owner(candidate))
      return candidate
    },
    readNativeHookOwner: async (_row, expected) => {
      expect(expected?.key).toBe(proof.key)
      if (expected && 'identityV1' in expected) expect(expected.identityV1).toBe(digest)
      return proof
    },
  }, undefined, true)
  const delivery = { id: 'fixture-persisted-client-origin', firedAt: Date.now() }
  expect(await f.post({ callerPid: 6102, nativeOrigin: original }, delivery)).toEqual({ status: 200, body: { ok: true } })
  expect(await f.post({ callerPid: 6102, nativeOrigin: original }, delivery)).toEqual({ status: 200, body: { ok: true } })
  const changed = structuredClone(original); changed.ancestry[0].birth = '999999'
  expect(await f.post({ callerPid: 6102, nativeOrigin: changed }, delivery)).toEqual({ status: 409, body: { pending: false, error: 'HOOK_DELIVERY_CONFLICT' } })
  expect(liveCapture).not.toHaveBeenCalled()
  expect(expectedOrigins).toHaveLength(3)
  expect(expectedOrigins[0]).toEqual({ key: proof.key, identityV1: digest, source: 'caller' })
  expect(f.prompts).toEqual(['fixture prompt'])
  expect(f.registered).toHaveBeenCalledOnce()
})

it.each(['unknown-version', 'missing-member', 'changed-caller'])('holds a %s retained origin without fresh ancestry fallback', async failure => {
  const liveCapture = vi.fn(async () => { throw Error('No fallback allowed') }), nativeProof = vi.fn()
  const f = await httpFixture(undefined, undefined, { captureNativeHookCaller: liveCapture, readNativeHookOwner: nativeProof }, undefined, true)
  const origin = { version: 1, boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', callerPid: 6102,
    ancestry: [{ pid: 6102, parentPid: 1, birth: '12345', identityV1: 'a'.repeat(64) }] }
  if (failure === 'unknown-version') origin.version = 2
  if (failure === 'missing-member') origin.ancestry = []
  const before = snapshot()
  expect(await f.post({ nativeOrigin: origin, callerPid: failure === 'changed-caller' ? 6103 : 6102 }))
    .toMatchObject({ status: 202, body: { pending: false, retry: true } })
  expect(liveCapture).not.toHaveBeenCalled()
  expect(nativeProof).not.toHaveBeenCalled()
  expect(f.registered).not.toHaveBeenCalled()
  unchanged(before)
})

it.each(['wrong-digest', 'changed-cursor-route'])('reproves a client origin through HTTP and the real owner reader: %s', async failure => {
  const boot = 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
  const engine = failure === 'wrong-digest' ? 'codex' : 'cursor'
  const selected = engine === 'codex' ? registry.byAgent(source)! : registry.openProcessAgent({ engine: 'cursor',
    tmuxPane: '%3', cwd: root, processIdentity: { pid: 5103, executable: '<cursor>', startMarker: 'fixture-start' } })!.entry
  const original = structuredClone(selected), process = { pid: original.processIdentity!.pid, parentPid: 1, birth: '12345',
    command: engine, imagePath: '/fixture/engine', argv: [engine], fds: [] }
  vi.doMock('../engines/kit/nativeHookBoot.js', () => ({ kernelBootId: async () => boot }))
  const { controlIdentity } = await import('./nativeProcessControlProbe.js')
  const evidence = controlIdentity(process), readProcessEvidence = vi.fn(async (_pid: number, _budget: unknown, _children?: unknown, _expected?: unknown) =>
    ({ parent: { nativeBirth: process.birth, controlIdentity: evidence } }))
  vi.doMock('./processEvidence.js', () => ({ readProcessEvidence }))
  try {
    const { createNativeHookOwnerReader } = await import('../engines/kit/nativeHookOwner.js')
    const { nativeHookRouteV1, nativeHookIdentityV1 } = await import('../engines/kit/nativeHookOrigin.js')
    const reader = createNativeHookOwnerReader(), captureNativeHookCaller = vi.fn(reader.captureCaller)
    const member = { pid: process.pid, parentPid: 1, birth: process.birth, identityV1: nativeHookIdentityV1(evidence) }
    const origin = { version: 1, boot, callerPid: 6102, ancestry: failure === 'wrong-digest'
      ? [{ pid: 6102, parentPid: process.pid, birth: '12346', identityV1: 'a'.repeat(64) }, { ...member, identityV1: 'f'.repeat(64) }]
      : [{ pid: 6102, parentPid: 1, birth: '12346', identityV1: 'a'.repeat(64) }],
    ...(failure === 'changed-cursor-route' ? { runtime: { agentId: original.agentId, routeV1: nativeHookRouteV1(original), process: member } } : {}) }
    if (failure === 'changed-cursor-route') registry.updateRuntimes(original.agentId, [{ backend: 'tmux', paneId: '%4' }], 'tmux\u0000%4')
    const f = await httpFixture(undefined, undefined, { readNativeHookOwner: reader, captureNativeHookCaller,
      resolveHookAgent: async query => {
        const current = structuredClone(registry.byAgent(original.agentId)!)
        query.nativeCaller!.owner(current)
        return current
      },
    }, undefined, true)
    const before = snapshot()
    expect(await f.post({ engine, nativeOrigin: origin, callerPid: 6102, tmuxPane: engine === 'cursor' ? '%3' : '%2' }))
      .toMatchObject({ status: 202, body: { pending: false, retry: true } })
    expect(captureNativeHookCaller).not.toHaveBeenCalled()
    expect(f.prompts).toEqual([])
    expect(f.registered).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'data', 'native-hook-deliveries'))).toBe(false)
    if (failure === 'wrong-digest') expect(readProcessEvidence.mock.calls.at(-1)?.[3]).toEqual(original.processIdentity)
    unchanged(before)
  } finally { vi.doUnmock('./processEvidence.js'); vi.doUnmock('../engines/kit/nativeHookBoot.js') }
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
  const options = { verifiedNativeSource: false }, prepared = registry.prepareRegistration(body, options)!
  options.verifiedNativeSource = true
  expect(prepared.commit()?.entry.identityHold).toContain('concurrent binding')
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
  // Pin the original process's initialized journal. Otherwise its startup
  // allocation can independently refuse the replacement before this fixture
  // reaches the resolver-snapshot fence whose exact stale reply it asserts.
  await vi.waitFor(() => expect(f.recoveryReady(row)).toBe(true), { timeout: 4_000 })
  expect((await f.post({ callerPid: 6102 })).body).toEqual({ ignored: true, reason: 'stale_hook' })
  expect(f.prompts).toEqual([])
  expect(f.registered).not.toHaveBeenCalled()
  expect(row.sessionId).toBe('')
})

it('passes captured ancestry through the real resolver after the hook shell exits and the process record is delayed', async () => {
  const discovery = await import('./terminalAgentDiscovery.js')
  const table = [{ pid: 6102, parentPid: 5102, startMarker: 'fixture-start', executable: '<hook>', args: '' },
    { pid: 5102, parentPid: 1, startMarker: 'fixture-start', executable: '<codex>', args: '' }]
  vi.spyOn(discovery, 'processRows').mockImplementation(async () => [...table])
  const row = registry.byAgent(source)!, original = { ...row.processIdentity! }
  row.processIdentity = { ...original, pid: 4999, startMarker: 'old-exited-engine' }
  const { createEngineHooks } = await import('../core/engines/hooks.js')
  const hooks = createEngineHooks({ tmuxBackend: {}, syncSession: vi.fn(), registry,
    agentReconciler: { triggerHint: vi.fn(async () => true), trigger: vi.fn() } as never })
  const f = await httpFixture(undefined, undefined, {
    captureNativeHookCaller: async () => {
      table.shift()
      return { owner: selected => {
        if (selected.processIdentity?.pid !== original.pid) throw Error('not in captured caller ancestry')
        return { key: 'fixture-original', evidence: 'fixture-original', source: 'caller' as const }
      } }
    }, resolveHookAgent: hooks.resolveHookAgent,
  }, undefined, true)
  expect(await f.post({ callerPid: 6102 }, { id: 'fixture-captured-before-record' }))
    .toMatchObject({ status: 202, body: { pending: false, retry: true } })
  expect(f.prompts).toEqual([])
  row.processIdentity = original
  await vi.waitFor(() => expect(f.prompts).toEqual(['fixture prompt']), { timeout: 3_000 })
  expect(f.registered).toHaveBeenCalledOnce()
  expect(registry.byAgent(source)?.sessionId).toBe(A)
})

it('keeps unavailable arrival evidence retryable at the real HTTP resolver instead of ignoring the delivery', async () => {
  const discovery = await import('./terminalAgentDiscovery.js')
  vi.spyOn(discovery, 'processRows').mockResolvedValue([
    { pid: 6102, parentPid: 5102, startMarker: 'fixture-start', executable: '<hook>', args: '' },
    { pid: 5102, parentPid: 1, startMarker: 'fixture-start', executable: '<codex>', args: '' },
  ])
  const { createEngineHooks } = await import('../core/engines/hooks.js')
  const hooks = createEngineHooks({ tmuxBackend: {}, syncSession: vi.fn(), registry,
    agentReconciler: { triggerHint: vi.fn(async () => true), trigger: vi.fn() } as never })
  let unavailable = true
  const f = await httpFixture(undefined, undefined, {
    captureNativeHookCaller: async () => ({ owner: () => {
      if (unavailable) throw Error('fixture arrival evidence unavailable')
      return { key: 'fixture-original', evidence: 'fixture-original', source: 'caller' as const }
    } }), resolveHookAgent: hooks.resolveHookAgent,
  })
  const delivery = { id: 'fixture-unavailable-arrival' }
  expect(await f.post({ callerPid: 6102 }, delivery)).toMatchObject({
    status: 202, body: { pending: false, retry: true, detail: expect.stringContaining('fixture arrival evidence unavailable') },
  })
  expect(f.prompts).toEqual([])
  expect(f.registered).not.toHaveBeenCalled()
  expect(registry.byAgent(source)?.sessionId).toBe('')
  unavailable = false
  expect((await f.post({ callerPid: 6102 }, delivery)).body).toEqual({ ok: true })
  expect(f.prompts).toEqual(['fixture prompt'])
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
  // Retaining an uncertain Stop is not completion. Its claim still prevents attachment.
  await new Promise(resolve => setTimeout(resolve, 1_100))
  expect(order).not.toContain('attach')
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
  const onAdmissionStop = vi.fn(() => false)
  const f = await httpFixture(() => false, 65_536, { onTurnStop, onAdmissionStop,
    captureTurnStop: (_row, body) => async () => { onTurnStop(body); return 'completed' } })
  const delivery = { id: 'fixture-stop-delivery-02', firedAt: Date.now() }
  const body = { engine: 'cursor', sessionId: A, transcriptPath: undefined, tmuxPane: '%3', hookEvent: 'stop', prompt: undefined }
  expect((await f.post(body, delivery)).body).toEqual({ ok: true })
  expect((await Promise.all([f.post(body, delivery, 'turn-stop'), f.post(body, delivery, 'turn-stop')])).map(value => value.body))
    .toEqual([{ ok: true, duplicate: true }, { ok: true, duplicate: true }])
  expect((await f.post(body, delivery, 'turn-stop')).body).toEqual({ ok: true, duplicate: true })
  expect(onTurnStop).toHaveBeenCalledExactlyOnceWith({ sessionId: A, status: undefined, firedAt: delivery.firedAt })
  expect(onAdmissionStop).not.toHaveBeenCalled()
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

it('confirms a completed Stop after interpretation recovered without closing its later turn', async () => {
  const owner = registry.openProcessAgent({ engine: 'cursor', tmuxPane: '%3', cwd: root,
    processIdentity: { pid: 7103, startMarker: 'fixture-start', executable: '<engine>' } })!.entry
  registry.register({ engine: 'cursor', sessionId: A, tmuxPane: '%3', cwd: root, processIdentity: owner.processIdentity! })
  const onTurnStop = vi.fn(), onAdmissionStop = vi.fn(() => true)
  const f = await httpFixture(() => false, 65_536, { onTurnStop, onAdmissionStop,
    captureTurnStop: (_row, body) => async () => { onTurnStop(body); return 'completed' } })
  const delivery = { id: 'fixture-stop-recovered-01', firedAt: Date.now() }
  const body = { engine: 'cursor', sessionId: A, transcriptPath: undefined, tmuxPane: '%3', hookEvent: 'stop', prompt: undefined }
  expect((await f.post(body, delivery)).body).toEqual({ ok: true })
  const row = registry.byAgent(owner.agentId)!
  row.identityHold = 'native source unavailable'
  row.evidenceRevision = (row.evidenceRevision ?? 0) + 1
  delete row.identityHold
  row.evidenceRevision++
  expect((await f.post(body, delivery, 'turn-stop')).body).toEqual({ ok: true, duplicate: true })
  expect(row.interpretationHold).toBeUndefined()
  expect(onAdmissionStop).not.toHaveBeenCalled()
  expect(onTurnStop).toHaveBeenCalledOnce()
})

it.each(['before-followup', 'during-followup', 'during-registration', 'during-initial-resolution', 'during-native-capture'] as const)('Cancel supersedes original Stop %s without closing a newer turn', async phase => {
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
    captureTurnStop: (entry, body) => {
      const current = attach.captureAdmissionStop(entry)
      return async () => { if (!current()) return 'superseded'; onTurnStop(); return 'completed' }
    },
    ...(phase === 'during-native-capture' ? { captureNativeHookCaller: async () => {
      await new Promise<void>(resolve => { finish = resolve })
      return { owner: () => ({ key: 'fixture-original-cursor', evidence: 'fixture-original-cursor' }) }
    } } : {}),
    resolveHookAgent: async () => {
      resolutions++
      if (phase === 'during-initial-resolution' && resolutions === 1) {
        await new Promise<void>(resolve => { finish = resolve })
      }
      return structuredClone(registry.byAgent(row.agentId)!)
    } })
  const delivery = { id: 'fixture-stop-cancelled-01', firedAt: Date.now() }
  const body = { engine: 'cursor', sessionId: A, transcriptPath: undefined, tmuxPane: '%3', hookEvent: 'stop', prompt: undefined }
  if (phase === 'during-registration') fault.rename = true
  const registration = f.post(body, delivery)
  if (phase === 'during-initial-resolution' || phase === 'during-native-capture') await vi.waitFor(() => expect(finish).toBeDefined())
  else expect((await registration).body).toEqual(phase === 'during-registration' ? { pending: true } : { ok: true })
  const followup = phase === 'during-followup' ? f.post(body, delivery, 'turn-stop') : undefined
  attach.beforeCancel(row)
  laterTurnOpen = true
  if (phase === 'during-initial-resolution' || phase === 'during-native-capture') {
    // A retry must share the original cancellation witness, even when it could
    // resolve sooner after Cancel than the first request that was already taken.
    expect(await f.post(body, delivery)).toMatchObject({ status: 202, body: { pending: false, retry: true } })
    expect(await f.post({ ...body, title: 'different delivery' }, delivery)).toMatchObject({ status: 409 })
    expect(resolutions).toBe(phase === 'during-native-capture' ? 0 : 1)
  }
  fault.rename = false
  finish?.()
  await registration
  if (phase === 'during-registration') await vi.waitFor(() => expect(f.registered).toHaveBeenCalledOnce(), { timeout: 3_000 })
  expect((await (followup ?? f.post(body, delivery, 'turn-stop'))).body).toEqual({ ok: true, duplicate: true })
  expect(onTurnStop).toHaveBeenCalledTimes(['before-followup', 'during-followup'].includes(phase) ? 1 : 0)
  expect(onAdmissionStop).not.toHaveBeenCalled()
  expect(laterTurnOpen).toBe(true)
  attach.forget(A)
})

it('keeps concurrent confirmations pending until the one actual Stop effect completes', async () => {
  const owner = registry.openProcessAgent({ engine: 'cursor', tmuxPane: '%3', cwd: root,
    processIdentity: { pid: 7103, startMarker: 'fixture-start', executable: '<engine>' } })!.entry
  registry.register({ engine: 'cursor', sessionId: A, tmuxPane: '%3', cwd: root, processIdentity: owner.processIdentity! })
  let finish!: () => void
  const onAdmissionStop = vi.fn(() => false), onTurnStop = vi.fn()
  const effect = vi.fn(async () => { onTurnStop(); await new Promise<void>(resolve => { finish = resolve }); return 'completed' as const })
  const f = await httpFixture(() => false, 65_536, { onTurnStop, onAdmissionStop, captureTurnStop: () => effect })
  const delivery = { id: 'fixture-stop-concurrent-01', firedAt: Date.now() }
  const body = { engine: 'cursor', sessionId: A, transcriptPath: undefined, tmuxPane: '%3', hookEvent: 'stop', prompt: undefined }
  expect((await f.post(body, delivery)).body).toEqual({ pending: true })
  expect(f.registered).not.toHaveBeenCalled()
  expect((await Promise.all([f.post(body, delivery, 'turn-stop'), f.post(body, delivery, 'turn-stop')])).map(reply => reply.body))
    .toEqual([{ pending: true }, { pending: true }])
  finish()
  await vi.waitFor(() => expect(f.registered).toHaveBeenCalledOnce())
  expect((await f.post(body, delivery, 'turn-stop')).body).toEqual({ ok: true, duplicate: true })
  expect(effect).toHaveBeenCalledOnce()
  expect(onTurnStop).toHaveBeenCalledOnce()
  expect(onAdmissionStop).not.toHaveBeenCalled()
})

function boundCursorStop() {
  const owner = registry.openProcessAgent({ engine: 'cursor', tmuxPane: '%3', cwd: root,
    processIdentity: { pid: 7103, startMarker: 'fixture-start', executable: '<engine>' } })!.entry
  registry.register({ engine: 'cursor', sessionId: A, tmuxPane: '%3', cwd: root, processIdentity: owner.processIdentity! })
  return { owner, body: { engine: 'cursor', sessionId: A, transcriptPath: undefined, tmuxPane: '%3', hookEvent: 'stop', prompt: undefined },
    delivery: { id: 'fixture-stop-owned-completion', firedAt: Date.now() } }
}

function boundClaudeStop() {
  const directory = join(root, 'claude', 'projects', 'fixture')
  mkdirSync(directory, { recursive: true })
  const transcriptPath = join(directory, `${A}.jsonl`)
  writeFileSync(transcriptPath, JSON.stringify({ type: 'user', cwd: root, sessionId: A, isSidechain: false }) + '\n')
  const owner = registry.openProcessAgent({ engine: 'claude', tmuxPane: '%3', cwd: root,
    processIdentity: { pid: 7103, startMarker: 'fixture-claude', executable: '<claude>' } })!.entry
  expect(registry.register({ engine: 'claude', sessionId: A, transcriptPath, tmuxPane: '%3', cwd: root, processIdentity: owner.processIdentity! })?.entry.sessionId).toBe(A)
  return { owner, body: { engine: 'claude', sessionId: A, transcriptPath, tmuxPane: '%3', cwd: root, hookEvent: 'Stop', prompt: undefined },
    delivery: { id: 'fixture-legacy-stop-original', firedAt: Date.now() } }
}

it('retains a legacy Stop through pending registration and confirms its original effect without a client retry', async () => {
  const { owner, body, delivery } = boundClaudeStop()
  let blocked = true
  const stopped = vi.fn(), effect = vi.fn(async (execution) => { execution.verify(); stopped(); return 'completed' as const })
  const capture = vi.fn(() => effect), legacy = vi.fn()
  const f = await httpFixture(() => blocked, undefined, { captureTurnStop: capture, onTurnStop: legacy }, undefined, true)
  expect((await f.post({ ...body, hookEvent: 'UserPromptSubmit', prompt: 'original' }, {
    id: 'fixture-legacy-stop-predecessor', firedAt: delivery.firedAt - 1,
  })).body).toEqual({ pending: true })
  expect(await f.post(body, delivery, 'turn-stop')).toMatchObject({ status: 202, body: { pending: false, retry: true } })
  expect(capture).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agentId: owner.agentId }),
    { sessionId: A, status: undefined, firedAt: delivery.firedAt })
  expect(await f.post(body, delivery, 'turn-stop')).toMatchObject({ status: 202, body: { pending: false, retry: true } })
  expect((await f.post({ ...body, status: 'error' }, delivery, 'turn-stop')).status).toBe(409)
  expect(effect).not.toHaveBeenCalled()
  blocked = false; f.startRecovery()
  await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce(), { timeout: 4_000 })
  await vi.waitFor(async () => expect((await f.post(body, delivery, 'turn-stop')).body).toEqual({ ok: true, duplicate: true }), { timeout: 4_000 })
  expect(effect).toHaveBeenCalledOnce()
  expect(capture).toHaveBeenCalledOnce()
  expect(legacy).not.toHaveBeenCalled()
  expect(f.registered).toHaveBeenCalledOnce()
})

it('completes the original legacy Stop after real deferred attach and registration recovery', async () => {
  const { createAttach } = await import('../core/transcripts/attach.js')
  const { createSessionNormalizers } = await import('../core/transcripts/normalizers.js')
  const { createTurnHooks } = await import('../core/turns/turnHooks.js')
  const { liveFor } = await import('../engines/live.js')
  const { Watcher } = await import('../watcher/watcher.js')
  const { owner, body, delivery } = boundClaudeStop()
  writeFileSync(body.transcriptPath, readFileSync(body.transcriptPath, 'utf8') + JSON.stringify({
    type: 'user', uuid: 'fixture-original-prompt', message: { role: 'user', content: 'original' },
  }) + '\n')
  const row = registry.byAgent(owner.agentId)!, normalizers = createSessionNormalizers(), watcher = new Watcher()
  let blocked = true, f: Awaited<ReturnType<typeof httpFixture>> | undefined
  const emit = vi.fn(), stopped = vi.fn()
  const attach = createAttach({ liveFor, resolve: id => registry.byAgent(id), normalizers, watcher,
    nativeRecoveryReady: entry => f?.recoveryReady(entry) ?? true,
    terminalGone: async () => false, announceSession: vi.fn(), setInterpretationHold: () => false,
    cursorDiscovery: { add: async () => {} }, device: () => undefined,
    runtimeProfiles: { beginHydrate: () => ({ ingest: () => false, commit: () => false }),
      transcriptFields: () => [], ingestConfig: async () => false, capturePane: async () => null,
    } as unknown as import('../core/transcripts/attach.js').AttachDeps['runtimeProfiles'],
    captureTerminal: async () => null, emit: vi.fn(), announceTurnAborted: vi.fn(),
    questionWatcher: { start: vi.fn() }, terminalLabel: () => '<private-pane>',
    dbs: { opencode: '', kilo: '', devin: '' }, devinHome: '', hermesDb: async () => '', concurrency: 1,
  })
  const turns = createTurnHooks({ resolve: id => registry.bySession(id), normalizers, emit, drain: id => watcher.pollSession(id),
    onCursorTaskStart: vi.fn(), cursorTaskHooks: { wait: async () => {} }, cursorSubagents: { closeParent: vi.fn() },
    announceTurnAborted: vi.fn(), armAgyIdleWatch: vi.fn(), clearAgyIdleWatch: vi.fn(),
    mirror: { noteEngineStopped: stopped }, dataDir: join(root, 'data'),
  })
  try {
    await attach.attachSession(row)
    normalizers.noteTurnStart(A)
    const original = normalizers.liveParsers.get(A)!
    expect(original.snapshot().turnOpen).toBe(true)
    const attached = vi.fn(async entry => { await attach.attachSession(entry) })
    f = await httpFixture(() => blocked, undefined, {
      onRegistered: attached, onNativeRecoveryReady: async entry => { await attach.attachSession(entry) },
      captureAdmissionStop: attach.captureAdmissionStop,
      captureTurnStop: (entry, stop) => turns.captureStop(entry, stop, attach.captureAdmissionStop(entry)),
    }, undefined, true)
    expect((await f.post({ ...body, hookEvent: 'UserPromptSubmit', prompt: 'original' }, {
      id: 'fixture-composed-stop-predecessor', firedAt: delivery.firedAt - 1,
    })).body).toEqual({ pending: true })
    expect((await f.post(body, delivery, 'turn-stop')).status).toBe(202)
    blocked = false; f.startRecovery()
    await vi.waitFor(() => expect(emit).toHaveBeenCalledExactlyOnceWith(A, [{ type: 'turn_ended', payload: {} }]), { timeout: 6_000 })
    expect(attached).toHaveBeenCalledOnce()
    expect(normalizers.liveParsers.get(A)).toBe(original)
    expect(original.snapshot().turnOpen).toBe(false)
    expect(stopped).toHaveBeenCalledOnce()
  } finally { f?.stopRecovery(); attach.forget(A); await watcher.stop() }
}, 10_000)

it('keeps the first legacy Stop capture when a native owner read is unavailable and refreshes before dispatch', async () => {
  const { body, delivery } = boundClaudeStop()
  let unavailable = true
  const effect = vi.fn(async (execution) => { await execution.confirm(); execution.verify(); return 'completed' as const })
  const capture = vi.fn(() => effect), read = vi.fn(async () => {
    if (unavailable) throw Error('fixture original process unavailable')
    return { key: 'fixture-native-claude', evidence: 'fixture-claude-image', verify() {} }
  })
  const f = await httpFixture(undefined, undefined, { captureTurnStop: capture, readNativeHookOwner: read }, undefined, true)
  expect(await f.post(body, delivery, 'turn-stop')).toMatchObject({ status: 202, body: { pending: false, retry: true } })
  await vi.waitFor(() => expect(f.reasons.some(reason => reason?.includes('original process unavailable'))).toBe(true))
  expect(effect).not.toHaveBeenCalled()
  unavailable = false; f.startRecovery()
  await vi.waitFor(async () => expect((await f.post(body, delivery, 'turn-stop')).status).toBe(200), { timeout: 4_000 })
  expect(effect).toHaveBeenCalledOnce(); expect(capture).toHaveBeenCalledOnce()
  expect(read.mock.calls.length).toBeGreaterThan(2)
})

it('refreshes original admission after a retryable legacy Stop preflight hold', async () => {
  const { body, delivery } = boundClaudeStop()
  let reads = 0, retryable = true, firstProof = 0
  const read = vi.fn(async () => {
    const generation = ++reads
    return { key: 'fixture-native-claude', evidence: 'fixture-claude-image', verify() {
      if (generation <= firstProof) throw Error('fixture preflight proof expired')
    } }
  })
  const effect = Object.assign(vi.fn(async (execution) => {
    execution.verify()
    if (!firstProof) { firstProof = reads; return 'held' as const }
    retryable = false
    return 'completed' as const
  }), { retryable: () => retryable })
  const f = await httpFixture(undefined, undefined, { captureTurnStop: () => effect, readNativeHookOwner: read }, undefined, true)
  expect((await f.post(body, delivery, 'turn-stop')).status).toBe(202)
  f.startRecovery()
  await vi.waitFor(async () => expect((await f.post(body, delivery, 'turn-stop')).status).toBe(200), { timeout: 4_000 })
  expect(effect).toHaveBeenCalledTimes(2)
  expect(reads).toBeGreaterThan(firstProof)
})

it('never dispatches a retained legacy Stop after its server shuts down during ownership capture', async () => {
  const { body, delivery } = boundClaudeStop()
  let release!: () => void
  const effect = vi.fn(async () => 'completed' as const)
  const f = await httpFixture(undefined, undefined, { captureTurnStop: () => effect,
    captureNativeHookCaller: async () => {
      await new Promise<void>(resolve => { release = resolve })
      return { owner: () => ({ key: 'fixture-claude', evidence: 'fixture-image' }) }
    },
  }, undefined, true)
  const pending = f.post(body, delivery, 'turn-stop')
  await vi.waitFor(() => expect(release).toBeDefined())
  f.stopRecovery(); release()
  expect((await pending).status).toBe(202)
  await new Promise(resolve => setTimeout(resolve, 25))
  expect(effect).not.toHaveBeenCalled()
})

it('keeps the original legacy Stop caller alive until its ancestry capture settles, duplicates included', async () => {
  const { body, delivery } = boundClaudeStop()
  let alive = true, release!: () => void
  const effect = vi.fn(async () => 'completed' as const)
  const capture = vi.fn(async () => {
    await new Promise<void>(resolve => { release = resolve })
    if (!alive) throw Error('fixture hook caller exited when its response arrived')
    return { owner: () => ({ key: 'fixture-claude', evidence: 'fixture-image' }) }
  })
  const f = await httpFixture(undefined, undefined, { captureTurnStop: () => effect,
    captureNativeHookCaller: capture,
  }, undefined, true)
  const first = f.post(body, delivery, 'turn-stop').then(reply => { alive = false; return reply })
  await vi.waitFor(() => expect(release).toBeDefined())
  const duplicate = f.post(body, delivery, 'turn-stop').then(reply => { alive = false; return reply })
  await new Promise(resolve => setTimeout(resolve, 25))
  expect(alive).toBe(true)
  release()
  expect((await first).status).toBe(202)
  expect((await duplicate).status).toBe(202)
  await vi.waitFor(() => expect(effect).toHaveBeenCalledOnce())
  expect(capture).toHaveBeenCalledOnce()
})

it('lets Cancel retire only its unstarted legacy Stop while native recovery remains unavailable', async () => {
  const { createAttach } = await import('../core/transcripts/attach.js')
  const { createSessionNormalizers } = await import('../core/transcripts/normalizers.js')
  const { owner, body, delivery } = boundClaudeStop()
  const attach = createAttach({ normalizers: createSessionNormalizers(), resolve: registry.byAgent } as import('../core/transcripts/attach.js').AttachDeps)
  const effect = vi.fn(async () => 'completed' as const)
  const f = await httpFixture(undefined, undefined, { captureTurnStop: () => effect,
    captureAdmissionStop: attach.captureAdmissionStop,
    readNativeHookOwner: async () => { throw Error('fixture native evidence still unavailable') },
  }, undefined, true)
  expect((await f.post(body, delivery, 'turn-stop')).status).toBe(202)
  await vi.waitFor(() => expect(f.reasons.at(-1)).toContain('original Stop admission'))
  attach.beforeCancel(registry.byAgent(owner.agentId)!)
  f.startRecovery()
  await vi.waitFor(async () => expect((await f.post(body, delivery, 'turn-stop')).body).toEqual({ ok: true, duplicate: true }))
  await vi.waitFor(() => expect(f.reasons.at(-1)).toContain('fixture native evidence still unavailable'))
  expect(f.reasons.at(-1)).not.toContain('original Stop')
  expect(f.recoveryReady(registry.byAgent(owner.agentId)!)).toBe(false)
  expect(effect).not.toHaveBeenCalled()
})

it('bounds retained legacy Stops without claiming an overflow notification', async () => {
  const { body, delivery } = boundClaudeStop()
  const capture = vi.fn(() => vi.fn(async () => 'held' as const))
  const f = await httpFixture(undefined, 1, { captureTurnStop: capture }, undefined, true)
  expect((await f.post(body, delivery, 'turn-stop')).status).toBe(202)
  expect(await f.post(body, { ...delivery, id: 'fixture-legacy-stop-overflow' }, 'turn-stop'))
    .toMatchObject({ status: 429, body: { pending: false, error: 'HOOK_ADMISSION_BUSY' } })
  expect(capture).toHaveBeenCalledOnce()
})

it('keeps completed linked Stop confirmations across restart without dispatching again', async () => {
  const { body, delivery } = boundCursorStop()
  const stop = vi.fn(async () => 'completed' as const)
  const before = await httpFixture(undefined, undefined, { captureTurnStop: () => stop })
  expect((await before.post(body, delivery)).body).toEqual({ ok: true })
  expect(stop).toHaveBeenCalledOnce()
  await new Promise<void>(resolve => server!.close(() => resolve()))
  const replacement = vi.fn(async () => 'completed' as const)
  const recovered = await httpFixture(undefined, undefined, { captureTurnStop: () => replacement })
  expect((await recovered.post(body, delivery)).body).toEqual({ ok: true })
  expect((await recovered.post(body, delivery, 'turn-stop')).body).toEqual({ ok: true, duplicate: true })
  expect((await recovered.post({ ...body, status: 'changed' }, delivery, 'turn-stop')).status).toBe(409)
  expect(replacement).not.toHaveBeenCalled()
})

it('holds an interrupted Stop effect after restart instead of dispatching against the replacement turn', async () => {
  const { owner, body, delivery } = boundCursorStop()
  let finish!: () => void
  const before = await httpFixture(undefined, undefined, { captureTurnStop: () => async () => {
    await new Promise<void>(resolve => { finish = resolve }); return 'held'
  } })
  expect((await before.post(body, delivery)).body).toEqual({ pending: true })
  await new Promise<void>(resolve => server!.close(() => resolve()))
  finish()
  const replacement = vi.fn(async () => 'completed' as const)
  const recovered = await httpFixture(undefined, undefined, { captureTurnStop: () => replacement })
  expect((await recovered.post(body, delivery)).body).toEqual({ pending: true })
  expect((await recovered.post(body, delivery, 'turn-stop')).body).toEqual({ pending: true })
  await vi.waitFor(() => expect(recovered.reasons.some(reason => reason?.includes('unconfirmed') || reason?.includes('interrupted'))).toBe(true))
  expect(recovered.recoveryReady(registry.byAgent(owner.agentId)!)).toBe(false)
  expect(replacement).not.toHaveBeenCalled()
  expect(recovered.registered).not.toHaveBeenCalled()
})

it.each([false, true])('retains the first live Stop latch through uncertain intake only in its original core (restart=%s)', async restart => {
  const { body, delivery } = boundCursorStop()
  vi.doMock('../engines/kit/nativeHookJournal.js', async original => {
    const actual = await original<typeof import('../engines/kit/nativeHookJournal.js')>()
    let failed = false
    return { ...actual, createNativeHookJournal: (options: Parameters<typeof actual.createNativeHookJournal>[0]) => {
      const journal = actual.createNativeHookJournal(options)
      return { ...journal, retain: async (...args: Parameters<typeof journal.retain>) => {
        const retained = await journal.retain(...args)
        if (!failed) { failed = true; throw new Error('fixture intake confirmation outcome lost') }
        return retained
      } }
    } }
  })
  const firstStop = vi.fn(async () => 'completed' as const), firstCapture = vi.fn(() => firstStop)
  const before = await httpFixture(undefined, undefined, { captureTurnStop: firstCapture }, undefined, true)
  expect(await before.post(body, delivery)).toMatchObject({ status: 202, body: { retry: true } })
  expect(firstStop).not.toHaveBeenCalled()
  if (restart) {
    await new Promise<void>(resolve => server!.close(() => resolve()))
    const replacement = vi.fn(async () => 'completed' as const)
    const recovered = await httpFixture(undefined, undefined, { captureTurnStop: () => replacement }, undefined, true)
    expect((await recovered.post(body, delivery)).body).toEqual({ pending: true })
    expect(recovered.reasons.some(reason => reason?.includes('original Stop turn'))).toBe(true)
    expect(replacement).not.toHaveBeenCalled()
    expect(firstStop).not.toHaveBeenCalled()
  } else {
    expect((await before.post(body, delivery)).body).toEqual({ ok: true })
    expect(firstCapture).toHaveBeenCalledOnce()
    expect(firstStop).toHaveBeenCalledOnce()
    expect((await before.post(body, delivery, 'turn-stop')).body).toEqual({ ok: true, duplicate: true })
  }
})

it('lets Cancel revoke a cold retained Stop without applying it to a replacement turn', async () => {
  const { body, delivery, owner } = boundCursorStop()
  const before = await httpFixture(() => true, undefined, {}, undefined, true)
  expect((await before.post(body, delivery)).body).toEqual({ pending: true })
  await new Promise<void>(resolve => server!.close(() => resolve()))
  const { createAttach } = await import('../core/transcripts/attach.js')
  const { createSessionNormalizers } = await import('../core/transcripts/normalizers.js')
  const attach = createAttach({ normalizers: createSessionNormalizers(), resolve: registry.byAgent } as import('../core/transcripts/attach.js').AttachDeps)
  const replacement = vi.fn(async () => 'completed' as const), registered = vi.fn()
  const recovered = await httpFixture(undefined, undefined, {
    captureAdmissionStop: attach.captureAdmissionStop, captureTurnStop: () => replacement, onRegistered: registered,
  }, undefined, true)
  recovered.startRecovery()
  await vi.waitFor(() => expect(recovered.reasons.some(reason => reason?.includes('original Stop turn'))).toBe(true), { timeout: 4_000 })
  expect(replacement).not.toHaveBeenCalled()
  expect(registered).not.toHaveBeenCalled()
  attach.beforeCancel(registry.byAgent(owner.agentId)!)
  await vi.waitFor(() => expect(registered).toHaveBeenCalledOnce(), { timeout: 4_000 })
  expect((await recovered.post(body, delivery, 'turn-stop')).body).toEqual({ ok: true, duplicate: true })
  expect(replacement).not.toHaveBeenCalled()
})

it('retries the exact Stop result after failed terminal persistence without repeating the effect', async () => {
  const { body, delivery } = boundCursorStop()
  const stop = vi.fn(async () => 'completed' as const)
  const f = await httpFixture(undefined, undefined, { captureTurnStop: () => stop })
  fault.beforeNativeSync = text => { if (text?.includes('"kind":"result"')) fault.nativeSync = true }
  expect((await f.post(body, delivery)).body).toEqual({ pending: true })
  expect(stop).toHaveBeenCalledOnce()
  expect((await f.post(body, delivery, 'turn-stop')).body).toEqual({ pending: true })
  fault.beforeNativeSync = undefined; fault.nativeSync = false
  await vi.waitFor(async () => expect((await f.post(body, delivery, 'turn-stop')).body).toEqual({ ok: true, duplicate: true }), { timeout: 3_000 })
  expect(stop).toHaveBeenCalledOnce()
})

it('recovers an uncertain predecessor before a later intake without another producer retry', async () => {
  const { body, delivery } = boundCursorStop()
  vi.doMock('../engines/kit/nativeHookJournal.js', async original => {
    const actual = await original<typeof import('../engines/kit/nativeHookJournal.js')>()
    let failed = false
    return { ...actual, createNativeHookJournal: (options: Parameters<typeof actual.createNativeHookJournal>[0]) => {
      const journal = actual.createNativeHookJournal(options)
      return { ...journal, retain: async (...args: Parameters<typeof journal.retain>) => {
        const retained = await journal.retain(...args)
        if (!failed) { failed = true; throw new Error('fixture intake confirmation outcome lost') }
        return retained
      } }
    } }
  })
  const stop = vi.fn(async () => 'completed' as const), capture = vi.fn(() => stop)
  const f = await httpFixture(undefined, undefined, { captureTurnStop: capture }, undefined, true)
  expect(await f.post(body, delivery)).toMatchObject({ status: 202, body: { retry: true } })
  expect((await f.post({ ...body, hookEvent: 'session-start' }, {
    id: 'fixture-stop-later-intake', firedAt: delivery.firedAt + 1,
  })).body).toEqual({ pending: true })
  expect(stop).not.toHaveBeenCalled()
  f.startRecovery()
  await vi.waitFor(() => expect(f.registered).toHaveBeenCalledTimes(2), { timeout: 4_000 })
  expect(f.registered.mock.calls.map(call => call[1].hookEvent)).toEqual(['stop', 'session-start'])
  expect(capture).toHaveBeenCalledOnce()
  expect(stop).toHaveBeenCalledOnce()
  expect((await f.post(body, delivery, 'turn-stop')).body).toEqual({ ok: true, duplicate: true })
})

it('keeps the original Stop capture when its retained intake cannot enter the full live queue', async () => {
  const { body, delivery } = boundCursorStop()
  let queue!: ReturnType<typeof import('../core/engines/pendingAdmission.js')['createPendingAdmissions']>
  vi.doMock('../core/engines/pendingAdmission.js', async original => {
    const actual = await original<typeof import('../core/engines/pendingAdmission.js')>()
    return { ...actual, createPendingAdmissions: (options: Parameters<typeof actual.createPendingAdmissions>[0]) => {
      queue = actual.createPendingAdmissions({ ...options, capacity: 1 })
      vi.spyOn(queue, 'submit')
      return queue
    } }
  })
  let blocked = true
  const stop = vi.fn(async () => 'completed' as const), capture = vi.fn(() => stop)
  const f = await httpFixture(() => blocked, undefined, { captureTurnStop: capture }, undefined, true)
  expect((await f.post({ ...body, hookEvent: 'session-start' }, {
    id: 'fixture-stop-earlier-queued', firedAt: delivery.firedAt - 1,
  })).body).toEqual({ pending: true })
  expect((await f.post(body, delivery)).body).toEqual({ pending: true })
  expect(vi.mocked(queue.submit).mock.results.map(result => result.value)).toContain(false)
  blocked = false; f.startRecovery()
  await vi.waitFor(() => expect(f.registered).toHaveBeenCalledTimes(2), { timeout: 4_000 })
  expect(capture).toHaveBeenCalledOnce()
  expect(stop).toHaveBeenCalledOnce()
  expect((await f.post(body, delivery, 'turn-stop')).body).toEqual({ ok: true, duplicate: true })
})

it('does not publish an unmatched Stop hold after its owning server shuts down', async () => {
  const { body, delivery } = boundCursorStop()
  let release!: () => void
  const held = vi.fn(() => true)
  const f = await httpFixture(undefined, undefined, { onAdmissionStop: held, captureTurnStop: () => async execution => {
    await new Promise<void>(resolve => { release = resolve })
    expect(execution!.current()).toBe(false)
    return 'held'
  } })
  expect((await f.post(body, delivery)).body).toEqual({ pending: true })
  f.stopRecovery(); release()
  await new Promise(resolve => setTimeout(resolve, 25))
  expect(held).not.toHaveBeenCalled()
  expect(f.registered).not.toHaveBeenCalled()
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

vi.mock('../engines/kit/nativeHookStorage.js', async original => ({
  ...await original<object>(),
  openNativeHookStorage: (await import('../testing/nativeHookAdmissionStorageFixture.js')).fixtureNativeHookAdmissionStorage,
}))
