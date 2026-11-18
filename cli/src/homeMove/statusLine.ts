import type { Reason } from './conditions.js'
import type { MoveRecord } from './record.js'

// What a person does for each reason. A failed move left ~/.harness whole, so trying again is always safe.
const TO_DO: Record<Reason, string> = {
  'update-pending': 'it moves at the start after this update settles',
  'old-tmux': 'close the agents, then harness start',
  'pty-host': 'close the agents, then harness start',
  'target-exists': 'move the XDG harness folders aside, then harness start',
  'no-space': 'free some disk space, then harness start',
  permission: 'make the XDG folders yours, then harness start',
  io: 'harness start tries again',
}

/** `harness status`'s one line for a move that is held, failed or skipped; null when there is nothing to do. */
export function moveStatusLine(record: MoveRecord | null): string | null {
  if (record?.state === 'skipped-override') return 'home move: skipped-override · a setting or a link keeps Harness\'s folder where it is'
  if (record?.state !== 'waiting' && record?.state !== 'failed') return null
  const reason = record.reason ?? 'io'
  return `home move: ${record.state} ${reason} · ${TO_DO[reason]}`
}
