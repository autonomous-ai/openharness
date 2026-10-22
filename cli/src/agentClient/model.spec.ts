import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Ledger, ledgerPath } from './ledger.js'
import { asSaid, callerOf, clip, forAgent, lastTurn, matching, outsideCaller, rowsOf, stateOf, STOPPED_WITHIN_MS, type Frame, type Row } from './model.js'

describe('forAgent', () => {
  const row = (name: string, over: Partial<Row> = {}): Row => ({ name, id: name, agent: 'Codex', machine: 'm', state: 'idle', folder: null, branch: null,
    startedBy: 'person', yours: false, self: false, lastActive: null, ...over })
  it('puts its own first, then the working and the ones needing the person, then the rest, and counts the rest past 15', () => {
    const rows = [...Array.from({ length: 30 }, (_, i) => row(`idle${i}`)), row('busy', { state: 'working' }), row('mine1', { yours: true }), row('mine2', { yours: true })]
    const { shown, more } = forAgent(rows)
    expect(shown.map((r) => r.name).slice(0, 3)).toEqual(['mine1', 'mine2', 'busy'])
    expect(shown).toHaveLength(15)
    expect(more).toBe(18)
  })
  it('shows every row when there are 15 or fewer', () => {
    expect(forAgent([row('a'), row('b')])).toEqual({ shown: [row('a'), row('b')], more: 0 })
  })
})

const dirs: string[] = []
const ledger = (): Ledger => {
  const dir = mkdtempSync(join(tmpdir(), 'model-'))
  dirs.push(dir)
  return new Ledger(ledgerPath(dir))
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const NOW = Date.parse('2026-10-11T12:00:00Z')
const frame = (id: string, over: Partial<Frame> = {}): Frame => ({
  id, sessionId: `s-${id}`, name: id, engine: 'claude', status: 'active', activity: { state: 'idle' }, tmuxPane: `%${id.length}`,
  project: { cwd: `/work/${id}`, branch: 'main' }, createdAt: '2026-10-11T10:00:00Z', updatedAt: '2026-10-11T11:00:00Z', ...over,
})

describe('a harness as the agent verbs show it', () => {
  it('has one state from its status and activity', () => {
    expect(stateOf(frame('a', { status: 'stopped' }))).toBe('stopped')
    expect(stateOf(frame('a', { status: 'offline' }))).toBe('offline')
    expect(stateOf(frame('a', { activity: { state: 'working' } }))).toBe('working')
    expect(stateOf(frame('a'))).toBe('idle')
    expect(stateOf(frame('a', { activity: null }))).toBe('unknown')
  })

  it('knows the caller by its pane in any state, and a terminal is not one', () => {
    const frames = [frame('lead', { tmuxPane: '%4' }), frame('sh', { tmuxPane: '%5', engine: 'terminal' }), frame('old', { tmuxPane: '%6', status: 'stopped' }),
      frame('away', { tmuxPane: '%8', status: 'offline' }), frame('older', { tmuxPane: '%6', status: 'stopped', updatedAt: '2026-10-01T00:00:00Z' }),
      // tmux numbered panes anew: a person's terminal now has a stopped harness's old pane.
      frame('ghost', { tmuxPane: '%5', status: 'stopped' })]
    expect(callerOf(frames, '%4', 'm')).toEqual({ machineId: 'm', agentId: 'lead', name: 'lead', engine: 'claude' })
    expect(callerOf(frames, '%5', 'm')).toBeNull()
    // Stopped or offline, an agent is still that agent, never the person.
    expect(callerOf(frames, '%6', 'm')?.agentId).toBe('old')
    expect(callerOf(frames, '%8', 'm')?.agentId).toBe('away')
    expect(callerOf(frames, '%99', 'm')).toBeNull()
    expect(callerOf([frame('x', { tmuxPane: '%1', status: 'stopped', updatedAt: undefined }), frame('y', { tmuxPane: '%1', status: 'stopped', updatedAt: undefined })], '%1', 'm')?.agentId).toBe('x')
    expect(callerOf(frames, undefined, 'm')).toBeNull()
    expect(callerOf([frame('abcdefghij', { name: '', tmuxPane: '%7' })], '%7', 'm')?.name).toBe('abcdefgh')
  })

  it('knows an agent outside Harness by what it sets in its shell, one caller a session', () => {
    expect(outsideCaller({}, 'm')).toBeNull()
    expect(outsideCaller({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: ' S1 ', AI_AGENT: 'claude-code_2-1-296_agent' }, 'm'))
      .toEqual({ machineId: 'm', agentId: 'claude-code:S1', name: 'Claude Code', engine: 'claude', outside: true })
    expect(outsideCaller({ CODEX_THREAD_ID: 'T1' }, 'm')).toEqual({ machineId: 'm', agentId: 'codex:T1', name: 'Codex', engine: 'codex', outside: true })
    // An agent that names only itself is one caller for every session of it.
    expect(outsideCaller({ AI_AGENT: 'cursor_1-2_agent' }, 'm')).toEqual({ machineId: 'm', agentId: 'agent:cursor', name: 'Cursor', engine: 'cursor', outside: true })
    expect(outsideCaller({ AI_AGENT: 'claude-desktop' }, 'm')).toMatchObject({ name: 'Claude Desktop', engine: 'claude-desktop' })
    expect(outsideCaller({ AI_AGENT: 'codex' }, 'm')).toMatchObject({ name: 'Codex', engine: 'codex' })
    expect(outsideCaller({ AI_AGENT: 'newagent' }, 'm')).toMatchObject({ name: 'newagent' })
    expect(outsideCaller({ CLAUDECODE: '1' }, 'm')).toMatchObject({ agentId: 'agent:claude-code', name: 'Claude Code', engine: 'claude' })
    expect(outsideCaller({ CLAUDECODE: '0', CLAUDE_CODE_SESSION_ID: 'S1' }, 'm')).toBeNull()
    // What runs `harness` for it and knows its session says so (`harness mcp`).
    expect(outsideCaller({ AI_AGENT: 'cursor', HARNESS_AGENT_SESSION: 'mcp-42' }, 'm')).toMatchObject({ agentId: 'agent:cursor:mcp-42', name: 'Cursor' })
    expect(outsideCaller({ AI_AGENT: '  ' }, 'm')).toBeNull()
  })

  it('lists agents only, working first, says who started each, and keeps a stopped one a week with --all', () => {
    const l = ledger()
    l.append({ at: 1, depth: 1, by: { machineId: 'm', agentId: 'lead', name: 'lead', engine: 'claude' }, child: { machineId: 'm', agentId: 'kid', name: 'kid' } })
    l.append({ at: 1, depth: 1, by: { machineId: 'm', agentId: 'other', name: 'other', engine: 'codex' }, child: { machineId: 'm', agentId: 'cousin', name: 'cousin' } })
    const frames = [
      frame('lead'), frame('kid', { activity: { state: 'working' } }), frame('cousin', { updatedAt: '2026-10-11T11:30:00Z' }),
      frame('sh', { engine: 'terminal' }),
      frame('recent', { status: 'stopped', updatedAt: new Date(NOW - 60_000).toISOString() }),
      frame('ancient', { status: 'stopped', updatedAt: new Date(NOW - STOPPED_WITHIN_MS - 1).toISOString() }),
      frame('wt', { project: { cwd: '/work/repo/.wt/x', root: '/work/repo', worktree: true, branch: null }, updatedAt: 'nonsense' }),
    ]
    const caller = { machineId: 'm', agentId: 'lead', name: 'lead', engine: 'claude' }
    const rows = rowsOf(frames, { machineId: 'm', machine: 'mac', caller, ledger: l, now: NOW, all: false })
    expect(rows.map((r) => r.name)).toEqual(['kid', 'cousin', 'lead', 'wt'])
    const by = Object.fromEntries(rows.map((r) => [r.name, r]))
    expect(by.kid).toMatchObject({ startedBy: 'you', yours: true, self: false, state: 'working', agent: 'Claude Code', machine: 'mac' })
    expect(by.cousin).toMatchObject({ startedBy: 'other', yours: false })
    expect(by.lead).toMatchObject({ startedBy: 'person', self: true, folder: '/work/lead', branch: 'main' })
    expect(by.wt).toMatchObject({ folder: '/work/repo', branch: null, lastActive: null })
    const all = rowsOf(frames, { machineId: 'm', machine: 'mac', caller: null, ledger: l, now: NOW, all: true })
    expect(all.map((r) => r.name)).toContain('recent')
    expect(all.map((r) => r.name)).not.toContain('ancient')
    expect(all.find((r) => r.name === 'kid')).toMatchObject({ startedBy: 'lead', yours: false })
  })

  it('keeps a cloud maker\'s status beside the row, and leaves every other harness as it was', () => {
    const asleep = frame('asleep', { engine: 'devin-cloud', location: 'cloud', status: 'stopped', activity: { state: 'idle' },
      cloud: { state: 'stopped', activity: 'Devin went to sleep after inactivity.', providerStatus: { status: 'suspended', detail: 'inactivity' } },
      updatedAt: new Date(NOW - 1_000).toISOString() })
    const fo = frame('fo', { engine: 'fo', location: 'cloud', cloud: { state: 'idle', activity: 'Calling Hair Lab' } })
    const rows = rowsOf([frame('lead'), asleep, fo], { machineId: 'm', machine: 'mac', caller: null, ledger: ledger(), now: NOW, all: true })
    expect(rows.find((r) => r.name === 'asleep')).toMatchObject({ state: 'stopped', cloud: { state: 'stopped', activity: 'Devin went to sleep after inactivity.', providerStatus: { status: 'suspended', detail: 'inactivity' } } })
    expect(rows.find((r) => r.name === 'fo')!.cloud).toEqual({ state: 'idle', activity: 'Calling Hair Lab' })
    expect(rows.find((r) => r.name === 'lead')).not.toHaveProperty('cloud')
    expect(rowsOf([asleep], { machineId: 'm', machine: 'mac', caller: null, ledger: ledger(), now: NOW, all: false })).toEqual([])
  })

  it('names every agent as the app does, never by its id', () => {
    // `harness ps` listed a Kilo harness as "kilo": the table here knew six agents and passed the rest through.
    const named = (engine: string) => rowsOf([frame('a', { engine })], { machineId: 'm', machine: 'mac', caller: null, ledger: ledger(), now: NOW, all: false })[0]!.agent
    expect(['claude', 'codex', 'opencode', 'cursor', 'grok', 'pi'].map(named)).toEqual(['Claude Code', 'Codex', 'OpenCode', 'Cursor', 'Grok', 'pi'])
    expect(['kilo', 'amp', 'copilot', 'devin', 'hermes', 'muse', 'commandcode', 'agy'].map(named))
      .toEqual(['Kilo', 'Amp', 'Copilot', 'Devin', 'Hermes', 'Muse', 'Command Code', 'Antigravity'])
    // One Harness does not know yet is still said, as it calls itself.
    expect(named('newagent')).toBe('newagent')
  })

  it('finds a harness by its whole name, a name\'s start, or an id\'s start', () => {
    const rows = [{ name: 'Reviewer', id: 'aaaaaaaa-1' }, { name: 'reviewer-2', id: 'bbbbbbbb-2' }, { name: 'fixer', id: 'cccccccc-3' }]
    expect(matching('reviewer', rows).map((r) => r.id)).toEqual(['aaaaaaaa-1'])
    expect(matching('rev', rows)).toHaveLength(2)
    expect(matching('fix', rows).map((r) => r.id)).toEqual(['cccccccc-3'])
    expect(matching('cccccc', rows).map((r) => r.id)).toEqual(['cccccccc-3'])
    expect(matching('ccc', rows)).toEqual([])
    expect(matching('bbbbbbbb-2', rows).map((r) => r.name)).toEqual(['reviewer-2'])
    expect(matching('  ', rows)).toEqual([])
  })

  it('reads the last turn: the ask, the answer after its last tool call, and whether it has answered', () => {
    const ev = (type: string, payload: Record<string, unknown> = {}) => ({ type, payload })
    expect(lastTurn([])).toBeNull()
    expect(lastTurn([ev('text_delta', { content: 'orphan' })])).toBeNull()
    const turn = lastTurn([
      ev('user_message', { content: 'old' }), ev('text_delta', { content: 'old answer' }), ev('done'),
      ev('user_message', { content: '  fix the test ' }), ev('text_delta', { content: 'Looking.' }),
      ev('tool_start'), ev('tool_end'), ev('tool_start'), ev('tool_end'),
      ev('text_delta', { content: 'Fixed ' }), ev('text_delta', { content: 'it.' }), ev('done', { result: 'success' }),
    ])
    expect(turn).toEqual({ ask: 'fix the test', answer: 'Fixed it.', tools: 2, answered: true })
    // Still working, as the history reader pages it: a `done` at the end of every newest page all the same.
    expect(lastTurn([ev('user_message', { content: 'go' }), ev('text_delta', { content: 'Starting.' }), ev('tool_start'), ev('tool_end'), ev('done', { result: 'success' })]))
      .toEqual({ ask: 'go', answer: 'Starting.', tools: 1, answered: false })
    // A tool that has not answered yet is the turn's last word.
    expect(lastTurn([ev('user_message', { content: 'go' }), ev('tool_start'), ev('done', { result: 'success' })]))
      .toEqual({ ask: 'go', answer: '', tools: 1, answered: false })
    expect(lastTurn([ev('user_message'), ev('text_delta', { content: 'Hi.' })])).toEqual({ ask: null, answer: 'Hi.', tools: 0, answered: true })
    expect(lastTurn([ev('user_message', { content: 'x' }), ev('text_delta', { content: 7 })])).toEqual({ ask: 'x', answer: '', tools: 0, answered: false })
  })

  it('reads an ask without the markers around a paste, and keeps what was pasted', () => {
    const ev = (type: string, payload: Record<string, unknown> = {}) => ({ type, payload })
    const pasted = 'another agent release: \n\n<pasted_content id="1c18">\n#1242 is merged\n  and released\n</pasted_content id="1c18">\n'
    expect(lastTurn([ev('user_message', { content: pasted }), ev('text_delta', { content: 'ok' })])?.ask)
      .toBe('another agent release: \n\n#1242 is merged\n  and released')
    expect(asSaid('<pasted_content id="aa">\nfirst\n</pasted_content id="aa">\n\n\n<pasted_content id="bb">\nsecond\n</pasted_content id="bb">')).toBe('first\n\nsecond')
    expect(asSaid('<pasted_content id="aa"> one line </pasted_content id="aa"> then more')).toBe('one line then more')
    // Only a paste's markers: an ask that is nothing else is no ask, and other tags were said.
    expect(lastTurn([ev('user_message', { content: '<pasted_content id="aa">\n</pasted_content id="aa">' })])?.ask).toBeNull()
    expect(asSaid('make <b>this</b> bold, in a pasted_content test')).toBe('make <b>this</b> bold, in a pasted_content test')
  })

  it('clips long text with an ellipsis', () => {
    expect(clip('abcdef', 4)).toBe('abc…')
    expect(clip('abc', 4)).toBe('abc')
  })
})
