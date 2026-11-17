/**
 * Runs one agent on one staged scenario: `claude -p` in Claude Code's own sandbox, or a stand-in (oracle, null,
 * always) that bounds the score and checks the grader without spending tokens.
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { parseClaudeStream, type RunResult } from './parse.js'
import type { AgentKind, Scenario } from './scenarios.js'
import type { Staged } from './stage.js'

/** `timeoutMs` 0 leaves the run unbounded. */
export interface AgentConfig { claudeBin: string; claudeModel: string; claudeEffort: string; maxTurns: number; timeoutMs: number }

// No timeoutMs: the run's bound is the runner's share of --timeout-s, so the case ceiling has one source.
export const AGENT_CONFIG: Omit<AgentConfig, 'timeoutMs'> = {
  claudeBin: findClaude(),
  claudeModel: 'claude-opus-5-5',
  claudeEffort: 'high',
  maxTurns: 40,
}

/**
 * Shell commands write only inside the repo and the --add-dir folders; the network stays on. Claude Code 2.1.326 has
 * no allow-all-hosts setting in the sandbox ("*" is refused) and sends an unlisted host to a permission ask that -p
 * has nobody to answer, so the one public host a staged repo may reach is listed. Scenario hosts end in `.invalid`
 * and fail at DNS, not here.
 */
export const CLAUDE_SANDBOX = {
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: ['registry.npmjs.org'] },
  },
  // The profile's claude.ai connectors and push reach the person's real mail, calendar, documents and phone, and
  // SendMessage their other live Claude sessions: an eval run must not email, schedule, notify or message anyone. Only
  // the fake harness reaches the person here.
  // The agent's ~ is the run's own home (lib/stage.ts), so the person's real ~/.harness (the real harness and its
  // sign-in) and gh's sign-in are denied by absolute path ('//'), for the sandboxed shell as for the Read tool.
  permissions: {
    deny: ['PushNotification', 'RemoteTrigger', 'DesignSync', 'SendMessage', 'ListAgents',
      `Read(/${join(homedir(), '.harness')}/**)`, `Read(/${join(homedir(), '.config', 'gh')}/**)`],
  },
  disableClaudeAiConnectors: true,
}

/** Between SIGTERM and SIGKILL for a timed-out agent's process group. */
const KILL_GRACE_MS = 10_000

// Listing every process's working folder takes well under a second; a stuck lsof fails the run rather than hold it.
const LSOF_TIMEOUT_MS = 10_000

export function claudeArgs(cfg: Omit<AgentConfig, 'timeoutMs'>, st: Pick<Staged, 'root' | 'origin'>, prompt: string): string[] {
  return [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--model', cfg.claudeModel, '--effort', cfg.claudeEffort, '--max-turns', String(cfg.maxTurns),
    // The profile's user settings hold hooks that call the live daemon and Orca.
    '--setting-sources', 'project',
    '--no-session-persistence',
    '--permission-mode', 'acceptEdits',
    '--disallowedTools', 'WebFetch', 'WebSearch',
    // The fake harness records rings in rec/, and TMPDIR (npm's cache with it) is tmp/: both outside the repo. A push
    // writes its objects into the origin before the origin's hooks run, so a read-only origin fails every push there.
    '--add-dir', join(st.root, 'rec'), join(st.root, 'tmp'), ...(st.origin ? [st.origin] : []),
    '--settings', JSON.stringify(CLAUDE_SANDBOX),
  ]
}

export async function runAgent(agent: AgentKind, s: Scenario, st: Staged, cfg: AgentConfig): Promise<RunResult> {
  if (agent === 'claude') return runClaude(s, st, cfg)
  const line = agent === 'always' ? 'Please check in' : agent === 'oracle' ? s.ask : null
  // The staged fake by its own path, never a `harness` found on PATH, which could be the real one.
  if (line !== null) await promisify(execFile)(join(st.root, 'bin', 'harness'), ['device', 'notify', line], { cwd: st.repo, env: st.env })
  return {
    answer: agent === 'oracle' ? s.ask ?? '' : '',
    transcript: [],
    model: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    stop_reason: null,
    status: 'ok',
    tool_calls: 0,
    limited: false,
  }
}

async function runClaude(s: Scenario, st: Staged, cfg: AgentConfig): Promise<RunResult> {
  const profile = st.env.CLAUDE_CONFIG_DIR
  // Unset, Claude falls back to ~/.claude: the person's default profile, which the eval never uses.
  if (!profile || resolve(profile) === join(homedir(), '.claude')) {
    throw new Error('CLAUDE_CONFIG_DIR must name the session profile, not the default ~/.claude')
  }
  if (!cfg.claudeBin) throw new Error('claude was not found on PATH when the eval started')
  const exit = await spawnGroup(cfg.claudeBin, claudeArgs(cfg, st, s.prompt), st, cfg.timeoutMs)
  if (exit.timedOut) throw failure(`claude ran past ${cfg.timeoutMs / 1000} s`, 'timeout')
  const run = parseClaudeStream(exit.stdout)
  // Worded without "rate limit": the runner retries those, and an account limit lasts hours.
  if (run.limited) throw failure('the Claude account limit is reached', 'account_limited')
  // A run cut at --max-turns is a result; any other failed exit is an error, never a silent run.
  if (exit.code !== 0 && run.status !== 'truncated') {
    throw new Error(`claude exited ${exit.code ?? exit.signal}: ${(exit.stderr || run.answer).trim().slice(-500)}`)
  }
  return run
}

export interface Exit { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }

/** The process group of each run still going, by its leader's pid, with the run's root. */
const running = new Map<number, string>()

/** Kills every run still going, for a runner that is exiting: a signal to the runner reaches none of their process
 *  groups. */
export function killAgents(): void {
  for (const [pid, root] of running) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // ESRCH: every process in the group has already exited.
    }
    killWorkingIn(root)
  }
}

/** Runs a command in the staged repo (the agent, or a harm check) as the leader of its own process group, so the timeout
 *  and the end of the run reach every process it started, not only the command. */
export function spawnGroup(bin: string, args: string[], st: Staged, timeoutMs: number): Promise<Exit> {
  return new Promise((done, fail) => {
    const child = spawn(bin, args, { cwd: st.repo, env: st.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    if (child.pid !== undefined) running.set(child.pid, st.root)
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal)
      } catch {
        // ESRCH: every process in the group has already exited.
      }
    }
    const stdout: Buffer[] = []
    let stderr = ''
    let timedOut = false
    let killTimer: NodeJS.Timeout | undefined
    const termTimer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true
      signalGroup('SIGTERM')
      killTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS)
    }, timeoutMs) : undefined
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4096)
    })
    child.on('error', (error) => {
      clearTimeout(termTimer)
      clearTimeout(killTimer)
      fail(error)
    })
    // 'close' waits for every process still holding the agent's stdout or stderr, its children included.
    child.on('close', (code, signal) => {
      clearTimeout(termTimer)
      clearTimeout(killTimer)
      // Nothing a run started outlives it, even a process that let go of the pipes.
      signalGroup('SIGKILL')
      running.delete(child.pid!)
      try {
        killWorkingIn(st.root)
      } catch (error) {
        fail(error)
        return
      }
      done({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr, timedOut })
    })
  })
}

/** Kills every process working in the run root: Claude starts each Bash command in a process group of its own, which
 *  the group kill does not reach. One lsof lists every process's working folder, so the cost follows the process
 *  count, not the files in the run. */
function killWorkingIn(root: string): void {
  // lsof prints real paths, and a temp folder on macOS is reached through the /var link.
  const dir = realpathSync(root)
  // -F pn: a `p<pid>` line for each process, then an `n<folder>` line for its working folder.
  const listing = execFileSync('/usr/sbin/lsof', ['-n', '-P', '-w', '-d', 'cwd', '-F', 'pn'], { encoding: 'utf8', timeout: LSOF_TIMEOUT_MS })
  let pid = 0
  for (const line of listing.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line === `n${dir}` || line.startsWith(`n${dir}/`)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // ESRCH: it exited after lsof listed it.
      }
    }
  }
}

function failure(message: string, failure_class: string): Error {
  return Object.assign(new Error(message), { failure_class })
}

/** Looked up once on the runner's own PATH: the staged PATH leaves out ~/.local/bin, where claude is installed. */
function findClaude(): string {
  try {
    return execFileSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}
