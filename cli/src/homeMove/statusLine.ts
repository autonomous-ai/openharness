import { legacyHarnessHome } from '../config/harnessHome.js'
import type { Reason } from './conditions.js'
import type { MoveRecord } from './record.js'

// What is happening and what a person does, in plain words: the reason codes stay in the record and the log.
const CLOSE_AGENTS = `Harness's folders stay in ${legacyHarnessHome('~', 'linux')} until the agents close: close them, then run harness start.`
const SAYS: Record<Reason, string> = {
  'update-pending': 'Harness\'s folders move after this update settles.',
  'old-tmux': CLOSE_AGENTS,
  'pty-host': CLOSE_AGENTS,
  'target-exists': 'Moving Harness\'s folders failed: the new folders already exist; move them aside, then run harness start.',
  'no-space': 'Moving Harness\'s folders failed: free some disk space, then run harness start.',
  permission: 'Moving Harness\'s folders failed: Harness cannot write where they go; make those folders yours, then run harness start.',
  io: 'Moving Harness\'s folders failed: run harness start to try again.',
}

/** `harness status`'s one line for a move that is held, failed or skipped; null when there is nothing to do. */
export function moveStatusLine(record: MoveRecord | null): string | null {
  if (record?.state === 'skipped-override') return 'Harness\'s folders stay where a setting or a link keeps them.'
  if (record?.state !== 'waiting' && record?.state !== 'failed') return null
  return SAYS[record.reason ?? 'io']
}
