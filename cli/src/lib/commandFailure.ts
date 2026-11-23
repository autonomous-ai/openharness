/**
 * How a command fails, in a file of its own that only the commands import (cli.ts): what it prints is the terminal of
 * the person who ran one, never a daemon's log, which Export logs sends (architecture.failureLogs.spec.ts `TERMINAL`).
 */

import { exitSaying } from './daemonState.js'

/** Say why, whole, let go of the pid file if it is this process's, and exit. A daemon's start fails through
 *  daemonState.ts [failForegroundStart]. */
export const onError = (err: unknown, code = 1): never =>
  exitSaying(err, code, () => console.error('Failed to start adapter:', err))
