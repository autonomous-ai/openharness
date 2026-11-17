import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import { observedAgentId } from '../../src/cable/hosts/observed.js'
import { CLI_ROOT, type IsolatedDaemon, until } from './daemon.js'

/** Orca's names for the terminal, as its hook reads them; its secrets sit beside them and must never leave the hook. */
export const IN_ORCA = { ORCA_AGENT_SESSION_ID: 'e2e-orca-session', ORCA_PAIRING_CODE: 'pairing-e2e-4f1e', ORCA_AGENT_SESSION_SPAWN_TOKEN: 'spawn-e2e-8b2d' }

/** Claude Code in an Orca terminal, outside Harness: no tmux pane, no Harness pane, and Orca's own variables. [hints] are
 *  the session's own beside them, as its hook reads them: an Orca terminal's handle, or another app's names
 *  (`WEZTERM_PANE`, which the hook reads before Orca's). */
export class InOrca {
  readonly sessionId = randomUUID()
  readonly cwd: string
  constructor(private readonly d: IsolatedDaemon, folder: string, private readonly children: ChildProcess[],
    private readonly hints: Record<string, string> = {}) {
    this.cwd = join(d.projectsDir, folder)
    mkdirSync(this.cwd, { recursive: true })
  }

  get id(): string { return observedAgentId('claude', this.sessionId) }

  /** d.env names no tmux or Harness pane (testing/daemonEnvironment.ts): only IN_ORCA and [hints] say where this runs. */
  private env(): NodeJS.ProcessEnv {
    return { ...this.d.env, ...IN_ORCA, ...this.hints }
  }

  private run(file: string, args: string[], input: Record<string, unknown>, cwd = this.cwd): Promise<{ stdout: string; stderr: string; code: number | null; ms: number }> {
    const started = Date.now()
    const child = spawn(file, args, { cwd, env: this.env(), stdio: ['pipe', 'pipe', 'pipe'] })
    this.children.push(child)
    let stdout = '', stderr = ''
    child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const done = new Promise<{ stdout: string; stderr: string; code: number | null; ms: number }>((resolve) =>
      child.once('exit', (code) => resolve({ stdout, stderr, code, ms: Date.now() - started })))
    child.stdin!.end(JSON.stringify({ session_id: this.sessionId, cwd: this.cwd, ...input }))
    return done
  }

  /** Its own hook for [event], the command the daemon installed in Claude Code's settings, run through a shell as Claude
   *  Code runs it. */
  async hook(event: 'SessionStart' | 'UserPromptSubmit' | 'Stop', fields: Record<string, unknown> = {}): Promise<void> {
    const settings = join(this.d.env.HOME!, '.claude', 'settings.json')
    const command = await until(`the ${event} hook in Claude Code's settings`, () => {
      try {
        const blocks = (JSON.parse(readFileSync(settings, 'utf8')) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }).hooks?.[event] ?? []
        return blocks.flatMap((block) => block.hooks ?? []).map((hook) => hook.command).find((line) => line?.includes('notify.mjs'))
      } catch {
        return undefined
      }
    }, 30_000, 100)
    const run = await this.run('/bin/sh', ['-c', command], { hook_event_name: event, ...fields })
    expect(run.code, run.stderr).toBe(0)
  }

  /** The plugin's PermissionRequest hook: the real CLI, from the run's bundle or the sources as the daemon is started. */
  asked(command: string) {
    // The plugin as `claude plugin install` leaves it: its entry in the user settings, which `asked` reads before it tells
    // (`harness device claude disable` drops it). Beside the hooks the daemon installed there.
    const settings = join(this.d.env.HOME!, '.claude', 'settings.json')
    const current = JSON.parse(readFileSync(settings, 'utf8')) as { enabledPlugins?: Record<string, boolean> }
    writeFileSync(settings, JSON.stringify({ ...current, enabledPlugins: { ...current.enabledPlugins, 'harness-device@openharness': true } }))
    const bundle = process.env.E2E_BUNDLE_PATH
    const script = bundle ? [bundle] : ['--import', 'tsx', 'src/cli.ts']
    // From the CLI's folder, where tsx resolves; the session's folder is the input's.
    return this.run(process.execPath, [...script, 'device', 'claude', 'asked'], {
      hook_event_name: 'PermissionRequest', permission_mode: 'default', tool_name: 'Bash', tool_input: { command, description: 'Say hi' },
    }, CLI_ROOT)
  }
}
