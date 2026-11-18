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

  it('says what to do for a held, failed or skipped move, in one line with no path', () => {
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
      'home move: waiting update-pending · it moves at the start after this update settles',
      'home move: waiting old-tmux · close the agents, then harness start',
      'home move: waiting pty-host · close the agents, then harness start',
      'home move: failed target-exists · move the XDG harness folders aside, then harness start',
      'home move: failed no-space · free some disk space, then harness start',
      'home move: failed permission · make the XDG folders yours, then harness start',
      'home move: failed io · harness start tries again',
      'home move: skipped-override · a setting or a link keeps Harness\'s folder where it is',
    ])
    for (const line of lines) expect(line).not.toMatch(/[\n/]/)
  })
})
