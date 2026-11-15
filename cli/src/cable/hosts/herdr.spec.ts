import { describe, expect, it } from 'vitest'
import type { Place } from './adapter.js'
import type { OrcaDeps } from './orca.js'
import { createHerdrAdapter } from './herdr.js'

const FAKE_PATH_HERDR = '/fake/bin/herdr'

interface Call { file: string; args: string[]; timeoutMs: number }

/** A recording runner that runs nothing, so no spec moves the developer's own herdr: each call answers the next of
 *  [codes], then exit 0. */
function recorder(over: Partial<OrcaDeps> = {}, codes: Array<number | null> = []) {
  const calls: Call[] = []
  const deps: OrcaDeps = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return { code: codes.length ? codes.shift()! : 0 }
    },
    onPath: (name) => (name === 'herdr' ? FAKE_PATH_HERDR : null),
    exists: () => false,
    platform: 'darwin',
    ...over,
  }
  return { calls, adapter: createHerdrAdapter(deps) }
}

const place = (hints: Record<string, string>): Place => ({ host: 'herdr', app: 'herdr', hints })
const pane = (id: string) => ({ adapter: 'herdr', id })
const focusCall = (id: string): Call => ({ file: FAKE_PATH_HERDR, args: ['agent', 'focus', id], timeoutMs: 10_000 })

describe('the herdr adapter', () => {
  it('its id is herdr, it taps before its app, and it has no show and no type', () => {
    const { adapter } = recorder()
    expect(adapter.id).toBe('herdr')
    expect(adapter.tap).toBe('before')
    expect(adapter.show).toBeUndefined()
    expect(adapter.canShow).toBeUndefined()
    expect(adapter.type).toBeUndefined()
    expect(adapter.canFocus(pane('w1:p2'))).toBe(true)
  })

  it('paneOf takes a pane id, and refuses any other', () => {
    const { adapter } = recorder()
    expect(adapter.paneOf(place({ HERDR_PANE_ID: 'w1:p2' }))).toEqual(pane('w1:p2'))
    expect(adapter.paneOf(place({ __CFBundleIdentifier: 'com.mitchellh.ghostty', HERDR_PANE_ID: 'w1:p2' }))).toEqual(pane('w1:p2'))
    expect(adapter.paneOf(place({}))).toBeUndefined()
    for (const id of ['--help', 'w1:p1; rm -rf /', 'w1', ' w1:p1', 'w1:t1', 'p1']) {
      expect(adapter.paneOf(place({ HERDR_PANE_ID: id })), id).toBeUndefined()
    }
  })

  it('focus focuses the agent', async () => {
    const { calls, adapter } = recorder({}, [0, 1, null])
    expect(await adapter.focus(pane('w1:p2'))).toBe(true)
    expect(await adapter.focus(pane('w1:p2'))).toBe(false)
    expect(await adapter.focus(pane('w1:p2'))).toBe(false)
    expect(calls).toEqual([focusCall('w1:p2'), focusCall('w1:p2'), focusCall('w1:p2')])
  })

  it('with no herdr on PATH nothing runs', async () => {
    const { calls, adapter } = recorder({ onPath: () => null })
    expect(await adapter.focus(pane('w1:p2'))).toBe(false)
    expect(calls).toEqual([])
  })

  it('a pane id not in its form runs nothing', async () => {
    const { calls, adapter } = recorder()
    for (const id of ['--help', 'w1:p1; rm -rf /', 'w1', ' w1:p1', 'w1:t1', 'p1']) {
      expect(await adapter.focus(pane(id)), id).toBe(false)
    }
    expect(calls).toEqual([])
  })
})
