import { describe, expect, it } from 'vitest'
import { feedbackDismissKeys } from './screen.js'

// Nova's pane in the Swarm autonomous-harness, 2026-10-29 (Claude Code 2.1): the drafted bug report covered its prompt and
// every message to it came back undelivered.
const DRAFT = [
  '✻ Baked for 4m 54s · done 4:43 PM',
  '╭──────────────────────────────────────────────────────────────────────────────╮',
  '│ ✻ Bug report drafted: Lead switched Codex model via /model in a worker term… │',
  '│ │ - What happened: As Swarm Lead, I typed /model into a Codex Builder\'s      │',
  '│ │ terminal on a Harness Team account and picked GPT-6-Astra, then GPT-5.5,   │',
  '│ │ to get past…                                                               │',
  '│ 1 to review · 2 to send · 0 to dismiss                                       │',
  '╰──────────────────────────────────────────────────────────────────────────────╯',
  '────────────────────────────────────────────────────────────────────────────────',
  '❯ ',
].join('\n')
const TURN_OFF = [
  'Turn off Claude-drafted feedback? 0 to turn off · Esc to keep',
  '────────────────────────────────────────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · gh auth login for PR status',
].join('\n')
const SURVEY = [
  '● How is Claude doing this session? (optional)',
  '  1: Bad    2: Fine   3: Good   0: Dismiss',
  '────────────────────────────────────────────────────────────────────────────────',
  '❯ ',
].join('\n')

describe('dismissing Claude Code\'s feedback popups for a Swarm agent', () => {
  it('dismisses a drafted bug report with 0, which sends nothing', () => {
    expect(feedbackDismissKeys(DRAFT)).toEqual(['0'])
  })

  it('keeps the person\'s feedback setting with Esc, never 0 (which turns it off)', () => {
    expect(feedbackDismissKeys(TURN_OFF)).toEqual(['Escape'])
  })

  it('dismisses the session survey with 0, giving no rating', () => {
    expect(feedbackDismissKeys(SURVEY)).toEqual(['0'])
  })

  it.each([
    ['an idle prompt', '────\n❯ \n────'],
    ['a draft whose footer reads otherwise', DRAFT.replace('0 to dismiss', '0 to send')],
    ['a draft without its footer', DRAFT.replace(/│ 1 to review.*\n/, '')],
    ['a turn-off question that reads otherwise', TURN_OFF.replace('Esc to keep', 'Esc to turn off')],
    ['a survey without Dismiss', SURVEY.replace('0: Dismiss', '0: Good')],
    ['two popups at once', `${DRAFT}\n${SURVEY}`],
    ['the draft twice', `${DRAFT}\n${DRAFT}`],
  ])('sends nothing for %s', (_name, capture) => {
    expect(feedbackDismissKeys(capture)).toBeNull()
  })
})
