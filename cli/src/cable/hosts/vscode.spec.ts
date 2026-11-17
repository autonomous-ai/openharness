import { describe, expect, it } from 'vitest'
import type { AppLinkDeps } from './appLink.js'
import { detectApp, detectHost } from './hostDetect.js'
import { bundleOf, createOpenActions, type OpenTarget } from './open.js'
import { createVscodeAdapter } from './vscode.js'

const OPEN = '/usr/bin/open'
/** A Claude Code session's id, as its hook names it. */
const UUID = '8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
const UUID2 = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'
const VSCODE = 'com.microsoft.VSCode'
const link = (id: string) => `vscode://anthropic.claude-code/open?session=${id}`

interface Call { file: string; args: string[]; timeoutMs: number }
type Deps = AppLinkDeps

/** A recording runner that runs nothing, so no spec opens the developer's own VS Code: each call answers the next of
 *  [codes], then exit 0. VS Code is in front unless told. The opener holds this adapter alone. */
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
    ...over,
  }
  const adapter = createVscodeAdapter(deps)
  const log = (line: string) => { logs.push(line) }
  return { calls, logs, adapter, opener: createOpenActions({ run: deps.run, platform: deps.platform, adapters: [adapter], log }) }
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
    expect(adapter.type).toBeUndefined()
    expect(adapter.canFocus(pane)).toBe(true)
    expect(adapter.canShow(pane)).toBe(true)
    expect(recorder({ inFront: () => false }).adapter.canShow(pane)).toBe(false)
    for (const platform of ['linux', 'win32'] as const) {
      const elsewhere = recorder({ platform })
      expect(elsewhere.adapter.canFocus(pane), platform).toBe(false)
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
      // The app is VS Code by TERM_PROGRAM alone: inferred, so no link.
      [{ TERM_PROGRAM: 'vscode', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }, UUID, VSCODE],
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
    expect(linux.opener.can(target(TAB))).toBe(false)
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
