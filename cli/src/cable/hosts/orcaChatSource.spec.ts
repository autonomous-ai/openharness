import { afterEach, describe, expect, it, vi } from 'vitest'
import { RECORDED_ORCA_AGENTS, RECORDED_ORCA_WORKTREES } from '../../testing/recordedOrca.js'
import { observedAgentId } from './observed.js'
import {
  ORCA_CHAT_TIMEOUT_MS, ORCA_CHATS_KEPT, ORCA_ROWS_READ, OrcaChatSource, type HeardChat, type OrcaChatDeps,
} from './orcaChatSource.js'
import { HostRegistry } from './registry.js'
import { capsLetters, type HostAgent, type HostSource, type PaneSwitch } from './types.js'

const T = 1_795_000_000_000
const ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca'
const AGENTS = RECORDED_ORCA_AGENTS.result.agents
const WORKTREES = RECORDED_ORCA_WORKTREES.result.worktrees
/** The recording's Chat 1, a Claude chat in a worktree with an identity, and that worktree's id and key. */
const CHAT1 = AGENTS[0]
const WT5 = CHAT1.worktreeId
const WT5_KEY = WORKTREES[4].identity.key

// Orca 1.4.271's `orca agent --help`, whole (2026-11-23).
const HELP = [
  'orca agent',
  '',
  'Usage: orca agent <command> [options]',
  '',
  'Commands:',
  "  hooks prepare-codex Prepare a WSL pane's Orca-managed Codex home before a shell launch",
  '  hooks status       Show whether Orca-managed agent status hooks are enabled',
  '  hooks off          Disable Orca-managed agent status hooks and remove local hook entries',
  '  hooks on           Enable Orca-managed agent status hooks',
  '  launch             Start an agent in an existing workspace, as a chat or a terminal',
  '  installed          List the agent CLIs installed on this host, with the IDs --agent takes',
  '  list               List agents, chats and terminals, with their Orca session IDs',
  '  show               Show where an agent is, by its Orca session ID',
  '  read               Read what an agent said, by its Orca session ID',
  '',
  'Run `orca agent <command> --help` for command-specific usage.',
  '',
].join('\n')
// An Orca with no `list`: the word stays in other commands' descriptions.
const HELP_NO_LIST = HELP.replace(/^ {2}list .*\n/m, '')

const LOG = /^\[orca-chat\] (listed · \d+ chats · \d+ heard|read · failed · (exit|no answer|unreadable)|read · (<0\.5s|<2s|>2s))$/
/** Every value of the recording that names something of a person's, and the made-up ones below: no log line holds one. */
const PRIVATE: readonly string[] = [
  ...AGENTS.flatMap((row) => [
    row.orcaSessionId, row.worktreeId, row.worktreeId.split('::')[1], row.workspace, row.repo, row.paneKey, row.title,
    row.lastAssistantMessage,
  ]),
  ...WORKTREES.flatMap((row): string[] => [row.id, ...('identity' in row ? [row.identity.key] : [])]),
  'someone', 'made-up', 'Made up', '/work',
]

/** `orca agent list --json`'s answer, as recorded, with these rows. */
const agentsAnswer = (agents: readonly unknown[]): string =>
  JSON.stringify({ ...RECORDED_ORCA_AGENTS, result: { ...RECORDED_ORCA_AGENTS.result, agents } })
/** `orca worktree list --json`'s answer, as recorded, with these rows. */
const worktreesAnswer = (worktrees: readonly unknown[]): string =>
  JSON.stringify({ ...RECORDED_ORCA_WORKTREES, result: { ...RECORDED_ORCA_WORKTREES.result, worktrees } })
/** A made-up chat row in the recording's shape, older as n grows. */
const chat = (n: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...CHAT1,
  orcaSessionId: `made-up-${n}`,
  worktreeId: `made-up::/work/p${n}`,
  workspace: `p${n}`,
  paneKey: `made-up-pane-${n}`,
  title: `Made up ${n}`,
  lastAssistantMessage: `Made up answer ${n}`,
  updatedAt: T - n * 1000,
  ...over,
})
/** A chat's row id while no hook has named its session. */
const restingId = (orcaId: string): string => observedAgentId('orca', orcaId)
/** Lets what the source was answered be taken in: every answer here resolves at once. */
const turn = () => new Promise((resolve) => setImmediate(resolve))

/** Every line any source said: checked after each test. */
const lines: string[] = []

interface Call { file: string; args: string[]; timeoutMs: number }
type Answer = Awaited<ReturnType<OrcaChatDeps['run']>>

describe("Orca's chats on the dial", () => {
  afterEach(() => {
    for (const line of lines.splice(0)) {
      expect(line).toMatch(LOG)
      for (const word of PRIVATE) expect(line).not.toContain(word)
    }
  })

  /** A source whose `orca` answers what the test holds, on a clock each `agent list` moves by `took`. */
  function setup() {
    const state = {
      binary: ORCA as string | null,
      stamp: { realPath: ORCA, mtimeMs: 1 } as { realPath: string; mtimeMs: number } | null,
      help: { code: 0, stdout: HELP } as Answer,
      agents: { code: 0, stdout: JSON.stringify(RECORDED_ORCA_AGENTS) } as Answer,
      worktrees: { code: 0, stdout: JSON.stringify(RECORDED_ORCA_WORKTREES) } as Answer,
      heard: new Map() as ReadonlyMap<string, HeardChat>,
      took: 200,
    }
    const calls: Call[] = []
    /** The lists under way while the test holds them: each waits until released. */
    const held: Array<() => void> = []
    let holding = false
    let clock = 0
    let changes = 0
    const focus = vi.fn(async (_agentId: string, _worktreeId: string | undefined) => true)
    const show = vi.fn(async (_agentId: string): Promise<PaneSwitch> => 'ok')
    const deps: OrcaChatDeps = {
      binary: () => state.binary,
      run: async (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        if (args[1] === '--help') return state.help
        if (args[0] === 'agent') clock += state.took
        if (holding) await new Promise<void>((resolve) => held.push(resolve))
        return args[0] === 'agent' ? state.agents : state.worktrees
      },
      mtime: () => state.stamp,
      heard: () => state.heard,
      focus,
      show,
      log: (line) => { lines.push(line) },
      now: () => clock,
    }
    const src = new OrcaChatSource(deps)
    src.onChange(() => { changes++ })
    const lists = (group: string) => calls.filter(({ args }) => args[0] === group && args[1] === 'list').length
    return {
      src, state, calls, focus, show,
      changes: () => changes,
      said: () => [...lines],
      helps: () => calls.filter(({ args }) => args[1] === '--help').length,
      agentLists: () => lists('agent'),
      worktreeLists: () => lists('worktree'),
      hold: () => { holding = true },
      /** Answers the lists under way; with `stillHolding`, the next ones wait too. */
      release: async (stillHolding = false) => {
        holding = stillHolding
        for (const go of held.splice(0)) go()
        await turn()
      },
      /** One read, asked and taken in. */
      read: async (opts?: { worktrees?: boolean }) => {
        src.read(opts)
        await turn()
      },
    }
  }

  it("lists Orca's chats as resting rows on Orca's page, read with Orca's CLI, and takes no words", async () => {
    const t = setup()
    t.state.agents.stdout = agentsAnswer([
      chat(2, { state: 'working', lastAssistantMessage: 'Line one\n\tline\u0007 two  ' }),
      chat(1, { state: 'blocked', agent: 'codex' }),
      chat(4, { state: 'waiting' }),
    ])
    await t.read()
    expect(t.calls).toEqual([
      { file: ORCA, args: ['agent', '--help'], timeoutMs: ORCA_CHAT_TIMEOUT_MS },
      { file: ORCA, args: ['agent', 'list', '--json'], timeoutMs: ORCA_CHAT_TIMEOUT_MS },
    ])
    expect(t.src.list()).toEqual([
      {
        id: restingId('made-up-1'), engine: 'codex', name: 'Made up 1', cwd: '/work/p1', host: 'orca', app: 'orca',
        state: 'needs-you', unseenDone: false, resting: true, lastActivityAt: T - 1000, lastAnswer: 'Made up answer 1',
      },
      expect.objectContaining({ id: restingId('made-up-2'), engine: 'claude', state: 'working', lastAnswer: 'Line one line two' }),
      expect.objectContaining({ id: restingId('made-up-4'), state: 'needs-you' }),
    ])
    expect(t.changes()).toBe(1)
    expect(capsLetters(t.src.capabilities())).toBe(capsLetters({ status: true, voice: false, focus: true, answer: false }))
    expect(t.src.voiceRefusal()).toBe('Type in Orca for chats.')
    expect(t.said()).toEqual(['[orca-chat] read · <0.5s', '[orca-chat] listed · 3 chats · 0 heard'])
  })

  it('the recorded answer gives its chats newest first, each with its worktreeId; terminal rows and remote hosts are left out', async () => {
    const t = setup()
    t.state.agents.stdout = agentsAnswer([
      ...AGENTS,
      { ...CHAT1, orcaSessionId: 'made-up-terminal', kind: 'terminal' },
      { ...CHAT1, orcaSessionId: 'made-up-remote', hostId: 'ssh-made-up' },
    ])
    await t.read()
    expect(t.src.list().map(({ name }) => name)).toEqual([
      'Chat 3', 'Chat 10', 'Chat 2', 'Chat 1', 'Chat 17', 'Chat 9', 'Chat 8', 'Chat 16', 'Chat 15', 'Chat 14', 'Chat 7',
      'Chat 12', 'Chat 5', 'Chat 4', 'Chat 11', 'Chat 13', 'Chat 6',
    ])
    for (const row of AGENTS) {
      expect(t.src.worktreeOf(row.orcaSessionId)).toBe(row.worktreeId)
      expect(t.src.worktreeOfAgent(restingId(row.orcaSessionId))).toBe(row.worktreeId)
    }
    expect(t.src.worktreeOf('made-up-terminal')).toBeUndefined()
    expect(t.src.worktreeOf('made-up-remote')).toBeUndefined()
    expect(t.src.worktreeOfAgent(restingId('made-up-remote'))).toBeUndefined()
    // Orca's own order, which the rank follows, is its list's, not the newest first.
    expect(t.src.order()).toEqual(AGENTS.map(({ orcaSessionId }) => restingId(orcaSessionId)))
    expect(t.src.list()[0]).toEqual({
      id: restingId(AGENTS[2].orcaSessionId), engine: 'claude', name: 'Chat 3', cwd: '/Users/someone/work/repo-3/wt-5',
      host: 'orca', app: 'orca', state: 'working', unseenDone: false, resting: true, lastActivityAt: AGENTS[2].updatedAt,
      lastAnswer: 'Answer 3.',
    })
    expect(t.src.list().find(({ name }) => name === 'Chat 2')).toMatchObject({ engine: 'codex', state: 'idle' })
    expect(t.said()).toEqual(['[orca-chat] read · <0.5s', `[orca-chat] listed · ${AGENTS.length} chats · 0 heard`])
  })

  it('names an untitled chat by its workspace, else by its CLI, keeps no folder that is not a whole path, and cuts a preview by character', async () => {
    const t = setup()
    t.state.agents.stdout = agentsAnswer([
      chat(1, { title: '   ', worktreeId: 'no-separator' }),
      chat(2, { title: undefined, workspace: undefined, worktreeId: 'made-up::relative/path', lastAssistantMessage: ' \n ' }),
      chat(3, { title: 'x'.repeat(80), lastAssistantMessage: 'y'.repeat(400) }),
      chat(4, { title: 'a\u0007b', lastAssistantMessage: 7, state: 'sleeping' }),
      chat(5, { lastAssistantMessage: '\u{1F600}'.repeat(400) }),
    ])
    await t.read()
    const [one, two, three, four, five] = t.src.list()
    expect(one).toMatchObject({ name: 'p1' })
    expect(one.cwd).toBeUndefined()
    expect(t.src.worktreeOf('made-up-1')).toBe('no-separator')
    expect(two).toMatchObject({ name: 'claude' })
    expect(two.cwd).toBeUndefined()
    expect(two.lastAnswer).toBeUndefined()
    expect(three.name).toBe('x'.repeat(64))
    expect(three.cwd).toBe('/work/p3')
    expect(Array.from(three.lastAnswer!)).toHaveLength(300)
    expect(three.lastAnswer!.endsWith('…')).toBe(true)
    expect(four).toMatchObject({ name: 'p4', state: 'idle' })
    expect(four.lastAnswer).toBeUndefined()
    // A cut through an emoji's surrogate pair would leave half a character on the card.
    expect(five.lastAnswer).toBe(`${'\u{1F600}'.repeat(299)}…`)
  })

  it('65 chats keep the newest 64; 300 rows parse the first 256', async () => {
    const t = setup()
    t.state.agents.stdout = agentsAnswer(Array.from({ length: ORCA_CHATS_KEPT + 1 }, (_, n) => chat(n)))
    await t.read()
    expect(t.src.list().map(({ id }) => id)).toEqual(Array.from({ length: ORCA_CHATS_KEPT }, (_, n) => restingId(`made-up-${n}`)))
    expect(t.src.worktreeOf(`made-up-${ORCA_CHATS_KEPT}`)).toBeUndefined()
    expect(t.src.order()).toHaveLength(ORCA_CHATS_KEPT)
    // Rows past the 256th are never read, newer though they are.
    t.state.agents.stdout = agentsAnswer(Array.from({ length: 300 }, (_, n) => chat(n, { updatedAt: T + n })))
    await t.read()
    expect(t.src.list().map(({ id }) => id))
      .toEqual(Array.from({ length: ORCA_CHATS_KEPT }, (_, n) => restingId(`made-up-${ORCA_ROWS_READ - 1 - n}`)))
    // The order of those kept is Orca's.
    expect(t.src.order())
      .toEqual(Array.from({ length: ORCA_CHATS_KEPT }, (_, n) => restingId(`made-up-${ORCA_ROWS_READ - ORCA_CHATS_KEPT + n}`)))
    expect(t.said()).toEqual(['[orca-chat] read · <0.5s', `[orca-chat] listed · ${ORCA_CHATS_KEPT} chats · 0 heard`])
  })

  it('rows outside the bounds are skipped, one by one', async () => {
    const t = setup()
    const skipped = [
      null, 'chat', [CHAT1], 7,
      chat(1, { kind: 'terminal' }), chat(2, { kind: undefined }),
      chat(3, { hostId: 'ssh-made-up' }), chat(4, { hostId: undefined }),
      chat(5, { orcaSessionId: '' }), chat(6, { orcaSessionId: 'x'.repeat(129) }), chat(7, { orcaSessionId: 'made-up\n7' }),
      chat(8, { orcaSessionId: 'made-up\u007f8' }), chat(9, { orcaSessionId: 9 }),
      chat(10, { agent: 'Claude Code' }), chat(11, { agent: 'a'.repeat(33) }), chat(12, { agent: '1claude' }),
      chat(13, { agent: undefined }),
      chat(14, { updatedAt: '1' }), chat(15, { updatedAt: null }), chat(16, { updatedAt: 'INFINITY' }),
      chat(17, { worktreeId: '' }), chat(18, { worktreeId: `made-up::/${'w'.repeat(4151)}` }),
      chat(19, { worktreeId: 'made-up::/work/\u0001p19' }), chat(20, { worktreeId: 'made-up::/work/p20\u0085' }),
      chat(21, { worktreeId: 21 }), chat(22, { worktreeId: undefined }),
    ]
    const kept = [
      chat(30, { orcaSessionId: 'x'.repeat(128) }),
      chat(31, { agent: `a${'-'.repeat(31)}` }),
      chat(32, { worktreeId: `made-up::/${'w'.repeat(4150)}` }),
      chat(33),
      // A chat named twice keeps its first row.
      chat(33, { title: 'Second copy', updatedAt: T + 1 }),
    ]
    // JSON has no Infinity: a number past a double's range parses to it.
    t.state.agents.stdout = agentsAnswer([...skipped, ...kept]).replace('"updatedAt":"INFINITY"', '"updatedAt":1e999')
    await t.read()
    expect(t.src.list().map(({ id }) => id))
      .toEqual([restingId('x'.repeat(128)), restingId('made-up-31'), restingId('made-up-32'), restingId('made-up-33')])
    expect(t.src.list().map(({ name }) => name)).not.toContain('Second copy')
    expect(t.src.worktreeOf('made-up-32')).toHaveLength(4160)
    expect(t.said()).toEqual(['[orca-chat] read · <0.5s', '[orca-chat] listed · 4 chats · 0 heard'])
  })

  it('an answer of another shape, a non-zero exit and a timeout each clear the list and log one line per run of failures', async () => {
    const t = setup()
    await t.read({ worktrees: true })
    expect(t.src.list()).toHaveLength(AGENTS.length)
    expect(t.src.worktreeFor(`identity:${WT5_KEY}`)).toBe(WT5)
    t.state.agents = { code: 1, stdout: '' }
    await t.read()
    expect(t.src.list()).toEqual([])
    // The worktrees go with the chats.
    expect(t.src.worktreeOf(CHAT1.orcaSessionId)).toBeUndefined()
    expect(t.src.worktreeFor(`identity:${WT5_KEY}`)).toBeUndefined()
    expect(t.changes()).toBe(2)
    for (const answer of [
      // A timeout: the run answers no code once its time is up (orca.ts orcaDeps).
      { code: null, stdout: '' },
      { code: 0, stdout: '{"ok":' },
      { code: 0, stdout: JSON.stringify({ ok: false, error: 'not running' }) },
      { code: 0, stdout: JSON.stringify({ ok: true, result: { agents: {} } }) },
      { code: 0, stdout: JSON.stringify({ ok: true, result: null }) },
      { code: 0, stdout: JSON.stringify([1]) },
      { code: 0, stdout: '' },
    ]) {
      t.state.agents = answer
      await t.read()
    }
    expect(t.changes()).toBe(2)
    expect(t.said()).toEqual([
      '[orca-chat] read · <0.5s', `[orca-chat] listed · ${AGENTS.length} chats · 0 heard`, '[orca-chat] read · failed · exit',
    ])
    t.state.agents = { code: 0, stdout: JSON.stringify(RECORDED_ORCA_AGENTS) }
    await t.read()
    expect(t.src.list()).toHaveLength(AGENTS.length)
    t.state.agents = { code: null, stdout: '' }
    await t.read()
    t.state.agents = { code: 0, stdout: 'not json' }
    t.src.stop()
    await t.read()
    expect(t.said().slice(3)).toEqual([
      `[orca-chat] listed · ${AGENTS.length} chats · 0 heard`, '[orca-chat] read · failed · no answer',
      '[orca-chat] read · failed · unreadable',
    ])
  })

  it('a worktree read that fails empties the worktree map alone, with one line per run of failures', async () => {
    const t = setup()
    await t.read({ worktrees: true })
    t.state.worktrees = { code: 1, stdout: '' }
    await t.read({ worktrees: true })
    expect(t.src.list()).toHaveLength(AGENTS.length)
    expect(t.src.worktreeOf(CHAT1.orcaSessionId)).toBe(WT5)
    expect(t.src.worktreeFor(`identity:${WT5_KEY}`)).toBeUndefined()
    // The scope can change with the map: it is told.
    expect(t.changes()).toBe(2)
    for (const answer of [{ code: null, stdout: '' }, { code: 0, stdout: JSON.stringify({ ok: true, result: { worktrees: 'none' } }) }]) {
      t.state.worktrees = answer
      await t.read({ worktrees: true })
    }
    expect(t.said()).toEqual([
      '[orca-chat] read · <0.5s', `[orca-chat] listed · ${AGENTS.length} chats · 0 heard`, '[orca-chat] read · failed · exit',
    ])
    t.state.worktrees = { code: 0, stdout: JSON.stringify(RECORDED_ORCA_WORKTREES) }
    await t.read({ worktrees: true })
    expect(t.src.worktreeFor(`identity:${WT5_KEY}`)).toBe(WT5)
    expect(t.changes()).toBe(3)
  })

  it('a failed read with nothing listed tells no change', async () => {
    const t = setup()
    t.state.agents = { code: 2, stdout: '' }
    await t.read()
    expect(t.changes()).toBe(0)
    expect(t.said()).toEqual(['[orca-chat] read · failed · exit'])
  })

  it('reads nothing until asked, and nothing after stop', async () => {
    const t = setup()
    await turn()
    t.src.refold()
    expect(t.calls).toEqual([])
    expect(t.src.list()).toEqual([])
    expect(t.changes()).toBe(0)
    await t.read({ worktrees: true })
    expect(t.src.list()).toHaveLength(AGENTS.length)
    expect(t.src.worktreeFor(`identity:${WT5_KEY}`)).toBe(WT5)
    const asked = t.calls.length
    t.src.stop()
    // No dial: nothing listed, nothing kept.
    expect(t.src.list()).toEqual([])
    expect(t.src.order()).toEqual([])
    expect(t.src.paneNames()).toEqual(new Map())
    expect(t.src.placed()).toEqual(new Map())
    expect(t.src.worktreeOf(CHAT1.orcaSessionId)).toBeUndefined()
    expect(t.src.worktreeFor(`identity:${WT5_KEY}`)).toBeUndefined()
    expect(t.changes()).toBe(2)
    t.src.stop()
    await turn()
    expect(t.calls).toHaveLength(asked)
    expect(t.changes()).toBe(2)
    // A read under way at a stop lands on nothing, and the read asked during it goes with it.
    t.hold()
    t.src.read()
    await turn()
    t.src.read()
    t.src.stop()
    await t.release()
    expect(t.src.list()).toEqual([])
    expect(t.agentLists()).toBe(2)
    // A read asked after a stop, while the stopped one still runs, waits for it, then lists.
    t.hold()
    t.src.read()
    await turn()
    t.src.stop()
    t.src.read()
    await turn()
    expect(t.agentLists()).toBe(3)
    await t.release(true)
    expect(t.src.list()).toEqual([])
    expect(t.agentLists()).toBe(4)
    await t.release()
    expect(t.src.list()).toHaveLength(AGENTS.length)
  })

  it('a read asked during a read runs once after it, however many were asked', async () => {
    const t = setup()
    t.hold()
    t.src.read()
    await turn()
    t.src.read()
    t.src.read({ worktrees: true })
    t.src.read()
    await turn()
    expect([t.agentLists(), t.worktreeLists()]).toEqual([1, 0])
    await t.release(true)
    expect([t.agentLists(), t.worktreeLists()]).toEqual([2, 1])
    await t.release()
    await turn()
    expect([t.agentLists(), t.worktreeLists()]).toEqual([2, 1])
    expect(t.src.list()).toHaveLength(AGENTS.length)
    expect(t.src.worktreeFor(`identity:${WT5_KEY}`)).toBe(WT5)
  })

  it('reads nothing with Orca not installed, and its chats go with it', async () => {
    const t = setup()
    t.state.binary = null
    await t.read({ worktrees: true })
    expect(t.calls).toEqual([])
    expect(t.src.list()).toEqual([])
    t.state.binary = ORCA
    await t.read()
    t.state.binary = null
    await t.read()
    expect(t.src.list()).toEqual([])
    expect(t.changes()).toBe(2)
    expect(t.said()).toEqual(['[orca-chat] read · <0.5s', `[orca-chat] listed · ${AGENTS.length} chats · 0 heard`])
  })

  it('an Orca whose agent --help lacks list lists nothing, and is asked again only when its binary changes', async () => {
    const t = setup()
    t.state.help = { code: 0, stdout: HELP_NO_LIST }
    await t.read({ worktrees: true })
    await t.read()
    expect(t.calls).toEqual([{ file: ORCA, args: ['agent', '--help'], timeoutMs: ORCA_CHAT_TIMEOUT_MS }])
    expect(t.src.list()).toEqual([])
    expect(t.changes()).toBe(0)
    // An update moved the binary's mtime: the new Orca is asked.
    t.state.stamp = { realPath: ORCA, mtimeMs: 2 }
    t.state.help = { code: 0, stdout: HELP }
    await t.read()
    await t.read()
    expect(t.helps()).toBe(2)
    expect(t.src.list()).toHaveLength(AGENTS.length)
    // Another Orca, at another real path, without list: the chats go, with no line.
    t.state.stamp = { realPath: '/opt/Orca/orca-ide', mtimeMs: 2 }
    t.state.help = { code: 0, stdout: HELP_NO_LIST }
    await t.read()
    expect(t.helps()).toBe(3)
    expect(t.src.list()).toEqual([])
    expect(t.changes()).toBe(2)
    // A help that fails says nothing of the CLI: the read fails, and the next asks again.
    t.state.stamp = { realPath: ORCA, mtimeMs: 3 }
    t.state.help = { code: 1, stdout: '' }
    await t.read()
    await t.read()
    expect(t.helps()).toBe(5)
    // A binary whose real path cannot be read is asked nothing.
    t.state.stamp = null
    await t.read()
    expect(t.helps()).toBe(5)
    expect(t.agentLists()).toBe(2)
    expect(t.said()).toEqual([
      '[orca-chat] read · <0.5s', `[orca-chat] listed · ${AGENTS.length} chats · 0 heard`, '[orca-chat] read · failed · exit',
    ])
  })

  it('worktreeFor answers from the last worktree read, and asks for one with the next read only on a miss', async () => {
    const t = setup()
    await t.read()
    expect(t.worktreeLists()).toBe(0)
    expect(t.src.worktreeFor(`identity:${WT5_KEY}`)).toBeUndefined()
    // The miss reads nothing by itself: the next read takes the worktree list with the chats.
    await turn()
    expect(t.worktreeLists()).toBe(0)
    await t.read()
    expect(t.calls.slice(-2)).toEqual([
      { file: ORCA, args: ['agent', 'list', '--json'], timeoutMs: ORCA_CHAT_TIMEOUT_MS },
      { file: ORCA, args: ['worktree', 'list', '--json'], timeoutMs: ORCA_CHAT_TIMEOUT_MS },
    ])
    for (const row of WORKTREES) if ('identity' in row) expect(t.src.worktreeFor(`identity:${row.identity.key}`)).toBe(row.id)
    await t.read()
    expect(t.worktreeLists()).toBe(1)
    // A worktree with no identity is named by its id, which the devices compare as it is; a key Orca cannot print is
    // never read for.
    for (const workspace of [WORKTREES[7].id, '', 'identity:', 'identity:made up', 'identity:made-up\n', `identity:${'k'.repeat(247)}`]) {
      expect(t.src.worktreeFor(workspace)).toBeUndefined()
    }
    await t.read()
    expect(t.worktreeLists()).toBe(1)
    // A worktree made after the last read is a miss: the next read reads the list again.
    expect(t.src.worktreeFor('identity:wt2:local:made-up')).toBeUndefined()
    t.state.worktrees.stdout = worktreesAnswer([...WORKTREES, { id: 'made-up::/work/new', identity: { key: 'wt2:local:made-up' } }])
    await t.read()
    expect(t.worktreeLists()).toBe(2)
    expect(t.src.worktreeFor('identity:wt2:local:made-up')).toBe('made-up::/work/new')
    // The devices can ask for one too.
    await t.read({ worktrees: true })
    expect(t.worktreeLists()).toBe(3)
  })

  it('worktree rows with no identity, or outside the bounds, are skipped', async () => {
    const t = setup()
    t.state.worktrees.stdout = worktreesAnswer([
      ...WORKTREES,
      null, 'worktree', [WORKTREES[0]],
      { id: 'made-up::/w/1', identity: null },
      { id: 'made-up::/w/2', identity: {} },
      { id: 'made-up::/w/3', identity: { key: '' } },
      { id: 'made-up::/w/4', identity: { key: 'k'.repeat(247) } },
      { id: 'made-up::/w/5', identity: { key: 'made-up 5' } },
      { id: 'made-up::/w/6', identity: { key: 'made-up/6' } },
      { id: 'made-up::/w/7', identity: { key: 'made-up\t7' } },
      { id: 'made-up::/w/8', identity: { key: 8 } },
      { id: 'made-up::/w/9', identity: 'made-up-9' },
      { id: '', identity: { key: 'made-up-10' } },
      { id: `made-up::/${'w'.repeat(4151)}`, identity: { key: 'made-up-11' } },
      { id: 'made-up::/w/\u001b12', identity: { key: 'made-up-12' } },
      { id: 13, identity: { key: 'made-up-13' } },
      { identity: { key: 'made-up-14' } },
      { id: 'made-up::/w/15', identity: { key: 'k'.repeat(246) } },
      { id: `made-up::/${'w'.repeat(4150)}`, identity: { key: 'made-up-16' } },
      // A key named twice keeps its first worktree.
      { id: 'made-up::/w/17', identity: { key: WT5_KEY } },
    ])
    await t.read({ worktrees: true })
    for (const row of WORKTREES) if ('identity' in row) expect(t.src.worktreeFor(`identity:${row.identity.key}`)).toBe(row.id)
    expect(t.src.worktreeFor(`identity:${'k'.repeat(246)}`)).toBe('made-up::/w/15')
    expect(t.src.worktreeFor('identity:made-up-16')).toHaveLength(4160)
    for (const key of ['made-up-9', 'made-up-10', 'made-up-11', 'made-up-12', 'made-up-13', 'made-up-14']) {
      expect(t.src.worktreeFor(`identity:${key}`)).toBeUndefined()
    }
    // 300 rows: the first 256 are read.
    t.state.worktrees.stdout = worktreesAnswer(Array.from({ length: 300 }, (_, n) => ({ id: `made-up::/w/${n}`, identity: { key: `made-up-${n}` } })))
    await t.read({ worktrees: true })
    expect(t.src.worktreeFor(`identity:made-up-${ORCA_ROWS_READ - 1}`)).toBe(`made-up::/w/${ORCA_ROWS_READ - 1}`)
    expect(t.src.worktreeFor(`identity:made-up-${ORCA_ROWS_READ}`)).toBeUndefined()
    expect(t.src.worktreeFor(`identity:${WT5_KEY}`)).toBeUndefined()
  })

  it("gives a chat a hook told of the hooked copy's id and session, and keeps them past that copy's end", async () => {
    const t = setup()
    t.state.agents.stdout = agentsAnswer([chat(1), chat(2)])
    t.state.heard = new Map([
      ['made-up-1', { engine: 'claude', sessionId: 'claude-session-1' }],
      ['other-orca-chat', { engine: 'claude', sessionId: 'claude-session-9' }],
    ])
    await t.read()
    expect(t.src.list()[0]).toMatchObject({ id: observedAgentId('claude', 'claude-session-1'), engine: 'claude', sessionId: 'claude-session-1' })
    expect(t.src.list()[1].sessionId).toBeUndefined()
    expect(t.said()).toEqual(['[orca-chat] read · <0.5s', '[orca-chat] listed · 2 chats · 1 heard'])
    // The hooked copy is dropped: the chat still sits in Orca under that session.
    t.state.heard = new Map()
    await t.read()
    expect(t.src.list()[0].id).toBe(observedAgentId('claude', 'claude-session-1'))
    expect(t.src.worktreeOfAgent(observedAgentId('claude', 'claude-session-1'))).toBe('made-up::/work/p1')
    // The chat leaves Orca's list, then comes back: its session went with it.
    t.state.agents.stdout = agentsAnswer([chat(2)])
    await t.read()
    t.state.agents.stdout = agentsAnswer([chat(1), chat(2)])
    await t.read()
    expect(t.src.list()[0].id).toBe(restingId('made-up-1'))
  })

  it('folds a chat into the hooked copy as a hook names its session, before the next read, and names that copy as Orca does', async () => {
    const t = setup()
    t.state.agents.stdout = agentsAnswer([chat(1), chat(2)])
    // With no chat listed, a hook folds nothing.
    t.state.heard = new Map([['made-up-9', { engine: 'claude', sessionId: 'claude-session-9' }]])
    t.src.refold()
    expect(t.src.list()).toEqual([])
    expect(t.changes()).toBe(0)
    await t.read()
    expect(t.src.paneNames()).toEqual(new Map([
      ['made-up-1', { title: 'Made up 1', renamed: false }], ['made-up-2', { title: 'Made up 2', renamed: false }],
    ]))
    expect(t.src.placed()).toEqual(new Map([[restingId('made-up-1'), 'made-up-1'], [restingId('made-up-2'), 'made-up-2']]))
    const before = t.changes()
    t.src.refold()
    expect(t.changes()).toBe(before)
    t.state.heard = new Map([['made-up-2', { engine: 'codex', sessionId: 'thread-2' }]])
    t.src.refold()
    expect(t.agentLists()).toBe(1)
    expect(t.changes()).toBe(before + 1)
    expect(t.src.list()[1]).toMatchObject({ id: observedAgentId('codex', 'thread-2'), engine: 'codex', sessionId: 'thread-2' })
    expect(t.src.placed().get(observedAgentId('codex', 'thread-2'))).toBe('made-up-2')
    expect(t.src.order()).toEqual([restingId('made-up-1'), observedAgentId('codex', 'thread-2')])
    expect(t.src.worktreeOfAgent(observedAgentId('codex', 'thread-2'))).toBe('made-up::/work/p2')
  })

  it('a chat heard by its hook is not a row of its own: its hooked copy is placed and named', async () => {
    const hookedId = observedAgentId('claude', 'claude-session-1')
    const hooked: HostAgent = {
      id: hookedId, engine: 'claude', sessionId: 'claude-session-1', name: 'claude', host: 'orca', app: 'orca',
      state: 'working', unseenDone: false, lastActivityAt: T,
    }
    const heard = new Map([[CHAT1.orcaSessionId, { engine: 'claude', sessionId: 'claude-session-1' }]])
    /** The observed source's copies, as the hooks gave them. */
    let live: HostAgent[] = []
    const observed: HostSource = { id: 'observed', list: () => live, capabilities: () => ({ status: true, voice: true, focus: true, answer: true }) }
    /** Chat 1's rows on the dial, with the source that gives each. */
    const chat1 = (src: OrcaChatSource) => {
      const entries = new HostRegistry([observed, src]).entries()
      expect(entries).toHaveLength(AGENTS.length)
      return entries
        .filter(({ agent }) => agent.id === hookedId || agent.id === restingId(CHAT1.orcaSessionId))
        .map(({ agent, source }) => [agent.id, source.id, agent.sessionId])
    }

    // The hook before the first read.
    live = [hooked]
    const first = setup()
    first.state.heard = heard
    await first.read()
    expect(chat1(first.src)).toEqual([[hookedId, 'observed', 'claude-session-1']])
    expect(first.src.placed().get(hookedId)).toBe(CHAT1.orcaSessionId)
    expect(first.src.paneNames().get(CHAT1.orcaSessionId)).toEqual({ title: 'Chat 1', renamed: false })
    expect(first.src.worktreeOfAgent(hookedId)).toBe(WT5)

    // The read before the first hook: the resting row, then the hooked copy once the hook names the session.
    live = []
    const second = setup()
    await second.read()
    expect(chat1(second.src)).toEqual([[restingId(CHAT1.orcaSessionId), 'orca-chat', undefined]])
    live = [hooked]
    second.state.heard = heard
    second.src.refold()
    expect(chat1(second.src)).toEqual([[hookedId, 'observed', 'claude-session-1']])
    // Its process ends: the card keeps its id, now the chat source's.
    live = []
    second.state.heard = new Map()
    second.src.refold()
    expect(chat1(second.src)).toEqual([[hookedId, 'orca-chat', 'claude-session-1']])
  })

  it('a tap on a listed chat asks the devices for it with its worktree; any other id opens nothing', async () => {
    const t = setup()
    await t.read()
    const row = t.src.list().find(({ name }) => name === 'Chat 1')!
    expect(await t.src.focus(row)).toBe(true)
    expect(t.focus).toHaveBeenLastCalledWith(row.id, WT5)
    expect(await t.src.focus({ ...row, id: 'someone-else' })).toBe(false)
    expect(t.focus).toHaveBeenCalledTimes(1)
    // A hooked copy's row: its worktree by the Orca id it is placed at.
    t.state.heard = new Map([[CHAT1.orcaSessionId, { engine: 'claude', sessionId: 'claude-session-1' }]])
    t.src.refold()
    const hooked = t.src.list().find(({ name }) => name === 'Chat 1')!
    expect(await t.src.focus(hooked)).toBe(true)
    expect(t.focus).toHaveBeenLastCalledWith(observedAgentId('claude', 'claude-session-1'), WT5)
    // Nothing is listed after a stop: a tap opens nothing.
    t.src.stop()
    expect(await t.src.focus(hooked)).toBe(false)
    expect(t.focus).toHaveBeenCalledTimes(2)
  })

  it('a rest on a listed chat shows it through the devices, as its tap does; any other id has no pane and shows nothing', async () => {
    const t = setup()
    const row0 = { id: 'someone-else' } as HostAgent
    expect(t.src.hasPane(row0)).toBe(false)
    await t.read()
    const row = t.src.list().find(({ name }) => name === 'Chat 1')!
    expect(t.src.hasPane(row)).toBe(true)
    expect(await t.src.showPane(row)).toBe('ok')
    expect(t.show).toHaveBeenLastCalledWith(row.id)
    expect(t.src.hasPane({ ...row, id: 'someone-else' })).toBe(false)
    expect(await t.src.showPane({ ...row, id: 'someone-else' })).toBe('failed')
    expect(t.show).toHaveBeenCalledTimes(1)
    // Nothing is listed after a stop: a rest shows nothing.
    t.src.stop()
    expect(t.src.hasPane(row)).toBe(false)
    expect(await t.src.showPane(row)).toBe('failed')
    expect(t.show).toHaveBeenCalledTimes(1)
  })

  it("tells a change of a row, of Orca's order or of the worktrees, never a new time alone", async () => {
    const t = setup()
    t.state.agents.stdout = agentsAnswer([chat(1), chat(2)])
    await t.read()
    expect(t.changes()).toBe(1)
    t.state.agents.stdout = agentsAnswer([chat(1, { updatedAt: T + 5 }), chat(2)])
    await t.read()
    expect(t.changes()).toBe(1)
    expect(t.src.list()[0].lastActivityAt).toBe(T + 5)
    const steps: Array<Record<string, unknown>> = [
      { state: 'working' },
      { state: 'working', lastAssistantMessage: 'Made up answer 1, longer' },
      { state: 'working', lastAssistantMessage: 'Made up answer 1, longer', title: 'Made up, renamed' },
      { state: 'working', lastAssistantMessage: 'Made up answer 1, longer', title: 'Made up, renamed', worktreeId: 'made-up::moved' },
    ]
    for (const [at, over] of steps.entries()) {
      t.state.agents.stdout = agentsAnswer([chat(1, over), chat(2)])
      await t.read()
      expect(t.changes()).toBe(2 + at)
    }
    // Orca's order alone moves the rank.
    t.state.agents.stdout = agentsAnswer([chat(2), chat(1, steps.at(-1))])
    await t.read()
    expect(t.changes()).toBe(6)
    // The worktrees' map, read again with nothing new, tells nothing.
    await t.read({ worktrees: true })
    expect(t.changes()).toBe(7)
    await t.read({ worktrees: true })
    expect(t.changes()).toBe(7)
    expect(t.said()).toEqual(['[orca-chat] read · <0.5s', '[orca-chat] listed · 2 chats · 0 heard'])
  })

  it("says the read's time in buckets, once per change of bucket", async () => {
    const t = setup()
    for (const took of [499, 100, 500, 1999, 2000, 9000]) {
      t.state.took = took
      await t.read()
    }
    // A failed read says its failure, not its time.
    t.state.took = 100
    t.state.agents = { code: 1, stdout: '' }
    await t.read()
    // Each attach says it again.
    t.state.agents = { code: 0, stdout: JSON.stringify(RECORDED_ORCA_AGENTS) }
    t.src.stop()
    await t.read()
    expect(t.said().filter((line) => !line.includes('listed'))).toEqual([
      '[orca-chat] read · <0.5s', '[orca-chat] read · <2s', '[orca-chat] read · >2s', '[orca-chat] read · failed · exit',
      '[orca-chat] read · <0.5s',
    ])
  })

  it("a listener that throws keeps neither the next from hearing nor the reads from going on, and a read's throw is caught", async () => {
    const t = setup()
    const heard = vi.fn()
    const off = t.src.onChange(() => { throw new Error('listener') })
    t.src.onChange(heard)
    await t.read()
    expect(heard).toHaveBeenCalledTimes(1)
    off()
    t.state.agents.stdout = agentsAnswer([chat(2)])
    await t.read()
    expect(heard).toHaveBeenCalledTimes(2)
    // heard() throwing is a throw of the read: the next read still runs.
    t.state.heard = { [Symbol.iterator]: () => { throw new Error('heard') } } as unknown as Map<string, HeardChat>
    t.state.agents.stdout = agentsAnswer([chat(3)])
    await t.read()
    t.state.heard = new Map()
    await t.read()
    expect(t.src.list().map(({ name }) => name)).toEqual(['Made up 3'])
    expect(t.agentLists()).toBe(4)
  })

  it('no log line holds a title, folder, id or workspace', async () => {
    const t = setup()
    t.state.heard = new Map([[CHAT1.orcaSessionId, { engine: 'claude', sessionId: 'claude-session-1' }]])
    await t.read({ worktrees: true })
    t.state.took = 3000
    t.state.agents.stdout = agentsAnswer([...AGENTS, chat(1, { orcaSessionId: 'x'.repeat(129) })])
    await t.read()
    // An exit that still printed the list, then an error that names a worktree.
    t.state.worktrees = { code: 2, stdout: JSON.stringify(RECORDED_ORCA_WORKTREES) }
    await t.read({ worktrees: true })
    t.state.agents = { code: 0, stdout: JSON.stringify({ ok: false, error: { message: `no worktree ${WT5}` } }) }
    await t.read()
    t.state.stamp = { realPath: ORCA, mtimeMs: 9 }
    t.state.help = { code: 0, stdout: HELP_NO_LIST }
    await t.read()
    const said = t.said()
    expect(said).toEqual([
      '[orca-chat] read · <0.5s', `[orca-chat] listed · ${AGENTS.length} chats · 1 heard`, '[orca-chat] read · >2s',
      '[orca-chat] read · failed · exit',
    ])
    for (const line of said) {
      expect(line).toMatch(LOG)
      for (const word of PRIVATE) expect(line).not.toContain(word)
    }
  })
})
