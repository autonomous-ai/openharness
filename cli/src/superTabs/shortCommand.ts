/**
 * The `super-tab` command an agent is told to run, as short as it can be and still work.
 *
 * Every delivered message names this command five or six times. Spelled out it is the daemon's Node, its V8 flags, its
 * cli.js, `--port` and `--machine`, which cost the agent context and read badly. The installers put a `harness` launcher
 * on PATH (`~/.local/bin/harness` on a Mac or Linux, `bin\harness.exe` on Windows) that runs the same CLI, so `harness
 * super-tab …` does the same thing, but only when that launcher is the one this daemon runs. A launcher left by another
 * build, a development checkout, or a folder that is not on the agent's PATH would run the wrong CLI or none, so each of
 * those keeps the full command. `--port` and `--machine` are dropped only when the CLI would choose the same values by
 * itself (`whereFor` in agentClient/daemon.ts) in the agent's shell, which has none of the daemon's own environment: a
 * tmux pane gets no PORT, ADAPTER_DATA_DIR or HARNESS_AUTH_DIR. So a daemon started with any of them (an isolated end-to-end
 * daemon, `harness tui`) keeps both flags, or its agents would talk to the default daemon.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { win32 } from 'node:path'
import { currentCli } from '../lib/windows/installLayout.js'
import { probe, resolveViaLoginShell } from '../lib/tmuxOnPath.js'
import { currentUserShell } from '../lib/userShell.js'
import { shellQuote } from '../orchestrator/prompts.js'

/** The port the CLI uses when nothing says otherwise (config/env.ts PORT). */
const DEFAULT_PORT = 18473
/** What moves the daemon (or the CLI's idea of it) off the defaults. The agent's shell does not have them. */
const ISOLATING = ['PORT', 'ADAPTER_DATA_DIR', 'ADAPTER_CLI_DIR', 'HARNESS_AUTH_DIR', 'HARNESS_ENV_FILE', 'ADAPTER_COMPUTER_ID', 'ADAPTER_COMPUTER_ID_FILE']

export interface ShortCommandDeps {
  platform?: NodeJS.Platform
  /** The daemon's environment. */
  env?: NodeJS.ProcessEnv
  /** The file an agent's shell runs for `harness`, or null: it is not there, or the answer is not a file. */
  resolve?: () => Promise<string | null>
  readFile?: (path: string) => string
  exists?: (path: string) => boolean
  realpath?: (path: string) => string
  /** The CLI a Windows install's `cli\current` names. */
  windowsCli?: (root: string) => { cliJs: string } | null
}

/** A POSIX shell word list: single and double quotes, and a backslash outside quotes. Enough for what the installers write. */
export function shellWords(text: string): string[] {
  const words: string[] = []
  let word: string | null = null, quote = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) { if (c === quote) quote = ''; else word += c; continue }
    if (c === "'" || c === '"') { quote = c; word ??= ''; continue }
    if (c === '\\' && i + 1 < text.length) { word = (word ?? '') + text[++i]; continue }
    if (/\s/.test(c)) { if (word !== null) words.push(word); word = null; continue }
    word = (word ?? '') + c
  }
  if (word !== null) words.push(word)
  return words
}

/**
 * What the agent's shell runs for `harness`: the person's own login shell, since a pane's PATH is what their startup files
 * make it, and again as a plain login shell with no rc file, as the subshell of an agent's tool runs (`path_helper` can put
 * /usr/local/bin ahead there). Both must give the same file, else null.
 */
export async function shellResolve(
  // A spec must never start the developer's own shell (cli/AGENTS.md, rule 6).
  shell: string | undefined = process.env.NODE_ENV === 'test' ? undefined : currentUserShell(),
): Promise<string | null> {
  if (!shell) return null
  const [own, plain] = await Promise.all([resolveViaLoginShell('harness', shell), probe(shell, ['-lc'], 'harness')])
  return own && own === plain ? own : null
}

/**
 * `harness` as PowerShell and cmd find it: the first PATH folder holding any form of it decides. Only `harness.exe` is ours;
 * a `harness.ps1` or `.cmd` earlier on PATH would be run instead of it.
 */
export function windowsResolve(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string | null {
  for (const dir of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) {
    for (const name of ['harness.exe', 'harness.cmd', 'harness.bat', 'harness.ps1']) {
      const file = win32.join(dir, name)
      if (exists(file)) return name === 'harness.exe' ? file : null
    }
  }
  return null
}

/** Whether [launcher] is the installer's script and runs the same Node and cli.js as [words] (the daemon's command, split). */
function runsSameCli(launcher: string, words: string[], deps: Required<Pick<ShortCommandDeps, 'readFile' | 'realpath'>>): boolean {
  let exec: string[]
  try {
    const text = deps.readFile(launcher)
    // Exactly what install.sh writes. Any other shape could do anything, so it is not trusted.
    if (text.length > 4096 || !text.startsWith('#!/bin/sh\nexec ') || text.indexOf('\n', 15) !== text.length - 1) return false
    exec = shellWords(text.slice(10))
  } catch { return false }
  const [node, script] = [words[0], words[words.length - 1]]
  // Between them the daemon may carry only V8 memory flags; a loader or another flag changes what runs.
  if (exec.length !== 4 || exec[3] !== '$@' || words.length < 2 || !words.slice(1, -1).every(w => w.startsWith('--max-'))) return false
  try { return exec[1] === node && deps.realpath(exec[2]) === deps.realpath(script) } catch { return false }
}

/** What every delivery named before this file: the daemon's own command, spelled out. */
export const fullCommandPrefix = (daemon: { command: string; port: number }, machineId: string): string =>
  `${daemon.command} super-tab --port ${daemon.port} --machine ${shellQuote(machineId)}`

/**
 * `harness super-tab …` when it would run this daemon's CLI for the agent, else the daemon's full command; with the flags
 * the CLI would not choose for itself. Costs a shell start, so the caller asks once and keeps the answer.
 */
export async function agentCommandPrefix(
  daemon: { command: string; port: number }, machineId: string, defaultMachine: () => string, deps: ShortCommandDeps = {},
): Promise<string> {
  const platform = deps.platform ?? process.platform
  const environment = deps.env ?? process.env
  const words = shellWords(daemon.command)
  const found = await (deps.resolve ?? (platform === 'win32' ? () => Promise.resolve(windowsResolve(environment, deps.exists)) : shellResolve))().catch(() => null)
  const realpath = deps.realpath ?? realpathSync
  let short = false
  if (found && words.length) {
    try {
      if (platform === 'win32') {
        // bin\harness.exe finds its install from its own folder (pty/src/command.rs): the CLI is the one `cli\current` names.
        const cli = win32.basename(found).toLowerCase() === 'harness.exe' ? (deps.windowsCli ?? currentCli)(win32.dirname(win32.dirname(found))) : null
        short = !!cli && realpath(cli.cliJs).toLowerCase() === realpath(words[words.length - 1]).toLowerCase()
      } else short = runsSameCli(found, words, { readFile: deps.readFile ?? (p => readFileSync(p, 'utf8')), realpath })
    } catch { short = false }
  }
  if (!short) return fullCommandPrefix(daemon, machineId)
  const plain = daemon.port === DEFAULT_PORT && !ISOLATING.some(name => environment[name])
  return `harness super-tab${plain ? '' : ` --port ${daemon.port}`}${plain && machineId === defaultMachine() ? '' : ` --machine ${shellQuote(machineId)}`}`
}
