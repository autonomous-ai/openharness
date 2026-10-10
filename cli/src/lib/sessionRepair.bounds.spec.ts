import { nativeConversationFixture } from '../testing/nativeConversationEvidence.js'
import { execFile, execFileSync } from 'node:child_process'
import { constants } from 'node:buffer'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { identityBytes, identityEntries, identityScanBudget } from '../engines/kit/identityScan.js'
import type { RegisteredSession } from './registry.js'
import type { StopAgentServiceDeps } from './stopAgentService.js'

// These cases exercise count/byte bounds and changing ownership, not host fsync speed.
// homeAdoption.spec.ts separately advances this clock to prove the work deadline holds.
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), opendir: vi.fn(actual.opendir), stat: vi.fn(actual.stat),
    readdir: vi.fn(actual.readdir), readlink: vi.fn(actual.readlink) }
})
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})
vi.mock('./tmux.js', async original => ({ ...await original<object>(), processRows: vi.fn() }))
vi.mock('../engines/kit/nativeDescriptors.js', async original => ({ ...await original<object>(), readDescriptorEvidence: vi.fn() }))
vi.mock('./processEvidence.js', async () => {
  const { nativeConversationFixture } = await import('../testing/nativeConversationEvidence.js')
  const { processRows } = await import('./tmux.js')
  const { readDescriptorEvidence } = await import('../engines/kit/nativeDescriptors.js')
  return { readProcessEvidence: (...args: Parameters<typeof import('./processEvidence.js')['readProcessEvidence']>) => {
    const sources = nativeConversationFixture(async () => [], processRows)
    sources.descriptors = readDescriptorEvidence
    return sources.processes(...args)
  } }
})
vi.mock('./deleteAgentFallback.js', () => ({ checkPidRuntime: vi.fn(), terminateDeletedAgent: vi.fn() }))

const START = Date.parse('2026-10-09T00:00:00Z')
const CWD = '/workspace'
const SID = '11111111-2222-4333-8444-555555555555'
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
let root: string
let repair: typeof import('./sessionRepair.js')
const body = (cwd = CWD) => JSON.stringify({ cwd, isSidechain: false }) + '\n'
function file(path: string, text: string, time = START): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  utimesSync(path, time / 1000, time / 1000)
  return path
}
const transcript = (name = SID, cwd = CWD, time = START) => file(join(root, 'claude', 'projects', 'work', `${name}.jsonl`), body(cwd), time)
const record = (text: string, home = join(root, 'claude')) => file(join(home, 'sessions', '77.json'), text)
const validRecord = (id = SID) => JSON.stringify({ pid: 77, procStart: new Date(START).toISOString(), cwd: CWD, sessionId: id })

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open)
  vi.mocked(fs.opendir).mockReset().mockImplementation(actual.opendir)
  vi.mocked(fs.stat).mockReset().mockImplementation(actual.stat)
  vi.mocked(fs.readdir).mockReset().mockImplementation(actual.readdir)
  vi.mocked(fs.readlink).mockReset().mockImplementation(actual.readlink)
  const processes = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  vi.mocked(execFile).mockReset().mockImplementation(processes.execFile)
  root = realpathSync(mkdtempSync(join(tmpdir(), 'identity-bounds-')))
  const homes = { HOME: join(root, 'home'), ADAPTER_DATA_DIR: join(root, 'data'),
    CLAUDE_PROJECTS_DIR: join(root, 'claude', 'projects'), CODEX_HOME: join(root, 'codex'),
    COPILOT_HOME: join(root, 'copilot'), GROK_HOME: join(root, 'grok'), PI_HOME: join(root, 'pi'), MUSE_HOME: join(root, 'muse') }
  for (const [name, value] of Object.entries(homes)) vi.stubEnv(name, value)
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  vi.resetModules()
  repair = await import('./sessionRepair.js')
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })
const scan = () => repair.findLiveSession('claude', CWD, START, { bornOnly: true })

describe('complete bounded evidence before choosing a conversation', () => {
  it('never makes a hidden second candidate unique by retaining only the newest 400 files', async () => {
    transcript('visible', CWD, START + 2000)
    transcript('hidden', CWD, START)
    for (let i = 0; i < 399; i++) transcript(`other-${i}`, '/elsewhere', START + 1000)
    await expect(scan()).rejects.toThrow('transcript count limit')
  })

  it('shares the file budget across moved homes', async () => {
    const moved = join(root, 'moved')
    for (let i = 0; i < 200; i++) transcript(`other-${i}`, '/elsewhere')
    for (let i = 0; i < 200; i++) file(join(moved, 'projects', 'work', `${i}.jsonl`), body('/elsewhere'))
    transcript('visible')
    const homes = await import('./engineHomes.js')
    homes.adoptEngineHomes({ CLAUDE_CONFIG_DIR: moved }, { claudeHome: join(root, 'claude'), codexHome: join(root, 'codex') })
    await expect(scan()).rejects.toThrow('transcript count limit')
  })

  it('holds a shallow candidate if an unknown deeper subtree cannot be inspected', async () => {
    transcript('visible')
    file(join(root, 'claude', 'projects', 'a', 'b', 'c', 'd', 'e', 'hidden.jsonl'), body())
    await expect(scan()).rejects.toThrow('depth limit')
  })

  it('excludes declared subagent folders before applying depth bounds', async () => {
    const path = transcript()
    file(join(root, 'claude', 'projects', 'work', 'subagents', 'a', 'b', 'c', 'd', 'child.jsonl'), body())
    await expect(scan()).resolves.toEqual({ sessionId: SID, transcriptPath: path })
  })

  it('holds on an unreadable subtree and recovers on a later complete scan', async () => {
    const path = transcript()
    const hidden = join(root, 'claude', 'projects', 'unknown'); mkdirSync(hidden)
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(fs.opendir).mockImplementation(async (path, options) => {
      if (String(path) === hidden) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' })
      return actual.opendir(path, options)
    })
    await expect(scan()).rejects.toThrow('directory could not be read')
    vi.mocked(fs.opendir).mockImplementation(actual.opendir)
    await expect(scan()).resolves.toEqual({ sessionId: SID, transcriptPath: path })
  })

  it('bounds directory iteration itself and closes its iterator on exhaustion', async () => {
    let reads = 0, closed = false
    const directory = { async *[Symbol.asyncIterator]() {
      try { while (true) { reads++; yield { name: `unrelated-${reads}` } } }
      finally { closed = true }
    } }
    vi.mocked(fs.opendir).mockResolvedValueOnce(directory as never)
    await expect((async () => { for await (const _entry of identityEntries('/fixture', identityScanBudget())) { /* consume */ } })())
      .rejects.toThrow('directory entry limit')
    expect(reads).toBe(4096)
    expect(closed).toBe(true)
    expect(fs.opendir).toHaveBeenLastCalledWith('/fixture', { bufferSize: 32 })
  })

  it.each(['read error', 'byte limit', 'line limit', 'unknown sidechain', 'empty', 'partial'])('does not choose a sibling when another header has %s', async mode => {
    transcript('sibling')
    const path = transcript('unknown')
    if (mode === 'empty') file(path, '')
    if (mode === 'partial') file(path, '{"cwd":"/workspace')
    if (mode === 'byte limit') file(path, ' '.repeat(256 * 1024) + body())
    if (mode === 'line limit') file(path, '{}\n'.repeat(20) + body())
    if (mode === 'unknown sidechain') file(path, JSON.stringify({ cwd: CWD }) + '\n' + '{}\n'.repeat(20) + '{"isSidechain":true}\n')
    if (mode === 'read error') {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
        if (String(name) === path) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' })
        return actual.open(name, flags, mode)
      })
    }
    await expect(scan()).rejects.toThrow('Conversation identity is held')
  })

  it('can exclude a confirmed different cwd without reading its remaining history', async () => {
    const path = transcript()
    file(join(root, 'claude', 'projects', 'other.jsonl'), JSON.stringify({ cwd: '/elsewhere' }) + '\n' + 'x'.repeat(2 * 1024 * 1024))
    await expect(scan()).resolves.toEqual({ sessionId: SID, transcriptPath: path })
  })

  it.each(['claude', 'codex', 'codex-profile'])('rechecks %s home authority after an awaited native lookup', async mode => {
    const moved = join(root, 'new-home')
    const homes = await import('./engineHomes.js')
    const codex = mode !== 'claude'
    const header = (id: string) => JSON.stringify({ type: 'session_meta', payload: { id, cwd: CWD } }) + '\n'
    const own = codex ? file(join(root, 'codex', 'sessions', `rollout-${SID}.jsonl`), header(SID)) : transcript()
    const other = codex ? file(join(moved, 'sessions', `rollout-${OTHER}.jsonl`), header(OTHER))
      : file(join(moved, 'projects', 'work', `${OTHER}.jsonl`), body())
    if (codex) {
      const { processRows } = await import('./tmux.js')
      const { readDescriptorEvidence } = await import('../engines/kit/nativeDescriptors.js')
      vi.mocked(processRows).mockResolvedValue([{ pid: 77, parentPid: 1, executable: 'codex', args: 'codex', startMarker: new Date(START).toString() }])
      vi.mocked(readDescriptorEvidence).mockImplementation(nativeConversationFixture(async () => [own, other]).descriptors)
    }
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let adopted = false
    vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
      if (String(name) === own && !adopted) {
        adopted = true
        homes.adoptEngineHomes(codex ? { CODEX_HOME: moved } : { CLAUDE_CONFIG_DIR: moved },
          { claudeHome: join(root, 'claude'), codexHome: join(root, 'codex') })
      }
      return actual.open(name, flags, mode)
    })
    const result = codex ? repair.findLiveSession('codex', CWD, START,
      { pid: 77, ...(mode === 'codex-profile' ? { codexHome: join(root, 'codex') } : {}) }) : scan()
    if (mode === 'codex-profile') await expect(result).resolves.toEqual({ sessionId: SID, transcriptPath: own })
    else await expect(result).rejects.toThrow('known session homes changed')
    expect(adopted).toBe(true)
  })
})

describe('bounded native metadata', () => {
  it.each(['empty', 'partial', 'line limit'])('holds Copilot with a %s competing header', async mode => {
    const header = JSON.stringify({ type: 'session.start', data: { context: { cwd: CWD } } }) + '\n'
    file(join(root, 'copilot', 'session-state', SID, 'events.jsonl'), header)
    file(join(root, 'copilot', 'session-state', OTHER, 'events.jsonl'), mode === 'empty' ? ''
      : mode === 'partial' ? '{"type":"session.start","data":' : '{}\n'.repeat(5) + header)
    await expect(repair.findLiveSession('copilot', CWD, START)).rejects.toThrow('identity is held')
  })

  it.each(['empty', 'partial', 'oversized', 'read error'])('holds Codex with a %s competing rollout, including process-owned files', async mode => {
    const home = join(root, 'codex', 'sessions')
    const header = (id: string) => JSON.stringify({ type: 'session_meta', payload: { id, cwd: CWD } }) + '\n'
    const own = file(join(home, `rollout-${SID}.jsonl`), header(SID))
    const other = file(join(home, `rollout-${OTHER}.jsonl`), mode === 'empty' ? ''
      : mode === 'partial' ? '{"type":"session_meta","payload":' : ' '.repeat(128 * 1024) + header(OTHER))
    if (mode === 'read error') {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
        if (String(name) === other) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' })
        return actual.open(name, flags, mode)
      })
    }
    await expect(repair.findLiveSession('codex', CWD, START)).rejects.toThrow('identity is held')
    await expect(repair.openFileSessionOf('codex', 77, home, CWD, { sources: nativeConversationFixture(async () => [own, other]) })).rejects.toThrow('identity is held')
  })

  it.each(['empty', 'workspace', 'run'])('holds Muse with a partly written %s identity beside a complete run', async mode => {
    const base = join(root, 'muse', 'sessions', '2026', '10', '09')
    const header = JSON.stringify({ payload: { record: { workspace_root: CWD } } }) + '\n'
    const run = JSON.stringify({ payload: { kind: 'run', event: { kind: 'started' } } }) + '\n'
    file(join(base, SID, 'session.jsonl'), header + run)
    file(join(base, OTHER, 'session.jsonl'), mode === 'empty' ? '' : mode === 'workspace' ? '{"payload":' : header + '{"payload":')
    await expect(repair.findLiveSession('muse', CWD, START)).rejects.toThrow('identity is held')
  })

  it('reads Copilot opening records without loading a history larger than a JS string', async () => {
    const path = file(join(root, 'copilot', 'session-state', SID, 'events.jsonl'),
      JSON.stringify({ type: 'session.start', data: { context: { cwd: CWD } } }) + '\n')
    truncateSync(path, constants.MAX_STRING_LENGTH + 4096)
    await expect(repair.findLiveSession('copilot', CWD, START)).resolves.toEqual({ sessionId: SID, transcriptPath: path })
  })

  it('holds Copilot when its first identity record exceeds the bounded prefix', async () => {
    file(join(root, 'copilot', 'session-state', SID, 'events.jsonl'), ' '.repeat(256 * 1024) + JSON.stringify({ type: 'session.start', data: { context: { cwd: CWD } } }))
    await expect(repair.findLiveSession('copilot', CWD, START)).rejects.toThrow('header exceeds the read limit')
  })

  it('rejects an oversized Grok sidecar instead of matching a truncated directory', async () => {
    const group = join(root, 'grok', 'sessions', 'hashed')
    file(join(group, SID, 'updates.jsonl'), '{}\n')
    file(join(group, '.cwd'), CWD + ' '.repeat(64 * 1024))
    await expect(repair.findLiveSession('grok', CWD, START)).rejects.toThrow('native record exceeds')
  })

  it.each(['missing', 'relative'])('holds a Grok hash folder with a %s working directory', async mode => {
    file(join(root, 'grok', 'sessions', encodeURIComponent(CWD), SID, 'updates.jsonl'), '{}\n')
    const group = join(root, 'grok', 'sessions', 'hashed')
    file(join(group, OTHER, 'updates.jsonl'), '{}\n')
    if (mode === 'relative') file(join(group, '.cwd'), 'relative')
    await expect(repair.findLiveSession('grok', CWD, START)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  })

  it('holds a native record removed between opening and verifying its path', async () => {
    const path = record(validRecord())
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const handle = await actual.open(path, 'r')
    const original = handle.read.bind(handle)
    vi.spyOn(handle, 'read').mockImplementationOnce((async (...args: Parameters<typeof handle.read>) => {
      const result = await Reflect.apply(original, handle, args)
      rmSync(path)
      return result
    }) as typeof handle.read)
    vi.mocked(fs.open).mockResolvedValueOnce(handle)
    await expect(repair.processSessionOf('claude', 77, CWD, START)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
    expect(handle.fd).toBe(-1)
  })

  it.each(['malformed', 'oversized', 'read error', 'missing transcript'])('does not fall back to a sibling after a %s process record', async mode => {
    transcript(OTHER)
    const path = record(mode === 'malformed' ? '{' : mode === 'oversized' ? validRecord() + ' '.repeat(64 * 1024) : validRecord())
    if (mode === 'read error') {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
        if (String(name) === path) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' })
        return actual.open(name, flags, mode)
      })
    }
    await expect(repair.findLiveSession('claude', CWD, START, { pid: 77 })).rejects.toThrow('Conversation identity is held')
  })

  it.each(['unreadable', 'conflicting'])('does not accept the first home before checking a %s moved-home record', async mode => {
    transcript(); record(validRecord())
    const moved = join(root, 'moved')
    file(join(moved, 'projects', 'work', `${OTHER}.jsonl`), body())
    record(mode === 'unreadable' ? '{' : validRecord(OTHER), moved)
    const homes = await import('./engineHomes.js')
    homes.adoptEngineHomes({ CLAUDE_CONFIG_DIR: moved }, { claudeHome: join(root, 'claude'), codexHome: join(root, 'codex') })
    await expect(repair.processSessionOf('claude', 77, CWD, START)).rejects.toThrow('Conversation identity is held')
  })

  it.each([{ procStart: '' }, { procStart: 'garbage' }, { cwd: '' }, { cwd: 'relative' }, { cwd: '/another/workspace' }])(
    'does not fall back after invalid or contradictory current process evidence %j', async fields => {
      transcript(OTHER)
      record(JSON.stringify({ ...JSON.parse(validRecord()), ...fields }))
      await expect(repair.findLiveSession('claude', CWD, START, { pid: 77 })).rejects.toThrow('identity is held')
    })

  it.each(['initial', 'validation'])('rechecks the authoritative claim after later homes in the %s pass', async pass => {
    transcript(); transcript(OTHER)
    const first = record(validRecord())
    const moved = join(root, 'moved')
    const later = record(JSON.stringify({ ...JSON.parse(validRecord()), pid: 88 }), moved)
    const homes = await import('./engineHomes.js')
    homes.adoptEngineHomes({ CLAUDE_CONFIG_DIR: moved }, { claudeHome: join(root, 'claude'), codexHome: join(root, 'codex') })
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let reads = 0
    vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
      if (String(name) === later && ++reads === (pass === 'initial' ? 1 : 3)) writeFileSync(first, validRecord(OTHER))
      return actual.open(name, flags, mode)
    })
    await expect(repair.processSessionOf('claude', 77, CWD, START)).rejects.toThrow('process records changed')
  })

  it.each(['scan', 'process'])('bounds %s probes even when every saved home is missing', async kind => {
    file(join(root, 'data', 'engine-homes.json'), JSON.stringify({
      claude: Array.from({ length: 65 }, (_, i) => join(root, `missing-${i}`)),
    }))
    await expect(kind === 'scan' ? scan() : repair.processSessionOf('claude', 77, CWD, START))
      .rejects.toThrow('known session-home limit')
    expect(fs.opendir).not.toHaveBeenCalled()
    expect(fs.open).not.toHaveBeenCalled()
  })

  it('holds when the saved home set changes while the authoritative record is rechecked', async () => {
    transcript(); const path = record(validRecord())
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let reads = 0
    vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
      if (String(name) === path && ++reads === 3) {
        file(join(root, 'data', 'engine-homes.json'), JSON.stringify({ claude: [join(root, 'new-home')] }))
      }
      return actual.open(name, flags, mode)
    })
    await expect(repair.processSessionOf('claude', 77, CWD, START)).rejects.toThrow('known session homes changed')
  })

  it('rejects an atomically replaced identity even when its old descriptor stays readable', async () => {
    const path = file(join(root, 'record'), 'before')
    const replacement = file(join(root, 'replacement'), 'after!')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const handle = await actual.open(path, 'r')
    let opened = false
    vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
      if (String(name) === path) {
        if (!opened) { opened = true; return handle }
        renameSync(replacement, path)
      }
      return actual.open(name, flags, mode)
    })
    await expect(identityBytes(path, 64)).rejects.toThrow(/changed during|replaced during/)
    expect(handle.fd).toBe(-1)
  })

  it('rejects nonregular native records without waiting for a FIFO writer', async () => {
    const path = join(root, 'fifo')
    execFileSync('mkfifo', [path])
    await expect(identityBytes(path, 64)).rejects.toThrow('not a regular file')
  })

  it('rejects a file changing or ending during the read and closes the descriptor', async () => {
    const path = file(join(root, 'record'), 'complete')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    for (const mode of ['changed', 'ended']) {
      const handle = await actual.open(path, 'r')
      const original = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementationOnce((async (...args: Parameters<typeof handle.read>) => {
        if (mode === 'ended') return { bytesRead: 0, buffer: args[0] }
        const result = await Reflect.apply(original, handle, args)
        writeFileSync(path, 'changed and longer')
        return result
      }) as typeof handle.read)
      vi.mocked(fs.open).mockResolvedValueOnce(handle)
      await expect(identityBytes(path, 64)).rejects.toThrow(mode === 'changed' ? 'changed during' : 'ended during')
      expect(handle.fd).toBe(-1)
    }
  })
})

it.each(['Stop', 'checkpointed Stop', 'unknown process', 'unknown descriptors', 'Claude record switch', 'Claude new record'])('%s holds before saving, signalling or retiring when real native identity is incomplete', async action => {
  transcript(OTHER); record('{')
  const row = { agentId: 'fixture-agent', engine: 'claude', sessionId: '', cwd: CWD, registeredAt: 1,
    runtimes: [{ backend: 'tmux', paneId: '%77' }],
    processIdentity: { pid: 77, executable: 'claude', startMarker: new Date(START).toISOString() },
  } as RegisteredSession
  const tmux = await import('./tmux.js')
  vi.mocked(tmux.processRows).mockResolvedValue([{ ...row.processIdentity!, parentPid: 1, args: 'claude' }])
  let reason = 'process record is incomplete'
  if (action === 'Claude record switch' || action === 'Claude new record') {
    transcript()
    if (action === 'Claude record switch') record(validRecord())
    else rmSync(join(root, 'claude', 'sessions', '77.json'))
    let probes = 0
    vi.mocked(tmux.processRows).mockImplementation(async () => {
      // Same pid, generation, executable and argv. Only the native conversation switches
      // during the final asynchronous process probe, after the first selected record proof.
      if (++probes === 2) { await Promise.resolve(); record(validRecord(OTHER)) }
      return [{ ...row.processIdentity!, parentPid: 1, args: 'claude' }]
    })
    reason = action === 'Claude new record' ? 'native path or alias changed' : 'process records changed'
  }
  if (action === 'unknown process') { vi.mocked(tmux.processRows).mockResolvedValue(null); reason = 'process graph is incomplete' }
  if (action === 'unknown descriptors') {
    row.engine = 'codex'
    const { readDescriptorEvidence } = await import('../engines/kit/nativeDescriptors.js')
    const { IdentityReadUnavailable } = await import('../engines/kit/identityScan.js')
    vi.mocked(readDescriptorEvidence).mockRejectedValueOnce(new IdentityReadUnavailable('the descriptor probe is incomplete'))
    reason = 'descriptor probe is incomplete'
  }
  const { AgentRestartCoordinator } = await import('./restartAgent.js')
  const { createStopAgentService } = await import('./stopAgentService.js')
  const { terminateDeletedAgent } = await import('./deleteAgentFallback.js')
  const checkpoint = vi.fn(), save = vi.fn()
  const deps: StopAgentServiceDeps = {
    registry: { resolve: () => row }, stoppedAgents: { save } as unknown as StopAgentServiceDeps['stoppedAgents'],
    restartJobs: new AgentRestartCoordinator(), stopJobs: new Map(), tmuxBackend: { kill: vi.fn() },
    agentReconciler: { suppress: vi.fn(), holdRoute: vi.fn(), releaseRoute: vi.fn(), trigger: vi.fn() },
    forgetSession: vi.fn(), markDeleted: vi.fn(), clearDeleted: vi.fn(), stopNative: vi.fn(),
  }
  await expect(createStopAgentService(deps)(row.agentId, action === 'checkpointed Stop' ? { checkpoint } : {}))
    .rejects.toThrow(reason)
  expect(save).not.toHaveBeenCalled(); expect(checkpoint).not.toHaveBeenCalled()
  expect(deps.stopNative).not.toHaveBeenCalled(); expect(terminateDeletedAgent).not.toHaveBeenCalled()
  expect(deps.tmuxBackend!.kill).not.toHaveBeenCalled(); expect(deps.forgetSession).not.toHaveBeenCalled()
  expect(deps.markDeleted).not.toHaveBeenCalled(); expect(deps.registry.resolve(row.agentId)).toBe(row)
  expect(deps.stopJobs.size).toBe(0)
})


it('retains lossless descriptor identity when numeric stat values round two inodes together', async () => {
  const path = file(join(root, 'large-inode'), 'exact')
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const original = await actual.stat(path)
  const version = { ...original, dev: 5, ino: 9007199254740992, fileKey: { device: 5n, inode: 9007199254740992n } }
  expect(Number(9007199254740993n)).toBe(version.ino)
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args)
    vi.spyOn(handle, 'stat').mockImplementation(async (options?: { bigint?: boolean }) => options?.bigint
      ? { ...original, dev: 5n, ino: 9007199254740993n } as never
      : { ...original, dev: 5, ino: version.ino, isFile: () => true } as never)
    return handle
  })
  await expect(identityBytes(path, 64, version)).rejects.toThrow('not the file held by the process')
})
