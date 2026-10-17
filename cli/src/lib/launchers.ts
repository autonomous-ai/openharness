/**
 * The `harness` and `hn` launchers in the bin folder: repointing `harness` at the runtime it should run on,
 * and adding `hn` beside it on a machine installed before hn shipped.
 *
 * Its own module so the hn updater, which the core runs, can repair `hn` without loading the managed
 * runtimes' installer (runtimeInstall.ts), whose grid half is the models service's.
 */
import { accessSync, constants, linkSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { env } from '../config/env.js'

/** The trailing `exec …` line, which is the only line any launcher we ship varies. */
const EXEC_LINE = /^exec .*$/m

/**
 * Repoints the `harness` launcher at [node].
 *
 * Three launcher shapes have shipped — the public installer's two-liner, `install-cli.sh`'s, and its
 * `--no-updates` variant carrying a comment block and `ADAPTER_UPDATE_DISABLE=true`. All three end in
 * a single `exec … cli.js "$@"` line with everything else preamble, so replacing ONLY that line
 * handles all three and preserves a developer's pin for free: the interpreter is repaired, and the
 * promise that no release reaches that computer on its own is untouched.
 */
export function ensureLauncher(node: string, log: (message: string) => void = () => {}): void {
  try {
    const launcher = join(env.HARNESS_BIN_DIR, 'harness')
    const current = readFileSync(launcher, 'utf-8')
    const cli = join(env.ADAPTER_CLI_DIR, 'cli.js')
    const exec = EXEC_LINE.exec(current)
    // Only ever rewrite a launcher that runs OUR bundle. Anything else at this path belongs to
    // somebody else, and a missing launcher means the CLI is being run some other way — writing one
    // nobody asked for is a different feature.
    if (!exec || !exec[0].includes(cli)) return

    const next = current.replace(EXEC_LINE, `exec ${shellQuote(node)} ${shellQuote(cli)} "$@"`)
    if (next === current) return

    const temporary = `${launcher}.tmp-${process.pid}`
    writeFileSync(temporary, next, { mode: 0o755 })
    renameSync(temporary, launcher)
    log(`  ✓ repointed ${launcher} at ${node}`)
  } catch {
    // A read-only bin dir, a launcher owned by another user — none of it is worth failing a start.
  }
}

/**
 * Add the short terminal command to an existing installation. Self-update replaces only the JS
 * bundles, so machines installed before hn shipped never re-run the installer's launcher step.
 * Run this on entry to the installed bundle, including daemon handoffs and an already-current
 * `harness update`. A checkout or update canary must never change the real installation.
 *
 * Delegate through the existing harness launcher so runtime repairs and --no-updates pins apply
 * equally to hn. Publish the complete script without replacing any existing file or symlink.
 */
export function ensureHnLauncher(scriptPath: string): boolean {
  let temporary: string | undefined
  try {
    const cli = join(env.ADAPTER_CLI_DIR, 'cli.js')
    if (realpathSync(scriptPath) !== realpathSync(cli)) return false
    const hn = join(env.HARNESS_BIN_DIR, 'hn')
    try { lstatSync(hn); return false } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
    }
    const launcher = join(env.HARNESS_BIN_DIR, 'harness')
    accessSync(launcher, constants.X_OK)
    const exec = EXEC_LINE.exec(readFileSync(launcher, 'utf8'))
    if (!exec || !(exec[0].includes(cli) || exec[0].includes(shellQuote(cli)))) return false

    temporary = mkdtempSync(join(env.HARNESS_BIN_DIR, '.hn-'))
    const staged = join(temporary, 'hn')
    writeFileSync(staged, `#!/bin/sh\nexec ${shellQuote(launcher)} tui "$@"\n`, { mode: 0o755 })
    // link, unlike rename, fails if another process or the user has already created hn.
    linkSync(staged, hn)
    return true
  } catch {
    // A read-only bin dir or a racing install must not prevent the CLI or daemon from running.
    return false
  } finally {
    if (temporary) { try { rmSync(temporary, { recursive: true, force: true }) } catch { /* best effort */ } }
  }
}

/** Lines a shipped `harness` launcher may carry before its exec: the shebang, comments, blanks, and the
 *  `--no-updates` pin. */
const LAUNCHER_PREAMBLE = /^(#.*|ADAPTER_UPDATE_DISABLE=true(; export ADAPTER_UPDATE_DISABLE)?|export ADAPTER_UPDATE_DISABLE|\s*)$/

/** A node word as the installers write it: bare `node` (the first dev installer), single-quoted, or double-quoted
 *  with nothing the shell would expand. */
const NODE_WORD = `(?:node|'(?:[^']|'\\\\'')*'|"[^"$\`\\\\]*")`
const CLI_WORD = `('(?:[^']|'\\\\'')*'|"[^"]*")`

/** Whether [content] is a launcher that runs a node on exactly [cliJs] (quoted as install.sh or install-cli.sh
 *  write it), then [extra] if given, then passes the arguments through. Only the shipped preamble may come before
 *  the exec, and nothing after it. Anything else, a different bundle, a longer path or extra lines, is somebody's. */
function runsBundle(content: string, cliJs: string, extra?: string): boolean {
  const lines = content.replace(/\n$/, '').split('\n')
  const exec = lines.pop() ?? ''
  if (!lines.every((line) => LAUNCHER_PREAMBLE.test(line))) return false
  const tail = extra ? ` ${extra}` : ''
  const matched = new RegExp(`^exec ${NODE_WORD} ${CLI_WORD}${tail} "\\$@"$`).exec(exec)
  return !!matched && (matched[1] === shellQuote(cliJs) || (matched[1] === `"${cliJs}"` && !/["$`\\]/.test(cliJs)))
}

/** Whether [content] is a `harness` launcher of ours. */
export function isOwnHarnessLauncher(content: string, cliJs: string): boolean {
  return runsBundle(content, cliJs)
}

/** Whether [content] is the `hn` that the installer or ensureHnLauncher wrote, which hands everything to [launcher]. */
export function isOwnHnLauncher(content: string, launcher: string): boolean {
  return content === `#!/bin/sh\nexec ${shellQuote(launcher)} tui "$@"\n`
}

/**
 * The entries of the bin folder that are Harness's, for `harness uninstall`: the `harness` launcher that runs this
 * install's bundle, the `hn` that hands to it, and the `tmux` link install.sh points at the managed tmux under [root].
 * Anything else there, a `harness` or `hn` somebody else wrote included, is not ours to remove: the folder is shared
 * with Claude Code's installer, uv, pipx and the person's own scripts. The `hn` of releases #365 to #500 ran the
 * bundle directly (`exec <node> <cli.js> tui "$@"`); that form is ours too.
 *
 * The path checks are lexical: pass [binDir] and [root] in the unresolved form the installer used (`$HOME/.harness`,
 * not a realpath). Callers must unlink these entries, never follow them.
 */
export function ownedBinEntries(binDir: string, cliJs: string, root: string): string[] {
  const owned: string[] = []
  const regular = (path: string): string | null => {
    try { return lstatSync(path).isFile() ? readFileSync(path, 'utf8') : null } catch { return null }
  }
  const launcher = join(binDir, 'harness')
  const harness = regular(launcher)
  if (harness !== null && isOwnHarnessLauncher(harness, cliJs)) owned.push(launcher)
  const hn = regular(join(binDir, 'hn'))
  if (hn !== null && (isOwnHnLauncher(hn, launcher) || runsBundle(hn, cliJs, 'tui'))) owned.push(join(binDir, 'hn'))
  try {
    const tmux = join(binDir, 'tmux')
    if (lstatSync(tmux).isSymbolicLink()) {
      const target = relative(root, resolve(binDir, readlinkSync(tmux)))
      const [top, ...more] = target.split(sep)
      // Only something inside the runtime folder: a managed tmux, not the folder itself or a path out of it.
      if (top === 'runtime' && more.length > 0 && !more.includes('..') && !isAbsolute(target)) owned.push(tmux)
    }
  } catch { /* no tmux link */ }
  return owned
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
