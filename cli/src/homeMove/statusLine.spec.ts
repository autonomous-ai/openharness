import { describe, expect, it } from 'vitest'
import type { MoveRecord } from './record.js'
import { moveStatusLine } from './statusLine.js'

const record = (state: MoveRecord['state'], reason?: MoveRecord['reason']): MoveRecord =>
  ({ version: 1, state, reason, entries: 0, bytesCopied: 0, panes: 0, oldProcesses: 0, at: 1_763_400_000_000 })

describe('moveStatusLine', () => {
  it('says nothing with no record, and nothing once moved', () => {
    expect(moveStatusLine(null)).toBeNull()
    expect(moveStatusLine(record('moved'))).toBeNull()
    expect(moveStatusLine(record('bridged'))).toBeNull()
  })

  it('says what to do for a held, failed or skipped move, in one plain line with no path and no code', () => {
    const lines = [
      moveStatusLine(record('waiting', 'update-pending')),
      moveStatusLine(record('waiting', 'old-tmux')),
      moveStatusLine(record('waiting', 'pty-host')),
      moveStatusLine(record('failed', 'target-exists')),
      moveStatusLine(record('failed', 'no-space')),
      moveStatusLine(record('failed', 'permission')),
      moveStatusLine(record('failed', 'io')),
      moveStatusLine(record('skipped-override')),
    ]
    expect(lines).toEqual([
      'Harness\'s folders move after this update settles.',
      'Harness\'s folders stay in ~/.harness until the agents close: close them, then run harness start.',
      'Harness\'s folders stay in ~/.harness until the agents close: close them, then run harness start.',
      'Moving Harness\'s folders failed: the new folders already exist; move them aside, then run harness start.',
      'Moving Harness\'s folders failed: free some disk space, then run harness start.',
      'Moving Harness\'s folders failed: Harness cannot write where they go; make those folders yours, then run harness start.',
      'Moving Harness\'s folders failed: run harness start to try again.',
      'Harness\'s folders stay where a setting or a link keeps them.',
    ])
    // ~/.harness is the one path a line may name, and no internal code shows.
    for (const line of lines) expect(line?.replaceAll('~/.harness', '')).not.toMatch(/[\n/]|-(override|pending|tmux|host|exists|space)|\bio\b/)
  })
})
