import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({
  copied: undefined as (() => void | Promise<void>) | undefined,
  inspectedCheckpoint: undefined as (() => void) | undefined,
  openingSource: undefined as (() => () => void) | undefined,
  sourceFailure: undefined as 'open' | 'stat' | 'read' | 'close' | undefined,
}))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
    const restore = faults.openingSource?.()
    try { await actual.copyFile(...args) } finally { restore?.() }
    await faults.copied?.()
  }, open: async (...args: Parameters<typeof actual.open>) => {
    const source = String(args[0]).endsWith('.jsonl')
    if (source && faults.sourceFailure === 'open') throw Error('Source open unavailable')
    const restore = source ? faults.openingSource?.() : undefined
    const handle = await actual.open(...args).finally(() => restore?.())
    if (source) {
      const stat = handle.stat.bind(handle), read = handle.read.bind(handle), close = handle.close.bind(handle)
      handle.close = async () => {
        await close()
        if (faults.sourceFailure === 'close') throw Error('Source close unavailable')
      }
      handle.stat = (async (...values: Parameters<typeof stat>) => {
        if (faults.sourceFailure === 'stat') throw Error('Source stat unavailable')
        return stat(...values)
      }) as typeof handle.stat
      handle.read = (async (...values: Parameters<typeof read>) => {
        if (faults.sourceFailure === 'read') throw Error('Source read unavailable')
        return read(...values)
      }) as typeof handle.read
    }
    if (String(args[0]).endsWith('.history.tmp')) {
      const write = handle.write.bind(handle)
      handle.write = (async (...values: Parameters<typeof write>) => {
        const result = await write(...values)
        await faults.copied?.()
        return result
      }) as typeof handle.write
    }
    return handle
  }, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    const result = await actual.lstat(...args)
    if (String(args[0]).endsWith('.history')) faults.inspectedCheckpoint?.()
    return result
  } }
})
vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in the transcript authority fixture') }
  return { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
vi.mock('./loginShellEnv.js', () => ({ loginShellEnvironment: () => ({}) }))
vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))
vi.mock('./deleteAgentFallback.js', () => ({ checkPidRuntime: vi.fn(), terminateDeletedAgent: vi.fn(async () => 'gone') }))
vi.mock('./engineLaunch.js', async original => ({ ...await original<object>(),
  buildEngineLaunchArgv: () => ['<engine>'], dropPermissionFlagIfUnsupported: vi.fn(),
}))
vi.mock('./engineBin.js', async original => ({ ...await original<object>(), enginePathOverride: () => '<engine>' }))
vi.mock('../core/engines/cursorTasks.js', () => ({ removePendingCursorTasks: vi.fn(async () => {}) }))

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
let root: string, transcript: string, directory: string
let registry: typeof import('./registry.js')['registry']
let row: import('./registry.js').RegisteredSession
let capture: typeof import('./captureResumeIdentity.js')['captureResumeIdentity']
let checkpoints: import('./sessionCheckpoint.js').SessionCheckpointStore
const header = (id = A) => JSON.stringify({ type: 'session_meta', payload: { id, cwd: root, source: 'cli' } }) + '\n'
const files = () => Object.fromEntries(readdirSync(directory).map(name => [name, readFileSync(join(directory, name), 'utf8')]))

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'control-transcript-')))
  faults.copied = undefined; faults.inspectedCheckpoint = undefined; faults.openingSource = undefined; faults.sourceFailure = undefined
  for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
    'PI_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
    const path = join(root, name); mkdirSync(path, { recursive: true, mode: 0o700 }); vi.stubEnv(name, path)
  }
  vi.stubEnv('CLAUDE_PROJECTS_DIR', join(root, 'CLAUDE_CONFIG_DIR', 'projects'))
  mkdirSync(join(root, 'CODEX_HOME', 'sessions'))
  writeFileSync(join(root, 'ADAPTER_DATA_DIR', 'engine-homes.json'), '{}')
  transcript = join(root, 'CODEX_HOME', 'sessions', `rollout-${A}.jsonl`)
  writeFileSync(transcript, header())
  directory = join(root, 'checkpoints')
  vi.resetModules()
  vi.mocked((await import('./deleteAgentFallback.js')).terminateDeletedAgent).mockReset().mockResolvedValue('gone')
  ;({ registry } = await import('./registry.js'))
  capture = (await import('./captureResumeIdentity.js')).captureResumeIdentity
  checkpoints = new (await import('./sessionCheckpoint.js')).SessionCheckpointStore(directory)
  row = registry.openPendingAgent({ engine: 'codex', cwd: root, runtimes: [{ backend: 'tmux', paneId: '%1' }] })!
  Object.assign(row, { sessionId: A, transcriptPath: transcript,
    processIdentity: { pid: 7001, executable: '<codex>', startMarker: 'fixture-start' } })
  registry.flush()
})
afterEach(() => {
  faults.copied = undefined; faults.inspectedCheckpoint = undefined; faults.openingSource = undefined; faults.sourceFailure = undefined
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules()
  rmSync(root, { recursive: true, force: true })
})

it.each(['different conversation', 'partial header'])('holds capture of a saved %s before Stop can archive it', async state => {
  writeFileSync(transcript, state === 'partial header' ? '{partial' : header(B))
  await expect(capture(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(registry.byAgent(row.agentId)?.sessionId).toBe(A)
})

it.each(['different conversation', 'partial header', 'unreadable catalog'])('keeps the prior checkpoint and draft when its source has %s', async state => {
  await checkpoints.save(row, { screen: 'Original unsent draft' })
  const before = files()
  if (state === 'unreadable catalog') writeFileSync(join(root, 'ADAPTER_DATA_DIR', 'engine-homes.json'), '{partial')
  else writeFileSync(transcript, state === 'partial header' ? '{partial' : header(B))
  await expect(checkpoints.save(row, { screen: 'Must not replace the prior draft' })).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(files()).toEqual(before)
})

it.each(['header', 'catalog'])('rechecks the native %s after asynchronous copying before publishing a checkpoint', async changed => {
  utimesSync(transcript, 1, 1)
  await checkpoints.save(row, { screen: 'Original draft' })
  const before = files()
  // Force another checkpoint without changing its native header or identity.
  writeFileSync(transcript, header() + '{"type":"event_msg"}\n')
  utimesSync(transcript, 2, 2)
  faults.copied = () => {
    if (changed === 'catalog') writeFileSync(join(root, 'ADAPTER_DATA_DIR', 'engine-homes.json'), '{partial')
    else {
      writeFileSync(transcript, header(B) + '{"type":"event_msg"}\n')
      // Same inode, byte count and timestamp do not prove the same native conversation.
      utimesSync(transcript, 2, 2)
    }
  }
  await expect(checkpoints.save(row, { screen: 'New draft' })).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(files()).toEqual(before)
})

it('rechecks native identity after inspecting an otherwise reusable checkpoint', async () => {
  await checkpoints.save(row, { screen: 'Original draft' })
  const before = files()
  faults.inspectedCheckpoint = () => writeFileSync(transcript, header(B))
  await expect(checkpoints.save(row, { screen: 'New draft' })).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(files()).toEqual(before)
})

it('holds a source descriptor opened through an ancestor that moves away and back', async () => {
  await checkpoints.save(row, { screen: 'Original draft' })
  const before = files()
  writeFileSync(transcript, header() + '{"turn":"new content"}\n')
  const sourceDirectory = dirname(transcript), parked = sourceDirectory + '-parked', other = sourceDirectory + '-other'
  mkdirSync(other)
  writeFileSync(join(other, basename(transcript)), header() + '{"turn":"wrong file!"}\n')
  faults.openingSource = () => {
    faults.openingSource = undefined
    renameSync(sourceDirectory, parked); renameSync(other, sourceDirectory)
    return () => { renameSync(sourceDirectory, other); renameSync(parked, sourceDirectory) }
  }
  await expect(checkpoints.save(row, { screen: 'New draft' })).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(files()).toEqual(before)
  expect(readFileSync(transcript, 'utf8')).toContain('new content')
})

it('copies a newly appended body rather than reusing history inspected before an await', async () => {
  await checkpoints.save(row)
  faults.inspectedCheckpoint = () => {
    faults.inspectedCheckpoint = undefined
    writeFileSync(transcript, header() + '{"turn":"flushed during checkpoint lookup"}\n')
  }
  await checkpoints.save(row)
  expect(Object.values(files()).some(contents => contents === readFileSync(transcript, 'utf8'))).toBe(true)
})

it('does not reuse same-sized history rewritten in place with a restored modification time', async () => {
  writeFileSync(transcript, header() + '{"turn":"first"}\n')
  utimesSync(transcript, 1, 1)
  await checkpoints.save(row)
  writeFileSync(transcript, header() + '{"turn":"later"}\n')
  utimesSync(transcript, 1, 1)
  await checkpoints.save(row)
  expect(Object.values(files()).some(contents => contents === readFileSync(transcript, 'utf8'))).toBe(true)
})

it.each(['open', 'stat', 'read', 'close'] as const)('holds an unavailable source %s without replacing saved history or draft', async stage => {
  await checkpoints.save(row, { screen: 'Original draft' })
  const before = files()
  writeFileSync(transcript, header() + '{"turn":"new content"}\n')
  faults.sourceFailure = stage
  await expect(checkpoints.save(row, { screen: 'New draft' })).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(files()).toEqual(before)
})

it('keeps the prior draft if closing an otherwise reusable source descriptor fails', async () => {
  await checkpoints.save(row, { screen: 'Original draft' })
  const before = files()
  faults.sourceFailure = 'close'
  await expect(checkpoints.save(row, { screen: 'New draft' })).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(files()).toEqual(before)
})

it('keeps a fresh lookup budget after a slow copy instead of expiring otherwise valid history', async () => {
  faults.copied = async () => { await new Promise(resolve => setTimeout(resolve, 350)) }
  await expect(checkpoints.save(row, { screen: 'The unsent draft' })).resolves.toBeUndefined()
  expect(Object.values(files()).some(contents => contents === header())).toBe(true)
})

it('refuses a physically replaced transcript even when its new header names the same conversation', async () => {
  const { controlTranscriptEvidence } = await import('../engines/transcriptBindings.js')
  const proof = controlTranscriptEvidence('codex', A, transcript)
  const replacement = transcript + '.replacement'
  writeFileSync(replacement, header()); renameSync(replacement, transcript)
  expect(() => proof.verify()).toThrow('replaced during the operation')
})

it('accepts an appended body with a fresh complete header after a long wait', async () => {
  const { controlTranscriptEvidence } = await import('../engines/transcriptBindings.js')
  const proof = controlTranscriptEvidence('codex', A, transcript)
  await new Promise(resolve => setTimeout(resolve, 350))
  writeFileSync(transcript, header() + '{"type":"event_msg"}\n')
  expect(() => proof.verify()).not.toThrow()
})

it.each(['claude', 'pi'] as const)('eagerly checks the saved %s opening without a worker', async engine => {
  const folder = engine === 'claude' ? join(root, 'CLAUDE_CONFIG_DIR', 'projects', 'fixture')
    : join(root, 'PI_HOME', 'agent', 'sessions', 'fixture')
  mkdirSync(folder, { recursive: true })
  transcript = join(folder, `${A}.jsonl`)
  const opening = (id: string, extra: object = {}) => JSON.stringify(engine === 'claude'
    ? { type: 'user', sessionId: id, cwd: root, isSidechain: false, ...extra }
    : { type: 'session', id, cwd: root, ...extra }) + '\n'
  Object.assign(row, { engine, transcriptPath: transcript })
  writeFileSync(transcript, opening(A))
  await checkpoints.save(row, { screen: 'Original draft' })
  const before = files()
  for (const contents of [opening(B), '{partial', opening(A, engine === 'claude' ? { isSidechain: true } : { cwd: dirname(root) })]) {
    writeFileSync(transcript, contents)
    await expect(capture(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
    await expect(checkpoints.save(row, { screen: 'New draft' })).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
    expect(files()).toEqual(before)
  }
  writeFileSync(transcript, (engine === 'claude' ? '{"type":"queue-operation"}\n' : '') + opening(A))
  await expect(capture(row)).resolves.toMatchObject({ sessionId: A, transcriptPath: transcript })
})

it.each(['claude', 'pi'] as const)('does not let a different physical %s file lend its valid opening to a saved path', async engine => {
  const { NativeFiles } = await import('../engines/kit/nativeFiles.js')
  const { controlTranscriptEvidence } = await import('../engines/transcriptBindings.js')
  const parent = engine === 'claude' ? join(root, 'CLAUDE_CONFIG_DIR', 'projects') : join(root, 'PI_HOME', 'agent', 'sessions')
  const folder = join(parent, 'source'), parked = join(parent, 'parked'), other = join(parent, 'other')
  mkdirSync(folder, { recursive: true }); mkdirSync(other)
  const opening = (id: string) => JSON.stringify(engine === 'claude'
    ? { type: 'user', sessionId: id, cwd: root, isSidechain: false } : { type: 'session', id, cwd: root }) + '\n'
  const path = join(folder, `${A}.jsonl`)
  writeFileSync(path, opening(B)); writeFileSync(join(other, `${A}.jsonl`), opening(A))
  const readOpening = NativeFiles.prototype.opening, verify = NativeFiles.prototype.verify
  const swapped = new Set<import('../engines/kit/nativeFiles.js').NativeFiles>()
  let moved = false
  const restore = () => { if (moved) { renameSync(folder, other); renameSync(parked, folder); moved = false } }
  vi.spyOn(NativeFiles.prototype, 'opening').mockImplementation(function (this: import('../engines/kit/nativeFiles.js').NativeFiles, selected, rule) {
    renameSync(folder, parked); renameSync(other, folder); moved = true; swapped.add(this)
    return readOpening.call(this, selected, rule)
  })
  vi.spyOn(NativeFiles.prototype, 'verify').mockImplementation(function (this: import('../engines/kit/nativeFiles.js').NativeFiles, selected) {
    verify.call(this, selected)
    if (swapped.has(this)) restore()
  })
  try { expect(() => controlTranscriptEvidence(engine, A, path, undefined, root)).toThrow(expect.objectContaining({ code: 'IDENTITY_UNAVAILABLE' })) }
  finally { restore() }
  expect(readFileSync(path, 'utf8')).toBe(opening(B))
})

it('preserves a repaired parent through Stop and the final real forget archive', async () => {
  const { createStopAgentService } = await import('./stopAgentService.js')
  const { createForgetSession } = await import('../core/agents/forget.js')
  const { StoppedAgentStore } = await import('./stoppedAgents.js')
  const { AgentRestartCoordinator } = await import('./restartAgent.js')
  const parent = transcript, child = join(dirname(parent), `rollout-${B}.jsonl`)
  writeFileSync(child, JSON.stringify({ type: 'session_meta', payload: { id: B, cwd: root,
    source: { subagent: { thread_spawn: { parent_thread_id: A } } } } }) + '\n')
  row.transcriptPath = child
  const stopped = new StoppedAgentStore(join(root, 'stopped'))
  const forget = createForgetSession({ registry, stoppedAgents: stopped, syncRecapPool: vi.fn(), normalizers: { forget: vi.fn() },
    forgetAttach: vi.fn(), turnStartedAt: new Map(), neverFoldedHistory: new Set(), replayedFirstTurn: new Set(),
    clearAgyIdleWatch: vi.fn(), cursorDiscovery: { remove: vi.fn() }, cursorSubagents: { forget: vi.fn() },
    runtimeProfiles: { forget: vi.fn() }, watcher: { removeSession: vi.fn(async () => {}) },
    stopHeartbeat: vi.fn(), teams: { forget: vi.fn() }, input: { forget: vi.fn() }, deviceInput: { forget: vi.fn() },
    detachDsh: vi.fn(), mirror: { forget: vi.fn() }, clients: { send: vi.fn(), sendCommander: vi.fn() },
    dataDir: join(root, 'ADAPTER_DATA_DIR') })
  const stop = createStopAgentService({ registry, stoppedAgents: stopped, restartJobs: new AgentRestartCoordinator(),
    stopJobs: new Map(), tmuxBackend: { kill: vi.fn(async () => ({ state: 'succeeded' as const, dispatch: 'executed' as const })) },
    agentReconciler: { suppress: vi.fn(), holdRoute: vi.fn(), releaseRoute: vi.fn(), trigger: vi.fn(async () => {}) },
    forgetSession: forget, markDeleted: vi.fn(), clearDeleted: vi.fn(), stopNative: async () => {} })
  await stop(row.agentId, { checkpoint: async session => {
    expect(session.transcriptPath).toBe(parent)
    stopped.save({ ...row, title: 'A hook saved the stale child path' })
  } })
  expect(registry.byAgent(row.agentId)).toBeUndefined()
  expect(stopped.get(row.agentId)).toMatchObject({ active: false, sessionId: A, transcriptPath: parent })
})

it('retains a typed Stop hold when the native broker contains a failed grant check', async () => {
  const { createNativeControls } = await import('../core/engines/nativeControls.js')
  const { engineNativeControlRequests } = await import('../engines/worker/nativeControlRequests.js')
  const { launch } = await import('../engines/codex/launch.js')
  const { argvTokens } = await import('./tmux.js')
  const { createStopAgentService } = await import('./stopAgentService.js')
  const { StoppedAgentStore } = await import('./stoppedAgents.js')
  const { AgentRestartCoordinator } = await import('./restartAgent.js')
  const { terminateDeletedAgent } = await import('./deleteAgentFallback.js')
  const mutation = vi.fn()
  let core!: ReturnType<typeof createNativeControls>
  const requests = engineNativeControlRequests('codex', { load: async () => ({ activity: async () => 'working',
    stop: async (_conversation, host) => { writeFileSync(transcript, header(B)); if (await host.current()) mutation() },
    recover: async () => {}, close: () => {} }), recycle: vi.fn(),
    query: async (query, payload) => core.answer('engine-codex', query, payload) ?? { error: 'DENIED' } })
  core = createNativeControls({ call: async (_service, method, payload) =>
    requests[method]({ ...payload, requestId: 'fixture-request' }, { owner: true, local: true }) as Promise<Record<string, unknown>>,
    handles: () => true, inline: () => undefined, servers: { codex: launch.sharedServer! }, home: () => join(root, 'CODEX_HOME'),
    rows: async () => [{ ...row.processIdentity!, parentPid: 1, args: `codex resume ${A}` },
      { pid: 90, parentPid: 1, executable: 'codex', startMarker: 'server-birth', args: 'codex app-server' }],
    argv: argvTokens, readFile: async () => JSON.stringify({ pid: 90, processStartTime: 'server-birth' }), log: vi.fn() })
  core.connected('engine-codex')
  const kill = vi.fn(async () => ({ state: 'succeeded' as const, dispatch: 'executed' as const })), forget = vi.fn()
  const stop = createStopAgentService({ registry, stoppedAgents: new StoppedAgentStore(join(root, 'stopped')),
    restartJobs: new AgentRestartCoordinator(), stopJobs: new Map(), tmuxBackend: { kill },
    agentReconciler: { suppress: vi.fn(), holdRoute: vi.fn(), releaseRoute: vi.fn(), trigger: vi.fn(async () => {}) },
    forgetSession: forget, markDeleted: vi.fn(), clearDeleted: vi.fn(), stopNative: core.stop })
  await expect(stop(row.agentId)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(mutation).not.toHaveBeenCalled(); expect(terminateDeletedAgent).not.toHaveBeenCalled()
  expect(kill).not.toHaveBeenCalled(); expect(forget).not.toHaveBeenCalled()
})

it.each(['checkpoint', 'native drain'])('holds Stop when its transcript changes during the %s await', async phase => {
  const { createStopAgentService } = await import('./stopAgentService.js')
  const { StoppedAgentStore } = await import('./stoppedAgents.js')
  const { AgentRestartCoordinator } = await import('./restartAgent.js')
  const { terminateDeletedAgent } = await import('./deleteAgentFallback.js')
  vi.mocked(terminateDeletedAgent).mockClear()
  const kill = vi.fn(async () => ({ state: 'succeeded' as const, dispatch: 'executed' as const }))
  const forget = vi.fn()
  const stopNative = vi.fn(async () => { if (phase === 'native drain') writeFileSync(transcript, header(B)) })
  const stop = createStopAgentService({ registry, stoppedAgents: new StoppedAgentStore(join(root, 'stopped')),
    restartJobs: new AgentRestartCoordinator(), stopJobs: new Map(), tmuxBackend: { kill },
    agentReconciler: { suppress: vi.fn(), holdRoute: vi.fn(), releaseRoute: vi.fn(), trigger: vi.fn(async () => {}) },
    forgetSession: forget, markDeleted: vi.fn(), clearDeleted: vi.fn(), stopNative })
  await expect(stop(row.agentId, { checkpoint: async () => {
    if (phase === 'checkpoint') writeFileSync(transcript, header(B))
  } })).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(terminateDeletedAgent).not.toHaveBeenCalled()
  expect(kill).not.toHaveBeenCalled()
  expect(forget).not.toHaveBeenCalled()
  expect(registry.byAgent(row.agentId)?.sessionId).toBe(A)
  if (phase === 'checkpoint') expect(stopNative).not.toHaveBeenCalled()
})

it.each(['binding', 'process birth', 'native grant', 'contained grant', 'process signal', 'pane completion'] as const)(
  'keeps Stop authority at the %s boundary', async phase => {
    const { createStopAgentService } = await import('./stopAgentService.js')
    const { StoppedAgentStore } = await import('./stoppedAgents.js')
    const { AgentRestartCoordinator } = await import('./restartAgent.js')
    const { terminateDeletedAgent } = await import('./deleteAgentFallback.js')
    if (phase === 'process birth') row.processIdentity!.startTicks = 1
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true)
    const realTermination = (await vi.importActual<typeof import('./deleteAgentFallback.js')>('./deleteAgentFallback.js')).terminateDeletedAgent
    vi.mocked(terminateDeletedAgent).mockImplementationOnce(async (session, dependencies) => {
      if (phase === 'process signal') return realTermination(session, { ...dependencies,
        sleep: async () => {}, checkRuntime: async () => { writeFileSync(transcript, header(B)); return { state: 'alive' } },
      })
      return 'gone'
    })
    const kill = vi.fn(async () => {
      if (phase === 'pane completion') writeFileSync(transcript, header(B))
      return { state: 'succeeded' as const, dispatch: 'executed' as const }
    })
    const forget = vi.fn(), nativeMutation = vi.fn()
    const stop = createStopAgentService({ registry, stoppedAgents: new StoppedAgentStore(join(root, 'stopped')),
      restartJobs: new AgentRestartCoordinator(), stopJobs: new Map(), tmuxBackend: { kill },
      agentReconciler: { suppress: vi.fn(), holdRoute: vi.fn(), releaseRoute: vi.fn(), trigger: vi.fn(async () => {}) },
      forgetSession: forget, markDeleted: vi.fn(), clearDeleted: vi.fn(), stopNative: async (_session, current) => {
        if (phase === 'native grant' || phase === 'contained grant') writeFileSync(transcript, header(B))
        if (phase === 'contained grant') { try { current() } catch {} return }
        if (current()) nativeMutation()
      } })
    await expect(stop(row.agentId, { checkpoint: async (_session, when) => {
      if (phase === 'binding' && when === 'before') registry.byAgent(row.agentId)!.boundAt = 2
      if (phase === 'process birth' && when === 'before') registry.byAgent(row.agentId)!.processIdentity!.startTicks = 2
    } })).rejects.toMatchObject({ code: phase === 'binding' || phase === 'process birth' ? 'STOP_UNCONFIRMED' : 'IDENTITY_UNAVAILABLE' })
    expect(signal).not.toHaveBeenCalled()
    expect(forget).not.toHaveBeenCalled()
    if (phase !== 'pane completion') expect(kill).not.toHaveBeenCalled()
    if (phase === 'native grant' || phase === 'contained grant' || phase === 'binding' || phase === 'process birth') expect(nativeMutation).not.toHaveBeenCalled()
  })

it.each(['before', 'configuration', 'history repair', 'permission', 'tmux dispatch', 'conversation ownership', 'allocation'] as const)(
  'holds Resume when its native conversation changes during %s', async phase => {
    const { createResumeAgentService } = await import('./resumeAgentService.js')
    const { StoppedAgentStore } = await import('./stoppedAgents.js')
    const { AgentRestartCoordinator } = await import('./restartAgent.js')
    const { checkPidRuntime } = await import('./deleteAgentFallback.js')
    const { dropPermissionFlagIfUnsupported } = await import('./engineLaunch.js')
    const { TmuxBackend } = await import('./tmuxBackend.js')
    const { tmuxFeaturesOf } = await import('./tmuxVersion.js')
    vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'gone', reason: 'fixture process ended' })
    vi.mocked(dropPermissionFlagIfUnsupported).mockImplementation(async (_engine, choice) => {
      if (phase === 'permission') writeFileSync(transcript, header(B))
      return { choice, droppedFlag: null }
    })
    registry.removeAgent(row.agentId)
    const stopped = new StoppedAgentStore(join(root, 'stopped')); stopped.save(row)
    const writeConfiguration = vi.fn()
    const prepare = vi.fn(() => { if (phase === 'history repair') writeFileSync(transcript, header(B)) })
    const create = vi.fn(async () => {
      writeFileSync(transcript, header(B))
      return { state: 'succeeded' as const, dispatch: 'executed' as const, runtime: { backend: 'tmux' as const, paneId: '%99' } }
    })
    const kill = vi.fn(async () => ({ state: 'succeeded' as const, dispatch: 'executed' as const }))
    const announce = vi.fn()
    let newOwner: string | undefined
    const backend = phase === 'tmux dispatch' || phase === 'conversation ownership' ? new TmuxBackend(undefined, () => 'fixture-owner', () => {}, async () => {
      // The backend has accepted the request, but has not crossed its actual process-dispatch gate.
      if (phase === 'conversation ownership') {
        const other = registry.openPendingAgent({ engine: 'codex', cwd: root, runtimes: [{ backend: 'tmux', paneId: '%88' }] })!
        const admitted = registry.register({ engine: 'codex', cwd: root, tmuxPane: '%88', sessionId: A, transcriptPath: transcript })!
        expect(admitted.entry.agentId).toBe(other.agentId)
        newOwner = other.agentId
      } else writeFileSync(transcript, header(B))
      return tmuxFeaturesOf({ major: 3, minor: 7 })
    }) : { create, kill }
    const resume = createResumeAgentService({ registry, stoppedAgents: stopped, restartJobs: new AgentRestartCoordinator(),
      stopJobs: new Map(), pinnedControls: new Set(), tmuxBackend: backend,
      retainExitedSession: vi.fn(), announceSession: announce,
      relaunchOverrides: async (_session, _source, current) => {
        await Promise.resolve()
        if (phase === 'configuration') writeFileSync(transcript, header(B))
        if (current()) writeConfiguration()
        return { ok: true, overrides: { env: {}, extraArgs: [], clearEnv: [] } }
      },
      prepareSessionResume: prepare, refreshGridWebSearch: vi.fn(), clearDeleted: vi.fn(), attachDsh: vi.fn(),
      attachSession: vi.fn(async () => true),
    })
    if (phase === 'before') writeFileSync(transcript, header(B))
    await expect(resume(row.agentId)).resolves.toMatchObject({ ok: false,
      error: phase === 'allocation' ? 'RESUME_UNCONFIRMED' : 'IDENTITY_UNAVAILABLE',
      detail: expect.stringContaining(phase === 'conversation ownership' ? 'another live harness' : 'different conversation') })
    expect(registry.byAgent(row.agentId)).toBeUndefined()
    expect(announce).not.toHaveBeenCalled()
    expect(stopped.get(row.agentId)?.sessionId).toBe(A)
    if (newOwner) expect(registry.bySession(A)?.agentId).toBe(newOwner)
    if (phase === 'before' || phase === 'configuration') {
      expect(writeConfiguration).not.toHaveBeenCalled()
      expect(prepare).not.toHaveBeenCalled()
    }
    if (phase === 'allocation') expect(kill).toHaveBeenCalledExactlyOnceWith({ backend: 'tmux', paneId: '%99' })
    else { expect(create).not.toHaveBeenCalled(); expect(stopped.resumeReservedAt(row.agentId)).toBeNull() }
  },
)
