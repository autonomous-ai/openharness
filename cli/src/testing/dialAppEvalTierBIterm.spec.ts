import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_BUNDLES } from '../cable/hosts/hostDetect.js'
import { itermSession } from './dialAppEval/catalog.js'
import type { SessionDef } from './dialAppEval/types.js'

// The dial eval's tier B iTerm2 steps, the parts that need no daemon. They are outside tsconfig's rootDir (src), so they
// are loaded untyped, as dialAppEvalTierB.spec.ts loads the harness.
const iterm = await import('../../e2e/harness/appEvalIterm.js' as string) as {
  itermHints(s: SessionDef): Record<string, string>
  tabOpened(tabs: Map<string, string>, label: string, tty: string): void
  tabClosed(tabs: Map<string, string>, label: string, tty: string): void
  leftOpen(client: Opened & { pid: number; processes: object }): Opened & { processes: object }
}
/** A tab of the fake iTerm2 as iTerm2's steps hold it. */
interface Opened { window: string; tab: number; label: string; tty: string; app?: number }

/** The parts of a daemon the fake apps read: its root, and its home in it. */
interface FakeDaemon { root: string; env: NodeJS.ProcessEnv }
type Tab = { process: ChildProcess; pid: number; shellPid?: number; appPid?: number }
const outside = await import('../../e2e/harness/outsideAgent.js' as string) as {
  tabUnder(d: FakeDaemon, app: 'iterm', argv: readonly string[], env: NodeJS.ProcessEnv):
    Promise<{ pid: number; appPid?: number; type?(text: string): void; close(): Promise<void> }>
  openTab(d: FakeDaemon, cwd: string, env: NodeJS.ProcessEnv, command: readonly string[], options: { app: 'iterm'; shell: boolean }): Promise<Tab>
  closeTab(tab: Tab, what: string): Promise<void>
  relaunchIterm(tab: { appPid?: number }): Promise<void>
  typeInto(tab: ChildProcess, text: string): void
}

let dir = ''
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("tier B's iTerm2", () => {
  it("a tab, a tmux and a herdr session's hints are Decision 8's", () => {
    // A tab's: iTerm2's TERM_PROGRAM and bundle id, as iTerm2 gives every shell it starts.
    expect(iterm.itermHints(itermSession('a'))).toEqual({ TERM_PROGRAM: 'iTerm.app', __CFBundleIdentifier: APP_BUNDLES.iterm })
    // tmux's: the bundle id its server started with; tmux sets TERM_PROGRAM and TMUX_PANE in its panes itself.
    expect(iterm.itermHints(itermSession('b', { place: 'tmux' }))).toEqual({ __CFBundleIdentifier: APP_BUNDLES.iterm })
    // herdr's: what its server started with, from an iTerm2 tab, which its panes keep; herdr sets HERDR_PANE_ID itself.
    expect(iterm.itermHints(itermSession('c', { place: 'herdr' }))).toEqual({ TERM_PROGRAM: 'iTerm.app', __CFBundleIdentifier: APP_BUNDLES.iterm })
  })

  it("a tab label maps to the tty its tab opened on, and a restart's new tab takes the label over", () => {
    const tabs = new Map<string, string>()
    iterm.tabOpened(tabs, 'w1.0.0', '/dev/ttys001')
    // herdr's first client's tab, then herdr started again: that tab closes, and a new one opens under its label.
    iterm.tabOpened(tabs, 'w1.2.0', '/dev/ttys003')
    iterm.tabClosed(tabs, 'w1.2.0', '/dev/ttys003')
    expect(tabs.has('w1.2.0')).toBe(false)
    iterm.tabOpened(tabs, 'w1.2.0', '/dev/ttys004')
    expect(Object.fromEntries(tabs)).toEqual({ 'w1.0.0': '/dev/ttys001', 'w1.2.0': '/dev/ttys004' })
    // A tab that takes a label over while the old one is open keeps it as the old one closes.
    iterm.tabOpened(tabs, 'w1.0.0', '/dev/ttys005')
    iterm.tabClosed(tabs, 'w1.0.0', '/dev/ttys001')
    expect(tabs.get('w1.0.0')).toBe('/dev/ttys005')
    // macOS gives a closed tab's tty to the next tab: the label it held goes with it.
    iterm.tabOpened(tabs, 'w1.3.0', '/dev/ttys004')
    expect(Object.fromEntries(tabs)).toEqual({ 'w1.0.0': '/dev/ttys005', 'w1.3.0': '/dev/ttys004' })
  })

  it("a detached client's tab stays open on its shell, whose pid its close ends: never the gone client's, another process's by then", () => {
    const processes = { pid: 4001, shellPid: 4000, appPid: 3990 }
    const client = { window: 'w1', tab: 1, label: 'w1.1.0', tty: '/dev/ttys004', app: 3990, pid: 4001, processes }
    expect(iterm.leftOpen(client)).toEqual({ window: 'w1', tab: 1, label: 'w1.1.0', tty: '/dev/ttys004', app: 3990,
      processes: { pid: 4000, shellPid: 4000, appPid: 3990 } })
  })
})

describe.skipIf(process.platform !== 'darwin')("tier B's fake iTerm2, relaunched", () => {
  it("a tab of it takes no keys, and typing into one throws: its keys went in through the app's stdin, which Node closed as it ended", async () => {
    dir = mkdtempSync(join(tmpdir(), 'tier-b-relaunch-'))
    const d: FakeDaemon = { root: dir, env: { HOME: join(dir, 'home'), PATH: process.env.PATH } }
    const client = await outside.tabUnder(d, 'iterm', ['/bin/cat'], d.env)
    const shell = await outside.openTab(d, dir, d.env, ['/bin/cat'], { app: 'iterm', shell: true })
    try {
      await outside.relaunchIterm(client)
      await outside.relaunchIterm(shell)
      expect(() => client.type!('lost\r')).toThrow(/takes no keys/)
      expect(() => outside.typeInto(shell.process, 'lost\r')).toThrow(/takes no keys/)
    } finally {
      await client.close()
      await outside.closeTab(shell, 'the shell tab')
    }
  })
})
