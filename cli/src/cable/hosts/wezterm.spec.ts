import { describe, expect, it } from 'vitest'
import type { Place } from './adapter.js'
import { MAX_TEXT, type OrcaDeps } from './orca.js'
import { createWeztermAdapter } from './wezterm.js'

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
      expect(found, `${at.host} ${at.ptyOwner}`).toEqual(pane('held:7'))
      expect(adapter.canType!(found)).toBe(false)
      expect(await adapter.type!(found, 'hello', 'claude')).toBe(false)
      expect(calls).toEqual([])
    }
    expect(await adapter.focus(pane('held:7'))).toBe(true)
    expect(calls).toEqual([activate(FAKE_PATH_WEZTERM, '7')])
  })

  // `code .` run in WezTerm's pane 7: Codex in VS Code's terminal carries WEZTERM_PANE=7, and detectHost says WezTerm.
  it('a terminal started from the pane takes no words', async () => {
    const { calls, adapter } = recorder()
    const found = adapter.paneOf(place({ WEZTERM_PANE: '7', TERM_PROGRAM: 'vscode' }, 'wezterm', null))!
    expect(found).toEqual(pane('held:7'))
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
