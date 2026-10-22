/**
 * The `super-tab` command an agent is told to run, as short as it can be and still work.
 *
 * Every delivered message names this command five or six times. Spelled out it is the daemon's Node, its V8 flags, its
 * cli.js, `--port` and `--machine`, which cost the agent context and read badly. The installers put a `harness` launcher
 * on PATH (`~/.local/bin/harness` on a Mac or Linux, `bin\harness.exe` on Windows) that runs the same CLI, so `harness
 * super-tab …` does the same thing, but only when that launcher is the one this daemon runs. A launcher left by another
 * build, a development checkout, or a folder that is not on the agent's PATH would run the wrong CLI or none, so each of
 * those keeps the full command. `--port` and `--machine` are dropped only when the CLI would choose the same values by
 * itself (`whereFor` in agentClient/daemon.ts).
 */
import { execFile } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { basename, win32 } from 'node:path'
import { currentCli } from '../lib/windows/installLayout.js'
import { resolveBinaryOnPath } from '../lib/binaryOnPath.js'
import { currentUserShell } from '../lib/userShell.js'
import { shellQuote } from '../orchestrator/prompts.js'

/** What the CLI picks for itself when it is given neither flag. */
export interface CliDefaults { port: number; dataDir: string; machineId: () => string }

export interface ShortCommandDeps {
  platform?: NodeJS.Platform
  /** The file an agent's shell runs for `harness`, or null: it is not there, or the answer is not a file. */
  resolve?: () => Promise<string | null>
  readFile?: (path: string) => string
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

/** The agent's shell asked what `harness` is: run as a login shell, since a pane's PATH is what the person's startup files make it. */
export function shellResolve(
  // A spec must never start the developer's own shell (cli/AGENTS.md, rule 6).
  shell: string | undefined = process.env.NODE_ENV === 'test' ? undefined : currentUserShell(), run: typeof execFile = execFile,
): Promise<string | null> {
  if (!shell) return Promise.resolve(null)
  const flag = basename(shell).toLowerCase() === 'zsh' ? '-lic' : '-ic'
  const marker = '__HARNESS_LAUNCHER__='
  return new Promise(done => {
    try {
      const child = run(shell, [flag, `printf '\\n${marker}%s\\n' "$(command -v harness)"`], {
        encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
      }, (error, stdout) => {
        // Startup files may print banners: only the last marked line counts.
        const line = error ? undefined : stdout.split('\n').reverse().find(l => l.startsWith(marker))?.slice(marker.length)
        done(line?.startsWith('/') ? line : null)
      })
      child.stdin?.end()
    } catch { done(null) }
  })
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

/**
 * `harness super-tab …` when it would run this daemon's CLI for the agent, else the daemon's full command; with the flags
 * the CLI would not choose for itself. Costs a shell start, so the caller asks once and keeps the answer.
 */
export async function agentCommandPrefix(
  daemon: { command: string; port: number }, dataDir: string, machineId: string, defaults: CliDefaults, deps: ShortCommandDeps = {},
): Promise<string> {
  const platform = deps.platform ?? process.platform
  const words = shellWords(daemon.command)
  const found = await (deps.resolve ?? (platform === 'win32' ? () => Promise.resolve(resolveBinaryOnPath('harness')) : shellResolve))().catch(() => null)
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
  if (!short) return `${daemon.command} super-tab --port ${daemon.port} --machine ${shellQuote(machineId)}`
  const port = daemon.port === defaults.port && dataDir === defaults.dataDir ? '' : ` --port ${daemon.port}`
  const machine = machineId === defaults.machineId() ? '' : ` --machine ${shellQuote(machineId)}`
  return `harness super-tab${port}${machine}`
}
