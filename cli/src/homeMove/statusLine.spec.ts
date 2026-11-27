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
      // A PTY host holds Harness's terminals: they are closed too.
      'Harness\'s folders stay in ~/.harness until its agents and terminals close: close them, then run harness start.',
      'Harness\'s folders stay in ~/.harness until its agents and terminals close: close them, then run harness start.',
      // The folders by their default names, whatever a setting named: a person finds them by those.
      'Moving Harness\'s folders failed: ~/.local/share/harness or ~/.local/state/harness already exists; move it aside, then run harness start.',
      'Moving Harness\'s folders failed: free some disk space, then run harness start.',
      'Moving Harness\'s folders failed: Harness cannot write ~/.local/share/harness or ~/.local/state/harness; make the folders they are in yours, then run harness start.',
      'Moving Harness\'s folders failed: run harness start to try again.',
      'Harness\'s folders stay where a setting or a link keeps them.',
    ])
    // ~/.harness and the two folders it moves to are the paths a line may name, and no internal code shows.
    const named = (line: string | null) => ['~/.harness', '~/.local/share/harness', '~/.local/state/harness'].reduce((rest, path) => rest?.replaceAll(path, '') ?? null, line)
    for (const line of lines) expect(named(line)).not.toMatch(/[\n/]|-(override|pending|tmux|host|exists|space)|\bio\b/)
  })
})
