import { describe, expect, it } from 'vitest'
import { isTabLabel, namedPanes, selectRecord, sessionTab, tabLabel } from './itermRecords.js'
import type { SessionKey } from './types.js'

describe('iTerm2 records', () => {
  it("a tab's label is window.tab.split, split 0 by default", () => {
    expect(tabLabel({ window: 'w1', tab: 1, split: 2 })).toBe('w1.1.2')
    expect(tabLabel({ window: 'w2', tab: 0 })).toBe('w2.0.0')
    expect(sessionTab({ place: 'tab', window: 'w1', tab: 2, split: 1 })).toBe('w1.2.1')
    expect(sessionTab({ window: 'w1', tab: 0 })).toBe('w1.0.0')
  })

  it('isTabLabel takes what tabLabel writes and nothing else, so no tty, pane id or session name passes for one', () => {
    expect([tabLabel({ window: 'w1', tab: 0 }), tabLabel({ window: 'w12', tab: 3, split: 1 })].map(isTabLabel)).toEqual([true, true])
    for (const other of ['/dev/ttys004', 'ttys004', '%3', 'w1:p2', 'eval-w1-2', 'other', 'w1.1', 'W1.1.0', 'w1.1.0 ', undefined, 7]) {
      expect(isTabLabel(other), String(other)).toBe(false)
    }
  })

  it("a tmux or herdr session's tab is its client's, split 0", () => {
    expect(sessionTab({ place: 'tmux', window: 'w1', tab: 1, split: 2 })).toBe('w1.1.0')
    expect(sessionTab({ place: 'herdr', window: 'w2', tab: 3, split: 1 })).toBe('w2.3.0')
  })

  it('namedPanes writes %3 and w1:p2 as their sessions\' keys and an unknown one as pane:other, and leaves formats, session names and other arguments as they are', () => {
    const panes: Record<string, SessionKey> = { '%3': 'a', 'w1:p2': 'b' }
    const keyOf = (pane: string): SessionKey | undefined => panes[pane]
    expect(namedPanes(['select-window', '-t', '%3', ';', 'select-pane', '-t', '%3'], keyOf))
      .toEqual(['select-window', '-t', 'pane:a', ';', 'select-pane', '-t', 'pane:a'])
    expect(namedPanes(['agent', 'focus', 'w1:p2'], keyOf)).toEqual(['agent', 'focus', 'pane:b'])
    expect(namedPanes(['switch-client', '-c', '/dev/ttys004', '-t', '%9'], keyOf))
      .toEqual(['switch-client', '-c', '/dev/ttys004', '-t', 'pane:other'])
    expect(namedPanes(['agent', 'focus', 'w1:pA'], keyOf)).toEqual(['agent', 'focus', 'pane:other'])
    expect(namedPanes(['list-clients', '-t', 'eval-w1-0', '-F', '#{client_name} #{pane_id}', '%3x', 'w1:p'], keyOf))
      .toEqual(['list-clients', '-t', 'eval-w1-0', '-F', '#{client_name} #{pane_id}', '%3x', 'w1:p'])
  })

  it('selectRecord names the tab by label, other for an unknown tty, and keeps raise only when true', () => {
    const labelOf = (tty: string): string | undefined => (tty === '/dev/ttys002' ? 'w1.1.0' : undefined)
    expect(selectRecord({ app: 'iterm', tty: '/dev/ttys002', raise: true }, labelOf)).toEqual({ app: 'iterm', tab: 'w1.1.0', raise: true })
    expect(selectRecord({ app: 'iterm', tty: '/dev/ttys002', raise: false }, labelOf)).toEqual({ app: 'iterm', tab: 'w1.1.0' })
    expect(selectRecord({ app: 'iterm', tty: '/dev/ttys009' }, labelOf)).toEqual({ app: 'iterm', tab: 'other' })
  })
})
