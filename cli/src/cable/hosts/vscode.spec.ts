import { describe, expect, it } from 'vitest'
import { detectApp, detectHost } from './hostDetect.js'
import { bundleOf, createOpenActions, type OpenTarget } from './open.js'
import { createVscodeAdapter } from './vscode.js'

const OPEN = '/usr/bin/open'
/** A Claude Code session's id, as its hook names it. */
const UUID = '8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'

interface Call { file: string; args: string[]; timeoutMs: number }
type Deps = Parameters<typeof createVscodeAdapter>[0]

/** A recording runner that runs nothing, so no spec opens the developer's own VS Code: each call answers the next of
 *  [codes], then exit 0. The opener holds this adapter alone. */
function recorder(over: Partial<Deps> = {}, codes: Array<number | null> = []) {
  const calls: Call[] = []
  const logs: string[] = []
  const deps: Deps = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return { code: codes.length ? codes.shift()! : 0, stdout: '' }
    },
    platform: 'darwin',
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
  it('its id is vscode, it taps before its app, and only macOS can focus', async () => {
    const pane = { adapter: 'vscode', id: UUID }
    const { adapter } = recorder()
    expect(adapter.id).toBe('vscode')
    expect(adapter.tap).toBe('before')
    expect(adapter.show).toBeUndefined()
    expect(adapter.canShow).toBeUndefined()
    expect(adapter.type).toBeUndefined()
    expect(adapter.canFocus(pane)).toBe(true)
    for (const platform of ['linux', 'win32'] as const) {
      const elsewhere = recorder({ platform })
      expect(elsewhere.adapter.canFocus(pane), platform).toBe(false)
      expect(await elsewhere.adapter.focus(pane), platform).toBe(false)
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
    expect(calls).toEqual([run(file, `vscode://anthropic.claude-code/open?session=${UUID}`)])
  })

  it('a pane id not in its form runs nothing', async () => {
    const { calls, adapter } = recorder()
    for (const id of ['sess-1', UUID.toUpperCase(), `${UUID}&x=y`, `${UUID}/..`, `local_${UUID}`, '', '--args']) {
      expect(await adapter.focus({ adapter: 'vscode', id }), id).toBe(false)
    }
    expect(calls).toEqual([])
  })
})

describe('a tap on a session in the VS Code extension\'s tab (docs/specs/2026-11-15-device-wave1-checks.md, F3)', () => {
  const VSCODE = 'com.microsoft.VSCode'
  const CURSOR = 'com.todesktop.230313mzl4w4u92'
  const TAB = { __CFBundleIdentifier: VSCODE, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }
  const tabLink = run(OPEN, `vscode://anthropic.claude-code/open?session=${UUID}`)

  it('the VS Code extension\'s tab: its session\'s link, then VS Code comes forward', async () => {
    const { calls, logs, opener } = recorder()
    expect(target(TAB)).toEqual({ bundle: VSCODE, pane: { adapter: 'vscode', id: UUID } })
    expect(await opener.open('a1', target(TAB))).toBe(true)
    expect(calls).toEqual([tabLink, forward(VSCODE)])
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
