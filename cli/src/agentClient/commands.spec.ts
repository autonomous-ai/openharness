import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addressOf, agentOrigin, AGENTS_START_AGENTS_OFF, closeCommand, DEPTH_REFUSAL, EXIT, parseDuration, psCommand, refusalNext, replyCommand, showCommand, spawnCheck, spawnCount, spawnRefusal, SPAWN_LIMITS, step, tellCommand, waitCommand, whoamiCommand, type ClientDeps } from './commands.js'
import { RefusedError, type Rpc } from '../messages/rpc.js'
import { AgentClientError, type Daemon, type Where } from './daemon.js'
import { Ledger, ledgerPath } from './ledger.js'
import { agentSettingsPath } from '../lib/agentSettings.js'
import { setAgentSettingsForTest, signedOutForTest, TEST_ACCOUNT } from '../testing/agentSettings.js'
import type { Frame } from './model.js'

const NOW = Date.parse('2026-10-11T12:00:00Z')

const frame = (id: string, over: Partial<Frame> = {}): Frame => ({
  id, sessionId: `s-${id}`, name: id, engine: 'codex', status: 'active', activity: { state: 'idle' }, tmuxPane: `%${id}`,
  project: { cwd: `/work/${id}`, branch: 'main' }, createdAt: '2026-10-11T10:00:00Z', updatedAt: '2026-10-11T11:59:00Z', ...over,
})

type Handler = (payload: Record<string, unknown>) => Record<string, unknown>

/** A daemon answering from a table; `screens` scripts what each inspect sees, one look at a time. */
class FakeDaemon implements Daemon {
  requests: Array<{ type: string; payload: Record<string, unknown> }> = []
  closed = false
  frames: Frame[] = []
  screens = new Map<string, string[]>()
  pages = new Map<string, Record<string, unknown>[]>()
  extra: Record<string, Handler> = {}
  constructor(readonly machineId = 'm') {}
  async request(type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.requests.push({ type, payload })
    if (this.extra[type]) return this.extra[type](payload)
    switch (type) {
      case 'agents_list': return { agents: this.frames.filter((f) => payload.includeStopped || f.status !== 'stopped') }
      case 'agent_recent': return { agentId: payload.agentId, events: [{ kind: 'summary', text: `${String(payload.agentId)} text`, recap: `${String(payload.agentId)} recap` }], asks: [`ask of ${String(payload.agentId)}`] }
      case 'agent_close': {
        if (payload.mode === 'inspect') {
          const seen = this.screens.get(String(payload.agentId)) ?? []
          return { activity: seen.length > 1 ? seen.shift() : seen[0] ?? 'idle' }
        }
        return { closed: true }
      }
      case 'session_get': {
        const pages = this.pages.get(String(payload.sessionId)) ?? []
        const index = payload.before ? Number(payload.before) : 0
        return pages[index] ?? { events: [], hasMore: false }
      }
      default: return { error: 'UNKNOWN' }
    }
  }
  close(): void { this.closed = true }
}

let dir: string
let where: Where
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-client-'))
  writeFileSync(join(dir, 'machine-name'), 'studio\n')
  // The account lets agents start agents: off by default (lib/agentSettings.ts), and these are about what an agent's
  // `harness new` does once it may.
  setAgentSettingsForTest(dir, { agentsStartAgents: true })
  where = { port: 1, dataDir: dir, machineId: 'm' }
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); signedOutForTest() })

function harness(daemon: FakeDaemon, over: Partial<ClientDeps> & { others?: Record<string, FakeDaemon> } = {}) {
  const out: string[] = [], err: string[] = []
  let clock = NOW
  const deps: ClientDeps = {
    pane: '%lead', env: {}, where: () => where,
    open: async (_w, machineId) => {
      if (!machineId || machineId === 'm') return daemon
      const other = over.others?.[machineId]
      if (!other) throw new AgentClientError('NO_PEER_LINK', 'not linked')
      return other
    },
    ledger: (d) => new Ledger(ledgerPath(d)),
    out: (l) => out.push(l), err: (l) => err.push(l),
    now: () => clock, sleep: async (ms) => { clock += ms }, intervalMs: 1_000,
    ...over,
  }
  return { deps, out, err, ledger: new Ledger(ledgerPath(dir)), advance: (ms: number) => { clock += ms } }
}

it('recognizes a Windows host pane from HARNESS_PANE for agent commands', async () => {
  const d = new FakeDaemon()
  d.frames = [frame('lead', { tmuxPane: 'p1:%3' })]
  const h = harness(d, { env: { HARNESS_PANE: 'p1:%3' } })
  delete h.deps.pane
  expect(await whoamiCommand([], h.deps)).toBe(EXIT.ok)
  expect(h.out.join('\n')).toContain('inside Harness')
})

const started = (ledger: Ledger, by: string, child: string, childMachine = 'm', at = NOW) => ledger.append({
  at, depth: 1, by: { machineId: 'm', agentId: by, name: by, engine: 'claude' }, child: { machineId: childMachine, agentId: child, name: child },
})

const ev = (type: string, payload: Record<string, unknown> = {}) => ({ type, payload })

describe('harness ps', () => {
  it('lists the harnesses here: who you are, state, who started each, and what each is about', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('kid', { activity: { state: 'working' } }), frame('sh', { engine: 'terminal' })]
    const h = harness(d)
    started(h.ledger, 'lead', 'kid')
    expect(await psCommand([], h.deps)).toBe(EXIT.ok)
    const text = h.out.join('\n')
    expect(text).toMatch(/^You: Claude Code "lead" \(lead\), inside Harness, on studio\.\nCan start harnesses: yes\.\nYours: 1 open of 4 · 1 of 20 starts in the last 10 minutes\nNAME +AGENT +STATE +STARTED BY +ACTIVE +FOLDER/)
    expect(text).toMatch(/kid +Codex +working +you +1m +\/work\/kid \(main\)\n  kid recap/)
    expect(text).toMatch(/lead +Claude Code +idle +person \(you\)/)
    expect(text).not.toContain('sh ')
    expect(d.closed).toBe(true)
  })

  it('ends an agent\'s ps with Next: read its idle one, wait for its busy ones, or start one', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('a'), frame('b', { activity: { state: 'working' } }), frame('c', { status: 'stopped' }), frame('theirs')]
    const h = harness(d)
    for (const kid of ['a', 'b', 'c']) started(h.ledger, 'lead', kid)
    expect(await psCommand([], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n').split('\n').slice(-2)).toEqual([
      'Next: harness show a  (read its answer, then close it: harness close a)',
      '  or: harness wait b  (until it stops working)',
    ])
    // Through MCP, as its tools.
    d.frames = [frame('lead', { engine: 'claude' }), frame('b', { activity: { state: 'working' } })]
    const one = harness(d, { env: { HARNESS_VIA_MCP: '1' } })
    expect(await psCommand([], one.deps)).toBe(EXIT.ok)
    expect(one.out.join('\n').split('\n').at(-1)).toBe('Next: harness_wait (names: "b")  (until it stops working)')
    // None of its own, and it may start one.
    d.frames = [frame('lead', { engine: 'claude' }), frame('theirs')]
    const none = harness(d)
    expect(await psCommand([], none.deps)).toBe(EXIT.ok)
    expect(none.out.join('\n').split('\n').at(-1)).toBe('Next: harness new <agent> --name <name> <project> -- <task>  (to hand work to another agent; do quick work yourself)')
    // It may not start one: the block above says why, and nothing comes next.
    setAgentSettingsForTest(dir, { agentsStartAgents: false })
    const off = harness(d)
    expect(await psCommand([], off.deps)).toBe(EXIT.ok)
    expect(off.out.join('\n')).not.toMatch(/^Next:/m)
    // The person: no Next.
    const person = harness(d, { pane: undefined })
    expect(await psCommand([], person.deps)).toBe(EXIT.ok)
    expect(person.out.join('\n')).not.toMatch(/^Next:/m)
    // Programs read it as a field.
    setAgentSettingsForTest(dir, { agentsStartAgents: true })
    const json = harness(d)
    expect(await psCommand(['--json'], json.deps)).toBe(EXIT.ok)
    expect(JSON.parse(json.out[0]).next).toEqual([{ run: 'harness new <agent> --name <name> <project> -- <task>', when: 'to hand work to another agent; do quick work yourself' }])
  })

  it('shows an agent at most 15 rows, its own first, and says how to see the rest; a person sees all', async () => {
    const d = new FakeDaemon()
    // Its own two are the oldest: still shown, and first.
    d.frames = [frame('lead', { engine: 'claude' }), ...Array.from({ length: 18 }, (_, i) => frame(`h${i}`)),
      frame('old1', { updatedAt: '2026-10-01T00:00:00Z' }), frame('old2', { updatedAt: '2026-10-01T00:00:00Z' })]
    const h = harness(d)
    started(h.ledger, 'lead', 'old1')
    started(h.ledger, 'lead', 'old2')
    expect(await psCommand([], h.deps)).toBe(EXIT.ok)
    const lines = h.out.join('\n').split('\n')
    const rows = lines.filter((l) => /^(h\d+|old\d|lead) /.test(l))
    expect(rows).toHaveLength(15)
    expect(rows.slice(0, 2).map((l) => l.split(' ')[0])).toEqual(['old1', 'old2'])
    // What is left out, and that the command for it lists the stopped ones too.
    expect(lines).toContain('and 6 more, none of them yours: harness ps --all (lists every one, and those stopped this week)')
    // Programs get every row.
    const json = harness(d)
    expect(await psCommand(['--json'], json.deps)).toBe(EXIT.ok)
    expect(JSON.parse(json.out[0]).harnesses).toHaveLength(21)
    // --all: all of them.
    const all = harness(d)
    expect(await psCommand(['--all'], all.deps)).toBe(EXIT.ok)
    expect(all.out.join('\n')).not.toContain('more: harness ps --all')
    // The person: every row, as before.
    const person = harness(d, { pane: undefined })
    expect(await psCommand([], person.deps)).toBe(EXIT.ok)
    expect(person.out.join('\n')).not.toContain('more: harness ps --all')
    expect(person.out.join('\n').match(/^(h\d+|old\d|lead) /gm)).toHaveLength(21)
  })

  it('tells an agent outside Harness that it is one', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('kid')]
    const h = harness(d, { pane: undefined, env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'S1' } })
    h.ledger.append({ at: NOW, depth: 1, by: { machineId: 'm', agentId: 'claude-code:S1', name: 'Claude Code', engine: 'claude' }, child: { machineId: 'm', agentId: 'kid', name: 'kid' } })
    expect(await psCommand([], h.deps)).toBe(EXIT.ok)
    expect(h.out[0].split('\n')[0]).toBe('You: Claude Code, outside Harness, on studio. Nothing can message you here.')
    expect(h.out[0]).toMatch(/\nkid +Codex +\w+ +you /)
  })

  it('gives the context in its JSON, and leaves a person\'s ps as it was', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('theirs')]
    const h = harness(d)
    expect(await psCommand(['--json'], h.deps)).toBe(EXIT.ok)
    const listed = JSON.parse(h.out.join('\n'))
    expect(listed.context.caller).toMatchObject({ kind: 'agent', name: 'lead', machine: 'studio' })
    expect(listed.you).toBe('lead')
    const person = harness(d, { pane: undefined })
    expect(await psCommand([], person.deps)).toBe(EXIT.ok)
    expect(person.out.join('\n')).toMatch(/^NAME +AGENT/)
  })

  it('prints JSON for programs, and asks for stopped ones with --all', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead'), frame('old', { status: 'stopped' })]
    d.extra.agent_recent = (p) => (p.agentId === 'lead' ? { error: 'NOPE' } : { events: [{ kind: 'x', text: '' }, { kind: 'y' }], asks: ['  first   ask ', 3] })
    const h = harness(d, { pane: undefined })
    expect(await psCommand(['--all', '--json'], h.deps)).toBe(EXIT.ok)
    const parsed = JSON.parse(h.out[0])
    expect(parsed.you).toBeNull()
    expect(parsed.machine).toBe('studio')
    expect(parsed.harnesses.map((r: { name: string }) => r.name)).toEqual(['lead', 'old'])
    expect(d.requests[0]).toMatchObject({ type: 'agents_list', payload: { includeStopped: true } })
    // A stopped harness is not asked what it is about.
    expect(d.requests.filter((r) => r.type === 'agent_recent').map((r) => r.payload.agentId)).toEqual(['lead'])
  })

  it('says what it shows when there is nothing, uses the asks when there is no summary, and survives a summary that does not come', async () => {
    const empty = harness(new FakeDaemon())
    expect(await psCommand([], empty.deps)).toBe(EXIT.ok)
    expect(empty.out).toEqual(['No harnesses on this machine.'])
    const d = new FakeDaemon()
    d.frames = [frame('a'), frame('b')]
    d.extra.agent_recent = (p) => { if (p.agentId === 'b') throw new Error('slow'); return { events: [], asks: ['the ask'] } }
    const h = harness(d)
    expect(await psCommand([], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n')).toContain('  asked: the ask')
  })

  it('lists an ask without the markers around a paste', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a')]
    // As the daemon keeps it: on one line, the markers still in it.
    d.extra.agent_recent = () => ({ events: [], asks: ['read this: <pasted_content id="1c18"> #1242 is merged </pasted_content id="1c18">'] })
    const h = harness(d)
    expect(await psCommand([], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n')).toContain('  asked: read this: #1242 is merged')
    expect(h.out.join('\n')).not.toContain('pasted_content')
  })

  it('refuses names and unknown options with the usage, and prints the usage for --help', async () => {
    const h = harness(new FakeDaemon())
    expect(await psCommand(['kid'], h.deps)).toBe(EXIT.usage)
    expect(h.err[0]).toBe('harness ps takes no names. To read one: harness show kid')
    expect(await psCommand(['--bogus'], h.deps)).toBe(EXIT.usage)
    expect(h.err).toContain('Unknown option --bogus.')
    expect(await psCommand(['--help'], h.deps)).toBe(EXIT.ok)
    expect(h.out.at(-1)).toMatch(/^Usage: harness ps/)
  })

  it('says when the daemon cannot be reached or cannot list, in words or JSON', async () => {
    const down = harness(new FakeDaemon(), { open: async () => { throw new AgentClientError('DAEMON_UNREACHABLE', 'Harness is not running here.') } })
    expect(await psCommand([], down.deps)).toBe(EXIT.failed)
    expect(down.err).toEqual(['Harness is not running here.'])
    const d = new FakeDaemon()
    d.extra.agents_list = () => ({ error: 'BUSY' })
    const h = harness(d)
    expect(await psCommand(['--json'], h.deps)).toBe(EXIT.failed)
    expect(JSON.parse(h.out[0])).toEqual({ error: 'BUSY', detail: 'Harness could not list its harnesses. Try again.' })
    expect(d.closed).toBe(true)
    const odd = harness(new FakeDaemon(), { open: async () => { throw 'string' } })
    expect(await psCommand([], odd.deps)).toBe(EXIT.failed)
    expect(odd.err).toEqual(['string'])
  })
})

describe('harness show', () => {
  it('shows the state and the last turn, reading back a page at a time until it finds the ask', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead'), frame('reviewer')]
    d.pages.set('s-reviewer', [
      { events: [ev('tool_start'), ev('tool_end'), ev('text_delta', { content: 'Two bugs.' }), ev('done')], hasMore: true, oldestCursor: '1' },
      { events: [ev('user_message', { content: 'review 3f2a' })], hasMore: false },
    ])
    const h = harness(d)
    started(h.ledger, 'lead', 'reviewer')
    expect(await showCommand(['rev'], h.deps)).toBe(EXIT.ok)
    expect(h.out).toEqual([
      'reviewer on studio: idle · Codex · started by you',
      'folder: /work/reviewer (main)',
      'asked: review 3f2a',
      'answer (after 1 tool calls):',
      'Two bugs.',
      // Idle and the caller's: a harness left open after its answer is read sits there for nobody.
      'Next: harness close reviewer  (once you have what you need)',
    ])
    expect(d.requests.filter((r) => r.type === 'session_get').map((r) => r.payload)).toEqual([
      { sessionId: 's-reviewer', limit: 80 }, { sessionId: 's-reviewer', limit: 80, before: '1' },
    ])
  })

  it('ends with a hint to close only an idle harness of the caller\'s, by a name its verbs take, as a tool through MCP', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead'), frame('kid', { name: 'so we have built harness web,' }), frame('busy'), frame('theirs')]
    d.screens.set('busy', ['working'])
    d.pages.set('s-kid', [{ events: [ev('user_message', { content: 'go' }), ev('text_delta', { content: 'done' })], hasMore: false }])
    const h = harness(d)
    started(h.ledger, 'lead', 'kid')
    started(h.ledger, 'lead', 'busy')
    expect(await showCommand(['kid'], h.deps)).toBe(EXIT.ok)
    // An unnamed harness is called by its session title, a sentence `close` would not take: the start of its id.
    expect(h.out.at(-1)).toBe('Next: harness close kid  (once you have what you need)')
    expect(await showCommand(['busy'], h.deps)).toBe(EXIT.ok)
    expect(h.out.at(-1)).not.toMatch(/harness close/)
    expect(await showCommand(['theirs'], h.deps)).toBe(EXIT.ok)
    expect(h.out.at(-1)).not.toMatch(/harness close/)
    const mcp = harness(d, { env: { HARNESS_VIA_MCP: '1' } })
    expect(await showCommand(['kid'], mcp.deps)).toBe(EXIT.ok)
    expect(mcp.out.at(-1)).toBe('Next: harness_close (name: "kid")  (once you have what you need)')
    // Programs read the next step as a field, not a line.
    const json = harness(d)
    expect(await showCommand(['kid', '--json'], json.deps)).toBe(EXIT.ok)
    expect(json.out.join('\n')).not.toMatch(/Next:/)
    expect(JSON.parse(json.out.join('\n')).next).toEqual([{ run: 'harness close kid', when: 'once you have what you need' }])
  })

  it('clips a long answer and says how to read the rest; says when it waits for the person', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead'), frame('long')]
    d.screens.set('long', ['needs_input'])
    d.pages.set('s-long', [{ events: [ev('user_message', { content: 'go' }), ev('text_delta', { content: 'x'.repeat(50) })], hasMore: false }])
    const h = harness(d)
    expect(await showCommand(['long', '--chars', '10'], h.deps)).toBe(EXIT.ok)
    expect(h.out[0]).toBe('long on studio: needs the person · Codex · started by person')
    expect(h.out).toContain('xxxxxxxxx…')
    expect(h.out).toContain('… 40 more characters: harness show long --chars 50')
    expect(h.out.at(-1)).toMatch(/^Next: tell the person/)
    const json = harness(d)
    expect(await showCommand(['long', '--json', '--chars=5'], json.deps)).toBe(EXIT.ok)
    expect(JSON.parse(json.out.join('\n'))).toMatchObject({ name: 'long', state: 'needs-input', answer: 'xxxx…', truncated: true, ask: 'go' })
  })

  it('starts with the result and ends with Next: close for its own idle harness', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('kid')]
    d.pages.set('s-kid', [{ events: [ev('user_message', { content: 'review it' }), ev('text_delta', { content: 'One bug.' })], hasMore: false }])
    const h = harness(d)
    started(h.ledger, 'lead', 'kid')
    expect(await showCommand(['kid'], h.deps)).toBe(EXIT.ok)
    const lines = h.out.join('\n').split('\n')
    expect(lines[0]).toBe('kid on studio: idle · Codex · started by you')
    expect(lines.at(-1)).toBe('Next: harness close kid  (once you have what you need)')
  })

  it('names wait for a working harness, and never close for one the caller did not start', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('busy', { activity: { state: 'working' } }), frame('theirs')]
    d.screens.set('busy', ['working'])
    const h = harness(d)
    started(h.ledger, 'lead', 'busy')
    expect(await showCommand(['busy'], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n').split('\n').at(-1)).toBe('Next: harness wait busy  (until it stops working)')
    const theirs = harness(d)
    expect(await showCommand(['theirs'], theirs.deps)).toBe(EXIT.ok)
    expect(theirs.out.join('\n')).not.toMatch(/harness close/)
  })

  it('says to tell the person when only they can answer, and gives next in JSON', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('asker')]
    d.screens.set('asker', ['needs_input'])
    const h = harness(d)
    started(h.ledger, 'lead', 'asker')
    expect(await showCommand(['asker'], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n').split('\n').at(-1)).toBe('Next: tell the person; only they answer it (a question or a permission).')
    const json = harness(d)
    expect(await showCommand(['asker', '--json'], json.deps)).toBe(EXIT.ok)
    const parsed = JSON.parse(json.out[0])
    expect(parsed.state).toBe('needs-input')
    expect(parsed.next).toEqual([{ tell: 'tell the person; only they answer it (a question or a permission).' }])
  })

  it('says when there is no turn yet, or no transcript to read', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('fresh', { sessionId: '' }), frame('broken'), frame('stopped', { status: 'stopped' })]
    d.extra.session_get = () => ({ error: 'ENGINE_UNAVAILABLE' })
    const h = harness(d, { pane: undefined })
    expect(await showCommand(['fresh'], h.deps)).toBe(EXIT.ok)
    expect(await showCommand(['broken'], h.deps)).toBe(EXIT.ok)
    expect(await showCommand(['stopped'], h.deps)).toBe(EXIT.ok)
    expect(h.out.filter((l) => l === 'No turn yet.')).toHaveLength(3)
    expect(h.out).toContain('stopped on studio: stopped · Codex · started by person')
    // The screen could not be read: the listed state stands.
    d.extra.agent_close = () => { throw new Error('gone') }
    const again = harness(d, { pane: undefined })
    expect(await showCommand(['fresh'], again.deps)).toBe(EXIT.ok)
    expect(again.out[0]).toContain(': idle ·')
  })

  it('stops reading back after four pages', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('chatty')]
    d.pages.set('s-chatty', Array.from({ length: 6 }, (_, i) => ({ events: [ev('tool_start')], hasMore: true, oldestCursor: String(i + 1) })))
    const h = harness(d, { pane: undefined })
    expect(await showCommand(['chatty'], h.deps)).toBe(EXIT.ok)
    expect(d.requests.filter((r) => r.type === 'session_get')).toHaveLength(4)
    expect(h.out).toContain('No turn yet.')
  })

  it('refuses no name, two names, a bad --chars, and says which harnesses a name could mean', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('review-a'), frame('review-b'), frame('solo', { status: 'stopped' }), frame('solo2', { name: 'solo', status: 'stopped' })]
    const h = harness(d, { pane: undefined })
    expect(await showCommand([], h.deps)).toBe(EXIT.usage)
    expect(h.err[0]).toBe('Name the harness to show.')
    expect(await showCommand(['a', 'b'], h.deps)).toBe(EXIT.usage)
    expect(await showCommand(['a', '--chars', 'x'], h.deps)).toBe(EXIT.usage)
    expect(await showCommand(['a', '--chars'], h.deps)).toBe(EXIT.usage)
    expect(h.err).toContain('--chars needs a value.')
    expect(await showCommand(['review'], h.deps)).toBe(EXIT.failed)
    expect(h.err.at(-1)).toBe('"review" could be review-a (review-a, idle), review-b (review-b, idle). Use more of the name, or the id.')
    expect(await showCommand(['solo'], h.deps)).toBe(EXIT.failed)
    expect(await showCommand(['nobody'], h.deps)).toBe(EXIT.failed)
    expect(h.err.at(-1)).toBe('No harness named "nobody" on this machine. `harness ps` lists them. One on another of your machines: add --machine <name> (`harness ps --machine <name>` lists those).')
    // An MCP client has no `--machine` to give.
    const mcp = harness(d, { pane: undefined, env: { HARNESS_VIA_MCP: '1' } })
    expect(await showCommand(['nobody'], mcp.deps)).toBe(EXIT.failed)
    expect(mcp.err.at(-1)).toBe('No harness named "nobody" on this machine. `harness_list` lists them.')
  })

  it('prefers a live harness over a stopped one of the same name', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('old', { name: 'fixer', status: 'stopped' }), frame('new', { name: 'fixer' })]
    const h = harness(d, { pane: undefined })
    expect(await showCommand(['fixer', '--json'], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out.join('\n')).id).toBe('new')
  })

  it('finds a harness the caller started by the name it was started with, after its engine retitled it', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead'), frame('kid', { name: 'Fix the login test' })]
    const h = harness(d)
    started(h.ledger, 'lead', 'kid')
    h.ledger.append({ ...h.ledger.all()[0], child: { machineId: 'm', agentId: 'kid', name: 'Claude harness 10-11 8:38' } })
    expect(await showCommand(['Claude harness 10-11 8:38', '--json'], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({ id: 'kid', name: 'Fix the login test', startedBy: 'you' })
  })

  it('finds a harness the caller started on another machine', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead')]
    const mini = new FakeDaemon('mini')
    mini.frames = [frame('gpu-job')]
    const h = harness(d, { others: { mini } })
    started(h.ledger, 'lead', 'gpu-job', 'mini')
    expect(await showCommand(['gpu', '--json'], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({ name: 'gpu-job', machine: 'mini', startedBy: 'you' })
    expect(mini.closed).toBe(true)
    mini.frames = []
    const gone = harness(d, { others: { mini } })
    expect(await showCommand(['gpu-job'], gone.deps)).toBe(EXIT.failed)
    expect(gone.err[0]).toBe('gpu-job is no longer on its machine.')
  })
})

describe('harness wait', () => {
  const inspects = (d: FakeDaemon) => d.requests.filter((r) => r.type === 'agent_close').length
  const answered = (d: FakeDaemon, id: string) => d.pages.set(`s-${id}`, [{ events: [ev('user_message', { content: 'x' }), ev('text_delta', { content: 'Done.' }), ev('done')], hasMore: false }])

  it('waits while it works, then says it is idle once it stays idle', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead'), frame('kid')]
    d.screens.set('kid', ['working', 'working', 'idle'])
    const h = harness(d)
    expect(await waitCommand(['kid'], h.deps)).toBe(EXIT.ok)
    expect(h.out).toEqual(['kid: idle · read it: harness show kid'])
    expect(inspects(d)).toBe(4)
    expect(d.requests.filter((r) => r.type === 'agent_close').every((r) => r.payload.mode === 'inspect')).toBe(true)
  })

  it('reads no screen while the daemon says it is working', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('kid', { activity: { state: 'working' } })]
    let looks = 0
    d.extra.agents_list = () => ({ agents: [looks++ < 3 ? d.frames[0] : { ...d.frames[0], activity: { state: 'idle' } }] })
    const h = harness(d)
    expect(await waitCommand(['kid'], h.deps)).toBe(EXIT.ok)
    expect(inspects(d)).toBe(2)
  })

  it('returns, after a second look, for a harness that has already answered', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('done')]
    answered(d, 'done')
    const h = harness(d)
    expect(await waitCommand(['done', '--json'], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out.join('\n'))).toEqual({ harnesses: [{ name: 'done', id: 'done', state: 'idle', next: [{ run: 'harness show done', when: 'to read its answer' }] }] })
    expect(inspects(d)).toBe(2)
  })

  it('does not return on the turn before a message it was just sent', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('kid')]
    answered(d, 'kid')
    // Idle on the old turn, then the message is in its box, then it works on it, then it answers it.
    d.screens.set('kid', ['idle', 'draft', 'working', 'idle'])
    const h = harness(d)
    expect(await waitCommand(['kid'], h.deps)).toBe(EXIT.ok)
    expect(inspects(d)).toBe(5)
  })

  it('does not take a harness that has not begun its task for one that finished', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('new', { createdAt: new Date(NOW - 5_000).toISOString(), sessionId: '' })]
    d.screens.set('new', ['idle', 'idle', 'working', 'idle'])
    const h = harness(d)
    expect(await waitCommand(['new'], h.deps)).toBe(EXIT.ok)
    expect(inspects(d)).toBe(5)
  })

  it('waits on an idle harness whose last turn has no answer yet, until it has one', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('k')]
    d.pages.set('s-k', [{ events: [ev('user_message', { content: 'x' }), ev('tool_start'), ev('done')], hasMore: false }])
    const h = harness(d)
    expect(await waitCommand(['k', '--timeout', '10s'], h.deps)).toBe(EXIT.timeout)
  })

  it('gives up on a harness with nothing asked of it, once it is past starting', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('blank', { createdAt: '2026-10-11T09:00:00Z' })]
    const h = harness(d)
    expect(await waitCommand(['blank'], h.deps)).toBe(EXIT.ok)
    expect(inspects(d)).toBe(3)
    // Without a start time it is taken as old.
    const e = new FakeDaemon()
    e.frames = [frame('blank', { createdAt: undefined })]
    expect(await waitCommand(['blank'], harness(e).deps)).toBe(EXIT.ok)
  })

  it('stops for the person, a stop, a harness that went, or the clock', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('asks'), frame('busy')]
    d.screens.set('asks', ['needs_input'])
    d.screens.set('busy', ['working'])
    const h = harness(d)
    expect(await waitCommand(['asks'], h.deps)).toBe(EXIT.needsInput)
    expect(h.out[0]).toMatch(/asks: needs the person · it waits for the person/)
    const t = harness(d)
    expect(await waitCommand(['busy', '--timeout', '10s'], t.deps)).toBe(EXIT.timeout)
    expect(t.out[0]).toBe('busy: timeout · still working; wait again or read it: harness show busy')
    const s = new FakeDaemon()
    s.frames = [frame('x')]
    s.screens.set('x', ['working'])
    let n = 0
    s.extra.agents_list = () => ({ agents: n++ < 2 ? s.frames : [{ ...s.frames[0], status: 'stopped' }] })
    const st = harness(s)
    expect(await waitCommand(['x'], st.deps)).toBe(EXIT.stopped)
    expect(st.out[0]).toBe('x: stopped · it was stopped; its answer is kept: harness show x')
    let m = 0
    s.extra.agents_list = () => ({ agents: m++ < 2 ? s.frames : [] })
    const g = harness(s)
    expect(await waitCommand(['x'], g.deps)).toBe(EXIT.stopped)
    expect(g.out[0]).toBe('x: gone · it is gone')
  })

  it('tells where to look for a harness that is gone, and gives each one\'s next in JSON', async () => {
    const s = new FakeDaemon()
    s.frames = [frame('x')]
    s.screens.set('x', ['working'])
    let m = 0
    s.extra.agents_list = () => ({ agents: m++ < 2 ? s.frames : [] })
    const g = harness(s)
    expect(await waitCommand(['x'], g.deps)).toBe(EXIT.stopped)
    expect(g.out.join('\n')).toBe('x: gone · it is gone\nNext: harness ps --all  (to see whether it was closed)')
    const d = new FakeDaemon()
    d.frames = [frame('done')]
    answered(d, 'done')
    const json = harness(d)
    expect(await waitCommand(['done', '--json'], json.deps)).toBe(EXIT.ok)
    expect(JSON.parse(json.out.join('\n')).harnesses[0].next).toEqual([{ run: 'harness show done', when: 'to read its answer' }])
  })

  // A Codex lead closed its harness, then waited on it as it had queued: "Failed (exit 4) … stopped · it was stopped".
  it('says a harness the caller closed was closed by it, and is no failure; another\'s close still is', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead'), frame('kid', { status: 'stopped' }), frame('gone')]
    const h = harness(d)
    started(h.ledger, 'lead', 'kid')
    started(h.ledger, 'lead', 'gone')
    h.ledger.append({ at: NOW, by: { machineId: 'm', agentId: 'lead' }, closed: { machineId: 'm', agentId: 'kid' } })
    expect(await waitCommand(['kid'], h.deps)).toBe(EXIT.ok)
    expect(h.out).toEqual(['kid: closed (you closed it)'])
    expect(await waitCommand(['kid', '--json'], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out[1])).toEqual({ harnesses: [{ name: 'kid', id: 'kid', state: 'closed', next: [] }] })
    // Gone from the list after it closed it: still its close.
    h.ledger.append({ at: NOW, by: { machineId: 'm', agentId: 'lead' }, closed: { machineId: 'm', agentId: 'gone' } })
    let n = 0
    d.extra.agents_list = () => ({ agents: n++ < 1 ? d.frames : [] })
    const g = harness(d)
    expect(await waitCommand(['gone'], g.deps)).toBe(EXIT.ok)
    expect(g.out).toEqual(['gone: closed (you closed it)'])
    // Closed by another agent, or by the person: stopped, as before.
    delete d.extra.agents_list
    const other = harness(d, { pane: undefined, env: { CODEX_THREAD_ID: 'T1' } })
    other.ledger.append({ at: NOW, depth: 1, by: { machineId: 'm', agentId: 'codex:T1', name: 'Codex', engine: 'codex' }, child: { machineId: 'm', agentId: 'kid', name: 'kid' } })
    expect(await waitCommand(['kid'], other.deps)).toBe(EXIT.stopped)
    expect(other.out).toEqual(['kid: stopped · it was stopped; its answer is kept: harness show kid'])
    const person = harness(d, { pane: undefined })
    expect(await waitCommand(['kid'], person.deps)).toBe(EXIT.stopped)
    // Reopened after it closed it, worked on and stopped again: not its close any more.
    d.frames = [frame('lead'), frame('kid', { status: 'stopped', updatedAt: '2026-10-11T12:05:00Z' })]
    const reopened = harness(d)
    expect(await waitCommand(['kid'], reopened.deps)).toBe(EXIT.stopped)
    expect(reopened.out).toEqual(['kid: stopped · it was stopped; its answer is kept: harness show kid'])
  })

  it('waits for all of several, listing once a round, or the first with --any; a name twice is one harness', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('a'), frame('b')]
    d.screens.set('a', ['working', 'idle'])
    d.screens.set('b', ['working', 'working', 'working', 'idle'])
    const all = harness(d)
    expect(await waitCommand(['a,b', 'a'], all.deps)).toBe(EXIT.ok)
    expect(all.out).toEqual(['a: idle · read it: harness show a', 'b: idle · read it: harness show b'])
    const lists = d.requests.filter((r) => r.type === 'agents_list').length
    // The first list names them; then one a round, five rounds.
    expect(lists).toBe(6)
    d.screens.set('a', ['working', 'idle'])
    d.screens.set('b', ['working'])
    const any = harness(d)
    expect(await waitCommand(['a,b', '--any'], any.deps)).toBe(EXIT.ok)
    expect(any.out).toEqual(['a: idle · read it: harness show a'])
  })

  it('keeps waiting through a slow answer and a screen it cannot read', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('k')]
    let looks = 0
    d.extra.agent_close = () => {
      looks++
      if (looks === 1) throw new AgentClientError('TIMEOUT', 'slow')
      if (looks === 2) return { activity: 'unknown' }
      return looks === 3 ? { activity: 'working' } : { activity: 'idle' }
    }
    let lists = 0
    d.extra.agents_list = () => {
      // The daemon's own word is unknown while the screen cannot be read; then idle.
      lists++
      return { agents: [{ ...d.frames[0], activity: lists < 4 ? null : { state: 'idle' } }] }
    }
    const h = harness(d)
    expect(await waitCommand(['k', '--timeout', '0'], h.deps)).toBe(EXIT.ok)
    expect(looks).toBe(5)
  })

  it('passes on a failure it cannot wait through, and waits through a list that timed out', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('k')]
    let n = 0
    d.extra.agents_list = () => {
      n++
      if (n === 2) throw new AgentClientError('TIMEOUT', 'slow')
      if (n === 3) throw new AgentClientError('DISCONNECTED', 'The connection to Harness closed.')
      return { agents: d.frames }
    }
    const h = harness(d)
    expect(await waitCommand(['k'], h.deps)).toBe(EXIT.failed)
    expect(h.err).toEqual(['The connection to Harness closed.'])
  })

  it('refuses no name and a time it cannot read', async () => {
    const h = harness(new FakeDaemon())
    expect(await waitCommand([], h.deps)).toBe(EXIT.usage)
    expect(await waitCommand([','], h.deps)).toBe(EXIT.usage)
    expect(await waitCommand(['a', '--timeout', 'soon'], h.deps)).toBe(EXIT.usage)
    expect(h.err).toContain('"soon" is not a time: use 90s, 30m or 2h.')
    expect(parseDuration('90s')).toBe(90_000)
    expect(parseDuration('30')).toBe(1_800_000)
    expect(parseDuration('2h')).toBe(7_200_000)
  })

  it('waits on a harness the caller started on another machine', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead')]
    const mini = new FakeDaemon('mini')
    mini.frames = [frame('far')]
    mini.screens.set('far', ['working', 'idle'])
    const h = harness(d, { others: { mini } })
    started(h.ledger, 'lead', 'far', 'mini')
    expect(await waitCommand(['far'], h.deps)).toBe(EXIT.ok)
    expect(mini.closed).toBe(true)
  })
})

describe('Next names a harness as its verbs take it', () => {
  it('quotes a two-word name once, as a shell command or a tool call', async () => {
    expect(step({}, 'wait', '"code review"')).toBe('harness wait "code review"')
    expect(step({ HARNESS_VIA_MCP: '1' }, 'wait', '"code review"')).toBe('harness_wait (names: "code review")')
    expect(step({ HARNESS_VIA_MCP: '1' }, 'show', '"code review"')).toBe('harness_read (name: "code review")')
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' })]
    const viaMcp = (await agentOrigin(harness(d, { env: { HARNESS_VIA_MCP: '1' } }).deps))!
    expect(viaMcp.answer({ id: 'k1', name: 'code review' }, { local: true, machine: null }).next[0])
      .toEqual({ run: 'harness_wait (names: "code review")', when: 'until it has answered; then read it: harness_read (name: "code review")' })
  })

  it('gives wait\'s next by a name the verbs take: quoted, or the id\'s start for a sentence', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('abcdef123456', { name: 'so we have built harness web,' }), frame('cr123456', { name: 'code review' })]
    d.pages.set('s-abcdef123456', [{ events: [ev('user_message', { content: 'x' }), ev('text_delta', { content: 'Done.' }), ev('done')], hasMore: false }])
    d.pages.set('s-cr123456', [{ events: [ev('user_message', { content: 'x' }), ev('text_delta', { content: 'Done.' }), ev('done')], hasMore: false }])
    const h = harness(d, { pane: undefined })
    expect(await waitCommand(['abcdef12', '--json'], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out[0]).harnesses[0].next).toEqual([{ run: 'harness show abcdef12', when: 'to read its answer' }])
    const two = harness(d, { pane: undefined })
    expect(await waitCommand(['cr123456', '--json'], two.deps)).toBe(EXIT.ok)
    expect(JSON.parse(two.out[0]).harnesses[0].next).toEqual([{ run: 'harness show "code review"', when: 'to read its answer' }])
  })
})

describe('refusals and the person', () => {
  it('closing a harness the caller did not start exits 5, with its code in JSON beside the old fields', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('theirs')]
    const h = harness(d)
    expect(EXIT.refused).toBe(5)
    expect(await closeCommand(['theirs'], h.deps)).toBe(EXIT.refused)
    const json = harness(d)
    expect(await closeCommand(['theirs', '--json'], json.deps)).toBe(EXIT.refused)
    expect(JSON.parse(json.out[0])).toEqual({ error: 'NOT_YOURS', detail: 'You did not start theirs, so you may not close it. Only the person can.', code: 'NOT_YOURS', next: [] })
  })

  it('refuses a start over the open limit with its reason, the switch off and an orphan with theirs', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), ...['a', 'b', 'c', 'd'].map((id) => frame(id))]
    const h = harness(d)
    for (const kid of ['a', 'b', 'c', 'd']) started(h.ledger, 'lead', kid)
    const full = await (await agentOrigin(h.deps))!.check().catch((e) => e)
    expect(full).toBeInstanceOf(AgentClientError)
    expect([full.code, full.reason]).toEqual(['SPAWN_LIMIT', 'OPEN_LIMIT'])
    expect(refusalNext({}, full)).toEqual([{ run: 'harness close <name>', when: 'one you are done with, to free a place' }])
    setAgentSettingsForTest(dir, { agentsStartAgents: false })
    const off = await (await agentOrigin(harness(d).deps))!.check().catch((e) => e)
    expect([off.code, off.reason]).toEqual(['TURNED_OFF', 'SWITCH_OFF'])
    expect(refusalNext({}, off)).toEqual([])
    const orphan = await (await agentOrigin(harness(new FakeDaemon(), { pane: '%gone', where: () => ({ ...where, harnessPane: true }) }).deps))!.check().catch((e) => e)
    expect([orphan.code, orphan.reason]).toEqual(['NOT_YOURS', 'ORPHAN'])
  })

  it('says needs the person in text and keeps needs-input in JSON, with needsPerson', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('asker')]
    d.screens.set('asker', ['needs_input'])
    const h = harness(d)
    started(h.ledger, 'lead', 'asker')
    expect(await waitCommand(['asker'], h.deps)).toBe(EXIT.needsInput)
    expect(h.out[0]).toMatch(/^asker: needs the person · /)
    const json = harness(d)
    expect(await waitCommand(['asker', '--json'], json.deps)).toBe(EXIT.needsInput)
    expect(JSON.parse(json.out[0]).harnesses[0]).toMatchObject({ state: 'needs-input', needsPerson: true })
    const shown = harness(d)
    expect(await showCommand(['asker'], shown.deps)).toBe(EXIT.ok)
    expect(shown.out[0]).toBe('asker on studio: needs the person · Codex · started by you')
    const shownJson = harness(d)
    expect(await showCommand(['asker', '--json'], shownJson.deps)).toBe(EXIT.ok)
    expect(JSON.parse(shownJson.out[0])).toMatchObject({ state: 'needs-input', needsPerson: true })
  })
})

describe('harness close', () => {
  it('closes a harness the agent started, once it is idle', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead'), frame('kid')]
    const h = harness(d)
    started(h.ledger, 'lead', 'kid')
    expect(await closeCommand(['kid'], h.deps)).toBe(EXIT.ok)
    expect(h.out).toEqual(['kid on studio: closed. Its conversation is kept; the person can resume it.\nNext: nothing; you have 0 open of 4.'])
    expect(d.requests.at(-1)).toMatchObject({ type: 'agent_close', payload: { agentId: 'kid', sessionId: 's-kid', mode: 'idle' } })
    const now = harness(d)
    expect(await closeCommand(['kid', '--now', '--json'], now.deps)).toBe(EXIT.ok)
    expect(JSON.parse(now.out[0])).toEqual({ name: 'kid', id: 'kid', closed: true, effect: 'Its conversation is kept; the person can resume it.', next: [], open: 0 })
    expect(d.requests.at(-1)?.payload.mode).toBe('now')
  })

  it('says the result and the effect, and how many of its own are still open', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('kid'), frame('other')]
    const h = harness(d)
    started(h.ledger, 'lead', 'kid')
    started(h.ledger, 'lead', 'other')
    expect(await closeCommand(['kid'], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n')).toBe('kid on studio: closed. Its conversation is kept; the person can resume it.\nNext: nothing; you have 1 open of 4.')
    const json = harness(d)
    expect(await closeCommand(['other', '--json'], json.deps)).toBe(EXIT.ok)
    expect(JSON.parse(json.out[0])).toEqual({ name: 'other', id: 'other', closed: true, effect: 'Its conversation is kept; the person can resume it.', next: [], open: 1 })
    // The person: the result alone.
    const person = harness(d, { pane: undefined })
    expect(await closeCommand(['kid'], person.deps)).toBe(EXIT.ok)
    expect(person.out).toEqual(['kid on studio: closed. Its conversation is kept; the person can resume it.'])
  })

  it('refuses an agent a harness it did not start, and its own; the person closes anything', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead'), frame('theirs')]
    const h = harness(d)
    expect(await closeCommand(['theirs'], h.deps)).toBe(EXIT.refused)
    expect(h.err[0]).toBe('You did not start theirs, so you may not close it. Only the person can.')
    expect(await closeCommand(['lead'], h.deps)).toBe(EXIT.refused)
    expect(h.err[1]).toBe('That is your own harness. The person closes it.')
    const person = harness(d, { pane: undefined })
    expect(await closeCommand(['theirs'], person.deps)).toBe(EXIT.ok)
    // An agent the daemon lists offline for a moment is still that agent: never the person.
    d.frames = [frame('lead', { status: 'offline' }), frame('theirs')]
    const stopped = harness(d)
    expect(await closeCommand(['theirs'], stopped.deps)).toBe(EXIT.refused)
    expect(stopped.err[0]).toMatch(/^You did not start theirs/)
    // A pane Harness made whose harness it has forgotten: what is left of an agent, never the person.
    d.frames = [frame('theirs')]
    const left = harness(d, { pane: '%gone', where: () => ({ ...where, harnessPane: true }) })
    expect(await closeCommand(['theirs'], left.deps)).toBe(EXIT.refused)
    expect(left.err[0]).toBe('This pane\'s harness is no longer running, so nothing here may close or start harnesses. Only the person can.')
    // A person's terminal in Harness, or a pane of their own tmux, is the person.
    d.frames = [frame('theirs'), frame('sh', { engine: 'terminal', tmuxPane: '%sh' })]
    expect(await closeCommand(['theirs'], harness(d, { pane: '%sh', where: () => ({ ...where, harnessPane: true }) }).deps)).toBe(EXIT.ok)
    expect(await closeCommand(['theirs'], harness(d, { pane: '%own' }).deps)).toBe(EXIT.ok)
  })

  it('lets an agent outside Harness close only what its session started', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('mine'), frame('theirs'), frame('sh', { engine: 'terminal', tmuxPane: '%sh' })]
    const h = harness(d, { pane: undefined, env: { CODEX_THREAD_ID: 'T1' } })
    h.ledger.append({ at: NOW, depth: 1, by: { machineId: 'm', agentId: 'codex:T1', name: 'Codex', engine: 'codex' }, child: { machineId: 'm', agentId: 'mine', name: 'mine' } })
    expect(await closeCommand(['theirs'], h.deps)).toBe(EXIT.refused)
    expect(h.err[0]).toBe('You did not start theirs, so you may not close it. Only the person can.')
    expect(await closeCommand(['mine'], h.deps)).toBe(EXIT.ok)
    // Another session of the same agent did not start it.
    const other = harness(d, { pane: undefined, env: { CODEX_THREAD_ID: 'T2' } })
    expect(await closeCommand(['mine'], other.deps)).toBe(EXIT.refused)
    // From a person's terminal in Harness: still the agent its shell names.
    const inTile = harness(d, { pane: '%sh', env: { AI_AGENT: 'cursor_1-2_agent' }, where: () => ({ ...where, harnessPane: true }) })
    expect(await closeCommand(['theirs'], inTile.deps)).toBe(EXIT.refused)
  })

  it('says what to do when it is working or changed, and passes on any other refusal', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('k')]
    const replies: Array<Record<string, unknown>> = [
      { error: 'SESSION_NOT_IDLE', activity: 'working' }, { error: 'SESSION_NOT_IDLE', activity: 'needs_input' },
      { error: 'AGENT_CHANGED' }, { error: 'CLOSE_FAILED', detail: 'disk full' }, { error: 'CLOSE_FAILED' },
    ]
    d.extra.agent_close = () => replies.shift()!
    const h = harness(d, { pane: undefined })
    for (let i = 0; i < 5; i++) expect(await closeCommand(['k'], h.deps)).toBe(EXIT.failed)
    expect(h.err).toEqual([
      'k is working. Wait for it (harness wait k), or close it anyway with --now.',
      'k is waiting for the person. Wait for it (harness wait k), or close it anyway with --now.',
      'k changed while closing. Check it with harness show k, then try again.',
      'disk full',
      'Could not close k.',
    ])
  })

  // Codex 0.162.1, closed a second after its start (2026-10-12): the machine's own reason came through as it was,
  // "Conversation identity is held: the native control descriptor type is unavailable."
  it('says plainly when it closed a harness still starting without a conversation, or could not close one', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead'), frame('kid')]
    const replies: Array<Record<string, unknown>> = [
      { closed: true, withoutConversation: true }, { closed: true, withoutConversation: true },
      { error: 'IDENTITY_UNAVAILABLE', detail: 'Conversation identity is held: the native control descriptor type is unavailable.' },
    ]
    d.extra.agent_close = () => replies.shift()!
    const h = harness(d)
    started(h.ledger, 'lead', 'kid')
    expect(await closeCommand(['kid', '--now'], h.deps)).toBe(EXIT.ok)
    expect(h.out).toEqual(['kid on studio: closed. It had not started a conversation, so none was kept.\nNext: nothing; you have 0 open of 4.'])
    expect(await closeCommand(['kid', '--now', '--json'], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out[1])).toEqual({ name: 'kid', id: 'kid', closed: true, conversationKept: false, effect: 'It had not started a conversation, so none was kept.', next: [], open: 0 })
    expect(await closeCommand(['kid', '--now'], h.deps)).toBe(EXIT.failed)
    expect(h.err).toEqual(['kid was not closed: Harness cannot tell which conversation it is in right now, and closing it would lose that conversation. Try again in a moment.'])
  })

  it('records what an agent closed, for its wait; the person\'s closes and a record that cannot be written change nothing', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead'), frame('kid'), frame('theirs')]
    const h = harness(d)
    started(h.ledger, 'lead', 'kid')
    expect(await closeCommand(['kid'], h.deps)).toBe(EXIT.ok)
    expect(h.ledger.closedBy({ machineId: 'm', agentId: 'lead' }, { machineId: 'm', agentId: 'kid' })).toBe(NOW)
    // Older lines and readers: the closed line is no start, and asks for nothing.
    expect(h.ledger.childrenOf({ machineId: 'm', agentId: 'lead' }).map((row) => row.child.agentId)).toEqual(['kid'])
    expect(h.ledger.pendingOf(null, NOW)).toEqual([])
    expect(await closeCommand(['theirs'], harness(d, { pane: undefined }).deps)).toBe(EXIT.ok)
    expect(readFileSync(ledgerPath(dir), 'utf8').trim().split('\n')).toHaveLength(2)
    const unwritable = harness(d, { ledger: (data) => Object.assign(new Ledger(ledgerPath(data)), { append: () => { throw new Error('read-only') } }) })
    expect(await closeCommand(['kid'], unwritable.deps)).toBe(EXIT.ok)
    expect(unwritable.out).toEqual(['kid on studio: closed. Its conversation is kept; the person can resume it.\nNext: nothing; you have 0 open of 4.'])
  })

  it('closes one harness at a time, by name', async () => {
    const h = harness(new FakeDaemon())
    expect(await closeCommand([], h.deps)).toBe(EXIT.usage)
    expect(await closeCommand(['a', 'b'], h.deps)).toBe(EXIT.usage)
    expect(h.err).toContain('Close one harness at a time.')
  })
})

describe('harness new, run by an agent', () => {
  it('is nothing outside a harness pane or in a person\'s terminal; refuses when it cannot tell who is calling', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('sh', { engine: 'terminal', tmuxPane: '%9', status: 'offline' })]
    expect(await agentOrigin(harness(d, { pane: undefined }).deps)).toBeNull()
    // A person's terminal, in any state: the core marks every session inactive as it starts.
    expect(await agentOrigin(harness(d, { pane: '%9', where: () => ({ ...where, harnessPane: true }) }).deps)).toBeNull()
    // The daemon did not answer: outside Harness, the person; in a pane Harness made, refused.
    const down = async () => { throw new Error('down') }
    expect(await agentOrigin(harness(d, { open: down }).deps)).toBeNull()
    const unknown = (await agentOrigin(harness(d, { open: down, where: () => ({ ...where, harnessPane: true }) }).deps))!
    await expect(unknown.check()).rejects.toThrow(/could not tell who is starting this/)
  })

  it('says the daemon is out of reach rather than "try again", which an agent did in the same sandbox', async () => {
    const message = 'Harness is running, but a sandbox keeps this shell from reaching it.'
    const unreachable = async () => { throw new AgentClientError('DAEMON_UNREACHABLE', message) }
    // Codex outside Harness, and Codex in a pane Harness made: both run `harness new` sandboxed.
    for (const over of [{ pane: undefined, env: { CODEX_THREAD_ID: 't' } }, { where: () => ({ ...where, harnessPane: true }) }]) {
      const origin = (await agentOrigin(harness(new FakeDaemon(), { open: unreachable, ...over }).deps))!
      await expect(origin.check()).rejects.toMatchObject({ code: 'DAEMON_UNREACHABLE', message })
    }
  })

  it('refuses every agent until the account turns agents starting agents on, says where, and never refuses the person', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' })]
    // An account that never said: off by default.
    rmSync(agentSettingsPath(dir))
    const inPane = (await agentOrigin(harness(d).deps))!
    await expect(inPane.check()).rejects.toMatchObject({ code: 'TURNED_OFF', message: AGENTS_START_AGENTS_OFF })
    // The agent asks the person with its own tool, and turns it on only after their yes: people do not open a terminal.
    expect(AGENTS_START_AGENTS_OFF).toMatch(/^Agents may not start harnesses yet\. agents-start-agents is off\. Ask the person, with your tool for asking them \(Claude Code: AskUserQuestion; Codex: request_user_input\)/)
    expect(AGENTS_START_AGENTS_OFF).toContain('Only if they say yes, run `harness settings agents-start-agents on --person-said-yes`')
    expect(AGENTS_START_AGENTS_OFF).toMatch(/Never answer it for them\. If they say no: do the work yourself\.$/)
    const outside = (await agentOrigin(harness(d, { pane: undefined, env: { CODEX_THREAD_ID: 't' } }).deps))!
    await expect(outside.check()).rejects.toThrow(AGENTS_START_AGENTS_OFF)
    expect(await agentOrigin(harness(d, { pane: undefined }).deps)).toBeNull()
    setAgentSettingsForTest(dir, { agentsStartAgents: true })
    await expect((await agentOrigin(harness(d).deps))!.check()).resolves.toBeUndefined()
    // Turned off again; and on, but for an account no one is signed in to here.
    setAgentSettingsForTest(dir, { agentsStartAgents: false })
    await expect((await agentOrigin(harness(d).deps))!.check()).rejects.toThrow(AGENTS_START_AGENTS_OFF)
    setAgentSettingsForTest(dir, { agentsStartAgents: true })
    signedOutForTest()
    await expect((await agentOrigin(harness(d).deps))!.check()).rejects.toThrow(AGENTS_START_AGENTS_OFF)
  })

  it('names its own harness as the one that started the new one; an agent outside Harness names none', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' })]
    expect((await agentOrigin(harness(d).deps))!.parentAgentId).toBe('lead')
    const outside = (await agentOrigin(harness(d, { pane: undefined, env: { CODEX_THREAD_ID: 't' } }).deps))!
    expect(outside).not.toHaveProperty('parentAgentId')
  })

  it('refuses from what is left of an agent whose harness is gone', async () => {
    const origin = (await agentOrigin(harness(new FakeDaemon(), { pane: '%gone', where: () => ({ ...where, harnessPane: true }) }).deps))!
    await expect(origin.check()).rejects.toThrow(/no longer running/)
    expect(origin.prompt('x', 'm')).toBe('x')
    expect(await origin.created('m', {})).toBeNull()
    expect(origin.answer({}, { local: true, machine: null })).toEqual({ effect: '', next: [] })
  })

  it('heads the task with who sent it, records what it started, and says how to follow it, never to message it', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' })]
    const h = harness(d)
    const origin = (await agentOrigin(h.deps))!
    expect(d.closed).toBe(true)
    await expect(origin.check()).resolves.toBeUndefined()
    // Being started by it is no way to message it (owner, 2026-10-11: Agent Messages off means off): the header
    // invited the new harness to `harness send` its starter, and agents talked with no tab turned on.
    expect(origin.prompt('review it', 'm')).toBe('[from lead · Claude Code · studio, the harness that started you. It reads your answer itself.]\n\nreview it')
    expect(origin.prompt('review it', 'm')).not.toContain('harness send')
    expect(origin.prompt('train it', 'mini')).toBe('[from lead · Claude Code · studio, the harness that started you. It reads your answer itself.]\n\ntrain it')
    // A task longer than a first message holds: the whole of it in a file, its start in the message.
    const long = `Review all of it. ${'x'.repeat(3_000)}`
    const sent = origin.prompt(long, 'm')
    expect(sent.length).toBeLessThanOrEqual(2_000)
    const file = /All of it is in (\S+): read the whole file/.exec(sent)![1]
    expect(readFileSync(file, 'utf8')).toBe(long)
    expect(sent).toContain('It begins:\n\nReview all of it. xxx')
    expect(() => origin.prompt(long, 'mini')).toThrow(/another machine holds at most/)
    expect(await origin.created('m', { id: 'kid', name: 'reviewer' })).toBeNull()
    expect(await origin.created('m', { name: 'no id' })).toBeNull()
    expect(h.ledger.all()).toEqual([{ at: NOW, depth: 1, by: { machineId: 'm', agentId: 'lead', name: 'lead', engine: 'claude' }, child: { machineId: 'm', agentId: 'kid', name: 'reviewer' } }])
    await origin.created('m', { id: 'kid2', name: 7 })
    expect(h.ledger.all()[1].child.name).toBe('')
    const here = { local: true, machine: null }
    expect(origin.answer({ id: 'kid', name: 'reviewer' }, here)).toEqual({
      effect: 'The person sees it in Harness, beside you.',
      next: [{ run: 'harness wait reviewer', when: 'until it has answered; then read it: harness show reviewer' }],
    })
    // A name that is a sentence, or Harness's own stand-in: the id's start instead.
    const runOf = (agent: Record<string, unknown>, at: { local: boolean; machine: string | null } = here) => { const [step] = origin.answer(agent, at).next; return 'run' in step ? step.run : '' }
    expect(runOf({ id: 'abcdef123456', name: 'Claude harness 10-11 8:38' })).toBe('harness wait abcdef12')
    expect(runOf({ id: 'abcdef123456', name: 'code review' })).toBe('harness wait "code review"')
    // On another machine: named with it, and the person sees it there, not beside the caller.
    expect(origin.answer({ id: 'kid', name: 'reviewer' }, { local: false, machine: 'Mac mini' })).toEqual({
      effect: 'The person sees it in Harness.',
      next: [{ run: 'harness wait --machine "Mac mini" reviewer', when: 'until it has answered; then read it: harness show --machine "Mac mini" reviewer' }],
    })
    // Under MCP the tools take no machine: harness_wait finds the caller's own by its record.
    const viaMcp = (await agentOrigin(harness(d, { env: { HARNESS_VIA_MCP: '1' } }).deps))!
    const [mcpStep] = viaMcp.answer({ id: 'kid', name: 'reviewer' }, { local: false, machine: 'mini' }).next
    expect(mcpStep).toEqual({ run: 'harness_wait (names: "reviewer")', when: 'until it has answered; then read it: harness_read (name: "reviewer")' })
    expect(addressOf({ machineId: 'm', agentId: 'abcdef123456', name: 'so we have built harness web,', engine: 'claude' })).toBe('abcdef12')
    expect(addressOf({ machineId: 'm', agentId: 'abcdef123456', name: 'x'.repeat(41), engine: 'claude' })).toBe('abcdef12')
  })

  it('gives an agent outside Harness its limits and a header, records it by its session, and leaves out the reply', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('sh', { engine: 'terminal', tmuxPane: '%9' })]
    const claude = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'S1' }
    const h = harness(d, { pane: undefined, env: claude })
    const origin = (await agentOrigin(h.deps))!
    await expect(origin.check()).resolves.toBeUndefined()
    expect(origin.prompt('review it', 'm')).toBe('[from Claude Code outside Harness · studio, the agent that started you. It reads your answer itself.]\n\nreview it')
    expect(await origin.created('m', { id: 'kid', name: 'reviewer' })).toBeNull()
    expect(h.ledger.all()).toEqual([{ at: NOW, depth: 1, by: { machineId: 'm', agentId: 'claude-code:S1', name: 'Claude Code', engine: 'claude' }, child: { machineId: 'm', agentId: 'kid', name: 'reviewer' } }])
    // Nothing can message it: it has no pane. It has no place beside it either.
    expect(origin.answer({ id: 'kid', name: 'reviewer' }, { local: true, machine: null })).toEqual({
      effect: 'The person sees it in Harness.',
      next: [{ run: 'harness wait reviewer', when: 'until it has answered; then read it: harness show reviewer' }],
    })
    // In a person's terminal in Harness, it is still that agent.
    expect(await agentOrigin(harness(d, { pane: '%9', env: claude, where: () => ({ ...where, harnessPane: true }) }).deps)).not.toBeNull()
    // The daemon did not answer: refused, never the person.
    const down = (await agentOrigin(harness(d, { pane: undefined, env: claude, open: async () => { throw new Error('down') } }).deps))!
    await expect(down.check()).rejects.toThrow(/could not tell who is starting this/)
  })

  it('keeps the record on the other machine too, and says when that machine could not keep it', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' })]
    const h = harness(d)
    const asked: Array<[string, Record<string, unknown>]> = []
    const origin = (await agentOrigin(h.deps, async (target, payload) => { asked.push([target.machineId, payload]); return { recorded: true } }))!
    expect(await origin.created('mini', { id: 'far', name: 'gpu-job' })).toBeNull()
    expect(asked).toEqual([['mini', { action: 'started', row: expect.objectContaining({ depth: 1, child: { machineId: 'mini', agentId: 'far', name: 'gpu-job' } }) }]])
    const old = (await agentOrigin(h.deps, async () => { throw new Error('UNKNOWN_ACTION') }))!
    expect(await old.created('mini', { id: 'far2', name: '' })).toBe('The harness runs on a machine whose Harness did not record who started it: there, its limits start from zero.')
    expect(h.ledger.childrenOf({ machineId: 'm', agentId: 'lead' }).map((r) => r.child.agentId)).toEqual(['far', 'far2'])
  })

  it('refuses past the limits: depth, live harnesses per harness and per machine, and starts in ten minutes', () => {
    const l = new Ledger(ledgerPath(dir))
    const lead = { machineId: 'm', agentId: 'lead', name: 'lead', engine: 'claude' }
    const live = new Set(['m/lead'])
    expect(spawnRefusal(lead, live, l, 'm', NOW)).toBeNull()
    l.append({ at: NOW, depth: SPAWN_LIMITS.depth, by: { ...lead, agentId: 'up' }, child: { machineId: 'm', agentId: 'deep', name: 'deep' } })
    expect(spawnRefusal({ ...lead, agentId: 'deep' }, live, l, 'm', NOW)).toBe(DEPTH_REFUSAL)
    for (let i = 0; i < SPAWN_LIMITS.livePerHarness - 1; i++) {
      started(l, 'lead', `k${i}`, 'm', NOW - 3_600_000)
      live.add(`m/k${i}`)
    }
    started(l, 'lead', 'far', 'mini', NOW - 3_600_000)
    expect(spawnRefusal(lead, live, l, 'm', NOW)).toBeNull()
    live.add('mini/far')
    expect(spawnRefusal(lead, live, l, 'm', NOW)).toBe('You have 4 harnesses running. Close one you are done with first (harness close <name>).')
    const crowd = new Ledger(ledgerPath(mkdtempSync(join(dir, 'crowd-'))))
    const busy = new Set<string>()
    for (let i = 0; i < SPAWN_LIMITS.livePerMachine; i++) {
      crowd.append({ at: 0, depth: 1, by: { ...lead, agentId: `p${i}` }, child: { machineId: 'm', agentId: `c${i}`, name: `c${i}` } })
      busy.add(`m/c${i}`)
    }
    expect(spawnRefusal(lead, busy, crowd, 'm', NOW)).toMatch(/^Agents have 40 harnesses running on this machine/)
    const quick = new Ledger(ledgerPath(mkdtempSync(join(dir, 'quick-'))))
    for (let i = 0; i < SPAWN_LIMITS.perWindow; i++) started(quick, 'lead', `q${i}`, 'm', NOW - 60_000)
    expect(spawnRefusal(lead, new Set(), quick, 'm', NOW)).toBe('You started 20 harnesses in 10 minutes. Wait, or work with the ones you have.')
  })

  it('keeps a harness another agent started from starting more: four of its own at most, one level down', () => {
    // Owner, October 12: "be very careful about when to start a new agent so we don't waste user token". They were eight
    // and two levels: a harness an agent started could start more, and each of those spent the person's tokens.
    expect(SPAWN_LIMITS).toMatchObject({ livePerHarness: 4, depth: 1, livePerMachine: 40, perWindow: 20 })
    const l = new Ledger(ledgerPath(dir))
    const kid = { machineId: 'm', agentId: 'kid', name: 'kid', engine: 'codex' }
    // The person's harness: no line, no parent.
    expect(spawnRefusal(kid, new Set(), l, 'm', NOW)).toBeNull()
    // Its record says another agent started it.
    started(l, 'lead', 'kid')
    expect(spawnRefusal(kid, new Set(), l, 'm', NOW)).toBe('A harness another agent started may not start harnesses itself. Do the work yourself, or say in your answer what else is needed.')
    // The record lost its line, but the core's row names its starter.
    const lost = new Ledger(ledgerPath(mkdtempSync(join(dir, 'lost-'))))
    expect(spawnRefusal({ ...kid, startedByAgent: true }, new Set(), lost, 'm', NOW)).toBe(DEPTH_REFUSAL)
  })

  it('refuses a harness another agent started, from its pane, before anything is asked', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('kid', { parentAgentId: 'lead' })]
    const h = harness(d, { pane: '%kid' })
    const origin = (await agentOrigin(h.deps))!
    expect(origin.parentAgentId).toBe('kid')
    await expect(origin.check()).rejects.toThrow(DEPTH_REFUSAL)
    expect(d.requests.filter((r) => r.type === 'agent_create')).toEqual([])
    // Started from another machine, or by an agent outside Harness: no starter here, and no line in this machine's
    // record. The core's row still says another agent started it.
    d.frames = [frame('far', { startedBy: 'agent' })]
    await expect((await agentOrigin(harness(d, { pane: '%far' }).deps))!.check()).rejects.toThrow(DEPTH_REFUSAL)
  })

  it('counts harnesses asked for and still installing as running, toward every limit', () => {
    // Each starts by itself once its engine is installed: asked for meanwhile, they passed every limit and started at once.
    const lead = { machineId: 'm', agentId: 'lead', name: 'lead', engine: 'claude' }
    const waiting = (n: number, machineId = 'm', at = NOW) => Array.from({ length: n }, (_, i) => ({ at, depth: 1, by: lead,
      creation: { machineId, creationId: `w${i}`, name: `w${i}`, engine: 'codex' } }))
    const empty = new Ledger(ledgerPath(mkdtempSync(join(dir, 'waiting-'))))
    expect(spawnRefusal(lead, new Set(), empty, 'm', NOW, waiting(SPAWN_LIMITS.livePerHarness - 1))).toBeNull()
    expect(spawnRefusal(lead, new Set(), empty, 'm', NOW, waiting(SPAWN_LIMITS.livePerHarness)))
      .toBe('You have 4 harnesses running or starting. Close one you are done with first (harness close <name>).')
    const crowd = new Ledger(ledgerPath(mkdtempSync(join(dir, 'crowd-waiting-'))))
    const busy = new Set<string>()
    for (let i = 0; i < SPAWN_LIMITS.livePerMachine - 1; i++) {
      crowd.append({ at: 0, depth: 1, by: { ...lead, agentId: `p${i}` }, child: { machineId: 'm', agentId: `c${i}`, name: `c${i}` } })
      busy.add(`m/c${i}`)
    }
    expect(spawnRefusal(lead, busy, crowd, 'm', NOW, waiting(1, 'mini'))).toBeNull()
    expect(spawnRefusal(lead, busy, crowd, 'm', NOW, waiting(1))).toMatch(/^Agents have 39 harnesses running on this machine/)
    const quick = new Ledger(ledgerPath(mkdtempSync(join(dir, 'quick-waiting-'))))
    for (let i = 0; i < SPAWN_LIMITS.perWindow - SPAWN_LIMITS.livePerHarness + 1; i++) started(quick, 'lead', `q${i}`, 'm', NOW - 60_000)
    expect(spawnRefusal(lead, new Set(), quick, 'm', NOW, waiting(SPAWN_LIMITS.livePerHarness - 1))).toBe('You started 20 harnesses in 10 minutes. Wait, or work with the ones you have.')
    expect(spawnRefusal(lead, new Set(), quick, 'm', NOW, waiting(SPAWN_LIMITS.livePerHarness - 1, 'm', NOW - 11 * 60_000))).toBeNull()
  })

  it('counts what it started on other machines as those machines say, and a day of them when one cannot be asked', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead')]
    const mini = new FakeDaemon('mini')
    // Seven closed on mini: they free their places.
    mini.frames = [frame('alive'), ...Array.from({ length: 7 }, (_, i) => frame(`gone${i}`, { status: 'stopped' }))]
    const h = harness(d, { others: { mini } })
    started(h.ledger, 'lead', 'alive', 'mini')
    for (let i = 0; i < 7; i++) started(h.ledger, 'lead', `gone${i}`, 'mini')
    await expect((await agentOrigin(h.deps))!.check()).resolves.toBeUndefined()
    expect(mini.closed).toBe(true)
    // An old one is not asked about.
    started(h.ledger, 'lead', 'ancient', 'away', NOW - 8 * 24 * 3_600_000)
    // A machine that cannot be asked: its last day's starts count.
    for (let i = 0; i < 8; i++) started(h.ledger, 'lead', `x${i}`, 'offline', NOW - 3_600_000)
    await expect((await agentOrigin(h.deps))!.check()).rejects.toThrow(/You have 9 harnesses running/)
    const later = harness(d, { others: { mini }, now: () => NOW + 2 * 86_400_000 })
    await expect((await agentOrigin(later.deps))!.check()).resolves.toBeUndefined()
    const odd = new FakeDaemon('mini')
    odd.extra.agents_list = () => ({ agents: 'nope' })
    await expect((await agentOrigin(harness(d, { others: { mini: odd } }).deps))!.check()).rejects.toThrow(/You have 8 harnesses running/)
  })
})

describe('a harness asked for that has not started (its engine still installing)', () => {
  const asked = (ledger: Ledger, name: string, creationId: string, machineId = 'm', at = NOW) => ledger.append({
    at, depth: 1, by: { machineId: 'm', agentId: 'lead', name: 'lead', engine: 'claude' }, creation: { machineId, creationId, name, engine: 'codex' },
  })
  const installing = { state: 'pending', held: { service: 'install', detail: 'Installing Codex. The harness starts once it is installed.' } }

  it('lists it by its name as installing, and records it as the caller\'s once its machine has made it', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' })]
    const statuses: Record<string, Record<string, unknown>> = { c1: installing, c2: { state: 'cancelled' }, c3: { state: 'failed', failure: { code: 'ENGINE_INSTALL_FAILED', detail: 'Codex could not be installed: offline' } } }
    d.extra.agent_create_status = (p) => statuses[String(p.creationId)] ?? { state: 'missing' }
    const h = harness(d, { env: { HARNESS_VIA_MCP: '1' } })
    asked(h.ledger, 'cx', 'c1'); asked(h.ledger, 'gone', 'c2'); asked(h.ledger, 'broke', 'c3'); asked(h.ledger, 'old', 'c4', 'm', NOW - 31 * 60_000)
    expect(await psCommand([], h.deps)).toBe(EXIT.ok)
    const text = h.out.join('\n')
    expect(text).toMatch(/\ncx +Codex +installing +you \(you\)|\ncx +Codex +installing +you /)
    expect(text).toContain('cx has not started yet: Harness is installing Codex. It starts by itself; wait for it with harness_wait (names: "cx").')
    expect(text).toMatch(/\nbroke +Codex +failed +you /)
    expect(text).toContain('broke never started: Codex could not be installed: offline.')
    expect(text).not.toContain('gone')
    // A line older than any install is not asked after.
    expect(d.requests.filter((r) => r.type === 'agent_create_status').map((r) => r.payload.creationId)).toEqual(['c1', 'c2', 'c3'])
    // Made now: the caller's, by the creation it was asked for, and no longer listed as installing.
    statuses.c1 = { state: 'created', agent: frame('k1', { name: 'cx' }) }
    d.frames.push(frame('k1', { name: 'cx' }))
    h.out.length = 0
    expect(await psCommand([], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n')).toMatch(/\ncx +Codex +idle +you /)
    expect(h.ledger.parentOf({ machineId: 'm', agentId: 'k1' })).toMatchObject({ at: NOW, by: { agentId: 'lead' }, child: { name: 'cx', creationId: 'c1' } })
  })

  it('waits for it to start, then for its turn; says how one that never started ended, and one still installing', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' })]
    let asks = 0
    d.extra.agent_create_status = (p) => {
      if (p.creationId !== 'c1') return p.creationId === 'c2' ? { state: 'failed', failure: { code: 'ENGINE_INSTALL_FAILED', detail: 'Codex could not be installed: offline' } } : installing
      if (++asks < 4) return installing
      // Made: in the list from now on, as the daemon lists what it made.
      if (!d.frames.some((f) => f.id === 'k1')) d.frames.push(frame('k1', { name: 'cx' }))
      return { state: 'created', agent: frame('k1', { name: 'cx' }) }
    }
    d.pages.set('s-k1', [{ events: [ev('user_message', { content: 'go' }), ev('text_delta', { content: 'done' })], hasMore: false }])
    const h = harness(d)
    asked(h.ledger, 'cx', 'c1')
    expect(await waitCommand(['cx'], h.deps)).toBe(EXIT.ok)
    expect(h.out).toEqual(['cx: idle · read it: harness show cx'])
    expect(h.ledger.parentOf({ machineId: 'm', agentId: 'k1' })?.child.creationId).toBe('c1')
    asked(h.ledger, 'broke', 'c2')
    h.out.length = 0
    expect(await waitCommand(['broke'], h.deps)).toBe(EXIT.stopped)
    expect(h.out).toEqual(['broke: failed · it never started: Codex could not be installed: offline'])
    asked(h.ledger, 'slow', 'c3')
    h.out.length = 0
    expect(await waitCommand(['slow', '--timeout', '5s', '--json'], h.deps)).toBe(EXIT.timeout)
    expect(JSON.parse(h.out[0])).toEqual({ harnesses: [{ name: 'slow', id: 'c3', state: 'installing', detail: 'Installing Codex. The harness starts once it is installed.',
      next: [{ run: 'harness wait slow', when: 'to keep waiting' }] }] })
    h.out.length = 0
    expect(await waitCommand(['slow', '--timeout', '2s'], h.deps)).toBe(EXIT.timeout)
    expect(h.out).toEqual(['slow: installing · slow has not started yet: Harness is installing Codex. It starts by itself; wait for it with harness wait slow.'])
  })

  it('answers show with what it waits for, and close by cancelling it before it starts', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' })]
    let cancel: Record<string, unknown> = { state: 'cancelled' }
    d.extra.agent_create_status = () => installing
    d.extra.agent_create_cancel = () => cancel
    const h = harness(d)
    asked(h.ledger, 'cx', 'c1')
    expect(await showCommand(['cx'], h.deps)).toBe(EXIT.failed)
    expect(h.err).toEqual(['cx has not started yet: Harness is installing Codex. It starts by itself; wait for it with harness wait cx.'])
    expect(await closeCommand(['cx'], h.deps)).toBe(EXIT.ok)
    expect(h.out).toEqual(['Cancelled cx before it started.'])
    expect(d.requests.find((r) => r.type === 'agent_create_cancel')?.payload.creationId).toBe('c1')
    cancel = { state: 'unconfirmed' }
    h.err.length = 0
    expect(await closeCommand(['cx'], h.deps)).toBe(EXIT.failed)
    expect(h.err).toEqual(['cx is starting now, so it was not cancelled. Close it once it has: harness close cx.'])
  })

  it('follows one on another machine through that machine', async () => {
    const d = new FakeDaemon(), mini = new FakeDaemon('mini')
    d.frames = [frame('lead', { engine: 'claude' })]
    mini.extra.agent_create_status = () => ({ state: 'pending', held: { service: 'native', detail: 'Waiting to confirm the engine’s native hooks.' } })
    const h = harness(d, { others: { mini } })
    asked(h.ledger, 'far', 'c9', 'mini')
    expect(await psCommand([], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n')).toContain('far has not started yet: it is starting (Waiting to confirm the engine’s native hooks). It starts by itself; wait for it with harness wait far.')
    expect(mini.closed).toBe(true)
    // A machine that cannot be asked keeps it as starting.
    asked(h.ledger, 'away', 'c8', 'offline')
    h.out.length = 0
    expect(await psCommand([], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n')).toMatch(/\naway +Codex +starting +you /)
  })
})

describe('a harness that started by itself, recorded and followed', () => {
  const install = { state: 'pending', held: { service: 'install', detail: 'Installing Codex.' } }
  const asking = (ledger: Ledger, by: string, name: string, creationId: string, machineId = 'm') => ledger.append({
    at: NOW, depth: 1, by: { machineId: 'm', agentId: by, name: by, engine: 'claude' }, creation: { machineId, creationId, name, engine: 'codex' },
  })

  it('is recorded as started by who asked by any verb on its machine, there and on its own machine', async () => {
    const d = new FakeDaemon(), mini = new FakeDaemon('mini')
    d.frames = [frame('lead', { engine: 'claude' }), frame('kid', { name: 'kid' })]
    d.extra.agent_create_status = () => ({ state: 'created', agent: frame('kid') })
    mini.extra.agent_create_status = () => ({ state: 'created', agent: frame('far1', { name: 'far' }) })
    const sent: unknown[] = []
    // The person runs ps: the harness another agent asked for here is that agent's, and so is its depth.
    const h = harness(d, { pane: undefined, others: { mini }, record: async (to, body) => { sent.push([to, body]); return {} } })
    asking(h.ledger, 'other', 'kid', 'c1')
    asking(h.ledger, 'other', 'far', 'c2', 'mini')
    expect(await psCommand([], h.deps)).toBe(EXIT.ok)
    expect(h.ledger.parentOf({ machineId: 'm', agentId: 'kid' })).toMatchObject({ by: { agentId: 'other' }, child: { creationId: 'c1' } })
    expect(h.ledger.depthOf({ machineId: 'm', agentId: 'kid' })).toBe(1)
    // Another's on another machine is theirs to ask.
    expect(mini.requests).toEqual([])
    const mine = harness(d, { others: { mini }, record: async (to, body) => { sent.push([to, body]); return {} } })
    asking(mine.ledger, 'lead', 'far', 'c3', 'mini')
    expect(await psCommand([], mine.deps)).toBe(EXIT.ok)
    expect(mine.ledger.parentOf({ machineId: 'mini', agentId: 'far1' })?.child.creationId).toBe('c3')
    expect(sent).toEqual([[{ port: 1, dataDir: dir, machineId: 'mini' }, { action: 'started', row: expect.objectContaining({ child: expect.objectContaining({ agentId: 'far1', creationId: 'c3' }) }) }]])
    // Recorded once: asked again, nothing more is written or sent.
    expect(await psCommand([], mine.deps)).toBe(EXIT.ok)
    expect(mine.ledger.all().filter((row) => row.child.agentId === 'far1')).toHaveLength(1)
    expect(sent).toHaveLength(1)
  })

  it('is found by exactly its name before a running harness whose name only starts so, and by its creation when unnamed', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('reviewer-old', { name: 'reviewer-old' })]
    d.extra.agent_create_status = () => install
    const h = harness(d)
    started(h.ledger, 'lead', 'reviewer-old')
    asking(h.ledger, 'lead', 'reviewer', 'c1')
    asking(h.ledger, 'lead', '', 'abcdef123456')
    expect(await showCommand(['reviewer'], h.deps)).toBe(EXIT.failed)
    expect(h.err.at(-1)).toBe('reviewer has not started yet: Harness is installing Codex. It starts by itself; wait for it with harness wait reviewer.')
    expect(await psCommand([], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n')).toMatch(/\nabcdef12 +Codex +installing +you /)
    expect(await showCommand(['abcdef12'], h.deps)).toBe(EXIT.failed)
    expect(h.err.at(-1)).toBe('abcdef12 has not started yet: Harness is installing Codex. It starts by itself; wait for it with harness wait abcdef12.')
  })

  it('says how close went when the harness started meanwhile, never did, or could not be cancelled', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' })]
    let cancel: Record<string, unknown> = { state: 'created', agent: frame('k1') }
    d.extra.agent_create_status = () => install
    d.extra.agent_create_cancel = () => cancel
    const h = harness(d)
    asking(h.ledger, 'lead', 'cx', 'c1')
    expect(await closeCommand(['cx'], h.deps)).toBe(EXIT.failed)
    expect(h.err.at(-1)).toBe('cx is starting now, so it was not cancelled. Close it once it has: harness close cx.')
    cancel = { state: 'failed', failure: { code: 'ENGINE_INSTALL_FAILED', detail: 'Codex could not be installed: offline' } }
    expect(await closeCommand(['cx'], h.deps)).toBe(EXIT.failed)
    expect(h.err.at(-1)).toBe('cx never started: Codex could not be installed: offline. Nothing to close.')
    cancel = { error: 'UNSUPPORTED' }
    expect(await closeCommand(['cx', '--json'], h.deps)).toBe(EXIT.failed)
    expect(JSON.parse(h.out.at(-1)!)).toEqual({ error: 'UNSUPPORTED', detail: 'cx could not be cancelled (UNSUPPORTED). Check it with harness ps.' })
    cancel = {}
    expect(await closeCommand(['cx'], h.deps)).toBe(EXIT.failed)
    expect(h.err.at(-1)).toBe('cx could not be cancelled. Check it with harness ps.')
  })

  it('keeps waiting on one whose machine is out of reach for a moment', async () => {
    const d = new FakeDaemon(), mini = new FakeDaemon('mini')
    d.frames = [frame('lead', { engine: 'claude' })]
    let reachable = false
    mini.extra.agent_create_status = () => { if (!reachable) throw new AgentClientError('DISCONNECTED', 'gone'); return install }
    const h = harness(d, { others: { mini } })
    asking(h.ledger, 'lead', 'far', 'c9', 'mini')
    const waited = waitCommand(['far', '--timeout', '6s'], h.deps)
    expect(await waited).toBe(EXIT.timeout)
    expect(h.out).toEqual(['far: starting · far has not started yet: it is starting. It starts by itself; wait for it with harness wait far.'])
    reachable = true
    expect(await waitCommand(['far', '--timeout', '2s'], h.deps)).toBe(EXIT.timeout)
    expect(h.out.at(-1)).toBe('far: installing · far has not started yet: Harness is installing Codex. It starts by itself; wait for it with harness wait far.')
  })
})

describe('an agent asking again for a harness it already has', () => {
  it('is answered with the one still installing or running by that name, and starts a new one otherwise', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('k1', { name: 'reviewer' }), frame('k2', { name: 'old', status: 'stopped' })]
    d.extra.agent_create_status = (p) => p.creationId === 'c1' ? { state: 'pending', held: { service: 'install', detail: 'Installing Codex.' } }
      : { state: 'failed', failure: { code: 'ENGINE_INSTALL_FAILED', detail: 'offline' } }
    const h = harness(d, { env: { HARNESS_VIA_MCP: '1' } })
    h.ledger.append({ at: NOW, depth: 1, by: { machineId: 'm', agentId: 'lead', name: 'lead', engine: 'claude' }, creation: { machineId: 'm', creationId: 'c1', name: 'cx', engine: 'codex' } })
    h.ledger.append({ at: NOW, depth: 1, by: { machineId: 'm', agentId: 'lead', name: 'lead', engine: 'claude' }, creation: { machineId: 'm', creationId: 'c2', name: 'broke', engine: 'codex' } })
    started(h.ledger, 'lead', 'k1', 'm', NOW - 3 * 60_000)
    h.ledger.append({ at: NOW - 2 * 60_000, depth: 1, by: { machineId: 'm', agentId: 'lead', name: 'lead', engine: 'claude' }, child: { machineId: 'm', agentId: 'k1', name: 'reviewer' } })
    started(h.ledger, 'lead', 'k2', 'm', NOW - 60_000)
    const origin = (await agentOrigin(h.deps))!
    const codexHere = { machineId: 'm', engine: 'codex' }
    expect(await origin.existing!('CX', codexHere)).toEqual({ name: 'cx', machineId: 'm', state: 'starting',
      note: '"cx" is already starting: Harness is installing Codex. It starts by itself; wait for it with harness_wait (names: "cx"). Do not start it again.' })
    expect(await origin.existing!('reviewer', codexHere)).toEqual({ name: 'reviewer', machineId: 'm', agentId: 'k1', state: 'running',
      note: '"reviewer" is already running: you started it 2 min ago. Wait for it with harness_wait (names: "reviewer") or read it with harness_read (name: "reviewer"). '
        + 'Do not start it again; to start a new one by that name, close it first (harness_close (name: "reviewer")).' })
    // A store harness is judged by the machine alone: it is recorded by the engine it runs on.
    expect(await origin.existing!('cx', { machineId: 'm', engine: 'acme/notes' })).toMatchObject({ name: 'cx' })
    // One that never started, one stopped, one by another name, none at all, another agent or machine: started anew.
    for (const name of ['broke', 'k2', 'other', null, ' ']) expect(await origin.existing!(name, codexHere)).toBeNull()
    expect(await origin.existing!('cx', { machineId: 'm', engine: 'claude' })).toBeNull()
    expect(await origin.existing!('reviewer', { machineId: 'm', engine: 'claude' })).toBeNull()
    expect(await origin.existing!('cx', { machineId: 'mini', engine: 'codex' })).toBeNull()
    // Started more than ten minutes ago: new work by an old name, not a retry.
    const later = harness(d, { env: {}, now: () => NOW + 11 * 60_000 })
    expect(await (await agentOrigin(later.deps))!.existing!('reviewer', codexHere)).toBeNull()
  })

  // Asked again two seconds later, an agent was told it had started it "1 min ago".
  it('says a harness started under a minute ago was started just now', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('k1', { name: 'pong' })]
    const h = harness(d)
    h.ledger.append({ at: NOW - 2_000, depth: 1, by: { machineId: 'm', agentId: 'lead', name: 'lead', engine: 'claude' }, child: { machineId: 'm', agentId: 'k1', name: 'pong' } })
    expect((await (await agentOrigin(h.deps))!.existing!('pong', { machineId: 'm', engine: 'codex' }))?.note)
      .toMatch(/^"pong" is already running: you started it just now\. /)
    const minute = harness(d, { now: () => NOW + 58_000 })
    expect((await (await agentOrigin(minute.deps))!.existing!('pong', { machineId: 'm', engine: 'codex' }))?.note)
      .toMatch(/you started it 1 min ago\. /)
  })

  it('records a harness asked for before it starts, and its creation once it has', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' })]
    const h = harness(d)
    const origin = (await agentOrigin(h.deps))!
    origin.pending!('m', { creationId: 'c5', name: 'cx', engine: 'codex' })
    expect(h.ledger.pendingOf({ machineId: 'm', agentId: 'lead' }, NOW)).toEqual([{ at: NOW, depth: 1,
      by: { machineId: 'm', agentId: 'lead', name: 'lead', engine: 'claude' }, creation: { machineId: 'm', creationId: 'c5', name: 'cx', engine: 'codex' } }])
    await origin.created('m', { id: 'k5', name: 'cx' }, 'c5')
    expect(h.ledger.pendingOf({ machineId: 'm', agentId: 'lead' }, NOW)).toEqual([])
    expect(h.ledger.parentOf({ machineId: 'm', agentId: 'k5' })?.child).toEqual({ machineId: 'm', agentId: 'k5', name: 'cx', creationId: 'c5' })
  })
})

describe('a harness on another machine, named with --machine', () => {
  // The lamp (lamp-4ace, 2026-10-14 21:36): a program outside Harness ran `harness new claude @office lamp-first-task`,
  // then could not read the answer with `show` or `wait`. It is the person here: no pane, no agent in its shell.
  const machines = async () => [
    { machineId: 'm', label: 'studio', status: 'online', current: true },
    { machineId: 'office-id', label: 'office', status: 'online', current: false },
    { machineId: 'mini-id', label: 'Mac mini', status: 'online', current: false },
  ]
  const answered = [{ events: [ev('user_message', { content: 'What is 2+2?' }), ev('text_delta', { content: 'Four.' })], hasMore: false }]
  const lamp = () => {
    const d = new FakeDaemon(), office = new FakeDaemon('office-id')
    office.frames = [frame('lamp-first-task', { engine: 'claude' })]
    office.pages.set('s-lamp-first-task', answered)
    return { d, office, h: harness(d, { pane: undefined, machines, others: { 'office-id': office } }) }
  }

  it('shows it through that machine, which a name alone does not reach', async () => {
    const { d, office, h } = lamp()
    expect(await showCommand(['lamp-first-task'], h.deps)).toBe(EXIT.failed)
    expect(h.err[0]).toMatch(/^No harness named "lamp-first-task" on this machine\. .*add --machine <name>/)
    expect(await showCommand(['--machine', 'office', 'lamp-first-task', '--json'], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({ name: 'lamp-first-task', machine: 'office', state: 'idle', startedBy: 'person', ask: 'What is 2+2?', answer: 'Four.' })
    expect(office.requests.map((r) => r.type)).toEqual(['agents_list', 'agent_close', 'session_get'])
    expect(office.closed).toBe(true)
    expect(d.closed).toBe(true)
    // The option after the name or before it, `--machine=`, a name's start, and a machine by its id or the start of its
    // name.
    h.out.length = 0
    expect(await showCommand(['lamp', '--machine=office-id'], h.deps)).toBe(EXIT.ok)
    expect(h.out[0]).toBe('lamp-first-task on office: idle · Claude Code · started by person')
    expect(h.out).toContain('Four.')
    // More of the answer is asked for on that machine too, as it was named.
    h.out.length = 0
    expect(await showCommand(['--machine', 'off', 'lamp-first-task', '--chars', '2'], h.deps)).toBe(EXIT.ok)
    expect(h.out.at(-1)).toBe('… 3 more characters: harness show --machine off lamp-first-task --chars 5')
  })

  it('refuses the old @machine with what to type, before asking any machine', async () => {
    const { d, office, h } = lamp()
    expect(await showCommand(['@office', 'lamp-first-task'], h.deps)).toBe(EXIT.usage)
    expect(h.err[0]).toBe('Name the machine with --machine office.')
    expect(await waitCommand(['lamp-first-task', '@Mac mini'], h.deps)).toBe(EXIT.usage)
    expect(h.err).toContain('Name the machine with --machine "Mac mini".')
    expect(await psCommand(['@'], h.deps)).toBe(EXIT.usage)
    expect(h.err).toContain('Name the machine with --machine <name>.')
    expect(d.requests).toEqual([])
    expect(office.requests).toEqual([])
  })

  it('reads this machine as without --machine, and says what it cannot find there or which machine it does not know', async () => {
    const { d, office, h } = lamp()
    d.frames = [frame('here')]
    expect(await showCommand(['--machine', 'studio', 'here', '--json'], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({ name: 'here', machine: 'studio' })
    expect(office.requests).toEqual([])
    expect(await showCommand(['--machine', 'office', 'nobody'], h.deps)).toBe(EXIT.failed)
    expect(h.err.at(-1)).toBe('No harness named "nobody" on office. `harness ps --machine office` lists them.')
    expect(await showCommand(['--machine', 'nowhere', 'x', '--json'], h.deps)).toBe(EXIT.failed)
    expect(JSON.parse(h.out.at(-1)!)).toEqual({ error: 'UNKNOWN_MACHINE', detail: 'No machine called “nowhere”. Yours: studio, office, Mac mini.' })
    // A machine that is not linked here says so.
    expect(await showCommand(['--machine', 'mini', 'x'], h.deps)).toBe(EXIT.failed)
    expect(h.err.at(-1)).toBe('not linked')
    expect(await showCommand(['x', '--machine'], h.deps)).toBe(EXIT.usage)
    expect(await showCommand(['--machine', '--json', 'x'], h.deps)).toBe(EXIT.usage)
    expect(await showCommand(['--machine=', 'x'], h.deps)).toBe(EXIT.usage)
    expect(h.err.filter((l) => l === '--machine needs a value.')).toHaveLength(3)
    expect(await showCommand(['--machine', 'office', '--machine', 'mini', 'x'], h.deps)).toBe(EXIT.usage)
    expect(h.err).toContain('Name one machine.')
    // Without the account's machines to resolve it against, it is refused rather than guessed.
    const bare = harness(d, { pane: undefined })
    expect(await showCommand(['--machine', 'office', 'x'], bare.deps)).toBe(EXIT.failed)
    expect(bare.err).toEqual(['Harness could not list your machines here.'])
  })

  it('waits on it through that machine, every name there, and names the next step with its machine', async () => {
    const { office, h } = lamp()
    office.frames.push(frame('second'))
    office.screens.set('lamp-first-task', ['working', 'idle'])
    office.pages.set('s-second', answered)
    expect(await waitCommand(['--machine', 'office', 'lamp-first-task,second'], h.deps)).toBe(EXIT.ok)
    expect(h.out).toEqual(['lamp-first-task: idle · read it: harness show --machine office lamp-first-task', 'second: idle · read it: harness show --machine office second'])
    expect(office.closed).toBe(true)
    // A machine with a space in its name is quoted.
    const mini = new FakeDaemon('mini-id')
    mini.frames = [frame('gpu')]
    mini.pages.set('s-gpu', answered)
    const spaced = harness(new FakeDaemon(), { pane: undefined, machines, others: { 'mini-id': mini } })
    expect(await waitCommand(['--machine', 'Mac mini', 'gpu'], spaced.deps)).toBe(EXIT.ok)
    expect(spaced.out).toEqual(['gpu: idle · read it: harness show --machine "Mac mini" gpu'])
  })

  // Review of #1333: each name opened its own connection there, and a second name for the same harness was dropped
  // with its connection still open, holding the process after it printed.
  it('closes every connection it opens there, a name given twice or by its start included', async () => {
    const { office, h } = lamp()
    const opened: Array<{ closed: boolean }> = []
    const open: ClientDeps['open'] = async (w, machineId) => {
      if (machineId !== 'office-id') return h.deps.open!(w, machineId)
      const line = { machineId: 'office-id', closed: false, request: (type: string, payload?: Record<string, unknown>) => office.request(type, payload), close() { this.closed = true } }
      opened.push(line)
      return line as unknown as Daemon
    }
    expect(await waitCommand(['--machine', 'office', 'lamp-first-task,lamp,lamp-first-task'], { ...h.deps, open })).toBe(EXIT.ok)
    expect(h.out).toEqual(['lamp-first-task: idle · read it: harness show --machine office lamp-first-task'])
    expect(opened.length).toBeGreaterThan(1)
    expect(opened.filter((line) => !line.closed)).toEqual([])
  })

  it('lists that machine\'s harnesses, asking it what each is about', async () => {
    const { d, office, h } = lamp()
    d.frames = [frame('local-one')]
    expect(await psCommand(['--machine', 'office'], h.deps)).toBe(EXIT.ok)
    const text = h.out.join('\n')
    expect(text).toMatch(/^NAME +AGENT/)
    expect(text).toMatch(/lamp-first-task +Claude Code +idle +person /)
    expect(text).toContain('lamp-first-task recap')
    expect(text).not.toContain('local-one')
    expect(office.requests.filter((r) => r.type === 'agent_recent').map((r) => r.payload.agentId)).toEqual(['lamp-first-task'])
    expect(d.requests.filter((r) => r.type === 'agent_recent')).toEqual([])
    expect(office.closed).toBe(true)
    h.out.length = 0
    expect(await psCommand(['--machine', 'office', '--json'], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({ you: null, machine: 'office', harnesses: [{ name: 'lamp-first-task', machine: 'office' }] })
    office.frames = []
    h.out.length = 0
    expect(await psCommand(['--machine', 'office'], h.deps)).toBe(EXIT.ok)
    expect(h.out).toEqual(['No harnesses on office.'])
    expect(await psCommand(['--machine', 'office', 'x'], h.deps)).toBe(EXIT.usage)
    expect(h.err[0]).toBe('harness ps takes no names. To read one: harness show --machine office x')
  })

  it('closes one there as here: the person anything, an agent only what it started', async () => {
    const { d, office, h } = lamp()
    expect(await closeCommand(['--machine', 'office', 'lamp-first-task'], h.deps)).toBe(EXIT.ok)
    expect(h.out).toEqual(['lamp-first-task on office: closed. Its conversation is kept; the person can resume it.'])
    expect(office.requests.at(-1)).toMatchObject({ type: 'agent_close', payload: { agentId: 'lamp-first-task', mode: 'idle' } })
    // One still working is waited for on its machine.
    office.extra.agent_close = (p) => (p.mode === 'inspect' ? { activity: 'working' } : { error: 'SESSION_NOT_IDLE', activity: 'working' })
    expect(await closeCommand(['--machine', 'office', 'lamp-first-task'], h.deps)).toBe(EXIT.failed)
    expect(h.err.at(-1)).toBe('lamp-first-task is working. Wait for it (harness wait --machine office lamp-first-task), or close it anyway with --now.')
    delete office.extra.agent_close
    // An agent in a pane here: `--machine office` gives it no more than it has here.
    d.frames = [frame('lead', { engine: 'claude' })]
    office.frames.push(frame('kid'))
    const agent = harness(d, { machines, others: { 'office-id': office } })
    expect(await closeCommand(['--machine', 'office', 'lamp-first-task'], agent.deps)).toBe(EXIT.refused)
    expect(agent.err[0]).toBe('You did not start lamp-first-task, so you may not close it. Only the person can.')
    started(agent.ledger, 'lead', 'kid', 'office-id')
    expect(await closeCommand(['--machine', 'office', 'kid'], agent.deps)).toBe(EXIT.ok)
    expect(office.requests.at(-1)).toMatchObject({ type: 'agent_close', payload: { agentId: 'kid' } })
  })

  it('follows an agent\'s harness that has not started on that machine, and only that machine\'s', async () => {
    const d = new FakeDaemon(), office = new FakeDaemon('office-id')
    d.frames = [frame('lead', { engine: 'claude' })]
    const launching = () => ({ state: 'pending', held: { service: 'launch', detail: 'Waiting for launch preparation.' } })
    office.extra.agent_create_status = launching
    d.extra.agent_create_status = launching
    const h = harness(d, { machines, others: { 'office-id': office } })
    const asked = (name: string, creationId: string, machineId: string) => h.ledger.append({
      at: NOW, depth: 1, by: { machineId: 'm', agentId: 'lead', name: 'lead', engine: 'claude' }, creation: { machineId, creationId, name, engine: 'codex' },
    })
    asked('far', 'c1', 'office-id'); asked('near', 'c2', 'm')
    expect(await psCommand(['--machine', 'office'], h.deps)).toBe(EXIT.ok)
    const text = h.out.join('\n')
    expect(text).toMatch(/\nfar +Codex +starting +you /)
    expect(text).toContain('far has not started yet: it is starting (Waiting for launch preparation). It starts by itself; wait for it with harness wait --machine office far.')
    expect(text).not.toContain('near')
    expect(await showCommand(['--machine', 'office', 'far'], h.deps)).toBe(EXIT.failed)
    expect(h.err.at(-1)).toBe('far has not started yet: it is starting (Waiting for launch preparation). It starts by itself; wait for it with harness wait --machine office far.')
    // `near` is starting on this machine, not office.
    expect(await showCommand(['--machine', 'office', 'near'], h.deps)).toBe(EXIT.failed)
    expect(h.err.at(-1)).toBe('No harness named "near" on office. `harness ps --machine office` lists them.')
  })
})

describe('spawnCheck and spawnCount', () => {
  const lead = { machineId: 'm', agentId: 'lead', name: 'lead', engine: 'claude' }

  it('counts what the limits count, and names the limit that refuses', () => {
    const ledger = new Ledger(ledgerPath(dir))
    for (const kid of ['a', 'b', 'c', 'd']) started(ledger, 'lead', kid)
    const live = new Set(['m/a', 'm/b', 'm/c', 'm/d'])
    expect(spawnCount(lead, live, ledger, NOW)).toEqual({ open: 4, starts: 4, depth: 0, oldestStartAt: NOW })
    expect(spawnCheck(lead, live, ledger, 'm', NOW)).toEqual({ reason: 'OPEN_LIMIT', message: spawnRefusal(lead, live, ledger, 'm', NOW) })
    expect(spawnCheck(lead, new Set(['m/a']), ledger, 'm', NOW)).toBeNull()
    expect(spawnCheck({ ...lead, startedByAgent: true }, new Set(), ledger, 'm', NOW)).toEqual({ reason: 'DEPTH', message: DEPTH_REFUSAL })
  })

  it('names the start rate, and the oldest start in the window', () => {
    const ledger = new Ledger(ledgerPath(dir))
    for (let i = 0; i < SPAWN_LIMITS.perWindow; i++) started(ledger, 'lead', `k${i}`, 'm', NOW - 60_000 + i)
    expect(spawnCheck(lead, new Set(), ledger, 'm', NOW)?.reason).toBe('START_RATE')
    expect(spawnCount(lead, new Set(), ledger, NOW)).toMatchObject({ open: 0, starts: SPAWN_LIMITS.perWindow, oldestStartAt: NOW - 60_000 })
  })
})

describe('harness whoami', () => {
  /** The account's machines as this computer's daemon keeps them (`<data>/machines.json`, device/machineList.ts). */
  const cacheMachines = (owner = TEST_ACCOUNT.machineId) => writeFileSync(join(dir, 'machines.json'), JSON.stringify({
    machines: [
      { machineId: 'm', name: 'studio', state: 'ready', local: true },
      { machineId: 'o', name: 'office', state: 'ready', local: false },
      { machineId: 'b', name: 'box', state: 'offline', local: false },
    ],
    bodyOwner: owner, fetchedAt: NOW,
  }))
  /** The account's machines from the backend: the block must never ask for them. */
  const network = () => { const asked = { n: 0 }; return { asked, machines: () => { asked.n++; return new Promise<never>(() => {}) } } }

  it('tells an agent in a pane who and where it is, that it may start, and its counts', async () => {
    cacheMachines()
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('kid')]
    const net = network()
    const h = harness(d, { machines: net.machines })
    started(h.ledger, 'lead', 'kid')
    expect(await whoamiCommand([], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n')).toBe([
      'You: Claude Code "lead" (lead), inside Harness, on studio.',
      'Can start harnesses: yes.',
      'Yours: 1 open of 4 · 1 of 20 starts in the last 10 minutes · other machines: office (running), box (offline)',
    ].join('\n'))
    expect(d.closed).toBe(true)
    // The list the daemon keeps, never the backend: a request left open held the process for 10 to 35 s (review).
    expect(net.asked.n).toBe(0)
  })

  it('lists no machines from a list another account\'s daemon kept', async () => {
    cacheMachines('another-account')
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' })]
    const h = harness(d)
    expect(await whoamiCommand([], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n')).not.toContain('other machines')
  })

  it('says the switch is off, and gives the context as JSON', async () => {
    setAgentSettingsForTest(dir, { agentsStartAgents: false })
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' })]
    const h = harness(d)
    expect(await whoamiCommand(['--json'], h.deps)).toBe(EXIT.ok)
    const { context } = JSON.parse(h.out.join('\n'))
    expect(context.canStart).toEqual({ ok: false, reason: 'SWITCH_OFF', message: 'The person has not turned on "Agents can start other agents".', fix: 'harness settings agents-start-agents on --person-said-yes', fixBy: 'person' })
    expect(context.machines).toEqual([])
  })

  it('signed out: says to sign in first, and lists no machines', async () => {
    cacheMachines()
    signedOutForTest()
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' })]
    const h = harness(d)
    expect(await whoamiCommand([], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n').split('\n')[1]).toMatch(/^Can start harnesses: no\. This computer is signed out of Harness/)
    expect(h.out.join('\n')).not.toContain('other machines')
  })

  it('ps asks the network nothing for the block, an agent\'s or a person\'s', async () => {
    cacheMachines()
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' })]
    for (const over of [{}, { pane: undefined }]) {
      const net = network()
      const h = harness(d, { machines: net.machines, ...over })
      expect(await psCommand([], h.deps)).toBe(EXIT.ok)
      expect(net.asked.n).toBe(0)
    }
  })

  it('says why when Harness cannot be reached, as ps does', async () => {
    const h = harness(new FakeDaemon(), { open: async () => { throw new AgentClientError('DAEMON_UNREACHABLE', 'Harness is not running here.') } })
    expect(await whoamiCommand([], h.deps)).toBe(EXIT.failed)
    expect(h.err).toEqual(['Harness is not running here.'])
  })

  it('takes no names and no --machine', async () => {
    const h = harness(new FakeDaemon())
    expect(await whoamiCommand(['x'], h.deps)).toBe(EXIT.usage)
    expect(h.err[0]).toBe('harness whoami takes no names and no --machine: it is about you, here.')
  })
})

describe('a cloud harness (#1444)', () => {
  const cloud = (id: string, state: string, over: Partial<Frame> = {}) => frame(id, {
    engine: 'devin-cloud', location: 'cloud', tmuxPane: null, project: null, sessionId: id,
    activity: { state: state === 'working' || state === 'starting' ? 'working' : 'idle' },
    cloud: { state, links: [{ label: 'Session', url: 'https://app.devin.ai/sessions/1' }] }, ...over,
  })
  const transcript = (d: FakeDaemon, messages: Array<{ from: string; text: string }>) => {
    d.extra.cloud_transcript = () => ({ messages: messages.map((m, i) => ({ id: String(i), at: '', ...m })), total: messages.length })
  }

  it('shows its state from the cloud, its last words and its links, reading no screen', async () => {
    const d = new FakeDaemon()
    d.frames = [cloud('devin', 'idle')]
    transcript(d, [{ from: 'person', text: 'old' }, { from: 'agent', text: 'old answer' }, { from: 'person', text: 'reply to the thread' }, { from: 'agent', text: 'On it.' }, { from: 'agent', text: 'Replied.' }])
    const h = harness(d)
    expect(await showCommand(['devin', '--json'], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({ state: 'idle', ask: 'reply to the thread', answer: 'On it.\n\nReplied.',
      links: [{ label: 'Session', url: 'https://app.devin.ai/sessions/1' }] })
    expect(d.requests.some((r) => r.type === 'agent_close' || r.type === 'session_get')).toBe(false)
    const text = harness(d)
    expect(await showCommand(['devin'], text.deps)).toBe(EXIT.ok)
    expect(text.out).toContain('Session: https://app.devin.ai/sessions/1')
  })

  it('says it needs the person while it asks, though its frame says idle, and how the answer goes to it', async () => {
    const d = new FakeDaemon()
    d.frames = [cloud('devin', 'needs_input')]
    transcript(d, [{ from: 'person', text: 'go' }, { from: 'agent', text: 'Which branch?' }])
    const h = harness(d)
    expect(await showCommand(['devin', '--json'], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({ state: 'needs-input', needsPerson: true, answer: 'Which branch?',
      next: [{ run: "harness reply devin -- <the person's answer>" }] })
    const w = harness(d)
    expect(await waitCommand(['devin'], w.deps)).toBe(EXIT.needsInput)
  })

  it('waits while it starts and works, and returns when it is done or failed', async () => {
    const d = new FakeDaemon()
    const states = ['starting', 'working', 'working', 'idle']
    d.extra.agents_list = () => ({ agents: [cloud('devin', states.length > 1 ? states.shift()! : states[0])] })
    const h = harness(d)
    expect(await waitCommand(['devin'], h.deps)).toBe(EXIT.ok)
    expect(h.out).toEqual(['devin: idle · read it: harness show devin'])
    expect(d.requests.some((r) => r.type === 'agent_close')).toBe(false)
    d.extra.agents_list = () => ({ agents: [cloud('devin', 'failed')] })
    const f = harness(d)
    expect(await waitCommand(['devin', '--json'], f.deps)).toBe(EXIT.stopped)
    expect(JSON.parse(f.out.join('\n')).harnesses[0].state).toBe('failed')
  })

  it('replies with the person\'s words, and refuses an agent, a terminal harness and no words', async () => {
    const d = new FakeDaemon()
    d.frames = [cloud('devin', 'needs_input'), frame('kid')]
    const sent: Record<string, unknown>[] = []
    d.extra.cloud_send = (payload) => { sent.push(payload); return { ok: true } }
    const h = harness(d)
    expect(await replyCommand(['devin', '--', 'the', 'release', 'branch'], h.deps)).toBe(EXIT.ok)
    expect(sent).toEqual([{ agentId: 'devin', text: 'the release branch' }])
    expect(h.out.join('\n')).toMatch(/^Sent to devin\.\nNext: harness wait devin/)
    expect(await replyCommand(['kid', '--', 'x'], harness(d).deps)).toBe(EXIT.usage)
    expect(await replyCommand(['devin'], harness(d).deps)).toBe(EXIT.usage)
    d.extra.cloud_send = () => ({ error: 'CLOUD_FAILED', detail: 'Devin Cloud is still working.' })
    const busy = harness(d)
    expect(await replyCommand(['devin', '--', 'x'], busy.deps)).not.toBe(EXIT.ok)
    expect(busy.err.join('\n')).toMatch(/still working/)
    d.frames.push(frame('lead'))
    const before = d.requests.length
    const agent = harness(d)
    expect(await replyCommand(['devin', '--', 'x'], agent.deps)).toBe(EXIT.refused)
    expect(d.requests.slice(before).some((r) => r.type === 'cloud_send')).toBe(false)
    // The agent is told to tell the person, never to run the reply it would be refused.
    const shown = harness(d)
    expect(await showCommand(['devin', '--json'], shown.deps)).toBe(EXIT.ok)
    expect(JSON.parse(shown.out.join('\n')).next).toEqual([{ tell: expect.stringMatching(/tell the person/) }])
  })

  it('says a failed one failed in the cloud, shows nothing read when its conversation cannot be read, and will not close one', async () => {
    const d = new FakeDaemon()
    d.frames = [cloud('devin', 'failed')]
    const w = harness(d)
    expect(await waitCommand(['devin'], w.deps)).toBe(EXIT.stopped)
    expect(w.out).toEqual(['devin: failed · it failed in the cloud; what it said and its links: harness show devin'])
    d.extra.cloud_transcript = () => ({ error: 'SERVICE_UNAVAILABLE' })
    const s = harness(d)
    expect(await showCommand(['devin'], s.deps)).toBe(EXIT.ok)
    expect(s.out).toContain('No turn yet.')
    const c = harness(d)
    expect(await closeCommand(['devin'], c.deps)).toBe(EXIT.usage)
    expect(c.err.join('\n')).toMatch(/stop it in Harness/)
    expect(d.requests.some((r) => r.type === 'agent_close' && r.payload.mode !== 'inspect')).toBe(false)
  })

  it('shows the maker\'s status in show and ps --all, and leaves Fo, Cursor and a local harness as they were', async () => {
    const d = new FakeDaemon()
    d.frames = [
      cloud('asleep', 'stopped', { status: 'stopped', cloud: { state: 'stopped', activity: 'Devin went to sleep after inactivity.', providerStatus: { status: 'suspended', detail: 'inactivity' }, links: [] } }),
      cloud('halted', 'stopped', { status: 'stopped', cloud: { state: 'stopped', activity: 'The session was stopped by request.', providerStatus: { status: 'suspended', detail: 'user_request' }, links: [] } }),
      cloud('done', 'idle', { cloud: { state: 'idle', activity: null, providerStatus: { status: 'exit', detail: null }, links: [] } }),
      cloud('fo', 'idle', { engine: 'fo', cloud: { state: 'idle', activity: 'Calling Hair Lab', links: [] } }),
      cloud('cursor', 'working', { engine: 'cursor-cloud', cloud: { state: 'working', links: [] } }),
      frame('local'),
    ]
    const listed = harness(d, { pane: undefined })
    expect(await psCommand(['--json'], listed.deps)).toBe(EXIT.ok)
    expect(JSON.parse(listed.out[0]).harnesses.map((r: { name: string }) => r.name)).not.toContain('asleep')
    const all = harness(d, { pane: undefined })
    expect(await psCommand(['--all', '--json'], all.deps)).toBe(EXIT.ok)
    const byName = Object.fromEntries(JSON.parse(all.out[0]).harnesses.map((r: { name: string }) => [r.name, r]))
    expect(byName.asleep.cloud).toEqual({ state: 'stopped', activity: 'Devin went to sleep after inactivity.', providerStatus: { status: 'suspended', detail: 'inactivity' } })
    expect(byName.halted.cloud).toEqual({ state: 'stopped', activity: 'The session was stopped by request.', providerStatus: { status: 'suspended', detail: 'user_request' } })
    expect(byName.done.cloud.providerStatus).toEqual({ status: 'exit', detail: null })
    expect(byName.fo.cloud).toEqual({ state: 'idle', activity: 'Calling Hair Lab' })
    expect(byName.cursor.cloud).toEqual({ state: 'working', activity: null })
    expect(byName.local).not.toHaveProperty('cloud')
    const shown = harness(d, { pane: undefined })
    expect(await showCommand(['halted', '--json'], shown.deps)).toBe(EXIT.ok)
    expect(JSON.parse(shown.out.join('\n')).cloud).toEqual({ state: 'stopped', activity: 'The session was stopped by request.', providerStatus: { status: 'suspended', detail: 'user_request' } })
    const fo = harness(d, { pane: undefined })
    expect(await showCommand(['fo', '--json'], fo.deps)).toBe(EXIT.ok)
    expect(JSON.parse(fo.out.join('\n')).cloud).toEqual({ state: 'idle', activity: 'Calling Hair Lab' })
    expect(JSON.parse(fo.out.join('\n'))).not.toHaveProperty('cloud.providerStatus')
    const local = harness(d, { pane: undefined })
    expect(await showCommand(['local', '--json'], local.deps)).toBe(EXIT.ok)
    expect(JSON.parse(local.out.join('\n'))).not.toHaveProperty('cloud')
  })

  it('waits on the frame it ended on, including one that left the live list', async () => {
    const steps = [
      cloud('devin', 'starting', { cloud: { state: 'starting', activity: null, providerStatus: { status: 'new', detail: null }, links: [] } }),
      cloud('devin', 'working', { cloud: { state: 'working', activity: null, providerStatus: { status: 'running', detail: 'working' }, links: [] } }),
      cloud('devin', 'idle', { cloud: { state: 'idle', activity: null, providerStatus: { status: 'running', detail: 'finished' }, links: [] } }),
    ]
    const d = new FakeDaemon()
    d.extra.agents_list = () => ({ agents: [steps.length > 1 ? steps.shift()! : steps[0]!] })
    const h = harness(d)
    expect(await waitCommand(['devin', '--json'], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out.join('\n')).harnesses[0]).toMatchObject({ state: 'idle', cloud: { state: 'idle', providerStatus: { status: 'running', detail: 'finished' } } })
    const asking = new FakeDaemon()
    asking.frames = [cloud('devin', 'needs_input', { cloud: { state: 'needs_input', activity: null, providerStatus: { status: 'running', detail: 'waiting_for_approval' }, links: [] } })]
    const w = harness(asking)
    expect(await waitCommand(['devin', '--json'], w.deps)).toBe(EXIT.needsInput)
    expect(JSON.parse(w.out.join('\n')).harnesses[0]).toMatchObject({ state: 'needs-input', needsPerson: true, cloud: { providerStatus: { status: 'running', detail: 'waiting_for_approval' } } })
    const gone = new FakeDaemon()
    const live = cloud('devin', 'working', { cloud: { state: 'working', activity: null, providerStatus: { status: 'running', detail: 'working' }, links: [] } })
    const stopped = cloud('devin', 'stopped', { status: 'stopped', cloud: { state: 'stopped', activity: 'The session was stopped by request.', providerStatus: { status: 'suspended', detail: 'user_request' }, links: [] } })
    let n = 0
    gone.extra.agents_list = (payload) => {
      n += 1
      if (n <= 2) return { agents: [live] }
      return { agents: payload.includeStopped ? [stopped] : [] }
    }
    const s = harness(gone)
    expect(await waitCommand(['devin', '--json'], s.deps)).toBe(EXIT.stopped)
    expect(JSON.parse(s.out.join('\n')).harnesses[0].cloud).toEqual({ state: 'stopped', activity: 'The session was stopped by request.', providerStatus: { status: 'suspended', detail: 'user_request' } })
  })
})

describe('harness tell', () => {
  const told = (over: { state?: string; error?: [string, string] } = {}) => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const record: Rpc = async (target, payload) => {
      calls.push([target.machineId, payload])
      if (over.error) throw new RefusedError(over.error[0], over.error[1])
      return { id: 'm0000001', state: over.state ?? 'queued' }
    }
    return { calls, record }
  }
  const answeredWith = (d: FakeDaemon, id: string, ask: string, answer: string) =>
    d.pages.set(`s-${id}`, [{ events: [ev('user_message', { content: ask }), ev('text_delta', { content: answer }), ev('done')], hasMore: false }])

  beforeEach(() => { setAgentSettingsForTest(dir, { agentsTellAgents: true }) })

  it('gives a harness it started more work, through its machine, and records it for wait', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('kid')]
    const r = told()
    const h = harness(d, { record: r.record })
    started(h.ledger, 'lead', 'kid')
    expect(await tellCommand(['kid', '--', 'Now', 'add', 'tests.'], h.deps)).toBe(EXIT.ok)
    expect(r.calls).toEqual([['m', { action: 'tell', pane: '%lead', machine: 'studio', agentId: 'kid', text: 'Now add tests.' }]])
    expect(h.out.join('\n')).toBe('kid on studio: told. kid has it: typed once it is free, or given at its next tool call while it works.\n'
      + 'Next: harness wait kid  (until it has answered; then read it: harness show kid)')
    expect(h.ledger.toldBy({ machineId: 'm', agentId: 'lead' }, { machineId: 'm', agentId: 'kid' })).toEqual({
      at: NOW, by: { machineId: 'm', agentId: 'lead' }, told: { machineId: 'm', agentId: 'kid' }, probe: 'Now add tests.' })
  })

  it('on another machine, says who tells it: that machine checks its own record', async () => {
    const d = new FakeDaemon(), far = new FakeDaemon('m2')
    d.frames = [frame('lead', { engine: 'claude' })]
    far.frames = [frame('far')]
    const r = told()
    const h = harness(d, { record: r.record, others: { m2: far } })
    started(h.ledger, 'lead', 'far', 'm2')
    expect(await tellCommand(['far', '--json', '--', 'Ship it.'], h.deps)).toBe(EXIT.ok)
    expect(r.calls).toEqual([['m2', { action: 'tell', from: { machineId: 'm', agentId: 'lead' }, machine: 'studio', agentId: 'far', text: 'Ship it.' }]])
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({ name: 'far', state: 'queued', next: [{ run: 'harness wait far' }] })
    expect(far.closed).toBe(true)
  })

  it('is refused, never asked of a machine, until the person allows it, and for a harness the caller did not start', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('kid'), frame('theirs'), frame('done', { status: 'stopped' })]
    const r = told()
    started(new Ledger(ledgerPath(dir)), 'lead', 'kid')
    started(new Ledger(ledgerPath(dir)), 'lead', 'done')
    setAgentSettingsForTest(dir, { agentsTellAgents: false })
    let h = harness(d, { record: r.record })
    expect(await tellCommand(['kid', '--', 'x'], h.deps)).toBe(EXIT.refused)
    expect(h.err.join('\n')).toContain('harness settings agents-tell-agents on')
    setAgentSettingsForTest(dir, { agentsTellAgents: true })
    h = harness(d, { record: r.record })
    expect(await tellCommand(['theirs', '--', 'x'], h.deps)).toBe(EXIT.refused)
    expect(h.err.join('\n')).toBe('You did not start theirs, so you may not tell it. Only the person can.')
    h = harness(d, { record: r.record })
    expect(await tellCommand(['done', '--', 'x'], h.deps)).toBe(EXIT.refused)
    expect(h.err.join('\n')).toMatch(/no longer running.*Start a new harness/)
    // The person at a terminal has no pane to tell from: they open the harness in Harness.
    h = harness(d, { record: r.record, pane: undefined })
    expect(await tellCommand(['kid', '--', 'x'], h.deps)).toBe(EXIT.refused)
    h = harness(d, { record: r.record })
    expect(await tellCommand(['kid'], h.deps)).toBe(EXIT.usage)
    expect(await tellCommand(['kid', 'theirs', '--', 'x'], h.deps)).toBe(EXIT.usage)
    expect(r.calls).toEqual([])
  })

  it('says the machine\'s refusal as it said it, as a refusal not to retry', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('kid')]
    const r = told({ error: ['NOT_YOURS', 'You did not start that harness, as its machine records it, so you may not tell it. Only the person can.'] })
    const h = harness(d, { record: r.record })
    started(h.ledger, 'lead', 'kid')
    expect(await tellCommand(['kid', '--json', '--', 'x'], h.deps)).toBe(EXIT.refused)
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({ error: 'NOT_YOURS', code: 'NOT_YOURS' })
    expect(h.ledger.toldBy({ machineId: 'm', agentId: 'lead' }, { machineId: 'm', agentId: 'kid' })).toBeNull()
  })

  it('wait does not return on the answer to the work before, until the harness takes the new work', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('kid')]
    answeredWith(d, 'kid', 'Fix the footer.', 'Fixed.')
    const h = harness(d)
    started(h.ledger, 'lead', 'kid')
    h.ledger.append({ at: NOW, by: { machineId: 'm', agentId: 'lead' }, told: { machineId: 'm', agentId: 'kid' }, probe: 'Now add tests.' })
    // Idle on the turn before the tell: still waiting when the wait ends.
    expect(await waitCommand(['kid', '--timeout', '10s'], h.deps)).toBe(EXIT.timeout)
    // Typed into it, a turn asked with those words: that answer is the one to read.
    answeredWith(d, 'kid', '[from lead · Claude Code · studio, the harness that started you: more work. It reads your answer itself.]\n\nNow  add\ntests.', 'Added 3.')
    expect(await waitCommand(['kid', '--timeout', '10s'], h.deps)).toBe(EXIT.ok)
  })

  it('wait takes work given inside a turn, and lets go of a tell nothing took after a while', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('kid', { updatedAt: new Date(NOW + 5_000).toISOString() })]
    answeredWith(d, 'kid', 'Fix the footer.', 'Fixed, and tests added.')
    const h = harness(d)
    started(h.ledger, 'lead', 'kid')
    h.ledger.append({ at: NOW, by: { machineId: 'm', agentId: 'lead' }, told: { machineId: 'm', agentId: 'kid' }, probe: 'Now add tests.' })
    // It worked after the tell (given at a tool call): its answer is the new one.
    expect(await waitCommand(['kid', '--timeout', '10s'], h.deps)).toBe(EXIT.ok)
    d.frames[1] = frame('kid')
    h.advance(10 * 60_000 + 1)
    expect(await waitCommand(['kid', '--timeout', '10s'], h.deps)).toBe(EXIT.ok)
  })

  it('show says the answer is to the work before, and an idle harness of the caller\'s can be told more', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('kid')]
    answeredWith(d, 'kid', 'Fix the footer.', 'Fixed.')
    const h = harness(d)
    started(h.ledger, 'lead', 'kid')
    expect(await showCommand(['kid'], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n')).toContain('Next: harness tell kid -- <work>  (to give it more work in the same conversation)\n  or: harness close kid  (once you have what you need)')
    h.ledger.append({ at: NOW, by: { machineId: 'm', agentId: 'lead' }, told: { machineId: 'm', agentId: 'kid' }, probe: 'Now add tests.' })
    const again = harness(d)
    expect(await showCommand(['kid', '--json'], again.deps)).toBe(EXIT.ok)
    expect(JSON.parse(again.out.join('\n'))).toMatchObject({ answer: 'Fixed.', told: { taken: false }, next: [{ run: 'harness wait kid' }] })
    // Through MCP the next steps are its tools.
    const mcp = harness(d, { env: { HARNESS_VIA_MCP: '1' } })
    setAgentSettingsForTest(dir, {})
    new Ledger(ledgerPath(dir)).append({ at: NOW - 11 * 60_000, by: { machineId: 'm', agentId: 'lead' }, told: { machineId: 'm', agentId: 'kid' }, probe: 'Old.' })
    expect(await showCommand(['kid'], mcp.deps)).toBe(EXIT.ok)
    expect(mcp.out.join('\n')).toContain('Next: harness_tell (name: "kid", text: "<work>")')
  })
})
