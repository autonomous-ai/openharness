/**
 * `harness open-url <url>`: what a pane's BROWSER script runs first (lib/browserShim.ts). It asks the daemon that
 * owns the pane whether a phone takes the page (core/terminals/browser.ts). Exit 0: it did. Anything else, from
 * any failure: the script opens the page on this computer instead. Prints nothing; not for people.
 */
import { openDaemon, whereFor, type Daemon, type Where } from './daemon.js'
import { sendPane } from '../messages/command.js'

export interface OpenUrlDeps {
  pane?: string | undefined
  env?: NodeJS.ProcessEnv
  where?: (pane: string) => Where
  open?: (where: Where) => Promise<Daemon>
}

/** How long a pane's program waits for the answer before its page opens here. */
const ASK_MS = 5_000

export async function openUrlCommand(args: string[], deps: OpenUrlDeps = {}): Promise<number> {
  const url = args[0]
  const pane = 'pane' in deps ? deps.pane : sendPane(deps.env ?? process.env)
  if (!url || !pane) return 1
  const where = (deps.where ?? whereFor)(pane)
  // A pane no Harness daemon made: nobody to ask.
  if (!where.harnessPane) return 1
  let daemon: Daemon
  try { daemon = await (deps.open ?? openDaemon)(where) } catch { return 1 }
  try {
    const answer = await daemon.request('browser_open', { pane, url }, ASK_MS)
    return answer.handled === true ? 0 : 1
  } catch {
    return 1
  } finally {
    daemon.close()
  }
}
