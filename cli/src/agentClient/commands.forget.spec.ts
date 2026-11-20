import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeCommand, EXIT, type ClientDeps } from './commands.js'
import type { Daemon, Where } from './daemon.js'
import type { RunCommand } from './forget.js'
import { Ledger, ledgerPath } from './ledger.js'
import { ProgramRecords, type ProgramHarness } from './program.js'
import { signedOutForTest } from '../testing/agentSettings.js'
import type { Frame } from './model.js'

const NOW = Date.parse('2026-11-17T12:00:00Z')
const TOKEN = 't'.repeat(40)
const HASH = createHash('sha256').update(TOKEN).digest('hex')
const KEY = 'agent:main:harness-a1'
const HERMES_ID = '20261117_120000_abc123'
const ARCHIVE = 'OpenClaw keeps its transcript in its own archive of deleted sessions'

const frame = (id: string, over: Partial<Frame> = {}): Frame => ({
  id, sessionId: `agent:main:harness-${id}`, name: id, engine: 'openclaw', status: 'active', activity: { state: 'idle' }, tmuxPane: `%${id}`,
  project: { cwd: `/work/${id}` }, createdAt: '2026-11-17T10:00:00Z', updatedAt: '2026-11-17T11:59:00Z', ...over,
})

type Handler = (payload: Record<string, unknown>) => Record<string, unknown>

/** A daemon whose close stops the harness, and whose purge erases it, as the real ones do. */
class FakeDaemon implements Daemon {
  machineId = 'm'
  requests: Array<{ type: string; payload: Record<string, unknown> }> = []
  frames: Frame[] = []
  screen: Record<string, unknown> = { activity: 'idle' }
  extra: Record<string, Handler> = {}
  async request(type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.requests.push({ type, payload })
    if (this.extra[type]) return this.extra[type](payload)
    if (type === 'agents_list') return { agents: this.frames.filter((f) => payload.includeStopped || f.status !== 'stopped') }
    if (type === 'agent_close' && payload.mode === 'inspect') return this.screen
    if (type === 'agent_close') {
      this.frames = this.frames.map((f) => (f.id === payload.agentId ? { ...f, status: 'stopped' } : f))
      return { ok: true }
    }
    if (type === 'agent_purge' && payload.mode === 'inspect') return { reviewId: 'r1' }
    if (type === 'agent_purge') {
      this.frames = this.frames.filter((f) => f.id !== payload.agentId)
      return { deleted: true, sessionDeleted: true }
    }
    return { error: 'UNKNOWN' }
  }
  close(): void {}
  sent(type: string, mode?: string) { return this.requests.filter((r) => r.type === type && (mode === undefined || r.payload.mode === mode)) }
}

let dir: string
let where: Where
let token: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'program-forget-'))
  writeFileSync(join(dir, 'machine-name'), 'lamp\n')
  signedOutForTest()
  where = { port: 1, dataDir: dir, machineId: 'computer-1' }
  token = join(dir, 'token')
  writeFileSync(token, `${TOKEN}\n`)
  chmodSync(token, 0o600)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** Engines that delete what they are asked: the Gateway every key, Hermes its session. */
const engines = (archived: string[] = []): RunCommand => async (command, args) => command === 'openclaw'
  ? { code: 0, stdout: JSON.stringify({ ok: true, key: JSON.parse(args[4]).key, deleted: true, archived }, null, 2), stderr: '' }
  : { code: 0, stdout: `Deleted session '${args.at(-1)}'.\n`, stderr: '' }

function harness(daemon: FakeDaemon, cli: RunCommand = engines(), env: NodeJS.ProcessEnv = {}, holds: boolean | null = true) {
  const out: string[] = [], err: string[] = []
  const run = vi.fn<RunCommand>(cli)
  const deps: ClientDeps = {
    pane: undefined, env, where: () => where, open: async () => daemon,
    ledger: (d) => new Ledger(ledgerPath(d)), out: (l) => out.push(l), err: (l) => err.push(l),
    now: () => NOW, sleep: async () => {}, engineCli: run, hermesHolds: async () => holds,
  }
  return { deps, out, err, run, keys: () => run.mock.calls.filter(([c]) => c === 'openclaw').map(([, a]) => JSON.parse(a[4]).key) }
}

const own = (agentId: string, over: Partial<ProgramHarness> = {}) =>
  new ProgramRecords(dir).put({ agentId, tokenHash: HASH, name: 'lamp-openclaw', engine: 'openclaw', createdAt: NOW - 60_000, startedAt: NOW - 60_000, inputs: [], ...over })

const forget = (h: ReturnType<typeof harness>, extra: string[] = ['--json'], name = 'lamp-openclaw') =>
  closeCommand([name, '--program-token-file', token, '--forget', ...extra], h.deps)

describe('harness close --forget, a program\'s own harness (#4393)', () => {
  it('closes it, deletes its OpenClaw session through the Gateway and what Harness kept, and forgets it', async () => {
    const d = new FakeDaemon()
    // Its engine titled the session since: found by the name the program gave it.
    d.frames = [frame('a1', { name: 'Light control' })]
    own('a1')
    const h = harness(d, engines(['/state/x.jsonl.deleted']))
    expect(await forget(h)).toBe(EXIT.ok)
    expect(JSON.parse(h.out[0])).toEqual({
      name: 'Light control', id: 'a1', engine: 'openclaw', closed: true, forgotten: true,
      harness: { state: 'deleted' },
      engineSession: { state: 'deleted', sessions: [{ key: KEY, state: 'deleted', detail: ARCHIVE }] },
      effect: `Light control: closed and forgotten; the next harness ensure starts a new one. Its OpenClaw session ${KEY} was deleted (${ARCHIVE}). Everything Harness kept of it is erased.`,
    })
    // Closed with leave to have saved nothing, should its engine have written nothing yet.
    expect(d.sent('agent_close', 'idle')[0].payload).toMatchObject({ agentId: 'a1', ifNoHistory: true })
    expect(h.run).toHaveBeenCalledWith('openclaw', ['gateway', 'call', 'sessions.delete', '--params', JSON.stringify({ key: KEY, deleteTranscript: true }), '--json', '--timeout', '10000'])
    expect(d.sent('agent_purge', 'delete')[0].payload).toEqual({ agentId: 'a1', sessionId: KEY, createdAt: Date.parse('2026-11-17T10:00:00Z'),
      mode: 'delete', reviewId: 'r1', choices: { sessionData: true, worktreeData: false } })
    expect(new ProgramRecords(dir).get('a1')).toBeNull()
  })

  it('deletes every key it used: the one it was launched with, which keeps its conversation after a /new, and the one it is bound to', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1', { name: 'lamp-openclaw', sessionId: 'agent:main:tui-9f' })]
    own('a1')
    const h = harness(d)
    expect(await forget(h)).toBe(EXIT.ok)
    expect(h.keys()).toEqual([KEY, 'agent:main:tui-9f'])
    const said = JSON.parse(h.out[0])
    expect(said.engineSession).toEqual({ state: 'deleted', sessions: [{ key: KEY, state: 'deleted' }, { key: 'agent:main:tui-9f', state: 'deleted' }] })
    expect(said.effect).toContain(`Its OpenClaw session ${KEY} was deleted. Its OpenClaw session agent:main:tui-9f was deleted.`)
    // One kept is the whole kept, each said.
    d.frames = [frame('a1', { name: 'lamp-openclaw', sessionId: 'agent:main:tui-9f' })]
    own('a1')
    const one = harness(d, async (_c, args) => JSON.parse(args[4]).key === KEY
      ? { code: 0, stdout: '{"ok":true,"deleted":true}', stderr: '' } : { code: 1, stdout: '', stderr: 'Gateway call failed: busy' })
    expect(await forget(one)).toBe(EXIT.failed)
    expect(JSON.parse(one.out[0]).engineSession).toEqual({ state: 'kept', sessions: [{ key: KEY, state: 'deleted' },
      { key: 'agent:main:tui-9f', state: 'kept', detail: 'OpenClaw\'s Gateway did not delete it (Gateway call failed: busy)' }] })
  })

  it('says it in words without --json, and a closed one is deleted without a close', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1', { name: 'lamp-openclaw', status: 'stopped', sessionId: '' })]
    own('a1')
    const h = harness(d)
    expect(await forget(h, [])).toBe(EXIT.ok)
    expect(h.out).toEqual([`lamp-openclaw: forgotten; the next harness ensure starts a new one. Its OpenClaw session ${KEY} was deleted. Everything Harness kept of it is erased.`])
    expect(d.sent('agent_close')).toHaveLength(0)
    // No conversation bound: the purge reads that as none.
    expect(d.sent('agent_purge', 'inspect')[0].payload.sessionId).toBeNull()
  })

  it('is refused while it works, unless --now, and nothing is deleted or forgotten', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1')]
    own('a1')
    d.extra.agent_close = (p) => (p.mode === 'inspect' ? { activity: 'working' } : { error: 'SESSION_NOT_IDLE', activity: 'working' })
    const h = harness(d)
    expect(await forget(h)).toBe(EXIT.failed)
    expect(JSON.parse(h.out[0])).toMatchObject({ error: 'WORKING', detail: 'a1 is working. Wait for it (harness wait a1), or close it anyway with --now.' })
    expect(h.run).not.toHaveBeenCalled()
    expect(d.sent('agent_purge')).toHaveLength(0)
    expect(new ProgramRecords(dir).get('a1')).not.toBeNull()
    delete d.extra.agent_close
    const now = harness(d)
    expect(await forget(now, ['--now', '--json'])).toBe(EXIT.ok)
    expect(d.sent('agent_close', 'now')[0].payload).toMatchObject({ ifNoHistory: true })
  })

  it('never says a Gateway refusal was a deletion: NOT_ALL_DELETED (1), and the harness is still forgotten', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1')]
    own('a1')
    const h = harness(d, async () => ({ code: 1, stdout: '', stderr: 'Gateway call failed: Error: connect ECONNREFUSED 127.0.0.1:18789' }))
    expect(await forget(h)).toBe(EXIT.failed)
    const said = JSON.parse(h.out[0])
    expect(said).toMatchObject({ error: 'NOT_ALL_DELETED', forgotten: true, harness: { state: 'deleted' },
      engineSession: { state: 'kept', sessions: [{ key: KEY, state: 'kept', detail: 'OpenClaw\'s Gateway did not delete it (Gateway call failed: Error: connect ECONNREFUSED 127.0.0.1:18789)' }] } })
    expect(said.detail).toBe(said.effect)
    expect(said.effect).toContain(`Its OpenClaw session ${KEY} was NOT deleted: OpenClaw's Gateway did not delete it`)
    expect(new ProgramRecords(dir).get('a1')).toBeNull()
    // In words, on stderr.
    own('a1')
    d.frames = [frame('a1')]
    const words = harness(d, async () => ({ code: 1, stdout: '', stderr: 'no gateway' }))
    expect(await forget(words, [])).toBe(EXIT.failed)
    expect(words.err[0]).toMatch(/was NOT deleted: OpenClaw's Gateway did not delete it \(no gateway\)\. Everything Harness kept of it is erased\.$/)
  })

  it('says none when the Gateway had no such session', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1')]
    own('a1')
    const h = harness(d, async () => ({ code: 0, stdout: '{"ok":true,"deleted":false,"archived":[]}', stderr: '' }))
    expect(await forget(h)).toBe(EXIT.ok)
    expect(JSON.parse(h.out[0]).engineSession.state).toBe('none')
    expect(JSON.parse(h.out[0]).effect).toContain(`Its OpenClaw session ${KEY} had nothing to delete: OpenClaw's Gateway had no such session.`)
  })

  it('keeps the session of a --local run, which is in its own folder, and says so', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1')]
    own('a1', { local: '/run/lamp/openclaw' })
    const h = harness(d)
    expect(await forget(h)).toBe(EXIT.failed)
    expect(JSON.parse(h.out[0]).engineSession).toEqual({ state: 'kept', sessions: [{ state: 'kept', key: KEY,
      detail: 'it ran on its own --local folder (/run/lamp/openclaw), which holds its session: delete that folder' }] })
    expect(h.run).not.toHaveBeenCalled()
  })

  it('says what Harness could not erase, with the daemon\'s words, in one sentence', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1')]
    own('a1')
    d.extra.agent_purge = (p) => (p.mode === 'inspect' ? { reviewId: 'r1' } : { error: 'DELETE_REFUSED', detail: 'Another operation is using this saved harness. Nothing was deleted.' })
    const h = harness(d)
    expect(await forget(h)).toBe(EXIT.failed)
    expect(JSON.parse(h.out[0])).toMatchObject({ harness: { state: 'kept', detail: 'Another operation is using this saved harness. Nothing was deleted.' }, engineSession: { state: 'deleted' } })
    expect(JSON.parse(h.out[0]).effect).toMatch(/What Harness kept of it was NOT erased: Another operation is using this saved harness\. Nothing was deleted\.$/)
  })

  describe('Hermes, whose session Hermes deletes itself', () => {
    const hermes = (over: Partial<Frame> = {}) => frame('h1', { engine: 'hermes', sessionId: HERMES_ID, ...over })

    it('deletes it with hermes sessions delete, then what Harness kept', async () => {
      const d = new FakeDaemon()
      d.frames = [hermes()]
      own('h1', { engine: 'hermes' })
      const h = harness(d, async (command, args) => { d.requests.push({ type: command, payload: {} }); return engines()(command, args) })
      expect(await forget(h)).toBe(EXIT.ok)
      expect(JSON.parse(h.out[0])).toMatchObject({ engine: 'hermes', harness: { state: 'deleted' }, engineSession: { state: 'deleted', sessions: [{ key: HERMES_ID, state: 'deleted' }] } })
      expect(JSON.parse(h.out[0]).effect).toContain(`Its Hermes session ${HERMES_ID} was deleted.`)
      expect(h.run).toHaveBeenCalledWith('hermes', ['sessions', 'delete', '--yes', HERMES_ID])
      // Hermes first: the purge then finds nothing of it left in Hermes's store.
      expect(d.requests.map((r) => r.type).filter((type) => type === 'hermes' || type === 'agent_purge')).toEqual(['hermes', 'agent_purge', 'agent_purge'])
    })

    it('says none for one that never had a conversation, or one its store no longer holds', async () => {
      const d = new FakeDaemon()
      d.frames = [hermes({ sessionId: '' })]
      own('h1', { engine: 'hermes' })
      const h = harness(d)
      expect(await forget(h)).toBe(EXIT.ok)
      expect(JSON.parse(h.out[0]).engineSession).toEqual({ state: 'none', sessions: [] })
      expect(JSON.parse(h.out[0]).effect).toContain('Its Hermes conversation had nothing to delete.')
      expect(h.run).not.toHaveBeenCalled()
      d.frames = [hermes()]
      own('h1', { engine: 'hermes' })
      const gone = harness(d, engines(), {}, false)
      expect(await forget(gone)).toBe(EXIT.ok)
      expect(JSON.parse(gone.out[0]).engineSession.sessions).toEqual([{ key: HERMES_ID, state: 'none', detail: 'Hermes\'s store has no such session' }])
    })

    it('says kept, with Hermes\'s words, when Hermes did not delete it, and what the purge then kept', async () => {
      const d = new FakeDaemon()
      d.frames = [hermes()]
      own('h1', { engine: 'hermes' })
      d.extra.agent_purge = () => ({ error: 'DELETE_REFUSED', detail: 'This engine uses history triggers that Harness cannot safely verify. Use the engine to delete its conversation.' })
      const h = harness(d, async () => ({ code: 1, stdout: '', stderr: 'database is locked' }))
      expect(await forget(h)).toBe(EXIT.failed)
      const said = JSON.parse(h.out[0])
      expect(said).toMatchObject({ harness: { state: 'kept' }, engineSession: { state: 'kept', sessions: [{ key: HERMES_ID, state: 'kept', detail: 'Hermes did not delete it (database is locked)' }] } })
      // Each clause ends once: no "conversation.." from the daemon's own stop.
      expect(said.effect).toMatch(/Use the engine to delete its conversation\.$/)
      expect(said.effect).not.toMatch(/\.\./)
    })

    it('says a gone one\'s session cannot be found', async () => {
      const d = new FakeDaemon()
      own('h1', { engine: 'hermes' })
      const h = harness(d)
      expect(await forget(h)).toBe(EXIT.failed)
      expect(JSON.parse(h.out[0])).toMatchObject({ name: 'lamp-openclaw', closed: false, harness: { state: 'none' },
        engineSession: { state: 'kept', detail: 'Harness no longer keeps this harness, so it cannot find its conversation', sessions: [] } })
      expect(JSON.parse(h.out[0]).effect).toContain('Its Hermes conversation was NOT deleted: Harness no longer keeps this harness')
      expect(new ProgramRecords(dir).get('h1')).toBeNull()
    })
  })

  describe('any other engine, whose session is the purge\'s', () => {
    const claude = (over: Partial<Frame> = {}) => frame('c1', { engine: 'claude', sessionId: 'c-session', ...over })

    it('deleted with the purge, none without a conversation, kept with the store\'s or the purge\'s reason', async () => {
      const d = new FakeDaemon()
      d.frames = [claude()]
      own('c1', { engine: 'claude' })
      const h = harness(d)
      expect(await forget(h)).toBe(EXIT.ok)
      expect(JSON.parse(h.out[0]).engineSession).toEqual({ state: 'deleted', sessions: [] })
      expect(h.run).not.toHaveBeenCalled()

      d.frames = [claude({ sessionId: '' })]
      own('c1', { engine: 'claude' })
      const none = harness(d)
      expect(await forget(none)).toBe(EXIT.ok)
      expect(JSON.parse(none.out[0]).engineSession).toEqual({ state: 'none', sessions: [] })

      d.frames = [claude()]
      own('c1', { engine: 'claude' })
      d.extra.agent_purge = (p) => (p.mode === 'inspect' ? { reviewId: 'r1' } : { deleted: true, kept: [{ what: 'engine-store', reason: 'Its store keeps it.' }] })
      const kept = harness(d)
      expect(await forget(kept)).toBe(EXIT.failed)
      expect(JSON.parse(kept.out[0])).toMatchObject({ harness: { state: 'deleted' }, engineSession: { state: 'kept', detail: 'Its store keeps it.' } })

      d.frames = [claude()]
      own('c1', { engine: 'claude' })
      d.extra.agent_purge = () => ({ error: 'DELETE_REFUSED' })
      const refused = harness(d)
      expect(await forget(refused)).toBe(EXIT.failed)
      expect(JSON.parse(refused.out[0])).toMatchObject({ harness: { state: 'kept', detail: 'DELETE_REFUSED' }, engineSession: { state: 'kept', detail: 'DELETE_REFUSED' } })

      own('c1', { engine: 'claude' })
      d.extra.agent_purge = () => { throw new Error('Harness is not running.') }
      const failed = harness(d)
      expect(await forget(failed)).toBe(EXIT.failed)
      expect(JSON.parse(failed.out[0])).toMatchObject({ harness: { state: 'kept', detail: 'Harness is not running.' } })

      own('c1', { engine: 'claude' })
      d.extra.agent_purge = () => { throw 'gone' }
      const thrown = harness(d)
      expect(await forget(thrown)).toBe(EXIT.failed)
      expect(JSON.parse(thrown.out[0])).toMatchObject({ harness: { state: 'kept', detail: 'gone' } })
    })
  })

  it('forgets a record whose harness Harness no longer lists, deleting its OpenClaw session by the key it was launched with', async () => {
    const d = new FakeDaemon()
    own('a1')
    const h = harness(d)
    expect(await forget(h)).toBe(EXIT.ok)
    expect(JSON.parse(h.out[0])).toMatchObject({ id: 'a1', closed: false, harness: { state: 'none' }, engineSession: { state: 'deleted', sessions: [{ key: KEY }] } })
    expect(JSON.parse(h.out[0]).effect).toContain('Harness kept nothing of it.')
    expect(d.sent('agent_purge')).toHaveLength(0)
    expect(new ProgramRecords(dir).get('a1')).toBeNull()
    // Forgotten, its name is no longer the program's: asked again, UNKNOWN_HARNESS.
    const again = harness(d)
    expect(await forget(again)).toBe(EXIT.failed)
    expect(JSON.parse(again.out[0]).error).toBe('UNKNOWN_HARNESS')
  })

  it('takes the key it was listed with when it is gone once closed', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1', { name: 'lamp-openclaw', sessionId: 'agent:work:harness-a1' })]
    own('a1')
    d.extra.agent_close = (p) => {
      if (p.mode === 'inspect') return { activity: 'idle' }
      d.frames = []
      return { ok: true }
    }
    const h = harness(d)
    expect(await forget(h)).toBe(EXIT.ok)
    expect(JSON.parse(h.out[0])).toMatchObject({ closed: true, harness: { state: 'none' } })
    expect(h.keys()).toEqual([KEY, 'agent:work:harness-a1'])
  })

  it('is refused without the token as a usage error, before anything is asked', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1')]
    const h = harness(d)
    expect(await closeCommand(['a1', '--forget', '--json'], h.deps)).toBe(EXIT.usage)
    expect(h.err[0]).toBe('--forget deletes a program\'s own harness\'s conversation: it takes --program-token-file <path>.')
    expect(d.requests).toHaveLength(0)
  })

  it('refuses NOT_YOURS for a harness the token does not own, and an agent even with the token', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1', { name: 'lamp-openclaw' })]
    const h = harness(d)
    expect(await forget(h)).toBe(EXIT.refused)
    expect(JSON.parse(h.out[0]).error).toBe('NOT_YOURS')
    own('a1')
    const agent = harness(d, engines(), { CODEX_THREAD_ID: 'thread-1' })
    expect(await forget(agent)).toBe(EXIT.refused)
    expect(JSON.parse(agent.out[0]).error).toBe('NOT_YOURS')
    expect(d.sent('agent_close', 'idle')).toHaveLength(0)
    expect(d.sent('agent_purge')).toHaveLength(0)
    expect(new ProgramRecords(dir).get('a1')).not.toBeNull()
  })

  it('without --forget closes it and keeps its conversation and its record, as on main', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1', { name: 'lamp-openclaw', createdAt: undefined, sessionId: undefined })]
    own('a1')
    const h = harness(d)
    expect(await closeCommand(['lamp-openclaw', '--program-token-file', token, '--json'], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out[0])).toMatchObject({ id: 'a1', closed: true, effect: 'Its conversation is kept; the person can resume it.' })
    // An ordinary close: no leave to save nothing.
    expect(d.sent('agent_close', 'idle')[0].payload).toEqual({ agentId: 'a1', sessionId: '', createdAt: '', mode: 'idle' })
    expect(h.run).not.toHaveBeenCalled()
    expect(d.sent('agent_purge')).toHaveLength(0)
    expect(new ProgramRecords(dir).get('a1')).not.toBeNull()
    // Forgotten later, closed: its creation time unknown, the purge is asked with none.
    const later = harness(d)
    expect(await forget(later)).toBe(EXIT.ok)
    expect(d.sent('agent_purge', 'inspect')[0].payload.createdAt).toBeNaN()
  })

  it('takes a token on this computer only', async () => {
    const d = new FakeDaemon()
    const h = harness(d)
    expect(await forget(h, ['--machine', 'office'])).toBe(EXIT.usage)
    expect(h.err[0]).toBe('--program-token-file is for a harness on this computer: leave out --machine.')
  })

  it('says a name no record or harness has as UNKNOWN_HARNESS', async () => {
    const h = harness(new FakeDaemon())
    expect(await forget(h)).toBe(EXIT.failed)
    expect(JSON.parse(h.out[0]).error).toBe('UNKNOWN_HARNESS')
  })

  it('runs the engines\' own CLIs by default', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a1', { name: 'lamp-openclaw' })]
    own('a1')
    const h = harness(d)
    delete h.deps.engineCli
    const path = process.env.PATH
    process.env.PATH = tmpdir()
    try { expect(await forget(h)).toBe(EXIT.failed) } finally { process.env.PATH = path }
    expect(JSON.parse(h.out[0]).engineSession.sessions[0].detail).toBe('OpenClaw\'s Gateway did not delete it (openclaw is not on the PATH here)')
    // Hermes's store read where Hermes keeps it: the test's own empty home has none, so nothing is run.
    d.frames = [frame('h1', { name: 'lamp-openclaw', engine: 'hermes', sessionId: HERMES_ID })]
    own('h1', { engine: 'hermes' })
    const hermes = harness(d)
    delete hermes.deps.hermesHolds
    expect(await forget(hermes)).toBe(EXIT.failed)
    expect(JSON.parse(hermes.out[0]).engineSession.sessions).toEqual([{ key: HERMES_ID, state: 'kept', detail: 'Hermes\'s store could not be read here, so nothing was deleted' }])
    expect(hermes.run).not.toHaveBeenCalled()
  })
})
