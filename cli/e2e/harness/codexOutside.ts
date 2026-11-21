/**
 * Codex outside Harness, told by its own hooks, as harness/inOrca.ts tells Claude Code: no tmux pane, no Harness pane, and
 * the app it runs in named by the hints a test gives it. With no process of its own the hooks' caller is the test's, so
 * the session lives as long as the test; given one (`own`), the hooks run under it, and ending it ends the session, as a
 * Codex that quits does: Codex runs no hook as a session ends. A turn its prompt hook started stays working until its
 * Stop hook, which a test runs once the turn's answer is in its rollout, and with no process to read idle, for as long as
 * a test needs without one.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import { expect } from 'vitest'
import { observedAgentId } from '../../src/cable/hosts/observed.js'
import { until, type IsolatedDaemon } from './daemon.js'

/** The session's own process: each hook handed on its stdin run through a shell as Codex runs it, one at a time, each
 *  answered on its stdout with its exit code and stderr. Named by its first argument when there is one: Linux knows a
 *  process by that name (its comm), as it knows the ChatGPT app's. */
const OWN = `const { spawn } = require('node:child_process')
if (process.argv[1]) process.title = process.argv[1]
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const { command, cwd, env, input } = JSON.parse(line)
  const hook = spawn('/bin/sh', ['-c', command], { cwd, env, stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  hook.stderr.on('data', (chunk) => { stderr += chunk })
  hook.on('close', (code) => process.stdout.write(JSON.stringify({ code, stderr }) + '\\n'))
  hook.stdin.end(input)
})`

export interface CodexOutsideOptions {
  /** Its thread: a new one when none is given. */
  sessionId?: string
  /** A process of its own, named [title] when given. */
  own?: { title?: string }
}

export class CodexOutside {
  readonly sessionId: string
  readonly cwd: string
  /** Its rollout, in the daemon's Codex home: where `codex queue` finds its thread. */
  readonly transcriptPath: string
  private readonly process: ChildProcess | undefined
  private readonly answers: Interface | undefined

  constructor(private readonly d: IsolatedDaemon, folder: string, private readonly children: ChildProcess[],
    private readonly hints: Record<string, string>, options: CodexOutsideOptions = {}) {
    this.sessionId = options.sessionId ?? randomUUID()
    this.cwd = join(d.projectsDir, folder)
    mkdirSync(this.cwd, { recursive: true })
    this.transcriptPath = join(d.env.CODEX_HOME!, 'sessions', '2026', '11', '15', `rollout-2026-11-15T00-00-00-${this.sessionId}.jsonl`)
    mkdirSync(dirname(this.transcriptPath), { recursive: true })
    // The first line a Codex rollout has, as the fake engine writes it: the daemon reads it to tell a sub-agent's.
    const meta = { id: this.sessionId, cli_version: '0.167.0', cwd: this.cwd, source: 'cli' }
    appendFileSync(this.transcriptPath, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: meta })}\n`)
    if (options.own) {
      const title = options.own.title
      this.process = spawn(process.execPath, ['-e', OWN, ...(title ? [title] : [])], { cwd: this.cwd, env: d.env, stdio: ['pipe', 'pipe', 'ignore'] })
      children.push(this.process)
      this.answers = createInterface({ input: this.process.stdout! })
    }
  }

  get id(): string { return observedAgentId('codex', this.sessionId) }

  /** Its own hook for [event], the command the daemon installed in its Codex home's hooks.json, run through a shell as Codex
   *  runs it, with the daemon's environment (which names no tmux or Harness pane) and [hints]. */
  async hook(event: 'SessionStart' | 'UserPromptSubmit' | 'Stop', fields: Record<string, unknown> = {}): Promise<void> {
    const settings = join(this.d.env.CODEX_HOME!, 'hooks.json')
    const command = await until(`the ${event} hook in Codex's hooks.json`, () => {
      try {
        const blocks = (JSON.parse(readFileSync(settings, 'utf8')) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }).hooks?.[event] ?? []
        return blocks.flatMap((block) => block.hooks ?? []).map((hook) => hook.command).find((line) => line?.includes('notify.mjs'))
      } catch {
        return undefined
      }
    }, 30_000, 100)
    const env = { ...this.d.env, ...this.hints }
    const input = JSON.stringify({ session_id: this.sessionId, cwd: this.cwd, transcript_path: this.transcriptPath, hook_event_name: event, ...fields })
    const { code, stderr } = this.answers ? await this.ownRun(command, env, input) : await this.run(command, env, input)
    expect(code, stderr).toBe(0)
  }

  /** Its own process ended, and with it the session. */
  async end(): Promise<void> {
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

  /** Through its own process, which answers each hook in turn: one ended first answers none. */
  private ownRun(command: string, env: NodeJS.ProcessEnv, input: string): Promise<{ code: number | null; stderr: string }> {
    const answers = this.answers!
    return new Promise((resolve, reject) => {
      const gone = () => reject(new Error('the Codex session\'s process ended before its hook did'))
      answers.once('line', (line) => {
        answers.off('close', gone)
        resolve(JSON.parse(line) as { code: number | null; stderr: string })
      })
      answers.once('close', gone)
      this.process!.stdin!.write(`${JSON.stringify({ command, cwd: this.cwd, env, input })}\n`)
    })
  }
}
