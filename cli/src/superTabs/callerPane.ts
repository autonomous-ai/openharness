/**
 * The pane a `harness super-tab` (or `send`, `new`, `tell`, `close`) runs in, from its parent processes rather than from
 * what it says.
 *
 * Security review of #2087: a Buddy allowed to run `harness super-tab` could name a Builder with --agent and speak as it.
 * The CLI tells the daemon which harness asks, and that harness has to be the pane's own. TMUX_PANE alone is what the
 * command's environment says, which a command can set; so the pane is the one whose process is this command's nearest
 * ancestor, and a TMUX_PANE that names another pane is refused (the Lead's must on #904's plan).
 *
 * It fails closed (security review 2's late finding): a command that may run in a pane but cannot prove which one, with TMUX
 * pointing at a socket that does not exist, a fake tmux first on PATH, or a double fork with TMUX still set, went on as a
 * person's terminal. Now ps unreadable, a tmux server among its parents, or TMUX or TMUX_PANE set, with no pane proven, is a
 * refusal; ps and tmux are run from where the system keeps them, never from PATH. What it cannot see is a command that
 * detached itself from its pane on purpose and cleared TMUX and TMUX_PANE: it reads as a person's terminal (the PR names it).
 * Windows has no tmux to check against, and keeps TMUX_PANE as it was.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readlinkSync } from 'node:fs'
import { basename } from 'node:path'

export interface Process { pid: number; command: string }

export interface PaneProbe {
  /** This process and its parents, nearest first, each with its command, or null when ps cannot be read. */
  ancestors(): Process[] | null
  /** Every pane with the pid of the process it runs, from the tmux of [server], or null when tmux cannot be read. */
  panes(server: Process): Array<{ pane: string; pid: number }> | null
}

const NAMED_ANOTHER = 'This command names a pane it does not run in. Run it as your harness gave it, without setting TMUX_PANE.'
const UNPROVEN = 'Harness could not tell which pane this command runs in, so it did not run it. Run it as your harness gave it, in its own pane.'

/** A tmux server, as ps names it: `tmux` on macOS (it sets its own title), `tmux: server` on Linux. */
const isTmuxServer = (command: string): boolean => /^tmux(:|$)/.test(basename(command.split(' ')[0] ?? ''))

export function runningPane(env: NodeJS.ProcessEnv, probe: PaneProbe = processProbe(env), platform: NodeJS.Platform = process.platform): { pane?: string; refused?: string } {
  if (platform === 'win32') return env.TMUX_PANE ? { pane: env.TMUX_PANE } : {}
  const ancestors = probe.ancestors()
  if (!ancestors) return { refused: UNPROVEN }
  const server = ancestors.find(row => isTmuxServer(row.command))
  const byPid = new Map((server ? probe.panes(server) ?? [] : []).map(({ pane, pid }) => [pid, pane]))
  const pane = ancestors.map(row => byPid.get(row.pid)).find(Boolean)
  if (env.TMUX_PANE && pane && env.TMUX_PANE !== pane) return { refused: NAMED_ANOTHER }
  if (pane) return { pane }
  return server || env.TMUX || env.TMUX_PANE ? { refused: UNPROVEN } : {}
}

const read = (command: string, args: string[], env: NodeJS.ProcessEnv): string | null => {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], env }) } catch { return null }
}
const firstOf = (paths: string[]): string | undefined => paths.find(path => existsSync(path))

/** Where systems keep tmux: Homebrew on Apple silicon and Intel, then the system's own. Never PATH, which a command sets. */
const TMUX_PATHS = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux', '/bin/tmux', '/run/current-system/sw/bin/tmux']

/** tmux and ps as the system has them, with [env]'s tmux socket: steered elsewhere, that server's panes are not its parents. */
export const processProbe = (env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): PaneProbe => ({
  panes: server => {
    // Linux names the server's own executable; macOS gives no path for it.
    let binary: string | undefined
    if (platform === 'linux' && server.pid > 0) { try { binary = readlinkSync(`/proc/${server.pid}/exe`) } catch { /* below */ } }
    binary ??= firstOf(TMUX_PATHS)
    const out = binary ? read(binary, ['list-panes', '-a', '-F', '#{pane_id} #{pane_pid}'], env) : null
    if (out === null) return null
    return out.split('\n').map(line => line.trim().split(' ')).filter(([pane, pid]) => /^%\d+$/.test(pane ?? '') && /^\d+$/.test(pid ?? ''))
      .map(([pane, pid]) => ({ pane: pane!, pid: Number(pid) }))
  },
  ancestors: () => {
    const ps = firstOf(['/bin/ps', '/usr/bin/ps'])
    const out = ps ? read(ps, ['-A', '-o', 'pid=,ppid=,comm='], env) : null
    if (out === null) return null
    const rows = new Map<number, { ppid: number; command: string }>()
    for (const line of out.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      if (match) rows.set(Number(match[1]), { ppid: Number(match[2]), command: match[3]!.trim() })
    }
    if (!rows.has(process.pid)) return null
    const chain: Process[] = []
    for (let pid: number | undefined = process.pid; pid && pid > 0 && !chain.some(row => row.pid === pid); pid = rows.get(pid)?.ppid) {
      chain.push({ pid, command: rows.get(pid)?.command ?? '' })
    }
    return chain
  },
})
