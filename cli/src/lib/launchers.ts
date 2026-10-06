/**
 * The `harness` and `hn` launchers in the bin folder: repointing `harness` at the runtime it should run on,
 * and adding `hn` beside it on a machine installed before hn shipped.
 *
 * Its own module so the hn updater, which the core runs, can repair `hn` without loading the managed
 * runtimes' installer (runtimeInstall.ts), whose grid half is the models service's.
 */
import { accessSync, constants, linkSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
