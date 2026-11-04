/**
 * A wide Buddy's shell on Windows, in a real sandbox. On a Mac Claude Code holds that shell in its own sandbox; on native
 * Windows it has none, so Harness runs each command through the same runtime (@anthropic-ai/sandbox-runtime): a separate
 * low-privilege account, a write-restricted token, a Windows Filtering Platform fence on that account, and a local proxy
 * holding the host list. See docs/superpowers/specs/2026-11-04-windows-parity-design.md, W8.
 *
 * CLAUDE_CODE_SHELL_PREFIX makes every shell line Claude Code starts come through buddy-shell.sh. So inside is the default.
 * Two things run outside, as excludedCommands do on a Mac: this launch's own hook lines, which the script knows word for word,
 * and a harness command its guard approved a moment ago (`takeApproval`), by its exact words and once: those need the
 * daemon, whose pipe admits its owner alone. Nothing here decides what a Buddy may do: the guard judges every command first.
 * A sandbox that cannot start refuses the command, and never runs it outside.
 *
 * All of it is kept in Harness's data folder, never the Buddy's own, where a commit or a pull could put a file.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../../config/env.js'
import { findGitBash } from './gitBash.js'

export const SRT_WIN_EXE = 'srt-win.exe'
/** The guard answers and Claude Code starts the shell at once: an approval older than this is one nobody used. */
const APPROVAL_MS = 15_000

/** Windows' own stores of secrets and browser profiles in a home, and sign-ins kept in plain files: closed as ../buddyGuard.ts
 *  closes a Mac's. */
export const WINDOWS_CLOSED_IN_HOME = [
  'AppData/Roaming/Microsoft/Credentials', 'AppData/Local/Microsoft/Credentials', 'AppData/Roaming/Microsoft/Protect', 'AppData/Local/Microsoft/Vault',
  'AppData/Roaming/Microsoft/Vault', 'AppData/Roaming/Microsoft/Crypto', 'AppData/Roaming/Microsoft/SystemCertificates', 'AppData/Local/Google/Chrome/User Data',
  'AppData/Local/Microsoft/Edge/User Data', 'AppData/Roaming/Mozilla/Firefox', 'AppData/Local/Mozilla/Firefox', 'AppData/Local/BraveSoftware',
  'AppData/Roaming/Opera Software', 'AppData/Local/Vivaldi', 'AppData/Roaming/GitHub CLI', 'AppData/Roaming/gcloud', 'NTUSER.DAT', '.git-credentials', '_netrc', '.netrc',
] as const

export interface BuddySandboxPolicy {
  network: { allowedDomains: readonly string[] }
  filesystem: { allowWrite: readonly string[]; denyWrite: readonly string[]; denyRead: readonly string[]; allowRead?: readonly string[] }
  /** The clones its commands read, which git refuses as another account's without this. */
  gitFolders?: readonly string[]
}

/** The folder one Buddy's sandbox is kept in: by its folder's path, so a relaunch finds it. */
export const buddySandboxDir = (root: string, dataDir: string = env.ADAPTER_DATA_DIR): string =>
  join(dataDir, 'buddy-sandbox', createHash('sha256').update(root).digest('hex').slice(0, 32))
const policyFile = (dir: string) => join(dir, 'policy.json')
export const buddyApprovalsDir = (dir: string): string => join(dir, 'approved')
const shellFile = (dir: string) => join(dir, 'buddy-shell.sh')

export function writeBuddySandboxPolicy(dir: string, policy: BuddySandboxPolicy): void {
  mkdirSync(buddyApprovalsDir(dir), { recursive: true, mode: 0o700 })
  writeFileSync(policyFile(dir), JSON.stringify(policy), { mode: 0o600 })
}

export function buddySandboxPolicy(dir: string): BuddySandboxPolicy | null {
  try {
    const policy = JSON.parse(readFileSync(policyFile(dir), 'utf8')) as Partial<BuddySandboxPolicy>
    return policy?.network && policy.filesystem ? policy as BuddySandboxPolicy : null
  } catch { return null }
}

/**
 * The parts of the line Claude Code assembles for a Bash call, as read from 2.1.318 on Windows and a Mac:
 * `source snapshot || true && export TEMP=… && … && eval '<command>' < /dev/null && pwd -P >| <cwd file>`.
 * A command cannot forge this: every apostrophe in it comes through as `'"'"'`, so its text never closes that quote.
 * Null for any other line, which then runs inside as a whole.
 */
export function claudeShellLine(line: string): { command: string; cwdFile: string } | null {
  const open = " && eval '", close = "' < /dev/null && pwd -P >| "
  const start = line.indexOf(open), end = line.lastIndexOf(close)
  if (start < 0 || end < start + open.length) return null
  const quoted = line.slice(start + open.length, end), escaped = `'"'"'`
  if (quoted.split(escaped).join('').includes("'")) return null
  const cwdFile = line.slice(end + close.length)
  return cwdFile ? { command: quoted.split(escaped).join("'"), cwdFile } : null
}

/** Takes the guard's approval of exactly [command], if one stands, so it runs outside once. Old ones go as they are found. */
export function takeApproval(dir: string, command: string, now: number): boolean {
  const approvals = buddyApprovalsDir(dir)
  let names: string[] = []
  try { names = readdirSync(approvals) } catch { return false }
  let taken = false
  for (const name of names) {
    // A guard still writing one renames it to .json when it is whole.
    if (!name.endsWith('.json')) continue
    const file = join(approvals, name)
    let approval: { command?: unknown; at?: unknown } = {}
    try { approval = JSON.parse(readFileSync(file, 'utf8')) as typeof approval } catch { /* an unfinished or foreign file is no approval */ }
    const fresh = typeof approval.at === 'number' && approval.at <= now && now - approval.at <= APPROVAL_MS
    if (fresh && !taken && approval.command === command) { taken = true; rmSync(file, { force: true }); continue }
    if (!fresh) rmSync(file, { force: true })
  }
  return taken
}

export interface BuddySandbox {
  initialize(policy: BuddySandboxPolicy, srtWin: string): Promise<void>
  wrap(command: string, bash: string, cwd: string): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>
  reset(): Promise<void>
}
export interface BuddyShellDeps {
  sandbox?: BuddySandbox
  run?: (argv: string[], env: NodeJS.ProcessEnv | undefined) => Promise<number>
  err?: (line: string) => void
  bash?: string | null
  srtWin?: string | null
  now?: () => number
  cwd?: string
}

const REFUSED = "This command did not run: this Buddy's sandbox is not available on this computer. It can still read its own folder."

function realSandbox(): BuddySandbox {
  const runtime = import('@anthropic-ai/sandbox-runtime')
  return {
    initialize: async (policy, srtWin) => {
      const { SandboxManager } = await runtime
      await SandboxManager.initialize({
        network: { allowedDomains: [...policy.network.allowedDomains], deniedDomains: [] },
        filesystem: { allowWrite: [...policy.filesystem.allowWrite], denyWrite: [...policy.filesystem.denyWrite], denyRead: [...policy.filesystem.denyRead],
          ...(policy.filesystem.allowRead ? { allowRead: [...policy.filesystem.allowRead] } : {}) },
        ...(policy.gitFolders?.length ? { git: { safeDirectories: [...policy.gitFolders] } } : {}),
        windows: { srtWin: { path: srtWin } },
      } as never)
    },
    wrap: async (command, bash, cwd) => (await runtime).SandboxManager.wrapWithSandboxArgv(command, bash, undefined, undefined, cwd),
    reset: async () => { await (await runtime).SandboxManager.reset() },
  }
}

function runInherit(argv: string[], environment: NodeJS.ProcessEnv | undefined): Promise<number> {
  return new Promise((resolve) => {
    // Claude Code gives a command no stdin (`< /dev/null`).
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, ...(environment ? { env: environment } : {}) })
    child.once('error', () => resolve(127))
    child.once('exit', (code) => resolve(code ?? 1))
  })
}

/** `harness buddy-shell <its sandbox folder> <line>`: one shell line of a wide Buddy that is not a hook's. Its exit code is the command's. */
export async function runBuddyShell(dir: string, line: string, deps: BuddyShellDeps = {}): Promise<number> {
  const err = deps.err ?? ((text: string) => process.stderr.write(`${text}\n`))
  const policy = buddySandboxPolicy(dir)
  const bash = deps.bash === undefined ? findGitBash() : deps.bash
  if (!policy || !bash) { err(REFUSED); return 126 }
  const run = deps.run ?? runInherit
  const parts = claudeShellLine(line)
  if (parts && parts.command.startsWith('harness ') && takeApproval(dir, parts.command, (deps.now ?? Date.now)())) return run([bash, '-c', line], undefined)
  const srtWin = deps.srtWin === undefined ? srtWinBinary() : deps.srtWin
  if (!srtWin) { err(REFUSED); return 126 }
  const sandbox = deps.sandbox ?? realSandbox()
  let wrapped: { argv: string[]; env: NodeJS.ProcessEnv }
  try {
    await sandbox.initialize(policy, srtWin)
    // Only the command goes in. The rest of the line is Claude Code's own, and names its person's temporary folder, closed
    // here: their snapshot of their shell, and the file it reads the command's working folder from.
    wrapped = await sandbox.wrap(parts?.command ?? line, bash, deps.cwd ?? process.cwd())
  } catch {
    await sandbox.reset().catch(() => {})
    err(REFUSED)
    return 126
  }
  try {
    const code = await run(wrapped.argv, wrapped.env)
    // A command cannot have moved: the guard allows no `cd`.
    if (code === 0 && parts) return run([bash, '-c', `pwd -P >| ${parts.cwdFile}`], undefined)
    return code
  } finally { await sandbox.reset().catch(() => {}) }
}

/** The helper, in the signed payload (ptyPayload.ts): never one a command names, or that a folder holds. */
export function srtWinBinary(runtimeDir: string = join(process.env.USERPROFILE ?? '', '.harness', 'runtime')): string | null {
  let version: string
  try { version = readFileSync(join(runtimeDir, 'current-pty'), 'utf8').trim() } catch { return null }
  const file = join(runtimeDir, 'pty', version, SRT_WIN_EXE)
  return existsSync(file) ? file : null
}

/** What CLAUDE_CODE_SHELL_PREFIX names: a bare path Claude Code quotes, in Git Bash's forward slashes. */
export const buddyShellPrefix = (dir: string): string => shellFile(dir).replace(/\\/g, '/')

const shellWord = (value: string) => `'${value.split("'").join(`'"'"'`)}'`

/** [hooks]: this launch's own hook lines, which run outside and start no Node of their own here: one per tool call. */
export function buddyShellScript(input: { node: string; cli: string; dir: string; hooks: readonly string[] }): string {
  const hooks = input.hooks.length ? `case "$1" in\n  ${input.hooks.map(shellWord).join('|')}) exec bash -c "$1" ;;\nesac\n` : ''
  return `#!/bin/sh\n${hooks}exec ${shellWord(input.node)} ${shellWord(input.cli)} buddy-shell ${shellWord(input.dir)} "$1"\n`
}

export function writeBuddyShell(dir: string, input: { node: string; cli: string; hooks: readonly string[] }): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(shellFile(dir), buddyShellScript({ ...input, dir }), { mode: 0o700 })
}

/** The mark that this computer's sandbox was installed and its home opened to it, written once that finished. */
const installedMark = (dataDir: string) => join(dataDir, 'buddy-sandbox', 'installed')
export function markBuddySandboxInstalled(dataDir: string = env.ADAPTER_DATA_DIR): void {
  mkdirSync(join(dataDir, 'buddy-sandbox'), { recursive: true, mode: 0o700 })
  writeFileSync(installedMark(dataDir), '', { mode: 0o600 })
}
export const forgetBuddySandboxInstalled = (dataDir: string = env.ADAPTER_DATA_DIR): void => rmSync(installedMark(dataDir), { force: true })
/** Whether a Buddy here can have it: the sandbox a person agreed to, and the helper still there. */
export const buddySandboxReady = (dataDir: string = env.ADAPTER_DATA_DIR, binary: () => string | null = srtWinBinary): boolean =>
  existsSync(installedMark(dataDir)) && binary() !== null
