// Cross-unit seams of the A2/A3 fork handoff, with the real modules on each side rather than fakes:
//  - the fork record as cli.ts builds it at `agent_fork` → registry.openPendingAgent (normalizer) → the stopped
//    copy (StoppedAgentStore save/get, through strictPersistedRow) → lib/agentHandoff.ts inheritance;
//  - lib/agentHandoff.ts's transcript gate and lookup wired to the real registry.validTranscriptPath and
//    sessionRepair.findResumedTranscript, as cli.ts wires them (`backend.handoffRequestProvider`);
//  - lib/handoffDiscovery.ts (through cli.ts's `handoffProviderDeps`) over the real sessionRepair searches: Claude only
//    by its per-process record, never a folder scan; ownership checked against the real stopped store, failing closed.
// The unit specs pin each side with fakes; this one pins that the pieces agree.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RegisteredSession } from './lib/registry.js'

const CHANGE = '0123456789abcdef0123456789abcdef'
const OTHER_CHANGE = 'fedcba9876543210fedcba9876543210'
const PARENT_SESSION = '11111111-2222-4333-8444-555555555555'
const FOUND_SESSION = '99999999-8888-4777-8666-555555555555'

let root: string
let ws: string
let projects: string
let data: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'handoff-fork-int-')))
  ws = join(root, 'ws')
  projects = join(root, 'claude', 'projects')
  data = join(root, 'data')
  for (const dir of [ws, projects, data, join(root, 'codex')]) mkdirSync(dir, { recursive: true })
  for (const key of ['ADAPTER_DATA_DIR', 'CLAUDE_PROJECTS_DIR', 'CODEX_HOME']) saved[key] = process.env[key]
  process.env.ADAPTER_DATA_DIR = data
  process.env.CLAUDE_PROJECTS_DIR = projects
  process.env.CODEX_HOME = join(root, 'codex')
  vi.resetModules()
})
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

async function modules() {
  const registryModule = await import('./lib/registry.js')
  const repair = await import('./lib/sessionRepair.js')
  const discovery = await import('./lib/handoffDiscovery.js')
  const handoff = await import('./lib/agentHandoff.js')
  const stopped = await import('./lib/stoppedAgents.js')
  registryModule.registry.load()
  return { ...registryModule, ...repair, ...discovery, ...handoff, ...stopped }
}

type Mods = Awaited<ReturnType<typeof modules>>

const iso = (ms: number): string => new Date(ms).toISOString()

/** A Claude main transcript: each [ask, answer, at] becomes a user record and an assistant record. */
function claudeFile(path: string, turns: Array<[string, string, number]>, extra: Record<string, unknown> = {}): string {
  mkdirSync(join(path, '..'), { recursive: true })
  const lines: string[] = []
  turns.forEach(([ask, answer, at], i) => {
    lines.push(JSON.stringify({ type: 'user', uuid: `u${i}`, isSidechain: false, cwd: ws, timestamp: iso(at), ...extra, message: { role: 'user', content: ask } }))
    lines.push(JSON.stringify({ type: 'assistant', uuid: `a${i}`, isSidechain: false, cwd: ws, timestamp: iso(at + 1_000), ...extra, message: { role: 'assistant', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' } }))
  })
  writeFileSync(path, lines.join('\n') + '\n')
  return path
}

/** The `forkedFrom` expression of cli.ts's `agent_fork` handler, applied to `source`. */
function forkOriginAsCliBuildsIt(source: RegisteredSession, sourceName: string) {
  return {
    agentId: source.agentId, name: sourceName,
    ...(source.sessionId ? { sessionId: source.sessionId, ...(source.transcriptPath ? { transcriptPath: source.transcriptPath } : {}) } : {}),
  }
}

/**
 * The provider deps through cli.ts's own factory (`handoffProviderDeps`), with the real registry, stopped store,
 * transcript lookup, gate and session searches; only the mirror is faked, loudly, so any use of it shows.
 */
function cliDeps(m: Mods, rows: RegisteredSession[], over: { findLiveSession?: Mods['findLiveSession']; claudeProcessSession?: Mods['claudeProcessSession'] } = {}) {
  const stoppedDir = join(data, 'stopped-agents')
  const store = new m.StoppedAgentStore(stoppedDir)
  return m.handoffProviderDeps({
    registry: {
      resolve: (id) => rows.find((s) => s.agentId === id) ?? null,
      byAgent: (id) => rows.find((s) => s.agentId === id),
      bySession: (sid) => rows.find((s) => s.sessionId === sid),
    },
    stopped: {
      get: (id) => store.get(id),
      ids: () => {
        try { return readdirSync(stoppedDir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
      },
    },
    mirror: {
      recentAsks: () => ['MIRROR-ASK'],
      lastFullText: () => 'MIRROR-ANSWER',
      recent: () => [{ kind: 'summary', recap: 'MIRROR-RECAP', text: 'MIRROR-RECAP' }],
    } as unknown as Parameters<Mods['handoffProviderDeps']>[0]['mirror'],
    databaseHistory: () => undefined,
    findLiveSession: over.findLiveSession ?? m.findLiveSession,
    claudeProcessSession: over.claudeProcessSession ?? m.claudeProcessSession,
    isRecentlyDeleted: () => false,
    findResumedTranscript: m.findResumedTranscript,
    validTranscriptPath: m.validTranscriptPath,
  })
}

const handoffMd = (agentId: string): string => readFileSync(join(ws, '.harness', 'handoff', `${agentId}-${CHANGE}.md`), 'utf8')

describe('fork record → registry → stopped copy → inheritance (real modules)', () => {
  /** A bound Claude parent with one ask before the fork and one far after it, and its fork as the daemon opens it. */
  async function forkOfParent(m: Mods, parentFilePath = join(projects, '-ws', `${PARENT_SESSION}.jsonl`)) {
    const t0 = Date.now()
    const parentFile = claudeFile(parentFilePath, [['PRE-FORK ask: add a retry', 'Retry added.', t0 - 120_000], ['POST-FORK ask', 'Later work.', t0 + 600_000]])
    const parent = {
      agentId: 'parent-1', sessionId: PARENT_SESSION, engine: 'claude', cwd: ws, transcriptPath: parentFile,
      // Rebound after the fork: only a RECORDED session may still be inherited.
      registeredAt: t0 - 3_600_000, boundAt: t0 + 60_000, projectDir: 'ws',
    } as unknown as RegisteredSession
    const fork = m.registry.openPendingAgent({
      engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%7' }], cwd: ws,
      forkedFrom: forkOriginAsCliBuildsIt(parent, 'harness Devops'),
    })!
    return { parent, parentFile, fork }
  }

  it('a live fork, the same fork after a daemon restart, and its stopped copy inherit exactly the recorded session up to the fork', async () => {
    const m = await modules()
    const { parent, parentFile, fork } = await forkOfParent(m)
    expect(fork.forkedFrom).toEqual({ agentId: 'parent-1', name: 'harness Devops', sessionId: PARENT_SESSION, transcriptPath: parentFile })

    // A daemon restart: a fresh registry module loads the row from disk (the 03-verify-r1 major: load() lost forkedFrom).
    vi.resetModules()
    const reloaded = await import('./lib/registry.js')
    reloaded.registry.load()
    const restartedFork = reloaded.registry.byAgent(fork.agentId)!
    expect(restartedFork.forkedFrom).toEqual(fork.forkedFrom)

    // The stopped copy, as Change agent on a stopped fork resolves it (cli.ts: registry.resolve ?? stoppedAgents.get).
    const store = new m.StoppedAgentStore(join(data, 'stopped-agents'))
    store.save({ ...fork, active: false })
    const stoppedFork = new m.StoppedAgentStore(join(data, 'stopped-agents')).get(fork.agentId)!
    expect(stoppedFork.forkedFrom).toEqual(fork.forkedFrom)

    for (const [label, row] of [['live', fork], ['restarted', restartedFork], ['stopped', stoppedFork]] as const) {
      rmSync(join(ws, '.harness'), { recursive: true, force: true })
      const findLiveSession = vi.fn(m.findLiveSession)
      const claudeProcessSession = vi.fn(m.claudeProcessSession)
      const result = await m.prepareAgentHandoff(cliDeps(m, [parent, row], { findLiveSession, claudeProcessSession }), { agentId: row.agentId, changeId: CHANGE, targetEngine: 'codex' })
      expect(result, label).toEqual({ file: `.harness/handoff/${row.agentId}-${CHANGE}.md`, gitRepo: false, cwd: ws, degraded: ['git'] })
      const md = handoffMd(row.agentId)
      expect(md, label).toContain('PRE-FORK ask: add a retry')
      expect(md, label).toContain('History: inherited from `harness Devops` (agent `parent-1`)')
      expect(md, label).not.toContain('POST-FORK ask')
      expect(md, label).not.toMatch(/MIRROR-(ASK|ANSWER|RECAP)/)
      expect(md, label).not.toContain(parentFile)
      expect(findLiveSession, label).not.toHaveBeenCalled()
      expect(claudeProcessSession, label).not.toHaveBeenCalled()
    }
  })

  it('a recorded transcript that moved is found again by session id through the real lookup', async () => {
    const m = await modules()
    const { parent, parentFile, fork } = await forkOfParent(m)
    const movedTo = join(projects, '-ws-moved', `${PARENT_SESSION}.jsonl`)
    mkdirSync(join(movedTo, '..'), { recursive: true })
    renameSync(parentFile, movedTo)
    // The parent now runs another session: its current file must not stand in for the recorded one.
    const current = claudeFile(join(projects, '-ws', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl'), [['NEW SESSION ask', 'New.', Date.now() - 1_000]])
    const moved = { ...parent, sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', transcriptPath: current } as RegisteredSession
    const result = await m.prepareAgentHandoff(cliDeps(m, [moved, fork]), { agentId: fork.agentId, changeId: CHANGE, targetEngine: 'codex' })
    expect(result.file).toBe(`.harness/handoff/${fork.agentId}-${CHANGE}.md`)
    const md = handoffMd(fork.agentId)
    expect(md).toContain('PRE-FORK ask: add a retry')
    expect(md).not.toContain('NEW SESSION ask')
    expect(md).not.toContain('POST-FORK ask')
  })

  it('a recorded transcript outside the engine root fails the real gate: nothing is inherited', async () => {
    const m = await modules()
    // A path the registry normalizer accepts (absolute) but validTranscriptPath does not vouch for.
    const { parent, fork } = await forkOfParent(m, join(root, 'elsewhere', `${PARENT_SESSION}.jsonl`))
    const result = await m.prepareAgentHandoff(cliDeps(m, [parent, fork]), { agentId: fork.agentId, changeId: CHANGE, targetEngine: 'codex' })
    expect(result).toEqual({ file: null, gitRepo: false, cwd: ws, degraded: ['transcript'] })
    expect(existsSync(join(ws, '.harness'))).toBe(false)
  })
})

describe('discovery through the real Claude process record (handoffDiscovery ↔ sessionRepair ↔ agentHandoff)', () => {
  const PID = 4242
  // Second precision, as Claude's procStart and the daemon's start marker carry it.
  const startMarker = (): string => new Date(Math.floor((Date.now() - 2_000) / 1000) * 1000).toISOString()
  /** An unbound, live, non-fork Claude agent with a process identity, as the registry keeps a pane it launched. */
  function unbound(marker: string | null, pid: number | null = PID): RegisteredSession {
    return {
      agentId: 'agent-new', sessionId: '', engine: 'claude', cwd: ws, transcriptPath: null,
      registeredAt: Date.parse(marker ?? new Date().toISOString()), boundAt: null, projectDir: 'ws',
      ...(marker || pid ? { processIdentity: { pid, executable: '/usr/bin/claude', startMarker: marker } } : {}),
    } as unknown as RegisteredSession
  }
  /** Claude's per-process record (`<projects>/../sessions/<pid>.json`). */
  function processRecord(sessionId: string, procStart: string, cwd = ws): void {
    mkdirSync(join(projects, '..', 'sessions'), { recursive: true })
    writeFileSync(join(projects, '..', 'sessions', `${PID}.json`), JSON.stringify({ pid: PID, procStart, cwd, sessionId }))
  }
  const ownFile = (at: number): string => claudeFile(join(projects, '-ws', `${FOUND_SESSION}.jsonl`), [['OWN ask: fix the login bug', 'Fixed.', at]])
  const ask = (m: Mods, deps: ReturnType<typeof cliDeps>, change = CHANGE) =>
    m.prepareAgentHandoff(deps, { agentId: 'agent-new', changeId: change, targetEngine: 'codex' })

  it('hands over the session the process record names, read through the real lookup and gate', async () => {
    const m = await modules()
    const marker = startMarker()
    const own = ownFile(Date.parse(marker) + 500)
    processRecord(FOUND_SESSION, marker)
    const findLiveSession = vi.fn(m.findLiveSession)
    const result = await ask(m, cliDeps(m, [unbound(marker)], { findLiveSession }))
    expect(result).toEqual({ file: `.harness/handoff/agent-new-${CHANGE}.md`, gitRepo: false, cwd: ws, degraded: ['git'] })
    const md = handoffMd('agent-new')
    expect(md).toContain('OWN ask: fix the login bug')
    expect(md).toContain(`- Session: \`${FOUND_SESSION}\``)
    expect(md).not.toMatch(/MIRROR-(ASK|ANSWER|RECAP)/)
    expect(md).not.toContain(own)
    expect(findLiveSession).not.toHaveBeenCalled()
  })

  it('never scans the project folder for Claude: no process record, nothing, even beside a born session', async () => {
    const m = await modules()
    const marker = startMarker()
    ownFile(Date.parse(marker) + 500)
    const findLiveSession = vi.fn(m.findLiveSession)
    const claudeProcessSession = vi.fn(m.claudeProcessSession)
    const result = await ask(m, cliDeps(m, [unbound(marker)], { findLiveSession, claudeProcessSession }))
    expect(claudeProcessSession).toHaveBeenCalledTimes(1)
    expect(findLiveSession).not.toHaveBeenCalled()
    expect(result).toEqual({ file: null, gitRepo: false, cwd: ws, degraded: ['transcript'] })
    expect(existsSync(join(ws, '.harness'))).toBe(false)
  })

  it('looks nowhere without both a start marker and a pid', async () => {
    const m = await modules()
    const marker = startMarker()
    ownFile(Date.parse(marker) + 500)
    processRecord(FOUND_SESSION, marker)
    for (const [label, row] of [['no marker', unbound(null)], ['no pid', unbound(marker, null)], ['no identity', unbound(null, null)]] as const) {
      const findLiveSession = vi.fn(m.findLiveSession)
      const claudeProcessSession = vi.fn(m.claudeProcessSession)
      expect(await ask(m, cliDeps(m, [row], { findLiveSession, claudeProcessSession })), label).toEqual({ file: null, gitRepo: false, cwd: ws, degraded: ['transcript'] })
      expect(claudeProcessSession, label).not.toHaveBeenCalled()
      expect(findLiveSession, label).not.toHaveBeenCalled()
    }
  })

  it('refuses a record from another process start or another folder', async () => {
    const m = await modules()
    const marker = startMarker()
    ownFile(Date.parse(marker) + 500)
    for (const [label, procStart, cwd] of [['older start', new Date(Date.parse(marker) - 60_000).toISOString(), ws], ['other folder', marker, root]] as const) {
      processRecord(FOUND_SESSION, procStart, cwd)
      expect(await ask(m, cliDeps(m, [unbound(marker)])), label).toMatchObject({ file: null, degraded: ['transcript'] })
    }
  })

  it('never hands over a session a stopped agent holds, read from the real stopped store', async () => {
    const m = await modules()
    const marker = startMarker()
    ownFile(Date.parse(marker) + 500)
    processRecord(FOUND_SESSION, marker)
    const holder = m.registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%9' }], cwd: ws })!
    new m.StoppedAgentStore(join(data, 'stopped-agents')).save({ ...holder, sessionId: FOUND_SESSION, active: false })
    expect(await ask(m, cliDeps(m, [unbound(marker)]))).toMatchObject({ file: null, degraded: ['transcript'] })
  })

  it('fails closed on one unreadable stopped record, whoever it belonged to', async () => {
    const m = await modules()
    const marker = startMarker()
    ownFile(Date.parse(marker) + 500)
    processRecord(FOUND_SESSION, marker)
    const other = m.registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%10' }], cwd: ws })!
    const store = new m.StoppedAgentStore(join(data, 'stopped-agents'))
    store.save({ ...other, sessionId: 'unrelated-session', active: false })
    // Readable and not the holder: discovery goes ahead.
    expect((await ask(m, cliDeps(m, [unbound(marker)]))).file).toBe(`.harness/handoff/agent-new-${CHANGE}.md`)
    // One more record that cannot be read (the store's list() would skip it silently): nothing is handed over.
    rmSync(join(ws, '.harness'), { recursive: true, force: true })
    writeFileSync(join(data, 'stopped-agents', 'broken-1.json'), '{not json', { mode: 0o600 })
    expect(await ask(m, cliDeps(m, [unbound(marker)]), OTHER_CHANGE)).toMatchObject({ file: null, degraded: ['transcript'] })
  })

  it('a fork in the same folder never searches, even with a matching process record', async () => {
    const m = await modules()
    const marker = startMarker()
    ownFile(Date.parse(marker) + 500)
    processRecord(FOUND_SESSION, marker)
    const fork = { ...unbound(marker), forkedFrom: { agentId: 'gone-parent', name: 'Gone' } } as RegisteredSession
    const findLiveSession = vi.fn(m.findLiveSession)
    const claudeProcessSession = vi.fn(m.claudeProcessSession)
    const result = await ask(m, cliDeps(m, [fork], { findLiveSession, claudeProcessSession }))
    expect(findLiveSession).not.toHaveBeenCalled()
    expect(claudeProcessSession).not.toHaveBeenCalled()
    expect(result).toEqual({ file: null, gitRepo: false, cwd: ws, degraded: ['transcript'] })
  })
})
