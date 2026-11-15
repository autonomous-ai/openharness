import { describe, expect, it } from 'vitest'
import type { Place } from './adapter.js'
import type { OrcaDeps } from './orca.js'
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
      return { code: codes.length ? codes.shift()! : 0 }
    },
    onPath: (name) => (name === 'wezterm' ? FAKE_PATH_WEZTERM : null),
    exists: () => false,
    platform: 'darwin',
    ...over,
  }
  return { calls, adapter: createWeztermAdapter(deps) }
}

const place = (hints: Record<string, string>): Place => ({ host: 'wezterm', app: 'wezterm', hints })
const pane = (id: string) => ({ adapter: 'wezterm', id })
const activate = (file: string, id: string): Call => ({ file, args: ['cli', 'activate-pane', '--pane-id', id], timeoutMs: 10_000 })

describe('the WezTerm adapter', () => {
  it('its id is wezterm, it taps before its app, and it has no show and no type', () => {
    const { adapter } = recorder()
    expect(adapter.id).toBe('wezterm')
    expect(adapter.tap).toBe('before')
    expect(adapter.show).toBeUndefined()
    expect(adapter.canShow).toBeUndefined()
    expect(adapter.type).toBeUndefined()
    expect(adapter.canFocus(pane('7'))).toBe(true)
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
