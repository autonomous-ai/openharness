import { describe, expect, it } from 'vitest'
import { APP_BUNDLES } from '../cable/hosts/hostDetect.js'
import { itermSession } from './dialAppEval/catalog.js'
import type { SessionDef } from './dialAppEval/types.js'

// The dial eval's tier B iTerm2 steps, the parts that need no daemon. They are outside tsconfig's rootDir (src), so they
// are loaded untyped, as dialAppEvalTierB.spec.ts loads the harness.
const iterm = await import('../../e2e/harness/appEvalIterm.js' as string) as {
  itermHints(s: SessionDef): Record<string, string>
  tabOpened(tabs: Map<string, string>, label: string, tty: string): void
  tabClosed(tabs: Map<string, string>, label: string, tty: string): void
}

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
})
