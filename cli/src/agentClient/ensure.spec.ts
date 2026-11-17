import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from './commands.js'
import { AgentClientError, type Daemon, type Where } from './daemon.js'
import { ensureCommand, type EnsureDeps } from './ensure.js'
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

describe('harness ensure (#4393)', () => {
  it('starts a new one as harness new does, with the token, and says the daemon it started', async () => {
    const d = new FakeDaemon()
    const h = harness(d, { daemonUp: async () => ({ started: true, ms: 912 }) })
    expect(await ensureCommand(args(), h.deps)).toBe(EXIT.ok)
    expect(h.made).toEqual([['openclaw', '--name', 'lamp', '--program-token-file', token, '--json']])
    expect(h.json()).toEqual({ result: 'new', id: 'new1', name: 'lamp', engine: 'openclaw', engineSession: 'harness-new1', state: 'starting',
      daemonStarted: true, daemonStartMs: 912 })
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
    d.extra.agent_resume = () => ({ state: 'failed', failure: { code: 'SPAWN_FAILED', detail: 'no gateway' } })
    const h = harness(d)
    await ensureCommand(args(), h.deps)
    expect(h.json()).toMatchObject({ result: 'new', id: 'new1', why: expect.stringContaining('could not be opened again') })
    expect(new ProgramRecords(dir).get('c1')).toBeNull()
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
