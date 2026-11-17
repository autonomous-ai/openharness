/**
 * The PATH of everything an end-to-end test starts: a daemon under test, a tmux server a test starts, the shells in
 * their panes. A list of links, never a folder: one folder of the worker's PATH is every program in it. The audit of
 * 2026-11-15 found the developer's PATH folders (~/.opencode/bin, ~/.local/bin, /usr/local/bin and more) holding their
 * real engines, which the daemon and a tile found by name, and the PM's census found 5 `opencode` and 4 `cursor-agent`
 * among the processes tests left behind (docs/plans/2026-11-15-e2e-isolation-2-design.md). So each tool a test or a
 * daemon under test runs by name is linked, one by one, in <root>/tools; the rest is the system's folders, which hold
 * ps, lsof, sh, env, sleep and the rest, and no engine, on macOS and on CI's Linux. Every other engine is then not
 * installed, as on CI.
 *
 * POSIX only: its callers need tmux, which Windows has not.
 */
import { mkdirSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveBinaryOnPath } from '../lib/binaryOnPath.js'

/** The commands a test or a daemon under test runs by name and the system's folders may not have. Never an engine. */
export const TEST_TOOLS: readonly string[] = [
  // Never a lookup: `#!/usr/bin/env node` scripts run it by name (a Store harness's init.mjs, an MCP server a test
  // writes), and so does `harness shell-launch` in a pane. The run's copy (testNode.ts), so that what they start finds
  // no engine and no `npm` beside its Node (audit of 2026-11-16, docs/plans/2026-11-16-e2e-isolation-3-design.md); the
  // Node running the tests where no run made one (the unit specs that use isolatedTmux).
  'node',
  // The daemon's terminal backend and the tests' own servers. Homebrew's on macOS; with none on PATH the daemon puts
  // the folder its login shell finds one in ahead of the rest (lib/tmuxOnPath.ts), /usr/local/bin on a Mac.
  'tmux',
  // Workspaces, the Store, worktrees, the tests' own repositories.
  'git',
  // The tiles' shell.
  'zsh',
  // The shells the tiles of shells.e2e.ts, restoreInput.e2e.ts, suspend.e2e.ts and eagerHooks.e2e.ts run; a machine
  // may lack tcsh or dash.
  'bash', 'tcsh', 'dash',
  // The agent browser files (Homebrew's on macOS).
  'podman',
]

/** Where every machine keeps ps, lsof, sh, env, sleep and the rest, and no engine. */
export const SYSTEM_FOLDERS: readonly string[] = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

let found: ReadonlyMap<string, string> | undefined

/** Each tool [worker]'s PATH has, with its absolute file; `node` is the run's Node named in [worker]'s E2E_NODE_PATH,
 *  or the Node running the tests where none is. The link to it stays a symbolic link: it runs the copy, and the copy
 *  is the path Node names itself by. With no argument: this worker's own, found once and kept. */
export function workerTools(worker?: NodeJS.ProcessEnv): ReadonlyMap<string, string> {
  if (!worker) return found ??= workerTools(process.env)
  const tools = new Map<string, string>()
  for (const name of TEST_TOOLS) {
    // A relative PATH entry names a file from the worker's folder; as a link's target it would be read from <root>/tools.
    const file = name === 'node' ? worker.E2E_NODE_PATH || process.execPath : resolveBinaryOnPath(name, worker)
    if (file) tools.set(name, resolve(file))
  }
  return tools
}

/** Makes `<root>/tools`, a link for each of [tools], and returns `<root>/tools:/usr/bin:/bin:/usr/sbin:/sbin`. Once for
 *  each root: isolatedTmux makes it, and a daemon beside another takes the PATH from that tmux's environment. */
export function testPath(root: string, tools: ReadonlyMap<string, string> = workerTools()): string {
  const folder = join(root, 'tools')
  mkdirSync(folder)
  for (const [name, file] of tools) symlinkSync(file, join(folder, name))
  return [folder, ...SYSTEM_FOLDERS].join(':')
}
