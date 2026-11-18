/** The optional browser shim's stable location and launch prelude; no filesystem effects. */
import { join } from 'node:path'
import { env } from '../config/env.js'
import { shellSingleQuote } from './shellQuote.js'

/** Where the daemon writes the script: beside its data, which outlives a restart of either. */
export function browserShimPath(dataDir: string = env.ADAPTER_DATA_DIR): string {
  return join(dataDir, 'bin', 'harness-browser')
}

/**
 * The lines a pane's launch script runs: `BROWSER` is the script, when it is there, and the person's own is kept
 * for it to fall back on. A pane started before the daemon ever wrote it keeps its browser.
 */
export function browserPrelude(path: string = browserShimPath()): string {
  const quoted = shellSingleQuote(path)
  return `if [ -x ${quoted} ]; then if [ "\${BROWSER:-}" != ${quoted} ]; then HARNESS_PREVIOUS_BROWSER="\${BROWSER:-}"; export HARNESS_PREVIOUS_BROWSER; fi; BROWSER=${quoted}; export BROWSER; fi\n`
}
