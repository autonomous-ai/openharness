/**
 * Codex outside Harness, told by its own hooks, as harness/inOrca.ts tells Claude Code: no tmux pane, no Harness pane, and
 * the app it runs in named by the hints a test gives it. With no process of its own the hooks' caller is the test's, so
 * the session lives as long as the test; given one (`own`, or a terminal's tab: `inTab`), the hooks run under it, and
 * ending it ends the session, as a Codex that quits does: Codex runs no hook as a session ends. A turn its prompt hook
 * started stays working until its Stop hook, which a test runs once the turn's answer is in its rollout, and with no
 * process to read idle, for as long as a test needs without one.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect } from 'vitest'
import { observedAgentId } from '../../src/cable/hosts/observed.js'
import { until, type IsolatedDaemon } from './daemon.js'
import { closeTab, HOOK_RUNNER, hookRuns, hookTab, type HookRun, type Tab, type TabOptions } from './outsideAgent.js'

export interface CodexOutsideOptions {
  /** Its thread: a new one when none is given. */
  sessionId?: string
  /** A process of its own, named [title] when given. */
  own?: { title?: string }
  /** Its CODEX_HOME, when not the daemon's: its rollout there, and its hooks that home's hooks.json. */
  home?: string
}

export class CodexOutside {
  readonly sessionId: string
  readonly cwd: string
  /** Its rollout, in its Codex home: in the daemon's, where `codex queue` finds its thread. */
  readonly transcriptPath: string
  private readonly home: string
  private process: ChildProcess | undefined
  /** Its own process's runs of its hooks, when it has one (HOOK_RUNNER). */
  private ownRun: HookRun | undefined
  private tab: Tab | undefined

  constructor(private readonly d: IsolatedDaemon, folder: string, private readonly children: ChildProcess[],
    private readonly hints: Record<string, string>, options: CodexOutsideOptions = {}) {
    this.sessionId = options.sessionId ?? randomUUID()
    this.cwd = join(d.projectsDir, folder)
    mkdirSync(this.cwd, { recursive: true })
    this.home = options.home ?? d.env.CODEX_HOME!
    this.transcriptPath = join(this.home, 'sessions', '2026', '11', '15', `rollout-2026-11-15T00-00-00-${this.sessionId}.jsonl`)
    mkdirSync(dirname(this.transcriptPath), { recursive: true })
    // The first line a Codex rollout has, as the fake engine writes it: the daemon reads it to tell a sub-agent's.
    const meta = { id: this.sessionId, cli_version: '0.167.0', cwd: this.cwd, source: 'cli' }
    appendFileSync(this.transcriptPath, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: meta })}\n`)
    if (options.own) {
      const title = options.own.title
      this.process = spawn(process.execPath, ['-e', HOOK_RUNNER, ...(title ? [title] : [])], { cwd: this.cwd, env: d.env, stdio: ['pipe', 'pipe', 'ignore'] })
      children.push(this.process)
      this.ownRun = hookRuns(this.process.stdout!, this.process.stdin!, this.cwd, "the Codex session's process")
    }
  }

  /**
   * Its own process the foreground job of a shell in a tab of a fake app (outsideAgent.ts openTab), as an editor's
   * terminal runs Codex: [shellPid] is the shell the editor reports for that terminal. The tab's terminal is its stdio,
   * so its hooks come and go on a socket in the daemon's root. Ended by `end`, which closes the tab.
   */
  static async inTab(d: IsolatedDaemon, folder: string, children: ChildProcess[], hints: Record<string, string>,
    tab: TabOptions, options: Omit<CodexOutsideOptions, 'own'> = {}): Promise<CodexOutside> {
    const codex = new CodexOutside(d, folder, children, hints, options)
    const { tab: opened, run } = await hookTab(d, codex.cwd, { ...codex.env, TERM: 'xterm-256color' }, { ...tab, shell: true }, `the Codex in ${folder}`)
    codex.tab = opened
    codex.ownRun = run
    return codex
  }

  get id(): string { return observedAgentId('codex', this.sessionId) }
  /** In a tab: its own process, and the shell it runs in. */
  get pid(): number | undefined { return this.tab?.pid }
  get shellPid(): number | undefined { return this.tab?.shellPid }

  /** What its hooks run under: the daemon's environment (which names no tmux or Harness pane), its home, and [hints]. */
  private get env(): NodeJS.ProcessEnv {
    return { ...this.d.env, CODEX_HOME: this.home, ...this.hints }
  }

  /** Its own hook for [event], the command the daemon installed in its Codex home's hooks.json, run through a shell as Codex
   *  runs it, under its environment. */
  async hook(event: 'SessionStart' | 'UserPromptSubmit' | 'Stop', fields: Record<string, unknown> = {}): Promise<void> {
    const settings = join(this.home, 'hooks.json')
    const command = await until(`the ${event} hook in Codex's hooks.json`, () => {
      try {
        const blocks = (JSON.parse(readFileSync(settings, 'utf8')) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }).hooks?.[event] ?? []
        return blocks.flatMap((block) => block.hooks ?? []).map((hook) => hook.command).find((line) => line?.includes('notify.mjs'))
      } catch {
        return undefined
      }
    }, 30_000, 100)
    const env = this.env
    const input = JSON.stringify({ session_id: this.sessionId, cwd: this.cwd, transcript_path: this.transcriptPath, hook_event_name: event, ...fields })
    const { code, stderr } = this.ownRun ? await this.ownRun(command, env, input) : await this.run(command, env, input)
    expect(code, stderr).toBe(0)
  }

  /** Its own process ended, and with it the session: in a tab, the tab closed. */
  async end(): Promise<void> {
    if (this.tab) return closeTab(this.tab, this.cwd)
    const own = this.process
    if (!own || own.exitCode !== null || own.signalCode !== null) return
    const exited = new Promise<void>((done) => own.once('exit', () => done()))
    own.kill('SIGTERM')
    await exited
  }

  private async run(command: string, env: NodeJS.ProcessEnv, input: string): Promise<{ code: number | null; stderr: string }> {
    const child = spawn('/bin/sh', ['-c', command], { cwd: this.cwd, env, stdio: ['pipe', 'ignore', 'pipe'] })
    this.children.push(child)
    let stderr = ''
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const exited = new Promise<number | null>((resolve) => child.once('close', resolve))
    child.stdin!.end(input)
    return { code: await exited, stderr }
  }
}
