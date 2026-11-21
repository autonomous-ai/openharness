import { describe, expect, it } from 'vitest'
import type { Place } from './adapter.js'
import { MAX_TEXT, type OrcaDeps } from './orca.js'
import { RECORDED_WEZTERM } from '../../testing/recordedWezterm.js'
import { createWeztermAdapter, createWeztermTabAdapter, LISTED_PANES_MAX } from './wezterm.js'

const APP_WEZTERM = '/Applications/WezTerm.app/Contents/MacOS/wezterm'
const FAKE_PATH_WEZTERM = '/fake/bin/wezterm'

interface Call { file: string; args: string[]; timeoutMs: number }

/** A recording runner that runs nothing, so no spec moves the developer's own WezTerm: each call answers the next of
 *  [codes], then exit 0. */
function recorder(over: Partial<OrcaDeps> = {}, codes: Array<number | null> = []) {
  const calls: Call[] = []
  const deps: OrcaDeps = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return { code: codes.length ? codes.shift()! : 0, stdout: '' }
    },
    onPath: (name) => (name === 'wezterm' ? FAKE_PATH_WEZTERM : null),
    exists: () => false,
    platform: 'darwin',
    ...over,
  }
  return { calls, adapter: createWeztermAdapter(deps) }
}

/** A place, by default an agent on the pseudo-terminal of WezTerm's own pane. */
const place = (hints: Record<string, string>, host = 'wezterm', ptyOwner: string | null = 'wezterm'): Place =>
  ({ host, app: 'wezterm', hints, ...(ptyOwner === null ? {} : { ptyOwner }) })
const pane = (id: string) => ({ adapter: 'wezterm', id })
/** The pane of an agent WezTerm did not make the terminal of, as paneOf gives it. */
const heldPane = (id: string) => ({ ...pane(`held:${id}`), held: true })
// Every command says --no-auto-start: with no WezTerm running, `wezterm cli` would start a mux server that outlives it.
const activate = (file: string, id: string): Call =>
  ({ file, args: ['cli', '--no-auto-start', 'activate-pane', '--pane-id', id], timeoutMs: 10_000 })
const send = (id: string, text: string, file = FAKE_PATH_WEZTERM): Call =>
  ({ file, args: ['cli', '--no-auto-start', 'send-text', '--pane-id', id, '--no-paste', '--', text], timeoutMs: 10_000 })

describe('the WezTerm adapter', () => {
  it('its id is wezterm, it taps before its app, it types, and it has no show', () => {
    const { adapter } = recorder()
    expect(adapter.id).toBe('wezterm')
    expect(adapter.tap).toBe('before')
    expect(adapter.show).toBeUndefined()
    expect(adapter.canShow).toBeUndefined()
    expect(adapter.type).toBeTypeOf('function')
    expect(adapter.canType?.(pane('7'))).toBe(true)
    expect(adapter.canFocus(pane('7'))).toBe(true)
  })

  it('types the words, then Enter on its own', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.type!(pane('7'), 'hello there', 'claude')).toBe(true)
    expect(calls).toEqual([send('7', 'hello there'), send('7', '\r')])
  })

  // A multiplexer, a terminal or an editor started in a WezTerm pane keeps its variables: that pane shows whichever of
  // their panes is in front, or a shell that runs whatever is typed. Only the process that made the agent's
  // pseudo-terminal says whose it is (Place.ptyOwner): any but WezTerm's, or none read yet, only focuses.
  it('types only into a pane whose pseudo-terminal is the agent\'s', async () => {
    const { calls, adapter } = recorder()
    const held = [
      ...['tmux', 'zellij', 'kitty', null].map((owner) => place({ WEZTERM_PANE: '7' }, 'wezterm', owner)),
      ...['tmux', 'zellij', 'herdr', 'rex', 'kitty'].map((host) => place({ WEZTERM_PANE: '7' }, host, null)),
    ]
    for (const at of held) {
      const found = adapter.paneOf(at)!
      expect(found, `${at.host} ${at.ptyOwner}`).toEqual(heldPane('7'))
      expect(adapter.canType!(found)).toBe(false)
      expect(await adapter.type!(found, 'hello', 'claude')).toBe(false)
      expect(calls).toEqual([])
    }
    expect(await adapter.focus(pane('held:7'))).toBe(true)
    expect(calls).toEqual([activate(FAKE_PATH_WEZTERM, '7')])
  })

  // The observed source reads the field alone, never an id's form: a held pane is tapped after the agent's other panes,
  // and takes no words, rest or key.
  it('a held pane says so; an own one does not', () => {
    const { adapter } = recorder()
    expect(adapter.paneOf(place({ WEZTERM_PANE: '7' }))).toStrictEqual(pane('7'))
    for (const ptyOwner of [undefined, null, 'kitty']) {
      expect(adapter.paneOf({ ...place({ WEZTERM_PANE: '7' }), ptyOwner }), String(ptyOwner)).toStrictEqual(heldPane('7'))
    }
  })

  // `code .` run in WezTerm's pane 7: Codex in VS Code's terminal carries WEZTERM_PANE=7, and detectHost says WezTerm.
  it('a terminal started from the pane takes no words', async () => {
    const { calls, adapter } = recorder()
    const found = adapter.paneOf(place({ WEZTERM_PANE: '7', TERM_PROGRAM: 'vscode' }, 'wezterm', null))!
    expect(found).toEqual(heldPane('7'))
    expect(adapter.canType!(found)).toBe(false)
    expect(await adapter.type!(found, 'hello', 'claude')).toBe(false)
    expect(calls).toEqual([])
  })

  // WezTerm started from an Orca terminal keeps its handle: WezTerm's own pane is where the agent is.
  it('the agent\'s own pane takes words whatever other host\'s variables it inherited', () => {
    const { adapter } = recorder()
    const inherited = place({ WEZTERM_PANE: '7', ORCA_TERMINAL_HANDLE: 'term_0f8e2c1a-0000-4000-8000-000000000000', TMUX_PANE: '%1' }, 'tmux')
    expect(adapter.paneOf(inherited)).toEqual(pane('7'))
    expect(adapter.canType!(pane('7'))).toBe(true)
  })

  it('one send at a time for a pane', async () => {
    const calls: Call[] = []
    let release = () => {}
    const { adapter } = recorder({
      run: (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        return calls.length === 1 ? new Promise((resolve) => { release = () => resolve({ code: 0, stdout: '' }) }) : Promise.resolve({ code: 0, stdout: '' })
      },
    })
    const first = adapter.type!(pane('7'), 'first', 'claude')
    expect(await adapter.type!(pane('7'), 'second', 'claude')).toBe(false)
    expect(await adapter.type!(pane('8'), 'other', 'claude')).toBe(true)
    release()
    expect(await first).toBe(true)
    expect(await adapter.type!(pane('7'), 'third', 'claude')).toBe(true)
    expect(calls).toEqual([send('7', 'first'), send('8', 'other'), send('8', '\r'), send('7', '\r'), send('7', 'third'), send('7', '\r')])
  })

  it('a first command that fails sends no Enter', async () => {
    const { calls, adapter } = recorder({}, [1, null, 0, 1])
    expect(await adapter.type!(pane('7'), 'hello', 'claude')).toBe(false)
    expect(await adapter.type!(pane('7'), 'hello', 'claude')).toBe(false)
    expect(await adapter.type!(pane('7'), 'hello', 'claude')).toBe(false)
    expect(calls).toEqual([send('7', 'hello'), send('7', 'hello'), send('7', 'hello'), send('7', '\r')])
  })

  it('words starting with a dash, and with control characters', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.type!(pane('7'), '--help\nnow\u001b[2J', 'claude')).toBe(true)
    expect(calls).toEqual([send('7', '--help now [2J'), send('7', '\r')])
    expect(await adapter.type!(pane('7'), '', 'claude')).toBe(false)
    expect(await adapter.type!(pane('7'), 'x'.repeat(MAX_TEXT + 1), 'claude')).toBe(false)
    expect(await adapter.type!(pane('7; rm -rf /'), 'hello', 'claude')).toBe(false)
    expect(calls).toHaveLength(2)
  })

  it('no wezterm found: canType is false', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { calls, adapter } = recorder({ platform, onPath: () => null })
      expect(adapter.canType!(pane('7')), platform).toBe(false)
      expect(await adapter.type!(pane('7'), 'hello', 'claude')).toBe(false)
      expect(calls).toEqual([])
    }
    const app = recorder({ onPath: () => null, exists: (path) => path === APP_WEZTERM })
    expect(app.adapter.canType!(pane('7'))).toBe(true)
    expect(await app.adapter.type!(pane('7'), 'hello', 'claude')).toBe(true)
    expect(app.calls).toEqual([send('7', 'hello', APP_WEZTERM), send('7', '\r', APP_WEZTERM)])
  })

  // canType runs at every look, each second for each WezTerm agent, and finding wezterm walks PATH.
  it('wezterm is looked for once; again only while none was found, or after a run that failed', async () => {
    const found: Array<string | null> = [null, FAKE_PATH_WEZTERM]
    let looks = 0
    const { adapter } = recorder({ onPath: () => { looks++; return found.length ? found.shift()! : FAKE_PATH_WEZTERM } }, [1])
    expect(adapter.canType!(pane('7'))).toBe(false)
    for (let look = 0; look < 3; look++) expect(adapter.canType!(pane('7'))).toBe(true)
    expect(looks).toBe(2)
    expect(await adapter.focus(pane('7'))).toBe(false)
    expect(adapter.canType!(pane('7'))).toBe(true)
    expect(looks).toBe(3)
    expect(await adapter.focus(pane('7'))).toBe(true)
    expect(adapter.canType!(pane('7'))).toBe(true)
    expect(looks).toBe(3)
  })

  it('paneOf takes a pane number, and refuses any other', () => {
    const { adapter } = recorder()
    expect(adapter.paneOf(place({ WEZTERM_PANE: '7' }))).toEqual(pane('7'))
    expect(adapter.paneOf(place({ TERM_PROGRAM: 'WezTerm', WEZTERM_PANE: '3' }))).toEqual(pane('3'))
    expect(adapter.paneOf(place({ TERM_PROGRAM: 'WezTerm' }))).toBeUndefined()
    for (const id of ['7; rm -rf /', '--help', '-1', '7 ', '1234567890', '']) {
      expect(adapter.paneOf(place({ WEZTERM_PANE: id })), id).toBeUndefined()
    }
  })

  it('focus activates the pane', async () => {
    const { calls, adapter } = recorder({}, [0, 1, null])
    expect(await adapter.focus(pane('7'))).toBe(true)
    expect(await adapter.focus(pane('7'))).toBe(false)
    expect(await adapter.focus(pane('7'))).toBe(false)
    expect(calls).toEqual([activate(FAKE_PATH_WEZTERM, '7'), activate(FAKE_PATH_WEZTERM, '7'), activate(FAKE_PATH_WEZTERM, '7')])
  })

  it('WezTerm\'s own binary is used on macOS when PATH has none', async () => {
    const looked: string[] = []
    const { calls, adapter } = recorder({ onPath: () => null, exists: (path) => { looked.push(path); return path === APP_WEZTERM } })
    expect(await adapter.focus(pane('7'))).toBe(true)
    expect(calls).toEqual([activate(APP_WEZTERM, '7')])
    expect(looked).toEqual([APP_WEZTERM])
  })

  it('on Linux with none on PATH nothing runs, and the app\'s binary is never looked for', async () => {
    const looked: string[] = []
    const { calls, adapter } = recorder({ platform: 'linux', onPath: () => null, exists: (path) => { looked.push(path); return true } })
    expect(await adapter.focus(pane('7'))).toBe(false)
    expect(calls).toEqual([])
    expect(looked).toEqual([])
  })

  it('a pane id not in its form runs nothing', async () => {
    const { calls, adapter } = recorder()
    for (const id of ['7; rm -rf /', '--help', '-1', '7 ', '1234567890', '']) {
      expect(await adapter.focus(pane(id)), id).toBe(false)
    }
    expect(calls).toEqual([])
  })
})

/** A runner that runs nothing and answers each call the next of [answers], then exit 1: WezTerm's tab adapter reads
 *  what `list` printed. */
function tabRecorder(answers: Array<{ code: number | null; stdout: string }>, over: Partial<OrcaDeps> = {}) {
  const calls: Call[] = []
  let front: string | undefined = 'wezterm'
  const deps: OrcaDeps = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return answers.shift() ?? { code: 1, stdout: '' }
    },
    onPath: (name) => (name === 'wezterm' ? FAKE_PATH_WEZTERM : null),
    exists: () => false,
    platform: 'linux',
    ...over,
  }
  const adapter = createWeztermTabAdapter({ ...deps, front: () => front })
  return { calls, adapter, toFront: (app: string | undefined) => { front = app } }
}

/** An agent in a multiplexer whose client is in a WezTerm pane, as the outer lookup placed it. */
const outerPlace = (outer?: Place['outer']): Place => ({ host: 'herdr', app: 'wezterm', hints: {}, ...(outer ? { outer } : {}) })
const tab = (tty: string) => ({ adapter: 'wezterm-tab', id: tty })
const list: Call = { file: FAKE_PATH_WEZTERM, args: ['cli', '--no-auto-start', 'list', '--format', 'json'], timeoutMs: 10_000 }
const listed = { code: 0, stdout: RECORDED_WEZTERM.list }
const done = { code: 0, stdout: '' }
const recordedEntries = JSON.parse(RECORDED_WEZTERM.list) as Array<Record<string, unknown>>

describe("WezTerm's tab of an outer place", () => {
  it("a place in WezTerm's window by its client's tty is a tab that comes after the app", () => {
    const { adapter } = tabRecorder([])
    expect(adapter.id).toBe('wezterm-tab')
    expect(adapter.tap).toBe('after')
    expect(adapter.paneOf(outerPlace({ app: 'wezterm', tty: '/dev/pts/0', pid: 41 }))).toStrictEqual(tab('/dev/pts/0'))
    expect(adapter.canFocus(tab('/dev/pts/0'))).toBe(true)
    const mac = tabRecorder([], { platform: 'darwin' }).adapter
    expect(mac.paneOf(outerPlace({ app: 'wezterm', tty: '/dev/ttys004' }))).toStrictEqual(tab('/dev/ttys004'))
    expect(mac.paneOf(outerPlace({ app: 'wezterm', tty: '/dev/pts/0' }))).toBeUndefined()
    const notTabs: Array<Place['outer']> = [undefined, { app: 'kitty', tty: '/dev/pts/0' }, { app: 'wezterm' }, { app: 'wezterm', pid: 41 },
      ...['/dev/ttys004', '/dev/pts/../x', '/dev/pts/0 ', 'pts/0', ''].map((tty) => ({ app: 'wezterm', tty }))]
    for (const outer of notTabs) expect(adapter.paneOf(outerPlace(outer)), JSON.stringify(outer)).toBeUndefined()
    // An agent in WezTerm's own pane is WezTerm's own adapter's.
    expect(adapter.paneOf({ host: 'wezterm', app: 'wezterm', hints: { WEZTERM_PANE: '7' }, tty: '/dev/pts/0' })).toBeUndefined()
    const windows = tabRecorder([], { platform: 'win32' }).adapter
    expect(windows.paneOf(outerPlace({ app: 'wezterm', tty: '/dev/pts/0' }))).toBeUndefined()
    expect(windows.canFocus(tab('/dev/pts/0'))).toBe(false)
    expect(adapter.canFocus(tab('/dev/pts/../x'))).toBe(false)
  })

  it('a rest shows it only while WezTerm is in front', () => {
    const { adapter, toFront, calls } = tabRecorder([])
    expect(adapter.canShow(tab('/dev/pts/0'))).toBe(true)
    expect(adapter.canShow(tab('/dev/ttys004'))).toBe(false)
    for (const app of ['kitty', 'terminal-app', undefined]) {
      toFront(app)
      expect(adapter.canShow(tab('/dev/pts/0')), String(app)).toBe(false)
    }
    toFront('wezterm')
    expect(adapter.canShow(tab('/dev/pts/0'))).toBe(true)
    expect(calls).toEqual([])
  })

  // Activating a pane in a tab not in front also makes that tab its window's active one (the recording's
  // tabBecameActive), so no activate-tab runs.
  it("show lists once and activates the pane holding the client's tty", async () => {
    const recorded: Call = { file: FAKE_PATH_WEZTERM, args: RECORDED_WEZTERM.activatePane.argv.slice(1), timeoutMs: 10_000 }
    const { calls, adapter } = tabRecorder([listed, done, listed, done, listed])
    expect(await adapter.show(tab('/dev/pts/0'), 'agent-1')).toBe('ok')
    expect(calls).toEqual([list, recorded])
    expect(await adapter.focus(tab('/dev/pts/2'))).toBe(true)
    expect(calls.slice(2)).toEqual([list, activate(FAKE_PATH_WEZTERM, '2')])
    // No pane holds the client's tty: nothing is activated.
    expect(await adapter.show(tab('/dev/pts/9'), 'agent-1')).toBe('failed')
    expect(calls.slice(4)).toEqual([list])
  })

  it('a list out of form activates nothing and fails', async () => {
    const target = recordedEntries[0]!
    const other = recordedEntries[1]!
    const entries = (...more: unknown[]) => JSON.stringify([target, ...more])
    const panes = (count: number) => JSON.stringify(Array.from({ length: count }, (_, n) => ({ ...target, pane_id: n, tty_name: `/dev/pts/${n}` })))
    const outOfForm = [
      '',
      'not json',
      '{}',
      JSON.stringify(target),
      entries(null),
      entries('pane'),
      entries({ ...other, pane_id: '1' }),
      entries({ ...other, pane_id: -1 }),
      entries({ ...other, pane_id: 1.5 }),
      entries({ ...other, pane_id: 1234567890 }),
      entries({ ...other, pane_id: undefined }),
      entries({ ...other, tty_name: undefined }),
      entries({ ...other, tty_name: null }),
      panes(LISTED_PANES_MAX + 1),
    ]
    expect(LISTED_PANES_MAX).toBe(256)
    for (const stdout of outOfForm) {
      const { calls, adapter } = tabRecorder([{ code: 0, stdout }, { code: 0, stdout }])
      expect(await adapter.show(tab('/dev/pts/0'), 'agent-1'), stdout.slice(0, 80)).toBe('failed')
      expect(await adapter.focus(tab('/dev/pts/0')), stdout.slice(0, 80)).toBe(false)
      expect(calls).toEqual([list, list])
    }
    // At the bound, the list is read.
    const { calls, adapter } = tabRecorder([{ code: 0, stdout: panes(LISTED_PANES_MAX) }, done])
    expect(await adapter.show(tab('/dev/pts/255'), 'agent-1')).toBe('ok')
    expect(calls).toEqual([list, activate(FAKE_PATH_WEZTERM, '255')])
  })

  it('a list that failed: failed, and wezterm is looked for again', async () => {
    let looks = 0
    const failed = { code: 1, stdout: '' }
    const { calls, adapter } = tabRecorder([failed, { code: null, stdout: '' }, listed, done, listed, failed, listed],
      { onPath: () => { looks++; return FAKE_PATH_WEZTERM } })
    expect(await adapter.show(tab('/dev/pts/0'), 'agent-1')).toBe('failed')
    expect(looks).toBe(1)
    expect(await adapter.focus(tab('/dev/pts/0'))).toBe(false)
    expect(looks).toBe(2)
    expect(await adapter.show(tab('/dev/pts/0'), 'agent-1')).toBe('ok')
    expect(looks).toBe(3)
    // An activate that failed is looked for again too.
    expect(await adapter.show(tab('/dev/pts/0'), 'agent-1')).toBe('failed')
    expect(looks).toBe(3)
    expect(await adapter.show(tab('/dev/pts/9'), 'agent-1')).toBe('failed')
    expect(looks).toBe(4)
    expect(calls).toEqual([list, list, list, activate(FAKE_PATH_WEZTERM, '0'), list, activate(FAKE_PATH_WEZTERM, '0'), list])
    // None found: nothing runs.
    const none = tabRecorder([], { onPath: () => null })
    expect(await none.adapter.show(tab('/dev/pts/0'), 'agent-1')).toBe('failed')
    expect(none.calls).toEqual([])
  })
})
