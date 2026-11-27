import { spawnSync } from 'node:child_process'
import { HARNESS_OWNER_OPTION, paneOwnerFormat, paneOwnerOf } from '../lib/harnessSessionLabel.js'
import type { Done } from './journal.js'

/** Harness's panes on the default tmux server, as the move reads and retags them. */
export interface Tmux {
  /** `tmux -V`, null with no tmux. */
  version(): string | null
  /** Every tagged pane's tag, read from its pane option, or before tmux 3.0 from its start command. */
  tags(paneOptions: boolean): string[]
  /** Gives every pane tagged [from] the tag [to], each in [journal] before it is set; returns their ids. */
  retag(from: string, to: string, journal: { add(done: Done): void }): string[]
  /** Sets the tag of each of [ids] to [to], as a rollback does. */
  tag(ids: readonly string[], to: string): void
}

type Run = (args: string[]) => { status: number | null; stdout: string }

const CALL_LIMIT_MS = 5_000

/** tmux on its default server, where the daemon makes its panes: a start typed in a pane of another server names that
 *  one in TMUX, which the daemon never inherits (lib/startEnvironment.ts). */
function onDefaultServer(args: string[]): { status: number | null; stdout: string } {
  const env = { ...process.env }
  delete env.TMUX
  delete env.TMUX_PANE
  return spawnSync('tmux', args, { encoding: 'utf8', env, timeout: CALL_LIMIT_MS })
}

export function defaultTmux(run: Run = onDefaultServer): Tmux {
  // A tmux that is missing, or has no server, lists no panes.
  const lines = (args: string[]): string[] => {
    const { status, stdout } = run(args)
    return status === 0 ? stdout.split('\n').filter(Boolean) : []
  }
  const setTag = (id: string, to: string): boolean => run(['set-option', '-p', '-t', id, HARNESS_OWNER_OPTION, to]).status === 0
  const version = (): string | null => {
    const { status, stdout } = run(['-V'])
    return status === 0 ? stdout.trim() : null
  }
  return {
    version,
    tags: (paneOptions) => lines(['list-panes', '-a', '-F', paneOwnerFormat(paneOptions)]).map(paneOwnerOf),
    retag(from, to, journal) {
      // Before 3.0 a pane has no options, and the move waits while one carries the tag in its start command
      // (conditions.ts): what lists the tag there is a window's, which `set-option -p` cannot reach.
      if (!hasPaneOptions(version())) return []
      const listing = (): [id: string, tag: string][] => lines(['list-panes', '-a', '-F', `#{pane_id}|${paneOwnerFormat(true)}`])
        .map((line) => [line.slice(0, line.indexOf('|')), line.slice(line.indexOf('|') + 1)])
      const ids: string[] = []
      for (const [id, tag] of listing()) {
        if (tag !== from) continue
        // In the journal first: a crash between the two leaves a pane the rollback sets back, never one it does not know.
        journal.add({ did: 'pane', id })
        if (!setTag(id, to)) {
          // A pane that closed since the listing runs nothing that could use an old path.
          if (!listing().some(([listed]) => listed === id)) continue
          throw new Error(`tmux could not retag pane ${id}`)
        }
        ids.push(id)
      }
      return ids
    },
    tag(ids, to) {
      // A pane closed since has no tag to put back, and does not stop the others.
      for (const id of ids) setTag(id, to)
    },
  }
}

/**
 * Whether [version] has pane options (tmux 3.0). A version it cannot read is new, as lib/tmuxVersion.ts reads it: the
 * move does not load that file, which reaches beyond the move's imports, and the spec holds the two to one answer.
 */
export function hasPaneOptions(version: string | null): boolean {
  const major = /(\d+)\.\d+/.exec(version ?? '')?.[1]
  return major === undefined || Number(major) >= 3
}
