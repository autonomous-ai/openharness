import { expect, it } from 'vitest'
import { teamWriteHold } from './preflight.js'

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
