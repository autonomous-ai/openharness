import { describe, expect, it } from 'vitest'
import { codexStoppedGoal } from './codexTurnRecovery.js'

// The live footer from the interrupted cmd p session on M2. Its rollout ended
// with token_count and thread_settings_applied, never task_complete/turn_aborted.
const screen = [
  '■ Conversation interrupted - use /feedback if something went wrong',
  '  ↳ Recap: Previous work is saved.', '',
  '\x1b[1m\x1b[38;5;215m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m', '',
  '  \x1b[38;5;223mGPT-6-Astra max\x1b[39m · ~/work \x1b[38;5;5mGoal stalled (/goal resume)\x1b[39m',
  '  \x1b[1m?\x1b[0m for shortcuts                       ⚠ 1 warning · f2 to view',
].join('\n')
describe('Codex stopped-goal footer', () => {
  it('recognizes the live interrupted goal and its paused equivalent', () => {
    expect(codexStoppedGoal(screen)).toBe(true)
    expect(codexStoppedGoal(screen.replace('stalled', 'paused'))).toBe(true)
  })
  it.each([
    null, '', screen.replace('Goal stalled (/goal resume)', 'Goal active'),
    screen.replace('Goal stalled (/goal resume)', ''),
    screen.replace('\x1b[2mAsk Codex to do anything\x1b[0m', 'please continue'),
    screen + '\nSelect Model and Effort',
    screen.replace('■ Conversation interrupted', '• Working (1h · esc to interrupt)\n■ Conversation interrupted'),
    'Goal stalled (/goal resume)\n› \x1b[2mAsk Codex to do anything\x1b[0m\n? for shortcuts',
    screen.replace('?\x1b[0m for shortcuts', '?\x1b[0m something else'),
  ])('does not treat active, unknown, historical or draft UI as stopped', value => {
    expect(codexStoppedGoal(value)).toBe(false)
  })
})
