import { describe, expect, it } from 'vitest'
import type { Place } from './adapter.js'
import { createCodexAppAdapter } from './codexApp.js'

const THREAD = '01a1de76-a3b7-7270-b39e-1245893274c1'
const CODEX_APP = 'com.openai.codex'
const FALLBACK = '[device] open · codex · fallback'

interface Call { file: string; args: string[]; timeoutMs: number }
type Deps = Parameters<typeof createCodexAppAdapter>[0]

/** A recording runner that runs nothing, so no spec opens the developer's own Codex app: each call answers the next of
 *  [codes] (null: it timed out or never started), then exit 0. */
function recorder(over: Partial<Deps> = {}, codes: Array<number | null> = []) {
  const calls: Call[] = []
  const logs: string[] = []
  const deps: Deps = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return { code: codes.length ? codes.shift()! : 0, stdout: '' }
    },
    platform: 'darwin',
    inFront: () => true,
    log: (line) => { logs.push(line) },
    ...over,
  }
  return { calls, logs, adapter: createCodexAppAdapter(deps) }
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

const pane = (id: string) => ({ adapter: 'codex', id })
const link: Call = { file: '/usr/bin/open', args: ['-b', CODEX_APP, `codex://threads/${THREAD}`], timeoutMs: 10_000 }
const forward: Call = { file: '/usr/bin/open', args: ['-b', CODEX_APP], timeoutMs: 10_000 }
/** A session the open scan found: the app and the session id, and no hook's hints yet. */
const scanned = (over: Partial<Place> = {}): Place => ({ host: 'terminal', app: 'codex', hints: {}, engine: 'codex', sessionId: THREAD, ...over })

describe('the Codex app adapter', () => {
  it('its id is codex, its link takes the place of open -b, and it types nothing', () => {
    const { adapter } = recorder()
    expect(adapter.id).toBe('codex')
    expect(adapter.tap).toBe('instead')
    expect(adapter.type).toBeUndefined()
  })

  it('paneOf: a hook\'s place and a scan\'s place both give the thread\'s pane', () => {
    const { adapter } = recorder()
    const hooked: Place = { host: 'codex', app: 'codex', hints: { __CFBundleIdentifier: CODEX_APP }, engine: 'codex', sessionId: THREAD, pid: 4242 }
    expect(adapter.paneOf(hooked)).toEqual(pane(THREAD))
    expect(adapter.paneOf(scanned())).toEqual(pane(THREAD))
  })

  it('paneOf: none for another app, another engine, or a session id that is no thread id', () => {
    const { adapter } = recorder()
    // A Codex session in another app has a thread id too: its tap brings its own app.
    for (const app of ['ghostty', 'orca']) expect(adapter.paneOf(scanned({ app })), app).toBeUndefined()
    // The app decides, never a hint.
    expect(adapter.paneOf(scanned({ app: 'terminal', hints: { __CFBundleIdentifier: CODEX_APP } }))).toBeUndefined()
    expect(adapter.paneOf(scanned({ engine: 'claude' }))).toBeUndefined()
    expect(adapter.paneOf(scanned({ sessionId: undefined }))).toBeUndefined()
    const forged = [THREAD.toUpperCase(), `${THREAD}/../x`, `${THREAD}?x=1`, '--args', 'local_abc', 'my-thread', '']
    for (const sessionId of forged) expect(adapter.paneOf(scanned({ sessionId })), sessionId).toBeUndefined()
  })

  it('canFocus is macOS only; canShow also needs the app in front, asked each time', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const { adapter } = recorder({ platform })
      expect(adapter.canFocus(pane(THREAD)), platform).toBe(false)
      expect(adapter.canShow(pane(THREAD)), platform).toBe(false)
    }
    let front = true
    const { adapter } = recorder({ inFront: () => front })
    expect(adapter.canFocus(pane(THREAD))).toBe(true)
    expect(adapter.canShow(pane(THREAD))).toBe(true)
    front = false
    expect(adapter.canFocus(pane(THREAD))).toBe(true)
    expect(adapter.canShow(pane(THREAD))).toBe(false)
  })

  it('focus runs /usr/bin/open -b com.openai.codex with the thread\'s link, the URL one argument', async () => {
    const { calls, logs, adapter } = recorder()
    expect(await adapter.focus(pane(THREAD))).toBe(true)
    expect(calls).toEqual([link])
    expect(logs).toEqual([])

    for (const platform of ['linux', 'win32'] as const) {
      const off = recorder({ platform })
      expect(await off.adapter.focus(pane(THREAD)), platform).toBe(false)
      expect(off.calls).toEqual([])
    }

    const forged = recorder()
    expect(await forged.adapter.focus(pane(`${THREAD}?x=1`))).toBe(false)
    expect(forged.calls).toEqual([])
    expect(forged.logs).toEqual([])
  })

  it('a link that exits non-zero or times out brings the app forward once, in one line with no thread id', async () => {
    for (const code of [1, null]) {
      const { calls, logs, adapter } = recorder({}, [code])
      expect(await adapter.focus(pane(THREAD)), String(code)).toBe(true)
      expect(calls).toEqual([link, forward])
      expect(logs).toEqual([FALLBACK])
      for (const line of logs) expect(line).not.toContain(THREAD)
    }
  })

  it('a link and an app that both fail answer false', async () => {
    for (const codes of [[1, 1], [null, null]]) {
      const { calls, logs, adapter } = recorder({}, codes)
      expect(await adapter.focus(pane(THREAD)), String(codes)).toBe(false)
      expect(calls).toEqual([link, forward])
      expect(logs).toEqual([FALLBACK])
    }
  })

  // The end-to-end harness points HARNESS_OPEN_BIN at a fake that opens nothing (e2e/harness/daemon.ts), as open.ts
  // takes it.
  it.each([
    ['/tmp/e2e/fake-open', '/tmp/e2e/fake-open'],
    ['', '/usr/bin/open'],
    ['fake-open', '/usr/bin/open'],
    [undefined, '/usr/bin/open'],
  ])('HARNESS_OPEN_BIN %j: an absolute path is the open a tap, its fallback and a rest run; empty, relative and none run /usr/bin/open', async (bin, file) => {
    const { calls, adapter } = recorder({ bin }, [1])
    expect(await adapter.focus(pane(THREAD))).toBe(true)
    expect(await adapter.show(pane(THREAD), 'a1')).toBe('ok')
    expect(calls).toEqual([{ ...link, file }, { ...forward, file }, { ...link, file }])
  })
})

describe('a rest on a Codex app session', () => {
  it('a rest runs the link alone; one that fails stays failed and brings nothing forward', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.show(pane(THREAD), 'a1')).toBe('ok')
    expect(calls).toEqual([link])

    for (const code of [1, null]) {
      const failed = recorder({}, [code])
      expect(await failed.adapter.show(pane(THREAD), 'a1'), String(code)).toBe('failed')
      expect(failed.calls).toEqual([link])
      expect(failed.logs).toEqual([])
    }
  })

  it('a rest with the app not in front is not asked for, and one with a bad id or off macOS runs nothing', async () => {
    expect(recorder({ inFront: () => false }).adapter.canShow(pane(THREAD))).toBe(false)

    const forged = recorder()
    for (const id of ['', '--args', `${THREAD}/../x`, THREAD.toUpperCase()]) {
      expect(await forged.adapter.show(pane(id), 'a1'), id).toBe('failed')
    }
    expect(forged.calls).toEqual([])

    for (const platform of ['linux', 'win32'] as const) {
      const off = recorder({ platform })
      expect(await off.adapter.show(pane(THREAD), 'a1'), platform).toBe('failed')
      expect(off.calls).toEqual([])
    }
  })

  it('a link still running drops the next rest for that agent', async () => {
    const { calls, waiting, adapter } = holding()
    const first = adapter.show(pane(THREAD), 'a1')
    expect(await adapter.show(pane(THREAD), 'a1')).toBe('busy')
    expect(calls).toEqual([link])
    waiting[0]()
    expect(await first).toBe('ok')
  })
})
