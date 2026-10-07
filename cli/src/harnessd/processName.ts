/**
 * What the daemon's processes are called in Activity Monitor, `top` and `ps -c`.
 *
 * Those name a process after the FILE that was exec'd, not its `process.title`: every one of ours was
 * `node`. A symlink does not help either — the kernel takes the name of the file it resolves to (Claude
 * Code shows as `2.1.291`, its binary's file name). A hard link does: same inode, no extra disk, the same
 * code signature, and the name it was exec'd under. So each process is started through a hard link of
 * the managed node named after it (`harnessd`, `harnessd-core`, `harnessd-search`…).
 *
 * The links live in `<runtime>/node-…/libexec/harnessd/`, never in `bin/`: that folder is put on agent
 * panes' PATH (lib/engineLaunch.ts `npmRuntimePrelude`), where `harnessd-core` would be a command. Only a
 * node inside the managed runtime is linked — never a system, Homebrew or developer one, whose folder is
 * not ours to write in. Anything that goes wrong leaves the process running as `node`, as before: a name
 * is never worth a process that does not start.
 */
import { linkSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

export { baseNode } from './baseNode.js'

const LINK_DIR = join('libexec', 'harnessd')

export interface NamedNodeFs {
  realpath(path: string): string
  /** The file's identity, or null when it is not there. */
  identity(path: string): { dev: number; ino: number } | null
  mkdir(path: string): void
  link(existing: string, created: string): void
  rename(from: string, to: string): void
  unlink(path: string): void
}

export const nodeFs: NamedNodeFs = {
  realpath: realpathSync,
  identity: (path) => {
    const stat = statSync(path, { throwIfNoEntry: false })
    return stat ? { dev: stat.dev, ino: stat.ino } : null
  },
  mkdir: (path) => { mkdirSync(path, { recursive: true }) },
  link: linkSync,
  rename: renameSync,
  unlink: unlinkSync,
}

export interface NamedNodeOptions {
  fs?: NamedNodeFs
  platform?: NodeJS.Platform
  pid?: number
  /** Told once per name when the process has to run as plain `node`, and why. */
  log?: (line: string) => void
}

const reported = new Set<string>()

/** Tests only. */
export function resetNamedNodeReports(): void { reported.clear() }

/** [node] under the name [name] — a hard link of it, made or refreshed here — or [node] itself when it
 *  is not the managed runtime's, or the link cannot be made. */
export function namedNode(node: string, name: string, runtimeDir: string | undefined, options: NamedNodeOptions = {}): string {
  const fs = options.fs ?? nodeFs
  const fallBack = (why: string): string => {
    if (!reported.has(name)) {
      reported.add(name)
      options.log?.(`[harnessd] ${name} runs as ${basename(node)} (${why})`)
    }
    return node
  }
  if ((options.platform ?? process.platform) === 'win32') return node
  const inside = runtimeDir ? relative(runtimeDir, node) : ''
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return node
  const dir = join(dirname(dirname(node)), LINK_DIR)
  const link = join(dir, name)
  const temp = `${link}.${options.pid ?? process.pid}.tmp`
  try {
    // Found by QA on a quiet machine: a managed symlink to Homebrew Node passed the lexical check.
    // macOS hard-linked its target, and dyld aborted the relocated executable: libnode was left behind.
    // Resolve both paths so a symlinked runtime still works, but an external interpreter stays put.
    const resolved = relative(fs.realpath(runtimeDir!), fs.realpath(node))
    if (!resolved || resolved.startsWith('..') || isAbsolute(resolved)) return fallBack('node resolves outside the managed runtime')
    const target = fs.identity(node)
    if (!target) return fallBack('no node binary')
    const current = fs.identity(link)
    if (current && current.dev === target.dev && current.ino === target.ino) return link
    // A fresh name, renamed over the old one: two masters at once, or a link to a node since replaced,
    // never leave the name missing or pointing at the wrong binary.
    fs.mkdir(dir)
    try { fs.unlink(temp) } catch { /* not there */ }
    fs.link(node, temp)
    fs.rename(temp, link)
    return link
  } catch (error) {
    // A link made but not renamed would otherwise stay behind, one per failed start.
    try { fs.unlink(temp) } catch { /* never made */ }
    return fallBack(error instanceof Error ? error.message : String(error))
  }
}
