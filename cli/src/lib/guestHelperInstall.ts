/**
 * The owner's one-time step that lets guests run here (docs/plans/2026-10-19-guest-machine-sharing-plan.md):
 * one admin prompt installs the guest helper, the sudoers drop-in that lets the owner's daemon run it
 * without a password, a Node runtime guests' engines can use, and the hook script their engines report
 * through. Guests are never prompted.
 *
 * One privileged script does all of it, staged in a private temp folder and run once: on macOS through
 * `osascript … with administrator privileges` (the system's own password or Touch ID sheet), on Linux
 * through `pkexec`, else `sudo` in the terminal. It is idempotent: running it again replaces each piece.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, sep } from 'node:path'

import { env } from '../config/env.js'
import { HOOK_SCRIPT } from '../engines/kit/notifyHooks.js'
import { GUEST_HELPER_PATH, runGuestCommand, type GuestRunner } from './guestAccounts.js'
import { guestHelperScript, guestSudoersTemplate, helperScriptVersion } from './guestHelperAssets.js'
import { managedNodePath } from './nodeRuntime.js'

export const GUEST_SUDOERS_PATH = '/etc/sudoers.d/harness-guests'
export const GUEST_NODE_DIR = '/usr/local/lib/harness/node'
export const GUEST_HOOK_DIR = '/usr/local/lib/harness/hook'

/** The helper version this CLI ships: an installed one older than it is installed again. */
export const GUEST_HELPER_VERSION = helperScriptVersion(guestHelperScript()) ?? 0

const OWNER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/

/** The sudoers drop-in for [owner]. */
export function sudoersFor(owner: string): string {
  if (!OWNER.test(owner) || owner === 'root' || owner.startsWith('hg_')) throw new Error(`not an owner account: ${owner}`)
  return guestSudoersTemplate().replaceAll('{{OWNER}}', owner)
}

/** POSIX single quotes. */
function sh(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/** The managed Node runtime's folder (`~/.harness/runtime/node-…`), or null on a machine with none. */
export function managedNodeRuntimeDir(): string | null {
  const node = managedNodePath()
  if (!node.startsWith(env.ADAPTER_RUNTIME_DIR + sep)) return null
  return dirname(dirname(node))
}

export interface InstallScriptInput {
  /** The private folder holding `guest-helper`, `sudoers` and, when there is one, `notify.mjs`. */
  stageDir: string
  /** The Node runtime to copy for guests' engines; null leaves the installed one as it is. */
  nodeRuntimeDir: string | null
  hookScript: boolean
}

/** The one script run as root. Every target's parent must be root's alone: a helper sudo runs without a
 *  password, in a folder the owner (or anyone) could write, would be root for whatever replaced it. */
export function buildInstallScript(input: InstallScriptInput): string {
  const stage = sh(input.stageDir)
  const lines = [
    '#!/bin/sh',
    '# Harness guest helper install (cli/src/lib/guestHelperInstall.ts), run once as root.',
    'set -eu',
    'die() { printf "harness: %s\\n" "$1" >&2; exit "${2:-1}"; }',
    // A parent another account could write is refused, not repaired: chown-ing a system folder is not ours.
    'owned_by_root() {',
    '  [ -e "$1" ] || return 0',
    // (GNU `stat -f` is the file system's status and answers anything: the platform decides.)
    '  if [ "$(uname -s)" = Darwin ]; then uid=$(stat -f %u "$1"); mode=$(stat -f %Lp "$1")',
    '  else uid=$(stat -c %u "$1"); mode=$(stat -c %a "$1"); fi',
    '  [ "$uid" = 0 ] || die "$1 is not owned by root" 6',
    '  [ $((0$mode & 022)) -eq 0 ] || die "$1 can be written by others" 6',
    '}',
    'for dir in / /usr /usr/local /usr/local/libexec /usr/local/lib /etc /etc/sudoers.d; do owned_by_root "$dir"; done',
    // sudo must read drop-ins; editing /etc/sudoers itself is not ours to do either.
    "grep -Eq '^[#@]includedir[[:space:]]+(/private)?/etc/sudoers\\.d' /etc/sudoers || die 'sudo does not read /etc/sudoers.d on this computer' 5",
    `visudo -cf ${stage}/sudoers >/dev/null || die 'the sudoers drop-in is not valid' 5`,
    `mkdir -p ${sh(dirname(GUEST_HELPER_PATH))} ${sh(GUEST_HOOK_DIR)}`,
    `chown 0:0 ${sh(dirname(GUEST_HELPER_PATH))} ${sh(dirname(GUEST_HOOK_DIR))} ${sh(GUEST_HOOK_DIR)}`,
    `chmod 755 ${sh(dirname(GUEST_HELPER_PATH))} ${sh(dirname(GUEST_HOOK_DIR))} ${sh(GUEST_HOOK_DIR)}`,
    // The helper before the drop-in that names it: sudo never allows a path that is not in place yet.
    `install -o 0 -g 0 -m 0755 ${stage}/guest-helper ${sh(GUEST_HELPER_PATH)}`,
  ]
  if (input.nodeRuntimeDir) {
    const next = sh(`${GUEST_NODE_DIR}.new`)
    // Node and npm, which a guest's engine installs need: `bin`, `lib` and `include`, about 190 MB. Never the
    // runtime's `libexec`, the daemon's own process images (a renamed node per process, 1.2 GB on 2026-10-19).
    const parts = ['bin', 'lib', 'include'].map((part) => sh(`${input.nodeRuntimeDir}/${part}`)).join(' ')
    lines.push(
      `rm -rf ${next}`,
      `mkdir -p ${next}`,
      `for part in ${parts}; do [ ! -e "$part" ] || cp -R "$part" ${next}/; done`,
      `chown -R 0:0 ${next}`,
      `chmod -R a+rX,go-w ${next}`,
      `rm -rf ${sh(GUEST_NODE_DIR)}`,
      `mv ${next} ${sh(GUEST_NODE_DIR)}`,
    )
  }
  if (input.hookScript) lines.push(`install -o 0 -g 0 -m 0644 ${stage}/notify.mjs ${sh(`${GUEST_HOOK_DIR}/notify.mjs`)}`)
  lines.push(`install -o 0 -g 0 -m 0440 ${stage}/sudoers ${sh(GUEST_SUDOERS_PATH)}`, '')
  return lines.join('\n')
}

/** The osascript line that runs [scriptPath] as root behind the system's admin prompt. */
export function adminAppleScript(scriptPath: string, prompt: string): string {
  const quote = (text: string) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  return `do shell script "/bin/sh " & quoted form of ${quote(scriptPath)} with prompt ${quote(prompt)} with administrator privileges`
}

export const GUEST_HELPER_PROMPT =
  'Harness wants to let people you share this computer with run their harnesses as separate accounts, so they cannot see your files.'

export type GuestHelperInstallResult =
  | { ok: true }
  | { ok: false; code: 'CANCELLED' | 'FAILED' | 'UNSUPPORTED'; message: string }

export interface GuestHelperInstallOptions {
  /** The account the drop-in allows: this one, by default. */
  owner?: string
  runner?: GuestRunner
  platform?: NodeJS.Platform
  nodeRuntimeDir?: string | null
  hookScript?: string | null
  /** Whether `pkexec` and a desktop session are there (Linux). */
  graphical?: boolean
}

export async function installGuestHelper(options: GuestHelperInstallOptions = {}): Promise<GuestHelperInstallResult> {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'linux') {
    return { ok: false, code: 'UNSUPPORTED', message: 'Sharing this computer needs macOS or Linux.' }
  }
  const runner = options.runner ?? runGuestCommand
  const owner = options.owner ?? userInfo().username
  let sudoers: string
  try {
    sudoers = sudoersFor(owner)
  } catch (error) {
    return { ok: false, code: 'FAILED', message: (error as Error).message }
  }
  const nodeRuntimeDir = options.nodeRuntimeDir === undefined ? managedNodeRuntimeDir() : options.nodeRuntimeDir
  const hookScript = options.hookScript === undefined ? (existsSync(HOOK_SCRIPT) ? HOOK_SCRIPT : null) : options.hookScript

  // Private to this account until root copies it (mkdtemp is 0700): nobody else can swap a file in between.
  const stageDir = mkdtempSync(join(tmpdir(), 'harness-guest-'))
  try {
    writeFileSync(join(stageDir, 'guest-helper'), guestHelperScript(), { mode: 0o700 })
    writeFileSync(join(stageDir, 'sudoers'), sudoers, { mode: 0o600 })
    if (hookScript) writeFileSync(join(stageDir, 'notify.mjs'), readFileSync(hookScript), { mode: 0o600 })
    const script = join(stageDir, 'install.sh')
    writeFileSync(script, buildInstallScript({ stageDir, nodeRuntimeDir, hookScript: !!hookScript }), { mode: 0o700 })
    chmodSync(stageDir, 0o700)

    let result
    if (platform === 'darwin') {
      result = await runner('osascript', ['-e', adminAppleScript(script, GUEST_HELPER_PROMPT)], { timeoutMs: 10 * 60_000 })
      // -128 is the sheet's Cancel.
      if (result.code !== 0 && /-128|User canceled/i.test(result.stderr)) {
        return { ok: false, code: 'CANCELLED', message: 'Sharing was not turned on: the admin prompt was cancelled.' }
      }
    } else {
      const graphical = options.graphical ?? (existsSync('/usr/bin/pkexec') && !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY))
      result = graphical
        ? await runner('pkexec', ['/bin/sh', script], { timeoutMs: 10 * 60_000 })
        : await runner('sudo', ['/bin/sh', script], { interactive: true, timeoutMs: 10 * 60_000 })
      // pkexec: 126 is a dismissed dialog, 127 a refused authorization.
      if (graphical && (result.code === 126 || result.code === 127)) {
        return { ok: false, code: 'CANCELLED', message: 'Sharing was not turned on: the admin prompt was cancelled.' }
      }
    }
    if (result.code !== 0) {
      // osascript's `do shell script` ends the script's stderr lines with CR, not LF: split on both, or a reason after an
      // earlier line is never found, and the CR left in it makes a terminal print the line over itself.
      const said = result.stderr.trim().split(/[\r\n]+/).pop()?.replace(/^.*harness: /, '') ?? ''
      return { ok: false, code: 'FAILED', message: said || 'Sharing could not be set up on this computer.' }
    }
    return { ok: true }
  } finally {
    rmSync(stageDir, { recursive: true, force: true })
  }
}

export type GuestHelperState =
  | 'ready' // installed, current, and this account may run it without a password
  | 'missing'
  | 'outdated' // older than this CLI's: install again
  | 'not-authorized' // installed, but sudo asks this account for a password

export interface GuestHelperStatus { state: GuestHelperState; version: number | null }

export interface GuestHelperStatusDeps {
  runner?: GuestRunner
  helperPath?: string
  /** The installed helper's text, or null when there is none (no sudo needed: it is 0755). */
  read?: (path: string) => string | null
}

export async function guestHelperStatus(deps: GuestHelperStatusDeps = {}): Promise<GuestHelperStatus> {
  const helperPath = deps.helperPath ?? GUEST_HELPER_PATH
  const read = deps.read ?? ((path: string) => {
    try {
      return statSync(path).isFile() ? readFileSync(path, 'utf8') : null
    } catch {
      return null
    }
  })
  const text = read(helperPath)
  if (text === null) return { state: 'missing', version: null }
  const version = helperScriptVersion(text)
  if (version === null || version < GUEST_HELPER_VERSION) return { state: 'outdated', version }
  // `sudo -n -l <command>` answers 0 only when this account may run it without a password.
  const allowed = await (deps.runner ?? runGuestCommand)('sudo', ['-n', '-l', helperPath], { timeoutMs: 10_000 })
  return { state: allowed.code === 0 ? 'ready' : 'not-authorized', version }
}
