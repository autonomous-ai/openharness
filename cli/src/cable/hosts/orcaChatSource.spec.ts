import { afterEach, describe, expect, it, vi } from 'vitest'
import { observedAgentId } from './observed.js'
import { ORCA_CHAT_POLL_MS, ORCA_CHAT_TIMEOUT_MS, ORCA_CHATS, OrcaChatSource, type HeardChat, type OrcaChatSourceDeps } from './orcaChatSource.js'
import { capsLetters } from './types.js'

const T = 1_795_000_000_000
const ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca'
const LOG = /^\[orca-chat\] (listed · \d+ chats · \d+ heard|read · failed · (unreadable|no answer|exit))$/
/** The n-th chat row as `orca agent list --json` prints it, older as n grows. */
const chat = (n: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  orcaSessionId: `0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`,
  kind: 'chat',
  agent: 'claude',
  state: 'done',
  worktreeId: `e19bb2fa-6a7c-40c3-aa10-c79ae2fffe68::/work/p${n}`,
  workspace: `Workspace ${n}`,
  repo: 'repo',
  hostId: 'local',
  paneKey: `structured-agent-session-${n}`,
  title: `Chat ${n}`,
  lastAssistantMessage: `Answer ${n}`,
  updatedAt: T - n * 1000,
  ...over,
})
const idOf = (n: number) => `0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`
const answer = (agents: unknown[]): string => JSON.stringify({ id: 'x', ok: true, result: { agents, truncated: false, hostScope: 'local' }, _meta: {} })
/** Lets what the source was answered be taken in. */
const turn = () => new Promise((resolve) => setImmediate(resolve))

/** Every line any source said: checked after each test. */
const lines: string[] = []

describe("Orca's chats on a Harness Max", () => {
  afterEach(() => {
    for (const line of lines.splice(0)) {
      expect(line).toMatch(LOG)
      for (const word of ['Chat', 'Answer', '/work', 'Workspace', '0000000']) expect(line).not.toContain(word)
    }
  })

  /** A source whose reads answer what `orca` holds, with a Max attached, and timers the test fires. */
  function setup() {
    const timers: Array<{ ms: number; run: () => void; cancelled: boolean }> = []
    const state = {
      wanted: true,
      binary: ORCA as string | null,
      orca: { code: 0 as number | null, stdout: answer([chat(1)]) },
      heard: new Map<string, HeardChat>(),
    }
    const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = []
    /** A read the test answers by hand, when set: each run waits on it. */
    const held: Array<(answer: { code: number | null; stdout: string }) => void> = []
    let holding = false
    const focus = vi.fn(async (_agentId: string) => true)
    let changes = 0
    const deps: OrcaChatSourceDeps = {
      binary: () => state.binary,
      run: async (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        if (holding) return new Promise((resolve) => held.push(resolve))
        return state.orca
      },
      wanted: () => state.wanted,
      heard: () => state.heard,
      after: (ms, run) => {
        const timer = { ms, run, cancelled: false }
        timers.push(timer)
        return () => { timer.cancelled = true }
      },
      focus,
      log: (line) => { lines.push(line) },
    }
    const src = new OrcaChatSource(deps)
    src.onChange(() => { changes++ })
    /** The poll's next read, as its timer fires. */
    const poll = async (): Promise<void> => {
      const timer = timers.filter((t) => !t.cancelled).at(-1)
      expect(timer?.ms).toBe(ORCA_CHAT_POLL_MS)
      timer!.cancelled = true
      timer!.run()
      await turn()
    }
    return {
      src, state, calls, focus, timers, poll, held,
      hold: () => { holding = true },
      changes: () => changes,
      live: () => timers.filter((t) => !t.cancelled).length,
      said: () => [...lines],
    }
  }

  it("lists Orca's chats on Orca's page as resting rows, the newest first, read with Orca's CLI", async () => {
    const t = setup()
    t.state.orca.stdout = answer([
      chat(2, { state: 'working', lastAssistantMessage: 'Line one\n\tline\u0007 two  ' }),
      { ...chat(3), kind: 'terminal' },
      chat(1, { state: 'blocked', agent: 'codex' }),
      chat(4, { state: 'waiting' }),
    ])
    t.src.start()
    await turn()
    expect(t.calls).toEqual([{ file: ORCA, args: ['agent', 'list', '--json'], timeoutMs: ORCA_CHAT_TIMEOUT_MS }])
    expect(t.src.list()).toEqual([
      {
        id: observedAgentId('orca', idOf(1)), engine: 'codex', name: 'Chat 1', cwd: '/work/p1', host: 'orca', app: 'orca',
        state: 'needs-you', unseenDone: false, resting: true, lastActivityAt: T - 1000, lastAnswer: 'Answer 1',
      },
      expect.objectContaining({ id: observedAgentId('orca', idOf(2)), engine: 'claude', state: 'working', lastAnswer: 'Line one line two' }),
      expect.objectContaining({ id: observedAgentId('orca', idOf(4)), state: 'needs-you' }),
    ])
    expect(t.changes()).toBe(1)
    expect(capsLetters(t.src.capabilities())).toBe(capsLetters({ status: true, voice: false, focus: true, answer: false }))
    expect(t.said()).toEqual(['[orca-chat] listed · 3 chats · 0 heard'])
    // The next read is the poll's, one at a time: a timer after this read's end.
    expect(t.live()).toBe(1)
  })

  it('names an untitled chat by its workspace, else by its CLI, and keeps no folder that is not a whole path', async () => {
    const t = setup()
    t.state.orca.stdout = answer([
      chat(1, { title: '   ', worktreeId: 'no-separator' }),
      chat(2, { title: undefined, workspace: undefined, worktreeId: 'repo::relative/path', lastAssistantMessage: ' \n ' }),
      chat(3, { title: 'x'.repeat(80), worktreeId: 'repo::/work/\u0001p3', lastAssistantMessage: 'y'.repeat(400) }),
      chat(4, { worktreeId: 7, lastAssistantMessage: 7, state: 'sleeping' }),
    ])
    t.src.start()
    await turn()
    const [one, two, three, four] = t.src.list()
    expect(one).toMatchObject({ name: 'Workspace 1' })
    expect(one.cwd).toBeUndefined()
    expect(two).toMatchObject({ name: 'claude' })
    expect(two.cwd).toBeUndefined()
    expect(two.lastAnswer).toBeUndefined()
    expect(three.name).toBe('x'.repeat(64))
    expect(three.cwd).toBeUndefined()
    expect(Array.from(three.lastAnswer!)).toHaveLength(300)
    expect(three.lastAnswer!.endsWith('…')).toBe(true)
    expect(four).toMatchObject({ state: 'idle' })
    expect(four.cwd).toBeUndefined()
    expect(four.lastAnswer).toBeUndefined()
  })

  it("leaves out a row that is not Orca's, keeps a chat named twice once, and lists the newest 16", async () => {
    const t = setup()
    const many = Array.from({ length: ORCA_CHATS + 4 }, (_, n) => chat(n + 10, { orcaSessionId: `chat-${n}`, updatedAt: T + n }))
    t.state.orca.stdout = answer([
      null, 'chat', [chat(1)],
      chat(2, { orcaSessionId: '' }),
      chat(3, { orcaSessionId: 'x'.repeat(129) }),
      chat(4, { orcaSessionId: 'bad\nid' }),
      chat(5, { orcaSessionId: 5 }),
      chat(6, { agent: 'Claude Code' }),
      chat(7, { agent: undefined }),
      chat(8, { updatedAt: '1' }),
      chat(9, { updatedAt: Number.NaN }),
      ...many,
      chat(1, { orcaSessionId: 'chat-0', title: 'Second copy', updatedAt: T + 1000 }),
    ])
    t.src.start()
    await turn()
    const names = t.src.list().map(({ name }) => name)
    expect(names).toHaveLength(ORCA_CHATS)
    // chat-0's first copy is kept, at its own time: the oldest, so past the 16.
    expect(names).not.toContain('Second copy')
    expect(t.src.list()[0].id).toBe(observedAgentId('orca', `chat-${ORCA_CHATS + 3}`))
    expect(t.src.list().map(({ id }) => id)).not.toContain(observedAgentId('orca', 'chat-0'))
  })

  it("gives a chat a hook told of the hooked copy's id and session, and keeps them past that copy's end", async () => {
    const t = setup()
    t.state.orca.stdout = answer([chat(1), chat(2)])
    t.state.heard.set(idOf(1), { engine: 'claude', sessionId: 'claude-session-1' })
    t.state.heard.set('other-orca-chat', { engine: 'claude', sessionId: 'claude-session-9' })
    t.src.start()
    await turn()
    expect(t.src.list()[0]).toMatchObject({ id: observedAgentId('claude', 'claude-session-1'), engine: 'claude', sessionId: 'claude-session-1' })
    expect(t.src.list()[1].sessionId).toBeUndefined()
    expect(t.said()).toEqual(['[orca-chat] listed · 2 chats · 1 heard'])
    // The hooked copy is dropped: the chat still sits in Orca under that session.
    t.state.heard.clear()
    await t.poll()
    expect(t.src.list()[0].id).toBe(observedAgentId('claude', 'claude-session-1'))
    // The chat leaves Orca's list, then comes back: its session went with it.
    t.state.orca.stdout = answer([chat(2)])
    await t.poll()
    t.state.orca.stdout = answer([chat(1), chat(2)])
    await t.poll()
    expect(t.src.list()[0].id).toBe(observedAgentId('orca', idOf(1)))
  })

  it("folds a chat into the hooked copy as a hook names its session, before the next read, and names that copy as Orca does", async () => {
    const t = setup()
    t.state.orca.stdout = answer([chat(1), chat(2)])
    // With no chat listed, a hook folds nothing.
    t.state.heard.set(idOf(9), { engine: 'claude', sessionId: 'claude-session-9' })
    t.src.refold()
    expect(t.src.list()).toEqual([])
    expect(t.changes()).toBe(0)
    t.src.start()
    await turn()
    expect(t.src.paneNames()).toEqual(new Map([[idOf(1), { title: 'Chat 1', renamed: false }], [idOf(2), { title: 'Chat 2', renamed: false }]]))
    expect(t.src.placed()).toEqual(new Map([[observedAgentId('orca', idOf(1)), idOf(1)], [observedAgentId('orca', idOf(2)), idOf(2)]]))
    const before = t.changes()
    t.src.refold()
    expect(t.changes()).toBe(before)
    t.state.heard.set(idOf(2), { engine: 'codex', sessionId: 'thread-2' })
    t.src.refold()
    expect(t.calls).toHaveLength(1)
    expect(t.changes()).toBe(before + 1)
    expect(t.src.list()[1]).toMatchObject({ id: observedAgentId('codex', 'thread-2'), engine: 'codex', sessionId: 'thread-2' })
    expect(t.src.placed().get(observedAgentId('codex', 'thread-2'))).toBe(idOf(2))
  })

  it('tells a change of a row, never a new time alone', async () => {
    const t = setup()
    t.src.start()
    await turn()
    expect(t.changes()).toBe(1)
    t.state.orca.stdout = answer([chat(1, { updatedAt: T + 5 })])
    await t.poll()
    expect(t.changes()).toBe(1)
    expect(t.src.list()[0].lastActivityAt).toBe(T + 5)
    t.state.orca.stdout = answer([chat(1, { state: 'working' })])
    await t.poll()
    expect(t.changes()).toBe(2)
    t.state.orca.stdout = answer([chat(1, { state: 'working', lastAssistantMessage: 'Answer 1, longer' })])
    await t.poll()
    expect(t.changes()).toBe(3)
    t.state.orca.stdout = answer([chat(1, { state: 'working', lastAssistantMessage: 'Answer 1, longer', title: 'Renamed' })])
    await t.poll()
    expect(t.changes()).toBe(4)
    // Counts unchanged say nothing more.
    expect(t.said()).toEqual(['[orca-chat] listed · 1 chats · 0 heard'])
  })

  it('reads nothing and lists nothing while no Max is attached, and lists again once one is', async () => {
    const t = setup()
    t.state.wanted = false
    t.src.start()
    await turn()
    expect(t.calls).toHaveLength(0)
    expect(t.src.list()).toEqual([])
    expect(t.changes()).toBe(0)
    expect(t.live()).toBe(1)
    t.state.wanted = true
    await t.poll()
    expect(t.src.list()).toHaveLength(1)
    // The Max goes, a Pro stays: its rows go at the next read, and its count is said again when a Max comes back.
    t.state.wanted = false
    await t.poll()
    expect(t.src.list()).toEqual([])
    expect(t.src.paneNames()).toEqual(new Map())
    expect(t.changes()).toBe(2)
    expect(t.calls).toHaveLength(1)
    t.state.wanted = true
    await t.poll()
    expect(t.said()).toEqual(['[orca-chat] listed · 1 chats · 0 heard', '[orca-chat] listed · 1 chats · 0 heard'])
  })

  it('reads nothing with Orca not installed', async () => {
    const t = setup()
    t.state.binary = null
    t.src.start()
    await turn()
    expect(t.calls).toHaveLength(0)
    expect(t.src.list()).toEqual([])
    expect(t.live()).toBe(1)
  })

  it('drops the rows on a read that fails, says one line for a run of failures, and lists again after', async () => {
    const t = setup()
    t.src.start()
    await turn()
    t.state.orca = { code: 1, stdout: '' }
    await t.poll()
    expect(t.src.list()).toEqual([])
    expect(t.changes()).toBe(2)
    t.state.orca = { code: null, stdout: '' }
    await t.poll()
    t.state.orca = { code: 0, stdout: '{"ok":' }
    await t.poll()
    t.state.orca = { code: 0, stdout: JSON.stringify({ ok: false, error: 'not running' }) }
    await t.poll()
    t.state.orca = { code: 0, stdout: JSON.stringify({ ok: true, result: { agents: {} } }) }
    await t.poll()
    t.state.orca = { code: 0, stdout: JSON.stringify([1]) }
    await t.poll()
    expect(t.changes()).toBe(2)
    expect(t.said()).toEqual(['[orca-chat] listed · 1 chats · 0 heard', '[orca-chat] read · failed · exit'])
    t.state.orca = { code: 0, stdout: answer([chat(1)]) }
    await t.poll()
    expect(t.src.list()).toHaveLength(1)
    t.state.orca = { code: null, stdout: '' }
    await t.poll()
    t.state.orca = { code: 0, stdout: 'not json' }
    t.src.stop()
    t.src.start()
    await turn()
    expect(t.said().slice(2)).toEqual([
      '[orca-chat] listed · 1 chats · 0 heard', '[orca-chat] read · failed · no answer', '[orca-chat] read · failed · unreadable',
    ])
  })

  it('a failed read with nothing listed tells no change', async () => {
    const t = setup()
    t.state.orca = { code: 2, stdout: '' }
    t.src.start()
    await turn()
    expect(t.changes()).toBe(0)
    expect(t.live()).toBe(1)
  })

  it('stops: its timer cancelled, its rows gone, and a read under way taking nothing', async () => {
    const t = setup()
    t.src.start()
    t.src.start()
    await turn()
    expect(t.calls).toHaveLength(1)
    t.src.stop()
    t.src.stop()
    expect(t.live()).toBe(0)
    expect(t.src.list()).toEqual([])
    expect(t.changes()).toBe(2)
    // A start, then a stop while its read is under way: the read lands on nothing and asks for no next one.
    t.hold()
    t.src.start()
    await turn()
    t.src.stop()
    t.held[0]({ code: 0, stdout: answer([chat(1)]) })
    await turn()
    expect(t.src.list()).toEqual([])
    expect(t.live()).toBe(0)
    // A stop and a start while a read is under way: the old read takes nothing, the new start's read lists.
    t.src.start()
    await turn()
    t.src.stop()
    t.src.start()
    await turn()
    t.held[1]({ code: 0, stdout: answer([chat(1), chat(2)]) })
    await turn()
    expect(t.src.list()).toEqual([])
    t.held[2]({ code: 0, stdout: answer([chat(3)]) })
    await turn()
    expect(t.src.list().map(({ name }) => name)).toEqual(['Chat 3'])
    expect(t.live()).toBe(1)
  })

  it('a tap on a listed chat brings Orca forward; any other id opens nothing', async () => {
    const t = setup()
    t.src.start()
    await turn()
    const [row] = t.src.list()
    expect(await t.src.focus(row)).toBe(true)
    expect(t.focus).toHaveBeenCalledWith(row.id)
    expect(await t.src.focus({ ...row, id: 'someone-else' })).toBe(false)
    expect(t.focus).toHaveBeenCalledTimes(1)
  })

  it("a listener that throws keeps neither the next from hearing nor the poll from going on, and a read's throw is caught", async () => {
    const t = setup()
    const heard = vi.fn()
    const off = t.src.onChange(() => { throw new Error('listener') })
    t.src.onChange(heard)
    t.src.start()
    await turn()
    expect(heard).toHaveBeenCalledTimes(1)
    expect(t.live()).toBe(1)
    off()
    t.state.orca.stdout = answer([chat(2)])
    await t.poll()
    expect(heard).toHaveBeenCalledTimes(2)
    // heard() throwing is a throw of the read: the poll goes on.
    t.state.heard = { [Symbol.iterator]: () => { throw new Error('heard') } } as unknown as Map<string, HeardChat>
    t.state.orca.stdout = answer([chat(3)])
    await t.poll()
    expect(t.live()).toBe(1)
  })
})
