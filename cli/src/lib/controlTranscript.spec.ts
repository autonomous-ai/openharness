import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({ copied: undefined as (() => void | Promise<void>) | undefined }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
    await actual.copyFile(...args); await faults.copied?.()
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
  faults.copied = undefined
  for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
    const path = join(root, name); mkdirSync(path, { recursive: true, mode: 0o700 }); vi.stubEnv(name, path)
  }
  vi.stubEnv('CLAUDE_PROJECTS_DIR', join(root, 'CLAUDE_CONFIG_DIR', 'projects'))
  mkdirSync(join(root, 'CODEX_HOME', 'sessions'))
  writeFileSync(join(root, 'ADAPTER_DATA_DIR', 'engine-homes.json'), '{}')
  transcript = join(root, 'CODEX_HOME', 'sessions', `rollout-${A}.jsonl`)
  writeFileSync(transcript, header())
  directory = join(root, 'checkpoints')
  vi.resetModules()
  ;({ registry } = await import('./registry.js'))
  capture = (await import('./captureResumeIdentity.js')).captureResumeIdentity
  checkpoints = new (await import('./sessionCheckpoint.js')).SessionCheckpointStore(directory)
  row = registry.openPendingAgent({ engine: 'codex', cwd: root, runtimes: [{ backend: 'tmux', paneId: '%1' }] })!
  Object.assign(row, { sessionId: A, transcriptPath: transcript,
    processIdentity: { pid: 7001, executable: '<codex>', startMarker: 'fixture-start' } })
  registry.flush()
})
afterEach(() => {
  faults.copied = undefined
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
  await checkpoints.save(row)
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
  await expect(checkpoints.save(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
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

it.each(['before', 'configuration', 'history repair', 'permission', 'allocation'] as const)(
  'holds Resume when its native conversation changes during %s', async phase => {
    const { createResumeAgentService } = await import('./resumeAgentService.js')
    const { StoppedAgentStore } = await import('./stoppedAgents.js')
    const { AgentRestartCoordinator } = await import('./restartAgent.js')
    const { checkPidRuntime } = await import('./deleteAgentFallback.js')
    const { dropPermissionFlagIfUnsupported } = await import('./engineLaunch.js')
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
    const resume = createResumeAgentService({ registry, stoppedAgents: stopped, restartJobs: new AgentRestartCoordinator(),
      stopJobs: new Map(), pinnedControls: new Set(), tmuxBackend: { create, kill },
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
      error: phase === 'allocation' ? 'RESUME_UNCONFIRMED' : 'IDENTITY_UNAVAILABLE', detail: expect.stringContaining('different conversation') })
    expect(registry.byAgent(row.agentId)).toBeUndefined()
    expect(announce).not.toHaveBeenCalled()
    expect(stopped.get(row.agentId)?.sessionId).toBe(A)
    if (phase === 'before' || phase === 'configuration') {
      expect(writeConfiguration).not.toHaveBeenCalled()
      expect(prepare).not.toHaveBeenCalled()
    }
    if (phase === 'allocation') expect(kill).toHaveBeenCalledExactlyOnceWith({ backend: 'tmux', paneId: '%99' })
    else { expect(create).not.toHaveBeenCalled(); expect(stopped.resumeReservedAt(row.agentId)).toBeNull() }
  },
)
