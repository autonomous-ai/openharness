/**
 * Codex outside Harness, told by its own hooks, as harness/inOrca.ts tells Claude Code: no tmux pane, no Harness pane, no
 * process of its own, and the app it runs in named by the hints a test gives it. It runs no Stop hook here, so with no
 * process to read idle, a turn its prompt hook started stays working for as long as a test needs.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect } from 'vitest'
import { observedAgentId } from '../../src/cable/hosts/observed.js'
import { until, type IsolatedDaemon } from './daemon.js'

export class CodexOutside {
  readonly sessionId = randomUUID()
  readonly cwd: string
  /** Its rollout, in the daemon's Codex home: where `codex queue` finds its thread. */
  readonly transcriptPath: string

  constructor(private readonly d: IsolatedDaemon, folder: string, private readonly children: ChildProcess[],
    private readonly hints: Record<string, string>) {
    this.cwd = join(d.projectsDir, folder)
    mkdirSync(this.cwd, { recursive: true })
    this.transcriptPath = join(d.env.CODEX_HOME!, 'sessions', '2026', '11', '15', `rollout-2026-11-15T00-00-00-${this.sessionId}.jsonl`)
    mkdirSync(dirname(this.transcriptPath), { recursive: true })
    // The first line a Codex rollout has, as the fake engine writes it: the daemon reads it to tell a sub-agent's.
    const meta = { id: this.sessionId, cli_version: '0.167.0', cwd: this.cwd, source: 'cli' }
    appendFileSync(this.transcriptPath, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: meta })}\n`)
  }

  get id(): string { return observedAgentId('codex', this.sessionId) }

  /** Its own hook for [event], the command the daemon installed in its Codex home's hooks.json, run through a shell as Codex
   *  runs it, with the daemon's environment (which names no tmux or Harness pane) and [hints]. */
  async hook(event: 'SessionStart' | 'UserPromptSubmit', fields: Record<string, unknown> = {}): Promise<void> {
    const settings = join(this.d.env.CODEX_HOME!, 'hooks.json')
    const command = await until(`the ${event} hook in Codex's hooks.json`, () => {
      try {
        const blocks = (JSON.parse(readFileSync(settings, 'utf8')) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }).hooks?.[event] ?? []
        return blocks.flatMap((block) => block.hooks ?? []).map((hook) => hook.command).find((line) => line?.includes('notify.mjs'))
      } catch {
        return undefined
      }
    }, 30_000, 100)
    const child = spawn('/bin/sh', ['-c', command], { cwd: this.cwd, env: { ...this.d.env, ...this.hints }, stdio: ['pipe', 'ignore', 'pipe'] })
    this.children.push(child)
    let stderr = ''
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const exited = new Promise<number | null>((resolve) => child.once('close', resolve))
    child.stdin!.end(JSON.stringify({ session_id: this.sessionId, cwd: this.cwd, transcript_path: this.transcriptPath, hook_event_name: event, ...fields }))
    expect(await exited, stderr).toBe(0)
  }
}
