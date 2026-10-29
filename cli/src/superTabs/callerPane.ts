/**
 * The pane a `harness super-tab` runs in, from its parent processes rather than from what it says.
 *
 * Security review of #2087: a Buddy allowed to run `harness super-tab` could name a Builder with --agent and speak as it.
 * The CLI now tells the daemon which harness asks, and that harness has to be the pane's own. TMUX_PANE alone is what the
 * command's environment says, which a command can set; so the pane is the one whose process is this command's nearest
 * ancestor, and a TMUX_PANE that names another pane is refused (the Lead's must on #904's plan). Windows has no tmux to
 * check against, and keeps TMUX_PANE as it was.
 */
import { execFileSync } from 'node:child_process'

export interface PaneProbe {
  /** Every tmux pane with the pid of the process it runs, or null when tmux cannot be read. */
  panes(): Array<{ pane: string; pid: number }> | null
  /** This process and its parents, nearest first, or null when they cannot be read. */
  ancestors(): number[] | null
}

const NAMED_ANOTHER = 'This command names a pane it does not run in. Run it as your harness gave it, without setting TMUX_PANE.'

export function runningPane(env: NodeJS.ProcessEnv, probe: PaneProbe = realProbe, platform: NodeJS.Platform = process.platform): { pane?: string; refused?: string } {
  if (platform === 'win32') return env.TMUX_PANE ? { pane: env.TMUX_PANE } : {}
  const panes = probe.panes(), ancestors = probe.ancestors()
  const byPid = new Map((panes ?? []).map(({ pane, pid }) => [pid, pane]))
  const pane = (ancestors ?? []).map(pid => byPid.get(pid)).find(Boolean)
  // Nothing to check a named pane against is no proof of it either.
  if (env.TMUX_PANE && env.TMUX_PANE !== pane) return { refused: NAMED_ANOTHER }
  return pane ? { pane } : {}
}

const read = (command: string, args: string[]): string | null => {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return null }
}

const realProbe: PaneProbe = {
  panes: () => {
    const out = read('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_pid}'])
    if (out === null) return null
    return out.split('\n').map(line => line.trim().split(' ')).filter(([pane, pid]) => /^%\d+$/.test(pane ?? '') && /^\d+$/.test(pid ?? ''))
      .map(([pane, pid]) => ({ pane: pane!, pid: Number(pid) }))
  },
  ancestors: () => {
    const out = read('ps', ['-A', '-o', 'pid=,ppid='])
    if (out === null) return null
    const parents = new Map(out.split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(([pid, ppid]) => pid! > 0 && ppid! >= 0)
      .map(([pid, ppid]) => [pid!, ppid!]))
    const chain: number[] = []
    for (let pid: number | undefined = process.pid; pid && pid > 0 && !chain.includes(pid); pid = parents.get(pid)) chain.push(pid)
    return chain
  },
}
