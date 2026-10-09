/** Muse's native identity facts. A task start is bookkeeping; a run with an empty prompt is real. */
import type { RunIdentity } from '../kit/sessionIdentity.js'

export const MUSE_IDENTITY: RunIdentity = {
  bytes: [64 * 1024, 4 * 1024 * 1024],
  cwd: ['payload', 'record', 'workspace_root'],
  run: [{ field: ['payload', 'kind'], value: 'run' }, { field: ['payload', 'event', 'kind'], value: 'started' }],
}
