/**
 * The processes that still name a test's throwaway root once its daemon's process groups are ended, and ending them.
 *
 * Why: the census of 2026-11-14 found 14 fake `codex app-server` pairs and a fake `podman events` outliving the
 * end-to-end tests that started them. The product starts those children in a process group of their own
 * (lib/codexRateLimits.ts, services/agentBrowser/podman.ts), so ending the daemon's groups never reached them, and
 * their parent died before ending them. Every engine, `podman` and `gh` a daemon under test can start lives under its
 * root, a unique `mkdtemp` folder, so a command line that names `<root>/` is that test's and no one else's.
 *
 * A match that leads a process group is ended with its whole group: the fake engine renames its own title, so the
 * fake Codex's child (`node …/fakeEngine.mjs app-server`) never names the root and is reached only through its group.
 * Any other match is ended alone, never its group: a test's own `tmux -S <root>/…` call runs in the Vitest worker's
 * group, and signalling that group would end the test run.
 */
import { basename, isAbsolute } from 'node:path'
import { alive, processTable, type ProcessRow } from './spawnedRuns.js'

export interface RootProcesses {
  /** Process groups to signal whole, each led by a match. */
  groups: number[]
  /** Matches to signal alone. */
  pids: number[]
  /** Every pid those signals reach, once each, in the table's order. */
  all: number[]
}

/** What in [table] names [root], seen from the process [self]: itself, its parent and pid 1 are never matched. */
export function rootProcesses(root: string, table: ProcessRow[], self: number = process.pid): RootProcesses {
  // Only isolatedTmux's own folder, unique to its test. A wrong one (empty, `/`, a TMPDIR) would name other runs'
  // processes or every one on the machine, and their whole groups would be SIGKILLed.
  if (!isAbsolute(root) || !basename(root).startsWith('htmux-')) throw new Error(`not a test root (isolatedTmux's <tmp>/htmux-XXXXXX): ${root}`)
  const caller = table.find((row) => row.pid === self)
  const spared = new Set([self, caller?.ppid, 1])
  const matches = table.filter((row) => row.command.includes(`${root}/`) && !spared.has(row.pid))
  // A caller missing from the table leaves its own group unknown: then no group is signalled whole.
  const leads = (row: ProcessRow) => caller !== undefined && row.pid === row.pgid && row.pgid !== caller.pgid
  const groups = matches.filter(leads).map((row) => row.pgid)
  const pids = matches.filter((row) => !leads(row)).map((row) => row.pid)
  const all = table.filter((row) => pids.includes(row.pid) || groups.includes(row.pgid)).map((row) => row.pid)
  return { groups, pids, all }
}

/**
 * SIGKILL every process that names [root] and wait, at most [ms], until none of them is alive. Returns those still
 * alive, as `pid <n> <command>`; empty when none is.
 */
export async function endRootProcesses(root: string, ms = 5_000): Promise<string[]> {
  const table = processTable()
  const { groups, pids, all } = rootProcesses(root, table)
  for (const pgid of groups) { try { process.kill(-pgid, 'SIGKILL') } catch { /* the group is gone */ } }
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  // Waited for asynchronously: a child of this process stays a zombie, alive to a signal, until Node's event loop reaps it.
  const deadline = Date.now() + ms
  while (Date.now() < deadline && all.some((pid) => alive(pid))) await new Promise((resolve) => setTimeout(resolve, 50))
  return table.filter((row) => all.includes(row.pid) && alive(row.pid)).map((row) => `pid ${row.pid} ${row.command}`)
}
