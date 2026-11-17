import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from './commands.js'
import { AgentClientError, type Daemon, type Where } from './daemon.js'
import { engineRuns, ensureCommand, type EnsureDeps } from './ensure.js'
import { Ledger, ledgerPath } from './ledger.js'
import { ProgramRecords } from './program.js'
import { signedOutForTest } from '../testing/agentSettings.js'
import type { Frame } from './model.js'

const NOW = Date.parse('2026-11-17T12:00:00Z')
const TOKEN = 't'.repeat(40)
const HASH = createHash('sha256').update(TOKEN).digest('hex')

const frame = (id: string, over: Partial<Frame> = {}): Frame => ({
  id, sessionId: `agent:main:harness-${id}`, name: 'lamp', engine: 'openclaw', status: 'active', activity: { state: 'idle' }, tmuxPane: `%${id}`,
  project: { cwd: `/work/${id}` }, createdAt: '2026-11-17T10:00:00Z', updatedAt: '2026-11-17T11:59:00Z', ...over,
})

class FakeDaemon implements Daemon {
  machineId = 'computer-1'
  requests: Array<{ type: string; payload: Record<string, unknown> }> = []
  frames: Frame[] = []
  extra: Record<string, (payload: Record<string, unknown>) => Record<string, unknown>> = {}
  async request(type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.requests.push({ type, payload })
    if (this.extra[type]) return this.extra[type](payload)
    if (type === 'agents_list') return { agents: this.frames.filter((f) => payload.includeStopped || f.status !== 'stopped') }
    if (type === 'agent_close') return payload.mode === 'inspect' ? { activity: 'idle' } : { closed: true }
    return { error: 'UNKNOWN' }
  }
  close(): void {}
  types(): string[] { return this.requests.map((r) => r.type) }
}

let dir: string
let where: Where
let token: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ensure-'))
  writeFileSync(join(dir, 'machine-name'), 'lamp\n')
  signedOutForTest()
  where = { port: 1, dataDir: dir, machineId: 'computer-1' }
  token = join(dir, 'token')
  writeFileSync(token, `${TOKEN}\n`)
  chmodSync(token, 0o600)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const own = (agentId: string, name = 'lamp', engine = 'openclaw') =>
  new ProgramRecords(dir).put({ agentId, tokenHash: HASH, name, engine, createdAt: NOW - 60_000, startedAt: NOW - 60_000, inputs: [] })

/** [d], and a `harness new` that makes `new<n>` and records it as the program's, as `new --program-token-file` does. */
function harness(d: FakeDaemon, over: Partial<EnsureDeps> = {}) {
  const out: string[] = [], err: string[] = [], made: string[][] = []
  const deps: EnsureDeps = {
    pane: undefined, env: {}, where: () => where, open: async () => d,
    ledger: (data) => new Ledger(ledgerPath(data)), out: (l) => out.push(l), err: (l) => err.push(l), now: () => NOW,
    engineAlive: async () => true, sleep: async () => {},
    create: async (argv) => {
      made.push(argv)
      const id = `new${made.length}`
      const engine = argv[0]
      d.frames.push(frame(id, { engine }))
      own(id, 'lamp', engine)
      return { code: 0, lines: [JSON.stringify({ ok: true, machineId: 'computer-1', agent: { id, name: 'lamp', engine } })] }
    },
    ...over,
  }
  return { deps, out, err, made, json: () => JSON.parse(out.at(-1) ?? '{}') }
}

const args = (extra: string[] = [], engine = 'openclaw') => [engine, '--name', 'lamp', '--program-token-file', token, '--json', ...extra]

describe('engineRuns', () => {
  it('cannot tell without a tmux pane, and believes the row then', async () => {
    expect(await engineRuns(frame('a1', { tmuxPane: null, terminal: { runtimes: [] } }))).toBeNull()
    expect(await engineRuns(frame('a1', { tmuxPane: null, terminal: { runtimes: [{ backend: 'ptyhost', instance: 'p3', paneId: '%1' }] } }))).toBeNull()
    expect(await engineRuns(frame('a1', { tmuxPane: '%1', engine: undefined }))).toBeNull()
  })
})

describe('harness ensure (#4393)', () => {
  it('starts a new one as harness new does, with the token, and says the daemon it started', async () => {
    const d = new FakeDaemon()
    const h = harness(d, { daemonUp: async () => ({ started: true, ms: 912 }) })
    expect(await ensureCommand(args(), h.deps)).toBe(EXIT.ok)
    expect(h.made).toEqual([['openclaw', '--name', 'lamp', '--program-token-file', token, '--json']])
    expect(h.json()).toEqual({ result: 'new', id: 'new1', name: 'lamp', engine: 'openclaw', engineSession: 'agent:main:harness-new1', state: 'starting',
      daemonStarted: true, daemonStartMs: 912 })
  })

  it('names OpenClaw\'s session by its full key before it is bound, and Hermes\'s not before it has one', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1', { sessionId: '' })]
    own('a1')
    const h = harness(d)
    await ensureCommand(args(), h.deps)
    expect(h.json()).toMatchObject({ result: 'live', engineSession: 'agent:main:harness-a1' })
    const hermes = harness(new FakeDaemon())
    await ensureCommand(args([], 'hermes'), hermes.deps)
    expect(hermes.json()).toMatchObject({ result: 'new', engine: 'hermes', engineSession: null })
  })

  it('passes a folder and --local on to harness new', async () => {
    const h = harness(new FakeDaemon())
    await ensureCommand(args(['--local', '/state', '/srv/lamp']), h.deps)
    expect(h.made[0]).toEqual(['openclaw', '/srv/lamp', '--name', 'lamp', '--program-token-file', token, '--local', '/state', '--json'])
  })

  it('answers with the live one its token owns, and starts nothing', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1', { name: 'Light control' })]
    own('a1')
    const h = harness(d)
    expect(await ensureCommand(args(), h.deps)).toBe(EXIT.ok)
    expect(h.json()).toMatchObject({ result: 'live', id: 'a1', name: 'lamp', engineSession: 'agent:main:harness-a1' })
    expect(h.json()).not.toHaveProperty('daemonStarted')
    expect(h.made).toEqual([])
  })

  it('resumes a live row whose engine is gone, its pane killed with it (OpenClaw), rather than answer live', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1', { activity: { state: 'working' } })]
    own('a1')
    d.extra.agent_close = (p) => {
      if (p.mode === 'inspect') return { activity: 'working' }
      d.frames = [frame('a1', { status: 'stopped' })]
      return { closed: true }
    }
    d.extra.agent_resume = (p) => ({ state: 'created', resumed: true, agent: frame(String(p.agentId), { tmuxPane: '%7' }) })
    const checked: Frame[] = []
    const h = harness(d, { engineAlive: async (f) => { checked.push(f); return false } })
    expect(await ensureCommand(args(), h.deps)).toBe(EXIT.ok)
    expect(h.json()).toMatchObject({ result: 'resumed', id: 'a1', engineSession: 'agent:main:harness-a1', state: 'starting' })
    expect(checked.map((f) => f.id)).toEqual(['a1'])
    expect(d.types()).toEqual(expect.arrayContaining(['agent_close', 'agent_resume']))
    expect(d.requests.find((r) => r.type === 'agent_close')?.payload).toMatchObject({ agentId: 'a1', mode: 'now' })
    expect(new ProgramRecords(dir).get('a1')?.startedAt).toBe(NOW)
    expect(h.made).toEqual([])
  })

  it('resumes a live row whose engine was killed in a pane that survives (Claude), even when the close is refused', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('c1', { engine: 'claude', sessionId: 'sess-1' })]
    own('c1', 'lamp', 'claude')
    d.extra.agent_close = (p) => p.mode === 'inspect' ? { activity: 'idle' } : { error: 'IDENTITY_UNAVAILABLE' }
    d.extra.agent_resume = (p) => ({ state: 'created', resumed: true, agent: frame(String(p.agentId), { engine: 'claude', sessionId: 'sess-1' }) })
    const h = harness(d, { engineAlive: async () => false })
    expect(await ensureCommand(args([], 'claude'), h.deps)).toBe(EXIT.ok)
    expect(h.json()).toMatchObject({ result: 'resumed', id: 'c1', engine: 'claude', engineSession: 'sess-1' })
  })

  it('believes the row when the engine cannot be checked, and never checks one still starting', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1')]
    own('a1')
    const unknown = harness(d, { engineAlive: async () => null })
    await ensureCommand(args(), unknown.deps)
    expect(unknown.json()).toMatchObject({ result: 'live', id: 'a1' })
    d.frames = [frame('a1', { launch: { state: 'starting' } } as Partial<Frame>)]
    let asked = 0
    const starting = harness(d, { engineAlive: async () => { asked++; return false } })
    await ensureCommand(args(), starting.deps)
    expect(starting.json()).toMatchObject({ result: 'live', id: 'a1' })
    expect(asked).toBe(0)
    expect(d.types()).not.toContain('agent_resume')
  })

  it('resumes the closed one with its conversation', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('c1', { status: 'stopped', engine: 'hermes', sessionId: '20261117_abc' })]
    own('c1', 'lamp', 'hermes')
    d.extra.agent_resume = (p) => ({ state: 'created', resumed: true, agent: frame(String(p.agentId), { engine: 'hermes', sessionId: '20261117_abc' }) })
    const h = harness(d)
    expect(await ensureCommand(args([], 'hermes'), h.deps)).toBe(EXIT.ok)
    expect(h.json()).toMatchObject({ result: 'resumed', id: 'c1', engine: 'hermes', engineSession: '20261117_abc' })
    expect(new ProgramRecords(dir).get('c1')?.startedAt).toBe(NOW)
    expect(h.made).toEqual([])
  })

  it('says why when its engine could not go on with the conversation', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('c1', { status: 'stopped' })]
    own('c1')
    d.extra.agent_resume = (p) => ({ state: 'created', resumed: false, agent: frame(String(p.agentId)) })
    const h = harness(d)
    await ensureCommand(args(), h.deps)
    expect(h.json()).toMatchObject({ result: 'new', id: 'c1', why: expect.stringContaining('could not resume') })
  })

  it('starts a new one in place of a closed one that cannot be opened again, and forgets the old as the program\'s', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('c1', { status: 'stopped' })]
    own('c1')
    d.extra.agent_resume = () => ({ state: 'failed', failure: { code: 'AGENT_NOT_FOUND', detail: 'deleted' } })
    const h = harness(d)
    await ensureCommand(args(), h.deps)
    expect(h.json()).toMatchObject({ result: 'new', id: 'new1', why: expect.stringContaining('could not be opened again') })
    expect(new ProgramRecords(dir).get('c1')).toBeNull()
  })

  it('says a resume that failed for now, and keeps the harness and its conversation the program\'s', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('c1', { status: 'stopped' })]
    own('c1')
    d.extra.agent_resume = () => ({ state: 'failed', failure: { code: 'SPAWN_FAILED', detail: 'no gateway' } })
    const h = harness(d)
    expect(await ensureCommand(args(), h.deps)).toBe(EXIT.failed)
    expect(h.json()).toMatchObject({ error: 'SPAWN_FAILED', detail: 'no gateway' })
    expect(new ProgramRecords(dir).get('c1')).not.toBeNull()
    expect(h.made).toEqual([])
  })

  it('tries the resume again while the last engine is still stopping (AGENT_BUSY), and resumes the same id', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('c1', { status: 'stopped' })]
    own('c1')
    let busy = 3
    d.extra.agent_resume = (p) => busy-- > 0
      ? { state: 'failed', failure: { code: 'AGENT_BUSY', detail: 'The previous process is still running or could not be checked.' } }
      : { state: 'created', resumed: true, agent: frame(String(p.agentId)) }
    const h = harness(d)
    expect(await ensureCommand(args(), h.deps)).toBe(EXIT.ok)
    expect(h.json()).toMatchObject({ result: 'resumed', id: 'c1' })
    expect(d.requests.filter((r) => r.type === 'agent_resume')).toHaveLength(4)
    expect(h.made).toEqual([])
  })

  it('says ENGINE_NOT_READY, exit 5, when the last engine is still stopping after the wait, and starts nothing', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('c1', { status: 'stopped' })]
    own('c1')
    d.extra.agent_resume = () => ({ state: 'failed', failure: { code: 'AGENT_BUSY' } })
    let clock = NOW
    const h = harness(d, { now: () => clock, sleep: async (ms) => { clock += ms } })
    expect(await ensureCommand(args(), h.deps)).toBe(EXIT.refused)
    expect(h.json()).toMatchObject({ error: 'ENGINE_NOT_READY', detail: expect.stringContaining('still stopping') })
    expect(d.requests.filter((r) => r.type === 'agent_resume').length).toBe(31)
    expect(new ProgramRecords(dir).get('c1')).not.toBeNull()
    expect(h.made).toEqual([])
  })

  it('a crash then an ensure at once: the dead engine is found, waited out, and resumed with the same id', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('k1', { engine: 'claude', sessionId: 'sess-k', activity: { state: 'working' } })]
    own('k1', 'lamp', 'claude')
    d.extra.agent_close = (p) => {
      if (p.mode === 'inspect') return { activity: 'working' }
      d.frames = [frame('k1', { engine: 'claude', sessionId: 'sess-k', status: 'stopped' })]
      return { closed: true }
    }
    let busy = 2
    d.extra.agent_resume = (p) => busy-- > 0 ? { state: 'failed', failure: { code: 'AGENT_BUSY' } }
      : { state: 'created', resumed: true, agent: frame(String(p.agentId), { engine: 'claude', sessionId: 'sess-k' }) }
    const h = harness(d, { engineAlive: async () => false })
    expect(await ensureCommand(args([], 'claude'), h.deps)).toBe(EXIT.ok)
    expect(h.json()).toMatchObject({ result: 'resumed', id: 'k1', engineSession: 'sess-k' })
    expect(h.made).toEqual([])
    expect(new ProgramRecords(dir).get('k1')).not.toBeNull()
  })

  it('--fresh closes the live one and starts a new conversation', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1')]
    own('a1')
    const h = harness(d)
    await ensureCommand(args(['--fresh']), h.deps)
    expect(d.requests.find((r) => r.type === 'agent_close' && r.payload.mode === 'now')?.payload).toMatchObject({ agentId: 'a1' })
    expect(h.json()).toMatchObject({ result: 'new', id: 'new1' })
    expect(new ProgramRecords(dir).get('a1')).toBeNull()
  })

  it('refuses a name held by a harness without the token, with exit 5', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('p1')]
    const h = harness(d)
    expect(await ensureCommand(args(), h.deps)).toBe(EXIT.refused)
    expect(h.json()).toMatchObject({ error: 'NAME_TAKEN' })
    expect(h.made).toEqual([])
  })

  it('refuses its own live harness on another engine', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('h1', { engine: 'hermes' })]
    own('h1', 'lamp', 'hermes')
    const h = harness(d)
    expect(await ensureCommand(args(), h.deps)).toBe(EXIT.refused)
    expect(h.json()).toMatchObject({ error: 'NAME_TAKEN' })
  })

  it('refuses an agent, token or not', async () => {
    const h = harness(new FakeDaemon(), { env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's1' } })
    expect(await ensureCommand(args(), h.deps)).toBe(EXIT.refused)
    expect(h.json()).toMatchObject({ error: 'NOT_YOURS' })
  })

  it('says why harness new did not start it', async () => {
    const h = harness(new FakeDaemon(), { create: async () => ({ code: 1, lines: [JSON.stringify({ ok: false, error: 'OpenClaw Gateway is not running.' })] }) })
    expect(await ensureCommand(args(), h.deps)).toBe(EXIT.failed)
    expect(h.json()).toMatchObject({ error: 'FAILED', detail: 'OpenClaw Gateway is not running.' })
  })

  it('says when the daemon could not be started', async () => {
    const h = harness(new FakeDaemon(), { daemonUp: async () => { throw new AgentClientError('DAEMON_NOT_STARTED', 'Harness is not running here, and it did not start within 30s.', 'TIMEOUT') } })
    expect(await ensureCommand(args(), h.deps)).toBe(EXIT.failed)
    expect(h.json()).toMatchObject({ error: 'DAEMON_NOT_STARTED' })
  })

  it('takes its words strictly', async () => {
    const usage = async (argv: string[]) => {
      const h = harness(new FakeDaemon())
      return { code: await ensureCommand(argv, h.deps), err: h.err.join('\n') }
    }
    expect(await usage(['--name', 'lamp', '--program-token-file', token])).toMatchObject({ code: EXIT.usage })
    expect(await usage(['openclaw', '--program-token-file', token])).toMatchObject({ code: EXIT.usage, err: expect.stringContaining('--name') })
    expect(await usage(['openclaw', '--name', 'lamp'])).toMatchObject({ code: EXIT.usage, err: expect.stringContaining('--program-token-file') })
    expect(await usage(['openclaw', '--name', 'lamp', '--program-token-file', token, '--machine', 'office'])).toMatchObject({ code: EXIT.usage })
  })

  it('gives two ensures at once one harness', async () => {
    const d = new FakeDaemon()
    const slow = (h: { made: string[][] }) => async (argv: string[]) => {
      await new Promise((done) => setTimeout(done, 30))
      h.made.push(argv)
      d.frames.push(frame('only'))
      own('only')
      return { code: 0, lines: [JSON.stringify({ ok: true, agent: { id: 'only', name: 'lamp', engine: 'openclaw' } })] }
    }
    const a = harness(d), b = harness(d)
    a.deps.create = slow(a)
    b.deps.create = slow(b)
    expect(await Promise.all([ensureCommand(args(), a.deps), ensureCommand(args(), b.deps)])).toEqual([0, 0])
    expect([a.json().result, b.json().result].sort()).toEqual(['live', 'new'])
    expect(a.made.length + b.made.length).toBe(1)
    expect(readdirSync(dir).filter((f) => f.endsWith('.lock'))).toEqual([])
  })
})
