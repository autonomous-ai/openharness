/**
 * Codex outside Harness, told by its own hooks, as harness/inOrca.ts tells Claude Code: no Harness pane, and the app it
 * runs in named by the hints a test gives it. With no process of its own the hooks' caller is the test's, so the session
 * lives as long as the test; given one (`own`, a terminal's tab: `inTab`, or a pane of the person's tmux: `inTmux`), the
 * hooks run under it, and ending it ends the session, as a Codex that quits does: Codex runs no hook as a session ends. A
 * turn its prompt hook started stays working until its Stop hook, which a test runs once the turn's answer is in its
 * rollout, and with no process to read idle, for as long as a test needs without one.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { expect } from 'vitest'
import { observedAgentId } from '../../src/cable/hosts/observed.js'
import { until, type IsolatedDaemon } from './daemon.js'
import type { OrcaTerminal } from './orcaHost.js'
import { closeTab, HOOK_RUNNER, hookRuns, hookTab, killTab, type HookRun, type Tab, type TabOptions } from './outsideAgent.js'

/** For the hook runner in a tmux pane to reach its socket. */
const CONNECT_MS = 30_000
/** Each pane's socket a name of its own in the daemon's root. */
let panes = 0

export interface CodexOutsideOptions {
  /** Its thread: a new one when none is given. */
  sessionId?: string
  /** A process of its own, named [title] when given. */
  own?: { title?: string }
  /** Its CODEX_HOME, when not the daemon's: its rollout there, and its hooks that home's hooks.json. */
  home?: string
  /** A terminal of Orca's host stand-in it runs in (orcaHost.ts): its hooks run on it, their caller its runner. */
  terminal?: OrcaTerminal
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
  /** In a tmux pane: its id and its command's process. */
  private inPane: { id: string; pid: number } | undefined
  private readonly terminal: OrcaTerminal | undefined

  constructor(private readonly d: IsolatedDaemon, folder: string, private readonly children: ChildProcess[],
    private readonly hints: Record<string, string>, options: CodexOutsideOptions = {}) {
    this.sessionId = options.sessionId ?? randomUUID()
    this.cwd = join(d.projectsDir, folder)
    mkdirSync(this.cwd, { recursive: true })
    this.home = options.home ?? d.env.CODEX_HOME!
    this.terminal = options.terminal
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
   * so its hooks come and go on a socket in the daemon's root. Ended by `end`, which closes the tab; the tab goes in
   * [children] too, the driver's last resort when it was not.
   */
  static async inTab(d: IsolatedDaemon, folder: string, children: ChildProcess[], hints: Record<string, string>,
    tab: TabOptions, options: Omit<CodexOutsideOptions, 'own'> = {}): Promise<CodexOutside> {
    const codex = new CodexOutside(d, folder, children, hints, options)
    const { tab: opened, run } = await hookTab(d, codex.cwd, { ...codex.env, TERM: 'xterm-256color' }, { ...tab, shell: true }, `the Codex in ${folder}`)
    children.push(opened.process)
    codex.tab = opened
    codex.ownRun = run
    return codex
  }

  /**
   * Its own process the command of a new window of the tmux session [session] on the daemon's private server, made in the
   * background, as Codex started in the person's tmux: its hooks run under it, with what tmux sets in each pane it starts
   * (TMUX_PANE, TERM_PROGRAM). The pane's terminal is its stdio, so its hooks come and go on a socket in the daemon's root.
   * Ended by `end`, which kills its pane; [children] has none of it, as the tmux server's own.
   */
  static async inTmux(d: IsolatedDaemon, session: string, folder: string, children: ChildProcess[], hints: Record<string, string>,
    options: Omit<CodexOutsideOptions, 'own' | 'terminal'> = {}): Promise<CodexOutside> {
    const codex = new CodexOutside(d, folder, children, hints, options)
    const what = `the Codex in ${folder}`
    const path = join(d.root, `codex-pane-${++panes}.sock`)
    const server = createServer()
    let socket: Socket | undefined
    server.once('connection', (connected) => { socket = connected })
    await new Promise<void>((listening, failed) => server.once('error', failed).listen(path, listening))
    try {
      // Its pane's environment is its own, as its hooks', but for what tmux sets there.
      const variables = Object.entries(codex.env).flatMap(([name, value]) => value === undefined ? [] : ['-e', `${name}=${value}`])
      const [id, pid] = (await d.tmux.run('new-window', '-d', '-t', `${session}:`, '-P', '-F', '#{pane_id} #{pane_pid}', '-c', codex.cwd,
        ...variables, process.execPath, '-e', HOOK_RUNNER, '', path)).split(' ')
      codex.inPane = { id: id!, pid: Number(pid) }
      const connected = await until(`${what} on its socket`, () => socket, CONNECT_MS, 50)
      codex.ownRun = hookRuns(connected, connected, codex.cwd, what)
      return codex
    } catch (error) {
      await codex.end()
      throw error
    } finally {
      server.close()
    }
  }

  get id(): string { return observedAgentId('codex', this.sessionId) }
  /** In a tab or a tmux pane: its own process; in a tab, the shell it runs in. */
  get pid(): number | undefined { return this.tab?.pid ?? this.inPane?.pid }
  get shellPid(): number | undefined { return this.tab?.shellPid }
  /** In a tmux pane: that pane's id. */
  get pane(): string | undefined { return this.inPane?.id }

  /** What its hooks run under: the daemon's environment (which names no tmux or Harness pane), its home, and [hints]; in a
   *  tmux pane, what tmux sets there too. */
  get env(): NodeJS.ProcessEnv {
    const pane = this.inPane ? { TMUX_PANE: this.inPane.id, TERM_PROGRAM: 'tmux' } : {}
    return { ...this.d.env, CODEX_HOME: this.home, ...this.hints, ...pane }
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
    const { code, stderr } = this.ownRun ? await this.ownRun(command, env, input)
      : this.terminal ? await this.terminal.run('/bin/sh', ['-c', command], env, input, this.cwd)
        : await this.run(command, env, input)
    expect(code, stderr).toBe(0)
  }

  /** Its own process ended, and with it the session: in a tab, the tab closed; in a tmux pane, the pane killed. */
  async end(): Promise<void> {
    if (this.tab) return closeTab(this.tab, this.cwd)
    // One that ended went with its pane already.
    if (this.inPane) return this.d.tmux.run('kill-pane', '-t', this.inPane.id).then(() => {}, () => {})
    const own = this.process
    if (!own || own.exitCode !== null || own.signalCode !== null) return
    const exited = new Promise<void>((done) => own.once('exit', () => done()))
    own.kill('SIGTERM')
    await exited
  }

  /** In a tab, the tab gone at once (outsideAgent.ts killTab), with no wait; in a tmux pane, its process. */
  killTab(): void {
    if (this.tab) killTab(this.tab)
    if (this.inPane) try { process.kill(this.inPane.pid, 'SIGKILL') } catch { /* already gone */ }
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
