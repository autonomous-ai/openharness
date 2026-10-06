import { expect, it } from 'vitest'
import { teamWriteHold } from './preflight.js'
import { CLAUDE_REWIND_CONFIRM, CLAUDE_REWIND_EMPTY, CLAUDE_REWIND_LIST, CODEX_BROWSING_SCROLLBACK } from '../lib/__fixtures__/rewindPickers.js'

it('holds multiline drafts with an empty first line', () => {
  expect(teamWriteHold('claude', '────────────\n❯\n  a human draft\n────────────\n  ? for shortcuts')).toBe('team_waiting_draft')
  expect(teamWriteHold('codex', '›\n  a human draft\n  100% context left')).toBe('team_waiting_draft')
})
it('accepts proven empty composers and refuses busy or unrecognized surfaces', () => {
  expect(teamWriteHold('claude', '────────────\n❯\n────────────\n  ? for shortcuts')).toBeNull()
  expect(teamWriteHold('codex', '›\n\n  100% context left')).toBeNull()
  expect(teamWriteHold('codex', 'Working (esc to interrupt)\n›\n  100% context left')).toBe('team_waiting_idle')
  expect(teamWriteHold('claude', 'session unavailable')).toBe('team_waiting_idle')
  expect(teamWriteHold('grok', null)).toBe('team_waiting_unavailable')
})

it('recognizes the native Codex placeholder above its configurable model and task footer', () => {
  const footer = '  gpt-6-astra low · /tmp/fixture · Await team introduction'
  expect(teamWriteHold('codex', `\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m\n\n${footer}`)).toBeNull()
  expect(teamWriteHold('codex', `›\n  a human draft\n${footer}`)).toBe('team_waiting_draft')
  expect(teamWriteHold('codex', `› Keep this draft\n${footer}`)).toBe('team_waiting_draft')
})

it('holds a delivery while Codex browses its transcript, where its Enter would rewind the conversation', () => {
  const browsing = '\u001b[2m› Ask Codex to do anything\u001b[0m\n\n\u001b[36mBrowsing transcript\u001b[0m · ↑↓/jk scroll · ←→/hl prompts · ↵ rewind · esc back'
  expect(teamWriteHold('codex', browsing)).toBe('team_waiting_user')
})

it('holds a delivery while Claude Code\'s Rewind menu is open, as someone at the pane rather than by luck', () => {
  // Read before as an idle prompt (`❯ (current)` is italic) held only by its `Esc to cancel`, or as a
  // draft: a person's own message went in, and its Enter closed the menu or confirmed a rewind.
  for (const screen of [CLAUDE_REWIND_LIST, CLAUDE_REWIND_CONFIRM, CLAUDE_REWIND_EMPTY]) expect(teamWriteHold('claude', screen)).toBe('team_waiting_user')
  // And Codex's scrollback browser, a pager over the whole pane, the same way as its fullscreen one.
  expect(teamWriteHold('codex', CODEX_BROWSING_SCROLLBACK)).toBe('team_waiting_user')
})
