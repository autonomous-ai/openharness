import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeCommand, EXIT, replyCommand, resumeCommand, waitCommand, type ClientDeps } from './commands.js'
import { AgentClientError, type Daemon, type Where } from './daemon.js'
import { Ledger, ledgerPath } from './ledger.js'
import { ProgramRecords } from './program.js'
import { setAgentSettingsForTest, signedOutForTest } from '../testing/agentSettings.js'
import type { Frame } from './model.js'

const NOW = Date.parse('2026-11-17T12:00:00Z')
const TOKEN = 't'.repeat(40)
const HASH = createHash('sha256').update(TOKEN).digest('hex')

const frame = (id: string, over: Partial<Frame> = {}): Frame => ({
  id, sessionId: `s-${id}`, name: id, engine: 'openclaw', status: 'active', activity: { state: 'idle' }, tmuxPane: `%${id}`,
  project: { cwd: `/work/${id}` }, createdAt: '2026-11-17T10:00:00Z', updatedAt: '2026-11-17T11:59:00Z', ...over,
})

type Handler = (payload: Record<string, unknown>) => Record<string, unknown>

class FakeDaemon implements Daemon {
  machineId = 'm'
  requests: Array<{ type: string; payload: Record<string, unknown> }> = []
  frames: Frame[] = []
  screens: string[] = ['idle']
  extra: Record<string, Handler> = {}
  async request(type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.requests.push({ type, payload })
    if (this.extra[type]) return this.extra[type](payload)
    if (type === 'agents_list') return { agents: this.frames.filter((f) => payload.includeStopped || f.status !== 'stopped') }
    if (type === 'agent_close' && payload.mode === 'inspect') return { activity: this.screens.length > 1 ? this.screens.shift() : this.screens[0] }
    return { error: 'UNKNOWN' }
  }
  close(): void {}
}

let dir: string
let where: Where
let token: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'program-client-'))
  writeFileSync(join(dir, 'machine-name'), 'lamp\n')
  // Signed out, and the person's `programs-reply` switch never turned on: the lamp as it ships.
  signedOutForTest()
  where = { port: 1, dataDir: dir, machineId: 'computer-1' }
  token = join(dir, 'token')
  writeFileSync(token, `${TOKEN}\n`)
  chmodSync(token, 0o600)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function harness(daemon: FakeDaemon, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [], err: string[] = []
  let clock = NOW
  const deps: ClientDeps = {
    pane: undefined, env, where: () => where, open: async () => daemon,
    ledger: (d) => new Ledger(ledgerPath(d)), out: (l) => out.push(l), err: (l) => err.push(l),
    now: () => clock, sleep: async (ms) => { clock += ms },
  }
  return { deps, out, err }
}

const own = (agentId: string, name = 'lamp-openclaw', over: Partial<Parameters<ProgramRecords['put']>[0]> = {}) =>
  new ProgramRecords(dir).put({ agentId, tokenHash: HASH, name, engine: 'openclaw', createdAt: NOW - 60_000, startedAt: NOW - 60_000, inputs: [], ...over })

const reply = (h: ReturnType<typeof harness>, name = 'lamp-openclaw', extra: string[] = []) =>
  replyCommand([name, '--program-token-file', token, '--json', ...extra, '--', 'turn', 'on', 'the', 'light'], h.deps)

describe('harness reply to a program\'s own harness (#4393)', () => {
  it('returns taken with the input id once the engine took the words, signed out and with programs-reply off', async () => {
    const d = new FakeDaemon()
    // Its engine titled the session since: found by the name the program gave it.
    d.frames = [frame('a1', { name: 'Light control' })]
    own('a1')
    d.extra.input_ack = (p) => ({ inputId: 'program:x1', state: 'taken', takenAt: NOW + 400, echo: p })
    const h = harness(d)
    expect(await reply(h)).toBe(EXIT.ok)
    expect(JSON.parse(h.out[0])).toEqual({ state: 'taken', inputId: 'program:x1', takenAt: new Date(NOW + 400).toISOString() })
    expect(d.requests.find((r) => r.type === 'input_ack')!.payload).toEqual({ agentId: 'a1', text: 'turn on the light', ackMs: 30_000, takenMs: 30_000, inputId: expect.stringMatching(/^program:[0-9a-f-]{36}$/) })
    expect(new ProgramRecords(dir).get('a1')!.inputs).toEqual([{ id: 'program:x1', takenAt: NOW + 400 }])
  })

  it('waits for an engine still coming up, then says ENGINE_NOT_READY with nothing typed', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1')]
    own('a1')
    d.screens = ['working']
    const h = harness(d)
    expect(await reply(h, 'lamp-openclaw', ['--timeout', '3s'])).toBe(EXIT.refused)
    expect(JSON.parse(h.out[0]).error).toBe('ENGINE_NOT_READY')
    expect(d.requests.some((r) => r.type === 'input_ack')).toBe(false)
    expect(d.requests.filter((r) => r.payload.mode === 'inspect').length).toBeGreaterThan(2)
  })

  it('types once the engine is ready within the wait', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1')]
    own('a1')
    d.screens = ['working', 'working', 'idle']
    d.extra.input_ack = () => ({ inputId: 'program:x2', state: 'taken', takenAt: NOW })
    const h = harness(d)
    expect(await reply(h)).toBe(EXIT.ok)
  })

  it('says NOT_IDLE at once while it works on words it took, and NOT_RUNNING (4) once it was closed', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1')]
    own('a1', 'lamp-openclaw', { inputs: [{ id: 'program:old', takenAt: NOW - 1_000 }] })
    d.screens = ['working']
    const h = harness(d)
    expect(await reply(h)).toBe(EXIT.refused)
    expect(JSON.parse(h.out[0]).error).toBe('NOT_IDLE')
    d.frames = [frame('a1', { status: 'stopped' })]
    const h2 = harness(d)
    expect(await reply(h2)).toBe(EXIT.stopped)
    expect(JSON.parse(h2.out[0]).error).toBe('NOT_RUNNING')
  })

  it('says TIMEOUT (124): cancelled when nothing was typed, with the input to follow when it was', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1')]
    own('a1')
    d.extra.input_ack = () => ({ inputId: 'program:x3', state: 'timeout', cancelled: true, written: false })
    const h = harness(d)
    expect(await reply(h)).toBe(EXIT.timeout)
    expect(JSON.parse(h.out[0])).toMatchObject({ error: 'TIMEOUT', cancelled: true })
    d.extra.input_ack = () => ({ inputId: 'program:x4', state: 'unknown', reason: 'dispatch_ambiguous' })
    const h2 = harness(d)
    expect(await reply(h2)).toBe(EXIT.timeout)
    expect(JSON.parse(h2.out[0])).toMatchObject({ error: 'TIMEOUT', cancelled: false, inputId: 'program:x4', reason: 'dispatch_ambiguous' })
    // Kept for `wait --after`, as not seen taken.
    expect(new ProgramRecords(dir).get('a1')!.inputs.at(-1)).toEqual({ id: 'program:x4', takenAt: NOW, unconfirmed: true })
    d.extra.input_ack = () => ({ inputId: 'program:x5', state: 'rejected', reason: 'runtime_gone_pre_paste' })
    const h3 = harness(d)
    expect(await reply(h3)).toBe(EXIT.stopped)
    d.extra.input_ack = () => ({ inputId: 'program:x6', state: 'rejected', reason: 'enter_withheld' })
    const h4 = harness(d)
    // Enter held back: the words may be in its box. Followed, never sent again.
    expect(await reply(h4)).toBe(EXIT.timeout)
    expect(JSON.parse(h4.out[0])).toMatchObject({ error: 'TIMEOUT', cancelled: false, inputId: 'program:x6', reason: 'enter_withheld' })
    d.extra.input_ack = () => ({ inputId: 'program:x7', state: 'rejected', reason: 'question_open' })
    const h6 = harness(d)
    expect(await reply(h6)).toBe(EXIT.refused)
    expect(JSON.parse(h6.out[0]).error).toBe('ENGINE_NOT_READY')
    d.extra.input_ack = () => ({ error: 'UNSUPPORTED' })
    const h5 = harness(d)
    expect(await reply(h5)).toBe(EXIT.failed)
    expect(JSON.parse(h5.out[0]).error).toBe('DAEMON_TOO_OLD')
  })

  it('says TIMEOUT with its own input id to follow when the daemon never answers, and keeps it for wait --after', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1')]
    own('a1')
    d.extra.input_ack = () => { throw new AgentClientError('TIMEOUT', 'Harness did not answer input_ack in time. Try again.') }
    const h = harness(d)
    expect(await reply(h)).toBe(EXIT.timeout)
    const asked = String(d.requests.find((r) => r.type === 'input_ack')!.payload.inputId)
    expect(JSON.parse(h.out[0])).toMatchObject({ error: 'TIMEOUT', cancelled: false, inputId: asked, reason: 'no_answer' })
    expect(new ProgramRecords(dir).get('a1')!.inputs).toEqual([{ id: asked, takenAt: NOW, unconfirmed: true }])
    // Any other failure of the line is said as it is.
    d.extra.input_ack = () => { throw new AgentClientError('DAEMON_UNREACHABLE', 'Harness is not running.') }
    const down = harness(d)
    expect(await reply(down)).toBe(EXIT.failed)
  })

  it('follows an input not seen taken with wait --after: idle only once it was seen working', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1')]
    own('a1', 'lamp-openclaw', { inputs: [{ id: 'program:u1', takenAt: NOW, unconfirmed: true }, { id: 'program:t1', takenAt: NOW }] })
    const wait = (id: string, extra: string[] = []) => { const h = harness(d); return waitCommand(['lamp-openclaw', '--program-token-file', token, '--after', id, '--json', ...extra], h.deps).then((code) => ({ code, out: h.out })) }
    // Taken: its turn started, so the first idle after it is its end.
    d.screens = ['idle']
    expect((await wait('program:t1')).code).toBe(EXIT.ok)
    // Not seen taken, idle all along: still waited on.
    expect((await wait('program:u1', ['--timeout', '5s'])).code).toBe(EXIT.timeout)
    d.screens = ['working', 'working', 'idle']
    expect((await wait('program:u1')).code).toBe(EXIT.ok)
  })

  it('refuses an agent even with the token, a harness the token does not own, and a bad token file', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1'), frame('theirs')]
    own('a1')
    const agent = harness(d, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'sess' })
    expect(await reply(agent)).toBe(EXIT.refused)
    expect(JSON.parse(agent.out[0]).error).toBe('NOT_YOURS')
    const other = harness(d)
    expect(await reply(other, 'theirs')).toBe(EXIT.refused)
    expect(JSON.parse(other.out[0]).error).toBe('NOT_YOURS')
    chmodSync(token, 0o644)
    const bad = harness(d)
    expect(await reply(bad)).toBe(EXIT.refused)
    expect(JSON.parse(bad.out[0]).error).toBe('BAD_TOKEN_FILE')
    expect(d.requests.some((r) => r.type === 'input_ack')).toBe(false)
  })

  it('resumes its own closed harness without the person\'s switch, and marks its engine started', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1', { status: 'stopped' })]
    own('a1')
    d.extra.agent_resume = () => ({ state: 'created', agent: frame('a1'), resumed: true })
    const h = harness(d)
    expect(await resumeCommand(['lamp-openclaw', '--program-token-file', token, '--json'], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out[0])).toMatchObject({ ok: true, id: 'a1', resumed: true })
    expect(new ProgramRecords(dir).get('a1')!.startedAt).toBe(NOW)
  })

  it('refuses a close, resume or reply without the token to a harness a program owns', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1', { name: 't1' })]
    own('a1', 't1')
    const closed = harness(d)
    expect(await closeCommand(['t1', '--json'], closed.deps)).toBe(EXIT.refused)
    expect(JSON.parse(closed.out[0]).error).toBe('NOT_YOURS')
    d.frames = [frame('a1', { name: 't1', status: 'stopped' })]
    // The person's switch on, as the lamp's never is: still the program's alone.
    setAgentSettingsForTest(dir, { programsReply: true })
    const resumed = harness(d)
    expect(await resumeCommand(['t1', '--json'], resumed.deps)).toBe(EXIT.refused)
    expect(JSON.parse(resumed.out[0]).error).toBe('NOT_YOURS')
    d.frames = [frame('a1', { name: 't1' })]
    const replied = harness(d)
    expect(await replyCommand(['t1', '--json', '--', 'hi'], replied.deps)).toBe(EXIT.refused)
    expect(JSON.parse(replied.out[0]).error).toBe('NOT_YOURS')
    expect(d.requests.some((r) => r.type === 'agent_close' && r.payload.mode !== 'inspect')).toBe(false)
    expect(d.requests.some((r) => r.type === 'agent_resume')).toBe(false)
  })

  it('keeps every reply without a token as it was: refused while programs-reply is off', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1')]
    const h = harness(d)
    expect(await replyCommand(['a1', '--json', '--', 'hi'], h.deps)).toBe(EXIT.refused)
    expect(JSON.parse(h.out[0]).error).toBe('REPLY_OFF')
    const t = harness(d)
    expect(await replyCommand(['a1', '--timeout', '5s', '--', 'hi'], t.deps)).toBe(EXIT.usage)
  })
})

// The open line's errors keep their codes: a daemon that is down is said as every verb says it.
it('says a daemon out of reach as DAEMON_UNREACHABLE', async () => {
  const h = harness(new FakeDaemon())
  h.deps.open = async () => { throw new AgentClientError('DAEMON_UNREACHABLE', 'Harness is not running.') }
  expect(await reply(h)).toBe(EXIT.failed)
  expect(JSON.parse(h.out[0]).error).toBe('DAEMON_UNREACHABLE')
})
