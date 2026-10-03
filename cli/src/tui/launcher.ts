/** Identify the command users actually run before reporting that hn is up to date. */
import { execFile } from 'node:child_process'
import { accessSync, closeSync, constants, copyFileSync, lstatSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { env } from '../config/env.js'
import { resolveBinaryOnPath } from '../lib/binaryOnPath.js'
import { ensureHnLauncher } from '../lib/runtimeInstall.js'
import { installedTuiPath } from './paths.js'

const run = promisify(execFile)
const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
export const hnLauncherPath = (): string => join(env.HARNESS_BIN_DIR, 'hn')
const launcherSource = (): string => `#!/bin/sh\nexec ${quote(join(env.HARNESS_BIN_DIR, 'harness'))} tui "$@"\n`
type Launcher = { path: string; kind: 'missing' | 'managed' | 'legacy' | 'other'; identity?: string }

function identity(path: string): string | undefined {
  try {
    const s = lstatSync(path)
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function prefix(path: string): Buffer {
  if (!statSync(path).isFile()) throw new Error('Not a regular file')
  const fd = openSync(path, 'r')
  try {
    const bytes = Buffer.alloc(8192)
    return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0))
  } finally { closeSync(fd) }
}

function linkedTarget(path: string): string | null {
  try { return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : null } catch { return null }
}

/** Recognize only the launchers we have shipped, including the older direct Node launcher. */
export function isManagedHnLauncher(path = hnLauncherPath()): boolean {
  const linked = linkedTarget(path)
  if (linked === installedTuiPath() || linked === join(env.ADAPTER_CLI_DIR, 'cli.js')) return true
  try {
    const text = prefix(path).toString('utf8').trim()
    const harness = join(env.HARNESS_BIN_DIR, 'harness')
    if ([quote(harness), `"${harness}"`, harness].some(word => text === `#!/bin/sh\nexec ${word} tui "$@"`)) return true
    const cli = join(env.ADAPTER_CLI_DIR, 'cli.js')
    // The old installer's two-line script pins Node and cli.js. No extra commands or fuzzy
    // `.harness` substring: native binaries and unrelated programs can contain that string too.
    const lines = text.split('\n')
    return lines.length === 2 && lines[0] === '#!/bin/sh'
      && lines[1].startsWith('exec ') && lines[1].endsWith(' tui "$@"')
      && [quote(cli), `"${cli}"`, cli].some(word => lines[1].includes(` ${word} tui "$@"`))
  } catch { return false }
}

function checkoutLink(path: string): boolean {
  const linked = linkedTarget(path)
  if (!linked) return false
  const match = /^(.*)[/\\]target[/\\].+[/\\](?:hn|harness-tui)$/.exec(linked)
  if (!match) return false
  try { return /^name\s*=\s*"harness-tui"\s*$/m.test(readFileSync(join(match[1], 'Cargo.toml'), 'utf8')) } catch { return false }
}

export async function inspectHnLauncher(path = hnLauncherPath()): Promise<Launcher> {
  const before = identity(path)
  if (!before) return { path, kind: 'missing' }
  if (isManagedHnLauncher(path)) return { path, kind: 'managed', identity: before }
  if (checkoutLink(path)) return { path, kind: 'legacy', identity: before }
  try {
    // Only native executables get a version probe. Never run somebody else's shell wrapper.
    const magic = prefix(path).subarray(0, 4).toString('hex')
    if (['7f454c46', 'cffaedfe', 'feedfacf', 'cefaedfe', 'feedface', 'cafebabe', 'bebafeca'].includes(magic)) {
      const result = await run(path, ['--version'], { timeout: 3000, maxBuffer: 4096, env: { ...process.env, HN_AS_TMUX: '0' } })
      if (/^hn \d+\.\d+\.\d+(?:[-+][\w.-]+)? \(tmux [^\r\n]+\)$/.test(result.stdout.trim())) {
        return { path, kind: 'legacy', identity: before }
      }
    }
  } catch { /* unrelated or broken: preserve it */ }
  return { path, kind: 'other', identity: before }
}

function installedCli(script: string): boolean {
  try { return realpathSync(script) === realpathSync(join(env.ADAPTER_CLI_DIR, 'cli.js')) } catch { return false }
}

/** Explicit migration only, after the managed binary was verified. Preserve the old entry itself. */
export async function repairHnLauncher(script: string, log: (line: string) => void): Promise<void> {
  if (!installedCli(script)) return
  const state = await inspectHnLauncher()
  if (state.kind === 'managed') return
  if (state.kind === 'missing') {
    if (!ensureHnLauncher(script) && !isManagedHnLauncher()) {
      throw new Error(`Could not create ${state.path}; use \`harness tui\` to run the installed version.`)
    }
    return
  }
  if (state.kind === 'other') {
    log(`  hn at ${state.path} is another or unrecognized command; use \`harness tui\` for the managed version.`)
    return
  }
  const harness = join(env.HARNESS_BIN_DIR, 'harness')
  const cli = join(env.ADAPTER_CLI_DIR, 'cli.js')
  accessSync(harness, constants.X_OK)
  const exec = /^exec .*$/m.exec(readFileSync(harness, 'utf8'))?.[0]
  if (!exec || !(exec.includes(cli) || exec.includes(quote(cli)))) throw new Error('The harness launcher is not managed; hn was left unchanged.')
  if (identity(state.path) !== state.identity) throw new Error('The hn launcher changed during installation; run `harness tui --install` again.')
  const backup = mkdtempSync(join(env.HARNESS_BIN_DIR, '.hn-backup-'))
  const staged = join(backup, 'new-hn')
  try {
    const target = linkedTarget(state.path)
    // The backup lives one directory deeper; resolve relative links so it still runs the old build.
    if (target !== null) symlinkSync(target, join(backup, 'hn'))
    else copyFileSync(state.path, join(backup, 'hn'), constants.COPYFILE_EXCL)
    writeFileSync(staged, launcherSource(), { mode: 0o755 })
    if (identity(state.path) !== state.identity) throw new Error('The hn launcher changed during installation; run `harness tui --install` again.')
    renameSync(staged, state.path)
    log(`  ✓ hn now follows automatic updates. Previous launcher: ${join(backup, 'hn')}`)
  } finally { rmSync(staged, { force: true }) }
}

export async function reportHnLauncher(log: (line: string) => void): Promise<void> {
  if (process.env.HARNESS_TUI_BIN) {
    log(`  hn uses HARNESS_TUI_BIN=${process.env.HARNESS_TUI_BIN}; unset it to use automatic updates.`)
  }
  const standard = await inspectHnLauncher()
  if (standard.kind === 'legacy') {
    log(`  hn at ${standard.path} is an unmanaged Harness build and does not receive automatic updates.`)
    log('  Run `harness tui --install` (or `harness update --force`) to back it up and switch to the managed release.')
  } else if (standard.kind === 'other') {
    log(`  hn at ${standard.path} is another or unrecognized command; use \`harness tui\` for the managed version.`)
  }
  const active = resolveBinaryOnPath('hn')
  if (active && resolve(active) !== resolve(standard.path)) {
    log(`  Your PATH resolves hn to ${active}; put ${env.HARNESS_BIN_DIR} first or use \`harness tui\`.`)
  }
}
