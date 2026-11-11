/**
 * `harness browser <command>`: an agent drives the browser its person started for it
 * (docs/superpowers/specs/2026-11-11-browser-from-chat-design.md). It proves the pane it runs in from its parent
 * processes, asks that pane's daemon `agent_browser_run` over the local socket, and prints the tool's words; a screenshot
 * and the whole of a long output go to files in the agent's `$TMPDIR` (browserOutput.ts). It names no agent: the daemon
 * finds the agent by the pane, so a command reaches only its own agent's browser. It never starts or stops one.
 */
import type { Readable, Writable } from 'node:stream'
import { runningPane, type PaneProbe } from '../lib/callerPane.js'
import { browserHelp, parseBrowserArgs } from './browserArgs.js'
import { BrowserFilesError, capOutput, saveScreenshot } from './browserOutput.js'
import { EXIT } from './commands.js'
import { AgentClientError, openDaemon, whereFor, type Where } from './daemon.js'

const ON_WINDOWS = "Browser doesn't run on Windows yet."
const NOT_THIS_AGENT = "Browser isn't available for this agent."
const NO_PANE = 'Run harness browser from your own Harness pane.'
const UNAVAILABLE = "Browser isn't available right now"

/** How long this waits for the daemon: the tool's own limit (20 s, navigation 60 s, wait 30 s), 10 s the service gives a
 *  running call more, and 5 s more here, so the service's own answer comes first. */
const WAIT_MS: Record<string, number> = { navigate: 75_000, wait: 45_000 }
const DEFAULT_WAIT_MS = 35_000

/** A browser that is not ready, by its state or its failure's name, as the agent reads it. */
const NOT_READY: Record<string, string> = {
  setup: 'Browser is being set up',
  starting: 'Browser is starting',
  needs_setup: "Browser isn't set up",
  podman_install_failed: "Podman didn't install",
  podman_manual: 'Install Podman, then retry',
  podman_old: 'Update Podman, then retry',
  podman_memory: 'Give Podman 4 GB of memory, then retry',
  state_unreadable: "Browser data can't be read",
  podman_down: 'Podman is not running',
  image_failed: 'Browser image failed to build',
  browser_stopped: 'Browser stopped',
  profile_unwritable: "Browser can't save its login",
  proxy_failed: 'Proxy is not reachable',
  browser_limit: 'Too many browsers on this machine',
  device_failed: "Device settings didn't apply",
}

/** The daemon's refusals: what the agent reads, and the exit code that tells it whether to retry. */
const REFUSED: Record<string, [line: string, code: number]> = {
  BUSY: ['Browser is busy. Try again.', EXIT.failed],
  TOOL_FAILED: ['Browser is not reachable', EXIT.failed],
  OFF: ['Your browser is off. Ask your person to start it: Browser in your chat.', EXIT.stopped],
  STOPPED: ['Your person stopped your browser.', EXIT.stopped],
  NOT_ALLOWED: [NOT_THIS_AGENT, EXIT.refused],
  NO_AGENT: [NO_PANE, EXIT.refused],
  NOT_ON_WINDOWS: [ON_WINDOWS, EXIT.refused],
}

export interface BrowserIo { stdout: Writable; stderr: Writable; stdin: Readable }

export interface BrowserDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  probe?: PaneProbe
  where?: (pane: string) => Where
  open?: typeof openDaemon
}

/** [table]'s own entry for [key]: a name from the daemon is never one of an object's inherited ones. */
const own = <T>(table: Record<string, T>, key: unknown): T | undefined =>
  typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined

const readAll = async (stream: Readable): Promise<string> => {
  let text = ''
  stream.setEncoding('utf8')
  for await (const chunk of stream) text += chunk as string
  return text
}

export async function browserCommand(argv: readonly string[], io: BrowserIo = process, deps: BrowserDeps = {}): Promise<number> {
  const say = (stream: Writable, line: string, code: number): number => { stream.write(`${line}\n`); return code }
  // Before anything starts: the browser's container runs on macOS and Linux only (docs/windows-rules.md).
  if ((deps.platform ?? process.platform) === 'win32') return say(io.stderr, ON_WINDOWS, EXIT.refused)
  const parsed = parseBrowserArgs(argv)
  if ('help' in parsed) return say(io.stdout, browserHelp(), EXIT.ok)
  if ('usage' in parsed) return say(io.stderr, parsed.usage, EXIT.usage)
  const env = deps.env ?? process.env
  // The pane from the command's parents: a TMUX_PANE that names another pane, or a pane that cannot be proven (a pty
  // host's on macOS or Linux), is refused rather than taken at its word.
  const { pane, ancestors } = runningPane(env, deps.probe, deps.platform)
  if (!pane) return say(io.stderr, NO_PANE, EXIT.refused)
  const { command } = parsed
  const args = parsed.stdin === 'text' ? { ...parsed.args, text: await readAll(io.stdin) } : parsed.args
  let reply: Record<string, unknown>
  try {
    const daemon = await (deps.open ?? openDaemon)((deps.where ?? whereFor)(pane))
    try {
      reply = await daemon.request('agent_browser_run', { pane, ancestors, command, args }, WAIT_MS[command] ?? DEFAULT_WAIT_MS)
    } finally { daemon.close() }
  } catch (error) {
    if (!(error instanceof AgentClientError)) throw error
    return say(io.stderr, error.code === 'TIMEOUT' ? `${command} timed out` : error.message, EXIT.failed)
  }
  if (reply.ok !== true) {
    if (reply.error === 'NOT_READY') return say(io.stderr, own(NOT_READY, reply.state) ?? UNAVAILABLE, EXIT.failed)
    if (reply.error === 'TOOL_TIMEOUT') return say(io.stderr, `${command} timed out`, EXIT.failed)
    const [line, exit] = own(REFUSED, reply.error) ?? [UNAVAILABLE, EXIT.failed]
    return say(io.stderr, line, exit)
  }
  const text = typeof reply.text === 'string' ? reply.text : ''
  if (reply.failed === true) return say(io.stderr, text, EXIT.failed)
  try {
    // No image bytes reach the terminal: the agent reads the file with its own file tool.
    const out = typeof reply.image === 'string' ? saveScreenshot(env, reply.image) : capOutput(env, text)
    return say(io.stdout, out, EXIT.ok)
  } catch (error) {
    if (!(error instanceof BrowserFilesError)) throw error
    return say(io.stderr, error.message, EXIT.failed)
  }
}
