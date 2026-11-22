/**
 * Tier B's Orca agents (docs/plans/2026-11-22-dial-eval-orca-design.md, "Tier B"; the plan's Decision 16): each one a
 * terminal-host stand-in of its own (orcaHost.ts) and its Node runner, the caller of every hook it runs, under Orca's
 * host's name, or another's for a held pane (HELD_MAKER); no engine process runs. Claude Code's hooks are InOrca's on that
 * terminal, Codex's CodexOutside's, and an agent ends when its stand-in does.
 *
 * Every session here runs inside the real Orca, so this worker's environment holds Orca's, tmux's and its terminal's
 * names, and the maker walk from this worker reaches the real Orca: nothing runs for an agent but on its stand-in, under
 * the daemon's environment, made from scratch (testing/daemonEnvironment.ts), and the session's own names (`orcaEnv`).
 */
import { execFileSync, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { engineOf, HELD_MAKER, type SessionDef } from '../../src/testing/dialAppEval/types.js'
import { guardEnv } from './appEvalDriver.js'
import { CodexOutside } from './codexOutside.js'
import type { IsolatedDaemon } from './daemon.js'
import { IN_ORCA, InOrca } from './inOrca.js'
import { orcaTerminal, type OrcaTerminal } from './orcaHost.js'
import { startPluginLoop, type PluginLoop } from './pluginLoop.js'

/** Orca's names for the session's terminal, its made-up secrets beside them, with the session's own id (the plan's
 *  Decision 1), then its hints. */
const orcaNames = (s: Pick<SessionDef, 'key'>, hints: Record<string, string>): Record<string, string> =>
  ({ ...IN_ORCA, ORCA_AGENT_SESSION_ID: `eval-orca-${s.key}`, ...hints })

/** Every Orca agent's process's environment: the daemon's (testing/daemonEnvironment.ts), Orca's names for the session
 *  and its hints (Decision 4); no value of this worker's. */
export function orcaEnv(d: Pick<IsolatedDaemon, 'env'>, s: SessionDef, hints: Record<string, string>): NodeJS.ProcessEnv {
  return { ...d.env, ...orcaNames(s, hints) }
}

/** Orca's plugin's loop on [d] (harness/pluginLoop.ts), under the daemon's network guard as every process tier B starts
 *  is, its environment otherwise its own. */
export function startOrcaPlugin(d: IsolatedDaemon, children: ChildProcess[]): PluginLoop {
  return startPluginLoop(d, children, guardEnv(d))
}

/** The environment [pid] was started with, as the OS keeps it (Linux's /proc, macOS's `ps -E`), each `name=value`: what
 *  a process was handed, not what it set itself since. */
export function startedWith(pid: number): string[] {
  if (process.platform === 'linux') return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
  const line = execFileSync('/bin/ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
  // ps prints them after the command's words, joined by spaces: a value's own spaces split it, so a caller matches the
  // names it knows, or the entries whose values it made.
  return line.trim().split(' ').filter((word) => word.includes('='))
}

export class OrcaAgent {
  private constructor(private readonly s: SessionDef, private readonly terminal: OrcaTerminal,
    private readonly env: NodeJS.ProcessEnv, private readonly engine: InOrca | CodexOutside) {}

  /** On a stand-in of its own, its hooks InOrca's (Claude Code) or CodexOutside's (Codex) on that terminal, in the
   *  catalog's folder `/work/<name>` made under the daemon's projects. */
  static async start(d: IsolatedDaemon, children: ChildProcess[], s: SessionDef, hints: Record<string, string>): Promise<OrcaAgent> {
    if (!s.cwd.startsWith('/work/')) throw new Error(`${s.key}: ${s.cwd} is not a catalog folder`)
    const engine = engineOf(s)
    if (engine === 'cursor') throw new Error(`${s.key}: tier B runs no Cursor agent in Orca`)
    const terminal = await orcaTerminal(d, children, s.held ? { name: HELD_MAKER } : {})
    // Each hook's environment is the daemon's beside these names: orcaEnv's.
    const names = orcaNames(s, hints)
    const folder = s.cwd.slice('/work/'.length)
    return new OrcaAgent(s, terminal, orcaEnv(d, s, hints), engine === 'codex'
      ? new CodexOutside(d, folder, children, names, { sessionId: s.id, terminal })
      : new InOrca(d, folder, children, names, { sessionId: s.id, terminal: Promise.resolve(terminal) }))
  }

  /** Its runner's: every hook's caller. */
  get pid(): number { return this.terminal.pid }

  /** Its hook for [event], as its engine runs it. An end is its engine's leaving: Claude Code's SessionEnd hook, then its
   *  process; Codex runs no hook as it ends. */
  async hook(event: 'start' | 'turn-start' | 'needs-input' | 'turn-stop' | 'end'): Promise<void> {
    const engine = this.engine
    if (engine instanceof CodexOutside) {
      switch (event) {
        case 'start': return engine.hook('SessionStart', { source: 'startup' })
        case 'turn-start': return engine.hook('UserPromptSubmit')
        case 'turn-stop': return engine.hook('Stop')
        case 'end': return this.close()
        case 'needs-input': throw new Error(`${this.s.key}: tier B's Codex in Orca asks nothing`)
      }
    }
    switch (event) {
      case 'start': return engine.hook('SessionStart', { source: 'startup' })
      case 'turn-start': return engine.hook('UserPromptSubmit')
      // As Claude Code tells its hooks of a permission it waits on (fakeEngine.mjs).
      case 'needs-input': return engine.hook('Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
      case 'turn-stop': return engine.hook('Stop')
      case 'end':
        await engine.hook('SessionEnd', { reason: 'prompt_input_exit' })
        return this.close()
    }
  }

  /** A command on its terminal as its hooks run: its runner the caller, under orcaEnv's environment, in its folder. */
  run(file: string, args: string[]): ReturnType<OrcaTerminal['run']> {
    return this.terminal.run(file, args, this.env, '', this.engine.cwd)
  }

  /** Its stand-in ends: the agent goes with no hook. */
  close(): Promise<void> { return this.terminal.close() }
}
