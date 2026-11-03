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
 * refusal; ps and tmux are run from where the system (or Harness's own runtime) keeps them, never from PATH. What it cannot see is a command that
 * detached itself from its pane on purpose and cleared TMUX and TMUX_PANE: it reads as a person's terminal (the PR names it).
 * Windows has no tmux to check against, and keeps TMUX_PANE as it was.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readlinkSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename, join } from 'node:path'
import { managedTmuxPath, tmuxInstallDirectories } from '../lib/tmuxOnPath.js'

export interface Process { pid: number; command: string }

export interface PaneProbe {
  /** This process and its parents, nearest first, each with its command, or null when ps cannot be read. */
  ancestors(): Process[] | null
  /** Every pane with the pid of the process it runs, from the tmux of [server], or null when tmux cannot be read. */
  panes(server: Process): Array<{ pane: string; pid: number }> | null
}

const NAMED_ANOTHER = 'This command names a pane it does not run in. Run it as your harness gave it, without setting TMUX_PANE.'
export const NOT_IN_PANE = 'This command does not run in the Harness pane it names, so it did not run. Run it as your harness gave it, in its own pane.'
const UNPROVEN = 'Harness could not tell which pane this command runs in, so it did not run it. Run it as your harness gave it, in its own pane.'

/** A tmux server, as ps names it: `tmux` on macOS (it sets its own title), `tmux: server` on Linux. */
const isTmuxServer = (command: string): boolean => /^tmux(:|$)/.test(basename(command.split(' ')[0] ?? ''))

/** The pane, and this command's parents' pids to hold its harness to (`inDaemonPane`); Windows, with no check, gives none. */
export function runningPane(env: NodeJS.ProcessEnv, probe: PaneProbe = processProbe(env), platform: NodeJS.Platform = process.platform): { pane?: string; refused?: string; ancestors?: number[] } {
  if (platform === 'win32') return env.TMUX_PANE ? { pane: env.TMUX_PANE } : {}
  const ancestors = probe.ancestors()
  if (!ancestors) return { refused: UNPROVEN }
  const server = ancestors.find(row => isTmuxServer(row.command))
  const byPid = new Map((server ? probe.panes(server) ?? [] : []).map(({ pane, pid }) => [pid, pane]))
  const pane = ancestors.map(row => byPid.get(row.pid)).find(Boolean)
  if (env.TMUX_PANE && pane && env.TMUX_PANE !== pane) return { refused: NAMED_ANOTHER }
  if (pane) return { pane, ancestors: ancestors.map(row => row.pid) }
  return server || env.TMUX || env.TMUX_PANE ? { refused: UNPROVEN } : {}
}

/**
 * Whether the Harness daemon's own pane of [harnessId] is among this command's parents. Pane ids restart in every tmux
 * server, so a private server counted up to a Builder's pane id and its command was taken for that Builder (re-check 2 of
 * #2093); the daemon reads the pane's process from its own server (`terminal_info`, core/terminals/requests.ts). With no
 * parents to hold it to (Windows, or a pane a caller already established), there is nothing to check.
 */
export async function inDaemonPane(daemon: { request: (type: string, payload?: Record<string, unknown>, ms?: number) => Promise<Record<string, unknown>> },
  harnessId: string, ancestors: number[] | undefined): Promise<boolean> {
  if (!ancestors) return true
  const info = await daemon.request('terminal_info', { agentId: harnessId }, 10_000).catch((): Record<string, unknown> => ({}))
  return typeof info.pid === 'number' && ancestors.includes(info.pid)
}

const read = (command: string, args: string[], env: NodeJS.ProcessEnv): string | null => {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], env }) } catch { return null }
}
const firstOf = (paths: string[]): string | undefined => paths.find(path => existsSync(path))

/** Where systems keep tmux beyond the folders Harness installs to: MacPorts, the system's own, and NixOS's. */
const SYSTEM_TMUX = ['/usr/local/bin/tmux', '/opt/local/bin/tmux', '/usr/bin/tmux', '/bin/tmux', '/run/current-system/sw/bin/tmux']

/** The system's tmux in order: the folders Harness installs to and already trusts (lib/tmuxOnPath.ts, ~/.local/bin and
 *  Homebrew's), then [SYSTEM_TMUX]. Never PATH, which a command sets; [home] is this account's, from the user database. */
export function systemTmuxPaths(platform: NodeJS.Platform, home: string): string[] {
  return [...new Set([...tmuxInstallDirectories({ HOME: home }, platform).map(dir => join(dir, 'tmux')), ...SYSTEM_TMUX])]
}

/** This account's home, from the user database rather than HOME, which a command sets. */
const accountHome = (): string => userInfo().homedir

/**
 * tmux and ps as the system has them, with [env]'s tmux socket: steered elsewhere, that server's panes are not its parents.
 * tmux is the one the daemon runs (lib/tmuxOnPath.ts): Linux names the server's own executable; otherwise Harness's own
 * build, which install.sh lays down on a Mac without Homebrew's and in Team accounts (re-check 1 of #2093: missing it there
 * refused every agent's Swarm command), and only then where systems keep it. A tmux of another version cannot read the
 * daemon's server, so the daemon's own comes first.
 */
export const processProbe = (env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
  options: { runtimeDir?: string; systemTmux?: string[] } = {}): PaneProbe => ({
  panes: server => {
    let binary: string | undefined
    if (platform === 'linux' && server.pid > 0) { try { binary = readlinkSync(`/proc/${server.pid}/exe`) } catch { /* below */ } }
    binary ??= managedTmuxPath(options.runtimeDir ?? join(accountHome(), '.harness', 'runtime'))
      ?? firstOf(options.systemTmux ?? systemTmuxPaths(platform, accountHome()))
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
