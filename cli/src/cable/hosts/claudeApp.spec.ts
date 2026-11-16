import { describe, expect, it } from 'vitest'
import type { Place } from './adapter.js'
import { createClaudeAppAdapter } from './claudeApp.js'

const SESSION = 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
const OTHER = 'local_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const CLAUDE = 'com.anthropic.claudefordesktop'
const OPEN = '/usr/bin/open'

interface Call { file: string; args: string[]; timeoutMs: number }
type Deps = Parameters<typeof createClaudeAppAdapter>[0]

/** A recording runner that runs nothing, so no spec opens the developer's own Claude app: each call answers the next
 *  of [codes], then exit 0. */
function recorder(over: Partial<Deps> = {}, codes: Array<number | null> = []) {
  const calls: Call[] = []
  const deps: Deps = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return { code: codes.length ? codes.shift()! : 0, stdout: '' }
    },
    platform: 'darwin',
    inFront: () => true,
    ...over,
  }
  return { calls, adapter: createClaudeAppAdapter(deps) }
}

/** The recorder, each command held until it is let go, so a link can be caught still running. */
function holding() {
  const calls: Call[] = []
  const waiting: Array<() => void> = []
  const { adapter } = recorder({
    run: (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return new Promise((resolve) => waiting.push(() => resolve({ code: 0, stdout: '' })))
    },
  })
  return { calls, waiting, adapter }
}

const place = (hints: Record<string, string>): Place => ({ host: 'claude', app: 'claude', hints })
const pane = (id: string) => ({ adapter: 'claude', id })
const link = (session: string): Call => ({ file: OPEN, args: ['-b', CLAUDE, `claude://code/continue?session=${session}`], timeoutMs: 10_000 })

describe('the Claude app adapter', () => {
  it('its id is claude, and its link takes the place of open -b', () => {
    const { adapter } = recorder()
    expect(adapter.id).toBe('claude')
    expect(adapter.tap).toBe('instead')
    expect(adapter.type).toBeUndefined()
  })

  it('paneOf takes a local_ session of the Claude app\'s own, and refuses any other', () => {
    const { adapter } = recorder()
    expect(adapter.paneOf(place({ __CFBundleIdentifier: CLAUDE, CLAUDE_CODE_HOST_SESSION_ID: SESSION }))).toEqual(pane(SESSION))

    // A session id another app's agent carries opens no link.
    expect(adapter.paneOf(place({ __CFBundleIdentifier: 'com.mitchellh.ghostty', CLAUDE_CODE_HOST_SESSION_ID: SESSION }))).toBeUndefined()
    expect(adapter.paneOf(place({ TERM_PROGRAM: 'ghostty', CLAUDE_CODE_HOST_SESSION_ID: SESSION }))).toBeUndefined()
    expect(adapter.paneOf(place({ __CFBundleIdentifier: CLAUDE }))).toBeUndefined()
    const forged = ['local_', 'local_a/b', 'local_x&source=y', `local_${'a'.repeat(65)}`, 'session_abc', '--args', '8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b']
    for (const session of forged) {
      expect(adapter.paneOf(place({ __CFBundleIdentifier: CLAUDE, CLAUDE_CODE_HOST_SESSION_ID: session })), session).toBeUndefined()
    }
  })

  it('canFocus is macOS only; canShow also needs the app in front, asked each time', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const { adapter } = recorder({ platform })
      expect(adapter.canFocus(pane(SESSION)), platform).toBe(false)
      expect(adapter.canShow(pane(SESSION)), platform).toBe(false)
    }
    let front = true
    const { adapter } = recorder({ inFront: () => front })
    expect(adapter.canFocus(pane(SESSION))).toBe(true)
    expect(adapter.canShow(pane(SESSION))).toBe(true)
    front = false
    expect(adapter.canFocus(pane(SESSION))).toBe(true)
    expect(adapter.canShow(pane(SESSION))).toBe(false)
  })

  it('focus runs the continue link alone', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.focus(pane(SESSION))).toBe(true)
    expect(calls).toEqual([link(SESSION)])

    for (const code of [1, null]) {
      const failed = recorder({}, [code])
      expect(await failed.adapter.focus(pane(SESSION)), String(code)).toBe(false)
      expect(failed.calls).toEqual([link(SESSION)])
    }

    const linux = recorder({ platform: 'linux' })
    expect(await linux.adapter.focus(pane(SESSION))).toBe(false)
    expect(linux.calls).toEqual([])

    const forged = recorder()
    expect(await forged.adapter.focus(pane('local_a&x=1'))).toBe(false)
    expect(forged.calls).toEqual([])
  })
})

describe('a rest on a Claude app session', () => {
  it('runs the continue link, and nothing else', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.show(pane(SESSION), 'a1')).toBe('ok')
    expect(calls).toEqual([link(SESSION)])
  })

  it('a link that exits non-zero, or never exits, is failed, and no app is brought forward', async () => {
    for (const code of [1, null]) {
      const { calls, adapter } = recorder({}, [code])
      expect(await adapter.show(pane(SESSION), 'a1'), String(code)).toBe('failed')
      expect(calls).toEqual([link(SESSION)])
    }
  })

  it('an id not in the link\'s form never reaches open', async () => {
    const { calls, adapter } = recorder()
    const bad = ['', 'local_', `local_${'a'.repeat(65)}`, 'local_a b', 'local_a&x=1', 'local_a/../b', '-b', '8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b']
    for (const session of bad) expect(await adapter.show(pane(session), 'a1'), session).toBe('failed')
    expect(calls).toEqual([])
  })

  it('on Linux and Windows nothing runs', async () => {
    for (const platform of ['linux', 'win32'] as const) {
      const { calls, adapter } = recorder({ platform })
      expect(await adapter.show(pane(SESSION), 'a1'), platform).toBe('failed')
      expect(calls).toEqual([])
    }
  })

  it('a link still running drops the next for that agent, and another agent\'s runs', async () => {
    const { calls, waiting, adapter } = holding()
    const first = adapter.show(pane(SESSION), 'a1')
    expect(await adapter.show(pane(OTHER), 'a1')).toBe('busy')
    expect(calls).toEqual([link(SESSION)])
    const other = adapter.show(pane(OTHER), 'a2')
    expect(calls).toEqual([link(SESSION), link(OTHER)])
    waiting[0]()
    expect(await first).toBe('ok')
    // Once its link has ended, the agent takes the next one.
    const next = adapter.show(pane(OTHER), 'a1')
    expect(calls).toEqual([link(SESSION), link(OTHER), link(OTHER)])
    waiting[1]()
    waiting[2]()
    expect(await other).toBe('ok')
    expect(await next).toBe('ok')
  })

  it('a focus is not refused while a show\'s link runs, and a show is not busy while a focus runs', async () => {
    const { calls, waiting, adapter } = holding()
    const rest = adapter.show(pane(SESSION), 'a1')
    const tap = adapter.focus(pane(SESSION))
    expect(calls).toEqual([link(SESSION), link(SESSION)])
    for (const done of waiting.splice(0)) done()
    expect(await rest).toBe('ok')
    expect(await tap).toBe(true)

    const tapFirst = adapter.focus(pane(SESSION))
    const restAfter = adapter.show(pane(SESSION), 'a1')
    expect(calls).toEqual([link(SESSION), link(SESSION), link(SESSION), link(SESSION)])
    for (const done of waiting.splice(0)) done()
    expect(await tapFirst).toBe(true)
    expect(await restAfter).toBe('ok')
  })
})
