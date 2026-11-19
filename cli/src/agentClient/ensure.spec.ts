import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from './commands.js'
import { AgentClientError, type Daemon, type Where } from './daemon.js'
import { engineRuns, ensureCommand, gatewayHolds, SETTLE_MS, type EnsureDeps } from './ensure.js'
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
    if (this.extra[type]) return this.resumed(type, this.extra[type](payload))
    if (type === 'agents_list') return { agents: this.frames.filter((f) => payload.includeStopped || f.status !== 'stopped') }
    if (type === 'agent_close') return payload.mode === 'inspect' ? { activity: 'idle' } : { closed: true }
    return { error: 'UNKNOWN' }
  }
  /** As the daemon does: a harness opened again is listed active. */
  private resumed(type: string, reply: Record<string, unknown>): Record<string, unknown> {
    const agent = reply.agent as Frame | undefined
    if (type === 'agent_resume' && reply.state === 'created' && agent) {
      this.frames = [...this.frames.filter((f) => f.id !== agent.id), { ...agent, status: 'active' }]
    }
    return reply
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
    engineAlive: async () => true, sessionHeld: async () => null, sleep: async () => {},
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

/** [first] for the first ask, [then] after it: an engine found dead before the resume and running after. */
const firstThen = <T>(first: T, then: T) => { let n = 0; return async () => n++ === 0 ? first : then }

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
    expect(h.json()).toEqual({ result: 'new', id: 'new1', name: 'lamp', engine: 'openclaw', engineSession: 'agent:main:harness-new1', state: 'idle',
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
    const h = harness(d, { engineAlive: async (f) => { checked.push(f); return f.tmuxPane === '%7' ? true : 'pane-gone' } })
    expect(await ensureCommand(args(), h.deps)).toBe(EXIT.ok)
    expect(h.json()).toMatchObject({ result: 'resumed', id: 'a1', engineSession: 'agent:main:harness-a1', state: 'starting', confirmed: true })
    expect(checked.map((f) => f.tmuxPane)).toEqual(['%a1', '%7'])
    expect(d.types()).toEqual(expect.arrayContaining(['agent_close', 'agent_resume']))
    expect(d.requests.find((r) => r.type === 'agent_close')?.payload).toMatchObject({ agentId: 'a1', mode: 'now' })
    expect(new ProgramRecords(dir).get('a1')?.startedAt).toBe(NOW)
    expect(h.made).toEqual([])
  })

  it('resumes an idle row whose engine was killed in a pane that survives (Claude)', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('c1', { engine: 'claude', sessionId: 'sess-1' })]
    own('c1', 'lamp', 'claude')
    d.extra.agent_close = (p) => {
      if (p.mode === 'inspect') return { activity: 'idle' }
      d.frames = [frame('c1', { engine: 'claude', sessionId: 'sess-1', status: 'stopped' })]
      return { closed: true }
    }
    d.extra.agent_resume = (p) => ({ state: 'created', resumed: true, agent: frame(String(p.agentId), { engine: 'claude', sessionId: 'sess-1' }) })
    const h = harness(d, { engineAlive: firstThen<boolean>(false, true) })
    expect(await ensureCommand(args([], 'claude'), h.deps)).toBe(EXIT.ok)
    expect(h.json()).toMatchObject({ result: 'resumed', id: 'c1', engine: 'claude', engineSession: 'sess-1', confirmed: true })
  })

  it('never closes a working row for an engine it cannot see in a pane still there (another namespace, hidepid)', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('c1', { engine: 'claude', sessionId: 'sess-1', activity: { state: 'working' } })]
    own('c1', 'lamp', 'claude')
    const h = harness(d, { engineAlive: async () => false })
    expect(await ensureCommand(args([], 'claude'), h.deps)).toBe(EXIT.ok)
    expect(h.json()).toMatchObject({ result: 'live', id: 'c1' })
    expect(d.requests.filter((r) => r.type === 'agent_close' && r.payload.mode === 'now')).toEqual([])
    expect(d.types()).not.toContain('agent_resume')
  })

  it('says ENGINE_NOT_READY, exit 5, and starts nothing when the dead row cannot be closed', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('c1', { engine: 'claude', sessionId: 'sess-1' })]
    own('c1', 'lamp', 'claude')
    d.extra.agent_close = (p) => p.mode === 'inspect' ? { activity: 'idle' } : { error: 'IDENTITY_UNAVAILABLE' }
    const h = harness(d, { engineAlive: async () => 'pane-gone' })
    expect(await ensureCommand(args([], 'claude'), h.deps)).toBe(EXIT.refused)
    expect(h.json()).toMatchObject({ error: 'ENGINE_NOT_READY', detail: expect.stringContaining('IDENTITY_UNAVAILABLE') })
    expect(d.types()).not.toContain('agent_resume')
    expect(h.made).toEqual([])
    expect(new ProgramRecords(dir).get('c1')).not.toBeNull()
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
    expect(h.json()).toMatchObject({ result: 'resumed', id: 'c1', engine: 'hermes', engineSession: '20261117_abc', state: 'idle', confirmed: true })
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
    expect(h.json()).toMatchObject({ result: 'new', id: 'c1', why: expect.stringContaining('could not resume'), whyCode: 'ENGINE_SESSION_GONE' })
  })

  it('starts a new one in place of a closed one that cannot be opened again, and forgets the old as the program\'s', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('c1', { status: 'stopped' })]
    own('c1')
    d.extra.agent_resume = () => ({ state: 'failed', failure: { code: 'AGENT_NOT_FOUND', detail: 'deleted' } })
    const h = harness(d)
    await ensureCommand(args(), h.deps)
    expect(h.json()).toMatchObject({ result: 'new', id: 'new1', why: expect.stringContaining('could not be opened again'), whyCode: 'HARNESS_GONE' })
    expect(new ProgramRecords(dir).get('c1')).toBeNull()
  })

  it('keeps a record whose harness one list left out, and resumes it rather than start another', async () => {
    const d = new FakeDaemon()
    own('c1')
    d.extra.agent_resume = (p) => ({ state: 'created', resumed: true, agent: frame(String(p.agentId)) })
    const h = harness(d)
    expect(await ensureCommand(args(), h.deps)).toBe(EXIT.ok)
    expect(h.json()).toMatchObject({ result: 'resumed', id: 'c1' })
    expect(d.requests.find((r) => r.type === 'agent_resume')?.payload).toMatchObject({ agentId: 'c1' })
    expect(new ProgramRecords(dir).get('c1')).not.toBeNull()
    expect(h.made).toEqual([])
  })

  it('forgets a record the daemon no longer knows only on its AGENT_NOT_FOUND', async () => {
    const d = new FakeDaemon()
    own('c1')
    d.extra.agent_resume = () => ({ state: 'failed', failure: { code: 'AGENT_NOT_FOUND' } })
    const h = harness(d)
    expect(await ensureCommand(args(), h.deps)).toBe(EXIT.ok)
    expect(h.json()).toMatchObject({ result: 'new', id: 'new1', whyCode: 'HARNESS_GONE' })
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
    const h = harness(d, { engineAlive: firstThen<'pane-gone' | true>('pane-gone', true) })
    expect(await ensureCommand(args([], 'claude'), h.deps)).toBe(EXIT.ok)
    expect(h.json()).toMatchObject({ result: 'resumed', id: 'k1', engineSession: 'sess-k', confirmed: true })
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

  it('refuses an agent, token or not, before it starts the daemon for one', async () => {
    let up = 0
    const h = harness(new FakeDaemon(), { env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's1' }, daemonUp: async () => { up++; return { started: true, ms: 1 } } })
    expect(await ensureCommand(args(), h.deps)).toBe(EXIT.refused)
    expect(h.json()).toMatchObject({ error: 'NOT_YOURS' })
    expect(up).toBe(0)
  })

  it('reads the token before it starts the daemon', async () => {
    let up = 0
    const h = harness(new FakeDaemon(), { daemonUp: async () => { up++; return { started: true, ms: 1 } } })
    expect(await ensureCommand(['openclaw', '--name', 'lamp', '--program-token-file', join(dir, 'missing'), '--json'], h.deps)).not.toBe(EXIT.ok)
    expect(up).toBe(0)
  })

  it('keeps the harness it just made the program\'s when harness new could not record it', async () => {
    const d = new FakeDaemon()
    const h = harness(d, { create: async () => {
      d.frames.push(frame('new1'))
      return { code: 0, lines: [JSON.stringify({ ok: true, machineId: 'computer-1', agent: { id: 'new1', name: 'lamp', engine: 'openclaw' } })] }
    } })
    expect(await ensureCommand(args(), h.deps)).toBe(EXIT.ok)
    expect(h.json()).toMatchObject({ result: 'new', id: 'new1' })
    expect(new ProgramRecords(dir).get('new1')).toMatchObject({ tokenHash: HASH, name: 'lamp' })
    const again = harness(d)
    await ensureCommand(args(), again.deps)
    expect(again.json()).toMatchObject({ result: 'live', id: 'new1' })
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

describe('harness ensure, a conversation its engine no longer holds (#4484)', () => {
  /** c1 closed, its OpenClaw conversation `agent:main:harness-c1`, and a resume the daemon opens. */
  function closed() {
    const d = new FakeDaemon()
    d.frames = [frame('c1', { status: 'stopped' })]
    own('c1')
    d.extra.agent_resume = (p) => ({ state: 'created', resumed: true, agent: frame(String(p.agentId)) })
    return d
  }
  const resumes = (d: FakeDaemon) => d.requests.filter((r) => r.type === 'agent_resume')

  it('never resumes a key the Gateway no longer holds: a new harness by the same name and token', async () => {
    const d = closed()
    const asked: string[] = []
    const h = harness(d, { sessionHeld: async (key) => { asked.push(key); return false } })
    expect(await ensureCommand(args(), h.deps)).toBe(EXIT.ok)
    expect(asked).toEqual(['agent:main:harness-c1'])
    expect(resumes(d)).toEqual([])
    expect(h.made).toEqual([['openclaw', '--name', 'lamp', '--program-token-file', token, '--json']])
    expect(h.json()).toMatchObject({ result: 'new', id: 'new1', name: 'lamp', whyCode: 'ENGINE_SESSION_GONE', why: expect.stringContaining('agent:main:harness-c1') })
    expect(h.json()).not.toHaveProperty('confirmed')
    expect(new ProgramRecords(dir).get('c1')).toBeNull()
    expect(new ProgramRecords(dir).get('new1')).toMatchObject({ tokenHash: HASH, name: 'lamp' })
  })

  it('resumes when the Gateway holds the key, or cannot be asked', async () => {
    for (const held of [true, null]) {
      const d = closed()
      const h = harness(d, { sessionHeld: async () => held })
      expect(await ensureCommand(args(), h.deps)).toBe(EXIT.ok)
      expect(h.json()).toMatchObject({ result: 'resumed', id: 'c1', state: 'idle', confirmed: true })
      expect(h.json()).not.toHaveProperty('whyCode')
      expect(resumes(d)).toHaveLength(1)
      expect(h.made).toEqual([])
    }
  })

  it('asks no Gateway for --local, nor for another engine', async () => {
    let asked = 0
    const d = closed()
    const local = harness(d, { sessionHeld: async () => { asked++; return false } })
    await ensureCommand(args(['--local', '/state']), local.deps)
    expect(local.json()).toMatchObject({ result: 'resumed', id: 'c1' })
    const hd = new FakeDaemon()
    hd.frames = [frame('h1', { status: 'stopped', engine: 'hermes', sessionId: '20261117_abc' })]
    own('h1', 'lamp', 'hermes')
    hd.extra.agent_resume = (p) => ({ state: 'created', resumed: true, agent: frame(String(p.agentId), { engine: 'hermes', sessionId: '20261117_abc' }) })
    const hermes = harness(hd, { sessionHeld: async () => { asked++; return false } })
    await ensureCommand(args([], 'hermes'), hermes.deps)
    expect(hermes.json()).toMatchObject({ result: 'resumed', id: 'h1' })
    expect(asked).toBe(0)
  })

  it('starts a new one when the engine exits right after the resume and the Gateway then says the key is gone', async () => {
    const d = closed()
    const h = harness(d, { sessionHeld: firstThen<boolean | null>(null, false), engineAlive: async () => 'pane-gone' })
    expect(await ensureCommand(args(), h.deps)).toBe(EXIT.ok)
    expect(resumes(d)).toHaveLength(1)
    expect(d.requests.find((r) => r.type === 'agent_close' && r.payload.mode === 'now')?.payload).toMatchObject({ agentId: 'c1' })
    expect(h.json()).toMatchObject({ result: 'new', id: 'new1', name: 'lamp', whyCode: 'ENGINE_SESSION_GONE' })
    expect(new ProgramRecords(dir).get('c1')).toBeNull()
  })

  it('says an engine that exits right after the resume stopped, and keeps the record, while the key is held or unknown', async () => {
    for (const held of [true, null]) {
      const byEngine = closed()
      const a = harness(byEngine, { sessionHeld: async () => held, engineAlive: async () => false })
      expect(await ensureCommand(args(), a.deps)).toBe(EXIT.ok)
      expect(a.json()).toMatchObject({ result: 'resumed', id: 'c1', state: 'stopped', confirmed: false, whyCode: 'ENGINE_EXITED' })
      expect(a.made).toEqual([])
      expect(new ProgramRecords(dir).get('c1')).not.toBeNull()
      // The row closed again by discovery while it is watched.
      const byRow = closed()
      byRow.extra.agents_list = () => ({ agents: [frame('c1', { status: 'stopped' })] })
      const b = harness(byRow, { sessionHeld: async () => held })
      expect(await ensureCommand(args(), b.deps)).toBe(EXIT.ok)
      expect(b.json()).toMatchObject({ result: 'resumed', id: 'c1', state: 'stopped', confirmed: false, whyCode: 'ENGINE_EXITED' })
      expect(b.made).toEqual([])
    }
  })

  it('watches a resumed one only until it is seen up, and never past SETTLE_MS', async () => {
    let clock = NOW
    const sleep = async (ms: number) => { clock += ms }
    const d = closed()
    let reads = 0
    d.extra.agent_close = (p) => p.mode === 'inspect' ? (++reads >= 4 ? { activity: 'idle' } : {}) : { closed: true }
    const soon = harness(d, { now: () => clock, sleep })
    await ensureCommand(args(), soon.deps)
    expect(soon.json()).toMatchObject({ result: 'resumed', state: 'idle', confirmed: true })
    expect(clock - NOW).toBe(3_000)

    clock = NOW
    const never = closed()
    never.extra.agent_close = (p) => p.mode === 'inspect' ? {} : { closed: true }
    const slow = harness(never, { now: () => clock, sleep: async (ms) => { clock += ms + 300 }, engineAlive: async () => null })
    await ensureCommand(args(), slow.deps)
    expect(slow.json()).toMatchObject({ result: 'resumed', id: 'c1', state: 'starting', confirmed: false })
    expect(slow.json()).not.toHaveProperty('whyCode')
    expect(clock - NOW).toBeGreaterThanOrEqual(SETTLE_MS)
    expect(clock - NOW).toBeLessThanOrEqual(SETTLE_MS + 300)
  })

  it('confirms a resume whose engine still runs when the watch ends, its TUI not drawn yet (a lamp\'s arm64)', async () => {
    let clock = NOW
    const d = closed()
    d.extra.agent_close = (p) => p.mode === 'inspect' ? {} : { closed: true }
    const h = harness(d, { now: () => clock, sleep: async (ms) => { clock += ms }, engineAlive: async () => true })
    await ensureCommand(args(), h.deps)
    expect(h.json()).toMatchObject({ result: 'resumed', id: 'c1', state: 'starting', confirmed: true })
    expect(h.json()).not.toHaveProperty('whyCode')
    expect(clock - NOW).toBe(SETTLE_MS)
  })

  it('says a resume the daemon has not confirmed resumed, confirmed false, rather than as a plain resume', async () => {
    let clock = NOW
    const d = closed()
    d.extra.agent_resume = () => { d.frames = [frame('c1')]; return { state: 'unconfirmed' } }
    d.extra.agent_close = (p) => p.mode === 'inspect' ? {} : { closed: true }
    const h = harness(d, { now: () => clock, sleep: async (ms) => { clock += ms } })
    expect(await ensureCommand(args(), h.deps)).toBe(EXIT.ok)
    expect(h.json()).toMatchObject({ result: 'resumed', id: 'c1', state: 'starting', confirmed: false })
    expect(new ProgramRecords(dir).get('c1')?.startedAt).toBe(NOW)
  })
})

describe('gatewayHolds', () => {
  const said = (ok: boolean, text: string) => { const argv: string[][] = []; return { argv, call: async (a: string[]) => { argv.push(a); return { ok, said: text } } } }

  it('asks sessions.resolve for the key, and reads a held key, a deleted one, and anything else', async () => {
    const held = said(true, '{\n  "ok": true,\n  "key": "agent:main:harness-c1"\n}')
    expect(await gatewayHolds('agent:main:harness-c1', held.call)).toBe(true)
    expect(held.argv).toEqual([['gateway', 'call', 'sessions.resolve', '--params', '{"key":"agent:main:harness-c1"}', '--json', '--timeout', '10000']])
    expect(await gatewayHolds('k', said(false, '{"ok": false, "message": "No session found: k"}').call)).toBe(false)
    expect(await gatewayHolds('k', said(false, 'Error: connect ECONNREFUSED 127.0.0.1:18789').call)).toBeNull()
    expect(await gatewayHolds('k', said(false, '').call)).toBeNull()
    expect(await gatewayHolds('k', said(true, 'gateway call: unknown method').call)).toBeNull()
  })
})
