import { describe, expect, it } from 'vitest'
import { terminalActivity } from './terminalActivity.js'

describe('terminalActivity', () => {
  it.each([
    ['codex', '◦ Working (27m 18s • esc to interrupt)', 'Working'],
    ['codex', '• Thinking (1s • esc to interrupt)', 'Thinking'],
    ['claude', '✻ Coalescing… (1m 7s · ↓ 2.2k tokens)', 'Coalescing...'],
    ['claude', '\x1b[33m✳ Boogieing...\x1b[0m', 'Boogieing...'],
    ['claude', '✢ Crunching…', 'Crunching...'],
    ['claude', '✶ Coalescing… (1h 11m 34s · ↓ 31.2k tokens)', 'Coalescing...'],
    ['claude', '· Compacting conversation… (25s · ↓ 1.3k tokens)', 'Compacting conversation...'],
  ])('copies the %s footer verbatim, normalizing only the ellipsis glyph', (engine, screen, label) => {
    expect(terminalActivity(engine, screen)).toBe(label)
  })
  it.each([
    ['claude', '✻ Baked for 1m 41s · done 10:29 AM'],
    ['codex', 'Working'],
    ['codex', '◦ Running tmux capture-pane -p -J -t %2'],
    ['claude', 'Coalescing...'],
    ['claude', 'The agent says ✻ Coalescing…'],
    ['terminal', '• Working (1s • esc to interrupt)'],
  ])('does not turn %s output into a status: %s', (engine, screen) => {
    expect(terminalActivity(engine, screen)).toBeNull()
  })
  it('finds the Claude activity above an expanded agent tree', () => {
    const screen = [
      'tool output', '✶ Wandering… (19m 0s · ↓ 52.6k tokens)',
      '  Tip: Use /btw for a quick question', '', '──────────────────',
      '❯\u00a0', '──────────────────',
      '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt',
      '  ◎ /goal active (41m)', '', '  ● main',
      ...Array.from({length: 12}, (_, i) => `  ◯ general-purpose  Task ${i}`), '',
    ].join('\n')
    expect(terminalActivity('claude', screen)).toBe('Wandering...')
    // An old spinner in output cannot replace the live one near the input.
    expect(terminalActivity('claude', '✻ Coalescing…\n' + screen)).toBe('Wandering...')
    // Without Claude's actual footer, a quoted prompt does not widen the search.
    expect(terminalActivity('claude', screen.replace('shift+tab to cycle', 'help').replace('esc to interrupt', ''))).toBeNull()
  })
  it('ignores history above the live footer and prefers its last matching row', () => {
    expect(terminalActivity('claude', '✻ Coalescing…\n' + '\n'.repeat(17))).toBeNull()
    expect(terminalActivity('codex', '• Thinking (1s • esc to interrupt)\n◦ Working (2s • esc to interrupt)')).toBe('Working')
  })
})
