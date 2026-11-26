import { describe, expect, it } from 'vitest'
import type { PageAgent, Place } from './adapter.js'
import { detectApp, detectHost } from './hostDetect.js'
import { bundleOf, createOpenActions, type OpenTarget } from './open.js'
import { createVscodeAdapter, createVscodeClientAdapter, termPid } from './vscode.js'
import type { VscodeTyped } from './vscodeTerminals.js'
import type { WindowsRaise } from './windowsRaise.js'

const OPEN = '/usr/bin/open'
/** A Claude Code session's id, as its hook names it. */
const UUID = '8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
const UUID2 = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'
const VSCODE = 'com.microsoft.VSCode'
const link = (id: string) => `vscode://anthropic.claude-code/open?session=${id}`

interface Call { file: string; args: string[]; timeoutMs: number }
type Deps = Parameters<typeof createVscodeAdapter>[1]
interface Terminal { window: string; shell: number }

/** A recording runner that runs nothing, so no spec opens the developer's own VS Code: each call answers the next of
 *  [codes], then exit 0. VS Code is in front unless told. The opener holds this adapter alone. No window holds a
 *  terminal until a test sets `windows.held`; each show, scroll and page-key ask is recorded, and `asked` keeps the
 *  order of the terminal's looks beside a test's own. The terminals take page keys while the agent does not ask. Each
 *  window types while `windows.types` says so, and each send of words is recorded and answers `windows.typed`. The
 *  adapter is VS Code's unless [editor] names Cursor. */
function recorder(over: Partial<Deps> = {}, codes: Array<number | null> = [], editor: 'vscode' | 'cursor' = 'vscode') {
  const calls: Call[] = []
  const logs: string[] = []
  const windows = { held: undefined as Terminal | undefined, writes: true, shows: [] as Array<{ terminal: Terminal; tap: boolean }>,
    scrolls: [] as Array<{ terminal: Terminal; lines: number; page?: boolean }>,
    guards: [] as Array<{ pid: number; agent: PageAgent }>,
    types: true, typed: 'typed' as VscodeTyped,
    sends: [] as Array<{ pid: number; words: string; atPrompt: () => boolean }>,
    typeAsks: [] as number[] }
  const asked: string[] = []
  const deps: Deps = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return { code: codes.length ? codes.shift()! : 0, stdout: '' }
    },
    platform: 'darwin',
    onPath: () => null,
    inFront: () => true,
    terminals: {
      terminalOf: () => { asked.push('terminalOf'); return windows.held },
      show: (terminal, tap) => { windows.shows.push({ terminal, tap }); return windows.writes },
      scroll: (terminal, lines, page) => { windows.scrolls.push({ terminal, lines, page }); return windows.writes },
      pageKeys: (pid, agent) => { windows.guards.push({ pid, agent }); return agent.asking ? false : Promise.resolve(true) },
      canType: (pid) => { windows.typeAsks.push(pid); return windows.types },
      type: async (pid, words, atPrompt) => { windows.sends.push({ pid, words, atPrompt }); return windows.typed },
    },
    ...over,
  }
  const adapter = createVscodeAdapter(editor, deps)
  const log = (line: string) => { logs.push(line) }
  return {
    calls, logs, adapter, windows, asked,
    opener: createOpenActions({ run: deps.run, platform: deps.platform, adapters: [adapter], log }),
  }
}

/** What an agent's hook hints let a tap open, as the observed source reads them, for the hook's session and engine. */
const target = (hints: Record<string, string>, sessionId = UUID, engine = 'claude'): OpenTarget => {
  const place = { host: detectHost(hints), app: detectApp(hints), hints, sessionId, engine }
  return { bundle: bundleOf(place.host, hints), pane: recorder().adapter.paneOf(place) }
}
const run = (file: string, ...args: string[]): Call => ({ file, args, timeoutMs: 10_000 })
const forward = (bundle: string): Call => run(OPEN, '-b', bundle)

describe('the VS Code adapter', () => {
  it('its id is vscode, a tap is its link instead of its app, and only macOS can focus or show', async () => {
    const pane = { adapter: 'vscode', id: UUID }
    const { adapter } = recorder()
    expect(adapter.id).toBe('vscode')
    expect(adapter.tap).toBe('instead')
    expect(adapter.show).toBeTypeOf('function')
    expect(adapter.canShow).toBeTypeOf('function')
    expect(adapter.type).toBeTypeOf('function')
    expect(adapter.canFocus(pane)).toBe(true)
    expect(adapter.canShow(pane)).toBe(true)
    expect(recorder({ inFront: () => false }).adapter.canShow(pane)).toBe(false)
    for (const platform of ['linux', 'win32'] as const) {
      const elsewhere = recorder({ platform })
      // On Linux the first look answers yes while xdg-mime is read: a tap's focus waits for that read (appLink.ts).
      expect(elsewhere.adapter.canFocus(pane), platform).toBe(platform === 'linux')
      expect(elsewhere.adapter.canShow(pane), platform).toBe(false)
      expect(await elsewhere.adapter.focus(pane), platform).toBe(false)
      expect(await elsewhere.adapter.show(pane, 'a1'), platform).toBe('failed')
      expect(elsewhere.calls).toEqual([])
    }
  })

  // The end-to-end harness points HARNESS_OPEN_BIN at a fake that opens nothing (e2e/harness/daemon.ts), as open.ts
  // takes it.
  it.each([
    ['/tmp/e2e/fake-open', '/tmp/e2e/fake-open'],
    ['', OPEN],
    ['fake-open', OPEN],
    [undefined, OPEN],
  ])('HARNESS_OPEN_BIN %j: an absolute path is the open a tap runs; empty, relative and none run /usr/bin/open', async (bin, file) => {
    const { calls, adapter } = recorder({ bin })
    expect(await adapter.focus({ adapter: 'vscode', id: UUID })).toBe(true)
    expect(calls).toEqual([run(file, '-b', VSCODE, link(UUID))])
  })

  it('a pane id not in its form runs nothing', async () => {
    const { calls, adapter } = recorder()
    for (const id of ['sess-1', UUID.toUpperCase(), `${UUID}&x=y`, `${UUID}/..`, `local_${UUID}`, '', '--args']) {
      expect(await adapter.focus({ adapter: 'vscode', id }), id).toBe(false)
      expect(await adapter.show({ adapter: 'vscode', id }, 'a1'), id).toBe('failed')
    }
    expect(calls).toEqual([])
  })
})

describe('a tap on a session in the VS Code extension\'s tab (docs/specs/2026-11-15-device-wave1-checks.md, F3)', () => {
  const CURSOR = 'com.todesktop.230313mzl4w4u92'
  const TAB = { __CFBundleIdentifier: VSCODE, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }
  const tabLink = run(OPEN, '-b', VSCODE, link(UUID))

  it('the VS Code extension\'s tab: its session\'s link, sent to VS Code alone', async () => {
    const { calls, logs, opener } = recorder()
    expect(target(TAB)).toEqual({ bundle: VSCODE, pane: { adapter: 'vscode', id: UUID } })
    expect(await opener.open('a1', target(TAB))).toBe(true)
    expect(calls).toEqual([tabLink])
    expect(logs).toEqual([])
  })

  it('no link without all three: the extension\'s word, VS Code\'s own bundle id, a UUID', async () => {
    const cases: Array<[Record<string, string>, string, string]> = [
      [{ __CFBundleIdentifier: VSCODE, CLAUDE_CODE_ENTRYPOINT: 'cli' }, UUID, VSCODE],
      [{ __CFBundleIdentifier: VSCODE }, UUID, VSCODE],
      // Cursor runs the same extension, which says the same word: its link is not VS Code's.
      [{ __CFBundleIdentifier: CURSOR, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }, UUID, CURSOR],
      [TAB, 'sess-1', VSCODE], [TAB, UUID.toUpperCase(), VSCODE], [TAB, `${UUID}&x=y`, VSCODE], [TAB, `${UUID}/..`, VSCODE],
      [TAB, `local_${UUID}`, VSCODE], [TAB, '', VSCODE],
    ]
    for (const [hints, sessionId, bundle] of cases) {
      const { calls, opener } = recorder()
      const tap = target(hints, sessionId)
      expect(tap.pane, JSON.stringify([hints, sessionId])).toBeUndefined()
      expect(await opener.open('a1', tap)).toBe(true)
      expect(calls, JSON.stringify([hints, sessionId])).toEqual([forward(bundle)])
    }
  })

  // Claude Code hands its environment to what its tools run: a Codex session started from the extension's tab says the
  // same word and VS Code's bundle id, and a Codex thread id is a UUID too. The link names Claude Code's sessions only.
  it('another engine\'s session started from the extension\'s tab opens no link', async () => {
    for (const engine of ['codex', 'gemini']) {
      const { calls, opener } = recorder()
      const tap = target(TAB, UUID, engine)
      expect(tap.pane, engine).toBeUndefined()
      expect(await opener.open('a1', tap)).toBe(true)
      expect(calls, engine).toEqual([forward(VSCODE)])
    }
  })

  it('a link that fails still brings VS Code forward, in one line with no session; on Linux nothing runs', async () => {
    const failed = recorder({}, [1])
    expect(await failed.opener.open('a1', target(TAB))).toBe(true)
    expect(failed.calls).toEqual([tabLink, forward(VSCODE)])
    expect(failed.logs).toEqual(['[device] open · vscode · fallback'])
    expect(failed.logs.join()).not.toContain(UUID)
    const linux = recorder({ platform: 'linux' })
    // The first look answers yes while xdg-mime is read (appLink.ts): none is on PATH, so the tap opens nothing.
    expect(linux.opener.can('a1', target(TAB))).toBe(true)
    expect(await linux.opener.open('a1', target(TAB))).toBe(false)
    expect(linux.calls).toEqual([])
  })
})

describe('a rest on a session in the VS Code extension\'s tab (docs/plans/2026-11-17-dial-vscode-follow-design.md)', () => {
  const pane = (id: string) => ({ adapter: 'vscode', id })

  it('with VS Code in front, a rest runs the session\'s link once, sent to VS Code alone', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.show(pane(UUID), 'a1')).toBe('ok')
    expect(calls).toEqual([run(OPEN, '-b', VSCODE, link(UUID))])
  })

  it('a rest whose link fails is failed and brings nothing forward', async () => {
    const { calls, adapter } = recorder({}, [1])
    expect(await adapter.show(pane(UUID), 'a1')).toBe('failed')
    expect(calls).toEqual([run(OPEN, '-b', VSCODE, link(UUID))])
  })

  it('a second rest on the same agent while its link runs is busy; another agent\'s runs', async () => {
    const calls: Call[] = []
    const waiting: Array<() => void> = []
    const { adapter } = recorder({
      run: (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        return new Promise((resolve) => waiting.push(() => resolve({ code: 0, stdout: '' })))
      },
    })
    const first = adapter.show(pane(UUID), 'a1')
    expect(await adapter.show(pane(UUID), 'a1')).toBe('busy')
    const other = adapter.show(pane(UUID2), 'a2')
    waiting.forEach((release) => release())
    expect(await first).toBe('ok')
    expect(await other).toBe('ok')
    expect(calls).toEqual([run(OPEN, '-b', VSCODE, link(UUID)), run(OPEN, '-b', VSCODE, link(UUID2))])
  })
})

describe('an agent in VS Code\'s integrated terminal (docs/plans/2026-11-17-dial-vscode-extension-design.md, §3)', () => {
  const TERM = { TERM_PROGRAM: 'vscode' }
  const PID = 4321
  const HELD: Terminal = { window: 'win-0001abcd', shell: 700 }
  const pane = (id = `term:${PID}`) => ({ adapter: 'vscode', id })
  /** The place a hook or the scan gives an agent in VS Code's terminal: its own pid, its engine. */
  const place = (hints: Record<string, string>, over: Partial<Place> = {}): Place =>
    ({ host: detectHost(hints), app: detectApp(hints), hints, engine: 'claude', pid: PID, ...over })
  const tapOf = (hints: Record<string, string>, over: Partial<Place> = {}): OpenTarget =>
    ({ bundle: bundleOf(detectHost(hints), hints), pane: recorder().adapter.paneOf(place(hints, over)) })

  it('a Claude Code or Codex agent in VS Code\'s terminal has a term pane of its pid', () => {
    for (const engine of ['claude', 'codex']) {
      for (const hints of [TERM, { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: VSCODE }]) {
        expect(tapOf(hints, { engine }), engine).toEqual({ bundle: VSCODE, pane: pane() })
      }
    }
  })

  it('no term pane for the extension\'s panel, Cursor, another engine, or a place with no pid, pid 1, or a fraction', () => {
    const { adapter } = recorder()
    const cases: Array<[Record<string, string>, Partial<Place>]> = [
      // The panel's word in a place with no session id: neither the panel's pane nor a terminal's.
      [{ TERM_PROGRAM: 'vscode', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }, {}],
      [{ TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.todesktop.230313mzl4w4u92' }, {}],
      [TERM, { engine: 'gemini' }],
      [TERM, { engine: undefined }],
      [TERM, { pid: undefined }],
      [TERM, { pid: 1 }],
      [TERM, { pid: 0 }],
      [TERM, { pid: -5 }],
      [TERM, { pid: 4321.5 }],
      [TERM, { pid: 2 ** 31 }],
    ]
    for (const [hints, over] of cases) {
      expect(adapter.paneOf(place(hints, over)), JSON.stringify([hints, over])).toBeUndefined()
    }
    expect(adapter.paneOf(place(TERM, { pid: 2 }))).toEqual(pane('term:2'))
    expect(adapter.paneOf(place(TERM, { pid: 2 ** 31 - 1 }))).toEqual(pane(`term:${2 ** 31 - 1}`))
  })

  it('a tap writes the show, then runs open -b for VS Code itself, and the opener runs nothing after it', async () => {
    const { calls, logs, opener, windows } = recorder()
    windows.held = HELD
    expect(await opener.open('a1', tapOf(TERM))).toBe(true)
    expect(windows.shows).toEqual([{ terminal: HELD, tap: true }])
    expect(calls).toEqual([forward(VSCODE)])
    expect(logs).toEqual([])
  })

  it('a tap whose own open -b fails still answers true: the show was queued', async () => {
    const { calls, logs, opener, windows } = recorder({}, [1])
    windows.held = HELD
    expect(await opener.open('a1', tapOf(TERM))).toBe(true)
    expect(windows.shows).toEqual([{ terminal: HELD, tap: true }])
    expect(calls).toEqual([forward(VSCODE)])
    expect(logs).toEqual([])
  })

  it('off macOS the show alone is the tap', async () => {
    const { calls, logs, adapter, opener, windows } = recorder({ platform: 'linux' })
    windows.held = HELD
    const tap = tapOf(TERM)
    expect(adapter.canFocus(pane())).toBe(true)
    expect(opener.can('a1', tap)).toBe(true)
    expect(await opener.open('a1', tap)).toBe(true)
    expect(windows.shows).toEqual([{ terminal: HELD, tap: true }])
    expect(calls).toEqual([])
    expect(logs).toEqual([])
  })

  it('a show that cannot be written falls back to the app, once', async () => {
    const { calls, logs, opener, windows } = recorder()
    windows.held = HELD
    windows.writes = false
    expect(await opener.open('a1', tapOf(TERM))).toBe(true)
    expect(windows.shows).toEqual([{ terminal: HELD, tap: true }])
    expect(logs).toEqual(['[device] open · vscode · fallback'])
    expect(calls).toEqual([forward(VSCODE)])
  })

  it('with no window holding its terminal a tap brings the app only, with no fallback line', async () => {
    const { calls, logs, adapter, opener, windows } = recorder()
    expect(adapter.canFocus(pane())).toBe(false)
    expect(await opener.open('a1', tapOf(TERM))).toBe(true)
    expect(windows.shows).toEqual([])
    expect(logs).toEqual([])
    expect(calls).toEqual([forward(VSCODE)])
    expect(recorder({ platform: 'linux' }).opener.can('a1', tapOf(TERM))).toBe(false)
  })

  it('a rest shows the terminal only while VS Code is in front', async () => {
    let front = false
    const r: ReturnType<typeof recorder> = recorder({ inFront: () => { r.asked.push('inFront'); return front } })
    r.windows.held = HELD
    expect(r.adapter.canShow(pane())).toBe(false)
    expect(r.asked).toEqual(['inFront'])
    front = true
    expect(r.adapter.canShow(pane())).toBe(true)
    expect(r.asked).toEqual(['inFront', 'inFront', 'terminalOf'])
    expect(await r.adapter.show(pane(), 'a1')).toBe('ok')
    expect(r.windows.shows).toEqual([{ terminal: HELD, tap: false }])
    expect(r.calls).toEqual([])
    r.windows.held = undefined
    expect(r.adapter.canShow(pane())).toBe(false)
  })

  it('a rest whose window has gone fails', async () => {
    const { calls, adapter, windows } = recorder()
    expect(await adapter.show(pane(), 'a1')).toBe('failed')
    windows.held = HELD
    windows.writes = false
    expect(await adapter.show(pane(), 'a1')).toBe('failed')
    expect(windows.shows).toEqual([{ terminal: HELD, tap: false }])
    expect(calls).toEqual([])
  })

  it('a term id out of form is no terminal pane: the link\'s verbs refuse it and run nothing', async () => {
    const ids = ['term:0', 'term:1', 'term:x', 'term:2147483648', 'term:12.5', 'term:-4', 'term:042', 'term:', 'term: 42', 'xterm:42']
    for (const platform of ['darwin', 'linux'] as const) {
      const { calls, adapter, windows } = recorder({ platform })
      windows.held = HELD
      for (const id of ids) {
        expect(termPid(id), id).toBeUndefined()
        // On Linux the first look answers yes while xdg-mime is read, as macOS does: focus still refuses the id.
        expect(adapter.canFocus(pane(id)), id).toBe(platform === 'darwin' || id === ids[0])
        expect(await adapter.focus(pane(id)), id).toBe(false)
        expect(await adapter.show(pane(id), 'a1'), id).toBe('failed')
      }
      expect(windows.shows).toEqual([])
      expect(calls).toEqual([])
    }
    expect(termPid('term:2')).toBe(2)
    expect(termPid(`term:${2 ** 31 - 1}`)).toBe(2 ** 31 - 1)
    expect(termPid(UUID)).toBeUndefined()
  })

  // The dial's scroll (docs/plans/2026-11-17-dial-vscode-extension-design.md, §4), on the scroll route every app shares
  // (docs/plans/2026-11-17-dial-herdr-scroll-design.md, §4).
  it('a stroke may scroll the terminal only while VS Code is in front and a window holds it, and its lines go there', () => {
    let front = false
    const r: ReturnType<typeof recorder> = recorder({ inFront: () => { r.asked.push('inFront'); return front } })
    r.windows.held = HELD
    expect(r.adapter.canScroll!(pane())).toBe(false)
    expect(r.asked).toEqual(['inFront'])
    front = true
    expect(r.adapter.canScroll!(pane())).toBe(true)
    expect(r.asked).toEqual(['inFront', 'inFront', 'terminalOf'])
    r.adapter.scroll!(pane(), -3)
    expect(r.windows.scrolls).toEqual([{ terminal: HELD, lines: -3, page: false }])
    expect(r.calls).toEqual([])
    r.windows.held = undefined
    expect(r.adapter.canScroll!(pane())).toBe(false)
  })

  it('lines for a terminal no window holds go nowhere, and the panel\'s pane or a term id out of form never scrolls', () => {
    const { adapter, windows } = recorder()
    adapter.scroll!(pane(), 2)
    windows.held = HELD
    for (const id of [UUID, 'term:1', 'term:x']) {
      expect(adapter.canScroll!(pane(id)), id).toBe(false)
      adapter.scroll!(pane(id), 2)
    }
    expect(windows.scrolls).toEqual([])
  })

  // Claude Code's fullscreen view (docs/plans/2026-11-18-dial-vscode-claude-fullscreen-scroll-design.md): the terminals
  // own the guard's reads and deadline; the adapter names the pane's pid and passes on what the route knows.
  it('pageKeys asks the terminals for the pane\'s own pid, with what the route knows of its agent', async () => {
    const r = recorder()
    const agent = { asking: false, cwd: '/w', transcriptPath: '/t/s1.jsonl' }
    expect(await r.adapter.pageKeys!(pane(), agent)).toBe(true)
    expect(r.adapter.pageKeys!(pane(), { ...agent, asking: true })).toBe(false)
    expect(r.windows.guards).toEqual([{ pid: PID, agent }, { pid: PID, agent: { ...agent, asking: true } }])
  })

  it('pageKeys is false at once for the panel\'s pane or a term id out of form, and asks nothing', () => {
    const { adapter, windows } = recorder()
    windows.held = HELD
    for (const id of [UUID, 'term:1', 'term:x']) {
      expect(adapter.pageKeys!(pane(id), { asking: false, cwd: '/w' }), id).toBe(false)
    }
    expect(windows.guards).toEqual([])
  })

  it('scroll passes page on, and lines with none are plain', () => {
    const { adapter, windows } = recorder()
    windows.held = HELD
    adapter.scroll!(pane(), -3, true)
    adapter.scroll!(pane(), -3)
    expect(windows.scrolls).toEqual([{ terminal: HELD, lines: -3, page: true }, { terminal: HELD, lines: -3, page: false }])
  })

  // The dial's words (docs/plans/2026-11-22-dial-vscode-cursor-voice-design.md): the terminals own the guard, the
  // settle and the Enter; the adapter names the pane's pid and says why it was refused (V9).
  it('canType: a terminal\'s pane only while the terminals say its window types; the panel\'s pane and a term id out of form never', () => {
    const { adapter, windows } = recorder()
    expect(adapter.canType!(pane())).toBe(true)
    windows.types = false
    expect(adapter.canType!(pane())).toBe(false)
    windows.types = true
    for (const id of [UUID, 'term:1', 'term:x', 'term:042']) expect(adapter.canType!(pane(id)), id).toBe(false)
    expect(windows.typeAsks).toEqual([PID, PID])
  })

  it('type hands the terminals the agent\'s pid, the words and the caller\'s prompt check; typed is true', async () => {
    const { adapter, windows, calls } = recorder()
    const atPrompt = () => true
    expect(await adapter.type!(pane(), 'Eval words for bravo.', 'codex', atPrompt)).toBe(true)
    expect(windows.sends).toEqual([{ pid: PID, words: 'Eval words for bravo.', atPrompt }])
    expect(windows.sends[0].atPrompt).toBe(atPrompt)
    expect(calls).toEqual([])
  })

  it('not in front of its terminal: refused with "Bring it to the front of its terminal."; failed is false', async () => {
    const { adapter, windows } = recorder()
    windows.typed = 'background'
    expect(await adapter.type!(pane(), 'hi', 'codex', () => true)).toEqual({ refused: 'Bring it to the front of its terminal.' })
    windows.typed = 'failed'
    expect(await adapter.type!(pane(), 'hi', 'codex', () => true)).toBe(false)
  })

  it('with no prompt check, or for the panel\'s pane, nothing is typed: false', async () => {
    const { adapter, windows } = recorder()
    expect(await adapter.type!(pane(), 'hi', 'codex')).toBe(false)
    for (const id of [UUID, 'term:1', 'term:x']) expect(await adapter.type!(pane(id), 'hi', 'claude', () => true), id).toBe(false)
    expect(windows.sends).toEqual([])
  })

  it('it declares VS Code\'s bundle', () => {
    expect(recorder().adapter.bundle).toBe('com.microsoft.VSCode')
  })
})

describe('the adapter made for Cursor', () => {
  const CURSOR = 'com.todesktop.230313mzl4w4u92'
  const cursorLink = (id: string) => `cursor://anthropic.claude-code/open?session=${id}`
  const PANEL = { __CFBundleIdentifier: CURSOR, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }
  const TERM = { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: CURSOR }
  const at = (hints: Record<string, string>, over: Partial<Place> = {}): Place =>
    ({ host: detectHost(hints), app: detectApp(hints), hints, engine: 'claude', sessionId: UUID, pid: 4242, ...over })

  it('its id is cursor and its bundle Cursor\'s', () => {
    const { adapter } = recorder({}, [], 'cursor')
    expect([adapter.id, adapter.bundle, adapter.tap]).toEqual(['cursor', CURSOR, 'instead'])
  })

  it('Claude Code\'s panel in Cursor opens by cursor://, sent to Cursor alone', async () => {
    const { adapter, calls } = recorder({}, [], 'cursor')
    expect(adapter.paneOf(at(PANEL))).toEqual({ adapter: 'cursor', id: UUID })
    expect(await adapter.focus({ adapter: 'cursor', id: UUID })).toBe(true)
    expect(calls).toEqual([run(OPEN, '-b', CURSOR, cursorLink(UUID))])
  })

  it('each editor takes its own panel and its own terminals alone', () => {
    const vscode = recorder().adapter
    const cursor = recorder({}, [], 'cursor').adapter
    expect(vscode.paneOf(at(PANEL))).toBeUndefined()
    expect(vscode.paneOf(at(TERM))).toBeUndefined()
    expect(cursor.paneOf(at({ __CFBundleIdentifier: VSCODE, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }))).toBeUndefined()
    expect(cursor.paneOf(at({ TERM_PROGRAM: 'vscode', __CFBundleIdentifier: VSCODE }))).toBeUndefined()
    expect(cursor.paneOf(at(TERM))).toEqual({ adapter: 'cursor', id: 'term:4242' })
  })

  it('cursor-agent\'s terminal in Cursor is typed into as VS Code\'s', async () => {
    const r = recorder({}, [], 'cursor')
    const pane = r.adapter.paneOf(at(TERM, { engine: 'cursor', sessionId: undefined }))!
    expect(pane).toEqual({ adapter: 'cursor', id: 'term:4242' })
    expect(r.adapter.canType!(pane)).toBe(true)
    const atPrompt = () => true
    expect(await r.adapter.type!(pane, 'Eval words for bravo.', 'cursor', atPrompt)).toBe(true)
    expect(r.windows.sends).toEqual([{ pid: 4242, words: 'Eval words for bravo.', atPrompt }])
  })

  // U10: Cursor documents no way to put words into one existing chat (docs/plans/2026-11-22-dial-vscode-cursor-voice-design.md, §2).
  it('a sentence for Cursor\'s own agent alone: none for cursor-agent with TERM_PROGRAM, Claude Code, Codex, its panel, or any agent of VS Code\'s adapter', () => {
    const cursor = recorder({}, [], 'cursor').adapter
    const vscode = recorder().adapter
    const own = at({ __CFBundleIdentifier: CURSOR }, { engine: 'cursor', sessionId: undefined })
    expect(cursor.voiceRefusal!(own)).toBe('Voice can\'t reach Cursor\'s agent. Type in Cursor.')
    for (const place of [
      at(TERM, { engine: 'cursor', sessionId: undefined }),
      at(TERM),
      at(TERM, { engine: 'codex' }),
      at(PANEL),
    ]) expect(cursor.voiceRefusal!(place), JSON.stringify(place)).toBeUndefined()
    expect(vscode.voiceRefusal).toBeUndefined()
  })

  // Review Focus 5: the open scan gives no hints until the session's first hook.
  it('a place with no hints (a session the scan found) is Cursor\'s own agent\'s; the same place with TERM_PROGRAM is not, and has its term pane', () => {
    const { adapter } = recorder({}, [], 'cursor')
    const scanned: Place = { host: 'terminal', app: 'cursor', hints: {}, engine: 'cursor', pid: 4242 }
    expect(adapter.voiceRefusal!(scanned)).toBe('Voice can\'t reach Cursor\'s agent. Type in Cursor.')
    expect(adapter.paneOf(scanned)).toBeUndefined()
    const hooked = { ...scanned, hints: { TERM_PROGRAM: 'vscode' } }
    expect(adapter.voiceRefusal!(hooked)).toBeUndefined()
    expect(adapter.paneOf(hooked)).toEqual({ adapter: 'cursor', id: 'term:4242' })
  })

  it('a tap on a terminal in Cursor queues its show with the raise, then opens Cursor by its bundle', async () => {
    const r = recorder({}, [], 'cursor')
    r.windows.held = { window: 'w1', shell: 4000 }
    expect(await r.adapter.focus({ adapter: 'cursor', id: 'term:4242' })).toBe(true)
    expect(r.windows.shows).toEqual([{ terminal: { window: 'w1', shell: 4000 }, tap: true }])
    expect(r.calls).toEqual([run(OPEN, '-b', CURSOR)])
  })
})

it.each(['vscode', 'cursor'] as const)('cursor-agent in %s\'s terminal has the terminal pane; with no TERM_PROGRAM, or another engine, none', (editor) => {
  const bundle = editor === 'vscode' ? VSCODE : 'com.todesktop.230313mzl4w4u92'
  const place = (engine: string, hints: Record<string, string> = { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: bundle }): Place =>
    ({ host: detectHost(hints), app: detectApp(hints), hints, engine, pid: 4242 })
  const { adapter } = recorder({}, [], editor)
  expect(adapter.paneOf(place('cursor'))).toEqual({ adapter: editor, id: 'term:4242' })
  expect(adapter.paneOf(place('opencode'))).toBeUndefined()
  // Cursor's own agent: its bundle id names the app, but it sends no TERM_PROGRAM, so its pid is never read with `ps`.
  expect(adapter.paneOf(place('cursor', { __CFBundleIdentifier: bundle }))).toBeUndefined()
})

// Linux has no `open -b`: the devices' raise brings the editor forward (docs/plans/2026-11-19-dial-linux-design.md
// §§ 1.6, 2).
describe('a tap on a terminal on Linux raises its editor', () => {
  const HELD: Terminal = { window: 'w1', shell: 4000 }
  const tapped = (editor: 'vscode' | 'cursor', answer = true, platform: 'linux' | 'darwin' = 'linux') => {
    const raises: Array<{ pid?: number; app?: string }> = []
    const r = recorder({ platform, raise: async (window) => { raises.push(window); return answer } }, [], editor)
    r.windows.held = HELD
    return { ...r, raises, focus: () => r.adapter.focus({ adapter: editor, id: 'term:4242' }) }
  }

  it.each(['vscode', 'cursor'] as const)('%s: the show is queued with the raise, then the raise names the pane\'s pid and the editor', async (editor) => {
    const t = tapped(editor)
    expect(await t.focus()).toBe(true)
    expect(t.windows.shows).toEqual([{ terminal: HELD, tap: true }])
    expect(t.raises).toEqual([{ pid: 4242, app: editor }])
    expect(t.calls).toEqual([])
  })

  it('a raise that answers false leaves the tap true: the show was queued', async () => {
    const t = tapped('vscode', false)
    expect(await t.focus()).toBe(true)
    expect(t.raises).toEqual([{ pid: 4242, app: 'vscode' }])
  })

  it('a show that cannot be written raises nothing', async () => {
    const t = tapped('vscode')
    t.windows.writes = false
    expect(await t.focus()).toBe(false)
    expect(t.raises).toEqual([])
  })

  it('macOS runs open -b and no raise', async () => {
    const t = tapped('vscode', true, 'darwin')
    expect(await t.focus()).toBe(true)
    expect(t.calls).toEqual([forward(VSCODE)])
    expect(t.raises).toEqual([])
  })
})

// Windows has no `open -b`: the devices' raise brings the editor forward by its bundle, and opens the tab's link
// (windowsRaise.ts).
describe('a tap on Windows raises its editor', () => {
  const HELD: Terminal = { window: 'w1', shell: 4000 }
  const CURSOR = 'com.todesktop.230313mzl4w4u92'
  /** The recorder on Windows, holding a raise that notes each call with how many shows were written before it, and
   *  answers [answer]. */
  const tapped = (editor: 'vscode' | 'cursor', answer = true) => {
    const raised: Array<{ call: string[]; shows: number }> = []
    const note = async (call: string[]) => { raised.push({ call, shows: r.windows.shows.length }); return answer }
    const windows: WindowsRaise = {
      app: (bundle) => note(['app', bundle]),
      link: (url, bundle) => note(['link', url, String(bundle)]),
      cursorFolder: (folder) => note(['cursorFolder', folder]),
      desktop: () => note(['desktop']),
      window: (pid) => note(['window', String(pid)]),
    }
    const r = recorder({ platform: 'win32', windows }, [], editor)
    r.windows.held = HELD
    return { ...r, raised, focus: (id = 'term:4242') => r.adapter.focus({ adapter: editor, id }) }
  }

  it.each([['vscode', VSCODE], ['cursor', CURSOR]] as const)('%s: the terminal is shown, then the editor comes forward by its bundle', async (editor, bundle) => {
    const t = tapped(editor)
    expect(t.adapter.canFocus({ adapter: editor, id: 'term:4242' })).toBe(true)
    expect(await t.focus()).toBe(true)
    expect(t.windows.shows).toEqual([{ terminal: HELD, tap: true }])
    expect(t.raised).toEqual([{ call: ['app', bundle], shows: 1 }])
    expect(t.calls).toEqual([])
  })

  it('a raise that answers false leaves the tap true: the show was queued', async () => {
    const t = tapped('vscode', false)
    expect(await t.focus()).toBe(true)
    expect(t.raised).toEqual([{ call: ['app', VSCODE], shows: 1 }])
  })

  it('a show that cannot be written raises nothing', async () => {
    const t = tapped('vscode')
    t.windows.writes = false
    expect(await t.focus()).toBe(false)
    expect(t.raised).toEqual([])
  })

  it('the extension\'s tab opens by its link, sent with the editor\'s bundle', async () => {
    const t = tapped('vscode')
    expect(t.adapter.canFocus({ adapter: 'vscode', id: UUID })).toBe(true)
    expect(await t.focus(UUID)).toBe(true)
    expect(t.raised).toEqual([{ call: ['link', link(UUID), VSCODE], shows: 0 }])
    expect(t.calls).toEqual([])
  })
})

// Linux has no bundle id: the editor is the app the process scan named (docs/plans/2026-11-19-dial-linux-design.md § 1.6).
describe('the extension\'s tab on Linux', () => {
  const CURSOR = 'com.todesktop.230313mzl4w4u92'
  const ENTRY = { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }
  const at = (app: string, over: Partial<Place> = {}, hints: Record<string, string> = ENTRY): Place =>
    ({ host: detectHost(hints), app, hints, engine: 'claude', sessionId: UUID, pid: 4242, ...over })
  /** A Linux box whose every tool is under /fake/bin and whose xdg-mime names an app for each scheme. */
  const linux = (editor: 'vscode' | 'cursor' = 'vscode') => {
    const calls: Call[] = []
    const r = recorder({
      platform: 'linux',
      onPath: (name) => `/fake/bin/${name}`,
      run: async (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        return { code: 0, stdout: file.endsWith('/xdg-mime') ? `${args[2].split('/')[1]}.desktop\n` : '' }
      },
    }, [], editor)
    return { ...r, calls }
  }

  it('a Claude Code session the extension started, in the editor the scan named, has the tab\'s pane', () => {
    expect(linux().adapter.paneOf(at('vscode'))).toEqual({ adapter: 'vscode', id: UUID })
    expect(linux('cursor').adapter.paneOf(at('cursor'))).toEqual({ adapter: 'cursor', id: UUID })
    expect(linux().adapter.paneOf(at('cursor'))).toBeUndefined()
    expect(linux('cursor').adapter.paneOf(at('vscode'))).toBeUndefined()
  })

  it('another app\'s bundle id, another engine, a terminal app or a session out of form has none', () => {
    const { adapter } = linux()
    const cases: Place[] = [
      at('vscode', {}, { ...ENTRY, __CFBundleIdentifier: CURSOR }),
      at('vscode', { engine: 'codex' }),
      at('terminal'),
      at('vscode', { sessionId: 'sess-1' }),
      at('vscode', { sessionId: undefined }),
    ]
    for (const place of cases) expect(adapter.paneOf(place), JSON.stringify(place)).toBeUndefined()
  })

  // On macOS the bundle id an editor started from Terminal inherited is dropped (hostDetect.ts ownHints): there too the
  // app its parents named is the editor.
  it('on macOS too the app the caller\'s parents named has the tab, on Windows it names none', () => {
    expect(recorder().adapter.paneOf(at('vscode'))).toEqual({ adapter: 'vscode', id: UUID })
    expect(recorder({}, [], 'cursor').adapter.paneOf(at('cursor'))).toEqual({ adapter: 'cursor', id: UUID })
    expect(recorder().adapter.paneOf(at('cursor'))).toBeUndefined()
    expect(recorder({ platform: 'win32' }).adapter.paneOf(at('vscode'))).toBeUndefined()
  })

  it.each([
    ['vscode', 'vscode://anthropic.claude-code/open?session='],
    ['cursor', 'cursor://anthropic.claude-code/open?session='],
  ] as const)('a tap in %s runs xdg-open on the editor\'s link once its scheme has an app', async (editor, url) => {
    const { adapter, calls } = linux(editor)
    const pane = adapter.paneOf(at(editor))!
    expect(await adapter.focus(pane)).toBe(true)
    expect(calls).toEqual([
      run('/fake/bin/xdg-mime', 'query', 'default', `x-scheme-handler/${editor}`),
      run('/fake/bin/xdg-open', `${url}${UUID}`),
    ])
    expect(adapter.canFocus(pane)).toBe(true)
  })
})

// Claude Code in the person's tmux, whose client is attached from an integrated terminal (dial eval V12): the agent's
// chain runs through the tmux server, never a window's shell, so the client's is the one a window reports.
describe('the terminal holding a multiplexer\'s client in VS Code or Cursor', () => {
  const CLIENT = 4300
  const HELD: Terminal = { window: 'win-0001abcd', shell: 4299 }
  /** A tmux agent whose client the outer lookup found in [app]'s terminal, by the client's process. */
  const nested = (app: string): Place =>
    ({ host: 'tmux', app: 'tmux', hints: { TMUX_PANE: '%3', TERM_PROGRAM: 'tmux' }, engine: 'claude', pid: 4242,
      outer: { app, tty: '/dev/ttys004', pid: CLIENT } })
  /** The adapter for [editor], over windows that hold the client's shell once a test sets `held`. */
  const client = (editor: 'vscode' | 'cursor' = 'vscode') => {
    const windows = { held: undefined as Terminal | undefined, writes: true, front: true, asked: [] as number[],
      shows: [] as Array<{ terminal: Terminal; tap: boolean }> }
    const adapter = createVscodeClientAdapter(editor, {
      inFront: () => windows.front,
      terminals: {
        terminalOf: (pid) => { windows.asked.push(pid); return windows.held },
        show: (terminal, tap) => { windows.shows.push({ terminal, tap }); return windows.writes },
      },
    })
    return { adapter, windows }
  }
  const pane = (id = `client:${CLIENT}`, adapter = 'vscode-tab') => ({ adapter, id })

  it('its pane is the client\'s process in its own editor alone, and it comes after the app', () => {
    const { adapter } = client()
    expect(adapter.id).toBe('vscode-tab')
    expect(adapter.tap).toBe('after')
    expect(adapter.paneOf(nested('vscode'))).toEqual(pane())
    expect(adapter.paneOf(nested('cursor'))).toBeUndefined()
    expect(client('cursor').adapter.id).toBe('cursor-tab')
    expect(client('cursor').adapter.paneOf(nested('cursor'))).toEqual(pane(`client:${CLIENT}`, 'cursor-tab'))
    expect(client('cursor').adapter.paneOf(nested('vscode'))).toBeUndefined()
    for (const pid of [undefined, 1, 0, -5, 4300.5, 2 ** 31, '4300']) {
      expect(adapter.paneOf({ ...nested('vscode'), outer: { app: 'vscode', pid: pid as number } }), String(pid)).toBeUndefined()
    }
    const { outer: _, ...plain } = nested('vscode')
    expect(adapter.paneOf(plain)).toBeUndefined()
  })

  it('a tap shows the window\'s shell that holds the client, with the raise', async () => {
    const { adapter, windows } = client()
    windows.held = HELD
    expect(adapter.canFocus(pane())).toBe(true)
    expect(await adapter.focus(pane())).toBe(true)
    expect(windows.asked).toEqual([CLIENT, CLIENT])
    expect(windows.shows).toEqual([{ terminal: HELD, tap: true }])
  })

  it('with no window listing a shell on the client\'s chain, it can do nothing and shows no terminal', async () => {
    const { adapter, windows } = client()
    expect(adapter.canFocus(pane())).toBe(false)
    expect(await adapter.focus(pane())).toBe(false)
    expect(adapter.canShow(pane())).toBe(false)
    expect(await adapter.show(pane(), 'a1')).toBe('failed')
    expect(windows.shows).toEqual([])
  })

  it('a show that cannot be written is a failed tap and a failed rest', async () => {
    const { adapter, windows } = client()
    windows.held = HELD
    windows.writes = false
    expect(await adapter.focus(pane())).toBe(false)
    expect(await adapter.show(pane(), 'a1')).toBe('failed')
  })

  it('a rest shows the shell only while the editor is in front', async () => {
    const { adapter, windows } = client()
    windows.held = HELD
    windows.front = false
    expect(adapter.canShow(pane())).toBe(false)
    expect(windows.asked).toEqual([])
    windows.front = true
    expect(adapter.canShow(pane())).toBe(true)
    expect(await adapter.show(pane(), 'a1')).toBe('ok')
    expect(windows.shows).toEqual([{ terminal: HELD, tap: false }])
  })

  it('an id out of form is no pane: nothing is asked or shown, and the client\'s terminal never scrolls or takes words', async () => {
    const { adapter, windows } = client()
    windows.held = HELD
    for (const id of ['client:1', 'client:04300', `term:${CLIENT}`, 'client:4300:x', '4300']) {
      expect(adapter.canFocus(pane(id)), id).toBe(false)
      expect(await adapter.focus(pane(id)), id).toBe(false)
      expect(adapter.canShow(pane(id)), id).toBe(false)
      expect(await adapter.show(pane(id), 'a1'), id).toBe('failed')
    }
    expect(windows.asked).toEqual([])
    expect(windows.shows).toEqual([])
    expect(adapter.scroll).toBeUndefined()
    expect(adapter.type).toBeUndefined()
    expect(adapter.pageKeys).toBeUndefined()
  })
})
